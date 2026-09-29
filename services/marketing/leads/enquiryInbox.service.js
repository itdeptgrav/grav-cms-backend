// services/marketing/leads/enquiryInbox.service.js
//
// THE MARKETING ENQUIRIES INBOX: RECORDED SUBMISSIONS, WITH WHAT GRAV DID.
//
// ── READS ONLY ─────────────────────────────────────────────────────────────
// Two existing records are joined at read time: the submission (append-only
// evidence) and its processing receipt under the current contract version.
// Nothing here writes: no receipt is opened, no processing is started, and no
// Sales Lead, enquiry, journey, activity or handover is created. Reading an
// enquiry is not acting on it.
//
// ── TWO KINDS OF RECORD, ONE INBOX ─────────────────────────────────────────
// Google lead-form submissions (MarketingAdvertisingLead, joined to their
// processing receipts) and lead-source enquiries (MarketingSourceEnquiry —
// IndiaMART) are merged at read time. A lead-source enquiry has no campaign,
// is never processed automatically, and carries no marketing permission,
// because the source never asks: it reads `not_processed` and
// `no_permission_recorded` / `source_does_not_ask`, fixed, and nothing is
// stored to say so.
//
// ── COMPANY FIRST, IN EVERY SELECTOR ───────────────────────────────────────
// The caller's company is the first term of every query, including the join to
// receipts and the lookup of plan names. A reference from another company is
// indistinguishable from one that does not exist.
//
// ── WHAT NEVER LEAVES ──────────────────────────────────────────────────────
// Fields are projected in, not filtered out: the database id, Google's
// submission, campaign and form ids, the binding and deployment, the click id,
// lead source/stage, API version, receipt stage names, attempt counts and
// retry times are never read into this service's output at all.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const { MarketingAdvertisingLead } = require("../../../models/CMS_Models/Marketing/MarketingAdvertisingLead");
const { MarketingLeadProcessingReceipt } = require("../../../models/CMS_Models/Marketing/MarketingLeadProcessingReceipt");
const { MarketingCampaignDraft } = require("../../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const { MarketingSourceEnquiry } = require("../../../models/CMS_Models/Marketing/MarketingSourceEnquiry");
const draftIdentity = require("../campaignDrafts/draftIdentity");
const P = require("../../../constants/marketingLeadProcessing");
const E = require("../../../constants/marketingEnquiries");
const I = require("../../../constants/marketingIndiamart");
const indiamartRouting = require("./indiamartRouting.read");

const str = (v) => String(v ?? "").trim();
const arr = (v) => (Array.isArray(v) ? v : []);

const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/* The only receipt fields read. Enough to derive the public view and nothing
   about retries. */
const RECEIPT_FIELDS = {
  stage: 1, reason: 1, gravPersonKey: 1, identityCreated: 1,
  engagementRecordedAt: 1, consentEvaluatedAt: 1, consentRecorded: 1,
  completedAt: 1, submissionRef: 1, updatedAt: 1,
};

/* ── THE DERIVATION ─────────────────────────────────────────────────────── */

const STAGE_TO_PROCESSING = Object.freeze(Object.fromEntries(
  E.PROCESSING.flatMap((p) => p.stages.map((s) => [s, p.code])),
));

function processingOf(receipt) {
  if (!receipt) return "processing";
  return STAGE_TO_PROCESSING[receipt.stage] || "processing";
}

/* Unknown until processing has evaluated permission. Nothing else — not a
   review hold, not a failure, not the absence of a receipt — is an outcome. */
function consentOf(receipt) {
  if (!receipt || !receipt.consentEvaluatedAt) return { outcome: "unknown", basis: null };
  const basis = E.CONSENT_BASIS_CODES.includes(receipt.reason) ? receipt.reason : null;
  return {
    outcome: receipt.consentRecorded === true ? "permission_recorded" : "no_permission_recorded",
    basis,
  };
}

function reviewReasonOf(receipt) {
  if (!receipt || receipt.stage !== "needs_human_review") return null;
  return E.REVIEW_REASON_CODES.includes(receipt.reason) ? receipt.reason : null;
}

/* The receipt's own public view, plus the fact the inbox itself proves. */
function statesOf(receipt) {
  if (!receipt) return ["lead_recorded", "processing_incomplete"];
  const view = MarketingLeadProcessingReceipt.hydrate(receipt).publicView();
  return ["lead_recorded", ...view.states];
}

function statusOf(receipt) {
  const consent = consentOf(receipt);
  return {
    processing: processingOf(receipt),
    consent: consent.outcome,
    consentBasis: consent.basis,
    reviewReason: reviewReasonOf(receipt),
    states: statesOf(receipt),
  };
}

/* A lead-source enquiry: fixed, because nothing processes it and the source
   never asks for permission. */
const SOURCE_STATUS = Object.freeze({
  processing: "not_processed",
  consent: "no_permission_recorded",
  consentBasis: "source_does_not_ask",
  reviewReason: null,
  states: Object.freeze(["lead_recorded"]),
});
const sourceStatus = () => ({ ...SOURCE_STATUS, states: [...SOURCE_STATUS.states] });

const GOOGLE_SOURCE = "google_lead_form";
const GOOGLE_KIND = "buyer_enquiry";

/* ── THE CONTACT, TWO WAYS ─────────────────────────────────────────────── */

const nameOf = (c = {}) => str(c.fullName) || [str(c.firstName), str(c.lastName)].filter(Boolean).join(" ");

/* The list row: who, and whether they can be reached — never the address. */
function contactSummary(c = {}) {
  return {
    name: nameOf(c),
    companyName: str(c.companyName),
    hasEmail: Boolean(str(c.email) || str(c.workEmail)),
    hasPhone: Boolean(str(c.phone) || str(c.workPhone)),
  };
}

/* The same summary for a lead-source enquiry, which has alternate numbers. */
function sourceContactSummary(c = {}) {
  return {
    name: str(c.fullName),
    companyName: str(c.companyName),
    hasEmail: Boolean(str(c.email) || str(c.emailAlt)),
    hasPhone: Boolean(str(c.phone) || str(c.phoneAlt) || str(c.landline) || str(c.landlineAlt)),
  };
}

/* The detail: every field the person supplied, in a fixed order, each marked
   as what it is — something they typed. */
function suppliedContact(c = {}) {
  return E.CONTACT_FIELD_ORDER
    .filter((field) => str(c[field]))
    .map((field) => ({
      field,
      code: E.CONTACT_CODE_BY_FIELD[field] || null,
      label: E.CONTACT_LABELS[field],
      value: str(c[field]),
      provenance: "self_reported",
    }));
}

/* A question code is a closed Google enum value. Anything that looks like an
   identifier rather than a code is not published as one. */
const safeCode = (code) => {
  const c = str(code);
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(c) ? c : "UNRECOGNISED_QUESTION";
};

/* ── THE PLAN EACH ENQUIRY CAME FROM ────────────────────────────────────── */

async function campaignsFor(companyId, draftIds, env) {
  const ids = [...new Set(draftIds.map(String))].map((id) => new mongoose.Types.ObjectId(id));
  const rows = ids.length
    ? await MarketingCampaignDraft.find({ companyId, _id: { $in: ids } }).select("draftRef name").lean()
    : [];
  const byId = new Map(rows.map((r) => [String(r._id), r]));
  return (draftId, draftRef) => {
    const plan = byId.get(String(draftId));
    let signed = null;
    if (plan) {
      /* The same signed identifier the plans screen uses, so a row can link
         to its plan. Without the signing secret the link is simply absent. */
      try {
        signed = draftIdentity.encodeDraftId({ companyId: str(companyId), draftId: str(plan._id) }, env);
      } catch (_) {
        signed = null;
      }
    }
    return {
      campaignDraftId: signed,
      draftRef: str(plan?.draftRef) || str(draftRef),
      name: str(plan?.name),
    };
  };
}

/* ── INPUT ──────────────────────────────────────────────────────────────── */

const LIST_PARAMS = ["page", "limit", "campaign", "processing", "consent", "source", "kind"];

function wholeNumber(raw, field, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = /^\d+$/.test(str(raw)) ? Number(str(raw)) : NaN;
  if (!Number.isInteger(n) || n < min || (max && n > max)) {
    throw fail("VALIDATION",
      max ? `${field} must be a whole number between ${min} and ${max}.` : `${field} must be a whole number of ${min} or more.`,
      { field });
  }
  return n;
}

function oneOf(raw, field, allowed) {
  const v = str(raw);
  if (!v) return null;
  if (!allowed.includes(v)) {
    throw fail("VALIDATION", `${field} must be one of: ${allowed.join(", ")}.`, { field, allowed });
  }
  return v;
}

function parseListQuery(query = {}) {
  const unknown = Object.keys(query).filter((k) => !LIST_PARAMS.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION", `Unknown filter. The enquiries list accepts: ${LIST_PARAMS.join(", ")}.`, { unknown });
  }
  const campaign = str(query.campaign);
  if (campaign && !REF_PATTERN.test(campaign)) {
    throw fail("VALIDATION", "campaign must be a campaign plan reference.", { field: "campaign" });
  }
  return {
    page: wholeNumber(query.page, "page", { min: 1, fallback: 1 }),
    limit: wholeNumber(query.limit, "limit", { min: 1, max: E.PAGE.MAX, fallback: E.PAGE.DEFAULT }),
    campaign: campaign || null,
    processing: oneOf(query.processing, "processing", E.PROCESSING_CODES),
    consent: oneOf(query.consent, "consent", E.CONSENT_CODES),
    source: oneOf(query.source, "source", E.SOURCE_CODES),
    kind: oneOf(query.kind, "kind", E.KIND_CODES),
  };
}

/* Which records a filter can match at all. A lead-source enquiry has no
   campaign and a fixed status; a lead-form submission is always a buyer
   enquiry and is never `not_processed`. */
function branchesFor(q) {
  const google = (!q.source || q.source === GOOGLE_SOURCE)
    && (!q.kind || q.kind === GOOGLE_KIND)
    && q.processing !== SOURCE_STATUS.processing;
  const leadSource = (!q.source || q.source !== GOOGLE_SOURCE)
    && !q.campaign
    && (!q.processing || q.processing === SOURCE_STATUS.processing)
    && (!q.consent || q.consent === SOURCE_STATUS.consent);
  return { google, leadSource };
}

/* A filter on derived status, expressed against the joined receipt `r`. A
   missing receipt is `processing` and `unknown`, exactly as the view says. */
function statusMatch({ processing, consent }) {
  const and = [];
  if (processing) {
    const stages = E.PROCESSING.find((p) => p.code === processing).stages;
    and.push(processing === "processing"
      ? { $or: [{ r: null }, { "r.stage": { $in: [...stages] } }, { "r.stage": { $nin: P.STAGE_CODES } }] }
      : { "r.stage": { $in: [...stages] } });
  }
  if (consent === "unknown") {
    and.push({ $or: [{ r: null }, { "r.consentEvaluatedAt": null }] });
  } else if (consent) {
    and.push({ "r.consentEvaluatedAt": { $ne: null } });
    and.push(consent === "permission_recorded"
      ? { "r.consentRecorded": true }
      : { "r.consentRecorded": { $ne: true } });
  }
  return and.length ? { $and: and } : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIST
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * One page of the company's recorded enquiries, newest received first.
 *
 * @param {object} args
 * @param {ObjectId} args.companyId  the caller's company — never a parameter
 * @param {object}   [args.query]    page, limit, campaign, processing, consent,
 *                                   source, kind
 */
async function list({ companyId, query = {}, env = process.env } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "The enquiries inbox needs a company.");
  const company = new mongoose.Types.ObjectId(String(companyId));
  const q = parseListQuery(query);

  const match = { companyId: company, classification: "production" };
  if (q.campaign) match.draftRef = q.campaign;

  const filter = statusMatch(q);
  const branches = branchesFor(q);

  /* Lead-source enquiries, in the same row shape. Projected in: the source's
     own id never enters the pipeline. */
  const sourceMatch = { companyId: company };
  if (q.source && q.source !== GOOGLE_SOURCE) sourceMatch.source = q.source;
  if (q.kind) sourceMatch.kind = q.kind;
  const leadSourceBranch = {
    $unionWith: {
      coll: MarketingSourceEnquiry.collection.name,
      pipeline: [
        { $match: sourceMatch },
        {
          $project: {
            companyId: 1, submissionRef: 1, submittedAt: 1, receivedAt: 1, source: 1, kind: 1,
            "contact.fullName": 1, "contact.companyName": 1,
            "contact.email": 1, "contact.emailAlt": 1,
            "contact.phone": 1, "contact.phoneAlt": 1, "contact.landline": 1, "contact.landlineAlt": 1,
            fromLeadSource: { $literal: true },
          },
        },
      ],
    },
  };

  const [out] = await MarketingAdvertisingLead.aggregate([
    { $match: match },
    /* A filter only lead-source enquiries can satisfy reads no submissions. */
    ...(branches.google ? [] : [{ $match: { _id: null } }]),
    /* Projected in. Provider ids and everything else stay in the database. */
    {
      $project: {
        companyId: 1, submissionRef: 1, campaignDraftId: 1, draftRef: 1,
        submittedAt: 1, receivedAt: 1, ingestionOrigin: 1,
        "contact.fullName": 1, "contact.firstName": 1, "contact.lastName": 1,
        "contact.companyName": 1, "contact.email": 1, "contact.workEmail": 1,
        "contact.phone": 1, "contact.workPhone": 1,
      },
    },
    {
      $lookup: {
        from: MarketingLeadProcessingReceipt.collection.name,
        let: { lead: "$_id", company: "$companyId" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$companyId", "$$company"] },
                  { $eq: ["$leadId", "$$lead"] },
                  { $eq: ["$contractVersion", P.CONTRACT_VERSION] },
                ],
              },
            },
          },
          { $project: { _id: 0, ...RECEIPT_FIELDS } },
          { $limit: 1 },
        ],
        as: "receipts",
      },
    },
    { $addFields: { r: { $arrayElemAt: ["$receipts", 0] } } },
    { $project: { receipts: 0 } },
    ...(filter ? [{ $match: filter }] : []),
    ...(branches.leadSource ? [leadSourceBranch] : []),
    { $sort: { receivedAt: -1, _id: -1 } },
    {
      $facet: {
        rows: [{ $skip: (q.page - 1) * q.limit }, { $limit: q.limit }],
        total: [{ $count: "n" }],
      },
    },
  ]);

  const rows = arr(out?.rows);
  const total = out?.total?.[0]?.n || 0;
  const campaignOf = await campaignsFor(
    company,
    rows.filter((r) => !r.fromLeadSource).map((r) => r.campaignDraftId),
    env,
  );

  return {
    enquiries: rows.map((row) => (row.fromLeadSource
      ? {
        submissionRef: row.submissionRef,
        receivedAt: row.receivedAt,
        submittedAt: row.submittedAt || null,
        ingestionOrigin: "pull",
        source: row.source,
        kind: row.kind,
        campaign: null,
        contact: sourceContactSummary(row.contact),
        ...sourceStatus(),
      }
      : {
        submissionRef: row.submissionRef,
        receivedAt: row.receivedAt,
        submittedAt: row.submittedAt || null,
        ingestionOrigin: row.ingestionOrigin,
        source: GOOGLE_SOURCE,
        kind: GOOGLE_KIND,
        campaign: campaignOf(row.campaignDraftId, row.draftRef),
        contact: contactSummary(row.contact),
        ...statusOf(row.r || null),
      })),
    page: {
      number: q.page,
      size: q.limit,
      total,
      pages: Math.ceil(total / q.limit),
    },
    filters: {
      campaign: q.campaign, processing: q.processing, consent: q.consent, source: q.source, kind: q.kind,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   DETAIL
   ═══════════════════════════════════════════════════════════════════════════ */

const NOT_FOUND = () => fail("NOT_FOUND", "That enquiry is not one GRAV can show you.");

/**
 * One enquiry: what the person supplied, the questions they answered, and
 * what GRAV has done with it.
 */
async function detail({ companyId, submissionRef, env = process.env } = {}) {
  if (!companyId) throw fail("TENANT_MEMBERSHIP_UNPROVEN", "The enquiries inbox needs a company.");
  const ref = str(submissionRef);
  if (!REF_PATTERN.test(ref)) throw NOT_FOUND();
  const company = new mongoose.Types.ObjectId(String(companyId));
  if (/^MSE-/.test(ref)) return sourceDetail(company, ref);

  const lead = await MarketingAdvertisingLead
    .findOne({ companyId: company, submissionRef: ref, classification: "production" })
    .select("submissionRef campaignDraftId draftRef submittedAt receivedAt ingestionOrigin contact answers unmapped phoneVerified")
    .lean();
  if (!lead) throw NOT_FOUND();

  const receipt = await MarketingLeadProcessingReceipt
    .findOne({ companyId: company, leadId: lead._id, contractVersion: P.CONTRACT_VERSION })
    .select(Object.keys(RECEIPT_FIELDS).join(" "))
    .lean();

  const campaignOf = await campaignsFor(company, [lead.campaignDraftId], env);

  return {
    submissionRef: lead.submissionRef,
    receivedAt: lead.receivedAt,
    submittedAt: lead.submittedAt || null,
    ingestionOrigin: lead.ingestionOrigin,
    source: GOOGLE_SOURCE,
    kind: GOOGLE_KIND,
    campaign: campaignOf(lead.campaignDraftId, lead.draftRef),
    contact: contactSummary(lead.contact),
    supplied: suppliedContact(lead.contact),
    answers: arr(lead.answers).map((a) => ({
      code: safeCode(a.code),
      question: str(a.question),
      answer: str(a.answer),
      selfReported: true,
      provenance: "self_reported",
    })),
    unmapped: arr(lead.unmapped).map((u) => ({
      code: safeCode(u.code),
      answer: str(u.answer),
      selfReported: true,
      needsReview: true,
      provenance: "self_reported",
    })),
    phoneVerified: typeof lead.phoneVerified === "boolean" ? lead.phoneVerified : null,
    enquiryContext: null,
    ...statusOf(receipt || null),
    lastProcessedAt: receipt?.updatedAt || null,
  };
}

/* One lead-source enquiry: everything the source sent under GRAV's names,
   the context of the enquiry, and the fixed status. The source's own id is
   never selected. */
async function sourceDetail(company, ref) {
  const row = await MarketingSourceEnquiry
    .findOne({ companyId: company, submissionRef: ref })
    .select("submissionRef source kind sourceType submittedAt submittedAtText receivedAt contact context")
    .lean();
  if (!row) throw NOT_FOUND();
  const c = row.contact || {};
  const x = row.context || {};
  const type = I.QUERY_TYPES[str(row.sourceType)] || null;
  const present = (v) => v !== null && v !== undefined && str(v) !== "";
  return {
    submissionRef: row.submissionRef,
    receivedAt: row.receivedAt,
    submittedAt: row.submittedAt || null,
    ingestionOrigin: "pull",
    source: row.source,
    kind: row.kind,
    campaign: null,
    contact: sourceContactSummary(c),
    supplied: I.CONTACT_FIELDS
      .filter(({ field }) => str(c[field]))
      .map(({ field, code, label }) => ({ field, code, label, value: str(c[field]), provenance: "source_reported" })),
    answers: [],
    unmapped: [],
    phoneVerified: null,
    enquiryContext: {
      sourceType: type ? { code: type.code, label: type.label } : (str(row.sourceType) ? { code: str(row.sourceType), label: "Unrecognised type" } : null),
      /* The name was IndiaMART's placeholder, not the buyer's. */
      nameIsPlaceholder: Boolean(c.nameIsPlaceholder),
      /* The source's own time text, kept because it may not be readable. */
      submittedAtAsSent: str(row.submittedAtText) || null,
      fields: I.CONTEXT_FIELDS
        .filter(({ field }) => present(x[field]))
        .map(({ field, code, label }) => ({
          field, code, label, value: field === "callDurationSeconds" ? x[field] : str(x[field]),
        })),
    },
    ...sourceStatus(),
    lastProcessedAt: null,
    /* Where GRAV sent it: to Sales through the handover, held for review, or
       kept out — with delivery and Sales' decision. Null until routed. */
    salesRouting: await indiamartRouting.forEnquiry({ companyId: company, submissionRef: row.submissionRef }),
  };
}

/* ── VOCABULARY ─────────────────────────────────────────────────────────── */

const view = (x) => ({ code: x.code, label: x.label, means: x.means });

const vocabulary = Object.freeze({
  processing: E.PROCESSING.map(view),
  consent: E.CONSENT.map(view),
  consentBases: E.CONSENT_BASES.map(view),
  reviewReasons: E.REVIEW_REASONS.map(view),
  states: P.PUBLIC_STATES.map(view),
  ingestionOrigins: E.INGESTION_ORIGINS.map(view),
  sources: E.SOURCES.map(view),
  kinds: E.KINDS.map((k) => ({ ...view(k), isEnquiry: k.isEnquiry })),
  contactFields: E.CONTACT_FIELD_ORDER.map((field) => ({
    field, code: E.CONTACT_CODE_BY_FIELD[field] || null, label: E.CONTACT_LABELS[field],
  })),
  provenance: Object.values(E.PROVENANCE).map(view),
  phoneVerified: { means: E.PHONE_VERIFIED.means },
  unmapped: { means: E.UNMAPPED.means },
  page: { defaultSize: E.PAGE.DEFAULT, maxSize: E.PAGE.MAX },
});

module.exports = {
  list,
  detail,
  vocabulary,
  __internals: { statusOf, consentOf, processingOf, contactSummary, suppliedContact, parseListQuery },
};
