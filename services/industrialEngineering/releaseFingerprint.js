// services/industrialEngineering/releaseFingerprint.js
//
// IE CHUNK 8A-i — THE AGGREGATE FINGERPRINT.
//
// One hash over the complete frozen release payload: the approved bulletin
// rows, the approved line layout's arrangement and metrics, and the approved
// capacity standard's inputs, calculation and evidence.
//
// ── WHY NOT THE BULLETIN'S OWN FINGERPRINT ─────────────────────────────────
// `sourceFingerprint` proves the bulletin ROWS and nothing more. Two releases
// whose bulletin is identical but whose line was rearranged, or whose capacity
// assumptions were re-planned, are two different things to hand Planning — and
// under the bulletin's fingerprint the second would look like a duplicate of the
// first, be refused as a no-op, and never reach anybody. The unique index that
// makes re-issuing an identical aggregate a no-op is only as honest as the value
// it is built on.
//
// ── WHAT IS EXCLUDED, AND WHY ──────────────────────────────────────────────
// Everything volatile: the capture time, the release version, the issuer, the
// history and the note. Two people issuing the same aggregate a minute apart are
// issuing the SAME aggregate, and a fingerprint that moved with the clock would
// mint a second version for no change at all. The note is excluded for the same
// reason from the other direction: re-wording a covering note does not change
// what was planned, and a fingerprint that said it did would supersede a release
// over an apostrophe.
//
// Overrides are excluded too. An override records why a retired operation was
// allowed through; it says nothing about the plan being handed over, and two
// releases of one aggregate with different override reasons are still one
// aggregate.
//
// ── AND CANONICALISATION IS THE WHOLE PROBLEM ──────────────────────────────
// The same aggregate read twice must hash identically even though Mongoose
// hands back ObjectIds one time and strings the next, Dates one time and ISO
// strings the next, and object keys in whatever order the driver felt like. So
// every value is reduced to a tagged string, every object's keys are sorted, and
// ARRAYS ARE NOT — a bulletin's row order is the sequence work is done in, and
// sorting it away would make two different lines hash alike.
"use strict";

const crypto = require("crypto");

/** Volatile or non-aggregate fields, excluded wherever they appear. */
const EXCLUDED = Object.freeze(new Set([
  "capturedAt", "issuedAt", "issuedBy", "issuedByName",
  "versionNo", "releaseRef", "history", "note",
  "retiredOperationOverrides", "aggregateFingerprint",
  "createdAt", "updatedAt", "_id", "__v",
]));

const isObjectId = (v) => v
  && typeof v === "object"
  && (v._bsontype === "ObjectId" || v._bsontype === "ObjectID");

/**
 * One value, as a string in which equal things are equal and nothing else is.
 *
 * The type tags matter: without them the number 1, the string "1" and the
 * boolean true would all canonicalise to the same thing, and three different
 * aggregates would share a fingerprint.
 */
/* An ISO-8601 instant, to the millisecond, with a zone. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function canonical(value, exclude = EXCLUDED) {
  if (value === undefined || value === null) return "n";
  if (isObjectId(value)) return `o:${String(value)}`;
  if (value instanceof Date) return `d:${value.getTime()}`;
  if (Array.isArray(value)) {
    /* Order preserved — it is business evidence, not presentation. */
    return `[${value.map((v) => canonical(v, exclude)).join(",")}]`;
  }
  switch (typeof value) {
    case "number":
      /* Negative zero and zero are the same quantity; NaN and the infinities
         cannot be part of a frozen figure and are tagged so they can never
         masquerade as one. */
      if (Number.isNaN(value)) return "f:NaN";
      if (!Number.isFinite(value)) return `f:${value > 0 ? "+inf" : "-inf"}`;
      return `f:${value === 0 ? 0 : value}`;
    case "boolean": return `b:${value}`;
    case "string": {
      /* A 24-character hex string and the ObjectId it came from are the same
         id, so both reduce to the same token. */
      if (/^[0-9a-f]{24}$/i.test(value)) return `o:${value.toLowerCase()}`;
      /* ── AND AN ISO INSTANT IS THE DATE IT CAME FROM ─────────────────
         The same release read from the database yields Dates and read off the
         wire yields ISO strings. If those hashed differently, nobody could
         recompute a release's fingerprint from the payload they were handed —
         and a fingerprint that only its author can check is not evidence. */
      if (ISO_INSTANT.test(value)) {
        const at = new Date(value);
        if (!Number.isNaN(at.getTime())) return `d:${at.getTime()}`;
      }
      return `s:${value}`;
    }
    case "object": {
      /* A Mongoose subdocument answers `toObject`; a lean one is already plain. */
      const plain = typeof value.toObject === "function" ? value.toObject() : value;
      const keys = Object.keys(plain).filter((k) => !exclude.has(k)).sort();
      return `{${keys.map((k) => `${k}=${canonical(plain[k], exclude)}`).join(",")}}`;
    }
    default:
      /* A function or a symbol has no place in a frozen payload; tagging rather
         than ignoring means one could never slip in unnoticed. */
      return `u:${String(value)}`;
  }
}

/** The canonical string a fingerprint is taken over. Exported for diagnosis. */
const canonicalize = (payload) => `ie-release-v1${canonical(payload)}`;

/** The aggregate fingerprint: SHA-256 over the canonical payload. */
const aggregateFingerprintOf = (payload) =>
  crypto.createHash("sha256").update(canonicalize(payload), "utf8").digest("hex");

/**
 * The canonical hash of a release REQUEST, for the command ledger.
 *
 * Same key with a different request is a client bug refused loudly rather than
 * replayed. The key itself is not part of it — it is the identity the hash hangs
 * off, not part of what was asked.
 *
 * ── AND NOTHING IS EXCLUDED HERE ──────────────────────────────────────────
 * The aggregate's exclusions are about what makes two PLANS the same plan: a
 * covering note does not change what was engineered, so it is left out of the
 * aggregate fingerprint. A REQUEST is a different question. Two requests
 * differing only in their note are two different things somebody asked for, and
 * replaying the first answer for the second would report a success for an
 * intention nobody acted on. So the request hash covers the request entire.
 */
const NOTHING_EXCLUDED = Object.freeze(new Set());

const requestHashOf = (body) =>
  crypto.createHash("sha256")
    .update(`ie-release-request-v1${canonical(body, NOTHING_EXCLUDED)}`, "utf8")
    .digest("hex");

module.exports = { canonical, canonicalize, aggregateFingerprintOf, requestHashOf, EXCLUDED };
