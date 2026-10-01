// models/CMS_Models/Manufacturing/WorkOrder/productionExecutionBasis.schema.js
//
// THE PRODUCTION EXECUTION BASIS — what Production accepted for executing ONE
// existing WorkOrder: the frozen IE route, the PPC plan it was published
// under, the PPC capacity booking and planning line behind it, and the
// quantity. Embedded in the WorkOrder as `productionExecutionBases[]`.
//
// ── WHY EMBEDDED, NOT A COLLECTION ──────────────────────────────────────────
// The cluster is at its 500-collection cap; the owner decided (28 Sep 2026)
// that no collection is created, renamed or repurposed for this. A basis
// belongs to exactly one WorkOrder, is read with it, and its receipt must be
// atomic with the WorkOrder's own state — which a single-document conditional
// update gives for free.
//
// ── WHY A PPC PUBLICATION IS NOT ENOUGH ─────────────────────────────────────
// `PpcStagePublication` is PPC's frozen target to a department, "not a
// Production release" in its own words. It is planning input. It becomes
// executable only when Production itself receives it through the dedicated
// command (services/production/executionBasis/), which proves every reference
// server-side and COPIES the frozen values here. Nothing below is a live
// pointer to be re-resolved later: a later edit or deletion of the WorkOrder's
// editable route, the PPC plan, the booking, the line or the IE library cannot
// change what Production accepted.
//
// ── SCOPE: A PLANNING LINE, NOT A FACTORY ───────────────────────────────────
// There is no Establishment/site master and no Production physical-line
// register (docs/decisions/hr-organisation-scope.md §3,
// store-purchase-tenancy-permissions.md "Sites"). The pilot scope is
// `companyId + PpcCapacityLine._id`: a company-owned planning line a booking
// froze by revision. `factoryRefDisplay` is the line's free-text factory label,
// copied for display ONLY — never a join key, a scope or a site identity.
//
// ── IMMUTABILITY ────────────────────────────────────────────────────────────
// Every field is frozen at receipt EXCEPT the lifecycle block (`state`,
// `effectiveUntil`, `supersededBy*`, `history`), and even that moves only
// through the service's own guarded update. `guardWorkOrderUpdate` below is
// installed on the WorkOrder schema and refuses every write that touches this
// path unless the dedicated service marked the query with
// EXECUTION_BASIS_WRITE_OPTION.
"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema.Types;

const BASIS_STATE = Object.freeze({ ACTIVE: "ACTIVE", SUPERSEDED: "SUPERSEDED" });
const BASIS_STATES = Object.freeze(Object.values(BASIS_STATE));

const BASIS_LIMITS = Object.freeze({
  /* Versions kept per WorkOrder. Reaching it REFUSES a successor
     (EXECUTION_BASIS_HISTORY_FULL); history is never truncated. With the IE
     bulletin's own 400-row cap this bounds the path at roughly
     20 × ~160 KB ≈ 3.2 MB of a 16 MB document — see the task report. */
  VERSIONS: 20,
  HISTORY: 20,
  REASON_MIN: 10,
  REASON_MAX: 2000,
});

/* The query option only the execution-basis service sets. Code, never a
   request body, can pass a query option. */
const EXECUTION_BASIS_WRITE_OPTION = "productionExecutionBasisWrite";

/* ── THE RECEIPT FENCE ─────────────────────────────────────────────────────
   A coordination counter, not business state. The receipt transaction `$inc`s
   it on the PpcStagePublication, PpcCapacityBooking, PpcCapacityLine and
   IeRelease it copied — each with a predicate re-proving the exact eligible
   state it read — so any concurrent change to one of those four documents
   write-conflicts with the receipt instead of slipping past it (no write
   skew). It is written ONLY through the raw collection by the execution-basis
   service, never declared in those schemas, never read by any business rule,
   and incrementing it changes nothing any PPC/IE rule looks at. */
const RECEIPT_FENCE_FIELD = "productionReceiptFence";
const PATH = "productionExecutionBases";

const actorSchema = new mongoose.Schema(
  { id: { type: ObjectId, default: null }, name: { type: String, trim: true, default: "" } },
  { _id: false },
);

/** One frozen route step, copied from IeRelease.source.rows at receipt. */
const frozenStepSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },
    ieOperationId: { type: ObjectId, required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, required: true, trim: true },
    operationName: { type: String, trim: true, default: "" },
    machineType: { type: String, trim: true, default: "" },
    standardTimeMinutes: { type: Number, required: true, min: 0 },
    standardTimeSource: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["RECEIVED", "SUPERSEDED"], required: true },
    at: { type: Date, required: true },
    actor: { type: actorSchema, default: () => ({}) },
    note: { type: String, trim: true, default: "", maxlength: BASIS_LIMITS.REASON_MAX },
  },
  { _id: false },
);

const productionExecutionBasisSchema = new mongoose.Schema(
  {
    /* ── IDENTITY ──────────────────────────────────────────────────────── */
    basisId: { type: ObjectId, required: true },
    basisRef: { type: String, required: true, trim: true },
    versionNo: { type: Number, required: true, min: 1 },
    /* `${companyId}:${workOrderId}:${publicationId}` — see receiptKeyOf. */
    receiptKey: { type: String, required: true, trim: true },

    /* ── WHOSE, AND WHICH WORK ─────────────────────────────────────────── */
    companyId: { type: ObjectId, required: true },
    workOrderId: { type: ObjectId, required: true },
    workOrderNumber: { type: String, trim: true, default: "" },
    customerRequestId: { type: ObjectId, default: null },
    orderLineRef: { type: String, required: true, trim: true },
    executionQuantity: { type: Number, required: true, min: 1 },
    quantityRule: { type: String, required: true, trim: true },

    /* ── THE PPC PUBLICATION RECEIVED ──────────────────────────────────── */
    publication: {
      type: new mongoose.Schema({
        publicationId: { type: ObjectId, required: true },
        publicationVersionNo: { type: Number, required: true, min: 1 },
        publishedAt: { type: Date, required: true },
        process: { type: String, required: true, trim: true },
        stageId: { type: String, required: true, trim: true },
        stageLabel: { type: String, trim: true, default: "" },
        acceptedAt: { type: Date, default: null },
        confirmedQuantity: { type: Number, required: true, min: 0 },
        publishedWorkOrderQuantity: { type: Number, required: true, min: 1 },
      }, { _id: false }),
      required: true,
    },
    planning: {
      type: new mongoose.Schema({
        planningFileId: { type: ObjectId, required: true },
        planningFileRef: { type: String, trim: true, default: "" },
        planningGeneration: { type: Number, default: null },
        scheduleVersionNo: { type: Number, required: true, min: 1 },
      }, { _id: false }),
      required: true,
    },
    capacityBooking: {
      type: new mongoose.Schema({
        bookingId: { type: ObjectId, required: true },
        bookingRef: { type: String, required: true, trim: true },
        generation: { type: Number, required: true, min: 1 },
        calendarVersionNo: { type: Number, default: null },
        windowStart: { type: String, required: true },
        windowEnd: { type: String, required: true },
      }, { _id: false }),
      required: true,
    },
    /* A PPC PLANNING line — never described as a physical Production line. */
    planningLine: {
      type: new mongoose.Schema({
        capacityLineId: { type: ObjectId, required: true },
        lineRef: { type: String, required: true, trim: true },
        lineRevision: { type: Number, required: true, min: 1 },
        lineName: { type: String, trim: true, default: "" },
        factoryRefDisplay: { type: String, trim: true, default: "" },
        factoryRefAuthoritative: { type: Boolean, default: false },
      }, { _id: false }),
      required: true,
    },
    ieRelease: {
      type: new mongoose.Schema({
        ieReleaseId: { type: ObjectId, required: true },
        releaseRef: { type: String, required: true, trim: true },
        versionNo: { type: Number, required: true, min: 1 },
        aggregateFingerprint: { type: String, trim: true, default: "" },
        sourceFingerprint: { type: String, trim: true, default: "" },
        bulletinVersionId: { type: ObjectId, default: null },
        bulletinVersionNo: { type: Number, default: null },
      }, { _id: false }),
      required: true,
    },
    route: {
      type: [frozenStepSchema],
      validate: [(v) => Array.isArray(v) && v.length > 0, "A basis needs its frozen route."],
    },
    plannedWindow: {
      type: new mongoose.Schema({
        start: { type: String, required: true },
        end: { type: String, required: true },
      }, { _id: false }),
      required: true,
    },

    /* ── RECEIPT ───────────────────────────────────────────────────────── */
    receivedAt: { type: Date, required: true },
    receivedBy: { type: actorSchema, default: () => ({}) },
    supersedesBasisId: { type: ObjectId, default: null },
    /* The command that created this version, kept so a replay can be proved
       equivalent: "receive", or "supersede" with its normalised reason. */
    receiptCommand: {
      type: new mongoose.Schema({
        kind: { type: String, enum: ["receive", "supersede"], required: true },
        supersedesBasisId: { type: ObjectId, default: null },
        reasonNormalized: { type: String, default: "" },
      }, { _id: false }),
      default: undefined,
    },

    /* ── LIFECYCLE (the only part that moves, through the service) ─────── */
    state: { type: String, enum: BASIS_STATES, required: true },
    effectiveFrom: { type: Date, required: true },
    effectiveUntil: { type: Date, default: null },
    supersededByBasisId: { type: ObjectId, default: null },
    supersededAt: { type: Date, default: null },
    supersededBy: { type: actorSchema, default: undefined },
    supersedeReason: { type: String, trim: true, default: "" },
    history: {
      type: [historySchema],
      default: () => [],
      validate: [(v) => !Array.isArray(v) || v.length <= BASIS_LIMITS.HISTORY, "History is bounded."],
    },
  },
  { _id: false },
);

/* ═══ THE WRITE GUARD ════════════════════════════════════════════════════
 *
 * Installed on the WorkOrder schema. The rule is about the QUERY, not a list
 * of routes: any update, replace or pipeline that names `productionExecutionBases`
 * (whole path, dotted sub-path or positional), or that could rewrite the whole
 * document, is refused unless the execution-basis service marked it.
 */
const namesPath = (key) => {
  const head = String(key).split(".")[0];
  return head === PATH;
};

function updateTouchesBases(update) {
  if (!update) return false;
  if (Array.isArray(update)) {
    // Aggregation-pipeline update: any stage that could rewrite the root, or
    // names the path, counts.
    return update.some((stage) => Object.entries(stage || {}).some(([op, body]) => {
      if (["$replaceRoot", "$replaceWith", "$project"].includes(op)) return true;
      if (op === "$unset") return [].concat(body).some(namesPath);
      return Object.keys(body || {}).some(namesPath);
    }));
  }
  return Object.entries(update).some(([key, value]) => {
    if (!key.startsWith("$")) return namesPath(key);
    if (value && typeof value === "object") return Object.keys(value).some(namesPath);
    return false;
  });
}

const REFUSAL = "productionExecutionBases can only be written by the Production execution-basis service.";

function installExecutionBasisGuard(schema) {
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function guardUpdate(next) {
    if (this.getOptions()?.[EXECUTION_BASIS_WRITE_OPTION] === true) return next();
    if (updateTouchesBases(this.getUpdate())) return next(new Error(REFUSAL));
    return next();
  });
  // A whole-document replacement would silently drop every basis.
  schema.pre(["replaceOne", "findOneAndReplace"], function guardReplace(next) {
    if (this.getOptions()?.[EXECUTION_BASIS_WRITE_OPTION] === true) return next();
    return next(new Error(`WorkOrder replacement is refused: it would rewrite ${PATH}. ${REFUSAL}`));
  });
  schema.pre("insertMany", function guardInsertMany(next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.some((d) => Array.isArray(d?.[PATH]) ? d[PATH].length > 0 : d?.[PATH] != null)) {
      return next(new Error(REFUSAL));
    }
    return next();
  });
}

/** For the WorkOrder's own `validate` hook: a document save may not carry one. */
function documentWriteRefusal(doc) {
  if (doc.$locals?.[EXECUTION_BASIS_WRITE_OPTION] === true) return null;
  if (doc.isNew) {
    const v = doc.get(PATH);
    return Array.isArray(v) && v.length > 0 ? REFUSAL : null;
  }
  return doc.isModified(PATH) ? REFUSAL : null;
}

module.exports = {
  BASIS_STATE,
  BASIS_STATES,
  BASIS_LIMITS,
  EXECUTION_BASIS_WRITE_OPTION,
  RECEIPT_FENCE_FIELD,
  PATH,
  productionExecutionBasisSchema,
  frozenStepSchema,
  updateTouchesBases,
  installExecutionBasisGuard,
  documentWriteRefusal,
};
