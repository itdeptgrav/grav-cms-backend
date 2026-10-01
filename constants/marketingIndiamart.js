// constants/marketingIndiamart.js
//
// INDIAMART AS A MARKETING LEAD SOURCE: WHAT ITS PULL API PROMISES, AND WHAT
// GRAV SAYS ABOUT IT.
//
// ── THE CONTRACT, AS PUBLISHED (verified 2026-09-22) ───────────────────────
// Source: https://help.indiamart.com/knowledge-base/lms-crm-integration-v2/
// (page last updated 11 Dec 2025). Nothing below is inferred from a live call:
// GRAV has no seller key yet. Where the page is silent, the behaviour chosen is
// the conservative one and `docs/decisions/marketing-indiamart-lead-source.md`
// lists it as unconfirmed.
//
//   GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/
//       ?glusr_crm_key=<key>&start_time=<IST>&end_time=<IST>
//
//   · times are IST; the page's own example is `07-Dec-202109:00:00`
//   · at most 7 days per call; only the last 365 days are held
//   · one call every 5 minutes, or CODE 429; more than 5 in a minute blocks
//     the key for 15 minutes
//   · no pagination and no record cap is documented
//   · overlapping windows return the same enquiry twice; UNIQUE_QUERY_ID is the
//     key to deduplicate on
//   · a key belongs to a paid seller, is made at the seller's Lead Manager,
//     stops working after 7 days without activity, and regenerating it cancels
//     the old one
//   · enquiries from before the key was generated appear after 24 hours
//
// ── WHAT GRAV NEVER DOES WITH IT ───────────────────────────────────────────
// IndiaMART never asks a buyer for marketing permission, so none is recorded
// or inferred. Pulling creates nothing outside the inbox. Routing (below) sends
// eligible BUYER enquiries to Sales only through the existing Marketing
// handover, and never a Buy-Lead or a catalog view.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

const SOURCE = "indiamart";
const SOURCE_LABEL = "IndiaMART";

const ENDPOINT = "https://mapi.indiamart.com/wservce/crm/crmListing/v2/";
const KEY_PAGE = "https://seller.indiamart.com/leadmanager/crmapi";
const CONTRACT_URL = "https://help.indiamart.com/knowledge-base/lms-crm-integration-v2/";

/* The deployment secret. Server environment only — never MongoDB, never a
   response, never a log line. Bound to the one Marketing company. */
const KEY_ENV = "MARKETING_INDIAMART_CRM_KEY";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const LIMITS = freeze({
  /* IndiaMART's own rate: one call per five minutes. */
  MIN_CALL_INTERVAL_MS: 5 * MINUTE,
  /* After a 429 the key may be blocked for 15 minutes; GRAV waits that long. */
  RATE_LIMITED_BACKOFF_MS: 15 * MINUTE,
  /* Seven days per call, less a minute so an inclusive-boundary reading of
     "7 days" on IndiaMART's side cannot refuse the window. */
  MAX_WINDOW_MS: 7 * DAY - MINUTE,
  /* IndiaMART holds 365 days; an hour's margin keeps a slow call from asking
     for a moment that has just aged out. */
  RETENTION_MS: 365 * DAY,
  RETENTION_MARGIN_MS: HOUR,
  RETENTION_DAYS: 365,
  MAX_WINDOW_DAYS: 7,
  /* Each window starts this far before the last one ended, so an enquiry that
     IndiaMART indexes a little late is still inside a window GRAV asks for.
     The duplicate it produces is recognised by UNIQUE_QUERY_ID. */
  OVERLAP_MS: 15 * MINUTE,
  /* One run holds the source this long at most; a crashed run frees it. */
  LEASE_MS: 2 * MINUTE,
  REQUEST_TIMEOUT_MS: 30 * 1000,
  MAX_RESPONSE_BYTES: 20 * 1024 * 1024,
  MAX_GAPS_KEPT: 10,
});

/* ── WHAT KIND OF CONTACT EACH RECORD IS ────────────────────────────────────
   A buyer who contacted GRAV is not the same as a prospect IndiaMART sold or
   showed to GRAV, and the inbox must not present one as the other. */
const KINDS = [
  pair("buyer_enquiry", "Buyer enquiry", {
    isEnquiry: true,
    means: "The buyer contacted GRAV about GRAV's products: a direct enquiry, a phone call or a WhatsApp message.",
  }),
  pair("purchased_lead", "Purchased lead", {
    isEnquiry: false,
    means: "A buyer's requirement that GRAV took from IndiaMART's Buy-Leads. The buyer posted it to IndiaMART, not to GRAV, and did not contact GRAV.",
  }),
  pair("catalog_view", "Catalog view", {
    isEnquiry: false,
    means: "IndiaMART reported that this buyer looked at GRAV's catalog. They did not send an enquiry.",
  }),
  pair("unclassified", "Unrecognised type", {
    isEnquiry: false,
    means: "IndiaMART sent a record type GRAV does not recognise. It is kept as sent and is not treated as an enquiry.",
  }),
];
const KIND_CODES = codes(KINDS);

/* IndiaMART's QUERY_TYPE → GRAV's kind. Anything else is `unclassified`. */
const QUERY_TYPES = freeze({
  W: pair("W", "Direct enquiry", { kind: "buyer_enquiry" }),
  P: pair("P", "Phone call", { kind: "buyer_enquiry" }),
  WA: pair("WA", "WhatsApp enquiry", { kind: "buyer_enquiry" }),
  B: pair("B", "Buy-Lead", { kind: "purchased_lead" }),
  BIZ: pair("BIZ", "Catalog view", { kind: "catalog_view" }),
});

const kindFor = (queryType) => QUERY_TYPES[String(queryType ?? "").trim().toUpperCase()]?.kind || "unclassified";

/* IndiaMART fills SENDER_NAME with this when the buyer gave none. It is not a
   name and is not shown as one. */
const PLACEHOLDER_NAMES = freeze(["indiamart buyer"]);

/* ── CONNECTION, AS A MARKETER SEES IT ──────────────────────────────────── */
const CONNECTION_STATES = [
  pair("not_configured", "Not connected", {
    means: "GRAV has no IndiaMART key for this company, so it cannot fetch IndiaMART enquiries.",
  }),
  pair("configured_unverified", "Key present, not checked yet", {
    means: "An IndiaMART key is set up, but GRAV has not yet fetched with it, so it is not known to work.",
  }),
  pair("connected", "Connected", {
    means: "The last check with IndiaMART succeeded.",
  }),
  pair("failing", "Last check failed", {
    means: "The last check with IndiaMART did not succeed. Enquiries fetched earlier are still in the inbox.",
  }),
];
const CONNECTION_CODES = codes(CONNECTION_STATES);

/* ── WHY A CHECK FAILED, AND WHAT TO DO ─────────────────────────────────────
   `retryable` says whether the same check later could succeed on its own. */
const ERRORS = [
  pair("key_rejected", "IndiaMART refused the key", {
    retryable: false,
    means: "IndiaMART says the key is wrong or has expired. A key stops working after 7 days without activity in the seller account, and generating a new one cancels the old one.",
    action: `Generate a key at ${KEY_PAGE} and give it to whoever manages GRAV's server settings. Scheduled checks resume on their own.`,
  }),
  pair("rate_limited", "IndiaMART asked GRAV to slow down", {
    retryable: true,
    means: "IndiaMART allows one check every 5 minutes, and may pause a key for 15 minutes when it is called too often.",
    action: "GRAV waits until the time shown and then checks again on its own. Nothing was lost.",
  }),
  pair("window_rejected", "IndiaMART refused the time range", {
    retryable: false,
    means: "IndiaMART rejected the dates GRAV asked for. It holds only the last 365 days and returns at most 7 days per check.",
    action: "Report this to GRAV support; it needs a fix in GRAV, not in IndiaMART.",
  }),
  pair("provider_error", "IndiaMART had a problem", {
    retryable: true,
    means: "IndiaMART answered with an error of its own.",
    action: "GRAV checks again on its own. The same time range will be fetched again, and nothing will be duplicated.",
  }),
  pair("unreachable", "IndiaMART did not answer", {
    retryable: true,
    means: "GRAV could not reach IndiaMART, or IndiaMART took too long to answer. IndiaMART may still have received the check.",
    action: "GRAV checks again on its own after the time shown. The same time range will be fetched again, and nothing will be duplicated.",
  }),
  pair("malformed_response", "IndiaMART's answer could not be read", {
    retryable: true,
    means: "IndiaMART answered in a form GRAV does not recognise, so GRAV recorded nothing from it.",
    action: "GRAV checks again on its own. If it keeps happening, report it to GRAV support: IndiaMART may have changed its format.",
  }),
  pair("incomplete_response", "IndiaMART's answer was incomplete", {
    retryable: true,
    means: "IndiaMART said it had more enquiries than it sent, so GRAV did not mark this time range as covered.",
    action: "GRAV checks again on its own. The same time range will be fetched again, and nothing will be duplicated.",
  }),
  pair("storage_failed", "GRAV could not save every enquiry", {
    retryable: true,
    means: "Some enquiries from this check were not saved, so GRAV did not mark the time range as covered. Enquiries that were saved are in the inbox.",
    action: "GRAV checks again on its own after the time shown. The same time range will be fetched again, and nothing will be duplicated.",
  }),
];
const ERROR_CODES = codes(ERRORS);
const ERROR_BY_CODE = freeze(Object.fromEntries(ERRORS.map((e) => [e.code, e])));

/* The Pull API's own CODE → GRAV's error. 200 and 204 are successes: 204 is
   IndiaMART saying the window genuinely holds no enquiries. */
const PROVIDER_CODE_TO_ERROR = freeze({
  401: "key_rejected",
  429: "rate_limited",
  400: "window_rejected",
  500: "provider_error",
});

const RUN_OUTCOMES = [
  pair("completed", "Checked", { means: "GRAV fetched the time range and saved every enquiry in it." }),
  pair("failed", "Check failed", { means: "GRAV did not finish the check. See the error for what to do." }),
];

/* Why Check now cannot be used at the moment. */
const CHECK_BLOCKS = [
  pair("not_administrator", "Only an administrator can check", {
    means: "Checking IndiaMART is an administrator action. You can still see the connection status.",
  }),
  pair("not_configured", "Not connected", {
    means: "There is no IndiaMART key for this company.",
  }),
  pair("running", "A check is running", {
    means: "GRAV is checking IndiaMART now.",
  }),
  pair("too_soon", "Too soon to check again", {
    means: "IndiaMART allows one check every 5 minutes. Check now is available again at the time shown.",
  }),
];

const COVERAGE_NOTES = freeze([
  "IndiaMART keeps enquiries for 365 days. Anything older cannot be fetched.",
  "Each check covers up to 7 days. If GRAV is further behind than that, each check catches up by up to 7 days.",
  "IndiaMART releases enquiries from before its key was generated 24 hours later. A check in the first day after a new key may miss them.",
  /* About coverage only, and true in every scheduling state: whether checks
     run on their own is `automaticChecks`, not a coverage note. */
  "Coverage moves forward only when a check succeeds. Whether checks run on their own is shown separately under automatic checks.",
]);

/* ── WHETHER CHECKS RUN ON THEIR OWN ────────────────────────────────────────
   Distinct from coverage: coverage is what has been read; this is whether
   anything will read more without a person. */
const AUTOMATIC_CHECK_STATES = [
  pair("scheduled", "Checking on a schedule", {
    means: "GRAV checks IndiaMART on its own every few minutes, never more than once in 5 minutes. Check now is an extra check for administrators.",
  }),
  pair("switched_off", "Scheduled checks switched off", {
    means: "Scheduled checks are switched off. Enquiries are fetched only when an administrator uses Check now.",
  }),
  pair("no_key", "No key, nothing is checked", {
    means: "There is no IndiaMART key for this company, so nothing is fetched, on a schedule or by Check now.",
  }),
];

/* Every value `automaticChecks.lastCycleOutcome` can hold: what the last
   scheduled cycle did about calling IndiaMART. Routing to Sales runs in every
   cycle whatever this says. */
const SCHEDULED_CYCLE_OUTCOMES = [
  pair("completed", "Checked", {
    means: "The last scheduled cycle fetched from IndiaMART and saved everything in its time range.",
  }),
  pair("failed", "Check failed", {
    means: "The last scheduled cycle called IndiaMART and the check did not succeed. The last error says why and what to do.",
  }),
  pair("waiting_rate_limit", "Waiting for IndiaMART's limit", {
    means: "The last scheduled cycle did not call IndiaMART, because IndiaMART allows one check in 5 minutes (15 after it asked GRAV to slow down). The next cycle checks when allowed.",
  }),
  pair("another_check_running", "Another check was running", {
    means: "The last scheduled cycle did not call IndiaMART, because another check (a scheduled one elsewhere, or Check now) was already running.",
  }),
  pair("error", "Cycle could not run", {
    means: "The last scheduled cycle hit a problem inside GRAV before it could check IndiaMART. Nothing was fetched by it; the next cycle tries again.",
  }),
];
const SCHEDULED_CYCLE_OUTCOME_CODES = codes(SCHEDULED_CYCLE_OUTCOMES);

/* ── THE RECORD, UNDER GRAV'S NAMES ─────────────────────────────────────────
   Stored field → IndiaMART's field and GRAV's label. */
const CONTACT_FIELDS = freeze([
  freeze({ field: "fullName", code: "SENDER_NAME", label: "Name" }),
  freeze({ field: "companyName", code: "SENDER_COMPANY", label: "Company name" }),
  freeze({ field: "phone", code: "SENDER_MOBILE", label: "Mobile number" }),
  freeze({ field: "phoneAlt", code: "SENDER_MOBILE_ALT", label: "Alternate mobile number" }),
  freeze({ field: "landline", code: "SENDER_PHONE", label: "Phone number" }),
  freeze({ field: "landlineAlt", code: "SENDER_PHONE_ALT", label: "Alternate phone number" }),
  freeze({ field: "email", code: "SENDER_EMAIL", label: "Email address" }),
  freeze({ field: "emailAlt", code: "SENDER_EMAIL_ALT", label: "Alternate email address" }),
  freeze({ field: "streetAddress", code: "SENDER_ADDRESS", label: "Address" }),
  freeze({ field: "city", code: "SENDER_CITY", label: "City" }),
  freeze({ field: "region", code: "SENDER_STATE", label: "State" }),
  freeze({ field: "postalCode", code: "SENDER_PINCODE", label: "PIN code" }),
  freeze({ field: "country", code: "SENDER_COUNTRY_ISO", label: "Country" }),
]);

const CONTEXT_FIELDS = freeze([
  freeze({ field: "subject", code: "SUBJECT", label: "Subject" }),
  freeze({ field: "productName", code: "QUERY_PRODUCT_NAME", label: "Product asked about" }),
  freeze({ field: "categoryName", code: "QUERY_MCAT_NAME", label: "IndiaMART category" }),
  freeze({ field: "message", code: "QUERY_MESSAGE", label: "Message" }),
  freeze({ field: "callDurationSeconds", code: "CALL_DURATION", label: "Call length (seconds)" }),
  freeze({ field: "receiverPhone", code: "RECEIVER_MOBILE", label: "GRAV number that took the call" }),
]);

const PROVENANCE = freeze({
  code: "source_reported",
  label: "As IndiaMART sent it",
  means: "IndiaMART supplied this. Some of it the buyer typed and some IndiaMART holds about them; GRAV has not verified any of it.",
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SCHEDULE
   ═══════════════════════════════════════════════════════════════════════════
   Every 6 minutes: IndiaMART allows one call per 5, and the state row's fence
   enforces that across every process, so a cycle that finds the fence closed
   simply does not call. After downtime each cycle catches up one 7-day window. */
const SCHEDULE = freeze({
  JOB_NAME: "marketing-indiamart-pull",
  EVERY_MS: 6 * MINUTE,
  ROUTE_PER_CYCLE: 50,
  DELIVER_PER_CYCLE: 50,
  /* Coverage reads `stalled` when no check has succeeded for this long. */
  STALE_AFTER_MS: 30 * MINUTE,
  /* Coverage is `current` while it ends within this of now. */
  CURRENT_WITHIN_MS: 30 * MINUTE,
});

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTING A BUYER ENQUIRY TO SALES
   ═══════════════════════════════════════════════════════════════════════════
   Through the existing handover only: a MarketingProspectHandover, its outbox
   announcement, and Sales' own receiver (the one Sales writer). */
const ROUTING = freeze({
  /* Only these kinds are routed automatically. */
  ROUTED_KINDS: freeze(["buyer_enquiry"]),
  /* Sales' handover threshold counts requests from the last 30 days
     (handoverContract RECENCY_DAYS). An older one would be refused there. */
  MAX_AGE_MS: 30 * DAY,
  /* A time later than GRAV received the record (beyond clock slack), or
     earlier than IndiaMART could still hold, is not a real enquiry time. */
  FUTURE_SLACK_MS: 10 * MINUTE,
  PLAUSIBLE_PAST_MS: 366 * DAY,
  CLAIM_MS: 5 * MINUTE,
  RETRY_BASE_MS: MINUTE,
  RETRY_MAX_MS: 6 * HOUR,
  MAX_ATTEMPTS: 8,
  SOURCE_LABEL: "IndiaMART",
  CAMPAIGN_NAME: "IndiaMART buyer enquiries",
  /* The recorded evidence: a buyer asking about a product is the existing
     explicit-request kind, which Sales maps to "requested product info". */
  EVENT_SOURCE: "indiamart",
  EVENT_KIND: "form_submitted",
});

const ROUTING_STATES = [
  pair("pending", "Waiting to be routed", {
    means: "GRAV has this enquiry and will route it on the next cycle.",
  }),
  pair("retrying", "Retrying", {
    means: "Routing hit a temporary problem. GRAV will try again at the time shown; nothing is duplicated.",
  }),
  pair("sent_to_sales", "Sent to Sales", {
    means: "Handed to Sales through the Marketing handover. Sales decides what happens next.",
  }),
  pair("held_for_review", "Held for review", {
    means: "GRAV will not send this to Sales on its own. The reason says why and what a person can do.",
  }),
  pair("not_routed", "Not routed to Sales", {
    means: "This is not a buyer enquiry to GRAV, so it is not sent to Sales automatically.",
  }),
  pair("dismissed", "Kept out of Sales", {
    means: "A person reviewed this and decided not to send it to Sales.",
  }),
];
const ROUTING_STATE_CODES = codes(ROUTING_STATES);

/* Why an enquiry is held or not routed. `release` says what a reviewer may
   supply to send it on; absent means it cannot be released. */
const HOLD_REASONS = [
  pair("kind_not_routed", "Not a buyer enquiry", {
    means: "Purchased Buy-Leads and catalog views are prospects, not buyers who contacted GRAV. They are never sent to Sales automatically.",
  }),
  pair("unclassified_type", "Unrecognised IndiaMART type", {
    means: "IndiaMART sent a type GRAV does not recognise, so GRAV cannot tell whether the buyer contacted GRAV.",
    release: "confirmBuyerEnquiry",
  }),
  pair("submitted_time_unknown", "Enquiry time could not be read", {
    means: "IndiaMART's time text is kept exactly as sent, but GRAV cannot read it, and it will not guess. A reviewer who checks the enquiry in IndiaMART's Lead Manager can confirm the time; GRAV records who confirmed it and how.",
    release: "confirmSubmittedAt",
  }),
  pair("submitted_time_implausible", "Enquiry time is not possible", {
    means: "GRAV read IndiaMART's time, but it is after GRAV received the enquiry or older than IndiaMART keeps enquiries, so it cannot be right. A reviewer can confirm the real time from IndiaMART's Lead Manager.",
    release: "confirmSubmittedAt",
  }),
  pair("too_old", "Older than 30 days", {
    means: "The enquiry time is valid, but it is more than 30 days ago, and Sales' handover accepts requests from the last 30 days. This usually follows downtime. It is not a problem with the time itself.",
  }),
  pair("contact_missing", "No way to reach the buyer", {
    means: "IndiaMART sent no phone number or email address for this buyer.",
  }),
  pair("contact_invalid", "Email address is not valid", {
    means: "The email address IndiaMART sent is not a valid address. A reviewer can send the enquiry on with the phone number only.",
    release: "usePhoneOnly",
  }),
  pair("name_missing", "No buyer name", {
    means: "IndiaMART sent no name, or only its \"IndiaMART Buyer\" placeholder. Sales' handover needs a name to address the buyer by.",
    release: "contactName",
  }),
  pair("company_name_missing", "No company name", {
    means: "Sales' handover needs the buyer's organisation, and IndiaMART sent none. A reviewer who knows it can supply it.",
    release: "companyName",
  }),
  pair("handover_blocked", "Handover blocked", {
    means: "The Marketing handover refused this enquiry. The detail gives its reason.",
  }),
  pair("handover_refused", "Handover rejected the details", {
    means: "The Marketing handover rejected a field of this enquiry. The detail names the field.",
  }),
  pair("routing_failed", "Routing kept failing", {
    means: "GRAV tried several times and could not route this enquiry. A reviewer can try again.",
    release: "retry",
  }),
];
const HOLD_REASON_CODES = codes(HOLD_REASONS);

/* Whether Sales has it yet, read from the handover's own outbox row. */
const DELIVERY_STATES = [
  pair("delivered", "Sales has it", { means: "The handover reached Sales." }),
  pair("pending", "On its way to Sales", { means: "The handover is recorded; delivery to Sales is being retried." }),
];

/* What Sales did, read from the handover's state. */
const SALES_OUTCOMES = [
  pair("awaiting_sales_review", "Awaiting Sales", { means: "Sales has not decided yet." }),
  pair("accepted", "Accepted by Sales", { means: "Sales accepted the prospect." }),
  pair("returned", "Returned to Marketing", { means: "Sales returned it with a reason." }),
  pair("rejected", "Rejected by Sales", { means: "Sales decided not to pursue it." }),
  pair("duplicate_linked", "Linked to an existing record", { means: "Sales linked it to a record it already had." }),
];
const SALES_OUTCOME_BY_STATE = freeze({
  AWAITING_REVIEW: "awaiting_sales_review",
  ACCEPTED: "accepted",
  RETURNED: "returned",
  REJECTED: "rejected",
  DUPLICATE_LINKED: "duplicate_linked",
});

const COVERAGE_FRESHNESS = [
  pair("never_checked", "Not checked yet", { means: "GRAV has not fetched from IndiaMART yet." }),
  pair("current", "Up to date", { means: "GRAV has read IndiaMART up to the last half hour." }),
  pair("catching_up", "Catching up", { means: "Checks are succeeding, and GRAV is still reading earlier days it missed. Each check covers up to 7 days." }),
  pair("stalled", "Not up to date", { means: "No check has succeeded for over half an hour. Enquiries since the time shown have not been fetched." }),
];

module.exports = freeze({
  SOURCE,
  SOURCE_LABEL,
  ENDPOINT,
  KEY_PAGE,
  CONTRACT_URL,
  KEY_ENV,
  LIMITS,
  KINDS,
  KIND_CODES,
  QUERY_TYPES,
  kindFor,
  PLACEHOLDER_NAMES,
  CONNECTION_STATES,
  CONNECTION_CODES,
  ERRORS,
  ERROR_CODES,
  ERROR_BY_CODE,
  PROVIDER_CODE_TO_ERROR,
  RUN_OUTCOMES,
  CHECK_BLOCKS,
  COVERAGE_NOTES,
  AUTOMATIC_CHECK_STATES,
  SCHEDULED_CYCLE_OUTCOMES,
  SCHEDULED_CYCLE_OUTCOME_CODES,
  CONTACT_FIELDS,
  CONTEXT_FIELDS,
  PROVENANCE,
  SCHEDULE,
  ROUTING,
  ROUTING_STATES,
  ROUTING_STATE_CODES,
  HOLD_REASONS,
  HOLD_REASON_CODES,
  DELIVERY_STATES,
  SALES_OUTCOMES,
  SALES_OUTCOME_BY_STATE,
  COVERAGE_FRESHNESS,
});
