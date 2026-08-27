const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");

/**
 * **A task finished through its OUTPUTS earns its C1 score.**
 * REPORTED 26 Aug 2026.
 *
 * `reviewCompletion` credits C1 when a task's COMPLETION SUBMISSION is
 * approved. A task carrying outputs never makes one — it is finished a piece
 * at a time through `reviewOutput`, which marked it `done` and
 * `tl_final_approved` without ever passing through that path.
 *
 * So the screen contradicted itself: the task read Completed with "2 of 2
 * approved", the flow showed Created → Assigned → Work → Approved, and the
 * score panel still said "1.0 of 1.0 points PROJECTED" — projected being the
 * honest word, because nothing had ever been written. The person had finished
 * the work and been paid nothing for it.
 */

const src = fs.readFileSync(require.resolve("./taskForward.service.js"), "utf8");

/** The body of one async function, to the start of the next. */
function fn(name) {
  const i = src.indexOf(`async function ${name}(`);
  if (i === -1) return "";
  const j = src.indexOf("\nasync function ", i + 1);
  return j === -1 ? src.slice(i) : src.slice(i, j);
}

test("approving the final output credits C1", () => {
  const body = fn("reviewOutput");
  assert.notEqual(body, "", "reviewOutput not found — renamed?");
  assert.match(
    body,
    /c1Svc\s*\.?\s*\n?\s*\.?computeAndStoreTaskScore\(/,
    "a task completed through its outputs no longer earns a score",
  );
});

test("it is credited ONLY when every output is approved", () => {
  /* Approving the first of three must pay nothing — the task is not done. */
  const body = fn("reviewOutput");
  const at = body.indexOf("computeAndStoreTaskScore(");
  assert.ok(at > 0);
  const guard = body.slice(0, at);
  assert.match(
    guard.slice(guard.lastIndexOf("if (")),
    /allApproved/,
    "the score is credited before every output is approved",
  );
});

test("it credits the same way the completion path does", () => {
  /* Same call, same shape, so the two cannot drift into paying differently
     for the same finished work. */
  const body = fn("reviewOutput");
  assert.match(body, /taskId,/);
  assert.match(body, /employeeId: primaryEmployee/);
  assert.match(body, /isRejected: false/);
  /* Off the request's critical path, exactly as `reviewCompletion` does it —
     a scoring failure must never fail the approval that earned it. */
  assert.match(body, /setImmediate\(/);
  assert.match(body, /\.catch\(\(e\) => console\.error\("\[C1 score on output approval\]"/);
});

test("lateness is measured from the last output handed over", () => {
  /* There is no `completionSubmission` on this path, so the instant the work
     actually left the assignee's hands is the last output submission. */
  const body = fn("reviewOutput");
  assert.match(body, /const lastHandover = submissions/);
  assert.match(body, /\.map\(\(s\) => s && s\.submittedAt\)/);
  assert.match(body, /\.sort\(\)\s*\r?\n?\s*\.pop\(\)/);
});

test("the score sees the task as it is AFTER the approval lands", () => {
  /* `task` was read before the write, so on its own it still says the task is
     unfinished — the score would be computed against a stale record. */
  const body = fn("reviewOutput");
  assert.match(body, /taskData: \{ \.\.\.task, \.\.\.updates \}/);
});

test("the completion path still credits too — this did not move the rule", () => {
  const body = fn("reviewCompletion");
  assert.match(body, /computeAndStoreTaskScore\(/);
  assert.match(body, /isFullyApproved \|\| isRejected/);
});
