"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { summarise, rangeOf } = require("./cuttingOverview");

const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);

test("the range is bounded and ordered", () => {
  assert.deepEqual(rangeOf({}, "2026-10-16"), { from: "2026-10-16", to: "2026-10-16", days: 1 });
  assert.deepEqual(rangeOf({ from: "2026-10-20", to: "2026-10-16" }, "2026-10-16"), { from: "2026-10-16", to: "2026-10-16", days: 1 });
  assert.equal(rangeOf({ from: "2026-01-01", to: "2026-10-16" }, "2026-10-16").days, 92);
});

test("every figure is a recorded cut: days zero-filled, hours bucketed, people and work orders summed", () => {
  const records = [
    { employeeId: "e1", employeeName: "Rakesh", date: "2026-10-15", entries: [
      { woId: "w1", woNumber: "WO-1", stockItemName: "Shirt", variants: "M · Blue", quantityCut: 40, timestamp: at("2026-10-15", "10:05") },
      { woId: "w2", woNumber: "WO-2", stockItemName: "Shirt", variants: "L · Blue", quantityCut: 20, timestamp: at("2026-10-15", "14:40") },
    ] },
    { employeeId: "e2", employeeName: "Sunita", date: "2026-10-16", entries: [
      { woId: "w1", woNumber: "WO-1", stockItemName: "Shirt", variants: "M · Blue", quantityCut: 60, timestamp: at("2026-10-16", "10:20") },
      { woId: "w1", woNumber: "WO-1", quantityCut: 0, timestamp: at("2026-10-16", "11:00") },
    ] },
    { employeeId: "e9", employeeName: "Outside", date: "2026-09-01", entries: [{ woId: "w9", quantityCut: 999 }] },
  ];
  const s = summarise(records, { from: "2026-10-14", to: "2026-10-16", days: 3 });
  assert.deepEqual(s.days.map((d) => [d.date, d.pieces]), [["2026-10-14", 0], ["2026-10-15", 60], ["2026-10-16", 60]]);
  assert.deepEqual({ ...s.totals, peakDay: s.totals.peakDay.date }, { pieces: 120, sessions: 3, workOrders: 2, people: 2, activeDays: 2, perActiveDay: 60, peakDay: "2026-10-15" });
  assert.equal(s.hours.find((h) => h.key === "09:30").pieces, 100);
  assert.equal(s.hours.find((h) => h.key === "14:30").pieces, 20);
  assert.deepEqual(s.people.map((p) => [p.name, p.pieces, p.workOrders, p.share]), [["Rakesh", 60, 2, 50], ["Sunita", 60, 1, 50]]);
  assert.deepEqual(s.workOrders.map((w) => [w.woNumber, w.pieces, w.people]), [["WO-1", 100, ["Rakesh", "Sunita"]], ["WO-2", 20, ["Rakesh"]]]);
});
