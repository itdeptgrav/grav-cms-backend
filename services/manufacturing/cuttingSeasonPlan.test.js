"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("./cuttingSeasonPlan");

const T = (over) => ({ _id: "t1", status: "active", department: "cutting", manufacturingOrderId: "m1", moNumber: "MO-REQ-1", customerName: "A", dayPlan: [], ...over });

test("one lay holding two orders is gathered back by its key; a proposal is not a lay", () => {
  const lays = p.laysFromTargets([
    T({ dayPlan: [{ date: "2026-10-16", time: "10:30", workOrderId: "w1", pieces: 40, label: "Lay 1", layKey: "cutting:2026-10-16T09:30" }] }),
    T({ _id: "t2", manufacturingOrderId: "m2", moNumber: "MO-REQ-2", dayPlan: [{ date: "2026-10-16", time: "10:30", workOrderId: "w2", pieces: 20, label: "Lay 1", layKey: "cutting:2026-10-16T09:30" }, { date: "2026-10-18", time: "11:30", workOrderId: "w2", pieces: 5, layKey: "cutting:2026-10-18T10:30" }] }),
    T({ _id: "t3", status: "proposed", dayPlan: [{ date: "2026-10-16", time: "10:30", workOrderId: "w9", pieces: 99, layKey: "cutting:2026-10-16T09:30" }] }),
  ], { from: "2026-10-16", to: "2026-10-17" });
  assert.equal(lays.length, 1, "the 18th is outside the window");
  assert.deepEqual([lays[0].pieces, lays[0].orders, lays[0].start], [60, 2, "09:30"]);
});

test("sizes read as log-book columns; anything else stays itself", () => {
  assert.equal(p.sizeColumn("m"), "M");
  assert.equal(p.sizeColumn("XXXL"), "3XL");
  assert.equal(p.sizeColumn("2XL"), "XXL");
  assert.equal(p.sizeColumn("40"), null);
  assert.deepEqual(p.variantParts([{ name: "Size", value: "M" }, { name: "Colour", value: "Navy" }]), { size: "M", colour: "Navy" });
});

const facts = new Map([
  ["w1", { workOrderNumber: "WO-1", productName: "Shirt", styleNo: "SH-01", size: "M", colour: "Navy", bomCons: 1.6, fabric: { key: "f1:v", quality: "f1", name: "Shirting", variant: "Navy" } }],
  ["w2", { workOrderNumber: "WO-2", productName: "Shirt", styleNo: "SH-01", size: "L", colour: "Navy", bomCons: 1.6, fabric: { key: "f1:v", quality: "f1", name: "Shirting", variant: "Navy" } }],
]);
const LAY = { layKey: "k", date: "2026-10-16", time: "10:30", start: "09:30", label: "Lay 3", pieces: 120, lines: [{ workOrderId: "w1", moId: "m1", moNumber: "MO-REQ-1", customerName: "Hotel A", pieces: 80 }, { workOrderId: "w2", moId: "m1", moNumber: "MO-REQ-1", customerName: "Hotel A", pieces: 40 }], cutPlan: null };

test("a lay gives its season the report details and a lay row to start from", () => {
  const plan = p.planOf([LAY], { facts });
  assert.deepEqual(p.headerFromPlan(plan), { buyerName: "Hotel A", poNo: "MO-REQ-1", styleNo: "SH-01", colour: "Navy", date: "2026-10-16" });
  const s = p.suggestLay(plan, { cuttingMaster: "Rakesh" });
  assert.equal(s.values.layNo, "3");
  assert.deepEqual([s.values.ratio.M, s.values.ratio.L, s.values.plies], ["2", "1", "40"], "80 M + 40 L is a 2:1 marker, 40 plies");
  assert.equal(s.values.bomCons, "1.6");
  assert.equal(s.values.fabricLot, "Shirting · Navy");
  assert.deepEqual(s.from, ["the pieces PPC planned"]);
});

test("PPC's cut plan, when it wrote one for the hour, gives the marker and plies", () => {
  const plan = p.planOf([{ ...LAY, cutPlan: { no: 3, table: "T2", plies: 40, ratio: [{ size: "M", count: 2 }, { size: "L", count: 1 }], lengthM: 3.048, widthCm: 152.4, efficiencyPct: 84 } }], { facts });
  const s = p.suggestLay(plan);
  assert.deepEqual([s.values.markerLength, s.values.markerWidth, s.values.markerEff, s.values.tableNo, s.values.plies], ["10", "5", "84", "T2", "40"]);
  assert.deepEqual(s.from, ["PPC's cut plan"]);
});

test("the lay is compared with PPC's ask, size by size", () => {
  const plan = p.planOf([LAY], { facts });
  assert.equal(p.planCheck(plan, []).state, "not_cut");
  const c = p.planCheck(plan, [{ styleNo: "SH-01", ratio: { M: 2, L: 1 }, plies: 38 }]);
  assert.deepEqual(c.rows.map((r) => [r.size, r.planned, r.cut, r.diff]), [["M", 80, 76, -4], ["L", 40, 38, -2]]);
  assert.deepEqual([c.planned, c.cut, c.state], [120, 114, "short"]);
  assert.match(p.planCheck(plan, [{ styleNo: "XX-9", ratio: { M: 3 }, plies: 40 }]).notes.join(" "), /not one PPC planned/);
});

test("sizes that are not log-book columns are compared in the total only, and no ratio is guessed", () => {
  const f2 = new Map([["w1", { styleNo: "AP-1", size: "30" }]]);
  const plan = p.planOf([{ ...LAY, lines: [{ workOrderId: "w1", moId: "m1", pieces: 12 }] }], { facts: f2 });
  assert.equal(p.suggestLay(plan).values.plies, "");
  assert.match(p.planCheck(plan, []).notes[0], /30/);
});

test("a lay is due by the earliest of its orders, at the highest priority", () => {
  const d = p.dueOf([{ targetTo: "2026-10-21", deliveryDeadline: "2026-11-09", priority: "medium" }, { targetTo: "2026-10-19", deliveryDeadline: "2026-11-02", priority: "urgent" }, { priority: "nonsense" }]);
  assert.deepEqual(d, { targetTo: "2026-10-19", deliveryDeadline: "2026-11-02", priority: "urgent" });
  assert.deepEqual(p.dueOf([]), { targetTo: "", deliveryDeadline: "", priority: "" });
  const lays = p.laysFromTargets([T({ from: "2026-10-15", to: "2026-10-20", dayPlan: [{ date: "2026-10-16", time: "10:30", workOrderId: "w1", pieces: 4, layKey: "k" }] })]);
  assert.equal(lays[0].lines[0].targetTo, "2026-10-20", "each line carries its target's end");
});
