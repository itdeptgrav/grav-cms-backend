const test = require("node:test");
const assert = require("node:assert/strict");
const { assessTarget, capacityAt, evaluateTarget, instant } = require("./orderTargets.evaluate");

const std = { samMinutesPerPiece: 2, operators: 10, hoursPerDay: 8, efficiencyPct: 75 };
// 10 × 8 × 60 × 0.75 / 2 = 1800 a day, 225 an hour
const all = [0, 1, 2, 3, 4, 5, 6];

test("capacityAt: operators × hours × efficiency ÷ SAM", () => {
  assert.deepEqual(capacityAt(std), { perDay: 1800, perHour: 225, availableMinutesPerDay: 4800 });
  assert.equal(capacityAt(null), null);
});

test("no standard → an info line, no arithmetic", () => {
  const a = assessTarget({ department: "cutting", kind: "per_day", pieces: 300, from: "2026-09-24", to: "2026-09-26", workingDays: all }, null, []);
  assert.equal(a.standard, null); assert.equal(a.required, null);
  assert.equal(a.warnings.length, 1); assert.equal(a.warnings[0].level, "info"); assert.match(a.warnings[0].text, /IE has not set a standard/);
});

test("generous dates: 1800 pieces needs 1 day, 5 were given", () => {
  const a = assessTarget({ department: "cutting", kind: "total", pieces: 1800, from: "2026-09-21", to: "2026-09-25", workingDays: all }, std, []);
  assert.equal(a.required.minDays, 1);
  assert.equal(a.given.days, 5);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0].text, /Generous: 1800 pieces needs about 1 working day .* 5 days were given/);
});

test("too much per day: over capacity", () => {
  const a = assessTarget({ department: "cutting", kind: "per_day", pieces: 2500, from: "2026-09-24", to: "2026-09-24", workingDays: all }, std, []);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0].text, /Asks 2500 a day; at IE's standard Cutting does about 1800 a day/);
  assert.equal(a.required.minDays, 2);
});

test("per hour over the hourly capacity", () => {
  const a = assessTarget({ department: "production", kind: "per_hour", pieces: 300, from: "2026-09-24", to: "2026-09-24", hoursFrom: "09:30", hoursTo: "13:30", workingDays: all }, std, []);
  assert.match(a.warnings[0].text, /Asks 300 an hour; .* about 225 an hour/);
});

test("just right: no warning", () => {
  const a = assessTarget({ department: "cutting", kind: "per_day", pieces: 1500, from: "2026-09-24", to: "2026-09-25", workingDays: all }, std, []);
  assert.deepEqual(a.warnings, []);
  assert.equal(a.busy.free, true);
});

test("busy: another order's target overlaps, and the combined load is checked", () => {
  const other = { _id: "x", department: "cutting", status: "active", kind: "per_day", pieces: 1200, from: "2026-09-23", to: "2026-09-25", workingDays: all, moNumber: "MO-OTHER" };
  // 1500 a day for 4 days = 6000 → exactly 4 days at standard, so no "generous" line.
  const a = assessTarget({ department: "cutting", kind: "per_day", pieces: 1500, from: "2026-09-23", to: "2026-09-26", workingDays: all }, std, [other]);
  assert.equal(a.busy.free, false);
  assert.equal(a.busy.combinedPerDay, 2700);
  assert.equal(a.warnings.length, 1);
  assert.match(a.warnings[0].text, /already committed to 1200 a day on MO-OTHER .* 2700 a day against about 1800/);
  // Light other load: only an info line.
  const light = { ...other, pieces: 200 };
  const b = assessTarget({ department: "cutting", kind: "per_day", pieces: 1500, from: "2026-09-23", to: "2026-09-26", workingDays: all }, std, [light]);
  assert.equal(b.warnings.length, 1); assert.equal(b.warnings[0].level, "info"); assert.match(b.warnings[0].text, /also working on MO-OTHER \(200 a day until 2026-09-25\)/);
  // A non-overlapping target does not count.
  const c = assessTarget({ department: "cutting", kind: "per_day", pieces: 900, from: "2026-09-28", to: "2026-09-29", workingDays: all }, std, [other]);
  assert.equal(c.busy.free, true);
});

test("efficiency: earned minutes over the minutes the people were there", () => {
  const t = { department: "production", kind: "per_hour", pieces: 200, from: "2026-09-24", to: "2026-09-24", hoursFrom: "09:30", hoursTo: "17:30", workingDays: all };
  const events = Array.from({ length: 900 }, (_, i) => ({ at: instant("2026-09-24", i < 450 ? "10:00" : "11:00"), qty: 1 }));
  const r = evaluateTarget(t, events, "2026-09-24", { standard: std, now: instant("2026-09-24", "11:30") });
  // 2 h elapsed × 10 operators × 60 = 1200 available; 900 × 2 = 1800 earned → 150%
  assert.deepEqual(r.today.efficiency, { earnedMinutes: 1800, availableMinutes: 1200, pct: 150, plannedPct: 75 });
  const past = evaluateTarget(t, events, "2026-09-24", { standard: std, now: instant("2026-09-25", "10:00") });
  assert.equal(past.today.efficiency.availableMinutes, 4800); // the whole 8 h window
  assert.equal(evaluateTarget(t, events, "2026-09-24", { now: instant("2026-09-24", "11:30") }).today.efficiency, null);
});
