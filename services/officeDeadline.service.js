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
}) {
  if (Number.isFinite(tlHoursSetMs) && tlHoursSetMs > 0) {
    return { anchorMs: tlHoursSetMs, source: "hours_granted" };
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

/** This person's rank on this task — legacy's own precedence. */
function rankOf(task, employeeId) {
  const per = task.assigneePriorities || {};
  const mine = employeeId != null ? per[employeeId] : undefined;
  const n = Number(mine ?? task.priority);
  return Number.isFinite(n) && n > 0 ? n : 99;
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

  const myRank = rankOf(task, employeeId);
  const myCreated = readMs(task.createdAtISO) ?? readMs(task.createdAt) ?? nowMs;

  let latestMs = null;
  let latestId = null;
  let latestTitle = null;

  snap.forEach((doc) => {
    if (taskId && doc.id === taskId) return;
    const other = doc.data();
    if (TERMINAL_STATUSES.includes(other.status)) return;

    /* Ahead of me: a stronger rank, or the same rank raised earlier. Equal
       ranks need the tie-break or two P2s would each ignore the other and
       both claim the same hour. */
    const theirRank = rankOf(other, employeeId);
    if (theirRank > myRank) return;
    if (theirRank === myRank) {
      const theirCreated = readMs(other.createdAtISO) ?? readMs(other.createdAt);
      if (!Number.isFinite(theirCreated) || theirCreated >= myCreated) return;
    }

    /**
     * **A fixed calendar date does not occupy your queue.** OWNER DECISION,
     * 17 Aug 2026.
     *
     * Only BUDGETED work pushes. A task given a date rather than hours — a
     * report due next Friday — is a deadline, not time being spent: it does
     * not stop you working today, and treating it as queue-occupying would
     * push every lower-priority task past next Friday. Two of the ten live
     * tasks carried such a date when this was decided, so it is not a
     * theoretical case.
     *
     * `hasTimer === false` is the same statement in the engine's other
     * vocabulary — no timer means no hours to spend — and both are read
     * because deadline-mode tasks are written by more than one path.
     */
    if (other.fixedDeadline || other.hasTimer === false) return;

    const end = readMs(other.dueDate);
    if (!Number.isFinite(end)) return;
    if (latestMs === null || end > latestMs) {
      latestMs = end;
      latestId = doc.id;
      latestTitle = other.title || null;
    }
  });

  return latestMs === null
    ? null
    : { endMs: latestMs, taskId: latestId, title: latestTitle };
}

async function resolveAcceptanceAnchor(task, nowMs = Date.now(), taskId = null) {
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
        /* `updatedAt` is written only on a mode change, so while the mode is
           online it IS the session start — the same reading the Cowork
           frontend's `queueAnchorMs` uses. */
        dutySessionStartMs = readMs(d.updatedAt);
      }
    } catch (e) {
      /* An unreadable duty doc costs the first_online refinement, never the
         acceptance. */
      console.warn("[officeDeadline] duty read failed:", e.message);
    }
  }

  const personal = acceptanceAnchorMs({
    tlHoursSetMs,
    createdMs,
    dutyMode,
    dutySessionStartMs,
    nowMs,
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

  const live = [];
  snap.forEach((doc) => {
    const t = doc.data();
    if (TERMINAL_STATUSES.includes(t.status)) return;
    if (t.fixedDeadline || t.hasTimer === false) return;
    const anchorMs = readMs(t.clockStartsAtMs);
    const secs =
      Number(t.deadlineWindowSecs) || Number(t.senderTimerWindowSecs) || 0;
    if (!Number.isFinite(anchorMs) || secs <= 0) return;
    live.push({
      ref: doc.ref,
      id: doc.id,
      title: t.title || doc.id,
      rank: rankOf(t, employeeId),
      createdMs: readMs(t.createdAtISO) ?? readMs(t.createdAt) ?? 0,
      anchorMs,
      secs,
      dueMs: readMs(t.dueDate),
      parentTaskId: t.parentTaskId || null,
      raw: t,
    });
  });

  /* The queue's own order — rank, then which was raised first, exactly the
     tie-break `queueAheadEndMs` uses. Two orderings would eventually disagree
     about who waits for whom. */
  live.sort((a, b) => a.rank - b.rank || a.createdMs - b.createdMs);

  const calendar = await readOfficeCalendar();
  const moved = [];
  let previousEndMs = null;

  for (const task of live) {
    const anchorMs =
      previousEndMs === null ? task.anchorMs : Math.max(task.anchorMs, previousEndMs);
    let dueIso = addWorkingSecsIST(
      anchorMs,
      task.secs,
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
       shorten commitments people are already working to. */
    if (
      Number.isFinite(dueMs) &&
      (task.dueMs === null || dueMs > task.dueMs) &&
      anchorMs > task.anchorMs
    ) {
      if (!opts.dryRun) {
        await task.ref.update({
          clockStartsAtMs: anchorMs,
          clockStartsAtSource: "after_priority_work",
          dueDate: dueIso,
        });
      }
      moved.push({
        taskId: task.id,
        title: task.title,
        from: task.dueMs === null ? null : new Date(task.dueMs).toISOString(),
        to: dueIso,
      });
    }

    previousEndMs = Math.max(dueMs, task.dueMs ?? dueMs);
  }

  return moved;
}

module.exports = {
  addWorkingSecsIST,
  rechainQueueFor,
  readOfficeCalendar,
  computeWorkingDeadline,
  readMs,
  acceptanceAnchorMs,
  resolveAcceptanceAnchor,
  queueAheadEndMs,
  rankOf,
  TERMINAL_STATUSES,
};
