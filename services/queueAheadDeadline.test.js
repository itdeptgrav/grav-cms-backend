const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { rankOf, TERMINAL_STATUSES } = require("./officeDeadline.service");

/**
 * **A task cannot start before the work queued above it finishes.**
 * OWNER DECISION, 17 Aug 2026.
 *
 * Reported with real data: T057 (P1, due 13:23) and T059 (P2, budget 1h10m)
 * both raised that morning for the same person. T059 came out due 14:07 — its
 * own 12:57 anchor plus its own budget, as though the P1 above it did not
 * exist. One person works one task at a time, so its earliest honest finish is
 * 13:23 + 1:10 = 14:33.
 *
 * The engine had half the rule already: `checkAndExtendForP1` pushes lower
 * work out when a P1 ARRIVES. Its gate is `Number(priority) === 1`, so it
 * never answered the opposite case — a new task arriving BELOW work that is
 * already there. That half now lives in `resolveAcceptanceAnchor`.
 */

const src = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");
const src2 = fs.readFileSync(require.resolve("./taskForward.service.js"), "utf8");

test("the anchor is pushed to after the queue ahead, never pulled earlier", () => {
  /* `Math.max` is the safety property: a deadline can only move LATER, so no
     task becomes harder to meet and nobody is marked late for work that was
     queued above them. */
  assert.match(src, /ahead\.endMs > personal\.anchorMs/);
  assert.match(src, /source: "after_priority_work"/);
  /* And the personal anchor still wins when nothing is ahead. */
  assert.match(src, /return personal;/);
});

test("only unfinished work counts as ahead", () => {
  for (const s of ["done", "cancelled", "tl_final_approved", "ceo_approved"]) {
    assert.ok(
      TERMINAL_STATUSES.includes(s),
      `${s} would keep pushing deadlines out after it closed`,
    );
  }
  /* A live status must NOT be in the list, or the queue would look empty. */
  for (const s of ["confirmed", "in_progress", "assigned", "open", "submitted"]) {
    assert.equal(TERMINAL_STATUSES.includes(s), false, `${s} was dropped from the queue`);
  }
});

test("the per-person rank wins over the task's own", () => {
  /* Legacy stores `assigneePriorities[me] ?? priority`, and priority IS per
     person — reading `task.priority` alone would queue somebody behind work
     that is not urgent to them. */
  assert.equal(rankOf({ priority: 5, assigneePriorities: { GR1: 2 } }, "GR1"), 2);
  assert.equal(rankOf({ priority: 5, assigneePriorities: { GR1: 2 } }, "GR2"), 5);
  assert.equal(rankOf({ priority: 3 }, "GR1"), 3);
  /* Legacy's unranked sentinels must sort LAST, not first. */
  assert.equal(rankOf({}, "GR1"), 99);
  assert.equal(rankOf({ priority: 0 }, "GR1"), 99);
  assert.equal(rankOf({ priority: null }, "GR1"), 99);
});

test("a task never waits for itself", () => {
  /* Without the id it finds its own document in its own queue, and a task with
     a deadline would push its own anchor past it on every re-resolution. */
  assert.match(src, /if \(taskId && doc\.id === taskId\) return;/);
  assert.match(src, /async function resolveAcceptanceAnchor\(task, nowMs = Date\.now\(\), taskId = null\)/);
});

test("equal ranks are broken by which was raised first", () => {
  /* Two P2s with no tie-break each see the other as "not ahead of me", so both
     claim the same hour and neither waits. */
  /* The pairwise comparison became a sort when the walk started ordering the
     whole queue — the promotion of workable work above blocked work is a
     property of the list, not of any two tasks. The tie-break is unchanged and
     is now the sort's second key. */
  assert.match(src, /a\.rank - b\.rank \|\| a\.createdMs - b\.createdMs/);
  assert.match(src, /createdMs: readMs\(other\.createdAtISO\) \?\? readMs\(other\.createdAt\) \?\? 0/);
});

test("every accept surface passes the task id", () => {
  /* Three surfaces resolve this anchor and they must not hand out different
     deadlines for one task — the reason they share the resolver at all. */
  const sites = [
    "../routes/task_routes/taskForward.js",
    "../routes/task_routes/taskTree.routes.js",
    "./budgetNegotiation.service.js",
  ];
  for (const site of sites) {
    const s = fs.readFileSync(require.resolve(site), "utf8");
    assert.match(
      s,
      /resolveAcceptanceAnchor\(.*Date\.now\(\),\s*[A-Za-z_$]/,
      `${site} resolves the anchor without a task id — it will queue behind itself`,
    );
  }
});

test("a granted cross-department task still respects the queue", () => {
  /* `grantMs` used to override the anchor outright, which would have left one
     accept surface chaining and the other not. */
  const bn = fs.readFileSync(require.resolve("./budgetNegotiation.service.js"), "utf8");
  assert.match(bn, /Math\.max\(grantMs, normalAnchor\.anchorMs \?\? grantMs\)/);
});

test("a fixed calendar date does not occupy the queue", () => {
  /**
   * OWNER DECISION, 17 Aug 2026. Only BUDGETED work pushes. A task given a
   * date rather than hours — a report due next Friday — is a deadline, not
   * time being spent, and letting it push would put every lower-priority task
   * past next Friday. Two of ten live tasks carried such a date.
   */
  assert.match(src, /if \(other\.fixedDeadline \|\| other\.hasTimer === false\) return;/);

  /**
   * And the end read is the budgeted date alone — reading `fixedDeadline`
   * here would reinstate exactly what the skip above removes.
   *
   * That read moved into `effectiveEndMs` on 18 Aug 2026, when submitted work
   * started releasing the queue at its handover rather than at its deadline.
   * The guarantee is unchanged and is now asserted where the read lives, so
   * this still fails if a fixed calendar date creeps back into queue time.
   */
  assert.match(src, /endMs: effectiveEndMs\(other\)/);

  const body = src.slice(
    src.indexOf("function effectiveEndMs"),
    src.indexOf("/** This person's rank"),
  );
  assert.ok(body.length > 0, "effectiveEndMs has moved or been renamed");
  assert.match(body, /readMs\(task\.dueDate\)/);
  assert.equal(
    /fixedDeadline/.test(body),
    false,
    "a fixed calendar date is being read as queue time again",
  );
});

test("a task whose date has passed stops delaying the ones below it", () => {
  /**
   * OWNER DECISION, 17 Aug 2026, chosen against the alternative.
   *
   * Worked example put to the owner: Task A (P1, 1h) due 13:23 and untouched;
   * at 14:30 a new Task C (2h) is raised. Counting A's unspent hour would make
   * C due 17:30; ignoring it makes C due 16:33. **16:33 was chosen.**
   *
   * The reasoning, so a later reader does not "fix" it: six of ten live tasks
   * were overdue at the time. Counting leftover work would let one slipped
   * task quietly push every deadline beneath it, and a late task is already
   * being handled by rework or an extension. The cost is accepted and named —
   * C's deadline assumes A is finished when it is not.
   *
   * Mechanically this is the ABSENCE of a remaining-work calculation: the rule
   * reads `dueDate` and compares instants, so a past date loses the `>`
   * comparison and pushes nothing. Pinned because the natural "improvement"
   * is to reach for the timer session, and that would reverse the decision.
   */
  assert.match(src, /ahead\.endMs > personal\.anchorMs/);

  /**
   * **Scoped to the PUSH rule, where the 17 Aug decision actually lives.**
   *
   * This read the whole file until 26 Aug 2026, on the reasoning that any
   * timer read anywhere near this arithmetic would be the "improvement" that
   * reverses the decision. That is still true of the rule below — what it must
   * never do is count a late task's unspent hours in order to delay the work
   * BENEATH it, which is exactly the case the owner ruled on.
   *
   * It is not true of the whole file. `rechainQueueFor` now reads worked time
   * for a different question, settled separately: when a task's own dependency
   * is finally approved, it is rescheduled from that approval with the hours
   * it has LEFT, so the time already spent on the part that was unblocked is
   * not handed back to it. That touches one task's own budget and pushes
   * nothing onto anybody else — the 17 Aug decision is untouched by it.
   *
   * So the guard now covers `queueAheadEndMs` and `resolveAcceptanceAnchor`,
   * and stops at the walk.
   */
  const anchorRule = src.slice(
    src.indexOf("function queueAheadEndMs("),
    src.indexOf("async function rechainQueueFor("),
  );
  assert.ok(anchorRule.length > 0, "the anchor rule was renamed — this guard is now blind");
  assert.equal(
    /cowork_task_timers/.test(anchorRule),
    false,
    "the anchor rule started reading worked time — that reverses the 17 Aug decision that a late task stops pushing",
  );
  assert.equal(
    /totalSeconds|workedSecs|remainingSecs/.test(anchorRule),
    false,
    "leftover-work arithmetic appeared in the anchor rule; see the decision above",
  );
});

test("the push never carries a subtask past its project", () => {
  /**
   * "A subtask can never be due after the project it belongs to" — OWNER
   * DECISION 16 Aug 2026, which predates the queue rule. Two of the three
   * accept surfaces never clamped to the parent, so an unchecked push would
   * have created exactly the state that rule forbids.
   *
   * The PUSH is capped, not the deadline: the paths that never clamped still
   * behave as they did, and the new rule contributes nothing past the
   * project's ceiling.
   */
  assert.match(src, /readParentDeadline/);
  assert.match(src, /ahead\.endMs > parent\.dueAtMs/);
  assert.match(src, /cappedToParent: true/);
  /* And an unreadable parent must not break the acceptance. */
  const at = src.indexOf("readParentDeadline");
  assert.match(src.slice(at, at + 700), /catch \(e\)/);
});

/* ── The deadline follows the budget ──────────────────────────────────────── */

test("changing a task's budget recomputes its deadline", () => {
  /**
   * **Reported 17 Aug 2026.** `setActiveTaskBudget` wrote the window and
   * nothing else, so a granted extension raised the budget and left the date
   * alone. T062 reached a 2-hour budget from a 13:23 start and kept a 15:00
   * deadline; its own arithmetic says 15:23. The task panel shows both figures
   * one above the other, and they disagreed.
   */
  const fn = src2.slice(
    src2.indexOf("async function setActiveTaskBudget("),
    src2.indexOf("async function markTaskStarted("),
  );
  assert.ok(fn.length > 0, "setActiveTaskBudget is gone");
  /**
   * **The granted time is ADDED to the date already held.** OWNER DECISION,
   * 17 Aug 2026.
   *
   * The first version recomputed `anchor + budget` outright, which quietly
   * took back slack a task was already carrying: T062 stood at 16:30 on a
   * 3:00 budget anchored at 13:23, though 13:23 + 3:00 is 16:23. Granting ten
   * more minutes then produced 16:33, so a +10 grant read as +3.
   */
  assert.match(fn, /const deltaSecs = secs - previousSecs;/);
  assert.match(fn, /startMs: currentDueMs,\s*\n?\s*windowSecs: deltaSecs,/);
  /* The anchor is still the fallback where no date exists yet. */
  assert.match(fn, /startMs: anchorMs, windowSecs: secs/);
  assert.match(fn, /\.\.\.\(dueDate \? \{ dueDate \} : \{\}\)/);
});

test("the recompute counts from the STORED anchor, never a fresh one", () => {
  /* `clockStartsAtMs` is stamped once and deliberately never recomputed —
     re-resolving it here would move the start every time somebody adjusted the
     hours, and a deadline whose origin drifts cannot be checked by the person
     measured against it. */
  const fn = src2.slice(
    src2.indexOf("async function setActiveTaskBudget("),
    src2.indexOf("async function markTaskStarted("),
  );
  assert.match(fn, /readInstantMs\(task\.clockStartsAtMs\)/);
  assert.equal(
    /resolveAcceptanceAnchor|Date\.now\(\)/.test(fn),
    false,
    "the budget change is re-deriving the clock start — it must use the stamped one",
  );
});

test("a fixed calendar date and a missing anchor are both left alone", () => {
  /* A typed date has no budget-derived deadline to move, and a task with no
     stamped anchor has nothing honest to count from — better the date it has
     than one invented from now. */
  const fn = src2.slice(
    src2.indexOf("async function setActiveTaskBudget("),
    src2.indexOf("async function markTaskStarted("),
  );
  assert.match(fn, /!task\.fixedDeadline && Number\.isFinite\(anchorMs\)/);
});

test("the recompute cannot push a subtask past its project", () => {
  /* Same 16 Aug rule the anchor push respects. Clamped rather than refused:
     the budget change is the manager's and stands. */
  const fn = src2.slice(
    src2.indexOf("async function setActiveTaskBudget("),
    src2.indexOf("async function markTaskStarted("),
  );
  assert.match(fn, /readParentDeadline\(task\)/);
  assert.match(fn, /Date\.parse\(dueDate\) > parent\.dueAtMs/);
  /* And a failure costs the recalculation, never the budget. */
  assert.match(fn, /catch \(e\)/);
});

/* ── The chain re-settles when a link above it moves ──────────────────────── */

test("a deadline that moves pushes the tasks queued below it", () => {
  /**
   * **Reported 17 Aug 2026.** T062 (P1) and T063 (P2) were chained correctly
   * when T063 was created — T062 was due 15:00, so T063 anchored there and
   * came out due 17:00. T062's budget then grew and its deadline moved to
   * 16:30 while T063 kept its 15:00 anchor: thirty minutes of real room for
   * two hours of work.
   *
   * Distinct from the "decided once" rule, which is about NEW work arriving
   * above somebody and still stands. Here the chain was already agreed and the
   * link above it moved.
   */
  assert.match(src, /async function rechainQueueFor\(employeeId/);
  assert.match(src2, /rechainQueueFor\(targetId\)/);
});

test("the re-chain only ever pushes later", () => {
  /* The safety property that makes the walk safe to run repeatedly: a task
     cannot become harder to meet because something above it finished sooner
     than planned. */
  const fn = src.slice(src.indexOf("async function rechainQueueFor("));
  assert.match(fn, /Math\.max\(task\.anchorMs, previousEndMs\)/);
  assert.match(fn, /dueMs > task\.dueMs/);
  assert.match(fn, /anchorMs > task\.anchorMs/);
});

test("the re-chain uses the queue's own ordering", () => {
  /* Rank, then which was raised first — the same tie-break `queueAheadEndMs`
     uses. Two orderings would eventually disagree about who waits for whom. */
  const fn = src.slice(src.indexOf("async function rechainQueueFor("));
  assert.match(fn, /a\.rank - b\.rank \|\| a\.createdMs - b\.createdMs/);
});

test("the re-chain skips what the queue rule skips", () => {
  /* Fixed calendar dates occupy no hours, and a task with no stamped anchor
     has nothing honest to count from. The two halves of the rule must agree
     about which work is in the queue at all. */
  const fn = src.slice(src.indexOf("async function rechainQueueFor("));
  assert.match(fn, /t\.fixedDeadline \|\| t\.hasTimer === false/);
  assert.match(fn, /TERMINAL_STATUSES\.includes\(t\.status\)/);
  assert.match(fn, /!Number\.isFinite\(anchorMs\) \|\| secs <= 0/);
});

test("the re-chain cannot fail the budget that triggered it", () => {
  /* Detached and caught: a queue walk must not make the manager wait on their
     own press, nor undo a budget already written. */
  const at = src2.indexOf("rechainQueueFor(targetId)");
  const around = src2.slice(at - 200, at + 300);
  assert.match(around, /setImmediate\(/);
  assert.match(around, /\.catch\(/);
});

test("the walk can be rehearsed without writing", () => {
  /* Used to show the owner what would move before anything moved. */
  const fn = src.slice(src.indexOf("async function rechainQueueFor("));
  assert.match(fn, /if \(!opts\.dryRun\)/);
});

test("a reduced or unchanged budget never shortens the deadline", () => {
  /* A smaller budget is a decision about HOURS. Taking the date away with it
     is a second decision nobody made, and a background recompute that makes a
     commitment harder to meet is the one thing this whole area must not do. */
  const fn = src2.slice(
    src2.indexOf("async function setActiveTaskBudget("),
    src2.indexOf("async function markTaskStarted("),
  );
  assert.match(fn, /} else if \(deltaSecs > 0\) \{/);
  assert.match(fn, /Unchanged or REDUCED leaves `dueDate` null/);
});
