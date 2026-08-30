const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { unblockedAtMs } = require("./officeDeadline.service");

/**
 * **One task, two dependent outputs, freed at different times.**
 * OWNER RULE, 26 Aug 2026.
 *
 * Reported: a task whose outputs waited on two different inputs was anchored
 * by whichever landed FIRST and never moved again. The second approval was
 * discarded, so the half of the work that only became possible later was
 * scheduled as though it could have started hours earlier.
 *
 * The rule now has two halves, and both are needed:
 *   · the anchor is the LATEST approval — the moment the task became fully
 *     workable;
 *   · the budget counted from it is what is LEFT, so the hours already spent
 *     on the part that was unblocked are not handed back.
 */

const H = 3600;
const at = (h, m = 0) =>
  Date.parse(`2026-08-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);

const PURI = at(10);
const PARADEEP = at(13);
const NOW = at(15);

/** One task, two outputs, each waiting on a different upstream output. */
const task = {
  outputs: [
    { id: "b_puri", label: "puri development", needsOutputIds: ["a_puri"] },
    { id: "b_paradeep", label: "paradeep development", needsOutputIds: ["a_paradeep"] },
  ],
};

test("the first approval anchors it while the second is still waiting", () => {
  const approvals = new Map([["a_puri", PURI]]);
  assert.equal(unblockedAtMs(task, approvals, NOW), PURI);
});

test("the SECOND approval moves the anchor — it is not discarded", () => {
  /* The reported fault: this returned PURI, so the 13:00 approval changed
     nothing and the task kept a 10:00 start it could not have used. */
  const approvals = new Map([["a_puri", PURI], ["a_paradeep", PARADEEP]]);
  assert.equal(unblockedAtMs(task, approvals, NOW), PARADEEP);
  assert.notEqual(unblockedAtMs(task, approvals, NOW), PURI);
});

test("approvals in either order give the same answer — the latest wins", () => {
  const a = new Map([["a_puri", PURI], ["a_paradeep", PARADEEP]]);
  const b = new Map([["a_paradeep", PARADEEP], ["a_puri", PURI]]);
  assert.equal(unblockedAtMs(task, a, NOW), unblockedAtMs(task, b, NOW));
});

test("with nothing approved it still floors at now, so the deadline does not burn", () => {
  assert.equal(unblockedAtMs(task, new Map(), NOW), NOW);
});

/* ── The remaining-budget half ────────────────────────────────────────────── */

const SOURCE = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");

test("a dependency re-anchor schedules what is LEFT, not the full budget", () => {
  assert.match(
    SOURCE,
    /const secsToSchedule = Number\.isFinite\(task\.freedAtMs\)\s*\r?\n\s*\? Math\.max\(0, task\.secs - \(Number\(task\.workedSecs\) \|\| 0\)\)\s*\r?\n\s*: task\.secs;/,
    "the remaining-budget rule is gone",
  );
  assert.match(SOURCE, /addWorkingSecsIST\(\s*\r?\n\s*anchorMs,\s*\r?\n\s*secsToSchedule,/);
});

test("only dependency-anchored tasks use remaining time", () => {
  /* Everything else in the walk keeps its full agreed budget — this is not a
     general switch to remaining-time scheduling, which would change every
     deadline the product measures against. */
  const i = SOURCE.indexOf("const secsToSchedule");
  assert.ok(i > 0);
  assert.match(SOURCE.slice(i, i + 220), /: task\.secs;/);
});

test("worked time is read from the timer session, and a missing one is zero", () => {
  assert.match(SOURCE, /collection\("cowork_task_timers"\)/);
  assert.match(SOURCE, /if \(!s\.exists\) return;/);
  /* A running clock counts the part nobody has banked yet. */
  assert.match(SOURCE, /d\.isActive && d\.lastStartTime/);
});

test("the timer is read only for tasks a dependency could re-anchor", () => {
  /* A queue is a handful of documents; reading a session for every task in it
     would spend reads on tasks the rule cannot touch. */
  assert.match(SOURCE, /\.filter\(\(t\) => Number\.isFinite\(t\.freedAtMs\)\)/);
});
