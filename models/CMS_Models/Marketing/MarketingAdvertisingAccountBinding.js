// models/CMS_Models/Marketing/MarketingAdvertisingAccountBinding.js
//
// WHICH ADVERTISING ACCOUNT A GRAV COMPANY DEPLOYS INTO.
//
// ── THE FAILURE THIS PREVENTS ──────────────────────────────────────────────
// The read chunk takes its account from `GOOGLE_ADS_CUSTOMER_ID`. For a report
// that is survivable. For a create it is not: one OAuth identity commonly has
// access to several advertising accounts — an agency's own, two clients', a
// test one — and taking the account from the environment means the first real
// campaign is created in whichever one a deployment variable happened to name.
// Nobody chose that account, nobody would find out until an invoice arrived,
// and the campaign would be sitting in somebody else's account with GRAV's
// tracking on it.
//
// So a write needs a binding: a deliberate act, by a named person, recording
// which account THIS company's campaigns are created in — verified against the
// accounts the credential could actually see at the moment it was made.
//
// ── AND WHAT A BINDING IS NOT ──────────────────────────────────────────────
// It is not a credential and it cannot become one. Everything stored here is an
// identifier or a label that the advertising interface shows to anybody who can
// open the account: the account number, its name, its currency, its timezone.
// The allow-list in `constants/marketingGoogleSearchDeployment.js` is what may
// be written; the schema below is strict, so a field outside it is not stored
// even if a caller sends it; and `assertNoSecretShapedValue` refuses a
// credential pasted into `note` rather than storing it under a harmless name.
//
// A binding plus a credential is what reaches an account. Neither alone does,
// and they live in different places on purpose — the credential in deployment
// secrets, this in the database — so that a database dump is not an advertising
// account and a leaked environment is not a decision about where to spend.
"use strict";

const mongoose = require("mongoose");

const {
  BINDING_STATE_CODES,
} = require("../../../constants/marketingGoogleSearchDeployment");

const { DEPLOYMENT_CHANNEL_CODES } = require("./MarketingCampaignDeployment");

const actorSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, default: null },
    name: { type: String, trim: true, default: "" },
    role: { type: String, trim: true, default: "" },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

/* ── WHAT GRAV READ, AND WHEN ───────────────────────────────────────────────
   Not "is this account fine", which has no time attached and is therefore a
   claim rather than an observation. The last read, its outcome, and the moment
   it happened, so an operator can see that a `verified` binding was verified
   eleven minutes ago rather than in March. */
const verificationSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    /* GRAV's own code. A Google error code never lands here. */
    outcome: { type: String, trim: true, required: true },
    reasonCode: { type: String, trim: true, default: "" },
    /* Read back from the account itself, which is the only way to know GRAV is
       pointed at the account somebody meant rather than at an id that parses. */
    observedAccountName: { type: String, trim: true, default: "" },
    observedCurrency: { type: String, trim: true, default: "" },
    observedTimeZone: { type: String, trim: true, default: "" },
    observedIsManager: { type: Boolean, default: null },
    observedStatus: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const bindingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* Google Ads or Meta Ads. The email channel is never here: the internal
       engine has no externally-bound advertising account, and listing it would
       put the engine in a collection a reader of this file can see. */
    channel: { type: String, enum: DEPLOYMENT_CHANNEL_CODES, required: true },

    /* ── THE ACCOUNT, AS THE PROVIDER NUMBERS IT ──────────────────────────
       Digits only for Google — the API takes `1234567890`, the interface shows
       `123-456-7890`, and accepting the hyphenated form and storing it would
       make two bindings that are the same account look different. Normalised by
       the service before it arrives here. */
    externalAccountId: { type: String, required: true, trim: true, maxlength: 64 },
    /* The name the account shows. Stored so a person confirming a binding sees
       a name rather than a number; never used to identify the account. */
    externalAccountName: { type: String, trim: true, default: "", maxlength: 300 },

    /* ── THE BUSINESS THE ACCOUNT SITS IN ─────────────────────────────────
       Meta's business identifier, where the channel exposes it. Another
       identifier, not a credential: it is on every screen of Business Manager.
       Empty for a channel that has no such concept. Deliberately NOT normalised
       into an account id — a business and an ad account are different objects,
       and conflating them would bind a company to the wrong thing. */
    businessId: { type: String, trim: true, default: "", maxlength: 64 },

    /* ── WHAT THE ACCOUNT SAID IT CAN DO ──────────────────────────────────
       A summary of the account's own status and capabilities, read back rather
       than assumed. Not a credential and not a capability GRAV grants itself:
       it is what the channel reported about an account somebody already has
       access to. Kept so a preflight can explain a refusal without re-reading,
       and stamped with the read that produced it. */
    accountStatus: { type: String, trim: true, default: "", maxlength: 64 },
    accountCapabilities: {
      type: new mongoose.Schema({
        campaignReads: { type: Boolean, default: null },
        insightsReads: { type: Boolean, default: null },
        /* Meta reports these; Google has no equivalent and leaves them null,
           which is different from false. */
        disableReason: { type: String, trim: true, default: "" },
        capabilities: { type: [{ type: String, trim: true, maxlength: 64 }], default: [] },
        readAt: { type: Date, default: null },
      }, { _id: false }),
      default: null,
    },

    /* ── THE MANAGER ACCOUNT, WHEN THERE IS ONE ───────────────────────────
       Google requires a `login-customer-id` header when the target account sits
       under a manager. It is another account NUMBER, not a credential. Empty
       when the account stands alone; sending an empty one is a 400. */
    loginAccountId: { type: String, trim: true, default: "", maxlength: 64 },

    /* Read from the account, not supplied. A plan's budget currency is checked
       against this, because a budget approved in one currency created in an
       account that bills in another spends a different amount of money. */
    currency: { type: String, trim: true, uppercase: true, default: "", maxlength: 3 },
    timeZone: { type: String, trim: true, default: "", maxlength: 64 },

    note: { type: String, trim: true, default: "", maxlength: 500 },

    state: { type: String, enum: BINDING_STATE_CODES, required: true, default: "unverified" },

    /* ── WHO DECIDED, AND WHO WITHDREW ────────────────────────────────────
       Binding a company's advertising account to a write path is the decision
       that makes spending possible. It carries a name. */
    boundBy: { type: actorSchema, required: true },
    revokedBy: { type: actorSchema, default: null },
    revokedReason: { type: String, trim: true, default: "", maxlength: 300 },

    lastVerification: { type: verificationSchema, default: null },

    /* Optimistic concurrency, the same contract the plan uses. Two operators
       rebinding at once must not silently lose one decision. */
    revision: { type: Number, required: true, default: 1, min: 1 },
  },
  {
    timestamps: true,
    collection: "marketing_advertising_account_bindings",
    /* ── STRICT, AND SAYING SO ────────────────────────────────────────────
       The default would drop an unknown field silently; this throws. A caller
       that sends `refreshToken` gets an error naming it rather than a stored
       document that quietly lost it — and the difference matters, because the
       silent version leaves the caller believing the token was accepted. */
    strict: "throw",
  },
);

/* ── ONE LIVE BINDING PER COMPANY PER CHANNEL ───────────────────────────────
   The partial filter excludes withdrawn ones, so a company's history of
   bindings is kept while only one can be in force. Without this, two `verified`
   bindings for one company would make "which account do we deploy into" a
   question with two answers, resolved by whichever row a query returned first. */
bindingSchema.index(
  { companyId: 1, channel: 1 },
  {
    name: "companyId_1_channel_1_live",
    unique: true,
    partialFilterExpression: { state: { $in: ["unverified", "verified", "unreachable"] } },
  },
);

bindingSchema.index({ companyId: 1, channel: 1, createdAt: -1 });

module.exports = mongoose.models.MarketingAdvertisingAccountBinding
  || mongoose.model("MarketingAdvertisingAccountBinding", bindingSchema);
