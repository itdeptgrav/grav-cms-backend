const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { lastHandoverMs } = require("./officeDeadline.service");

/**
 * **The head of a queue cannot start before the person put down what they
 * were holding.**
 *
 * REPORTED, with real records. Rakesh held two tasks raised 18:35 and 18:40.
 * The dependent one led the queue, delivered its first output at 18:58, and
 * its second output was still waiting on another team. With nothing workable
 * it dropped a place and the plain one-hour task took the front — anchored at
 * the queue's 18:35 start, so it arrived carrying a deadline of 19:35 that had
 * already expired, for a person who had been working the whole time.
 *
 * The instant that matters is the SUBMISSION (18:58), never the approval
 * (19:24): waiting on a reviewer is not the assignee's time to lose.
 */

const at = (iso) => Date.parse(iso);
const SUBMIT = at("2026-08-25T13:28:08.000Z"); // 18:58 IST
const APPROVE = at("2026-08-25T13:54:03.000Z"); // 19:24 IST

test("a per-OUTPUT submission counts as a handover", () => {
  /* The case `completionSubmission` cannot see: the task is still `confirmed`,
     because one output is delivered and the other is blocked. */
  const task = {
    status: "confirmed",
    outputSubmissions: {
      out_0: {
        submittedAt: new Date(SUBMIT).toISOString(),
        review: { approved: true, reviewedAt: new Date(APPROVE).toISOString() },
      },
    },
  };
  assert.equal(lastHandoverMs(task), SUBMIT);
});

test("the SUBMISSION is taken, never the approval", () => {
  const task = {
    outputSubmissions: {
      out_0: {
        submittedAt: new Date(SUBMIT).toISOString(),
        review: { approved: true, reviewedAt: new Date(APPROVE).toISOString() },
      },
    },
  };
  assert.notEqual(lastHandoverMs(task), APPROVE);
  assert.equal(lastHandoverMs(task), SUBMIT);
});

test("a whole-task submission still counts", () => {
  const task = { completionSubmission: { submittedAt: new Date(SUBMIT).toISOString() } };
  assert.equal(lastHandoverMs(task), SUBMIT);
});

test("the LATEST handover wins when there are several", () => {
  const earlier = at("2026-08-25T12:00:00.000Z");
  const task = {
    completionSubmission: { submittedAt: new Date(earlier).toISOString() },
    outputSubmissions: {
      a: { submittedAt: new Date(earlier).toISOString() },
      b: { submittedAt: new Date(SUBMIT).toISOString() },
    },
  };
  assert.equal(lastHandoverMs(task), SUBMIT);
});

test("a task nobody has handed anything over on has no handover", () => {
  assert.equal(lastHandoverMs({ status: "confirmed" }), null);
  assert.equal(lastHandoverMs({ outputSubmissions: {} }), null);
  assert.equal(lastHandoverMs({ outputSubmissions: { a: {} } }), null);
});

/* ── The floor is wired into the walk, and only ever pushes later ─────────── */

const SOURCE = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");

test("the floor is collected across EVERY document, terminal ones included", () => {
  /* A task submitted and since approved still occupied the person right up to
     the moment they submitted it, so it must be counted before the walk drops
     terminal work. */
  const at_ = SOURCE.indexOf("const handovers = [];");
  assert.ok(at_ > 0, "the handover floor is gone");
  const collect = SOURCE.indexOf("const handed = lastHandoverMs(t);");
  const terminalSkip = SOURCE.indexOf("if (TERMINAL_STATUSES.includes(t.status)) return;");
  assert.ok(
    collect > 0 && collect < terminalSkip,
    "the floor is collected after terminal work is dropped — approved handovers would be missed",
  );
});

test("the floor applies to the HEAD only, and as a max", () => {
  /* Everything behind the head chains from the task above it, which already
     ends at or after any handover. Applying it there would double-count. */
  const at_ = SOURCE.indexOf("otherHandoverMs > anchorMs");
  assert.ok(at_ > 0, "the floor is not applied");
  const guard = SOURCE.slice(at_ - 300, at_);
  assert.match(guard, /previousEndMs === null/, "the floor is not restricted to the head");
});

test("a task's OWN handovers never push its own start", () => {
  /**
   * REPORTED 26 Aug 2026. Umung's task waits on nobody — both outputs are his
   * own work. He submitted the first at 03:11 and the second at 03:47, and
   * each submission pushed the task's own start forward, so its deadline grew
   * every time he made progress on it.
   *
   * The floor says "you were busy with something ELSE until you put it down".
   * A task cannot have been busy with itself.
   */
  assert.match(
    SOURCE,
    /h\.taskId === task\.id \? latest :/,
    "a task's own handovers are back in its floor — progress pushes its own deadline",
  );
  /* And the handovers are kept per task, or there would be nothing to exclude. */
  assert.match(SOURCE, /handovers\.push\(\{ taskId: doc\.id, atMs: handed \}\)/);
});

test("a future stamp cannot push a live queue past the day", () => {
  assert.match(SOURCE, /handed <= nowMs/);
});
