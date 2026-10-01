const test = require("node:test");
const assert = require("node:assert/strict");
const {
  computeWorkOrderFlow, classifyTrend, predictDependency, routeFromExecutionBasis, reconcileOperationCodes,
  CONFIDENCE, TREND, CONTEXT,
} = require("./flowWip");

// ── Fixtures ────────────────────────────────────────────────────────────────
const COMPANY = "64000000000000000000000a";
const OTHER_COMPANY = "64000000000000000000000b";
const WO_A = "66f0a1b2c3d4e5f6a7b81842";
const WO_B = "66f0a1b2c3d4e5f6a7b89999";
const RELEASE_1 = "670000000000000000000001";
const M1 = "650000000000000000000001";
const M2 = "650000000000000000000002";
const M3 = "650000000000000000000003";
const AS_OF = new Date("2026-09-28T10:00:00.000Z");
const minsAgo = (m) => new Date(AS_OF.getTime() - m * 60 * 1000);

const LINE = "680000000000000000000001";
/* One embedded Production execution basis, as the receipt command writes it. */
const basisOf = (codes, over = {}) => ({
  basisId: over.basisId || "690000000000000000000001",
  basisRef: "PEB-a7b81842-V1",
  versionNo: 1,
  receiptKey: "k1",
  state: "ACTIVE",
  companyId: COMPANY,
  workOrderId: over.workOrderId || WO_A,
  effectiveFrom: minsAgo(24 * 60),
  effectiveUntil: null,
  planningLine: { capacityLineId: LINE, lineRef: "LINE-A", lineRevision: 3, factoryRefDisplay: "UNIT-1" },
  ieRelease: { ieReleaseId: RELEASE_1, releaseRef: "IER-1", versionNo: 1 },
  route: codes.map((code, i) => ({
    rowId: `row-${(i + 1) * 10}`, sequence: i + 1, ieOperationId: `ieop-${i + 1}`,
    ieOperationRevision: 1, operationCode: code, operationName: `Operation ${code}`,
    standardTimeMinutes: i + 1, standardTimeSource: "ie_release",
  })),
  ...over,
});
const frozen = (codes, workOrderId = WO_A, bases = [basisOf(codes, { workOrderId })]) =>
  routeFromExecutionBasis({ workOrder: { _id: workOrderId, productionExecutionBases: bases }, companyId: COMPANY, asOf: AS_OF });
const ROUTE = frozen(["SJ-01", "BA-03", "HM-02"]);

const workOrder = (over = {}) => ({
  _id: WO_A, workOrderNumber: "WO-1842", quantity: 200, status: "in_progress",
  // The editable route: deliberately different from the frozen one, and never read.
  operations: [{ _id: "x", operationCode: "P001" }, { _id: "y", operationCode: "P002" }],
  ...over,
});

let seq = 0;
const scan = (unit, code, minutesAgo, over = {}) => ({
  eventId: `dev-1-${++seq}`,
  type: "scan",
  workOrderKey: (over.workOrderId || WO_A).slice(-8),
  barcodeId: `WO-${(over.workOrderId || WO_A).slice(-8)}-${String(unit).padStart(3, "0")}`,
  unitNumber: unit,
  activeOps: Array.isArray(code) ? code : [code],
  scanTime: minsAgo(minutesAgo),
  machineId: over.machineId || M1,
  operatorId: over.operatorId,
  timeRecovered: Boolean(over.timeRecovered),
});
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const flow = (wo, events, opts = {}) => computeWorkOrderFlow(wo, events, { route: ROUTE, asOf: AS_OF, windowMinutes: 60, ...opts });
const heartbeat = (machineId, ops, minutesAgo = 1) => ({ machineId, activeOps: ops, lastHeartbeatAt: minsAgo(minutesAgo) });
const assignmentOf = (heartbeats) => currentAssignmentFromHeartbeats(heartbeats, { asOf: AS_OF, now: AS_OF, staleMs: 180000 });

// ═══ Defect 1 — frozen identity, never the editable route ═══════════════════
test("the operation sequence and ids come from the frozen release, not WorkOrder.operations", () => {
  const r = flow(workOrder(), [scan(1, "SJ-01", 10)]);
  assert.deepEqual(r.operations.map((o) => [o.operationId, o.sequence, o.operationCode]),
    [["row-10", 1, "SJ-01"], ["row-20", 2, "BA-03"], ["row-30", 3, "HM-02"]]);
  assert.equal(r.route.status, "frozen");
  assert.equal(r.route.basis.ieReleaseId, RELEASE_1);
  assert.equal(r.route.basis.identityBasis, "frozen_release_operation_code");
});

test("regression: editing the current route cannot change a historical asOf answer", () => {
  const events = [...range(1, 30).map((u) => scan(u, "SJ-01", 90)), ...range(1, 12).map((u) => scan(u, "BA-03", 40))];
  const before = flow(workOrder(), events);
  const edited = workOrder({
    operations: [{ _id: "z", operationCode: "BA-03" }, { _id: "x", operationCode: "SJ-01" }, { _id: "q", operationCode: "NEW-9" }],
  });
  const after = flow(edited, events);
  assert.deepEqual(after, before);
  assert.equal(after.edges[0].wipPieces, 18);
});

test("no execution basis: unknown with production_execution_basis_unavailable, no fallback", () => {
  const none = routeFromExecutionBasis({ workOrder: { _id: WO_A }, companyId: COMPANY, asOf: AS_OF });
  const wo = workOrder({ operations: [{ operationCode: "SJ-01" }, { operationCode: "BA-03" }] });
  const r = computeWorkOrderFlow(wo, [scan(1, "SJ-01", 10), scan(1, "BA-03", 5)], { route: none, asOf: AS_OF });
  assert.equal(r.confidence, CONFIDENCE.UNKNOWN);
  assert.deepEqual(r.reasons, ["production_execution_basis_unavailable"]);
  assert.deepEqual(r.edges, []);
  assert.deepEqual(computeWorkOrderFlow(wo, [], { asOf: AS_OF }).reasons, ["production_execution_basis_unavailable"]);
});

test("execution basis: asOf picks the version in force; foreign or mismatched bases never apply", () => {
  const V1 = "690000000000000000000001";
  const V2 = "690000000000000000000002";
  const switchAt = minsAgo(30);
  const bases = [
    basisOf(["A1", "A2"], { basisId: V1, versionNo: 1, state: "SUPERSEDED", effectiveUntil: switchAt }),
    basisOf(["B1", "B2"], { basisId: V2, versionNo: 2, effectiveFrom: switchAt }),
  ];
  const wo = { _id: WO_A, productionExecutionBases: bases };
  const at = (asOf) => routeFromExecutionBasis({ workOrder: wo, companyId: COMPANY, asOf });
  assert.equal(at(minsAgo(60)).basis.executionBasisId, V1);
  assert.deepEqual(at(minsAgo(60)).rows.map((r) => r.operationCode), ["A1", "A2"]);
  assert.equal(at(AS_OF).basis.executionBasisId, V2);
  assert.equal(at(switchAt).basis.executionBasisId, V2); // the boundary belongs to the successor
  assert.equal(at(minsAgo(48 * 60)).reason, "production_execution_basis_unavailable"); // before any receipt

  const foreign = { _id: WO_A, productionExecutionBases: [basisOf(["A"], { companyId: OTHER_COMPANY })] };
  assert.equal(routeFromExecutionBasis({ workOrder: foreign, companyId: COMPANY, asOf: AS_OF }).status, "unavailable");
  const otherWo = { _id: WO_A, productionExecutionBases: [basisOf(["A"], { workOrderId: WO_B })] };
  assert.equal(routeFromExecutionBasis({ workOrder: otherWo, companyId: COMPANY, asOf: AS_OF }).status, "unavailable");
  // Two versions claiming the same instant is impossible; it is refused, never resolved by picking one.
  const overlap = { _id: WO_A, productionExecutionBases: [basisOf(["A"]), basisOf(["B"], { basisId: V2 })] };
  assert.equal(routeFromExecutionBasis({ workOrder: overlap, companyId: COMPANY, asOf: AS_OF }).status, "unavailable");
});

test("the flow carries planning-line scope, and never a site or a physical line", () => {
  const r = flow(workOrder(), [scan(1, "SJ-01", 10)]);
  assert.deepEqual(r.planningLineScope, { source: "frozen_execution_basis", capacityLineId: LINE, lineRef: "LINE-A", revision: 3, factoryRefDisplay: "UNIT-1", factoryRefAuthoritative: false });
  assert.deepEqual(r.siteScope, { status: "not_modelled" });
  assert.deepEqual(r.physicalLineMapping, { status: "unavailable" });
  assert.equal(r.route.basis.source, "production_execution_basis");
});

// ═══ Core WIP behaviour, carried over ═══════════════════════════════════════
test("normal sequential production: WIP is upstream pieces not yet downstream", () => {
  const events = [
    ...range(1, 120).map((u) => scan(u, "SJ-01", 200 - u)),
    ...range(1, 83).map((u) => scan(u, "BA-03", 150 - u, { machineId: M2 })),
    ...range(1, 40).map((u) => scan(u, "HM-02", 60 - u / 2, { machineId: M3 })),
  ];
  const [e1, e2] = flow(workOrder(), events).edges;
  assert.deepEqual(
    [e1.fromOperationId, e1.toOperationId, e1.completedUpstream, e1.completedDownstream, e1.wipPieces, e1.confidence],
    ["row-10", "row-20", 120, 83, 37, CONFIDENCE.CALCULATED],
  );
  assert.deepEqual([e2.wipPieces, e2.confidence], [43, CONFIDENCE.CALCULATED]);
});

test("duplicate scans — device retry, rescan, second barcode form — do not raise WIP", () => {
  const base = [...range(1, 10).map((u) => scan(u, "SJ-01", 30)), ...range(1, 4).map((u) => scan(u, "BA-03", 20))];
  const dupes = [
    ...range(1, 10).map((u) => scan(u, "SJ-01", 25)),
    { ...scan(5, "SJ-01", 24), workOrderKey: WO_A, barcodeId: `WO-${WO_A}-5` },
    { ...scan(7, "sj-01", 23) },
  ];
  assert.equal(flow(workOrder(), base).edges[0].wipPieces, 6);
  const twice = flow(workOrder(), [...base, ...dupes]);
  assert.equal(twice.edges[0].wipPieces, 6);
  assert.equal(twice.edges[0].completedUpstream, 10);
  assert.equal(twice.dataQuality.repeatScans, 12);
});

test("partial downstream completion: only the unfinished pieces wait", () => {
  const events = [...range(1, 20).map((u) => scan(u, "SJ-01", 40)), ...[2, 4, 6, 8, 10].map((u) => scan(u, "BA-03", 10))];
  const e = flow(workOrder(), events).edges[0];
  assert.deepEqual([e.completedUpstream, e.completedDownstream, e.wipPieces, e.confidence], [20, 5, 15, CONFIDENCE.CALCULATED]);
});

test("downstream exceeding recognised upstream never goes negative", () => {
  const events = [...range(1, 5).map((u) => scan(u, "SJ-01", 50)), ...range(1, 9).map((u) => scan(u, "BA-03", 20))];
  const e = flow(workOrder(), events).edges[0];
  assert.deepEqual([e.completedUpstream, e.completedDownstream, e.wipPieces, e.downstreamWithoutUpstream], [5, 9, 0, 4]);
  assert.equal(e.confidence, CONFIDENCE.ESTIMATED);
  assert.ok(e.reasons.includes("downstream_without_upstream"));
});

test("two work orders on the same operation and machine stay separate", () => {
  const woB = workOrder({ _id: WO_B, quantity: 50 });
  const routeB = frozen(["SJ-01", "BA-03", "HM-02"], WO_B);
  const events = [
    ...range(1, 10).map((u) => scan(u, "SJ-01", 30)), ...range(1, 3).map((u) => scan(u, "BA-03", 10)),
    ...range(1, 40).map((u) => scan(u, "SJ-01", 30, { workOrderId: WO_B })),
    ...range(1, 40).map((u) => scan(u, "BA-03", 10, { workOrderId: WO_B })),
  ];
  assert.equal(flow(workOrder(), events).edges[0].wipPieces, 7);
  const b = flow(woB, events, { route: routeB }).edges[0];
  assert.deepEqual([b.completedUpstream, b.wipPieces], [40, 0]);
});

test("rework / repeated operation: repeats are one membership, first completion is arrival", () => {
  const events = [
    scan(1, "SJ-01", 90), scan(2, "SJ-01", 80), scan(1, "BA-03", 60),
    scan(1, "SJ-01", 30), // sent back upstream after row-20 — still not waiting
    scan(2, "SJ-01", 20), // redone at row-10 — waits from its FIRST completion
  ];
  const e = flow(workOrder(), events).edges[0];
  assert.equal(e.wipPieces, 1);
  assert.equal(e.oldestWaitingSince, minsAgo(80).toISOString());
});

test("skipped operation: a unit already past the downstream step is bypassed, not waiting", () => {
  const events = [...range(1, 6).map((u) => scan(u, "SJ-01", 60)), scan(1, "BA-03", 40), scan(1, "HM-02", 30), scan(2, "HM-02", 30)];
  const [e1, e2] = flow(workOrder(), events).edges;
  assert.deepEqual([e1.wipPieces, e1.bypassedDownstream], [4, 1]);
  assert.equal(e2.downstreamWithoutUpstream, 1);
});

test("cancelled work order, out-of-range units, ambiguous frozen codes, key collision", () => {
  const events = [...range(1, 5).map((u) => scan(u, "SJ-01", 10)), scan(999, "SJ-01", 10), scan(0, "SJ-01", 10)];
  assert.equal(flow(workOrder(), events).dataQuality.invalidUnitScans, 2);
  const cancelled = flow(workOrder({ status: "cancelled" }), events).edges[0];
  assert.deepEqual([cancelled.confidence, cancelled.wipPieces], [CONFIDENCE.UNKNOWN, null]);
  assert.ok(cancelled.reasons.includes("work_order_cancelled"));

  const dup = flow(workOrder(), [scan(1, "SJ-01", 10)], { route: frozen(["SJ-01", "BA-03", "SJ-01"]) }).edges[0];
  assert.ok(dup.reasons.includes("upstream_operation_code_ambiguous"));
  assert.equal(dup.confidence, CONFIDENCE.UNKNOWN);

  const collided = flow(workOrder(), [scan(1, "SJ-01", 10)], { keyCollision: true }).edges[0];
  assert.ok(collided.reasons.includes("work_order_key_collision"));
});

test("a combined station scan completes both operations it names", () => {
  const e = flow(workOrder(), [scan(1, ["SJ-01", "BA-03"], 10), scan(2, "SJ-01", 10)]).edges[0];
  assert.deepEqual([e.completedUpstream, e.completedDownstream, e.wipPieces], [2, 1, 1]);
});

// ═══ Defect 3 — no fabricated zeroes; evidence is judged per edge ═══════════
test("scans only at operation 1 of 3: edge 2→3 is unknown, not zero", () => {
  const [e1, e2] = flow(workOrder(), range(1, 10).map((u) => scan(u, "SJ-01", 20))).edges;
  assert.equal(e1.wipPieces, 10);
  assert.equal(e1.confidence, CONFIDENCE.ESTIMATED);
  assert.ok(e1.reasons.includes("downstream_has_no_reporting_evidence"));
  assert.deepEqual([e2.confidence, e2.wipPieces, e2.completedUpstream, e2.completedDownstream],
    [CONFIDENCE.UNKNOWN, null, null, null]);
  assert.deepEqual(e2.reasons, ["edge_has_no_reporting_evidence"]);
});

test("an edge with reporting evidence on both sides and genuinely zero WIP is a calculated zero", () => {
  const events = [...range(1, 8).map((u) => scan(u, "SJ-01", 50)), ...range(1, 8).map((u) => scan(u, "BA-03", 20))];
  const e = flow(workOrder(), events).edges[0];
  assert.deepEqual([e.wipPieces, e.confidence, e.oldestWaitingSince], [0, CONFIDENCE.CALCULATED, null]);
  assert.deepEqual(e.reasons, []);
});

test("a downstream-only scan leaves the edge unknown", () => {
  const e = flow(workOrder(), range(1, 12).map((u) => scan(u, "BA-03", 15))).edges[0];
  assert.deepEqual([e.confidence, e.wipPieces, e.trend], [CONFIDENCE.UNKNOWN, null, TREND.UNKNOWN]);
  assert.deepEqual(e.reasons, ["upstream_not_recorded"]);
});

test("no events anywhere: every edge and the work order are unknown with null counts", () => {
  const r = flow(workOrder(), []);
  assert.equal(r.confidence, CONFIDENCE.UNKNOWN);
  assert.deepEqual(r.reasons, ["no_scan_data"]);
  for (const e of r.edges) {
    assert.equal(e.confidence, CONFIDENCE.UNKNOWN);
    for (const k of ["completedUpstream", "completedDownstream", "wipPieces", "arrivalRatePerHour", "departureRatePerHour"]) assert.equal(e[k], null);
  }
  assert.deepEqual(flow(workOrder(), [scan(1, "XX-99", 5)]).reasons, ["scans_not_attributable"]);
});

test("events elsewhere in the work order never turn an untouched edge into zero", () => {
  const four = frozen(["SJ-01", "BA-03", "HM-02", "QC-01"]);
  const events = [...range(1, 10).map((u) => scan(u, "SJ-01", 40)), ...range(1, 10).map((u) => scan(u, "BA-03", 20))];
  const edges = flow(workOrder(), events, { route: four }).edges;
  assert.equal(edges[0].confidence, CONFIDENCE.CALCULATED);
  assert.equal(edges[0].wipPieces, 0);
  assert.deepEqual([edges[2].confidence, edges[2].wipPieces], [CONFIDENCE.UNKNOWN, null]);
  assert.deepEqual(edges[2].reasons, ["edge_has_no_reporting_evidence"]);
});

// ═══ Oldest waiting and trend ═══════════════════════════════════════════════
test("oldest waiting timestamp is the earliest upstream completion still waiting", () => {
  const events = [
    scan(1, "SJ-01", 300), scan(2, "SJ-01", 240), scan(3, "SJ-01", 120),
    scan(1, "BA-03", 100),
    scan(3, "SJ-01", 400), // an offline queue delivers unit 3's EARLIER scan late
  ];
  const e = flow(workOrder(), events).edges[0];
  assert.equal(e.wipPieces, 2);
  assert.equal(e.oldestWaitingSince, minsAgo(400).toISOString());
  assert.equal(e.oldestWaitingAgeSeconds, 400 * 60);
  // Scans after asOf are not part of the picture.
  assert.equal(flow(workOrder(), [scan(1, "SJ-01", 50), scan(2, "SJ-01", 50), scan(1, "BA-03", -5), scan(2, "BA-03", 10)]).edges[0].wipPieces, 1);
  const rec = flow(workOrder(), [scan(1, "SJ-01", 90, { timeRecovered: true }), scan(2, "SJ-01", 10), scan(2, "BA-03", 5)]).edges[0];
  assert.ok(rec.reasons.includes("oldest_waiting_time_recovered"));
});

test("trend: growing, shrinking, stable and unknown", () => {
  const growing = flow(workOrder(), [...range(1, 30).map((u) => scan(u, "SJ-01", 45)), ...range(1, 5).map((u) => scan(u, "BA-03", 15))]).edges[0];
  assert.deepEqual([growing.trend, growing.arrivalRatePerHour, growing.departureRatePerHour], [TREND.GROWING, 30, 5]);
  const shrinking = flow(workOrder(), [...range(1, 30).map((u) => scan(u, "SJ-01", 180)), ...range(1, 20).map((u) => scan(u, "BA-03", 20))]).edges[0];
  assert.equal(shrinking.trend, TREND.SHRINKING);
  const stable = flow(workOrder(), [...range(1, 20).map((u) => scan(u, "SJ-01", 50)), ...range(1, 19).map((u) => scan(u, "BA-03", 20))]).edges[0];
  assert.equal(stable.trend, TREND.STABLE);
  const quiet = flow(workOrder(), [...range(1, 8).map((u) => scan(u, "SJ-01", 300)), scan(1, "BA-03", 200)]).edges[0];
  assert.deepEqual([quiet.wipPieces, quiet.trend], [7, TREND.UNKNOWN]);
  assert.equal(classifyTrend(10, 9), TREND.STABLE);
  assert.equal(classifyTrend(100, 85), TREND.GROWING);
  assert.equal(classifyTrend(0, 0), TREND.UNKNOWN);
});

// ═══ Dependency forecast: frozen SAM + observed operators, never guesses ═══
test("dependency prediction uses frozen SAM and distinct operators seen scanning", () => {
  const events = [
    ...range(1, 18).map((u) => scan(u, "SJ-01", 50 - u, { operatorId: "op-up" })),
    ...range(1, 9).map((u) => scan(u, "BA-03", 20 - u, { operatorId: u < 5 ? "op-down-1" : "op-down-2" })),
    scan(1, "BA-03", 2, { operatorId: "op-down-1" }), // repeat scan cannot invent another operator
  ];
  const e = flow(workOrder(), events).edges[0];
  assert.equal(e.upstreamStandardTimeMinutes, 1);
  assert.equal(e.downstreamStandardTimeMinutes, 2);
  assert.equal(e.upstreamActiveOperators, 1);
  assert.equal(e.downstreamActiveOperators, 2);
  assert.equal(e.prediction.predictionBasis, "frozen_sam_and_recent_operators");
  assert.equal(e.prediction.downstreamSamRatePerHour, 60);
  assert.equal(e.prediction.status, "starvation_risk");
  assert.equal(e.prediction.minutesUntilRunout, 13);
});

test("dependency prediction reports no risk, outside-window risk, and unavailable evidence honestly", () => {
  const base = { wipPieces: 9, arrivalRatePerHour: 18, departureRatePerHour: 12,
    upstreamStandardTimeMinutes: null, downstreamStandardTimeMinutes: 2,
    upstreamActiveOperators: 0, downstreamActiveOperators: 1, windowMinutes: 60 };
  assert.deepEqual(
    (({ status, minutesUntilRunout, predictionBasis }) => ({ status, minutesUntilRunout, predictionBasis }))(predictDependency(base)),
    { status: "starvation_risk", minutesUntilRunout: 45, predictionBasis: "frozen_sam_and_recent_operators" },
  );
  assert.equal(predictDependency({ ...base, wipPieces: 30 }).status, "not_at_risk");
  assert.equal(predictDependency({ ...base, arrivalRatePerHour: 35 }).status, "not_at_risk");
  assert.equal(predictDependency({ ...base, arrivalRatePerHour: null }).status, "unavailable");
  const observed = predictDependency({ ...base, downstreamStandardTimeMinutes: null, downstreamActiveOperators: 0,
    arrivalRatePerHour: 8, departureRatePerHour: 20, wipPieces: 6 });
  assert.equal(observed.predictionBasis, "observed_downstream_rate");
  assert.equal(observed.minutesUntilRunout, 30);
});

// ═══ Machine context: server-owned assignments only ═══════════════════════
const assigned = (machineId, rowId, over = {}) => ({
  _id: machineId,
  productionOwnership: { companyId: COMPANY },
  productionAssignment: { assignmentId: `as-${machineId.slice(-2)}`, revision: 1, companyId: COMPANY, workOrderId: WO_A,
    executionBasisId: "690000000000000000000001", operationRowId: rowId, ...over },
});
const ctx = (machines) => ({ available: true, reason: null, machines });

test("edges resolve their machines from current server-owned assignments", () => {
  const events = [...range(1, 10).map((u) => scan(u, "SJ-01", 30, { machineId: M1 })), ...range(1, 4).map((u) => scan(u, "BA-03", 10, { machineId: M2 }))];
  const [e1, e2] = flow(workOrder(), events, { assignmentContext: ctx([assigned(M3, "row-10"), assigned(M2, "row-20")]) }).edges;
  assert.equal(e1.currentContext.source, "server_owned_machine_assignment");
  assert.equal(e1.currentContext.status, "resolved");
  assert.deepEqual([e1.currentContext.upstreamMachineIds, e1.currentContext.downstreamMachineIds], [[M3], [M2]]);
  assert.deepEqual(e1.currentContext.upstream.assignments, [{ machineId: M3, assignmentId: "as-03", revision: 1 }]);
  // M1 scanned SJ-01 historically but is not assigned: it is evidence, not context.
  assert.ok(!e1.currentContext.upstreamMachineIds.includes(M1));
  assert.equal(e2.currentContext.downstream.status, "unassigned");
});

test("an assignment on another basis version is unresolved, never counted", () => {
  const e = flow(workOrder(), [scan(1, "SJ-01", 10)], { assignmentContext: ctx([assigned(M1, "row-10", { executionBasisId: "690000000000000000000009" })]) }).edges[0];
  assert.equal(e.currentContext.status, "unresolved");
  assert.deepEqual(e.currentContext.upstreamMachineIds, []);
  assert.match(e.currentContext.reasons[0], /^assignment_on_other_basis_version:/);
});

test("no assignment context (historical asOf) is unavailable; heartbeat-shaped input is ignored", () => {
  const events = range(1, 10).map((u) => scan(u, "SJ-01", 30, { machineId: M1 }));
  const none = flow(workOrder(), events).edges[0];
  assert.equal(none.currentContext.status, "unavailable");
  const historical = flow(workOrder(), events, { assignmentContext: { available: false, reason: "current_assignment_not_applicable_to_historical_asof" } }).edges[0];
  assert.deepEqual(historical.currentContext.reasons, ["current_assignment_not_applicable_to_historical_asof"]);
  // Heartbeat codes or an ad-hoc machine map are not an assignment context.
  const hb = flow(workOrder(), events, { assignment: { machinesByCode: new Map([["sj-01", new Set([M3])]]) },
    heartbeats: [{ machineId: M3, activeOps: ["SJ-01"] }] }).edges[0];
  assert.deepEqual([hb.currentContext.status, hb.currentContext.upstreamMachineIds], ["unavailable", []]);
  // Narrowing by machine with no context cannot claim membership either way.
  const narrowed = flow(workOrder(), events, { context: { machineIds: new Set([M1]) } }).edges[0];
  assert.equal(narrowed.inContext, null);
});

test("operation-code narrowing uses frozen codes and changes no counts", () => {
  const events = [...range(1, 10).map((u) => scan(u, "SJ-01", 30)), ...range(1, 4).map((u) => scan(u, "BA-03", 20)), scan(1, "HM-02", 10)];
  const all = flow(workOrder(), events).edges;
  const byCode = flow(workOrder(), events, { context: { operationCode: "hm-02" } }).edges;
  assert.deepEqual(byCode.map((e) => e.inContext), [false, true]);
  assert.deepEqual(byCode.map((e) => e.wipPieces), all.map((e) => e.wipPieces));
});

// ═══ Reconciliation diagnostic ══════════════════════════════════════════════
test("reconciliation reports device vs frozen codes and never maps them", () => {
  const events = [scan(1, "CT007", 10), scan(2, ["AP001", "AP002"], 9), scan(3, "SJ-01", 8)];
  const r = reconcileOperationCodes(workOrder(), events, frozen(["SJ-01", "BA-03", "BA-03"]), { asOf: AS_OF });
  assert.deepEqual(r.matchedCodes, ["sj-01"]);
  assert.deepEqual(r.unmatchedDeviceCodes, ["ap001", "ap002", "ct007"]);
  assert.deepEqual(r.duplicatedRouteCodes, ["ba-03"]);
  assert.deepEqual(r.blockingReasons, ["frozen_route_codes_duplicated"]);
  assert.equal(r.projectable, false);
  assert.deepEqual(r.editableRouteCodes, ["P001", "P002"]);

  const none = reconcileOperationCodes(workOrder(), [scan(1, "CT007", 10)], { status: "unavailable", reason: "frozen_route_unavailable" }, { asOf: AS_OF });
  assert.deepEqual(none.blockingReasons, ["frozen_route_unavailable"]);
  assert.deepEqual(none.expectedFrozenRouteCodes, []);
  const noMatch = reconcileOperationCodes(workOrder(), [scan(1, "CT007", 10)], ROUTE, { asOf: AS_OF });
  assert.deepEqual(noMatch.blockingReasons, ["no_device_code_matches_frozen_route"]);
});
