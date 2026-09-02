// models/CMS_Models/StorePurchase/SpIdempotencyRecord.js
//
// Store & Purchase — Chunk 1. ONE USER ACTION, ONE EFFECT.
//
// Chunk 0 pinned the behaviour this exists to stop: re-posting a goods
// receipt is accepted and silently books the whole delivery into stock a
// second time as "surplus", and a double-clicked payment is recorded twice.
// Nothing in the domain is idempotent today.
//
// ── WHY THE PAYLOAD IS HASHED AND NOT STORED ────────────────────────────────
// The record must be able to say "this is the same request" without keeping
// the request. A SHA-256 of the canonical body does that, and cannot leak a
// bank reference or a price if the collection is ever read by the wrong
// person. The stored RESPONSE is the one thing that has to be kept verbatim,
// because replaying it is the point.
"use strict";

const mongoose = require("mongoose");

/**
 * ── WHY THERE IS AN EFFECT_APPLIED STATE ────────────────────────────────────
 * The first version had three states, and a hole between two of them: the
 * business mutation could succeed, the history write then fail, the request
 * return 500, and the record be marked FAILED — at which point a retry was
 * told to go ahead and do the mutation AGAIN. Stock moved twice for one
 * delivery, which is the exact failure idempotency exists to prevent.
 *
 * EFFECT_APPLIED is the durable marker that closes it. Once the domain
 * mutation has committed, the record says so, and no retry may re-run it —
 * only finish what is left (history, response) and replay.
 */
const STATUSES = ["IN_PROGRESS", "EFFECT_APPLIED", "COMPLETED", "FAILED"];

const idempotencySchema = new mongoose.Schema(
  {
    /* Scope. A key is only ever meaningful within one company, for one actor,
       on one operation — so the same key from two people, or on two different
       endpoints, is two different things and must not collide. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    actorId: { type: String, required: true, trim: true },
    operation: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true },

    /* Canonical SHA-256 of the request body. Same key + different hash is a
       client bug worth refusing loudly, not a replay. */
    requestHash: { type: String, required: true, trim: true },

    status: { type: String, enum: STATUSES, default: "IN_PROGRESS", index: true },

    /* Kept only for COMPLETED records — what to replay. */
    responseStatus: { type: Number },
    responseBody: { type: mongoose.Schema.Types.Mixed },

    /* For diagnosis; never replayed. */
    failureReason: { type: String, trim: true, default: "" },

    /* When the domain mutation committed. Its presence — not the status
       string alone — is what a recovery path checks before deciding whether
       re-running the work is safe. */
    effectAppliedAt: { type: Date, default: null },

    /* Renewed while a request is running, so a crashed process can be told
       apart from a slow one. Without it an IN_PROGRESS record would lock the
       action until the 30-day TTL expired. */
    heartbeatAt: { type: Date, default: Date.now },

    /* What the operation produced, so a replay is traceable to its document
       even if the response body is later trimmed. */
    resultEntityType: { type: String, trim: true, default: "" },
    resultEntityId: { type: mongoose.Schema.Types.ObjectId, default: null },

    completedAt: { type: Date },
  },
  { timestamps: true, collection: "sp_idempotency_records" },
);

/* The uniqueness that makes concurrent duplicates impossible: the second
   insert loses on this index and is told to replay rather than to execute. */
idempotencySchema.index(
  { companyId: 1, actorId: 1, operation: 1, key: 1 },
  { unique: true },
);

/* Documented retention: 30 days. Long enough for any realistic retry — a
   user re-submitting a form, a mobile client resuming, an operator coming
   back after a network failure — and short enough that the collection is not
   an indefinite record of who did what, which is action history's job. */
idempotencySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports.STATUSES = STATUSES;
module.exports =
  mongoose.models.SpIdempotencyRecord ||
  mongoose.model("SpIdempotencyRecord", idempotencySchema);
module.exports.STATUSES = STATUSES;
