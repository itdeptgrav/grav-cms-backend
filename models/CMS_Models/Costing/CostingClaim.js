// models/CMS_Models/Costing/CostingClaim.js
//
// Central Costing — Chunk 2. A KEY THAT RESOLVED TO A VERSION SOMEBODY ELSE MADE.
//
// ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
// A costing version carries the claim of the ONE key that created it
// (`provenance.creationClaimId`), and that is a durable, uniquely-indexed
// record — it outlives the 30-day `SpIdempotencyRecord` and is what makes a
// retry safe forever.
//
// But a legacy import has a second way to succeed. A DIFFERENT key importing an
// UNCHANGED sheet is answered from content deduplication: the sheet's content
// hash already matches a frozen version, so that version is returned rather
// than duplicated. That second key never touched `provenance` — it could not,
// because a version is immutable and belongs to the first key — so its only
// trace was the temporary idempotency row. Once that row expired or was
// deleted, the key had no history at all and could be spent again, against a
// different costing, with nothing left to notice. The permanent binding this
// domain promises held for the first key and quietly lapsed for every other.
//
// ── WHY A SEPARATE COLLECTION AND NOT A FIELD ───────────────────────────────
// The relationship is many-to-one: any number of keys may legitimately resolve
// to one version. Recording them ON the version would mean appending to a
// frozen document on every alias — mutating immutable content to record
// something that is not part of the costing at all. A receipt is a different
// fact about a different thing: it is bookkeeping ABOUT a key, not content OF
// a costing, and it belongs in its own place.
//
// ── AND IT IS A POINTER, NEVER AN AUTHORITY ─────────────────────────────────
// A receipt says "this key already resolved to that version". It never carries
// cost, price or margin, and nothing reads a costing THROUGH it: the version it
// names is loaded and checked under the caller's own company scope, exactly as
// any other read is.
"use strict";

const mongoose = require("mongoose");

const costingClaimSchema = new mongoose.Schema(
  {
    /* Required, always from the resolved company context. A key is only ever
       meaningful within one company. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
    },

    /* The server-derived claim: sha256 of {company, actor, operation, key}.
       Deliberately target-independent, for the reason set out in
       Middlewear/centralCostingContext.js — a key aimed at a second costing
       must COLLIDE here rather than mint a fresh claim and quietly succeed. */
    claimId: { type: String, required: true, trim: true },

    /* Which endpoint spent it, for diagnosis. Not part of the identity: the
       claim id already encodes the operation. */
    operation: { type: String, trim: true, default: "" },

    /* What the key was spent ON, and what it was spent DOING. All three are
       compared before a recovery is allowed, so a key cannot be re-aimed at a
       different costing or a corrected payload. */
    costingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    target: { type: String, trim: true, default: "" },
    requestHash: { type: String, trim: true, default: "" },

    /* The version the key resolved to — created by it, or already existing and
       matched by content. */
    versionId: { type: mongoose.Schema.Types.ObjectId, required: true },
    versionNumber: { type: Number, min: 1 },

    /* Why this key resolved the way it did, so a reader can tell the key that
       did the work from the ones that arrived afterwards. */
    resolution: {
      type: String,
      enum: ["CREATED", "CONTENT_DEDUPLICATED"],
      default: "CREATED",
    },
  },
  { timestamps: true, collection: "costing_claims" },
);

/* ── ONE CLAIM, ONE ANSWER — ENFORCED BY THE DATABASE ───────────────────────
 * Two concurrent imports under different keys both write a receipt, and that
 * is correct: two keys, two receipts, one version. What must never happen is
 * the SAME key resolving to two different versions, and this index makes that
 * impossible rather than unlikely.
 *
 * Company-scoped, never global: a claim id is derived from the company, so a
 * global index would be both redundant and a cross-tenant collision waiting to
 * happen. */
costingClaimSchema.index({ companyId: 1, claimId: 1 }, { unique: true });

/* "Which keys resolved to this version" — for diagnosis, and for a future
   chunk that wants to show the provenance of a recovered answer. */
costingClaimSchema.index({ companyId: 1, versionId: 1 });

module.exports =
  mongoose.models.CostingClaim || mongoose.model("CostingClaim", costingClaimSchema);
