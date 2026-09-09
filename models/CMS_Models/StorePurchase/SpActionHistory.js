// models/CMS_Models/StorePurchase/SpActionHistory.js
//
// Store & Purchase — Chunk 1. WHAT HAPPENED, WHO DID IT, AND WHY.
//
// ── APPEND-ONLY, ENFORCED AT THE SCHEMA ─────────────────────────────────────
// "Immutable" that relies on nobody writing an update is not immutable. Every
// mutating entry point mongoose offers is blocked below, so a future route —
// or a well-meant fix — cannot quietly rewrite what happened. The existing
// StockLedger is the cautionary example: it was built to record corrections
// and its edit route rewrites the original transaction's quantity in place.
//
// ── WHAT IS DELIBERATELY NOT STORED ─────────────────────────────────────────
// No tokens, no uploaded document contents, no bank details, no full request
// payloads. History answers "what changed and who changed it", and a record
// that also carries the payload becomes a second copy of the data it
// describes — one that outlives deletion and is read by more people.
"use strict";

const mongoose = require("mongoose");

const ACTOR_TYPES = ["employee", "deptUser", "service", "system"];

const actionHistorySchema = new mongoose.Schema(
  {
    /* Tenant. History is as company-scoped as the records it describes. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* What it happened to. `entityType` is server vocabulary
       ("PURCHASE_ORDER", "MRF", …). */
    entityType: { type: String, required: true, trim: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* The human number AS IT WAS. A snapshot, deliberately: the document may
       later be cancelled or renumbered, and this row must still say which
       piece of paper the action was about. */
    documentNumber: { type: String, trim: true, default: "" },

    /* Server vocabulary: "CREATED", "ISSUED", "RECEIVED", "CANCELLED", … */
    action: { type: String, required: true, trim: true },

    /* Who. Id and type are the authority; the name is a snapshot so the row
       still reads after the person leaves. */
    actorId: { type: String, required: true, trim: true },
    actorType: { type: String, enum: ACTOR_TYPES, default: "employee" },
    actorName: { type: String, trim: true, default: "" },

    at: { type: Date, default: Date.now, index: true },

    /* Transition. Null `previousState` on a creation is correct, not missing. */
    previousState: { type: String, trim: true, default: null },
    resultingState: { type: String, trim: true, default: null },

    /* Required by the caller for actions that demand one (cancellation,
       adjustment, override). The service enforces it; the schema cannot know
       which actions those are. */
    reason: { type: String, trim: true, default: "" },

    /* Correlation. `requestId` ties an entry to one HTTP request even when
       that request wrote several; `idempotencyKey` ties a replay back to the
       original attempt, which is how a replay is proved NOT to have appended
       a second entry. */
    requestId: { type: String, trim: true, default: "" },
    idempotencyKey: { type: String, trim: true, default: "" },

    /* A SUMMARY of what changed — field names and short scalar values only.
       Never the documents themselves. */
    changes: [
      {
        field: { type: String, trim: true },
        from: { type: mongoose.Schema.Types.Mixed },
        to: { type: mongoose.Schema.Types.Mixed },
        _id: false,
      },
    ],

    /* Small, structured, non-sensitive context (counts, quantities, policy
       outcome). Bounded by the service, not by trust. */
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    /* Set when the entry could not be written inside the same transaction as
       the state change it describes — see actionHistory.service.js. A row
       carrying this is evidence for reconciliation, not a normal entry. */
    atomicityDegraded: { type: Boolean, default: false },
  },
  { timestamps: true, collection: "sp_action_history" },
);

actionHistorySchema.index({ companyId: 1, entityType: 1, entityId: 1, at: -1 });
actionHistorySchema.index({ companyId: 1, at: -1 });
actionHistorySchema.index({ companyId: 1, idempotencyKey: 1 });

/* ── The append-only guarantee ─────────────────────────────────────────────
 * Every mutation hook mongoose exposes is refused. Inserting is the only
 * thing this model does. A test asserts each of these throws. */
const IMMUTABLE = new Error(
  "SpActionHistory is append-only: entries cannot be updated or deleted.",
);

function refuse(next) {
  next(IMMUTABLE);
}

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace",
  "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "remove",
]) {
  actionHistorySchema.pre(op, function (next) { refuse(next); });
}

/* Document-level: `save()` on an already-persisted entry is an edit. */
actionHistorySchema.pre("save", function (next) {
  if (!this.isNew) return refuse(next);
  next();
});

module.exports =
  mongoose.models.SpActionHistory ||
  mongoose.model("SpActionHistory", actionHistorySchema);
module.exports.ACTOR_TYPES = ACTOR_TYPES;
