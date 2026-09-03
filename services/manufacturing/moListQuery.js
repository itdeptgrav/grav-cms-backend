// services/manufacturing/moListQuery.js
//
// Query policy for the manufacturing-order register: what a caller asked for,
// turned into something safe and deterministic to run.
//
// Pure and dependency-free — no mongoose, no request, no clock of its own. The
// reference date is passed in, so deadline risk can be tested without moving
// the machine's clock and two servers in different timezones classify the same
// order the same way.
//
// WHY THIS EXISTS SEPARATELY
// -------------------------
// The register's query handling lived inline in the route as
// `parseInt(page)` / `new RegExp(search)`. Both are unsafe on input a URL can
// carry, and the route proved it: `?page=abc`, `?page=0`, `?limit=0`,
// `?limit=-5` and `?search=(` each answered **500**, because a NaN skip and an
// unterminated character class both reach the database as errors. Normalising
// where it can be unit-tested, rather than where it is entangled with an
// aggregation, is the point of the split.
//
// Nothing here widens a query. Every unrecognised value narrows to "matches
// nothing", never to "matches everything" — an unknown filter must not quietly
// return the whole register.

"use strict";

/** The four PM-facing states. Fixed by the register and by Chunk 1's tests. */
const DISPLAY_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

/** Stored on CustomerRequest.priority. */
const PRIORITIES = ["low", "medium", "high", "urgent"];

/**
 * Deadline-risk vocabulary. Mechanical and explainable on purpose: it is a
 * comparison between one date and one reference instant, and nothing else. It
 * models no capacity, no throughput and no production intelligence, and must
 * not be read as predicting whether an order will land.
 *
 *   closed    — the order is completed or cancelled, so a deadline no longer
 *               describes anything actionable
 *   none      — no deadline recorded (neither delivery deadline nor estimate)
 *   overdue   — the deadline is before the reference instant
 *   due_soon  — the deadline falls within DUE_SOON_DAYS of it
 *   on_track  — anything later
 */
const DEADLINE_RISKS = ["overdue", "due_soon", "on_track", "none", "closed"];

/**
 * The due-soon horizon, in days.
 *
 * Seven, to agree with the horizon the register already colours as "risk"
 * (`deadlineToneClass` in the frontend's components/manufacturing/moStatus.js
 * turns amber inside a week). This is a filter vocabulary, not that function:
 * the colouring keeps its own thresholds and is unchanged. What matters is that
 * "due soon" here means the same week a user already sees flagged.
 */
const DUE_SOON_DAYS = 7;

/** Page size when none is asked for. Unchanged from the original route. */
const DEFAULT_LIMIT = 12;

/**
 * Largest page a caller may request.
 *
 * The route used to echo whatever arrived — `?limit=1000000000` was accepted
 * verbatim — which is an unbounded read of every sales-approved order plus a
 * work-order lookup for each. 100 is comfortably above every real caller: the
 * register asks for 12 and the Project Manager dashboard for 5. A larger
 * request is clamped rather than refused, so no existing caller can break on
 * it; `pagination.limit` reports what was actually applied.
 */
const MAX_LIMIT = 100;

/**
 * Largest page a caller may request.
 *
 * Clamping the page size alone was not enough: `skip` is `(page - 1) * limit`,
 * so `?page=1e308` produced `skip: Infinity`, and any page above
 * `Number.MAX_SAFE_INTEGER` produced a skip that could not be represented
 * exactly. Both reach the database as an invalid `$skip` — which is the 500
 * this normalisation exists to prevent, arriving by a different door.
 *
 * A million pages is far past any real caller (at the maximum page size that is
 * a hundred million rows) and keeps the arithmetic exact: the largest skip this
 * permits is (1e6 - 1) x 100 = 99,999,900, comfortably inside the safe-integer
 * range. Clamped rather than refused, like MAX_LIMIT, so no existing caller can
 * break on it; `pagination.page` reports the page actually applied.
 */
const MAX_PAGE = 1_000_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turn text into a regex that matches it literally.
 *
 * Without this, punctuation is code: `(` is an unterminated group and threw a
 * 500, and `.*` quietly matched every order in the register. A person typing an
 * order reference means the characters they typed.
 */
function escapeRegex(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A positive integer no greater than `max`, or `fallback` for anything that is
 * not a positive number at all.
 *
 * Three different inputs, three different answers, on purpose:
 *   - not a number, or below 1  -> `fallback` (there was nothing to honour)
 *   - a positive fraction       -> floored (2.7 pages is 2 pages)
 *   - larger than `max`         -> `max` (honoured as far as it can be)
 */
function positiveInt(value, fallback, max) {
  // Number(), not parseInt(): parseInt("2.7") is 2 and parseInt("12abc") is 12,
  // both of which accept input that was never a page number.
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (floored < 1) return fallback;
  return Math.min(floored, max);
}

/**
 * Page and page size, always usable.
 *
 * Absent, zero, negative and non-numeric resolve to the defaults rather than
 * reaching the database. A positive fraction is FLOORED, not defaulted — 2.7
 * pages is page 2 — which is what the old `parseInt` did for the one input it
 * survived, and is the behaviour callers already have.
 *
 * Oversized values are clamped: pages to MAX_PAGE, page size to MAX_LIMIT. That
 * pairing is what makes `skip` safe. Because both factors are bounded, the
 * product is bounded too — at most (MAX_PAGE - 1) x MAX_LIMIT = 99,999,900 —
 * so `skip` is always a finite, non-negative safe integer and can never reach
 * the database as `Infinity`.
 */
function normalisePagination({ page, limit } = {}) {
  const pageNum = positiveInt(page, 1, MAX_PAGE);
  const limitNum = positiveInt(limit, DEFAULT_LIMIT, MAX_LIMIT);
  return { page: pageNum, limit: limitNum, skip: (pageNum - 1) * limitNum };
}

/**
 * The search term, and the terms it should be matched by.
 *
 * `term` is the trimmed text as typed. `reference` is the same with a leading
 * `MO-` removed, because the register displays `MO-<requestId>` while the
 * stored field is the bare `requestId` — someone copying a number off the
 * screen and pasting it into the search box previously matched nothing at all.
 * The stored value is not changed; only what is compared against it.
 *
 * Returns null when there is nothing to search for, so an all-whitespace term
 * is the same as no term rather than a regex that matches everything.
 */
function normaliseSearch(search) {
  const term = String(search ?? "").trim();
  if (!term) return null;
  const reference = term.replace(/^mo-/i, "").trim();
  return {
    term,
    reference: reference || term,
    escapedTerm: escapeRegex(term),
    escapedReference: escapeRegex(reference || term),
  };
}

/**
 * One of `allowed`, lower-cased and trimmed; null when nothing was asked for.
 *
 * An unrecognised value is returned as-is rather than dropped. That is
 * deliberate: dropping it would turn `?status=bogus` into "no filter" and hand
 * back the entire register, which is the direction a filter must never fail.
 * Passed through, it matches nothing — which is also exactly what the route did
 * before this module existed.
 */
function normaliseEnum(value, allowed) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  return { value: v, known: allowed.includes(v) };
}

const normaliseStatus = (v) => normaliseEnum(v, DISPLAY_STATUSES);
const normalisePriority = (v) => normaliseEnum(v, PRIORITIES);
const normaliseDeadlineRisk = (v) => normaliseEnum(v, DEADLINE_RISKS);

/**
 * The two instants the risk vocabulary is expressed against.
 *
 * Computed once per request and injected into the aggregation as literals, so
 * every row in one response is classified against the same moment.
 */
function deadlineBoundaries(now = new Date()) {
  const at = now instanceof Date ? now : new Date(now);
  return { now: at, dueSoonUntil: new Date(at.getTime() + DUE_SOON_DAYS * DAY_MS) };
}

/**
 * The same classification as the aggregation performs, in JavaScript.
 *
 * Kept so the rule can be read and tested as one small function rather than
 * only as a `$switch`, and so a row assembled outside the pipeline classifies
 * identically. The pipeline is the authority at query time; this must agree
 * with it, and the tests hold both to the same cases.
 */
function classifyDeadlineRisk({ deadline, displayStatus }, now = new Date()) {
  if (displayStatus === "completed" || displayStatus === "cancelled") return "closed";
  if (!deadline) return "none";

  const at = new Date(deadline);
  if (Number.isNaN(at.getTime())) return "none";

  const { now: ref, dueSoonUntil } = deadlineBoundaries(now);
  if (at < ref) return "overdue";
  if (at < dueSoonUntil) return "due_soon";
  return "on_track";
}

/** Everything the projection needs, from everything a URL may carry. */
function normaliseListQuery(query = {}, now = new Date()) {
  return {
    ...normalisePagination(query),
    search: normaliseSearch(query.search),
    status: normaliseStatus(query.status),
    priority: normalisePriority(query.priority),
    deadlineRisk: normaliseDeadlineRisk(query.deadlineRisk),
    ...deadlineBoundaries(now),
  };
}

module.exports = {
  DISPLAY_STATUSES,
  PRIORITIES,
  DEADLINE_RISKS,
  DUE_SOON_DAYS,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  MAX_PAGE,
  escapeRegex,
  normalisePagination,
  normaliseSearch,
  normaliseStatus,
  normalisePriority,
  normaliseDeadlineRisk,
  deadlineBoundaries,
  classifyDeadlineRisk,
  normaliseListQuery,
};
