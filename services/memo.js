// services/memo.js
//
// A small in-process memo for reads that are the same for everybody and
// change rarely: the settings singletons, the list of departments.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The production backend runs in Oregon and its database in Mumbai. Every
// query is a ~234 ms round trip across the Pacific — measured, not guessed:
// the health endpoint reports the ping, and the request log reads like a
// ruler in multiples of it. So a read that is repeated on every request costs
// a quarter of a second every time, whatever it returns. AttendanceSettings
// alone was read from the database at 28 call sites, on nearly every
// attendance request, and it changes a few times a year.
//
// Memoising it for a few seconds removes one round trip from most requests.
// Nothing else changes: the first read after the window, or after a write,
// still goes to the database.
//
// ── SINGLE INSTANCE ─────────────────────────────────────────────────────────
// This is process memory. The host runs one instance (WEB_CONCURRENCY=1), so
// a write here invalidates the only copy there is. With more than one
// instance a write on one would take up to TTL to be seen by the others —
// acceptable for settings, and the TTL is short for exactly that reason.
//
// ── CLONES, NOT REFERENCES ──────────────────────────────────────────────────
// Plain objects are handed out as deep clones, so a caller that edits the
// value it was given (several back-fill loops do) cannot poison the copy the
// next caller receives. Mongoose documents are handed out as-is: cloning
// would strip their methods, and every writer of these singletons goes
// through the model (findOneAndUpdate / updateOne / save), which is what the
// invalidation hooks watch.

"use strict";

const entries = new Map(); // key -> { value, expiresAt, pending }

function isPlain(v) {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

function handOut(v) {
  return isPlain(v) ? structuredClone(v) : v;
}

/**
 * @param {string}   key
 * @param {number}   ttlMs
 * @param {Function} loader  async () => value
 */
async function memo(key, ttlMs, loader) {
  const now = Date.now();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return handOut(hit.value);

  /* One loader in flight per key: ten concurrent first-reads after an
     invalidation would otherwise all cross the Pacific. */
  if (hit?.pending) return handOut(await hit.pending);

  const pending = (async () => {
    const value = await loader();
    entries.set(key, { value, expiresAt: Date.now() + ttlMs, pending: null });
    return value;
  })();
  entries.set(key, { value: hit?.value, expiresAt: 0, pending });
  try {
    return handOut(await pending);
  } catch (err) {
    entries.delete(key);
    throw err;
  }
}

function invalidate(key) {
  entries.delete(key);
}

/**
 * Wire invalidation to every write path of a schema.
 *
 * Call BEFORE mongoose.model() compiles the schema. Covers document saves,
 * the query-level updates, and deletes — the ways a singleton is ever
 * written in this codebase.
 */
function invalidateOnWrite(schema, key) {
  const drop = function () {
    invalidate(key);
  };
  schema.post("save", drop);
  schema.post(
    ["findOneAndUpdate", "updateOne", "updateMany", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"],
    drop,
  );
}

/** For tests and the developer side. */
function stats() {
  const out = {};
  for (const [k, e] of entries) out[k] = { cached: e.value !== undefined, ttlLeftMs: Math.max(0, e.expiresAt - Date.now()) };
  return out;
}

module.exports = { memo, invalidate, invalidateOnWrite, stats };
