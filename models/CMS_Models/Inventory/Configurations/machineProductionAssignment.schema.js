// models/CMS_Models/Inventory/Configurations/machineProductionAssignment.schema.js
//
// SERVER-OWNED PRODUCTION STATE ON A MACHINE — embedded, no new collection.
//
//   productionOwnership           which company owns this machine (claimed by
//                                 a platform admin; absent = unclaimed)
//   productionAssignment          the ONE current assignment: this machine does
//                                 this frozen operation of this WorkOrder's
//                                 Production execution basis
//   productionAssignmentRevision  bumped by every assign/reassign/unassign
//   productionAssignmentHistory[] every transition, with the complete prior
//                                 assignment, who, when and why — bounded, and
//                                 the bound REFUSES rather than truncates
//   productionDeviceSync          what the scanner is known to be running, and
//                                 the safe toggle instruction to reach the
//                                 assignment — device EVIDENCE, never authority
//
// ── WHY THE MACHINE, AND WHY NOT FIREBASE ───────────────────────────────────
// Firmware 5.6.x reads no Firebase: a scanner's operations change only when an
// `ops:` / `opsgp:` barcode is scanned at the machine, and each scan TOGGLES.
// So the database assignment is the authority, and the device is brought to it
// by a barcode computed from the device's own freshly observed state (see
// services/production/machineAssignment/deviceSync.rules.js).
//
// ── WRITE GUARD ─────────────────────────────────────────────────────────────
// Every write that names one of these paths is refused unless the machine
// assignment service marked the query with MACHINE_ASSIGNMENT_WRITE_OPTION —
// the same device WorkOrder uses for execution bases. Every path is
// `select: false`, so the Machine register's reads never carry them and its
// forms can never echo them back.
"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema.Types;

const MACHINE_ASSIGNMENT_WRITE_OPTION = "machineProductionAssignmentWrite";
const GUARDED_PATHS = Object.freeze([
  "productionOwnership",
  "productionAssignment",
  "productionAssignmentRevision",
  "productionAssignmentHistory",
  "productionDeviceSync",
]);

const ASSIGNMENT_LIMITS = Object.freeze({
  HISTORY: 50, // transitions kept; reaching it refuses (MACHINE_ASSIGNMENT_HISTORY_FULL)
  DEVICE_CODES: 8, // the scanner's own MAX_ACTIVE_OPS
  REASON_MIN: 10,
  REASON_MAX: 1000,
});

const CODE_PROVENANCE = Object.freeze({ CANONICAL: "canonical", LEGACY: "explicit_legacy_override" });

const SYNC_STATUS = Object.freeze({
  PENDING_DEVICE_STATE: "pending_device_state",
  READY_TO_SYNC: "ready_to_sync",
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  APPLIED: "applied",
  DRIFT: "drift",
  FAILED: "failed",
});

const actorSchema = new mongoose.Schema(
  { id: { type: ObjectId, default: null }, name: { type: String, trim: true, default: "" } },
  { _id: false },
);

const ownershipSchema = new mongoose.Schema(
  {
    companyId: { type: ObjectId, required: true },
    claimedAt: { type: Date, required: true },
    claimedBy: { type: actorSchema, required: true },
    reason: { type: String, required: true, trim: true },
  },
  { _id: false },
);

const deviceCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    provenance: { type: String, enum: Object.values(CODE_PROVENANCE), required: true },
  },
  { _id: false },
);

/** The current assignment: every identity copied from the frozen basis at assignment. */
const assignmentSchema = new mongoose.Schema(
  {
    assignmentId: { type: ObjectId, required: true },
    assignmentRef: { type: String, required: true, trim: true },
    revision: { type: Number, required: true, min: 1 },
    state: { type: String, enum: ["ACTIVE"], required: true },
    companyId: { type: ObjectId, required: true },
    machineId: { type: ObjectId, required: true },
    workOrderId: { type: ObjectId, required: true },
    workOrderNumber: { type: String, trim: true, default: "" },
    executionBasisId: { type: ObjectId, required: true },
    executionBasisVersionNo: { type: Number, required: true, min: 1 },
    capacityLineId: { type: ObjectId, required: true },
    capacityLineRef: { type: String, required: true, trim: true },
    operationRowId: { type: String, required: true, trim: true },
    operationSequence: { type: Number, required: true, min: 1 },
    ieOperationId: { type: ObjectId, required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    canonicalOperationCode: { type: String, required: true, trim: true },
    operationName: { type: String, trim: true, default: "" },
    /* What the scanner must carry. Default [canonical]; a legacy code only
       through the explicit, reasoned override — never the IE identity. */
    deviceOperationCodes: { type: [deviceCodeSchema], required: true },
    legacyOverrideReason: { type: String, trim: true, default: "" },
    effectiveFrom: { type: Date, required: true },
    actor: { type: actorSchema, required: true },
    reason: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/** One transition. `previous` is the complete assignment it closed, if any. */
const transitionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ["assign", "reassign", "unassign"], required: true },
    fromRevision: { type: Number, required: true, min: 0 },
    toRevision: { type: Number, required: true, min: 1 },
    at: { type: Date, required: true },
    actor: { type: actorSchema, required: true },
    reason: { type: String, trim: true, default: "" },
    requestFingerprint: { type: String, required: true },
    previous: { type: assignmentSchema, default: null },
    nextAssignmentId: { type: ObjectId, default: null },
  },
  { _id: false },
);

const observedSchema = new mongoose.Schema(
  {
    deviceId: { type: String, default: "" },
    heartbeatAt: { type: Date, default: null },
    evidenceRevision: { type: Number, default: null },
    codes: { type: [String], default: () => [] },
  },
  { _id: false },
);

const instructionSchema = new mongoose.Schema(
  {
    instructionId: { type: String, required: true },
    forRevision: { type: Number, required: true, min: 1 },
    deviceId: { type: String, required: true },
    observedHeartbeatAt: { type: Date, required: true },
    observedEvidenceRevision: { type: Number, required: true, min: 0 },
    toggles: { type: [new mongoose.Schema({ code: String, action: { type: String, enum: ["remove", "add"] } }, { _id: false })], default: () => [] },
    payloads: { type: [String], default: () => [] },
    issuedAt: { type: Date, required: true },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: actorSchema, default: undefined },
  },
  { _id: false },
);

/** Device synchronisation, keyed to ONE assignment revision. */
const deviceSyncSchema = new mongoose.Schema(
  {
    forRevision: { type: Number, required: true, min: 1 },
    desiredCodes: { type: [String], default: () => [] },
    productionAssigned: { type: Boolean, required: true },
    /* When the transition was PREPARED, inside its transaction — audit only.
       It precedes the commit, so it proves nothing about device evidence. */
    transitionAt: { type: Date, required: true },
    /* THE CAUSAL EVIDENCE BASELINE — captured AFTER the commit is known:
       every heartbeat document then associated with this machine, and its
       server-owned `evidenceRevision`. Only a heartbeat whose revision is
       strictly greater than its device's baseline (0 for a device not in it)
       was ingested after the capture, and so after the commit. Written once,
       by a revision-fenced update, never reset. Absent → nothing qualifies. */
    evidenceBaseline: {
      type: new mongoose.Schema({
        devices: { type: [new mongoose.Schema({ deviceId: String, evidenceRevision: Number }, { _id: false })], default: () => [] },
      }, { _id: false }),
      default: null,
    },
    /* When the baseline was captured (database clock). Audit and display
       only — a timestamp proves nothing about post-commit ordering. */
    confirmationBoundaryAt: { type: Date, default: null },
    status: { type: String, enum: Object.values(SYNC_STATUS), required: true },
    reasons: { type: [String], default: () => [] },
    observed: { type: observedSchema, default: undefined },
    instruction: { type: instructionSchema, default: undefined },
    appliedRevision: { type: Number, default: null },
    appliedAt: { type: Date, default: null },
    lastEvaluatedAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
  },
  { _id: false },
);

/** Adds the guarded paths to the Machine schema. */
function addProductionAssignmentPaths(schema) {
  schema.add({
    productionOwnership: { type: ownershipSchema, default: undefined, select: false },
    productionAssignment: { type: assignmentSchema, default: undefined, select: false },
    productionAssignmentRevision: { type: Number, default: undefined, select: false },
    productionAssignmentHistory: { type: [transitionSchema], default: undefined, select: false },
    productionDeviceSync: { type: deviceSyncSchema, default: undefined, select: false },
  });
}

const namesGuarded = (key) => GUARDED_PATHS.includes(String(key).split(".")[0]);

function updateTouchesGuarded(update) {
  if (!update) return false;
  if (Array.isArray(update)) {
    return update.some((stage) => Object.entries(stage || {}).some(([op, body]) => {
      if (["$replaceRoot", "$replaceWith", "$project"].includes(op)) return true;
      if (op === "$unset") return [].concat(body).some(namesGuarded);
      return Object.keys(body || {}).some(namesGuarded);
    }));
  }
  return Object.entries(update).some(([key, value]) => {
    if (!key.startsWith("$")) return namesGuarded(key);
    if (value && typeof value === "object") return Object.keys(value).some(namesGuarded);
    return false;
  });
}

const REFUSAL = "Machine ownership and production assignment can only be written by the Production machine-assignment service.";

function installMachineAssignmentGuard(schema) {
  schema.pre(["updateOne", "updateMany", "findOneAndUpdate"], function guardUpdate(next) {
    if (this.getOptions()?.[MACHINE_ASSIGNMENT_WRITE_OPTION] === true) return next();
    if (updateTouchesGuarded(this.getUpdate())) return next(new Error(REFUSAL));
    return next();
  });
  schema.pre(["replaceOne", "findOneAndReplace"], function guardReplace(next) {
    if (this.getOptions()?.[MACHINE_ASSIGNMENT_WRITE_OPTION] === true) return next();
    return next(new Error(`Machine replacement is refused: it would rewrite production state. ${REFUSAL}`));
  });
  schema.pre("insertMany", function guardInsertMany(next, docs) {
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.some((d) => GUARDED_PATHS.some((p) => d?.[p] != null))) return next(new Error(REFUSAL));
    return next();
  });
  schema.pre("validate", function guardDocument(next) {
    const touched = this.isNew
      ? GUARDED_PATHS.some((p) => this.get(p) != null)
      : GUARDED_PATHS.some((p) => this.isModified(p));
    if (touched) this.invalidate("productionAssignment", REFUSAL);
    next();
  });
}

module.exports = {
  MACHINE_ASSIGNMENT_WRITE_OPTION,
  GUARDED_PATHS,
  ASSIGNMENT_LIMITS,
  CODE_PROVENANCE,
  SYNC_STATUS,
  addProductionAssignmentPaths,
  installMachineAssignmentGuard,
  updateTouchesGuarded,
};
