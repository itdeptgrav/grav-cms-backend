// constants/marketingGoogleLeadForm.js
//
// GOOGLE'S LEAD-FORM CONTRACT, AS GOOGLE DOCUMENTS IT.
//
// ── EVERY VALUE HERE WAS READ FROM GOOGLE'S OWN REFERENCE ──────────────────
// Nothing in this file is inferred, remembered or reasonable-looking. The
// sources and the exact quotes are in
// `docs/decisions/google-lead-form-verified-contract.md`, and a field, a
// question, a delivery mechanism or a retrieval window that is not on one of
// those pages is not in this file.
//
// That sounds pedantic until the alternative is considered. An invented
// question code produces a form Google refuses at creation — recoverable. An
// invented DELIVERY mechanism produces a campaign that runs, spends, collects
// enquiries, and delivers them nowhere, and nobody finds out until somebody
// asks why the leads stopped.
//
// ── THE DISTINCTION THIS FILE EXISTS TO HOLD ───────────────────────────────
// Google's enum contains `JOB_ROLE`, `COMPANY_SIZE`, `ANNUAL_SALES`,
// `JOB_INDUSTRY`, `COMPANY_NAME` and `JOB_TITLE`. Every one of them is typed or
// picked BY THE PERSON, about themselves. Google verifies none of them against
// an employer, a registry or anything else.
//
// They are the most tempting fields in the product, because they look exactly
// like the firmographic targeting a B2B advertiser wants and cannot have. GRAV
// stores them as self-reported answers, labels them that way everywhere they
// surface, and never uses one to claim where somebody works, how senior they
// are or whether they can authorise a purchase.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ═══════════════════════════════════════════════════════════════════════════
   THE FORM ITSELF
   ═══════════════════════════════════════════════════════════════════════════
   `LeadFormAsset`. Required is Google's "Required", not GRAV's opinion. */

const FORM_CONTENT = [
  pair("businessName", "Business name", {
    googleField: "business_name", required: true,
    means: "The business being advertised, shown on the form.",
  }),
  pair("headline", "Form headline", {
    googleField: "headline", required: true,
    means: "What the form is asking for.",
  }),
  pair("description", "Form description", {
    googleField: "description", required: true,
    means: "A fuller description of what the form is for.",
  }),
  pair("callToAction", "Call to action", {
    googleField: "call_to_action_type", required: true,
    means: "The words on the button that opens the form.",
  }),
  pair("callToActionDescription", "Value proposition", {
    googleField: "call_to_action_description", required: true,
    means: "What somebody gets by filling it in. Google requires this and it is the line people actually read.",
  }),
  pair("privacyPolicyUrl", "Privacy policy link", {
    googleField: "privacy_policy_url", required: true,
    means: "Where the form says the collected data is handled. Google refuses a form without it, and so does GRAV.",
  }),
  pair("postSubmitHeadline", "Thank-you headline", {
    googleField: "post_submit_headline", required: false,
    means: "Shown after somebody submits.",
  }),
  pair("postSubmitDescription", "Thank-you description", {
    googleField: "post_submit_description", required: false,
    means: "What happens next, in the advertiser's own words.",
  }),
  pair("postSubmitCallToAction", "After-submit action", {
    googleField: "post_submit_call_to_action_type", required: false,
    means: "What somebody may do after submitting — visit the site, download, call.",
  }),
];
const FORM_CONTENT_CODES = codes(FORM_CONTENT);

/* ── GOOGLE'S BUTTON WORDS, VERBATIM FROM THE v25 ENUMS ──────────────────────
   `LeadFormCallToActionType` and `LeadFormPostSubmitCallToActionType`, read on
   2026-09-21 (UNKNOWN/UNSPECIFIED omitted: they are return values, not choices). */
const CALL_TO_ACTION_TYPES = freeze([
  "APPLY_NOW", "BOOK_NOW", "CONTACT_US", "DOWNLOAD", "GET_INFO", "GET_OFFER",
  "GET_QUOTE", "GET_STARTED", "JOIN_NOW", "LEARN_MORE", "REGISTER",
  "REQUEST_DEMO", "SIGN_UP", "SUBSCRIBE",
]);
const POST_SUBMIT_CALL_TO_ACTION_TYPES = freeze(["DOWNLOAD", "LEARN_MORE", "SHOP_NOW", "VISIT_SITE"]);

/* ── STORAGE BOUNDS, NOT GOOGLE'S LIMITS ─────────────────────────────────────
   The v25 reference does not state per-field character limits for
   `LeadFormAsset`, and GRAV does not invent them. These cap what GRAV stores;
   Google's own limits are applied by Google, and the validate-only pass before
   every creation reports them before anything is created. */
const DRAFT_TEXT_MAX = freeze({
  businessName: 100,
  headline: 100,
  description: 500,
  callToActionDescription: 100,
  privacyPolicyUrl: 2048,
  postSubmitHeadline: 100,
  postSubmitDescription: 500,
});
const REQUIRED_FORM_CONTENT = freeze(FORM_CONTENT.filter((f) => f.required).map((f) => f.code));

/* ═══════════════════════════════════════════════════════════════════════════
   CONTACT FIELDS — WHAT THE PERSON IS ASKED FOR
   ═══════════════════════════════════════════════════════════════════════════
   `LeadFormFieldUserInputType`, the half where somebody types their own
   details. GRAV offers the subset it can actually do something with: a
   government identity number for one Latin American country is a real Google
   field and is not something GRAV has any use for or any right to hold. */

const CONTACT_FIELDS = [
  pair("FULL_NAME", "Full name", { means: "Given and family name together." }),
  pair("FIRST_NAME", "First name", {}),
  pair("LAST_NAME", "Last name", {}),
  pair("EMAIL", "Email address", {}),
  pair("PHONE_NUMBER", "Phone number", {}),
  pair("CITY", "City", {}),
  pair("POSTAL_CODE", "Postcode", {}),
  pair("COUNTRY", "Country", {}),
  pair("COMPANY_NAME", "Company name", {
    selfReported: true,
    means: "Typed by the person. Google does not check it against anything.",
  }),
  pair("JOB_TITLE", "Job title", {
    selfReported: true,
    means: "Typed by the person. Google does not check it against anything.",
  }),
];
const CONTACT_FIELD_CODES = codes(CONTACT_FIELDS);

/* ── GOOGLE'S OWN EXCLUSIVITY RULE ──────────────────────────────────────────
   Quoted: FIRST_NAME and LAST_NAME "can not be set at the same time as
   FULL_NAME". Enforced locally so a plan is refused before a creation attempt
   rather than by Google after one. */
const FIELD_EXCLUSIONS = freeze([
  freeze({
    group: freeze(["FULL_NAME"]),
    excludes: freeze(["FIRST_NAME", "LAST_NAME"]),
    why: "Google does not allow a full-name field alongside separate first and last name fields. Choose one shape.",
  }),
]);

/* An enquiry GRAV cannot reply to is an enquiry GRAV cannot use. */
const CONTACTABLE_FIELDS = freeze(["EMAIL", "PHONE_NUMBER"]);

/* ═══════════════════════════════════════════════════════════════════════════
   QUALIFYING QUESTIONS — WHAT THE PERSON SAYS ABOUT THEMSELVES
   ═══════════════════════════════════════════════════════════════════════════
   Google authors the question text; the advertiser picks which to ask. The
   exact wording is recorded so GRAV shows the person what was actually asked
   rather than a paraphrase — an answer read without its question is a word
   with no meaning.

   GRAV offers the business-relevant subset. Google's full enum also carries
   travel, retail, real-estate and education verticals and an age ladder from
   OVER_18_AGE to OVER_65_AGE, none of which GRAV has a use for today. */
const QUALIFYING_QUESTIONS = [
  pair("JOB_ROLE", "Job role", {
    question: "What is your job role?", category: "Business",
  }),
  pair("JOB_INDUSTRY", "Industry", {
    question: "What industry do you work in?", category: "Jobs",
  }),
  pair("JOB_DEPARTMENT", "Department", {
    question: "What is your job department?", category: "Business",
  }),
  pair("COMPANY_SIZE", "Company size", {
    question: "What size is your company?", category: "Business",
  }),
  pair("ANNUAL_SALES", "Annual sales volume", {
    question: "What is your annual sales volume?", category: "Business",
  }),
  pair("LEVEL_OF_EDUCATION", "Level of education", {
    question: "What is your highest level of education?", category: "Jobs",
  }),
  pair("CATEGORY", "Category of interest", {
    question: "Which category are you interested in?", category: "General",
  }),
  pair("OFFER", "Offer of interest", {
    question: "Which offer are you interested in?", category: "General",
  }),
];
const QUALIFYING_QUESTION_CODES = codes(QUALIFYING_QUESTIONS);

/* ── GOOGLE'S LIMITS, VERBATIM ──────────────────────────────────────────────
   "This field is subject to a limit of 5 qualifying questions per form and
   cannot be used if values are set using custom_question_fields." */
const QUESTION_LIMITS = freeze({
  MAX_QUALIFYING_QUESTIONS: 5,
  /* ── WHY GRAV OFFERS NO CUSTOM QUESTIONS ─────────────────────────────────
     Google supports `custom_question_fields`, and using them switches OFF
     every pre-defined qualifying question on the same form. That is a real
     trade a marketer could reasonably make, and GRAV does not offer it: a
     custom question produces a free-text answer nothing can group, compare or
     qualify against, and it is the fastest route to a form that asks for
     something GRAV then has no idea what to do with.

     Recorded as a decision rather than an omission, so the next person knows
     it was considered. */
  customQuestionsOffered: false,
  customQuestionsWhy: "A custom question turns off every pre-defined qualifying question on the same form, and produces a free-text answer nothing can group or compare. GRAV offers Google's own questions instead.",
});

/* ── AND THE SENTENCE THAT TRAVELS WITH EVERY ANSWER ───────────────────────── */
const ANSWER_PROVENANCE = freeze({
  verified: false,
  label: "Answered by the person",
  means: "This is what the person said about themselves on the form. Google does not check any of it against an employer, a registry or any other record.",
  /* Named so no read model can accidentally describe one of these as a fact
     about somebody's employer. */
  neverTreatAsVerified: freeze(["JOB_ROLE", "JOB_INDUSTRY", "JOB_DEPARTMENT",
    "COMPANY_SIZE", "ANNUAL_SALES", "COMPANY_NAME", "JOB_TITLE"]),
});

/* ═══════════════════════════════════════════════════════════════════════════
   DELIVERY AND VERIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

const DELIVERY = freeze({
  /* The schema version GRAV asks Google to deliver in. Google's own
     "Add lead form asset" sample sets 3; the webhook documentation says the
     version "can be ignored for now". Recorded as the sample's value, not as a
     documented requirement. */
  PAYLOAD_SCHEMA_VERSION: 3,
  /* `WebhookDelivery`: advertiser_webhook_url, google_secret,
     payload_schema_version. */
  googleField: "delivery_methods",
  onlyOneWebhook: true,
  onlyOneWebhookWhy: "Google: \"Only one method typed as WebhookDelivery can be configured.\"",

  /* ── A SHARED SECRET, NOT A SIGNATURE ──────────────────────────────────
     Google's own words for `google_secret`: "Anti-spoofing secret set by the
     advertiser as part of the webhook payload." It travels INSIDE the JSON
     body. There is no HMAC, no signing key and no signature header in the
     documented contract, and GRAV must not invent one — a verification step
     checking a signature Google never sends would reject every real delivery.

     It is also weaker than a signature in a way that shapes the rest of the
     design: a secret echoed in a body is replayable by anyone who has ever
     seen one. Verification alone is therefore not enough, and the ingestion
     boundary is idempotent on the submission id as well. */
  verification: "shared_secret_in_payload",
  verificationMeans: "Google includes a secret GRAV chose inside the body of every delivery. GRAV compares it and refuses anything that does not match.",
  signatureAvailable: false,
  signatureWhy: "Google's documented lead-form webhook carries no signature or signing key. GRAV does not check for one, because checking for something that is never sent would refuse every genuine lead.",
});

/* ── RETENTION AND RECOVERY, AS GOOGLE STATES THEM ──────────────────────────
   "Google Ads stores leads for 60 days." CSV export covers 30. The API
   exports up to 60.

   Both numbers are published rather than the friendlier one, because the
   promise GRAV can make ends exactly where Google's retention does: after 60
   days a missed lead is not late, it is gone. */
const RETENTION = freeze({
  PROVIDER_RETENTION_DAYS: 60,
  RETRIEVAL_SUPPORTED: true,
  RETRIEVAL_WINDOW_DAYS: 60,
  retrievalResource: "lead_form_submission_data",
  retrievalMeans: "Google keeps submitted leads for 60 days and lets them be read back within that window. GRAV can therefore recover a delivery it missed — but only inside 60 days, after which Google no longer holds it.",
  /* Both filterable and sortable on the resource, which is what makes a
     paginated, resumable, idempotent sweep possible rather than aspirational. */
  cursorFields: freeze(["id", "submission_date_time"]),
});

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT MAKES A LEAD FORM ACTUALLY SERVE
   ═══════════════════════════════════════════════════════════════════════════
   Google's eligibility rules, not GRAV's preferences. A campaign that breaks
   one of these is created successfully and never shows a form, which is the
   worst failure available: it looks like it worked. */

const ELIGIBILITY = [
  pair("conversion_bidding_required", "Conversion-focused bidding", {
    means: "Google: the campaign \"should use a conversion-focused bidding strategy\". A click-maximising campaign will not serve the form.",
    /* GRAV's default bid strategy is `maximise_clicks`, which would produce
       exactly that failure — so this is checked locally. */
    blocksLocally: true,
  }),
  pair("lead_form_conversion_goal", "Lead-form conversion goal", {
    means: "Google: the campaign \"must be optimized towards a Google lead form conversion goal\", even where it also optimises for others.",
    blocksLocally: true,
  }),
  pair("responsive_search_ads_only", "Responsive search ads", {
    means: "Google: responsive search ad creatives are eligible; expanded text ads are not.",
    blocksLocally: true,
  }),
  pair("privacy_policy_required", "Privacy policy", {
    means: "Google requires a privacy-policy link on every lead form.",
    blocksLocally: true,
  }),
  pair("serving_country", "A country where lead forms serve", {
    means: "Google does not serve lead forms in every country. A campaign targeting only countries on that list would run and collect nothing.",
    blocksLocally: true,
  }),
  pair("account_vertical_eligible", "An eligible account", {
    means: "Google requires a good policy-compliance history and an eligible vertical. Sensitive verticals are refused.",
    /* ── NOT KNOWABLE FROM A PLAN ─────────────────────────────────────────
       GRAV cannot read an account's compliance history or its vertical, and
       an evaluator that guessed would produce a confident local pass followed
       by a provider refusal. It stays external and is reported as external. */
    blocksLocally: false,
    externallyVerified: true,
  }),
];
const ELIGIBILITY_CODES = codes(ELIGIBILITY);
const LOCAL_ELIGIBILITY = freeze(ELIGIBILITY.filter((e) => e.blocksLocally).map((e) => e.code));

/* Countries where Google states lead forms do not serve. Published so a plan
   targeting only these can be refused with the reason, rather than created and
   quietly collecting nothing. */
const NON_SERVING_COUNTRIES = freeze([
  "AF", "DZ", "AI", "AM", "AZ", "BH", "BT", "BO", "BA", "BG", "KH", "HR", "CU",
  "DO", "EG", "EE", "GE", "GD", "GP", "GY", "IQ", "JO", "XK", "KW", "KG", "LV",
  "LB", "LY", "MV", "MD", "ME", "MA", "MM", "NP", "NI", "MK", "OM", "PS", "PY",
  "QA", "SA", "RS", "SI", "SS", "SD", "SR", "SY", "TJ", "TN", "AE", "UY", "VE",
  "YE",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT GRAV HAS NOT VERIFIED
   ═══════════════════════════════════════════════════════════════════════════
   Declared rather than guessed. The webhook payload's own key names were not
   read from Google's form-ads documentation in the pass that produced this
   file, so nothing here hard-codes them — an ingestion boundary that assumed
   them would fail on the first real delivery, silently, at the one moment
   nobody is watching. */
const UNVERIFIED = freeze({
  /* ── THE TWO PROOFS THAT ONLY A REAL ACCOUNT CAN GIVE ──────────────────
     GRAV can now build, validate and create a stopped lead-form campaign —
     but only into the controlled proof account, and nobody has yet done it
     there. Until a creation in that account has been read back as stopped and
     a real enquiry from its form has arrived and been processed, the type is
     not offered. Flipping either flag is a record of those two events, not a
     judgement about the code. */
  controlledAccountCreation: freeze({
    verified: false,
    why: "No lead-form campaign has yet been created in the controlled proof account and read back as stopped with its form attached.",
    blocks: freeze(["general_creation"]),
  }),
  realLeadDelivery: freeze({
    verified: false,
    why: "No real enquiry from a GRAV-created lead form has yet been delivered to GRAV and processed end to end.",
    blocks: freeze(["general_creation"]),
  }),
  webhookPayloadSchema: freeze({
    verified: false,
    why: "Google publishes the webhook payload's JSON schema in its form-ads documentation. That page has not been read, so the exact key names and how `payload_schema_version` changes them are not encoded here.",
    blocks: freeze(["lead_ingestion"]),
  }),
});

/* ── WHAT A SCREEN NEEDS TO BUILD THE FORM, FROM THIS ONE FILE ───────────────
   Served with the plan vocabulary and on the capability entry, so a builder
   never restates a field, a question or a rule. Button labels are GRAV's
   reading of Google's code; Google shows its own wording on the live form. */
const humanise = (code) => code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, " ");
const LEAD_FORM_VOCABULARY = freeze({
  contentFields: freeze(FORM_CONTENT.map((f) => freeze({
    code: f.code, label: f.label, means: f.means, required: f.required,
    maxLength: DRAFT_TEXT_MAX[f.code] || null,
  }))),
  contactFields: freeze(CONTACT_FIELDS.map((f) => freeze({
    code: f.code, label: f.label, selfReported: f.selfReported === true, means: f.means || null,
  }))),
  qualifyingQuestions: freeze(QUALIFYING_QUESTIONS.map((q) => freeze({
    code: q.code, label: q.label, question: q.question, category: q.category, selfReported: true,
  }))),
  maxQualifyingQuestions: QUESTION_LIMITS.MAX_QUALIFYING_QUESTIONS,
  customQuestionsOffered: QUESTION_LIMITS.customQuestionsOffered,
  customQuestionsWhy: QUESTION_LIMITS.customQuestionsWhy,
  fieldExclusions: FIELD_EXCLUSIONS,
  contactableFields: CONTACTABLE_FIELDS,
  contactableMeans: "A form must ask for an email address or a phone number, or nobody could reply to an enquiry from it.",
  callToActionTypes: freeze(CALL_TO_ACTION_TYPES.map((code) => freeze({ code, label: humanise(code) }))),
  postSubmitCallToActionTypes: freeze(POST_SUBMIT_CALL_TO_ACTION_TYPES.map((code) => freeze({ code, label: humanise(code) }))),
  buttonLabelsMean: "GRAV's reading of Google's button code. Google shows its own wording, in the viewer's language, on the live form.",
  answerProvenance: ANSWER_PROVENANCE,
  /* Not accepted on a Google lead form in this release: Google publishes no
     permission field whose answer GRAV could evidence. */
  marketingConsentOffered: false,
  marketingConsentWhy: "Google's lead form has no documented permission question GRAV could record as evidence, so a Google lead form does not ask for marketing permission. An enquiry is still somebody GRAV may reply to about what they asked.",
});

module.exports = freeze({
  LEAD_FORM_VOCABULARY,
  FORM_CONTENT,
  FORM_CONTENT_CODES,
  REQUIRED_FORM_CONTENT,
  CALL_TO_ACTION_TYPES,
  POST_SUBMIT_CALL_TO_ACTION_TYPES,
  DRAFT_TEXT_MAX,

  /* The environment variable naming the advertising account(s) — digits,
     comma-separated — that a lead-form campaign may be created in while the
     type is controlled. Its NAME is published; its value is never returned. */
  CONTROLLED_ACCOUNT_VAR: "MARKETING_LEAD_FORM_CONTROLLED_ACCOUNTS",

  CONTACT_FIELDS,
  CONTACT_FIELD_CODES,
  CONTACTABLE_FIELDS,
  FIELD_EXCLUSIONS,

  QUALIFYING_QUESTIONS,
  QUALIFYING_QUESTION_CODES,
  QUESTION_LIMITS,
  ANSWER_PROVENANCE,

  DELIVERY,
  RETENTION,

  ELIGIBILITY,
  ELIGIBILITY_CODES,
  LOCAL_ELIGIBILITY,
  NON_SERVING_COUNTRIES,

  UNVERIFIED,
});
