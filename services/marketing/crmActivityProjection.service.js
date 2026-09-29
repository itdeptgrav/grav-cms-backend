// services/marketing/crmActivityProjection.service.js
//
// THE FEW MARKETING MILESTONES SALES SHOULD SEE, AND NOTHING ELSE.
//
// ── THE RULE THIS FILE EXISTS TO KEEP ──────────────────────────────────────
// "The CRM Activity timeline receives useful marketing milestones … Raw
// delivery telemetry stays in the marketing event store." A salesperson opening
// a Prospect wants to know that somebody asked for a sample, clicked the thing
// they were sent, or unsubscribed. They do not want four hundred rows saying an
// email was delivered, and the moment the timeline contains those it stops
// being a timeline and becomes a log nobody reads.
//
// So the projection is an ALLOWLIST, not a filter. A kind that is not named
// here is not projected, and adding one is a visible edit to this file.
//
// ── IT NEVER INVENTS A PERSON ──────────────────────────────────────────────
// An Activity attaches to a canonical Sales record that already exists. If the
// marketing identity has no Sales record linked, nothing is written and the
// receipt says why — the alternative, creating a Lead or Contact because a
// tracking pixel fired, would let marketing telemetry manufacture customers.
//
// ── AND IT CHANGES NO LIFECYCLE ────────────────────────────────────────────
// This module writes exactly one collection: CRMActivity. It does not touch a
// Lead's captureStatus, reviewStatus or qualificationState, it creates no
// Enquiry or Sales Journey, and it holds no path to the services that do.
"use strict";

const mongoose = require("mongoose");

const Activity = require("../../models/CMS_Models/Sales/Activity");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/* ── THE ALLOWLIST ──────────────────────────────────────────────────────────
   Each entry says which CRM activity type the milestone becomes and how to
   phrase it. `email_opened`, `email_sent`, `email_delivered` and `page_viewed`
   are absent BY DESIGN: an open is a proxy fetch, a send is our own act, a
   delivery is a provider receipt, and a page view is browsing. None is a thing
   a salesperson should be told about individually. */
const PROJECTABLE = Object.freeze({
  form_submitted: {
    activityType: "email_log",
    summary: (e) => `Marketing: submitted ${e.assetName || "a form"}`,
  },
  callback_requested: {
    activityType: "email_log",
    summary: () => "Marketing: requested a callback",
  },
  quotation_requested: {
    activityType: "email_log",
    summary: () => "Marketing: requested a quotation",
  },
  sample_requested: {
    activityType: "email_log",
    summary: () => "Marketing: requested a sample",
  },
  consultation_requested: {
    activityType: "email_log",
    summary: () => "Marketing: requested a consultation",
  },
  email_clicked: {
    activityType: "email_log",
    summary: (e) => `Marketing: clicked a link in ${e.assetName || "a campaign email"}`,
  },
  email_unsubscribed: {
    activityType: "note",
    summary: () => "Marketing: unsubscribed from marketing email",
  },
  email_bounced: {
    activityType: "note",
    /* Only a confirmed-or-unclassifiable bounce reaches here — see
       `isProjectable`. A soft bounce is a full mailbox, not news.

       ── WHAT HAPPENED, NOT WHAT IS TRUE NOW ────────────────────────────
       These read "hard-bounced on the 9th", not "is suppressed". A timeline
       entry is a dated record of an event and is never re-read when the world
       moves on: a person who bounced in March and was corrected in April would
       have had a row asserting, in the present tense and for ever, that they
       cannot be emailed. The consent record answers what is true now; this
       answers what happened. */
    summary: (e) => (e.bounceClass === "hard"
      ? "Marketing: email address hard-bounced"
      : "Marketing: email bounced, cause not classified — flagged for review"),
  },
});

/** Is this observation a milestone at all? */
function isProjectable(event) {
  const rule = PROJECTABLE[event.kind];
  if (!rule) return false;
  /* A soft bounce is temporary and is never projected: it would put "bounced"
     in front of a salesperson about a mailbox that was briefly full. */
  if (event.kind === "email_bounced" && event.bounceClass === "soft") return false;
  return true;
}

/**
 * Find the canonical Sales record this marketing person is already linked to.
 *
 * ── READ-ONLY, AND COMPANY-SCOPED ────────────────────────────────────────
 * Follows the link the marketing identity already holds. It performs no search
 * by email and creates nothing: a webhook arriving is not evidence that a
 * customer exists, and the one thing this must never do is manufacture one.
 *
 * @returns {Promise<{type:string, id:ObjectId}|null>}
 */
async function linkedSalesRecord({ companyId, identity }) {
  if (!identity) return null;

  if (identity.salesLeadId) {
    /* Re-read within the company. A link recorded when the person belonged to
       this company must not still resolve if the record has moved. */
    const lead = await Lead.findOne({ _id: identity.salesLeadId, companyId }).select("_id").lean();
    if (lead) return { type: "lead", id: lead._id };
  }
  if (identity.salesAccountId) {
    /* ── VERIFIED, NOT TRUSTED ─────────────────────────────────────────────
       This returned the id straight off the identity row. A marketing identity
       is a Marketing record; the Account it names is a Sales record, and
       whether that Account belongs to THIS company is a fact only the Account
       can answer. Without the read, a stale or mistaken link in company A would
       have attached a timeline entry to company B's customer. */
    const account = await Account.findOne({ _id: identity.salesAccountId, companyId }).select("_id").lean();
    if (account) return { type: "account", id: account._id };
  }
  return null;
}

/**
 * Write the Activity for one observation, once.
 *
 * ── IDEMPOTENT BY INDEX, NOT BY CHECK ─────────────────────────────────────
 * `marketingSourceEventId` carries the observation's key and a partial unique
 * index refuses a second row for it. A read-then-write check is passed by two
 * concurrent replays; the index is not, and a duplicate-key error is then the
 * answer rather than a failure.
 *
 * @returns {Promise<{projected:boolean, duplicate:boolean, activityId, reason:string}>}
 */
async function project({ companyId, event, identity, now = new Date() } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "An Activity projection needs a company.");

  const rule = PROJECTABLE[event.kind];
  if (!isProjectable(event)) {
    return { projected: false, duplicate: false, activityId: null, reason: "NOT_APPLICABLE" };
  }

  const linked = await linkedSalesRecord({ companyId, identity });
  if (!linked) {
    /* No canonical record. Nothing is written and nothing is invented; the
       receipt keeps this pending so it can be projected if the person is later
       linked to a Sales record by somebody who decided to. */
    return { projected: false, duplicate: false, activityId: null, reason: "NO_LINKED_SALES_RECORD" };
  }

  const doc = {
    activityType: rule.activityType,
    subject: rule.summary(event),
    /* A concise human line. No payload, no field dump, no provider text beyond
       the campaign it came from. */
    description: [
      event.campaignName ? `Campaign: ${event.campaignName}` : "",
      event.assetName ? `Asset: ${event.assetName}` : "",
    ].filter(Boolean).join(" · ") || undefined,
    /* ── THE EVENT'S OWN TIME, NEVER THE WEBHOOK'S ────────────────────────
       A retry sweep can deliver a week-old event today. Stamping the timeline
       with arrival time would put it in the wrong place in the story, and the
       story is what the timeline is for. */
    activityDate: event.occurredAt,
    status: "completed",
    completedAt: event.occurredAt,
    [linked.type === "lead" ? "leadId" : "accountId"]: linked.id,
    /* Provenance: which marketing observation produced this, in which company
       and from which source system — the complete identity, because a source
       event id alone is unique only within one Mautic instance. */
    ...provenanceKey({ companyId, event }),
    createdBy: { name: "Marketing" },
    updatedBy: { name: "Marketing" },
  };

  try {
    const created = await Activity.create(doc);
    return {
      projected: true, duplicate: false, activityId: created._id,
      reason: "", salesRecordType: linked.type, salesRecordId: linked.id,
    };
  } catch (err) {
    /* ── NOT EVERY 11000 IS A REPLAY ───────────────────────────────────────
       This treated any duplicate-key error as "already projected". The Activity
       model carries other unique constraints — `activityId` most of all, which
       a `countDocuments() + 1` pre-save hook generates and which therefore
       collides whenever two activities are created at once. Under that reading,
       a concurrency collision on a DIFFERENT index was reported as an
       idempotent replay with `activityId: null`, the receipt went
       ACTIVITY_PROJECTED, and the timeline entry was never written at all.

       A duplicate is a replay only if an activity with THIS company-scoped
       provenance actually exists. Anything else is a real failure and is
       propagated, so the receipt lands ACTIVITY_FAILED and is retried. */
    if (err?.code === 11000) {
      const existing = await findByProvenance({ companyId, event });
      if (existing) {
        return {
          projected: false, duplicate: true, activityId: existing._id,
          reason: "", salesRecordType: linked.type, salesRecordId: linked.id,
        };
      }
    }
    throw err;
  }
}

/** The complete provenance identity. One definition, used to write and to look
 *  up, so the two can never disagree about what "the same event" means. */
const provenanceKey = ({ companyId, event }) => ({
  marketingCompanyId: companyId,
  marketingSource: str(event.source) || "mautic",
  marketingSourceEventId: str(event.sourceEventId),
});

/** The activity this observation already produced in THIS company, or null.
 *  Never another company's — the company is in the selector. */
async function findByProvenance({ companyId, event }) {
  return Activity.findOne(provenanceKey({ companyId, event })).select("_id").lean();
}

module.exports = { project, isProjectable, linkedSalesRecord, findByProvenance, provenanceKey, PROJECTABLE };
