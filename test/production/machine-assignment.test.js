// test/production/machine-assignment.test.js
//
// SERVER-OWNED MACHINE ASSIGNMENT — Machine → WorkOrder → Production execution
// basis → frozen operation — and device-verified scanner synchronisation.
// Against an in-memory replica set (test/setup.js).
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const DeviceHeartbeat = require("../../models/CMS_Models/Manufacturing/Production/Barcode/DeviceHeartbeat");
const ProductionEvent = require("../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
const CanvasLayout = require("../../models/CMS_Models/Manufacturing/Production/CanvasLayout");
const schemaModule = require("../../models/CMS_Models/Inventory/Configurations/machineProductionAssignment.schema");
const { MACHINE_ASSIGNMENT_WRITE_OPTION, ASSIGNMENT_LIMITS } = schemaModule;
const { createMachineAssignmentService } = require("../../services/production/machineAssignment/assignment.service");
const { createMachineAssignmentRouter } = require("../../routes/CMS_Routes/Production/MachineAssignment/machineAssignmentRoutes");
const { createFlowTrackingService } = require("../../services/production/flowTracking/flowTracking.service");
const F = require("./support/executionBasisFixtures");

const { ObjectId } = mongoose.Types;
let seq = 0;

beforeAll(() => F.settleCollections([Machine]));

/* ── fixtures ─────────────────────────────────────────────────────────────── */

async function machine(over = {}) {
  const m = await Machine.create({
    name: `SNLS ${++seq}`, type: "Single needle", model: "DDL", serialNumber: `SN-MA-${seq}`, status: "Operational",
    powerConsumption: "0.5kW", location: "Floor", lastMaintenance: new Date(), nextMaintenance: new Date(),
    createdBy: new ObjectId(), ...over,
  });
  return m;
}

const svc = (opts = {}) => createMachineAssignmentService(opts);
const admin = { id: String(new ObjectId()), name: "Platform Admin" };
const editor = { id: String(new ObjectId()), name: "Line Supervisor" };
const companyExists = async () => true;

/** A company with an ACTIVE execution basis and one claimed, operational machine. */
async function floor(label, { claim = true, machineOver = {} } = {}) {
  const w = await F.world(label);
  await F.receive(w, { now: new Date(Date.now() - 3600e3) });
  const m = await machine(machineOver);
  if (claim) await svc().claim({ machineId: String(m._id), companyId: String(w.co._id), reason: "Pilot line machine claimed.", actor: admin, companyExists });
  const bases = (await WorkOrder.findById(w.wo._id).select("+productionExecutionBases").lean()).productionExecutionBases;
  const basis = bases.find((b) => b.state === "ACTIVE");
  return { ...w, machine: m, basis, rowOf: (i) => basis.route[i].rowId };
}

const assignArgs = (f, over = {}) => ({
  companyId: String(f.co._id), machineId: String(f.machine._id), expectedRevision: 0,
  workOrderId: String(f.wo._id), executionBasisId: String(f.basis.basisId), operationRowId: f.rowOf(0), actor: editor, ...over,
});
const machineState = (id) => Machine.findById(id).select("+productionOwnership +productionAssignment +productionAssignmentRevision +productionAssignmentHistory +productionDeviceSync").lean();
/* Exactly what the ingest route does: $set the device state, $inc the
   server-owned evidence revision. `at` is only a clock value — it proves nothing. */
const heartbeat = (m, codes, at = new Date(), deviceId = `DEV-${String(m._id).slice(-4)}`) =>
  DeviceHeartbeat.updateOne({ deviceId }, { $set: { deviceId, machineId: m._id, activeOps: codes, lastHeartbeatAt: at },
    $inc: { evidenceRevision: 1 } }, { upsert: true });
const rejectsWith = (p, code) => expect(p).rejects.toMatchObject({ code });

/* ══ OWNERSHIP ════════════════════════════════════════════════════════════ */

describe("machine ownership", () => {
  test("an admin claims an unclaimed machine; a repeat is idempotent; another company is refused", async () => {
    const a = await F.world("OwnA");
    const b = await F.world("OwnB");
    const m = await machine();
    const out = await svc().claim({ machineId: String(m._id), companyId: String(a.co._id), reason: "Pilot claim for line A.", actor: admin, companyExists });
    expect(out.claimed).toBe(true);
    const state = await machineState(m._id);
    expect(state.productionOwnership).toMatchObject({ reason: "Pilot claim for line A.", claimedBy: { name: "Platform Admin" } });
    expect(String(state.productionOwnership.companyId)).toBe(String(a.co._id));
    expect((await svc().claim({ machineId: String(m._id), companyId: String(a.co._id), reason: "Pilot claim for line A.", actor: admin, companyExists })).claimed).toBe(false);
    await rejectsWith(svc().claim({ machineId: String(m._id), companyId: String(b.co._id), reason: "Trying to take it over.", actor: admin, companyExists }),
      "MACHINE_OWNED_BY_OTHER_COMPANY");
    await rejectsWith(svc().claim({ machineId: String(m._id), companyId: String(a.co._id), reason: "short", actor: admin, companyExists }), "CLAIM_REASON_REQUIRED");
    await rejectsWith(svc().claim({ machineId: String(m._id), companyId: String(a.co._id), reason: "Company does not exist.", actor: admin, companyExists: async () => false }), "COMPANY_NOT_FOUND");
  });

  test("a Production editor cannot claim: the claim door is platform-admin only", async () => {
    const f = await F.world("OwnHttp");
    const m = await machine();
    const sup = await F.person({ companies: [f.co], grants: { "production-supervisor": "owner" } });
    const app = express();
    app.use(express.json());
    app.use("/ma", createMachineAssignmentRouter()); // the real deps: requirePlatformAdmin
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/ma/admin/machines/${m._id}/claim`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${sup.token}` },
        body: JSON.stringify({ companyId: String(f.co._id), reason: "Editor trying to claim." }) });
      expect([401, 403]).toContain(res.status);
      const unclaimed = await fetch(`http://127.0.0.1:${server.address().port}/ma/admin/unclaimed-machines`, { headers: { Authorization: `Bearer ${sup.token}` } });
      expect([401, 403]).toContain(unclaimed.status);
    } finally { await new Promise((r) => server.close(r)); }
    expect((await machineState(m._id)).productionOwnership).toBeUndefined();
  });

  test("the unclaimed diagnostic lists only unclaimed machines", async () => {
    const f = await floor("OwnDiag");
    const loose = await machine();
    const ids = (await svc().unclaimedMachines()).map((x) => x.machineId);
    expect(ids).toContain(String(loose._id));
    expect(ids).not.toContain(String(f.machine._id));
  });
});

/* ══ ASSIGNMENT ELIGIBILITY ═══════════════════════════════════════════════ */

describe("assignment eligibility", () => {
  test("canonical assignment copies every identity from the frozen basis; the device is NOT reported in step", async () => {
    const f = await floor("Canon");
    const out = await svc().assign(assignArgs(f, { reason: "Start of shift" }));
    expect(out.reused).toBe(false);
    const s = await machineState(f.machine._id);
    expect(s.productionAssignmentRevision).toBe(1);
    expect(s.productionAssignment).toMatchObject({
      revision: 1, state: "ACTIVE", workOrderNumber: f.wo.workOrderNumber, executionBasisVersionNo: 1,
      capacityLineRef: f.line.lineRef, operationRowId: f.rowOf(0), operationSequence: 1, ieOperationRevision: 1,
      canonicalOperationCode: "SJ-01", operationName: "Op SJ-01", legacyOverrideReason: "",
      deviceOperationCodes: [{ code: "SJ-01", provenance: "canonical" }], actor: { name: "Line Supervisor" },
    });
    expect(String(s.productionAssignment.executionBasisId)).toBe(String(f.basis.basisId));
    expect(String(s.productionAssignment.capacityLineId)).toBe(String(f.line._id));
    expect(s.productionDeviceSync).toMatchObject({ forRevision: 1, desiredCodes: ["SJ-01"], productionAssigned: true, status: "pending_device_state" });
    expect(s.productionAssignmentHistory).toHaveLength(1);
    expect(s.productionAssignmentHistory[0]).toMatchObject({ kind: "assign", fromRevision: 0, toRevision: 1, previous: null });
  });

  test("an explicit legacy scanner code needs a reason and is recorded beside the canonical code", async () => {
    const f = await floor("Legacy");
    await rejectsWith(svc().assign(assignArgs(f, { legacyDeviceCode: "CT007" })), "LEGACY_CODE_REASON_REQUIRED");
    await rejectsWith(svc().assign(assignArgs(f, { legacyDeviceCode: "CT 007", legacyReason: "Floor scanner labels still use CT codes." })), "LEGACY_CODE_INVALID");
    await svc().assign(assignArgs(f, { legacyDeviceCode: "CT007", legacyReason: "Floor scanner labels still use CT codes." }));
    const a = (await machineState(f.machine._id)).productionAssignment;
    expect(a.canonicalOperationCode).toBe("SJ-01");
    expect(a.deviceOperationCodes).toEqual([{ code: "CT007", provenance: "explicit_legacy_override" }]);
    expect(a.legacyOverrideReason).toBe("Floor scanner labels still use CT codes.");
  });

  test("no implicit code mapping: a scanner reporting CT007 never becomes the SJ-01 assignment's code", async () => {
    const f = await floor("NoMap");
    const s = svc();
    await s.assign(assignArgs(f));
    await heartbeat(f.machine, ["CT007"], new Date(Date.now() + 1000));
    const { deviceSync } = await s.evaluate({ companyId: String(f.co._id), machineId: String(f.machine._id) });
    expect(deviceSync.desiredCodes).toEqual(["SJ-01"]);
    expect(deviceSync.status).toBe("drift");
    expect(deviceSync.reasons).toEqual(["unmapped_observed_codes", "unmapped:CT007"]);
    expect(deviceSync.instruction).toBeUndefined();
    expect((await machineState(f.machine._id)).productionAssignment.deviceOperationCodes).toEqual([{ code: "SJ-01", provenance: "canonical" }]);
  });

  test("every refusal: unclaimed, foreign, ineligible, inactive basis, missing row, finished work order", async () => {
    const f = await floor("Refuse");
    const loose = await machine();
    await rejectsWith(svc().assign(assignArgs(f, { machineId: String(loose._id) })), "MACHINE_UNCLAIMED");

    const other = await floor("RefuseOther");
    await rejectsWith(svc().assign(assignArgs(f, { machineId: String(other.machine._id) })), "MACHINE_NOT_FOUND");
    await rejectsWith(svc().assign(assignArgs(f, { workOrderId: String(other.wo._id) })), "WORK_ORDER_NOT_FOUND");
    await rejectsWith(svc().assign(assignArgs(f, { executionBasisId: String(other.basis.basisId) })), "EXECUTION_BASIS_NOT_FOUND");
    await rejectsWith(svc().assign(assignArgs(f, { operationRowId: "row-that-does-not-exist" })), "OPERATION_NOT_IN_BASIS");
    await rejectsWith(svc().assign(assignArgs(f, { capacityLineId: String(other.line._id) })), "PLANNING_LINE_MISMATCH");

    const repair = await floor("RefuseRepair", { machineOver: { status: "Repair Needed" } });
    await rejectsWith(svc().assign(assignArgs(repair)), "MACHINE_NOT_ELIGIBLE");

    for (const status of ["cancelled", "completed"]) {
      const done = await floor(`Refuse${status}`);
      await WorkOrder.collection.updateOne({ _id: done.wo._id }, { $set: { status } });
      await rejectsWith(svc().assign(assignArgs(done)), "WORK_ORDER_NOT_ASSIGNABLE");
    }

    // A superseded basis.
    const sup = await floor("RefuseSuperseded");
    const { pub2 } = await F.republish(sup);
    await F.svc().supersede({ companyId: String(sup.co._id), workOrderId: String(sup.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(sup.basis.basisId), reason: "Republished after the IE revision." });
    await rejectsWith(svc().assign(assignArgs(sup)), "EXECUTION_BASIS_NOT_ACTIVE");
    expect((await machineState(sup.machine._id)).productionAssignment).toBeUndefined();
  });

  test("a stale expected revision is refused", async () => {
    const f = await floor("Stale");
    await svc().assign(assignArgs(f));
    await expect(svc().reassign(assignArgs(f, { expectedRevision: 5, operationRowId: f.rowOf(1), reason: "Line balance change." })))
      .rejects.toMatchObject({ code: "ASSIGNMENT_REVISION_STALE", details: { currentRevision: 1, expectedRevision: 5 } });
  });
});

/* ══ CONCURRENCY ══════════════════════════════════════════════════════════ */

describe("concurrency", () => {
  test("concurrent assignments of one machine: exactly one wins", async () => {
    const f = await floor("RaceAssign");
    const outcomes = await Promise.allSettled([0, 1, 2].map((i) => svc().assign(assignArgs(f, { operationRowId: f.rowOf(i) }))));
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    for (const o of outcomes.filter((x) => x.status === "rejected")) {
      expect(["IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", "ASSIGNMENT_REVISION_STALE", "ASSIGNMENT_CONFLICT"]).toContain(o.reason.code);
    }
    const s = await machineState(f.machine._id);
    expect([s.productionAssignmentRevision, s.productionAssignmentHistory.length]).toEqual([1, 1]);
  });

  test("a basis supersession during the assignment: the assignment retries and refuses the old basis", async () => {
    const f = await floor("RaceBasis");
    const { pub2 } = await F.republish(f);
    let fired = 0;
    const racing = svc({ hooks: { beforeFence: async () => {
      if (fired++) return;
      await F.svc().supersede({ companyId: String(f.co._id), workOrderId: String(f.wo._id), publicationId: String(pub2._id),
        supersedesBasisId: String(f.basis.basisId), reason: "Republished while a machine was being assigned." });
    } } });
    await rejectsWith(racing.assign(assignArgs(f)), "EXECUTION_BASIS_NOT_ACTIVE");
    expect(fired).toBe(1); // attempt 1 was fenced out by the conflict; attempt 2 re-read and refused before reaching its fence
    expect((await machineState(f.machine._id)).productionAssignment).toBeUndefined();
  });

  test("an assignment committed first stays on the basis it was proved against", async () => {
    const f = await floor("RaceBasisAfter");
    await svc().assign(assignArgs(f));
    const { pub2 } = await F.republish(f);
    await F.svc().supersede({ companyId: String(f.co._id), workOrderId: String(f.wo._id), publicationId: String(pub2._id),
      supersedesBasisId: String(f.basis.basisId), reason: "Republished after the assignment." });
    const a = (await machineState(f.machine._id)).productionAssignment;
    expect(String(a.executionBasisId)).toBe(String(f.basis.basisId)); // was active at its commit; now visibly stale in flow
  });
});

/* ══ HISTORY AND IDEMPOTENCY ══════════════════════════════════════════════ */

describe("history and idempotency", () => {
  test("reassign and unassign keep the complete prior assignment, who, when and why", async () => {
    const f = await floor("History");
    const s = svc();
    await s.assign(assignArgs(f));
    const first = (await machineState(f.machine._id)).productionAssignment;
    await s.reassign(assignArgs(f, { expectedRevision: 1, operationRowId: f.rowOf(1), reason: "Moved to body attach." }));
    const second = (await machineState(f.machine._id)).productionAssignment;
    await s.unassign({ companyId: String(f.co._id), machineId: String(f.machine._id), expectedRevision: 2, reason: "End of order on this machine.", actor: editor });
    const st = await machineState(f.machine._id);
    expect(st.productionAssignment).toBeUndefined();
    expect(st.productionAssignmentRevision).toBe(3);
    expect(st.productionAssignmentHistory.map((t) => [t.kind, t.fromRevision, t.toRevision])).toEqual([["assign", 0, 1], ["reassign", 1, 2], ["unassign", 2, 3]]);
    expect(st.productionAssignmentHistory[1].previous).toEqual(first);
    expect(st.productionAssignmentHistory[2].previous).toEqual(second);
    expect(st.productionAssignmentHistory[2]).toMatchObject({ reason: "End of order on this machine.", actor: { name: "Line Supervisor" } });
    expect(st.productionDeviceSync).toMatchObject({ forRevision: 3, desiredCodes: [], productionAssigned: false });
    await rejectsWith(s.unassign({ companyId: String(f.co._id), machineId: String(f.machine._id), expectedRevision: 3, reason: "Nothing to end here.", actor: editor }), "NO_CURRENT_ASSIGNMENT");
    await rejectsWith(s.reassign(assignArgs(f, { expectedRevision: 3, reason: "short" })), "ASSIGNMENT_REASON_REQUIRED");
  });

  test("the history bound refuses rather than truncating", async () => {
    const f = await floor("Bound");
    const filler = Array.from({ length: ASSIGNMENT_LIMITS.HISTORY }, (_, i) => ({ kind: "assign", fromRevision: 100 + i, toRevision: 101 + i,
      at: new Date(), actor: { name: "old" }, reason: "", requestFingerprint: `old-${i}`, previous: null, nextAssignmentId: null }));
    await Machine.collection.updateOne({ _id: f.machine._id }, { $set: { productionAssignmentHistory: filler } });
    await rejectsWith(svc().assign(assignArgs(f)), "MACHINE_ASSIGNMENT_HISTORY_FULL");
    expect((await machineState(f.machine._id)).productionAssignmentHistory).toHaveLength(ASSIGNMENT_LIMITS.HISTORY);
  });

  test("an exact replay returns the committed result; a different request on the same revision is refused", async () => {
    const f = await floor("Replay");
    const first = await svc().assign(assignArgs(f, { reason: "Start of shift" }));
    const again = await svc().assign(assignArgs(f, { reason: "  Start   of shift ", actor: { name: "Delivery retry" } }));
    expect(again.reused).toBe(true);
    expect(String(again.assignment.assignmentId)).toBe(String(first.assignment.assignmentId));
    await expect(svc().assign(assignArgs(f, { operationRowId: f.rowOf(1), reason: "Start of shift" })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", status: 409 });
    expect((await machineState(f.machine._id)).productionAssignmentHistory).toHaveLength(1);
  });
});

/* ══ DEVICE SYNCHRONISATION ═══════════════════════════════════════════════ */

describe("device-verified synchronisation", () => {
  test("from a legacy code to canonical: safe delta, acknowledge, then applied only on a newer matching heartbeat", async () => {
    const f = await floor("Sync");
    const s = svc();
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await s.assign(assignArgs(f, { legacyDeviceCode: "CT007", legacyReason: "Floor labels still use CT codes." }));
    await s.reassign(assignArgs(f, { expectedRevision: 1, reason: "Scanner moves to canonical IE codes." }));

    expect((await s.evaluate(ids)).deviceSync.status).toBe("pending_device_state"); // no heartbeat yet

    await heartbeat(f.machine, ["CT007"], new Date(Date.now() + 1000));
    const ready = (await s.evaluate(ids)).deviceSync;
    expect(ready.status).toBe("ready_to_sync");
    expect(ready.instruction.payloads).toEqual(["opsgp:CT007,SJ-01"]);
    expect(ready.instruction.forRevision).toBe(2);
    expect((await s.evaluate(ids)).deviceSync.instruction.instructionId).toBe(ready.instruction.instructionId); // idempotent

    await rejectsWith(s.acknowledge({ ...ids, instructionId: ready.instruction.instructionId, revision: 1, actor: editor }), "SYNC_INSTRUCTION_STALE");
    const acked = await s.acknowledge({ ...ids, instructionId: ready.instruction.instructionId, revision: 2, actor: editor });
    expect(acked.deviceSync.status).toBe("awaiting_confirmation");
    expect((await s.acknowledge({ ...ids, instructionId: ready.instruction.instructionId, revision: 2, actor: editor })).reused).toBe(true);
    expect((await s.evaluate(ids)).deviceSync.status).toBe("awaiting_confirmation"); // same heartbeat: still waiting

    await heartbeat(f.machine, ["SJ-01"], new Date(Date.now() + 2000));
    const applied = (await s.evaluate(ids)).deviceSync;
    expect(applied).toMatchObject({ status: "applied", appliedRevision: 2 });
    expect(applied.observed.codes).toEqual(["SJ-01"]);
  });

  test("an old instruction cannot be acknowledged after a reassignment", async () => {
    const f = await floor("SyncOld");
    const s = svc();
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await s.assign(assignArgs(f));
    await heartbeat(f.machine, [], new Date(Date.now() + 1000));
    const ready = (await s.evaluate(ids)).deviceSync;
    await s.reassign(assignArgs(f, { expectedRevision: 1, operationRowId: f.rowOf(1), reason: "Line balance change." }));
    await rejectsWith(s.acknowledge({ ...ids, instructionId: ready.instruction.instructionId, revision: 1, actor: editor }), "SYNC_INSTRUCTION_STALE");
    const current = (await machineState(f.machine._id)).productionDeviceSync;
    expect([current.forRevision, current.instruction]).toEqual([2, undefined]);
  });

  test("unassignment ends Production immediately; the scanner may still hold old codes until verified", async () => {
    const f = await floor("SyncUnassign");
    const s = svc();
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await s.assign(assignArgs(f));
    await s.unassign({ ...ids, expectedRevision: 1, reason: "Order finished on this machine.", actor: editor });
    await heartbeat(f.machine, ["SJ-01", "ZZ-99"], new Date(Date.now() + 1000));
    const drift = (await s.evaluate(ids)).deviceSync;
    expect([drift.status, drift.productionAssigned]).toEqual(["drift", false]); // ZZ-99 was never assigned here
    await heartbeat(f.machine, ["SJ-01"], new Date(Date.now() + 2000));
    const ready = (await s.evaluate({ ...ids, reissue: true })).deviceSync;
    expect(ready.instruction.payloads).toEqual(["ops:SJ-01"]);
    const view = await s.machineView(ids);
    expect(view.deviceSync).toMatchObject({ productionAssigned: false, scannerMayHoldOldCodes: true, status: "ready_to_sync" });
    expect(view.assignment).toBeNull();
  });

  test("a processing failure leaves the assignment committed; a later evaluation applies the pending revision", async () => {
    const f = await floor("SyncFail");
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await svc().assign(assignArgs(f));
    const broken = svc({ loadHeartbeats: async () => { throw new Error("heartbeat store unreachable"); } });
    const failed = (await broken.evaluate(ids)).deviceSync;
    expect([failed.status, failed.lastError]).toEqual(["failed", "heartbeat store unreachable"]);
    expect((await machineState(f.machine._id)).productionAssignment.revision).toBe(1);
    // Offline is NOT a failure: no heartbeat at all is pending.
    expect((await svc().evaluate(ids)).deviceSync.status).toBe("pending_device_state");
    await heartbeat(f.machine, ["SJ-01"], new Date(Date.now() + 1000));
    expect((await svc().evaluate(ids)).deviceSync).toMatchObject({ status: "applied", appliedRevision: 1 });
  });

  test("a delayed evaluation can never overwrite a newer assignment's sync state", async () => {
    const f = await floor("SyncDelayed");
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await svc().assign(assignArgs(f));
    await heartbeat(f.machine, ["SJ-01"], new Date(Date.now() + 1000));
    const slow = svc({ loadHeartbeats: async (machineId) => {
      await svc().reassign(assignArgs(f, { expectedRevision: 1, operationRowId: f.rowOf(1), reason: "Reassigned mid-evaluation." }));
      return DeviceHeartbeat.find({ machineId }).lean();
    } });
    const out = await slow.evaluate(ids);
    expect(out.superseded).toBe(true);
    const st = (await machineState(f.machine._id)).productionDeviceSync;
    expect([st.forRevision, st.status, st.appliedRevision]).toEqual([2, "pending_device_state", null]);
  });

  test("generated payloads parse exactly as the firmware parses ops:/opsgp:", async () => {
    // A JS transcription of isOpsKeyword / isOpsGroupKeyword / extractOpName / extractGroupOps.
    const parse = (s) => (s.startsWith("opsgp:") ? s.substring(6).trim().split(",").map((t) => t.trim()).filter(Boolean).slice(0, 8)
      : s.startsWith("ops:") ? [s.substring(4)] : null);
    const f = await floor("SyncParse");
    const s = svc();
    const ids = { companyId: String(f.co._id), machineId: String(f.machine._id) };
    await s.assign(assignArgs(f, { legacyDeviceCode: "AP001", legacyReason: "Floor labels still use AP codes." }));
    await s.reassign(assignArgs(f, { expectedRevision: 1, reason: "Moving the scanner to canonical codes." }));
    await heartbeat(f.machine, ["AP001"], new Date(Date.now() + 1000));
    const { instruction } = (await s.evaluate(ids)).deviceSync;
    const toggled = instruction.payloads.flatMap(parse);
    expect(toggled).toEqual(instruction.toggles.map((t) => t.code));
    // Simulate the device: toggling each code from the observed state reaches exactly the desired state.
    const state = new Set(["ap001"]);
    for (const c of toggled) (state.has(c.toLowerCase()) ? state.delete(c.toLowerCase()) : state.add(c.toLowerCase()));
    expect([...state]).toEqual(["sj-01"]);
  });
});

/* ══ READS AND ISOLATION ══════════════════════════════════════════════════ */

describe("reads are company-isolated", () => {
  test("machine, WorkOrder, planning-line and operation queries", async () => {
    const f = await floor("Reads");
    const other = await floor("ReadsOther");
    const s = svc();
    await s.assign(assignArgs(f));
    await s.assign(assignArgs(other));
    const mine = String(f.co._id);
    await rejectsWith(s.machineView({ companyId: mine, machineId: String(other.machine._id) }), "MACHINE_NOT_FOUND");
    const byWo = await s.currentAssignments({ companyId: mine, workOrderId: String(f.wo._id) });
    expect(byWo.map((x) => x.machineId)).toEqual([String(f.machine._id)]);
    expect(await s.currentAssignments({ companyId: mine, workOrderId: String(other.wo._id) })).toEqual([]);
    expect((await s.currentAssignments({ companyId: mine, capacityLineId: String(f.line._id) })).map((x) => x.machineId)).toEqual([String(f.machine._id)]);
    expect(await s.currentAssignments({ companyId: mine, operationRowId: f.rowOf(2) })).toEqual([]);
    expect((await s.currentAssignments({ companyId: mine, operationRowId: f.rowOf(0) })).map((x) => x.machineId)).toEqual([String(f.machine._id)]);
    const assignable = await s.assignableOperations({ companyId: mine });
    expect(assignable.map((x) => x.workOrderId)).toEqual([String(f.wo._id)]);
    expect(assignable[0].operations.map((o) => o.code)).toEqual(["SJ-01", "BA-03", "HM-02"]);
  });
});

/* ══ FLOW ═════════════════════════════════════════════════════════════════ */

describe("flow reads the database assignment only", () => {
  test("edges resolve machines from assignments; scans and heartbeats never create one", async () => {
    const f = await floor("Flow");
    const bystander = await machine();
    await svc().claim({ machineId: String(bystander._id), companyId: String(f.co._id), reason: "Second machine on the line.", actor: admin, companyExists });
    // Historical scans and a heartbeat on the bystander, with the canonical code.
    await ProductionEvent.create({ eventId: `ma-${++seq}`, type: "scan", machineId: bystander._id, barcodeId: `WO-${String(f.wo._id).slice(-8)}-1`,
      workOrderKey: String(f.wo._id).slice(-8), unitNumber: 1, activeOps: ["SJ-01"], scanTime: new Date(Date.now() - 60e3), shiftDate: new Date() });
    await heartbeat(bystander, ["SJ-01"]);
    await svc().assign(assignArgs(f));

    const flow = createFlowTrackingService();
    const r = await flow.activeFlow({ companyId: String(f.co._id), capacityLineId: String(f.line._id) });
    const edge = r.workOrders[0].edges[0];
    expect(edge.currentContext).toMatchObject({ source: "server_owned_machine_assignment", status: "resolved",
      upstreamMachineIds: [String(f.machine._id)], downstreamMachineIds: [] });
    expect(edge.currentContext.upstream.assignments[0]).toMatchObject({ machineId: String(f.machine._id), revision: 1 });
    expect(await svc().currentAssignments({ companyId: String(f.co._id), workOrderId: String(f.wo._id) })).toHaveLength(1);

    const byMachine = await flow.activeFlow({ companyId: String(f.co._id), capacityLineId: String(f.line._id), machineId: String(bystander._id) });
    expect(byMachine.workOrders).toEqual([]); // scans and a heartbeat are not an assignment
  });

  test("zones fail closed without a company-owned layout, even when the shared default places the machine", async () => {
    const f = await floor("FlowZone");
    await svc().assign(assignArgs(f));
    await CanvasLayout.create({ organizationId: "default", machinePositions: [{ machineId: f.machine._id, x: 0, y: 0, zoneId: "LINE-01" }],
      chamberTemplates: [{ id: "LINE-01", name: "Line 1", x: 0, y: 0 }] });
    const flow = createFlowTrackingService();
    await expect(flow.activeFlow({ companyId: String(f.co._id), capacityLineId: String(f.line._id), zoneId: "LINE-01" }))
      .rejects.toMatchObject({ code: "ZONE_CONTEXT_UNAVAILABLE", status: 409 });
    await CanvasLayout.create({ organizationId: String(f.co._id), machinePositions: [{ machineId: f.machine._id, x: 0, y: 0, zoneId: "LINE-01" }],
      chamberTemplates: [{ id: "LINE-01", name: "Line 1", x: 0, y: 0 }] });
    const r = await flow.activeFlow({ companyId: String(f.co._id), capacityLineId: String(f.line._id), zoneId: "LINE-01" });
    expect(r.zoneScope).toMatchObject({ status: "resolved", machineIds: [String(f.machine._id)] });
    expect(r.workOrders).toHaveLength(1);
  });
});

/* ══ MODEL SAFETY ═════════════════════════════════════════════════════════ */

describe("generic Machine writes cannot inject or alter production state", () => {
  test("create, save, insertMany, update and replace shapes are refused; ordinary edits work", async () => {
    const forged = { productionOwnership: { companyId: new ObjectId(), claimedAt: new Date(), claimedBy: { name: "x" }, reason: "forged ownership" } };
    await expect(machine(forged)).rejects.toThrow(/machine-assignment service/);
    await expect(Machine.insertMany([{ name: "x", type: "x", model: "x", serialNumber: `SN-X-${++seq}`, powerConsumption: "1", location: "x",
      lastMaintenance: new Date(), nextMaintenance: new Date(), createdBy: new ObjectId(), productionAssignmentRevision: 4 }])).rejects.toThrow(/machine-assignment service/);

    const f = await floor("Guard");
    await svc().assign(assignArgs(f));
    const id = f.machine._id;
    for (const update of [
      { $set: { productionOwnership: null } }, { $unset: { productionAssignment: 1 } }, { $set: { "productionAssignment.operationRowId": "x" } },
      { $inc: { productionAssignmentRevision: 1 } }, { $push: { productionAssignmentHistory: {} } }, { $set: { "productionDeviceSync.status": "applied" } },
      { productionAssignment: null }, [{ $set: { productionAssignmentRevision: 0 } }], [{ $replaceWith: { _id: "$_id" } }],
    ]) {
      await expect(Machine.updateOne({ _id: id }, update)).rejects.toThrow(/machine-assignment service/);
      await expect(Machine.findByIdAndUpdate(id, update)).rejects.toThrow(/machine-assignment service/);
    }
    await expect(Machine.replaceOne({ _id: id }, { name: "x" })).rejects.toThrow(/replacement is refused/);
    const loaded = await Machine.findById(id).select("+productionDeviceSync");
    loaded.productionDeviceSync.status = "applied";
    await expect(loaded.save()).rejects.toThrow(/machine-assignment service/);

    // Ordinary register edits still work, and ordinary reads carry none of it.
    await Machine.updateOne({ _id: id }, { $set: { location: "Line 2" } });
    const plain = await Machine.findById(id);
    plain.status = "Idle";
    await plain.save();
    const lean = await Machine.findById(id).lean();
    for (const p of schemaModule.GUARDED_PATHS) expect(lean[p]).toBeUndefined();
    expect((await machineState(id)).productionAssignment.revision).toBe(1);
  });

  test("no new MongoDB collection is declared or created, and nothing writes Firebase", async () => {
    expect(mongoose.modelNames().filter((n) => /assignment|devicesync/i.test(n))).toEqual([]);
    const names = async () => (await mongoose.connection.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).sort();
    const f = await floor("Collections");
    await heartbeat(f.machine, []); // the heartbeat collection exists before, as it does live
    const before = await names();
    await svc().assign(assignArgs(f));
    await svc().evaluate({ companyId: String(f.co._id), machineId: String(f.machine._id) });
    expect(await names()).toEqual(before);
    const fs = require("fs");
    const path = require("path");
    for (const file of ["services/production/machineAssignment/assignment.service.js", "services/production/machineAssignment/deviceSync.rules.js",
      "services/production/machineAssignment/assignment.rules.js", "routes/CMS_Routes/Production/MachineAssignment/machineAssignmentRoutes.js"]) {
      expect(fs.readFileSync(path.join(__dirname, "../..", file), "utf8")).not.toMatch(/require\([^)]*firebase|from\s+["'][^"']*firebase/i);
    }
  });
});

/* ══ HTTP ═════════════════════════════════════════════════════════════════ */

describe("HTTP boundary", () => {
  test("commands answer committed separately from device state; an unknown outcome says so", async () => {
    const f = await floor("Http");
    const service = svc();
    const app = express();
    app.use(express.json());
    app.use("/ma", createMachineAssignmentRouter({
      authenticate: (req, _res, next) => { req.user = { id: editor.id, name: editor.name }; next(); },
      resolveCompany: (req, _res, next) => { req.merchandising = { companyId: String(f.co._id) }; next(); },
      requireEditor: (_q, _s, next) => next(), requireViewer: (_q, _s, next) => next(),
      requireAdmin: (_q, res) => res.status(403).json({ success: false }), companyExists,
      service: () => service,
    }));
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}/ma`;
    const post = (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));
    try {
      const body = { workOrderId: String(f.wo._id), executionBasisId: String(f.basis.basisId), operationRowId: f.rowOf(0), expectedRevision: 0,
        companyId: new ObjectId().toString(), canonicalOperationCode: "FORGED", deviceOperationCodes: ["FORGED"] };
      const created = await post(`/machines/${f.machine._id}/assign`, body);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ committed: true, reused: false, revision: 1,
        assignment: { operation: { canonicalCode: "SJ-01" }, deviceOperationCodes: [{ code: "SJ-01", provenance: "canonical" }] },
        deviceSync: { status: "pending_device_state", label: "Waiting for fresh scanner heartbeat" } });
      const stale = await post(`/machines/${f.machine._id}/assign`, { ...body, operationRowId: f.rowOf(1) });
      expect([stale.status, stale.body.code, stale.body.committed]).toEqual([409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST", false]);
    } finally { await new Promise((r) => server.close(r)); }
  });
});

/* ══ CAUSAL DEVICE EVIDENCE ════════════════════════════════════════════════ */

describe("device evidence is causal: a server-owned revision newer than the post-commit baseline", () => {
  const unknown = () => { const e = new Error("ack lost"); e.hasErrorLabel = (l) => l === "UnknownTransactionCommitResult"; return e; };
  /** A commit that lets a heartbeat be ingested just before it commits. */
  const heartbeatDuringCommit = (m, codes) => async (session) => {
    await heartbeat(m, codes);
    await session.commitTransaction();
  };
  const syncOf = async (id) => (await machineState(id)).productionDeviceSync;
  const ids = (f) => ({ companyId: String(f.co._id), machineId: String(f.machine._id) });
  const devId = (f) => `DEV-${String(f.machine._id).slice(-4)}`;
  const revOf = async (f) => (await DeviceHeartbeat.findOne({ deviceId: devId(f) }).lean())?.evidenceRevision;

  test("a heartbeat ingested before commit is captured in the baseline: not applied, no barcode", async () => {
    const f = await floor("CausalMatch");
    const out = await svc({ commit: heartbeatDuringCommit(f.machine, ["SJ-01"]) }).assign(assignArgs(f));
    expect(out.baseline).toEqual({ established: true, error: null });
    expect((await syncOf(f.machine._id)).evidenceBaseline.devices).toEqual([{ deviceId: devId(f), evidenceRevision: 1 }]);
    const evald = (await svc().evaluate(ids(f))).deviceSync;
    expect(evald).toMatchObject({ status: "pending_device_state", reasons: ["no_heartbeat_since_assignment_commit"], appliedRevision: null });
    expect(evald.instruction).toBeUndefined();
    await heartbeat(f.machine, ["SJ-01"]); // revision 2: ingested after the capture
    expect((await svc().evaluate(ids(f))).deviceSync).toMatchObject({ status: "applied", appliedRevision: 1, observed: { evidenceRevision: 2 } });
  });

  test("a mismatching pre-commit heartbeat cannot drive a barcode; the next revision can", async () => {
    const f = await floor("CausalNoBarcode");
    await svc({ commit: heartbeatDuringCommit(f.machine, []) }).assign(assignArgs(f));
    const evald = (await svc().evaluate(ids(f))).deviceSync;
    expect([evald.status, evald.instruction]).toEqual(["pending_device_state", undefined]);
    await heartbeat(f.machine, []);
    expect((await svc().evaluate(ids(f))).deviceSync.instruction.payloads).toEqual(["ops:SJ-01"]);
  });

  test("a future timestamp with an unchanged evidence revision does not qualify", async () => {
    const f = await floor("CausalFuture");
    await heartbeat(f.machine, ["CT007"]);
    await svc().assign(assignArgs(f));
    // Someone (or a clock jump) re-stamps the document without an ingest.
    await DeviceHeartbeat.updateOne({ deviceId: devId(f) }, { $set: { activeOps: ["SJ-01"], lastHeartbeatAt: new Date(Date.now() + 3600e3) } });
    expect(await revOf(f)).toBe(1);
    expect((await svc().evaluate(ids(f))).deviceSync).toMatchObject({ status: "pending_device_state", reasons: ["no_heartbeat_since_assignment_commit"] });
  });

  test("a historical heartbeat without a revision needs another heartbeat", async () => {
    const f = await floor("CausalHistorical");
    await DeviceHeartbeat.collection.insertOne({ deviceId: devId(f), machineId: f.machine._id, activeOps: ["SJ-01"], lastHeartbeatAt: new Date() });
    await svc().assign(assignArgs(f));
    expect((await syncOf(f.machine._id)).evidenceBaseline.devices).toEqual([{ deviceId: devId(f), evidenceRevision: 0 }]);
    expect((await svc().evaluate(ids(f))).deviceSync.status).toBe("pending_device_state");
    await heartbeat(f.machine, ["SJ-01"]); // 0 → 1
    expect((await svc().evaluate(ids(f))).deviceSync.status).toBe("applied");
  });

  test("a heartbeat racing between the baseline read and write qualifies — it was ingested after the commit", async () => {
    const f = await floor("CausalRace");
    await heartbeat(f.machine, ["CT007"]); // revision 1, before
    const racing = svc({ hooks: { betweenBaselineReadAndWrite: () => heartbeat(f.machine, ["SJ-01"]) } }); // revision 2, during
    await racing.assign(assignArgs(f));
    expect((await syncOf(f.machine._id)).evidenceBaseline.devices).toEqual([{ deviceId: devId(f), evidenceRevision: 1 }]);
    expect((await svc().evaluate(ids(f))).deviceSync).toMatchObject({ status: "applied", observed: { evidenceRevision: 2 } });
  });

  test("replay never resets the baseline", async () => {
    const f = await floor("CausalReplay");
    await heartbeat(f.machine, ["CT007"]);
    await svc().assign(assignArgs(f, { reason: "Start of shift" }));
    const first = await syncOf(f.machine._id);
    await heartbeat(f.machine, ["SJ-01"]);
    const replay = await svc().assign(assignArgs(f, { reason: "Start of shift" }));
    expect([replay.reused, replay.baseline.established]).toEqual([true, false]);
    const after = await syncOf(f.machine._id);
    expect(after.evidenceBaseline).toEqual(first.evidenceBaseline);
    expect(after.confirmationBoundaryAt.getTime()).toBe(first.confirmationBoundaryAt.getTime());
    expect((await svc().evaluate(ids(f))).deviceSync.status).toBe("applied"); // the post-baseline heartbeat still counts
  });

  test("an uncertain commit confirmed by the primary read establishes the baseline; a failed capture recovers later", async () => {
    const script = ["commit+lose", "lose", "lose"];
    const uncertain = (extra = {}) => { let n = 0; return svc({ ...extra, commit: async (session) => {
      if (script[n++] === "commit+lose") await session.commitTransaction();
      throw unknown();
    } }); };
    const f = await floor("CausalUncertain");
    const out = await uncertain().assign(assignArgs(f));
    expect(out).toMatchObject({ reused: true, commitOutcome: "confirmed_by_revision", baseline: { established: true } });
    expect((await syncOf(f.machine._id)).evidenceBaseline).not.toBeNull();

    const g = await floor("CausalUncertainFail");
    const out2 = await uncertain({ hooks: { beforeBaseline: () => { throw new Error("database unreachable after commit"); } } }).assign(assignArgs(g));
    expect(out2.baseline).toEqual({ established: false, error: "database unreachable after commit" });
    expect((await syncOf(g.machine._id)).evidenceBaseline).toBeNull();
    const evald = (await svc().evaluate(ids(g))).deviceSync; // captures first, then evaluates
    expect(evald.evidenceBaseline).not.toBeNull();
    expect(evald.status).toBe("pending_device_state");
  });

  test("while the baseline cannot be captured the assignment stands and the device stays pending", async () => {
    const f = await floor("CausalFail");
    const failing = svc({ hooks: { beforeBaseline: () => { throw new Error("baseline capture refused"); } } });
    expect((await failing.assign(assignArgs(f))).reused).toBe(false);
    expect((await machineState(f.machine._id)).productionAssignment.revision).toBe(1);
    await heartbeat(f.machine, ["SJ-01"]);
    const stillPending = (await failing.evaluate(ids(f))).deviceSync;
    expect(stillPending).toMatchObject({ status: "pending_device_state", reasons: ["evidence_baseline_not_established"], evidenceBaseline: null });
    expect(stillPending.instruction).toBeUndefined();
    // A healthy evaluation captures the baseline (which includes that heartbeat) — so it still waits.
    expect((await svc().evaluate(ids(f))).deviceSync.status).toBe("pending_device_state");
    await heartbeat(f.machine, ["SJ-01"]);
    expect((await svc().evaluate(ids(f))).deviceSync.status).toBe("applied");
  });

  test("a delayed baseline write for an old revision cannot touch a newer assignment", async () => {
    const f = await floor("CausalDelayed");
    await svc({ hooks: { beforeBaseline: ({ revision }) => { if (revision === 1) throw new Error("slow"); } } }).assign(assignArgs(f));
    expect((await syncOf(f.machine._id)).evidenceBaseline).toBeNull();
    await heartbeat(f.machine, ["CT007"]);
    await svc().reassign(assignArgs(f, { expectedRevision: 1, operationRowId: f.rowOf(1), reason: "Line balance change." }));
    const rev2 = await syncOf(f.machine._id);
    await heartbeat(f.machine, ["BA-03"]);
    expect((await svc().establishBaseline(String(f.co._id), String(f.machine._id), 1)).established).toBe(false);
    const after = await syncOf(f.machine._id);
    expect([after.forRevision, after.evidenceBaseline]).toEqual([2, rev2.evidenceBaseline]);
  });

  test.each(["assign", "reassign", "unassign"])("%s follows the identical evidence rule", async (kind) => {
    const f = await floor(`Causal ${kind}`);
    const s = svc();
    if (kind !== "assign") await s.assign(assignArgs(f));
    const desired = kind === "unassign" ? [] : kind === "reassign" ? ["BA-03"] : ["SJ-01"];
    const during = svc({ commit: heartbeatDuringCommit(f.machine, desired) });
    if (kind === "assign") await during.assign(assignArgs(f));
    if (kind === "reassign") await during.reassign(assignArgs(f, { expectedRevision: 1, operationRowId: f.rowOf(1), reason: "Line balance change." }));
    if (kind === "unassign") await during.unassign({ ...ids(f), expectedRevision: 1, reason: "Order finished on this machine.", actor: editor });
    const revision = kind === "assign" ? 1 : 2;
    const pre = (await s.evaluate(ids(f))).deviceSync;
    expect([pre.status, pre.instruction, pre.appliedRevision]).toEqual(["pending_device_state", undefined, null]);
    await heartbeat(f.machine, desired);
    expect((await s.evaluate(ids(f))).deviceSync).toMatchObject({ status: "applied", appliedRevision: revision });
  });

  test("the real ingest route increments the revision and ignores one sent by the device", async () => {
    const app = express();
    app.use(express.json());
    app.use("/scanner", require("../../routes/Barcode_Scan_Punchings/scannerIngestRoutes"));
    const server = await new Promise((r) => { const s2 = app.listen(0, () => r(s2)); });
    const m = await machine();
    try {
      const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/scanner/heartbeat`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await post({ deviceId: "DEV-INGEST", machineId: String(m._id), activeOps: "SJ-01", evidenceRevision: 999 });
      await post({ deviceId: "DEV-INGEST", machineId: String(m._id), activeOps: "SJ-01", evidenceRevision: 999 });
      const doc = await DeviceHeartbeat.findOne({ deviceId: "DEV-INGEST" }).lean();
      expect([doc.evidenceRevision, doc.activeOps]).toEqual([2, ["SJ-01"]]);
    } finally { await new Promise((r) => server.close(r)); }
  });
});
