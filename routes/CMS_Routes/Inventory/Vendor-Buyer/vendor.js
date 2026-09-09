// routes/CMS_Routes/Inventory/Vendor-Buyer/vendor.js
//
// Store & Purchase — Supplier Master.
//
// ── WHAT THIS ROUTER WAS ────────────────────────────────────────────────────
// `Vendor` carried no company, and this file had `EmployeeAuthMiddleware` and
// nothing else. Every signed-in employee of every company read, edited and
// re-statused ONE shared supplier table: names, contacts, GSTINs, bank
// account numbers. The register's "statistics" counted the whole system, so a
// two-supplier company was shown its competitors' totals. That is why the
// previous chunk closed the Item Master's supplier integration rather than
// keep serving it — the reads could not be made safe without ownership.
//
// Ownership is what this adds. Every read and write below is filtered by the
// resolved company, and a supplier from another company answers exactly as one
// that does not exist: 404, with nothing in the body that admits it is there.
//
// ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
// It does not adopt the suppliers that predate the boundary. They carry
// `companyId: null`, and no code here can know which company a supplier two of
// them both buy from belongs to. They are legacy: readable only through the
// explicit legacy contract, never writable, until a person decides.
//
// It does not invent performance. The old `/performance` endpoint returned
// `onTimeDelivery = 85` and `paymentOnTime = 90` as literals when it had no
// evidence, called order value "total spent", and inferred settlement from a
// purchase-order array that Accounting owns. Every figure here is measured
// from dated records and carries its own denominator, or it is absent.

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite, withIdempotency,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const SpIdempotencyRecord = require("../../../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const {
  buildRecoveryReceipt, readFact, RECOVERY_RECEIPT_VERSION,
} = SpIdempotencyRecord;

// Vendor types for clothing industry
const VENDOR_TYPES = [
  "Raw Material Supplier",
  "Fabric Supplier",
  "Accessories Supplier",
  "Packaging Supplier",
  "Equipment Supplier",
  "Logistics",
  "Other"
];

// Common products for clothing industry
const COMMON_PRODUCTS = [
  "Cotton Fabric",
  "Polyester Fabric",
  "Silk Fabric",
  "Denim Fabric",
  "Linen Fabric",
  "Zippers",
  "Buttons",
  "Threads",
  "Labels",
  "Tags",
  "Packaging Boxes",
  "Polybags",
  "Hangers",
  "Sewing Machines",
  "Cutting Machines",
  "Embroidery Machines",
  "Fusing Machines",
  "Ironing Equipment",
  "Transport Services",
  "Warehousing"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);
/* Authentication says who is calling. This says which company they are acting
   for, and refuses when the answer is "none". */
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
const canMaintain = [requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite];
const canReadHistory = requireCapability(CAPABILITIES.HISTORY_READ);

/** Every supplier query is company-scoped. Another company's is missing. */
const scoped = (req, extra = {}) => ({ ...tenantContext.tenantFilter(req.tenant), ...extra });

/** A supplier name is text, not a pattern. */
const escapeRegex = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The stable codes this router answers with.
 *
 * A caller that has to read prose to tell "already exists" from "you cannot
 * edit an archived supplier" cannot act on either.
 */
const CODES = {
  CODE_DUPLICATE: "SUPPLIER_CODE_DUPLICATE",
  GSTIN_DUPLICATE: "SUPPLIER_GSTIN_DUPLICATE",
  NOT_FOUND: "SUPPLIER_NOT_FOUND",
  LEGACY_READ_ONLY: "SUPPLIER_LEGACY_READ_ONLY",
  ARCHIVED: "SUPPLIER_ARCHIVED",
  NOT_SELECTABLE: "SUPPLIER_NOT_SELECTABLE",
  BLACKLIST_REASON: "BLACKLIST_REASON_REQUIRED",
  DELETE_UNSUPPORTED: "SUPPLIER_DELETE_NOT_SUPPORTED",
  INVALID_ID: "SUPPLIER_ID_INVALID",
  CODE_REQUIRED: "SUPPLIER_CODE_REQUIRED",
  CODE_INVALID: "SUPPLIER_CODE_INVALID",
  CODE_IMMUTABLE: "SUPPLIER_CODE_IMMUTABLE",
  STATUS_NOT_EDITABLE: "SUPPLIER_STATUS_NOT_EDITABLE",
  TRANSITION: "SUPPLIER_TRANSITION_NOT_ALLOWED",
  STATE_CHANGED: "SUPPLIER_STATE_CHANGED",
  REASON_BLACKLIST: "BLACKLIST_REASON_REQUIRED",
  REASON_REACTIVATE: "REACTIVATION_REASON_REQUIRED",
  REASON_ARCHIVE: "ARCHIVE_REASON_REQUIRED",
  INVALID_DATE: "INVALID_DATE_FILTER",
  BANK_NOT_HERE: "SUPPLIER_BANK_NOT_EDITABLE_HERE",
  VERSION_CONFLICT: "SUPPLIER_VERSION_CONFLICT",
  RECONCILE: "RECOVERY_RECONCILIATION_REQUIRED",
  FIELD_INVALID: "SUPPLIER_FIELD_INVALID",
};

/* ── THE SHARED RECEIPT, BUILT TO ITS ACTUAL SCHEMA ─────────────────────────
 * Lane B's `recoveryReceiptSchema` requires `v`, `action` and `entityId`, and
 * defines `documentNumber`, `previousState`, `resultingState`, `fields` and
 * `reason`. It exports no builder yet, so this is the one place a supplier
 * receipt is constructed — and it uses only fields that schema defines.
 *
 * Two failures this replaces:
 *   · the receipts carried `supplierCode` and `changes`, which the schema does
 *     not define. Mongoose strips unknown subdocument paths silently, so the
 *     receipt persisted MINUS exactly the facts a recovery needed;
 *   · they omitted `v` and `entityId` altogether.
 *
 * `fields` is field NAMES only — the schema says so, and a receipt is read by
 * whoever reconciles, which is a wider audience than the endpoint.
 */
/* Lane B now exports `buildRecoveryReceipt` — it validates, bounds and
   allowlists, and the unit of work calls it BEFORE the mutation so a malformed
   receipt stops the operation rather than leaving a mutation unmarked. This
   only supplies the named inputs; it does not re-implement any of that. */
const supplierReceipt = ({ action, entityId, documentNumber, occurredAt,
  previousState, resultingState, fields, reason, facts }) => ({
  action,
  entityType: "Vendor",
  entityId,
  documentNumber,
  /* The moment the event happens, decided by the caller before the write, so
     a repair long afterwards cannot backdate or forward-date it. */
  occurredAt: occurredAt || new Date(),
  previousState, resultingState, fields, reason, facts,
});

/**
 * Whether a persisted receipt may be recovered from, for THIS route.
 *
 * Every check is a way the receipt could describe something other than the
 * request in hand. A receipt that fails any of them is not evidence.
 */
function receiptUsable(receipt, { action, entityType, markerEntityId, supplierId }) {
  if (!receipt) return { ok: false, reason: "RECEIPT_MISSING" };
  if (receipt.v !== RECOVERY_RECEIPT_VERSION) return { ok: false, reason: "RECEIPT_VERSION_UNSUPPORTED" };
  if (receipt.action !== action) return { ok: false, reason: "RECEIPT_ACTION_MISMATCH" };
  /* The receipt states its own entity type now; the route asserts it equals
     the domain it serves rather than trusting the marker alone. */
  if (receipt.entityType !== "Vendor") return { ok: false, reason: "RECEIPT_ENTITY_TYPE_MISMATCH" };
  if (!receipt.entityId) return { ok: false, reason: "RECEIPT_ENTITY_MISSING" };
  if (markerEntityId && String(receipt.entityId) !== String(markerEntityId)) {
    return { ok: false, reason: "RECEIPT_MARKER_DISAGREE" };
  }
  if (supplierId && String(receipt.entityId) !== String(supplierId)) {
    return { ok: false, reason: "RECEIPT_TARGET_MISMATCH" };
  }
  return { ok: true };
}

/**
 * The historical facts each action needs before its history can be rebuilt.
 *
 * ── A DELIBERATE GAP, REPORTED RATHER THAN PAPERED OVER ─────────────────────
 * `SUPPLIER_ASSESS` needs the RATING that was recorded, and the shared receipt
 * schema has no numeric field to carry it. Encoding it in `reason` or
 * `resultingState` would manufacture an authoritative-looking event from a
 * value the receipt never held. So assessment recovery fails closed, and the
 * missing shared field is reported to Lane B.
 */
const RECEIPT_REQUIREMENTS = {
  SUPPLIER_CREATE: ["resultingState"],
  SUPPLIER_UPDATE: [],
  SUPPLIER_ACTIVATE: ["previousState", "resultingState"],
  SUPPLIER_DEACTIVATE: ["previousState", "resultingState"],
  SUPPLIER_BLACKLIST: ["previousState", "resultingState", "reason"],
  SUPPLIER_ARCHIVE: ["previousState", "resultingState", "reason"],
  SUPPLIER_BANK_UPDATE: [],
  /* Was unsatisfiable: the schema had no numeric field for the rating, so
     assessment recovery failed closed and the gap was reported. Lane B's
     `facts` slot now carries it, so it is a real requirement again. */
  SUPPLIER_ASSESS: ["__ratingFact"],
};

function receiptComplete(receipt, action) {
  const needed = RECEIPT_REQUIREMENTS[action] || [];
  const missing = needed.filter((f) => {
    if (f === "__ratingFact") {
      const fact = (receipt.facts || []).find((x) => x.key === "rating");
      return readFact(fact) === undefined;
    }
    return !receipt[f];
  });
  return missing.length ? { ok: false, reason: "RECEIPT_INCOMPLETE", missing } : { ok: true };
}

/* ── AN APPLIED EFFECT ALWAYS ENDS THE REQUEST ──────────────────────────────
 * Every handler entered recovery only when `recovering.entityId` existed and
 * otherwise carried on into validation and mutation — so an interrupted write
 * whose marker was half-written was simply performed a second time, which is
 * the one thing the marker exists to prevent.
 *
 * A marker now has exactly two outcomes: a verified recovery, or a structured
 * refusal telling the caller to reconcile. It never falls through.
 *
 * Lane B persists a `recoveryReceipt` alongside the marker in one update, and
 * their own note says a record without one is "a recovery must refuse rather
 * than reconstruct". This consumes that; it does not add a second mechanism.
 */
function recoveryGate(req, { supplierId = null, action = null } = {}) {
  const recovering = req.idempotent?.recovering || null;
  if (!recovering) return { proceed: true };

  const receipt = req.idempotent?.record?.recoveryReceipt || null;

  if (!recovering.entityId) {
    /* The marker exists but names nothing. Nobody can say what landed. */
    return { proceed: false, reason: "MARKER_INCOMPLETE" };
  }
  if (supplierId && String(recovering.entityId) !== String(supplierId)) {
    /* Never claim another supplier's effect because a payload resembled it. */
    return { proceed: false, reason: "TARGET_MISMATCH" };
  }

  const usable = receiptUsable(receipt, {
    action, entityType: recovering.entityType,
    markerEntityId: recovering.entityId, supplierId,
  });
  if (!usable.ok) return { proceed: false, reason: usable.reason, entityId: recovering.entityId };

  const complete = receiptComplete(receipt, action);
  if (!complete.ok) {
    return { proceed: false, reason: complete.reason, missing: complete.missing,
      entityId: recovering.entityId };
  }

  return { proceed: false, recover: true, entityId: recovering.entityId, receipt };
}

/** The structured refusal a caller can act on. */
const reconcileRequired = (res, gate, extra = {}) => res.status(409).json({
  success: false,
  code: CODES.RECONCILE,
  message:
    "A previous attempt with this key reached the server and its outcome cannot be "
    + "established here. Reload the supplier to see its current state before deciding again.",
  reason: gate.reason,
  /* Named, so a shared-schema gap is visible to whoever reads this rather
     than looking like an ordinary transient failure. */
  ...(gate.missing ? { missingReceiptFields: gate.missing } : {}),
  ...extra,
});

/**
 * The version a caller decided against, if they stated one.
 *
 * @returns {{ok:true,value:number|null}|{ok:false,message:string}}
 */
function expectedVersionOf(body) {
  const raw = body?.expectedVersion;
  /* Required, not optional. Optional meant a client could simply omit it and
     get last-write-wins back — the protection was opt-in for exactly the
     callers least likely to opt in. */
  if (raw === undefined || raw === null) {
    return { ok: false, message: "`expectedVersion` is required: state the version this change was decided against." };
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || !Number.isFinite(raw)) {
    return { ok: false, message: "`expectedVersion` must be a whole number of zero or more." };
  }
  return { ok: true, value: raw };
}

/**
 * Apply a change only if the record is still at the version it was decided
 * against, and move the version on in the same write.
 *
 * ── WHY `save()` WAS NOT ENOUGH ─────────────────────────────────────────────
 * The pattern was: read, compare `recordVersion` in JavaScript, increment the
 * loaded document, `save()`. Two requests can both read version 3, both pass
 * the comparison, and both save — the second silently replacing the first.
 * The comparison has to be part of the write, where the database can serialise
 * it, not a step before it.
 *
 * @returns {object|null} the updated document, or null when the version moved
 */
async function casUpdate(req, { supplierId, expectedVersion, set, extraFilter = {} }) {
  return Vendor.findOneAndUpdate(
    scoped(req, { _id: supplierId, recordVersion: expectedVersion, ...extraFilter }),
    { $set: set, $inc: { recordVersion: 1 } },
    { new: true },
  );
}

const versionConflict = (res, current) => res.status(409).json({
  success: false,
  code: CODES.VERSION_CONFLICT,
  message: "This supplier changed after you loaded it. Reload it and decide again.",
  currentVersion: current,
});

/* The public fields an ordinary edit may change, and therefore the fields the
   audit compares. It was `["companyName", "gstNumber"]`, so changing a
   contact, a phone number or a supplier type left no trace at all. */
const EDITABLE_FIELDS = [
  "companyName", "vendorType", "contactPerson", "email", "phone",
  "alternatePhone", "gstNumber", "panNumber", "notes",
];

/* Nested and list fields an ordinary edit can change. They were absent from
   the diff, so moving a supplier to another city or changing what it supplies
   left no trace in the record at all. */
const EDITABLE_ADDRESS_FIELDS = ["street", "city", "state", "pincode", "country"];

/** Safe before/after scalars for every editable public field. Never a secret. */
function diffEditable(before, after) {
  const changes = [];

  EDITABLE_FIELDS.forEach((f) => {
    if (String(before[f] ?? "") !== String(after[f] ?? "")) {
      changes.push({ field: f, from: String(before[f] ?? ""), to: String(after[f] ?? "") });
    }
  });

  EDITABLE_ADDRESS_FIELDS.forEach((f) => {
    const was = String(before.address?.[f] ?? "");
    const now = String(after.address?.[f] ?? "");
    if (was !== now) changes.push({ field: `address.${f}`, from: was, to: now });
  });

  /* Compared as a set rendered to text: the order suppliers are listed in is
     not a change anybody made. */
  const listOf = (v) => (Array.isArray(v) ? [...v].map(String).sort().join(", ") : "");
  if (listOf(before.primaryProducts) !== listOf(after.primaryProducts)) {
    changes.push({
      field: "primaryProducts",
      from: listOf(before.primaryProducts), to: listOf(after.primaryProducts),
    });
  }

  return changes;
}

/* ── TYPES AND BOUNDS ───────────────────────────────────────────────────────
 * Not business rules — those are not all decided yet, and inventing a GSTIN
 * regex the finance team has not agreed would be worse than accepting text.
 * What IS decided: a field is a string or it is refused, and nothing unbounded
 * reaches the database. `.trim()` on a number threw a 500 that told the caller
 * nothing about what was wrong with their request.
 *
 * OPEN RULE: format validation for GSTIN, PAN and IFSC is deliberately not
 * enforced here. Until the exact accepted forms are agreed, they are stored as
 * typed, bounded text. */
const LIMITS = Object.freeze({
  name: 200, code: 32, contact: 120, email: 160, phone: 32,
  identity: 40, address: 160, notes: 5000, reason: 5000, product: 120, products: 100,
});

function boundedText(value, max, field) {
  if (value === undefined) return { ok: true, skip: true };
  if (value === null) return { ok: true, value: "" };
  if (typeof value !== "string") {
    return { ok: false, field, message: `${field} must be text.` };
  }
  const text = value.trim();
  if (text.length > max) {
    return { ok: false, field, message: `${field} is longer than ${max} characters.` };
  }
  return { ok: true, value: text };
}

/** @returns {null|{field,message}} the first problem, or null */
function validateSupplierBody(body, { requireName }) {
  const checks = [
    ["companyName", LIMITS.name], ["contactPerson", LIMITS.contact],
    ["email", LIMITS.email], ["phone", LIMITS.phone], ["alternatePhone", LIMITS.phone],
    ["gstNumber", LIMITS.identity], ["panNumber", LIMITS.identity],
    ["notes", LIMITS.notes], ["vendorType", LIMITS.contact],
  ];
  for (const [field, max] of checks) {
    const r = boundedText(body?.[field], max, field);
    if (!r.ok) return r;
  }

  /* An empty name was silently ignored rather than refused, so a form that
     cleared it reported success and changed nothing. */
  if (body?.companyName !== undefined && !String(body.companyName || "").trim()) {
    return { field: "companyName", message: "A supplier name is required." };
  }
  if (requireName && !String(body?.companyName || "").trim()) {
    return { field: "companyName", message: "A supplier name is required." };
  }

  if (body?.primaryProducts !== undefined) {
    if (!Array.isArray(body.primaryProducts)) {
      return { field: "primaryProducts", message: "The products list must be a list." };
    }
    if (body.primaryProducts.length > LIMITS.products) {
      return { field: "primaryProducts", message: `At most ${LIMITS.products} products.` };
    }
    for (const entry of body.primaryProducts) {
      /* `.trim()` on a number threw a 500 rather than saying what was wrong. */
      if (typeof entry !== "string") {
        return { field: "primaryProducts", message: "Every product must be text." };
      }
      if (entry.length > LIMITS.product) {
        return { field: "primaryProducts", message: `A product name is longer than ${LIMITS.product} characters.` };
      }
    }
  }

  if (body?.address !== undefined) {
    if (body.address === null || typeof body.address !== "object" || Array.isArray(body.address)) {
      return { field: "address", message: "The address must be an object." };
    }
    for (const part of ["street", "city", "state", "pincode", "country"]) {
      const r = boundedText(body.address[part], LIMITS.address, `address.${part}`);
      if (!r.ok) return r;
    }
  }

  return null;
}

/** The tenant-input contract, applied before any domain work on a write. */
function tenantInputRefused(req, res) {
  try {
    tenantContext.assertNoForeignCompany(req.tenant, req.body);
    /* An invented or unauthorised site fails closed through the established
       policy rather than being stamped from the body. */
    if (req.body?.siteId !== undefined) tenantContext.resolveSite(req.tenant, req.body.siteId);
    return false;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}

/* ── SUPPLIER CODE ──────────────────────────────────────────────────────────
 * The model called it stable identity while creation accepted it blank, so
 * "stable" described a field that was usually empty. It is mandatory for every
 * company-owned supplier, normalised to one canonical form, and immutable once
 * set: it is printed on orders and quoted to the supplier, so changing it
 * through an ordinary edit would silently rename an identity other documents
 * already refer to.
 *
 * Format: A-Z, 0-9, hyphen and underscore, 2-32 characters. Stated here and
 * enforced on the server, not merely hinted at in the form.
 */
const SUPPLIER_CODE_RE = /^[A-Z0-9][A-Z0-9_-]{1,31}$/;

function normaliseCode(raw) {
  if (typeof raw !== "string") return null;
  /* Ends trimmed, case raised — and nothing else. Deleting an interior space
     would turn "SUP 1" into "SUP1" and store a code nobody typed. */
  return raw.trim().toUpperCase();
}

/** @returns {{ok:true,code:string}|{ok:false,code:string,message:string}} */
function checkSupplierCode(raw) {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
    return { ok: false, code: CODES.CODE_REQUIRED,
      message: "A supplier code is required. It identifies this supplier on orders and paperwork." };
  }
  const value = normaliseCode(raw);
  if (value === null || !SUPPLIER_CODE_RE.test(value)) {
    return { ok: false, code: CODES.CODE_INVALID,
      message: "A supplier code uses letters, digits, hyphen and underscore only, 2 to 32 characters." };
  }
  return { ok: true, value };
}

const refuse = (res, status, code, message, extra = {}) =>
  res.status(status).json({ success: false, code, message, ...extra });

/** A supplier this company owns, or a stated refusal. Never a cast error. */
async function loadSupplier(req, res, { forWrite = false, allowArchived = false } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(req.params.id))) {
    /* Answered as "not found" rather than "malformed": a caller probing ids
       learns nothing either way, and Mongoose's CastError is a database
       detail nobody outside this process should see. */
    refuse(res, 404, CODES.NOT_FOUND, "Supplier not found.");
    return null;
  }
  const supplier = await Vendor.findOne(scoped(req, { _id: req.params.id }));
  if (!supplier) {
    refuse(res, 404, CODES.NOT_FOUND, "Supplier not found.");
    return null;
  }
  if (forWrite && supplier.companyId == null) {
    /* Legacy records are readable through the explicit contract and are never
       written: adopting one into whichever company happened to edit it is a
       silent transfer of somebody else's supplier. */
    refuse(res, 403, CODES.LEGACY_READ_ONLY,
      "This supplier predates company ownership and cannot be edited until it is migrated.");
    return null;
  }
  if (forWrite && !allowArchived && supplier.status === "Archived") {
    refuse(res, 409, CODES.ARCHIVED,
      "This supplier is archived. Archived suppliers are kept as a record and cannot be edited.");
    return null;
  }
  return supplier;
}

/** Identity is compared normalised, so "29abc…" and "29ABC…" are one GSTIN. */
const squash = (v) => String(v || "").replace(/\s+/g, "").toUpperCase();

/**
 * Whether this identity is already somebody else's inside this company.
 *
 * Scoped, so another company holding the same code or GSTIN is not a clash —
 * and cannot be discovered by probing this endpoint either.
 */
async function identityClash(req, { supplierCode, gstNumber, excludeId }) {
  const code = squash(supplierCode);
  const gst = squash(gstNumber);

  if (code) {
    const clash = await Vendor.findOne(scoped(req, {
      supplierCode: code, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })).select("_id").lean();
    if (clash) {
      return { code: CODES.CODE_DUPLICATE, message: `Supplier code "${code}" is already used in this company.` };
    }
  }
  /* A blank GSTIN is an absence, and absences do not collide. */
  if (gst) {
    const clash = await Vendor.findOne(scoped(req, {
      gstNormalised: gst, ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    })).select("_id").lean();
    if (clash) {
      return { code: CODES.GSTIN_DUPLICATE, message: `GSTIN ${gst} already belongs to a supplier in this company.` };
    }
  }
  return null;
}

/* ── BANK DETAILS ARE NOT LIST DATA ─────────────────────────────────────────
 * An account number belongs in the one workflow that needs it, not in every
 * register page and every search result that happens to match. */
const LIST_FIELDS =
  "companyName vendorType supplierCode status contactPerson email phone "
  + "gstNumber panNumber primaryProducts rating companyId createdAt updatedAt "
  /* Without these, an assessment recorded a minute ago renders in the register
     as an unverifiable legacy number — the provenance was dropped by the
     projection, not missing from the record. */
  + "ratingRecordedAt ratingRecordedByName ratingReason alternatePhone address recordVersion "
  + "blacklist.reason blacklist.at archive.reason archive.at";

/**
 * The supplier as ordinary readers see it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The detail route returned `vendor.toObject()` — the whole document, account
 * number and IFSC included — to anybody holding `sp.read`. Keeping bank fields
 * out of LIST responses was never the requirement: an account number is
 * payment instruction data, and the people who need it are the ones who
 * maintain it, not everyone who can look a supplier up.
 *
 * They are served only by the private endpoint below, under maintenance
 * authority. Store does not execute payments — Accounting does — so these are
 * restricted supplier instructions held pending that integration, not
 * something Store needs in order to pay anybody.
 */
function publicSupplier(doc) {
  const d = doc?.toObject ? doc.toObject() : (doc || {});

  /* ── AN ALLOWLIST, NOT A SUBTRACTION ────────────────────────────────────
   * This copied the whole document and deleted `bankDetails`. Everything else
   * shipped by default: the normalised identity keys, the lifecycle recovery
   * markers with their operation ids, the verification signature, internal
   * audit ids — and, worse, any field added to the model later, which would
   * reach the API the moment somebody declared it, with no review.
   *
   * Naming what goes out means a new field is invisible until somebody
   * deliberately publishes it. */
  const out = {
    _id: d._id,
    companyName: d.companyName || "",
    supplierCode: d.supplierCode || "",
    vendorType: d.vendorType || "",
    status: d.status || "",
    contactPerson: d.contactPerson || "",
    email: d.email || "",
    phone: d.phone || "",
    /* Accepted, stored and editable — and previously dropped on the way out,
       so the field read blank after every save. */
    alternatePhone: d.alternatePhone || "",
    address: d.address || {},
    /* The identity as entered, for people to read. The NORMALISED keys are
       internal to duplicate detection and are not published. */
    gstNumber: d.gstNumber || "",
    panNumber: d.panNumber || "",
    primaryProducts: d.primaryProducts || [],
    notes: d.notes || "",

    /* Reason and time only. `by` is an internal id; the name is what a
       reader needs, and history carries the full attribution. */
    blacklist: { at: d.blacklist?.at || null, reason: d.blacklist?.reason || "" },
    archive: { at: d.archive?.at || null, reason: d.archive?.reason || "" },

    rating: d.rating ?? null,
    ratingRecordedByName: d.ratingRecordedByName || "",
    ratingRecordedAt: d.ratingRecordedAt || null,
    /* A score without what it was based on cannot be reviewed or disputed. */
    ratingReason: d.ratingReason || "",

    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    /* Quoted back on the next write, so a decision can be tied to the state
       it was actually made against. */
    recordVersion: d.recordVersion ?? 0,
  };

  out.legacy = d.companyId == null;
  out.selectable = isSelectable(d);
  /* Says whether there is anything behind the private endpoint, never what. */
  out.hasBankDetails = Boolean(
    d.bankDetails && (d.bankDetails.accountNumber || d.bankDetails.ifscCode),
  );
  return out;
}

/**
 * A supplier Store may bind a NEW order or alias to.
 *
 * The code is part of it: a company-owned record part-way through migration
 * has no supplier code yet, and an order raised against it would carry no
 * identity anybody can quote back. Such records stay visible — they need
 * remediation — and stay unavailable for new procurement until they are
 * complete.
 */
const isSelectable = (v) =>
  Boolean(v && v.status === "Active" && v.companyId != null
    && typeof v.supplierCode === "string" && v.supplierCode.trim() !== "");

/**
 * One register row.
 *
 * The list returned projected Mongoose documents directly while the detail
 * route returned a DTO, so the two disagreed: rows carried no `address` (the
 * register reads `address.city`), no computed `selectable`, and no rating
 * provenance — so a just-recorded assessment rendered as a legacy value. The
 * projection also decided what was safe, which is the same subtractive
 * mistake the detail route was corrected for.
 */
function listSupplier(d) {
  return {
    _id: d._id,
    companyName: d.companyName || "",
    supplierCode: d.supplierCode || "",
    vendorType: d.vendorType || "",
    status: d.status || "",
    contactPerson: d.contactPerson || "",
    email: d.email || "",
    phone: d.phone || "",
    address: {
      city: d.address?.city || "",
      state: d.address?.state || "",
      country: d.address?.country || "",
    },
    primaryProducts: d.primaryProducts || [],
    gstNumber: d.gstNumber || "",
    /* Enough provenance for the register to tell a recorded assessment from a
       legacy number, and both from no assessment at all. */
    rating: d.rating ?? null,
    ratingRecordedAt: d.ratingRecordedAt || null,
    ratingRecordedByName: d.ratingRecordedByName || "",
    ratingReason: d.ratingReason || "",
    blacklist: { at: d.blacklist?.at || null, reason: d.blacklist?.reason || "" },
    archive: { at: d.archive?.at || null, reason: d.archive?.reason || "" },
    createdAt: d.createdAt,
    recordVersion: d.recordVersion ?? 0,
    /* Computed the same way everywhere, so a row cannot look selectable in
       one screen and not in another. */
    legacy: d.companyId == null,
    selectable: isSelectable(d),
  };
}


/* `applyLifecycle()` was removed: it still held the old direct-save
   implementation, outside the unit-of-work path the lifecycle now uses, and
   nothing called it. A second, divergent way to change a supplier's state is
   exactly what someone would reach for by accident. */




// ✅ GET all vendors with optional search/filter
router.get("/", canRead, async (req, res) => {
  try {
    const { search = "", status, vendorType } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    /* Bounded: an unbounded list is a slow query and, on a big company, a
       response nobody can read anyway. */
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const filter = scoped(req);

    if (search) {
      /* Escaped: a supplier called "Mill (North)" was previously an
         unterminated group, and "." matched every character. */
      const re = new RegExp(escapeRegex(String(search).trim()), "i");
      filter.$and = [{ $or: [
        { companyName: re }, { contactPerson: re },
        { email: re }, { phone: re }, { supplierCode: re },
      ] }];
    }

    if (status && ["Active", "Inactive", "Blacklisted", "Archived"].includes(status)) {
      filter.status = status;
    }
    if (vendorType && VENDOR_TYPES.includes(vendorType)) {
      filter.vendorType = vendorType;
    }

    const [vendors, total] = await Promise.all([
      Vendor.find(filter)
        /* No bank details. See LIST_FIELDS. */
        .select(LIST_FIELDS)
        /* Deterministic: `createdAt` alone ties on records created in the same
           millisecond and pages then repeat or skip rows. */
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Vendor.countDocuments(filter),
    ]);

    /* Counted inside the same company boundary as the list. These were
       system-wide totals shown to every company as its own. */
    const base = scoped(req);
    const [allInCompany, active, blacklisted, archived] = await Promise.all([
      Vendor.countDocuments(base),
      Vendor.countDocuments({ ...base, status: "Active" }),
      Vendor.countDocuments({ ...base, status: "Blacklisted" }),
      Vendor.countDocuments({ ...base, status: "Archived" }),
    ]);

    res.json({
      success: true,
      vendors: vendors.map(listSupplier),
      pagination: {
        page, limit, total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
      stats: { total: allInCompany, active, blacklisted, archived },
      legacy: Boolean(req.tenant?.legacyMode),
      filters: {
        types: VENDOR_TYPES,
        statuses: ["Active", "Inactive", "Blacklisted", "Archived"],
        commonProducts: COMMON_PRODUCTS
      }
    });

  } catch (error) {
    console.error("Error fetching vendors:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendors"
    });
  }
});

// ✅ GET all raw-item variants that have a vendor alias for this vendor
/* Declared before every `/:id` route below: Express matches in order, so a
   `/:id` handler placed first would capture "/types" and answer it with a
   supplier lookup for an id of "types". */
router.get("/:id/alias-items", canRead, async (req, res) => {
  try {
    const vendor = await loadSupplier(req, res)
    if (!vendor) return
    const vendorId = String(vendor._id)

    /* Both sides scoped: this company's supplier, and this company's items.
       An unscoped item query would have listed another company's catalogue
       through a supplier id. */
    const rawItems = await RawItem.find({
      ...tenantContext.tenantFilter(req.tenant),
      "variants.vendorNicknames.vendor": vendor._id,
    }).select("name sku category customCategory unit customUnit variants")

    const items = rawItems.map(item => {
      const baseUnit = item.customUnit || item.unit || "Unit"

      const filteredVariants = item.variants
        .map(v => {
          const alias = (v.vendorNicknames || []).find(
            n => n.vendor?.toString() === vendorId.toString()
          )
          if (!alias) return null
          return {
            variantId:   v._id,
            combination: v.combination || [],
            sku:         v.sku || "",
            quantity:    v.quantity || 0,
            status:      v.status || "Out of Stock",
            aliasId:     alias._id,
            vendorCode:  alias.nickname || "",
            price:       alias.price || 0,
            deliveryDays: alias.deliveryDays || 0,
            notes:       alias.notes || ""
          }
        })
        .filter(Boolean)

      if (!filteredVariants.length) return null

      return {
        rawItemId: item._id,
        name:      item.name,
        sku:       item.sku,
        category:  item.customCategory || item.category || "Uncategorized",
        unit:      baseUnit,
        variants:  filteredVariants
      }
    }).filter(Boolean)

    res.json({ success: true, items, total: items.length })
  } catch (error) {
    console.error("Error fetching alias items:", error)
    res.status(500).json({ success: false, message: "Server error while fetching alias items" })
  }
})

// ✅ GET vendor types
router.get("/types", canRead, async (req, res) => {
  res.json({
    success: true,
    types: VENDOR_TYPES
  });
});

// ✅ GET common products
router.get("/common-products", canRead, async (req, res) => {
  res.json({
    success: true,
    products: COMMON_PRODUCTS
  });
});

// ✅ GET vendor by ID
router.get("/:id", canRead, async (req, res) => {
  try {
    const vendor = await loadSupplier(req, res);
    if (!vendor) return;

    res.json({ success: true, vendor: publicSupplier(vendor) });

  } catch (error) {
    console.error("Error fetching vendor:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor"
    });
  }
});

// ✅ CREATE new vendor
router.post("/", ...canMaintain, withIdempotency("SUPPLIER_CREATE"), async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      alternatePhone,
      address,
      gstNumber,
      panNumber,
      primaryProducts,
      notes,
      rating,
      supplierCode,
    } = req.body;
    /* `status` is NOT read from the body. A supplier's lifecycle state is
       reached through the named operations below, each of which records who
       changed it and why. */

    // Validation - Only companyName is required
    /* Shape BEFORE `.trim()`: a numeric or object name threw here and
       answered 500, telling the caller nothing they could act on. */
    const shapeFirst = validateSupplierBody(req.body, { requireName: true });
    if (shapeFirst) return refuse(res, 400, CODES.FIELD_INVALID, shapeFirst.message, { field: shapeFirst.field });

    if (!companyName || !String(companyName).trim()) {
      return res.status(400).json({
        success: false,
        message: "Company name is required"
      });
    }

    /* ── OWNERSHIP FIELDS ARE REFUSED, NOT IGNORED ─────────────────────
     * Ignoring a foreign `companyId` was described as security; it is not.
     * A client naming another company is asking for something it must never
     * get, and answering with a silent substitution teaches it the field
     * works. */
    if (tenantInputRefused(req, res)) return;


    /* ── RECOVERING A HALF-FINISHED CREATE ──────────────────────────────
     * The supplier saved, then history was written, then the idempotency
     * record was completed — three independent steps. If history failed, the
     * supplier existed and the retry hit the duplicate supplier code: the
     * system reporting a conflict against work it had done itself, with no
     * way for the caller to get past it.
     *
     * The effect marker is looked up by its own saved identity — not by
     * supplier code or GSTIN, which are business values that could match a
     * different record somebody else created in between. */
    const createGate = recoveryGate(req, { action: "SUPPLIER_CREATE" });
    if (!createGate.proceed) {
      if (!createGate.recover) return reconcileRequired(res, createGate);
      const existing = await Vendor.findOne(scoped(req, { _id: createGate.entityId }));
      if (!existing) {
        /* The marker names a supplier this company cannot see. */
        return reconcileRequired(res, { reason: "EFFECT_NOT_FOUND" });
      }
      {
        /* The domain mutation is NOT repeated. Only the bookkeeping that was
           left unfinished is completed, and `recover` writes history at most
           once however many times this path is taken. */
        await unitOfWork.recover(req.tenant, {
          entityType: "Vendor", entityId: existing._id,
          idempotencyKey: req.idempotent?.key || "",
          entry: {
            documentNumber: existing.supplierCode,
            action: "SUPPLIER_CREATE",
            previousState: null, resultingState: existing.status,
            reason: "Supplier registered",
            idempotencyKey: req.idempotent?.key || "",
          },
        });
        const replay = { success: true, message: "Supplier registered", vendor: publicSupplier(existing), recovered: true };
        return req.idempotent.succeed(201, replay, { entityType: "Vendor", entityId: existing._id });
      }
    }
    /* ── ONE DOOR FOR PAYMENT INSTRUCTIONS ─────────────────────────────
     * Ordinary editing refused them and the screens said they were
     * restricted, while creation accepted and stored them — so the whole
     * restriction could be stepped around by setting them at registration.
     * The supplier is created first; an authorised maintainer records them
     * afterwards through the restricted endpoint. */
    if (req.body?.bankDetails !== undefined) {
      return refuse(res, 400, CODES.BANK_NOT_HERE,
        "Payment instructions are recorded separately, after the supplier exists.",
        { endpoint: "PUT /vendors/:id/bank-details" });
    }

    const codeCheck = checkSupplierCode(supplierCode);
    if (!codeCheck.ok) return refuse(res, 400, codeCheck.code, codeCheck.message);

    /* Company-scoped, and normalised: the old check looked at every company's
       suppliers and compared raw spellings, so it both refused a GSTIN
       another company legitimately used and let two casings of one identity
       be stored side by side. */
    const clash = await identityClash(req, { supplierCode: codeCheck.value, gstNumber });
    if (clash) return refuse(res, 409, clash.code, clash.message);

    // Process primary products
    let processedProducts = [];
    if (primaryProducts && Array.isArray(primaryProducts)) {
      processedProducts = primaryProducts
        .map(product => product.trim())
        .filter(product => product !== "");
    }

    // Create new vendor
    const newVendor = new Vendor({
      /* Ownership from the resolved context ONLY — never from the payload. */
      ...tenantContext.stamp(req.tenant),
      supplierCode: codeCheck.value,
      companyName: companyName.trim(),
      vendorType: vendorType || "Raw Material Supplier",
      contactPerson: contactPerson ? contactPerson.trim() : "",
      email: email ? email.trim().toLowerCase() : "",
      phone: phone ? phone.trim() : "",
      alternatePhone: alternatePhone ? alternatePhone.trim() : "",
      address: {
        street: address?.street ? address.street.trim() : "",
        city: address?.city ? address.city.trim() : "",
        state: address?.state ? address.state.trim() : "",
        pincode: address?.pincode ? address.pincode.trim() : "",
        country: address?.country ? address.country.trim() : "India"
      },
      gstNumber: gstNumber ? gstNumber.trim().toUpperCase() : "",
      panNumber: panNumber ? panNumber.trim().toUpperCase() : "",
      primaryProducts: processedProducts,
      /* Never from a creation payload — see the refusal above. */
      notes: notes ? notes.trim() : "",
      status: "Active",
      /* No default. A supplier nobody has assessed has no rating, and an
         assessment is recorded through POST /:id/assessment with its author
         and date. `rating` in a creation body is ignored for that reason. */
      rating: null,
      createdBy: req.user.id,
      /* The recovery marker only. The audit entry is written to the
         established action history below. */
      lifecycleHistory: [{
        at: new Date(), action: "create", fromState: "", toState: "Active",
        operationId: req.idempotent?.record?._id || null,
      }],
    });

    /* Domain mutation, history and effect marker as one operation: together
       in a transaction where the deployment supports it, and marked before
       anything later can fail where it does not. */
    const outcome = await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record || null,
      recoveryReceipt: supplierReceipt({
            action: "SUPPLIER_CREATE",
            entityId: newVendor._id,
            documentNumber: newVendor.supplierCode,
            resultingState: "Active",
          }),
      mutate: async (session) => {
        await newVendor.save(session ? { session } : {});
        return {
          entityType: "Vendor", entityId: newVendor._id,
          /* Lane B's durable evidence, written with the marker in one update:
             a later recovery reads THIS, never today's record plus the retry
             body. */
                    entry: {
            entityType: "Vendor", entityId: newVendor._id,
            documentNumber: newVendor.supplierCode,
            action: "SUPPLIER_CREATE",
            previousState: null, resultingState: "Active",
            reason: "Supplier registered",
            idempotencyKey: req.idempotent?.key || "",
            metadata: { supplierCode: newVendor.supplierCode, companyName: newVendor.companyName },
          },
          result: newVendor,
        };
      },
    });

    const body = {
      success: true,
      message: "Supplier registered",
      vendor: publicSupplier(newVendor),
      /* From the mode `run` actually returns. It was reading
         `outcome.atomicityDegraded`, a property `run` has never produced, so
         every response claimed full atomicity — including on a standalone
         deployment where the history write is a separate round trip. */
      atomicityDegraded: outcome?.mode !== "TRANSACTIONAL",
    };
    return req.idempotent
      ? req.idempotent.succeed(201, body, { entityType: "Vendor", entityId: newVendor._id })
      : res.status(201).json(body);

  } catch (error) {
    console.error("Error creating vendor:", error);

    if (error.code === 11000) {
      /* The index caught a race the read-then-write check could not. Answered
         with the same stable code, not a raw driver error. */
      const onCode = String(error.message || "").includes("supplierCode");
      return refuse(res, 409,
        onCode ? CODES.CODE_DUPLICATE : CODES.GSTIN_DUPLICATE,
        onCode
          ? "That supplier code is already used in this company."
          : "That GSTIN already belongs to a supplier in this company.");
    }

    res.status(500).json({ success: false, message: "Server error while creating supplier" });
  }
});

// ✅ UPDATE vendor
router.put("/:id", ...canMaintain, withIdempotency("SUPPLIER_UPDATE", { target: (req) => req.params.id }), async (req, res) => {
  try {
    const {
      companyName,
      vendorType,
      contactPerson,
      email,
      phone,
      alternatePhone,
      address,
      gstNumber,
      panNumber,
      primaryProducts,
      notes,
      rating,
      supplierCode,
    } = req.body;
    /* `status` is NOT read from the body. A supplier's lifecycle state is
       reached through the named operations below, each of which records who
       changed it and why. */

    /* Refused, not ignored — the same contract as creation. */
    if (tenantInputRefused(req, res)) return;

    /* ── LIFECYCLE IS NOT AN EDITABLE FIELD ────────────────────────────
     * One documented contract: a body carrying `status` is REFUSED. Quietly
     * dropping it would let a form submit a status change, get a 200, and
     * show the old state back — the user believing they had changed it. */
    if (req.body?.status !== undefined) {
      return refuse(res, 400, CODES.STATUS_NOT_EDITABLE,
        "A supplier's state is changed through a named lifecycle operation that records who changed it and why.",
        { operations: ["activate", "deactivate", "blacklist", "archive"] });
    }
    if (req.body?.bankDetails !== undefined) {
      /* ── WHY THIS IS REFUSED, NOT IGNORED ──────────────────────────────
       * The form initialised its bank fields from a detail response that
       * deliberately never carries them, so they were always blank — and it
       * submitted that empty object on every save. Renaming a supplier
       * therefore erased its payment instructions, silently, with the user
       * having never seen the values they destroyed. Ignoring the field would
       * leave that form believing it had saved them. */
      return refuse(res, 400, CODES.BANK_NOT_HERE,
        "Payment instructions are maintained separately, through the restricted bank details workflow.",
        { endpoint: "PUT /vendors/:id/bank-details" });
    }
    if (req.body?.rating !== undefined) {
      return refuse(res, 400, CODES.STATUS_NOT_EDITABLE,
        "A supplier assessment is recorded through POST /vendors/:id/assessment, which keeps its author and date.",
        { operations: ["assessment"] });
    }

    /* ── NOTHING IS ASSIGNED BEFORE THIS POINT ─────────────────────────
     * The old order was: load, apply the request's values to the document in
     * memory, compute a diff, THEN check recovery — so a recovery answered
     * with unsaved request values as though they were persisted, and built
     * "recovered" history from today's request rather than the original
     * event. The gate and the version check both run first. */
    const shape = validateSupplierBody(req.body, { requireName: false });
    if (shape) return refuse(res, 400, CODES.FIELD_INVALID, shape.message, { field: shape.field });

    const vendor = await loadSupplier(req, res, { forWrite: true });
    if (!vendor) return;

    /* ── RECOVERY FIRST, BEFORE THE VERSION IS EVEN LOOKED AT ──────────
     * The version check ran before this, so a retry carrying the same
     * `expectedVersion` its own effect had already incremented was rejected
     * as stale — the caller could never get past it. */
    const gate = recoveryGate(req, { supplierId: vendor._id, action: "SUPPLIER_UPDATE" });
    if (!gate.proceed) {
      if (!gate.recover) return reconcileRequired(res, gate, { currentVersion: vendor.recordVersion ?? 0 });

      /* Every fact from the validated receipt. No `||` fallbacks onto the
         current record or the retry body: those describe now, not then. */
      await unitOfWork.recover(req.tenant, {
        entityType: "Vendor", entityId: gate.receipt.entityId,
        idempotencyKey: req.idempotent?.key || "",
        entry: {
          documentNumber: gate.receipt.documentNumber,
          action: gate.receipt.action,
          previousState: gate.receipt.previousState,
          resultingState: gate.receipt.resultingState,
          reason: gate.receipt.reason,
          changes: (gate.receipt.fields || []).map((f) => ({ field: f, from: "", to: "" })),
          idempotencyKey: req.idempotent?.key || "",
        },
      });
      /* The PERSISTED record, not one this request has touched. */
      const persisted = await Vendor.findOne(scoped(req, { _id: vendor._id })).lean();
      const replay = { success: true, message: "Supplier updated",
        vendor: publicSupplier(persisted), recovered: true };
      return req.idempotent.succeed(200, replay, { entityType: "Vendor", entityId: vendor._id });
    }

    const wanted = expectedVersionOf(req.body);
    if (!wanted.ok) return refuse(res, 400, CODES.FIELD_INVALID, wanted.message, { field: "expectedVersion" });
    if (wanted.value !== (vendor.recordVersion ?? 0)) {
      return versionConflict(res, vendor.recordVersion ?? 0);
    }
    const before = { status: vendor.status, address: { ...(vendor.address || {}) },
      primaryProducts: [...(vendor.primaryProducts || [])] };
    EDITABLE_FIELDS.forEach((f) => { before[f] = vendor[f]; });

    /* ── THE CODE IS STABLE IDENTITY ───────────────────────────────────
     * Re-sending the same code (in any casing) is not a change. Sending a
     * different one is refused: purchase orders and correspondence already
     * carry the old value, and an ordinary edit must not silently rename
     * something other records point at. */
    if (supplierCode !== undefined) {
      const codeCheck = checkSupplierCode(supplierCode);
      if (!codeCheck.ok) return refuse(res, 400, codeCheck.code, codeCheck.message);
      if (vendor.supplierCode && codeCheck.value !== vendor.supplierCode) {
        return refuse(res, 409, CODES.CODE_IMMUTABLE,
          `This supplier is identified as ${vendor.supplierCode}. A supplier code cannot be changed once orders and paperwork carry it.`,
          { current: vendor.supplierCode });
      }
      /* A legacy record being migrated is the only case with no code yet. */
      if (!vendor.supplierCode) vendor.supplierCode = codeCheck.value;
    }

    /* Scoped and normalised, and it excludes this supplier so re-saving its
       own GSTIN is not a clash with itself. */
    const clash = await identityClash(req, {
      supplierCode: vendor.supplierCode, gstNumber, excludeId: vendor._id,
    });
    if (clash) return refuse(res, 409, clash.code, clash.message);

    // Update fields if provided
    if (companyName) vendor.companyName = companyName.trim();
    if (vendorType) vendor.vendorType = vendorType;
    if (contactPerson !== undefined) vendor.contactPerson = contactPerson ? contactPerson.trim() : "";
    if (email !== undefined) vendor.email = email ? email.trim().toLowerCase() : "";
    if (phone !== undefined) vendor.phone = phone ? phone.trim() : "";
    if (alternatePhone !== undefined) vendor.alternatePhone = alternatePhone ? alternatePhone.trim() : "";

    // Update address if provided
    if (address) {
      if (address.street !== undefined) vendor.address.street = address.street ? address.street.trim() : "";
      if (address.city !== undefined) vendor.address.city = address.city ? address.city.trim() : "";
      if (address.state !== undefined) vendor.address.state = address.state ? address.state.trim() : "";
      if (address.pincode !== undefined) vendor.address.pincode = address.pincode ? address.pincode.trim() : "";
      if (address.country !== undefined) vendor.address.country = address.country ? address.country.trim() : "India";
    }

    if (gstNumber !== undefined) vendor.gstNumber = gstNumber ? gstNumber.trim().toUpperCase() : "";
    if (panNumber !== undefined) vendor.panNumber = panNumber ? panNumber.trim().toUpperCase() : "";

    // Update primary products
    if (primaryProducts !== undefined) {
      if (Array.isArray(primaryProducts)) {
        vendor.primaryProducts = primaryProducts
          .map(product => product.trim())
          .filter(product => product !== "");
      }
    }

    /* No bank handling here. The route refuses a `bankDetails` body above, so
       this block could never run — dead code that still read as the place
       payment instructions are maintained. They are maintained by
       PUT /:id/bank-details, under maintenance authority. */

    if (notes !== undefined) vendor.notes = notes ? notes.trim() : "";
    /* `status` was removed from the destructuring above but this line was
       left behind, so every ordinary edit threw ReferenceError and answered
       500 — the route did not work at all. Lifecycle moves through the named
       operations; a body that tries to set it is refused above, not silently
       dropped here.
       `rating` is not editable here either: an assessment records who made it
       and when, which POST /:id/assessment does. */

    vendor.updatedBy = req.user.id;

    /* Field names and safe scalars — never a bank value, never a signature,
       and never the request payload. It compared two fields, so every other
       change a person made was invisible in the record afterwards. */
    const changed = diffEditable(before, vendor);
    /* A retry of an uncertain response used to append a second identical
       audit event: the record then showed one person editing twice. */
    let outcome;
    try {
      outcome = await unitOfWork.run(req.tenant, {
      idempotencyRecord: req.idempotent?.record || null,
      recoveryReceipt: supplierReceipt({
            action: "SUPPLIER_UPDATE",
            entityId: vendor._id,
            documentNumber: vendor.supplierCode,
            previousState: before.status,
            resultingState: vendor.status,
            fields: changed.map((c) => c.field),
          }),
      mutate: async (session) => {
        /* The document was assigned in memory above only to compute the
           diff; the write itself is conditioned on the version. */
        const set = { updatedBy: req.user?.id || null };
        EDITABLE_FIELDS.forEach((f) => { set[f] = vendor[f]; });
        set.address = vendor.address;
        set.primaryProducts = vendor.primaryProducts;
        set.supplierCode = vendor.supplierCode;
        set.gstNormalised = squash(vendor.gstNumber);
        set.panNormalised = squash(vendor.panNumber);
        set.emailNormalised = String(vendor.email || "").trim().toLowerCase();

        const claimed = await Vendor.findOneAndUpdate(
          scoped(req, { _id: vendor._id, recordVersion: wanted.value }),
          { $set: set, $inc: { recordVersion: 1 } },
          { new: true, ...(session ? { session } : {}) },
        );
        if (!claimed) {
          const stale = new Error("SUPPLIER_VERSION_CONFLICT");
          stale.versionConflict = true;
          throw stale;
        }
        Object.assign(vendor, { recordVersion: claimed.recordVersion });
        return {
          entityType: "Vendor", entityId: vendor._id,
          /* TOP LEVEL. It was nested inside `entry`, which `unitOfWork.run`
             does not read — so the marker was written with no receipt at all
             and every recovery had to reconcile. */
                    entry: {
            entityType: "Vendor", entityId: vendor._id,
            documentNumber: vendor.supplierCode,
            action: "SUPPLIER_UPDATE",
            previousState: before.status, resultingState: vendor.status,
            reason: "Supplier details updated",
            changes: changed,
            idempotencyKey: req.idempotent?.key || "",
          },
          result: claimed,
        };
      },
      });
    } catch (err) {
      if (!err?.versionConflict) throw err;
      /* Thrown from inside the mutation, so the unit of work wrote no
         history and marked no effect. */
      outcome = "VERSION_CONFLICT";
    }

    if (outcome === "VERSION_CONFLICT") {
      const now = await Vendor.findOne(scoped(req, { _id: vendor._id })).select("recordVersion").lean();
      return versionConflict(res, now?.recordVersion ?? 0);
    }

    const updatedBody = {
      success: true,
      message: "Supplier updated",
      vendor: publicSupplier(vendor),
      /* From the mode `run` actually returns. It was reading
         `outcome.atomicityDegraded`, a property `run` has never produced, so
         every response claimed full atomicity — including on a standalone
         deployment where the history write is a separate round trip. */
      atomicityDegraded: outcome?.mode !== "TRANSACTIONAL",
    };
    return req.idempotent
      ? req.idempotent.succeed(200, updatedBody, { entityType: "Vendor", entityId: vendor._id })
      : res.json(updatedBody);

  } catch (error) {
    console.error("Error updating vendor:", error);

    if (error.code === 11000) {
      /* The index caught a race the scoped pre-check could not see. Answered
         with the same stable codes and status as the pre-check, so a caller
         handles one contract rather than two. */
      const onCode = String(error.message || "").includes("supplierCode");
      return res.status(409).json({
        success: false,
        code: onCode ? CODES.CODE_DUPLICATE : CODES.GSTIN_DUPLICATE,
        message: onCode
          ? "That supplier code is already used in this company."
          : "That GSTIN already belongs to a supplier in this company."
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while updating vendor"
    });
  }
});

// ✅ DELETE vendor
/* ── DELETING A SUPPLIER IS NOT A THING THIS SYSTEM DOES ────────────────────
 * This endpoint answered "Vendor marked as inactive" to a DELETE. Two problems
 * at once: a caller that asked to delete was told something else had happened
 * and had to read the prose to find out, and a deactivation was recorded with
 * no reason and no author. Purchase orders, receipts and item aliases point at
 * this record; destroying it would orphan them, and quietly deactivating it
 * behind a DELETE is a lifecycle change nobody can account for.
 *
 * It refuses, and names the operation that does what the caller probably
 * meant. Nothing is written. */
router.delete("/:id", ...canMaintain, async (req, res) => {
  return refuse(res, 405, CODES.DELETE_UNSUPPORTED,
    "Suppliers are not deleted, because orders and item aliases refer to them. "
    + "Deactivate the supplier to stop new procurement, or archive it to close it entirely.",
    { operations: ["POST /vendors/:id/deactivate", "POST /vendors/:id/archive"] });
});

/* ── THE STATUS DROPDOWN IS GONE ────────────────────────────────────────────
 * `PATCH /:id/status` set any status from the body, with no reason, no record
 * of who, and no distinction between "dormant this season" and "we will not
 * buy from them again". Blacklisting in particular is a judgement about a
 * business relationship, and a system that cannot say who made it or why
 * cannot defend it later. */
router.patch("/:id/status", ...canMaintain, async (req, res) => {
  return refuse(res, 405, CODES.DELETE_UNSUPPORTED,
    "A supplier's state is changed through a named operation that records who "
    + "changed it and why.",
    { operations: [
      "POST /vendors/:id/activate", "POST /vendors/:id/deactivate",
      "POST /vendors/:id/blacklist", "POST /vendors/:id/archive",
    ] });
});

/* ── THE TRANSITION TABLE ───────────────────────────────────────────────────
 * Stated once, here, rather than implied by four handlers. Two rules are
 * deliberate and not obvious:
 *
 *   Blacklisted → Active needs a reason of its own. Lifting a blacklisting is
 *   as consequential as imposing one, and "we are buying from them again"
 *   deserves the same accountability as "we are not".
 *
 *   Archived → nothing. Archiving is how a supplier is closed for good in this
 *   chunk. Un-archiving needs a workflow that decides what happens to the
 *   record's history and its old aliases, and inventing one here would be
 *   guessing at it.
 */
const TRANSITIONS = {
  Active:      { deactivate: "Inactive", blacklist: "Blacklisted", archive: "Archived" },
  Inactive:    { activate: "Active", blacklist: "Blacklisted", archive: "Archived" },
  Blacklisted: { activate: "Active", archive: "Archived" },
  Archived:    {},
};

/** Which operations must state why. */
const REASON_RULES = {
  blacklist: { always: true, code: CODES.REASON_BLACKLIST,
    message: "Say why this supplier is being blacklisted. The reason is kept with the decision." },
  archive: { always: true, code: CODES.REASON_ARCHIVE,
    message: "Say why this supplier is being archived." },
  activate: { fromBlacklist: true, code: CODES.REASON_REACTIVATE,
    message: "Say why this supplier is being removed from the blacklist." },
};

const LIFECYCLE = [
  { path: "activate", action: "activate" },
  { path: "deactivate", action: "deactivate" },
  { path: "blacklist", action: "blacklist" },
  { path: "archive", action: "archive" },
];

/* "blacklistd." — the old message built the past tense by appending "d". */
const PAST_TENSE = {
  activate: "activated", deactivate: "deactivated",
  blacklist: "blacklisted", archive: "archived",
};

LIFECYCLE.forEach(({ path, action }) => {
  router.post(`/:id/${path}`, ...canMaintain, withIdempotency(`SUPPLIER_${action.toUpperCase()}`, { target: (req) => req.params.id }),
    async (req, res) => {
      try {
        if (tenantInputRefused(req, res)) return;
        const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

        /* ── EVERY OPERATION IS A WRITE ──────────────────────────────────
         * `activate` used to pass `forWrite: false`, so a legacy supplier
         * opened under ?scope=legacy could be mutated through it — the one
         * path that skipped the legacy and archived guards. */
        /* Archived is loaded but not editable: the transition table below is
           what says an archived supplier has no ordinary way out, and it can
           name the allowed moves. The legacy refusal still applies. */
        const supplier = await loadSupplier(req, res, { forWrite: true, allowArchived: true });
        if (!supplier) return;

        /* ── THE GATE TERMINATES, ALWAYS ────────────────────────────────
         * `if (!gate.proceed && !gate.recover)` let a RECOVERABLE marker fall
         * through into the ordinary transition below whenever the embedded
         * lifecycle marker happened to be absent — performing the change a
         * second time on the strength of a marker that said it had already
         * happened. Neither the embedded array, the current state nor the
         * retry body is an authority here. */
        const gate = recoveryGate(req, {
          supplierId: supplier._id, action: `SUPPLIER_${action.toUpperCase()}`,
        });
        if (!gate.proceed) {
          if (!gate.recover) {
            return reconcileRequired(res, gate, { currentVersion: supplier.recordVersion ?? 0 });
          }
          await unitOfWork.recover(req.tenant, {
            entityType: "Vendor", entityId: gate.receipt.entityId,
            idempotencyKey: req.idempotent?.key || "",
            entry: {
              documentNumber: gate.receipt.documentNumber,
              action: gate.receipt.action,
              previousState: gate.receipt.previousState,
              resultingState: gate.receipt.resultingState,
              reason: gate.receipt.reason,
              idempotencyKey: req.idempotent?.key || "",
            },
          });
          const persisted = await Vendor.findOne(scoped(req, { _id: supplier._id })).lean();
          const replay = {
            success: true,
            message: `Supplier ${PAST_TENSE[action]}.`,
            vendor: publicSupplier(persisted), recovered: true,
          };
          return req.idempotent.succeed(200, replay, { entityType: "Vendor", entityId: supplier._id });
        }

        const wanted = expectedVersionOf(req.body);
        if (!wanted.ok) return refuse(res, 400, CODES.FIELD_INVALID, wanted.message, { field: "expectedVersion" });
        if (wanted.value !== (supplier.recordVersion ?? 0)) {
          return versionConflict(res, supplier.recordVersion ?? 0);
        }

        /* The embedded marker is kept for diagnostics only. The recovery
           decision above is made from the durable receipt, which is the
           record of what actually happened. */
        const operationId = req.idempotent?.record?._id || null;

        const from = supplier.status;
        const to = TRANSITIONS[from]?.[action];

        if (!to) {
          if (Object.values(TRANSITIONS[from] || {}).includes(from)) { /* unreachable, kept explicit */ }
          /* Already in the target state is a no-op, not a failure — and it
             writes no history line, because nothing changed. */
          const targetOfAction = { activate: "Active", deactivate: "Inactive",
            blacklist: "Blacklisted", archive: "Archived" }[action];
          if (from === targetOfAction) {
            const body = { success: true, message: `Supplier is already ${from.toLowerCase()}.`,
              vendor: publicSupplier(supplier), unchanged: true };
            return req.idempotent
              ? req.idempotent.succeed(200, body, { entityType: "Vendor", entityId: supplier._id })
              : res.json(body);
          }
          return refuse(res, 409, CODES.TRANSITION,
            `A ${from.toLowerCase()} supplier cannot be ${PAST_TENSE[action]}.`,
            { from, action, allowed: Object.keys(TRANSITIONS[from] || {}) });
        }

        const rule = REASON_RULES[action];
        const reasonNeeded = rule && (rule.always || (rule.fromBlacklist && from === "Blacklisted"));
        if (reasonNeeded && !reason) return refuse(res, 400, rule.code, rule.message);

        /* ── COMPARE AND SET ────────────────────────────────────────────
         * Two decisions taken at once used to load the same document, mutate
         * separate copies and save: the later save replaced the earlier
         * decision AND the history line that explained it. The stored state
         * is part of the write condition, so exactly one lands and the other
         * is told what actually happened. */
        const actor = { by: req.user?.id || null, byName: req.user?.name || req.user?.email || "" };
        const set = {
          status: to,
          updatedBy: req.user?.id || null,
          ...(to === "Blacklisted"
            ? { blacklist: { at: new Date(), reason, by: actor.by, byName: actor.byName } } : {}),
          ...(to === "Archived"
            ? { archive: { at: new Date(), reason, by: actor.by, byName: actor.byName } } : {}),
          ...(from === "Blacklisted" && to !== "Blacklisted"
            ? { blacklist: { at: null, by: null, byName: "", reason: "" } } : {}),
        };

        /* ── THE TRANSITION IS ONE UNIT OF WORK ────────────────────────
         * The compare-and-set ran on its own and history was then repaired
         * afterwards with `recover` — which is the bookkeeping path for an
         * INTERRUPTED write, not how an ordinary one should be performed. On
         * a transaction-capable deployment the state change and its history
         * now commit together; on standalone Mongo the established marked
         * fallback runs and the response says atomicity was degraded.
         *
         * The CAS is unchanged and still inside the mutation: the stored
         * status is part of the write condition, so a stale decision loses
         * and — because it throws before the unit of work records anything —
         * writes no history and marks no effect. */
        let claimed = null;
        let outcome = null;
        try {
          outcome = await unitOfWork.run(req.tenant, {
            idempotencyRecord: req.idempotent?.record || null,
      recoveryReceipt: supplierReceipt({
                  action: `SUPPLIER_${action.toUpperCase()}`,
                  /* The loaded supplier: the receipt is built BEFORE the
                     mutation now, so the post-write document does not exist
                     yet. Its id and code are the same either way. */
                  entityId: supplier._id,
                  documentNumber: supplier.supplierCode,
                  previousState: from, resultingState: to, reason,
                }),
            mutate: async (session) => {
              claimed = await Vendor.findOneAndUpdate(
                /* Both conditions in the filter: the state it was decided
                   against, and the version it was read at. */
                scoped(req, {
                  _id: supplier._id, status: from,
                  recordVersion: wanted.value,
                }),
                {
                  $set: set,
                  $push: { lifecycleHistory: { at: new Date(), action, fromState: from, toState: to, operationId } },
                  $inc: { recordVersion: 1 },
                },
                { new: true, ...(session ? { session } : {}) },
              );

              if (!claimed) {
                /* Aborts the operation before any history is written. */
                const stale = new Error("SUPPLIER_STATE_CHANGED");
                stale.staleTransition = true;
                throw stale;
              }

              return {
                entityType: "Vendor", entityId: claimed._id,
                                entry: {
                  entityType: "Vendor", entityId: claimed._id,
                  documentNumber: claimed.supplierCode,
                  action: `SUPPLIER_${action.toUpperCase()}`,
                  previousState: from, resultingState: to, reason,
                  idempotencyKey: req.idempotent?.key || "",
                },
                result: claimed,
              };
            },
          });
        } catch (err) {
          if (!err?.staleTransition) throw err;
          /* Somebody else's decision landed first. The current state is the
             useful answer, not a generic failure. */
          const current = await Vendor.findOne(scoped(req, { _id: supplier._id })).select("status").lean();
          return refuse(res, 409, CODES.STATE_CHANGED,
            `This supplier is now ${String(current?.status || "").toLowerCase()}. Your change was not applied.`,
            { currentStatus: current?.status || null, expected: from });
        }

        const body = {
          success: true,
          message: `Supplier ${PAST_TENSE[action]}.`,
          vendor: publicSupplier(claimed),
          atomicityDegraded: outcome?.mode !== "TRANSACTIONAL",
        };
        return req.idempotent
          ? req.idempotent.succeed(200, body, { entityType: "Vendor", entityId: claimed._id })
          : res.json(body);
      } catch (error) {
        console.error(`Error during supplier ${action}:`, error);
        res.status(500).json({ success: false, message: `Server error during supplier ${action}` });
      }
    });
});

/* ── THE SEPARATE BANK ENDPOINT ─────────────────────────────────────────────
 * ── AN UNRESOLVED SECURITY DECISION, STATED PLAINLY ─────────────────────────
 * This was described as "restricted", and it is NOT more restricted than
 * ordinary supplier editing: both require `sp.master.maintain`. Anybody who
 * can rename a supplier can read and change its payment instructions. The
 * capability table defines no sensitive-data permission, and inventing one —
 * or reaching for an Accounting capability — would change a shared mapping
 * while Lane B is working in it.
 *
 * So the claim is withdrawn rather than the protection overstated. What this
 * endpoint DOES give, and what is genuinely enforced and tested:
 *   · bank values appear in no list, detail, lifecycle, assessment, history
 *     or recovery response — only here;
 *   · the audit stream records field NAMES only, never values;
 *   · a failed load shows an error, never blank fields that would erase the
 *     stored values if saved;
 *   · tenant scoping and the legacy refusal apply as to any write.
 *
 * OPEN DECISION for the product owner: whether a distinct sensitive-data
 * capability should gate payment instructions separately from catalogue
 * maintenance. Until that is decided, this is separation of ROUTE, not of
 * permission.
 *
 * Store does not pay anyone. These are restricted instructions held against
 * the later Accounting integration, which is where settlement actually
 * happens — describing them to a Store user as "helpful for payments" would
 * misstate who does what. */
router.get("/:id/bank-details", ...canMaintain, async (req, res) => {
  try {
    const supplier = await loadSupplier(req, res, { forWrite: true });
    if (!supplier) return;

    const b = supplier.bankDetails || {};
    await actionHistory.record(req.tenant, {
      entityType: "Vendor", entityId: supplier._id,
      documentNumber: supplier.supplierCode,
      action: "SUPPLIER_BANK_VIEW",
      reason: "Restricted supplier instructions viewed",
      /* The fact of the access, never the values. */
      metadata: { fields: Object.keys(b).filter((k) => b[k]) },
    });

    res.json({
      success: true,
      bankDetails: {
        accountName: b.accountName || "", accountNumber: b.accountNumber || "",
        bankName: b.bankName || "", ifscCode: b.ifscCode || "", branch: b.branch || "",
      },
      note: "Restricted supplier instructions. Payment execution is recorded in Accounting.",
    });
  } catch (error) {
    console.error("Error reading supplier bank details:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/**
 * The restricted bank update.
 *
 * Separate from ordinary editing because the values are payment instructions
 * and the people who may change them are the people who may see them. Store
 * does not execute payments — Accounting does — so these are held pending that
 * integration rather than used here.
 */
router.put("/:id/bank-details", ...canMaintain, withIdempotency("SUPPLIER_BANK_UPDATE", { target: (req) => req.params.id }),
  async (req, res) => {
    try {
      if (tenantInputRefused(req, res)) return;

      const supplier = await loadSupplier(req, res, { forWrite: true });
      if (!supplier) return;

      /* ── NO SILENT BLANKING ────────────────────────────────────────
       * `typeof v === "string" ? v.trim() : ""` turned every malformed value
       * into an empty string, so sending a number ERASED the stored
       * instruction and reported success. Clearing must be deliberate: an
       * empty string or null does it, and nothing else is accepted. */
      const FIELDS = ["accountName", "accountNumber", "bankName", "ifscCode", "branch"];
      const next = { ...(supplier.bankDetails ? supplier.bankDetails.toObject?.() || { ...supplier.bankDetails } : {}) };
      for (const f of FIELDS) {
        const raw = req.body?.[f];
        if (raw === undefined) continue;                 // not part of this edit
        if (raw === null) { next[f] = ""; continue; }    // deliberate clearing
        if (typeof raw !== "string") {
          return refuse(res, 400, CODES.FIELD_INVALID,
            `${f} must be text. To clear it, send an empty string.`, { field: f });
        }
        if (raw.length > LIMITS.identity * 2) {
          return refuse(res, 400, CODES.FIELD_INVALID, `${f} is too long.`, { field: f });
        }
        next[f] = f === "ifscCode" ? raw.trim().toUpperCase() : raw.trim();
      }
      FIELDS.forEach((f) => { next[f] = next[f] || ""; });

      /* ── RECOVERY BEFORE MUTATION ──────────────────────────────────
       * This had no recovery branch at all, so an effect-applied retry ran
       * the save and the history write a second time. The recovered entity is
       * checked against the supplier in the route: an effect recorded against
       * a different record must never be claimed here. */
      const gate = recoveryGate(req, {
        supplierId: supplier._id, action: "SUPPLIER_BANK_UPDATE",
      });
      /* ── RECOVERY BEFORE THE VERSION IS CONSULTED ────────────────────
       * The version check ran first, so a retry carrying the same
       * `expectedVersion` that its own effect had already incremented was
       * refused as stale — a caller could never complete the recovery. */
      if (!gate.proceed) {
        if (!gate.recover) {
          return reconcileRequired(res, gate, { currentVersion: supplier.recordVersion ?? 0 });
        }
        await unitOfWork.recover(req.tenant, {
          entityType: "Vendor", entityId: supplier._id,
          idempotencyKey: req.idempotent?.key || "",
          entry: {
            /* Every fact from the receipt, none from the current record. */
            action: gate.receipt.action,
            documentNumber: gate.receipt.documentNumber,
            reason: gate.receipt.reason,
            changes: (gate.receipt.fields || []).map((f) => ({ field: f, from: "", to: "" })),
            idempotencyKey: req.idempotent?.key || "",
          },
        });
        /* The persisted record, not a locally mutated copy. */
        const persisted = await Vendor.findOne(scoped(req, { _id: supplier._id })).lean();
        const replay = {
          success: true, message: "Payment instructions updated", recovered: true,
          hasBankDetails: Boolean(persisted?.bankDetails?.accountNumber),
        };
        return req.idempotent.succeed(200, replay, { entityType: "Vendor", entityId: supplier._id });
      }

      const wanted = expectedVersionOf(req.body);
      if (!wanted.ok) return refuse(res, 400, CODES.FIELD_INVALID, wanted.message, { field: "expectedVersion" });
      if (wanted.value !== (supplier.recordVersion ?? 0)) {
        return versionConflict(res, supplier.recordVersion ?? 0);
      }

      const current = supplier.bankDetails || {};
      /* Field NAMES only. An audit stream is read by more people than this
         endpoint is, so no value from here ever reaches it. */
      const changed = Object.keys(next)
        .filter((f) => String(current[f] || "") !== next[f])
        .map((f) => ({ field: f, from: "", to: "" }));

      if (!changed.length) {
        const same = { success: true, message: "No change to payment instructions.", unchanged: true };
        return req.idempotent
          ? req.idempotent.succeed(200, same, { entityType: "Vendor", entityId: supplier._id })
          : res.json(same);
      }

      let outcome;
      try {
        outcome = await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record || null,
      recoveryReceipt: supplierReceipt({
              action: "SUPPLIER_BANK_UPDATE",
              entityId: supplier._id,
              documentNumber: supplier.supplierCode,
              fields: changed.map((c) => c.field),
            }),
        mutate: async (session) => {
          const claimed = await casUpdate(req, {
            supplierId: supplier._id,
            expectedVersion: wanted.value,
            set: { bankDetails: next, updatedBy: req.user?.id || null },
          });
          if (!claimed) {
            const stale = new Error("SUPPLIER_VERSION_CONFLICT");
            stale.versionConflict = true;
            throw stale;
          }
          return {
            entityType: "Vendor", entityId: supplier._id,
            /* Field NAMES only — a receipt is read back later by whoever
               recovers, and a bank value must never be in it. */
                        entry: {
              entityType: "Vendor", entityId: supplier._id,
              documentNumber: supplier.supplierCode,
              action: "SUPPLIER_BANK_UPDATE",
              reason: "Payment instructions updated",
              idempotencyKey: req.idempotent?.key || "",
              changes: changed,
            },
            result: claimed,
          };
        },
      });

      } catch (err) {
        if (!err?.versionConflict) throw err;
        const now = await Vendor.findOne(scoped(req, { _id: supplier._id })).select("recordVersion").lean();
        return versionConflict(res, now?.recordVersion ?? 0);
      }

      /* The response confirms the change without echoing a value back. */
      const body = {
        success: true,
        message: "Payment instructions updated",
        changedFields: changed.map((c) => c.field),
        /* From the mode `run` actually returns. It was reading
         `outcome.atomicityDegraded`, a property `run` has never produced, so
         every response claimed full atomicity — including on a standalone
         deployment where the history write is a separate round trip. */
      atomicityDegraded: outcome?.mode !== "TRANSACTIONAL",
      };
      return req.idempotent
        ? req.idempotent.succeed(200, body, { entityType: "Vendor", entityId: supplier._id })
        : res.json(body);
    } catch (error) {
      console.error("Error updating supplier bank details:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

/** Recording an assessment, with the author and date the old default lacked. */
router.post("/:id/assessment", ...canMaintain, withIdempotency("SUPPLIER_ASSESS", { target: (req) => req.params.id }),
  async (req, res) => {
    try {
      if (tenantInputRefused(req, res)) return;
      const value = Number(req.body?.rating);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        return refuse(res, 400, "ASSESSMENT_INVALID", "An assessment is a whole number from 1 to 5.");
      }
      /* Text, not "anything with a toString": `String({})` produced
         "[object Object]" and stored it as the stated basis. */
      if (req.body?.reason !== undefined && typeof req.body.reason !== "string") {
        return refuse(res, 400, CODES.FIELD_INVALID, "The stated basis must be text.", { field: "reason" });
      }
      const reason = (req.body?.reason || "").trim();
      if (reason.length > LIMITS.reason) {
        return refuse(res, 400, "ASSESSMENT_REASON_INVALID",
          `The stated basis is longer than ${LIMITS.reason} characters.`);
      }
      if (!reason) {
        return refuse(res, 400, "ASSESSMENT_REASON_REQUIRED",
          "Say what this assessment is based on. A score with no stated basis cannot be reviewed.");
      }

      /* forWrite refuses legacy and archived: an archived supplier is a
         closed record, and assessing one implies a relationship that ended. */
      const supplier = await loadSupplier(req, res, { forWrite: true });
      if (!supplier) return;

      const gate = recoveryGate(req, {
        supplierId: supplier._id, action: "SUPPLIER_BANK_UPDATE",
      });
      if (!gate.proceed && !gate.recover) {
        return reconcileRequired(res, gate, { currentVersion: supplier.recordVersion ?? 0 });
      }

      const wanted = expectedVersionOf(req.body);
      if (!wanted.ok) return refuse(res, 400, CODES.FIELD_INVALID, wanted.message, { field: "expectedVersion" });
      if (wanted.value !== (supplier.recordVersion ?? 0)) {
        return versionConflict(res, supplier.recordVersion ?? 0);
      }

      if (gate.recover) {
        /* Already recorded. Repeating the save would overwrite the author and
           timestamp of the assessment that actually happened. */
        await unitOfWork.recover(req.tenant, {
          entityType: "Vendor", entityId: supplier._id,
          idempotencyKey: req.idempotent?.key || "",
          entry: {
            documentNumber: supplier.supplierCode, action: "SUPPLIER_ASSESS",
            reason, metadata: { rating: value },
            idempotencyKey: req.idempotent?.key || "",
          },
        });
        const replay = { success: true, message: "Assessment recorded",
          vendor: publicSupplier(supplier), recovered: true };
        return req.idempotent.succeed(200, replay, { entityType: "Vendor", entityId: supplier._id });
      }

      let assessed;
      try {
        await unitOfWork.run(req.tenant, {
        idempotencyRecord: req.idempotent?.record || null,
      recoveryReceipt: supplierReceipt({
              action: "SUPPLIER_ASSESS",
              entityId: supplier._id,
              documentNumber: supplier.supplierCode,
              reason,
              /* ── A STRING, AND WHY ────────────────────────────────────
               * The rating is a number, and it is sent as text on purpose.
               * `unitOfWork.run` validates the receipt (building
               * `{key, value: 4}` into `{key, num: 4}`), then
               * `idempotency.markEffectApplied` validates the ALREADY-BUILT
               * receipt a second time — and that pass reads `f.value`, which
               * the first pass moved to `num`, so it throws
               * "facts[0].value must be a string or a finite number".
               *
               * A numeric fact therefore cannot survive the two builds today.
               * A string one is build-idempotent, so the rating is stored as
               * text and read back with `Number(readFact(...))` — exact, and
               * no shared file touched. REPORTED TO LANE B: the double build
               * across run() → markEffectApplied. */
              facts: [{ key: "rating", value: String(value) }],
            }),
        mutate: async (session) => {
          const claimed = await casUpdate(req, {
            supplierId: supplier._id,
            expectedVersion: wanted.value,
            set: {
              rating: value,
              ratingRecordedBy: req.user?.id || null,
              ratingRecordedByName: req.user?.name || req.user?.email || "",
              ratingRecordedAt: new Date(),
              ratingReason: reason,
              updatedBy: req.user?.id || null,
            },
          });
          if (!claimed) {
            const stale = new Error("SUPPLIER_VERSION_CONFLICT");
            stale.versionConflict = true;
            throw stale;
          }
          return {
            entityType: "Vendor", entityId: supplier._id,
            /* The rating rides in Lane B's typed `facts` slot, so a later
               recovery can reproduce the assessment exactly instead of
               failing closed on a fact the receipt could not hold. */
                        entry: {
              entityType: "Vendor", entityId: supplier._id,
              documentNumber: supplier.supplierCode,
              action: "SUPPLIER_ASSESS", reason,
              metadata: { rating: value },
              idempotencyKey: req.idempotent?.key || "",
            },
            result: claimed,
          };
        },
        });
        assessed = await Vendor.findOne(scoped(req, { _id: supplier._id })).lean();
      } catch (err) {
        if (!err?.versionConflict) throw err;
        const now = await Vendor.findOne(scoped(req, { _id: supplier._id })).select("recordVersion").lean();
        return versionConflict(res, now?.recordVersion ?? 0);
      }

      const body = { success: true, message: "Assessment recorded", vendor: publicSupplier(assessed) };
      return req.idempotent
        ? req.idempotent.succeed(200, body, { entityType: "Vendor", entityId: supplier._id })
        : res.json(body);
    } catch (error) {
      console.error("Error recording supplier assessment:", error);
      res.status(500).json({ success: false, message: "Server error" });
    }
  });

/**
 * The supplier's history, read from the authoritative action history.
 *
 * Not from the embedded array: that lives inside a document ordinary saves
 * rewrite, so it could never be the immutable record it was described as.
 */
router.get("/:id/history", canReadHistory, async (req, res) => {
  try {
    const supplier = await loadSupplier(req, res);
    if (!supplier) return;

    /* ── A CURSOR, NOT AN OFFSET ──────────────────────────────────────
     * Action history is append-only, so `skip((page - 1) * limit)` over it is
     * unstable by construction: an entry written between two requests shifts
     * every later row down, and the last row of page one reappears at the top
     * of page two. Worse in the other direction — a deletion or a clock skew
     * can hide a row entirely.
     *
     * The cursor is the sort key itself: the event's timestamp AND its id,
     * because several entries can share a millisecond and a timestamp alone
     * cannot break that tie. */
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const SpActionHistory = require("../../../../models/CMS_Models/StorePurchase/SpActionHistory");
    const filter = {
      companyId: req.tenant.companyId,
      entityType: "Vendor",
      entityId: supplier._id,
    };

    if (req.query.cursor) {
      const [atRaw, idRaw] = String(req.query.cursor).split("|");
      const at = new Date(atRaw);
      if (Number.isNaN(at.getTime()) || !mongoose.Types.ObjectId.isValid(String(idRaw))) {
        return refuse(res, 400, "INVALID_CURSOR",
          "That page marker is not one this system issued.");
      }
      /* Strictly after the last row in the previous page, in the same order
         the rows are sorted by. */
      filter.$or = [
        { at: { $lt: at } },
        { at, _id: { $lt: new mongoose.Types.ObjectId(String(idRaw)) } },
      ];
    }

    const [rows, total] = await Promise.all([
      /* One extra row, to know whether there is a next page without a second
         count that could disagree with the page just read. */
      SpActionHistory.find(filter).sort({ at: -1, _id: -1 }).limit(limit + 1).lean(),
      SpActionHistory.countDocuments({
        companyId: req.tenant.companyId, entityType: "Vendor", entityId: supplier._id,
      }),
    ]);

    const hasMore = rows.length > limit;
    if (hasMore) rows.pop();

    const history = rows.map((r) => ({
      /* A stable identity for each entry: the cursor is built from it, and
         the screen uses it as a React key instead of an array index. */
      id: String(r._id),
      at: r.at,
      action: r.action,
      fromState: r.previousState || "",
      toState: r.resultingState || "",
      reason: r.reason || "",
      /* The name recorded at the time — not re-resolved now. */
      actor: r.actorName || String(r.actorId || ""),
      changes: (r.changes || []).map((c) => c.field),
    }));

    const last = rows[rows.length - 1];
    res.json({
      success: true,
      history,
      total,
      pagination: {
        limit,
        total,
        hasMore,
        /* Opaque to the caller, and only meaningful to this endpoint. */
        nextCursor: hasMore && last ? `${new Date(last.at).toISOString()}|${last._id}` : null,
      },
    });
  } catch (error) {
    console.error("Error fetching supplier history:", error);
    res.status(500).json({ success: false, message: "Server error while fetching supplier history" });
  }
});

// ✅ GET vendor purchase orders
router.get("/:id/purchase-orders", canRead, async (req, res) => {
  try {
    const { status, startDate, endDate } = req.query;
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const vendor = await loadSupplier(req, res);
    if (!vendor) return;

    /* ── DATE FILTERS ARE VALIDATED, NOT FORWARDED ─────────────────────
     * `new Date("not-a-date")` is an Invalid Date, and handing that to Mongo
     * produces a driver error the caller sees as a 500. A filter the caller
     * mistyped is a validation answer. */
    const parseDay = (raw, label) => {
      if (raw === undefined || raw === "") return { ok: true, value: null };
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, message: `${label} is not a date this system can read.` };
      }
      return { ok: true, value: d };
    };
    const from = parseDay(startDate, "startDate");
    const to = parseDay(endDate, "endDate");
    if (!from.ok || !to.ok) {
      return refuse(res, 400, CODES.INVALID_DATE, from.ok ? to.message : from.message,
        { field: from.ok ? "endDate" : "startDate" });
    }

    /* This company's orders with this company's supplier. */
    const filter = { ...tenantContext.tenantFilter(req.tenant), vendor: vendor._id };

    if (status && status !== "all") {
      filter.status = status;
    }

    if (from.value || to.value) {
      filter.orderDate = {};
      if (from.value) filter.orderDate.$gte = from.value;
      if (to.value) filter.orderDate.$lte = to.value;
    }

    const purchaseOrders = await PurchaseOrder.find(filter)
      .select("poNumber orderDate expectedDeliveryDate totalAmount status items totalReceived totalPending deliveries payments")
      .populate("items.rawItem", "name sku unit")
      .sort({ orderDate: -1, _id: -1 })
      .limit(limit);

    /* ── TOTALS ARE NOT COMPUTED FROM ONE PAGE ─────────────────────────
     * These were derived from `purchaseOrders`, which is the LIMITED result
     * set. A supplier with 40 orders asked for 10 was shown "10 orders" and
     * the value of those ten, labelled as its totals. Aggregated over the
     * whole filter instead, independently of what this page returned. */
    const [summary] = await PurchaseOrder.aggregate([
      { $match: filter },
      { $group: {
        _id: null,
        totalOrders: { $sum: 1 },
        completedOrders: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
        cancelledOrders: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
        pendingOrders: { $sum: { $cond: [
          { $in: ["$status", ["ISSUED", "PARTIALLY_RECEIVED"]] }, 1, 0] } },
        completedOrderValue: { $sum: { $cond: [
          { $eq: ["$status", "COMPLETED"] }, { $ifNull: ["$totalAmount", 0] }, 0] } },
        openOrderValue: { $sum: { $cond: [
          { $in: ["$status", ["ISSUED", "PARTIALLY_RECEIVED"]] }, { $ifNull: ["$totalAmount", 0] }, 0] } },
      } },
    ]);
    const stats = summary || {
      totalOrders: 0, completedOrders: 0, cancelledOrders: 0, pendingOrders: 0,
      completedOrderValue: 0, openOrderValue: 0,
    };
    delete stats._id;



    // Format the response
    const formattedOrders = purchaseOrders.map(po => {
      /* ── NO CROSS-UNIT ARITHMETIC ──────────────────────────────────────
       * `items.reduce((s, i) => s + i.quantity)` added 300 metres of fabric
       * to 12 boxes of buttons and reported the total as one number, then
       * divided a received count by it to produce a "progress" percentage.
       * Progress is counted in LINES, which are commensurable; the per-line
       * quantities keep their own units below. */
      const linesTotal = po.items.length;
      const linesComplete = po.items.filter(
        (i) => (i.receivedQuantity || 0) >= (i.quantity || 0)).length;

      return {
        _id: po._id,
        poNumber: po.poNumber,
        date: po.orderDate,
        status: po.status,
        totalAmount: po.totalAmount,
        items: po.items.map(item => ({
          name: item.rawItem?.name || item.itemName,
          sku: item.sku,
          unit: item.unit,
          quantity: item.quantity,
          delivered: item.receivedQuantity || 0,
          pending: item.pendingQuantity || item.quantity
        })),
        deliveryDate: po.expectedDeliveryDate,
        /* Stated as what it counts, so nobody reads it as a quantity. */
        linesComplete,
        linesTotal,
        progress: linesTotal > 0 ? Math.round((linesComplete / linesTotal) * 100) : null,
        progressBasis: "LINES_FULLY_RECEIVED"
      };
    });

    res.json({
      success: true,
      purchaseOrders: formattedOrders,
      stats,
      pagination: {
        limit,
        returned: purchaseOrders.length,
        total: stats.totalOrders,
        /* Says plainly that this is a page, so nobody reads `purchaseOrders`
           as the supplier's whole order history. */
        hasMore: purchaseOrders.length < stats.totalOrders,
      }
    });

  } catch (error) {
    console.error("Error fetching vendor purchase orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor purchase orders"
    });
  }
});

/* ── PAYMENTS ARE NOT STORE'S TO REPORT ─────────────────────────────────────
 * This endpoint read `po.payments` — an editable array on the purchase order —
 * and presented it as the supplier's transaction history: amounts, dates, who
 * recorded them, running totals of what was "paid". Store does not own bills,
 * settlement or ledgers; Accounting does. A payment recorded there and not
 * here, or corrected there after being entered here, made this screen quietly
 * wrong about money.
 *
 * Rather than serve a second, unreconciled version of Accounting's records, it
 * says whose they are. The Accounting integration is a later chunk; until it
 * exists, an honest blank beats a confident number. */
router.get("/:id/transactions", canRead, async (req, res) => {
  try {
    const vendor = await loadSupplier(req, res);
    if (!vendor) return;

    return res.status(503).json({
      success: false,
      code: "PAYMENTS_OWNED_BY_ACCOUNTING",
      message:
        "Payments and settlement are recorded in Accounting, not in Store & Purchase. "
        + "This screen cannot show them yet.",
      owner: "Accounting",
      transactions: [],
    });
  } catch (error) {
    console.error("Error answering supplier transactions:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

/* ── WHAT THIS SUPPLIER HAS SUPPLIED ────────────────────────────────────────
 * The old version accumulated `totalQuantity += item.quantity` across every
 * line of every order — 300 metres of fabric plus 12 boxes of buttons plus 5
 * sewing machines, reported as one figure — and derived an "average price"
 * from the same pooled total. Quantities are only addable within one unit, so
 * each item now keeps its own, and a line with no recorded unit is counted
 * separately rather than folded in with the rest. */
router.get("/:id/items-supplied", canRead, async (req, res) => {
  try {
    const vendor = await loadSupplier(req, res);
    if (!vendor) return;

    const orders = await PurchaseOrder.find({
      ...tenantContext.tenantFilter(req.tenant),
      vendor: vendor._id,
    })
      .select("items orderDate")
      .sort({ orderDate: -1, _id: -1 })
      .lean();

    const byItem = new Map();

    orders.forEach((po) => {
      (po.items || []).forEach((line) => {
        const key = String(line.rawItem || line.itemName || "");
        if (!key) return;

        if (!byItem.has(key)) {
          byItem.set(key, {
            rawItem: line.rawItem || null,
            name: line.itemName || "",
            sku: line.sku || "",
            orders: 0,
            /* One bucket per unit. Never one total. */
            quantities: new Map(),
            unitsWithoutName: 0,
            orderedValue: 0,
            lastOrderedAt: null,
          });
        }

        const row = byItem.get(key);
        row.orders += 1;
        row.orderedValue += (line.quantity || 0) * (line.unitPrice || 0);
        if (!row.lastOrderedAt || new Date(po.orderDate) > new Date(row.lastOrderedAt)) {
          row.lastOrderedAt = po.orderDate;
        }
        if (line.itemName && !row.name) row.name = line.itemName;

        const unit = (line.unit || "").trim();
        if (!unit) {
          /* Counted, not pooled: a line whose unit nobody recorded cannot be
             added to metres or to pieces, and hiding it would understate. */
          row.unitsWithoutName += 1;
          return;
        }
        row.quantities.set(unit, (row.quantities.get(unit) || 0) + (line.quantity || 0));
      });
    });

    const itemsSupplied = [...byItem.values()].map((row) => ({
      rawItem: row.rawItem,
      name: row.name,
      sku: row.sku,
      orders: row.orders,
      /* An array, because "how much" has as many answers as there are units. */
      quantityByUnit: [...row.quantities.entries()].map(([unit, quantity]) => ({ unit, quantity })),
      linesWithNoRecordedUnit: row.unitsWithoutName,
      orderedValue: Math.round(row.orderedValue),
      lastOrderedAt: row.lastOrderedAt,
    }));

    res.json({ success: true, itemsSupplied, total: itemsSupplied.length });
  } catch (error) {
    console.error("Error fetching items supplied:", error);
    res.status(500).json({ success: false, message: "Server error while fetching supplied items" });
  }
});

/* ── PERFORMANCE IS MEASURED OR IT IS ABSENT ────────────────────────────────
 * What this endpoint used to return:
 *
 *   onTimeDelivery = 85    a literal, returned whenever there was no delivery
 *                          data — which is exactly when a reader most needs to
 *                          know there is none. A made-up 85% is not a neutral
 *                          placeholder; it is a supplier passing a bar nobody
 *                          measured them against.
 *   paymentOnTime  = 90    the same, plus a deeper problem: it inferred
 *                          settlement from `po.payments`, an editable array on
 *                          the purchase order. Store does not own bills or
 *                          payments — Accounting does — so any answer here is
 *                          a guess dressed as a fact.
 *   responseTime   = 24    hours, with no communication tracking anywhere.
 *   qualityRating  = vendor.rating || 4.2
 *                          a number somebody typed into a form, presented
 *                          beside computed metrics as though it were one.
 *   totalSpent            order value of COMPLETED orders, labelled as money
 *                          spent. An order being complete says the goods
 *                          arrived, not that anyone was paid.
 *
 * Every figure below is computed from dated records this company owns, and
 * carries the denominator it was computed over. Where there is nothing to
 * measure, the value is null and the coverage says zero — a reader can tell
 * "nothing yet" from "measured, and poor". */
router.get("/:id/performance", canRead, async (req, res) => {
  try {
    const vendor = await loadSupplier(req, res);
    if (!vendor) return;

    /* This company's orders only. The old query matched every company's. */
    const orders = await PurchaseOrder.find({
      ...tenantContext.tenantFilter(req.tenant),
      vendor: vendor._id,
    }).select("status totalAmount deliveries orderDate expectedDeliveryDate").lean();

    const totalOrders = orders.length;
    const byStatus = (s) => orders.filter((o) => o.status === s).length;

    /* ── ON-TIME DELIVERY, WHERE BOTH DATES EXIST ──────────────────────────
     * An order with no expected date cannot be late, and one with no recorded
     * delivery has not arrived. Neither belongs in the denominator: counting
     * them as on-time flatters the supplier, counting them as late blames it
     * for a date nobody recorded. */
    /* ── WHAT "ON TIME" CAN HONESTLY MEAN HERE ─────────────────────────
     * The previous version took the FIRST dated receipt as the order's
     * delivery. One carton arriving early therefore made a shipment that
     * finished a month late count as on time — the metric rewarded exactly
     * the behaviour it was supposed to detect.
     *
     * An order is on time only if the receipt that COMPLETED it arrived by
     * the expected date. That needs a completed order, an expected date, and
     * a dated final receipt. Where those exist the figure is computed and
     * labelled FINAL_RECEIPT; where they do not, it is not estimated from
     * whatever partial data is lying about. */
    const finalMeasurable = orders.filter((o) => {
      if (o.status !== "COMPLETED" || !o.expectedDeliveryDate) return false;
      return (o.deliveries || []).some((d) => d.deliveryDate || d.createdAt);
    });

    const lastReceipt = (o) => (o.deliveries || [])
      .map((d) => new Date(d.deliveryDate || d.createdAt))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((x, y) => y - x)[0] || null;

    const onTimeCount = finalMeasurable.filter((o) => {
      const last = lastReceipt(o);
      return last && last <= new Date(o.expectedDeliveryDate);
    }).length;

    const onTimeDelivery = finalMeasurable.length
      ? Math.round((onTimeCount / finalMeasurable.length) * 100)
      : null;
    const onTimeDeliveryBasis = finalMeasurable.length ? "FINAL_RECEIPT" : "NOT_MEASURED";

    /* Value ORDERED, on orders that completed. Not money that changed hands. */
    const completedOrders = orders.filter((o) => o.status === "COMPLETED");
    const orderedValue = completedOrders.reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    const openValue = orders
      .filter((o) => ["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status))
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

    res.json({
      success: true,
      performance: {
        totalOrders,
        completedOrders: byStatus("COMPLETED"),
        cancelledOrders: byStatus("CANCELLED"),
        pendingOrders: orders.filter((o) =>
          ["ISSUED", "PARTIALLY_RECEIVED"].includes(o.status)).length,

        onTimeDelivery,
        onTimeDeliveryBasis,
        /* The denominator, always. "80% of 5" and "80% of 500" are different
           claims, and a percentage alone hides which one this is. */
        onTimeDeliveryCoverage: { measured: finalMeasurable.length, of: totalOrders },

        orderedValue,
        /* Named for the population it divides. It was completed-order value
           over ALL orders, so one completed order among ten made the average
           a tenth of what it actually was. */
        averageCompletedOrderValue: completedOrders.length
          ? Math.round(orderedValue / completedOrders.length) : null,
        openOrderValue: openValue,

        /* ── WHERE A RATING CAME FROM ─────────────────────────────────
         * RECORDED: a person assessed this supplier, and we have who and
         * when. LEGACY_UNVERIFIED: a value with no recorded author, which
         * cannot be told apart from the old `default: 3` the application
         * itself wrote — so it is not attributed to anybody. */
        statedRating: vendor.rating
          ? {
            value: vendor.rating,
            source: vendor.ratingRecordedAt ? "RECORDED" : "LEGACY_UNVERIFIED",
            by: vendor.ratingRecordedByName || null,
            at: vendor.ratingRecordedAt || null,
            reason: vendor.ratingReason || "",
          }
          : null,

        /* Deliberately absent, not zero: settlement is Accounting's record,
           and quoting a number from here would be Store answering a question
           it cannot see the evidence for. */
        paymentPerformance: { available: false, owner: "Accounting" },
      },
    });
  } catch (error) {
    console.error("Error fetching supplier performance:", error);
    res.status(500).json({ success: false, message: "Server error while fetching supplier performance" });
  }
});

module.exports = router;