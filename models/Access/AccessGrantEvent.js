// models/Access/AccessGrantEvent.js
//
// THE APPEND-ONLY AUDIT OF APPLICATION ACCESS (GAC-2 correction, 25 Sep 2026).
//
// One document per accepted access change, written by
// services/access/accessGrantAdmin.service.js inside the same transaction as
// the change itself. Nothing else writes here, and nothing — anywhere — may
// change or remove a document once written.
//
// Why not models/Access/ChangeLog.js: that collection is the readable "who
// changed what" history for every module. It says of itself that it is not a
// compliance audit, it has no protection against update or delete, and
// verification scripts delete from it. The access change still leaves a
// ChangeLog line for the History screen, but THIS is the record of authority.
//
// ── HOW "APPEND-ONLY" IS ENFORCED ────────────────────────────────────────────
//   1. Every Mongoose update, replace and delete path on this model throws —
//      query middleware for updateOne/updateMany/findOneAndUpdate/replaceOne/
//      findOneAndReplace/deleteOne/deleteMany/findOneAndDelete, model
//      middleware for bulkWrite, and document middleware for a save() of an
//      existing document and for doc.deleteOne(). An application bug cannot
//      edit history by accident.
//   2. A hash chain. Each event stores `seq`, `prevHash` and
//      `hash = sha256(prevHash + canonical(event))`, and the chain head lives
//      in `access_grant_head` (advanced in the same transaction). A raw driver
//      write that edits, reorders or removes an event — the one path Mongoose
//      middleware cannot see — breaks the chain, and verifyChain() reports the
//      first broken sequence number. Tampering is therefore DETECTABLE even
//      where it cannot be PREVENTED from inside the application.
//   3. Database privileges are the remaining layer: in production the
//      application's MongoDB user should hold insert/find (no update/remove)
//      on `access_grant_events`. That is a deployment change, recorded as
//      outstanding in docs/handoff/latest-implementation.md.
//
// ── IDEMPOTENCY IN STORAGE ───────────────────────────────────────────────────
// `_id` IS the idempotency key. MongoDB's `_id` uniqueness needs no index build
// (autoIndex is off in production), holds across every application, and makes
// two concurrent requests with one key impossible to both commit: the second
// insert fails with a duplicate key or a transaction write conflict.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IMMUTABLE_MESSAGE = "access_grant_events is append-only: an access audit event cannot be changed or removed.";

class ImmutableAuditError extends Error {
  constructor(op) {
    super(`${IMMUTABLE_MESSAGE} (${op})`);
    this.code = "ACCESS_AUDIT_IMMUTABLE";
  }
}

const accessGrantEventSchema = new mongoose.Schema(
  {
    // The idempotency key. See the note above.
    _id: { type: String, required: true },

    seq: { type: Number, required: true },
    prevHash: { type: String, required: true },
    hash: { type: String, required: true },

    application: { type: String, required: true },
    actor: {
      id: { type: String, default: "" },
      email: { type: String, default: "" },
      name: { type: String, default: "" },
      subject: { type: String, default: "" },
      authority: { type: String, default: "" }, // platform_admin | application_owner
    },
    target: {
      subject: { type: String, required: true },
      id: { type: String, required: true },
      email: { type: String, required: true },
    },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    changed: { type: Boolean, required: true },
    sideEffects: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reason: { type: String, required: true },
    fingerprint: { type: String, required: true },
    // Which door the request came through (the canonical route or a named
    // compatibility adapter). Informational only.
    via: { type: String, default: "" },
    occurredAt: { type: Date, required: true },
  },
  { collection: "access_grant_events", versionKey: false, minimize: false },
);

accessGrantEventSchema.index({ seq: 1 }, { unique: true, name: "access_grant_seq_unique" });
accessGrantEventSchema.index({ application: 1, occurredAt: -1 });
accessGrantEventSchema.index({ "target.email": 1, occurredAt: -1 });

/* ── 1. refuse every mutation path Mongoose offers ─────────────────────── */
const QUERY_MUTATIONS = [
  "updateOne", "updateMany", "findOneAndUpdate", "replaceOne",
  "findOneAndReplace", "deleteOne", "deleteMany", "findOneAndDelete",
];
for (const op of QUERY_MUTATIONS) {
  accessGrantEventSchema.pre(op, { query: true, document: false }, function refuse() {
    throw new ImmutableAuditError(op);
  });
}
accessGrantEventSchema.pre("deleteOne", { document: true, query: false }, function refuse() {
  throw new ImmutableAuditError("document.deleteOne");
});
accessGrantEventSchema.pre("save", function refuseResave() {
  if (!this.isNew) throw new ImmutableAuditError("save of an existing event");
});
accessGrantEventSchema.pre("bulkWrite", function refuseBulk(next, ops) {
  const list = Array.isArray(ops) ? ops : [];
  if (list.some((o) => !o.insertOne)) throw new ImmutableAuditError("bulkWrite");
  next();
});

/* ── 2. the hash chain ─────────────────────────────────────────────────── */

const GENESIS = "0".repeat(64);

/** Stable JSON: keys sorted at every level, so the hash does not depend on key order. */
function canonical(value) {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The fields the hash covers — everything except the hash itself. */
function hashedFields(ev) {
  return {
    _id: ev._id, seq: ev.seq, prevHash: ev.prevHash, application: ev.application,
    actor: ev.actor, target: ev.target, before: ev.before ?? null, after: ev.after ?? null,
    changed: ev.changed, sideEffects: ev.sideEffects || [], reason: ev.reason,
    fingerprint: ev.fingerprint, via: ev.via || "", occurredAt: new Date(ev.occurredAt),
  };
}

function computeHash(ev) {
  return crypto.createHash("sha256").update(canonical(hashedFields(ev))).digest("hex");
}

/**
 * The chain head: one document, advanced inside every grant transaction.
 * Also carries `revision`, the shared counter authorization caches compare
 * against (services/access/grantRevision.js).
 */
const accessGrantHeadSchema = new mongoose.Schema(
  {
    _id: { type: String },
    seq: { type: Number, default: 0 },
    lastHash: { type: String, default: GENESIS },
    revision: { type: Number, default: 0 },
  },
  { collection: "access_grant_head", versionKey: false },
);

const AccessGrantEvent = mongoose.models.AccessGrantEvent
  || mongoose.model("AccessGrantEvent", accessGrantEventSchema);
const AccessGrantHead = mongoose.models.AccessGrantHead
  || mongoose.model("AccessGrantHead", accessGrantHeadSchema);

const HEAD_ID = "access-grants";

/**
 * Walk the chain in sequence order and report the first break. Read-only.
 * @returns {{ ok: boolean, events: number, brokenAt?: number, problem?: string }}
 */
async function verifyChain() {
  const head = await AccessGrantHead.findById(HEAD_ID).lean();
  let prev = GENESIS;
  let expectedSeq = 1;
  let count = 0;
  const cursor = AccessGrantEvent.find({}).sort({ seq: 1 }).lean().cursor();
  for await (const ev of cursor) {
    count += 1;
    if (ev.seq !== expectedSeq) return { ok: false, events: count, brokenAt: expectedSeq, problem: "missing or reordered event" };
    if (ev.prevHash !== prev) return { ok: false, events: count, brokenAt: ev.seq, problem: "prevHash does not match the previous event" };
    if (computeHash(ev) !== ev.hash) return { ok: false, events: count, brokenAt: ev.seq, problem: "event content does not match its hash" };
    prev = ev.hash;
    expectedSeq += 1;
  }
  if ((head?.seq || 0) !== count) return { ok: false, events: count, brokenAt: count + 1, problem: "head sequence does not match the events present" };
  if ((head?.lastHash || GENESIS) !== prev) return { ok: false, events: count, brokenAt: count, problem: "head hash does not match the last event" };
  return { ok: true, events: count };
}

module.exports = {
  AccessGrantEvent,
  AccessGrantHead,
  HEAD_ID,
  GENESIS,
  computeHash,
  verifyChain,
  ImmutableAuditError,
};
