// models/CMS_Models/Merchandising/TnaPlan.js
//
// THE EXECUTION FILE'S TIME & ACTION PLAN — and everything dated on it.
//
// One plan per Execution File. It pins the template version and the calendar
// version it was created from, and both are immutable from that moment: this
// is how "existing files retain the template version they started with" is
// enforced structurally rather than by anybody remembering. Publishing a newer
// template changes nothing here. Moving a live file forward is a deliberate,
// audited baseline revision — never a side effect of somebody else's
// configuration change.
//
// ── THREE DATES, AND THEY ARE NOT INTERCHANGEABLE ───────────────────────────
//   baselineDate  what the company committed to. Written once per baseline,
//                 by baseline creation or revision, and by nothing else.
//   forecastDate  what it is currently expected to land on. Moves freely.
//   actualDate    what happened. Written by the owner of the fact.
//
// The single most damaging thing this model could permit is a forecast
// overwriting a baseline, because then "are we late" has no answer. So
// `baselineDate` has exactly two writers and every other command is forbidden
// from touching it — see `tnaPlan.service.js`, where that is enforced, and the
// baseline document itself, which is frozen after saving.
//
// ── AND A MILESTONE'S NAME IS NOT ITS IDENTITY ──────────────────────────────
// `milestoneRef` is built from the milestone CODE and the stable reference of
// whatever it is scoped to — a delivery drop, or M2.1's `unitDiscriminator`.
// Never the label, never the buyer, never a position. A renamed colourway must
// not withdraw a milestone and open a new one, taking its history with it.
"use strict";

const mongoose = require("mongoose");

const {
  dateOnly, actorRef, OWNER_DEPARTMENT, COMPLETION_AUTHORITY,
} = require("./TnaTemplate");

/* ── PLAN LIFECYCLE ────────────────────────────────────────────────────── */

const PLAN_STATE = Object.freeze({
  DRAFT: "DRAFT",
  BASELINED: "BASELINED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  /* Reached only by mirroring the Execution File's own cancellation, exactly
     as the handover receiver mirrors Sales'. Merchandising does not cancel a
     plan on its own: it has nothing to cancel while the commercial
     requirement stands. */
  CANCELLED: "CANCELLED",
});

/** Derived and stored, so the register can index and sort on it. */
const MILESTONE_STATUS = Object.freeze({
  PENDING: "PENDING",
  DUE_SOON: "DUE_SOON",
  OVERDUE: "OVERDUE",
  FORECAST_LATE: "FORECAST_LATE",
  BLOCKED: "BLOCKED",
  COMPLETED: "COMPLETED",
  /* Withdrawn by a baseline revision. Kept, never deleted. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
});

const SCOPE_KIND = Object.freeze({ FILE: "FILE", DELIVERY: "DELIVERY", UNIT: "UNIT" });

const planSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile",
      required: true, index: true, immutable: true,
    },

    /* ── PINNED AT CREATION, FOR EVER ─────────────────────────────────── */
    templateId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    templateVersionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    templateVersionNo: { type: Number, required: true, immutable: true },
    templateName: { type: String, trim: true, default: "" },
    calendarId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    calendarVersionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    calendarVersionNo: { type: Number, required: true, immutable: true },
    calendarName: { type: String, trim: true, default: "" },
    timezone: { type: String, trim: true, default: "Asia/Kolkata" },

    state: {
      type: String, enum: Object.values(PLAN_STATE),
      default: PLAN_STATE.DRAFT, required: true, index: true,
    },
    /* The anchor for PLAN_START milestones. */
    planStartDate: dateOnly({ required: true }),
    currentBaselineNo: { type: Number, default: null },

    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    reopenedAt: { type: Date, default: null },

    revision: { type: Number, default: 0 },
    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_tna_plans" },
);

/* One plan per file. Two would be two answers to one question. */
planSchema.index({ companyId: 1, fileId: 1 }, { unique: true });
planSchema.index({ companyId: 1, state: 1, updatedAt: -1 });

/* ── THE SOURCE-OWNED COMPLETION REFERENCE ─────────────────────────────── */

/**
 * How Merchandising records that another department finished something
 * WITHOUT pretending to be that department.
 *
 * `actor` is null for a source event, deliberately: naming a merchandiser on
 * Quality's inspection result would be a false attribution, and the handover
 * receiver already sets the same precedent with `source: "sales"` and no actor.
 */
const completionSchema = new mongoose.Schema(
  {
    recordedVia: { type: String, enum: ["MERCHANDISING_ENTRY", "SOURCE_EVENT"], required: true },
    sourceApp: { type: String, trim: true, default: "" },
    sourceEventId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceEventKind: { type: String, trim: true, default: "" },
    sourceRecordType: { type: String, trim: true, default: "" },
    sourceRecordRef: { type: String, trim: true, default: "" },
    sourceRecordVersion: { type: Number, default: null },
    /* When the SOURCE says it happened, not when we heard. */
    observedAt: { type: Date, default: null },
    actor: actorRef(),
  },
  { _id: false },
);

const blockedSchema = new mongoose.Schema(
  {
    reasonCode: { type: String, trim: true, required: true },
    note: { type: String, trim: true, default: "", maxlength: 2000 },
    by: actorRef(),
    at: { type: Date, default: null },
  },
  { _id: false },
);

const milestoneSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    planId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    /* Deterministic — see the header. Never random, never positional. */
    milestoneRef: { type: String, trim: true, required: true, immutable: true },
    milestoneCode: { type: String, trim: true, required: true, immutable: true },
    /* Copied at creation. A later template rename does not reach it: this is
       what the plan was built from. */
    name: { type: String, trim: true, required: true },
    ownerDepartment: {
      type: String, enum: Object.values(OWNER_DEPARTMENT), required: true, immutable: true,
    },
    completionAuthority: {
      type: String, enum: Object.values(COMPLETION_AUTHORITY), required: true, immutable: true,
    },
    sourceEventKinds: [{ type: String, trim: true }],

    scopeKind: { type: String, enum: Object.values(SCOPE_KIND), default: SCOPE_KIND.FILE },
    dropRef: { type: String, trim: true, default: "" },
    unitDiscriminator: { type: String, trim: true, default: "" },

    /* Topological rank, recomputed when the graph is ranked. Forecast
       propagation walks in this order, so one pass settles the plan. */
    sequenceRank: { type: Number, default: 0, index: true },

    /* THE THREE DATES. See the header for why they are three. */
    baselineDate: dateOnly({ default: null }),
    forecastDate: dateOnly({ default: null }),
    actualDate: dateOnly({ default: null }),

    status: {
      type: String, enum: Object.values(MILESTONE_STATUS),
      default: MILESTONE_STATUS.PENDING, index: true,
    },
    blocked: { type: blockedSchema, default: null },
    completion: { type: completionSchema, default: null },

    /* ── WHAT A PERSON SAID, KEPT SEPARATELY FROM WHAT THE GRAPH COMPUTES ──
       A merchandiser who states "this will land on the 20th" has made a
       statement, and the next propagation pass must not silently erase it.
       Kept as its own field and applied as a FLOOR: propagation may push the
       forecast later when a predecessor slips past it, and never pulls it
       earlier than what somebody actually said. Cleared when the milestone is
       rescheduled or reopened, which are the moments the statement is
       withdrawn. */
    manualForecastDate: dateOnly({ default: null }),

    lastForecastAt: { type: Date, default: null },
    lastForecastBy: actorRef(),
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_tna_milestones" },
);

milestoneSchema.index({ companyId: 1, planId: 1, milestoneRef: 1 }, { unique: true });
/* The plan's own ordered read. */
milestoneSchema.index({ companyId: 1, planId: 1, sequenceRank: 1 });
/* ── THE PORTFOLIO'S INDEX ────────────────────────────────────────────────
   One row is one milestone across every file, filtered by status and ordered
   by the date somebody is chasing. Compound so the cross-file register is an
   index scan rather than a collection scan at twenty thousand rows. */
milestoneSchema.index({ companyId: 1, status: 1, forecastDate: 1, _id: 1 });
milestoneSchema.index({ companyId: 1, ownerDepartment: 1, status: 1 });
milestoneSchema.index({ companyId: 1, fileId: 1, actualDate: 1 });

/* ── THE IMMUTABLE COMMITMENT ──────────────────────────────────────────── */

const baselineEntrySchema = new mongoose.Schema(
  {
    milestoneRef: { type: String, trim: true, required: true },
    milestoneCode: { type: String, trim: true, required: true },
    baselineDate: dateOnly({ required: true }),
  },
  { _id: false },
);

const baselineSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    planId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    baselineNo: { type: Number, min: 1, required: true, immutable: true },
    state: { type: String, enum: ["ACTIVE", "SUPERSEDED"], default: "ACTIVE", index: true },

    /* What it was computed from — so it can be recomputed and must come out
       identical. That reproducibility is the whole reason versions are
       frozen. */
    templateVersionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    calendarVersionId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    planStartDate: dateOnly({ required: true, immutable: true }),

    entries: { type: [baselineEntrySchema], default: [], immutable: true },

    approvedBy: actorRef(),
    approvedAt: { type: Date, default: null },
    supersededByBaselineNo: { type: Number, default: null },
    supersededAt: { type: Date, default: null },

    /* Required from baseline 2 onward: a commitment does not move without a
       recorded reason. */
    revisionReason: {
      reasonCode: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "", maxlength: 2000 },
      rescheduleRef: { type: String, trim: true, default: "" },
    },
  },
  { timestamps: true, collection: "merchandising_tna_baselines" },
);

baselineSchema.index({ companyId: 1, planId: 1, baselineNo: 1 }, { unique: true });
/* At most one live commitment per plan — the database decides, so two
   concurrent approvals cannot both produce one. */
baselineSchema.index(
  { companyId: 1, planId: 1 },
  { unique: true, partialFilterExpression: { state: "ACTIVE" }, name: "one_active_baseline" },
);

/** A saved baseline is frozen except for its standing. */
const BASELINE_MUTABLE = new Set([
  "state", "supersededByBaselineNo", "supersededAt", "updatedAt", "__v",
]);

baselineSchema.pre("save", function freezeBaseline(next) {
  if (this.isNew) return next();
  const touched = this.modifiedPaths().filter((p) => !BASELINE_MUTABLE.has(p.split(".")[0]));
  if (touched.length) {
    const err = new Error(
      `A baseline is what the company committed to. ${touched.join(", ")} cannot change — revise the baseline instead.`,
    );
    err.name = "TnaBaselineImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

/* ── THE AUDITED MOVE ──────────────────────────────────────────────────── */

const rescheduleSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    planId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    rescheduleRef: { type: String, trim: true, required: true, immutable: true },

    state: {
      type: String, enum: ["PREVIEWED", "APPROVED", "REJECTED", "WITHDRAWN"],
      default: "PREVIEWED", index: true,
    },
    scope: { type: String, enum: ["MILESTONE", "PLAN"], default: "MILESTONE" },
    milestoneRef: { type: String, trim: true, default: "" },

    reasonCode: { type: String, trim: true, required: true },
    /* Long enough to be a reason rather than a shrug — the same rule the
       M2 clarification request follows. */
    reasonNote: { type: String, trim: true, required: true, maxlength: 2000 },
    proposedDate: dateOnly({ required: true }),

    /* ── WHAT THE REQUESTER WAS SHOWN ─────────────────────────────────
       Frozen at request time. An approver approves the impact they were
       shown, not a recomputation — if the plan moved underneath, approval is
       refused and the requester previews again. */
    impact: {
      affected: [
        new mongoose.Schema(
          {
            milestoneRef: { type: String, trim: true },
            milestoneCode: { type: String, trim: true },
            name: { type: String, trim: true },
            beforeForecast: dateOnly({ default: null }),
            afterForecast: dateOnly({ default: null }),
            baselineDate: dateOnly({ default: null }),
            daysMoved: { type: Number, default: 0 },
          },
          { _id: false },
        ),
      ],
      breachesCommittedDelivery: { type: Boolean, default: false },
      committedDeliveryDates: [dateOnly()],
      deliveryDaysLate: { type: Number, default: 0 },
      /* The plan revision the preview was computed against. */
      planRevision: { type: Number, default: 0 },
      milestoneRevisions: { type: mongoose.Schema.Types.Mixed, default: undefined },
    },
    createsBaselineRevision: { type: Boolean, default: false },

    requestedBy: actorRef(),
    requestedAt: { type: Date, default: null },
    decidedBy: actorRef(),
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true, collection: "merchandising_tna_reschedules" },
);

rescheduleSchema.index({ companyId: 1, planId: 1, rescheduleRef: 1 }, { unique: true });
rescheduleSchema.index({ companyId: 1, planId: 1, state: 1, createdAt: -1 });

/* ── APPROVED REASONS ──────────────────────────────────────────────────── */

const reasonCodeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    code: { type: String, trim: true, required: true, uppercase: true },
    label: { type: String, trim: true, required: true, maxlength: 160 },
    kind: { type: String, enum: ["BLOCK", "RESCHEDULE"], required: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "merchandising_tna_reason_codes" },
);

reasonCodeSchema.index({ companyId: 1, code: 1, kind: 1 }, { unique: true });

module.exports = {
  PLAN_STATE, MILESTONE_STATUS, SCOPE_KIND, BASELINE_MUTABLE,
  TnaPlan: mongoose.models.TnaPlan || mongoose.model("TnaPlan", planSchema),
  TnaMilestone: mongoose.models.TnaMilestone || mongoose.model("TnaMilestone", milestoneSchema),
  TnaBaseline: mongoose.models.TnaBaseline || mongoose.model("TnaBaseline", baselineSchema),
  TnaReschedule: mongoose.models.TnaReschedule || mongoose.model("TnaReschedule", rescheduleSchema),
  TnaReasonCode: mongoose.models.TnaReasonCode || mongoose.model("TnaReasonCode", reasonCodeSchema),
};
