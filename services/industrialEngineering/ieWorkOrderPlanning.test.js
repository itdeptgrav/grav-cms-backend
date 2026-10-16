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

test("views: operationsView and linePlanView are stated absences when nothing is stored", () => {
  assert.equal(svc.linePlanView({}), null);
  assert.deepEqual(svc.operationsView({}), { count: 0, totalSeconds: 0, samMinutes: null, rows: [], plan: null });
  const v = svc.operationsView({ operations: [{ _id: oid(), operationType: "A", operationCode: "a", plannedTimeSeconds: 30 }], operationsPlan: { source: "ie-copy", copiedFromWorkOrderNumber: "WO-1", updatedBy: { name: "R" }, version: 3 } });
  assert.equal(v.samMinutes, 0.5);
  assert.equal(v.plan.copiedFromWorkOrderNumber, "WO-1");
  assert.equal(v.plan.version, 3);
});
