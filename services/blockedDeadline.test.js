const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

/**
 * **The dependency feature swaps priority. Nothing else.**
 * OWNER RULE, 21 Aug 2026.
 *
 * Every deadline stays the engine's own: anchors from
 * `resolveAcceptanceAnchor`, dates walked through the office calendar by
 * `addWorkingSecsIST`, chaining by `rechainQueueFor`. A task's start time is a
 * fact about that task — when its holder came online, when it was assigned,
 * what breaks were credited — and no amount of priority swapping may invent a
 * different one.
 *
 * ## What this file used to assert, and why it does not any more
 *
 * The first version of this feature pushed a blocked task's deadline out
 * directly (`blocked_on_input`) and gave it back on approval
 * (`_restoreBlockedDeadline`, `input_approved`). It worked, and it was still
 * wrong: it computed the same answer twice, from two anchors, and the two
 * disagreed the moment either side moved. The chain kept re-deriving a blocked
 * task from its original anchor and discarding the compensation the push had
 * just paid — which is exactly the symptom that was reported.
 *
 * The whole of it was unnecessary. A blocked task drops to P2, and the ordinary
 * chain anchors it after the task that overtook it:
 *
 *     T099 at P1 : 11:06 + 4h            = 15:06
 *     T099 at P2 : after T101's 12:28    = 16:28
 *
 * That IS the clock stopping while its input is unavailable — paid for by the
 * swap, through rules that already existed. So these tests now pin the ABSENCE
 * of the second mechanism, and the presence of the ordering that replaced it.
 */

const src = fs.readFileSync(require.resolve("./taskForward.service.js"), "utf8");
const office = fs.readFileSync(require.resolve("./officeDeadline.service.js"), "utf8");
const route = fs.readFileSync(
  require.resolve("../routes/task_routes/taskForward.js"),
  "utf8",
);

function fn(name) {
  const i = src.indexOf(`async function ${name}(`);
  if (i === -1) return "";
  const j = src.indexOf("\nasync function ", i + 1);
  return j === -1 ? src.slice(i) : src.slice(i, j);
}

function officeFn(name) {
  const i = office.indexOf(`function ${name}(`);
  if (i === -1) return "";
  const j = office.indexOf("\n}", i);
  return j === -1 ? office.slice(i) : office.slice(i, j + 2);
}

/* ── The second mechanism is gone, and must stay gone ─────────────────────── */

test("no separate deadline rule for blocked work exists anywhere", () => {
  for (const [name, text] of [
    ["taskForward.service.js", src],
    ["officeDeadline.service.js", office],
    ["taskForward.js (routes)", route],
  ]) {
    assert.doesNotMatch(text, /blocked_on_input/, `${name} still has the block trigger`);
    assert.doesNotMatch(text, /_restoreBlockedDeadline/, `${name} still restores deadlines`);
    assert.doesNotMatch(text, /input_approved/, `${name} still invents an anchor source`);
  }
});

test("the cascade takes no trigger and keeps its own clock dedup", () => {
  /* `checkAndExtendForP1` is back to what it was: one reason to run, and the
     2-minute dedup that suits it. */
  const body = fn("checkAndExtendForP1");
  assert.doesNotMatch(body, /trigger\s*=\s*"/);
  assert.match(body, /Date\.now\(\) - new Date\(h\.at\)\.getTime\(\)\) < 2 \* 60 \* 1000/);
  assert.match(body, /trigger: "p1_conflict_check"/);
});

test("the never-pull-earlier rail has exactly one exception, and it is named", () => {
  /**
   * The rail exists so somebody who planned around 16:00 never arrives to find
   * it is 15:00, and the dependency feature is NOT allowed to be a special
   * case — no `blocked_on_input`, no autoExtended carve-out.
   *
   * The one exception is the owner rule of 21 Aug 2026: the head of a queue
   * takes the QUEUE's start so the number does not change with whichever task
   * leads. It can only tighten (the queue start is adopted only when it is
   * earlier), it never applies inside a preview, and it is the only clause
   * beside `anchorIsQueueDerived`.
   */
  assert.match(
    office,
    /const correctsItself =\s*\n\s*\(anchorIsQueueDerived \|\| headTakesQueueStart\) &&/,
  );
  assert.match(office, /!sim &&\n      previousEndMs === null &&/);
  assert.doesNotMatch(office, /blockRuleWroteIt|autoExtendedDueToP1 === true/);
  assert.match(office, /dueMs > task\.dueMs/);
  assert.match(office, /anchorMs > task\.anchorMs/);
});

/* ── What the swap actually needs from the deadline chain ─────────────────── */

test("blocked work does not occupy its holder's queue", () => {
  /* The sibling of the `fixedDeadline` rule: only work somebody can actually
     spend an hour on pushes the work beneath it. */
  const body = officeFn("occupiesQueue");
  assert.notEqual(body, "", "occupiesQueue not found — renamed?");
  assert.match(body, /if \(outputs\.length === 0\) return true;/);
  assert.match(body, /needs\.every\(\(id\) => approvedOutputIds\.has\(id\)\)/);
  assert.match(body, /!sub\.review \|\| sub\.review\.approved === true/);
});

test("both deadline paths ORDER by it — blocked work is chained, not dropped", () => {
  /**
   * Excluding blocked work from the chain was a wrong turn: it left a blocked
   * task holding a date nothing could recompute. It still gets a deadline; it
   * is simply chained AFTER the work that overtook it, which is the ordinary
   * rule that one person does one task at a time.
   */
  assert.match(office, /workable: occupiesQueue\(other, approvedOutputIds\)/);
  assert.match(office, /workable: simulated \? true : occupiesQueue\(t, approvedOutputIds\)/);
  assert.equal(
    (office.match(/workableFirst\(/g) || []).length,
    3,
    "workableFirst should be defined once and called by both paths",
  );
});

test("a stale queue anchor is re-derived once nothing is ahead", () => {
  /**
   * The one thing the swap genuinely breaks: a task promoted past a blocked one
   * still carries `after_priority_work`, pointing at work no longer above it.
   * `resolveAcceptanceAnchor` rebuilds the task's OWN anchor from its creation
   * and its holder's duty document — so this restores an engine-derived value
   * rather than inventing one.
   */
  assert.match(office, /if \(previousEndMs === null && anchorIsQueueDerived\)/);
  assert.match(office, /const re = await resolveAcceptanceAnchor\(task\.raw, nowMs, task\.id\)/);
  assert.match(office, /re\.source !== "after_priority_work"/);
  /* And it is labelled for what it is, since that label decides whether a
     later walk may overwrite it. */
  assert.match(
    office,
    /personalAnchorMs !== null && anchorMs === personalAnchorMs\s*\?\s*personalAnchorSource/,
  );
});

test("nowMs is in scope for the walk that reads it", () => {
  /**
   * Pinned because this exact mistake — a const declared in one loop and read
   * in another — already shipped once in this feature and was swallowed by a
   * catch into a silent no-op.
   */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  const decl = body.indexOf("const nowMs = Date.now();");
  const use = body.indexOf("resolveAcceptanceAnchor(task.raw, nowMs");
  assert.ok(decl !== -1, "nowMs is not declared inside rechainQueueFor");
  assert.ok(decl < use, "nowMs is read before it is declared");
});

/* ── Announcing a new P1 ──────────────────────────────────────────────────── */

test("the announcement is deduped on the task, not on a timer", () => {
  /* The queue is derived on every page load, so an announcement wired straight
     to "what is first has changed" would notify every few seconds. */
  const body = fn("_notifyP1Changed");
  assert.match(body, /if \(empSnap\.data\(\)\.p1NotifiedTaskId === p1TaskId\) return false;/);
  assert.ok(
    body.indexOf("p1NotifiedTaskId: p1TaskId") < body.indexOf("_notifyMany"),
    "the id must be recorded before the notification is attempted",
  );
});

test("nobody is blamed for a P1 they did not change", () => {
  assert.match(fn("_notifyP1Changed"), /senderId: "system"/);
});

test("all three causes announce through the one function", () => {
  /* A block demoting a task, an approval handing the slot back, and a manual
     reorder are the same event to the person reading the queue. */
  assert.match(fn("checkAndExtendForP1"), /_notifyP1Changed\(/);
  assert.match(fn("restoreUnblockedDeadlines"), /_notifyP1Changed\(/);
  assert.match(route, /svc\._notifyP1Changed\(\{[\s\S]{0,200}p1TaskId: orderedTaskIds\[0\]/);
});

test("the sync asks the engine to re-chain and computes nothing itself", () => {
  const body = fn("restoreUnblockedDeadlines");
  assert.match(body, /rechainQueueFor\(employeeId\)/);
  assert.doesNotMatch(body, /addWorkingSecsIST|dueDate:|Date\.now\(\) \+/);
});

/* ── Two facts, two fields ────────────────────────────────────────────────── */

/**
 * **`assigneePriorities` is the decision. `effectivePriority` is the
 * consequence.** OWNER RULE, 21 Aug 2026.
 *
 * The stored rank is never overwritten — it is the only reason a task blocked
 * out of P1 climbs back the moment its input lands. But that means the rank and
 * the position shown can legitimately differ, and the difference used to live
 * nowhere: the documents said Development was P1 while every screen said P2,
 * and each consumer had to re-derive workability to find out which was true.
 *
 * Verified against grav-cms-38f45: T102 stored P2 / effective P1, T103 stored
 * P1 / effective P2, with both stored ranks untouched.
 */

test("the derived position is written, and the stored rank never is", () => {
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  assert.match(body, /const positionOf = new Map\(ordered\.map\(\(t, i\) => \[t\.id, i \+ 1\]\)\)/);
  assert.match(body, /effectivePriority: positionOf\.get\(task\.id\)/);
  /* The decision is untouchable — checked against CODE, since the comments
     above the write necessarily name the field they promise not to touch. */
  const code = body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /assigneePriorities/);
});

test("a task written for its deadline is not written twice", () => {
  /* The position rides along on the deadline update where there is one. */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  assert.match(body, /wroteFor\.add\(task\.id\);/);
  assert.match(body, /if \(wroteFor\.has\(t\.id\)\) return null;/);
  /* And an unchanged position costs no write either. */
  assert.match(body, /if \(Number\(t\.raw\?\.effectivePriority\) === position\) return null;/);
});

test("work that leaves the queue does not keep a position", () => {
  /* A stale number here reads exactly like a live one. */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  assert.match(body, /!held\.has\(d\.id\) && d\.effectivePriority !== undefined/);
  assert.match(body, /effectivePriority: admin\.firestore\.FieldValue\.delete\(\)/);
});

test("a dry run writes no position at all", () => {
  /* The rejection preview asks this on every keystroke. */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  const guard = body.indexOf('if (!opts.dryRun) {\n    const admin');
  assert.ok(guard !== -1, "the position write is not behind a dryRun guard");
  /* The STANDALONE write specifically — `effectivePriority: position` also
     matches `positionOf` in the deadline update further up. */
  const standalone = body.indexOf("t.ref.update({ effectivePriority: position })");
  assert.ok(standalone !== -1, "the standalone position write has moved");
  assert.ok(guard < standalone, "the position write escapes the dryRun guard");
});

test("the re-anchor can only pull a start EARLIER, never later", () => {
  /**
   * Its whole job is undoing a queue push, and a push always moves an anchor
   * later — so the personal anchor it displaced must lie before it. Anything
   * later is drift, and drift here hands out time nobody granted.
   *
   * Two real routes to it: `acceptanceAnchorMs` returns `now` under the
   * `acceptance` source whenever nothing is provable (an unreadable duty
   * document is enough), and `first_online` reads the duty document's
   * `updatedAt` as the session start — which moves whenever anything else
   * writes that document.
   */
  assert.match(office, /re\.source !== "acceptance" &&/);
  assert.match(office, /re\.anchorMs < task\.anchorMs;/);
  /* And nothing is adopted unless all of those hold. */
  assert.match(office, /if \(isRecovery\) \{/);
});

/* ── A departed task leaves no hole ───────────────────────────────────────── */

/**
 * **A rank is a position, and positions do not have holes.**
 *
 * Ranks are handed out as "your open task count + 1", so they are contiguous
 * when written. Then a task is deleted and the numbers around it are left
 * alone. Reported from a real queue: two tasks reading P1 and P3, because the
 * task that had been 2 was gone — and nothing on screen could explain the
 * missing number, since nothing was missing.
 *
 * The ACTIVE queue hides this by renumbering what it shows. Work awaiting
 * acceptance displays the STORED rank (owner decision, 17 Aug), so there the
 * hole is visible and permanent. The hole is now not left.
 *
 * Verified against grav-cms-38f45: GR0045 held P1 and P3, and closing the gap
 * left P1 and P2 with the order unchanged.
 */

test("deleting a task renumbers what is left behind", () => {
  const body = fn("deleteTask");
  assert.match(body, /_closeRankGaps\(holder\)/);
  /* Every holder, including one still waiting at the cross-department gate. */
  assert.match(body, /task\.assigneeIds \|\| \[\]\), task\.pendingAssigneeId/);
});

test("renumbering preserves order and only compacts the numbers", () => {
  /* It must never reorder somebody's work — the sequence is the rank they had,
     then which was raised first, exactly the tie-break the queue uses. */
  const body = fn("_closeRankGaps");
  assert.notEqual(body, "", "_closeRankGaps not found — renamed?");
  assert.match(body, /a\.rank - b\.rank \|\| a\.createdMs - b\.createdMs/);
  assert.match(body, /assigneePriorities\.\$\{employeeId\}`\]: position/);
});

test("it skips work that holds no slot", () => {
  /* Finished work, and a broken-down task, which is a project rather than a
     queue slot — the same exclusion the queue itself makes. */
  const body = fn("_closeRankGaps");
  assert.match(body, /TERMINAL\.includes\(t\.status\)/);
  assert.match(body, /\(t\.subtaskIds \|\| \[\]\)\.length > 0/);
});

test("a rank already correct is not rewritten", () => {
  /* The overwhelmingly common case: nothing moved, so nothing is written. */
  assert.match(fn("_closeRankGaps"), /if \(Number\(t\.current\) === position\) return null;/);
});

/* ── An approval reorders somebody else's day ─────────────────────────────── */

/**
 * **The trigger that was missing.**
 *
 * A dependency means one person's approval changes ANOTHER person's queue:
 * Umung approves an output, Rakesh's blocked task becomes workable, it climbs
 * back and his dates move with it. `_releaseOutputDependents` told him and
 * stopped — his order and deadlines stayed frozen in the blocked arrangement
 * until he happened to open a task list and the throttled sync fired.
 *
 * Reported from live data: Dev stored P1 and workable again, still sitting at
 * effective P2 with the early slot held by Cowork, hours after its input landed.
 *
 * This is safe where the earlier push-and-give-back pair was not, and the
 * difference is exact: that computed a deadline of its own and argued with the
 * chain. This computes nothing — it asks the one chain to re-walk.
 */

test("approving an output re-chains everybody it unblocked", () => {
  const body = fn("_releaseOutputDependents");
  assert.match(body, /await _rechainAffected\(affected\);/);
  /* Collected inside the loop, walked once after it — a person holding two
     freed tasks must not have their queue walked twice. */
  assert.ok(
    body.indexOf("affected.push") < body.indexOf("_rechainAffected(affected)"),
    "the re-chain must run after the whole sweep, not per task",
  );
});

test("order changes even where there is nobody to notify", () => {
  /* A self-assigned task frees no recipient but still climbs the queue, so the
     collection must not sit behind the notification guard. */
  const body = fn("_releaseOutputDependents");
  assert.ok(
    body.indexOf("affected.push") < body.indexOf("if (!recipients.length) continue;"),
    "a task with no one to notify would be left un-rechained",
  );
});

test("it re-walks the engine's chain and computes no date itself", () => {
  /* The distinction that keeps this from becoming a second opinion about
     deadlines — the fault that sank `blocked_on_input`. */
  const body = fn("_rechainAffected");
  assert.notEqual(body, "", "_rechainAffected not found — renamed?");
  assert.match(body, /rechainQueueFor\(id\)/);
  assert.doesNotMatch(body, /addWorkingSecsIST|dueDate|clockStartsAtMs/);
});

test("each person is walked once, and a failure cannot fail the approval", () => {
  const body = fn("_rechainAffected");
  assert.match(body, /\[\.\.\.new Set\(employeeIds\.filter\(Boolean\)\)\]/);
  assert.match(body, /catch \(e\) \{/);
});

/* ── Nothing starts before it was allowed to ──────────────────────────────── */

/**
 * **A task blocked on somebody else's output cannot begin before that output
 * was approved.** OWNER RULE, 21 Aug 2026.
 *
 * The chain handled this whenever something sat ABOVE the task — that task
 * finishes after the approval anyway. The hole was a blocked task reaching the
 * FRONT, where it took the queue's start instead and was charged hours it was
 * forbidden to work.
 *
 * **The EARLIEST unblocking, not the last.** A task is workable when ANY one of
 * its outputs is startable — the rule `occupiesQueue` already uses — so a task
 * waiting on Gopalpur (approved 14:00) and Puri (approved 17:00) could have
 * begun at 14:00.
 *
 * Verified by execution: Dependent alone at the front of a queue starting 10:00
 * was anchored 14:00, not 10:00 and not 17:00.
 */

test("the anchor is the LATEST approval that frees an output", () => {
  /**
   * **Superseded by an OWNER RULE of 26 Aug 2026.** This took the EARLIEST
   * approval until then, which meant one task carrying two dependent outputs
   * was anchored by whichever input happened to land first and never moved
   * again:
   *
   *   puri approved 10:00, paradeep approved 13:00  ->  anchored 10:00
   *   the 13:00 approval changed nothing at all
   *
   * The half of the work that only became possible at 13:00 was then scheduled
   * as though it could have started at 10:00, and the assignee lost three
   * hours of budget to a wait somebody else owned.
   *
   * The latest approval is the moment the task became FULLY workable, and the
   * walk counts the REMAINING budget from it — see `secsToSchedule`, which is
   * the other half of this rule and stops the hours already worked on the
   * unblocked part being handed back.
   */
  const body = officeFn("unblockedAtMs");
  assert.notEqual(body, "", "unblockedAtMs not found — renamed?");
  /* Latest across outputs... */
  assert.match(body, /if \(latest === null \|\| lastOfThisOutput > latest\) latest = lastOfThisOutput;/);
  /* ...but an output is not free until ALL of ITS inputs are. */
  assert.match(body, /if \(at > lastOfThisOutput\) lastOfThisOutput = at;/);
  assert.match(body, /if \(!allApproved\) continue;/);
});

test("a task that was never held up is not constrained", () => {
  /* An output needing no input is startable from the beginning, so the rule has
     nothing to say about that task at all. */
  const body = officeFn("unblockedAtMs");
  assert.match(body, /if \(needs\.length === 0\) return null;/);
  assert.match(body, /if \(outputs\.length === 0\) return null;/);
});

test("the approval IS the anchor — it replaces what the chain decided", () => {
  /**
   * **Superseded by an OWNER RULE of 26 Aug 2026.** This read the other way
   * round until then — the approval was applied as a `max`, on the reasoning
   * that it must never make a deadline harder than the queue already had.
   *
   * The owner's case retired that reasoning. Two of one person's tasks, each
   * waiting on a different output of somebody else's:
   *
   *   Puri Dev    (4h)  input approved 10:00  ->  due 14:00
   *   Pardeep Dev (6h)  input approved 13:00  ->  due 19:00
   *
   * Under the `max`, Pardeep Dev chained behind Puri Dev's 14:00 finish and
   * came out at 20:00, because 14:00 was later than its own 13:00 approval.
   * The approval is the moment the work became possible and the instant its
   * budget is counted from, so it decides the date outright — including where
   * that pulls it earlier than the queue would have.
   *
   * It is still applied AFTER the chain, which is what lets it overrule one;
   * the ordering assertion further down is unchanged.
   */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  assert.match(
    body,
    /if \(Number\.isFinite\(task\.freedAtMs\)\)[\s\S]{0,1600}?previousEndMs === null[\s\S]{0,120}?\? task\.freedAtMs[\s\S]{0,120}?: Math\.max\(anchorMs, task\.freedAtMs\)/,
    "the approval no longer leads at the head, or no longer floors behind live work",
  );
  /* The `> anchorMs` form still exists, and must — but for the OTHER case.
     A task still WAITING on its input floors at now and may only ever be
     pushed later; applied exactly, that dragged a blocked task on top of the
     work above it. Only a real approval replaces the anchor outright. */
  assert.match(
    body,
    /task\.unblockedAtMs > anchorMs/,
    "the waiting floor stopped being a max — a blocked task can overtake live work",
  );
  /* And the anchor must be assignable for that to work — this threw
     "Assignment to constant variable" on the first attempt, which every
     source-assertion test in this file happily passed. */
  assert.match(body, /let anchorMs =/);
});

test("a preview keeps the start the caller asked about", () => {
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  assert.match(body, /unblockedAtMs: simulated \? null : unblockedAtMs\(t, approvedAtById, nowMs\)/);
});

test("the approval instant is recorded when the review is written", () => {
  /* Without `reviewedAt` there is nothing to anchor to. */
  assert.match(fn("reviewOutput"), /reviewedAt: new Date\(\)\.toISOString\(\)/);
});

test("nowMs is declared before everything that reads it", () => {
  /**
   * Pinned because this exact slip has now happened three times in this file —
   * `_blockedRefire`, `anchorMs` as a const, and `nowMs` — and every one of
   * them threw at runtime while the whole source-assertion suite passed. These
   * tests cannot see an execution fault, so the shape has to be asserted.
   */
  const i = office.indexOf("async function rechainQueueFor(");
  const body = office.slice(i);
  const decl = body.indexOf("const nowMs = Date.now();");
  assert.ok(decl !== -1, "nowMs is not declared inside rechainQueueFor");
  for (const m of body.matchAll(/\bnowMs\b/g)) {
    assert.ok(
      m.index >= decl,
      `nowMs is read at ${m.index}, before its declaration at ${decl}`,
    );
  }
});

test("a still-blocked task floors at now, so its deadline does not burn", () => {
  /**
   * OWNER RULE, 21 Aug 2026. A task waiting with NOTHING approved had no floor
   * at all — it fell back to the queue start and its deadline ran down while it
   * sat unable to touch the work. With nothing above it in the queue that is
   * the whole of its clock, running against a wait somebody else owns.
   *
   * While it waits the floor moves with the clock. The moment an input is
   * approved the approval branch answers instead, a FIXED instant, and the
   * date stops moving.
   *
   * The variable is `latest` rather than `earliest` since the OWNER RULE of
   * 26 Aug 2026 — see the test above. This rule is unchanged by that: a task
   * with NOTHING approved has neither, and still floors at now.
   */
  const body = officeFn("unblockedAtMs");
  assert.match(body, /if \(latest === null && Number\.isFinite\(nowMs\)\) return nowMs;/);
  /* And it must come AFTER the approval search, so a freed task gets the fixed
     instant rather than the moving one. */
  assert.ok(
    body.indexOf("if (!allApproved) continue;") < body.indexOf("latest === null && Number.isFinite(nowMs)"),
  );
});
