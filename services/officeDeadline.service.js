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
async function resolveAcceptanceAnchor(task, nowMs = Date.now()) {
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

  return acceptanceAnchorMs({
    tlHoursSetMs,
    createdMs,
    dutyMode,
    dutySessionStartMs,
    nowMs,
  });
}

module.exports = {
  addWorkingSecsIST,
  readOfficeCalendar,
  computeWorkingDeadline,
  readMs,
  acceptanceAnchorMs,
  resolveAcceptanceAnchor,
};
