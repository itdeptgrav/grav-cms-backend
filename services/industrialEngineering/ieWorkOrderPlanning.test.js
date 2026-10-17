// node --test services/industrialEngineering/ieWorkOrderPlanning.test.js
// The pure half of IE's work-order planning: what an operation list and a
// line plan must look like before anything is written.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const svc = require("./ieWorkOrderPlanning.service");

const oid = () => new mongoose.Types.ObjectId();

test("normaliseOperations: names required, times bounded, codes trimmed, SAM minutes accepted", () => {
  const ops = svc.normaliseOperations([
    { operationType: " Collar attach ", operationCode: " CA-01 ", plannedTimeSeconds: 42.4 },
    { name: "Sleeve join", code: "SJ", samMinutes: 1.5 },
    { operationType: "Hem", seconds: 0 },
  ]);
  assert.deepEqual(ops.map((o) => [o.operationType, o.operationCode, o.plannedTimeSeconds, o.status]), [
    ["Collar attach", "CA-01", 42, "pending"],
    ["Sleeve join", "SJ", 90, "pending"],
    ["Hem", "", 0, "pending"],
  ]);
  assert.throws(() => svc.normaliseOperations([{ operationCode: "X" }]), /no name/);
  assert.throws(() => svc.normaliseOperations([{ operationType: "A", plannedTimeSeconds: -1 }]), /invalid time/);
  assert.throws(() => svc.normaliseOperations("nope"), /list/);
  assert.throws(() => svc.normaliseOperations(Array.from({ length: svc.MAX_OPERATIONS + 1 }, () => ({ operationType: "a" }))), /At most/);
});

test("planFor: stations resolve to the work order's own operations by id, code, then name", () => {
  const a = { _id: oid(), operationType: "Collar attach", operationCode: "CA-01", plannedTimeSeconds: 60 };
  const b = { _id: oid(), operationType: "Sleeve join", operationCode: "", plannedTimeSeconds: 90 };
  const wo = { operations: [a, b] };
  const plan = svc.planFor({
    lineId: "line-1", lineName: "Line 1", slotsPerSide: 13, pitch: 175, tableWidth: 120,
    stations: [
      { side: "R", index: 2, operationId: String(b._id), machineId: String(oid()), machineName: "SNLS3", machineType: "SNLS" },
      { side: "L", index: 1, operationCode: "ca-01", item: "machine", machineId: String(oid()) },
      { side: "L", index: 2, operationType: "sleeve JOIN" },
      { side: "L", index: 3, operationType: "Button hole", plannedTimeSeconds: 30 },
      { side: "R", index: 1, item: "table" },
    ],
  }, wo);
  assert.equal(plan.lineId, "line-1");
  assert.deepEqual(plan.stations.map((s) => `${s.side}${s.index}`), ["L1", "L2", "L3", "R1", "R2"], "sorted left then right");
  const L1 = plan.stations[0];
  assert.equal(String(L1.operationId), String(a._id)); assert.equal(L1.operationCode, "CA-01"); assert.equal(L1.plannedTimeSeconds, 60);
  assert.equal(String(plan.stations[1].operationId), String(b._id), "by name, case-insensitive");
  assert.equal(plan.stations[2].operationId, null, "an operation the work order lacks is kept by name, unresolved");
  assert.equal(plan.stations[2].operationType, "Button hole");
  assert.equal(plan.stations[3].item, "table");
  assert.equal(String(plan.stations[4].operationId), String(b._id), "by id");
  assert.deepEqual(plan.summary, { stations: 4, operationsPlaced: 2, operationsTotal: 2, samMinutes: Math.round(((60 + 90 + 30 + 90) / 60) * 100) / 100 });
});

test("planFor: refusals", () => {
  const wo = { operations: [] };
  assert.throws(() => svc.planFor({ stations: [] }, wo), /Choose a sewing line/);
  assert.throws(() => svc.planFor({ lineId: "l", stations: [{ side: "X", index: 1 }] }, wo), /not on the line/);
  assert.throws(() => svc.planFor({ lineId: "l", slotsPerSide: 13, stations: [{ side: "L", index: 14 }] }, wo), /not on the line/);
  assert.throws(() => svc.planFor({ lineId: "l", stations: [{ side: "L", index: 1 }, { side: "l", index: 1 }] }, wo), /twice/);
  assert.throws(() => svc.planFor({ lineId: "l", slotsPerSide: 2, stations: [1, 2, 3, 4, 5].map((i) => ({ side: "L", index: i })) }, wo), /More stations/);
});

test("flowFor: nodes from the catalogue or custom, arrows resolved into one sequence", () => {
  const flow = svc.flowFor({
    nodes: [
      { key: "sewing", department: "sewing", x: 300, y: 0 },
      { key: "Cutting", x: 0, y: 0 },
      { key: "qc2", x: 600 },
      { key: "sub-1", department: "custom", label: "Subcontract wash", x: 450, optional: true },
      { key: "packaging", x: 750 },
    ],
    edges: [
      { from: "cutting", to: "sewing" }, { from: "sewing", to: "sub-1" }, { from: "sub-1", to: "qc2" },
      { from: "qc2", to: "packaging" }, { from: "qc2", to: "packaging" }, // drawn twice = one arrow
    ],
    notes: "n",
  });
  assert.deepEqual(flow.sequence, ["cutting", "sewing", "sub-1", "qc2", "packaging"]);
  assert.equal(flow.edges.length, 4, "a duplicate arrow is one arrow");
  assert.deepEqual(flow.nodes.map((n) => [n.key, n.department, n.label, n.optional]), [
    ["sewing", "sewing", "Sewing", false],
    ["cutting", "cutting", "Cutting", false],
    ["qc2", "qc2", "QC 2 (final)", false],
    ["sub-1", "custom", "Subcontract wash", true],
    ["packaging", "packaging", "Packaging", false],
  ]);
  assert.deepEqual(flow.summary, { steps: 5, startAt: "Cutting", endAt: "Packaging" });
  assert.equal(flow.notes, "n");
});

test("flowFor: branches order by canvas position, a lone department is a flow, refusals are named", () => {
  /* two departments fed by Cutting with no arrow between them: the one drawn
     further left comes first */
  const fork = svc.flowFor({
    nodes: [{ key: "cutting", x: 0 }, { key: "printing", x: 400 }, { key: "embroidery", x: 200 }, { key: "sewing", x: 600 }],
    edges: [{ from: "cutting", to: "printing" }, { from: "cutting", to: "embroidery" }, { from: "printing", to: "sewing" }, { from: "embroidery", to: "sewing" }],
  });
  assert.deepEqual(fork.sequence, ["cutting", "embroidery", "printing", "sewing"]);
  const lone = svc.flowFor({ nodes: [{ key: "packaging" }], edges: [] });
  assert.deepEqual(lone.sequence, ["packaging"]);
  assert.equal(lone.summary.startAt, "Packaging");

  assert.throws(() => svc.flowFor({ nodes: [] }), /at least one department/);
  assert.throws(() => svc.flowFor({ nodes: [{ key: "cutting" }, { key: "CUTTING" }] }), /twice/);
  assert.throws(() => svc.flowFor({ nodes: [{ key: "x1", department: "custom" }] }), /no label/);
  assert.throws(() => svc.flowFor({ nodes: [{ key: "cutting" }], edges: [{ from: "cutting", to: "sewing" }] }), /not on the flow/);
  assert.throws(() => svc.flowFor({ nodes: [{ key: "cutting" }], edges: [{ from: "cutting", to: "cutting" }] }), /itself/);
  assert.throws(() => svc.flowFor({
    nodes: [{ key: "cutting" }, { key: "sewing" }, { key: "qc1" }],
    edges: [{ from: "cutting", to: "sewing" }, { from: "sewing", to: "qc1" }, { from: "qc1", to: "cutting" }],
  }), /circle/);
  assert.throws(() => svc.flowFor({ nodes: Array.from({ length: svc.MAX_FLOW_NODES + 1 }, (_, i) => ({ key: `c${i}`, department: "custom", label: "x" })) }), /At most/);
});

test("processFlowView: an absence is null; a stored flow prints its sequence in words", () => {
  assert.equal(svc.processFlowView({}), null);
  assert.equal(svc.processFlowView({ processFlow: { nodes: [] } }), null);
  const v = svc.processFlowView({ processFlow: {
    nodes: [{ key: "cutting", department: "cutting" }, { key: "sewing", department: "sewing", label: "Sewing line 2" }],
    edges: [{ from: "cutting", to: "sewing" }], sequence: ["cutting", "sewing", "ghost"],
    summary: { steps: 2 }, version: 2, plannedBy: { name: "R" },
  } });
  assert.deepEqual(v.sequence, ["cutting", "sewing"], "a key no node has is dropped");
  assert.deepEqual(v.sequenceLabels, ["Cutting", "Sewing line 2"]);
  assert.equal(v.summary.startAt, "Cutting"); assert.equal(v.summary.endAt, "Sewing line 2");
  assert.equal(v.version, 2); assert.equal(v.plannedBy, "R");
});

test("views: operationsView and linePlanView are stated absences when nothing is stored", () => {
  assert.equal(svc.linePlanView({}), null);
  assert.deepEqual(svc.operationsView({}), { count: 0, totalSeconds: 0, samMinutes: null, rows: [], plan: null });
  const v = svc.operationsView({ operations: [{ _id: oid(), operationType: "A", operationCode: "a", plannedTimeSeconds: 30 }], operationsPlan: { source: "ie-copy", copiedFromWorkOrderNumber: "WO-1", updatedBy: { name: "R" }, version: 3 } });
  assert.equal(v.samMinutes, 0.5);
  assert.equal(v.plan.copiedFromWorkOrderNumber, "WO-1");
  assert.equal(v.plan.version, 3);
});
