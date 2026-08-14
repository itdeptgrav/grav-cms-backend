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

module.exports = {
  addWorkingSecsIST,
  readOfficeCalendar,
  computeWorkingDeadline,
  readMs,
};
