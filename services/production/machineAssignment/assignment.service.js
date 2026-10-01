// services/production/machineAssignment/assignment.service.js
//
// The ONE writer of a Machine's production ownership, assignment, history and
// device-sync state. Commands:
//
//   claim      platform admin: an UNCLAIMED machine → one proved company
//   assign     an unassigned, owned, eligible machine → one frozen operation
//   reassign   close the current assignment into history, activate a new one
//   unassign   close the current assignment into history
//   syncStatus / requestSync / acknowledgeSync   device synchronisation
//   reads      by machine, WorkOrder, planning line, frozen operation
//
// ── CONCURRENCY ─────────────────────────────────────────────────────────────
// Each command is one snapshot transaction, the execution-basis pattern:
//   1. read the Machine (and for assign/reassign the WorkOrder with its
//      execution bases) with the session, and prove eligibility on those reads;
//   2. FENCE the WorkOrder — a raw `$inc` of `productionAssignmentFence` whose
//      predicate re-states: this company, not cancelled/completed, and the
//      chosen basis still ACTIVE. An execution-basis supersession writes the
//      same document, so the two transactions conflict: either this commits
//      against the basis while it was still active, or it retries and sees the
//      successor (and refuses with EXECUTION_BASIS_NOT_ACTIVE);
//   3. update the Machine only if its assignment revision is still the one the
//      caller expected, it is still this company's, still eligible, and the
//      history bound is not reached — replacing the current assignment,
//      appending the transition and bumping the revision in ONE update;
//   4. commit.
// Retries are bounded (MAX_ATTEMPTS); an uncertain commit is resolved by the
// replay key (company, machine, expected revision) — never rerun blindly.
//
// ── THE POST-COMMIT EVIDENCE BASELINE ───────────────────────────────────────
// The transaction writes the sync state WITHOUT an evidence baseline. Only once
// the commit is KNOWN (normal commit, idempotent replay, or an uncertain commit
// confirmed by the primary read) does `establishBaseline` read every heartbeat
// document then associated with the machine and record each device's
// server-owned `evidenceRevision` — in an update fenced on the assignment
// revision, the sync revision and the baseline still being absent, so it never
// resets an existing baseline and a delayed write can never touch a newer
// assignment. A heartbeat ingested after that read carries a greater revision
// and is the only evidence the device state is post-commit (deviceSync.rules).
// If the capture fails, the assignment stays committed and the device stays
// `pending_device_state` (no barcode, never `applied`); the next evaluation
// captures it first.
"use strict";

const mongoose = require("mongoose");

const Machine = require("../../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const DeviceHeartbeat = require("../../../models/CMS_Models/Manufacturing/Production/Barcode/DeviceHeartbeat");
const {
  MACHINE_ASSIGNMENT_WRITE_OPTION, ASSIGNMENT_LIMITS, SYNC_STATUS,
} = require("../../../models/CMS_Models/Inventory/Configurations/machineProductionAssignment.schema");
const rules = require("./assignment.rules");
const sync = require("./deviceSync.rules");

const { MachineAssignmentError, isObjectId } = rules;
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const idOf = (v) => (v == null ? null : String(v));

const MAX_ATTEMPTS = 4;
const COMMIT_ATTEMPTS = 3;
const TRANSACTION_OPTIONS = Object.freeze({ readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_SEC || 180) * 1000;
const MACHINE_FIELDS = "name type status +productionOwnership +productionAssignment +productionAssignmentRevision +productionAssignmentHistory +productionDeviceSync";
const WO_FIELDS = "_id workOrderNumber quantity status salesLineLink +productionExecutionBases";

class RetryAttempt extends Error { constructor(r) { super(r); this.retryReason = r; } }
class CommitOutcomeUnknown extends Error { constructor(cause) { super("commit outcome unknown"); this.cause = cause; } }
const isTransient = (err) => err?.hasErrorLabel?.("TransientTransactionError") || err?.code === 112 || /WriteConflict/i.test(String(err?.message ?? ""));
const defaultCommit = (session) => session.commitTransaction();

function requireCompany(companyId) {
  if (!isObjectId(companyId)) throw new MachineAssignmentError(403, "COMPANY_CONTEXT_REQUIRED", "No acting company could be proved for this request.");
  return String(companyId);
}
function requireId(v, name) {
  if (!isObjectId(v)) throw new MachineAssignmentError(400, "INVALID_ID", `${name} must be a 24-character id.`);
  return String(v);
}
function requireRevision(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new MachineAssignmentError(400, "EXPECTED_REVISION_REQUIRED", "expectedRevision must be the machine's current assignment revision (0 when never assigned).");
  return n;
}

const revisionOf = (m) => Number(m?.productionAssignmentRevision || 0);
const transitionFor = (m, fromRevision) => (m?.productionAssignmentHistory || []).find((t) => t.fromRevision === fromRevision) || null;

function replayResult(machine, transition, fingerprint) {
  if (transition.requestFingerprint !== fingerprint) {
    throw new MachineAssignmentError(409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST",
      "That expected revision was already used by a different assignment request; this request was not applied.",
      { consumedRevision: transition.fromRevision, resultingRevision: transition.toRevision, kind: transition.kind });
  }
  const current = machine.productionAssignment;
  const assignment = current && idOf(current.assignmentId) === idOf(transition.nextAssignmentId) ? current : null;
  return { machine, transition, assignment, reused: true };
}

const defaultLoadHeartbeats = (machineId) => DeviceHeartbeat.find({ machineId })
  .select("deviceId machineId activeOps lastHeartbeatAt evidenceRevision").lean();

function createMachineAssignmentService({
  now = () => new Date(), commit = defaultCommit, hooks = {}, heartbeatStaleMs = HEARTBEAT_STALE_MS,
  loadHeartbeats = defaultLoadHeartbeats,
} = {}) {
  const loadMachine = (machineId, session) => {
    const q = Machine.findById(oid(machineId)).select(MACHINE_FIELDS);
    return (session ? q.session(session) : q).lean();
  };

  /* ═══ CLAIM ═════════════════════════════════════════════════════════════ */

  /** Platform admin only (enforced by the route). Unclaimed → one company. */
  async function claim({ machineId, companyId, reason, actor, companyExists }) {
    const mId = requireId(machineId, "machineId");
    const company = requireId(companyId, "companyId");
    const why = rules.requireReason(reason, "CLAIM_REASON_REQUIRED");
    if (!(await companyExists(company))) throw new MachineAssignmentError(404, "COMPANY_NOT_FOUND", "No such company.");
    const at = now();
    const ownership = { companyId: oid(company), claimedAt: at, claimedBy: { id: isObjectId(actor?.id) ? oid(actor.id) : null, name: String(actor?.name ?? "") }, reason: why };
    const r = await Machine.updateOne(
      { _id: oid(mId), productionOwnership: { $exists: false } },
      { $set: { productionOwnership: ownership } },
      { [MACHINE_ASSIGNMENT_WRITE_OPTION]: true },
    );
    const machine = await loadMachine(mId);
    if (!machine) throw new MachineAssignmentError(404, "MACHINE_NOT_FOUND", "No machine has that id.");
    if (r.modifiedCount === 1) return { ownership: machine.productionOwnership, claimed: true };
    if (idOf(machine.productionOwnership?.companyId) === company) return { ownership: machine.productionOwnership, claimed: false };
    throw new MachineAssignmentError(409, "MACHINE_OWNED_BY_OTHER_COMPANY", "This machine is already owned by another company; transfer is not supported.");
  }

  /** Read-only pilot diagnostic: machines nobody has claimed. */
  async function unclaimedMachines() {
    const rows = await Machine.find({ productionOwnership: { $exists: false } })
      .select("name type serialNumber status location").sort({ name: 1 }).lean();
    return rows.map((m) => ({ machineId: idOf(m._id), name: m.name, type: m.type, serialNumber: m.serialNumber, status: m.status, location: m.location }));
  }

  /* ═══ ASSIGN / REASSIGN / UNASSIGN ══════════════════════════════════════ */

  async function attempt(session, cmd) {
    const machine = await loadMachine(cmd.machineId, session);
    rules.assertOwnedMachine(machine, cmd.company);

    const consumed = transitionFor(machine, cmd.expectedRevision);
    if (consumed) return replayResult(machine, consumed, cmd.fingerprint);
    const revision = revisionOf(machine);
    if (revision !== cmd.expectedRevision) {
      throw new MachineAssignmentError(409, "ASSIGNMENT_REVISION_STALE", "The machine's assignment changed; reload and try again.",
        { currentRevision: revision, expectedRevision: cmd.expectedRevision });
    }
    const current = machine.productionAssignment || null;
    if (cmd.kind === "assign" && current) {
      throw new MachineAssignmentError(409, "ASSIGNMENT_CONFLICT", "This machine already has a current assignment; reassign it instead.",
        { current: rules.publicAssignment(current) });
    }
    if (cmd.kind !== "assign" && !current) throw new MachineAssignmentError(409, "NO_CURRENT_ASSIGNMENT", "This machine has no current assignment.");
    if ((machine.productionAssignmentHistory || []).length >= ASSIGNMENT_LIMITS.HISTORY) {
      throw new MachineAssignmentError(409, "MACHINE_ASSIGNMENT_HISTORY_FULL", "This machine's assignment history is full; it cannot be changed further.");
    }

    const at = now();
    const toRevision = revision + 1;
    let next = null;
    if (cmd.kind !== "unassign") {
      const workOrder = await WorkOrder.findOne({ _id: oid(cmd.workOrderId), "salesLineLink.companyId": oid(cmd.company) })
        .select(WO_FIELDS).session(session).lean();
      const proof = rules.assertAssignable({ companyId: cmd.company, machine, workOrder, ...cmd.selectors, now: at });
      if (hooks.beforeFence) await hooks.beforeFence({ kind: cmd.kind });
      const fenced = await WorkOrder.collection.updateOne({
        _id: workOrder._id,
        "salesLineLink.companyId": oid(cmd.company),
        status: { $nin: rules.NOT_ASSIGNABLE_WORK_ORDER },
        productionExecutionBases: { $elemMatch: { basisId: proof.basis.basisId, state: "ACTIVE", effectiveUntil: null } },
      }, { $inc: { productionAssignmentFence: 1 } }, { session });
      if (fenced.matchedCount !== 1) throw new RetryAttempt("work_order_fence");
      next = rules.buildAssignment({ companyId: cmd.company, machine, workOrder, ...proof, revision: toRevision, actor: cmd.actor, reason: cmd.reason, now: at });
    }

    const actor = { id: isObjectId(cmd.actor?.id) ? oid(cmd.actor.id) : null, name: String(cmd.actor?.name ?? "") };
    const transition = {
      kind: cmd.kind, fromRevision: revision, toRevision, at, actor, reason: cmd.reason,
      requestFingerprint: cmd.fingerprint, previous: current, nextAssignmentId: next ? next.assignmentId : null,
    };
    const deviceSync = sync.initialSync({
      revision: toRevision,
      desiredCodes: next ? next.deviceOperationCodes.map((c) => c.code) : [],
      productionAssigned: Boolean(next),
      transitionAt: at,
    });
    const update = {
      $set: { productionAssignmentRevision: toRevision, productionDeviceSync: deviceSync, ...(next ? { productionAssignment: next } : {}) },
      ...(next ? {} : { $unset: { productionAssignment: 1 } }),
      $push: { productionAssignmentHistory: transition },
    };
    const filter = {
      _id: machine._id,
      "productionOwnership.companyId": oid(cmd.company),
      productionAssignmentRevision: revision === 0 ? { $in: [null, 0] } : revision,
      [`productionAssignmentHistory.${ASSIGNMENT_LIMITS.HISTORY - 1}`]: { $exists: false },
      ...(next ? { status: { $in: rules.ELIGIBLE_MACHINE_STATUSES } } : {}),
    };
    const r = await Machine.updateOne(filter, update, { session, [MACHINE_ASSIGNMENT_WRITE_OPTION]: true });
    if (r.modifiedCount !== 1) throw new RetryAttempt("machine_predicate");
    return { transition, assignment: next, reused: false };
  }

  async function commitWithRetry(session) {
    let lastUnknown = null;
    for (let n = 1; n <= COMMIT_ATTEMPTS; n++) {
      try { await commit(session, { attempt: n }); return; } catch (err) {
        if (!err?.hasErrorLabel?.("UnknownTransactionCommitResult")) throw err;
        lastUnknown = err;
      }
    }
    throw new CommitOutcomeUnknown(lastUnknown);
  }

  async function run(cmd) {
    let lastRetry = null;
    for (let n = 1; n <= MAX_ATTEMPTS; n++) {
      const session = await mongoose.startSession();
      let uncertain = null;
      try {
        session.startTransaction(TRANSACTION_OPTIONS);
        const out = await attempt(session, cmd);
        if (out.reused) { await session.abortTransaction(); return out; }
        await commitWithRetry(session);
        return out;
      } catch (err) {
        if (err instanceof CommitOutcomeUnknown) uncertain = err;
        else {
          if (session.inTransaction()) await session.abortTransaction().catch(() => {});
          if (err instanceof MachineAssignmentError) throw err;
          if (err instanceof RetryAttempt || isTransient(err)) { lastRetry = err; continue; }
          throw err;
        }
      } finally {
        await session.endSession().catch(() => {});
      }
      return resolveUncertain(cmd, uncertain);
    }
    throw new MachineAssignmentError(409, "MACHINE_ASSIGNMENT_SOURCE_CHANGED",
      "The machine or work order kept changing while this was being applied; this request was not applied. Reload and try again.",
      { lastReason: lastRetry?.retryReason || lastRetry?.codeName || lastRetry?.code || "transient",
        lastError: String(lastRetry?.message || "").slice(0, 200) });
  }

  async function resolveUncertain(cmd, uncertain) {
    let machine;
    try { machine = await Machine.findById(oid(cmd.machineId)).select(MACHINE_FIELDS).read("primary").lean(); } catch { machine = null; }
    const t = machine && idOf(machine.productionOwnership?.companyId) === cmd.company ? transitionFor(machine, cmd.expectedRevision) : null;
    if (t) return { ...replayResult(machine, t, cmd.fingerprint), commitOutcome: "confirmed_by_revision" };
    throw new MachineAssignmentError(503, "MACHINE_ASSIGNMENT_COMMIT_OUTCOME_UNKNOWN",
      "The change was sent but its outcome could not be confirmed. Repeat the same request with the same expected revision: if it was committed it is returned, never applied twice.",
      { expectedRevision: cmd.expectedRevision, lastError: uncertain?.cause?.codeName || uncertain?.cause?.message || null });
  }

  async function command(kind, { companyId, machineId, expectedRevision, workOrderId, executionBasisId, operationRowId, capacityLineId, legacyDeviceCode, legacyReason, reason, actor } = {}) {
    const company = requireCompany(companyId);
    const cmd = { kind, company, machineId: requireId(machineId, "machineId"), expectedRevision: requireRevision(expectedRevision), actor };
    cmd.reason = kind === "assign" ? rules.normalizeReason(reason) : rules.requireReason(reason);
    if (kind !== "unassign") {
      cmd.workOrderId = requireId(workOrderId, "workOrderId");
      requireId(executionBasisId, "executionBasisId");
      if (!String(operationRowId ?? "").trim()) throw new MachineAssignmentError(400, "OPERATION_ROW_REQUIRED", "Choose a frozen operation (operationRowId).");
      if (capacityLineId != null && capacityLineId !== "") requireId(capacityLineId, "capacityLineId");
      cmd.selectors = { executionBasisId, operationRowId: String(operationRowId).trim(), capacityLineId, legacyDeviceCode, legacyReason };
    }
    cmd.fingerprint = rules.fingerprintOf(kind, { workOrderId, executionBasisId, operationRowId, capacityLineId, legacyDeviceCode, legacyReason, reason: cmd.reason });
    return run(cmd);
  }

  /**
   * Capture the post-commit evidence baseline for `revision`, if it is still
   * this machine's revision and has none. Never throws: a failure leaves the
   * device pending and is retried by the next evaluation.
   */
  async function establishBaseline(company, machineId, revision) {
    try {
      if (hooks.beforeBaseline) await hooks.beforeBaseline({ machineId, revision });
      const heartbeats = await loadHeartbeats(oid(machineId));
      const devices = heartbeats.map((h) => ({
        deviceId: String(h.deviceId || ""),
        evidenceRevision: Number.isInteger(h.evidenceRevision) && h.evidenceRevision >= 0 ? h.evidenceRevision : 0,
      }));
      // Test seam: a heartbeat may land between this read and the write below.
      if (hooks.betweenBaselineReadAndWrite) await hooks.betweenBaselineReadAndWrite({ machineId, revision });
      const r = await Machine.updateOne(
        {
          _id: oid(machineId),
          "productionOwnership.companyId": oid(company),
          productionAssignmentRevision: revision,
          "productionDeviceSync.forRevision": revision,
          "productionDeviceSync.evidenceBaseline": null,
        },
        {
          $set: { "productionDeviceSync.evidenceBaseline": { devices } },
          $currentDate: { "productionDeviceSync.confirmationBoundaryAt": true }, // audit only
        },
        { [MACHINE_ASSIGNMENT_WRITE_OPTION]: true },
      );
      return { established: r.modifiedCount === 1, error: null };
    } catch (err) {
      return { established: false, error: String(err?.message || err).slice(0, 300) };
    }
  }

  const withBaseline = (kind) => async (args) => {
    const out = await command(kind, args);
    const baseline = await establishBaseline(String(args.companyId), String(args.machineId), out.transition.toRevision);
    return { ...out, baseline };
  };
  const assign = withBaseline("assign");
  const reassign = withBaseline("reassign");
  const unassign = withBaseline("unassign");

  /* ═══ DEVICE SYNCHRONISATION ════════════════════════════════════════════ */

  async function ownedMachine(companyId, machineId) {
    const company = requireCompany(companyId);
    const machine = await loadMachine(requireId(machineId, "machineId"));
    rules.assertOwnedMachine(machine, company);
    return { company, machine };
  }

  /**
   * Evaluate against the freshest device evidence and persist — only if the
   * machine is still on the same assignment revision, so a delayed evaluation
   * can never write over a newer assignment's sync state.
   */
  async function evaluate({ companyId, machineId, reissue = false } = {}) {
    let { company, machine } = await ownedMachine(companyId, machineId);
    const revision = revisionOf(machine);
    if (!revision || !machine.productionDeviceSync) return { machine, deviceSync: null };
    if (!machine.productionDeviceSync.evidenceBaseline) {
      // The command's own baseline capture may have failed or not happened yet.
      await establishBaseline(company, String(machine._id), revision);
      machine = await loadMachine(machineId);
      if (revisionOf(machine) !== revision) return { machine, deviceSync: machine.productionDeviceSync || null, superseded: true };
    }
    const state = machine.productionDeviceSync;
    let nextState;
    try {
      const heartbeats = await loadHeartbeats(machine._id);
      nextState = sync.evaluateSync(state, {
        machineId: idOf(machine._id), revision, heartbeats, knownCodes: rules.knownDeviceCodes(machine),
        now: now(), staleMs: heartbeatStaleMs, reissue,
      });
    } catch (err) {
      nextState = { ...state, status: SYNC_STATUS.FAILED, lastError: String(err?.message || err).slice(0, 500), lastEvaluatedAt: now() };
    }
    const r = await Machine.updateOne(
      {
        _id: machine._id, "productionOwnership.companyId": oid(company), productionAssignmentRevision: revision,
        "productionDeviceSync.forRevision": revision,
        // Pinned: an evaluation built on a read without the baseline can never erase it.
        "productionDeviceSync.evidenceBaseline": state.evidenceBaseline ? { $ne: null } : null,
      },
      { $set: { productionDeviceSync: nextState } },
      { [MACHINE_ASSIGNMENT_WRITE_OPTION]: true },
    );
    if (r.matchedCount !== 1) return evaluateAfterChange(company, machineId);
    return { machine: { ...machine, productionDeviceSync: nextState }, deviceSync: nextState };
  }

  async function evaluateAfterChange(company, machineId) {
    const fresh = await loadMachine(machineId);
    return { machine: fresh, deviceSync: fresh?.productionDeviceSync || null, superseded: true };
  }

  /** The operator scanned the instruction. Only the CURRENT one, for the CURRENT revision. */
  async function acknowledge({ companyId, machineId, instructionId, revision, actor } = {}) {
    const { company, machine } = await ownedMachine(companyId, machineId);
    const current = revisionOf(machine);
    const instr = machine.productionDeviceSync?.instruction;
    if (Number(revision) !== current || !instr || instr.instructionId !== instructionId || instr.forRevision !== current) {
      throw new MachineAssignmentError(409, "SYNC_INSTRUCTION_STALE",
        "That synchronisation barcode is no longer current (the assignment or the scanner's state changed). Do not scan it; request a new one.",
        { currentRevision: current, currentInstructionId: instr?.instructionId || null });
    }
    if (instr.acknowledgedAt) return { deviceSync: machine.productionDeviceSync, reused: true };
    const at = now();
    const r = await Machine.updateOne(
      { _id: machine._id, "productionOwnership.companyId": oid(company), productionAssignmentRevision: current,
        "productionDeviceSync.instruction.instructionId": instructionId, "productionDeviceSync.instruction.acknowledgedAt": null },
      { $set: {
        "productionDeviceSync.instruction.acknowledgedAt": at,
        "productionDeviceSync.instruction.acknowledgedBy": { id: isObjectId(actor?.id) ? oid(actor.id) : null, name: String(actor?.name ?? "") },
        "productionDeviceSync.status": SYNC_STATUS.AWAITING_CONFIRMATION,
        "productionDeviceSync.reasons": ["waiting_for_newer_heartbeat"],
      } },
      { [MACHINE_ASSIGNMENT_WRITE_OPTION]: true },
    );
    const fresh = await loadMachine(machineId);
    if (r.modifiedCount !== 1 && !fresh?.productionDeviceSync?.instruction?.acknowledgedAt) {
      throw new MachineAssignmentError(409, "SYNC_INSTRUCTION_STALE", "That synchronisation barcode is no longer current. Request a new one.");
    }
    return { deviceSync: fresh.productionDeviceSync, reused: r.modifiedCount !== 1 };
  }

  /* ═══ READS ═════════════════════════════════════════════════════════════ */

  async function machineView({ companyId, machineId } = {}) {
    const { machine } = await ownedMachine(companyId, machineId);
    return {
      machineId: idOf(machine._id), name: machine.name, status: machine.status,
      revision: revisionOf(machine),
      assignment: rules.publicAssignment(machine.productionAssignment),
      deviceSync: publicSync(machine.productionDeviceSync),
      history: (machine.productionAssignmentHistory || []).map((t) => ({
        kind: t.kind, fromRevision: t.fromRevision, toRevision: t.toRevision, at: t.at, actor: t.actor?.name || "", reason: t.reason,
        previous: rules.publicAssignment(t.previous), nextAssignmentId: idOf(t.nextAssignmentId),
      })),
    };
  }

  /** Current assignments of this company, narrowed by WorkOrder, line and/or frozen operation. */
  async function currentAssignments({ companyId, workOrderId, capacityLineId, operationRowId } = {}) {
    const company = requireCompany(companyId);
    const filter = { "productionOwnership.companyId": oid(company), productionAssignment: { $exists: true } };
    if (workOrderId) filter["productionAssignment.workOrderId"] = oid(requireId(workOrderId, "workOrderId"));
    if (capacityLineId) filter["productionAssignment.capacityLineId"] = oid(requireId(capacityLineId, "capacityLineId"));
    if (operationRowId) filter["productionAssignment.operationRowId"] = String(operationRowId);
    const rows = await Machine.find(filter).select(MACHINE_FIELDS).lean();
    return rows
      .filter((m) => idOf(m.productionAssignment?.companyId) === company)
      .map((m) => ({ machineId: idOf(m._id), name: m.name, revision: revisionOf(m),
        assignment: rules.publicAssignment(m.productionAssignment), deviceSync: publicSync(m.productionDeviceSync) }));
  }

  /**
   * What may be assigned now: this company's WorkOrders (not cancelled or
   * completed) whose ACTIVE execution basis is in force, with the frozen route
   * of each — the picker's only source. Nothing comes from the editable route.
   */
  async function assignableOperations({ companyId, capacityLineId } = {}) {
    const company = requireCompany(companyId);
    const filter = {
      "salesLineLink.companyId": oid(company),
      status: { $nin: rules.NOT_ASSIGNABLE_WORK_ORDER },
      productionExecutionBases: { $elemMatch: { state: "ACTIVE", companyId: oid(company),
        ...(capacityLineId ? { "planningLine.capacityLineId": oid(requireId(capacityLineId, "capacityLineId")) } : {}) } },
    };
    const rows = await WorkOrder.find(filter).select(WO_FIELDS).lean();
    const at = now();
    const { basisAt } = require("../executionBasis/executionBasis.rules");
    return rows.map((wo) => {
      const basis = basisAt(wo.productionExecutionBases, at);
      if (!basis || basis.state !== "ACTIVE" || idOf(basis.companyId) !== company) return null;
      return {
        workOrderId: idOf(wo._id), workOrderNumber: wo.workOrderNumber || "", status: wo.status,
        executionBasisId: idOf(basis.basisId), executionBasisVersionNo: basis.versionNo,
        planningLine: { capacityLineId: idOf(basis.planningLine.capacityLineId), lineRef: basis.planningLine.lineRef },
        operations: (basis.route || []).map((r) => ({ rowId: r.rowId, sequence: r.sequence, code: r.operationCode, name: r.operationName,
          deviceCompatible: sync.validDeviceCode(r.operationCode) })),
      };
    }).filter(Boolean);
  }

  /** Company-owned machines and their current assignment — the flow tracker's loader. */
  async function assignmentsForWorkOrders(companyId, workOrderIds) {
    if (!workOrderIds.length) return [];
    return Machine.find({ "productionOwnership.companyId": oid(companyId), "productionAssignment.workOrderId": { $in: workOrderIds.map(oid) } })
      .select("+productionOwnership +productionAssignment +productionAssignmentRevision").lean();
  }

  return {
    claim, unclaimedMachines,
    assign, reassign, unassign, establishBaseline,
    evaluate, acknowledge,
    machineView, currentAssignments, assignableOperations, assignmentsForWorkOrders,
  };
}

/** The UI's reading of a sync state — never "done" unless a heartbeat said so. */
function publicSync(s) {
  if (!s) return null;
  const labels = {
    [SYNC_STATUS.PENDING_DEVICE_STATE]: "Waiting for fresh scanner heartbeat",
    [SYNC_STATUS.READY_TO_SYNC]: "Scan the barcode at the machine",
    [SYNC_STATUS.AWAITING_CONFIRMATION]: "Waiting for scanner confirmation",
    [SYNC_STATUS.APPLIED]: "Applied",
    [SYNC_STATUS.DRIFT]: "Scanner does not match the assignment",
    [SYNC_STATUS.FAILED]: "Synchronisation could not be processed",
  };
  return {
    forRevision: s.forRevision,
    status: s.status,
    label: labels[s.status] || s.status,
    productionAssigned: s.productionAssigned,
    scannerMayHoldOldCodes: !s.productionAssigned && s.status !== SYNC_STATUS.APPLIED,
    desiredCodes: s.desiredCodes || [],
    observed: s.observed ? { deviceId: s.observed.deviceId, heartbeatAt: s.observed.heartbeatAt, codes: s.observed.codes } : null,
    reasons: s.reasons || [],
    evidenceBaseline: s.evidenceBaseline ? { devices: s.evidenceBaseline.devices || [] } : null,
    baselineCapturedAt: s.confirmationBoundaryAt || null,
    transitionAt: s.transitionAt || null,
    instruction: s.instruction ? {
      instructionId: s.instruction.instructionId,
      forRevision: s.instruction.forRevision,
      toggles: s.instruction.toggles,
      payloads: s.instruction.payloads,
      scanInOrder: (s.instruction.payloads || []).length > 1,
      revisionSensitive: true,
      acknowledgedAt: s.instruction.acknowledgedAt || null,
    } : null,
    appliedRevision: s.appliedRevision ?? null,
    appliedAt: s.appliedAt || null,
    lastEvaluatedAt: s.lastEvaluatedAt || null,
    lastError: s.lastError || "",
  };
}

let defaultService = null;
function machineAssignmentService() {
  if (!defaultService) defaultService = createMachineAssignmentService();
  return defaultService;
}

module.exports = {
  MAX_ATTEMPTS,
  COMMIT_ATTEMPTS,
  MachineAssignmentError,
  createMachineAssignmentService,
  machineAssignmentService,
  publicSync,
};
