// models/CMS_Models/Merchandising/Development.js
//
// MERCHANDISING'S PRE-ORDER WORK. THREE RECORDS.
//
//   DevelopmentRequestReceipt  Merchandising's answer to Sales' request.
//   DevelopmentFile            the permanent pre-order aggregate.
//   DevelopmentBomRevision     the versioned material selection.
//
// ── WHY THIS IS NOT THE EXECUTION FILE ──────────────────────────────────────
// An Execution File exists because a customer placed a confirmed order, and
// everything on it is an instruction to execute that order. A Development File
// exists because Sales is trying to WIN an order, and everything on it is a
// proposal — a selection made to be costed and sampled, which may never become
// an order at all.
//
// Folding them together would mean either an Execution File that exists
// without a confirmed requirement (and a register full of speculative work
// nobody has ordered), or a Development selection carrying the guarantees of a
// confirmed instruction. The two records have different grains, different
// lifecycles and different consumers, so they are two records.
//
// Grain: one Development File per company + Sales Journey + product line.
//
// ── AND WHY THE BOM HOLDS IDENTITY ONLY ─────────────────────────────────────
// Fabric, trims, labels, accessories, sample packaging — what they ARE, in
// what colour and finish, on which part of the garment. Not how much of them:
// consumption, allowance and wastage are R&D's, engineered for this style.
// Not what they cost: rates are Costing's and suppliers are Supply Chain's.
//
// A quantity copied here would be presented as established by a record that
// established nothing, which is precisely the failure
// `approvedMaterialShortlist.service.js` was written to end.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

const dateOnly = (extra = {}) => ({
  type: String, trim: true,
  match: [/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date, YYYY-MM-DD."],
  ...extra,
});

/* ═══ 1. MERCHANDISING'S ANSWER TO SALES ═══════════════════════════════════ */

/**
 * `PENDING` is computed, not stored — a request with no receipt is pending,
 * the rule every receipt in this module follows. There is no `REJECTED`:
 * Merchandising cannot refuse to look at what Sales is trying to sell; it
 * accepts, or asks a question.
 */
const RECEIPT_STATE = Object.freeze({
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED_BY_SALES: "CANCELLED_BY_SALES",
});

const CLARIFICATION_CATEGORY = Object.freeze([
  "REQUIREMENT_UNCLEAR",
  "REFERENCE_MISSING",
  "DATE_NOT_ACHIEVABLE",
  "CATEGORY_NOT_APPLICABLE",
  "OTHER",
]);

const MIN_REASON = 15;

const receiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    requestRef: { type: String, trim: true, required: true, immutable: true },
    requestVersionNo: { type: Number, required: true, immutable: true },
    requestId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    state: { type: String, enum: Object.values(RECEIPT_STATE), required: true },
    clarification: {
      category: { type: String, enum: CLARIFICATION_CATEGORY, default: undefined },
      reason: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    decidedBy: actorRef(),
    decidedAt: { type: Date, default: null },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_development_receipts" },
);

receiptSchema.index({ companyId: 1, requestId: 1 }, { unique: true });

/* ═══ 2. THE DEVELOPMENT FILE ══════════════════════════════════════════════ */

/**
 * Where the pre-order job has got to.
 *
 * `RELEASED_TO_RND` is written when SALES authorises release — not when
 * Merchandising approves. Approving says the selection is settled; releasing
 * says the buyer relationship is ready for the money to be spent on sampling,
 * and that is Sales' call. Merchandising approving its own work into R&D's
 * queue would be Merchandising deciding to spend Sales' development budget.
 */
const LIFECYCLE = Object.freeze({
  NEW: "NEW",                       // the request arrived; nobody has started
  ACTIVE: "ACTIVE",                 // a merchandiser is selecting
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",             // Merchandising's selection is settled
  RELEASED_TO_RND: "RELEASED_TO_RND", // Sales authorised onward development
  ON_HOLD: "ON_HOLD",
  CLOSED: "CLOSED",
  CANCELLED: "CANCELLED",           // mirrored from Sales; never authored here
});

const developmentFileSchema = new mongoose.Schema(
  {
    /* ── THE NUMBER IS UNIQUE INSIDE A COMPANY, NOT ACROSS ALL OF THEM ───
       It is allocated per company — `MDV-<year>-0001` is every company's first
       file of the year — so a global unique index made the SECOND company's
       first file of each year impossible to create. The index below matches
       how the number is actually minted.

       Nothing reads a file by this number alone: every lookup in the codebase
       is company-scoped, and the number travels only as a denormalised label
       for people to quote. It is a display identity, and a display identity
       is unique within the tenant that displays it. */
    developmentNumber: { type: String, required: true, immutable: true, trim: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    /* ── THE GRAIN, AND IT IS IMMUTABLE ──────────────────────────────────
       One file per company + Journey + product line. A file that could be
       re-pointed would take its whole approved selection history with it. */
    journeyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    journeyRef: { type: String, trim: true, default: "" },
    productLineRef: { type: String, trim: true, required: true, immutable: true },

    /* The request version in force, and the whole history of them. */
    currentRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
    currentRequestVersionNo: { type: Number, default: null },
    requestHistory: [new mongoose.Schema({
      requestId: { type: mongoose.Schema.Types.ObjectId },
      versionNo: { type: Number },
      event: { type: String, trim: true },
      at: { type: Date },
      by: actorRef(),
    }, { _id: false })],

    /* Copied at creation from the request, for the register's own read. A
       later Sales edit does not reach it: this is what the file was opened
       from, and the current request version is always readable beside it. */
    productName: { type: String, trim: true, default: "" },
    styleRef: { type: String, trim: true, default: "" },
    buyerDisplayLabel: { type: String, trim: true, default: "" },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    stockItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    requiredByDate: dateOnly({ default: null }),

    lifecycleStatus: {
      type: String, enum: Object.values(LIFECYCLE), default: LIFECYCLE.NEW, index: true,
    },
    lifecycleReason: { type: String, trim: true, default: "" },

    /* ── RESPONSIBILITY, NOT AUTHORITY ───────────────────────────────────
       Who answers for this file. A record attribute and a filter — never a
       permission: the access layer deliberately does not read it. */
    responsibleMerchandiser: {
      email: { type: String, trim: true, lowercase: true },
      name: { type: String, trim: true },
      assignedAt: { type: Date },
      assignedBy: actorRef(),
    },

    /* The approved selection in force. Written only by the approval command. */
    currentBomRevisionNo: { type: Number, default: null },

    /* ── SALES RELEASES, MERCHANDISING DOES NOT ──────────────────────────
       Mirrored from Sales' own authorisation. Display-only here; the
       authoritative record is the release event in the audit trail. */
    releasedToRndAt: { type: Date, default: null },
    releasedBy: actorRef(),
    releaseReference: { type: String, trim: true, default: "" },
    /* ── THE REVISION SALES ACTUALLY RELEASED ────────────────────────────
       `currentBomRevisionNo` is the selection in force and it moves on when
       Merchandising approves another. This one does not: it is the revision
       named in the release Sales authorised, and it is what R&D is working
       against. Keeping them apart is the point — read together they say
       "R&D has revision 3, and revision 4 is now approved", which is exactly
       the sentence a later chunk needs in order to call a release stale. */
    releasedBomRevisionNo: { type: Number, default: null },

    coordinationNote: { type: String, trim: true, default: "", maxlength: 4000 },
    archived: { type: Boolean, default: false, index: true },

    revision: { type: Number, default: 0 },
    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_development_files" },
);

/* One file per line. The database, not the handler, is what makes a second
   impossible. */
developmentFileSchema.index(
  { companyId: 1, journeyId: 1, productLineRef: 1 }, { unique: true },
);
/* ── AND ONE NUMBER PER COMPANY ──────────────────────────────────────────
   Replaces a global unique index on `developmentNumber`. A deployed database
   still carries that old index and will keep rejecting the second company's
   first file until it is dropped; `scripts/repair/development-number-scope.js`
   does that, deliberately by hand rather than on boot. */
developmentFileSchema.index(
  { companyId: 1, developmentNumber: 1 }, { unique: true, name: "one_number_per_company" },
);
/* The register's own reads. */
developmentFileSchema.index({ companyId: 1, archived: 1, lifecycleStatus: 1, updatedAt: -1, _id: -1 });
developmentFileSchema.index({ companyId: 1, "responsibleMerchandiser.email": 1, updatedAt: -1 });

developmentFileSchema.statics.LIFECYCLE = LIFECYCLE;

/* ═══ 3. THE VERSIONED MATERIAL SELECTION ══════════════════════════════════ */

const BOM_STATE = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  APPROVED: "APPROVED",
  SUPERSEDED: "SUPERSEDED",
});

/** What kind of thing a row is. Sample packaging is explicitly sample-stage. */
const ROW_CATEGORY = Object.freeze({
  FABRIC: "FABRIC",
  TRIM: "TRIM",
  LABEL: "LABEL",
  ACCESSORY: "ACCESSORY",
  SAMPLE_PACKAGING: "SAMPLE_PACKAGING",
});

/**
 * One selected material.
 *
 * Read the fields and note what is not among them: no quantity, no unit, no
 * allowance, no wastage, no supplier, no rate, no cost, no purchase order, no
 * stock, no receipt, no reservation, no issue quantity, no sample result. Each
 * belongs to a department that is not Merchandising, and a copy here would be
 * a second answer to a question somebody else owns.
 */
const bomRowSchema = new mongoose.Schema(
  {
    /* ── THE ROW'S PERMANENT NAME ────────────────────────────────────────
       Opaque, minted once, and CARRIED when a revision is cloned. That is
       what makes "this label changed at revision 4" a sentence somebody can
       write, and what lets the confirmed order trace a selection back to the
       development row it came from. */
    rowRef: { type: String, trim: true, required: true },

    category: { type: String, enum: Object.values(ROW_CATEGORY), required: true },

    /* ── MATERIAL IDENTITY ───────────────────────────────────────────────
       The catalogue item and its physical variant — the colour/vendor
       combination, not a garment size. Both are references into the item
       master, which Merchandising reads and never writes. */
    rawItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    rawItemName: { type: String, trim: true, default: "", maxlength: 200 },
    rawItemSku: { type: String, trim: true, default: "" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],

    /* What a merchandiser actually specifies about it. */
    colourOrShade: { type: String, trim: true, default: "", maxlength: 120 },
    finish: { type: String, trim: true, default: "", maxlength: 120 },
    placement: { type: String, trim: true, default: "", maxlength: 200 },

    /* Which part of the style this applies to. Empty means the whole style. */
    appliesTo: { type: String, trim: true, default: "", maxlength: 200 },

    selectionNote: { type: String, trim: true, default: "", maxlength: 1000 },

    /* ── WHERE THIS IDENTITY CAME FROM ───────────────────────────────────
       A safe catalogue reference, so a reader can see whether a row was
       chosen fresh, adopted from a registered product's BOM, or carried
       from a legacy selection — and go and look. */
    source: {
      kind: {
        type: String,
        enum: ["MERCHANDISING_SELECTION", "REGISTERED_PRODUCT_BOM", "LEGACY_STYLE_PICK"],
        default: "MERCHANDISING_SELECTION",
      },
      stockItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
      reference: { type: String, trim: true, default: "" },
      observedAt: { type: Date, default: null },
    },
  },
  { _id: false },
);

const bomRevisionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    developmentFileId: {
      type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true,
    },
    revisionNo: { type: Number, min: 1, required: true, immutable: true },
    state: { type: String, enum: Object.values(BOM_STATE), default: BOM_STATE.DRAFT, index: true },

    rows: { type: [bomRowSchema], default: [] },

    /* Where this draft started, so a reader can see it was cloned. */
    clonedFromRevisionNo: { type: Number, default: null },

    submittedBy: actorRef(),
    submittedAt: { type: Date, default: null },
    /* ── MAKER AND CHECKER ───────────────────────────────────────────────
       The approver may not be the author or the submitter, and an owner is
       NOT an exception — the rung that would be exempt is the rung the
       separation exists to constrain. Enforced in the service, recorded
       here. */
    approvedBy: actorRef(),
    approvedAt: { type: Date, default: null },
    changesRequestedBy: actorRef(),
    changesRequestedAt: { type: Date, default: null },
    changeReason: { type: String, trim: true, default: "", maxlength: 2000 },
    /* ── WHICH DEPARTMENT SENT IT BACK ───────────────────────────────────
       Two different refusals wear the same shape and mean different things. A
       MERCHANDISING return is a checker telling a maker the selection is not
       right yet — an internal correction, same revision number, before anyone
       outside has seen it. A SALES return is a department that read the
       approved selection and said it does not answer what the customer asked
       for, which opens a NEW revision and means the previous one is already
       on the record as approved.
       Recorded rather than inferred: a merchandiser reading "sent back" needs
       to know whose question they are answering. */
    changesRequestedSource: {
      type: String, enum: ["MERCHANDISING", "SALES"], default: null,
    },

    supersededByRevisionNo: { type: Number, default: null },
    supersededAt: { type: Date, default: null },

    createdBy: actorRef(),
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_development_bom_revisions" },
);

bomRevisionSchema.index(
  { companyId: 1, developmentFileId: 1, revisionNo: 1 }, { unique: true },
);

/* ── ONE DRAFT, ONE SUBMITTED, ONE APPROVED — ENFORCED BY THE DATABASE ────
   Three partial unique indexes. Two drafts is two answers to one question;
   two approved revisions is two selections both claiming to be in force, and
   R&D would have no way to choose. Superseded revisions accumulate freely. */
bomRevisionSchema.index(
  { companyId: 1, developmentFileId: 1 },
  { unique: true, partialFilterExpression: { state: "DRAFT" }, name: "one_draft_bom" },
);
bomRevisionSchema.index(
  { companyId: 1, developmentFileId: 1 },
  { unique: true, partialFilterExpression: { state: "SUBMITTED" }, name: "one_submitted_bom" },
);
bomRevisionSchema.index(
  { companyId: 1, developmentFileId: 1 },
  { unique: true, partialFilterExpression: { state: "APPROVED" }, name: "one_approved_bom" },
);

/* ── APPROVED MEANS FROZEN ────────────────────────────────────────────────
   The guard, not the convention. R&D engineers consumption against an
   approved selection and Costing prices it; a selection edited underneath
   them would invalidate both without either being told. A change is a new
   revision, and the old one is superseded and kept. */
const FROZEN_AFTER_DRAFT = ["rows", "clonedFromRevisionNo"];

/* ── WHAT THE DATABASE HELD BEFORE THIS SAVE ──────────────────────────────
   The freeze has to be decided on the state the revision was ALREADY in, not
   the state it is moving to, and Mongoose exposes no supported reading of the
   loaded value. So it is remembered when the document arrives from the
   database, and again after every save that persists a new one. `$locals` is
   per-document scratch space and is never written to the collection. */
function rememberPersistedState() {
  this.$locals.persistedBomState = this.state;
}
bomRevisionSchema.post("init", rememberPersistedState);
bomRevisionSchema.post("save", rememberPersistedState);

bomRevisionSchema.pre("save", function freezeApproved(next) {
  if (this.isNew) return next();

  /* ── FROZEN IS DECIDED BY WHERE THE REVISION WAS, NOT WHERE IT IS GOING ──
     An earlier reading of this counted `isModified("state")` as evidence that
     the revision was still a draft, which inverted the guard: a single save
     that changed state could carry new rows past it. APPROVED → SUPERSEDED
     was the live example — the selection R&D engineered and Costing priced
     could be rewritten on the way out, leaving nothing to show it had ever
     said anything else. The same reading also consulted
     `this.$__.originalState`, which Mongoose does not define, so that clause
     was `undefined` on every save and never protected anything.

     A revision is editable only while the DATABASE still holds it as a draft.
     Once it has left that state its rows and its provenance are settled, and
     a change is a new revision. */
  const persisted = this.$locals.persistedBomState;
  const wasEditable = persisted === undefined
    /* Neither loaded nor previously saved through this instance, so there is
       nothing to trust — take the conservative reading. */
    ? this.state === BOM_STATE.DRAFT && !this.isModified("state")
    : persisted === BOM_STATE.DRAFT;
  if (wasEditable) return next();

  const touched = this.modifiedPaths().filter((p) => FROZEN_AFTER_DRAFT.includes(p.split(".")[0]));
  if (touched.length) {
    /* Named for the state it was frozen IN, not the one this save is moving
       it to: "an approved development BOM is frozen" is the fact the reader
       needs, even when the same save is superseding it. */
    const frozenAs = String(persisted || this.state).toLowerCase();
    const err = new Error(
      `A ${frozenAs} development BOM is frozen. ${touched.join(", ")} cannot `
      + "change — start a new revision, so what R&D and Costing worked against stays what it was.",
    );
    err.name = "DevelopmentBomImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  RECEIPT_STATE, CLARIFICATION_CATEGORY, MIN_REASON,
  LIFECYCLE, BOM_STATE, ROW_CATEGORY,
  DevelopmentRequestReceipt: mongoose.models.DevelopmentRequestReceipt
    || mongoose.model("DevelopmentRequestReceipt", receiptSchema),
  DevelopmentFile: mongoose.models.DevelopmentFile
    || mongoose.model("DevelopmentFile", developmentFileSchema),
  DevelopmentBomRevision: mongoose.models.DevelopmentBomRevision
    || mongoose.model("DevelopmentBomRevision", bomRevisionSchema),
};
