/**
 * GRAV-CMS-BACKEND/services/officeDeadline.service.js
 *
 * One answer to "this much working time, starting here — when is it due?".
 *
 * **Why a module rather than a fifth copy.** `_addWorkingSecsIST` exists
 * verbatim in `taskForward.js`, twice in `taskTree.routes.js`, and once more as
 * `_addWorkingSecsIST_svc` in `taskForward.service.js`. Every path that grants
 * working time has to answer the same question, and each copy is a place the
 * answer can drift. The existing four are left alone — a bug fix is the wrong
 * moment to re-point working call sites — but nothing new should add a fifth.
 *
 * The arithmetic is carried over unchanged: walk forward from the start,
 * skipping days marked off, time outside the day's in/out hours, and every
 * recurring break, until the requested working seconds have been consumed.
 */

/* Firebase is required lazily, inside the one function that needs it. At module
   scope it would drag credentials and a live connection into anything that only
   wants the arithmetic — including the tests, which is how date maths ends up
   with no tests at all. */

const DAY_KEYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const IST = 5.5 * 3600000;

/**
 * Lay `windowSecs` of WORKING time forward from `startMs`.
 *
 * Working time only: a two-hour budget granted at 17:15 lands mid-morning the
 * next working day, not at 19:15 the same night.
 *
 * The no-schedule fallback is raw wall-clock addition. It deliberately does NOT
 * carry the `+ 6 * 3600000` marker the copy in `taskForward.js:1931` adds — that
 * is a debugging probe ("BRANDED PROBE") for spotting the fallback in real data,
 * and six unexplained hours on a real deadline is not a behaviour to spread.
 */
function addWorkingSecsIST(startMs, windowSecs, schedule, breaks) {
  if (!schedule || windowSecs <= 0) {
    console.error("[officeDeadline] no schedule — falling back to wall clock", {
      hasSchedule: !!schedule,
      windowSecs,
    });
    return new Date(startMs + windowSecs * 1000).toISOString();
  }

  const dateStrOf = (ms) => new Date(ms + IST).toISOString().slice(0, 10);
  const dowOf = (ms) =>
    new Date(Date.parse(dateStrOf(ms) + "T00:00:00Z")).getUTCDay();

  let remaining = windowSecs;
  let cur = startMs;
  let guard = 0;

  while (remaining > 0 && guard++ < 3660) {
    const ds = dateStrOf(cur);
    const day = schedule[DAY_KEYS[dowOf(cur)]];
    const nextMidnight = Date.parse(ds + "T00:00:00+05:30") + 86400000;
    if (!day || day.isOff) { cur = nextMidnight; continue; }

    const dayStart = Date.parse(`${ds}T${day.inTime}:00+05:30`);
    const dayEnd = Date.parse(`${ds}T${day.outTime}:00+05:30`);
    if (cur < dayStart) cur = dayStart;
    if (cur >= dayEnd) { cur = nextMidnight; continue; }

    const todaysBreaks = (breaks || [])
      .map((b) => ({
        s: Date.parse(`${ds}T${b.start}:00+05:30`),
        e: Date.parse(`${ds}T${b.end}:00+05:30`),
      }))
      .filter((b) => b.e > b.s)
      .sort((a, b) => a.s - b.s);

    const inBrk = todaysBreaks.find((b) => cur >= b.s && cur < b.e);
    if (inBrk) { cur = inBrk.e; continue; }

    const nextBrkStart = (todaysBreaks.find((b) => b.s > cur) || {}).s;
    const segEnd = Math.min(dayEnd, nextBrkStart == null ? Infinity : nextBrkStart);
    const segSecs = Math.floor((segEnd - cur) / 1000);
    if (segSecs >= remaining) {
      return new Date(cur + remaining * 1000).toISOString();
    }
    remaining -= segSecs;
    cur = segEnd;
  }
  return new Date(cur).toISOString();
}

/** Read the office schedule once. Never throws — a failure means no schedule. */
async function readOfficeCalendar() {
  try {
    const { db } = require("../config/firebaseAdmin");
    const snap = await db.collection("cowork_settings").doc("office").get();
    if (!snap.exists) return { schedule: null, breaks: [] };
    return { schedule: snap.data().schedule || null, breaks: snap.data().breaks || [] };
  } catch (e) {
    console.error("[officeDeadline] office settings unreadable:", e.message);
    return { schedule: null, breaks: [] };
  }
}

/**
 * The deadline for a granted window, through the office calendar.
 *
 * Pass `calendar` when the caller already read it — a transaction must do its
 * reads before its writes, so the settings cannot be fetched from inside one.
 */
async function computeWorkingDeadline({ startMs, windowSecs, calendar = null }) {
  const cal = calendar || (await readOfficeCalendar());
  return addWorkingSecsIST(startMs, windowSecs, cal.schedule, cal.breaks);
}

/**
 * Epoch ms from whatever the document happens to carry.
 *
 * A Firestore Timestamp, a number, an ISO string — the same field is written by
 * `serverTimestamp()` in one path and read back through several. Null for
 * anything that is not a usable instant, so a caller can fall back rather than
 * compute a deadline from `NaN`.
 */
function readMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value.toMillis === "function") {
    try { return value.toMillis(); } catch { return null; }
  }
  if (typeof value._seconds === "number") return value._seconds * 1000;
  return null;
}

/**
 * Where a task's clock starts when its budget is accepted.
 *
 * **The owner's rule: whoever causes the delay bears it** (DEADLINE_START_RULE
 * in the Cowork repo). Three cases, in order:
 *
 *  · `hours_granted` — a cross-department grant recorded `tlHoursSetAt*`. The
 *    assignee could do nothing before the grant, so the wait was never theirs.
 *  · `first_online` — a normal task. The assignee had the task and its proposed
 *    hours the whole time, so the clock runs from the first PROVABLE moment
 *    they were online at or after it was given: their current duty session's
 *    start, floored at the task's creation. Sitting on an acceptance while
 *    online no longer buys a later deadline — T019 was given at 10:41:54,
 *    its assignee online from 10:56:20, accepted 12:01:42, and the old
 *    acceptance anchor handed the 1h05m of sitting back as extra deadline.
 *  · `acceptance` — nothing provable. Not online now, or the current session
 *    began after the moment being asked about. The press itself is the first
 *    moment presence can be demonstrated, so it is the honest floor — and it
 *    is exactly the old behaviour, so nothing here ever produces a LATER
 *    deadline than before.
 *
 * Pure and clock-free so the rule is testable; `nowMs` is the acceptance
 * instant. Passing a PAST acceptance replays the rule as it stood then: the
 * session-start guard `<= nowMs` then also proves the session spanned that
 * acceptance, which is what makes the same function serve the backfill.
 *
 * The result may lie in the past and the deadline it produces may already be
 * gone. That is the rule working — the task is simply Overdue — and the owner
 * has said so explicitly. Never clamp it to now.
 */
function acceptanceAnchorMs({
  tlHoursSetMs,
  createdMs,
  dutyMode,
  dutySessionStartMs,
  nowMs,
  hasOpenWork,
}) {
  if (Number.isFinite(tlHoursSetMs) && tlHoursSetMs > 0) {
    /* The grant is the earliest the assignee could begin — nothing was theirs
       to do before it. But if they were OFFLINE when the hours were granted and
       only came online later, the clock waits for them, exactly as first_online
       does for a normal task: the granted hours promise that much WORKING time,
       and time they could not be present for was not time they could work.

       `max` so it only ever moves LATER — online since before the grant keeps
       the grant; and it reads the SESSION START, not `nowMs`, so sitting on the
       task while online buys nothing, the same guard first_online makes. */
    if (
      dutyMode === "online" &&
      Number.isFinite(dutySessionStartMs) &&
      dutySessionStartMs > tlHoursSetMs &&
      dutySessionStartMs <= nowMs
    ) {
      return { anchorMs: dutySessionStartMs, source: "hours_granted" };
    }
    return { anchorMs: tlHoursSetMs, source: "hours_granted" };
  }
  /**
   * **Their first task — nothing else was open, so nothing was theirs to do.**
   *
   * OWNER DECISION. `first_online` below charges an online person from the
   * moment the task was created, deliberately, so that sitting on an acceptance
   * buys nothing. That is right while they have work: the time was theirs and
   * they spent it. It is wrong when they had NOTHING open — there was no work
   * to sit on, so the gap before they took this on was never work time.
   *
   * `hasOpenWork` is resolved by the caller and passed in, so this stays pure.
   * It is OPT-IN: only an explicit `false` — a caller that actually looked and
   * found nothing open — takes this branch. `undefined` means nobody asked, and
   * every existing caller falls through to exactly the rule it had before.
   *
   * Deliberately BELOW the grant branch, so a cross-department task never
   * reaches it: a granted task anchors at its grant and that path is untouched.
   *
   * Can only ever move a deadline LATER — acceptance is at or after creation —
   * which is the same safety property the rest of this function keeps.
   */
  if (hasOpenWork === false && Number.isFinite(nowMs)) {
    const anchorMs =
      Number.isFinite(createdMs) && createdMs > 0
        ? Math.max(createdMs, nowMs)
        : nowMs;
    return { anchorMs, source: "first_task" };
  }

  if (
    dutyMode === "online" &&
    Number.isFinite(dutySessionStartMs) &&
    dutySessionStartMs > 0 &&
    dutySessionStartMs <= nowMs &&
    Number.isFinite(createdMs) &&
    createdMs > 0
  ) {
    /* Online since before the task existed → the clock starts with the task;
       came online after it was given → starts when they arrived. */
    return { anchorMs: Math.max(createdMs, dutySessionStartMs), source: "first_online" };
  }
  return { anchorMs: nowMs, source: "acceptance" };
}

/**
 * The anchor for one task, from live data. Read OUTSIDE any transaction.
 *
 * Reads the ASSIGNEE's duty document — never the caller's: an assignor
 * accepting the assignee's counter still starts the assignee's clock.
 */
/**
 * Statuses that take a task OUT of the queue. Exactly the list
 * `checkAndExtendForP1` uses — the two halves of the priority-deadline rule
 * must not disagree about which work is still ahead of you.
 */
const TERMINAL_STATUSES = ["done", "cancelled", "tl_final_approved", "ceo_approved"];

/**
 * Has this task been handed in and is now waiting on somebody else?
 *
 * It is NOT terminal — the manager can still send it back, so it keeps its
 * place in the queue and its score is still open. But the person is no longer
 * working on it, which is a different question and the one the queue cares
 * about.
 */
function isAwaitingReview(task) {
  return (
    !TERMINAL_STATUSES.includes(task.status) &&
    task.completionStatus === "submitted"
  );
}

/**
 * When this task stopped occupying its assignee — the value everything BELOW
 * it in the queue should chain from.
 *
 * OWNER DECISION, 18 Aug 2026. Reported: A is due 2pm and handed in at 1pm; B
 * is two hours and came out due 4pm, as though the person sat idle until A's
 * deadline. They did not — they were free at 1pm, and B's honest finish is
 * 3pm.
 *
 * **Submission, not the deadline.** The old reading was wrong in both
 * directions, which is what gives it away: finishing an hour early bought the
 * person nothing, and handing in half an hour LATE still started the next task
 * at the old deadline, so B inherited a deadline it never had a chance to
 * meet. The moment the work left their hands is the only honest answer to
 * both.
 *
 * A task still being worked on has no such moment yet, so its deadline stands
 * — it is the best estimate available, and it is what the engine has always
 * used.
 */
function effectiveEndMs(task) {
  if (isAwaitingReview(task)) {
    const handedOver = readMs(task.completionSubmission?.submittedAt);
    if (Number.isFinite(handedOver)) return handedOver;
  }
  return readMs(task.dueDate);
}

/**
 * The last moment this person actually put this task DOWN.
 *
 * `effectiveEndMs` above answers the same question for a task handed over
 * whole, and only for that: it reads `completionSubmission`, which exists only
 * once every requirement is delivered. A task with OUTPUTS is handed over a
 * piece at a time, so a person can deliver everything they are currently able
 * to deliver — the rest waiting on somebody else — while the task itself is
 * still `confirmed` and carries no completion submission at all.
 *
 * That instant is real work leaving their hands, and the queue behind it has
 * to start from it. Reported: an output submitted at 18:58 left the next task
 * anchored at the queue's 18:35 start, so it reached the front already
 * carrying a deadline that had expired.
 *
 * **The SUBMISSION, never the approval.** Waiting on a reviewer is not the
 * assignee's time to lose — they were free the moment they handed it over,
 * and whether it comes back approved at 19:24 or rejected next morning
 * changes nothing about when they could start the next thing.
 */
function lastHandoverMs(task) {
  let latest = null;
  const consider = (value) => {
    const m = readMs(value);
    if (Number.isFinite(m) && (latest === null || m > latest)) latest = m;
  };
  consider(task.completionSubmission && task.completionSubmission.submittedAt);
  const subs = task.outputSubmissions || {};
  for (const key of Object.keys(subs)) {
    consider(subs[key] && subs[key].submittedAt);
  }
  return latest;
}

/** This person's rank on this task — legacy's own precedence. */
function rankOf(task, employeeId) {
  const per = task.assigneePriorities || {};
  const mine = employeeId != null ? per[employeeId] : undefined;
  const n = Number(mine ?? task.priority);
  return Number.isFinite(n) && n > 0 ? n : 99;
}



/**
 * The order the SCREEN shows — `workableFirst`, ported from
 * `lib/rules/tasks/priorityQueue.ts` and deliberately identical to it.
 *
 * Blocked work does not lead a queue: whatever can actually be started takes
 * the top spot, and the blocked task drops exactly one place. Nothing else
 * moves, and no stored rank is touched — which is what returns the task to its
 * own position the moment its input is approved.
 *
 * **The chain must walk THIS order, not the stored one.** Both were being used:
 * the screen showed T101 first and the chain believed T099 was, so T101 kept a
 * deadline computed for second place and T099 kept one computed from T101's
 * old date. If this ever diverges from the frontend's copy, that is the bug.
 */
function workableFirst(order) {
  if (order.length === 0 || order[0].workable !== false) return order;
  const firstWorkable = order.findIndex((c) => c.workable !== false);
  if (firstWorkable === -1) return order;
  return [
    order[firstWorkable],
    ...order.slice(0, firstWorkable),
    ...order.slice(firstWorkable + 1),
  ];
}

/**
 * **Work you are blocked from starting does not occupy your queue.**
 *
 * The sibling of the `fixedDeadline` rule below it: only work somebody can
 * actually spend an hour on pushes the work beneath it. A task waiting on
 * another person's unapproved output is not time being spent — it is time
 * being waited on — and counting it as queue-occupying gives the task below a
 * deadline built around hours nobody can work.
 *
 * Reported with real data: T099 was P1 and blocked on Umung's design; T101 was
 * raised beneath it and anchored `after_priority_work` at T099's 15:06 finish,
 * coming out due 16:06. But T099 could not be started at all, so T101 was
 * really first and its honest deadline was 12:28 — nearly four hours earlier.
 *
 * **This is what keeps ONE order.** `workableFirst` in the frontend promotes
 * past a blocked task for display without touching a stored rank, deliberately,
 * so the task returns to its own place when its input lands. Every deadline
 * path here walked the STORED order instead, so the chain believed a blocked
 * task was first while the screen said it was second. Same question, two
 * answers — the exact fault this codebase keeps paying for.
 *
 * A task with no outputs occupies the queue exactly as before: every task that
 * predates the feature takes the first branch and nothing changes for it.
 */
function occupiesQueue(task, approvedOutputIds) {
  const outputs = Array.isArray(task.outputs) ? task.outputs : [];
  if (outputs.length === 0) return true;
  const subs = task.outputSubmissions || {};
  return outputs.some((o) => {
    const needs = Array.isArray(o.needsOutputIds) ? o.needsOutputIds : [];
    /* An unknown id counts as NOT approved: releasing on missing data would
       start a clock against work whose input may not exist. */
    if (!needs.every((id) => approvedOutputIds.has(id))) return false;
    const sub = subs[o.id];
    /* Already handed over, or already approved — nothing left to sit down to. */
    if (sub && (!sub.review || sub.review.approved === true)) return false;
    return true;
  });
}

/**
 * Every output approved ANYWHERE, because an input is by definition somebody
 * else's output. Cached for a few seconds: a re-chain asks once per walk and a
 * queue read asks once per task, and the answer cannot meaningfully change
 * between them.
 */
let _approvedCache = { at: 0, ids: null, times: null };
async function _approvedIndex() {
  if (_approvedCache.ids && Date.now() - _approvedCache.at < 5000) return _approvedCache;
  const ids = new Set();
  /** outputId -> the instant its approval was recorded. */
  const times = new Map();
  try {
    const { db } = require("../config/firebaseAdmin");
    const snap = await db.collection("cowork_tasks").where("hasOutputs", "==", true).get();
    snap.forEach((d) => {
      const subs = d.data().outputSubmissions || {};
      for (const [oid, sub] of Object.entries(subs))
        if (sub && sub.review && sub.review.approved === true) {
          ids.add(oid);
          const at = readMs(sub.review.reviewedAt);
          if (Number.isFinite(at)) times.set(oid, at);
        }
    });
  } catch (e) {
    /* An unreadable index means "nothing is approved", which keeps blocked work
       OUT of the chain. That is the safe direction: it can only ever pull a
       deadline earlier, never push one past a date somebody was promised. */
    console.warn("[officeDeadline] output index read failed:", e.message);
  }
  _approvedCache = { at: Date.now(), ids, times };
  return _approvedCache;
}

/** Every output approved anywhere. */
async function approvedOutputIdsNow() {
  return (await _approvedIndex()).ids;
}

/**
 * **When this task could FIRST have been started.**
 *
 * A task blocked on somebody else's output cannot begin before that output is
 * approved, so its clock must not start earlier — otherwise it is charged hours
 * it was forbidden to work. The chain handles this whenever something sits
 * ABOVE it (that task finishes later anyway); the hole is a blocked task that
 * reaches the FRONT, where the queue start would otherwise apply.
 *
 * **The EARLIEST unblocking, not the last.** OWNER DECISION, 21 Aug 2026. An
 * output whose own inputs are all approved is startable, and a task is workable
 * when ANY one of them is — the same rule `occupiesQueue` uses. So a task
 * waiting on Gopalpur (approved 14:00) and Puri (approved 17:00) could have
 * begun at 14:00, and 14:00 is its start.
 *
 * Returns null where the rule has nothing to say: no outputs, an output that
 * needs no input (startable from the beginning, so never constrained), or
 * nothing approved yet.
 */
function unblockedAtMs(task, approvedAt, nowMs) {
  const outputs = Array.isArray(task.outputs) ? task.outputs : [];
  if (outputs.length === 0) return null;
  let latest = null;
  for (const o of outputs) {
    const needs = Array.isArray(o.needsOutputIds) ? o.needsOutputIds : [];
    /* Nothing to wait for — this task was never held up. */
    if (needs.length === 0) return null;
    /**
     * **An output already handed over cannot be what holds the clock still.**
     * OWNER RULE, 26 Aug 2026.
     *
     * The clock freezes on an approval because the approval gave this person
     * something to do. Once they have DONE it and handed it over, that reason
     * is spent: they are waiting on somebody else again, and the deadline must
     * resume moving exactly as it did before the first input landed.
     *
     * Reported as four states of one pair of tasks:
     *   · input not submitted        -> waiting   -> time moves
     *   · input approved             -> workable  -> time stops
     *   · that work handed over      -> waiting   -> time moves again
     *   · next input approved        -> workable  -> time stops
     *
     * Only the third was wrong: the first approval kept the clock frozen while
     * the person sat idle, so the wait for the SECOND input came out of their
     * budget.
     *
     * A RETURNED output is not handed over — the reviewer gave it back, it is
     * work again, and it holds the clock like any other workable output.
     */
    const sub = (task.outputSubmissions || {})[o.id];
    const handedOver =
      sub && sub.submittedAt && (!sub.review || sub.review.approved === true);
    if (handedOver) continue;
    let lastOfThisOutput = 0;
    let allApproved = true;
    for (const n of needs) {
      const at = approvedAt.get(n);
      if (!Number.isFinite(at)) { allApproved = false; break; }
      if (at > lastOfThisOutput) lastOfThisOutput = at;
    }
    /* Still waiting on something: this output cannot be the one that freed it. */
    if (!allApproved) continue;
    /**
     * **The LATEST approval, not the earliest.** OWNER RULE, 26 Aug 2026.
     *
     * This took the earliest, which meant one task with two dependent outputs
     * was anchored by whichever input landed FIRST and never moved again:
     *
     *   puri approved 10:00, paradeep approved 13:00  ->  anchored 10:00
     *   the 13:00 approval changed nothing at all
     *
     * So the half of the work that only became possible at 13:00 was scheduled
     * as though it could have been started at 10:00, and the person lost three
     * hours of their budget to a wait somebody else owned.
     *
     * The latest approval is the moment the task became fully workable, which
     * is the honest place to count the REMAINING budget from — see where the
     * seconds are chosen in the walk below.
     */
    if (latest === null || lastOfThisOutput > latest) latest = lastOfThisOutput;
  }

  /**
   * **Nothing freed yet, so it still cannot start — and the floor is NOW.**
   *
   * Without this a task waiting with no approval at all had no floor: it fell
   * back to the queue's start and its deadline burned down while it sat unable
   * to touch the work. With nothing above it in the queue that is the whole of
   * its clock, running against a wait somebody else owns.
   *
   * So while it waits the floor moves with the clock and the deadline keeps
   * pushing out. The moment an input is approved the branch above answers
   * instead — a FIXED instant — and the date stops moving. Waiting costs the
   * assignee nothing; being free and idle costs them normally.
   *
   * This is a deliberate exception to "a due date is decided once and then
   * holds still". It is the one case where holding still would be a promise the
   * person was forbidden to keep.
   */
  if (latest === null && Number.isFinite(nowMs)) return nowMs;
  return latest;
}

/**
 * When the work already AHEAD of this task in its assignee's queue finishes.
 *
 * OWNER DECISION, 17 Aug 2026. A person works one task at a time, so a P2
 * cannot honestly start before the P1 above it is done — but each deadline was
 * computed from its own anchor and its own budget, in ignorance of the queue.
 * Reported: T057 (P1, due 13:23) and T059 (P2, 1h10m) both created that
 * morning, and T059 came out due 14:07 — its own 12:57 start plus its own
 * budget, as though the P1 did not exist. Its earliest honest finish is 14:33.
 *
 * The engine already had HALF of this rule: `checkAndExtendForP1` pushes
 * lower-priority deadlines out when a P1 arrives. It fires only on
 * `Number(priority) === 1`, so it answers "a P1 arrived, move everything
 * below it" and has never answered "this new task arrives BELOW work that
 * already exists". That is the half added here.
 *
 * Returns null when nothing is ahead — the overwhelmingly common case, and the
 * one that leaves the anchor exactly as it was.
 */
async function queueAheadEndMs(task, taskId, employeeId, nowMs) {
  if (!employeeId) return null;
  const approvedOutputIds = await approvedOutputIdsNow();
  let snap;
  try {
    const { db } = require("../config/firebaseAdmin");
    snap = await db
      .collection("cowork_tasks")
      .where("assigneeIds", "array-contains", String(employeeId))
      .get();
  } catch (e) {
    /* An unreadable queue costs the chaining, never the acceptance — the task
       keeps the personal anchor it would have had before this rule existed. */
    console.warn("[officeDeadline] queue read failed:", e.message);
    return null;
  }

  const myCreated = readMs(task.createdAtISO) ?? readMs(task.createdAt) ?? nowMs;
  const ME = "\u0000me";

  /**
   * **Built as a list and ordered, rather than compared pair by pair.**
   *
   * The pairwise form could only ask "does this one out-rank me", which is a
   * question about STORED rank — and the promotion that puts workable work
   * above blocked work is a property of the whole queue, not of any two tasks
   * in it. Asking it pairwise gave the blocked task no one ahead of it and the
   * promoted task everyone, which is how T099 kept a date computed from T101's
   * old deadline while T101 kept one computed from T099's.
   *
   * Same list, same sort, same `workableFirst` as `rechainQueueFor`, so the
   * anchor a task is given on acceptance and the date the walk later computes
   * for it cannot disagree.
   */
  const candidates = [];
  snap.forEach((doc) => {
    if (taskId && doc.id === taskId) return;
    const other = doc.data();
    if (TERMINAL_STATUSES.includes(other.status)) return;
    /**
     * **A fixed calendar date does not occupy your queue.** OWNER DECISION,
     * 17 Aug 2026. Only BUDGETED work pushes: a task given a date rather than
     * hours — a report due next Friday — is a deadline, not time being spent.
     */
    if (other.fixedDeadline || other.hasTimer === false) return;
    candidates.push({
      id: doc.id,
      rank: rankOf(other, employeeId),
      createdMs: readMs(other.createdAtISO) ?? readMs(other.createdAt) ?? 0,
      workable: occupiesQueue(other, approvedOutputIds),
      endMs: effectiveEndMs(other),
      title: other.title || null,
    });
  });

  /* The asking task takes its own place in the order — it may be promoted
     above blocked work, or demoted below workable work, and either changes
     who is in front of it. */
  candidates.push({
    id: ME,
    rank: rankOf(task, employeeId),
    createdMs: myCreated,
    workable: occupiesQueue(task, approvedOutputIds),
    endMs: null,
    title: null,
  });

  candidates.sort((a, b) => a.rank - b.rank || a.createdMs - b.createdMs);
  const ordered = workableFirst(candidates);
  const myIndex = ordered.findIndex((c) => c.id === ME);

  let latestMs = null;
  let latestId = null;
  let latestTitle = null;
  for (const ahead of ordered.slice(0, myIndex)) {
    /* Submitted work stops occupying the person at the moment it was handed
       over, not at the deadline it was given — see `effectiveEndMs`. */
    if (!Number.isFinite(ahead.endMs)) continue;
    if (latestMs === null || ahead.endMs > latestMs) {
      latestMs = ahead.endMs;
      latestId = ahead.id;
      latestTitle = ahead.title;
    }
  }

  return latestMs === null
    ? null
    : { endMs: latestMs, taskId: latestId, title: latestTitle };
}

/**
 * Does this person have any OPEN, UNSUBMITTED work right now?
 *
 * The test for "is this their first task", and deliberately built from the two
 * predicates this file already owns rather than a fifth list of statuses:
 *
 *  · `TERMINAL_STATUSES` — finished or cancelled. Not work.
 *  · `isAwaitingReview`  — handed in and sitting with a reviewer. The person
 *    has nothing to do on it, so it does not make them busy.
 *
 * Everything else counts as open work, INCLUDING an overdue task. An overdue
 * task is still unfinished work they are meant to be doing, so somebody sitting
 * on one is not free and gets no acceptance anchor — OWNER DECISION, chosen
 * over the alternative of releasing them.
 *
 * The task being accepted is excluded by id: it is about to become their work,
 * and counting it would mean nobody could ever qualify.
 *
 * Same query shape `queueAheadEndMs` uses — one array-contains read, filtered
 * in memory — so this needs no new index. Read OUTSIDE any transaction.
 *
 * On ANY failure it answers `true` (busy). Failing closed keeps the existing
 * deadline rather than handing out an anchor on the strength of a read that
 * did not happen.
 */
async function hasOpenUnsubmittedWork(employeeId, excludeTaskId = null) {
  if (!employeeId) return true;
  try {
    const { db } = require("../config/firebaseAdmin");
    const snap = await db
      .collection("cowork_tasks")
      .where("assigneeIds", "array-contains", String(employeeId))
      .get();
    const skip = excludeTaskId == null ? null : String(excludeTaskId);
    for (const d of snap.docs) {
      if (skip && d.id === skip) continue;
      const t = d.data();
      if (TERMINAL_STATUSES.includes(t.status)) continue;
      if (isAwaitingReview(t)) continue;
      return true;
    }
    return false;
  } catch (e) {
    console.warn("[officeDeadline] open-work read failed:", e.message);
    return true;
  }
}

async function resolveAcceptanceAnchor(task, nowMs = Date.now(), taskId = null, opts = {}) {
  const tlHoursSetMs = readMs(task.tlHoursSetAtMs) ?? readMs(task.tlHoursSetAt);
  const createdMs = readMs(task.createdAtISO) ?? readMs(task.createdAt);
  const assignee = (task.assigneeIds || [])[0] || null;

  let dutyMode = null;
  let dutySessionStartMs = null;
  if (assignee && !Number.isFinite(tlHoursSetMs)) {
    try {
      const { db } = require("../config/firebaseAdmin");
      const snap = await db
        .collection("cowork_duty_status")
        .doc(String(assignee))
        .get();
      if (snap.exists) {
        const d = snap.data();
        dutyMode = d.mode ?? null;
        /**
         * **`since` is the session start. `updatedAt` is the last write.**
         *
         * This read `updatedAt`, on the stated assumption that it "is written
         * only on a mode change, so while the mode is online it IS the session
         * start". The assumption does not hold: heartbeats and the break-credit
         * ledger write the duty document continuously, so `updatedAt` tracks
         * NOW.
         *
         * The anchor is `max(createdAt, sessionStart)`, so a session start that
         * creeps forward drags every anchor with it and the deadline walks all
         * day — the exact fault `anchorMsFor` documents and refuses for its own
         * origin. Observed on GR0045: `since` 12:01:41, `updatedAt` 17:00:11 at
         * 17:04, and a task raised at 16:19 anchored to 16:57.
         *
         * `since` is a Timestamp set when the mode last changed, which is what
         * "the first provable moment they were online" means. `updatedAt` stays
         * as a fallback for a document written before `since` existed — worse,
         * but better than no anchor at all.
         */
        dutySessionStartMs = readMs(d.since) ?? readMs(d.updatedAt);
      }
    } catch (e) {
      /* An unreadable duty doc costs the first_online refinement, never the
         acceptance. */
      console.warn("[officeDeadline] duty read failed:", e.message);
    }
  }

  /**
   * Only an acceptance asks this, and only for a task that is not a grant.
   *
   * `opts.considerFirstTask` is passed by the two surfaces where somebody
   * takes work on — confirming an assignment, and a manager approving a
   * self-assigned task. Every other caller (the queue rechain above all) leaves
   * it off and `hasOpenWork` stays `undefined`, so the rule they get is byte
   * for byte the one they had. That matters most for `rechainQueueFor`, which
   * re-derives anchors with ITS OWN `nowMs`: were this on there, a re-derived
   * anchor would creep to the walk's clock and the deadline would walk all day.
   *
   * Skipped outright for a granted task — the grant branch wins anyway, so the
   * read would be a wasted round trip on the cross-department path.
   */
  let hasOpenWork;
  if (opts.considerFirstTask === true && !Number.isFinite(tlHoursSetMs)) {
    hasOpenWork = await hasOpenUnsubmittedWork(assignee, taskId);
  }

  const personal = acceptanceAnchorMs({
    tlHoursSetMs,
    createdMs,
    dutyMode,
    dutySessionStartMs,
    nowMs,
    hasOpenWork,
  });

  /**
   * **Pushed to after the queue ahead of it — never pulled earlier.**
   *
   * `Math.max` is the whole safety property: this rule can only ever move a
   * deadline LATER, so no task becomes harder to meet than it was, and a
   * person cannot be marked late by work that was queued above them.
   *
   * The personal anchor still decides when nothing is ahead, which is the
   * ordinary case. Where something is, the source says so rather than keeping
   * a reason that no longer explains the date on the screen.
   */
  let ahead = await queueAheadEndMs(task, taskId, assignee, nowMs);

  /**
   * **The push may not carry a subtask past its project.**
   *
   * "A subtask can never be due after the project it belongs to" is an OWNER
   * DECISION of 16 Aug 2026 and predates this rule. Two of the three accept
   * surfaces do not clamp to the parent at all — only `acceptBudgetProposal`
   * does — so a push that reached past the parent's date would have quietly
   * created the state that rule exists to forbid.
   *
   * Capping the PUSH, not the deadline: whatever those paths did before is
   * exactly what they still do, and the new rule simply contributes nothing
   * beyond the project's own ceiling. Adding a clamp they never had would be
   * changing behaviour that was not asked about.
   */
  if (ahead) {
    try {
      const { readParentDeadline } = require("./parentDeadlineCap.service");
      const parent = await readParentDeadline(task);
      if (parent && ahead.endMs > parent.dueAtMs) {
        ahead = { ...ahead, endMs: parent.dueAtMs, cappedToParent: true };
      }
    } catch (e) {
      /* An unreadable parent costs the cap, never the acceptance. */
      console.warn("[officeDeadline] parent read failed:", e.message);
    }
  }

  if (ahead && ahead.endMs > personal.anchorMs) {
    return {
      anchorMs: ahead.endMs,
      source: "after_priority_work",
      /* What it is waiting for, so the line can name it instead of leaving
         somebody to work out which task moved their date. */
      queuedAfterTaskId: ahead.taskId,
      queuedAfterTitle: ahead.title,
      /* The reason it WOULD have had. Kept because the personal anchor is
         still the honest answer to "when could you first have started". */
      personalAnchorMs: personal.anchorMs,
      personalSource: personal.source,
    };
  }
  return personal;
}

/**
 * Re-settle one person's queue after a deadline above it moved.
 *
 * **Reported 17 Aug 2026.** T062 (P1) and T063 (P2) were chained correctly at
 * the moment T063 was created — T062 was due 15:00, so T063 anchored there and
 * came out due 17:00. T062's budget then grew and its deadline moved to 16:30,
 * and T063 kept its 15:00 anchor: thirty minutes of real room for two hours of
 * work.
 *
 * **This is not the case the "decided once" rule covers.** That rule says NEW
 * work arriving above you does not reach back and move a date you already
 * hold, and it stands. This is the opposite situation: the chain was already
 * agreed, and the task above it moved. Leaving the link stale does not protect
 * anybody — it just makes the queue describe a day nobody can work.
 *
 * **Later only.** Every write goes through `Math.max`, so a deadline can be
 * pushed out and never pulled in. A task cannot become harder to meet because
 * something above it finished sooner than planned, and the walk is safe to run
 * more than once.
 *
 * Skips the same work `queueAheadEndMs` skips: fixed calendar dates occupy no
 * hours, and a task with no stamped anchor has nothing honest to count from.
 */
async function rechainQueueFor(employeeId, opts = {}) {
  if (!employeeId) return [];
  const { db } = require("../config/firebaseAdmin");
  const snap = await db
    .collection("cowork_tasks")
    .where("assigneeIds", "array-contains", String(employeeId))
    .get();

  /**
   * `opts.simulate` turns this walk into the answer to "what would happen if I
   * sent this back at that priority?" — the rejection screen asks it on every
   * keystroke of the priority picker, so it must never write.
   *
   * The task being sent back is currently sitting in `submitted`, which the
   * walk otherwise skips. Under the simulation it is active work again, with
   * the rank the manager is considering and the leftover budget the rework
   * rule will give it.
   */
  const sim = opts.simulate || null;
  if (sim && !opts.dryRun) {
    throw new Error("simulate requires dryRun — a preview must not write.");
  }

  const { ids: approvedOutputIds, times: approvedAtById } = await _approvedIndex();

  /**
   * Stamped ONCE for the whole walk, so every task in one pass is anchored
   * against the same instant.
   *
   * Declared here, above everything that reads it — the entry build, the
   * re-anchor, the unblocking floor. Putting it lower has now caused the same
   * fault three times in this file: a value used before its `const`, which
   * throws at runtime while every source-assertion test passes.
   */
  const nowMs = Date.now();

  const live = [];
  /* Every document this person holds, collected in the pass that is already
     happening — `snap.docs` is not part of the shape the walk is given. Used
     only to clear a position from work that has left the queue. */
  const seen = [];
  /**
   * The last time this person handed ANY of their work over — see
   * `lastHandoverMs`. Collected across every document they hold, including the
   * terminal ones: a task submitted and since approved still occupied them
   * right up to the moment they submitted it.
   */
  const handovers = [];
  snap.forEach((doc) => {
    const t = doc.data();
    seen.push({ id: doc.id, ref: doc.ref, effectivePriority: t.effectivePriority });
    const handed = lastHandoverMs(t);
    /* Kept PER TASK rather than as one figure, so a task can be excluded from
       its own floor below. Capped at now: a stamp in the future is bad data,
       and letting it through would push a live queue past the end of the day. */
    if (Number.isFinite(handed) && handed <= nowMs) {
      handovers.push({ taskId: doc.id, atMs: handed });
    }
    const simulated = sim && doc.id === String(sim.taskId);
    if (TERMINAL_STATUSES.includes(t.status)) return;
    if (t.fixedDeadline || t.hasTimer === false) return;

    const anchorMs = simulated ? sim.startMs : readMs(t.clockStartsAtMs);
    const secs = simulated
      ? Number(sim.secs) || 0
      : Number(t.deadlineWindowSecs) || Number(t.senderTimerWindowSecs) || 0;
    if (!Number.isFinite(anchorMs) || secs <= 0) return;
    live.push({
      ref: doc.ref,
      id: doc.id,
      title: t.title || doc.id,
      rank: simulated ? Number(sim.rank) : rankOf(t, employeeId),
      createdMs: readMs(t.createdAtISO) ?? readMs(t.createdAt) ?? 0,
      anchorMs,
      secs,
      dueMs: readMs(t.dueDate),
      /* Already handed in and waiting on a reviewer. Two consequences below:
         everything under it chains from THIS instead of its deadline, and its
         own deadline is left alone. */
      /* Under a simulation the task being sent back is active work again,
         so it is walked and given a deadline rather than skipped. */
      awaitingReview: simulated ? false : isAwaitingReview(t),
      handedOverMs: simulated ? null : effectiveEndMs(t),
      isRework: Boolean(simulated),
      /* Where the stored anchor came from. `after_priority_work` means THIS
         walk wrote it on a previous run — see the anchor decision below. */
      anchorSource: t.clockStartsAtSource ?? null,
      parentTaskId: t.parentTaskId || null,
      /* Decides the ORDER only. A blocked task still gets a deadline — it is
         simply chained after the work that overtook it, which is the ordinary
         rule that one person does one task at a time. */
      workable: simulated ? true : occupiesQueue(t, approvedOutputIds),
      /* When this task could first have been started, where it was held up by
         somebody else's output. Null where it never was. */
      unblockedAtMs: simulated ? null : unblockedAtMs(t, approvedAtById, nowMs),
      /**
       * The instant a dependency was actually APPROVED, or null while the task
       * is still waiting on one.
       *
       * `unblockedAtMs` above answers a different question and folds two cases
       * into one number: a real approval, and — where nothing is approved yet
       * — `nowMs`, so a waiting task's deadline does not burn down. Those two
       * must not be treated alike. An approval is a FIXED instant and is the
       * whole anchor; the now-floor is a moving one and may only ever push a
       * start later.
       *
       * Telling them apart costs nothing: passing a non-finite clock makes the
       * now-fallback unreachable, so what comes back is the approval or null.
       *
       * Reported: a task whose inputs were BOTH still unapproved was anchored
       * at 02:02 — the moment the walk happened to run — while the P1 above it
       * ran until 02:55. The two overlapped, and a blocked task had overtaken
       * work that was actually being done.
       */
      freedAtMs: simulated ? null : unblockedAtMs(t, approvedAtById, NaN),
      /* Filled in below, from the timer session. Only a dependency re-anchor
         reads it — see where the seconds are chosen in the walk. */
      workedSecs: 0,
      raw: t,
    });
  });

  /* The queue's own order — rank, then which was raised first, exactly the
     tie-break `queueAheadEndMs` uses. Two orderings would eventually disagree
     about who waits for whom. */
  live.sort((a, b) => a.rank - b.rank || a.createdMs - b.createdMs);
  /* Then the one adjustment the screen makes, so the dates agree with the
     positions shown beside them. */
  /**
   * How long each task has actually been worked, from its timer session.
   *
   * Read only for the tasks a dependency re-anchor could touch, and in
   * parallel: a queue is a handful of documents, and the alternative — folding
   * it into the walk — would make an awaited read per task inside a loop that
   * is otherwise pure arithmetic.
   *
   * A missing session is zero, not an error: it means nobody has started the
   * clock, which is the ordinary case for work that has been waiting.
   */
  await Promise.all(
    live
      .filter((t) => Number.isFinite(t.freedAtMs))
      .map(async (t) => {
        try {
          const s = await db
            .collection("cowork_task_timers")
            .doc(String(employeeId))
            .collection("sessions")
            .doc(t.id)
            .get();
          if (!s.exists) return;
          const d = s.data();
          const base = Number(d.totalSeconds) || 0;
          /* A clock still running counts the part nobody has banked yet. */
          const elapsed =
            d.isActive && d.lastStartTime
              ? Math.floor((nowMs - Number(d.lastStartTime)) / 1000)
              : 0;
          t.workedSecs = Math.max(0, base + Math.max(0, elapsed));
        } catch (e) {
          /* An unreadable timer costs the remaining-time refinement, never the
             deadline: the task simply keeps its full budget. */
          console.warn("[officeDeadline] timer read failed for", t.id, e.message);
        }
      }),
  );

  const ordered = workableFirst(live);
  /* 1..N over the work that actually holds a slot, in the order walked below.
     Folded into the deadline update where there is one, so a task is never
     written twice in a pass. */
  const positionOf = new Map(ordered.map((t, i) => [t.id, i + 1]));
  const wroteFor = new Set();

  const calendar = await readOfficeCalendar();

  /**
   * **One start per person, not per task.** OWNER RULE, 21 Aug 2026.
   *
   * `acceptanceAnchorMs` answers per task — `max(createdAt, sessionStart)` —
   * so two tasks raised 85 seconds apart got starts 85 seconds apart, and the
   * queue's "counted from" moved every time a different one led. Reported on
   * T102/T103: 12:28:55 when Cowork Meet was first, 12:30:20 when Development
   * was.
   *
   * So the HEAD of the queue is anchored at the moment this person became
   * available to the queue at all: their duty session, floored at the earliest
   * task in it. Whichever task leads, the number is the same. Everything below
   * the head chains from the head, exactly as before.
   *
   * The floor is what stops it handing out time: without it a queue would be
   * anchored at a session start hours before any of its work existed. It
   * cannot precede the first task, and it can only ever be EARLIER than that
   * task's own anchor — never later, so nothing gains time from this.
   */
  let queueAnchorMs = null;
  if (ordered.length > 0) {
    const earliestCreated = Math.min(
      ...ordered.map((t) => t.createdMs).filter((n) => Number.isFinite(n) && n > 0),
    );
    let sessionStartMs = null;
    try {
      const { db } = require("../config/firebaseAdmin");
      const duty = await db.collection("cowork_duty_status").doc(String(employeeId)).get();
      if (duty.exists && duty.data().mode === "online") {
        /* `since`, not `updatedAt` — the same correction as
           `resolveAcceptanceAnchor`, and for the same reason: `updatedAt`
           tracks the last write, so using it here made the queue's start creep
           forward all day and took every deadline with it. */
        sessionStartMs = readMs(duty.data().since) ?? readMs(duty.data().updatedAt);
      }
    } catch (e) {
      /* No duty document is not a reason to move anybody's deadline. Without
         it there is no queue start and every task keeps its own anchor —
         exactly the behaviour that predates this rule. */
      console.warn("[officeDeadline] duty read failed for queue anchor:", e.message);
    }
    if (Number.isFinite(earliestCreated)) {
      queueAnchorMs = Number.isFinite(sessionStartMs)
        ? Math.max(sessionStartMs, earliestCreated)
        : earliestCreated;
    }
  }
  const moved = [];
  let previousEndMs = null;

  for (const task of ordered) {
    /**
     * **A task already handed in is not recomputed.**
     *
     * Its deadline is finished business: the rework rule measures the time it
     * did not use as `deadline − submittedAt`, so moving that deadline later
     * would silently hand the rework time nobody earned. It still occupies its
     * place in the queue — the reviewer can send it back — and everything
     * under it chains from when it was handed over.
     */
    if (task.awaitingReview) {
      if (Number.isFinite(task.handedOverMs)) previousEndMs = task.handedOverMs;
      continue;
    }

    /**
     * **A stored anchor that this walk wrote is not evidence — it is this
     * walk's own previous answer.** OWNER DECISION, 18 Aug 2026.
     *
     * Reported with real data: T069 (P3, due 17:21) was handed in at 17:02,
     * and T070 (P4, 30 min) stayed at 17:51 instead of moving to 17:32. The
     * handover was being read correctly; what blocked it was `Math.max`
     * comparing the new answer against T070's stored anchor of 17:21 — a value
     * a PREVIOUS run of this same walk had written from T069's old deadline.
     * The chain was defending its own stale output, so it could never correct
     * itself downward.
     *
     * `clockStartsAtSource` already records which of the two a stored anchor
     * is, so the distinction is exact rather than a blanket loosening:
     *
     * - `after_priority_work` — written here. Recomputed from the queue.
     * - anything else (`first_online`, `hours_granted`, `acceptance`) — a real
     *   statement that the person could not have started before that moment,
     *   which still wins over the queue.
     *
     * With nothing ahead there is no queue answer to use, so the stored value
     * stands whatever its source: the task's true anchor was overwritten and
     * cannot be recovered.
     */
    const anchorIsQueueDerived = task.anchorSource === "after_priority_work";

    /**
     * **Nothing ahead any more, and the anchor only ever meant "something was".**
     *
     * The note above says such an anchor "cannot be recovered". It can:
     * `resolveAcceptanceAnchor` derives the personal one from the task's
     * creation and the holder's live duty document, neither of which the
     * overwrite touched. Keeping the stale value instead is what left T101
     * due 16:06 — a time computed from T099 finishing at 15:06 — after T099
     * was blocked and dropped BELOW it. The reason for the anchor had gone and
     * the anchor had not.
     *
     * Only when the stored anchor is this walk's own output. A `first_online`
     * or `hours_granted` anchor is a real statement about when the person could
     * have started, and it still stands.
     *
     * This can only ever move a deadline EARLIER, and only for a task that has
     * reached the front of its own queue — which is the honest direction: the
     * work ahead is gone, so the extra hours it was buying are gone with it.
     */
    let personalAnchorMs = null;
    let personalAnchorSource = null;
    if (previousEndMs === null && anchorIsQueueDerived) {
      try {
        const re = await resolveAcceptanceAnchor(task.raw, nowMs, task.id);
        /**
         * **It may only ever pull the anchor EARLIER.**
         *
         * The whole job here is undoing a queue push, and a queue push always
         * moves an anchor later — so the personal anchor it displaced must lie
         * before it. Anything later is not a recovery, it is drift, and drift
         * here hands out time nobody granted.
         *
         * Two ways that happened. `acceptanceAnchorMs` falls back to
         * `{ anchorMs: nowMs, source: "acceptance" }` whenever nothing is
         * provable — an unreadable duty document is enough — and "now" passes
         * every other test while being the one answer that is certainly wrong
         * for a task raised hours ago. And `first_online` reads the duty
         * document's `updatedAt` as the session start, which moves whenever
         * anything else writes that document.
         *
         * So: a real, PAST anchor, or the stored one stands.
         */
        const isRecovery =
          Number.isFinite(re?.anchorMs) &&
          re.source !== "after_priority_work" &&
          re.source !== "acceptance" &&
          re.anchorMs < task.anchorMs;
        if (isRecovery) {
          personalAnchorMs = re.anchorMs;
          personalAnchorSource = re.source;
        }
      } catch (e) {
        /* Unrecoverable costs the correction, never the walk — the task keeps
           the anchor it already had, which is the old behaviour exactly. */
        console.warn(`[officeDeadline] re-anchor failed for ${task.id}:`, e.message);
      }
    }

    /* The head carries the QUEUE's start, so the number does not change with
       whichever task happens to lead. Never later than the task's own anchor —
       this rule may tighten a deadline, never loosen one. */
    /**
     * **The head takes the queue's start, whichever direction that moves it.**
     *
     * This used to adopt the queue start only when it was EARLIER, a guard
     * against the anchor creeping forward. That creep had a different cause —
     * the session start was read from `updatedAt`, which tracks the last write
     * — and it is fixed at the source now that `since` is read instead.
     *
     * What the guard did instead was freeze ghosts. The queue start is
     * `max(session, earliest task in the queue)`, so DELETING the earliest task
     * moves it later; a stored anchor derived from the deleted task then could
     * never be corrected. Reported exactly that way: Cowork anchored 16:19:02,
     * the creation time of a Dev task that no longer existed, while the queue's
     * earliest surviving task was Cowork itself at 16:33:46. The engine held
     * 18:19 and the confirm dialog — which recomputes from scratch — showed
     * 09:33 the next morning. Both were internally consistent and they
     * disagreed, which is the failure this whole area keeps producing.
     *
     * The queue start is now stable in its own right: `since` does not move
     * while the mode holds, and creation times do not move at all. So adopting
     * it unconditionally cannot drift — it can only follow the queue it
     * describes.
     */
    const headAnchorMs =
      /* A simulation carries its own `startMs` — the rejection preview asks
         "what if I sent this back, starting now", and answering from the
         queue's start instead would answer a different question. */
      !task.isRework && Number.isFinite(queueAnchorMs)
        ? queueAnchorMs
        : (personalAnchorMs ?? task.anchorMs);

    /* `let`, because the unblocking floor below may raise it. */
    let anchorMs =
      previousEndMs === null
        ? headAnchorMs
        : anchorIsQueueDerived
          ? previousEndMs
          : Math.max(task.anchorMs, previousEndMs);
    /**
     * **Nothing starts before it was allowed to.** OWNER RULE, 21 Aug 2026.
     *
     * Applied AFTER the chain has had its say, and as a `max`, so it can only
     * ever push a start later — never pull one earlier, and never reorder
     * anything. Where the task above already finishes after the approval this
     * changes nothing, which is the ordinary case; it bites where a blocked
     * task reaches the FRONT and would otherwise take the queue's start.
     */
    /**
     * **The head cannot start before the person put down what they were
     * holding.** Companion to the rule below, and the same shape: a `max`
     * applied after the chain, so it can only ever push a start later.
     *
     * The queue's start is the moment the person became available to the queue
     * as a whole. That is the right anchor for the task that leads it at the
     * beginning of a session — and the wrong one for a task that reaches the
     * front hours later, because the work above it was handed over. The person
     * was busy until that handover; the head could not have begun before it.
     *
     * Reported: two tasks, both raised 18:35 and 18:40. The dependent one led
     * until it delivered its first output at 18:58 and its second was still
     * blocked. The plain task took the front and was anchored at the queue's
     * 18:35 start — a one-hour budget due at 19:35, already expired by the time
     * it reached the front, for a person who had been working the whole time.
     *
     * Only the HEAD reads it. Everything behind chains from the task above,
     * which already ends at or after any handover the person made.
     *
     * **A task's OWN handovers are excluded, and that is not a detail.**
     * REPORTED 26 Aug 2026. Umung's task waits on nobody: both its outputs are
     * his own work. He submitted the first at 03:11 and the second at 03:47,
     * and each submission pushed the task's own start forward — 03:11, then
     * 03:47 — so its deadline grew every time he made progress on it. The
     * floor exists to say "you were busy with something ELSE until you put it
     * down"; a task cannot have been busy with itself.
     */
    const otherHandoverMs = handovers.reduce(
      (latest, h) =>
        h.taskId === task.id ? latest : latest === null || h.atMs > latest ? h.atMs : latest,
      null,
    );

    if (
      previousEndMs === null &&
      Number.isFinite(otherHandoverMs) &&
      otherHandoverMs > anchorMs
    ) {
      anchorMs = otherHandoverMs;
    }

    /**
     * **A dependency's approval is the WHOLE anchor, not a floor under one.**
     * OWNER RULE, 26 Aug 2026.
     *
     * This was `if (unblockedAtMs > anchorMs)` — a `max`, so the approval only
     * counted when it happened to fall later than wherever the queue had
     * already placed the task. Where the queue placed it later, the approval
     * was ignored and the task was scheduled from a time it could not have
     * started, chained behind unrelated work.
     *
     * The owner's case, in their numbers. Two of B's tasks, each waiting on a
     * different one of A's outputs:
     *
     *   Puri Dev    (4h)  input approved 10:00  ->  10:00 + 4h = 14:00
     *   Pardeep Dev (6h)  input approved 13:00  ->  13:00 + 6h = 19:00
     *
     * Under the `max` Pardeep Dev chained behind Puri Dev — anchor 14:00, due
     * 20:00 — because 14:00 was later than its 13:00 approval. The approval is
     * the instant the work became possible, and it is the one the budget is
     * counted from: each dependency drives its own task's date and nothing
     * else's.
     *
     * **This may pull a date EARLIER**, which is the one place in this file
     * that is allowed to. It is the same exception `unblockedAtMs` already
     * documents for the waiting case: a deadline derived from a queue position
     * the dependency has overruled was never a promise anybody made.
     *
     * The consequence is deliberate and worth stating: two of one person's
     * tasks freed at different times can now hold overlapping windows. The
     * dependency decides when each CAN start; fitting them into a day is the
     * assignee's own scheduling, not something a chain should decide for them.
     */
    if (Number.isFinite(task.freedAtMs)) {
      /**
       * **At the head, the approval IS the start. Behind live work, it is only
       * a floor.** OWNER RULE, 26 Aug 2026, third statement of it.
       *
       * Two requirements meet here and they contradict each other whenever an
       * approval lands earlier than the work above finishes:
       *
       *  · A dependent task must be counted from its own approval, not from
       *    wherever the chain happened to place it — Pardeep Dev approved at
       *    13:00 must read 13:00 + 6h = 19:00.
       *  · A P2 must not start before the P1 above it ends — a task with one
       *    input approved at 02:11 and another still waiting must not sit on
       *    top of the plain task being worked from 02:16 to 03:16.
       *
       * The position settles it. A task that LEADS the queue has nothing to
       * wait for but its input, so the approval is the whole of its start. A
       * task BEHIND one still has a person doing something else first, and no
       * approval makes them free earlier — so there it may only ever push the
       * start later, never pull it back over work in hand.
       *
       * Pardeep Dev keeps its 19:00 because by then it leads: the work above
       * it was handed over, so nothing occupies the person any more.
       */
      anchorMs =
        previousEndMs === null
          ? task.freedAtMs
          : Math.max(anchorMs, task.freedAtMs);
    } else if (
      Number.isFinite(task.unblockedAtMs) &&
      task.unblockedAtMs > anchorMs
    ) {
      /* Still waiting on somebody: the now-floor may only push a start LATER.
         Applied as a max, it stops the deadline burning down while the task
         cannot be touched; applied exactly it would drag a blocked task on top
         of the work above it, which is the 02:02-against-02:55 overlap. */
      anchorMs = task.unblockedAtMs;
    }

    /**
     * **A dependency re-anchor schedules what is LEFT, never the whole budget
     * again.** OWNER RULE, 26 Aug 2026.
     *
     * The anchor above moves to the LATEST approval, which is the moment the
     * task finally became fully workable. Counting the full budget from there
     * would hand back every hour already spent on the part that WAS unblocked:
     *
     *   4h task, puri approved 10:00, one hour worked, paradeep approved 13:00
     *   full budget    -> 13:00 + 4h = 17:00   (the worked hour handed back)
     *   what is left   -> 13:00 + 3h = 16:00   (correct)
     *
     * Scoped to the dependency case on purpose. Every other task in this walk
     * keeps being scheduled from its full agreed budget, which is what the
     * rest of the product measures against — this is not a general switch to
     * remaining-time scheduling.
     */
    const secsToSchedule = Number.isFinite(task.freedAtMs)
      ? Math.max(0, task.secs - (Number(task.workedSecs) || 0))
      : task.secs;

    let dueIso = addWorkingSecsIST(
      anchorMs,
      secsToSchedule,
      calendar.schedule,
      calendar.breaks,
    );

    /* A subtask may not outlive its project — OWNER DECISION 16 Aug 2026. */
    if (task.parentTaskId) {
      try {
        const { readParentDeadline } = require("./parentDeadlineCap.service");
        const parent = await readParentDeadline(task.raw);
        if (parent && Date.parse(dueIso) > parent.dueAtMs) {
          dueIso = new Date(parent.dueAtMs).toISOString();
        }
      } catch {
        /* An unreadable parent costs the cap, never the walk. */
      }
    }

    const dueMs = Date.parse(dueIso);
    /* Written only when it moves LATER. Equal dates and earlier ones are both
       left alone — the second deliberately, so a queue that emptied does not
       shorten commitments people are already working to.

       The task being sent back is exempt: it is being handed a fresh budget
       from this moment, so its new deadline IS the answer even when that is
       earlier than the one it carried. */
    const movesLater =
      Number.isFinite(dueMs) &&
      (task.dueMs === null || dueMs > task.dueMs) &&
      anchorMs > task.anchorMs;

    /**
     * A queue-derived anchor is recomputed in BOTH directions — that is the
     * whole point of distinguishing it. The protection it loses is one it was
     * never entitled to: it was this walk's own arithmetic, not a promise the
     * task had any independent claim to.
     *
     * **But only when the ANCHOR actually moved.** Found on live data: T066
     * carries a queue anchor of 10:05:39 and a 195-minute budget, which would
     * make it due 13:21 — yet its stored deadline is 15:30, put there by
     * something this walk knows nothing about, an extension or a negotiated
     * budget. The task above it had not been handed over, so its anchor was
     * still right and nothing about it should have moved; without this
     * condition the walk would have overwritten that 15:30 with a time
     * already two hours in the past, and the task would have gone instantly
     * overdue for a reason nobody could explain.
     *
     * So the trigger is the anchor changing, never a disagreement between the
     * stored deadline and what this walk would compute — that disagreement is
     * somebody else's decision, not a fault to correct.
     */
    /**
     * **The head moving onto the queue's own start is a correction too.**
     *
     * Without this the rule only half-applies: pulling an anchor earlier is not
     * `movesLater`, and `correctsItself` alone wants a queue-derived anchor —
     * so a task sitting on its own `first_online` kept it until some unrelated
     * event forced a rewrite. That is the reported symptom exactly: 12:30:20 in
     * one state, 12:28:55 in another, for the same task.
     *
     * It can only ever tighten, never loosen: `headAnchorMs` takes the queue
     * start only when it is EARLIER than the anchor the task already had.
     */
    const headTakesQueueStart =
      /* Never inside a preview. "What if I sent this back at P4" must report
         the consequences of THAT, not an unrelated correction to somebody
         else's head — the rejection screen asks on every keystroke. */
      !sim &&
      previousEndMs === null &&
      Number.isFinite(queueAnchorMs) &&
      anchorMs === queueAnchorMs &&
      anchorMs !== task.anchorMs;

    const correctsItself =
      (anchorIsQueueDerived || headTakesQueueStart) &&
      Number.isFinite(dueMs) &&
      anchorMs !== task.anchorMs &&
      dueMs !== task.dueMs;

    if (movesLater || correctsItself || task.isRework) {
      if (!opts.dryRun) {
        wroteFor.add(task.id);
        await task.ref.update({
          effectivePriority: positionOf.get(task.id),
          clockStartsAtMs: anchorMs,
          /**
           * The source has to describe the anchor actually written.
           *
           * Stamping `after_priority_work` on a re-derived PERSONAL anchor
           * would be a lie with teeth: the label is what `anchorIsQueueDerived`
           * reads on the next walk, and a real personal anchor must survive
           * `Math.max` against the queue rather than being replaced by it.
           * Mislabelling it would let a later walk overwrite a true statement
           * about when somebody could start.
           */
          clockStartsAtSource:
            personalAnchorMs !== null && anchorMs === personalAnchorMs
              ? personalAnchorSource
              : "after_priority_work",
          dueDate: dueIso,
        });
      }
      moved.push({
        taskId: task.id,
        title: task.title,
        rank: task.rank,
        isRework: Boolean(task.isRework),
        from: task.dueMs === null ? null : new Date(task.dueMs).toISOString(),
        to: dueIso,
      });
    } else if (opts.reportAll) {
      /* A preview has to show the rows that DON'T move too — "Task C is
         untouched" is half of what the manager is deciding between. */
      moved.push({
        taskId: task.id,
        title: task.title,
        rank: task.rank,
        isRework: false,
        from: task.dueMs === null ? null : new Date(task.dueMs).toISOString(),
        to: task.dueMs === null ? dueIso : new Date(task.dueMs).toISOString(),
      });
    }

    /* The task that follows chains from where THIS one now ends. Taking the
       later of old and new would keep a corrected deadline's old value alive
       and push everything below it out again — undoing the correction one row
       further down. */
    previousEndMs = anchorIsQueueDerived
      ? dueMs
      : Math.max(dueMs, task.dueMs ?? dueMs);
  }


  /**
   * **The derived position, written where anybody can read it.**
   *
   * `assigneePriorities` is never touched — it is the rank a manager chose, and
   * it is the only reason a task blocked out of P1 climbs back the moment its
   * input lands. But that means the stored rank and the shown position can
   * legitimately differ, and until now the difference lived nowhere: the
   * documents said Development was P1 while every screen said P2, and each
   * consumer had to re-derive workability for itself to find out.
   *
   * So the two facts get two fields. `assigneePriorities` stays the DECISION;
   * `effectivePriority` is the CONSEQUENCE — 1..N over the work that actually
   * holds a queue slot, in the order this walk uses. Anything reading the
   * documents now sees what the person sees, without re-deriving anything.
   *
   * Written outside the deadline update on purpose: a swap can change what is
   * first without moving any date at all, and that still has to be recorded.
   */
  if (!opts.dryRun) {
    const admin = require("firebase-admin");
    const held = new Set();
    await Promise.all(
      ordered
        .map((t) => {
          if (t.isRework) return null; /* a simulation, not a real placement */
          held.add(t.id);
          const position = positionOf.get(t.id);
          /* Already carried by this pass's deadline update, or already right. */
          if (wroteFor.has(t.id)) return null;
          if (Number(t.raw?.effectivePriority) === position) return null;
          return t.ref.update({ effectivePriority: position }).catch((e) => {
            console.warn(
              `[officeDeadline] effectivePriority write failed for ${t.id}:`,
              e.message,
            );
          });
        })
        .filter(Boolean),
    );

    /* Anything that has LEFT the queue — finished, cancelled, blocked out of a
       slot — must not keep a position it no longer holds. A stale number here
       reads exactly like a live one. */
    await Promise.all(
      seen
        .filter((d) => !held.has(d.id) && d.effectivePriority !== undefined)
        .map((d) =>
          d.ref
            .update({ effectivePriority: admin.firestore.FieldValue.delete() })
            .catch(() => {}),
        ),
    );
  }

  return moved;
}

/**
 * The time a rework will be given, in seconds.
 *
 * **This mirrors the rule in `taskForward.service.js`, it does not replace
 * it.** That rule is the one that actually writes the deadline on rejection —
 * due 6:00 handed in at 5:00 gives the rework the whole unused hour, not the
 * fifteen minutes that were left when the reviewer got to it — and it is not
 * being changed. This exists so the rejection SCREEN can show the same number
 * before the manager commits, and it is read from the same two fields so the
 * two cannot drift apart.
 *
 * Null when the task carries no deadline or was never submitted, which is the
 * caller's signal that there is nothing to preview.
 */
function reworkLeftoverSecs(task) {
  const dueMs = readMs(task.dueDate) ?? readMs(task.fixedDeadline);
  const submittedMs = readMs(task.completionSubmission?.submittedAt);
  if (!Number.isFinite(dueMs) || !Number.isFinite(submittedMs)) return null;
  return Math.max(0, Math.round((dueMs - submittedMs) / 1000));
}

module.exports = {
  addWorkingSecsIST,
  occupiesQueue,
  approvedOutputIdsNow,
  unblockedAtMs,
  rechainQueueFor,
  readOfficeCalendar,
  computeWorkingDeadline,
  readMs,
  acceptanceAnchorMs,
  resolveAcceptanceAnchor,
  hasOpenUnsubmittedWork,
  queueAheadEndMs,
  rankOf,
  isAwaitingReview,
  effectiveEndMs,
  lastHandoverMs,
  reworkLeftoverSecs,
  TERMINAL_STATUSES,
};
