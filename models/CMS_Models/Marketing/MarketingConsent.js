// models/CMS_Models/Marketing/MarketingConsent.js
//
// PERMISSION IS A GRAV BUSINESS RECORD, NOT A FLAG SOMEBODY PASSED IN.
//
// ── WHAT THIS REPLACES, AND WHY IT HAD TO ──────────────────────────────────
// Chunk 0's `syncContact` took a `consent` argument and checked it:
//
//     if (consent.emailConsent !== "opted_in") refuse
//
// Which reads like an enforcement and is not one. Every caller that wanted a
// person in Mautic could have one by passing `{ emailConsent: "opted_in" }` —
// no record, no evidence, nobody accountable. The check tested the REQUEST, and
// a request cannot be the authority on whether a person agreed to be marketed
// to. ADR-004 puts consent in GRAV; this is where it now lives.
//
// ── TWO COLLECTIONS, AND THE DIVISION BETWEEN THEM ─────────────────────────
//   CURRENT  (`marketing_consents`)
//     Exactly one row per company + person + channel + purpose, enforced by a
//     unique index. It answers "what is true now", which is the only question
//     an enrolment decision may ask. Updated in place.
//
//   HISTORY  (`marketing_consent_history`)
//     One row per transition, append-only and enforced at the schema. It
//     answers "what did we believe, when, on whose word" — the question a
//     regulator, a complaint or a dispute actually asks, and the one a
//     mutable current-state row destroys the moment it is updated.
//
// Keeping both is not duplication. A single append-only log would make every
// eligibility check a scan-and-reduce, and a single mutable row would make the
// audit trail a thing we intended rather than a thing we have.
//
// ── IT CREATES NO SECOND PERSON ────────────────────────────────────────────
// Consent hangs off `gravPersonKey` — the opaque identity
// `MarketingIdentity` already mints (product plan §10: never an email address
// as the durable key). No name, no address and no company name is stored here.
// This model cannot become a competing Contact, Lead or Person master because
// it holds nothing a person could be identified by; reading one requires the
// identity row that owns the key.
//
// ── WHAT IS DELIBERATELY ABSENT ────────────────────────────────────────────
// The person's email address. It is tempting — a consent row "for an address"
// is easier to reason about — and it is the mistake the identity rule exists to
// prevent: addresses get reassigned to a successor, and consent keyed on one
// silently transfers to somebody who never gave it.
"use strict";

const mongoose = require("mongoose");

const {
  CONSENT_STATE_CODES,
  CONSENT_CHANNEL_CODES,
  CONSENT_PURPOSE_CODES,
} = require("../../../constants/marketing");

const actorRef = () => ({
  /* Absent for a system act — an unsubscribe webhook or a hard bounce is
     observed, not performed, and inventing a person for it would be a false
     attribution in the one record whose whole value is attribution. */
  id: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
  /* "user" | "system". Stated rather than inferred from whether `id` is set,
     because "we do not know who" and "nobody, it was automatic" are different
     facts and only one of them is a gap. */
  kind: { type: String, enum: ["user", "system"], default: "system" },
});

/* The evidence a state rests on. References only, never the artefact: a
   consent record that carries the signed form becomes a second copy of
   personal data that outlives deletion and is read by more people. */
const evidenceFields = () => ({
  /* Where the answer came from: "landing page form", "imported CRM export",
     "mautic unsubscribe webhook", "telephone, confirmed by salesperson". */
  capturedSource: { type: String, trim: true, default: "" },
  capturedAt: { type: Date, default: null },
  /* The privacy notice the person accepted, by version. Without it, "they
     agreed" cannot be answered with "to what". */
  noticeVersion: { type: String, trim: true, default: "" },
  /* A pointer to the proof — a form submission id, a document reference, a
     webhook event id. Not the proof itself. */
  evidenceRef: { type: String, trim: true, default: "" },
});

/* ═══ 1. CURRENT STATE ═════════════════════════════════════════════════════ */

const consentSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* The canonical GRAV person identity, from MarketingIdentity. Required:
       consent with no person attached is consent for nobody. */
    gravPersonKey: { type: String, required: true, trim: true },

    channel: { type: String, enum: CONSENT_CHANNEL_CODES, required: true },
    purpose: { type: String, enum: CONSENT_PURPOSE_CODES, required: true },

    /* Default `unknown`, and that default is load-bearing. A row that exists
       because somebody started asking must not read as agreement. */
    state: { type: String, enum: CONSENT_STATE_CODES, required: true, default: "unknown" },

    ...evidenceFields(),

    /* Who or what put it in this state, and when. */
    recordedBy: actorRef(),
    recordedAt: { type: Date, required: true, default: Date.now },

    /* ── WITHDRAWAL ───────────────────────────────────────────────────────
       Set when the state moves to `opted_out` or `suppressed`, and NOT cleared
       if the person later opts back in: "they withdrew in March and returned in
       June" is the true story, and blanking the first half tells a different
       one. `withdrawnAt` is therefore the last withdrawal, not a claim about
       the present — `state` is the present. */
    withdrawnAt: { type: Date, default: null },
    withdrawalReason: { type: String, trim: true, default: "" },

    /* The last idempotency key applied, so a repeated command is recognised
         without scanning history. See the service for how it is used. */
    lastCommandKey: { type: String, trim: true, default: "" },

    /* How many transitions this row has been through. Cheap integrity check
       against the history count, and what makes "silently rewritten" visible. */
    revision: { type: Number, default: 1, min: 1 },
  },
  { timestamps: true, collection: "marketing_consents" },
);

/* ONE CURRENT STATE PER PERSON PER CHANNEL PER PURPOSE. The resolver's
   conservative "ambiguous" branch exists for the case this index is supposed to
   make impossible, because a guarantee and a belief are different things. */
consentSchema.index(
  { companyId: 1, gravPersonKey: 1, channel: 1, purpose: 1 },
  { unique: true },
);
/* The Data Health read: who in this company is not reachable, and why. */
consentSchema.index({ companyId: 1, channel: 1, purpose: 1, state: 1 });

/* ═══ 2. APPEND-ONLY HISTORY ════════════════════════════════════════════════
   The enforcement below is copied, deliberately and almost verbatim, from
   models/CMS_Models/StorePurchase/SpActionHistory.js — the repository's existing
   append-only ledger. Its header makes the argument better than a second
   paraphrase would: "Immutable that relies on nobody writing an update is not
   immutable." One pattern for this in the codebase, not two. */

const historySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    gravPersonKey: { type: String, required: true, trim: true },
    channel: { type: String, enum: CONSENT_CHANNEL_CODES, required: true },
    purpose: { type: String, enum: CONSENT_PURPOSE_CODES, required: true },

    /* The transition itself. `fromState` is null only for the first entry. */
    fromState: { type: String, enum: [...CONSENT_STATE_CODES, null], default: null },
    toState: { type: String, enum: CONSENT_STATE_CODES, required: true },
    /* Which revision of the current row this entry produced, so the two
       collections can be reconciled without guessing at timestamps. */
    revision: { type: Number, required: true, min: 1 },

    ...evidenceFields(),

    recordedBy: actorRef(),
    /* When the transition was APPLIED. Distinct from `capturedAt`, which is
       when the person actually answered — an import records an answer given
       months earlier, and conflating the two makes a backdated consent look
       like a fresh one. */
    at: { type: Date, required: true, default: Date.now },

    reason: { type: String, trim: true, default: "" },
    /* The command that caused it, so a replay is traceable to its original. */
    commandKey: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "marketing_consent_history" },
);

/* One person's whole consent story, oldest first. */
historySchema.index({ companyId: 1, gravPersonKey: 1, channel: 1, purpose: 1, at: 1, _id: 1 });
/* ── ONE ENTRY PER REVISION PER TUPLE ───────────────────────────────────────
   Added after review. Two concurrent DIFFERENT commands both read the current
   revision, both computed `revision + 1`, and both appended — producing two
   history entries claiming to be revision 4 and no way to tell which produced
   the current state. This index makes that impossible: the loser gets a
   duplicate-key error and the service retries against the revision it can now
   see. */
historySchema.index(
  { companyId: 1, gravPersonKey: 1, channel: 1, purpose: 1, revision: 1 },
  { unique: true },
);

/* REPLAY SAFETY. One entry per command per tuple, so a retried command cannot
   append a second identical transition. A command with no key is exempt —
   `partialFilterExpression` keeps the index off those rows rather than
   collapsing every keyless entry into one. */
historySchema.index(
  { companyId: 1, gravPersonKey: 1, channel: 1, purpose: 1, commandKey: 1 },
  {
    unique: true,
    partialFilterExpression: { commandKey: { $type: "string", $gt: "" } },
  },
);

const APPEND_ONLY = new Error(
  "MarketingConsentHistory is append-only: entries cannot be updated or deleted.",
);

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace",
  "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "remove",
]) {
  historySchema.pre(op, function refuseWrite(next) { next(APPEND_ONLY); });
}

/* Document-level: `save()` on an already-persisted entry is an edit. */
historySchema.pre("save", function refuseResave(next) {
  if (!this.isNew) return next(APPEND_ONLY);
  return next();
});

module.exports = {
  APPEND_ONLY_MESSAGE: APPEND_ONLY.message,
  MarketingConsent: mongoose.models.MarketingConsent
    || mongoose.model("MarketingConsent", consentSchema),
  MarketingConsentHistory: mongoose.models.MarketingConsentHistory
    || mongoose.model("MarketingConsentHistory", historySchema),
};
