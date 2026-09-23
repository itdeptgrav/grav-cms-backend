// models/CMS_Models/Marketing/MarketingCampaignObservation.js
//
// ONE DAY OF ONE CAMPAIGN, AS GRAV OBSERVED IT.
//
// ── AN OBSERVATION, NOT A FIGURE ───────────────────────────────────────────
// The name matters. This row does not say "the campaign got 412 clicks"; it
// says "when GRAV read this account at 09:14, it was told 412". Those differ
// whenever the read failed, the day was unfinished, or the channel later
// revised its own numbers — which it does, routinely, as spend is reconciled
// and late conversions arrive through attribution windows.
//
// So every row carries what was read, WHEN it was read, how complete it was,
// and why it is not more complete than that.
//
// ── NULL IS NOT ZERO ───────────────────────────────────────────────────────
// Every metric defaults to `null` and means "the channel did not tell us".
// Zero means the channel told us zero. A schema that defaulted these to 0
// would make "we could not read Tuesday" and "nothing happened on Tuesday"
// indistinguishable in the database, and no amount of care in the service
// layer above could recover the difference afterwards.
//
// ── AND THE CHANNEL MAY CORRECT ITSELF ─────────────────────────────────────
// `metricRevision` increments only when the normalised facts actually change.
// A re-sync that reads the same numbers is a no-op, which is what makes the
// sync idempotent; a re-sync that reads different numbers supersedes the row
// and appends the old values to an append-only history, so a figure that moved
// can be explained rather than merely noticed.
"use strict";

const mongoose = require("mongoose");

const {
  COMPLETENESS_CODES,
  INCOMPLETE_REASON_CODES,
} = require("../../../constants/marketingPerformance");

/* ── THE METRICS, EVERY ONE NULLABLE ────────────────────────────────────────
   No `default: 0` anywhere in this block, deliberately. */
const metricFields = () => ({
  impressions: { type: Number, default: null, min: 0 },
  /* Google does not report reach on a Search campaign. Absent stays absent. */
  reach: { type: Number, default: null, min: 0 },
  clicks: { type: Number, default: null, min: 0 },
  /* Meta reports this only where a pixel is configured. */
  landingPageViews: { type: Number, default: null, min: 0 },

  /* ── MONEY, KEPT TWICE ────────────────────────────────────────────────
     `spendMinorUnits` is what a reader wants: paise, cents, an integer.
     `spendMicros` is what the channel actually said — Google reports cost in
     millionths of a currency unit, and 1_234_567 micros is 123.4567 minor
     units. Rounding on the way in discards a fraction of a paisa per day, and
     a month of that is a real discrepancy against the channel's own invoice.

     Totals are summed in micros and rounded ONCE, at presentation. */
  spendMinorUnits: { type: Number, default: null, min: 0 },
  spendMicros: { type: Number, default: null, min: 0 },

  /* Not an integer: Google reports fractional conversions where a conversion
     action is configured to count a fraction, and rounding them would change a
     figure the channel published. */
  conversions: { type: Number, default: null, min: 0 },
  conversionValueMinorUnits: { type: Number, default: null, min: 0 },
  conversionValueMicros: { type: Number, default: null, min: 0 },
});

/* ── WHAT EACH CHANNEL COUNTED AS A CONVERSION ──────────────────────────────
   Published beside the figure rather than left implicit. Google counts the
   conversion actions somebody configured in that account; Meta counts a set of
   pixel and on-platform events. A reader who disagrees with either definition
   can see it instead of guessing, and the two are never silently added. */
const conversionBasisSchema = new mongoose.Schema(
  {
    countedTypes: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },
    means: { type: String, trim: true, default: "", maxlength: 300 },
  },
  { _id: false },
);

const observationSchema = new mongoose.Schema(
  {
    /* ── THE KEY, IN FULL ────────────────────────────────────────────────
       Company, plan, the exact approved revision, the deployment, the channel,
       the advertising account, the external campaign and the reporting date.

       The approved revision is part of it because a plan edited and
       re-approved is a different campaign: its figures belong to the revision
       that was running, not to whatever the plan says today. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },
    approvedRevision: { type: Number, required: true, min: 1 },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    channel: { type: String, required: true, trim: true, enum: ["google_ads", "meta_ads"] },

    /* The account the figures came from. Never published — a reader is told
       which CHANNEL, not which account number — but recorded, because a
       deployment rebound to another account produces figures from a different
       place and this is what makes that detectable. */
    externalAccountId: { type: String, required: true, trim: true, maxlength: 64, select: false },
    externalCampaignId: { type: String, required: true, trim: true, maxlength: 64 },

    /* ── THE DAY, AS THE ACCOUNT COUNTS DAYS ─────────────────────────────
       A `YYYY-MM-DD` string, not a Date. An advertising day is a calendar day
       in the ACCOUNT's timezone; storing an instant would make the stored value
       depend on the server's timezone at write time, and a report would shift
       by a day when the server moved. */
    reportingDate: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    reportingTimeZone: { type: String, required: true, trim: true, maxlength: 64 },
    currency: { type: String, trim: true, default: "", maxlength: 3, uppercase: true },

    ...metricFields(),

    conversionBasis: { type: conversionBasisSchema, default: null },

    /* ── HOW MUCH OF THIS DAY IS SETTLED ─────────────────────────────────── */
    completeness: { type: String, enum: COMPLETENESS_CODES, required: true },
    incompleteReason: { type: String, enum: [...INCOMPLETE_REASON_CODES, ""], default: "" },

    /* ── WHEN GRAV LOOKED ────────────────────────────────────────────────
       Not `updatedAt`: that moves when anything on the row changes. This is
       the moment the channel was actually asked, which is the only thing a
       reader can judge freshness by. */
    observedAt: { type: Date, required: true },

    /* ── THE CHANNEL MAY CORRECT ITSELF ──────────────────────────────────
       Incremented only when the normalised facts change. A re-sync reading the
       same numbers leaves this alone, which is what makes the sync idempotent. */
    metricRevision: { type: Number, required: true, default: 1, min: 1 },
    /* A hash of the facts. Comparing this is how "did anything change" is
       answered without comparing nine nullable fields by hand. */
    factsFingerprint: { type: String, required: true, trim: true, maxlength: 64 },

    /* ── RAW RESPONSES ARE NOT HERE ──────────────────────────────────────
       No field for them, deliberately. This repository has no approved
       encrypted diagnostic store — `utils/salaryEncryption.js` is scoped in its
       own header to employee salary fields under its own key — and an
       advertising response carries account identifiers and, in an error
       envelope, request fragments. Storing one unencrypted would put that in
       every backup. The facts are kept; the body is logged server-side and
       discarded. */
  },
  { timestamps: true, collection: "marketing_campaign_observations", strict: "throw" },
);

/* ── ONE ROW PER DEPLOYMENT PER DAY ─────────────────────────────────────────
   The uniqueness that makes the sync idempotent: a second read of the same day
   finds this row rather than adding a second one. The company leads, so a
   query cannot reach another tenant's observations even if a deployment id
   leaked. */
observationSchema.index(
  { companyId: 1, deploymentId: 1, reportingDate: 1 },
  { unique: true },
);

/* The read the report service makes: one plan, one revision, a date range. */
observationSchema.index({ companyId: 1, campaignDraftId: 1, approvedRevision: 1, reportingDate: 1 });
observationSchema.index({ companyId: 1, channel: 1, reportingDate: 1 });

const MarketingCampaignObservation = mongoose.models.MarketingCampaignObservation
  || mongoose.model("MarketingCampaignObservation", observationSchema);

/* ── WHAT A FIGURE USED TO BE ───────────────────────────────────────────────
   Append-only. A channel revising its own numbers is ordinary — spend is
   reconciled, late conversions arrive — and a figure that moved with no record
   of having moved is the kind of thing that costs somebody an afternoon.

   Superseded values land here; the current row always holds the latest. */
const revisionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    observationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, required: true },
    reportingDate: { type: String, required: true, trim: true },

    /* The revision these values WERE. The row that replaced them carries
       `metricRevision + 1`. */
    metricRevision: { type: Number, required: true, min: 1 },
    factsFingerprint: { type: String, required: true, trim: true, maxlength: 64 },
    completeness: { type: String, enum: COMPLETENESS_CODES, required: true },
    observedAt: { type: Date, required: true },
    supersededAt: { type: Date, required: true, default: Date.now },

    ...metricFields(),
  },
  { timestamps: false, collection: "marketing_campaign_observation_revisions", strict: "throw" },
);

revisionSchema.index({ companyId: 1, observationId: 1, metricRevision: 1 }, { unique: true });

const refuse = function refuseMutation(next) {
  next(new Error("marketing_campaign_observation_revisions is append-only: a superseded figure cannot be rewritten."));
};
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete"]) {
  revisionSchema.pre(op, refuse);
}
revisionSchema.pre("save", function refuseRewrite(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

const MarketingCampaignObservationRevision = mongoose.models.MarketingCampaignObservationRevision
  || mongoose.model("MarketingCampaignObservationRevision", revisionSchema);

module.exports = {
  MarketingCampaignObservation,
  MarketingCampaignObservationRevision,
};
