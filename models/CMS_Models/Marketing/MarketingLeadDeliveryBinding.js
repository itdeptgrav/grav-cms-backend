// models/CMS_Models/Marketing/MarketingLeadDeliveryBinding.js
//
// WHERE ONE CAMPAIGN'S LEADS ARRIVE.
//
// ── EVERYTHING HERE IS COORDINATION, NOTHING IS A SECRET ───────────────────
// This row says: leads posted to this address belong to that company, that
// plan, that deployment. It is the thing a webhook resolves before it trusts
// anything in the body.
//
// It holds no webhook key, because there is nothing to hold. The key is derived
// from a deployment master at the moment it is needed, so a dumped copy of this
// collection yields binding identities and provider object numbers — neither of
// which is a credential — and no key for any company. `secretVersion` is an
// integer saying which generation of the master to derive with.
//
// ── PROVIDER IDENTIFIERS ARE STRINGS, ALWAYS ───────────────────────────────
// Google's form and campaign ids are int64, and it says so four times in its
// own documentation. A Mongo `Number` is a double: an id above 2^53 is stored
// with its last digits altered, silently, and the correlation this row exists
// for then matches nothing. Every one of them is a string, and the schema
// refuses anything else.
//
// ── AND THEY ARE BACKEND EVIDENCE ──────────────────────────────────────────
// `providerFormId` and `providerCampaignId` name objects inside somebody's
// advertising account. They exist so a delivery can be checked against the
// binding it claims to belong to. They are never published to a marketer, and
// `select: false` means a careless `.find()` does not carry them into a
// response by accident.
"use strict";

const mongoose = require("mongoose");

/* ── THE STATES A BINDING PASSES THROUGH ────────────────────────────────────
   `prepared` and `awaiting_form_identity` look similar and are not. The first
   means GRAV has an address and nothing has been created in Google. The second
   means creation has begun and GRAV is waiting to learn which form it made —
   a state in which a delivery could legitimately arrive before the identity
   has been recorded, so correlation has to tolerate not knowing yet.

   `disabled` is terminal for delivery and keeps the row: a binding that stopped
   accepting leads is evidence about leads that already arrived. */
const BINDING_STATES = [
  "prepared",
  "awaiting_form_identity",
  "bound",
  "disabled",
];

/* Google's ids arrive as int64. Stored as digits-only text or not at all. */
const providerId = () => ({
  type: String,
  trim: true,
  default: "",
  validate: {
    validator: (v) => v === "" || /^\d{1,20}$/.test(v),
    message: "A provider identifier is stored as digits, exactly as the channel sent them.",
  },
  /* Backend correlation evidence. Never published, and not loaded unless a
     caller asks for it by name. */
  select: false,
});

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, trim: true, default: "" },
  at: { type: Date, default: Date.now },
});

const bindingSchema = new mongoose.Schema(
  {
    /* ── EVERY SELECTOR CARRIES THIS ─────────────────────────────────────
       And after the route token has been resolved, it is the company the
       TOKEN named — never one a caller supplied. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* The stable internal identity the webhook key is derived from. Generated
       once and never changed: changing it would change the derived key and
       silently break every delivery for a live form. */
    bindingRef: { type: String, required: true, trim: true },

    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },
    approvedRevision: { type: Number, required: true, min: 1 },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, default: null },

    channel: { type: String, required: true, trim: true, default: "google_ads" },
    campaignType: { type: String, required: true, trim: true, default: "google_lead_form" },

    /* ── WHICH GENERATION OF THE MASTER TO DERIVE WITH ───────────────────
       An integer, and the only thing about the key this row knows. Immutable:
       a binding that changed generation mid-life would derive a key Google
       does not have, and every delivery would be refused as a bad secret. */
    secretVersion: { type: Number, required: true, min: 1, default: 1 },

    state: { type: String, enum: BINDING_STATES, required: true, default: "prepared", index: true },
    disabledReason: { type: String, trim: true, default: "", maxlength: 500 },
    disabledBy: { type: actorRef(), default: null },

    /* ── PROTECTED CORRELATION ───────────────────────────────────────────
       Learned when Google confirms what was created. A delivery naming a
       different form is refused — but only AFTER the token resolved the
       binding and the key verified, never as a way of choosing the company. */
    providerFormId: providerId(),
    providerCampaignId: providerId(),
    correlationConfirmedAt: { type: Date, default: null },

    /* ── THE PERMISSION QUESTION THIS FORM ASKED ─────────────────────────
       Non-secret, and the ONLY place consent evidence may come from. A notice
       identifier or version arriving in a delivery is a value the sender
       chose, so consent assembled from it evidences nothing.

       `columnId` names which answer on the form is the permission question.
       Without it GRAV cannot tell an agreement from an answer to something
       else, so a binding with no notice records no consent — which is the
       correct outcome for the overwhelming majority of lead forms, because
       most of them do not ask. */
    consentNotice: {
      requested: { type: Boolean, default: false },
      noticeId: { type: String, trim: true, default: "", maxlength: 120 },
      noticeVersion: { type: String, trim: true, default: "", maxlength: 40 },
      columnId: { type: String, trim: true, default: "", maxlength: 80 },
      purpose: { type: String, trim: true, default: "marketing", maxlength: 40 },
      channel: { type: String, trim: true, default: "email", maxlength: 40 },
    },

    /* So a retry of the same preparation returns the same binding rather than
       creating a second address for one form. */
    idempotencyKey: { type: String, required: true, trim: true },
    /* What the preparation asked for, hashed. A retry with DIFFERENT contents
       under the same key is a conflict, not a repeat — answering it with the
       first binding would silently ignore what the caller asked for. */
    commandFingerprint: { type: String, required: true, trim: true, maxlength: 64 },

    /* Stamped when the first production lead arrives, which is the moment the
       notice stops being editable. */
    noticeSettledAt: { type: Date, default: null },

    preparedBy: { type: actorRef(), default: null },
  },
  { timestamps: true, collection: "marketing_lead_delivery_bindings", strict: "throw" },
);

/* One binding per company per idempotency key — the fence that makes retrying
   a preparation safe. */
bindingSchema.index({ companyId: 1, idempotencyKey: 1 }, { unique: true });
/* The derivation identity has to be unique, or two bindings would share a key. */
bindingSchema.index({ companyId: 1, bindingRef: 1 }, { unique: true });
/* Correlation lookups, sparse so empty strings do not collide. */
bindingSchema.index({ companyId: 1, providerFormId: 1 });

/* ── NOTHING SECRET MAY BE WRITTEN HERE, EVEN BY ACCIDENT ───────────────────
   `strict: "throw"` already refuses a field outside the schema. This is the
   second line: a future edit that ADDS a field with one of these names gets
   caught by a test rather than by a breach, and the intent is recorded where
   somebody editing the schema will read it. */
const FORBIDDEN_FIELDS = Object.freeze([
  "webhookKey", "googleKey", "google_key", "secret", "masterSecret",
  "rawPayload", "payload", "headers", "authorization", "accessToken",
  "refreshToken", "developerToken", "deliveryToken",
]);

/* ── THE TWO FIELDS THE DERIVED KEY DEPENDS ON ─────────────────────────────
   Enforced by a hook rather than mongoose's `immutable`, which under
   `strict: "throw"` rejects the document when it is LOADED, not when it is
   changed — so a binding became unreadable the moment it existed.

   Changing either would change the derived key, so Google would hold one
   secret and GRAV would compute another, and every delivery for that form
   would be refused as a bad key with nothing to point at. */
const FROZEN_FIELDS = Object.freeze(["bindingRef", "secretVersion", "companyId"]);

bindingSchema.pre("save", function refuseFrozenChange(next) {
  if (this.isNew) return next();

  /* ── THE NOTICE IS SETTLED BEFORE THE FIRST LEAD, NEVER AFTER ──────────
     Changing which question meant "yes", or which version of the wording was
     shown, would re-describe permission that people already gave — and it
     would do it retrospectively, to evidence somebody may have relied on.

     `noticeSettledAt` is stamped the first time a notice is written. After
     that the binding may still be disabled or have its provider identity
     attached; the notice itself cannot move. */
  if (this.noticeSettledAt && this.isModified("consentNotice")) {
    return next(new Error(
      "This delivery address has already received leads under its recorded permission wording. Changing it would re-describe consent people already gave. Prepare a new binding instead.",
    ));
  }

  const moved = FROZEN_FIELDS.filter((f) => this.isModified(f));
  if (moved.length) {
    return next(new Error(
      `A delivery binding's ${moved.join(", ")} cannot change: the webhook key is derived from them, and changing one would silently break delivery for a live form.`,
    ));
  }
  return next();
});

bindingSchema.pre("save", function refuseSecrets(next) {
  for (const field of FORBIDDEN_FIELDS) {
    if (this.get(field) !== undefined) {
      return next(new Error(
        `A delivery binding stores no credentials: ${field} cannot be written here.`,
      ));
    }
  }
  return next();
});

/* ── THE PUBLIC FACE ────────────────────────────────────────────────────────
   Field by field. A spread would publish whatever a future internal field
   turns out to be, the day somebody adds one — and two of the fields on this
   row name objects inside a customer's advertising account. */
bindingSchema.methods.publicView = function publicView(deliveryToken) {
  return {
    deliveryToken,
    draftRef: this.draftRef,
    approvedRevision: this.approvedRevision,
    channel: this.channel,
    campaignType: this.campaignType,
    state: this.state,
    /* Whether Google's form has been matched to this binding — the FACT, never
       the identifier. */
    correlationConfirmed: Boolean(this.correlationConfirmedAt),
    /* Whether this form asks for marketing permission at all — the fact, not
       the wording's identifier or version. */
    asksMarketingPermission: Boolean(this.consentNotice?.requested),
    preparedAt: this.createdAt,
    updatedAt: this.updatedAt,
    means: this.state === "bound"
      ? "Leads from this campaign's form arrive at this address."
      : this.state === "disabled"
        ? "This address no longer accepts leads. What already arrived is kept."
        : "This address is ready. Nothing has been created in the advertising channel yet.",
  };
};

const MarketingLeadDeliveryBinding = mongoose.models.MarketingLeadDeliveryBinding
  || mongoose.model("MarketingLeadDeliveryBinding", bindingSchema);

module.exports = {
  MarketingLeadDeliveryBinding,
  BINDING_STATES,
  FORBIDDEN_FIELDS,
  FROZEN_FIELDS,
};
