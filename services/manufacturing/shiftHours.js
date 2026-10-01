// services/manufacturing/shiftHours.js
//
// THE FACTORY'S HOURS, FOR EVERY HOUR-WISE REPORT.
//
// The floor works 09:30–18:30 IST (Asia/Kolkata, +05:30, no daylight saving),
// and an hour-wise report is read against that clock — "how much in the
// 10:30–11:30 hour", not "in UTC hour 5". So every report that buckets by
// hour uses THESE buckets: nine shift hours starting on the half hour, plus
// one bucket for anything before the shift and one for anything after. The
// outside buckets exist because work recorded at 08:50 or 19:10 is real work;
// dropping it would make the day's total disagree with the hourly total, and
// hiding it would hide the overtime.
//
// IST is computed the way the rest of this backend does it: shift the instant
// by the offset and read UTC fields. The host runs on UTC, so `getHours()`
// would put a 10 am hour at 04:30.

"use strict";

const IST_OFFSET_MS = 330 * 60 * 1000;
const SHIFT_START_MIN = 9 * 60 + 30;   // 09:30
const SHIFT_END_MIN = 18 * 60 + 30;    // 18:30
const SHIFT_HOURS = (SHIFT_END_MIN - SHIFT_START_MIN) / 60; // 9

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** The bucket list, in order: before, nine shift hours, after. */
function shiftBuckets() {
  const out = [{ key: "before", label: `Before ${hhmm(SHIFT_START_MIN)}`, short: `<${hhmm(SHIFT_START_MIN)}`, outside: true }];
  for (let i = 0; i < SHIFT_HOURS; i++) {
    const s = SHIFT_START_MIN + i * 60;
    out.push({ key: hhmm(s), label: `${hhmm(s)}–${hhmm(s + 60)}`, short: hhmm(s), outside: false });
  }
  out.push({ key: "after", label: `After ${hhmm(SHIFT_END_MIN)}`, short: `>${hhmm(SHIFT_END_MIN)}`, outside: true });
  return out;
}

/** Minutes since IST midnight for an instant. */
function istMinutesOf(instant) {
  const d = new Date(new Date(instant).getTime() + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** Index into shiftBuckets() for an instant. */
function bucketIndexOf(instant) {
  const m = istMinutesOf(instant);
  if (m < SHIFT_START_MIN) return 0;
  if (m >= SHIFT_END_MIN) return SHIFT_HOURS + 1;
  return 1 + Math.floor((m - SHIFT_START_MIN) / 60);
}

/** "YYYY-MM-DD" of an instant on the IST calendar. */
function istDayKeyOf(instant) {
  return new Date(new Date(instant).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** [start, end) real instants for an IST calendar day. No date → today IST. */
function istDayWindow(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ""));
  let y, mo, d;
  if (m) { y = Number(m[1]); mo = Number(m[2]) - 1; d = Number(m[3]); }
  else {
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    y = nowIst.getUTCFullYear(); mo = nowIst.getUTCMonth(); d = nowIst.getUTCDate();
  }
  const start = new Date(Date.UTC(y, mo, d) - IST_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const label = `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return { start, end, label };
}

/** The IST day `days` after (or before, negative) a "YYYY-MM-DD". */
function shiftDayKey(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

module.exports = {
  IST_OFFSET_MS, SHIFT_START_MIN, SHIFT_END_MIN, SHIFT_HOURS,
  shiftBuckets, bucketIndexOf, istMinutesOf, istDayKeyOf, istDayWindow, shiftDayKey, hhmm,
  SHIFT: { start: hhmm(SHIFT_START_MIN), end: hhmm(SHIFT_END_MIN), timezone: "Asia/Kolkata" },
};
