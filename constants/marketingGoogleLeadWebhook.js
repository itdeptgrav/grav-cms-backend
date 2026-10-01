// constants/marketingGoogleLeadWebhook.js
//
// GOOGLE'S LEAD-FORM WEBHOOK, AS GOOGLE DOCUMENTS IT.
//
// Source: developers.google.com/google-ads/webhook/docs/{implementation,samples}
// Read 2026-09-20. Every value below is from the published proto or the field
// table on those pages. Nothing is inferred.
//
// ── THREE THINGS ON THAT PAGE THAT DECIDE THE DESIGN ───────────────────────
//
//   `column_name` is marked **Deprecated**, and the field table says it "might
//   not always be populated, use column_id instead". So identity is
//   `column_id`, always. Matching on the human label would work in testing —
//   where the samples all carry one — and start dropping fields in production
//   the moment Google stops sending it.
//
//   `form_id`, `campaign_id`, `adgroup_id`, `creative_id` and `asset_group_id`
//   are **int64**, and the page says so four times: "Clients need to use 8
//   bytes integer to process." JavaScript numbers are not 8-byte integers.
//   A campaign id above 2^53 silently loses its last digits through
//   `JSON.parse`, and the correlation it was for then matches nothing. These
//   are read from the raw body as text.
//
//   Delivery is **at-least-once**: "A single lead is not guaranteed to be
//   delivered exactly once." Deduplication on `lead_id` is part of the
//   contract, not a refinement of it.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });

/* ── THE KEY, AND ITS TWO SPELLINGS ─────────────────────────────────────────
   The proto is authoritative: `optional string google_key = 6`. But Google's
   own published samples spell it `Google_key` on every TEST payload and
   `google_key` on the production one.

   That is a documentation typo, almost certainly. GRAV accepts both anyway,
   and the reason is worth stating: refusing the capitalised form would refuse
   Google's own official test sample, so anybody following the documented
   testing procedure would watch verification fail and conclude the integration
   was broken.

   Accepting a second spelling of the same key name weakens nothing. The secret
   VALUE is still compared in constant time, and a wrong secret under either
   spelling is still refused. */
const KEY_FIELDS = freeze(["google_key", "Google_key"]);

/* ── WHAT ARRIVES ───────────────────────────────────────────────────────────
   `required` is GRAV's requirement, not Google's — the proto marks almost
   everything optional, and a delivery with no `lead_id` cannot be deduplicated
   and a delivery with no columns carries no person. */
const PAYLOAD_FIELDS = [
  pair("lead_id", "Lead identifier", {
    required: true,
    means: "Unique across all forms. Google's own recommendation is to use it to deduplicate.",
  }),
  pair("user_column_data", "Submitted answers", { required: true, repeated: true }),
  pair("google_key", "Verification secret", { required: true, secret: true }),
  pair("api_version", "Schema version", { required: false }),
  pair("form_id", "Form identifier", { required: false, int64: true }),
  pair("campaign_id", "Campaign identifier", { required: false, int64: true }),
  pair("adgroup_id", "Ad group identifier", { required: false, int64: true }),
  pair("creative_id", "Creative identifier", { required: false, int64: true }),
  pair("asset_group_id", "Asset group identifier", { required: false, int64: true }),
  pair("gcl_id", "Click identifier", { required: false }),
  pair("is_test", "Test delivery", { required: false }),
  pair("lead_stage", "Lead stage", { required: false }),
  pair("lead_submit_time", "Submitted at", { required: false }),
  pair("lead_source", "Origin", { required: false }),
];

/* Google: "Clients need to use 8 bytes integer to process." */
const INT64_FIELDS = freeze(PAYLOAD_FIELDS.filter((f) => f.int64).map((f) => f.code));

/* Google: 'It can be "LEAD_FORM" … or "CONVERSATIONAL_AGENT"'. An unfamiliar
   value is kept rather than refused — the list will grow. */
const LEAD_SOURCES = freeze(["LEAD_FORM", "CONVERSATIONAL_AGENT"]);

/* ── COLUMN IDS → GRAV'S OWN FIELDS ─────────────────────────────────────────
   A closed map. `column_id` is the identity; `column_name` is never consulted.

   Split into contact details GRAV can act on and answers somebody gave about
   themselves, because the two are treated completely differently downstream:
   one reaches a person, the other describes what they said. */
const CONTACT_COLUMNS = freeze({
  FULL_NAME: "fullName",
  FIRST_NAME: "firstName",
  LAST_NAME: "lastName",
  EMAIL: "email",
  WORK_EMAIL: "workEmail",
  PHONE_NUMBER: "phone",
  WORK_PHONE: "workPhone",
  POSTAL_CODE: "postalCode",
  STREET_ADDRESS: "streetAddress",
  CITY: "city",
  REGION: "region",
  COUNTRY: "country",
  COMPANY_NAME: "companyName",
  JOB_TITLE: "jobTitle",
});

/* ── A FLAG, NOT A CONTACT FIELD ────────────────────────────────────────────
   `PHONE_NUMBER_VERIFIED` is Google saying it checked the number reaches a
   handset. It is the ONLY thing on this whole payload Google verifies, and it
   verifies a phone line — not a person, an employer or a job. Kept apart from
   both maps so nothing can mistake it for either. */
const PHONE_VERIFIED_COLUMN = "PHONE_NUMBER_VERIFIED";

/* Answers, with the question Google showed. Stored with their question because
   "51-200" means nothing without "What size is your company?". */
const QUESTION_COLUMNS = freeze({
  COMPANY_SIZE: "What size is your company?",
  ANNUAL_SALES: "What is your annual sales volume?",
  YEARS_IN_BUSINESS: "How many years have you been in business?",
  JOB_DEPARTMENT: "What is your job department?",
  JOB_ROLE: "What is your job role?",
  JOB_INDUSTRY: "What industry do you work in?",
  YEARS_OF_EXPERIENCE: "How many years of work experience do you have?",
  LEVEL_OF_EDUCATION: "What is your highest level of education?",
  EDUCATION_PROGRAM: "Which program are you interested in?",
  EDUCATION_COURSE: "Which course are you interested in?",
  PRODUCT: "Which product are you interested in?",
  SERVICE: "Which service are you interested in?",
  OFFER: "Which offer are you interested in?",
  CATEGORY: "Which category are you interested in?",
  PREFERRED_CONTACT_METHOD: "Select your preferred method of contact",
  PREFERRED_CONTACT_TIME: "What is the best time to contact you?",
  PREFERRED_LOCATION: "Select your preferred location",
  PURCHASE_TIMELINE: "When are you looking to make a purchase?",
  NEXT_PLANNED_PURCHASE: "What is the next product you plan to purchase?",
  EVENT_SIGNUP_INTEREST: "Would you like to sign up for an event?",
});

const MAPPED_COLUMNS = freeze([
  ...Object.keys(CONTACT_COLUMNS),
  ...Object.keys(QUESTION_COLUMNS),
  PHONE_VERIFIED_COLUMN,
]);

/* ── AN UNRECOGNISED COLUMN IS KEPT, NOT GUESSED AND NOT DROPPED ────────────
   Google's table carries vertical columns GRAV has no mapping for — vehicles,
   property, travel — and will add more.

   Dropping one loses something a person typed. Guessing its meaning from the
   deprecated label is worse: `PREFERRED_DEALERSHIP` would become a "preferred
   location" and read as though somebody answered a question nobody asked. So
   an unknown column is preserved verbatim, flagged for review, and never
   mapped onto a GRAV field. */
const UNMAPPED_POLICY = freeze({
  keep: true,
  mapByName: false,
  means: "This answer came from a question GRAV does not recognise. It is kept exactly as it arrived and is not interpreted.",
  why: "Guessing a field's meaning from its label would record an answer to a question nobody asked.",
});

/* ── WHAT GRAV ANSWERS GOOGLE ───────────────────────────────────────────────
   From the Lead handling table. The retry semantics are the point: a 4XX tells
   Google never to try again, a 5XX tells it to try later.

   So a failed verification must be 4XX — the secret will not become right on a
   retry — and an internal fault must be 5XX, or a lead is lost because GRAV's
   database happened to be busy. A DUPLICATE is 200: GRAV already has it, and
   answering anything else asks Google to keep redelivering a lead that arrived. */
const RESPONSES = freeze({
  ACCEPTED: freeze({ status: 200, body: freeze({}), retryable: false }),
  DUPLICATE: freeze({ status: 200, body: freeze({}), retryable: false }),
  REFUSED: freeze({ status: 400, retryable: false }),
  UNVERIFIED: freeze({ status: 403, retryable: false }),
  TRY_AGAIN: freeze({ status: 503, retryable: true }),
});

/* Google's samples are a few hundred bytes. A megabyte is generous and still
   refuses a body nobody sent in good faith. */
const LIMITS = freeze({
  BODY_BYTES: 64 * 1024,
  MAX_COLUMNS: 100,
  MAX_VALUE_CHARS: 2000,
});

/* ── THE KEY IS DERIVED, SO THERE IS NOTHING TO PERSIST ────────────────────
   Marketing's binding contract is explicit that a credential never enters the
   database: "the credential in deployment secrets, this in the database — so
   that a database dump is not an advertising account". A per-form webhook
   secret is a credential, and there is no company-scoped secret store here.

   The way past that is not a vault. Google lets the advertiser CHOOSE the
   webhook key and only ever hands it back inside a delivery, so GRAV never
   needs to retrieve one — only to recognise it. Anything GRAV can recompute it
   does not have to keep.

   `services/marketing/leads/leadWebhookKey.js` derives the key for a company
   and binding from one dedicated deployment master, at the two moments it is
   needed: configuring Google, and checking a delivery. The database holds the
   binding identity and an integer version, neither of which is a secret, and a
   dumped database yields no key for any company without the master.

   The trade, stated rather than implied: one master is a single point of
   compromise for every company's keys at once. Against a database dump — much
   the likelier event — it is a complete defence. Against a compromised
   deployment environment it is none, because that environment already holds
   the advertising credentials. The key ring is what allows a master to be
   retired without breaking bindings created under an older one. */
const SECRET_BOUNDARY = freeze({
  strategy: "derived_per_binding",
  storedInDatabase: freeze(["secretVersion"]),
  derivedBy: "services/marketing/leads/leadWebhookKey.js",
  masterVariable: "MARKETING_GOOGLE_LEAD_WEBHOOK_MASTER_SECRET_V1",
  purpose: "grav.marketing.google-lead-webhook.v1",
  neverDo: "Store the derived key in a Marketing document, a history record, a deployment response, a log line or any public response.",
  blastRadius: "The deployment master is a single point of compromise for every company's webhook keys. A dumped database is not, because it holds no key material at all.",
});

module.exports = freeze({
  KEY_FIELDS,
  PAYLOAD_FIELDS,
  INT64_FIELDS,
  LEAD_SOURCES,

  CONTACT_COLUMNS,
  QUESTION_COLUMNS,
  PHONE_VERIFIED_COLUMN,
  MAPPED_COLUMNS,
  UNMAPPED_POLICY,

  RESPONSES,
  LIMITS,
  SECRET_BOUNDARY,
});
