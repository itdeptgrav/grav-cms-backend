// services/marketing/leads/leadProcessing.service.js
//
// FROM ONE SUBMITTED ENQUIRY TO A PERSON, AN ENGAGEMENT AND A DECISION.
//
// ── THREE EFFECTS, EACH ONCE, IN ORDER ─────────────────────────────────────
//   who was it            → the canonical Marketing identity
//   what did they do      → exactly one form-submission engagement
//   did they agree        → consent, only on explicit evidence
//
// Each is recorded on the receipt the moment it succeeds rather than in a batch
// at the end, which is the only reason a crash is survivable: a restarted
// worker reads the receipt, sees which effects exist, and continues at the
// first one that does not.
//
// ── THE RESUME IS CHECKED, NOT ASSUMED ─────────────────────────────────────
// "A later record exists, so the earlier step must have finished" is the
// tempting shortcut and it is wrong: a record belonging to a different company,
// a different submission or a different contract version proves nothing about
// this one. Every resume check carries all three.
//
// ── AND IT REACHES NOTHING DOWNSTREAM ──────────────────────────────────────
// No Sales model, no handover, no Google client. A processed lead is a person
// GRAV knows who did something; whether they should go to Sales is the existing
// qualification contract's decision, and this file cannot make it.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const MarketingIdentity = require("../../../models/CMS_Models/Marketing/MarketingIdentity");
const { MarketingIntentEvent } = require("../../../models/CMS_Models/Marketing/MarketingEvent");
const { MarketingAdvertisingLead } = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const {
  MarketingLeadProcessingReceipt,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const { MarketingLeadDeliveryBinding } = require("../../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");

const consent = require("../marketingConsent.service");
const { normalizePhone } = require("../handoverContract");
const P = require("../../../constants/marketingLeadProcessing");

const str = (v) => String(v ?? "").trim();
const lower = (v) => str(v).toLowerCase();

/* ── NORMALISATION IS THE REPOSITORY'S, NOT GOOGLE-SPECIFIC ─────────────────
   `normalizePhone` is imported from the handover contract, which is where the
   rule already lives. A second Google-flavoured phone rule would agree with it
   today and drift the first time either changed — and the symptom would be a
   person matched by one part of Marketing and not another. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const normalizeEmail = (v) => {
  const e = lower(v);
  return EMAIL_SHAPE.test(e) ? e : "";
};

/* GRAV's own opaque person key, derived the same way the handover contract
   derives it, so a person reached through either route is one person. */
const personKey = (companyId, basis) => crypto
  .createHash("sha256").update(`${companyId}|${basis}`).digest("hex").slice(0, 24);

/* ═══════════════════════════════════════════════════════════════════════════
   STRONG IDENTIFIERS
   ═══════════════════════════════════════════════════════════════════════════
   Only two things may identify a person: an email address and a phone number.

   A name, a company name, a job title, a postcode, a qualification answer, a
   campaign or a click id may not — not as a fallback, not in combination. Two
   people called "R Sharma" at "Acme" are two people, and matching them would
   merge two humans into one record on the strength of a coincidence. Every one
   of those fields is also self-reported and unverified. */

function strongIdentifiers(lead) {
  const email = normalizeEmail(lead?.contact?.email) || normalizeEmail(lead?.contact?.workEmail);
  const phone = normalizePhone(lead?.contact?.phone) || normalizePhone(lead?.contact?.workPhone);
  return {
    email,
    /* The repository's rule keeps the last ten digits; anything shorter is not
       a phone number GRAV can match on. */
    phone: phone && phone.length === 10 ? phone : "",
  };
}

/**
 * Who this enquiry is from.
 *
 * Four outcomes, and the two unhappy ones are the point of the function.
 */
async function resolveIdentity({ companyId, lead }) {
  const { email, phone } = strongIdentifiers(lead);

  if (!email && !phone) {
    /* ── NOTHING TO RECOGNISE THEM BY ────────────────────────────────────
       The submission stands and is kept. GRAV does not invent a person from a
       name and a company, because that person would then be matched against
       by everybody else who shares them. */
    return { outcome: "insufficient", reason: "no_usable_identifier" };
  }

  const byEmail = email
    ? await MarketingIdentity.findOne({ companyId, email }).lean()
    : null;
  const byPhone = phone
    ? await MarketingIdentity.findOne({ companyId, normalizedPhone: phone }).lean()
    : null;

  if (byEmail && byPhone && byEmail.gravPersonKey !== byPhone.gravPersonKey) {
    /* ── TWO PEOPLE, AND GRAV WILL NOT PICK ──────────────────────────────
       The email belongs to one person it knows and the phone to another.
       Every automatic answer here is a guess with consequences: choosing one
       attaches the enquiry to possibly the wrong human, merging them destroys
       two records that may be two real people, and creating a third makes the
       problem permanent. A person decides. */
    return { outcome: "conflict", reason: "identity_conflict" };
  }

  const existing = byEmail || byPhone;
  if (existing) {
    return { outcome: "existing", gravPersonKey: existing.gravPersonKey, created: false };
  }

  /* ── EXACTLY ONE NEW PERSON ──────────────────────────────────────────────
     Keyed on the strongest identifier available, upserted so two workers
     racing on one submission produce one identity rather than two. */
  const basis = email || phone;
  const gravPersonKey = personKey(String(companyId), basis);

  await MarketingIdentity.findOneAndUpdate(
    { companyId, gravPersonKey },
    {
      $setOnInsert: { companyId, gravPersonKey },
      $set: {
        ...(email ? { email } : {}),
        ...(phone ? { normalizedPhone: phone } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { outcome: "created", gravPersonKey, created: true };
}

/* ═══════════════════════════════════════════════════════════════════════════
   ENGAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */

/* A stable identity for the event, derived from the submission rather than the
   moment. A replay computes the same one and the ledger's unique index refuses
   the second — which is what makes "exactly one engagement" true rather than
   merely usually true. */
const eventKeyFor = (lead) => `google-lead:${lead.submissionRef}`;

/**
 * Record that this person submitted a lead form. Once.
 *
 * ── THE SUBMISSION TIME, NOT THE ARRIVAL TIME ──────────────────────────────
 * `occurredAt` is when the person submitted, as Google reported it. A recovery
 * sweep can deliver a week-old submission after a newer one, and ordering a
 * person's history by when GRAV happened to hear about it would put their story
 * in the wrong order.
 */
async function recordEngagement({ companyId, lead, gravPersonKey }) {
  const sourceEventId = eventKeyFor(lead);

  const existing = await MarketingIntentEvent
    .findOne({ companyId, source: "google_ads", sourceEventId }).select("_id").lean();
  if (existing) return { recorded: false, sourceEventId };

  try {
    await MarketingIntentEvent.create({
      companyId,
      source: "google_ads",
      sourceEventId,
      /* An explicit request in the existing vocabulary — somebody asked for
         something, which is the strongest engagement GRAV recognises. */
      kind: "form_submitted",
      gravPersonKey,
      occurredAt: lead.submittedAt ? new Date(lead.submittedAt) : new Date(lead.receivedAt),
      receivedAt: new Date(),
      /* Safe attribution: GRAV's own plan reference, never a provider's
         campaign, form or account number. */
      campaignId: "",
      campaignName: str(lead.draftRef),
      evidence: {
        providerRecordType: "lead_form_submission",
        providerEventType: "form_submitted",
      },
    });
    return { recorded: true, sourceEventId };
  } catch (err) {
    /* Two workers racing produced one event; the index settled it. */
    if (err?.code === 11000) return { recorded: false, sourceEventId };
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CONSENT
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Did this person explicitly agree to be marketed to?
 *
 * ── THE ANSWER IS ALMOST ALWAYS NO, AND THAT IS CORRECT ────────────────────
 * Submitting a form is asking for the thing the form offered. Somebody who
 * requested a quote requested a quote. Treating that as permission to market
 * to them is the inference this whole boundary exists to refuse, and it is an
 * easy one to make because the person plainly wants to hear from you — about
 * the quote.
 *
 * Four things must all be true, and any one missing means no permission is
 * recorded while everything else about the person is kept.
 */
function evaluateConsent({ lead, binding }) {
  const notice = binding?.consentNotice;

  /* ── THE FORM MUST HAVE ASKED ────────────────────────────────────────── */
  if (!notice?.requested) {
    return { record: false, reason: "consent_not_requested" };
  }

  /* ── AND GRAV MUST KNOW WHAT IT ASKED ────────────────────────────────────
     The notice identity and version come from the binding — what GRAV recorded
     when the form was built. Never from the delivery: a notice version
     arriving in a payload is a value the sender chose, and consent evidence
     assembled from the sender's own claims evidences nothing. */
  if (!str(notice.noticeId) || !str(notice.noticeVersion)) {
    return { record: false, reason: "consent_notice_unproven" };
  }

  const column = str(notice.columnId);
  if (!column) return { record: false, reason: "consent_notice_unproven" };

  /* The answer is looked up by the column the BINDING names. An answer under
     some other column is an answer to a different question. */
  const all = [...(lead.answers || []), ...(lead.unmapped || [])];
  const answered = all.find((a) => str(a.code) === column);

  if (!answered || !str(answered.answer)) {
    /* Silence is not agreement. */
    return { record: false, reason: "consent_answer_absent" };
  }

  const value = lower(answered.answer);

  if (P.REFUSAL_ANSWERS.includes(value)) {
    /* Understood, and it means no. Still not a suppression: the person
       declined marketing, which is a different thing from being suppressed as
       undeliverable, and conflating them would take an unrelated decision on
       their behalf. */
    return { record: false, reason: "consent_answer_ambiguous", declined: true };
  }

  if (!P.AGREEMENT_ANSWERS.includes(value)) {
    /* ── NOTHING FUZZY ───────────────────────────────────────────────────
       No "starts with y", no "not obviously negative". Recording permission
       somebody did not give is a claim GRAV cannot support and will not
       discover until they complain; failing to record one they did give costs
       a marketing email. */
    return { record: false, reason: "consent_answer_ambiguous" };
  }

  return {
    record: true,
    reason: "consent_recorded",
    noticeVersion: str(notice.noticeVersion),
    noticeId: str(notice.noticeId),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE STAGE MACHINE
   ═══════════════════════════════════════════════════════════════════════════ */

async function openReceipt({ companyId, lead }) {
  const selector = {
    companyId, leadId: lead._id, contractVersion: P.CONTRACT_VERSION,
  };
  const receipt = await MarketingLeadProcessingReceipt.findOneAndUpdate(
    selector,
    {
      $setOnInsert: { ...selector, submissionRef: lead.submissionRef, stage: "pending_identity" },
      $inc: { attempts: 1 },
      $set: { lastAttemptAt: new Date() },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return receipt;
}

/**
 * Process one submitted enquiry.
 *
 * Safe to call repeatedly. Safe to call after a crash. Safe to call twice at
 * once — every effect is fenced by a unique index rather than by a check.
 *
 * @param {object}   args
 * @param {ObjectId} args.companyId
 * @param {string}   args.submissionRef
 */
async function process({ companyId, submissionRef } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Processing a lead needs a company.");
  const company = new mongoose.Types.ObjectId(String(companyId));

  const lead = await MarketingAdvertisingLead
    .findOne({ companyId: company, submissionRef: str(submissionRef) }).lean();

  if (!lead) {
    return { stage: "refused", reason: "submission_missing" };
  }

  const receipt = await openReceipt({ companyId: company, lead });

  /* Already finished, under this contract version, for this submission, in
     this company. All four checked — a later record alone proves nothing. */
  if (receipt.stage === "completed") {
    return { stage: "completed", reason: receipt.reason, alreadyDone: true };
  }
  if (receipt.stage === "needs_human_review" || receipt.stage === "refused") {
    return { stage: receipt.stage, reason: receipt.reason, alreadyDone: true };
  }

  try {
    /* ── 1. WHO ──────────────────────────────────────────────────────────
       Skipped entirely if the receipt already carries a person. */
    if (!receipt.gravPersonKey) {
      const resolved = await resolveIdentity({ companyId: company, lead });

      if (resolved.outcome === "conflict" || resolved.outcome === "insufficient") {
        receipt.stage = "needs_human_review";
        receipt.reason = resolved.reason;
        await receipt.save();
        /* No engagement, no consent. GRAV does not know whose they would be. */
        return { stage: receipt.stage, reason: receipt.reason };
      }

      receipt.gravPersonKey = resolved.gravPersonKey;
      receipt.identityCreated = resolved.created === true;
      receipt.identityResolvedAt = new Date();
      receipt.stage = "identity_resolved";
      await receipt.save();
    }

    /* ── 2. WHAT THEY DID ────────────────────────────────────────────────
       The ledger's own unique index is the fence; the receipt merely records
       that the effect is done so a resume skips it. */
    if (!receipt.engagementRecordedAt) {
      const engagement = await recordEngagement({
        companyId: company, lead, gravPersonKey: receipt.gravPersonKey,
      });
      receipt.engagementEventKey = engagement.sourceEventId;
      receipt.engagementRecordedAt = new Date();
      receipt.stage = "engagement_recorded";
      await receipt.save();
    }

    /* ── 3. DID THEY AGREE ───────────────────────────────────────────────── */
    if (!receipt.consentEvaluatedAt) {
      const binding = await MarketingLeadDeliveryBinding
        .findOne({ companyId: company, _id: lead.bindingId }).lean();

      const decision = evaluateConsent({ lead, binding });

      if (decision.record) {
        await consent.record({
          companyId: company,
          gravPersonKey: receipt.gravPersonKey,
          channel: "email",
          purpose: "marketing",
          state: "opted_in",
          capturedSource: "google_lead_form",
          capturedAt: lead.submittedAt || lead.receivedAt,
          noticeVersion: decision.noticeVersion,
          evidenceRef: lead.submissionRef,
          /* Stable, so a replay is the same command rather than a second
             history row saying the same thing twice. */
          commandKey: `google-lead-consent:${lead.submissionRef}`,
        });
      }

      receipt.consentRecorded = decision.record === true;
      receipt.reason = decision.reason;
      receipt.consentEvaluatedAt = new Date();
      receipt.stage = "consent_evaluated";
      await receipt.save();
    }

    receipt.stage = "completed";
    receipt.completedAt = new Date();
    await receipt.save();

    return { stage: "completed", reason: receipt.reason };
  } catch (err) {
    /* ── RETRYABLE, AND THE DETAIL GOES TO THE LOG ───────────────────────
       The receipt keeps a stage and a count. A driver message written onto it
       would end up in monitoring, in a support ticket and on a screen. */
    console.error(`[lead-processing] ${str(submissionRef)} failed: ${str(err?.message).slice(0, 200)}`);
    receipt.stage = "retryable_failure";
    await receipt.save();
    return { stage: "retryable_failure" };
  }
}

module.exports = {
  process,
  __internals: { resolveIdentity, recordEngagement, evaluateConsent, strongIdentifiers, eventKeyFor, normalizeEmail },
};
