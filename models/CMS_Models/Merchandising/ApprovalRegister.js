// models/CMS_Models/Merchandising/ApprovalRegister.js
//
// WHAT THIS EXECUTION FILE IS WAITING TO BE APPROVED, AND BY WHOM.
//
// One register per Execution File. Each row is one approval this order needs
// before it can be made: an internal Merchandising selection, a buyer decision
// Sales owns, a technical or sample decision Product Development owns, a test
// or inspection Quality owns.
//
// ── THIS REGISTER RECORDS REQUIREMENTS, NEVER DECISIONS ─────────────────────
// That distinction is the whole design. Merchandising is entitled to say "this
// order needs the buyer to approve the strike-off, by the 14th, for the navy
// colourway". It is not entitled to say the buyer approved it. So a row stores:
//
//   · the REQUIREMENT — category, owner, applicability, required-by date;
//   · a REFERENCE to the record that will carry the decision;
//   · an OBSERVATION of what that record last said, and when it was read.
//
// The observation is explicitly a reading, not a result. It carries the time it
// was taken and whether the source could be reached at all, because "approved"
// and "we have not been able to look since Tuesday" are different facts and a
// register that showed them the same way would be worse than one that showed
// nothing.
//
// ── AND THERE IS NO CONTROL THAT COMPLETES SOMEBODY ELSE'S APPROVAL ─────────
// Not on the screen, and not in the model: an external row has no field a
// Merchandising command may write into `observation`. The service that fills it
// reads the source. Where no source producer exists yet — which is true of
// every external class in M4 — the row reads `AWAITING_SOURCE_RECORD`, which is
// the truthful answer and is deliberately not a synonym for "outstanding".
//
// Merchandising's OWN approvals are different, and are the only ones this
// register can settle by itself: they resolve from the M3/M4 revision records,
// which Merchandising does own.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** Who owns the decision a row is waiting for. */
const APPROVAL_OWNER = Object.freeze({
  MERCHANDISING: "MERCHANDISING",
  SALES: "SALES",
  PRODUCT_DEVELOPMENT: "PRODUCT_DEVELOPMENT",
  QUALITY: "QUALITY",
});

/**
 * The kinds of approval an order waits on, with the application that owns
 * each. Stable codes; the display label is separate and may be re-worded
 * without orphaning a single row.
 */
const APPROVAL_CATEGORY = Object.freeze({
  /* Merchandising's own, resolved from its own revision records. */
  MATERIAL_TRIM_CARD: { owner: APPROVAL_OWNER.MERCHANDISING, label: "Trim card approved" },
  PACKAGING_SPEC: { owner: APPROVAL_OWNER.MERCHANDISING, label: "Packaging specification approved" },
  DEVELOPMENT_SCHEDULE: { owner: APPROVAL_OWNER.MERCHANDISING, label: "Development requirements approved" },
  /* Sales owns every buyer-facing decision. */
  BUYER_STYLE_APPROVAL: { owner: APPROVAL_OWNER.SALES, label: "Buyer approved the style" },
  BUYER_SAMPLE_APPROVAL: { owner: APPROVAL_OWNER.SALES, label: "Buyer approved the sample" },
  BUYER_PRINT_STRIKE_OFF: { owner: APPROVAL_OWNER.SALES, label: "Buyer approved the strike-off" },
  BUYER_LAB_DIP: { owner: APPROVAL_OWNER.SALES, label: "Buyer approved the lab dip" },
  /* Product Development owns the technical and sample decisions. */
  TECH_PACK_RELEASED: { owner: APPROVAL_OWNER.PRODUCT_DEVELOPMENT, label: "Tech pack released" },
  FIT_SAMPLE_APPROVED: { owner: APPROVAL_OWNER.PRODUCT_DEVELOPMENT, label: "Fit sample approved" },
  PP_SAMPLE_APPROVED: { owner: APPROVAL_OWNER.PRODUCT_DEVELOPMENT, label: "Pre-production sample approved" },
  /* Quality owns testing, inspection, hold and release. */
  FABRIC_TEST_PASSED: { owner: APPROVAL_OWNER.QUALITY, label: "Fabric test passed" },
  GARMENT_TEST_PASSED: { owner: APPROVAL_OWNER.QUALITY, label: "Garment test passed" },
  INLINE_INSPECTION_CLEARED: { owner: APPROVAL_OWNER.QUALITY, label: "Inline inspection cleared" },
  FINAL_INSPECTION_CLEARED: { owner: APPROVAL_OWNER.QUALITY, label: "Final inspection cleared" },
});

/**
 * What an observation may say.
 *
 * `AWAITING_SOURCE_RECORD` is not a synonym for outstanding. It means nobody
 * has built the producer that would answer this question yet, so the register
 * cannot know — and saying "outstanding" would imply somebody is working on it.
 * `UNAVAILABLE` means the source exists and could not be read this time, which
 * is a different problem with a different fix.
 */
const OBSERVED_STATUS = Object.freeze({
  AWAITING_SOURCE_RECORD: "AWAITING_SOURCE_RECORD",
  NOT_STARTED: "NOT_STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  UNAVAILABLE: "UNAVAILABLE",
});

const approvalRowSchema = new mongoose.Schema(
  {
    /* This requirement's permanent, opaque name. */
    approvalRequirementRef: { type: String, trim: true, required: true },
    category: { type: String, enum: Object.keys(APPROVAL_CATEGORY), required: true },
    /* Denormalised from the category so a row can be read without the map,
       and so a category later re-owned does not silently re-own old rows. */
    owningApplication: { type: String, enum: Object.values(APPROVAL_OWNER), required: true },

    appliesToAllUnits: { type: Boolean, default: true },
    unitRefs: [{ type: String, trim: true }],
    requiredByDate: { type: Date, default: null },
    note: { type: String, trim: true, default: "", maxlength: 2000 },

    /* WHERE the decision will be recorded. Identity and version only. */
    sourceRef: {
      app: { type: String, trim: true, default: "" },
      recordType: { type: String, trim: true, default: "" },
      recordId: { type: mongoose.Schema.Types.ObjectId, default: null },
      recordRef: { type: String, trim: true, default: "" },
      sourceVersion: { type: String, trim: true, default: "" },
    },

    /* ── WHAT THE SOURCE LAST SAID, AND WHEN WE LOOKED ─────────────────
       Never written by a Merchandising command on an externally-owned row:
       the observer fills it by reading the source. `observedAt` is when the
       reading was taken, which is what makes a stale one detectable. */
    observation: {
      status: {
        type: String, enum: Object.values(OBSERVED_STATUS),
        default: OBSERVED_STATUS.AWAITING_SOURCE_RECORD,
      },
      decidedByName: { type: String, trim: true, default: "" },
      decidedAt: { type: Date, default: null },
      observedAt: { type: Date, default: null },
      /* Why the register cannot say more than it does. */
      reason: { type: String, trim: true, default: "", maxlength: 500 },
      sourceVersion: { type: String, trim: true, default: "" },
    },

    createdBy: actorRef(),
    createdAt: { type: Date, default: Date.now },
    updatedBy: actorRef(),
  },
  { _id: false },
);

const approvalRegisterSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile",
      required: true, index: true, immutable: true, unique: true,
    },
    rows: { type: [approvalRowSchema], default: [] },
    /* Optimistic concurrency, as everywhere else Merchandising writes. */
    revision: { type: Number, default: 0 },
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_approval_registers" },
);

/* One register per file. Two would be two answers to one question. */
approvalRegisterSchema.index({ companyId: 1, fileId: 1 }, { unique: true });

module.exports = {
  APPROVAL_OWNER, APPROVAL_CATEGORY, OBSERVED_STATUS,
  ApprovalRegister: mongoose.models.MerchandisingApprovalRegister
    || mongoose.model("MerchandisingApprovalRegister", approvalRegisterSchema),
};
