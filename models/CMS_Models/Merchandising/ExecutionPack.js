// models/CMS_Models/Merchandising/ExecutionPack.js
//
// WHAT MERCHANDISING HANDED DOWNSTREAM, EXACTLY, AND FOR EVER.
//
// A pack version is Merchandising's statement that its own work on one order
// is complete, expressed as a list of REFERENCES to the approved records that
// make it so. PPC receives one version. Six weeks later, when something is
// wrong on the floor, "what were you actually given" has to have one answer.
//
// ── REFERENCES, NOT COPIES ──────────────────────────────────────────────────
// Every entry is an id plus the version it pointed at. The pack does not carry
// the trim card's rows, the packing instructions or the milestone list — those
// records already exist, are already versioned, and are already immutable once
// approved. Copying them would create a second copy that could disagree with
// the first, and the day they disagreed nobody could say which was handed over.
//
// What IS copied is the small proof: version numbers, approval times, and a
// forecast SNAPSHOT with an `asOf`. That is enough to prove what was sent
// without duplicating what was sent.
//
// ── IMMUTABLE AFTER SUBMISSION ──────────────────────────────────────────────
// Once `state` leaves DRAFT, `contents`, `completeness` and `declaration` are
// frozen by a pre-save guard. A change is a NEW VERSION superseding the old,
// and the old is kept. Same discipline as an M3 revision and an M5 baseline,
// for the same reason: a record somebody acted on cannot be edited underneath
// them afterwards.
//
// ── THE COMPLETENESS RESULT IS FROZEN TOO ───────────────────────────────────
// `completeness` records what was true at submission, not what is true now.
// Re-evaluating it on read would mean a pack submitted correctly in March
// could start displaying as incomplete in June because a later revision
// superseded one of its references — which would be telling somebody the
// handover was wrong when it was right.
//
// ── AND THERE IS NO GATE ON ANOTHER DEPARTMENT ──────────────────────────────
// Every completeness gate is a Merchandising-owned fact. Gating this
// submission on Store stock or PPC capacity would make Merchandising the judge
// of those departments' work — the exact inversion the plan forbids. Source
// department status travels beside the pack as CONTEXT and is never counted.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Where a pack version can be. See the module header for what each means. */
const PACK_STATE = Object.freeze({
  DRAFT: "DRAFT",
  SUBMITTED: "SUBMITTED",
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  SUPERSEDED: "SUPERSEDED",
  WITHDRAWN: "WITHDRAWN",
  CANCELLED: "CANCELLED",
});

/**
 * The gates, as an ordered list.
 *
 * Every one is a fact Merchandising itself owns and can act on. Read the list
 * and there is nothing on it about stock, suppliers, capacity, planning or
 * test results — that absence is a designed property, and a test asserts it.
 */
const GATE = Object.freeze({
  HANDOVER_ACCEPTED: "HANDOVER_ACCEPTED",
  MATERIAL_TRIM_APPROVED: "MATERIAL_TRIM_APPROVED",
  PACKAGING_APPROVED: "PACKAGING_APPROVED",
  DEVELOPMENT_APPROVED: "DEVELOPMENT_APPROVED",
  APPROVALS_SETTLED: "APPROVALS_SETTLED",
  TNA_BASELINED: "TNA_BASELINED",
  UNITS_RECONCILE: "UNITS_RECONCILE",
});

const GATE_ORDER = Object.freeze(Object.values(GATE));

/* ── THE CONTENTS ─────────────────────────────────────────────────────────
   Declared field by field rather than as `Mixed`. An unexpected key cannot
   persist and cannot escape, which is the same tightening M2.1 made to the
   execution projection after `Mixed` let one through. */

const referenceSchema = (extra = {}) => new mongoose.Schema(
  { ...extra }, { _id: false },
);

const contentsSchema = new mongoose.Schema(
  {
    salesHandover: {
      versionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      versionNo: { type: Number, default: null },
      handoverRef: { type: String, trim: true, default: "" },
      handoverLineRef: { type: String, trim: true, default: "" },
      acceptedAt: { type: Date, default: null },
    },
    materialTrim: {
      revisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      revisionNo: { type: Number, default: null },
      approvedAt: { type: Date, default: null },
      approvedByName: { type: String, trim: true, default: "" },
    },
    packaging: {
      revisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      revisionNo: { type: Number, default: null },
      approvedAt: { type: Date, default: null },
      approvedByName: { type: String, trim: true, default: "" },
    },
    developmentRequirements: {
      revisionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      revisionNo: { type: Number, default: null },
      approvedAt: { type: Date, default: null },
      approvedByName: { type: String, trim: true, default: "" },
    },
    /* M4's register position — the count and each entry's state, not the
       requirement text. */
    approvalRegister: {
      position: { type: String, enum: ["COMPLETE", "OUTSTANDING"], default: "OUTSTANDING" },
      outstandingCount: { type: Number, default: 0 },
      entries: [new mongoose.Schema({
        approvalRef: { type: String, trim: true, default: "" },
        category: { type: String, trim: true, default: "" },
        owningApplication: { type: String, trim: true, default: "" },
        state: { type: String, trim: true, default: "" },
        decidedAt: { type: Date, default: null },
      }, { _id: false })],
    },
    timeAndAction: {
      planId: { type: mongoose.Schema.Types.ObjectId, default: null },
      baselineNo: { type: Number, default: null },
      baselineApprovedAt: { type: Date, default: null },
      templateVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
      templateVersionNo: { type: Number, default: null },
      calendarVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    /* ── A SNAPSHOT, AND LABELLED AS ONE ──────────────────────────────────
       The forecast at the moment of submission. `asOf` is required precisely
       so nobody reads it as a live figure or as a promise — the plan moves
       after a pack is sent, and this is what it looked like when it went. */
    forecastPosition: {
      asOf: { type: Date, default: null },
      milestonesTotal: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      overdue: { type: Number, default: 0 },
      forecastLate: { type: Number, default: 0 },
      deliveryAtRisk: { type: Boolean, default: false },
    },
    executionUnits: [new mongoose.Schema({
      unitDiscriminator: { type: String, trim: true, default: "" },
      quantity: { type: Number, default: 0 },
      dropRef: { type: String, trim: true, default: "" },
      committedDeliveryDate: { type: Date, default: null },
      active: { type: Boolean, default: true },
    }, { _id: false })],
  },
  { _id: false },
);

const completenessSchema = new mongoose.Schema(
  {
    gates: [new mongoose.Schema({
      key: { type: String, enum: GATE_ORDER, required: true },
      passed: { type: Boolean, required: true },
      /* The sentence a person can act on, and which tab fixes it. */
      detail: { type: String, trim: true, default: "", maxlength: 500 },
    }, { _id: false })],
    allPassed: { type: Boolean, default: false },
    evaluatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const packSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    packVersionNo: { type: Number, min: 1, required: true, immutable: true },

    state: { type: String, enum: Object.values(PACK_STATE), default: PACK_STATE.DRAFT, index: true },

    contents: { type: contentsSchema, default: () => ({}) },
    completeness: { type: completenessSchema, default: () => ({}) },

    /* ── THE DECLARATION ──────────────────────────────────────────────────
       One explicit statement, with the person who made it and when. Required
       for submission — a pack sent without somebody saying "this is complete"
       would be a system asserting completeness on a person's behalf. */
    declaration: {
      statement: { type: String, trim: true, default: "", maxlength: 2000 },
      byActor: actorRef(),
      at: { type: Date, default: null },
    },

    submittedBy: actorRef(),
    submittedAt: { type: Date, default: null },

    supersedesPackVersionNo: { type: Number, default: null },
    supersededByPackVersionNo: { type: Number, default: null },
    supersededAt: { type: Date, default: null },

    withdrawnBy: actorRef(),
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, trim: true, default: "", maxlength: 2000 },

    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, default: "", maxlength: 2000 },

    createdBy: actorRef(),
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_execution_packs" },
);

packSchema.index({ companyId: 1, fileId: 1, packVersionNo: 1 }, { unique: true });

/* ── ONE DRAFT AND ONE SUBMITTED, PER FILE, ENFORCED BY THE DATABASE ──────
   Two people assembling two drafts of the same handover is the state that
   produces two different packs both claiming to be the one. Two concurrent
   submissions is the same problem at the moment it matters most. Both are
   partial unique indexes, so every superseded and accepted version
   accumulates freely beside the one in force. */
packSchema.index(
  { companyId: 1, fileId: 1 },
  { unique: true, partialFilterExpression: { state: "DRAFT" }, name: "one_draft_pack_per_file" },
);
packSchema.index(
  { companyId: 1, fileId: 1 },
  { unique: true, partialFilterExpression: { state: "SUBMITTED" }, name: "one_submitted_pack_per_file" },
);

/* The version list, newest first. */
packSchema.index({ companyId: 1, fileId: 1, packVersionNo: -1 });

/* ── FROZEN THE MOMENT IT IS SENT ─────────────────────────────────────────
   The guard, not the convention. Every service in this module goes through
   `.save()`, so refusing here refuses everywhere — including a future writer
   nobody has reviewed. */
const FROZEN_AFTER_DRAFT = ["contents", "completeness", "declaration"];

packSchema.pre("save", function freezeSubmitted(next) {
  if (this.isNew) return next();

  /* Was this document ALREADY out of draft before this save began? The
     transition itself — the submit, which writes the frozen fields and moves
     the state in one save — is legitimate; a later edit is not. Same test the
     template version's guard uses, for the same distinction. */
  const wasDraft = this.$__.originalState?.state === PACK_STATE.DRAFT
    || (this.state === PACK_STATE.DRAFT && !this.isModified("state"))
    || this.isModified("state");
  if (wasDraft) return next();

  const touched = this.modifiedPaths().filter(
    (path) => FROZEN_AFTER_DRAFT.includes(path.split(".")[0]),
  );
  if (touched.length) {
    const err = new Error(
      `A ${this.state.toLowerCase()} execution pack is frozen. ${touched.join(", ")} cannot change — `
      + "submit a new version instead, so the one that was sent stays exactly as it was sent.",
    );
    err.name = "ExecutionPackImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  PACK_STATE, GATE, GATE_ORDER,
  ExecutionPack: mongoose.models.ExecutionPack || mongoose.model("ExecutionPack", packSchema),
};
