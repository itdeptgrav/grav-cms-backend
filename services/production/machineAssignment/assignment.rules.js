// services/production/machineAssignment/assignment.rules.js
//
// The pure half of server-owned machine assignment:
//
//   Machine → WorkOrder → Production execution basis → frozen operation row
//
// The browser sends selectors only (machine, WorkOrder, basis, row id, the
// expected assignment revision, an optional legacy scanner code with its
// reason, and a reason). Everything else — company, line, operation code and
// name, IE identity — is read from the frozen execution basis and copied.
//
// ── SCANNER CODES ───────────────────────────────────────────────────────────
// Default: the scanner carries the frozen canonical operation code. A legacy
// code (the floor's CT007 / AP001 / KUT004) enters only through an explicit
// override a Production editor types, with a reason; it is recorded beside the
// canonical code as `explicit_legacy_override` and is never the IE identity.
// No code is ever derived from sequence, similarity, name or machine type,
// and there is no scanner-code registry to validate against (the Operation
// registry names ops for a picker; it is not a device-code authority), so the
// override is kept as audited compatibility evidence.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { ASSIGNMENT_LIMITS, CODE_PROVENANCE } = require("../../../models/CMS_Models/Inventory/Configurations/machineProductionAssignment.schema");
const { basisAt } = require("../executionBasis/executionBasis.rules");
const { validDeviceCode, normCode } = require("./deviceSync.rules");

/* The Machine register's own states. Maintenance and repair are not
   production-ready; Idle is simply not working right now. */
const ELIGIBLE_MACHINE_STATUSES = Object.freeze(["Operational", "Idle"]);
const NOT_ASSIGNABLE_WORK_ORDER = Object.freeze(["cancelled", "completed"]);

class MachineAssignmentError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toResponse() {
    return { success: false, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

const fail = (status, code, message, details) => { throw new MachineAssignmentError(status, code, message, details); };
const idOf = (v) => (v == null ? null : String(v));
const isObjectId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const normalizeReason = (r) => String(r ?? "").trim().replace(/\s+/g, " ");

function requireReason(reason, code = "ASSIGNMENT_REASON_REQUIRED") {
  const r = normalizeReason(reason);
  if (r.length < ASSIGNMENT_LIMITS.REASON_MIN || r.length > ASSIGNMENT_LIMITS.REASON_MAX) {
    fail(400, code, `Give a reason of ${ASSIGNMENT_LIMITS.REASON_MIN}–${ASSIGNMENT_LIMITS.REASON_MAX} characters.`);
  }
  return r;
}

/** The machine as the acting company may see it: its own, unclaimed, or nothing. */
function assertOwnedMachine(machine, companyId) {
  if (!machine) fail(404, "MACHINE_NOT_FOUND", "No machine of your company has that id.");
  const owner = idOf(machine.productionOwnership?.companyId);
  if (!owner) fail(409, "MACHINE_UNCLAIMED", "This machine has not been claimed by a company yet; an administrator must claim it first.");
  if (owner !== idOf(companyId)) fail(404, "MACHINE_NOT_FOUND", "No machine of your company has that id.");
}

/** The device codes an assignment carries, and how they were chosen. */
function deviceCodesFor(canonicalCode, { legacyDeviceCode, legacyReason }) {
  const legacy = String(legacyDeviceCode ?? "").trim();
  if (!legacy) {
    if (!validDeviceCode(canonicalCode)) {
      fail(422, "CANONICAL_CODE_NOT_DEVICE_COMPATIBLE",
        "The frozen operation code cannot be carried by a scanner barcode; supply an explicit legacy scanner code with a reason.",
        { canonicalOperationCode: canonicalCode });
    }
    return { codes: [{ code: canonicalCode, provenance: CODE_PROVENANCE.CANONICAL }], legacyOverrideReason: "" };
  }
  if (!validDeviceCode(legacy)) {
    fail(400, "LEGACY_CODE_INVALID", "A scanner code is 1–32 letters, digits, '.', '_', '-' or '/', starting with a letter or digit.");
  }
  const reason = normalizeReason(legacyReason);
  if (reason.length < ASSIGNMENT_LIMITS.REASON_MIN || reason.length > ASSIGNMENT_LIMITS.REASON_MAX) {
    fail(400, "LEGACY_CODE_REASON_REQUIRED", "A legacy scanner code needs a reason of at least 10 characters.");
  }
  if (normCode(legacy) === normCode(canonicalCode)) {
    return { codes: [{ code: canonicalCode, provenance: CODE_PROVENANCE.CANONICAL }], legacyOverrideReason: "" };
  }
  return { codes: [{ code: legacy, provenance: CODE_PROVENANCE.LEGACY }], legacyOverrideReason: reason };
}

/**
 * Prove an assign/reassign against the WorkOrder's frozen basis. Throws the
 * first failed proof; returns the step and codes to copy.
 */
function assertAssignable({ companyId, machine, workOrder, executionBasisId, operationRowId, capacityLineId, legacyDeviceCode, legacyReason, now }) {
  if (!ELIGIBLE_MACHINE_STATUSES.includes(machine.status)) {
    fail(409, "MACHINE_NOT_ELIGIBLE", `A machine that is "${machine.status}" cannot take production work.`);
  }
  if (!workOrder || idOf(workOrder.salesLineLink?.companyId) !== idOf(companyId)) {
    fail(404, "WORK_ORDER_NOT_FOUND", "No work order of your company has that id.");
  }
  if (NOT_ASSIGNABLE_WORK_ORDER.includes(workOrder.status)) {
    fail(409, "WORK_ORDER_NOT_ASSIGNABLE", `A ${workOrder.status} work order cannot take machine assignments.`);
  }
  const bases = workOrder.productionExecutionBases || [];
  const basis = bases.find((b) => idOf(b.basisId) === idOf(executionBasisId) && idOf(b.companyId) === idOf(companyId));
  if (!basis) fail(404, "EXECUTION_BASIS_NOT_FOUND", "That work order has no such Production execution basis.");
  const inForce = basisAt(bases, now);
  if (basis.state !== "ACTIVE" || !inForce || idOf(inForce.basisId) !== idOf(basis.basisId)) {
    fail(409, "EXECUTION_BASIS_NOT_ACTIVE", "That execution basis is not the one in force; assign against the active version.",
      inForce ? { activeBasisId: idOf(inForce.basisId), activeVersionNo: inForce.versionNo } : undefined);
  }
  if (capacityLineId != null && capacityLineId !== "" && idOf(capacityLineId) !== idOf(basis.planningLine?.capacityLineId)) {
    fail(422, "PLANNING_LINE_MISMATCH", "That execution basis was received for a different planning line.");
  }
  const step = (basis.route || []).find((r) => String(r.rowId) === String(operationRowId));
  if (!step) fail(422, "OPERATION_NOT_IN_BASIS", "That operation is not in the execution basis's frozen route.");
  const { codes, legacyOverrideReason } = deviceCodesFor(step.operationCode, { legacyDeviceCode, legacyReason });
  return { basis, step, codes, legacyOverrideReason };
}

/** Everything that makes two requests the same command (actor excluded). */
function fingerprintOf(kind, req) {
  const canonical = {
    kind,
    workOrderId: idOf(req.workOrderId) || null,
    executionBasisId: idOf(req.executionBasisId) || null,
    operationRowId: req.operationRowId != null ? String(req.operationRowId) : null,
    capacityLineId: idOf(req.capacityLineId) || null,
    legacyDeviceCode: String(req.legacyDeviceCode ?? "").trim().toLowerCase() || null,
    legacyReason: normalizeReason(req.legacyReason) || null,
    reason: normalizeReason(req.reason) || null,
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** The frozen current-assignment snapshot. */
function buildAssignment({ companyId, machine, workOrder, basis, step, codes, legacyOverrideReason, revision, actor, reason, now }) {
  const id = new mongoose.Types.ObjectId();
  return {
    assignmentId: id,
    assignmentRef: `MA-${idOf(machine._id).slice(-6)}-R${revision}`,
    revision,
    state: "ACTIVE",
    companyId: oid(companyId),
    machineId: oid(machine._id),
    workOrderId: oid(workOrder._id),
    workOrderNumber: String(workOrder.workOrderNumber ?? ""),
    executionBasisId: oid(basis.basisId),
    executionBasisVersionNo: Number(basis.versionNo),
    capacityLineId: oid(basis.planningLine.capacityLineId),
    capacityLineRef: String(basis.planningLine.lineRef),
    operationRowId: String(step.rowId),
    operationSequence: Number(step.sequence),
    ieOperationId: oid(step.ieOperationId),
    ieOperationRevision: Number(step.ieOperationRevision),
    canonicalOperationCode: String(step.operationCode),
    operationName: String(step.operationName ?? ""),
    deviceOperationCodes: codes,
    legacyOverrideReason,
    effectiveFrom: new Date(now),
    actor: { id: actor?.id && isObjectId(actor.id) ? oid(actor.id) : null, name: String(actor?.name ?? "") },
    reason: normalizeReason(reason),
  };
}

/** Every code this machine was ever told to carry — what a sync may safely switch off. */
function knownDeviceCodes(machine) {
  const all = [];
  for (const c of machine.productionAssignment?.deviceOperationCodes || []) all.push(c.code);
  for (const t of machine.productionAssignmentHistory || []) for (const c of t.previous?.deviceOperationCodes || []) all.push(c.code);
  return [...new Set(all)];
}

/** Narrow, public view of an assignment. */
function publicAssignment(a) {
  if (!a) return null;
  return {
    assignmentId: idOf(a.assignmentId),
    assignmentRef: a.assignmentRef,
    revision: a.revision,
    state: a.state,
    machineId: idOf(a.machineId),
    workOrderId: idOf(a.workOrderId),
    workOrderNumber: a.workOrderNumber,
    executionBasisId: idOf(a.executionBasisId),
    executionBasisVersionNo: a.executionBasisVersionNo,
    planningLine: { capacityLineId: idOf(a.capacityLineId), lineRef: a.capacityLineRef },
    operation: {
      rowId: a.operationRowId, sequence: a.operationSequence, ieOperationId: idOf(a.ieOperationId),
      ieOperationRevision: a.ieOperationRevision, canonicalCode: a.canonicalOperationCode, name: a.operationName,
    },
    deviceOperationCodes: (a.deviceOperationCodes || []).map((c) => ({ code: c.code, provenance: c.provenance })),
    legacyOverrideReason: a.legacyOverrideReason || "",
    effectiveFrom: a.effectiveFrom ? new Date(a.effectiveFrom).toISOString() : null,
    actor: a.actor ? { name: a.actor.name } : null,
    reason: a.reason || "",
  };
}

module.exports = {
  ELIGIBLE_MACHINE_STATUSES,
  NOT_ASSIGNABLE_WORK_ORDER,
  MachineAssignmentError,
  isObjectId,
  normalizeReason,
  requireReason,
  assertOwnedMachine,
  deviceCodesFor,
  assertAssignable,
  fingerprintOf,
  buildAssignment,
  knownDeviceCodes,
  publicAssignment,
};
