// models/CMS_Models/Costing/Costing.js
//
// Central Costing — Chunk 1. THE COSTING RECORD ITSELF.
//
// ── WHAT THIS DOCUMENT IS, AND WHAT IT IS NOT ───────────────────────────────
// This is the STABLE HANDLE. It says which company owns a costing, what the
// costing is about, whether it is live or archived, and which version is
// current. It holds no cost, no price, no margin and no supplier — every one
// of those lives on a CostingVersion, which is frozen once written.
//
// Splitting it this way is what makes "a correction creates a new version"
// enforceable rather than aspirational: there is nothing commercial on this
// document to correct in place.
//
// ── WHY IT IS NOT UNDER Sales/, Store/ OR Accountant_model/ ─────────────────
// Costing consumes Store's supplier facts, Manufacturing's technical facts and
// Finance's overhead policy, and hands Sales a number it may quote. Owned by
// any one of those, it would inherit that module's access rules — which is
// exactly how a Sales screen ends up able to read a supplier's price. It sits
// in its own namespace so its own rules are the only ones that apply.
"use strict";

const mongoose = require("mongoose");

const { contextRefSchema, contextSnapshotSchema } = require("./costingContext");

/**
 * Lifecycle.
 *
 * ── ONLY THE STATE THIS CHUNK CAN HONESTLY ENFORCE ──────────────────────────
 * The roadmap's full lifecycle is Draft → In review → Approved → Superseded,
 * and Chunk 6 implements the transitions, the approver identity and the
 * reasons. Declaring those values now would let a future writer set
 * `APPROVED` with none of the controls that are supposed to precede it.
 * So a Costing has exactly one live state, plus archive.
 */
const COSTING_STATES = Object.freeze(["DRAFT"]);

const costingSchema = new mongoose.Schema(
  {
    /* ── OWNERSHIP ─────────────────────────────────────────────────────────
       Required, always stamped from the resolved company context, never read
       from a request body. There is no legacy-global costing: this collection
       is new, so every document in it has an owner from the first write and
       no read path has to cope with an unowned one. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
    },

    /* What this costing is about — typed, inert, never authority. */
    context: { type: contextRefSchema, required: true },

    /* How it reads to a human, frozen at creation. Display only. */
    contextSnapshot: { type: contextSnapshotSchema, default: () => ({}) },

    status: { type: String, enum: COSTING_STATES, default: "DRAFT", required: true },

    /* ── THE CURRENT VERSION POINTER ───────────────────────────────────────
       A cache of "the highest version number", maintained in the same unit of
       work that creates a version so it can never name a version that does
       not exist. It is NOT the authority on what versions there are — the
       CostingVersion collection is, and `GET /:id/versions` reads that. */
    currentVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    currentVersionNumber: { type: Number, default: 0, min: 0 },

    /* Creator, from the authenticated actor. `actorId` is a string because the
       identity chain has more than one kind of subject (employee ObjectId,
       biometric id) and storing whichever one arrived as an ObjectId would
       lose the ones that are not. */
    createdByActorId: { type: String, trim: true, default: "" },
    createdByActorName: { type: String, trim: true, default: "" },

    /* ── ARCHIVE, NEVER DELETE ─────────────────────────────────────────────
       A costing is the parent of an immutable version history. Deleting it
       would orphan frozen records that a quotation, a budget or an audit may
       still reference. */
    isArchived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    archivedByActorId: { type: String, trim: true, default: "" },
    archiveReason: { type: String, trim: true, maxlength: 500, default: "" },
  },
  { timestamps: true, collection: "costings" },
);

/* ── INDEXES ────────────────────────────────────────────────────────────────
   Company first in every one, because every query starts with the company and
   a compound index whose leading field is not the tenant scope is an index the
   scoped query cannot use.

   Deliberately NOT unique on context: a style is costed more than once — for
   different buyers, different seasons, different quantities — and a unique
   index would make the second attempt look like a duplicate. Uniqueness in
   this domain belongs to the VERSION NUMBER within a costing, and that index
   is on CostingVersion. */
costingSchema.index({ companyId: 1, createdAt: -1 });
costingSchema.index({ companyId: 1, isArchived: 1, status: 1, updatedAt: -1 });
costingSchema.index({ companyId: 1, "context.type": 1, "context.primaryId": 1 });

module.exports =
  mongoose.models.Costing || mongoose.model("Costing", costingSchema);
module.exports.COSTING_STATES = COSTING_STATES;
