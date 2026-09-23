// constants/marketingEnquiries.js
//
// WHAT THE MARKETING ENQUIRIES INBOX MAY SAY ABOUT A SUBMITTED ENQUIRY.
//
// ── DERIVED, NEVER STORED ──────────────────────────────────────────────────
// Every code here is computed at read time from two records that already
// exist: the submission (evidence, append-only) and its processing receipt
// (what GRAV decided). The inbox adds no third record and no status field.
//
// ── PERMISSION IS UNKNOWN UNTIL PROCESSING DECIDES IT ──────────────────────
// "No permission recorded" is a conclusion GRAV reaches when it evaluates the
// submission against the form's recorded wording. Before that evaluation there
// is no conclusion at all, and showing "no permission" would state one — so an
// enquiry still being processed, held for review, or not yet picked up reads
// `unknown`, never `no_permission_recorded`.
"use strict";

const P = require("./marketingLeadProcessing");
const W = require("./marketingGoogleLeadWebhook");
const { ANSWER_PROVENANCE } = require("./marketingGoogleLeadForm");
const I = require("./marketingIndiamart");

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── WHERE PROCESSING IS ────────────────────────────────────────────────────
   Four answers a marketer can act on. A temporary failure and a retry are
   GRAV's machinery and read as `processing`: the enquiry is safe either way. */
const PROCESSING = [
  pair("processing", "Being processed", {
    means: "GRAV has the enquiry and has not finished working through it.",
    stages: freeze(["pending_identity", "identity_resolved", "engagement_recorded", "consent_evaluated", "retryable_failure"]),
  }),
  pair("needs_review", "Needs a person to look", {
    means: "GRAV cannot safely decide something about this enquiry on its own and has stopped until somebody looks.",
    stages: freeze(["needs_human_review"]),
  }),
  pair("finished", "Processed", {
    means: "Everything GRAV does with a submitted enquiry has been done.",
    stages: freeze(["completed"]),
  }),
  pair("cannot_process", "Cannot be processed", {
    means: "This enquiry cannot be processed, and trying again would not change that.",
    stages: freeze(["refused"]),
  }),
  /* A lead-source enquiry (IndiaMART). It is recorded exactly as sent and is
     never run through automatic processing, so no receipt stage maps here. */
  pair("not_processed", "Not processed automatically", {
    means: "GRAV recorded this record exactly as the source sent it, and it does not go through Marketing's automatic processing: no marketing permission is recorded from it. Only a buyer enquiry is sent on to Sales, through the Marketing handover; where it went is shown with the record.",
    stages: freeze([]),
  }),
];
const PROCESSING_CODES = codes(PROCESSING);

/* ── MARKETING PERMISSION ───────────────────────────────────────────────── */
const CONSENT = [
  pair("unknown", "Not known yet", {
    means: "GRAV has not yet decided whether this enquiry carries marketing permission. It is not a no.",
  }),
  pair("permission_recorded", "Agreed to marketing", {
    means: "This person explicitly agreed to the wording the form showed.",
  }),
  pair("no_permission_recorded", "No marketing permission", {
    means: "No marketing permission is recorded for this person. That is not the same as them saying no, and it changes nothing else about this record.",
  }),
];
const CONSENT_CODES = codes(CONSENT);

/* Why a permission outcome is what it is. Only reasons processing records when
   it evaluates permission — never an identity or duplicate reason. */
const CONSENT_BASES = freeze([
  ...P.REASONS
    .filter((r) => r.stage === "consent_evaluated")
    .map((r) => pair(r.code, r.label, { means: r.means })),
  /* Not a processing outcome: a fact about the source. IndiaMART has no
     marketing-permission question, so there is nothing to evaluate. */
  pair("source_does_not_ask", "The source does not ask", {
    means: "This source never asks for marketing permission, so none can be recorded. Answering a request somebody made is a separate matter from marketing to them.",
  }),
]);
const CONSENT_BASIS_CODES = codes(CONSENT_BASES);

/* Why an enquiry is held for a person. */
const REVIEW_REASONS = freeze(P.REASONS
  .filter((r) => r.stage === "needs_human_review")
  .map((r) => pair(r.code, r.label, { means: r.means })));
const REVIEW_REASON_CODES = codes(REVIEW_REASONS);

const INGESTION_ORIGINS = [
  pair("delivery", "Delivered by the form", {
    means: "The advertising channel sent this enquiry to GRAV when it was submitted.",
  }),
  pair("recovery", "Recovered", {
    means: "GRAV fetched this enquiry from the advertising channel after the delivery did not arrive.",
  }),
  pair("pull", "Fetched from the source", {
    means: "GRAV fetched this record from the lead source, on its schedule or when an administrator checked.",
  }),
];

/* ── WHERE AN ENQUIRY CAME FROM, AND WHAT KIND OF CONTACT IT IS ─────────── */
const SOURCES = [
  pair("google_lead_form", "Google lead form", {
    means: "Submitted on a lead form in a Google Ads campaign GRAV created.",
  }),
  pair(I.SOURCE, I.SOURCE_LABEL, {
    means: "Fetched from the seller's IndiaMART Lead Manager.",
  }),
];
const SOURCE_CODES = codes(SOURCES);

/* A lead-form submission is always a buyer enquiry. IndiaMART also sends
   prospects who did not contact GRAV, and the kind says which is which. */
const KINDS = freeze(I.KINDS.map((k) => pair(k.code, k.label, { means: k.means, isEnquiry: k.isEnquiry })));
const KIND_CODES = codes(KINDS);

/* ── CONTACT DETAILS, UNDER GRAV'S OWN NAMES ────────────────────────────────
   Keyed by the stored field; every one was typed by the person. */
const CONTACT_LABELS = freeze({
  fullName: "Full name",
  firstName: "First name",
  lastName: "Last name",
  email: "Email address",
  workEmail: "Work email address",
  phone: "Phone number",
  workPhone: "Work phone number",
  postalCode: "Postcode",
  streetAddress: "Street address",
  city: "City",
  region: "Region",
  country: "Country",
  companyName: "Company name",
  jobTitle: "Job title",
});
const CONTACT_FIELD_ORDER = freeze(Object.keys(CONTACT_LABELS));

/* Stored field → the form's field code, for a client that already holds the
   lead-form vocabulary. */
const CONTACT_CODE_BY_FIELD = freeze(Object.fromEntries(
  Object.entries(W.CONTACT_COLUMNS).map(([code, field]) => [field, code]),
));

const PROVENANCE = freeze({
  self_reported: freeze({
    code: "self_reported",
    label: ANSWER_PROVENANCE.label,
    means: ANSWER_PROVENANCE.means,
  }),
  source_reported: I.PROVENANCE,
});

const PHONE_VERIFIED = freeze({
  means: "Whether the advertising channel confirmed the phone number reaches a handset. It confirms a phone line, not who owns it. Absent means the channel said nothing.",
});

const UNMAPPED = freeze({ means: W.UNMAPPED_POLICY.means });

const PAGE = freeze({ DEFAULT: 25, MAX: 100 });

module.exports = freeze({
  PROCESSING,
  PROCESSING_CODES,
  CONSENT,
  CONSENT_CODES,
  CONSENT_BASES,
  CONSENT_BASIS_CODES,
  REVIEW_REASONS,
  REVIEW_REASON_CODES,
  INGESTION_ORIGINS,
  SOURCES,
  SOURCE_CODES,
  KINDS,
  KIND_CODES,
  CONTACT_LABELS,
  CONTACT_FIELD_ORDER,
  CONTACT_CODE_BY_FIELD,
  PROVENANCE,
  PHONE_VERIFIED,
  UNMAPPED,
  PAGE,
});
