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
  SALES_JOURNEY_OUTCOME_CODES,
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
        // Enquiry is the first stage now (the "account" stage was removed — the
        // customer is set up on the Active Lead before conversion). "account"
        // stays in the enum for legacy journeys but seeds notStarted.
        default: code === "enquiry" ? "inProgress" : "notStarted",
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

    // ── Which Lead became this order ────────────────────────────────────────
    //
    // The chain Prospect → HOD review → Active Lead → Account records every hop
    // with a reason and an actor. Then the Journey was created against the
    // ACCOUNT alone and the trail stopped dead: nothing on an order pointed at
    // the lead that won it, so "who sourced this, and what did they promise"
    // became unanswerable the moment the journey existed. Two disconnected
    // steps — create the account from the lead, then separately create a
    // journey and pick that account off a list — and nothing stitched them back.
    //
    // Optional, because journeys legitimately exist for walk-in and repeat
    // business that never had a lead. `leadRef` is denormalised so the order can
    // name its origin without a second query.
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", index: true, sparse: true },
    leadRef: { type: String, trim: true },
    /**
     * OPTIONAL since 22 Aug 2026, and no longer asked for at creation.
     *
     * It was required, and it drove exactly one behaviour: `repeat` and
     * `replenishment` journeys skipped sampling. That turned out to be keyed on
     * the wrong thing — whether a SAMPLE is needed depends on whether the
     * PRODUCT is registered, not on whether the customer is a returning one —
     * so the behaviour moved to sampleStyleProvision.js and this field went
     * back to being a plain classification.
     *
     * A required classification nobody uses gets filled with whatever is first
     * in the dropdown, which is worse than an empty one: it reads as data. It
     * stays on the model, stays filterable, and existing values are untouched.
     */
    businessType: { type: String, enum: SALES_JOURNEY_BUSINESS_TYPE_CODES },

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
      default: "enquiry",
      index: true,
    },
    stageStates: { type: stageStatesSchema, default: () => ({}) },

    risk: { type: String, enum: SALES_JOURNEY_RISK_CODES, default: "onTrack", index: true },
    riskReason: { type: String, trim: true },

    // ── Outcome: a second axis, alongside currentStage ──────────────────────
    //
    // A customer going quiet, or going elsewhere, is not a stage — it can
    // happen at any of them. Until this existed the only tools past Enquiry
    // were `blocked` (which reads as OUR problem, and which the planner then
    // refuses to advance or close past) and `waitingCustomer` (which promises a
    // reply is coming). Neither could say "dormant" or "we lost it", so every
    // dead journey stayed on the board as "in flight" forever.
    //
    // `outcomeStage` is the whole point of the pair: recording WHERE a deal was
    // when it died is what turns a list of failures into "we lose most of them
    // at Cost & Quote".
    //
    // LOST IS PRE-PO ONLY. Once `po.number` exists the customer has committed,
    // capacity is booked and material is bought — walking away is a
    // cancellation with money and work orders to unwind, which is a different
    // job with a different authority. The planner refuses `lose` past the PO
    // rather than pretending this covers it.
    outcome: { type: String, enum: SALES_JOURNEY_OUTCOME_CODES, default: "active", index: true },
    /** Where it was when it stopped. Never overwritten by a later revive. */
    outcomeStage: { type: String, enum: SALES_JOURNEY_STAGE_CODES },
    /** A code from SALES_JOURNEY_PARK_REASONS or SALES_JOURNEY_LOST_REASONS. */
    outcomeReason: { type: String, trim: true },
    /** The salesperson's own words. Where the actual story lives. */
    outcomeNote: { type: String, trim: true },
    outcomeAt: { type: Date },
    outcomeBy: actorRef(),
    // ── Hold: why the current stage is not moving ───────────────────────────
    //
    // Two states stop a stage — `blocked` and `waitingOutside` — and until now
    // neither could say WHY on the record. The planner set the state and the
    // reason went into the change log alone, so the board showed "Blocked" and
    // whoever opened it next had to dig through an audit trail to learn that
    // fabric was at a mill.
    //
    // One block for both, because they are the same shape: this stage is held,
    // here is who or what by, here is when we expect it back.
    //
    // JOURNEY-LEVEL, not per stage. Only the CURRENT stage can be blocked or
    // waiting — the planner enforces that — so a single record is enough, and
    // widening the stageStates sub-schema into objects would be a migration for
    // no gain. `stage` records which stage it was raised at.
    //
    // Cleared whenever the stage moves to any other state. A stale "waiting on
    // Vardhman" under an in-progress stage is worse than no note at all.
    hold: {
      /** "blocked" or "waitingOutside" — mirrors the stage state that set it. */
      kind: { type: String, trim: true },
      /**
       * Free text, deliberately. Who or what we are waiting on: "Vardhman —
       * fabric dyeing", "SGS lab — colourfastness", "customer's architect".
       * An enum here would be a list of every vendor GRAV has ever used,
       * maintained by hand, and out of date the first time somebody tries a
       * new mill.
       */
      on: { type: String, trim: true },
      /** When we expect it back. Optional — sometimes nobody has committed. */
      expectedBack: { type: Date },
      since: { type: Date },
      by: actorRef(),
      stage: { type: String, enum: SALES_JOURNEY_STAGE_CODES },
    },

    /**
     * When to look at a PARKED journey again. Required to park, because a park
     * with no date is how a pipeline silently becomes a graveyard — the same
     * rule the Lead's nurture state already enforces with its next action.
     */
    revisitOn: { type: Date, index: true, sparse: true },
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
    // ── The customer's purchase order ───────────────────────────────────────
    //
    // Nothing recorded a PO anywhere — not here, not on the Enquiry — so the
    // PO/Contract stage could be marked complete with no evidence that a PO
    // exists, and "don't start production without a PO" was unenforceable
    // because there was nothing to check. A file uploaded at that stage was
    // never persisted against the journey either.
    //
    // `number` is the customer's own reference and the thing people quote in
    // conversation, so it is required for the record to count as present.
    po: {
      number: { type: String, trim: true },
      date: { type: Date },
      amount: { type: Number, min: 0 },
      currency: { type: String, trim: true, uppercase: true, default: "INR" },
      file: {
        name: { type: String, trim: true },
        url: { type: String, trim: true },
      },
      recordedAt: { type: Date },
      recordedBy: {
        employeeId: { type: String, trim: true },
        name: { type: String, trim: true },
      },

      // ── Payment terms, and the one they gate on ─────────────────────────
      //
      // Recorded HERE because the PO is where commercial terms are actually
      // agreed. Until now they lived in somebody's head or in the quotation's
      // notes, so nothing could act on them: a journey with a PO on file could
      // walk into production having received nothing.
      //
      // `advancePercent` is the only structured number, and only because it is
      // the only one the system can enforce before production. The rest is free
      // text — garment payment terms are a negotiation ("60% against BL, 40% on
      // delivery, retention 5% for 90 days"), and an enum would either refuse
      // real terms or grow forever.
      paymentTerms: {
        /** % of the order value that must be RECEIVED before production starts. */
        advancePercent: { type: Number, min: 0, max: 100 },
        /** Everything after the advance, in the words it was agreed in. */
        balanceTerms: { type: String, trim: true },
        note: { type: String, trim: true },
        /**
         * A production start with the advance short is possible, but never
         * silent: it takes a Sales manager and a written reason, and lands in
         * `advancedWithoutPrerequisites` below like every other bent rule.
         */
        agreedAt: { type: Date },
        agreedBy: actorRef(),
      },
    },

    // ── Every time a stage moved without its prerequisites ──────────────────
    //
    // The deliberate alternative to hard-gating every transition. Most stage
    // moves stay permissive, because the person moving them can see reality
    // better than the record can — but proceeding without a quotation or a PO
    // is written down, with who did it and why. A permissive system with a
    // complete record of where the rules were bent is more useful than a strict
    // one people defeat by typing a fake PO number.
    advancedWithoutPrerequisites: [
      new mongoose.Schema(
        {
          stage: { type: String, trim: true },
          missing: [{ type: String, trim: true }],
          reason: { type: String, trim: true },
          at: { type: Date, default: Date.now },
          by: {
            employeeId: { type: String, trim: true },
            name: { type: String, trim: true },
          },
        },
        { _id: false },
      ),
    ],

    // When the order was formally closed. "Closed" has meant only
    // `stageStates.retention === "complete"` until now, which records that the
    // final stage finished but not WHEN the order was signed off — and closing
    // is the moment money and delivery are declared settled, so it deserves its
    // own timestamp. Set by the `close` action in services/salesJourneyProgress.
    closedAt: { type: Date, default: null },

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
