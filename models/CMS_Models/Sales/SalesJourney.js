// models/CMS_Models/Sales/SalesJourney.js
//
// SalesJourney — ONE connected commercial lifecycle for one customer
// requirement, from Account through Retention.
//
// WHAT THIS RECORD IS NOT, stated first because every field below depends on it:
//
//   • NOT a customer master. The customer is `accountId` → CRMAccount. No
//     company name, address, role or tier is copied here. A Journey that stored
//     the customer's name would be a second, silently diverging account book.
//   • NOT a contact store. `primaryContactId` → CRMContact. No embedded person.
//   • NOT a task system. The current next action is `currentNextActionId` →
//     CRMActivity, a pointer to the ONE timeline every other CRM screen already
//     reads. There is deliberately no embedded subject/owner/dueDate here to
//     drift away from the Activity that owns them.
//   • NOT an Order. A Journey may exist with no Order at all, and continues to
//     exist after one is placed. Order lives in its own module, later.
//   • NOT a container for later-stage data. Creating a Journey creates nothing
//     else — no Enquiry, Style, Quotation, Order, Shipment or Claim.
//
// Every commercial counterparty (buying house, brand, PO issuer, bill-to,
// consignee, importer, agent) is another CRMAccount reference for the same
// reason: an organization is an organization, and it belongs in one table.
//
// The lifecycle vocabulary comes from constants/crm.js, which mirrors the
// frontend's stageConfig.js — see the note there before renaming anything.

const mongoose = require("mongoose");
const {
  SALES_JOURNEY_STAGE_CODES,
  SALES_JOURNEY_STAGE_STATE_CODES,
  SALES_JOURNEY_RISK_CODES,
  SALES_JOURNEY_BUSINESS_TYPE_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const accountRef = () => ({ type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" });

/**
 * One state per lifecycle stage, built FROM the stage list rather than typed
 * out, so a stage added to constants/crm.js cannot be silently missing here.
 * `account` opens `inProgress`: a Journey has a customer the moment it exists,
 * but the Account stage is not complete merely because one was selected — the
 * real readiness view decides that.
 */
const stageStatesSchema = new mongoose.Schema(
  Object.fromEntries(
    SALES_JOURNEY_STAGE_CODES.map((code) => [
      code,
      {
        type: String,
        enum: SALES_JOURNEY_STAGE_STATE_CODES,
        default: code === "account" ? "inProgress" : "notStarted",
      },
    ]),
  ),
  { _id: false },
);

const salesJourneySchema = new mongoose.Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    // The human reference is the ROUTE key, not the Mongo id — a salesperson
    // reads SJ-2026-0001 in a breadcrumb, never an ObjectId. Allocated by
    // services/salesJourneyRef.js under an atomic counter; `immutable` because
    // rewriting it would break every link and audit row that names it.
    journeyId: { type: String, required: true, unique: true, immutable: true, trim: true },

    name: { type: String, required: true, trim: true },
    accountId: { ...accountRef(), required: true, index: true },
    businessType: { type: String, enum: SALES_JOURNEY_BUSINESS_TYPE_CODES, required: true },

    // Optional external orientation only — an RFQ number the customer used.
    // This does NOT create or imply an Enquiry record; that module does not
    // exist yet and this field must not be mistaken for it.
    requirementRef: { type: String, trim: true },

    // ── Referenced commercial parties ───────────────────────────────────────
    // Every one an Account. No fallback name strings: an unresolvable party is
    // a data problem to fix, not a string to render.
    parties: {
      buyingHouseAccountId: accountRef(),
      brandAccountId: accountRef(),
      poIssuerAccountId: accountRef(),
      billToAccountId: accountRef(),
      consigneeAccountId: accountRef(),
      importerAccountId: accountRef(),
      agentAccountId: accountRef(),
    },

    // ── Contact and ownership ───────────────────────────────────────────────
    primaryContactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },

    // Same shape CRMActivity uses for task ownership, so "who owns this" reads
    // identically on a Journey and on the task hanging off it.
    ownerId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    ownerName: { type: String, trim: true },
    merchandiserId: { type: mongoose.Schema.Types.ObjectId },
    merchandiserName: { type: String, trim: true },

    // ── Lifecycle ───────────────────────────────────────────────────────────
    currentStage: {
      type: String,
      enum: SALES_JOURNEY_STAGE_CODES,
      default: "account",
      index: true,
    },
    stageStates: { type: stageStatesSchema, default: () => ({}) },

    risk: { type: String, enum: SALES_JOURNEY_RISK_CODES, default: "onTrack", index: true },
    riskReason: { type: String, trim: true },
    businessStatus: { type: String, trim: true },

    // ── Timing ──────────────────────────────────────────────────────────────
    // A real date and its business label ("Tender close"). Relative text
    // ("in 3 days") is never stored — it is derived at read time, or it is
    // wrong by tomorrow.
    targetDate: {
      label: { type: String, trim: true },
      date: { type: Date },
    },

    // ── Commercial summary (restricted) ─────────────────────────────────────
    // Stripped from responses server-side for unauthorized callers — see
    // services/crmVisibility.stripJourneyCommercial. Hiding it in React only
    // would still ship the number to the browser.
    expectedValue: {
      amount: { type: Number, min: 0 },
      currency: { type: String, trim: true, uppercase: true },
      confirmed: { type: Boolean, default: false },
    },

    // ── Current next action ─────────────────────────────────────────────────
    // A POINTER to the CRMActivity that owns the subject, owner, due date and
    // status. Nothing about that task is duplicated here.
    currentNextActionId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMActivity", index: true },

    // ── Lifecycle/audit metadata, matching the other CRM models ─────────────
    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

// The Hub's real access patterns, not speculative ones:
//   • "my work, most recently touched"        → isActive + ownerId + updatedAt
//   • "this account's journeys"               → isActive + accountId + updatedAt
//   • "team board filtered by stage and risk" → isActive + currentStage + risk
salesJourneySchema.index({ isActive: 1, ownerId: 1, updatedAt: -1 });
salesJourneySchema.index({ isActive: 1, accountId: 1, updatedAt: -1 });
salesJourneySchema.index({ isActive: 1, currentStage: 1, risk: 1 });
salesJourneySchema.index({ isActive: 1, "targetDate.date": 1 });

/** The state of the stage the Journey is actually on — the Hub's status chip. */
salesJourneySchema.virtual("currentStageState").get(function () {
  return this.stageStates?.[this.currentStage] || "notStarted";
});

/**
 * Who progress is waiting on, derived from lifecycle state rather than stored.
 * A stored copy would go stale the moment the stage state changed.
 */
salesJourneySchema.virtual("waitingOn").get(function () {
  const s = this.stageStates?.[this.currentStage];
  if (s === "waitingCustomer") return "customer";
  if (s === "waitingInternal") return "internal";
  return null;
});

module.exports = mongoose.model("SalesJourney", salesJourneySchema);
