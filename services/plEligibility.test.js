// services/plEligibility.test.js — run with `npm test`.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { decidePlEligibility } = require("./plEligibility");

const base = { dateOfJoining: "2024-01-01", threshold: 240, plEligible: false, consumedPL: 0 };

test("grants once the threshold is reached", () => {
  const d = decidePlEligibility({ ...base, workingDays: 240 });
  assert.strictEqual(d.action, "grant");
});

test("the threshold is inclusive — exactly the required days qualifies", () => {
  assert.strictEqual(decidePlEligibility({ ...base, workingDays: 240 }).action, "grant");
  assert.strictEqual(
    decidePlEligibility({ ...base, workingDays: 239 }).action,
    "not-yet-eligible",
  );
});

test("leaves an already-correct grant alone", () => {
  const d = decidePlEligibility({ ...base, workingDays: 400, plEligible: true });
  assert.strictEqual(d.action, "already-correct");
});

test("leaves somebody below the threshold alone when they have no PL", () => {
  const d = decidePlEligibility({ ...base, workingDays: 30 });
  assert.strictEqual(d.action, "not-yet-eligible");
  assert.strictEqual(d.shortBy, 210);
});

// The bug this whole change exists for: a date of joining is corrected, and the
// PL granted under the old date stays forever.
test("revokes PL that the joining date no longer supports", () => {
  const d = decidePlEligibility({ ...base, workingDays: 100, plEligible: true });
  assert.strictEqual(d.action, "revoke");
  assert.strictEqual(d.shortBy, 140);
});

test("REFUSES to revoke when PL has already been taken", () => {
  const d = decidePlEligibility({
    ...base,
    workingDays: 100,
    plEligible: true,
    consumedPL: 3,
  });
  assert.strictEqual(d.action, "needs-review");
  assert.match(d.reason, /already taken 3 PL day/);
});

test("half a day already taken still blocks the revoke", () => {
  const d = decidePlEligibility({
    ...base,
    workingDays: 100,
    plEligible: true,
    consumedPL: 0.5,
  });
  assert.strictEqual(d.action, "needs-review");
});

// The dangerous one. workingDaysSince(undefined) returns 0, which looks exactly
// like "nowhere near eligible" — and would revoke everybody with a blank field.
test("NEVER acts on an employee with no date of joining", () => {
  for (const missing of [null, undefined, ""]) {
    const d = decidePlEligibility({
      ...base,
      dateOfJoining: missing,
      workingDays: 0,
      plEligible: true,
    });
    assert.strictEqual(d.action, "no-joining-date", `for ${JSON.stringify(missing)}`);
  }
});

test("a missing joining date does not grant either", () => {
  const d = decidePlEligibility({
    ...base,
    dateOfJoining: null,
    workingDays: 9999,
  });
  assert.strictEqual(d.action, "no-joining-date");
});

test("every branch returns a reason a person can read", () => {
  const cases = [
    { workingDays: 400 },
    { workingDays: 10 },
    { workingDays: 400, plEligible: true },
    { workingDays: 10, plEligible: true },
    { workingDays: 10, plEligible: true, consumedPL: 2 },
    { dateOfJoining: null, workingDays: 0 },
  ];
  for (const c of cases) {
    const d = decidePlEligibility({ ...base, ...c });
    assert.ok(d.reason && d.reason.length > 10, `no reason for ${JSON.stringify(c)}`);
  }
});
