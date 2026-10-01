// models/CMS_Models/Merchandising/ChangeControl.js
//
// WHAT A SALES CHANGE DOES TO MERCHANDISING'S EXECUTION. THREE RECORDS.
//
//   ChangeIntakeReceipt   Merchandising's answer to the notice — acknowledged,
//                         or a clarification asked of Sales.
//   ChangeImpact          the internal execution impact: which units, which
//                         areas, which NEW revisions the change produced.
//   ChangeAcknowledgement each affected application's own answer, projected.
//
// ── THE IMPACT RECORDS REVISIONS, IT DOES NOT CONTAIN THEM ──────────────────
// Every sub-impact holds the NUMBER of the new revision the change produced —
// `materialTrimImpact.newRevisionNo`, `tnaImpact.baselineRevisionNo`. The
// revisions themselves live where they always did, created by the services
// that own them, and the previous ones are superseded and kept. Nothing here
// edits an approved revision, a baseline, or a submitted pack: those records
// carry their own immutability guards, and this model is deliberately unable
// to reach past them.
//
// ── AND AN ACKNOWLEDGEMENT IS NOT READINESS ─────────────────────────────────
// `ACCEPTED` means an application has seen the change and says it applies to
// them. It does not mean they have done anything about it, and the register
// never renders it as completion. `REJECTED_AS_INVALID` is narrower still: the
// receiver can show the change does not apply to them. That is a statement
// about applicability, not a veto — no receiver can refuse a commercially
// authorised change, any more than Merchandising can refuse a handover.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* ═══ 1. MERCHANDISING'S ANSWER TO SALES ═══════════════════════════════════ */

/**
 * `PENDING` is computed, not stored — a notice with no receipt is pending, the
 * same rule `HandoverReceipt` and M6's PPC receipt both follow. There is no
 * `REJECTED`: Merchandising cannot refuse a commercially authorised change; it
 * asks Sales for clarification.
 */
const INTAKE_STATE = Object.freeze({
  ACKNOWLEDGED: "ACKNOWLEDGED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED_BY_SALES: "CANCELLED_BY_SALES",
});

const CLARIFICATION_CATEGORY = Object.freeze([
  "EXECUTION_IMPACT_UNCLEAR",
  "DATE_NOT_ACHIEVABLE",
  "QUANTITY_OR_SPLIT_UNCLEAR",
  "REQUIREMENT_CONFLICTS_WITH_APPROVED_RECORD",
  "OTHER",
]);

const MIN_REASON = 15;

const intakeReceiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    changeRef: { type: String, trim: true, required: true, immutable: true },
    changeVersionNo: { type: Number, required: true, immutable: true },
    noticeId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    state: { type: String, enum: Object.values(INTAKE_STATE), required: true },
    clarification: {
      category: { type: String, enum: CLARIFICATION_CATEGORY, default: undefined },
      reason: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    decidedBy: actorRef(),
    decidedAt: { type: Date, default: null },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_change_intake_receipts" },
);

/* One answer per notice version. The database, not the handler, is what makes
   a duplicate acknowledgement impossible. */
intakeReceiptSchema.index({ companyId: 1, noticeId: 1 }, { unique: true });
intakeReceiptSchema.index({ companyId: 1, fileId: 1, changeRef: 1, changeVersionNo: -1 });

/* ═══ 2. THE INTERNAL EXECUTION IMPACT ═════════════════════════════════════ */

const IMPACT_STATE = Object.freeze({
  DRAFT: "DRAFT",
  ASSESSED: "ASSESSED",
  COORDINATED: "COORDINATED",
  CLOSED: "CLOSED",
});

/**
 * What the merchandiser decided to do about it.
 *
 * `ABSORB` — the change costs nothing internally; nothing is revised.
 * `REVISE` — Merchandising's own records must change, and the impact records
 *            which new revisions were produced.
 * `ESCALATE_TO_SALES` — the change cannot be executed as stated, and Sales is
 *            asked. Note this is an escalation, not a refusal: the decision
 *            goes back to the department that owns it.
 */
const IMPACT_DECISION = Object.freeze({
  ABSORB: "ABSORB",
  REVISE: "REVISE",
  ESCALATE_TO_SALES: "ESCALATE_TO_SALES",
});

/** The applications a coordinated change is announced to. */
const AFFECTED_APPLICATION = Object.freeze({
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  SUPPLY_CHAIN: "SUPPLY_CHAIN",
  STORE: "STORE",
  IE: "IE",
  PPC: "PPC",
  QUALITY: "QUALITY",
  PRODUCTION: "PRODUCTION",
  LOGISTICS: "LOGISTICS",
});

/** One area's impact: whether it moved, and the NEW revision if it did. */
const areaImpact = () => ({
  impacted: { type: Boolean, default: false },
  /* The revision the change PRODUCED. Never the one it replaced — that stays
     readable in its own collection. */
  newRevisionNo: { type: Number, default: null },
  note: { type: String, trim: true, default: "", maxlength: 1000 },
});

const impactSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    changeRef: { type: String, trim: true, required: true, immutable: true },
    changeVersionNo: { type: Number, required: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    impactRef: { type: String, trim: true, required: true, immutable: true },

    state: { type: String, enum: Object.values(IMPACT_STATE), default: IMPACT_STATE.DRAFT, index: true },

    /* Which execution units this change reaches, by M2.1's discriminator. An
       empty list means the whole line. */
    affectedUnits: [{ type: String, trim: true }],

    materialTrimImpact: areaImpact(),
    packagingImpact: areaImpact(),
    developmentImpact: areaImpact(),
    approvalImpact: {
      reopenedApprovalRefs: [{ type: String, trim: true }],
      note: { type: String, trim: true, default: "", maxlength: 1000 },
    },
    /* ── M5's OWN COMMANDS PRODUCE THESE ──────────────────────────────────
       `baselineRevisionNo` is the NEW baseline number M5 wrote. This model
       cannot and does not write a baseline date. */
    tnaImpact: {
      impacted: { type: Boolean, default: false },
      baselineRevisionNo: { type: Number, default: null },
      milestonesMoved: { type: Number, default: 0 },
      deliveryAtRisk: { type: Boolean, default: false },
      note: { type: String, trim: true, default: "", maxlength: 1000 },
    },
    /* ── M6's ────────────────────────────────────────────────────────────── */
    downstreamImpact: {
      impacted: { type: Boolean, default: false },
      packSupersededVersionNo: { type: Number, default: null },
      resubmissionRequired: { type: Boolean, default: false },
      note: { type: String, trim: true, default: "", maxlength: 1000 },
    },

    affectedApplications: [{ type: String, enum: Object.values(AFFECTED_APPLICATION) }],

    coordinationReason: {
      reasonCode: { type: String, trim: true, default: "" },
      note: { type: String, trim: true, default: "", maxlength: 2000 },
    },
    decision: { type: String, enum: Object.values(IMPACT_DECISION), default: null },

    assessedBy: actorRef(),
    assessedAt: { type: Date, default: null },
    coordinatedBy: actorRef(),
    coordinatedAt: { type: Date, default: null },
    closedBy: actorRef(),
    closedAt: { type: Date, default: null },

    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "merchandising_change_impacts" },
);

/* One impact per (change version, file). A second would be a second answer to
   the same question. */
impactSchema.index({ companyId: 1, changeRef: 1, changeVersionNo: 1, fileId: 1 }, { unique: true });
impactSchema.index({ companyId: 1, changeRef: 1, changeVersionNo: 1 });
/* The portfolio's own read: everything not yet closed, newest first. */
impactSchema.index({ companyId: 1, state: 1, updatedAt: -1, _id: -1 });
impactSchema.index({ companyId: 1, fileId: 1, updatedAt: -1 });

/* ═══ 3. EACH APPLICATION'S OWN ANSWER ═════════════════════════════════════ */

/**
 * `REJECTED_AS_INVALID` is here and nowhere else in this codebase.
 *
 * Sales' handover receipt has no reject; PPC's pack receipt has no reject.
 * This one does, for a single narrow case: a receiver can demonstrate the
 * change does not apply to it — a fabric change announced to Logistics, say.
 * That is a statement about APPLICABILITY, and it needs a reason. It is not a
 * veto of the commercial change, which no receiver has and none can acquire.
 */
const ACK_STATE = Object.freeze({
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  REJECTED_AS_INVALID: "REJECTED_AS_INVALID",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED: "CANCELLED",
});

const acknowledgementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    changeRef: { type: String, trim: true, required: true, immutable: true },
    /* WHICH VERSION was acknowledged. The whole of staleness rests on this:
       an acknowledgement of version 1 is not coverage of version 2, and the
       register shows it as STALE rather than counting it. */
    changeVersionNo: { type: Number, required: true, immutable: true },
    application: {
      type: String, enum: Object.values(AFFECTED_APPLICATION), required: true, immutable: true,
    },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    state: { type: String, enum: Object.values(ACK_STATE), required: true },
    reason: { type: String, trim: true, default: "", maxlength: 2000 },

    /* The receiver's own actor. Merchandising never writes one. */
    acknowledgedBy: actorRef(),
    acknowledgedAt: { type: Date, default: null },
    sourceEventId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, collection: "merchandising_change_acknowledgements" },
);

/* One answer per application per change version — a redelivery cannot mint a
   second, and a later version legitimately can. */
acknowledgementSchema.index(
  { companyId: 1, changeRef: 1, changeVersionNo: 1, application: 1 }, { unique: true },
);
acknowledgementSchema.index({ companyId: 1, fileId: 1, changeRef: 1 });

module.exports = {
  INTAKE_STATE, CLARIFICATION_CATEGORY, MIN_REASON,
  IMPACT_STATE, IMPACT_DECISION, AFFECTED_APPLICATION, ACK_STATE,
  ChangeIntakeReceipt: mongoose.models.ChangeIntakeReceipt
    || mongoose.model("ChangeIntakeReceipt", intakeReceiptSchema),
  ChangeImpact: mongoose.models.ChangeImpact || mongoose.model("ChangeImpact", impactSchema),
  ChangeAcknowledgement: mongoose.models.ChangeAcknowledgement
    || mongoose.model("ChangeAcknowledgement", acknowledgementSchema),
};
