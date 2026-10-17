const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateTarget, describeTarget, targetDays, instant } = require("./orderTargets.evaluate");

const ev = (ymd, hhmm, qty = 1) => ({ at: instant(ymd, hhmm), qty });

test("targetDays honours working days and the span", () => {
  const t = { from: "2026-09-21", to: "2026-09-27", workingDays: [1, 2, 3, 4, 5, 6] }; // Mon..Sun, no Sunday
  assert.deepEqual(targetDays(t), ["2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
});

test("per_day: today's figure, cumulative pace and the days that fell short", () => {
  const t = { department: "ironing", kind: "per_day", pieces: 100, from: "2026-09-21", to: "2026-09-25", workingDays: [1, 2, 3, 4, 5], orderQuantity: 600 };
  const events = [ev("2026-09-21", "10:00", 100), ev("2026-09-22", "11:00", 60), ev("2026-09-23", "12:00", 120), ev("2026-09-24", "09:45", 30)];
  const r = evaluateTarget(t, events, "2026-09-24", { doneOverall: 310, orderQuantity: 600, now: instant("2026-09-24", "15:00") });
  assert.equal(r.covers, true);
  assert.deepEqual({ e: r.today.expected, d: r.today.done, s: r.today.short }, { e: 100, d: 30, s: 70 });
  // At 15:00 the whole-day target counts 5.5 of the 9 shift hours: 300 + 61.
  assert.deepEqual({ e: r.toDate.expected, d: r.toDate.done, pct: r.toDate.pct }, { e: 361, d: 310, pct: 86 });
  assert.equal(r.status, "on_track");
  // At 08:00 nothing of today is due yet.
  const early = evaluateTarget(t, events.slice(0, 3), "2026-09-24", { now: instant("2026-09-24", "08:00") });
  assert.equal(early.toDate.expected, 300); assert.equal(early.today.expectedSoFar, 0);
  assert.deepEqual(r.shortDays.map((x) => x.date), ["2026-09-22"]);
  assert.equal(r.span.daysLeft, 1);
  assert.equal(r.span.neededPerDay, 190); // 500 - 310 over 1 remaining day
  assert.match(r.advice, /Required rate: 190 per day/);
  assert.equal(r.order.remaining, 290);
});

test("per_hour: expected grows with the clock and the hour table names the short hours", () => {
  const t = { department: "production", kind: "per_hour", pieces: 20, from: "2026-09-24", to: "2026-09-24", hoursFrom: "09:30", hoursTo: "13:30", workingDays: [0, 1, 2, 3, 4, 5, 6] };
  const events = [ev("2026-09-24", "09:40", 20), ev("2026-09-24", "10:45", 5), ev("2026-09-24", "11:50", 20)];
  const r = evaluateTarget(t, events, "2026-09-24", { now: instant("2026-09-24", "12:30") });
  assert.equal(r.today.expected, 80);          // 20 × 4 h
  assert.equal(r.today.expectedSoFar, 60);     // 3 h elapsed
  assert.equal(r.today.done, 45);
  assert.deepEqual(r.today.hours.map((h) => [h.label, h.expected, h.done]), [
    ["09:30–10:30", 20, 20], ["10:30–11:30", 20, 5], ["11:30–12:30", 20, 20], ["12:30–13:30", 20, 0],
  ]);
  const short = r.today.hours.filter((h) => h.short > 0).map((h) => h.label);
  assert.deepEqual(short, ["10:30–11:30", "12:30–13:30"]);
  // A scan outside the clock window does not count.
  const r2 = evaluateTarget(t, [...events, ev("2026-09-24", "16:00", 50)], "2026-09-24", { now: instant("2026-09-24", "18:00") });
  assert.equal(r2.today.done, 45);
});

test("total: even pace, then met with days to spare", () => {
  const t = { department: "packaging", kind: "total", pieces: 300, from: "2026-09-22", to: "2026-09-24", workingDays: [0, 1, 2, 3, 4, 5, 6] };
  const r1 = evaluateTarget(t, [ev("2026-09-22", "10:00", 100)], "2026-09-23");
  assert.equal(r1.perDay, 100);
  assert.deepEqual({ e: r1.toDate.expected, d: r1.toDate.done }, { e: 200, d: 100 });
  assert.equal(r1.status, "behind");
  const r2 = evaluateTarget(t, [ev("2026-09-22", "10:00", 200), ev("2026-09-23", "10:00", 100)], "2026-09-23");
  assert.equal(r2.status, "exceeded");
  assert.match(r2.advice, /Target achieved/);
});

test("before the start and after the end", () => {
  const t = { department: "qc", kind: "per_day", pieces: 50, from: "2026-09-25", to: "2026-09-26", workingDays: [0, 1, 2, 3, 4, 5, 6] };
  const before = evaluateTarget(t, [], "2026-09-24");
  assert.equal(before.status, "not_started"); assert.equal(before.today, null);
  const after = evaluateTarget(t, [ev("2026-09-25", "10:00", 50), ev("2026-09-26", "10:00", 20)], "2026-09-30");
  assert.equal(after.over, true); assert.equal(after.status, "behind"); assert.match(after.advice, /Not achieved: 70 of 100/);
});

test("describeTarget reads as one sentence with the totals worked out", () => {
  assert.equal(describeTarget({ department: "cutting", kind: "per_day", pieces: 300, from: "2026-09-21", to: "2026-09-23", workingDays: [1, 2, 3] }),
    "Cutting: 300 pieces a day, from 21 Sep 2026 to 23 Sep 2026 (3 working days → 900 in total).");
  assert.equal(describeTarget({ department: "production", kind: "per_hour", pieces: 25, from: "2026-09-24", to: "2026-09-24", hoursFrom: "09:30", hoursTo: "18:30", workingDays: [4] }),
    "Production (sewing): 25 pieces an hour between 09:30 and 18:30, on 24 Sep 2026 (225 a day → 225 in total).");
});

test("a capped pace stops when its quantity is reached", () => {
  const t = { department: "cutting", kind: "per_day", pieces: 4, cap: 18, from: "2026-10-19", to: "2026-10-23", workingDays: [1, 2, 3, 4, 5] };
  const r = evaluateTarget(t, [], "2026-10-23");
  assert.deepEqual(r.rows.map((x) => x.expected), [4, 4, 4, 4, 2], "the fifth day asks only the 2 that are left");
  assert.equal(r.totalExpected, 18);
  assert.match(describeTarget(t), /until 18 are done/);
  assert.match(describeTarget(t), /→ 18 in total/);
});

test("a batch plan: nothing is due before a lay's time, all of it after", () => {
  const t = { department: "cutting", kind: "total", pieces: 624, from: "2026-10-19", to: "2026-10-20", workingDays: [1, 2, 3, 4, 5],
    dayPlan: [{ date: "2026-10-19", time: "13:00", pieces: 312, label: "Lay 1" }, { date: "2026-10-19", time: "17:30", pieces: 156, label: "Lay 2" }, { date: "2026-10-20", time: "", pieces: 156, label: "Lay 3" }] };
  const at = (hhmm) => new Date(instant("2026-10-19", hhmm));
  assert.equal(evaluateTarget(t, [], "2026-10-19", { now: at("12:59") }).today.expectedSoFar, 0, "the lay is still on the table");
  assert.equal(evaluateTarget(t, [], "2026-10-19", { now: at("13:00") }).today.expectedSoFar, 312, "the whole lay is due at once");
  assert.equal(evaluateTarget(t, [], "2026-10-19", { now: at("18:00") }).today.expectedSoFar, 468);
  const r = evaluateTarget(t, [], "2026-10-20", { now: new Date(instant("2026-10-20", "19:00")) });
  assert.deepEqual(r.rows.map((x) => x.expected), [468, 156], "each day asks what its lays deliver");
  assert.equal(r.totalExpected, 624);
  assert.match(describeTarget(t), /624 garments in 3 lays over 2 days.*due when it comes off/);
  const hourly = { ...t, dayPlan: [{ date: "2026-10-16", time: "11:30", pieces: 312, label: "10:30–11:30" }, { date: "2026-10-16", time: "15:30", pieces: 312, label: "14:30–15:30" }] };
  assert.match(describeTarget(hourly), /624 garments, hour by hour on .*2 planned hours; each hour's garments are due by its end/);
  const byLay = { ...t, dayPlan: [
    { date: "2026-10-16", time: "11:30", workOrderId: "a", pieces: 150, label: "Lay 1 · T1" },
    { date: "2026-10-16", time: "11:30", workOrderId: "b", pieces: 150, label: "Lay 1 · T1" },
    { date: "2026-10-16", time: "15:30", workOrderId: "b", pieces: 324, label: "Lay 2 · T2" },
  ] };
  assert.match(describeTarget(byLay), /624 garments across 2 work orders in 2 lays on .*; each lay's garments are due when it comes off/);
  const twoTables = { ...byLay, dayPlan: byLay.dayPlan.map((b, i) => ({ ...b, label: i < 2 ? "Lays 1–2" : "Lay 3" })) };
  assert.match(describeTarget(twoTables), /in 3 lays/);
  const loads = { ...byLay, department: "washing", dayPlan: byLay.dayPlan.map((b, i) => ({ ...b, label: i < 2 ? "Loads 1–2" : "Load 3" })) };
  assert.match(describeTarget(loads), /in 3 loads/);
  const ship = { ...byLay, department: "dispatch", dayPlan: byLay.dayPlan.map((b, i) => ({ ...b, time: "", label: i < 2 ? "Shipment 1" : "Shipment 2" })) };
  assert.match(describeTarget(ship), /in 2 shipments/);
});
