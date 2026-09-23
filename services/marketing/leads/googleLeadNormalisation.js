// services/marketing/leads/googleLeadNormalisation.js
//
// ONE SUBMITTED LEAD, IN GRAV'S OWN WORDS.
//
// ── PURE. NO I/O, NO CLOCK, NO DATABASE, NO PROVIDER ───────────────────────
// It takes what Google sent and returns what GRAV keeps. Everything that
// decides, stores or contacts anything is elsewhere.
//
// ── BOTH DOORS LEAD HERE ───────────────────────────────────────────────────
// A lead reaches GRAV two ways: pushed over the webhook, or pulled back by the
// recovery sweep. They arrive in different shapes — `column_id`/`string_value`
// from one, `field_type`/`field_value` from the other — and they are the same
// submission.
//
// If each had its own normaliser they would drift, and the drift would show up
// as one lead stored twice with slightly different contents, which is the exact
// thing deduplication exists to prevent. So both are converted to the same
// shape first and then normalised by the same function.
//
// ── AND THE SECRET NEVER TOUCHES THE RESULT ────────────────────────────────
// `google_key` is read by the verifier and is not carried into anything this
// file returns. A normalised lead is stored, indexed, read back and rendered;
// a secret that rode along inside one would end up in all of those.
"use strict";

const W = require("../../../constants/marketingGoogleLeadWebhook");

const str = (v) => String(v ?? "").trim();
const arr = (v) => (Array.isArray(v) ? v : []);

/* ── INT64 IDS ARE READ AS TEXT ─────────────────────────────────────────────
   Google says four times that these are 8-byte integers. `JSON.parse` turns
   one above 2^53 into a nearby number, silently, and the correlation it was
   for then matches nothing.

   A number that survived parsing intact is still converted with `BigInt` where
   possible so the digits are exactly what arrived, and anything unparseable is
   kept as text rather than coerced. */
function int64Text(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return /^-?\d+$/.test(value.trim()) ? value.trim() : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    /* Above this, the value in hand is already approximate — the digits were
       lost before this function saw them. Kept, because a nearly-right id is
       better evidence than none, and flagged by the caller. */
    if (!Number.isSafeInteger(value)) return String(BigInt(Math.trunc(value)));
    return String(value);
  }
  return "";
}

/* An instant from either documented timestamp shape, or null. Never a guess:
   an unparseable time is absent rather than "now". */
function instantOf(raw) {
  const text = str(raw);
  if (!text) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text) ? text.replace(" ", "T") : text;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/* True only for a genuine `true` or the string "true". Google: "If value is
   false or if field is not present, treat this lead as valid production lead."
   A missing flag is production, and nothing else may make it a test. */
const isTrue = (v) => v === true || str(v).toLowerCase() === "true";

/* ── THE TWO WIRE SHAPES, MADE ONE ────────────────────────────────────────── */

/** Webhook: `{ column_id, string_value, column_name }`. */
const fromWebhookColumns = (userColumnData) => arr(userColumnData).map((c) => ({
  columnId: str(c?.column_id),
  value: str(c?.string_value),
}));

/** Retrieval: `{ field_type, field_value }` on `lead_form_submission_fields`. */
const fromRetrievalFields = (fields) => arr(fields).map((f) => ({
  columnId: str(f?.field_type),
  value: str(f?.field_value),
}));

/* ── CUSTOM QUESTIONS HAVE NO FIELD TYPE ────────────────────────────────────
   `CustomLeadFormSubmissionField` is `{ question_text, field_value }` — there
   is no `field_type` on it at all. An earlier version read custom answers
   through `fromRetrievalFields`, found an empty column id on every one, and
   skipped them: a recovered answer to a custom question vanished without a
   trace.

   GRAV does not offer custom questions, so one appearing means somebody built
   the form outside GRAV. Its answer is kept, under a fixed code, flagged for
   review and uninterpreted — the question text is advertiser prose, not an
   identifier, and is not treated as one. */
const CUSTOM_QUESTION_CODE = "CUSTOM_QUESTION";

const fromCustomFields = (fields) => arr(fields)
  .filter((f) => str(f?.field_value))
  .map((f) => ({ columnId: CUSTOM_QUESTION_CODE, value: str(f.field_value) }));

/**
 * Turn submitted columns into contact details, answers and anything unknown.
 *
 * `column_name` is never read. Google marks it deprecated and says it "might
 * not always be populated" — a mapping built on it works in testing, where
 * every sample carries one, and starts dropping fields in production.
 */
function mapColumns(columns) {
  const contact = {};
  const answers = [];
  const unmapped = [];
  let phoneVerified = null;

  for (const { columnId, value } of columns) {
    if (!columnId) continue;

    const capped = value.length > W.LIMITS.MAX_VALUE_CHARS
      ? value.slice(0, W.LIMITS.MAX_VALUE_CHARS)
      : value;

    if (columnId === W.PHONE_VERIFIED_COLUMN) {
      /* The only thing on this payload Google itself checked — and it checked
         that a phone line answers, not who owns it. */
      phoneVerified = isTrue(capped);
      continue;
    }

    const contactField = W.CONTACT_COLUMNS[columnId];
    if (contactField) {
      if (capped) contact[contactField] = capped;
      continue;
    }

    const question = W.QUESTION_COLUMNS[columnId];
    if (question) {
      answers.push({
        code: columnId,
        /* The question Google showed, stored beside the answer. "51-200" means
           nothing on its own. */
        question,
        answer: capped,
        /* ── NEVER A FACT ABOUT AN EMPLOYER ────────────────────────────────
           Somebody typed this about themselves and nothing checked it. The
           flag travels with the answer so no read model can lose it. */
        selfReported: true,
      });
      continue;
    }

    /* Kept, flagged, uninterpreted. */
    unmapped.push({
      code: columnId,
      answer: capped,
      selfReported: true,
      needsReview: true,
      means: W.UNMAPPED_POLICY.means,
    });
  }

  return { contact, answers, unmapped, phoneVerified };
}

/**
 * Normalise one delivery, from either door.
 *
 * @param {object} args
 * @param {"webhook"|"retrieval"} args.via
 * @param {object} args.payload   the delivery, already parsed
 * @param {object} [args.rawIds]  int64 ids read as text from the raw body
 * @returns {{ok: boolean, reason?: string, lead?: object}}
 */
function normalise({ via, payload, rawIds = {} } = {}) {
  const p = payload && typeof payload === "object" ? payload : {};

  const leadId = str(p.lead_id || p.id);
  if (!leadId) {
    /* Without it there is no way to recognise the same lead twice, and
       at-least-once delivery guarantees there will be a second time. */
    return { ok: false, reason: "missing_lead_id" };
  }

  const columns = via === "retrieval"
    ? [
      ...fromRetrievalFields(p.lead_form_submission_fields),
      ...fromCustomFields(p.custom_lead_form_submission_fields),
    ]
    : fromWebhookColumns(p.user_column_data);

  if (columns.length > W.LIMITS.MAX_COLUMNS) {
    return { ok: false, reason: "too_many_columns" };
  }

  const { contact, answers, unmapped, phoneVerified } = mapColumns(columns);

  if (!Object.keys(contact).length && !answers.length && !unmapped.length) {
    return { ok: false, reason: "no_submitted_data" };
  }

  /* ── IDS: RAW TEXT WINS ──────────────────────────────────────────────────
     The caller reads these out of the untouched body, where the digits are
     still exactly what Google sent. The parsed object is a fallback for a
     value small enough to have survived. */
  const idOf = (field) => str(rawIds[field]) || int64Text(p[field]);

  /* ── ONE INSTANT, WHICHEVER DOOR ────────────────────────────────────────
     The webhook sends ISO-8601 (`2024-09-26T12:30:00Z`). The API sends
     `2019-01-01 12:32:45-08:00` — a space instead of a `T`, and an offset in
     the account's own timezone. Both are turned into the same instant here, so
     the same submission read through either door has the same time. */
  const rawTime = str(p.lead_submit_time || p.submission_date_time);
  const submittedAt = instantOf(rawTime);

  return {
    ok: true,
    lead: {
      /* Google's identity for this submission. The deduplication key, always
         scoped by company and channel by the caller — the same id from two
         companies is two leads. */
      providerLeadId: leadId,
      channel: "google_ads",

      /* ── PRODUCTION UNLESS GOOGLE SAYS OTHERWISE ────────────────────────
         Google: a missing or false flag is a production lead. A test lead
         must never become a person, an engagement, a consent record or a
         prospect, so this one boolean gates all four. */
      isTest: isTrue(p.is_test),

      submittedAt: submittedAt || null,
      source: str(p.lead_source) || null,
      stage: str(p.lead_stage) || null,
      clickId: str(p.gcl_id || p.gclid) || null,
      apiVersion: str(p.api_version) || null,

      /* ── CORRELATION ONLY, NEVER PUBLISHED ──────────────────────────────
         These name somebody's advertising account objects. They exist so a
         lead can be tied back to the campaign that produced it, and the read
         models strip them. */
      correlation: {
        formId: idOf("form_id"),
        campaignId: idOf("campaign_id"),
        adGroupId: idOf("adgroup_id"),
        creativeId: idOf("creative_id"),
        assetGroupId: idOf("asset_group_id"),
      },

      contact,
      answers,
      unmapped,
      phoneVerified,

      receivedVia: via === "retrieval" ? "recovery" : "delivery",
    },
  };
}

/* ── WHAT THE PERSON CAN BE REACHED BY ──────────────────────────────────────
   A lead with neither is one nobody can reply to. Kept as a question the
   caller asks rather than a refusal here: the submission is still evidence
   that somebody engaged, even if replying to them is impossible. */
const reachable = (lead) => Boolean(
  lead?.contact?.email || lead?.contact?.workEmail
  || lead?.contact?.phone || lead?.contact?.workPhone,
);

module.exports = {
  normalise,
  mapColumns,
  int64Text,
  reachable,
  instantOf,
  CUSTOM_QUESTION_CODE,
  __internals: { fromWebhookColumns, fromRetrievalFields, fromCustomFields, isTrue },
};
