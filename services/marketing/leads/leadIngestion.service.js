// services/marketing/leads/leadIngestion.service.js
//
// TURNING A VERIFIED DELIVERY INTO ONE RECORD, ONCE.
//
// ── THE ONE THING THIS CHUNK DOES, AND WHERE IT STOPS ──────────────────────
// A verified production delivery becomes one immutable lead-submission record.
// That is all. No identity is resolved, no engagement is recorded, no consent
// is written, no prospect is created and nothing reaches Sales. Those are the
// next chunk, and the boundary is enforced by this file importing none of the
// services that would do them.
//
// ── DEDUPLICATION IS THE SECURITY CONTROL, NOT AN OPTIMISATION ─────────────
// Google's delivery is explicitly at-least-once, so the same lead arriving
// twice is ordinary. But verification is a shared secret inside the body
// rather than a signature, which means anybody who has ever seen one delivery
// holds a replayable body. The unique index is what stops that becoming a
// second person, a second engagement and a second prospect in the chunk that
// adds them.
//
// So the duplicate path is deliberately cheap and deliberately silent: it
// answers 200, creates nothing, touches no timestamp, and reveals nothing
// about the record that already exists.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  MarketingAdvertisingLead,
  MarketingAdvertisingLeadTest,
} = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const {
  MarketingLeadDeliveryBinding,
} = require("../../../models/CMS_Models/Marketing/MarketingLeadDeliveryBinding");
const queue = require("./leadProcessingQueue");

const str = (v) => String(v ?? "").trim();

/* GRAV's public identity for a submission. Random rather than derived from
   Google's id, so the public reference discloses nothing about the
   advertising account it came from. */
const submissionRef = () => `MLS-${crypto.randomBytes(9).toString("hex")}`;

const OUTCOMES = Object.freeze({
  RECORDED: "recorded",
  DUPLICATE: "duplicate",
  TEST_RECORDED: "test_recorded",
  TEST_DUPLICATE: "test_duplicate",
  CONFLICT: "conflict",
});

/* ── ONE ENQUIRY THAT ARRIVED BY BOTH ROUTES ────────────────────────────────
   Google delivers a lead by pushing it to the webhook AND keeps it available
   to read back through its API. Nothing Google publishes says the two carry the
   same identifier. If they do — the likely case — deduplication on the id
   already makes them one enquiry and this never fires.

   If they ever differ, the same person's same submission would arrive twice,
   and processing both would give them two engagements. So a NEW enquiry that
   matches one from the OTHER route — same form, same click, within a couple of
   minutes — is kept as evidence and held for a person rather than processed.
   Never merged: GRAV cannot prove they are the same, only that they look it.

   Restricted to the other route on purpose. Two webhook deliveries with
   different ids ARE two leads by Google's own account, and holding one would
   second-guess the one identifier Google does document. */
const SAME_MOMENT_MS = 2 * 60 * 1000;

/* Works from the STORED enquiry rather than the normalised delivery, so the
   recovery sweep can ask the same question about an enquiry whose promise was
   never written — and get the same answer ingestion would have given. */
async function looksAlreadyReceived(stored) {
  const clickId = str(stored.clickId);
  if (!clickId) return false;

  const otherRoute = stored.ingestionOrigin === "recovery" ? "delivery" : "recovery";
  const candidates = await MarketingAdvertisingLead.find({
    companyId: stored.companyId,
    bindingId: stored.bindingId,
    clickId,
    ingestionOrigin: otherRoute,
    _id: { $ne: stored._id },
  }).select("submittedAt").lean();

  if (!candidates.length) return false;

  const mine = stored.submittedAt ? new Date(stored.submittedAt).getTime() : NaN;
  return candidates.some((c) => {
    const theirs = c.submittedAt ? new Date(c.submittedAt).getTime() : NaN;
    /* If either time is unknown, a matching click from the other route is
       treated as a probable duplicate — holding costs a person a look;
       processing twice costs somebody a second engagement they never made. */
    if (!Number.isFinite(mine) || !Number.isFinite(theirs)) return true;
    return Math.abs(mine - theirs) <= SAME_MOMENT_MS;
  });
}

/**
 * Write the durable promise that this stored enquiry will be processed.
 * Idempotent: an existing receipt is left exactly as it is.
 *
 * @param {object} stored  the MarketingAdvertisingLead document
 */
async function promiseProcessing(stored) {
  const held = await looksAlreadyReceived(stored);
  return queue.enqueue({
    companyId: stored.companyId,
    leadId: stored._id,
    submissionRef: stored.submissionRef,
    holdReason: held ? "possible_duplicate_submission" : "",
  });
}

/**
 * Record one verified delivery.
 *
 * @param {object} args
 * @param {object} args.binding   the resolved, enabled delivery binding
 * @param {object} args.lead      the normalised lead
 * @returns {{outcome: string, submissionRef?: string}}
 */
async function record({ binding, lead } = {}) {
  const companyId = binding.companyId;
  const providerSubmissionId = str(lead.providerLeadId);

  if (!providerSubmissionId) {
    /* Without it nothing can be deduplicated, and at-least-once delivery
       guarantees there will be a second copy. */
    return { outcome: OUTCOMES.CONFLICT, reason: "missing_submission_id" };
  }

  /* ── A TEST DELIVERY NEVER BECOMES A PERSON ──────────────────────────────
     Google sends these from a button, carrying "John Doe" and a real-looking
     phone number. Somebody checking a connection wants to know it arrived and
     verified; nobody wants a fictional person in the Marketing records, and
     nobody should be ringing that number.

     Four facts and no person. The sample name, email and phone are dropped
     here — before any write — rather than stored and filtered later, because
     a filter is something a future query can forget to apply. */
  if (lead.isTest) {
    try {
      await MarketingAdvertisingLeadTest.create({
        companyId,
        bindingId: binding._id,
        channel: lead.channel,
        providerSubmissionId,
        receivedAt: new Date(),
        apiVersion: str(lead.apiVersion),
        verified: true,
      });
      return { outcome: OUTCOMES.TEST_RECORDED };
    } catch (err) {
      if (err?.code === 11000) return { outcome: OUTCOMES.TEST_DUPLICATE };
      throw err;
    }
  }

  const ref = submissionRef();

  let created;
  try {
    created = await MarketingAdvertisingLead.create({
      companyId,
      submissionRef: ref,
      channel: lead.channel,

      campaignDraftId: binding.campaignDraftId,
      draftRef: binding.draftRef,
      approvedRevision: binding.approvedRevision,
      deploymentId: binding.deploymentId,
      bindingId: binding._id,

      providerSubmissionId,
      /* Correlation evidence, backend-only. Taken from the normalised lead,
         which read them out of the raw body as text so a large int64 kept its
         digits. */
      providerCampaignId: str(lead.correlation?.campaignId),
      providerFormId: str(lead.correlation?.formId),

      submittedAt: lead.submittedAt ? new Date(lead.submittedAt) : null,
      receivedAt: new Date(),

      contact: lead.contact || {},
      answers: lead.answers || [],
      unmapped: (lead.unmapped || []).map((u) => ({
        code: u.code, answer: u.answer, selfReported: true, needsReview: true,
      })),
      phoneVerified: lead.phoneVerified,

      clickId: str(lead.clickId),
      leadSource: str(lead.source),
      leadStage: str(lead.stage),
      apiVersion: str(lead.apiVersion),

      ingestionOrigin: lead.receivedVia === "recovery" ? "recovery" : "delivery",
      classification: "production",
    });

    /* ── THE DURABLE PROMISE, WRITTEN WITH THE ENQUIRY ─────────────────────
       Before Google is answered. If GRAV dies between answering and
       processing, this receipt is what tells the recovery sweep the work is
       owed — without it the enquiry would sit unprocessed with nothing
       anywhere to say so.

       A failure to write it is not a reason to refuse Google: the enquiry
       itself is safe, and the sweep also looks for enquiries that have no
       receipt at all. So it is logged and the delivery still succeeds. */
    await promiseProcessing(created).catch((err) => {
      console.error(`[lead-ingestion] processing promise not written: ${str(err?.message).slice(0, 160)}`);
    });

    /* ── THE NOTICE IS NOW SETTLED ───────────────────────────────────────
       A lead has arrived under this binding's recorded permission wording, so
       the wording stops being editable. Changing it afterwards would
       re-describe consent somebody already gave. */
    if (!binding.noticeSettledAt) {
      await MarketingLeadDeliveryBinding.updateOne(
        { _id: binding._id, companyId, noticeSettledAt: null },
        { $set: { noticeSettledAt: new Date() } },
      );
    }

    return { outcome: OUTCOMES.RECORDED, submissionRef: ref };
  } catch (err) {
    if (err?.code === 11000) {
      /* ── THE DUPLICATE PATH ────────────────────────────────────────────
         Nothing is read back, nothing is compared and nothing is updated.

         A different payload arriving under an id GRAV already holds is not an
         opportunity to correct the record — the first one is the evidence,
         and overwriting it would let anybody who replays a body with edits
         rewrite what somebody typed. It is noted by code alone: no submitted
         value is logged, because those are a person's details. */
      return { outcome: OUTCOMES.DUPLICATE };
    }
    throw err;
  }
}

/* ── WHAT THIS CHUNK DELIBERATELY DOES NOT DO ───────────────────────────────
   Stated as data so the handoff and the tests read the same list, and so the
   next chunk starts from a written boundary rather than a memory of one. */
const NOT_IN_THIS_CHUNK = Object.freeze([
  "identity_resolution",
  "engagement",
  "consent",
  "prospect_handover",
  "sales_record",
  /* Reconciliation exists (leadReconciliation.service.js) and calls INTO
     this file; this file never calls it. */
  "api_reconciliation",
  "campaign_creation",
]);

module.exports = {
  record,
  OUTCOMES,
  NOT_IN_THIS_CHUNK,
  promiseProcessing,
};
