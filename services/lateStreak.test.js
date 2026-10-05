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

test("THE OWNER'S CASE: 3rd late regularized — the 4th is just late, the 5th is absent", () => {
  /* What an approved regularization leaves: the check-in moved, the day
     re-judged from scratch (status P, not late), and the marker the
     correction now stamps. Before 5 Oct 2026 the day left the streak and the
     4th late was docked as a late half day. */
  const regularized = late({ systemPrediction: "P", isLate: false, lateRegularized: true });
  assert.deepEqual(run([late(), late(), regularized, late(), late()]), [null, null, null, null, "LAB"]);
});

test("a regularized day is never itself docked, even when it lands on the 3rd or 5th", () => {
  const regularized = late({ systemPrediction: "P", isLate: false, lateRegularized: true });
  assert.deepEqual(run([late(), late(), late(), late(), regularized]), [null, null, "LHD", null, null]);
});

test("an HR punch edit that took the late away counts the same way (it stamps the marker too)", () => {
  const corrected = late({ hrFinalStatus: "P", isLate: false, lateRegularized: true });
  assert.deepEqual(run([late(), late(), corrected, late(), late()]), [null, null, null, null, "LAB"]);
});

test("a day that was never late is not counted", () => {
  const onTime = late({ systemPrediction: "P", isLate: false });
  assert.deepEqual(run([late(), late(), onTime, late()]), [null, null, null, "LHD"]);
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
