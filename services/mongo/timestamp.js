/**
 * A Firestore `Timestamp`, for data that lives in MongoDB.
 *
 * ## Why this has to exist
 *
 * MongoDB stores a date as a BSON `Date`. Firestore hands back a `Timestamp`.
 * They are not interchangeable in either direction, and both directions are
 * already load-bearing in this codebase:
 *
 * · **12 call sites do `.toDate()`.** A BSON `Date` has no such method, so each
 *   one is a `TypeError` the moment the database changes underneath it —
 *   scattered across `taskForward.service.js`, `cowork.service.js`,
 *   `timerSopTime.js`, `workloadroutes.js` and `livekit.routes.js`.
 * · **The browser parses `{_seconds, _nanoseconds}`.** That is what a Firestore
 *   `Timestamp` serialises to through `res.json()`, and the Cowork frontend
 *   reads exactly that shape in `lib/legacy/tasks.ts`,
 *   `lib/repositories/legacy/index.ts`, `workMap.ts` and
 *   `priorityDeadline.ts`. Hand it an ISO string instead and every deadline,
 *   timer and "started at" silently becomes null.
 *
 * So the facade stores BSON `Date` — which is correct, queryable and indexable
 * — and hands back one of these on the way out. Nothing above the facade can
 * tell the difference, which is the entire point.
 *
 * ## The parity that matters
 *
 * `toJSON()` emits `{_seconds, _nanoseconds}` so the wire format to the browser
 * is byte-identical to today. `valueOf()` returns milliseconds, so
 * `new Date(ts)`, `ts > other` and `Math.max(...)` all behave.
 *
 * What is deliberately NOT provided is `getTime()` or any other `Date` method.
 * A Firestore `Timestamp` has none of them either, so code calling one was
 * already broken before this migration — and quietly adding them here would
 * hide a real bug rather than fix it.
 *
 * ## The precision
 *
 * BSON `Date` is millisecond-precision, so `nanoseconds` is always a whole
 * number of milliseconds expressed in nanos. Firestore could store finer; this
 * cannot, and nothing in this product measures finer. The loss happens once,
 * at migration, and is recorded in `convert.js`.
 */

"use strict";

const NANOS_PER_MS = 1e6;
const MS_PER_SECOND = 1000;

class CompatTimestamp {
  /**
   * @param {number} seconds whole seconds since the epoch
   * @param {number} nanoseconds remainder, in nanoseconds
   */
  constructor(seconds, nanoseconds) {
    this.seconds = seconds;
    this.nanoseconds = nanoseconds;
    /* Frozen because a Timestamp is a value. Firestore's is immutable, and code
       that mutated one here would behave differently after the migration in a
       way nothing would catch. */
    Object.freeze(this);
  }

  static fromDate(date) {
    return CompatTimestamp.fromMillis(date.getTime());
  }

  static fromMillis(ms) {
    const seconds = Math.floor(ms / MS_PER_SECOND);
    /* `ms - seconds * 1000` rather than `ms % 1000`, so a pre-epoch value does
       not produce a negative remainder that would read as the wrong second. */
    return new CompatTimestamp(seconds, (ms - seconds * MS_PER_SECOND) * NANOS_PER_MS);
  }

  toDate() {
    return new Date(this.toMillis());
  }

  toMillis() {
    return this.seconds * MS_PER_SECOND + Math.floor(this.nanoseconds / NANOS_PER_MS);
  }

  isEqual(other) {
    return (
      other instanceof CompatTimestamp &&
      other.seconds === this.seconds &&
      other.nanoseconds === this.nanoseconds
    );
  }

  /**
   * The wire format the browser already reads.
   *
   * `_seconds` / `_nanoseconds` with the underscores, because that is what the
   * admin SDK's Timestamp serialises to and what the frontend parses. Renaming
   * them to the public `seconds`/`nanoseconds` would read better and break
   * every date on every screen.
   */
  toJSON() {
    return { _seconds: this.seconds, _nanoseconds: this.nanoseconds };
  }

  /** So `new Date(ts)`, `ts > other` and arithmetic all work. */
  valueOf() {
    return this.toMillis();
  }

  toString() {
    return `Timestamp(seconds=${this.seconds}, nanoseconds=${this.nanoseconds})`;
  }
}

/**
 * Every `Date` in a document, on its way out to the caller.
 *
 * Applied on read rather than stored, so what MongoDB holds stays a real BSON
 * `Date` — indexable, and comparable in a query. The conversion is the facade's
 * job precisely so the storage can be right and the callers can be unchanged.
 */
function reviveTimestamps(value, seen = new Set()) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return CompatTimestamp.fromDate(value);
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof CompatTimestamp) return value;

  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    const out = value.map((v) => reviveTimestamps(v, seen));
    seen.delete(value);
    return out;
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = reviveTimestamps(v, seen);
  seen.delete(value);
  return out;
}

module.exports = { CompatTimestamp, reviveTimestamps };
