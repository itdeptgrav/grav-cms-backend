// models/CMS_Models/Marketing/MarketingTrackingConfig.js
//
// WHAT THE PUBLIC WEBSITE IS CONFIGURED TO MEASURE, PER COMPANY.
//
// ── WHAT THIS IS NOT ───────────────────────────────────────────────────────
// It is not a place tracking runs. GRAV is the internal employee application:
// no container, no measurement tag and no pixel is ever loaded here, and
// nothing in this file or the service above it emits a script. These are
// identifiers GRAV holds on behalf of a website that lives on a different
// origin, serves a different audience and has its own consent surface.
//
// It is also not a credential store. There is no access token, no Conversions
// API token, no client secret and no refresh token in this schema, and the
// validator refuses those field names rather than dropping them — a submitted
// secret that vanished silently would leave somebody believing GRAV had it.
//
// ── ONE CURRENT RECORD, AND AN APPEND-ONLY HISTORY BESIDE IT ───────────────
// The current record is what the website would be told; the history is what was
// ever decided and by whom. Company-wide tracking is exactly the kind of setting
// that gets changed at 6pm by somebody who then goes home, so "what did it say
// last Tuesday and who changed it" has to be answerable.
//
// ── AND IT IS COMPANY-SCOPED, NOT A SINGLETON ──────────────────────────────
// Deliberately not the Sales/Accounting settings-singleton shape. A singleton
// would make one company's site identifiers the whole platform's, which for a
// value that ends up in a public page is a leak rather than a bug.
"use strict";

const mongoose = require("mongoose");

const {
  TRACKING_MODE_CODES,
  TRACKING_VERIFICATION_STATE_CODES,
} = require("../../../constants/marketing");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* ── THE SAFE SHAPE ─────────────────────────────────────────────────────────
   Every field here is a PUBLIC identifier: values that appear in the page
   source of the website they configure, and which therefore carry no secrecy to
   lose. This same sub-document is what the history stores, so a history row can
   never hold something the current record would not. */
const safeConfigSchema = new mongoose.Schema(
  {
    siteUrl: { type: String, trim: true, default: "" },
    trackingMode: { type: String, enum: TRACKING_MODE_CODES, default: "disabled" },
    gtmContainerId: { type: String, trim: true, default: "" },
    ga4MeasurementId: { type: String, trim: true, default: "" },
    metaPixelId: { type: String, trim: true, default: "" },
    enabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const trackingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    siteUrl: { type: String, trim: true, default: "" },
    trackingMode: { type: String, enum: TRACKING_MODE_CODES, required: true, default: "disabled" },

    /* Identifiers, normalised by the validator before they arrive here. Empty
       string rather than null for an unset one, so "never set" and "cleared"
       read the same to every query — a distinction nobody needs and everybody
       would eventually get wrong. */
    gtmContainerId: { type: String, trim: true, default: "" },
    ga4MeasurementId: { type: String, trim: true, default: "" },
    metaPixelId: { type: String, trim: true, default: "" },

    enabled: { type: Boolean, default: false },

    /* ── OPTIMISTIC CONCURRENCY ────────────────────────────────────────────
       Two administrators editing company-wide tracking in different tabs is not
       a hypothetical, and the loser of that race silently reverting the winner
       is the worst outcome. Every write states the revision it believes it is
       replacing and is refused if that is no longer true. */
    revision: { type: Number, default: 0, min: 0 },

    configuredAt: { type: Date, default: null },
    configuredBy: actorRef(),

    /* ── WHAT IS KNOWN ABOUT WHETHER IT WORKS ──────────────────────────────
       `verified` is RESERVED for a later probe that actually reads the public
       site. Nothing in this slice may write it, and the service asserts that. A
       saved identifier is `saved_unverified` and says so. */
    verification: {
      state: {
        type: String, enum: TRACKING_VERIFICATION_STATE_CODES, default: "not_configured",
      },
      checkedAt: { type: Date, default: null },
      /* A sentence written for a person, bounded. Never a provider response and
         never a stack: this field is rendered in a settings screen, and a screen
         is the last place an unbounded upstream string should land. */
      safeMessage: { type: String, trim: true, default: "", maxlength: 300 },
    },
  },
  { timestamps: true, collection: "marketing_tracking_configs" },
);

/* ONE CURRENT RECORD PER COMPANY. The upsert in the service relies on this, and
   it is what stops two concurrent first writes creating two configurations. */
trackingSchema.index({ companyId: 1 }, { unique: true });

/* ── THE HISTORY ────────────────────────────────────────────────────────────
   Append-only, one row per revision. `previous` and `resulting` both use the
   safe shape above, so the trail shows what changed without ever holding
   anything the current record would not.

   ── WHY THE UNIQUE KEY IS (company, revision) ────────────────────────────
   It is the idempotency key. The service writes the history row BEFORE it
   updates the current record — see the service header for why that order — and
   a retried write therefore collides here rather than appending a second row
   for the same decision. */
const historySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    revision: { type: Number, required: true, min: 1 },

    previous: { type: safeConfigSchema, default: null },
    resulting: { type: safeConfigSchema, required: true },

    actor: actorRef(),
    at: { type: Date, required: true },
    /* Why the change was made, in the author's own words. Bounded. */
    note: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: true, collection: "marketing_tracking_config_history" },
);

historySchema.index({ companyId: 1, revision: 1 }, { unique: true });
/* The paginated read: this company's trail, newest first, stable on `_id`. */
historySchema.index({ companyId: 1, _id: -1 });

/* ── APPEND-ONLY, ENFORCED AT THE SCHEMA ────────────────────────────────────
   The same arrangement MarketingConsentHistory and SpActionHistory use: every
   mutation operator refused, and `save()` refused on a document that is not new.
   An audit trail that can be edited is an audit trail that proves nothing. */
const HISTORY_IMMUTABLE = new Error(
  "MarketingTrackingConfigHistory is append-only: a recorded configuration change cannot be updated or deleted.",
);

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace",
  "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "remove",
]) {
  historySchema.pre(op, function refuseHistoryWrite(next) { next(HISTORY_IMMUTABLE); });
}
historySchema.pre("save", function refuseHistoryResave(next) {
  if (!this.isNew) return next(HISTORY_IMMUTABLE);
  return next();
});

module.exports = {
  HISTORY_IMMUTABLE_MESSAGE: HISTORY_IMMUTABLE.message,
  MarketingTrackingConfig: mongoose.models.MarketingTrackingConfig
    || mongoose.model("MarketingTrackingConfig", trackingSchema),
  MarketingTrackingConfigHistory: mongoose.models.MarketingTrackingConfigHistory
    || mongoose.model("MarketingTrackingConfigHistory", historySchema),
};
