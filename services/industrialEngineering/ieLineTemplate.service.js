// services/industrialEngineering/ieLineTemplate.service.js
//
// REUSABLE LINE TEMPLATES — CHUNK 6C.
//
// A template is an engineering PATTERN: how many stations, in what order, what
// each is called and noted, what each is planned to be equipped with, and which
// operations belong at each. It is captured from a layout that already exists,
// and applied to another layout later.
//
// ── THE WHOLE RISK OF THIS CHUNK IS IDENTITY ────────────────────────────────
// A template travels between styles. Everything that identifies the layout it
// came from must therefore stay behind, or applying it would make one style's
// line claim another's evidence. So the capture keeps NONE of:
//
//   · the layout's id, revision, history or ownership;
//   · its bound source — the bulletin revision, the fingerprint, the digests;
//   · its `rowId` values, which belong to one file's bulletin;
//   · its station ids, which identify one layout's stations in one trail;
//   · any calculated figure or compatibility verdict.
//
// What it keeps is the pattern, and one stable reference per slot: the
// `ieOperationId` from the frozen layout source, plus WHICH OCCURRENCE of that
// operation is meant.
//
// ── WHY OCCURRENCE, AND WHY IT IS DETERMINISTIC ─────────────────────────────
// A bulletin may place the same operation more than once — two buttonholes, a
// first and a second press. "Attach button belongs at station 3" is not enough
// to reproduce a line that has three of them. So each slot records the ordinal
// of that operation WITHIN THE SOURCE'S OWN ORDER, counted from 1, and applying
// resolves the same ordinal against the target's source order.
//
// Source order is `sourceRows` as the layout froze it, which is the bulletin's
// own sequence. It is stable, it is already the order every other part of this
// chunk reads, and it does not depend on which stations anything is at.
//
// ── AND `operationCode` IS NEVER A MATCHING KEY ─────────────────────────────
// It is mutable, it is re-usable once an operation is retired, and two
// companies may both hold `SEW-01`. Chunk 6B already labelled it as a legacy
// compatibility path for Production. It is captured here for a person to read
// and nothing resolves through it.
//
// ── NOTHING HERE TOUCHES PRODUCTION ─────────────────────────────────────────
// No `Machine`, no `CanvasLayout`, no barcode, no scan, no operator session, no
// availability, no maintenance status, no capacity, no approval and no release.
// A planned machine type is a TYPE and a count, exactly as Chunk 6B defined it.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeLineTemplate = require("../../models/CMS_Models/IndustrialEngineering/IeLineTemplate");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
/* Chunk 6C correction: an edited slot's operation is proved against THIS
   company's library before the pattern is stored. */
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const { fail } = require("../storePurchase/errors");
const { encodeCursor, decodeCursor, pageSize } = require("./ieRead.service");
const layouts = require("./ieLineLayout.service");

const { LIMITS, nameKeyOf } = IeLineTemplate;
const STATUS = Object.freeze({ ACTIVE: "ACTIVE", RETIRED: "RETIRED" });

/* The accepted surfaces. Anything else is refused by name rather than dropped,
   so a caller learns what this record does not hold rather than believing it
   saved something it did not. */
const CREATE_FIELDS = Object.freeze(["layoutId", "name", "description"]);
const PATCH_FIELDS = Object.freeze(["expectedRevision", "name", "description", "stations"]);
const STATION_FIELDS = Object.freeze(["label", "note", "plannedMachineTypes", "slots"]);
const SLOT_FIELDS = Object.freeze(["ieOperationId", "occurrence"]);
const LIFECYCLE_FIELDS = Object.freeze(["expectedRevision"]);
const APPLY_FIELDS = Object.freeze(["templateId", "expectedRevision"]);

/* Fields somebody will reasonably try to send, refused by name with where the
   fact actually lives. Every identity this chunk must not lend is here, and so
   is every Production concept the boundary excludes. */
const REFUSED_FIELDS = Object.freeze({
  companyId: "the company — that comes from your own membership, never a body",
  templateId: "its own id",
  status: "its own status — retire and restore are their own actions",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  history: "its own audit trail",
  nameKey: "the uniqueness form of its name, which only the server derives",
  capturedFrom: "where it was captured from, which the server records",
  templateStationId: "a template station id, which the server mints",
  slotId: "a slot id, which the server mints",
  rowId: "a bulletin row id. A row belongs to one file's bulletin and a template belongs to none",
  bulletinRowId: "a bulletin row id. A row belongs to one file's bulletin and a template belongs to none",
  stationId: "a LAYOUT station id. Applying a template mints fresh ones",
  ieStyleFileId: "which engineering file it belongs to — a template belongs to no file",
  bulletinRevision: "a bulletin revision — a template is bound to no bulletin",
  sourceFingerprint: "a layout's source fingerprint, which only the server computes",
  sourceRows: "a layout's bound source rows",
  layoutRevision: "a layout's revision",
  operationCode: "an operation CODE. A slot names the stable operation id, never a mutable code",
  standardTimeMinutes: "a standard time — that comes from the approved method study",
  machineTypeCompatibility: "a compatibility verdict — the server decides it from frozen evidence",
  compatible: "a compatibility verdict — the server decides it from frozen evidence",
  workloadMinutes: "a calculated workload",
  balanceEfficiencyPercent: "a calculated figure",
  machineId: "a specific machine. A template is an engineering pattern, not a floor allocation",
  serialNumber: "a machine serial number, which is an asset record",
  assetId: "an asset id, which is an asset record",
  availability: "an availability, which Maintenance and Production own",
  maintenanceStatus: "a maintenance status, which Maintenance owns",
  employeeId: "an employee. A template arranges WORK, never people",
  employeeName: "an employee. A template arranges WORK, never people",
  operatorId: "an operator. A template arranges WORK, never people",
  shift: "a shift, which is capacity planning and a later chunk",
  capacity: "a capacity figure, which is a later chunk",
  targetOutput: "a target output, which is capacity planning and a later chunk",
  barcodeId: "a barcode — a printed piece is Production's record",
  scanId: "a scan — Production owns scanning",
  approvedAt: "an approval. Nothing here approves or releases anything",
  releasedAt: "a release. Nothing here approves or releases anything",
});

/* ═══ HELPERS ══════════════════════════════════════════════════════════════ */

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const mintTemplateStationId = () => `tst_${crypto.randomBytes(9).toString("hex")}`;
const mintSlotId = () => `tsl_${crypto.randomBytes(9).toString("hex")}`;
const mintEventId = () => `lte_${crypto.randomBytes(9).toString("hex")}`;

const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const event = (type, { actor, templateRevision, changed = [], summary = "" }) => ({
  eventId: mintEventId(),
  type,
  at: new Date(),
  actorId: actorId(actor),
  actorName: actorName(actor),
  templateRevision,
  changed: [...changed],
  summary,
});

function assertContext(ctx) {
  if (!ctx?.companyId) {
    throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Choose which company you are working in.");
  }
}

/* A foreign company's template and a template that does not exist are ONE
   answer. Saying which would confirm that a record exists in a company the
   caller cannot see. */
const templateNotFound = () =>
  fail("IE_LINE_TEMPLATE_NOT_FOUND", "That line template was not found.");

function assertShape(body, allowed, what) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", `That is not ${what}.`);
  }
  for (const key of Object.keys(body)) {
    /* An endpoint that NAMES a field accepts it, whatever the record refuses on
       its own body. `templateId` is the clearest case: a template may never
       carry its own id, and applying one must say which. The allowlist is
       therefore checked first, and the refusal map explains everything it does
       not name. */
    if (allowed.includes(key)) continue;
    const refused = REFUSED_FIELDS[key];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A line template cannot carry ${refused}.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `This record does not accept "${key}".` }] });
    }
    throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${what}.`,
      { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not part of ${what}.` }] });
  }
}

function readExpectedRevision(value) {
  if (value === undefined || value === null || value === "") {
    throw fail("VALIDATION", "Say which revision of this template you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Say which revision of this template you read." }],
    });
  }
  const expected = Number(value);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "A revision is a whole number.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "NOT_AN_INTEGER", message: "A revision is a whole number." }],
    });
  }
  return expected;
}

const text = (v, field, max, errs, index) => {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    errs.push({ field, code: "INVALID", message: "This is text.", index });
    return "";
  }
  const out = v.trim().replace(/\s+/g, " ");
  if (out.length > max) {
    errs.push({ field, code: "TOO_LONG", message: `At most ${max} characters.`, index });
    return out.slice(0, max);
  }
  return out;
};

/**
 * A name, or a typed refusal — never a quietly shortened one.
 *
 * `text()` collects its complaints into an array and returns a TRUNCATED value
 * so a caller can report several field errors at once. Both readers here passed
 * a throwaway array, so an over-long name or description was clipped to the
 * limit and saved: the person got a 200, and the record held something they did
 * not write. The errors are now collected and thrown, and nothing is stored.
 */
function readName(value, { required = true } = {}) {
  const errs = [];
  const name = text(value, "name", LIMITS.NAME, errs, undefined);
  if (errs.length) {
    throw fail("VALIDATION", `A template name is at most ${LIMITS.NAME} characters.`,
      { field: "name", fieldErrors: errs });
  }
  if (!name && required) {
    throw fail("VALIDATION", "Give this template a name.", {
      field: "name",
      fieldErrors: [{ field: "name", code: "REQUIRED", message: "Give this template a name." }],
    });
  }
  return name;
}

/** A description, on the same terms. Whitespace is still normalised. */
function readDescription(value) {
  const errs = [];
  const description = text(value, "description", LIMITS.DESCRIPTION, errs, undefined);
  if (errs.length) {
    throw fail("VALIDATION", `A description is at most ${LIMITS.DESCRIPTION} characters.`,
      { field: "description", fieldErrors: errs });
  }
  return description;
}

const upperType = (v) => str(v).replace(/\s+/g, " ").toUpperCase();

/**
 * A duplicate ACTIVE name, whichever write hit it.
 *
 * The unique partial index is what decides this, and it is caught rather than
 * pre-checked: two simultaneous creates both pass a look-then-insert, and only
 * the index can settle it.
 */
const isDuplicateKey = (err) =>
  err?.code === 11000 || /E11000|duplicate key/i.test(str(err?.message));

const duplicateName = (name) => fail("IE_LINE_TEMPLATE_NAME_TAKEN",
  `Another active line template in this company is already called ${name}.`,
  { field: "name", name, fieldErrors: [{ field: "name", code: "TAKEN", message: "That name is taken." }] });

/* ═══ THE PUBLISHED SHAPE ══════════════════════════════════════════════════ */

const publishSlot = (s) => ({
  slotId: s.slotId,
  sequence: s.sequence,
  /* The STABLE identity a slot resolves through. */
  ieOperationId: String(s.ieOperationId),
  occurrence: s.occurrence,
  /* Read-only labels. Not how anything matches — see the header. */
  operationCode: s.operationCode || "",
  operationName: s.operationName || "",
});

const publishEvent = (e) => ({
  eventId: e.eventId,
  type: e.type,
  at: e.at ? new Date(e.at).toISOString() : null,
  actorName: e.actorName || "",
  templateRevision: e.templateRevision,
  changed: Array.isArray(e.changed) ? [...e.changed] : [],
  summary: e.summary || "",
});

function publishTemplate(doc, { withHistory = false } = {}) {
  const stations = (doc.stations || []).map((s) => ({
    templateStationId: s.templateStationId,
    sequence: s.sequence,
    label: s.label || "",
    note: s.note || "",
    plannedMachineTypes: (s.plannedMachineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
    slots: (s.slots || []).map(publishSlot),
  }));
  return {
    templateId: String(doc._id),
    companyId: String(doc.companyId),
    name: doc.name,
    description: doc.description || "",
    status: doc.status,
    revision: doc.revision,
    stations,
    stationCount: stations.length,
    slotCount: stations.reduce((n, s) => n + s.slots.length, 0),
    /* Provenance for a person to read. Nothing resolves through it, and a
       template whose source layout has since been superseded is still a
       perfectly good pattern. */
    capturedFrom: doc.capturedFrom ? {
      layoutId: doc.capturedFrom.layoutId ? String(doc.capturedFrom.layoutId) : null,
      ieStyleFileId: doc.capturedFrom.ieStyleFileId ? String(doc.capturedFrom.ieStyleFileId) : null,
      bulletinRevision: doc.capturedFrom.bulletinRevision ?? null,
      layoutRevision: doc.capturedFrom.layoutRevision ?? null,
      capturedAt: doc.capturedFrom.capturedAt ? new Date(doc.capturedFrom.capturedAt).toISOString() : null,
    } : null,
    editable: doc.status === STATUS.ACTIVE,
    ...(withHistory ? { history: [...(doc.history || [])].reverse().map(publishEvent) } : {}),
    createdByName: doc.createdByName || "",
    updatedByName: doc.updatedByName || "",
    statusChangedAt: doc.statusChangedAt ? new Date(doc.statusChangedAt).toISOString() : null,
    statusChangedByName: doc.statusChangedByName || "",
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
    /* This chunk reuses a pattern. It does not approve, release, allocate or
       plan capacity, and says so rather than letting a screen infer a control. */
    canApprove: false,
    allocates: false,
  };
}

/* ═══ THE OCCURRENCE RULE ══════════════════════════════════════════════════
 *
 * `sourceRows` in the layout's own frozen order — which is the bulletin's
 * sequence — walked once, counting each operation as it appears. The first
 * `attach button` is occurrence 1, the second is 2, and so on.
 *
 * Deterministic by construction: one pass, one order, no dependence on which
 * station anything sits at or on any code. Capture and apply use exactly this
 * function, so the two can never disagree about what "the second one" means.
 */
function occurrenceIndexOf(sourceRows = []) {
  const ordered = [...sourceRows].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const seen = new Map();
  const byRow = new Map();
  const byOperation = new Map();
  for (const row of ordered) {
    const key = String(row.ieOperationId);
    const n = (seen.get(key) || 0) + 1;
    seen.set(key, n);
    byRow.set(row.rowId, { ieOperationId: key, occurrence: n, row });
    if (!byOperation.has(key)) byOperation.set(key, new Map());
    byOperation.get(key).set(n, row);
  }
  return { byRow, byOperation, counts: seen };
}

/* ═══ SHAPING A PATTERN A CALLER SENT ══════════════════════════════════════ */

/**
 * Stations and their slots, in the shape this record stores.
 *
 * Ids are minted here and never accepted: `templateStationId` and `slotId` are
 * the server's, and a caller that could send one could make a template claim
 * another template's station in the trail. `sequence` is not accepted either —
 * position in the array IS the sequence, at every level.
 */
function shapeStations(list, { validOperationIds = null } = {}) {
  if (!Array.isArray(list)) {
    throw fail("IE_LINE_TEMPLATE_STATION_INVALID", "Stations are an ordered list.", {
      field: "stations",
      fieldErrors: [{ field: "stations", code: "NOT_A_LIST", message: "Stations are an ordered list." }],
    });
  }
  if (list.length > LIMITS.STATIONS) {
    throw fail("IE_LINE_TEMPLATE_STATION_INVALID", `A template holds at most ${LIMITS.STATIONS} stations.`, {
      field: "stations",
      fieldErrors: [{ field: "stations", code: "TOO_MANY", message: `At most ${LIMITS.STATIONS} stations.` }],
    });
  }

  const errs = [];
  const shaped = [];
  /* One operation occurrence, one place in the pattern — the same rule a
     layout applies to a row, for the same reason: two stations claiming "the
     second buttonhole" makes the pattern impossible to apply. */
  const seenSlots = new Set();

  for (let i = 0; i < list.length; i += 1) {
    const raw = list[i];
    const at = (f) => `stations.${i}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push({ field: `stations.${i}`, code: "INVALID", message: "Every station is an object.", index: i });
      continue;
    }
    for (const field of Object.keys(raw)) {
      if (STATION_FIELDS.includes(field)) continue;
      const refused = REFUSED_FIELDS[field];
      {
        throw fail("FIELD_NOT_ACCEPTED",
          refused ? `A template station cannot carry ${refused}.` : `"${field}" is not part of a template station.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: i }] });
      }
    }

    const label = text(raw.label, at("label"), LIMITS.LABEL, errs, i);
    const note = text(raw.note, at("note"), LIMITS.NOTE, errs, i);

    /* ── PLANNED MACHINE TYPES ── the same vocabulary Chunk 6B defined, and
       the same two keys. A TYPE and a count, never a machine. */
    const plannedMachineTypes = [];
    const rawPlan = raw.plannedMachineTypes === undefined ? [] : raw.plannedMachineTypes;
    if (!Array.isArray(rawPlan)) {
      throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID", "Planned machine types are a list.", {
        field: at("plannedMachineTypes"), index: i,
        fieldErrors: [{ field: at("plannedMachineTypes"), code: "NOT_A_LIST", message: "This is a list.", index: i }],
      });
    }
    if (rawPlan.length > LIMITS.MACHINE_TYPES_PER_STATION) {
      throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID",
        `A station plans at most ${LIMITS.MACHINE_TYPES_PER_STATION} machine types.`, {
          field: at("plannedMachineTypes"), index: i,
          fieldErrors: [{ field: at("plannedMachineTypes"), code: "TOO_MANY", message: `At most ${LIMITS.MACHINE_TYPES_PER_STATION}.`, index: i }],
        });
    }
    const seenTypes = new Set();
    for (let k = 0; k < rawPlan.length; k += 1) {
      const entry = rawPlan[k];
      const mf = (f) => `${at("plannedMachineTypes")}.${k}.${f}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID", "Every planned machine type is an object.", {
          field: `${at("plannedMachineTypes")}.${k}`, index: k,
          fieldErrors: [{ field: `${at("plannedMachineTypes")}.${k}`, code: "INVALID", message: "Every entry is an object.", index: k }],
        });
      }
      for (const field of Object.keys(entry)) {
        if (["machineType", "quantity"].includes(field)) continue;
        const refused = REFUSED_FIELDS[field];
        {
          throw fail("FIELD_NOT_ACCEPTED",
            refused ? `A planned machine type cannot carry ${refused}.`
              : `"${field}" is not part of a planned machine type. A station plans a TYPE and a count, nothing else.`,
            { field: mf(field), fieldErrors: [{ field: mf(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: k }] });
        }
      }
      const machineType = text(entry.machineType, mf("machineType"), LIMITS.LABEL, errs, k);
      if (!machineType) {
        throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID", "Name the machine type this station plans.", {
          field: mf("machineType"), index: k,
          fieldErrors: [{ field: mf("machineType"), code: "REQUIRED", message: "Name the machine type.", index: k }],
        });
      }
      const quantity = entry.quantity;
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > LIMITS.MACHINE_QUANTITY) {
        throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID",
          `A planned quantity is a whole number from 1 to ${LIMITS.MACHINE_QUANTITY}.`, {
            field: mf("quantity"), index: k,
            fieldErrors: [{ field: mf("quantity"), code: "OUT_OF_RANGE", message: `A whole number from 1 to ${LIMITS.MACHINE_QUANTITY}.`, index: k }],
          });
      }
      const key = upperType(machineType);
      if (seenTypes.has(key)) {
        throw fail("IE_LINE_TEMPLATE_MACHINE_TYPE_DUPLICATE",
          `${machineType} is planned twice at this station. Record it once with the quantity it needs.`, {
            field: mf("machineType"), machineType, index: k,
            fieldErrors: [{ field: mf("machineType"), code: "DUPLICATE", message: "Planned twice.", index: k }],
          });
      }
      seenTypes.add(key);
      plannedMachineTypes.push({ machineType, quantity });
    }

    /* ── THE SLOTS ── a stable operation id and which occurrence of it. */
    const slots = [];
    const rawSlots = raw.slots === undefined ? [] : raw.slots;
    if (!Array.isArray(rawSlots)) {
      throw fail("IE_LINE_TEMPLATE_STATION_INVALID", "Slots are an ordered list.", {
        field: at("slots"), index: i,
        fieldErrors: [{ field: at("slots"), code: "NOT_A_LIST", message: "Slots are an ordered list.", index: i }],
      });
    }
    if (rawSlots.length > LIMITS.SLOTS_PER_STATION) {
      throw fail("IE_LINE_TEMPLATE_STATION_INVALID", `At most ${LIMITS.SLOTS_PER_STATION} slots per station.`, {
        field: at("slots"), index: i,
        fieldErrors: [{ field: at("slots"), code: "TOO_MANY", message: `At most ${LIMITS.SLOTS_PER_STATION}.`, index: i }],
      });
    }
    for (let j = 0; j < rawSlots.length; j += 1) {
      const entry = rawSlots[j];
      const sf = (f) => `${at("slots")}.${j}.${f}`;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw fail("IE_LINE_TEMPLATE_STATION_INVALID", "Every slot is an object.", {
          field: `${at("slots")}.${j}`, index: j,
          fieldErrors: [{ field: `${at("slots")}.${j}`, code: "INVALID", message: "Every slot is an object.", index: j }],
        });
      }
      for (const field of Object.keys(entry)) {
        if (SLOT_FIELDS.includes(field)) continue;
        const refused = REFUSED_FIELDS[field];
        {
          throw fail("FIELD_NOT_ACCEPTED",
            refused ? `A slot cannot carry ${refused}.`
              : `"${field}" is not part of a slot. A slot names the stable operation and which occurrence of it.`,
            { field: sf(field), fieldErrors: [{ field: sf(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: j }] });
        }
      }
      const ieOperationId = str(entry.ieOperationId);
      if (!isId(ieOperationId)) {
        throw fail("IE_LINE_TEMPLATE_SLOT_INVALID",
          "A slot names an operation by its stable id, never by its code.", {
            field: sf("ieOperationId"), index: j,
            fieldErrors: [{ field: sf("ieOperationId"), code: "REQUIRED", message: "Name the operation by its id.", index: j }],
          });
      }
      /* A slot may only name an operation this pattern is allowed to hold —
         at capture, one that the source actually contains. */
      if (validOperationIds && !validOperationIds.has(ieOperationId)) {
        throw fail("IE_LINE_TEMPLATE_SLOT_INVALID",
          "That operation is not one this template was captured against.", {
            field: sf("ieOperationId"), ieOperationId, index: j,
            fieldErrors: [{ field: sf("ieOperationId"), code: "UNKNOWN_OPERATION", message: "Not part of this template's source.", index: j }],
          });
      }
      const occurrence = entry.occurrence === undefined ? 1 : entry.occurrence;
      if (typeof occurrence !== "number" || !Number.isInteger(occurrence) || occurrence < 1) {
        throw fail("IE_LINE_TEMPLATE_SLOT_INVALID",
          "An occurrence is a whole number from 1 — which time this operation appears in the bulletin.", {
            field: sf("occurrence"), index: j,
            fieldErrors: [{ field: sf("occurrence"), code: "OUT_OF_RANGE", message: "A whole number from 1.", index: j }],
          });
      }
      const slotKey = `${ieOperationId}#${occurrence}`;
      if (seenSlots.has(slotKey)) {
        throw fail("IE_LINE_TEMPLATE_SLOT_DUPLICATE",
          "That operation occurrence is already placed at a station in this template.", {
            field: sf("ieOperationId"), ieOperationId, occurrence, index: j,
            fieldErrors: [{ field: sf("ieOperationId"), code: "DUPLICATE_SLOT", message: "Already placed in this template.", index: j }],
          });
      }
      seenSlots.add(slotKey);
      slots.push({
        slotId: mintSlotId(),
        sequence: slots.length + 1,
        ieOperationId: oid(ieOperationId),
        occurrence,
        operationCode: "",
        operationName: "",
      });
    }

    shaped.push({
      templateStationId: mintTemplateStationId(),
      sequence: shaped.length + 1,
      label, note, plannedMachineTypes, slots,
    });
  }

  if (errs.length) {
    throw fail("IE_LINE_TEMPLATE_STATION_INVALID", "Some of these stations need fixing.",
      { fieldErrors: errs, field: errs[0].field });
  }
  return shaped;
}

/**
 * PROVE EVERY SLOT'S OPERATION BELONGS TO THIS COMPANY.
 *
 * A template PATCH used to accept any syntactically valid ObjectId: `isId()`
 * says a string is shaped like an id, not that it names anything, and certainly
 * not that it names something of yours. So an edited pattern could carry another
 * company's operation, or one that never existed, and be stored — with its
 * display labels copied from whatever the PREVIOUS revision happened to say.
 *
 * Every distinct submitted id is therefore resolved against this company's
 * operation library before anything is written. A missing id and a foreign one
 * are refused identically: "does that operation exist somewhere else" is not a
 * question a tenant boundary answers.
 *
 * ── WHY RETIRED OPERATIONS ARE ACCEPTED ─────────────────────────────────────
 * The library's own lifecycle keeps a retired operation readable and referable —
 * bulletin rows and method studies point at retired operations by design, and
 * retirement raises a readiness gap rather than invalidating history. A pattern
 * that names one is in exactly that position: it is a plan that will surface as
 * a gap when applied, not a forgery to refuse here.
 *
 * Matching is by ID only. `operationCode` is a display label, and validating on
 * it would make a renamed code a broken template.
 */
async function proveSlotOperations(ctx, stations) {
  const wanted = [...new Set(
    stations.flatMap((s) => (s.slots || []).map((slot) => String(slot.ieOperationId))),
  )];
  if (!wanted.length) return new Map();

  const owned = await IeOperation.find({
    _id: { $in: wanted.map(oid) },
    companyId: ctx.companyId,
  }).select("_id code name revision status").lean();
  const byId = new Map(owned.map((o) => [String(o._id), o]));

  const errs = [];
  stations.forEach((station, i) => {
    (station.slots || []).forEach((slot, j) => {
      const id = String(slot.ieOperationId);
      if (byId.has(id)) return;
      errs.push({
        field: `stations.${i}.slots.${j}.ieOperationId`,
        code: "UNKNOWN_OPERATION",
        message: "That operation is not in your company's operation library.",
        ieOperationId: id,
        index: j,
      });
    });
  });
  if (errs.length) {
    /* No write, no revision, no timestamp, no trail entry — the refusal happens
       before any of that, and names every affected slot at once. */
    throw fail("IE_LINE_TEMPLATE_SLOT_OPERATION_NOT_FOUND",
      errs.length === 1
        ? "That slot names an operation your company's library does not hold."
        : `${errs.length} slots name operations your company's library does not hold.`,
      { field: errs[0].field, fieldErrors: errs, ieOperationIds: [...new Set(errs.map((e) => e.ieOperationId))] });
  }
  return byId;
}

/** The read-only labels, taken from the PROVED company-owned records. */
function labelSlotsFromLibrary(stations, byId) {
  return stations.map((s) => ({
    ...s,
    slots: s.slots.map((slot) => {
      const op = byId.get(String(slot.ieOperationId));
      return { ...slot, operationCode: op?.code || "", operationName: op?.name || "" };
    }),
  }));
}

/** Fill in the read-only operation labels from a source the caller supplied. */
function labelSlots(stations, sourceRows = []) {
  const byOperation = new Map();
  for (const row of sourceRows) {
    const key = String(row.ieOperationId);
    if (!byOperation.has(key)) {
      byOperation.set(key, { code: row.operationCode || "", name: row.operationName || "" });
    }
  }
  return stations.map((s) => ({
    ...s,
    slots: s.slots.map((slot) => {
      const label = byOperation.get(String(slot.ieOperationId));
      return { ...slot, operationCode: label?.code || "", operationName: label?.name || "" };
    }),
  }));
}

/* ═══ CREATE — CAPTURE A PATTERN FROM AN EXISTING LAYOUT ═══════════════════ */

async function loadOwnedLayout(ctx, layoutId) {
  assertContext(ctx);
  if (!isId(layoutId)) throw fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");
  const doc = await IeLineLayout.findOne({ _id: oid(layoutId), companyId: ctx.companyId }).lean();
  if (!doc) throw fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");
  return doc;
}

async function loadOwnedTemplate(ctx, templateId) {
  assertContext(ctx);
  if (!isId(templateId)) throw templateNotFound();
  const doc = await IeLineTemplate.findOne({ _id: oid(templateId), companyId: ctx.companyId }).lean();
  if (!doc) throw templateNotFound();
  return doc;
}

/**
 * CAPTURE — turn a layout somebody has already balanced into a reusable pattern.
 *
 * Everything that identifies the layout stays behind. What crosses is the shape
 * of the line and, per slot, the stable operation id plus which occurrence of it
 * — resolved through the layout's own frozen source, in source order.
 *
 * A SOURCE_CHANGED layout may still be captured from: it is a perfectly good
 * pattern, and the operations it names are named by their stable ids rather
 * than by anything that moved.
 */
async function createTemplate(ctx, { body = {}, actor = null } = {}) {
  assertContext(ctx);
  assertShape(body, CREATE_FIELDS, "a new line template");
  const name = readName(body.name);
  const description = readDescription(body.description);

  const layout = await loadOwnedLayout(ctx, body.layoutId);
  const { byRow } = occurrenceIndexOf(layout.sourceRows || []);

  /* The pattern, read off the layout. Ids are minted fresh here — none of the
     layout's station ids, and none of its row ids, travels. */
  const stations = (layout.stations || []).map((s, i) => ({
    templateStationId: mintTemplateStationId(),
    sequence: i + 1,
    label: s.label || "",
    note: s.note || "",
    plannedMachineTypes: (s.plannedMachineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
    slots: (s.assignments || []).map((a, j) => {
      const placed = byRow.get(a.rowId);
      /* A layout cannot hold an assignment its own source does not contain —
         Chunk 6A refuses that on the way in — so this is defensive only. */
      if (!placed) {
        throw fail("IE_LINE_TEMPLATE_SLOT_INVALID",
          "That operation is not one of the bulletin rows this layout was opened against.",
          { field: `stations.${i}.slots.${j}`, rowId: a.rowId });
      }
      return {
        slotId: mintSlotId(),
        sequence: j + 1,
        ieOperationId: oid(placed.ieOperationId),
        occurrence: placed.occurrence,
        operationCode: placed.row.operationCode || "",
        operationName: placed.row.operationName || "",
      };
    }),
  }));

  const doc = {
    companyId: ctx.companyId,
    name,
    nameKey: nameKeyOf(name),
    description,
    status: STATUS.ACTIVE,
    revision: 1,
    stations,
    capturedFrom: {
      layoutId: layout._id,
      ieStyleFileId: layout.ieStyleFileId,
      bulletinRevision: layout.bulletinRevision,
      layoutRevision: layout.revision,
      capturedAt: new Date(),
    },
    history: [event("LINE_TEMPLATE_CREATED", {
      actor,
      templateRevision: 1,
      summary: `Captured from a line layout — ${stations.length} stations, `
        + `${stations.reduce((n, s) => n + s.slots.length, 0)} operation slots`,
    })],
    createdBy: actorId(actor),
    createdByName: actorName(actor),
    updatedBy: actorId(actor),
    updatedByName: actorName(actor),
  };

  try {
    const created = await IeLineTemplate.create(doc);
    return { template: publishTemplate(created.toObject(), { withHistory: true }), created: true };
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicateName(name);
    throw err;
  }
}

/* ═══ READ ═════════════════════════════════════════════════════════════════ */

async function readTemplate(ctx, { templateId } = {}) {
  const doc = await loadOwnedTemplate(ctx, templateId);
  return { template: publishTemplate(doc, { withHistory: true }) };
}

/** The company's templates, newest first. Retired ones included and labelled. */
async function listTemplates(ctx, { status, limit, cursor } = {}) {
  assertContext(ctx);
  const size = pageSize(limit);
  const after = decodeCursor(cursor, "time");

  const wanted = str(status).toUpperCase();
  if (wanted && !Object.values(STATUS).includes(wanted)) {
    throw fail("VALIDATION", "A template is ACTIVE or RETIRED.", {
      field: "status",
      fieldErrors: [{ field: "status", code: "INVALID", message: "ACTIVE or RETIRED." }],
    });
  }

  const and = [{ companyId: ctx.companyId }];
  if (wanted) and.push({ status: wanted });
  if (after) {
    and.push({
      $or: [
        { createdAt: { $lt: new Date(after.t) } },
        { createdAt: new Date(after.t), _id: { $lt: oid(after.i) } },
      ],
    });
  }
  const found = await IeLineTemplate.find({ $and: and })
    .sort({ createdAt: -1, _id: -1 }).limit(size + 1).lean();
  const page = found.slice(0, size);
  const last = page[page.length - 1];
  return {
    templates: page.map((t) => publishTemplate(t)),
    statusFilter: wanted || null,
    limit: size,
    hasMore: found.length > size,
    nextCursor: found.length > size
      ? encodeCursor({ t: new Date(last.createdAt).getTime(), i: String(last._id) })
      : null,
    sort: "createdAt:desc,_id:desc",
  };
}

/* ═══ EDIT ═════════════════════════════════════════════════════════════════ */

/** What changed, as categories, for the trail. Never a copy of the pattern. */
function changedCategories(before, after) {
  const changed = [];
  if (before.name !== after.name) changed.push("name");
  if ((before.description || "") !== (after.description || "")) changed.push("description");
  if (after.stations) {
    const shape = (list) => (list || []).map((s) => ({
      label: s.label || "", note: s.note || "",
      plan: (s.plannedMachineTypes || []).map((m) => `${upperType(m.machineType)}:${m.quantity}`).join(","),
      slots: (s.slots || []).map((x) => `${String(x.ieOperationId)}#${x.occurrence}`).join(","),
    }));
    if (JSON.stringify(shape(before.stations)) !== JSON.stringify(shape(after.stations))) {
      changed.push("stations");
    }
  }
  return changed;
}

/**
 * EDIT the metadata and the pattern, checked against the revision that was read.
 *
 * A RETIRED template is not edited: it is evidence of a pattern somebody
 * decided to stop offering, and restoring it is its own act.
 */
async function updateTemplate(ctx, { templateId, body = {}, actor = null } = {}) {
  const current = await loadOwnedTemplate(ctx, templateId);
  assertShape(body, PATCH_FIELDS, "a template edit");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status !== STATUS.ACTIVE) {
    throw fail("IE_LINE_TEMPLATE_RETIRED",
      "This template is retired. Restore it before editing it.",
      { templateId: String(current._id), allowedAction: "RESTORE" });
  }
  if (current.revision !== expected) {
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, templateId: String(current._id) });
  }

  const $set = { updatedBy: actorId(actor), updatedByName: actorName(actor) };
  const after = { name: current.name, description: current.description, stations: null };

  if ("name" in body) {
    const name = readName(body.name);
    $set.name = name;
    $set.nameKey = nameKeyOf(name);
    after.name = name;
  }
  if ("description" in body) {
    const description = readDescription(body.description);
    $set.description = description;
    after.description = description;
  }
  if ("stations" in body) {
    /* Re-shaped whole, exactly as a layout's stations are: a pattern is an
       ordered sequence, and one atomic revision check is what makes replacing
       it safe. Ids are minted fresh — a template station id identifies a
       station in THIS revision's pattern, not across an edit that reordered
       everything. */
    const shaped = shapeStations(body.stations);
    /* Every slot's operation proved to be this company's BEFORE anything is
       written, and the display labels taken from those proved records rather
       than from the caller or from whatever the previous revision said. */
    const owned = await proveSlotOperations(ctx, shaped);
    $set.stations = labelSlotsFromLibrary(shaped, owned);
    after.stations = $set.stations;
  }

  const changed = changedCategories(current, after);
  if (!changed.length) {
    /* An honest no-op: nothing moved, so nothing is written, no revision moves
       and no trail entry is invented. */
    return { template: publishTemplate(current, { withHistory: true }), updated: false, events: [] };
  }

  const nextRevision = expected + 1;
  const audit = event("LINE_TEMPLATE_EDITED", {
    actor, templateRevision: nextRevision, changed,
    summary: `Changed ${changed.join(", ")}`,
  });

  let updated;
  try {
    updated = await IeLineTemplate.findOneAndUpdate(
      { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
      { $set, $inc: { revision: 1 }, $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } } },
      { new: true },
    ).lean();
  } catch (err) {
    if (isDuplicateKey(err)) throw duplicateName($set.name || current.name);
    throw err;
  }

  if (!updated) {
    const now = await IeLineTemplate.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw templateNotFound();
    if (now.status !== STATUS.ACTIVE) {
      throw fail("IE_LINE_TEMPLATE_RETIRED", "This template was retired while you were editing it.",
        { templateId: String(now._id), allowedAction: "RESTORE" });
    }
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, templateId: String(now._id) });
  }
  return { template: publishTemplate(updated, { withHistory: true }), updated: true, events: [publishEvent(audit)] };
}

/* ═══ RETIRE AND RESTORE ═══════════════════════════════════════════════════
 * Reversible, and neither removes a record. A retired template stops being
 * offered and stops holding its name against the unique index; restoring it can
 * therefore be refused when the name has been taken since, which is the same
 * answer — and the same resolution — Chunk 2A gives for an operation code.
 */

async function retireTemplate(ctx, { templateId, body = {}, actor = null } = {}) {
  const current = await loadOwnedTemplate(ctx, templateId);
  assertShape(body, LIFECYCLE_FIELDS, "a retirement");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.RETIRED) {
    throw fail("IE_LINE_TEMPLATE_ALREADY_RETIRED", "This template is already retired.",
      { templateId: String(current._id), allowedAction: "RESTORE" });
  }
  if (current.revision !== expected) {
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, templateId: String(current._id) });
  }

  const nextRevision = expected + 1;
  const audit = event("LINE_TEMPLATE_RETIRED", {
    actor, templateRevision: nextRevision, changed: ["status"],
    summary: "Retired — no longer offered, and its name is released",
  });
  const now = new Date();
  const updated = await IeLineTemplate.findOneAndUpdate(
    { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.ACTIVE },
    {
      $set: {
        status: STATUS.RETIRED, statusChangedAt: now, statusChangedByName: actorName(actor),
        updatedBy: actorId(actor), updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();
  if (!updated) {
    const fresh = await IeLineTemplate.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!fresh) throw templateNotFound();
    if (fresh.status === STATUS.RETIRED) {
      throw fail("IE_LINE_TEMPLATE_ALREADY_RETIRED", "This template is already retired.",
        { templateId: String(fresh._id), allowedAction: "RESTORE" });
    }
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were reading it. Re-read it and decide again.",
      { expected, actual: fresh.revision, templateId: String(fresh._id) });
  }
  return { template: publishTemplate(updated, { withHistory: true }), retired: true };
}

async function restoreTemplate(ctx, { templateId, body = {}, actor = null } = {}) {
  const current = await loadOwnedTemplate(ctx, templateId);
  assertShape(body, LIFECYCLE_FIELDS, "a restoration");
  const expected = readExpectedRevision(body.expectedRevision);

  if (current.status === STATUS.ACTIVE) {
    throw fail("IE_LINE_TEMPLATE_ALREADY_ACTIVE", "This template is already active.",
      { templateId: String(current._id) });
  }
  if (current.revision !== expected) {
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were reading it. Re-read it and decide again.",
      { expected, actual: current.revision, templateId: String(current._id) });
  }

  const nextRevision = expected + 1;
  const audit = event("LINE_TEMPLATE_RESTORED", {
    actor, templateRevision: nextRevision, changed: ["status"],
    summary: "Restored — offered again",
  });
  const now = new Date();
  let updated;
  try {
    updated = await IeLineTemplate.findOneAndUpdate(
      { _id: current._id, companyId: ctx.companyId, revision: expected, status: STATUS.RETIRED },
      {
        $set: {
          status: STATUS.ACTIVE, statusChangedAt: now, statusChangedByName: actorName(actor),
          updatedBy: actorId(actor), updatedByName: actorName(actor),
        },
        $inc: { revision: 1 },
        $push: { history: { $each: [audit], $slice: -LIMITS.HISTORY } },
      },
      { new: true },
    ).lean();
  } catch (err) {
    /* Retiring RELEASED the name, so another template may hold it by now.
       Nothing is renamed automatically: the resolution is a deliberate act. */
    if (isDuplicateKey(err)) {
      throw fail("IE_LINE_TEMPLATE_NAME_TAKEN",
        `Another active line template in this company is already called ${current.name}. `
        + "Rename or retire that one, then restore this.",
        { field: "name", name: current.name, resolution: "RETIRE_CONFLICTING_THEN_RESTORE" });
    }
    throw err;
  }
  if (!updated) {
    const fresh = await IeLineTemplate.findOne({ _id: current._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!fresh) throw templateNotFound();
    if (fresh.status === STATUS.ACTIVE) {
      throw fail("IE_LINE_TEMPLATE_ALREADY_ACTIVE", "This template is already active.",
        { templateId: String(fresh._id) });
    }
    throw fail("IE_LINE_TEMPLATE_REVISION_CONFLICT",
      "Somebody changed this template while you were reading it. Re-read it and decide again.",
      { expected, actual: fresh.revision, templateId: String(fresh._id) });
  }
  return { template: publishTemplate(updated, { withHistory: true }), restored: true };
}

/**
 * Two arrangements, compared as they are persisted, WITHOUT their identities.
 *
 * Everything a person decided — the order, the labels, the notes, the planned
 * machine types and which row sits where — and nothing the server minted.
 */
function sameArrangement(before = [], after = []) {
  if (before.length !== after.length) return false;
  for (let i = 0; i < after.length; i += 1) {
    const a = after[i];
    const b = before[i];
    if ((a.label ?? "") !== (b.label ?? "")) return false;
    if ((a.note ?? "") !== (b.note ?? "")) return false;
    if (a.sequence !== b.sequence) return false;
    const ap = a.plannedMachineTypes || [];
    const bp = b.plannedMachineTypes || [];
    if (ap.length !== bp.length) return false;
    for (let k = 0; k < ap.length; k += 1) {
      if (upperType(ap[k].machineType) !== upperType(bp[k].machineType)) return false;
      if ((ap[k].quantity ?? null) !== (bp[k].quantity ?? null)) return false;
    }
    const aa = a.assignments || [];
    const bb = b.assignments || [];
    if (aa.length !== bb.length) return false;
    for (let j = 0; j < aa.length; j += 1) {
      if (aa[j].rowId !== bb[j].rowId) return false;
      if (aa[j].sequence !== bb[j].sequence) return false;
    }
  }
  return true;
}

/* ═══ APPLY ════════════════════════════════════════════════════════════════
 *
 * ONE atomic layout update. Every check happens before anything is written, and
 * a refusal at any of them leaves the layout exactly as it was — no revision,
 * no timestamp, no history entry.
 *
 * ── WHAT CROSSES, AND WHAT DOES NOT ─────────────────────────────────────────
 * Crossing: the station order, each label and note, each planned machine type
 * and count, and which operation occurrence sits where.
 *
 * NOT crossing, and there is no code path that could carry them: the template's
 * id, its revision, its history, its ownership, its station ids, its slot ids,
 * and anything at all about the layout it was captured from. Fresh layout
 * station ids are minted by the layout's own shaper, and every assignment is
 * rebuilt from the TARGET layout's frozen source rows — so the minutes, the
 * operation code and the operation name all come from the target, not the
 * template.
 */
async function applyTemplate(ctx, { layoutId, body = {}, actor = null } = {}) {
  const layout = await loadOwnedLayout(ctx, layoutId);
  assertShape(body, APPLY_FIELDS, "applying a template");
  const expected = readExpectedRevision(body.expectedRevision);

  /* ── 1. THE TEMPLATE MUST BE THIS COMPANY'S, AND OFFERED ───────────────── */
  const template = await loadOwnedTemplate(ctx, body.templateId);
  if (template.status !== STATUS.ACTIVE) {
    throw fail("IE_LINE_TEMPLATE_RETIRED",
      "This template is retired and is no longer offered. Restore it before applying it.",
      { templateId: String(template._id), allowedAction: "RESTORE" });
  }

  /* ── 2. THE LAYOUT MUST BE EDITABLE, AND ITS SOURCE CURRENT ────────────
     Checked BEFORE the revision, exactly as an ordinary edit does: a stale
     layout cannot accept any edit, so "your revision is stale" would send
     somebody to re-read and try again for ever. */
  const file = await IeStyleFile.findOne({ _id: layout.ieStyleFileId, companyId: ctx.companyId })
    .select("_id revision bulletin.rows").lean();
  if (!file) throw fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");
  /* ── THE LAYOUT'S OWN SOURCE (Chunk 7C2) ────────────────────────────────
     A version-backed layout is a balance of its immutable approved bulletin
     version; only a pre-7C1 layout is judged against the file's mutable
     bulletin. Asking the file for both would call a perfectly current layout
     stale the moment somebody typed in the successor draft. */
  const source = await layouts.sourceForLayout(ctx, layout, file);
  /* ── AN APPROVED LAYOUT TAKES NO PATTERN (Chunk 7C2) ────────────────────
     Asked before the source and before the revision, for the same reason the
     edit path asks first: both of those answers tell somebody to re-read and
     try again, and no amount of re-reading makes an approved layout writable. */
  if (layout.status === "APPROVED") {
    throw fail("IE_LAYOUT_IMMUTABLE",
      "This line layout was approved and is permanent evidence of the plan somebody accepted. "
      + "A template cannot be applied to it — open a new draft layout and apply it there.",
      {
        layoutId: String(layout._id),
        status: layout.status,
        approvedRevision: layout.approvedRevision ?? null,
        resolution: "OPEN_NEW_DRAFT_LAYOUT",
      });
  }

  const { state, reasons } = layouts.sourceStateOf(layout, source);
  if (state !== layouts.SOURCE_STATE.CURRENT) {
    throw fail("IE_LINE_LAYOUT_SOURCE_CHANGED",
      "This layout is a balance of a source that has since changed. It stays as evidence and cannot "
      + "be edited — open a layout for the current source and apply the template there.",
      {
        layoutId: String(layout._id), reasons,
        boundBulletinRevision: layout.bulletinRevision,
        currentBulletinRevision: file.revision,
        resolution: "OPEN_NEW_LAYOUT",
      });
  }
  if (layout.revision !== expected) {
    throw fail("IE_LINE_LAYOUT_REVISION_CONFLICT",
      "Somebody changed this layout while you were reading it. Re-read it and decide again.",
      { expected, actual: layout.revision, layoutId: String(layout._id) });
  }

  /* ── 3. RESOLVE EVERY SLOT AGAINST THE TARGET'S OWN FROZEN SOURCE ───────
     By stable operation id and occurrence, in the target's source order. Never
     by operation code — see the header. */
  const { byOperation, counts } = occurrenceIndexOf(layout.sourceRows || []);
  const missing = [];
  const resolved = template.stations.map((s) => ({
    label: s.label || "",
    note: s.note || "",
    plannedMachineTypes: (s.plannedMachineTypes || []).map((m) => ({
      machineType: m.machineType, quantity: m.quantity,
    })),
    assignments: s.slots.map((slot) => {
      const key = String(slot.ieOperationId);
      const row = byOperation.get(key)?.get(slot.occurrence) || null;
      if (!row) {
        missing.push({
          templateStationId: s.templateStationId,
          templateStationLabel: s.label || "",
          slotId: slot.slotId,
          ieOperationId: key,
          occurrence: slot.occurrence,
          /* Read-only, for a person to recognise it by. */
          operationCode: slot.operationCode || "",
          operationName: slot.operationName || "",
          /* Why: the target has none of this operation at all, or fewer of it
             than the pattern expects. Two different fixes. */
          reason: (counts.get(key) || 0) === 0
            ? "OPERATION_NOT_IN_SOURCE"
            : "FEWER_OCCURRENCES_IN_SOURCE",
          availableOccurrences: counts.get(key) || 0,
        });
        return null;
      }
      return { rowId: row.rowId };
    }).filter(Boolean),
  }));

  /* ── 4. ALL OR NOTHING ─────────────────────────────────────────────────
     A pattern that half-fits is not applied at all. Dropping the slots that do
     not resolve would produce a line nobody designed and would say nothing
     about what was lost. */
  if (missing.length) {
    throw fail("IE_LINE_TEMPLATE_SLOT_NOT_IN_SOURCE",
      `${missing.length} operation${missing.length === 1 ? "" : "s"} this template places `
      + `${missing.length === 1 ? "is" : "are"} not on this layout's bulletin. Nothing was applied.`,
      {
        layoutId: String(layout._id),
        templateId: String(template._id),
        templateRevision: template.revision,
        missingSlots: missing,
      });
  }

  /* ── 5. THROUGH THE LAYOUT'S OWN SHAPER ────────────────────────────────
     No `stationId` is supplied, so every station is minted fresh. The shaper
     is the same one an ordinary edit uses, so a template cannot reach a
     validation path an edit could not — including its refusal of a row that is
     not in the source, and of the same row placed twice. */
  const stations = layouts.shapeStations(resolved, {
    existingIds: new Set((layout.stations || []).map((s) => s.stationId)),
    existingById: new Map((layout.stations || []).map((s) => [s.stationId, s])),
    sourceByRow: new Map((layout.sourceRows || []).map((r) => [r.rowId, r])),
  });

  /* ── 6. AN IDENTICAL RESULT IS AN HONEST NO-OP ─────────────────────────
     Compared on the ARRANGEMENT, deliberately not on identity. An ordinary
     edit compares station ids too, and rightly so — a client sends them back,
     and a changed one is a real change. Applying mints fresh ones every time
     by design, so comparing them would make every second application look like
     a change and move the revision for nothing.

     And because a no-op writes nothing, the station ids already on the layout
     are the ones that stay: nothing is re-minted behind somebody's back. */
  const before = (layout.stations || []).map((s) => ({
    ...s, assignments: (s.assignments || []).map((a) => ({ ...a })),
  }));
  if (sameArrangement(before, stations)) {
    return {
      layout: layouts.publishLayout(layout, { current: source, withHistory: true }),
      updated: false,
      events: [],
      applied: { templateId: String(template._id), templateRevision: template.revision, name: template.name },
    };
  }

  /* ── 7. ONE REVISION, ONE TRAIL ENTRY, NAMING THE TEMPLATE ─────────────── */
  const nextRevision = expected + 1;
  const audit = {
    eventId: `lle_${crypto.randomBytes(9).toString("hex")}`,
    type: "LINE_LAYOUT_TEMPLATE_APPLIED",
    at: new Date(),
    actorId: actorId(actor),
    actorName: actorName(actor),
    layoutRevision: nextRevision,
    changed: ["stations", "template"],
    /* The stable identity, structured. The summary keeps the name because that
       is what a person reads, and the id is what a reader RESOLVES BY — a
       retired template releases its active name, so two templates can share
       one and the name alone cannot say which was applied. */
    templateId: template._id,
    templateRevision: template.revision,
    summary: `Applied line template "${template.name}" revision ${template.revision} — `
      + `${stations.length} stations, ${stations.reduce((n, s) => n + s.assignments.length, 0)} operations placed`,
  };

  const updated = await IeLineLayout.findOneAndUpdate(
    { _id: layout._id, companyId: ctx.companyId, revision: expected, status: "DRAFT" },
    {
      $set: { stations, updatedBy: actorId(actor), updatedByName: actorName(actor) },
      $inc: { revision: 1 },
      $push: { history: { $each: [audit], $slice: -200 } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeLineLayout.findOne({ _id: layout._id, companyId: ctx.companyId })
      .select("_id revision status").lean();
    if (!now) throw fail("IE_LINE_LAYOUT_NOT_FOUND", "That line layout was not found.");
    throw fail("IE_LINE_LAYOUT_REVISION_CONFLICT",
      "Somebody changed this layout while you were reading it. Re-read it and decide again.",
      { expected, actual: now.revision, layoutId: String(now._id) });
  }

  /* The complete published layout — balance, compatibility and readiness all
     recomputed by the layout's own publisher, never carried from the template.
     Rows the template does not place stay unassigned and appear as the coverage
     gap they are. */
  return {
    layout: layouts.publishLayout(updated, { current: source, withHistory: true }),
    updated: true,
    /* Published by the layout's OWN event publisher, so the request's `events`
       and the layout history it returns carry the same fields — including the
       structured template identity. */
    events: [layouts.publishEvent(audit)],
    applied: { templateId: String(template._id), templateRevision: template.revision, name: template.name },
  };
}

module.exports = {
  STATUS, CREATE_FIELDS, PATCH_FIELDS, STATION_FIELDS, SLOT_FIELDS,
  LIFECYCLE_FIELDS, APPLY_FIELDS, REFUSED_FIELDS,
  nameKeyOf, occurrenceIndexOf, publishTemplate, shapeStations, changedCategories, sameArrangement,
  createTemplate, readTemplate, listTemplates, updateTemplate,
  retireTemplate, restoreTemplate, applyTemplate,
};
