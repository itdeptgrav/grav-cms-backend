// constants/marketingLeadProcessing.js
//
// TURNING A SUBMITTED ENQUIRY INTO A PERSON GRAV KNOWS.
//
// ── THREE EFFECTS, IN ORDER, EACH ONCE ─────────────────────────────────────
// Resolve who it was, record that they did something, and decide whether they
// agreed to be marketed to. Every one of those writes to a different canonical
// boundary, and every one must survive the process dying in the middle.
//
// ── WHY THE STAGES ARE NAMED RATHER THAN COUNTED ───────────────────────────
// A numeric "step 2 of 4" tells a resuming worker nothing about what already
// happened. These say what is DONE, so a crash resumes at the first unfinished
// effect and repeats none of the finished ones — and so somebody reading a
// stuck receipt can see which of three quite different things went wrong.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── THE PROCESSING CONTRACT'S OWN VERSION ──────────────────────────────────
   Part of a receipt's identity. If the rules below change — what counts as
   agreement, which identifiers may match — the old receipts describe decisions
   made under the old rules, and reprocessing under the new ones is a different
   question with a different answer. A version makes that a new receipt rather
   than a quiet overwrite of an old conclusion. */
const CONTRACT_VERSION = 1;

/* ── STAGES ─────────────────────────────────────────────────────────────────
   `completed` is the only terminal success. The two terminal failures are
   deliberately separate: `needs_human_review` is a question nobody can answer
   automatically, and `refused` is a fact that will not change. Retrying either
   is pointless, but only one of them is anybody's job. */
const STAGES = [
  pair("pending_identity", "Waiting to be matched to a person", {
    means: "The enquiry is recorded. GRAV has not yet worked out who submitted it.",
    terminal: false,
  }),
  pair("identity_resolved", "Matched to a person", {
    means: "GRAV knows which person this enquiry belongs to.",
    terminal: false,
  }),
  pair("engagement_recorded", "Engagement recorded", {
    means: "The submission is recorded as something this person did.",
    terminal: false,
  }),
  pair("consent_evaluated", "Marketing permission decided", {
    means: "GRAV has decided whether this submission proves permission to market to them.",
    terminal: false,
  }),
  pair("completed", "Finished", {
    means: "Everything GRAV does with a submitted enquiry has been done.",
    terminal: true,
  }),
  pair("needs_human_review", "Needs somebody to look", {
    /* Not a failure of GRAV's. A question only a person can answer. */
    means: "GRAV cannot safely decide something about this enquiry on its own.",
    terminal: true,
  }),
  pair("retryable_failure", "Temporarily stuck", {
    means: "Something went wrong that may work on another attempt. The enquiry is safe.",
    terminal: false,
  }),
  pair("refused", "Cannot be processed", {
    means: "This enquiry cannot be processed, and trying again would not change that.",
    terminal: true,
  }),
];
const STAGE_CODES = codes(STAGES);
const STAGE_BY_CODE = freeze(Object.fromEntries(STAGES.map((s) => [s.code, s])));
const TERMINAL_STAGES = freeze(STAGES.filter((s) => s.terminal).map((s) => s.code));

/* The order effects happen in. A resuming worker starts at the first one the
   receipt does not already record. */
const STAGE_ORDER = freeze([
  "pending_identity", "identity_resolved", "engagement_recorded",
  "consent_evaluated", "completed",
]);

/* ── WHY A RECEIPT STOPPED ──────────────────────────────────────────────────
   Stable codes, never prose built from what somebody submitted. A reason that
   quoted an email address would put a person's details into a log, a metric
   label and every alert built on them. */
const REASONS = [
  pair("identity_conflict", "Two different people match", {
    means: "The email address belongs to one person GRAV knows and the phone number to another. GRAV will not guess which, and will not merge them.",
    stage: "needs_human_review",
  }),
  pair("no_usable_identifier", "No way to recognise the person", {
    means: "The enquiry has neither a usable email address nor a usable phone number, so GRAV cannot tell who it is from or reply to them.",
    stage: "needs_human_review",
  }),
  pair("consent_not_requested", "Permission was not asked for", {
    means: "This form did not ask for marketing permission, so none is recorded. The enquiry still stands.",
    stage: "consent_evaluated",
  }),
  pair("consent_answer_absent", "No answer to the permission question", {
    means: "The form asked for marketing permission and the person did not answer. Silence is not agreement.",
    stage: "consent_evaluated",
  }),
  pair("consent_answer_ambiguous", "The answer does not clearly mean yes", {
    means: "GRAV could not read the answer as unambiguous agreement, so no permission is recorded.",
    stage: "consent_evaluated",
  }),
  pair("consent_notice_unproven", "The wording shown cannot be proven", {
    means: "GRAV cannot establish exactly which permission wording this person saw, so it will not record permission they may not have given.",
    stage: "consent_evaluated",
  }),
  pair("consent_notice_mismatch", "The answer and the recorded wording disagree", {
    means: "What the form recorded and what arrived do not describe the same permission request.",
    stage: "consent_evaluated",
  }),
  pair("consent_recorded", "Permission recorded", {
    means: "The person explicitly agreed to the exact wording the form showed.",
    stage: "consent_evaluated",
  }),
  pair("possible_duplicate_submission", "Looks like an enquiry GRAV already has", {
    /* ── WHY THIS IS HELD RATHER THAN MERGED OR PROCESSED ──────────────────
       Google delivers leads two ways — pushed to the webhook and read back
       through its API — and nowhere documents that the two carry the same
       identifier. If they do, the ids converge and this never fires. If they
       ever differ, one enquiry would arrive twice under two ids.

       Processing both would give one person two engagements. Merging them
       would be guessing. So a second copy that matches an existing enquiry on
       everything but its id is kept as evidence and held for a person. */
    means: "This enquiry matches one GRAV already received on the same form, from the same click, at the same moment, but under a different reference. GRAV has kept it and done nothing with it until somebody confirms whether it is the same enquiry.",
    stage: "needs_human_review",
  }),
  pair("submission_missing", "The enquiry is gone", {
    means: "The submission this receipt describes cannot be found.",
    stage: "refused",
  }),
];
const REASON_CODES = codes(REASONS);
const REASON_BY_CODE = freeze(Object.fromEntries(REASONS.map((r) => [r.code, r])));

/* ── WHAT COUNTS AS AGREEING ────────────────────────────────────────────────
   A closed list, matched exactly after trimming and lower-casing. Nothing
   fuzzy, nothing that "looks positive".

   The temptation is a heuristic — anything starting with "y", anything not
   obviously negative — and it is wrong in the one direction that matters.
   Recording permission somebody did not give is a legal claim GRAV cannot
   support, and it is the kind of mistake that is invisible until somebody
   complains about an email they never agreed to. Not recording permission
   somebody did give costs one marketing email.

   So an answer that is not on this list is not agreement, and the person keeps
   everything else. */
const AGREEMENT_ANSWERS = freeze([
  "yes", "true", "agreed", "agree", "i agree", "opt in", "opt-in", "opted in",
  "subscribe", "subscribed", "accept", "accepted", "consent", "i consent",
]);

/* Named so a refusal can say the answer was understood and meant no, rather
   than that it could not be read — a distinction a person reviewing this will
   want. Everything outside BOTH lists is ambiguous. */
const REFUSAL_ANSWERS = freeze([
  "no", "false", "decline", "declined", "opt out", "opt-out", "opted out",
  "unsubscribe", "reject", "rejected", "disagree",
]);

/* ── AND WHAT IS NEVER AGREEMENT, WHATEVER IT LOOKS LIKE ────────────────────
   Recorded as data because each one has been argued for at some point, and
   each one is somebody reasoning from "they gave us their email, surely". */
const NEVER_CONSENT = freeze([
  pair("email_supplied", "Giving an email address", {
    why: "A person asking for a quote gave an address so somebody could reply to them about the quote.",
  }),
  pair("phone_supplied", "Giving a phone number", { why: "As above." }),
  pair("form_submitted", "Submitting the form at all", {
    why: "Submitting a form is asking for the thing the form offered, not agreeing to be marketed to afterwards.",
  }),
  pair("notice_displayed", "A notice being shown", {
    why: "Showing somebody a disclosure is not the same as them agreeing to it.",
  }),
  pair("provider_disclaimer", "Google's own disclaimer", {
    why: "It tells the person their details go to the advertiser. It is not a permission they granted.",
  }),
  pair("privacy_policy_url", "A privacy-policy link", {
    why: "A link to a policy is a requirement of running the form, not an agreement to anything.",
  }),
  pair("preselected_answer", "A pre-ticked box", {
    why: "Agreement somebody did not actively give.",
  }),
  pair("positive_qualification", "A positive-sounding qualification answer", {
    why: "\"Interested in booking an event\" answers a question about the enquiry. It is not permission to email them.",
  }),
  pair("missing_answer", "No answer at all", { why: "Silence is not agreement." }),
  pair("unknown_field", "An answer GRAV does not recognise", {
    why: "GRAV cannot know what question it answered, so it cannot know what was agreed to.",
  }),
]);

/* Which column on a lead form, if any, is the permission question. Bound from
   the form's own definition — never from anything the webhook supplied. */
const CONSENT_COLUMN_POLICY = freeze({
  fromBindingOnly: true,
  why: "A notice identifier or version arriving in a delivery is a value the sender chose. Consent evidence has to come from what GRAV recorded when the form was built.",
});

/* ═══════════════════════════════════════════════════════════════════════════
   RECOVERY — FINISHING WORK THAT STOPPED, AND FETCHING LEADS THAT NEVER ARRIVED
   ═══════════════════════════════════════════════════════════════════════════
   Two different gaps, closed by two different sweeps.

   INTERNAL: GRAV answered Google and then stopped before processing — a
   restart, a deploy, a crash. The enquiry is safe; its processing is not
   finished. Closed by a durable command written with the enquiry, and a sweep
   that finds any enquiry whose processing never completed.

   EXTERNAL: Google never delivered, or GRAV was down when it tried. The
   enquiry is not in GRAV at all. Closed by reading Google's own record of
   submissions, which it keeps for 60 days and not a day longer. */
const RECOVERY = freeze({
  /* A receipt untouched for this long is assumed abandoned by whatever started
     it. Long enough that a sweep never races a worker that is merely slow. */
  STALE_AFTER_MS: 5 * 60 * 1000,
  /* Per run, so one sweep cannot monopolise the database. The next run
     continues where this one stopped. */
  INTERNAL_BATCH: 100,
  /* A receipt that has failed this many times is left for an operator. The
     sweep counts it as exhausted rather than retrying it for ever and hiding
     a real fault behind an endless loop of attempts. */
  MAX_ATTEMPTS: 10,

  /* ── GOOGLE KEEPS LEADS FOR 60 DAYS ──────────────────────────────────────
     Its own words. A lead older than this is not late, it is gone, and no
     sweep can bring it back. */
  PROVIDER_RETENTION_DAYS: 60,

  /* ── RE-READ A LITTLE OF WHAT WAS ALREADY READ ───────────────────────────
     Google's submission times carry the ADVERTISING ACCOUNT's timezone offset,
     and a filter on them is evaluated in that zone. A day of overlap covers
     every possible offset and a submission that became visible late. Re-read
     rows cost nothing: deduplication recognises every one of them. */
  OVERLAP_MS: 24 * 60 * 60 * 1000,

  /* ── BOUNDS PER RUN ─────────────────────────────────────────────────────
     Google v25 fixes a search page at 10,000 rows and refuses a page size, so
     the bounds are GRAV's: new enquiries brought in, Google pages read, and
     bindings visited. A backlog larger than one run continues next run from
     the saved (time, id) cursor. Rows GRAV already holds are recognised by one
     lookup per page and cost no write. */
  MAX_NEW_ROWS_PER_RUN: 500,
  MAX_PAGES_PER_RUN: 3,
  MAX_BINDINGS_PER_RUN: 20,
  /* A run that has not released its lease in this long is presumed dead. */
  LEASE_MS: 10 * 60 * 1000,
  /* How often the scheduler looks for companies with bound lead forms. */
  SCHEDULE_EVERY_MS: 60 * 60 * 1000,
});

/* ── WHAT A SCREEN MAY SAY ABOUT RECOVERY ───────────────────────────────────
   Provider-neutral, and honest about the one limit that matters: Google's 60
   days. Never a cursor, never a page token, never a count of API calls. */
const COVERAGE_STATES = [
  pair("recovery_current", "Checked recently", {
    means: "GRAV has recently checked the advertising channel for any enquiry it may have missed.",
  }),
  pair("recovery_behind", "Not checked recently", {
    means: "GRAV has not checked the advertising channel for missed enquiries recently. Enquiries that were delivered normally are unaffected.",
  }),
  pair("recovery_never_run", "Not checked yet", {
    means: "GRAV has not yet checked the advertising channel for missed enquiries on this campaign.",
  }),
  pair("recovery_gap", "Some enquiries may be unrecoverable", {
    /* ── THE PROMISE ENDS WHERE GOOGLE'S RETENTION DOES ─────────────────────
       Stated, not implied. A screen that said "all enquiries recovered" after
       a long outage would be claiming something no sweep can do. */
    means: "GRAV had not checked for missed enquiries for longer than the advertising channel keeps them. Any enquiry from before the dates shown, if it was never delivered, can no longer be recovered.",
  }),
  pair("recovery_unavailable", "Cannot check right now", {
    means: "GRAV cannot check the advertising channel for missed enquiries on this campaign at the moment. Enquiries delivered normally still arrive.",
  }),
];
const COVERAGE_STATE_CODES = codes(COVERAGE_STATES);

/* ── WHY A PERSON SHOULD LOOK AT RECOVERY ───────────────────────────────────
   Closed, provider-neutral, and each one names who can fix it. Mapped from
   GRAV's own failure codes, never from a provider message. */
const ATTENTION_REASONS = [
  pair("campaign_not_created", "The campaign does not exist yet", {
    means: "GRAV has not created this lead form's campaign in the advertising channel, so there is nothing to check yet.",
  }),
  pair("oauth_unavailable", "Sign-in needs reconnecting", {
    means: "The advertising channel declined GRAV's sign-in. An administrator needs to reconnect it.",
  }),
  pair("api_access_unavailable", "API access needs granting", {
    means: "The cloud project GRAV signs in through has no access to the advertising API. An administrator needs to grant it.",
  }),
  pair("account_binding_unavailable", "The advertising account needs reviewing", {
    means: "The bound advertising account cannot be reached as configured. An administrator needs to review the binding.",
  }),
  pair("access_refused", "Access was refused", {
    means: "The advertising channel refused GRAV access to this account.",
  }),
  pair("api_version_rejected", "GRAV needs updating", {
    means: "The advertising channel did not accept the API version GRAV uses.",
  }),
  pair("provider_unavailable", "The channel did not answer", {
    means: "The advertising channel did not answer. GRAV will try again.",
  }),
  pair("not_configured", "The channel is not connected", {
    means: "This deployment has no connection to the advertising channel.",
  }),
  pair("backlog", "Still catching up", {
    means: "More enquiries were waiting than one check handles. The next check continues where this one stopped.",
  }),
];

/* A check older than this is reported as behind. */
const COVERAGE_CURRENT_WITHIN_MS = 24 * 60 * 60 * 1000;

/* ── THE STATES A SCREEN MAY SHOW ───────────────────────────────────────────
   Provider-neutral, marketer-facing. No stage names, no retry counters, no
   reason codes that describe GRAV's internals. */
const PUBLIC_STATES = [
  pair("lead_recorded", "Enquiry received", {
    means: "Somebody submitted the form and GRAV has their enquiry.",
  }),
  pair("matched_existing_person", "Matched to somebody you know", {
    means: "This enquiry belongs to a person already in Marketing.",
  }),
  pair("new_person_created", "New person", {
    means: "GRAV had not seen this person before and has added them.",
  }),
  pair("needs_identity_review", "Needs a person to look", {
    means: "GRAV cannot tell which person this enquiry belongs to and will not guess.",
  }),
  pair("engagement_recorded", "Counted as engagement", {
    means: "Submitting the form is recorded as something this person did.",
  }),
  pair("marketing_permission_recorded", "Agreed to marketing", {
    means: "This person explicitly agreed to the wording the form showed.",
  }),
  pair("no_marketing_permission_recorded", "No marketing permission", {
    /* ── NOT A REFUSAL, AND THE WORDING MATTERS ────────────────────────────
       Somebody who asked for a quote and was never asked about marketing has
       not said no. Showing this as "opted out" would suppress a person who
       never declined anything. */
    means: "No marketing permission is recorded for this person. That is not the same as them saying no, and it changes nothing else about this record.",
  }),
  pair("processing_incomplete", "Still being processed", {
    means: "GRAV has the enquiry and has not finished working through it.",
  }),
];
const PUBLIC_STATE_CODES = codes(PUBLIC_STATES);

module.exports = freeze({
  CONTRACT_VERSION,
  STAGES,
  STAGE_CODES,
  STAGE_BY_CODE,
  STAGE_ORDER,
  TERMINAL_STAGES,
  REASONS,
  REASON_CODES,
  REASON_BY_CODE,
  AGREEMENT_ANSWERS,
  REFUSAL_ANSWERS,
  NEVER_CONSENT,
  CONSENT_COLUMN_POLICY,
  PUBLIC_STATES,
  PUBLIC_STATE_CODES,
  RECOVERY,
  COVERAGE_STATES,
  COVERAGE_STATE_CODES,
  COVERAGE_CURRENT_WITHIN_MS,
  ATTENTION_REASONS,
  ATTENTION_REASON_CODES: codes(ATTENTION_REASONS),
});
