const test = require("node:test");
const assert = require("node:assert/strict");
const { createFlowTrackingService, FlowTrackingError, workOrderScopeFilter, defaultLoaders } = require("./flowTracking.service");

const CO_A = "64000000000000000000000a";
const CO_B = "64000000000000000000000b";
const WO_A = "66f0a1b2c3d4e5f6a7b81842"; // company A, line A1
const WO_A2 = "66f0a1b2c3d4e5f6a7b82222"; // company A, no basis
const WO_A3 = "66f0a1b2c3d4e5f6a7b83333"; // company A, line A2
const WO_B = "66f0a1b2c3d4e5f6a7b89999"; // company B
const WO_LEGACY = "66f0a1b2c3d4e5f6a7b87777"; // no company link
const LINE_A1 = "680000000000000000000a01";
const LINE_A2 = "680000000000000000000a02";
const LINE_B1 = "680000000000000000000b01";
const M1 = "650000000000000000000001";
const NOW = new Date("2026-09-28T10:00:00.000Z");
const at = (m) => new Date(NOW.getTime() - m * 60000);

const basis = (companyId, workOrderId, lineId, codes, over = {}) => ({
  basisId: over.basisId || `69000000000000000000${workOrderId.slice(-4)}`,
  basisRef: `PEB-${workOrderId.slice(-8)}-V1`, versionNo: 1, receiptKey: `${companyId}:${workOrderId}:p`,
  state: "ACTIVE", companyId, workOrderId, effectiveFrom: at(24 * 60), effectiveUntil: null,
  planningLine: { capacityLineId: lineId, lineRef: `REF-${lineId.slice(-3)}`, lineRevision: 1, factoryRefDisplay: "UNIT-1" },
  ieRelease: { ieReleaseId: "670000000000000000000001", releaseRef: "IER-1", versionNo: 1 },
  route: codes.map((c, i) => ({ rowId: `r${i + 1}`, sequence: i + 1, ieOperationId: `op${i + 1}`, ieOperationRevision: 1, operationCode: c, operationName: c })),
  ...over,
});
const wo = (id, companyId, bases, over = {}) => ({
  _id: id, workOrderNumber: `WO-${id.slice(-4)}`, quantity: 100, status: "in_progress",
  salesLineLink: companyId ? { companyId } : undefined,
  operations: [{ operationCode: "P001" }, { operationCode: "P002" }],
  productionExecutionBases: bases,
  ...over,
});
const scan = (woId, unit, code, m, machineId = M1) => ({
  type: "scan", workOrderKey: woId.slice(-8), unitNumber: unit, activeOps: [code], scanTime: at(m), machineId,
});

function world() {
  return {
    workOrders: [
      wo(WO_A, CO_A, [basis(CO_A, WO_A, LINE_A1, ["SJ-01", "BA-03"])]),
      wo(WO_A2, CO_A, undefined),
      wo(WO_A3, CO_A, [basis(CO_A, WO_A3, LINE_A2, ["SJ-01", "BA-03"])]),
      wo(WO_B, CO_B, [basis(CO_B, WO_B, LINE_B1, ["SJ-01", "BA-03"])]),
      wo(WO_LEGACY, null, undefined),
    ],
    lines: [
      { _id: LINE_A1, companyId: CO_A, lineRef: "REF-a01", name: "Line A1", revision: 1, status: "ACTIVE", factoryRef: "UNIT-1" },
      { _id: LINE_A2, companyId: CO_A, lineRef: "REF-a02", name: "Line A2", revision: 1, status: "ACTIVE", factoryRef: "UNIT-1" },
      { _id: LINE_B1, companyId: CO_B, lineRef: "REF-b01", name: "Line B1", revision: 1, status: "ACTIVE", factoryRef: "UNIT-1" },
    ],
    events: [
      ...[1, 2, 3, 4].map((u) => scan(WO_A, u, "SJ-01", 30)),
      scan(WO_A, 1, "BA-03", 10),
      ...[1, 2, 3].map((u) => scan(WO_B, u, "SJ-01", 30)),
      ...[1, 2].map((u) => scan(WO_A2, u, "SJ-01", 30)),
    ],
  };
}

/* Loaders that honour the company filter as the real Mongo queries do, plus a
   `leaky` switch that ignores it — to prove the service re-checks. */
function stubService(w = world(), { leaky = false } = {}) {
  const calls = [];
  const owned = (companyId) => (r) => leaky || String(r.salesLineLink?.companyId ?? r.companyId) === String(companyId);
  const service = createFlowTrackingService({
    workOrderById: async (companyId, id) => { calls.push(companyId); return w.workOrders.find((x) => x._id === id && owned(companyId)(x)) || null; },
    activeWorkOrders: async (companyId) => { calls.push(companyId); return w.workOrders.filter(owned(companyId)); },
    capacityLine: async (companyId, id) => { calls.push(companyId); return w.lines.find((l) => l._id === id && owned(companyId)(l)) || null; },
    lineProvenByBasis: async (companyId, id) => { calls.push(companyId); return w.workOrders.some((x) => owned(companyId)(x)
      && (x.productionExecutionBases || []).some((b) => String(b.companyId) === String(companyId) && String(b.planningLine.capacityLineId) === id)); },
    scanEvents: async (ids) => w.events.filter((e) => ids.some((id) => id.slice(-8) === e.workOrderKey)),
    collidingShortIds: async () => new Set(),
    currentAssignments: async (companyId, ids) => (w.machines || []).filter((m) => (leaky || String(m.productionOwnership?.companyId) === String(companyId))
      && ids.includes(String(m.productionAssignment?.workOrderId))),
    ownedMachineIds: async (companyId, ids) => (w.machines || []).filter((m) => (leaky || String(m.productionOwnership?.companyId) === String(companyId))
      && ids.includes(String(m._id))).map((m) => String(m._id)),
    companyCanvasLayout: async (companyId) => (w.layouts || []).find((l) => l.organizationId === String(companyId)) || null,
  }, { now: () => NOW });
  return { service, calls };
}

test("the work-order filter is the Sales-line company link and nothing else", () => {
  const f = workOrderScopeFilter(CO_A);
  assert.deepEqual(Object.keys(f), ["salesLineLink.companyId"]);
  assert.equal(String(f["salesLineLink.companyId"]), CO_A);
});

test("the real loaders resolve every model they query (no database needed)", () => {
  const loaders = defaultLoaders();
  for (const name of ["workOrderById", "activeWorkOrders", "capacityLine", "lineProvenByBasis", "scanEvents", "collidingShortIds",
    "currentAssignments", "ownedMachineIds", "companyCanvasLayout"]) {
    assert.equal(typeof loaders[name], "function", name);
  }
  assert.equal(loaders.heartbeats, undefined); // heartbeats are not a flow source
});

test("flow requires one planning line; a company-wide projection is refused", async () => {
  const { service } = stubService();
  for (const capacityLineId of [undefined, null, ""]) {
    await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId }), (e) => e.status === 400 && e.code === "PLANNING_LINE_SCOPE_REQUIRED");
  }
  await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: "bad" }), (e) => e.code === "INVALID_ID");
});

test("a foreign-company planning line is not found", async () => {
  const { service } = stubService();
  await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: LINE_B1 }), (e) => e.status === 404 && e.code === "CAPACITY_LINE_NOT_FOUND");
  const leaky = stubService(world(), { leaky: true }).service;
  await assert.rejects(leaky.activeFlow({ companyId: CO_A, capacityLineId: LINE_B1 }), (e) => e.code === "CAPACITY_LINE_NOT_FOUND");
});

test("the line view returns only this company's work whose basis froze this line", async () => {
  const { service, calls } = stubService();
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW });
  assert.deepEqual(r.workOrders.map((w) => w.workOrderId), [WO_A]);
  assert.equal(r.activeWorkOrdersWithoutExecutionBasis, 1); // WO_A2
  assert.equal(r.projection, "planning_line");
  assert.deepEqual(r.siteScope, { status: "not_modelled" });
  assert.deepEqual(r.physicalLineMapping, { status: "unavailable" });
  assert.deepEqual(r.planningLineScope, {
    capacityLineId: LINE_A1, proof: "production_execution_basis", currentRecordStatus: "available",
    current: { lineRef: "REF-a01", revision: 1, name: "Line A1", factoryRefDisplay: "UNIT-1", factoryRefAuthoritative: false },
  });
  assert.equal(r.workOrders[0].planningLineScope.source, "frozen_execution_basis");
  assert.deepEqual(r.machineContext, { source: "server_owned_machine_assignment", status: "resolved", reasons: [] });
  assert.deepEqual([r.workOrders[0].edges[0].completedUpstream, r.workOrders[0].edges[0].wipPieces], [4, 3]);
  assert.ok(calls.every((c) => c === CO_A));

  const a2 = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A2, asOf: NOW });
  assert.deepEqual(a2.workOrders.map((w) => w.workOrderId), [WO_A3]);
});

test("rows a leaky loader returns from another company are dropped", async () => {
  const { service } = stubService(world(), { leaky: true });
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW });
  assert.deepEqual(r.workOrders.map((w) => w.workOrderId), [WO_A]);
  // A basis stamped with another company on an own work order never applies.
  const w = world();
  w.workOrders[0].productionExecutionBases[0].companyId = CO_B;
  assert.deepEqual((await stubService(w).service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW })).workOrders, []);
});

test("factoryRef changes identity nothing and history nothing", async () => {
  const w = world();
  const { service } = stubService(w);
  const before = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: at(5) });
  w.lines[0].factoryRef = "SOMEWHERE-ELSE";
  w.lines[1].factoryRef = "UNIT-1"; // the other line now "shares" a factory label: irrelevant
  const after = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: at(5) });
  assert.deepEqual(after.workOrders, before.workOrders);
  assert.equal(after.planningLineScope.capacityLineId, LINE_A1);
  assert.equal(after.planningLineScope.current.factoryRefDisplay, "SOMEWHERE-ELSE");
  assert.equal(after.workOrders[0].planningLineScope.factoryRefDisplay, "UNIT-1"); // frozen
});

const M2 = "650000000000000000000002";
const M9 = "650000000000000000000009";
const assignedMachine = (id, companyId, workOrderId, rowId, basisId) => ({
  _id: id, productionOwnership: { companyId },
  productionAssignment: { assignmentId: `as-${id.slice(-1)}`, revision: 2, companyId, workOrderId, executionBasisId: basisId, operationRowId: rowId },
});

test("machine narrowing resolves only from this company's current assignments", async () => {
  const w = world();
  const basisA = w.workOrders[0].productionExecutionBases[0].basisId;
  w.machines = [assignedMachine(M1, CO_A, WO_A, "r2", basisA), assignedMachine(M9, CO_B, WO_B, "r1", w.workOrders[3].productionExecutionBases[0].basisId)];
  const { service } = stubService(w);
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, machineId: M1, asOf: NOW });
  assert.deepEqual(r.workOrders.map((x) => x.workOrderId), [WO_A]);
  assert.deepEqual(r.workOrders[0].edges[0].currentContext.downstreamMachineIds, [M1]);
  // Another company's machine, and a machine nobody owns, are not found.
  for (const id of [M9, M2]) {
    await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, machineId: id, asOf: NOW }),
      (e) => e.status === 404 && e.code === "MACHINE_NOT_FOUND");
  }
  // Historical scans on M1 without an assignment, or a heartbeat, never qualify another machine.
  w.machines = [];
  const none = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW });
  assert.deepEqual(none.workOrders[0].edges[0].currentContext.upstreamMachineIds, []);
});

test("zones need a company-owned layout; the shared default never counts", async () => {
  const w = world();
  const basisA = w.workOrders[0].productionExecutionBases[0].basisId;
  w.machines = [assignedMachine(M1, CO_A, WO_A, "r1", basisA)];
  w.layouts = [{ organizationId: "default", machinePositions: [{ machineId: M1, zoneId: "LINE-01" }], chamberTemplates: [{ id: "LINE-01" }] }];
  const { service } = stubService(w);
  await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, zoneId: "LINE-01", asOf: NOW }),
    (e) => e.status === 409 && e.code === "ZONE_CONTEXT_UNAVAILABLE");
  w.layouts.push({ organizationId: CO_A, machinePositions: [{ machineId: M1, zoneId: "LINE-01" }, { machineId: M9, zoneId: "LINE-01" }], chamberTemplates: [{ id: "LINE-01" }] });
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, zoneId: "LINE-01", asOf: NOW });
  assert.deepEqual(r.zoneScope, { status: "resolved", zoneId: "LINE-01", layoutOwner: CO_A, machineIds: [M1] }); // M9 is not ours
  assert.deepEqual(r.workOrders.map((x) => x.workOrderId), [WO_A]);
});

test("machine or zone narrowing of a historical asOf is refused; plain historical flow says context is unavailable", async () => {
  const { service } = stubService();
  const past = new Date(NOW.getTime() - 3600e3);
  await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, machineId: M1, asOf: past }),
    (e) => e.status === 409 && e.code === "MACHINE_CONTEXT_REQUIRES_CURRENT_ASOF");
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: past });
  assert.deepEqual(r.machineContext, { source: "server_owned_machine_assignment", status: "unavailable",
    reasons: ["current_assignment_not_applicable_to_historical_asof"] });
});

test("a work order outside the acting company is a 404 that reveals nothing", async () => {
  const { service } = stubService();
  for (const id of [WO_B, WO_LEGACY, "66f0a1b2c3d4e5f6a7b80000"]) {
    await assert.rejects(service.workOrderFlow({ companyId: CO_A, workOrderId: id, asOf: NOW }), (e) => {
      assert.ok(e instanceof FlowTrackingError);
      assert.deepEqual(e.toResponse(), { success: false, code: "NOT_FOUND", message: "No work order of your company has that id." });
      return e.status === 404;
    });
  }
  const leaky = stubService(world(), { leaky: true }).service;
  await assert.rejects(leaky.workOrderFlow({ companyId: CO_A, workOrderId: WO_B, asOf: NOW }), (e) => e.status === 404);
});

test("missing company context fails closed before any read", async () => {
  const { service, calls } = stubService();
  for (const companyId of [undefined, null, "", "not-an-id"]) {
    await assert.rejects(service.activeFlow({ companyId, capacityLineId: LINE_A1 }), (e) => e.status === 403 && e.code === "COMPANY_CONTEXT_REQUIRED");
    await assert.rejects(service.workOrderFlow({ companyId, workOrderId: WO_A }), (e) => e.status === 403);
    await assert.rejects(service.operationCodeReconciliation({ companyId }), (e) => e.status === 403);
  }
  assert.equal(calls.length, 0);
});

test("a work order with scans but no execution basis is unknown — its editable route is never used", async () => {
  const { service } = stubService();
  const r = await service.workOrderFlow({ companyId: CO_A, workOrderId: WO_A2, asOf: NOW });
  assert.deepEqual([r.confidence, r.reasons, r.edges], ["unknown", ["production_execution_basis_unavailable"], []]);
});

test("existing work orders without the field keep working (backward compatible)", async () => {
  const w = world();
  delete w.workOrders[1].productionExecutionBases; // absent, not empty
  const { service } = stubService(w);
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW });
  assert.equal(r.activeWorkOrdersWithoutExecutionBasis, 1);
});

test("operationCodeReconciliation reports per scoped work order against the execution basis", async () => {
  const w = world();
  w.events.push(scan(WO_A, 5, "CT007", 5), scan(WO_A2, 1, "AP001", 5));
  const { service } = stubService(w);
  const r = await service.operationCodeReconciliation({ companyId: CO_A, asOf: NOW });
  assert.equal(r.workOrders, 3);
  const a = r.rows.find((x) => x.workOrderId === WO_A);
  assert.deepEqual([a.matchedCodes, a.unmatchedDeviceCodes, a.projectable], [["ba-03", "sj-01"], ["ct007"], true]);
  const a2 = r.rows.find((x) => x.workOrderId === WO_A2);
  assert.deepEqual([a2.blockingReasons, a2.editableRouteCodes], [["production_execution_basis_unavailable"], ["P001", "P002"]]);
});

test("a deleted planning line stays readable through execution-basis proof; unproven ids do not", async () => {
  const w = world();
  w.lines = w.lines.filter((l) => l._id !== LINE_A1); // today's record is gone
  const { service } = stubService(w);
  const r = await service.activeFlow({ companyId: CO_A, capacityLineId: LINE_A1, asOf: NOW });
  assert.deepEqual([r.planningLineScope.proof, r.planningLineScope.currentRecordStatus, r.planningLineScope.current],
    ["production_execution_basis", "missing", null]);
  assert.deepEqual(r.workOrders.map((x) => x.workOrderId), [WO_A]);
  // Company B's deleted line, and an id nobody ever used: the same 404.
  w.lines = w.lines.filter((l) => l._id !== LINE_B1);
  for (const id of [LINE_B1, "680000000000000000000fff"]) {
    await assert.rejects(service.activeFlow({ companyId: CO_A, capacityLineId: id }), (e) => e.status === 404 && e.code === "CAPACITY_LINE_NOT_FOUND");
  }
});
