"use strict";
/**
 * Time helpers for the Timer SOP engine — pure, so they can be tested without
 * Firebase or Mongo in the room.
 *
 * ## Why `instantMs` exists
 *
 * The engine reads instants written by three different hands: the admin
 * toggle (a JavaScript Date, which Firestore hands back as a Timestamp), the
 * timer routes (Timestamps, sometimes serialised to `{ _seconds }` or
 * `{ seconds }` on the way through JSON) and older writes (ISO strings). One
 * of them — `timerSopEnabledAt` — was read with `new Date(value)`, which for a
 * Timestamp object is `Invalid Date`; the day label built from it threw
 * `RangeError: Invalid time value`, for every employee, on every run, before a
 * single day was judged. The engine had never moved a point.
 *
 * So every instant the engine reads goes through here, and an unreadable one
 * is `null` — a value a caller can test for — never NaN.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Epoch milliseconds for anything the store might hold an instant as, or
 * `null` when it cannot be read.
 */
function instantMs(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    if (typeof value.toMillis === "function") {
      const t = value.toMillis();
      return Number.isFinite(t) ? t : null;
    }
    if (typeof value._seconds === "number") {
      return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
    }
    if (typeof value.seconds === "number") {
      return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
    }
  }
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** IST calendar-date label (YYYY-MM-DD) for an epoch-ms instant. */
function istDateStr(utcMs) {
  if (!Number.isFinite(utcMs)) {
    throw new RangeError("istDateStr needs a finite epoch-ms instant");
  }
  return new Date(utcMs + IST_OFFSET_MS).toISOString().split("T")[0];
}

/**
 * Add N whole calendar days (N may be negative) to a YYYY-MM-DD label. Pure
 * label arithmetic anchored at UTC midnight, never mixed with the real-instant
 * math above, so it cannot inherit an offset bug.
 */
function addDaysToLabel(dateStr, n) {
  const anchor = Date.parse(dateStr + "T00:00:00.000Z");
  return new Date(anchor + n * MS_PER_DAY).toISOString().split("T")[0];
}

/** Day-of-week (0 = Sunday) for a YYYY-MM-DD label. */
function dowForLabel(dateStr) {
  const anchor = Date.parse(dateStr + "T00:00:00.000Z");
  return new Date(anchor).getUTCDay();
}

module.exports = { instantMs, istDateStr, addDaysToLabel, dowForLabel, IST_OFFSET_MS };
