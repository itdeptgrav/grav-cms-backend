"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { rollMembership } = require("./attendanceRoster.service");

/* September 2026 as the register held it: everybody has rows, and five people
   HR had marked inactive had two EMPTY rows each, written by the device on the
   12th and 13th. */
const base = {
  from: "2026-09-01",
  to: "2026-09-30",
  seenInRange: new Set(["GR0008", "GR0025", "GR0031", "GR0150"]),
  lastRegisterDay: "2026-09-30",
  punchedInRange: new Set(["GR0008", "GR0150"]),
};

test("an inactive employee with only blank device rows is NOT on the sheet", () => {
  const onRoll = rollMembership(base);
  assert.equal(onRoll("GR0025", false), false); // PRADEEP PRADHAN
  assert.equal(onRoll("GR0031", false), false); // LAXMIPRIYA SETHI
});

test("an inactive employee who actually punched in the period stays — they worked those days", () => {
  const onRoll = rollMembership(base);
  assert.equal(onRoll("GR0150", false), true);
});

test("an ACTIVE employee is never dropped for having no punches — absent is not gone", () => {
  const onRoll = rollMembership(base);
  assert.equal(onRoll("GR0025", true), true);
});

test("an active employee who punched is on the sheet", () => {
  assert.equal(rollMembership(base)("GR0008", true), true);
});

test("a caller that did not compute punches keeps the old behaviour", () => {
  const { punchedInRange, ...noPunches } = base;
  void punchedInRange;
  assert.equal(rollMembership(noPunches)("GR0025", false), true);
});

test("a period with no attendance written at all still falls back to the employee record", () => {
  const onRoll = rollMembership({ ...base, seenInRange: new Set(), punchedInRange: new Set(), lastRegisterDay: null });
  assert.equal(onRoll("GR0025", false), false);
  assert.equal(onRoll("GR0008", true), true);
});
