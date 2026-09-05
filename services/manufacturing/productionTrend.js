// services/manufacturing/productionTrend.js
//
// The production-trend endpoint's bucketing, with no database in it.
//
// The Project Manager Overview draws work orders STARTED against work orders
// COMPLETED, per week. The one honesty rule that matters lives here and in the
// route: a week's count is real evidence only when the work order actually
// carries the timestamp for it — `timeline.actualStartDate` for started,
// `timeline.actualEndDate` for completed. `createdAt` and `updatedAt` are never
// substituted (that is what made the Overview's old "completed this month"
// figure untrustworthy), so work orders that reached a state without a stamp are
// disclosed as coverage rather than folded silently into a bucket.
//
// Weeks are Monday-based in Asia/Kolkata (UTC+05:30, no DST). Pure and
// dependency-free so the route's math can be tested without Mongo.

"use strict";

const IST_OFFSET_MIN = 330; // Asia/Kolkata, +05:30, no daylight saving
const IST_OFFSET_MS = IST_OFFSET_MIN * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** The clamped week count. Anything that is not 4, 8 or 12 becomes 8. */
function normaliseWeeks(raw) {
  const n = Number.parseInt(raw, 10);
  return n === 4 || n === 12 ? n : 8;
}

/**
 * The UTC instant of the most recent Monday 00:00 in Asia/Kolkata, at or before
 * `at`.
 *
 * Computed by shifting into IST wall-clock, flooring to the Monday of that
 * week, then shifting back — so it is correct regardless of the server's own
 * timezone.
 */
function istWeekStart(at) {
  const wall = at + IST_OFFSET_MS;              // IST wall-clock, as ms
  const dayOfWeek = new Date(wall).getUTCDay(); // 0 Sun … 6 Sat, read in "wall" space
  const sinceMonday = (dayOfWeek + 6) % 7;      // Mon→0, Sun→6
  const wallMidnight = new Date(wall).setUTCHours(0, 0, 0, 0);
  const wallMondayMidnight = wallMidnight - sinceMonday * DAY_MS;
  return wallMondayMidnight - IST_OFFSET_MS;    // back to a real UTC instant
}

/**
 * The `weeks` consecutive Monday-based weeks ending with the week that contains
 * `asOf`. Each bucket is a half-open interval [start, end): the first day of the
 * next week is the exclusive end, so no instant lands in two buckets.
 */
function weekBuckets(asOf, weeks) {
  const asOfMs = asOf instanceof Date ? asOf.getTime() : Number(asOf);
  const currentStart = istWeekStart(asOfMs);
  const firstStart = currentStart - (weeks - 1) * WEEK_MS;

  const buckets = [];
  for (let i = 0; i < weeks; i++) {
    const startMs = firstStart + i * WEEK_MS;
    const endMs = startMs + WEEK_MS;
    buckets.push({
      startMs,
      endMs,
      periodStart: new Date(startMs).toISOString(),
      periodEnd: new Date(endMs).toISOString(),
    });
  }
  return buckets;
}

/**
 * Which bucket an instant belongs to, or -1 when it is outside the range.
 * Binary-free linear scan — the range is at most twelve weeks.
 */
function bucketIndexFor(buckets, dateMs) {
  if (!buckets.length) return -1;
  if (dateMs < buckets[0].startMs || dateMs >= buckets[buckets.length - 1].endMs) return -1;
  return Math.floor((dateMs - buckets[0].startMs) / WEEK_MS);
}

/**
 * Count a list of timestamps into the buckets. Anything not a usable date, or
 * outside the range, is ignored here — being outside the drawn window is not the
 * same as having no timestamp, and only the latter is coverage.
 */
function countInto(buckets, dates) {
  const counts = new Array(buckets.length).fill(0);
  for (const d of dates || []) {
    const ms = d instanceof Date ? d.getTime() : Date.parse(d);
    if (!Number.isFinite(ms)) continue;
    const idx = bucketIndexFor(buckets, ms);
    if (idx >= 0) counts[idx] += 1;
  }
  return counts;
}

/**
 * The whole response body, from the two timestamp lists and the two coverage
 * counts the route has already gathered. Every requested week is present,
 * zero-count weeks included.
 */
function buildTrend({ asOf, weeks, startedDates, completedDates, startedWithoutTimestamp, completedWithoutTimestamp }) {
  const buckets = weekBuckets(asOf, weeks);
  const started = countInto(buckets, startedDates);
  const completed = countInto(buckets, completedDates);

  return {
    success: true,
    bucket: "week",
    weeks,
    asOf: (asOf instanceof Date ? asOf : new Date(asOf)).toISOString(),
    points: buckets.map((b, i) => ({
      periodStart: b.periodStart,
      periodEnd: b.periodEnd,
      startedWorkOrders: started[i],
      completedWorkOrders: completed[i],
    })),
    coverage: {
      startedWithoutTimestamp: Number.isFinite(startedWithoutTimestamp) ? startedWithoutTimestamp : 0,
      completedWithoutTimestamp: Number.isFinite(completedWithoutTimestamp) ? completedWithoutTimestamp : 0,
    },
  };
}

module.exports = {
  IST_OFFSET_MIN,
  normaliseWeeks,
  istWeekStart,
  weekBuckets,
  bucketIndexFor,
  countInto,
  buildTrend,
};
