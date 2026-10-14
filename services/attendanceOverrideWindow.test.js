// services/attendanceOverrideWindow.test.js — the override's sunset and the one thing left after it.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const w = require("./attendanceOverrideWindow");

const at = (day) => new Date(`${day}T12:00:00+05:30`);

test("the full override works up to and including the sunset day (IST), not after", () => {
  delete process.env.HR_OVERRIDE_SUNSET;
  assert.equal(w.sunset(), w.DEFAULT_SUNSET);
  assert.equal(w.overridesOpen(at(w.DEFAULT_SUNSET)), true);
  assert.equal(w.overridesOpen(new Date("2026-10-31T18:29:00Z")), true, "23:59 IST on the 31st is still the 31st");
  assert.equal(w.overridesOpen(new Date("2026-10-31T18:31:00Z")), false, "00:01 IST on the 1st is past it");
});

test("HR_OVERRIDE_SUNSET moves the date; a malformed value is ignored", () => {
  process.env.HR_OVERRIDE_SUNSET = "2026-11-15";
  assert.equal(w.overridesOpen(at("2026-11-10")), true);
  process.env.HR_OVERRIDE_SUNSET = "next week";
  assert.equal(w.sunset(), w.DEFAULT_SUNSET);
  delete process.env.HR_OVERRIDE_SUNSET;
});

test("after the sunset a worked rest day can be credited CO / P / HD, or taken back", () => {
  for (const code of w.REST_DAY_CODES) {
    for (const s of w.REST_DAY_CREDITS) assert.equal(w.restDayCreditRefusal({ systemPrediction: code }, s), "", `${code} → ${s}`);
    assert.equal(w.restDayCreditRefusal({ systemPrediction: code }, null), "");
    assert.equal(w.restDayCreditRefusal({ systemPrediction: code }, code), "");
  }
});

test("after the sunset nothing else can be set", () => {
  assert.match(w.restDayCreditRefusal({ systemPrediction: "WO" }, "AB"), /only CO, P, HD/);
  assert.match(w.restDayCreditRefusal({ systemPrediction: "WO" }, undefined), /only CO, P, HD/);
  assert.match(w.restDayCreditRefusal({ systemPrediction: "P" }, "AB"), /ended on/, "a working day is not a rest day");
  assert.match(w.restDayCreditRefusal(null, "CO"), /ended on/, "no row is not a rest day — no row is created");
});
