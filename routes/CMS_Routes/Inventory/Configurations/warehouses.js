// routes/CMS_Routes/Inventory/Configurations/warehouses.js
//
// Store & Purchase — Chunk B3. Warehouses and locations.
//
// ── WHAT THIS REPLACES, MEASURED BEFORE CHANGING IT ─────────────────────────
// The previous router had `router.use(EmployeeAuthMiddleware)` and nothing
// else:
//
//   · No tenant scope anywhere. Any signed-in employee could list, read,
//     rewrite, re-status and DELETE every company's warehouses.
//   · No capability check, so a viewer could write.
//   · `/:id` was declared BEFORE `/capacity/units` and `/types/suggestions`,
//     so Express matched the parameter route first and both static endpoints
//     were answered as a lookup for a warehouse whose id is "capacity" or
//     "types" — never the reference data they were written to serve.
//   · `DELETE /:id` destroyed the record, guarded only by a stored
//     `itemsCount` that nothing maintains.
//   · A summary summed `itemsCount` across warehouses and served it as though
//     it were inventory.
//   · Search interpolated the raw query into `$regex`, so a caller's regex
//     metacharacters were executed rather than matched.
//
// ── WHAT THIS CHUNK IS NOT ──────────────────────────────────────────────────
// Identity only. There are no balances, transfers, valuations or lots here,
// and the payload says so rather than leaving a screen to imply otherwise.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");

const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
  CAPABILITIES,
} = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
/* History is no longer written from here directly: every entry now goes
   through the unit of work below, together with the change it describes. */
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const SpActionHistory = require("../../../../models/CMS_Models/StorePurchase/SpActionHistory");

const ENTITY = "WAREHOUSE";

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

/* ══════════════════════════════════════════════════════════════════════════
 * SHARED
 * ═════════════════════════════════════════════════════════════════════════ */

/** A tenant-scoped filter. `$and`, so a search clause cannot displace it. */
const scoped = (req, extra = {}) => {
  const tenant = tenantContext.tenantFilter(req.tenant);
  const clauses = [tenant];
  if (extra && Object.keys(extra).length) clauses.push(extra);
  return clauses.length === 1 ? clauses[0] : { $and: clauses };
};

const objectId = (id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : null);

/** Metacharacters are matched, not executed. */
const escapeRegex = (v) => String(v ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

/* ── WHAT AN IDEMPOTENCY KEY IS BOUND TO ───────────────────────────────────
   The shared fingerprint covers the body. For these routes the body alone is
   not the whole intent: `{action:"archive"}` against warehouse A and against
   warehouse B are byte-identical, so without the target the second replays
   the first's answer and B is never archived — while the caller is told it
   was. The target is the record the URL names. Create needs none: its intent
   is entirely in its body. */
const warehouseTarget = (req) => `warehouse:${req.params.id}`;
const locationTarget = (req) => `warehouse:${req.params.id}/location:${req.params.locationId}`;

/* ── ONE CODE CONTRACT ─────────────────────────────────────────────────────
   Applied to every path that accepts a code — warehouse create and update,
   location create and update. It was previously checked on warehouse create
   only, so a rename could introduce exactly what a create refused. The
   frontend mirrors it; the server does not rely on that. */
const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/;

function assertCode(raw, what) {
  const code = text(raw).toUpperCase();
  if (!code) throw fail("VALIDATION", `A ${what} code is required.`, { reason: "CODE_REQUIRED" });
  if (!CODE_PATTERN.test(code)) {
    throw fail("VALIDATION",
      `A ${what} code may use letters, numbers and hyphens, up to 16 characters, and must start with a letter or number.`,
      { reason: "CODE_FORMAT", code });
  }
  return code;
}

/* ── WHAT A CAPACITY UNIT MEASURES ─────────────────────────────────────────
   Pallet positions, racks and bins are counts; cubic metres are a volume.
   Only true area units are floor space, and the wording follows the
   dimension rather than assuming one. */
const UNIT_DIMENSIONS = Object.freeze({
  "sq ft": "AREA", "sq m": "AREA", "sq yards": "AREA",
  "cubic ft": "VOLUME", "cubic m": "VOLUME",
  "pallet positions": "POSITIONS", racks: "POSITIONS", bins: "POSITIONS", shelves: "POSITIONS",
});

const DIMENSION_LABELS = Object.freeze({
  AREA: "Floor area",
  VOLUME: "Storage volume",
  POSITIONS: "Storage positions",
  UNKNOWN: "Facility capacity",
});

const dimensionFor = (unit) => UNIT_DIMENSIONS[text(unit).toLowerCase()] || "UNKNOWN";

/* The units the server actually accepts, in the order they are offered. The
   form asks for this list rather than carrying its own copy, so a unit can
   never be offered that a write will then refuse. */
const CAPACITY_UNITS = Object.freeze(Object.keys(UNIT_DIMENSIONS).map((unit) => ({
  unit,
  dimension: UNIT_DIMENSIONS[unit],
  dimensionLabel: DIMENSION_LABELS[UNIT_DIMENSIONS[unit]],
})));

/**
 * A structured capacity that means something, or a refusal.
 *
 * ── WHY A HALF-STATED CAPACITY IS REFUSED, NOT STORED ───────────────────────
 * `{ value: 10000 }` with no unit is not a capacity — it is a number nobody
 * can read. Stored, it prints as "10000" beside warehouses measured in pallet
 * positions and cubic metres, and the first person to compare them is
 * comparing nothing. `{ unit: "sq ft" }` with no value is the same problem
 * from the other side. Both are the caller's mistake to correct, so both are
 * validation errors rather than a silently degraded record.
 *
 * A unit outside the supported set is refused for the same reason the ledger
 * refuses an unknown enum: guessing what "sqft " or "square feet" meant is
 * inventing a measurement. NaN, Infinity, numeric strings and negatives are
 * refused outright — `parseFloat("12abc")` returning 12 is precisely the
 * class of defect this replaces.
 *
 * The DIMENSION is never taken from the caller: it is what the unit measures,
 * which is a server fact, not an opinion.
 *
 * @returns {{value:number|null, unit:string, dimension:string}}
 */
function assertCapacity(raw) {
  /* Not stated at all: a warehouse with no recorded capacity, which is an
     honest state and not a zero. */
  if (raw === undefined || raw === null) {
    return { value: null, unit: "", dimension: "UNKNOWN" };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw fail("VALIDATION", "Capacity must be a value and a unit.",
      { reason: "CAPACITY_SHAPE" });
  }

  const unitRaw = raw.unit;
  const valueRaw = raw.value;
  const unitGiven = unitRaw !== undefined && unitRaw !== null && String(unitRaw).trim() !== "";
  const valueGiven = valueRaw !== undefined && valueRaw !== null && valueRaw !== "";

  /* Explicitly cleared. */
  if (!unitGiven && !valueGiven) return { value: null, unit: "", dimension: "UNKNOWN" };

  if (valueGiven && !unitGiven) {
    throw fail("VALIDATION",
      "A capacity needs a unit, so it can be read and compared.",
      { reason: "CAPACITY_UNIT_REQUIRED", supportedUnits: CAPACITY_UNITS.map((u) => u.unit) });
  }

  const unit = String(unitRaw).trim();
  const dimension = UNIT_DIMENSIONS[unit.toLowerCase()];
  if (!dimension) {
    throw fail("VALIDATION",
      `"${unit}" is not a capacity unit this system measures in.`,
      { reason: "CAPACITY_UNIT_UNSUPPORTED", unit,
        supportedUnits: CAPACITY_UNITS.map((u) => u.unit) });
  }

  if (!valueGiven) {
    throw fail("VALIDATION",
      `A capacity in ${unit} needs a number.`,
      { reason: "CAPACITY_VALUE_REQUIRED", unit });
  }

  /* Strict. A number, or nothing — never a string coaxed into one. */
  if (typeof valueRaw !== "number" || !Number.isFinite(valueRaw)) {
    throw fail("VALIDATION",
      "A capacity must be a finite number.",
      { reason: "CAPACITY_VALUE_INVALID" });
  }
  if (valueRaw < 0) {
    throw fail("VALIDATION",
      "A capacity cannot be negative.",
      { reason: "CAPACITY_VALUE_NEGATIVE" });
  }

  /* Stored under the supported spelling, not the caller's casing. */
  const canonical = CAPACITY_UNITS.find((u) => u.unit === unit.toLowerCase())?.unit || unit.toLowerCase();
  return { value: valueRaw, unit: canonical, dimension };
}

/**
 * Ownership supplied by the caller, checked rather than dropped.
 *
 * Ignoring a forged `companyId` and stamping the right one silently is not
 * protection — it tells the caller their request succeeded as asked when it
 * did something else. A foreign company is a TENANT_MISMATCH; a redundant
 * matching one is accepted; a site is resolved through the established
 * policy, which fails closed on an unconfigured or unpermitted one.
 */
function assertTenantInput(req) {
  const claimed = req.body?.companyId ?? req.body?.company;
  if (claimed !== undefined && claimed !== null && String(claimed).trim()) {
    if (String(claimed) !== String(req.tenant.companyId)) {
      throw fail("TENANT_MISMATCH",
        "That belongs to another company.",
        { reason: "COMPANY_MISMATCH" });
    }
  }
  /* `requireTenant` already resolves and validates a requested site through
     the site policy and fails closed; anything left here would be a second,
     weaker copy of that rule. */
}

/**
 * Write only the nested keys the caller actually sent.
 *
 * Uses dotted paths so the untouched siblings are left exactly as stored,
 * rather than being replaced by a whole new subdocument built from defaults.
 * `hasOwnProperty` and not truthiness: `""` is a real instruction to clear.
 */
function mergeNested($set, path, incoming, allowed) {
  if (incoming === undefined) return;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    throw fail("VALIDATION", `${path} must be an object of fields to change.`,
      { reason: "NESTED_SHAPE", field: path });
  }
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    const value = incoming[key];

    /* ── CLEARING IS DELIBERATE, AND ONLY THESE TWO SAY SO ───────────────
       The documented contract: an absent key changes nothing, `""` and
       `null` clear the field. Everything else is a malformed value. */
    if (value === "" || value === null) {
      $set[`${path}.${key}`] = "";
      continue;
    }

    /* ── AND EVERYTHING ELSE IS REFUSED, NOT FLATTENED ───────────────────
       `text()` returns "" for an array, an object, a boolean or a number.
       Run over a malformed payload that meant nothing of the sort, that
       silently ERASED a stored value and reported success — the caller was
       told their edit worked while it destroyed data. A wrong type is the
       caller's bug to fix, so it is named. */
    if (typeof value !== "string") {
      throw fail("VALIDATION",
        `${path}.${key} must be text. Send "" or null to clear it.`,
        { reason: "NESTED_FIELD_TYPE", field: `${path}.${key}`, received: Array.isArray(value) ? "array" : typeof value });
    }
    $set[`${path}.${key}`] = value.trim();
  }
}

/**
 * The version this edit was composed against.
 *
 * Required, and deliberately so. An edit that cannot say which version of
 * the record it was written against was not composed against one, and
 * accepting it would reintroduce exactly the silent overwrite the version
 * exists to stop. The detail response carries `version` for the form to
 * return here.
 */
function assertExpectedVersion(raw, current) {
  const stored = current.recordVersion ?? 0;
  if (raw === undefined || raw === null || raw === "") {
    throw fail("VALIDATION",
      "This edit did not say which version of the warehouse it was based on. Reload the warehouse and try again.",
      { reason: "VERSION_REQUIRED", currentVersion: stored });
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw fail("VALIDATION", "The declared version is not a version number.",
      { reason: "VERSION_INVALID" });
  }
  return n;
}

/** Bounded, so a caller cannot ask for the whole collection at once. */
const paging = (q) => {
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

/* What this master knows and does not know, stated in the payload. */
const CAPABILITY_NOTE = Object.freeze({
  locationBalances: false,
  note: "Warehouses and locations are identity only. Stock is not held per location yet — location-level balances arrive with the movement engine.",
});

const publicLocation = (l) => ({
  _id: String(l._id),
  code: l.code,
  name: l.name,
  type: l.type,
  parent: l.parent ? String(l.parent) : null,
  status: l.status,
  barcode: l.barcode || "",
  description: l.description || "",
  archivedAt: l.archivedAt || null,
  archiveReason: l.archiveReason || "",
  createdAt: l.createdAt || null,
  updatedAt: l.updatedAt || null,
});

/**
 * The wire shape.
 *
 * `code` is the canonical name for what is stored as `shortName`; both are
 * returned so existing callers keep working. `legacyItemsCount` is
 * deliberately not called a stock figure — nothing maintains it, and stock is
 * not held per warehouse.
 */
const publicWarehouse = (w) => ({
  _id: String(w._id),
  code: w.shortName,
  shortName: w.shortName,
  name: w.name,
  status: w.status || "Active",
  address: w.address || "",
  addressDetail: w.addressDetail || {},
  contactPerson: w.contactPerson || {},
  /* ── CAPACITY, BOTH SHAPES, NEITHER INVENTED ───────────────────────────
     `capacityLegacy` is whatever the original String path holds — returned
     verbatim, never parsed. `capacityDetail` is the structured value, with
     the dimension its unit actually measures. Neither is stock. */
  capacityLegacy: typeof w.capacity === "string" ? w.capacity : "",
  capacityDetail: (() => {
    const d = w.capacityDetail || {};
    const value = typeof d.value === "number" ? d.value : null;
    const unit = d.unit || "";
    const dimension = d.dimension || dimensionFor(unit);
    return {
      value, unit, dimension,
      label: DIMENSION_LABELS[dimension] || DIMENSION_LABELS.UNKNOWN,
      /* Said once, in the payload, so no screen has to decide it. */
      note: "What the facility can hold. It is not a stock quantity, and no utilisation or occupancy is implied.",
    };
  })(),
  description: w.description || "",
  locations: (w.locations || []).map(publicLocation),
  locationCount: (w.locations || []).filter((l) => l.status !== "Archived").length,
  archivedAt: w.archivedAt || null,
  archiveReason: w.archiveReason || "",
  createdAt: w.createdAt || null,
  updatedAt: w.updatedAt || null,
  /* Written before the tenant boundary. Read-only until migrated. */
  legacy: !w.companyId,
  legacyItemsCount: typeof w.itemsCount === "number" ? w.itemsCount : null,
  /* What an edit must declare it was composed against. Returned on every
     read so a form always has one to send back. */
  version: w.recordVersion ?? 0,
  structureVersion: w.structureVersion ?? 0,
  capabilities: CAPABILITY_NOTE,
});

/**
 * One recoverable unit: the mutation, its history and its effect marker.
 *
 * ── WHY MUTATE-THEN-RECORD WAS NOT SAFE ─────────────────────────────────────
 * Every write used to change the Warehouse first and record history second.
 * Throwing when history failed did not fix it: the mutation had already
 * landed, the route returned an error, the idempotency claim could be
 * released because no effect marker had been written, and the retry ran the
 * mutation a SECOND time. An unaudited change became a duplicated one.
 *
 * `unitOfWork.run` settles the mode before anything is written:
 *
 *   · TRANSACTIONAL — mutation, history and effect marker commit together, so
 *     a history failure rolls the mutation back and there is nothing to
 *     recover from.
 *   · MARKED (standalone) — mutation, then the effect marker IMMEDIATELY,
 *     then history. From the marker onward a same-key retry lands in the
 *     handler's recovery branch instead of repeating the mutation, so a
 *     history failure costs an audit entry, never a second change.
 *
 * `mutate` returns `{ entityType, entityId, entry, result }`. The
 * `recoveryReceipt` is prepared by the CALLER and passed in here, BEFORE the
 * mutation runs — `unitOfWork.run` validates it before touching anything, so a
 * malformed receipt cannot leave a mutation without a marker. The mode is
 * returned so the response can state it rather than assume it.
 */
async function runWrite(req, { recoveryReceipt, mutate }) {
  return unitOfWork.run(req.tenant, {
    idempotencyRecord: req.idempotent?.record || null,
    recoveryReceipt,
    mutate,
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * RECOVERY — WHAT HAPPENS AFTER AN EFFECT MARKER EXISTS
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * An EFFECT_APPLIED marker is a statement that the business mutation ALREADY
 * COMMITTED. From that instant this router has exactly two lawful outcomes:
 *
 *   · finish the unfinished bookkeeping and answer; or
 *   · refuse, and ask a person to reconcile.
 *
 * Running the mutation again is not a third option, and neither is releasing
 * the key so that a later attempt can. The previous shape got this wrong in a
 * quiet way: the recovery helpers returned `null` when they could not find
 * what the marker named, and every caller then FELL THROUGH to its ordinary
 * mutation path. A missing record — the one case where nobody can say what
 * happened — was the case that re-ran the write.
 *
 * So the helpers below never return a "carry on" value. They return a
 * response or they throw.
 *
 * ── WHY CURRENT STATE IS NOT EVIDENCE ───────────────────────────────────────
 * Recovery used to rebuild the history entry from the request and the
 * warehouse as it reads NOW. Between the interrupted write and its retry a
 * legitimate write can move the record on, and then the reconstruction is
 * simply false: an interrupted DEACTIVATE whose warehouse was archived in the
 * meantime was recorded as a transition ending in Archived, which nobody
 * made. The facts are captured when the effect commits — see the receipt on
 * SpIdempotencyRecord — and recovery reads only those.
 * ═════════════════════════════════════════════════════════════════════════ */

const {
  RECOVERY_RECEIPT_VERSION, buildRecoveryReceipt,
} = require("../../../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

/**
 * Refuse, in the one shape every reconciliation refusal uses.
 *
 * `cause` is deliberately separate from `reason`: every one of these is a
 * RECONCILIATION_REQUIRED as far as a caller's next step goes — stop, and
 * look — while the cause is what an operator needs to know to look in the
 * right place.
 */
const reconcile = (cause, message, extra = {}) =>
  fail("CONFLICT", message, {
    reason: "RECONCILIATION_REQUIRED",
    cause,
    /* Said in the payload so no screen has to infer it. */
    guidance: "This request was interrupted after it had already taken effect. Check the record before acting again; do not resend.",
    ...extra,
  });

/**
 * The `_id` a location created under this idempotency record will have.
 *
 * ── WHY THE RECORD AND NOT THE KEY ──────────────────────────────────────────
 * Hashing the literal key was wrong. A key is only unique WITHIN a company,
 * an actor and an operation — the same "retry-1" string from two people, or
 * against two operations, is two different actions, and deriving from the
 * key alone gave their locations the same `_id`. The idempotency record's own
 * `_id` is unique across all four, so this is too.
 *
 * It is still derived rather than random because it has to be known BEFORE
 * the write, so the receipt can record it; and it is the RECEIPT that
 * recovery reads, never this function.
 */
const locationIdForRecord = (record) =>
  record?._id
    ? new mongoose.Types.ObjectId(
      crypto.createHash("sha256").update(`sp-location:${record._id}`).digest("hex").slice(0, 24),
    )
    : new mongoose.Types.ObjectId();

/**
 * Is there enough durable evidence to finish this operation?
 *
 * Every check below fails CLOSED. A record written before receipts existed,
 * one whose schema version this deployment does not know, one naming a
 * warehouse that is gone, one naming a location that is gone, and one whose
 * identity does not match the URL being called all end the same way: a
 * structured 409, no mutation, no invented history.
 *
 * @throws {StorePurchaseError} 409 whenever recovery cannot proceed
 * @returns {{receipt, warehouse, location}}
 */
async function requireRecoveryEvidence(req, {
  action,
  expectedEntityType = ENTITY,
  urlWarehouseId = null,
  urlLocationId = null,
  needsLocation = false,
}) {
  const record = req.idempotent?.record || null;
  const receipt = record?.recoveryReceipt || null;

  /* ── 1. EVIDENCE EXISTS, IS THE RIGHT VERSION, AND CARRIES A TIME ──────── */
  if (!receipt || receipt.v !== RECOVERY_RECEIPT_VERSION || !receipt.entityId) {
    throw reconcile("RECOVERY_EVIDENCE_MISSING",
      "This request was interrupted after it had already taken effect, and there is not enough recorded evidence to complete it safely. Inspect the record and resolve the interrupted request before acting again.",
      { receiptVersion: receipt?.v ?? null, expectedReceiptVersion: RECOVERY_RECEIPT_VERSION });
  }
  /* A receipt without a valid event time cannot date its history entry, and
     inventing one would misreport when the change happened. Fail closed. */
  const occurredAt = receipt.occurredAt ? new Date(receipt.occurredAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime())) {
    throw reconcile("RECOVERY_EVIDENCE_MISSING",
      "This interrupted request did not record when it happened, so its history cannot be completed safely. Inspect the record and resolve it before acting again.");
  }

  /* ── 2. MARKER IDENTITY AGREES WITH ITSELF, THE RECEIPT AND THIS ROUTE ─── */
  /* Entity TYPE: the marker's, the receipt's and the route's must all agree.
     Without this a marker produced by another domain could be completed here. */
  if (expectedEntityType && receipt.entityType !== expectedEntityType) {
    throw reconcile("RECOVERY_ENTITY_TYPE_MISMATCH",
      "This request key already took effect against a different kind of record. Inspect both and resolve the interrupted request before acting again.",
      { recordedEntityType: receipt.entityType, expectedEntityType });
  }
  if (record.resultEntityType && record.resultEntityType !== receipt.entityType) {
    throw reconcile("RECOVERY_EVIDENCE_INCONSISTENT",
      "The record of this interrupted request does not agree with itself. Inspect it and resolve the interrupted request before acting again.");
  }
  /* Entity ID: the marker and the receipt must name the same document. */
  if (record.resultEntityId && String(record.resultEntityId) !== String(receipt.entityId)) {
    throw reconcile("RECOVERY_EVIDENCE_INCONSISTENT",
      "The record of this interrupted request does not agree with itself. Inspect it and resolve the interrupted request before acting again.");
  }

  /* ── 3. IT IS THE OPERATION THIS ROUTE PERFORMS ───────────────────────── */
  if (action && receipt.action !== action) {
    throw reconcile("RECOVERY_ACTION_MISMATCH",
      "This request key already took effect for a different action against this record. Inspect the record and resolve the interrupted request; do not start another action.",
      { recordedAction: receipt.action, expectedAction: action });
  }

  /* ── 4. IT IS THE RECORD THIS URL NAMES ───────────────────────────────── */
  if (urlWarehouseId && String(receipt.entityId) !== String(urlWarehouseId)) {
    throw reconcile("RECOVERY_TARGET_MISMATCH",
      "This request key already took effect against a different warehouse. Inspect both and resolve the interrupted request before acting again.");
  }

  /* ── 5. THE WAREHOUSE IT PRODUCED IS STILL THERE ──────────────────────── */
  const warehouse = await Warehouse.findOne(scoped(req, { _id: receipt.entityId })).lean();
  if (!warehouse) {
    /* Nobody can say from here whether it was created and then removed, or
       never became durable. That is precisely why this does not retry. */
    throw reconcile("RECOVERED_RECORD_MISSING",
      "This request had already taken effect, but the warehouse it produced can no longer be found. Inspect the register and resolve the interrupted request before creating or changing it again.");
  }

  /* ── 6. THE EMBEDDED SUBJECT (LOCATION), WHERE THERE IS ONE ────────────── */
  let location = null;
  if (needsLocation) {
    if (!receipt.subjectId) {
      throw reconcile("RECOVERY_EVIDENCE_MISSING",
        "This location request was interrupted after it had already taken effect, and the location it acted on was not recorded. Inspect the location list and resolve the interrupted request before acting again.");
    }
    if (urlLocationId && String(receipt.subjectId) !== String(urlLocationId)) {
      throw reconcile("RECOVERY_TARGET_MISMATCH",
        "This request key already took effect against a different location. Inspect both and resolve the interrupted request before acting again.");
    }
    location = (warehouse.locations || []).find(
      (l) => String(l._id) === String(receipt.subjectId),
    ) || null;
    if (!location) {
      throw reconcile("RECOVERED_LOCATION_MISSING",
        "This request had already taken effect, but the location it produced can no longer be found. Inspect the location list and resolve the interrupted request before adding or changing it again.");
    }
  }

  return { receipt, warehouse, location };
}

/**
 * The history entry the interrupted operation would have written.
 *
 * Built ONLY from the receipt. Nothing is read from the current record and
 * nothing from the retry's request body — both describe a later moment than
 * the event being recorded.
 */
const entryFromReceipt = (req, receipt) => ({
  entityType: ENTITY,
  entityId: receipt.entityId,
  documentNumber: receipt.documentNumber || "",
  action: receipt.action,
  /* ── THE EVENT'S OWN TIME ────────────────────────────────────────────────
     Not `new Date()`. Recovery may run long after the change; stamping "now"
     would record when the bookkeeping was repaired, not when the warehouse
     changed. The receipt carries the moment the effect committed. */
  at: new Date(receipt.occurredAt),
  ...(receipt.previousState ? { previousState: receipt.previousState } : {}),
  ...(receipt.resultingState ? { resultingState: receipt.resultingState } : {}),
  /* Every audit fact the first attempt would have written — a reason on any
     action that recorded one, not archive alone. */
  ...(receipt.reason ? { reason: receipt.reason } : {}),
  requestId: req.id || "",
  idempotencyKey: req.idempotent?.key || "",
  metadata: {
    ...(Array.isArray(receipt.fields) && receipt.fields.length ? { fields: receipt.fields } : {}),
    /* The generic subject maps back to the warehouse-facing metadata names the
       public history DTO already presents. */
    ...(receipt.subjectCode ? { locationCode: receipt.subjectCode } : {}),
    ...(receipt.subjectId ? { locationId: String(receipt.subjectId) } : {}),
    /* Says how this entry came to be written, without describing the
       machinery that wrote it. */
    recovered: true,
  },
});

/**
 * Finish an interrupted write and answer.
 *
 * ── WHAT THIS RESPONSE IS, AND IS NOT ───────────────────────────────────────
 * It is NOT the original response. That was never stored — only a COMPLETED
 * record keeps a body to replay, and this record never got that far. So it is
 * not labelled `replayed`, and it states the atomicity mode it actually had:
 * MARKED, degraded, because the change and its history were written
 * separately. Calling it an exact replay would be a claim nothing supports.
 */
async function completeRecovery(req, { receipt, warehouse, location }) {
  /* At most once: `recover` looks for an entry with this action AND this key
     before writing, so a recovery that is itself retried appends nothing. */
  await unitOfWork.recover(req.tenant, {
    entityType: ENTITY,
    entityId: receipt.entityId,
    idempotencyKey: req.idempotent?.key || "",
    entry: entryFromReceipt(req, receipt),
  });

  return req.idempotent.succeed(200, {
    success: true,
    message: "That change had already been applied. Its record has now been completed.",
    warehouse: publicWarehouse(warehouse),
    ...(location ? { location: publicLocation(location) } : {}),
    recovered: true,
    atomicity: { mode: "MARKED", degraded: true },
  }, { entityType: ENTITY, entityId: receipt.entityId });
}

/**
 * The facts a later recovery will need, captured as the effect commits.
 *
 * Allowlisted by construction: this function names every field, so nothing a
 * caller happens to have in scope can ride along. The schema behind it is a
 * closed subdocument, so even a mistake here cannot store an address, a
 * contact or a request body.
 */
const receiptFor = ({
  action, entityId, occurredAt, documentNumber = "",
  subjectId = null, subjectCode = "",
  previousState = "", resultingState = "", fields = null, reason = "",
}) => buildRecoveryReceipt({
  action,
  /* This router only ever writes WAREHOUSE records; the shared receipt is
     domain-neutral, so the domain is named explicitly here. */
  entityType: ENTITY,
  entityId,
  occurredAt,
  documentNumber,
  /* A warehouse location is the generic "subject" of the operation. */
  ...(subjectId ? { subjectType: "LOCATION", subjectId } : {}),
  ...(subjectCode ? { subjectCode } : {}),
  ...(previousState ? { previousState } : {}),
  ...(resultingState ? { resultingState } : {}),
  ...(Array.isArray(fields) && fields.length ? { fields } : {}),
  ...(reason ? { reason } : {}),
});

/** The whole recovery path, for a route that has nothing else to decide. */
async function recoverOrRefuse(req, opts) {
  return completeRecovery(req, await requireRecoveryEvidence(req, opts));
}

/** A warehouse in this tenant, or a structured not-found. */
async function loadWarehouse(req, id) {
  const oid = objectId(id);
  if (!oid) throw fail("NOT_FOUND", "That warehouse was not found.", { reason: "MALFORMED_ID" });
  const doc = await Warehouse.findOne(scoped(req, { _id: oid })).lean();
  if (!doc) throw fail("NOT_FOUND", "That warehouse was not found.", { reason: "WAREHOUSE_NOT_FOUND" });
  return doc;
}

/** An archived or legacy master accepts no changes. */
function assertMutable(w) {
  if (!w.companyId) {
    throw fail(
      "LEGACY_ACCESS_REQUIRED",
      "This warehouse was created before company ownership was recorded, so it is read-only until it has been migrated.",
      { reason: "LEGACY_RECORD_READ_ONLY" },
    );
  }
  if (w.status === "Archived") {
    throw fail(
      "LIFECYCLE_BLOCKED",
      /* Archiving is terminal through this workflow — the lifecycle route
         refuses to bring an archived warehouse back, and telling somebody to
         "reactivate it first" pointed them at a control that will refuse. */
      "This warehouse is archived and cannot be changed. Archiving is terminal through this workflow.",
      { reason: "WAREHOUSE_ARCHIVED" },
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * REFERENCE DATA
 *
 * Declared BEFORE `/:id`. Express matches in declaration order, and with the
 * parameter route first these were captured by it.
 * ═════════════════════════════════════════════════════════════════════════ */

router.get("/capacity/units", requireCapability(CAPABILITIES.READ), (_req, res) => {
  /* ── EACH UNIT CARRIES ITS OWN DIMENSION ──────────────────────────────
     A single `measures: "FLOOR_SPACE"` across this list was wrong about most
     of it: cubic metres are a volume and pallet positions are a count.
     Nothing downstream should have to guess which. */
  res.json({
    success: true,
    units: Object.entries(UNIT_DIMENSIONS).map(([value, dimension]) => ({
      value, dimension, label: DIMENSION_LABELS[dimension],
    })),
    dimensions: DIMENSION_LABELS,
  });
});


router.get("/types/suggestions", requireCapability(CAPABILITIES.READ), (_req, res) => {
  res.json({
    success: true,
    locationTypes: [
      { value: "RECEIVING", label: "Receiving" },
      { value: "INSPECTION", label: "Inspection" },
      { value: "USABLE_STOCK", label: "Usable stock" },
      { value: "QUARANTINE", label: "Quarantine" },
      { value: "RETURNS", label: "Returns" },
      { value: "SCRAP", label: "Scrap" },
      { value: "RACK_BIN", label: "Rack or bin" },
      { value: "OTHER", label: "Other" },
    ],
    lifecycle: ["Active", "Inactive", "Archived"],
  });
});

/** Is this code free in this company? Used by the form before it submits. */
router.get("/code-available", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const code = text(req.query.code).toUpperCase();
    if (!code) return res.json({ success: true, available: false, reason: "A code is required." });
    const exclude = objectId(req.query.excludeId);
    const clash = await Warehouse.findOne(
      scoped(req, { shortName: code, ...(exclude ? { _id: { $ne: exclude } } : {}) }),
    ).lean();
    res.json({ success: true, available: !clash });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * REGISTER
 * ═════════════════════════════════════════════════════════════════════════ */

/** The immutable record of everything done to one warehouse. */
/* ── WHAT A HISTORY ENTRY IS ALLOWED TO SAY ────────────────────────────────
   `metadata` was returned whole. It is written by every route that records
   anything, so what reaches the screen was whatever the newest write happened
   to put there — a growing, unreviewed surface with no contract, and the
   place an internal id or an actor's details leaks from without anyone
   deciding it should.

   These are the keys this screen displays, and nothing else crosses. */
const HISTORY_METADATA_KEYS = Object.freeze([
  "code", "fields", "locationType", "standardLocations", "recovered",
  /* ── THE LOCATION, IDENTIFIED ────────────────────────────────────────
     The code alone is not identity: it can be renamed, and then given to a
     different location. A trail that shows only codes cannot tell two
     locations apart after that, which is exactly the case somebody reads
     history to settle. The id is stable and says nothing private — it is
     already in every location URL this screen links to. */
  "locationCode", "locationId",
]);

const publicHistoryEntry = (e) => {
  const meta = e.metadata || {};
  const shown = {};
  for (const key of HISTORY_METADATA_KEYS) {
    if (meta[key] !== undefined) shown[key] = meta[key];
  }
  return {
    id: String(e._id),
    at: e.at,
    action: e.action,
    actorName: e.actorName || "",
    previousState: e.previousState || null,
    resultingState: e.resultingState || null,
    reason: e.reason || "",
    /* Accurate about the guarantee, not reassuring: this entry was written
       outside a transaction with the change it describes. */
    atomicityDegraded: e.atomicityDegraded === true,
    metadata: shown,
  };
};

/* ── A CURSOR, NOT AN OFFSET ───────────────────────────────────────────────
   History is append-only and read newest-first, so page 2 of an offset query
   is taken against a list that grew while page 1 was being read: every new
   entry pushes one down, and the reader sees an entry twice or never sees it
   at all. An audit trail that skips entries while being paged is worse than
   one that is hard to page.

   The cursor is the sort key itself — `at` and `_id`, the tiebreak that makes
   it total — so the next page continues from where the last one ended
   regardless of what has been written since. Malformed cursors are refused
   rather than silently starting from the top, because a caller who thinks
   they are on page 3 must not be handed page 1. */
const encodeCursor = (e) => Buffer.from(`${new Date(e.at).toISOString()}|${e._id}`).toString("base64url");

function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === "") return null;
  const parts = Buffer.from(String(raw), "base64url").toString("utf8").split("|");
  const at = new Date(parts[0]);
  if (parts.length !== 2 || Number.isNaN(at.getTime()) || !mongoose.Types.ObjectId.isValid(parts[1])) {
    throw fail("VALIDATION", "That history cursor is not one this screen issued.",
      { reason: "HISTORY_CURSOR_INVALID" });
  }
  return { at, _id: new mongoose.Types.ObjectId(parts[1]) };
}

router.get("/:id/history", requireCapability(CAPABILITIES.HISTORY_READ), async (req, res) => {
  try {
    /* Load through the tenant scope FIRST: another company's warehouse must
       read as missing, so its history cannot be probed by id. */
    const w = await loadWarehouse(req, req.params.id);
    const { limit } = paging(req.query);
    const after = decodeCursor(req.query.cursor);

    const filter = {
      companyId: req.tenant.companyId,
      entityType: ENTITY,
      entityId: w._id,
      /* Strictly past the last entry of the previous page, in the same total
         order the sort uses. */
      ...(after ? {
        $or: [
          { at: { $lt: after.at } },
          { at: after.at, _id: { $lt: after._id } },
        ],
      } : {}),
    };

    /* One extra row, so "is there more" is a fact rather than an inference
       from a count that may already be out of date. */
    const rows = await SpActionHistory.find(filter)
      .sort({ at: -1, _id: -1 }).limit(limit + 1).lean();

    const hasMore = rows.length > limit;
    const entries = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      success: true,
      /* No `total` and no page number. Both would be a snapshot of a list that
         is still being appended to, and neither is needed to read it. */
      paging: {
        limit,
        hasMore,
        nextCursor: hasMore && entries.length ? encodeCursor(entries[entries.length - 1]) : null,
      },
      entries: entries.map(publicHistoryEntry),
    });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[warehouse history read]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const { search = "", status = "" } = req.query;
    const { page, limit, skip } = paging(req.query);

    const narrow = {};
    if (["Active", "Inactive", "Archived"].includes(status)) narrow.status = status;
    if (text(search)) {
      const esc = escapeRegex(search);
      narrow.$or = [
        { name: { $regex: esc, $options: "i" } },
        { shortName: { $regex: esc, $options: "i" } },
      ];
    }
    const filter = scoped(req, narrow);

    const [total, rows] = await Promise.all([
      Warehouse.countDocuments(filter),
      Warehouse.find(filter)
        /* Deterministic: name then _id, so paging cannot repeat or skip a row
           when two warehouses share a name. */
        .sort({ name: 1, _id: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    res.json({
      success: true,
      warehouses: rows.map(publicWarehouse),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) || 1 },
      /* A count of RECORDS. The old summary summed `itemsCount` and served it
         as inventory. */
      summary: {
        warehouses: total,
        note: "A count of warehouse records. No stock or utilisation is implied.",
      },
      capabilities: CAPABILITY_NOTE,
    });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[warehouses list]", err);
    res.status(500).json({ success: false, message: "Server error while loading warehouses" });
  }
});

router.get("/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const w = await loadWarehouse(req, req.params.id);
    res.json({ success: true, warehouse: publicWarehouse(w), capabilities: CAPABILITY_NOTE });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    console.error("[warehouse detail]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/:id/locations", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const w = await loadWarehouse(req, req.params.id);
    res.json({
      success: true,
      locations: (w.locations || []).map(publicLocation),
      capabilities: CAPABILITY_NOTE,
    });
  } catch (err) {
    if (err?.name === "StorePurchaseError") return sendError(res, err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ══════════════════════════════════════════════════════════════════════════
 * CREATE
 * ═════════════════════════════════════════════════════════════════════════ */

router.post(
  "/",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("WAREHOUSE_CREATE"),
  async (req, res) => {
    try {
      assertTenantInput(req);
      const name = text(req.body.name);
      if (!name) throw fail("VALIDATION", "A warehouse name is required.", { reason: "NAME_REQUIRED" });
      const code = assertCode(req.body.code || req.body.shortName, "warehouse");

      if (req.idempotent?.recovering) {
        /* This key already created a warehouse. There is no ordinary path
           from here — either the record is completed, or a person looks. */
        return await recoverOrRefuse(req, { action: "WAREHOUSE_CREATED" });
      }

      const clash = await Warehouse.findOne(scoped(req, { shortName: code })).lean();
      if (clash) {
        throw fail("VALIDATION",
          `A warehouse with the code ${code} already exists in this company.`,
          { reason: "DUPLICATE_WAREHOUSE_CODE", code });
      }

      /* The structured field only. A string in `capacity` is legacy data,
         never something a new record starts with. */
      const capacity = assertCapacity(req.body?.capacityDetail);
      const actor = objectId(req.user?.id);

      /* ── STANDARD LOCATIONS, IN THE SAME WRITE ────────────────────────
         Created with the warehouse rather than afterwards, so a warehouse
         cannot exist half-configured in a way a second request would have to
         finish. One document, one insert — atomic by construction. */
      const locations = Warehouse.STANDARD_LOCATIONS.map((l) => ({
        ...l, status: "Active", createdBy: actor,
      }));

      /* ── IDENTITY AND TIME, BEFORE THE WRITE ──────────────────────────
         The receipt must be built and validated BEFORE the mutation, so the
         warehouse `_id` and the event time are fixed here rather than read
         back out of the created document. */
      const warehouseId = new mongoose.Types.ObjectId();
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: "WAREHOUSE_CREATED",
        entityId: warehouseId,
        occurredAt,
        documentNumber: code,
        resultingState: "Active",
      });

      const { result, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        const [created] = await Warehouse.create([{
          _id: warehouseId,
          /* Ownership comes from the resolved context. Whatever the body says
             about company, site, lifecycle, audit actors or counters is
             ignored — none of those are read from `req.body` anywhere here. */
          ...tenantContext.stamp(req.tenant),
          name,
          shortName: code,
          address: text(req.body.address),
          addressDetail: {
            line1: text(req.body?.addressDetail?.line1),
            line2: text(req.body?.addressDetail?.line2),
            city: text(req.body?.addressDetail?.city),
            state: text(req.body?.addressDetail?.state),
            postalCode: text(req.body?.addressDetail?.postalCode),
            country: text(req.body?.addressDetail?.country),
          },
          contactPerson: {
            name: text(req.body?.contactPerson?.name),
            phone: text(req.body?.contactPerson?.phone),
            email: text(req.body?.contactPerson?.email),
          },
          capacityDetail: capacity,
          description: text(req.body.description),
          status: "Active",
          locations,
          createdBy: actor,
        }], { session });

        return {
          entityType: ENTITY,
          entityId: created._id,
          entry: {
            entityType: ENTITY,
            entityId: created._id,
            documentNumber: created.shortName,
            action: "WAREHOUSE_CREATED",
            resultingState: "Active",
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: { code, standardLocations: locations.length },
          },
          result: created,
        };
      } });

      const body = {
        success: true,
        warehouse: publicWarehouse(result.toObject ? result.toObject() : result),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: result._id })
        : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      if (err?.code === 11000) {
        return sendError(res, fail("VALIDATION",
          "A warehouse with that code already exists in this company.",
          { reason: "DUPLICATE_WAREHOUSE_CODE" }));
      }
      console.error("[warehouse create]", err);
      res.status(500).json({ success: false, message: "Server error while creating the warehouse" });
    }
  },
);

/* ══════════════════════════════════════════════════════════════════════════
 * UPDATE
 * ═════════════════════════════════════════════════════════════════════════ */

router.put(
  "/:id",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  /* The frontend sends a key through the governed writer. Without the
     middleware the key was accepted and ignored, so a retry re-applied the
     edit and a changed payload under the same key was never refused. */
  withIdempotency("WAREHOUSE_UPDATE", { target: warehouseTarget }),
  async (req, res) => {
    try {
      assertTenantInput(req);

      /* The edit already landed under this key. Re-applying it would fail the
         version precondition — the first attempt incremented it — and the
         caller would be told somebody else had interfered. */
      if (req.idempotent?.recovering) {
        return await recoverOrRefuse(req, {
          action: "WAREHOUSE_UPDATED",
          urlWarehouseId: req.params.id,
        });
      }

      const current = await loadWarehouse(req, req.params.id);
      assertMutable(current);

      const $set = { updatedBy: objectId(req.user?.id) };
      if (req.body.name !== undefined) {
        const name = text(req.body.name);
        if (!name) throw fail("VALIDATION", "A warehouse name is required.", { reason: "NAME_REQUIRED" });
        $set.name = name;
      }
      if (req.body.code !== undefined || req.body.shortName !== undefined) {
        const code = assertCode(req.body.code ?? req.body.shortName, "warehouse");
        if (code !== current.shortName) {
          const clash = await Warehouse.findOne(
            scoped(req, { shortName: code, _id: { $ne: current._id } }),
          ).lean();
          if (clash) {
            throw fail("VALIDATION",
              `A warehouse with the code ${code} already exists in this company.`,
              { reason: "DUPLICATE_WAREHOUSE_CODE", code });
          }
        }
        $set.shortName = code;
      }
      for (const field of ["address", "description"]) {
        if (req.body[field] !== undefined) $set[field] = text(req.body[field]);
      }

      /* ── A PARTIAL FORM IS NOT AN ERASURE ───────────────────────────────
         Every supported key used to be written on every request that carried
         an `addressDetail` at all. A caller sending only `{ city: "Pune" }`
         — which is what a form editing one field sends — had line1, line2,
         state, postal code and country replaced with empty strings, and the
         history entry recorded a successful update.

         Only the keys the caller actually sent are written. An absent key is
         "I am not changing this"; an explicit "" is "clear this". They are
         different instructions and are now treated as such. */
      mergeNested($set, "addressDetail", req.body.addressDetail,
        ["line1", "line2", "city", "state", "postalCode", "country"]);
      mergeNested($set, "contactPerson", req.body.contactPerson,
        ["name", "phone", "email"]);

      if (req.body.capacityDetail !== undefined) {
        /* Validated as a whole: a value without a unit, an unsupported unit
           or a non-finite number is refused rather than half-stored. */
        const capacity = assertCapacity(req.body.capacityDetail);
        $set["capacityDetail.value"] = capacity.value;
        $set["capacityDetail.unit"] = capacity.unit;
        $set["capacityDetail.dimension"] = capacity.dimension;
      }
      /* ── THE LEGACY STRING IS NOT REWRITTEN HERE ────────────────────────
         The untouched legacy form still PUTs `capacity` as a string. Writing
         it through the structured reader turned a real measurement into an
         object whose value was null — the old text simply disappeared. It is
         left exactly as stored; the structured field is where new values go. */
      /* Lifecycle, ownership, audit actors and counters are NOT settable
         here — each has its own governed route, or no route at all. */

      const expected = assertExpectedVersion(req.body.expectedVersion, current);

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         Everything it records is known now: the id, the code as it will read
         after this edit (a rename sets $set.shortName), the fields changed and
         the time. An update never changes status, so the resulting state is
         the current one. */
      const changedFields = Object.keys($set).filter((k) => k !== "updatedBy");
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: "WAREHOUSE_UPDATED",
        entityId: current._id,
        occurredAt,
        documentNumber: $set.shortName || current.shortName,
        resultingState: current.status,
        fields: changedFields,
      });

      const { result: updated, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        /* ── THE LOSING WRITE STOPS HERE ──────────────────────────────────
           Conditioned on the version the edit was composed against. A stale
           edit matches no document, so nothing is written, and the throw
           below happens BEFORE the history entry and BEFORE the idempotency
           effect marker — a conflict leaves no trace of an action that did
           not occur. */
        const doc = await Warehouse.findOneAndUpdate(
          scoped(req, {
            _id: current._id,
            status: { $ne: "Archived" },
            /* A document written before this field existed has no
               `recordVersion` at all, and `{recordVersion: 0}` does not match
               a missing field — it would make every pre-existing warehouse
               permanently unwritable. Version 0 therefore also means absent. */
            recordVersion: expected === 0 ? { $in: [0, null] } : expected,
          }),
          { $set, $inc: { recordVersion: 1 } },
          { new: true, runValidators: true, session },
        ).lean();

        if (!doc) {
          /* Which of the two preconditions failed? Told apart by re-reading,
             because "somebody else edited this" and "this was archived" need
             different things from the person who hit it. */
          const latest = await Warehouse.findOne(scoped(req, { _id: current._id }))
            .select("status recordVersion updatedAt updatedBy").lean();
          if (!latest || latest.status === "Archived") {
            throw fail("LIFECYCLE_BLOCKED",
              "This warehouse could not be updated — it may have been archived while you were editing it.",
              { reason: "WAREHOUSE_ARCHIVED" });
          }
          throw fail("CONFLICT",
            "Somebody else changed this warehouse while you were editing it. Reload it and apply your changes again.",
            {
              reason: "STALE_VERSION",
              expectedVersion: expected,
              currentVersion: latest.recordVersion ?? 0,
              changedAt: latest.updatedAt || null,
            });
        }

        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: "WAREHOUSE_UPDATED",
            resultingState: doc.status,
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            /* The FIELDS that changed, not their values. */
            metadata: { fields: changedFields },
          },
          result: doc,
        };
      } });

      const body = {
        success: true,
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: updated._id })
        : res.json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      if (err?.code === 11000) {
        return sendError(res, fail("VALIDATION",
          "A warehouse with that code already exists in this company.",
          { reason: "DUPLICATE_WAREHOUSE_CODE" }));
      }
      console.error("[warehouse update]", err);
      res.status(500).json({ success: false, message: "Server error while updating the warehouse" });
    }
  },
);

/* ══════════════════════════════════════════════════════════════════════════
 * LIFECYCLE
 * ═════════════════════════════════════════════════════════════════════════ */

const LIFECYCLE_ACTIONS = Object.freeze({
  activate: "Active",
  deactivate: "Inactive",
  archive: "Archived",
});

router.patch(
  "/:id/lifecycle",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("WAREHOUSE_LIFECYCLE", { target: warehouseTarget }),
  async (req, res) => {
    try {
      const action = text(req.body.action).toLowerCase();
      const next = LIFECYCLE_ACTIONS[action];
      if (!next) {
        throw fail("VALIDATION",
          "A warehouse can be activated, deactivated or archived.",
          { reason: "INVALID_LIFECYCLE_ACTION", allowed: Object.keys(LIFECYCLE_ACTIONS) });
      }
      assertTenantInput(req);

      const historyAction = next === "Archived" ? "WAREHOUSE_ARCHIVED"
        : next === "Inactive" ? "WAREHOUSE_DEACTIVATED" : "WAREHOUSE_ACTIVATED";

      /* ── THE TRANSITION ALREADY HAPPENED ──────────────────────────────
         The effect marker is present, so this exact key already moved this
         exact warehouse. Re-running the compare-and-set would find the
         status already changed and report a LIFECYCLE_CONFLICT — telling
         the caller somebody else interfered, when in fact their own first
         attempt succeeded. The unfinished part is the history entry. */
      if (req.idempotent?.recovering) {
        return await recoverOrRefuse(req, {
          action: historyAction,
          urlWarehouseId: req.params.id,
        });
      }

      const current = await loadWarehouse(req, req.params.id);
      if (!current.companyId) {
        throw fail("LEGACY_ACCESS_REQUIRED",
          "This warehouse was created before company ownership was recorded, so it is read-only until it has been migrated.",
          { reason: "LEGACY_RECORD_READ_ONLY" });
      }

      /* ── ARCHIVE IS TERMINAL HERE ─────────────────────────────────────
         An archived master is read-only, and "activate" must not quietly
         become "restore". Bringing one back is a deliberate act that belongs
         with a governed restore path, not with the ordinary control that also
         un-pauses an inactive record. */
      if (current.status === "Archived" && next !== "Archived") {
        throw fail("LIFECYCLE_BLOCKED",
          "This warehouse is archived. Archiving is final through this screen — an archived warehouse is not reactivated here.",
          { reason: "ARCHIVE_IS_TERMINAL", status: current.status });
      }

      if (current.status === next) {
        const same = {
          success: true,
          message: `This warehouse is already ${next.toLowerCase()}.`,
          warehouse: publicWarehouse(current),
        };
        return req.idempotent
          ? await req.idempotent.succeed(200, same, { entityType: ENTITY, entityId: current._id })
          : res.json(same);
      }

      const reason = text(req.body.reason);
      if (next === "Archived" && reason.length < 4) {
        throw fail("VALIDATION",
          "Say why this warehouse is being archived. It is kept, and the reason is recorded with it.",
          { reason: "ARCHIVE_REASON_REQUIRED" });
      }

      /* ── A LIFECYCLE ACTION IS AN EDIT LIKE ANY OTHER ─────────────────
         It changes a warehouse FIELD, so it belongs under the same record
         version as every other field change. The write incremented
         `recordVersion` without ever checking it, which meant an "archive"
         chosen against a version somebody had since replaced still applied
         — and silently bumped the version other editors were relying on.

         Deliberately NOT `structureVersion`: that guards the embedded
         location array, and coupling the two would make adding a location
         invalidate an unrelated pending archive. The separation is the
         documented one and it stays. */
      const expected = assertExpectedVersion(req.body.expectedVersion, current);

      const actor = objectId(req.user?.id);
      const $set = { status: next, updatedBy: actor };
      if (next === "Archived") {
        $set.archivedAt = new Date();
        $set.archivedBy = actor;
        $set.archiveReason = reason;
      } else {
        $set.archivedAt = null;
        $set.archivedBy = null;
        $set.archiveReason = "";
      }

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         The transition (from `current.status` to `next`) and the reason are
         known now. The reason is carried whenever the history entry carries
         one — not archive alone — so a recovered deactivate keeps a reason the
         first attempt recorded. */
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: historyAction,
        entityId: current._id,
        occurredAt,
        documentNumber: current.shortName,
        previousState: current.status,
        resultingState: next,
        reason,
      });

      /* ── COMPARE AND SET ──────────────────────────────────────────────
         The transition was decided against `current.status`. Writing without
         that precondition lets two concurrent changes both apply, and the
         history then records a transition FROM a state the record was no
         longer in. */
      const { result: updated, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        /* ── COMPARE AND SET ────────────────────────────────────────────
           The transition was decided against `current.status`. Writing
           without that precondition lets two concurrent changes both apply,
           and the history then records a transition FROM a state the record
           was no longer in. Inside the unit of work, so a refusal here
           leaves neither a history entry nor an effect marker. */
        const doc = await Warehouse.findOneAndUpdate(
          scoped(req, {
            _id: current._id,
            status: current.status,
            /* Version 0 also means "written before this field existed" —
               `{recordVersion: 0}` does not match a missing field, and
               without this every pre-existing warehouse would be frozen. */
            recordVersion: expected === 0 ? { $in: [0, null] } : expected,
          }),
          { $set, $inc: { recordVersion: 1 } },
          { new: true, session },
        ).lean();
        if (!doc) {
          /* Two preconditions, two different things to tell the person. A
             throw here happens BEFORE the history entry and BEFORE the
             effect marker, so a refused action leaves no trace of one. */
          const latest = await Warehouse.findOne(scoped(req, { _id: current._id }))
            .select("status recordVersion updatedAt").lean();
          if (latest && (latest.recordVersion ?? 0) !== expected) {
            throw fail("CONFLICT",
              "Somebody else changed this warehouse while you were deciding. Reload it and choose again.",
              {
                reason: "STALE_VERSION",
                expectedVersion: expected,
                currentVersion: latest.recordVersion ?? 0,
                changedAt: latest.updatedAt || null,
              });
          }
          throw fail("LIFECYCLE_BLOCKED",
            "This warehouse's status changed while your request was being made. Reload it and try again.",
            { reason: "LIFECYCLE_CONFLICT", expected: current.status });
        }
        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: historyAction,
            previousState: current.status,
            resultingState: next,
            reason,
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
          },
          result: doc,
        };
      } });

      const body = {
        success: true,
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: updated._id })
        : res.json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[warehouse lifecycle]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

/* ── THE LEGACY DELETE ─────────────────────────────────────────────────────
   Kept so an existing caller gets an answer it can act on rather than a 404
   that looks as though the record were already gone. It destroys nothing: a
   warehouse is a master record that locations, receipts and movements refer
   to, and removing one would break every reference to it. */
router.delete("/:id", requireCapability(CAPABILITIES.MASTER_MAINTAIN), (_req, res) =>
  sendError(res, fail(
    "LIFECYCLE_BLOCKED",
    "A warehouse is never deleted. Archive it instead — the record is kept, and anything that refers to it stays readable.",
    { reason: "DELETE_NOT_SUPPORTED", useInstead: 'PATCH /:id/lifecycle { action: "archive", reason }' },
  )),
);

/* ══════════════════════════════════════════════════════════════════════════
 * LOCATIONS
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Would this parent produce a valid hierarchy?
 *
 * Refuses a parent that is not in this warehouse, the location itself, a
 * descendant of it (which would close a loop), and an archived parent.
 */
function assertParent(warehouse, parentId, selfId) {
  if (parentId === null || parentId === undefined || parentId === "") return null;
  const pid = objectId(parentId);
  if (!pid) throw fail("VALIDATION", "That parent location was not found in this warehouse.", { reason: "PARENT_NOT_FOUND" });

  const byId = new Map((warehouse.locations || []).map((l) => [String(l._id), l]));
  const parent = byId.get(String(pid));
  if (!parent) {
    /* A location from ANOTHER warehouse reads exactly as a missing one. */
    throw fail("VALIDATION", "That parent location was not found in this warehouse.", { reason: "PARENT_NOT_FOUND" });
  }
  if (selfId && String(pid) === String(selfId)) {
    throw fail("VALIDATION", "A location cannot be its own parent.", { reason: "SELF_PARENT" });
  }
  if (parent.status === "Archived") {
    throw fail("VALIDATION", "That parent location is archived, so nothing can be placed inside it.", { reason: "PARENT_ARCHIVED" });
  }
  /* An INACTIVE parent was allowed, which put an active location inside a
     closed one — the invariant the lifecycle routes enforce, broken at the
     moment of creation instead. */
  if (parent.status !== "Active") {
    throw fail("VALIDATION",
      `${parent.code} is ${String(parent.status).toLowerCase()}, so nothing can be placed inside it.`,
      { reason: "PARENT_NOT_ACTIVE", parent: parent.code, parentStatus: parent.status });
  }

  /* Walk up from the proposed parent. Meeting `selfId` means the proposed
     parent already sits beneath this location, so linking them would close a
     loop no traversal could escape. */
  if (selfId) {
    const seen = new Set();
    let cursor = parent;
    while (cursor) {
      const key = String(cursor._id);
      if (seen.has(key)) {
        throw fail("VALIDATION", "That parent would create a loop in the location hierarchy.", { reason: "HIERARCHY_CYCLE" });
      }
      seen.add(key);
      if (key === String(selfId)) {
        throw fail("VALIDATION", "That parent sits inside this location, so it cannot also contain it.", { reason: "HIERARCHY_CYCLE" });
      }
      cursor = cursor.parent ? byId.get(String(cursor.parent)) : null;
    }
  }
  return pid;
}

/* ── THE HIERARCHY INVARIANT ───────────────────────────────────────────────
   A location is reachable only through its ancestors, so an ACTIVE location
   underneath an inactive or archived one is a contradiction: the chain that
   leads to it is closed, and anything shown as usable there is not.

   Only the DIRECT parent and the DIRECT children were checked, which caught
   nothing beyond one hop. Deactivating a rack left every bin inside it
   active; activating a bin whose rack's aisle was inactive was allowed. Both
   traversals below walk the whole chain, with cycle protection — a cycle
   should be impossible because `assertParent` refuses to create one, but a
   traversal that trusts that assumption hangs the process if it is ever
   wrong, and old data was written before the rule existed. */

const locationIndex = (warehouse) =>
  new Map((warehouse.locations || []).map((l) => [String(l._id), l]));

/** Every ancestor of `location`, nearest first. Stops on a cycle. */
function ancestorsOf(warehouse, location) {
  const byId = locationIndex(warehouse);
  const out = [];
  const seen = new Set([String(location._id)]);
  let cursor = location.parent ? byId.get(String(location.parent)) : null;
  while (cursor && !seen.has(String(cursor._id))) {
    seen.add(String(cursor._id));
    out.push(cursor);
    cursor = cursor.parent ? byId.get(String(cursor.parent)) : null;
  }
  return out;
}

/** Every location beneath `location`, at any depth. Stops on a cycle. */
function descendantsOf(warehouse, location) {
  const children = new Map();
  for (const l of warehouse.locations || []) {
    const key = l.parent ? String(l.parent) : "";
    if (!key) continue;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(l);
  }
  const out = [];
  const seen = new Set([String(location._id)]);
  const queue = [...(children.get(String(location._id)) || [])];
  while (queue.length) {
    const node = queue.shift();
    if (seen.has(String(node._id))) continue;
    seen.add(String(node._id));
    out.push(node);
    queue.push(...(children.get(String(node._id)) || []));
  }
  return out;
}

/** A location may only be active if every location above it is. */
function assertAncestorsActive(warehouse, location) {
  const blocked = ancestorsOf(warehouse, location).find((a) => a.status !== "Active");
  if (blocked) {
    throw fail("LIFECYCLE_BLOCKED",
      `${blocked.code} is ${String(blocked.status).toLowerCase()}, and this location sits inside it. Activate ${blocked.code} first.`,
      { reason: "ANCESTOR_NOT_ACTIVE", ancestor: blocked.code, ancestorStatus: blocked.status });
  }
}

/** A location may only be closed once nothing beneath it is still open. */
function assertNoActiveDescendants(warehouse, location, verb) {
  const open = descendantsOf(warehouse, location).filter((d) => d.status === "Active");
  if (open.length) {
    throw fail("LIFECYCLE_BLOCKED",
      `This location still contains ${open.length} active location${open.length === 1 ? "" : "s"}. ${verb} those first.`,
      { reason: "LOCATION_HAS_ACTIVE_DESCENDANTS", descendants: open.map((d) => d.code) });
  }
}

router.post(
  "/:id/locations",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("LOCATION_CREATE", { target: warehouseTarget }),
  async (req, res) => {
    try {
      assertTenantInput(req);
      const w = await loadWarehouse(req, req.params.id);
      assertMutable(w);

      const code = assertCode(req.body.code, "location");
      const name = text(req.body.name);
      const type = text(req.body.type).toUpperCase();
      if (!name) throw fail("VALIDATION", "A location name is required.", { reason: "NAME_REQUIRED" });
      if (!Warehouse.LOCATION_TYPES.includes(type)) {
        throw fail("VALIDATION", "Choose one of the supported location types.",
          { reason: "INVALID_LOCATION_TYPE", allowed: Warehouse.LOCATION_TYPES });
      }
      /* Derived from the idempotency RECORD, not the key: the same key is
         legitimately re-usable by another actor, company or operation. Fixed
         before the write so the receipt can record it. */
      const newLocationId = locationIdForRecord(req.idempotent?.record);

      if (req.idempotent?.recovering) {
        /* Located by the RECORDED id — never by code, and never by
           recomputing it here. */
        return await recoverOrRefuse(req, {
          action: "LOCATION_CREATED",
          urlWarehouseId: req.params.id,
          needsLocation: true,
        });
      }

      if ((w.locations || []).some((l) => l.code === code)) {
        throw fail("VALIDATION",
          `A location with the code ${code} already exists in this warehouse.`,
          { reason: "DUPLICATE_LOCATION_CODE", code });
      }
      const parent = assertParent(w, req.body.parent, null);
      const actor = objectId(req.user?.id);
      const seenVersion = w.structureVersion || 0;

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         The warehouse id, the pre-assigned location id, the code and the time
         are all known now. The location is the generic "subject". */
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: "LOCATION_CREATED",
        entityId: w._id,
        occurredAt,
        documentNumber: w.shortName,
        subjectId: newLocationId,
        subjectCode: code,
        resultingState: "Active",
      });

      const { result, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        /* The `locations.code` guard makes the insert conditional on the code
           still being free, so two simultaneous creates cannot both land. */
        const doc = await Warehouse.findOneAndUpdate(
          /* The version pins the SNAPSHOT the parent and duplicate checks were
             decided against. If anything structural changed since, this matches
             nothing and the caller re-reads rather than writing on stale intent. */
          scoped(req, {
            _id: w._id,
            status: { $ne: "Archived" },
            structureVersion: seenVersion,
            "locations.code": { $ne: code },
          }),
          {
            $push: {
              locations: {
                _id: newLocationId,
                code, name, type, parent,
                status: "Active",
                barcode: text(req.body.barcode),
                description: text(req.body.description),
                createdBy: actor,
              },
            },
            $set: { updatedBy: actor },
            $inc: { structureVersion: 1 },
          },
          { new: true, runValidators: true, session },
        ).lean();

        if (!doc) {
          /* Either the code was taken, or the warehouse changed underneath the
             checks. Both are a conflict the caller resolves by re-reading. */
          const fresh = await Warehouse.findOne(scoped(req, { _id: w._id })).lean();
          const taken = (fresh?.locations || []).some((l) => l.code === code);
          throw fail(
            taken ? "VALIDATION" : "IDEMPOTENCY_IN_PROGRESS",
            taken
              ? `A location with the code ${code} already exists in this warehouse.`
              : "This warehouse changed while the location was being added. Reload it and try again.",
            { reason: taken ? "DUPLICATE_LOCATION_CODE" : "STRUCTURE_CONFLICT", code },
          );
        }

        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: "LOCATION_CREATED",
            resultingState: "Active",
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: {
              locationCode: code, locationType: type,
              locationId: String(newLocationId),
              parent: parent ? String(parent) : null,
            },
          },
          result: doc,
        };
      } });

      const updated = result;
      const created = (updated.locations || []).find((l) => String(l._id) === String(newLocationId));

      const body = {
        success: true,
        location: publicLocation(created),
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(201, body, { entityType: ENTITY, entityId: updated._id })
        : res.status(201).json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[location create]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put(
  "/:id/locations/:locationId",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("LOCATION_UPDATE", { target: locationTarget }),
  async (req, res) => {
    try {
      assertTenantInput(req);

      /* The edit already landed under this key. The URL names the location
         exactly, so there is no ambiguity about which one to complete. */
      if (req.idempotent?.recovering) {
        return await recoverOrRefuse(req, {
          action: "LOCATION_UPDATED",
          urlWarehouseId: req.params.id,
          urlLocationId: req.params.locationId,
          needsLocation: true,
        });
      }

      const w = await loadWarehouse(req, req.params.id);
      assertMutable(w);

      const lid = objectId(req.params.locationId);
      const current = lid ? (w.locations || []).find((l) => String(l._id) === String(lid)) : null;
      if (!current) throw fail("NOT_FOUND", "That location was not found in this warehouse.", { reason: "LOCATION_NOT_FOUND" });
      if (current.status === "Archived") {
        throw fail("LIFECYCLE_BLOCKED",
          "This location is archived and cannot be changed.",
          { reason: "LOCATION_ARCHIVED" });
      }

      const seenVersion = w.structureVersion || 0;
      const $set = { "locations.$[l].updatedBy": objectId(req.user?.id) };
      let renamedTo = null;
      if (req.body.code !== undefined) {
        const code = assertCode(req.body.code, "location");
        renamedTo = code;
        if (code !== current.code && (w.locations || []).some((l) => l.code === code)) {
          throw fail("VALIDATION",
            `A location with the code ${code} already exists in this warehouse.`,
            { reason: "DUPLICATE_LOCATION_CODE", code });
        }
        $set["locations.$[l].code"] = code;
      }
      if (req.body.name !== undefined) {
        const name = text(req.body.name);
        if (!name) throw fail("VALIDATION", "A location name is required.", { reason: "NAME_REQUIRED" });
        $set["locations.$[l].name"] = name;
      }
      if (req.body.type !== undefined) {
        const type = text(req.body.type).toUpperCase();
        if (!Warehouse.LOCATION_TYPES.includes(type)) {
          throw fail("VALIDATION", "Choose one of the supported location types.",
            { reason: "INVALID_LOCATION_TYPE", allowed: Warehouse.LOCATION_TYPES });
        }
        $set["locations.$[l].type"] = type;
      }
      if (req.body.parent !== undefined) {
        $set["locations.$[l].parent"] = assertParent(w, req.body.parent, current._id);
      }
      if (req.body.status !== undefined) {
        /* A status change is not an edit of the location's identity, and
           recording it as LOCATION_UPDATED said nothing about what happened.
           It has its own route and its own history action. */
        throw fail("VALIDATION",
          "Use the location lifecycle action to activate or deactivate a location.",
          { reason: "USE_LIFECYCLE_ROUTE", useInstead: "PATCH /:id/locations/:locationId/lifecycle" });
      }
      for (const f of ["barcode", "description"]) {
        if (req.body[f] !== undefined) $set[`locations.$[l].${f}`] = text(req.body[f]);
      }

      /* ── THE RENAME RACE ───────────────────────────────────────────────
         Create had an atomic duplicate guard; rename had only the snapshot
         check above, so two concurrent renames to the same free code both
         passed it and both wrote. The version pins the snapshot, and for a
         rename the code must ALSO still be free at write time. */
      const guard = {
        _id: w._id,
        status: { $ne: "Archived" },
        structureVersion: seenVersion,
        ...(renamedTo && renamedTo !== current.code ? { "locations.code": { $ne: renamedTo } } : {}),
      };

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         The subject id is fixed (the URL names it), its code as it will read
         after this edit is `renamedTo || current.code`, and an update never
         changes a location's status. The changed field names are known now. */
      const changedFields = Object.keys($set).filter((k) => !k.endsWith("updatedBy"))
        .map((k) => k.replace("locations.$[l].", ""));
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: "LOCATION_UPDATED",
        entityId: w._id,
        occurredAt,
        documentNumber: w.shortName,
        subjectId: current._id,
        subjectCode: renamedTo || current.code,
        resultingState: current.status,
        fields: changedFields,
      });

      const { result: updated, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        const doc = await Warehouse.findOneAndUpdate(
          scoped(req, guard),
          { $set, $inc: { structureVersion: 1 } },
          { new: true, runValidators: true, session, arrayFilters: [{ "l._id": current._id }] },
        ).lean();
        if (!doc) {
          const fresh = await Warehouse.findOne(scoped(req, { _id: w._id })).lean();
          if (!fresh) throw fail("NOT_FOUND", "That location was not found in this warehouse.", { reason: "LOCATION_NOT_FOUND" });
          const taken = renamedTo && (fresh.locations || []).some(
            (l) => l.code === renamedTo && String(l._id) !== String(current._id),
          );
          throw fail(
            taken ? "VALIDATION" : "IDEMPOTENCY_IN_PROGRESS",
            taken
              ? `A location with the code ${renamedTo} already exists in this warehouse.`
              : "This warehouse changed while the location was being edited. Reload it and try again.",
            { reason: taken ? "DUPLICATE_LOCATION_CODE" : "STRUCTURE_CONFLICT" },
          );
        }
        const now = (doc.locations || []).find((l) => String(l._id) === String(current._id));
        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: "LOCATION_UPDATED",
            resultingState: now?.status || current.status,
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: {
              locationCode: now?.code,
              locationId: String(current._id),
              fields: changedFields,
            },
          },
          result: doc,
        };
      } });

      const after = (updated.locations || []).find((l) => String(l._id) === String(current._id));
      const body = {
        success: true,
        location: publicLocation(after),
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: updated._id })
        : res.json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[location update]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.patch(
  "/:id/locations/:locationId/archive",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("LOCATION_ARCHIVE", { target: locationTarget }),
  async (req, res) => {
    try {
      assertTenantInput(req);

      if (req.idempotent?.recovering) {
        return await recoverOrRefuse(req, {
          action: "LOCATION_ARCHIVED",
          urlWarehouseId: req.params.id,
          urlLocationId: req.params.locationId,
          needsLocation: true,
        });
      }

      const w = await loadWarehouse(req, req.params.id);
      assertMutable(w);

      const lid = objectId(req.params.locationId);
      const current = lid ? (w.locations || []).find((l) => String(l._id) === String(lid)) : null;
      if (!current) throw fail("NOT_FOUND", "That location was not found in this warehouse.", { reason: "LOCATION_NOT_FOUND" });
      if (current.status === "Archived") {
        const already = { success: true, location: publicLocation(current), warehouse: publicWarehouse(w) };
        return req.idempotent
          ? await req.idempotent.succeed(200, already, { entityType: ENTITY, entityId: w._id })
          : res.json(already);
      }

      /* Archiving a parent would orphan whatever sits inside it — at ANY
         depth. The direct-children check missed a bin two levels down. */
      assertNoActiveDescendants(w, current, "Archive");

      const reason = text(req.body.reason);
      if (reason.length < 4) {
        throw fail("VALIDATION",
          "Say why this location is being archived. It is kept, and the reason is recorded with it.",
          { reason: "ARCHIVE_REASON_REQUIRED" });
      }

      const actor = objectId(req.user?.id);
      const seenVersion = w.structureVersion || 0;

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         Subject, transition and reason are all known now. */
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: "LOCATION_ARCHIVED",
        entityId: w._id,
        occurredAt,
        documentNumber: w.shortName,
        subjectId: current._id,
        subjectCode: current.code,
        previousState: current.status,
        resultingState: "Archived",
        reason,
      });

      const { result: updated, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        const doc = await Warehouse.findOneAndUpdate(
          /* Pinned to the snapshot the descendant check was decided against,
             so a child appearing in between cannot be orphaned. */
          scoped(req, { _id: w._id, status: { $ne: "Archived" }, structureVersion: seenVersion }),
          {
            $inc: { structureVersion: 1 },
            $set: {
              "locations.$[l].status": "Archived",
              "locations.$[l].archivedAt": new Date(),
              "locations.$[l].archivedBy": actor,
              "locations.$[l].archiveReason": reason,
              updatedBy: actor,
            },
          },
          { new: true, session, arrayFilters: [{ "l._id": current._id }] },
        ).lean();
        if (!doc) {
          throw fail("IDEMPOTENCY_IN_PROGRESS",
            "This warehouse changed while the location was being archived. Reload it and try again.",
            { reason: "STRUCTURE_CONFLICT" });
        }
        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: "LOCATION_ARCHIVED",
            previousState: current.status,
            resultingState: "Archived",
            reason,
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: { locationCode: current.code, locationId: String(current._id) },
          },
          result: doc,
        };
      } });

      const after = (updated.locations || []).find((l) => String(l._id) === String(current._id));
      const body = {
        success: true,
        location: publicLocation(after),
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: updated._id })
        : res.json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[location archive]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

/**
 * Activate or deactivate a location.
 *
 * Its own route, its own history actions. Routing this through the generic
 * edit recorded LOCATION_UPDATED, which is indistinguishable from a rename in
 * the audit trail. Archiving stays separate again — it is terminal and needs a
 * reason.
 */
router.patch(
  "/:id/locations/:locationId/lifecycle",
  requireCapability(CAPABILITIES.MASTER_MAINTAIN),
  refuseLegacyWrite,
  withIdempotency("LOCATION_LIFECYCLE", { target: locationTarget }),
  async (req, res) => {
    try {
      assertTenantInput(req);

      const action = text(req.body.action).toLowerCase();
      const next = action === "activate" ? "Active" : action === "deactivate" ? "Inactive" : null;
      if (!next) {
        throw fail("VALIDATION",
          "A location can be activated or deactivated. Archiving is a separate action.",
          { reason: "INVALID_LIFECYCLE_ACTION", allowed: ["activate", "deactivate"] });
      }

      if (req.idempotent?.recovering) {
        return await recoverOrRefuse(req, {
          action: next === "Active" ? "LOCATION_ACTIVATED" : "LOCATION_DEACTIVATED",
          urlWarehouseId: req.params.id,
          urlLocationId: req.params.locationId,
          needsLocation: true,
        });
      }

      const w = await loadWarehouse(req, req.params.id);
      assertMutable(w);

      const lid = objectId(req.params.locationId);
      const current = lid ? (w.locations || []).find((l) => String(l._id) === String(lid)) : null;
      if (!current) throw fail("NOT_FOUND", "That location was not found in this warehouse.", { reason: "LOCATION_NOT_FOUND" });
      if (current.status === "Archived") {
        throw fail("LIFECYCLE_BLOCKED",
          "This location is archived. Archiving is final — it is not reactivated here.",
          { reason: "ARCHIVE_IS_TERMINAL" });
      }
      if (current.status === next) {
        const same = { success: true, location: publicLocation(current), warehouse: publicWarehouse(w) };
        return req.idempotent
          ? await req.idempotent.succeed(200, same, { entityType: ENTITY, entityId: w._id })
          : res.json(same);
      }

      /* ── THE CHAIN, NOT ONE HOP ────────────────────────────────────────
         Activating a location whose grandparent is inactive would show it as
         usable through a route that is closed; deactivating one with open
         locations beneath it would strand them. Both walk the full chain. */
      if (next === "Active") assertAncestorsActive(w, current);
      else assertNoActiveDescendants(w, current, "Deactivate");

      const actor = objectId(req.user?.id);

      /* ── THE RECEIPT, BEFORE THE WRITE ────────────────────────────────
         Subject and transition are known now. */
      const occurredAt = new Date();
      const recoveryReceipt = receiptFor({
        action: next === "Active" ? "LOCATION_ACTIVATED" : "LOCATION_DEACTIVATED",
        entityId: w._id,
        occurredAt,
        documentNumber: w.shortName,
        subjectId: current._id,
        subjectCode: current.code,
        previousState: current.status,
        resultingState: next,
      });

      const { result: updated, mode } = await runWrite(req, { recoveryReceipt, mutate: async (session) => {
        const doc = await Warehouse.findOneAndUpdate(
          /* Compare-and-set on the location's own status, plus the structural
             version, so a concurrent change cannot be overwritten. */
          scoped(req, {
            _id: w._id,
            status: { $ne: "Archived" },
            structureVersion: w.structureVersion || 0,
            locations: { $elemMatch: { _id: current._id, status: current.status } },
          }),
          {
            $inc: { structureVersion: 1 },
            $set: { "locations.$[l].status": next, "locations.$[l].updatedBy": actor, updatedBy: actor },
          },
          { new: true, session, arrayFilters: [{ "l._id": current._id }] },
        ).lean();
        if (!doc) {
          throw fail("LIFECYCLE_BLOCKED",
            "This location changed while your request was being made. Reload the warehouse and try again.",
            { reason: "LIFECYCLE_CONFLICT", expected: current.status });
        }
        return {
          entityType: ENTITY,
          entityId: doc._id,
          entry: {
            entityType: ENTITY,
            entityId: doc._id,
            documentNumber: doc.shortName,
            action: next === "Active" ? "LOCATION_ACTIVATED" : "LOCATION_DEACTIVATED",
            previousState: current.status,
            resultingState: next,
            at: occurredAt,
            requestId: req.id || "",
            idempotencyKey: req.idempotent?.key || "",
            metadata: { locationCode: current.code, locationId: String(current._id) },
          },
          result: doc,
        };
      } });

      const after = (updated.locations || []).find((l) => String(l._id) === String(current._id));
      const body = {
        success: true,
        location: publicLocation(after),
        warehouse: publicWarehouse(updated),
        atomicity: { mode, degraded: mode !== "TRANSACTIONAL" },
      };
      return req.idempotent
        ? await req.idempotent.succeed(200, body, { entityType: ENTITY, entityId: updated._id })
        : res.json(body);
    } catch (err) {
      if (err?.name === "StorePurchaseError") return sendError(res, err);
      console.error("[location lifecycle]", err);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

/* No DELETE for a location either: it is an addressable identity that stock
   movements will refer to once the movement engine exists. */
router.delete("/:id/locations/:locationId", requireCapability(CAPABILITIES.MASTER_MAINTAIN), (_req, res) =>
  sendError(res, fail(
    "LIFECYCLE_BLOCKED",
    "A location is never deleted. Archive it instead — the record is kept, and anything that refers to it stays readable.",
    { reason: "DELETE_NOT_SUPPORTED", useInstead: "PATCH /:id/locations/:locationId/archive" },
  )),
);

module.exports = router;
