"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { applyLateCountPromotion } = require("./lateStreak");

const POLICY = { enabled: true, lateHDOnCount: 3, lateFullDayOnCount: 5 };
const TODAY = "2026-10-05";

/** A late day as the sync writes it. */
const late = (extra = {}) => ({
  isLate: true,
  systemPrediction: "P*",
  hrFinalStatus: null,
  inTime: new Date("2026-09-01T04:09:00Z"),
  ...extra,
});

/** Run a month of days through the rule; returns what each day was docked as. */
function run(days) {
  const state = { lateCount: 0, earlyCount: 0 };
  return days.map((d, i) =>
    applyLateCountPromotion(d, state, POLICY, `2026-09-${String(i + 1).padStart(2, "0")}`, TODAY)
      .promotedStatus,
  );
}

test("the plain streak: 3rd late is a late half day, 5th a late absent", () => {
  assert.deepEqual(run([late(), late(), late(), late(), late()]), [null, null, "LHD", null, "LAB"]);
});

test("a 3rd late HR marked Present: the 4th is NOT docked, the 5th is still absent", () => {
  assert.deepEqual(
    run([late(), late(), late({ hrFinalStatus: "P" }), late(), late()]),
    [null, null, null, null, "LAB"],
  );
});

test("a 3rd late covered by PL with its punches WIPED still counts", () => {
  /* What the override did before 5 Oct 2026: inTime null, isLate recomputed
     false. The 4th used to become "the 3rd" and be docked a half day. */
  const wiped = late({ hrFinalStatus: "L-EL", inTime: null, isLate: false });
  assert.deepEqual(run([late(), late(), wiped, late(), late()]), [null, null, null, null, "LAB"]);
});

test("a 3rd late covered by PL with punches kept still counts", () => {
  assert.deepEqual(
    run([late(), late(), late({ hrFinalStatus: "L-EL" }), late(), late()]),
    [null, null, null, null, "LAB"],
  );
});

test("a late HR corrected to ON TIME is not a late — a fixed device error", () => {
  /* HR typed the right time: inTime present, isLate recomputed false. */
  const corrected = late({ hrFinalStatus: "P", isLate: false });
  assert.deepEqual(run([late(), late(), corrected, late(), late()]), [null, null, null, "LHD", null]);
});

test("a projection that never selected inTime keeps the old rule", () => {
  const noField = late({ hrFinalStatus: "P", isLate: false });
  delete noField.inTime;
  assert.deepEqual(run([late(), late(), noField]), [null, null, null]);
});

test("the counter resets after a late absent", () => {
  assert.deepEqual(
    run([late(), late(), late(), late(), late(), late(), late(), late()]),
    [null, null, "LHD", null, "LAB", null, null, "LHD"],
  );
});
