// services/manufacturing/productionTrend.test.js
//
// The production-trend bucketing. Run with `npm test` (node --test).
//
// This is where the graph's honesty lives: Monday-based IST weeks, every
// requested week present, and timestamps that never become a fabricated count.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normaliseWeeks,
  istWeekStart,
  weekBuckets,
  bucketIndexFor,
  countInto,
  buildTrend,
} = require("./productionTrend");

/* ── weeks ─────────────────────────────────────────────────────────────────── */

test("weeks clamps to 4 / 8 / 12, defaulting to 8", () => {
  assert.equal(normaliseWeeks("4"), 4);
  assert.equal(normaliseWeeks("8"), 8);
  assert.equal(normaliseWeeks("12"), 12);
  assert.equal(normaliseWeeks(12), 12);
  for (const bad of ["7", "0", "-4", "99", "", undefined, null, "abc"]) {
    assert.equal(normaliseWeeks(bad), 8, `${JSON.stringify(bad)} should fall back to 8`);
  }
});

/* ── week boundaries ───────────────────────────────────────────────────────── */

test("weeks are Monday-based in Asia/Kolkata", () => {
  // Fri 4 Sep 2026 → its IST week starts Mon 31 Aug 2026 00:00 IST, which is
  // 30 Aug 18:30 UTC.
  const start = istWeekStart(Date.parse("2026-09-04T10:00:00Z"));
  assert.equal(new Date(start).toISOString(), "2026-08-30T18:30:00.000Z");
  // Sunday belongs to the week that started the previous Monday, not the next.
  const sun = istWeekStart(Date.parse("2026-09-06T09:00:00Z")); // Sun 6 Sep, IST afternoon
  assert.equal(new Date(sun).toISOString(), "2026-08-30T18:30:00.000Z");
  // A minute past IST-Monday-midnight is a new week.
  const mon = istWeekStart(Date.parse("2026-08-30T18:31:00Z")); // Mon 31 Aug 00:01 IST
  assert.equal(new Date(mon).toISOString(), "2026-08-30T18:30:00.000Z");
});

test("the requested number of contiguous weeks is returned, newest last", () => {
  const asOf = new Date("2026-09-04T10:00:00Z");
  for (const weeks of [4, 8, 12]) {
    const b = weekBuckets(asOf, weeks);
    assert.equal(b.length, weeks);
    // Each week is exactly 7 days and abuts the next with no gap or overlap.
    for (let i = 1; i < b.length; i++) {
      assert.equal(b[i].startMs, b[i - 1].endMs, "weeks must be contiguous");
      assert.equal(b[i].endMs - b[i].startMs, 7 * 24 * 60 * 60 * 1000);
    }
    // The last week contains asOf.
    const last = b[b.length - 1];
    assert.ok(asOf.getTime() >= last.startMs && asOf.getTime() < last.endMs);
  }
});

/* ── bucketing ─────────────────────────────────────────────────────────────── */

const ASOF = new Date("2026-09-04T10:00:00Z");

test("started and completed on different weeks land in different buckets", () => {
  const buckets = weekBuckets(ASOF, 4);
  // week index 2 is Mon 24 Aug; index 3 is Mon 31 Aug.
  const started = [new Date("2026-08-24T05:00:00Z"), new Date("2026-09-02T05:00:00Z")];
  const completed = [new Date("2026-09-03T05:00:00Z")];
  assert.deepEqual(countInto(buckets, started), [0, 0, 1, 1]);
  assert.deepEqual(countInto(buckets, completed), [0, 0, 0, 1]);
});

test("every requested week appears, including empty ones", () => {
  const out = buildTrend({ asOf: ASOF, weeks: 8, startedDates: [], completedDates: [], startedWithoutTimestamp: 0, completedWithoutTimestamp: 0 });
  assert.equal(out.points.length, 8);
  assert.ok(out.points.every((p) => p.startedWorkOrders === 0 && p.completedWorkOrders === 0));
  // Zero weeks are real weeks with real boundaries, not omitted.
  assert.ok(out.points.every((p) => typeof p.periodStart === "string" && typeof p.periodEnd === "string"));
});

test("a missing or malformed timestamp is never counted", () => {
  const buckets = weekBuckets(ASOF, 4);
  const dates = [null, undefined, "not-a-date", NaN, new Date("2026-09-02T05:00:00Z")];
  // Only the one real date counts; the four junk values are ignored, not zeroed
  // into a bucket.
  assert.deepEqual(countInto(buckets, dates), [0, 0, 0, 1]);
});

test("a date outside the drawn window is ignored, not clamped to an edge", () => {
  const buckets = weekBuckets(ASOF, 4);
  const old = new Date("2026-01-01T00:00:00Z"); // long before the window
  const future = new Date("2027-01-01T00:00:00Z");
  assert.deepEqual(countInto(buckets, [old, future]), [0, 0, 0, 0]);
});

/* ── the body ──────────────────────────────────────────────────────────────── */

test("the response shape is the contract, with coverage passed through", () => {
  const out = buildTrend({
    asOf: ASOF, weeks: 4,
    startedDates: [new Date("2026-08-24T05:00:00Z")],
    completedDates: [new Date("2026-09-03T05:00:00Z")],
    startedWithoutTimestamp: 3,
    completedWithoutTimestamp: 2,
  });
  assert.equal(out.success, true);
  assert.equal(out.bucket, "week");
  assert.equal(out.weeks, 4);
  assert.equal(out.asOf, ASOF.toISOString());
  assert.deepEqual(Object.keys(out.points[0]).sort(), ["completedWorkOrders", "periodEnd", "periodStart", "startedWorkOrders"]);
  assert.deepEqual(out.coverage, { startedWithoutTimestamp: 3, completedWithoutTimestamp: 2 });
});

test("coverage counts that are not finite become 0, never a guess", () => {
  const out = buildTrend({ asOf: ASOF, weeks: 4, startedDates: [], completedDates: [], startedWithoutTimestamp: undefined, completedWithoutTimestamp: NaN });
  assert.deepEqual(out.coverage, { startedWithoutTimestamp: 0, completedWithoutTimestamp: 0 });
});

test("the helper takes only the two timestamp lists — no createdAt/updatedAt path", () => {
  // Structural guarantee: `buildTrend` has no way to read anything but the
  // started/completed date arrays the route hands it, so the "no updatedAt
  // substitution" rule cannot be violated here.
  const raw = require("node:fs").readFileSync(require("node:path").join(__dirname, "productionTrend.js"), "utf8");
  // Strip comments — the header explains the rule and names the very fields it
  // forbids; the rule is about CODE.
  const src = raw.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(src.includes("buildTrend"), "comment stripping ate the source");
  assert.doesNotMatch(src, /createdAt|updatedAt/);
});
