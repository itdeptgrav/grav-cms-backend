const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { unblockedAtMs } = require("./officeDeadline.service");

/**
 * **A dependency's approval is the whole anchor for the task it freed.**
 * OWNER RULE, 26 Aug 2026.
 *
 * A's outputs Puri and Pardeep feed two of B's tasks. Each of B's tasks is
 * counted from the approval of ITS OWN input, and from nothing else:
 *
 *   Puri Dev    (4h)  input approved 10:00  ->  due 14:00
 *   Pardeep Dev (6h)  input approved 13:00  ->  due 19:00
 *
 * Pardeep Dev must NOT chain behind Puri Dev's 14:00 finish and come out at
 * 20:00, which is what applying the approval as a `max` produced.
 */

const at = (h, m = 0) => Date.parse(`2026-08-26T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`);
const APPROVED_PURI = at(10);
const APPROVED_PARDEEP = at(13);
const NOW = at(15);

/** A's two outputs, as the walk indexes them: id -> approval instant. */
const approvals = new Map([
  ["out_A_puri", APPROVED_PURI],
  ["out_A_pardeep", APPROVED_PARDEEP],
]);

const bTask = (needs) => ({ outputs: [{ id: "out_B", label: "dev", needsOutputIds: needs }] });

test("each dependent task is freed by its OWN input's approval", () => {
  assert.equal(unblockedAtMs(bTask(["out_A_puri"]), approvals, NOW), APPROVED_PURI);
  assert.equal(unblockedAtMs(bTask(["out_A_pardeep"]), approvals, NOW), APPROVED_PARDEEP);
});

test("approving one input does not free a task waiting on the other", () => {
  /* Only Puri is approved. Pardeep Dev is still waiting, so it has no fixed
     instant yet — its floor tracks the clock, which is what stops its deadline
     burning down against a wait somebody else owns. */
  const onlyPuri = new Map([["out_A_puri", APPROVED_PURI]]);
  assert.equal(unblockedAtMs(bTask(["out_A_puri"]), onlyPuri, NOW), APPROVED_PURI);
  assert.equal(unblockedAtMs(bTask(["out_A_pardeep"]), onlyPuri, NOW), NOW);
});

test("a task waiting on SEVERAL inputs is freed by the last of them", () => {
  const both = bTask(["out_A_puri", "out_A_pardeep"]);
  assert.equal(unblockedAtMs(both, approvals, NOW), APPROVED_PARDEEP);
});

test("a task with no dependency is not touched by this rule at all", () => {
  assert.equal(unblockedAtMs({ outputs: [] }, approvals, NOW), null);
  assert.equal(unblockedAtMs({ outputs: [{ id: "o", needsOutputIds: [] }] }, approvals, NOW), null);
});

/* ── The anchor is SET, not floored ───────────────────────────────────────── */

const SOURCE = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");

test("the approval LEADS at the head and only FLOORS behind live work", () => {
  /**
   * Three cases, each with a reported fault behind it:
   *
   * · **Freed, and leading the queue** — the approval is the whole start.
   *   Applied as `> anchorMs` it was discarded wherever the chain had placed
   *   the task later, so Pardeep Dev read 20:00 instead of its own 19:00.
   * · **Freed, but behind live work** — it may only push later. Applied
   *   exactly, a task with one input approved at 02:11 sat on top of the plain
   *   task being worked 02:16–03:16. No approval makes a person free earlier
   *   than the thing already in their hands.
   * · **Still waiting** — `unblockedAtMs` answers `nowMs` so the deadline does
   *   not burn down; that one is a max too, or a blocked task anchors at
   *   whatever moment the walk happened to run.
   */
  assert.match(
    SOURCE,
    /if \(Number\.isFinite\(task\.freedAtMs\)\)[\s\S]{0,1600}?previousEndMs === null[\s\S]{0,120}?\? task\.freedAtMs[\s\S]{0,120}?: Math\.max\(anchorMs, task\.freedAtMs\)/,
    "the approval no longer leads at the head, or no longer floors behind live work",
  );
  assert.match(
    SOURCE,
    /task\.unblockedAtMs > anchorMs/,
    "the waiting floor is no longer a max — a blocked task can overtake live work",
  );
});

test("the two cases are told apart by asking without a clock", () => {
  /* `unblockedAtMs` folds the approval and the now-fallback into one number.
     Passing a non-finite clock makes the fallback unreachable, so what comes
     back is the approval or null — which is exactly the distinction the anchor
     needs. */
  assert.match(SOURCE, /freedAtMs: simulated \? null : unblockedAtMs\(t, approvedAtById, NaN\)/);
});

test("the rule still runs AFTER the chain has had its say", () => {
  /* It has to overrule the queue, so it must be the last word on the anchor. */
  const chain = SOURCE.indexOf("previousEndMs === null");
  const dep = SOURCE.indexOf("if (Number.isFinite(task.freedAtMs))");
  assert.ok(chain > 0 && dep > chain, "the dependency anchor no longer follows the chain");
});
