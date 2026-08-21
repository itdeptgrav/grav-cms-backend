const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  isAwaitingReview,
  effectiveEndMs,
  reworkLeftoverSecs,
} = require("./officeDeadline.service");

/**
 * **The next task starts when the last one was handed over.**
 * OWNER DECISION, 18 Aug 2026.
 *
 * Reported: A is due 2pm and handed in at 1pm; B is two hours and came out due
 * 4pm — A's DEADLINE plus B's budget, as though the person sat idle for the
 * hour they had already finished. They were free at 1pm and B's honest finish
 * is 3pm.
 *
 * The old reading was wrong in both directions, which is what gives it away:
 * finishing early bought the person nothing, and handing in half an hour LATE
 * still started the next task at the old deadline, so it inherited a deadline
 * it never had a chance to meet.
 *
 * Decided in the same conversation: when a reviewer sends work back, THEY say
 * where it lands in the queue, because only they know whether the rework
 * matters more than what the person moved on to.
 */

const office = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");
const forward = fs.readFileSync(require.resolve("./taskForward.service.js"), "utf8");
const route = fs.readFileSync(
  require.resolve("../routes/task_routes/taskForward.js"),
  "utf8",
);

const iso = (s) => new Date(s).toISOString();
const AT_1PM = iso("2026-08-18T13:00:00+05:30");
const AT_2PM = iso("2026-08-18T14:00:00+05:30");

const submitted = (over = {}) => ({
  status: "in_progress",
  completionStatus: "submitted",
  dueDate: AT_2PM,
  completionSubmission: { submittedAt: AT_1PM },
  ...over,
});

/* ── what counts as handed over ─────────────────────────────────────────── */

test("a submitted task is awaiting review, not finished", () => {
  /* It keeps its place in the queue — the reviewer can still send it back —
     but the person is no longer working on it. Two different questions. */
  assert.equal(isAwaitingReview(submitted()), true);
});

test("an approved or cancelled task is not awaiting review", () => {
  for (const status of ["done", "cancelled", "tl_final_approved", "ceo_approved"]) {
    assert.equal(
      isAwaitingReview(submitted({ status })),
      false,
      `${status} should have left the queue entirely`,
    );
  }
});

test("work still in progress is not awaiting review", () => {
  assert.equal(isAwaitingReview({ status: "in_progress" }), false);
  assert.equal(
    isAwaitingReview({ status: "in_progress", completionStatus: "tl_rejected" }),
    false,
  );
});

/* ── the reported bug ───────────────────────────────────────────────────── */

test("submitted early: the queue chains from 1pm, not from the 2pm deadline", () => {
  /* The exact case reported. B is two hours, so this is the difference
     between B being due at 3pm and at 4pm. */
  assert.equal(effectiveEndMs(submitted()), Date.parse(AT_1PM));
});

test("submitted late: the queue chains from the LATE handover", () => {
  /**
   * The half nobody notices. Handed in at 2:30 for a 2pm deadline, the old
   * reading still started the next task at 2pm — half an hour before the
   * person was free — so it was given a deadline it could not meet.
   */
  const late = iso("2026-08-18T14:30:00+05:30");
  assert.equal(
    effectiveEndMs(submitted({ completionSubmission: { submittedAt: late } })),
    Date.parse(late),
  );
});

test("still being worked on: its deadline stands", () => {
  /* No handover moment exists yet, and the deadline is the only estimate
     there is — which is what the engine has always used. */
  const working = { status: "in_progress", dueDate: AT_2PM };
  assert.equal(effectiveEndMs(working), Date.parse(AT_2PM));
});

test("submitted but with no timestamp falls back to the deadline", () => {
  /* Rather than returning null and dropping the task out of the queue. */
  assert.equal(
    effectiveEndMs(submitted({ completionSubmission: {} })),
    Date.parse(AT_2PM),
  );
  assert.equal(effectiveEndMs(submitted({ completionSubmission: null })), Date.parse(AT_2PM));
});

/* ── the leftover rule, mirrored not rewritten ──────────────────────────── */

test("the rework gets the whole unused hour, not the time left when reviewed", () => {
  /**
   * The rule the owner asked me not to lose. Due 6:00, handed in at 5:00,
   * reviewed at 5:45 — the rework is worth the FULL hour that was never used,
   * not the fifteen minutes remaining against the old deadline.
   */
  const task = {
    dueDate: iso("2026-08-18T18:00:00+05:30"),
    completionSubmission: { submittedAt: iso("2026-08-18T17:00:00+05:30") },
  };
  assert.equal(reworkLeftoverSecs(task), 3600);
});

test("the preview reads the same two fields the rejection writes from", () => {
  /* A preview that predicts a number the commit does not produce is worse
     than no preview, so both are `dueDate − completionSubmission.submittedAt`. */
  assert.match(forward, /const leftoverMs = new Date\(currentDeadline\)\.getTime\(\) - new Date\(submittedAtISO\)\.getTime\(\)/);
  assert.match(office, /dueDate.*\n?.*completionSubmission\?\.submittedAt|completionSubmission\?\.submittedAt/);
});

test("a task submitted after its deadline owes no negative time", () => {
  /* Late work has nothing left over; a negative budget would produce a
     deadline in the past. */
  const task = {
    dueDate: AT_1PM,
    completionSubmission: { submittedAt: AT_2PM },
  };
  assert.equal(reworkLeftoverSecs(task), 0);
});

test("nothing to preview when the task was never submitted or has no deadline", () => {
  assert.equal(reworkLeftoverSecs({ dueDate: AT_2PM }), null);
  assert.equal(reworkLeftoverSecs({ completionSubmission: { submittedAt: AT_1PM } }), null);
  assert.equal(reworkLeftoverSecs({}), null);
});

test("a deadline-mode task's fixed date is read too", () => {
  assert.equal(
    reworkLeftoverSecs({
      fixedDeadline: AT_2PM,
      completionSubmission: { submittedAt: AT_1PM },
    }),
    3600,
  );
});

/* ── the walk ───────────────────────────────────────────────────────────── */

test("a task already handed in is not given a new deadline", () => {
  /**
   * Protects the leftover rule above. That rule measures unused time as
   * `deadline − submittedAt`, so pushing the deadline of submitted work later
   * would silently hand the rework time nobody earned.
   */
  assert.match(office, /if \(task\.awaitingReview\) \{/);
  assert.match(office, /previousEndMs = task\.handedOverMs;/);
});

test("the queue chains from the handover, in both places that ask", () => {
  /* `queueAheadEndMs` answers for one arriving task, `rechainQueueFor` walks
     the whole queue. Two readings of "when is the work above me done" would
     eventually disagree. */
  assert.match(office, /endMs: effectiveEndMs\(other\)/);
  assert.match(office, /handedOverMs: simulated \? null : effectiveEndMs\(t\)/);
});

test("a running task is still never pulled earlier", () => {
  /* The safety rail that predates this work and must survive it: somebody who
     planned around 4pm never arrives to find it is 3pm. */
  assert.match(office, /dueMs > task\.dueMs/);
  assert.match(office, /anchorMs > task\.anchorMs/);
});

test("two things are exempt from that rail, and only two", () => {
  /**
   * The task being sent back, because it is handed a fresh budget from this
   * moment — its new deadline is the answer even when it is earlier.
   *
   * And a task whose stored anchor this walk wrote itself: that value is the
   * walk's own previous arithmetic, not a promise the task can claim, so it is
   * recomputed in both directions. Without it, T070 could never come back from
   * 17:51 to 17:32 — the chain would defend its own stale output for ever.
   */
  assert.match(office, /if \(movesLater \|\| correctsItself \|\| task\.isRework\)/);
  assert.match(office, /anchorIsQueueDerived = task\.anchorSource === "after_priority_work"/);
});

test("a real anchor still wins over the queue", () => {
  /* `first_online`, `hours_granted` and `acceptance` each state that the
     person could not have started before that moment. That is a fact about
     them, not about the queue, so `Math.max` still defends it. */
  assert.match(office, /Math\.max\(task\.anchorMs, previousEndMs\)/);
});

test("a corrected deadline is what the next task chains from", () => {
  /* Taking the later of old and new would keep the stale value alive and push
     the row below out again, so the correction would travel one task deep. */
  assert.match(office, /previousEndMs = anchorIsQueueDerived\s*\n?\s*\? dueMs/);
});

/* ── the preview cannot write ───────────────────────────────────────────── */

test("a simulation without dryRun is refused outright", () => {
  /* The rejection screen asks this on every keystroke of the priority
     picker. A preview that writes would reorder the queue while the manager
     was still deciding. */
  assert.match(office, /simulate requires dryRun/);
});

test("the preview reports the rows that do NOT move as well", () => {
  /* "Task C is untouched" is half of what the manager is choosing between. */
  assert.match(office, /opts\.reportAll/);
});

test("the preview endpoint is read-only and runs the real walk", () => {
  assert.match(route, /router\.get\("\/task\/:taskId\/rework-preview"/);
  assert.match(route, /dryRun: true/);
  assert.match(route, /office\.reworkLeftoverSecs\(task\)/);
});

/* ── the reviewer's choice ──────────────────────────────────────────────── */

test("the reviewer can set where the rework lands", () => {
  assert.match(forward, /reworkPriority = null/);
  assert.match(forward, /reworkUpdate\.assigneePriorities = perAssignee;/);
  assert.match(route, /reworkPriority: reworkPriority \?\? null/);
});

test("BOTH ways of sending work back accept the priority", () => {
  /**
   * There are two, and they are not interchangeable. `reworkTask` is what the
   * Cowork review panel calls — it increments `reworksReceived`, which the C1
   * rework deduction counts. `reviewCompletion`'s rejected branch is the
   * older engine path. Wiring only one leaves the other silently reordering
   * nothing.
   */
  const rework = forward.slice(forward.indexOf("async function reworkTask"));
  assert.match(rework, /reworkPriority = null/);
  assert.match(rework, /_rankUpdate\.assigneePriorities = perAssignee;/);

  const routeRework = route.slice(route.indexOf(`router.post("/task/:taskId/rework"`));
  assert.match(routeRework.slice(0, 1200), /reworkPriority/);
});

test("every moment that changes the queue re-chains it", () => {
  /**
   * Three, and all three are needed. Found on live data: the walk produced
   * the right answer for T072 but nothing was calling it — T071 was handed in
   * at 17:38 and T072 sat at 18:19 (T071's DEADLINE plus its own 21 minutes)
   * instead of 17:59, because SUBMITTING was not a trigger. The correction
   * only arrived if some later event happened to re-chain the queue.
   *
   * - submitting  — the person stops working on it, so the queue below frees
   * - reviewing   — approval removes it, rejection puts it back
   * - rework      — same, by the other route the panel uses
   */
  assert.match(forward, /\[submitCompletionRequest\] queue re-chain failed/);
  assert.match(forward, /\[reviewCompletion\] queue re-chain failed/);
  assert.match(forward, /\[reworkTask\] queue re-chain failed/);
});

test("the review re-chain covers approval as well as rejection", () => {
  /* It sits after both branches rather than inside the rejected one: an
     approval takes the task out of the queue entirely, which frees the work
     below it just as surely. */
  const fn = forward.slice(forward.indexOf("async function reviewCompletion"));
  const chain = fn.indexOf("[reviewCompletion] queue re-chain failed");
  const ret = fn.indexOf("return { success: true, taskId, approved");
  const rejected = fn.indexOf("Rejected (all flows)");
  assert.ok(chain > rejected, "the re-chain must follow the rejected branch");
  assert.ok(chain < ret, "the re-chain must run before returning");
});

test("re-chaining always follows the write it reacts to", () => {
  /* Re-chaining first would move other people's deadlines for a decision that
     then failed to save. */
  for (const [fnName, marker] of [
    ["async function submitCompletionRequest", "[submitCompletionRequest] queue re-chain failed"],
    ["async function reworkTask", "[reworkTask] queue re-chain failed"],
  ]) {
    const fn = forward.slice(forward.indexOf(fnName));
    const update = fn.indexOf("ref.update(");
    const chain = fn.indexOf(marker);
    assert.ok(update > 0 && chain > update, `${fnName}: re-chain runs before the update`);
  }
});

test("the rework path's own deadline rule is untouched", () => {
  /**
   * This is the rule the owner named and asked me not to lose: the rework is
   * given the time that was NEVER USED, run through the working calendar.
   * Due 6:00, handed in at 5:00, sent back at 5:45 — a full hour of working
   * time, not the fifteen minutes that remained.
   */
  const rework = forward.slice(forward.indexOf("async function reworkTask"));
  assert.match(rework, /const leftoverSecs = Math\.floor\(\s*\n?\s*\(currentDeadlineMs - submittedAtMs\) \/ 1000,\s*\n?\s*\);/);
  assert.match(rework, /newDeadline = await computeWorkingDeadline\(\{/);
  /* And the gate: a LATE submission has nothing left over and keeps its date,
     rather than being handed a deadline already in the past. */
  assert.match(rework, /submittedAtMs <= currentDeadlineMs/);
  assert.match(rework, /deadlineHeldReason = "submitted_late"/);
});

test("the priority is written without disturbing the deadline field", () => {
  /* `_rankUpdate` is spread BEFORE `[deadlineField]`, so a stray `dueDate` in
     it could never overwrite the rework deadline just computed. */
  const rework = forward.slice(forward.indexOf("async function reworkTask"));
  const spread = rework.indexOf("..._rankUpdate,");
  const deadline = rework.indexOf("[deadlineField]: newDeadline,");
  assert.ok(spread > 0 && deadline > spread, "the deadline must be written last");
});

test("an absent or nonsense priority leaves the rank alone", () => {
  /* Optional on purpose — losing a rejection because a priority picker failed
     would be far worse than a queue in a slightly wrong order. */
  assert.match(forward, /Number\.isFinite\(wantedRank\) && wantedRank > 0/);
});

test("a failed re-chain never costs the thing it reacts to", () => {
  /**
   * The write is already saved by the time any of these run. A queue that
   * re-chains late is recoverable; a submission or a review that failed to
   * save is not — so all three are wrapped, and none of them may throw.
   */
  for (const marker of [
    "[submitCompletionRequest] queue re-chain failed",
    "[reviewCompletion] queue re-chain failed",
    "[reworkTask] queue re-chain failed",
  ]) {
    const at = forward.indexOf(marker);
    assert.ok(at > 0, `${marker} is missing`);
    const before = forward.slice(Math.max(0, at - 700), at);
    assert.match(before, /try \{/, `${marker} is not wrapped in a catch`);
    assert.match(before, /rechainQueueFor/);
  }
});

test("the review re-chain runs after the decision is written", () => {
  /* Re-chaining first would move deadlines for a review that then failed. */
  const write = forward.indexOf(`completionStatus: "tl_rejected"`);
  const chain = forward.indexOf("[reviewCompletion] queue re-chain failed");
  assert.ok(write > 0 && chain > write, "the re-chain must follow the update");
});

test("every assignee's queue is walked, not just the submitter's", () => {
  /* A queue belongs to a person, not to a task — so a task assigned to two
     people re-chains both, and each is told about their own moves. */
  const walks = forward.match(/for \(const id of task\.assigneeIds \|\| \[\]\) \{/g) || [];
  assert.equal(walks.length, 3, "every re-chain site must walk all assignees");
  assert.match(forward, /const moved = await rechainQueueFor\(id\);/);
  assert.match(forward, /employeeId: id,/);
});

/* ── telling people their deadline moved ────────────────────────────────── */

test("every move writes a message on the task, and names the cause", () => {
  /**
   * OWNER DECISION, 18 Aug 2026. "Deadline moved" on its own reads like a
   * system fault; naming what caused it gives the reader something they can
   * check and, if it looks wrong, argue with.
   */
  assert.match(forward, /async function _announceQueueShifts\(/);
  assert.match(forward, /Deadline moved to \$\{when\}\$\{because\}/);
  assert.match(forward, /above this \$\{causeReason\}/);
  assert.match(forward, /messageType: "system"/);
});

test("only a deadline that moves EARLIER sends a notification", () => {
  /**
   * The volume decision. One submission can re-chain four tasks, and four
   * pushes for four dates that all got easier is how people learn to ignore
   * notifications. Losing twenty minutes is the case they must not discover
   * by missing it.
   */
  const fn = forward.slice(forward.indexOf("async function _announceQueueShifts"));
  assert.match(fn, /const earlier = Date\.parse\(row\.to\) < Date\.parse\(row\.from\)/);
  assert.match(fn, /if \(!earlier \|\| !employeeId\) continue;/);
  /* And the notification must come AFTER that gate, never before it. */
  const gate = fn.indexOf("if (!earlier || !employeeId) continue;");
  const notify = fn.indexOf("_notifyMany(");
  const chat = fn.indexOf("sendTaskChat(");
  assert.ok(chat > 0 && chat < gate, "the chat message must not be gated on direction");
  assert.ok(notify > gate, "the notification must be gated on losing time");
});

test("nothing is announced for a task that had no deadline before", () => {
  /* Nothing moved from the reader's point of view, so saying so is noise. */
  const fn = forward.slice(forward.indexOf("async function _announceQueueShifts"));
  assert.match(fn, /if \(!row\.from \|\| row\.from === row\.to\) continue;/);
});

test("the task whose own event caused the shift is not told about itself", () => {
  const fn = forward.slice(forward.indexOf("async function _announceQueueShifts"));
  assert.match(fn, /if \(causeTaskId && row\.taskId === causeTaskId\) continue;/);
});

test("a failed message never costs the deadline it reports", () => {
  /* The deadlines are already written by the time this runs. */
  const fn = forward.slice(
    forward.indexOf("async function _announceQueueShifts"),
    forward.indexOf("async function submitCompletionRequest"),
  );
  assert.equal((fn.match(/try \{/g) || []).length, 2, "both channels must be wrapped");
  assert.match(fn, /\[queueShift\] chat failed/);
  assert.match(fn, /\[queueShift\] notify failed/);
});

test("all three triggers announce what they moved", () => {
  /* A re-chain nobody is told about is the behaviour this replaced. */
  assert.equal(
    (forward.match(/await _announceQueueShifts\(\{/g) || []).length,
    3,
    "every re-chain site must announce its result",
  );
  for (const reason of ["was handed in", "was reviewed", "was sent back for rework"]) {
    assert.ok(forward.includes(`causeReason: "${reason}"`), `missing cause: ${reason}`);
  }
});

test("times are shown in IST, and a different day says so", () => {
  /* "17:59" is unreadable if it silently means tomorrow. */
  const fn = forward.slice(forward.indexOf("function _istShort"));
  assert.match(fn, /timeZone: "Asia\/Kolkata"/);
  assert.match(fn, /tomorrow \$\{time\}/);
});

/* ── what must not have changed ─────────────────────────────────────────── */

test("the leftover-hour rule itself is untouched", () => {
  /**
   * Explicitly protected. The owner confirmed this rule works and is needed,
   * so this work is built around it rather than over it.
   */
  assert.match(forward, /const snappedNow = await _snapToNextWorkingMoment\(new Date\(\)\)/);
  assert.match(forward, /newDeadline = new Date\(snappedNow\.getTime\(\) \+ leftoverMs\)\.toISOString\(\)/);
});

test("a fixed-date task still occupies nobody's queue", () => {
  assert.match(office, /if \(other\.fixedDeadline \|\| other\.hasTimer === false\) return;/);
});

test("the terminal statuses are unchanged", () => {
  assert.match(
    office,
    /const TERMINAL_STATUSES = \["done", "cancelled", "tl_final_approved", "ceo_approved"\]/,
  );
});
