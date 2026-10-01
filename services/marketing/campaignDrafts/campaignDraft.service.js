// services/marketing/campaignDrafts/campaignDraft.service.js
//
// THE GRAV CAMPAIGN PLAN: CREATION, EDITING, SUBMISSION AND DECISION.
//
// ── NOTHING HERE REACHES AN ADVERTISING CHANNEL ────────────────────────────
// No provider adapter is imported, no HTTP client is reachable, and `approved`
// creates nothing anywhere. The advertising adapters live one directory across and
// this file does not require any of them — a test asserts that, because the
// easiest way for this chunk to start spending money is for somebody to add a
// convenient import during the deployment chunk.
//
// ── WHAT A SUBMISSION DOES ─────────────────────────────────────────────────
// It freezes the document. An approver must decide on what they read, and if the
// author can keep editing while it waits then an approval attaches to a version
// that no longer exists — an audit trail saying somebody approved a plan they
// never saw. So `awaiting_approval` is not editable, and the way back to editable
// is a decision somebody is accountable for.
//
// ── AND WHO DECIDES IS NOT WHO WRITES ──────────────────────────────────────
// Marketing writes and submits. An administrator decides. Sales appears nowhere in
// this file: Sales owns whether to accept a prospect handover, and a campaign
// approval is a commitment of marketing budget, which is not the same authority.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const {
  DRAFT_STATES, DRAFT_STATE_CODES, EDITABLE_STATES, TRANSITIONS,
  APPROVAL_DECISIONS, APPROVAL_DECISION_CODES, CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_CODES, CONVERSION_GOALS, CONVERSION_GOAL_CODES,
  HISTORY_KINDS, LIMITS, UTM_PATTERN, state: stateSpec, decision: decisionSpec,
} = require("../../../constants/marketingCampaignDrafts");
const { MARKETING_CHANNELS, MARKETING_CHANNEL_CODES } = require("../../../constants/marketingChannels");
const { CONTENT_KINDS, CONTENT_KIND_CODES } = require("../../../constants/marketing");
const {
  MarketingCampaignDraft, MarketingCampaignDraftHistory,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const identity = require("./draftIdentity");
const readiness = require("./deploymentReadiness.service");
const dates = require("../channels/channelDates");
const allocation = require("./campaignAllocation.service");
const {
  RECORDABLE_CAMPAIGN_TYPE_CODES, BIDDING_STRATEGY_CODES, BUDGET_RELATIONSHIP_CODES,
  DESTINATION_KIND_CODES, EXCLUSION_DECISION_CODES, BRIEF_LIMITS,
  campaignType: readinessTypeSpec,
} = require("../../../constants/marketingDeploymentReadiness");
const {
  DRAFT_TEXT_MAX: LEAD_FORM_DRAFT_TEXT_MAX, LEAD_FORM_VOCABULARY,
} = require("../../../constants/marketingGoogleLeadForm");

const str = (v) => String(v ?? "").trim();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);

/* The type a caller actually sent, for a refusal that tells them what to fix. */
const typeName = (v) => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  return `a ${typeof v}`;
};

/* ── WHO MAY DO WHAT ────────────────────────────────────────────────────────
   Two roles, and the difference between them is the control this chunk exists
   to provide. `admin` and `ceo` decide; `marketing` writes. An administrator may
   also write, because in the internal first release the same person often does
   both and blocking that would mean an administrator cannot fix a typo.

   What an administrator may NOT do is approve their own submission — see
   `assertNotSelfApproval`. */
const isApprover = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));
const isAuthor = (user) => isApprover(user) || str(user?.role) === "marketing";

/**
 * The actor for an audit row, or a refusal.
 *
 * ── AN AUDIT ROW NEEDS AN IDENTITY, NOT A DISPLAY NAME ─────────────────────
 * The first version defaulted a missing or malformed id to `null` and fell back
 * to comparing emails for the self-approval rule. Both were wrong together: a
 * claim with no id and no email produced an audit row attributable to nobody, and
 * it bypassed the second-person rule entirely, because two actors who are both
 * "nobody" never compare equal.
 *
 * So a stable id is REQUIRED before anything is written. Name and email remain
 * display snapshots — an employee can be renamed or deactivated and the row must
 * still say who acted — and the id is the authority.
 */
function actorFrom(user) {
  const raw = str(user?.id);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("CAMPAIGN_DRAFT_ACTOR_UNVERIFIED",
      "GRAV records who changed a campaign plan, so this needs a signed-in identity it can attribute the change to.",
      { field: "actor" });
  }
  return {
    id: new mongoose.Types.ObjectId(raw),
    /* Snapshots. Never the authority for anything. */
    name: str(user?.name),
    email: str(user?.email).toLowerCase(),
    role: str(user?.role),
  };
}

/* ── THE COMPANY GATE ───────────────────────────────────────────────────────
   Unlike the advertising channels, a campaign plan is a pure GRAV document with
   no shared external account behind it, so there is no single configured company
   to compare against — every company may have its own plans. The guarantee here
   is narrower and stricter: the company comes from the caller's membership and
   appears in EVERY selector, so a query cannot reach another company's rows even
   if a public identifier leaked. */
function assertCompany(companyId) {
  const id = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "A campaign plan needs a proven company.");
  }
  return new mongoose.Types.ObjectId(id);
}

/* ═══ THE PAYLOAD ALLOWLIST ═════════════════════════════════════════════════

   ── AN UNKNOWN FIELD IS REFUSED, NOT IGNORED ──────────────────────────────
   Silently dropping a field somebody sent leaves them believing GRAV stored it.
   That is how a marketer ends up convinced they set a budget. Worse, it is how a
   provider credential or a raw provider campaign id gets "saved": accepted,
   ignored, and reported as success.

   So the list is closed, and anything outside it is named in the refusal. */
const CREATE_FIELDS = Object.freeze([
  "name", "objective", "description", "channels",
  "audienceReference", "qualificationNotes",
  "contentRefs", "startDate", "endDate",
  "budgetAmount", "budgetCurrency", "budgetBasis",
  "conversionGoal", "utmCampaign",
  /* The per-channel deployment briefs. Part of the plan, so editing one obeys the
     same editable-state and revision rules as any other field: a submitted plan's
     brief is frozen. */
  "deploymentBriefs",
  /* Not a plan field. The creation idempotency key, so a retry after a dropped
     connection continues the same plan instead of minting a second reference and a
     second identity claim. Accepted here and never stored on the plan. */
  "idempotencyKey",
]);

/* The same fields, plus the revision a caller must state. No `state`: a state
   change is a transition with its own route and its own audit row, never a field
   somebody PATCHes. */
const UPDATE_FIELDS = Object.freeze([
  ...CREATE_FIELDS.filter((f) => f !== "idempotencyKey"),
  "expectedRevision",
]);

/* ── FIELDS REFUSED BY NAME, LOUDLY ─────────────────────────────────────────
   These would all be caught by the allowlist as "unknown". They are called out
   separately so the refusal can say WHY rather than "not a field" — somebody
   sending an access token needs to be told GRAV does not store one, not that
   they misspelled something.

   ── MATCHED ON WORDS, NOT ON SUBSTRINGS ──────────────────────────────────
   The first version tested `normalised.includes(part)`, which refused
   `description` because "de-SCRIPT-ion" contains "script". Substring matching
   over a list of short words refuses real fields and will keep doing it:
   `accountId` contains "count", `secretary` contains "secret", `notes` would
   collide with any list containing "note".

   So a field name is split into WORDS — on separators and on camel-case humps —
   and a word is refused only when it is one of these outright. `description`
   tokenises to `["description"]` and survives; `customHtml` tokenises to
   `["custom", "html"]` and does not. */
const REFUSED_WORDS = new Set([
  /* Credentials. */
  "token", "secret", "password", "credential", "credentials", "bearer",
  "apikey", "privatekey", "passphrase",
  /* `apiKey` tokenises to ["api", "key"], so the joined form above never matches
     it. No field in a campaign plan legitimately contains the word "key", which
     makes banning it outright safe here and is why it is in this list rather
     than expressed as a two-word rule nobody would maintain. */
  "key",
  /* Executable or markup content. Content lives in the content library. */
  "script", "javascript", "html", "snippet", "customcode", "tagcode",
]);

/* Whole field names, for the cases a single word cannot express. `accountId` on
   its own is innocuous in most schemas and here it could only be an advertising
   account somebody pasted in, so it is refused as a complete name rather than by
   banning the word "account". */
const REFUSED_NAMES = new Set([
  "providercampaignid", "externalcampaignid", "googlecampaignid", "metacampaignid",
  "adaccountid", "advertisingaccountid", "customerid", "accountid", "propertyid",
  "clientid", "appid", "appsecret", "developertoken", "apikey", "apisecret",
]);

/* `accessToken` → `access token`; `access_token` → `access token`;
   `ACCESSTOKEN` → `accesstoken`, which the name list below catches instead. */
const words = (key) => str(key)
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .filter(Boolean);

const normaliseKey = (k) => str(k).toLowerCase().replace(/[^a-z0-9]/g, "");

const isRefusedField = (key) => {
  if (REFUSED_NAMES.has(normaliseKey(key))) return true;
  return words(key).some((w) => REFUSED_WORDS.has(w));
};

function assertAcceptableFields(payload, allowed, { label }) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw fail("VALIDATION", `${label} needs a JSON object.`, { received: typeName(payload) });
  }

  const keys = Object.keys(payload);

  /* ── THE ALLOWLIST IS CONSULTED FIRST, AND IT IS FINAL ───────────────────
     The heuristic below only ever sees fields GRAV does not accept. Running it
     over every key instead refused `idempotencyKey`, because the word "key" is on
     the credential list to catch `apiKey` — a field GRAV explicitly accepts was
     rejected by a guess about field names. A heuristic that can override an
     explicit decision is a heuristic in the wrong place. */
  const unknown = keys.filter((k) => !allowed.includes(k));
  if (!unknown.length) return keys;

  /* Among the unknown ones, the credential- and code-shaped names get a reason
     rather than "not a field". Somebody sending an access token needs to be told
     GRAV does not store one, not that they misspelled something. */
  const refused = unknown.filter(isRefusedField);
  if (refused.length) {
    throw fail("VALIDATION",
      `A campaign plan is a GRAV document: it holds no provider credentials, no provider campaign identifiers and no embedded code, so ${refused.join(", ")} ${refused.length === 1 ? "was" : "were"} refused rather than saved.`,
      { refused });
  }

  throw fail("VALIDATION",
    `${label} does not accept ${unknown.join(", ")}. Sending a field GRAV ignores would leave you believing it was saved.`,
    { unknown, accepted: allowed });
}

/* ═══ FIELD VALIDATION ══════════════════════════════════════════════════════

   Each of these refuses rather than coerces. `Number("50000abc")` is NaN and
   `Number(null)` is 0 — the second is the dangerous one, because a null budget
   would become a zero budget that looks like a decision somebody made. */

function assertName(value) {
  if (typeof value !== "string") {
    throw fail("VALIDATION", `name must be text, not ${typeName(value)}.`, { field: "name" });
  }
  const v = value.trim();
  if (!v) throw fail("VALIDATION", "A campaign plan needs a name.", { field: "name" });
  if (v.length > LIMITS.NAME_MAX) {
    /* Refused, not truncated: a name silently cut is a name the author did not
       write, and they will not notice until somebody reads it back to them. */
    throw fail("VALIDATION",
      `name must be ${LIMITS.NAME_MAX} characters or fewer. This one is ${v.length}.`,
      { field: "name", max: LIMITS.NAME_MAX, received: v.length });
  }
  return v;
}

function assertEnum(value, codesList, field, what) {
  if (typeof value !== "string") {
    throw fail("VALIDATION", `${field} must be text, not ${typeName(value)}.`, { field });
  }
  const v = value.trim();
  if (!codesList.includes(v)) {
    throw fail("VALIDATION", `That is not ${what} GRAV recognises.`, { field, accepted: codesList });
  }
  return v;
}

function assertText(value, field, max) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw fail("VALIDATION", `${field} must be text, not ${typeName(value)}.`, { field });
  }
  const v = value.trim();
  if (v.length > max) {
    throw fail("VALIDATION",
      `${field} must be ${max} characters or fewer. This one is ${v.length}.`,
      { field, max, received: v.length });
  }
  return v;
}

/**
 * The selected channels.
 *
 * ── AN EMPTY SELECTION IS REFUSED, NOT STORED ──────────────────────────────
 * A campaign with no channel is not a campaign, and a plan that reached approval
 * with none would be approved for nothing. Duplicates are collapsed rather than
 * refused — somebody selecting `email` twice in a UI has made a harmless mistake
 * and the stored value is what they meant.
 */
function assertChannels(value) {
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", `channels must be a list, not ${typeName(value)}.`, { field: "channels" });
  }
  const seen = [];
  for (const raw of value) {
    if (typeof raw !== "string") {
      throw fail("VALIDATION", `Each channel must be text, not ${typeName(raw)}.`, { field: "channels" });
    }
    const code = raw.trim();
    if (!MARKETING_CHANNEL_CODES.includes(code)) {
      throw fail("VALIDATION", "That is not a channel GRAV can plan a campaign on.",
        { field: "channels", accepted: MARKETING_CHANNEL_CODES });
    }
    if (!seen.includes(code)) seen.push(code);
  }
  if (!seen.length) {
    throw fail("VALIDATION", "A campaign plan needs at least one channel.", {
      field: "channels", accepted: MARKETING_CHANNEL_CODES,
    });
  }
  if (seen.length > LIMITS.CHANNELS_MAX) {
    throw fail("VALIDATION", `A campaign plan may name at most ${LIMITS.CHANNELS_MAX} channels.`,
      { field: "channels", max: LIMITS.CHANNELS_MAX });
  }
  return seen;
}

/**
 * Content references, in the GRAV `contentId` contract.
 *
 * ── WHAT A REFERENCE MAY BE ────────────────────────────────────────────────
 * A kind from the content library's own vocabulary, and an identifier GRAV
 * published. Nothing else: no URL, no HTML, no subject line, no provider path.
 * The identifier is checked against a conservative pattern rather than resolved
 * against the library, deliberately — a plan must be writable while the content
 * library is unreachable, and a reference to content that was later deleted is a
 * fact worth keeping rather than a write GRAV should have refused.
 *
 * `capturedName` is a snapshot for an approver's benefit and is labelled as one.
 */
function assertContentRefs(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", `contentRefs must be a list, not ${typeName(value)}.`, { field: "contentRefs" });
  }
  if (value.length > LIMITS.CONTENT_REFS_MAX) {
    throw fail("VALIDATION", `A campaign plan may reference at most ${LIMITS.CONTENT_REFS_MAX} items.`,
      { field: "contentRefs", max: LIMITS.CONTENT_REFS_MAX });
  }

  const out = [];
  const seen = new Set();

  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw fail("VALIDATION",
        "Each content reference must be an object with a kind and a contentId.",
        { field: "contentRefs" });
    }

    const extra = Object.keys(raw).filter((k) => !["kind", "contentId", "capturedName"].includes(k));
    if (extra.length) {
      throw fail("VALIDATION",
        `A content reference accepts kind, contentId and capturedName. ${extra.join(", ")} ${extra.length === 1 ? "is" : "are"} not part of the contract.`,
        { field: "contentRefs", unknown: extra });
    }

    const kind = assertEnum(raw.kind, CONTENT_KIND_CODES, "contentRefs.kind", "a content kind");

    if (typeof raw.contentId !== "string") {
      throw fail("VALIDATION", `contentRefs.contentId must be text, not ${typeName(raw.contentId)}.`,
        { field: "contentRefs.contentId" });
    }
    const contentId = raw.contentId.trim();
    if (!contentId) {
      throw fail("VALIDATION", "A content reference needs a contentId.", { field: "contentRefs.contentId" });
    }
    /* ── THE IDENTIFIER IS AN IDENTIFIER, NOT A LOCATION ──────────────────
       A conservative character set, and it rules out the two things somebody is
       most likely to paste in instead: a URL and a provider API path. Both would
       be a provider detail stored in a GRAV document, and the second would name
       the engine. */
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(contentId)) {
      throw fail("VALIDATION",
        "A contentId is the identifier the content library published. It is not a URL or a path.",
        { field: "contentRefs.contentId" });
    }

    /* One reference per kind-and-id pair. The same asset listed twice is a
       duplicate somebody made in a picker; storing it twice would make an
       approver think two assets were planned. */
    const key = `${kind}:${contentId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      kind,
      contentId,
      capturedName: assertText(raw.capturedName, "contentRefs.capturedName", 300),
      capturedAt: new Date(),
    });
  }

  return out;
}

/**
 * The budget, as an amount with a currency and a basis, or nothing.
 *
 * ── ALL THREE OR NONE ──────────────────────────────────────────────────────
 * An amount without a currency is a number somebody will read in their own
 * currency. An amount without a basis is worse: ₹50,000 total and ₹50,000 a day
 * differ by a factor of thirty, and a plan that does not say which is a plan an
 * approver will read the cheaper way.
 */
function assertBudget(payload) {
  const given = ["budgetAmount", "budgetCurrency", "budgetBasis"].filter((f) => has(payload, f));
  if (!given.length) return undefined;

  /* Explicitly clearing it. All three must be null together — clearing the
     amount and leaving a currency would store half a budget. */
  const allNull = given.length === 3 && given.every((f) => payload[f] === null);
  if (allNull) return null;

  if (given.length !== 3) {
    throw fail("VALIDATION",
      "A budget needs all three of budgetAmount, budgetCurrency and budgetBasis. An amount without its currency is a number nobody can read, and one without a basis could be a daily rate or a total.",
      { fields: ["budgetAmount", "budgetCurrency", "budgetBasis"], missing: ["budgetAmount", "budgetCurrency", "budgetBasis"].filter((f) => !given.includes(f)) });
  }

  const raw = payload.budgetAmount;
  /* ── NO COERCION ──────────────────────────────────────────────────────────
     `Number("50000")` is 50000 and `Number(null)` is 0. A string is refused
     because a budget arriving as text is a client bug worth surfacing, and null
     is refused because a zero budget must be something somebody typed. */
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw fail("VALIDATION",
      `budgetAmount must be a number, not ${typeName(raw)}.`,
      { field: "budgetAmount", received: typeName(raw) });
  }
  if (raw < 0) {
    throw fail("VALIDATION",
      "A budget cannot be negative.",
      { field: "budgetAmount", received: raw });
  }

  if (typeof payload.budgetCurrency !== "string") {
    throw fail("VALIDATION", `budgetCurrency must be text, not ${typeName(payload.budgetCurrency)}.`,
      { field: "budgetCurrency" });
  }
  const currency = payload.budgetCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw fail("VALIDATION", "budgetCurrency must be a three-letter ISO currency code, like INR or USD.",
      { field: "budgetCurrency" });
  }

  const basis = assertEnum(payload.budgetBasis, ["total", "daily"], "budgetBasis", "a budget basis");

  return { amount: raw, currency, basis };
}

/**
 * The schedule.
 *
 * Both dates go through the shared strict calendar validator, so `2026-02-31`
 * cannot become a start date. Either may be absent — a plan being written may not
 * know its dates yet — but a plan with both must have them in order.
 */
function assertSchedule(payload, existing = { startDate: "", endDate: "" }) {
  const next = {
    startDate: has(payload, "startDate")
      ? (payload.startDate === null ? "" : dates.assertCalendarDate(payload.startDate, "startDate"))
      : str(existing.startDate),
    endDate: has(payload, "endDate")
      ? (payload.endDate === null ? "" : dates.assertCalendarDate(payload.endDate, "endDate"))
      : str(existing.endDate),
  };

  if (next.startDate && next.endDate) {
    if (next.startDate > next.endDate) {
      throw fail("VALIDATION", "The campaign's start date is after its end date.", { field: "startDate" });
    }
    /* A plan running to 2126 is a typo in the year, and it is worth refusing
       loudly rather than storing a plan nobody will notice is wrong until a
       budget is attached to it. */
    const range = dates.assertDateRange({
      startDate: next.startDate, endDate: next.endDate, maxDays: LIMITS.PLAN_HORIZON_DAYS,
    });
    return { ...next, days: range.days };
  }

  return { ...next, days: null };
}

/** The UTM campaign identity, lower-cased and conservative. */
function assertUtm(value) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw fail("VALIDATION", `utmCampaign must be text, not ${typeName(value)}.`, { field: "utmCampaign" });
  }
  const v = value.trim().toLowerCase();
  if (!v) return "";
  if (!UTM_PATTERN.test(v)) {
    throw fail("VALIDATION",
      "utmCampaign appears in destination URLs, so it may contain only lower-case letters, numbers, hyphens and underscores, and must start with a letter or number.",
      { field: "utmCampaign", max: LIMITS.UTM_MAX });
  }
  return v;
}

/* ═══ THE RECORD ════════════════════════════════════════════════════════════ */

/* ── THE REFERENCE COMES FROM AN ATOMIC COUNTER ──────────────────────────────
   It used to be derived by reading the largest existing reference and adding one.
   Two concurrent creates read the same largest value, computed the same next one,
   and each reserved a valid history row under its own draft id — so nothing
   collided until projection, where the plan collection's unique index rejected one
   and left canonical history that could never be applied.

   `campaignAllocation.allocateReference` increments a single counter document,
   which MongoDB guarantees atomically without a transaction. See that file for why
   gaps in the sequence are accepted and duplicates are not. */

/* ═══ THE DURABILITY PROTOCOL ════════════════════════════════════════════════

   ── WHY THE HISTORY ROW IS WRITTEN FIRST ───────────────────────────────────
   Two collections change on one command and this deployment cannot assume a
   replica set, so the pair cannot be made atomic. That leaves a choice about
   which half survives an interruption, and the two orders fail very differently:

     plan first     →  the plan changes and the trail never records who changed
                       it or what it was. The record is wrong about its own past,
                       the gap is INVISIBLE, and nothing can reconstruct it. Worse
                       for this feature than for most: a retry sees the target
                       state, reports `duplicate: true`, and the missing row is
                       never repaired because nothing knows it is missing.
     history first  →  the trail records a revision the plan has not caught up
                       with. Nothing is lost, the gap is DETECTABLE — history holds
                       a revision higher than the plan's — and the complete plan
                       for that revision is in the row, ready to apply.

   So: reserve the history row, then project it onto the plan, then answer. Every
   read and every write reconciles first, which means an interruption is repaired
   the next time anybody looks rather than waiting for a scheduler this deployment
   does not have.

   The history row is keyed uniquely on (company, draft, revision), so a retry
   cannot append twice and two racing callers cannot both claim one revision. That
   index is the serialisation point for the whole feature.

   This is the same protocol `trackingConfig.service.js` uses, for the same
   reason. */

/**
 * The COMPLETE plan at one revision, as a plain object.
 *
 * This is what makes reconciliation a repair rather than a guess: applying it is
 * deterministic and needs no earlier row. A diff could not do that — replaying
 * diffs needs every prior row present and correctly ordered, and the one
 * situation this exists for is the one where a write was interrupted.
 */
function canonical(plan) {
  return {
    draftRef: plan.draftRef,
    name: plan.name,
    objective: plan.objective,
    description: plan.description || "",
    channels: [...(plan.channels || [])],
    audience: {
      reference: plan.audience?.reference || "",
      qualificationNotes: plan.audience?.qualificationNotes || "",
    },
    contentRefs: (plan.contentRefs || []).map((r) => ({
      kind: r.kind,
      contentId: r.contentId,
      capturedName: r.capturedName || "",
      capturedAt: r.capturedAt || null,
    })),
    schedule: {
      startDate: plan.schedule?.startDate || "",
      endDate: plan.schedule?.endDate || "",
    },
    budget: plan.budget
      ? { amount: plan.budget.amount, currency: plan.budget.currency, basis: plan.budget.basis }
      : null,
    conversionGoal: plan.conversionGoal || null,
    utmCampaign: plan.utmCampaign || "",
    /* Part of the plan, so part of the snapshot a repair replays. A brief left out
       here would be silently lost by any reconciliation. */
    deploymentBriefs: (plan.deploymentBriefs || []).map(briefPlain),
    owner: actorPlain(plan.owner),
    state: plan.state,
    submittedAt: plan.submittedAt || null,
    submittedBy: actorPlain(plan.submittedBy),
    decidedAt: plan.decidedAt || null,
    decidedBy: actorPlain(plan.decidedBy),
    decisionReason: plan.decisionReason || "",
    cancelledAt: plan.cancelledAt || null,
    /* Always false in this chunk. Carried in the snapshot anyway, so a repair
       cannot quietly reset a value a later chunk sets. */
    deployed: Boolean(plan.deployed),
  };
}

/* A brief as a plain object. Dates become strings in the snapshot and are revived
   on the way back, exactly like the actor sub-documents. */
const briefPlain = (b) => (b ? JSON.parse(JSON.stringify(b)) : b);

const briefRevive = (b) => (b
  ? { ...b, updatedAt: b.updatedAt ? new Date(b.updatedAt) : new Date() }
  : b);

/* An actor sub-document as a plain object, or null. The id survives as a string
   in the snapshot and is revived on the way back. */
const actorPlain = (a) => (a && a.id
  ? { id: String(a.id), name: a.name || "", email: a.email || "", role: a.role || "" }
  : null);

const actorRevive = (a) => (a && a.id && mongoose.Types.ObjectId.isValid(String(a.id))
  ? { id: new mongoose.Types.ObjectId(String(a.id)), name: a.name || "", email: a.email || "", role: a.role || "" }
  : null);

/* The snapshot, shaped for `$set` on the plan document. */
const projectionOf = (resulting) => ({
  draftRef: resulting.draftRef,
  name: resulting.name,
  objective: resulting.objective,
  description: resulting.description || "",
  channels: [...(resulting.channels || [])],
  audience: {
    reference: resulting.audience?.reference || "",
    qualificationNotes: resulting.audience?.qualificationNotes || "",
  },
  contentRefs: (resulting.contentRefs || []).map((r) => ({
    kind: r.kind, contentId: r.contentId,
    capturedName: r.capturedName || "",
    capturedAt: r.capturedAt ? new Date(r.capturedAt) : new Date(),
  })),
  schedule: {
    startDate: resulting.schedule?.startDate || "",
    endDate: resulting.schedule?.endDate || "",
  },
  budget: resulting.budget || null,
  conversionGoal: resulting.conversionGoal || null,
  utmCampaign: resulting.utmCampaign || "",
  deploymentBriefs: (resulting.deploymentBriefs || []).map(briefRevive),
  owner: actorRevive(resulting.owner),
  state: resulting.state,
  submittedAt: resulting.submittedAt ? new Date(resulting.submittedAt) : null,
  submittedBy: actorRevive(resulting.submittedBy),
  decidedAt: resulting.decidedAt ? new Date(resulting.decidedAt) : null,
  decidedBy: actorRevive(resulting.decidedBy),
  decisionReason: resulting.decisionReason || "",
  cancelledAt: resulting.cancelledAt ? new Date(resulting.cancelledAt) : null,
  deployed: Boolean(resulting.deployed),
});

/* ── A FAILURE-INJECTION SEAM ────────────────────────────────────────────────
   Three named stages, so a test can interrupt a command exactly where an outage
   would and prove the protocol repairs rather than duplicates. Reachable only
   through the service's own options — no route passes it, and a test asserts
   that. A no-op in production. */
const STAGES = Object.freeze({
  AFTER_REFERENCE: "after_reference",
  /* Before the shared-identity claim, which is the earliest point at which two
     commands contend with each other. A test that wants a real race between two
     plans has to meet here: by `before_history` one of them has already been
     refused, and a barrier waiting for both would deadlock. */
  BEFORE_IDENTITY: "before_identity",
  AFTER_IDENTITY: "after_identity",
  BEFORE_HISTORY: "before_history",
  AFTER_HISTORY: "after_history",
  AFTER_PROJECTION: "after_projection",
  BEFORE_REPAIR: "before_repair",
});

const fireStage = async (hooks, stage, context) => {
  const hook = hooks && hooks[stage];
  if (typeof hook === "function") await hook(context);
};

/**
 * Reserve the history row for one revision.
 *
 * Returns `{ reserved, existing }`. A duplicate key means somebody already
 * claimed this revision — a retry of this same command, or a racing caller — and
 * the caller decides which by comparing what the existing row says.
 */
async function reserveHistory({
  companyId, draftId, draftRef, kind, revision, fromState, toState,
  changedFields = [], before = null, after = null, reason = "", actor, resulting,
}) {
  try {
    const row = await MarketingCampaignDraftHistory.create({
      companyId, draftId, draftRef, kind, revision,
      fromState, toState, changedFields, before, after, reason, actor,
      resulting,
      at: new Date(),
    });
    return { reserved: true, existing: row.toObject() };
  } catch (err) {
    if (err?.code !== 11000) throw err;
    /* Company-scoped, like every selector here. */
    const existing = await MarketingCampaignDraftHistory
      .findOne({ companyId, draftId, revision }).lean();
    return { reserved: false, existing };
  }
}

/**
 * Project a reserved history row onto the plan.
 *
 * Fenced on the revision it believes it is advancing FROM, so two callers cannot
 * both apply it and the second is a no-op rather than a second write. Upserts,
 * because a creation's plan row does not exist yet and a repair of an interrupted
 * creation must be able to make it.
 *
 * @returns {Promise<{ok:boolean, plan:object|null, reason:string}>}
 */
async function projectHistory({ companyId, draftId, row, fromRevision }) {
  try {
    const updated = await MarketingCampaignDraft.findOneAndUpdate(
      /* The company is in the selector as well as the id. Two independent
         conditions, because the identifier's own company check is one line and a
         selector without the company would make that line the only thing between
         a caller and another tenant's plan. */
      fromRevision === 0
        ? { _id: draftId, companyId, revision: { $exists: false } }
        : { _id: draftId, companyId, revision: fromRevision },
      {
        $set: { ...projectionOf(row.resulting), revision: row.revision },
        $setOnInsert: { companyId, _id: draftId },
      },
      { new: true, upsert: fromRevision === 0, setDefaultsOnInsert: true },
    );
    if (updated) return { ok: true, plan: updated, reason: "" };
  } catch (err) {
    if (err?.code === 11000) {
      /* A concurrent repair or create won. Theirs exists and applied the same
         row, so this is success from here. */
      const existing = await MarketingCampaignDraft.findOne({ _id: draftId, companyId });
      if (existing && existing.revision >= row.revision) return { ok: true, plan: existing, reason: "" };

      /* ── A DUPLICATE KEY THAT IS NOT A RACE ────────────────────────────────
         The plan collection's unique indexes cover the reference and the campaign
         identity. A collision on either means this row claims something ANOTHER
         plan owns, and no number of retries will change that. Classified here so a
         caller answers "this will not resolve" rather than "pending".

         Which constraint failed is read from the data, not from the driver's
         message: matching on E11000 text couples GRAV to MongoDB's wording, and
         that wording is not a contract. */
      const [refOwner, identityOwner] = await Promise.all([
        MarketingCampaignDraft
          .findOne({ companyId, draftRef: row.resulting?.draftRef, _id: { $ne: draftId } })
          .select("_id").lean(),
        row.resulting?.utmCampaign
          ? MarketingCampaignDraft
            .findOne({ companyId, utmCampaign: row.resulting.utmCampaign, _id: { $ne: draftId } })
            .select("_id").lean()
          : null,
      ]);

      if (refOwner || identityOwner) {
        return {
          ok: false,
          plan: existing || null,
          reason: "unprojectable",
          stage: refOwner ? "reference_owned_elsewhere" : "identity_owned_elsewhere",
        };
      }

      return { ok: false, plan: existing || null, reason: "projection_conflict" };
    }
    throw err;
  }

  /* Nothing matched. Either somebody moved the plan on already — in which case it
     is at or past this revision and there is nothing to do — or it is behind for
     a reason this call cannot resolve. */
  const current = await MarketingCampaignDraft.findOne({ _id: draftId, companyId });
  if (current && current.revision >= row.revision) return { ok: true, plan: current, reason: "" };
  return { ok: false, plan: current || null, reason: current ? "projection_behind" : "plan_missing" };
}

/**
 * Confirm that the identity an accepted revision carries is committed to this plan.
 *
 * Called when a commit did not take — a claim that was released, or one created by
 * a different command. It restores the reservation rather than assuming it, because
 * an accepted revision without its reservation is a plan whose name another plan
 * can take with nothing noticing.
 *
 * @returns {Promise<{ok:boolean, conflict:boolean}>}
 */
async function confirmAcceptedIdentity({ companyId, draftId, utmCampaign, revision = 1 }) {
  const company = assertCompany(companyId);
  const identity = str(utmCampaign).toLowerCase();
  if (!identity) return { ok: true, conflict: false };

  const owner = await allocation.identityOwner({ companyId: company, utmCampaign: identity });
  if (owner && String(owner.draftId) === String(draftId) && owner.status === "committed") {
    return { ok: true, conflict: false };
  }

  const plan = await MarketingCampaignDraft
    .findOne({ _id: draftId, companyId: company }).lean();

  const out = await allocation.restoreCommittedIdentity({
    companyId: company, utmCampaign: identity, draftId,
    draftRef: plan?.draftRef || "",
    revision: Number(plan?.revision) || revision,
    resulting: plan ? canonical(plan) : {},
  });

  if (out.conflict) return { ok: false, conflict: true };

  const after = await allocation.identityOwner({ companyId: company, utmCampaign: identity });
  return {
    ok: Boolean(after && String(after.draftId) === String(draftId) && after.status === "committed"),
    conflict: false,
  };
}

/**
 * Every identity an accepted revision carries must have a committed reservation.
 *
 * ── THE INVARIANT THIS DEFENDS ─────────────────────────────────────────────
 * The reservation is the only thing stopping another plan taking a name. An
 * accepted revision whose identity has no reservation is a plan that is silently
 * unprotected, and nothing about the plan itself would reveal it.
 *
 * So every identity in this plan's accepted history is checked and restored. A
 * `conflicted` result means another plan already owns one, which is a genuine
 * ownership problem a human resolves — reported, never papered over by inventing a
 * second owner.
 *
 * @returns {Promise<{unreserved:number, conflicted:string[]}>}
 */
async function restoreAcceptedReservations({ companyId, draftId }) {
  const company = assertCompany(companyId);

  const plan = await MarketingCampaignDraft
    .findOne({ _id: draftId, companyId: company }).lean();
  if (!plan) return { unreserved: 0, conflicted: [] };

  /* Every identity this plan's accepted revisions ever carried, not only the
     current one: each may already exist in click data. */
  const rows = await MarketingCampaignDraftHistory
    .find({ companyId: company, draftId, revision: { $lte: plan.revision } })
    .select("revision resulting.utmCampaign")
    .lean();

  const wanted = new Map();
  for (const row of rows) {
    const identity = str(row.resulting?.utmCampaign).toLowerCase();
    if (identity) wanted.set(identity, row.revision);
  }
  if (!wanted.size) return { unreserved: 0, conflicted: [] };

  let unreserved = 0;
  const conflicted = [];

  for (const [identity, revision] of wanted) {
    const out = await allocation.restoreCommittedIdentity({
      companyId: company, utmCampaign: identity, draftId,
      draftRef: plan.draftRef, revision, resulting: canonical(plan),
    });
    if (out.conflict) conflicted.push(identity);
    else if (out.restored) unreserved += 1;
  }

  return { unreserved, conflicted };
}

/**
 * Resolve every provisional identity claim on one plan against accepted history.
 *
 * ── THE DETERMINISTIC RECOVERY PATH ────────────────────────────────────────
 * A crash between the identity claim and the history reservation leaves a
 * provisional claim and no revision to justify it. Nothing may resolve that by a
 * clock or a timeout — a request that is merely slow is indistinguishable from one
 * that died, and a timeout would eventually steal a claim from a live request.
 *
 * So the question asked is one the data can answer: did the revision this claim was
 * made for actually happen, and did it carry this identity?
 *
 *   the revision's history row carries this identity   → commit it
 *   the row exists and carries a DIFFERENT identity    → this claim lost; release
 *   no row, and the plan is already past that revision → it can never happen; release
 *   no row, and the plan has not reached it yet        → still in flight; leave it
 *
 * The last case is the only one that blocks, and it blocks exactly as long as the
 * outcome is genuinely unknown. A retry of the same edit regenerates the same token
 * and adopts its own claim, so the rightful owner is never locked out; another plan
 * wanting that identity waits until the owner's revision is decided one way or the
 * other.
 *
 * Every release is fenced on the claim's own token, so this can never take a claim
 * from a different request that is still running.
 */
async function reconcileIdentityClaims({ companyId, draftId }) {
  const company = assertCompany(companyId);

  const claims = await allocation.claimsFor({ companyId: company, draftId });
  const provisional = claims.filter((c) => c.status === "provisional");

  /* ── THE `current` SYNC RUNS EVEN WITH NOTHING OUTSTANDING ────────────────
     An early return here left the flag stale in a real sequence: the first pass
     committed a claim while the plan had not yet been projected, so it marked the
     OLD identity current, and the second pass — with no claims left — returned
     before correcting it. `current` is derived from the plan, so it is re-derived
     whenever this runs. The cost is one indexed update; the alternative is a flag
     that disagrees with the plan it describes. */
  const syncCurrent = async () => {
    const live = await MarketingCampaignDraft
      .findOne({ _id: draftId, companyId: company }).select("utmCampaign").lean();
    if (!live) return;
    await allocation.syncCurrentIdentity({
      companyId: company, draftId, utmCampaign: live.utmCampaign || "",
    });
  };

  if (!provisional.length) {
    await syncCurrent();
    const missing = await restoreAcceptedReservations({ companyId: company, draftId });
    return {
      committed: 0, released: 0, inFlight: 0,
      unreserved: missing.unreserved, conflicted: missing.conflicted,
    };
  }

  const [plan, rows] = await Promise.all([
    MarketingCampaignDraft.findOne({ _id: draftId, companyId: company }).select("revision").lean(),
    MarketingCampaignDraftHistory
      .find({
        companyId: company,
        draftId,
        revision: { $in: provisional.map((c) => c.claimedAtRevision) },
      })
      .select("revision resulting.utmCampaign")
      .lean(),
  ]);

  const rowAt = new Map(rows.map((r) => [r.revision, r]));
  const planRevision = Number(plan?.revision) || 0;

  let committed = 0;
  let released = 0;
  let inFlight = 0;

  for (const claim of provisional) {
    const row = rowAt.get(claim.claimedAtRevision);

    if (row) {
      if (str(row.resulting?.utmCampaign).toLowerCase() === str(claim.utmCampaign).toLowerCase()) {
        /* The revision happened and carries this identity. Permanent now. */
        const out = await allocation.commitIdentity({
          companyId: company, utmCampaign: claim.utmCampaign, claimToken: claim.claimToken,
        });
        if (out.committed) committed += 1;
      } else {
        /* That revision happened and chose something else, so this claim lost. */
        const out = await allocation.releaseClaim({
          companyId: company, utmCampaign: claim.utmCampaign, claimToken: claim.claimToken,
        });
        if (out.released) released += 1;
      }
      continue;
    }

    if (claim.claimedAtRevision <= planRevision) {
      /* No row for a revision the plan has already passed. It can never be
         recorded — the revision number is spent — so the claim is provably dead. */
      const out = await allocation.releaseClaim({
        companyId: company, utmCampaign: claim.utmCampaign, claimToken: claim.claimToken,
      });
      if (out.released) released += 1;
      continue;
    }

    /* Genuinely undecided. Left alone, and counted so a caller can say so. */
    inFlight += 1;
  }

  /* Re-derived from the plan, so an edit repaired by reconciliation leaves the same
     flags an edit that completed normally would. */
  await syncCurrent();

  const missing = await restoreAcceptedReservations({ companyId: company, draftId });

  return { committed, released, inFlight, unreserved: missing.unreserved, conflicted: missing.conflicted };
}

/**
 * Finish any interrupted command on one plan.
 *
 * Idempotent, and it only acts while the plan is behind its own history. Run
 * before every read and before every write, so an interruption is repaired the
 * next time anybody looks.
 *
 * ── COMPANY-SCOPED, INCLUDING THE HISTORY LOOKUP ───────────────────────────
 * Two companies can hold plans at the same revision numbers, so a reconciliation
 * keyed on draft and revision alone could apply one company's row to another's
 * plan if an id ever collided. The company is in both selectors.
 *
 * @returns {Promise<{repaired:boolean, toRevision:number|null, stage:string}>}
 */
async function reconcileDraft({ companyId, draftId, hooks = null }) {
  const company = assertCompany(companyId);

  const [plan, newest] = await Promise.all([
    MarketingCampaignDraft.findOne({ _id: draftId, companyId: company }).lean(),
    MarketingCampaignDraftHistory
      .findOne({ companyId: company, draftId })
      .sort({ revision: -1 })
      .lean(),
  ]);

  if (!newest) return { repaired: false, toRevision: null, stage: "nothing_recorded" };

  /* Provisional identity claims are resolved against accepted history on every
     reconcile, so a crashed edit's claim is committed or freed the next time
     anybody looks — the same "repair when somebody reads" discipline the revision
     projection uses, and for the same reason: there is no scheduler. The same pass
     restores a reservation an accepted revision needs and does not have. */
  const claimState = await reconcileIdentityClaims({ companyId: company, draftId });

  const planRevision = Number(plan?.revision) || 0;
  if (planRevision >= newest.revision) {
    return {
      repaired: false, toRevision: null, stage: "consistent",
      conflictedIdentities: claimState.conflicted || [],
    };
  }

  await fireStage(hooks, STAGES.BEFORE_REPAIR, { draftId, toRevision: newest.revision });

  /* ── REPLAY EVERY MISSING ROW, IN ORDER ───────────────────────────────────
     Usually exactly one row is missing. More than one means two interruptions,
     and applying only the newest would skip a revision — the plan would jump from
     3 to 5 and the audit would describe a revision 4 the plan never held. Each is
     applied fenced on its own predecessor, so a gap stops the replay instead of
     being papered over. */
  const pending = await MarketingCampaignDraftHistory
    .find({ companyId: company, draftId, revision: { $gt: planRevision } })
    .sort({ revision: 1 })
    .lean();

  let from = planRevision;
  for (const row of pending) {
    if (row.revision !== from + 1) {
      /* A hole in the sequence. Not repairable by replaying — and not something to
         guess at. */
      return { repaired: false, toRevision: null, stage: "history_gap" };
    }
    const applied = await projectHistory({ companyId: company, draftId, row, fromRevision: from });
    if (!applied.ok) {
      /* ── A STABLE ANSWER, NOT AN ENDLESS RETRY ────────────────────────────
         `unprojectable` is terminal: the row claims something another plan owns and
         every future reconcile will fail identically. It is returned as its own
         stage so a caller answers a 409 rather than a 503 that invites waiting,
         and so this loop stops here instead of advancing into rows that depend on
         a revision that will never exist. */
      return {
        repaired: false,
        toRevision: null,
        stage: applied.reason === "unprojectable" ? applied.stage : applied.reason,
        terminal: applied.reason === "unprojectable",
      };
    }
    from = row.revision;
  }

  /* A revision that just landed may have a claim waiting on it, and its identity
     must be reserved before the revision is published as clean. */
  const afterReplay = await reconcileIdentityClaims({ companyId: company, draftId });

  return {
    repaired: true, toRevision: from, stage: "repaired",
    conflictedIdentities: afterReplay.conflicted || [],
  };
}

/**
 * Reconcile every plan in a company whose history is ahead of it.
 *
 * Used by the list read. One aggregation for the newest recorded revision per
 * plan, then a repair only for those actually behind — so the common case, where
 * nothing was interrupted, costs one extra query and no writes.
 */
async function reconcileCompany({ companyId }) {
  const company = assertCompany(companyId);

  const newest = await MarketingCampaignDraftHistory.aggregate([
    { $match: { companyId: company } },
    { $group: { _id: "$draftId", revision: { $max: "$revision" } } },
  ]);
  if (!newest.length) return { repaired: 0, pending: [] };

  const plans = await MarketingCampaignDraft
    .find({ companyId: company, _id: { $in: newest.map((n) => n._id) } })
    .select("_id revision")
    .lean();
  const revisionOf = new Map(plans.map((p) => [String(p._id), Number(p.revision) || 0]));

  const behind = newest.filter((n) => (revisionOf.get(String(n._id)) || 0) < n.revision);

  let repaired = 0;
  const pending = [];
  for (const row of behind) {
    const out = await reconcileDraft({ companyId: company, draftId: row._id });
    if (out.repaired) repaired += 1;
    else {
      pending.push({
        draftId: String(row._id),
        stage: out.stage,
        toRevision: row.revision,
        /* Terminal means no later read can apply it, which is what decides whether
           a client may offer a link to it. */
        terminal: Boolean(out.terminal),
      });
    }
  }
  return { repaired, pending };
}

/**
 * Did this revision actually land?
 *
 * ── "THE UPDATE MATCHED NOTHING" IS NOT "THE WORK IS OUTSTANDING" ──────────
 * A conditional update matches nothing in two very different situations: the
 * revision is still owed, or somebody else already projected it — a concurrent
 * reconcile, or another caller's `load` finishing this one's interrupted write.
 * The first is a pending repair; the second is success.
 *
 * Telling them apart by asking `reconcileDraft` whether it repaired anything does
 * not work, because by then there is nothing left to repair and it truthfully
 * answers "consistent". So the question asked is the right one: is the plan at or
 * past this revision?
 */
async function revisionLanded({ companyId, draftId, revision }) {
  const current = await MarketingCampaignDraft.findOne({ _id: draftId, companyId });
  if (current && Number(current.revision) >= revision) return current;
  return null;
}

/**
 * A recorded command that can NEVER be applied.
 *
 * ── NOT "PENDING", AND THAT DISTINCTION IS THE POINT ───────────────────────
 * `repairPending` promises that a later read finishes the job and that nothing has
 * been lost. If a history row claims a reference or an identity another plan owns,
 * no later read can ever apply it, and saying "pending" would tell somebody to
 * keep waiting for something that will not happen.
 *
 * Reaching this should be impossible by construction now that every shared
 * identity is claimed before history. It remains as the honest answer for rows
 * that predate that ordering or were written outside it.
 */
const unprojectable = ({ stage, revision }) => fail(
  "CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE",
  "This change was recorded but cannot be applied: the reference or campaign identity it claims belongs to another plan. It will not resolve on its own and needs somebody to look at it.",
  { stage, revision },
);

/* The 503 for a command whose projection could not be confirmed. Carries the
   GRAV-owned stage and the revisions, and nothing else — no driver message, no
   collection name, no index name. */
const repairPending = ({ stage, revision, previousRevision }) => fail(
  "CAMPAIGN_DRAFT_REPAIR_PENDING",
  "Your change is recorded and GRAV has not finished applying it. Reload in a moment; nothing has been lost.",
  { stage, revision, previousRevision },
);

/* ── THE PUBLIC SHAPE ───────────────────────────────────────────────────────
   One function, used by every read, so a field cannot be published by one route
   and withheld by another. The internal `_id` never travels; the public
   identifier is minted from it. */
function present(draft, { companyId, env = process.env } = {}) {
  const spec = stateSpec(draft.state);
  const available = Object.entries(TRANSITIONS[draft.state] || {});

  return {
    campaignDraftId: identity.encodeDraftId(
      { companyId: str(companyId || draft.companyId), draftId: str(draft._id) }, env,
    ),
    /* The human reference, for somebody quoting it in a conversation. Safe to
       publish: it is company-scoped and the public identifier is what a route
       accepts, so knowing a reference grants nothing. */
    reference: draft.draftRef,

    name: draft.name,
    objective: draft.objective,
    description: draft.description || "",
    channels: [...(draft.channels || [])],

    audience: {
      reference: draft.audience?.reference || "",
      qualificationNotes: draft.audience?.qualificationNotes || "",
    },

    contentRefs: (draft.contentRefs || []).map((r) => ({
      kind: r.kind,
      contentId: r.contentId,
      /* Labelled as a snapshot, so nobody reads it as the library's current
         name. */
      capturedName: r.capturedName || "",
      capturedAt: r.capturedAt || null,
    })),

    schedule: {
      startDate: draft.schedule?.startDate || null,
      endDate: draft.schedule?.endDate || null,
    },

    /* Never a bare number. */
    budget: draft.budget
      ? { amount: draft.budget.amount, currency: draft.budget.currency, basis: draft.budget.basis }
      : null,

    conversionGoal: draft.conversionGoal || null,
    utmCampaign: draft.utmCampaign || null,

    /* ── THE BRIEFS, AS STORED ───────────────────────────────────────────────
       No provider identifier appears in one, because the write boundary refuses
       them by name at the top level and one level into every nested object. */
    deploymentBriefs: (draft.deploymentBriefs || []).map((b) => briefPlain(b)),

    owner: draft.owner ? { name: draft.owner.name || "", email: draft.owner.email || "" } : null,

    state: draft.state,
    stateLabel: spec?.label || draft.state,
    /* The sentence that has to survive every screen this is rendered on. */
    stateMeans: spec?.means || "",
    editable: Boolean(spec?.editable),
    terminal: Boolean(spec?.terminal),

    /* What may happen next, and who may do it. Served so a client renders the
       buttons the server will actually honour rather than its own guess. */
    availableActions: available.map(([to, rule]) => ({ action: rule.action, to, actor: rule.actor })),

    revision: draft.revision,

    submittedAt: draft.submittedAt || null,
    submittedBy: draft.submittedBy ? { name: draft.submittedBy.name || "" } : null,
    decidedAt: draft.decidedAt || null,
    decidedBy: draft.decidedBy ? { name: draft.decidedBy.name || "" } : null,
    decisionReason: draft.decisionReason || "",
    cancelledAt: draft.cancelledAt || null,

    /* ── SAID IN THE PAYLOAD, NOT ONLY IN A COMMENT ───────────────────────
       An approved plan is a GRAV document. A client rendering one must not imply
       anything exists in an advertising account, and this is the field that tells
       it so. Always false in this chunk. */
    deployed: Boolean(draft.deployed),
    deploymentMeans: "Approval is a GRAV decision. Nothing exists in any advertising channel until a later deployment step creates it, paused.",

    createdAt: draft.createdAt || null,
    updatedAt: draft.updatedAt || null,
  };
}

/* ═══ COMMANDS ══════════════════════════════════════════════════════════════ */

/**
 * Create a plan, in `draft`.
 *
 * @returns {Promise<object>} the public shape
 */
async function create({ companyId, user, payload = {}, env = process.env, hooks = null } = {}) {
  const company = assertCompany(companyId);

  if (!isAuthor(user)) {
    throw fail("FORBIDDEN", "Writing a campaign plan is a Marketing or administrator action.");
  }

  assertAcceptableFields(payload, CREATE_FIELDS, { label: "Creating a campaign plan" });

  /* Required at creation: a plan with no name, objective or channel is not a
     plan, and allowing one would mean every read has to cope with a half-record. */
  for (const field of ["name", "objective", "channels"]) {
    if (!has(payload, field)) {
      throw fail("VALIDATION", `A campaign plan needs ${field}.`, { field });
    }
  }

  const schedule = assertSchedule(payload);
  const budget = assertBudget(payload);

  const doc = {
    companyId,
    name: assertName(payload.name),
    objective: assertEnum(payload.objective, CAMPAIGN_OBJECTIVE_CODES, "objective", "a campaign objective"),
    description: assertText(payload.description, "description", LIMITS.DESCRIPTION_MAX),
    channels: assertChannels(payload.channels),
    audience: {
      reference: assertText(payload.audienceReference, "audienceReference", LIMITS.AUDIENCE_REF_MAX),
      qualificationNotes: assertText(payload.qualificationNotes, "qualificationNotes", LIMITS.QUALIFICATION_NOTES_MAX),
    },
    contentRefs: assertContentRefs(payload.contentRefs),
    schedule: { startDate: schedule.startDate, endDate: schedule.endDate },
    budget: budget === undefined ? null : budget,
    conversionGoal: has(payload, "conversionGoal") && payload.conversionGoal !== null
      ? assertEnum(payload.conversionGoal, CONVERSION_GOAL_CODES, "conversionGoal", "a conversion goal")
      : null,
    utmCampaign: assertUtm(payload.utmCampaign),
    deploymentBriefs: [],
    owner: actorFrom(user),
    state: "draft",
    revision: 1,
    deployed: false,
  };

  /* ── FIVE STEPS, IN THIS ORDER, EACH INDEPENDENTLY IDEMPOTENT ────────────
     The order is the correction. Every identity this plan shares with other plans
     is claimed atomically BEFORE any history is written, so a conflict is a 409 at
     a point where nothing is recorded — rather than an unapplicable history row
     discovered at projection time.

       1. the creation intent, which is the only thing a retry can recognise
       2. the reference, from an atomic counter
       3. the campaign identity, permanently
       4. the history row, carrying the complete plan
       5. the projection onto the plan

     An interruption between any two of them is resumable: step 1 finds the intent,
     and steps 2 to 5 each recognise their own prior work. */

  const intentKey = allocation.assertIdempotencyKey(payload.idempotencyKey);
  /* The fingerprint covers the VALIDATED plan, not the raw body, so two requests
     differing only in key order or whitespace are the same creation. */
  const payloadFingerprint = allocation.fingerprint(canonical({ ...doc, draftRef: "" }));

  const { intent } = await allocation.claimCreateIntent({
    companyId: company, idempotencyKey: intentKey, payloadFingerprint,
  });
  const draftId = intent.draftId;

  /* ── ALREADY FINISHED ────────────────────────────────────────────────────
     A retry whose previous attempt completed. The plan is returned as it stands;
     nothing is allocated, recorded or projected again. */
  const already = await MarketingCampaignDraft.findOne({ _id: draftId, companyId: company });
  if (already) {
    return { ...present(already, { companyId: company, env }), duplicate: true };
  }

  /* Step 2. ONE operation that reads or establishes the reference, fenced so two
     concurrent callers under one key cannot walk away with different local
     numbers while the intent records a third. Whatever it returns is the
     reference the intent, the history row and the plan will all carry. */
  const { draftRef } = await allocation.ensureIntentReference({
    companyId: company, idempotencyKey: intentKey,
  });

  await fireStage(hooks, STAGES.AFTER_REFERENCE, {
    stage: STAGES.AFTER_REFERENCE, revision: 1, draftRef, draftId: String(draftId),
  });

  /* Step 3. A conflict here is permanent — identities are never released — and it
     is raised before a single history row exists. */
  /* After the channels are known, because a brief is only valid for a channel the
     plan uses. */
  if (has(payload, "deploymentBriefs")) {
    doc.deploymentBriefs = assertDeploymentBriefs(payload.deploymentBriefs, { channels: doc.channels });
  }

  /* Computed before the identity claim, because the claim's token now covers the
     complete resulting plan. */
  const resulting = canonical({ ...doc, draftRef });

  let identityClaim = null;
  if (doc.utmCampaign) {
    await fireStage(hooks, STAGES.BEFORE_IDENTITY, {
      stage: STAGES.BEFORE_IDENTITY, revision: 1, utmCampaign: doc.utmCampaign,
    });
    /* Provisional. Committed after the projection, so a creation that never lands
       does not hold the identity for ever. The token is derived from the plan and
       the revision, so a retry of this same creation recognises its own claim. */
    identityClaim = await allocation.claimIdentity({
      companyId: company, utmCampaign: doc.utmCampaign,
      draftId, draftRef, revision: 1, resulting,
    });
    await allocation.advanceIntent({
      companyId: company, idempotencyKey: intentKey,
      stage: "identity_reserved", set: { utmCampaign: doc.utmCampaign },
    });
  }

  await fireStage(hooks, STAGES.AFTER_IDENTITY, {
    stage: STAGES.AFTER_IDENTITY, revision: 1, draftRef, draftId: String(draftId),
  });

  await fireStage(hooks, STAGES.BEFORE_HISTORY, { stage: STAGES.BEFORE_HISTORY, revision: 1 });

  /* Step 4. Keyed on (company, draft, revision), so a retry finds its own row
     rather than appending a second. */
  const out = await reserveHistory({
    companyId: company, draftId, draftRef,
    kind: "created", revision: 1, fromState: null, toState: "draft",
    changedFields: Object.keys(payload).filter((k) => k !== "idempotencyKey"),
    before: null, after: auditView({ ...doc, draftRef }),
    actor: doc.owner, resulting,
  });

  /* Whoever reserved the row is the original creation; the other caller is
     continuing it and says so. Both end up returning the same plan. */
  const weRecordedIt = out.reserved;
  const row = out.existing;
  if (!row) {
    /* Neither reserved nor findable. A GRAV fault, and not answerable as pending:
       nothing was recorded, so there is nothing to repair. */
    console.error("[campaign-draft] creation history could not be reserved or read for company", String(company));
    throw fail("CONFLICT", "GRAV could not record this campaign plan. Please try again.");
  }

  await allocation.advanceIntent({
    companyId: company, idempotencyKey: intentKey, stage: "history_reserved",
  });

  await fireStage(hooks, STAGES.AFTER_HISTORY, { stage: STAGES.AFTER_HISTORY, revision: 1, draftId: String(draftId) });

  /* Step 5. */
  const applied = await projectHistory({
    companyId: company, draftId, row, fromRevision: 0,
  });

  if (!applied.ok) {
    if (applied.reason === "unprojectable") throw unprojectable({ stage: applied.stage, revision: 1 });
    /* Recorded, not yet applied, and honest about exactly that. A later read
       reconciles it. */
    throw repairPending({ stage: applied.reason, revision: 1, previousRevision: 0 });
  }

  /* ── THE COMMIT IS CONFIRMED, NOT ASSUMED ────────────────────────────────
     An accepted revision must never exist without its committed reservation: the
     reservation is the only thing stopping another plan taking the name. So a
     `committed: false` is not ignored — reconciliation is given a chance to
     confirm or restore it, and if it still cannot, the answer is a pending repair
     rather than a success. */
  if (identityClaim?.claimToken) {
    const out = await allocation.commitIdentity({
      companyId: company, utmCampaign: doc.utmCampaign, claimToken: identityClaim.claimToken,
    });
    if (!out.committed) {
      const confirmed = await confirmAcceptedIdentity({
        companyId: company, draftId, utmCampaign: doc.utmCampaign,
      });
      if (!confirmed.ok) {
        if (confirmed.conflict) throw unprojectable({ stage: "identity_owned_elsewhere", revision: 1 });
        throw repairPending({ stage: "identity_commit_unconfirmed", revision: 1, previousRevision: 0 });
      }
    }
  }

  await allocation.advanceIntent({
    companyId: company, idempotencyKey: intentKey, stage: "projected",
  });

  await fireStage(hooks, STAGES.AFTER_PROJECTION, { stage: STAGES.AFTER_PROJECTION, revision: 1, draftId: String(draftId) });

  return {
    ...present(applied.plan, { companyId: company, env }),
    duplicate: !weRecordedIt,
  };
}

/* The refusal for a campaign identity another plan already holds. Named rather
   than derived from a driver message: matching on the text of an E11000 couples
   GRAV's error handling to MongoDB's wording, and that wording is not a contract. */
const utmTaken = (utmCampaign) => fail("CAMPAIGN_DRAFT_UTM_TAKEN",
  `Another campaign plan in your company already uses the campaign identity "${utmCampaign}". Two campaigns sharing one become a single indistinguishable row in every analytics report, and an identity is never released — not even by cancelling the plan that holds it.`,
  { field: "utmCampaign" });

/* What a history row records of the document. Deliberately not the whole thing:
   the fields a reader cares about, without the timestamps mongoose maintains. */
const auditView = (d) => ({
  name: d.name,
  objective: d.objective,
  description: d.description || "",
  channels: [...(d.channels || [])],
  audienceReference: d.audience?.reference || "",
  qualificationNotes: d.audience?.qualificationNotes || "",
  contentRefs: (d.contentRefs || []).map((r) => ({ kind: r.kind, contentId: r.contentId })),
  startDate: d.schedule?.startDate || "",
  endDate: d.schedule?.endDate || "",
  budget: d.budget ? { amount: d.budget.amount, currency: d.budget.currency, basis: d.budget.basis } : null,
  conversionGoal: d.conversionGoal || null,
  utmCampaign: d.utmCampaign || "",
  deploymentBriefs: (d.deploymentBriefs || []).map(briefPlain),
});

/**
 * Load one plan within the company, or refuse.
 *
 * Reconciles first. A read that published a plan while its own history held a
 * higher revision would show somebody a version that is already superseded, and a
 * WRITE that started from it would build on a value the plan was about to leave.
 */
async function load(companyId, campaignDraftId, env, hooks = null) {
  const company = assertCompany(companyId);
  const { draftId } = identity.decodeDraftId(campaignDraftId, { companyId: str(company) }, env);

  const repair = await reconcileDraft({ companyId: company, draftId, hooks });

  /* The company is in the selector as well as in the verified token. Two
     independent checks, because the token's company check is one line and a
     selector without the company would make that line the only thing between a
     caller and another tenant's plans. */
  const draft = await MarketingCampaignDraft.findOne({ _id: draftId, companyId: company });

  /* ── AN UNREPAIRABLE INCONSISTENCY STOPS HERE ────────────────────────────
     Reconciliation either found nothing to do, finished the job, or could not.
     The third case must not fall through: a read would publish a plan that
     disagrees with its own trail as though it were clean, and a WRITE would build
     its next revision on a value the plan was never confirmed to hold.

     The first version only refused when the plan was missing entirely, so a
     history gap let an edit proceed and append a third revision beside the
     unapplied one. */
  /* A reservation owned by another plan is an ownership conflict that no repair can
     resolve, so the plan is not published as clean. Distinguished from a pending
     repair, because no later read will fix it. */
  if (repair.conflictedIdentities?.length) {
    throw unprojectable({
      stage: "identity_owned_elsewhere",
      revision: Number(draft?.revision) || 0,
    });
  }

  const unresolved = !repair.repaired
    && !["nothing_recorded", "consistent"].includes(repair.stage);

  if (unresolved) {
    /* Terminal means no later read can apply it. Answering "pending, nothing has
       been lost" would be a promise GRAV cannot keep. */
    if (repair.terminal) {
      throw unprojectable({ stage: repair.stage, revision: (Number(draft?.revision) || 0) + 1 });
    }
    throw repairPending({
      stage: repair.stage,
      revision: (Number(draft?.revision) || 0) + 1,
      previousRevision: Number(draft?.revision) || 0,
    });
  }

  if (!draft) {
    throw fail("CAMPAIGN_DRAFT_NOT_FOUND", "That campaign plan is not one GRAV can show you.");
  }
  return { company, draft, repair };
}

/**
 * The revision a caller must state, checked.
 *
 * Required, not optional-with-a-default. A client that omits it is a client that
 * will overwrite somebody's edit, and defaulting to "whatever is current" makes
 * the protection decorative.
 */
function assertRevision(payload, draft) {
  if (!has(payload, "expectedRevision")) {
    throw fail("VALIDATION",
      "Say which version you are editing, so GRAV can refuse a change built on a version somebody has already replaced.",
      { field: "expectedRevision", currentRevision: draft.revision });
  }
  const raw = payload.expectedRevision;
  /* `Number(null)` is 0 and `Number("3")` is 3. Both would let a caller who does
     not know the revision pass the check by accident. */
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw fail("VALIDATION",
      `expectedRevision must be a whole number telling GRAV which version you are replacing, not ${typeName(raw)}.`,
      { field: "expectedRevision", currentRevision: draft.revision, received: typeName(raw) });
  }
  if (raw !== draft.revision) {
    throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
      "Somebody changed this campaign plan since you opened it. Reload it and re-apply your changes.",
      { field: "expectedRevision", currentRevision: draft.revision, sentRevision: raw });
  }
  return raw;
}

/**
 * Edit a plan.
 *
 * ── A SUBMITTED PLAN IS NOT EDITABLE ───────────────────────────────────────
 * The refusal names the state and says what would make it editable, because
 * "conflict" on its own leaves an author guessing whether to wait or to ask
 * somebody.
 */
async function update({
  companyId, user, campaignDraftId, payload = {}, env = process.env, hooks = null,
} = {}) {
  if (!isAuthor(user)) {
    throw fail("FORBIDDEN", "Editing a campaign plan is a Marketing or administrator action.");
  }
  /* Before anything is read or written: a change GRAV cannot attribute is a change
     GRAV does not make. */
  const actor = actorFrom(user);

  const { company, draft } = await load(companyId, campaignDraftId, env, hooks);

  assertAcceptableFields(payload, UPDATE_FIELDS, { label: "Editing a campaign plan" });

  if (!EDITABLE_STATES.includes(draft.state)) {
    const spec = stateSpec(draft.state);
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      draft.state === "awaiting_approval"
        ? "This plan is awaiting a decision and is frozen so an approver reads what they decide on. It has to be returned before it can be edited."
        : `This plan is ${spec?.label?.toLowerCase() || draft.state} and cannot be edited.`,
      { state: draft.state, editableStates: EDITABLE_STATES });
  }

  /* ── A STALE REVISION MIGHT BE THIS COMMAND'S OWN SUCCESS ────────────────
     The retry of an interrupted edit arrives quoting the revision it started from,
     and by then its own recorded row may have been projected — by this very call's
     reconcile. Treating that as a conflict tells a caller to reload and re-apply a
     change that has already landed.

     So before refusing, the history row at the revision after theirs is compared
     with what their payload would have produced from the state they were editing.
     Identical means this IS their edit, already accepted; anything else is a genuine
     conflict. */
  if (Number.isInteger(payload.expectedRevision) && draft.revision !== payload.expectedRevision) {
    const already = await alreadyAccepted({
      companyId: company, draft, payload, expectedRevision: payload.expectedRevision, env,
    });
    if (already) return already;
  }

  assertRevision(payload, draft);

  const before = auditView(draft);
  const fromRevision = draft.revision;
  const fromState = draft.state;

  /* ── THE EDIT IS COMPUTED, NOT SAVED ─────────────────────────────────────
     `applyPayload` validates and applies onto the target in place, and nothing
     calls `save()`. The write is the conditional update below, built from the
     canonical snapshot. Leaving a `save()` anywhere on this path would reintroduce
     exactly the lost update the condition exists to prevent. */
  applyPayload(draft, payload);

  const after = auditView(draft);

  /* ── A SAVE THAT CHANGES NOTHING IS NOT A REVISION ───────────────────────
     Bumping the revision for an identical payload makes every other open editor
     conflict for no reason, and fills the history with rows that record nothing.
     The response still succeeds — the caller asked for a state and that is the
     state — and says no revision was created. */
  const changedFields = Object.keys(after).filter(
    (k) => JSON.stringify(after[k]) !== JSON.stringify(before[k]),
  );
  if (!changedFields.length) {
    const unchanged = await MarketingCampaignDraft.findOne({ _id: draft._id, companyId: company });
    return { ...present(unchanged, { companyId: company, env }), changed: false, changedFields: [] };
  }

  const revision = fromRevision + 1;
  /* Computed before the claim, because the claim's token covers the whole command.
     Two edits differing in any field a caller chose derive different tokens. */
  const resulting = canonical(draft);

  /* ── THE NEW IDENTITY IS RESERVED BEFORE THIS REVISION'S HISTORY ──────────
     A read-then-check against the plan collection was not enough: two plans
     changing to the same identity at the same moment both passed the check, both
     reserved valid history rows under different drafts, and the plan collection's
     unique index then rejected one projection — leaving an unapplicable row.

     The reservation is an atomic insert into its own collection, so one of the two
     is refused here, before it has recorded anything. */
  let identityClaim = null;
  const identityChanged = Boolean(draft.utmCampaign) && draft.utmCampaign !== before.utmCampaign;

  if (identityChanged) {
    await fireStage(hooks, STAGES.BEFORE_IDENTITY, {
      stage: STAGES.BEFORE_IDENTITY, revision, utmCampaign: draft.utmCampaign,
    });
    /* Provisional, and it blocks: another plan must not take an identity this
       request is mid-way through claiming. It becomes permanent only if THIS
       revision is accepted — an edit that loses the revision race never adopted
       the identity and must not hold it for ever. */
    identityClaim = await allocation.claimIdentity({
      companyId: company, utmCampaign: draft.utmCampaign,
      draftId: draft._id, draftRef: draft.draftRef, revision, resulting,
    });
  }

  /* Whatever happens from here, a provisional claim this request made is either
     committed or released before the answer leaves. The release is fenced on this
     command's own token, so it cannot touch a claim another request is holding. */
  /* Returns whether the reservation is confirmed committed to this plan. A
     `committed: false` is never ignored: an accepted revision without its
     reservation is a plan whose name another plan can take unnoticed. */
  const commitOwnClaim = async () => {
    if (!identityClaim?.claimToken) return { ok: true, conflict: false };
    const out = await allocation.commitIdentity({
      companyId: company, utmCampaign: draft.utmCampaign, claimToken: identityClaim.claimToken,
    });
    if (out.committed) return { ok: true, conflict: false };
    return confirmAcceptedIdentity({
      companyId: company, draftId: draft._id, utmCampaign: draft.utmCampaign, revision,
    });
  };

  const releaseOwnClaim = async () => {
    if (identityClaim?.claimToken) {
      await allocation.releaseClaim({
        companyId: company, utmCampaign: draft.utmCampaign, claimToken: identityClaim.claimToken,
      });
    }
  };

  await fireStage(hooks, STAGES.BEFORE_HISTORY, { stage: STAGES.BEFORE_HISTORY, revision });

  /* ── THE HISTORY INDEX IS THE SERIALISATION POINT ────────────────────────
     Two concurrent edits from the same revision both compute revision N+1 and both
     try to reserve it. The unique (company, draft, revision) index admits exactly
     one. The loser does not get to write anything, anywhere — which is why the
     reservation comes before the projection and not after it. */
  const out = await reserveHistory({
    companyId: company, draftId: draft._id, draftRef: draft.draftRef,
    kind: "edited", revision, fromState, toState: fromState,
    changedFields,
    before: Object.fromEntries(changedFields.map((k) => [k, before[k]])),
    after: Object.fromEntries(changedFields.map((k) => [k, after[k]])),
    actor, resulting,
  });

  if (!out.reserved) {
    /* ── IS THE ROW THAT GOT THERE FIRST THIS SAME COMMAND? ─────────────────
       Somebody already holds this revision. Comparing the recorded row's resulting
       state with the one intended here is what separates two cases that used to be
       treated identically:

         the same resulting state  →  this IS this command — a retry, or an
                                      identical concurrent request. It resumes and
                                      must NOT release the shared claim, because
                                      the claim belongs to the revision that is
                                      going to be accepted.
         a different state         →  a different command won. Only then is this
                                      one's own provisional claim released.

       Releasing on both was the bug: a losing edit took away the claim its twin
       was about to commit. */
    const recorded = out.existing;
    const sameCommand = recorded
      && allocation.fingerprint(recorded.resulting || {}) === allocation.fingerprint(resulting);

    if (sameCommand) {
      /* Finish applying it if it is outstanding, then answer as a duplicate of an
         accepted revision rather than a conflict. */
      await reconcileDraft({ companyId: company, draftId: draft._id });
      const landed = await revisionLanded({ companyId: company, draftId: draft._id, revision });
      if (landed) {
        await commitOwnClaim();
        const confirmedSame = await confirmAcceptedIdentity({
          companyId: company, draftId: draft._id, utmCampaign: landed.utmCampaign, revision,
        });
        if (!confirmedSame.ok) {
          if (confirmedSame.conflict) throw unprojectable({ stage: "identity_owned_elsewhere", revision });
          throw repairPending({ stage: "identity_commit_unconfirmed", revision, previousRevision: fromRevision });
        }
        return {
          ...present(landed, { companyId: company, env }),
          changed: true, changedFields, duplicate: true,
        };
      }
      /* Recorded and unapplied. The claim stays provisional; a later read finishes
         it. */
      const repair = await reconcileDraft({ companyId: company, draftId: draft._id });
      if (repair.terminal) throw unprojectable({ stage: repair.stage, revision });
      throw repairPending({ stage: repair.stage, revision, previousRevision: fromRevision });
    }

    /* A different command won, so this edit never happened and the identity it
       provisionally claimed is released — holding it would burn a name on behalf of
       a request that lost. Fenced on this command's own token, so it cannot touch
       the winner's claim. */
    await releaseOwnClaim();
    await reconcileDraft({ companyId: company, draftId: draft._id });
    const current = await MarketingCampaignDraft.findOne({ _id: draft._id, companyId: company }).lean();
    throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
      "Somebody changed this campaign plan while you were editing it. Reload it and re-apply your changes.",
      { field: "expectedRevision", currentRevision: Number(current?.revision) || fromRevision, sentRevision: fromRevision });
  }

  await fireStage(hooks, STAGES.AFTER_HISTORY, { stage: STAGES.AFTER_HISTORY, revision });

  /* ── AND THE PROJECTION IS CONDITIONAL ON ALL FOUR ───────────────────────
     Id, company, an editable state, and the exact revision. A state transition
     that slipped in between the load and here changes the state, so this matches
     nothing and the edit does not land — which is what stops an approval from
     attaching to content edited after it was submitted. */
  const applied = await MarketingCampaignDraft.findOneAndUpdate(
    {
      _id: draft._id,
      companyId: company,
      state: { $in: EDITABLE_STATES },
      revision: fromRevision,
    },
    { $set: { ...projectionOf(resulting), revision } },
    { new: true },
  );

  if (!applied) {
    await reconcileDraft({ companyId: company, draftId: draft._id });
    const landed = await revisionLanded({ companyId: company, draftId: draft._id, revision });
    if (landed) {
      /* Somebody else projected this caller's own durable row — a concurrent
         reconcile, or another command's `load` finishing it. The change is
         applied, so the claim is committed and this is a success, not a repair. */
      const landedCommit = await commitOwnClaim();
      if (!landedCommit.ok) {
        if (landedCommit.conflict) throw unprojectable({ stage: "identity_owned_elsewhere", revision });
        throw repairPending({ stage: "identity_commit_unconfirmed", revision, previousRevision: fromRevision });
      }
      return { ...present(landed, { companyId: company, env }), changed: true, changedFields };
    }
    /* The history row is durable and unapplied. The claim stays PROVISIONAL: this
       revision may yet be projected by a later read, and releasing now would let
       another plan take an identity this recorded revision still wants.
       `reconcileIdentityClaims` resolves it once the outcome is decided. */
    const repair = await reconcileDraft({ companyId: company, draftId: draft._id });
    if (repair.terminal) throw unprojectable({ stage: repair.stage, revision });
    throw repairPending({ stage: repair.stage, revision, previousRevision: fromRevision });
  }

  /* The revision is accepted, so the claim becomes permanent — and the answer is
     withheld until that is confirmed. */
  const committedOk = await commitOwnClaim();
  if (!committedOk.ok) {
    if (committedOk.conflict) throw unprojectable({ stage: "identity_owned_elsewhere", revision });
    throw repairPending({ stage: "identity_commit_unconfirmed", revision, previousRevision: fromRevision });
  }

  /* Which identity is the live one, derived from the plan. Every identity the plan
     has ever carried STAYS reserved — each may already exist in click data — and
     this only records which is current. */
  if (applied.utmCampaign !== before.utmCampaign) {
    await allocation.syncCurrentIdentity({
      companyId: company, draftId: draft._id, utmCampaign: applied.utmCampaign,
    });
  }

  await fireStage(hooks, STAGES.AFTER_PROJECTION, { stage: STAGES.AFTER_PROJECTION, revision });

  return { ...present(applied, { companyId: company, env }), changed: true, changedFields };
}

/**
 * Has this exact edit already been accepted at the revision after the caller's?
 *
 * ── COMPARING INTENT WITH THE RECORD ───────────────────────────────────────
 * Reconstructs the caller's intended result from the state they were editing — the
 * history row at their expected revision — and compares it with the row that
 * actually took the next revision. Equal means their edit landed, and the answer is
 * that revision flagged as a duplicate. Unequal means somebody else's edit landed
 * and a revision conflict is honest.
 *
 * Returns null when it cannot establish either, so the ordinary conflict path runs.
 */
async function alreadyAccepted({ companyId, draft, payload, expectedRevision, env }) {
  const [base, next] = await Promise.all([
    MarketingCampaignDraftHistory
      .findOne({ companyId, draftId: draft._id, revision: expectedRevision })
      .select("resulting").lean(),
    MarketingCampaignDraftHistory
      .findOne({ companyId, draftId: draft._id, revision: expectedRevision + 1 })
      .select("resulting kind").lean(),
  ]);

  if (!base?.resulting || !next?.resulting) return null;
  /* Only an edit can be a duplicate of an edit. A transition at that revision is a
     different kind of act and must not be mistaken for one. */
  if (next.kind !== "edited") return null;

  let intended;
  try {
    /* A copy, so the comparison cannot mutate the stored base. */
    intended = applyPayload(JSON.parse(JSON.stringify(base.resulting)), payload);
  } catch {
    /* The payload is not even valid against that base, so it cannot be what
       produced the accepted revision. */
    return null;
  }

  if (allocation.fingerprint(intended) !== allocation.fingerprint(next.resulting)) return null;

  const current = await MarketingCampaignDraft.findOne({ _id: draft._id, companyId });
  if (!current || current.revision < expectedRevision + 1) return null;

  const baseView = auditView(base.resulting);
  const intendedView = auditView(intended);
  const changedFields = Object.keys(intendedView).filter(
    (k) => JSON.stringify(intendedView[k]) !== JSON.stringify(baseView[k]),
  );

  return {
    ...present(current, { companyId, env }),
    changed: true,
    changedFields,
    duplicate: true,
  };
}

/**
 * The transition rule for a move, or a refusal naming what IS available.
 */
function assertTransition(draft, toState, { user, action }) {
  const fromRules = TRANSITIONS[draft.state] || {};
  const rule = fromRules[toState];

  if (!rule || rule.action !== action) {
    const available = Object.entries(fromRules).map(([to, r]) => r.action);
    /* `${action}d` produced "returnd" and "cancell"-adjacent nonsense, and an
       English past tense cannot be derived by appending a letter. The action is
       quoted as the verb a caller actually sent instead. */
    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      available.length
        ? `A ${stateSpec(draft.state)?.label?.toLowerCase() || draft.state} plan cannot be acted on with "${action}". What it can be: ${available.join(", ")}.`
        : `This plan is ${stateSpec(draft.state)?.label?.toLowerCase() || draft.state} and nothing further can be done to it.`,
      /* Named `availableActions`, not `available`: the shared privacy boundary
         treats `available` as a provider detail and drops it, and a refusal that
         lists nothing leaves a client guessing. */
      { state: draft.state, attempted: action, availableActions: available });
  }

  if (rule.actor === "approver" && !isApprover(user)) {
    throw fail("CAMPAIGN_DRAFT_DECISION_FORBIDDEN",
      "Deciding on a campaign plan is an administrator's call. Marketing writes and submits; Sales has no part in it.",
      { attempted: action });
  }
  if (rule.actor === "marketing" && !isAuthor(user)) {
    throw fail("FORBIDDEN", "That is a Marketing action.", { attempted: action });
  }

  return rule;
}

/**
 * Apply one state transition atomically.
 *
 * ── WHY THIS IS NOT A READ, A MUTATE AND A SAVE ────────────────────────────
 * Two concurrent submits both read the plan at revision 1, both set revision 2,
 * and both save. Mongo accepts the second write because nothing in it contradicts
 * the first, so the document ends up correct by luck — and then both try to write
 * the history row for revision 2. The unique index refuses the loser, which is
 * what it is for, but the refusal arrived as a raw duplicate-key error: a 500
 * carrying a collection name and an index name to the caller.
 *
 * So the state change is ONE conditional update. The expected state and revision
 * are in the SELECTOR, so exactly one of two racing callers matches. The loser
 * matches nothing, re-reads, and gets either an honest duplicate (the plan is
 * already where they wanted it) or an honest conflict (somebody moved it
 * somewhere else). Neither gets a database error.
 *
 * @param {object} args
 * @param {string} args.action  the verb, for the refusal's wording
 * @param {object} args.set     the fields this transition writes
 */
async function applyTransition({
  company, draft, toState, action, set, historyKind, reason = "", actor, env, hooks = null,
}) {
  const fromState = draft.state;
  const fromRevision = draft.revision;
  const revision = fromRevision + 1;

  /* The canonical plan this transition produces, built from the loaded document
     plus the fields the transition writes. This is what a repair applies. */
  const resulting = canonical({
    ...draft.toObject(),
    ...set,
    state: toState,
  });

  await fireStage(hooks, STAGES.BEFORE_HISTORY, { stage: STAGES.BEFORE_HISTORY, revision });

  const out = await reserveHistory({
    companyId: company, draftId: draft._id, draftRef: draft.draftRef,
    kind: historyKind, revision, fromState, toState,
    reason, actor, resulting,
  });

  if (!out.reserved) {
    /* ── A RETRY, OR A RACE ──────────────────────────────────────────────────
       Somebody already reserved this revision. If it was the same transition —
       this caller's own retry after an interruption — finish applying it and
       answer as a duplicate. If it was a different one, the plan went somewhere
       else and this is a conflict.

       The distinction is read from the DURABLE row, not guessed from the plan's
       current state. That is what makes a duplicate response safe: it is only
       given once both the recorded row and the projected plan are confirmed. */
    const existing = out.existing;
    await reconcileDraft({ companyId: company, draftId: draft._id, hooks });
    const current = await MarketingCampaignDraft.findOne({ _id: draft._id, companyId: company });

    if (existing && existing.toState === toState) {
      if (current && current.revision >= revision) {
        return {
          ...present(current, { companyId: company, env }),
          duplicate: true,
          message: `This plan is already ${stateSpec(toState)?.label?.toLowerCase() || toState}.`,
        };
      }
      /* Recorded and still not applied. NOT a duplicate — saying so would report
         success for a plan that does not yet reflect it. */
      throw repairPending({ stage: "projection_behind", revision, previousRevision: fromRevision });
    }

    throw fail("CAMPAIGN_DRAFT_STATE_CONFLICT",
      `Somebody changed this campaign plan while you were acting on it. It is now ${stateSpec(current?.state)?.label?.toLowerCase() || str(current?.state) || "in another state"}.`,
      { state: current?.state || null, attempted: action, currentRevision: Number(current?.revision) || fromRevision });
  }

  await fireStage(hooks, STAGES.AFTER_HISTORY, { stage: STAGES.AFTER_HISTORY, revision });

  /* ── ONE CONDITIONAL UPDATE ──────────────────────────────────────────────
     The expected state and revision are in the SELECTOR, so exactly one of two
     racing callers matches. A read-then-mutate-then-save would let both write,
     and the document would end up correct only by luck. */
  const applied = await MarketingCampaignDraft.findOneAndUpdate(
    { _id: draft._id, companyId: company, state: fromState, revision: fromRevision },
    { $set: { ...projectionOf(resulting), revision } },
    { new: true },
  );

  if (!applied) {
    await reconcileDraft({ companyId: company, draftId: draft._id });
    const landed = await revisionLanded({ companyId: company, draftId: draft._id, revision });
    if (landed) return { ...present(landed, { companyId: company, env }), duplicate: false };
    const repair = await reconcileDraft({ companyId: company, draftId: draft._id });
    if (repair.terminal) throw unprojectable({ stage: repair.stage, revision });
    throw repairPending({ stage: repair.stage, revision, previousRevision: fromRevision });
  }

  await fireStage(hooks, STAGES.AFTER_PROJECTION, { stage: STAGES.AFTER_PROJECTION, revision });

  return { ...present(applied, { companyId: company, env }), duplicate: false };
}

/**
 * Refuse a plan whose advertising brief the readiness evaluator would not pass.
 *
 * ── ONE EVALUATOR, CONSULTED BY BOTH GATES ─────────────────────────────────
 * Readiness reported `approvalReady: false` while `submit` moved the same plan to
 * awaiting_approval and `decide` approved it. Two parts of one product told a
 * marketer two different things about one plan, and the part that actually moved the
 * record was the part that checked nothing.
 *
 * Both gates now call the SAME pure function that the readiness route calls, so the
 * answers cannot drift. Re-evaluated at approval as well as at submission, because a
 * plan may already be sitting in awaiting_approval from before this rule existed —
 * and an approval is the consequential step.
 *
 * ── LOCAL BLOCKERS ONLY ────────────────────────────────────────────────────
 * The external preflight checks are excluded deliberately. They belong to
 * deployment, nothing inside GRAV can answer them, and blocking a submission on
 * them would make every plan permanently unapprovable.
 *
 * A plan with no advertising channel is not judged here at all: the ordinary
 * plan-approval rules are the whole rule for one.
 */
function assertSubmissionGate(draft, { action }) {
  const snapshot = canonical(draft);
  const gate = readiness.submissionGate({ plan: snapshot });
  if (gate.ready) return gate;

  /* ── THE SAME REFUSALS AS BEFORE, FROM ONE LIST ─────────────────────────
     An advertising plan is refused as advertising-incomplete (grouped exactly
     as the readiness response groups it); any other plan as a validation
     failure naming the missing fields. Both come from the gate the readiness
     route publishes, for this revision. */
  if (gate.applicable) {
    throw fail("CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE",
      action === "approve"
        ? "This plan advertises on a channel and its advertising brief is incomplete, so it cannot be approved. It can still be returned or rejected."
        : "This plan advertises on a channel and its advertising brief is incomplete, so it is not ready for a decision.",
      {
        advertisingReadiness: {
          applicable: true,
          evaluatorVersion: gate.verdict.evaluatorVersion,
          evaluatedRevision: draft.revision,
          missingFromPlan: gate.groups.missingFromPlan,
          unsupportedByGrav: gate.groups.unsupportedByGrav,
          contradictions: gate.groups.contradictions,
        },
        missing: gate.missing,
      });
  }

  throw fail("VALIDATION",
    action === "approve"
      ? `This plan is not complete enough to approve. It needs ${gate.missing.join(", ") || "the items listed"}. It can still be returned or rejected.`
      : `This plan is not ready for a decision. An approver needs ${gate.missing.join(", ") || "the items listed"}.`,
    { missing: gate.missing, evaluatedRevision: draft.revision, evaluatorVersion: gate.verdict.evaluatorVersion });
}

/* ── THE SUBMIT FENCE ─────────────────────────────────────────────────────────
   The revision the submitter was looking at. Checked against the loaded plan
   here, and made atomic by `applyTransition`, whose history reservation and
   conditional update both carry the revision: an edit landing between this check
   and the write takes the revision first, and the submit then conflicts. */
function assertSubmitRevision(expectedRevision) {
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw fail("VALIDATION",
      `expectedRevision must be a whole number telling GRAV which version you are submitting, not ${typeName(expectedRevision)}.`,
      { field: "expectedRevision", received: typeName(expectedRevision) });
  }
  return expectedRevision;
}

/* Was THIS revision the one that became the pending submission? A genuine
   duplicate is a repeat of the accepted submission; anything else is stale. */
async function submittedFrom({ companyId, draft, expectedRevision }) {
  const row = await MarketingCampaignDraftHistory
    .findOne({ companyId, draftId: draft._id, kind: "submitted" })
    .sort({ revision: -1 })
    .select("revision").lean();
  return Boolean(row) && row.revision === expectedRevision + 1 && draft.revision === expectedRevision + 1;
}

/**
 * Submit a plan for approval.
 *
 * ── FENCED ON THE REVISION, FOR EVERY CALLER ───────────────────────────────
 * `expectedRevision` is required: the revision the submitter reviewed. Missing,
 * null or malformed is refused before anything is read; a revision the plan has
 * moved past is a conflict. Either way no history row is written and the plan
 * does not move.
 *
 * ── IDEMPOTENT ONLY FOR THE ACCEPTED REVISION ──────────────────────────────
 * A double-clicked submit of the SAME revision finds that revision's submission
 * already accepted and returns the same answer rather than writing a second
 * history row or a second revision — `duplicate: true` so a client can tell, and
 * a success because the caller's intent is satisfied. A submit of any other
 * revision against an already-submitted plan is a conflict.
 *
 * ── AND A PLAN MUST BE COMPLETE TO BE SUBMITTED ────────────────────────────
 * Fields optional while drafting become required here. A plan going to an
 * approver with no budget and no dates is a plan they cannot decide on, and the
 * refusal lists everything missing at once rather than one field per round trip.
 */
async function submit({
  companyId, user, campaignDraftId, expectedRevision, env = process.env, hooks = null,
} = {}) {
  /* Before any read or write. Every caller — the route, a script, a test —
     names the revision it is submitting. There is no unfenced submit. */
  const actor = actorFrom(user);
  assertSubmitRevision(expectedRevision);
  const { company, draft } = await load(companyId, campaignDraftId, env, hooks);

  if (draft.state === "awaiting_approval") {
    /* ── A DUPLICATE ONLY OF THE SAME ACCEPTED SUBMISSION ─────────────────
       A double-click, or a second person pressing Submit on the same revision
       at the same moment, is the submission that was accepted: answered as a
       duplicate. A submit built on an OLDER revision is not — the plan that
       went for a decision is not the one this caller was looking at. */
    if (!(await submittedFrom({ companyId: company, draft, expectedRevision }))) {
      throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
        "This plan was submitted from a newer version than the one you were looking at. Reload it to see what went for a decision.",
        { field: "expectedRevision", currentRevision: draft.revision, sentRevision: expectedRevision });
    }
    return {
      ...present(draft, { companyId: company, env }),
      duplicate: true,
      message: "This plan was already submitted and is awaiting a decision.",
    };
  }

  assertTransition(draft, "awaiting_approval", { user, action: "submit" });

  if (expectedRevision !== draft.revision) {
    throw fail("CAMPAIGN_DRAFT_REVISION_CONFLICT",
      "Somebody changed this campaign plan since you opened it. Reload it and check it before submitting.",
      { field: "expectedRevision", currentRevision: draft.revision, sentRevision: expectedRevision });
  }

  /* After the duplicate short-circuit above, so a repeated submit of an
     already-submitted plan stays idempotent rather than being re-judged. The
     SAME gate the readiness route publishes as `approvalReady`. */
  assertSubmissionGate(draft, { action: "submit" });

  return applyTransition({
    company, draft, toState: "awaiting_approval", action: "submit",
    set: {
      submittedAt: new Date(),
      submittedBy: actor,
      /* A resubmission after a return clears the previous decision: leaving it
         would show the next approver the last rejection as though it applied to
         the version in front of them. */
      decisionReason: "",
      decidedAt: null,
      decidedBy: null,
    },
    historyKind: "submitted",
    actor, env, hooks,
  });
}

/**
 * Record a decision: approve, return or reject.
 *
 * ── APPROVAL IS NOT ACTIVATION ─────────────────────────────────────────────
 * This writes a state and an audit row. It calls no provider, creates nothing
 * external, commits no budget and starts no spending. The response says so in
 * `deploymentMeans`, because `approved` is the word somebody will read as "live".
 */
async function decide({
  companyId, user, campaignDraftId, decision, reason = "", env = process.env, hooks = null,
} = {}) {
  const wanted = assertEnum(decision, APPROVAL_DECISION_CODES, "decision", "a decision");
  const spec = decisionSpec(wanted);
  const actor = actorFrom(user);

  const { company, draft } = await load(companyId, campaignDraftId, env, hooks);

  /* ── IDEMPOTENT ──────────────────────────────────────────────────────────
     A repeated decision that matches the recorded one is reported as a duplicate
     rather than written twice. A repeated decision that DIFFERS is a state
     conflict, not an overwrite — changing an approval to a rejection is a new
     decision somebody must make from a state that allows it. */
  if (draft.state === spec.to) {
    return {
      ...present(draft, { companyId: company, env }),
      duplicate: true,
      message: `This plan was already ${stateSpec(spec.to)?.label?.toLowerCase() || spec.to}.`,
    };
  }

  /* The decision code and the transition table's action are the same word, which
     is not a coincidence — the table is the authority on who may make each move
     and the decision list names the moves. Passing `spec.action` here read
     plausibly and was always undefined, because a decision carries a target
     state and a reason rule, not an action name. */
  assertTransition(draft, spec.to, { user, action: wanted });

  const cleanReason = assertText(reason, "reason", LIMITS.DECISION_REASON_MAX);
  if (spec.requiresReason && !cleanReason) {
    throw fail("VALIDATION",
      wanted === "return"
        ? "Say what needs changing. A plan returned with no reason is one its author cannot act on."
        : "Say why this plan was rejected. It is the only record of the decision.",
      { field: "reason" });
  }

  /* ── RE-EVALUATED AT APPROVAL ───────────────────────────────────────────
     An approval is the consequential step, and a plan may have reached
     awaiting_approval before this rule existed or through a path that did not
     check. Return and reject stay available, which is what stops an incomplete
     plan being stuck. */
  if (wanted === "approve") assertSubmissionGate(draft, { action: "approve" });

  /* Only an approval needs a second pair of eyes. Declining your own plan does
     not, and blocking it would trap an author who changed their mind. */
  if (wanted === "approve") assertNotSelfApproval(draft, user);

  return applyTransition({
    company, draft, toState: spec.to, action: wanted,
    set: {
      decidedAt: new Date(),
      decidedBy: actor,
      decisionReason: cleanReason,
    },
    historyKind: spec.to === "approved" ? "approved" : spec.to === "returned" ? "returned" : "rejected",
    reason: cleanReason,
    actor, env, hooks,
  });
}

/**
 * An approver may not approve their own submission.
 *
 * ── WHY THIS IS HERE AND NOT LEFT TO POLICY ────────────────────────────────
 * An administrator may also write plans, which is deliberate in the internal
 * first release. Without this check one person could write, submit and approve a
 * budget commitment with nobody else involved, and the audit trail would show two
 * decisions by the same name and read as though it were controlled.
 *
 * Returning and rejecting are exempt: declining your own plan needs no second
 * pair of eyes, and blocking it would trap an author who changed their mind.
 */
function selfApprovalProblem(draft, user) {
  const submitter = draft.submittedBy;

  /* ── NO SUBMITTER IDENTITY MEANS NO APPROVAL ────────────────────────────
     A plan reaching `awaiting_approval` always records who submitted it, because
     `actorFrom` refuses a mutation without one. A row without it is either from
     before that rule or corrupt, and in both cases GRAV cannot tell whether this
     approver is the submitter. The safe answer is to refuse: approving a plan
     whose submitter is unknown is exactly the case the rule exists to prevent,
     and `return` is still available for whoever needs to move it.

     The earlier version fell through to "not the same person" when both sides
     were empty, which let an identity-less claim approve its own submission. */
  if (!submitter || !submitter.id) {
    return {
      code: "SUBMITTER_UNKNOWN",
      message: "GRAV cannot confirm who submitted this plan, so it cannot confirm that somebody else is approving it. It can still be returned or rejected.",
    };
  }

  /* ── BY IDENTITY, NEVER BY NAME ──────────────────────────────────────────
     Two people can share a name, and one person can change theirs. The
     comparison is the signed-in user's id against the recorded submitter's id;
     neither id is ever published. */
  if (String(user?.id || "") && String(user.id) === String(submitter.id)) {
    return {
      code: "SELF_APPROVAL",
      message: "You submitted this plan, so approving it needs somebody else. You can still return or reject it.",
    };
  }
  return null;
}

function assertNotSelfApproval(draft, user) {
  actorFrom(user);
  const problem = selfApprovalProblem(draft, user);
  if (problem) {
    throw fail("CAMPAIGN_DRAFT_DECISION_FORBIDDEN", problem.message, { attempted: "approve" });
  }
}

/* ── WHAT THIS VIEWER MAY DO, AND WHY NOT ─────────────────────────────────────
   Computed from the same table, role checks, submission gate and self-approval
   rule the commands enforce, so a button the screen offers is one the server
   will honour. The commands still check everything again: this is a courtesy to
   the screen, never the authority.

   Only booleans, stable reason codes and sentences. No user id, submitter id or
   email is exposed. */
function viewerActionsFor(draft, user) {
  const spec = stateSpec(draft.state);
  const rules = TRANSITIONS[draft.state] || {};
  const ruleFor = (action) => Object.values(rules).find((r) => r.action === action) || null;
  const identified = mongoose.Types.ObjectId.isValid(str(user?.id));
  const submittedByYou = Boolean(identified && draft.submittedBy?.id
    && String(draft.submittedBy.id) === String(user.id));
  const stateWord = (spec?.label || draft.state).toLowerCase();

  let gate = null;
  const gateFor = () => {
    if (!gate) gate = readiness.submissionGate({ plan: canonical(draft) });
    return gate;
  };

  const no = (reasonCode, reason) => ({ allowed: false, reasonCode, reason });
  const yes = () => ({ allowed: true, reasonCode: null, reason: null });

  const judge = (action) => {
    if (!identified) {
      return no("IDENTITY_UNVERIFIED", "GRAV records who acts on a campaign plan, and cannot confirm who you are.");
    }
    if (action === "edit") {
      if (!spec?.editable) return no("NOT_AVAILABLE_IN_STATE", `A ${stateWord} plan cannot be edited.`);
      if (!isAuthor(user)) return no("MARKETING_ONLY", "Editing a campaign plan needs the Editor role or higher in Marketing.");
      return yes();
    }
    const rule = ruleFor(action);
    if (!rule) return no("NOT_AVAILABLE_IN_STATE", `A ${stateWord} plan cannot be acted on with "${action}".`);
    if (rule.actor === "approver" && !isApprover(user)) {
      return no("APPROVER_ONLY", "Deciding on a campaign plan is an administrator's call.");
    }
    if (rule.actor === "marketing" && !isAuthor(user)) {
      return no("MARKETING_ONLY", "That needs the Editor role or higher in Marketing.");
    }
    if (action === "submit" && !gateFor().ready) {
      return no("PLAN_INCOMPLETE", `This plan is not ready for a decision yet. It still needs ${gateFor().missing.join(", ") || "the items the readiness check lists"}.`);
    }
    if (action === "approve") {
      const problem = selfApprovalProblem(draft, user);
      if (problem) return no(problem.code, problem.message);
      if (!gateFor().ready) {
        return no("PLAN_INCOMPLETE", "This plan is not complete enough to approve. It can still be returned or rejected.");
      }
    }
    return yes();
  };

  return {
    /* The revision these answers are about. Send it back as `expectedRevision`. */
    evaluatedRevision: draft.revision,
    submittedByYou,
    edit: judge("edit"),
    submit: judge("submit"),
    approve: judge("approve"),
    return: judge("return"),
    reject: judge("reject"),
    cancel: judge("cancel"),
  };
}

/**
 * Cancel a plan.
 *
 * Who may cancel depends on the state: Marketing may withdraw its own before a
 * decision, and standing down an APPROVED plan is the approver's call because
 * approval was theirs.
 */
async function cancel({ companyId, user, campaignDraftId, reason = "", env = process.env, hooks = null } = {}) {
  const actor = actorFrom(user);
  const { company, draft } = await load(companyId, campaignDraftId, env, hooks);

  if (draft.state === "cancelled") {
    return {
      ...present(draft, { companyId: company, env }),
      duplicate: true,
      message: "This plan was already cancelled.",
    };
  }

  assertTransition(draft, "cancelled", { user, action: "cancel" });

  const cleanReason = assertText(reason, "reason", LIMITS.DECISION_REASON_MAX);

  return applyTransition({
    company, draft, toState: "cancelled", action: "cancel",
    set: { cancelledAt: new Date(), decisionReason: cleanReason },
    historyKind: "cancelled",
    reason: cleanReason,
    actor, env, hooks,
  });
}

/**
 * Validate a payload and apply it onto a plan-shaped target, in place.
 *
 * Used by the edit itself and by the duplicate detection that reconstructs what a
 * caller's payload WOULD have produced from a revision since superseded. One
 * function, so the two cannot disagree about what a payload means — a disagreement
 * there would make a retry look like a different edit.
 *
 * The target may be a mongoose document or a plain object with the same field
 * shape, which is what `canonical()` produces.
 */
/**
 * The per-channel deployment briefs, validated.
 *
 * ── ONE BRIEF PER CHANNEL, AND ONLY FOR CHANNELS THE PLAN SELECTED ─────────
 * A brief for a channel the plan does not use is either a leftover from a channel
 * somebody removed or a mistake, and storing it would mean the readiness evaluator
 * silently ignoring information a marketer believes they gave.
 *
 * ── AND NOTHING A PROVIDER OWNS ────────────────────────────────────────────
 * No campaign, ad-set, ad-group or creative id. No advertising-account id. No
 * token. No script. No provider API path. Refused by name here as well as at the
 * top-level allowlist, because a nested object is exactly where a field slips
 * through an allowlist that only checks the top level.
 */
/* ── AN AGE IS A WHOLE NUMBER OR IT IS UNANSWERED ───────────────────────────
   `Number("25")` is 25, `Number(null)` is 0, `Number(true)` is 1 and
   `Number("")` is 0. Every one of those is an age boundary nobody typed, and
   two of them are an age of zero — which would quietly widen an audience that
   somebody had deliberately narrowed. So the type is checked rather than
   coerced, and `null` is preserved as "not decided". */
function assertOptionalAge(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw fail("VALIDATION",
      `${field} must be a whole number. A value sent as text is not an age.`,
      { field: `deploymentBriefs.${field}` });
  }
  if (value < 0 || value > 200) {
    throw fail("VALIDATION", `${field} is not an age.`, { field: `deploymentBriefs.${field}` });
  }
  return value;
}

function assertDeploymentBriefs(value, { channels }) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", `deploymentBriefs must be a list, not ${typeName(value)}.`,
      { field: "deploymentBriefs" });
  }

  const ACCEPTED = [
    "channel", "campaignType", "destination", "geoTargeting", "geoExclusions", "languages",
    "audiences", "exclusionDecision", "exclusions", "bidding", "budgetRelationship",
    "metaOptimisation", "specialAdCategory", "euPoliticalAdvertising",
    "audienceMode", "audienceAgeMin", "audienceAgeMax", "audienceGenders",
    "audienceExpansionRequested", "advertisingAssetId",
    "googleSearch", "googleLeadForm", "metaSingleImage", "contentRefs", "timezone",
  ];

  const seen = new Set();
  const out = [];

  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw fail("VALIDATION", "Each deployment brief must be an object.", { field: "deploymentBriefs" });
    }

    assertNoProviderFields(raw, "deploymentBriefs");

    const unknown = Object.keys(raw).filter((k) => !ACCEPTED.includes(k));
    if (unknown.length) {
      throw fail("VALIDATION",
        `A deployment brief does not accept ${unknown.join(", ")}.`,
        { field: "deploymentBriefs", unknown, accepted: ACCEPTED });
    }

    const channel = assertEnum(raw.channel, MARKETING_CHANNEL_CODES, "deploymentBriefs.channel", "a channel");
    if (!channels.includes(channel)) {
      throw fail("VALIDATION",
        "There is a deployment brief for a channel this plan does not use.",
        { field: "deploymentBriefs.channel", channel });
    }
    if (seen.has(channel)) {
      throw fail("VALIDATION", "There is more than one brief for the same channel.",
        { field: "deploymentBriefs.channel", channel });
    }
    seen.add(channel);

    /* ── AN UNSUPPORTED TYPE IS REFUSED AT THE WRITE, NOT ONLY AT THE READ ───
       The evaluator would report it, but storing it first means a plan carrying a
       value GRAV has already decided it will never prepare. Refusing here says so
       at the moment somebody chose it. */
    let campaignType = "";
    if (has(raw, "campaignType") && raw.campaignType !== null && str(raw.campaignType) !== "") {
      campaignType = assertEnum(raw.campaignType, RECORDABLE_CAMPAIGN_TYPE_CODES,
        "deploymentBriefs.campaignType", "a campaign type GRAV prepares");
      const spec = readinessTypeSpec(campaignType);
      if (spec.channel !== channel) {
        throw fail("VALIDATION",
          `${spec.label} is not a campaign type for that channel.`,
          { field: "deploymentBriefs.campaignType" });
      }
    }

    out.push({
      channel,
      campaignType,
      destination: assertDestination(raw.destination),
      geoTargeting: assertNamedTargets(raw.geoTargeting, "geoTargeting", BRIEF_LIMITS.GEO_MAX,
        ["country", "region", "city", "postal_area", "radius"]),
      /* Places the campaign must not reach. Deliberately its own list rather than
         a flag on `geoTargeting`: a flag one line of code forgets to read turns
         an exclusion into an inclusion. */
      geoExclusions: assertNamedTargets(raw.geoExclusions, "geoExclusions", BRIEF_LIMITS.GEO_MAX,
        ["country", "region", "city", "postal_area", "radius"]),
      languages: assertLanguages(raw.languages),
      audiences: assertNamedTargets(raw.audiences, "audiences", BRIEF_LIMITS.AUDIENCE_MAX,
        ["interest", "behaviour", "demographic", "custom_list", "lookalike", "search_intent"]),
      exclusionDecision: has(raw, "exclusionDecision") && str(raw.exclusionDecision)
        ? assertEnum(raw.exclusionDecision, EXCLUSION_DECISION_CODES, "deploymentBriefs.exclusionDecision", "an exclusion decision")
        : "",
      exclusions: assertNamedTargets(raw.exclusions, "exclusions", BRIEF_LIMITS.EXCLUSION_MAX,
        ["interest", "behaviour", "demographic", "custom_list", "lookalike", "search_intent"]),
      bidding: assertBidding(raw.bidding),
      budgetRelationship: has(raw, "budgetRelationship") && str(raw.budgetRelationship)
        ? assertEnum(raw.budgetRelationship, BUDGET_RELATIONSHIP_CODES, "deploymentBriefs.budgetRelationship", "a budget arrangement")
        : "",
      /* Validated against the channel's own closed tables at deployment, not
         here: this boundary stores what somebody chose, and the Meta contract
         decides whether it is a choice that channel offers. Stored as given so
         a plan can record an intent GRAV does not support yet and be told so
         plainly, rather than losing the field. */
      metaOptimisation: channel === "meta_ads" ? str(raw.metaOptimisation).slice(0, 40) : "",
      specialAdCategory: channel === "meta_ads" ? str(raw.specialAdCategory).slice(0, 40) : "",
      /* Google's EU political-advertising self-declaration. A closed pair,
         checked here because it is GRAV's own vocabulary; empty means the plan
         has not answered, which blocks deployment rather than defaulting. */
      euPoliticalAdvertising: channel === "google_ads" && str(raw.euPoliticalAdvertising)
        ? assertEnum(raw.euPoliticalAdvertising, ["does_not_contain", "contains"],
          "deploymentBriefs.euPoliticalAdvertising", "an EU political-advertising declaration")
        : "",
      /* ── THE AUDIENCE, STORED AS GIVEN AND JUDGED AT DEPLOYMENT ───────────
         Ages are stored strictly: a string that coerces to a number is refused
         here rather than becoming an age nobody typed. `null` is preserved and
         means unanswered, which is different from a channel default. */
      audienceMode: channel === "meta_ads" ? str(raw.audienceMode).slice(0, 40) : "",
      audienceAgeMin: channel === "meta_ads" ? assertOptionalAge(raw.audienceAgeMin, "audienceAgeMin") : null,
      audienceAgeMax: channel === "meta_ads" ? assertOptionalAge(raw.audienceAgeMax, "audienceAgeMax") : null,
      audienceGenders: channel === "meta_ads" ? str(raw.audienceGenders).slice(0, 20) : "",
      audienceExpansionRequested: channel === "meta_ads" ? raw.audienceExpansionRequested === true : false,
      /* The library's own opaque identifier. Its shape is checked where it is
         resolved; storing it here records which image the plan names. */
      advertisingAssetId: channel === "meta_ads" ? str(raw.advertisingAssetId).slice(0, 300) : "",
      googleSearch: channel === "google_ads" ? assertGoogleCreative(raw.googleSearch) : null,
      /* Only on a lead-form brief. Anywhere else it would be a form nothing
         creates, and a marketer would believe it was part of the campaign. */
      googleLeadForm: assertGoogleLeadForm(raw.googleLeadForm, { campaignType }),
      metaSingleImage: channel === "meta_ads" ? assertMetaCreative(raw.metaSingleImage) : null,
      contentRefs: assertContentRefs(raw.contentRefs),
      timezone: assertTimezone(raw.timezone),
      updatedAt: new Date(),
    });
  }

  /* Stable order, so an identical payload produces an identical stored value and
     both the no-change detection and the command fingerprint behave. */
  return out.sort((a, b) => a.channel.localeCompare(b.channel));
}

/* Provider-owned field names, refused inside a brief and one level into its nested
   objects. The top-level allowlist cannot see those. */
function assertNoProviderFields(object, path) {
  for (const [key, value] of Object.entries(object)) {
    if (isRefusedField(key)) {
      throw fail("VALIDATION",
        `A campaign plan holds no provider credentials, provider identifiers or embedded code, so ${key} was refused rather than saved.`,
        { field: `${path}.${key}`, refused: [key] });
    }
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      for (const nested of Object.keys(value)) {
        if (isRefusedField(nested)) {
          throw fail("VALIDATION",
            `A campaign plan holds no provider credentials, provider identifiers or embedded code, so ${nested} was refused rather than saved.`,
            { field: `${path}.${key}.${nested}`, refused: [nested] });
        }
      }
    }
  }
}

function assertDestination(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "destination must be an object.", { field: "deploymentBriefs.destination" });
  }
  const kind = assertEnum(value.kind, DESTINATION_KIND_CODES, "deploymentBriefs.destination.kind", "a destination kind");
  const contentId = assertText(value.contentId, "deploymentBriefs.destination.contentId", 200);
  if (contentId && !/^[A-Za-z0-9_.:-]{1,200}$/.test(contentId)) {
    throw fail("VALIDATION",
      "A contentId is the identifier the content library published. It is not a URL or a path.",
      { field: "deploymentBriefs.destination.contentId" });
  }
  const url = assertText(value.url, "deploymentBriefs.destination.url", BRIEF_LIMITS.DESTINATION_URL_MAX);
  if (url && !/^https:\/\//i.test(url)) {
    /* Refused rather than upgraded: an advertisement pointing at an insecure page
       is rejected by both channels, and silently rewriting somebody's address is
       not GRAV's decision to make. */
    throw fail("VALIDATION", "A destination address must be an https address.",
      { field: "deploymentBriefs.destination.url" });
  }
  return {
    kind, contentId, url,
    capturedName: assertText(value.capturedName, "deploymentBriefs.destination.capturedName", 300),
  };
}

function assertNamedTargets(value, field, max, kinds) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", `${field} must be a list.`, { field: `deploymentBriefs.${field}` });
  }
  if (value.length > max) {
    throw fail("VALIDATION", `${field} may name at most ${max} entries.`,
      { field: `deploymentBriefs.${field}`, max });
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw fail("VALIDATION", `Each ${field} entry must be an object with a name and a kind.`,
        { field: `deploymentBriefs.${field}` });
    }
    const extra = Object.keys(entry).filter((k) => !["name", "kind", "note"].includes(k));
    if (extra.length) {
      throw fail("VALIDATION", `A ${field} entry accepts name, kind and note.`,
        { field: `deploymentBriefs.${field}`, unknown: extra });
    }
    const name = assertText(entry.name, `deploymentBriefs.${field}.name`, BRIEF_LIMITS.GEO_NAME_MAX);
    if (!name) {
      throw fail("VALIDATION", `Each ${field} entry needs a name.`, { field: `deploymentBriefs.${field}.name` });
    }
    return {
      name,
      kind: assertEnum(entry.kind, kinds, `deploymentBriefs.${field}.kind`, "a targeting kind"),
      note: assertText(entry.note, `deploymentBriefs.${field}.note`, 200),
    };
  });
}

function assertLanguages(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw fail("VALIDATION", "languages must be a list.", { field: "deploymentBriefs.languages" });
  }
  if (value.length > BRIEF_LIMITS.LANGUAGE_MAX) {
    throw fail("VALIDATION", `At most ${BRIEF_LIMITS.LANGUAGE_MAX} languages.`,
      { field: "deploymentBriefs.languages", max: BRIEF_LIMITS.LANGUAGE_MAX });
  }
  const out = [];
  for (const raw of value) {
    const tag = assertText(raw, "deploymentBriefs.languages", 12);
    if (!tag) continue;
    /* BCP-47 shape. Resolved against each channel's own language list at
       deployment, which is why this checks form rather than membership. */
    if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) {
      throw fail("VALIDATION", "A language must be a tag like en or en-IN.",
        { field: "deploymentBriefs.languages" });
    }
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function assertBidding(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "bidding must be an object.", { field: "deploymentBriefs.bidding" });
  }
  const extra = Object.keys(value).filter((k) => !["strategy", "target"].includes(k));
  if (extra.length) {
    throw fail("VALIDATION", "bidding accepts strategy and target.",
      { field: "deploymentBriefs.bidding", unknown: extra });
  }
  const strategy = assertEnum(value.strategy, BIDDING_STRATEGY_CODES,
    "deploymentBriefs.bidding.strategy", "a bidding strategy");

  const target = value.target;
  if (target === null || target === undefined) {
    return { strategy, target: { amount: null, currency: "" } };
  }
  if (typeof target !== "object" || Array.isArray(target)) {
    throw fail("VALIDATION", "bidding.target must be an object.", { field: "deploymentBriefs.bidding.target" });
  }
  const amount = target.amount;
  if (amount !== null && amount !== undefined
    && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
    /* No coercion: `Number(null)` is 0, and a zero target has to be something
       somebody typed. */
    throw fail("VALIDATION", `bidding.target.amount must be a number, not ${typeName(amount)}.`,
      { field: "deploymentBriefs.bidding.target.amount" });
  }
  const currency = assertText(target.currency, "deploymentBriefs.bidding.target.currency", 3).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw fail("VALIDATION", "A target currency must be a three-letter ISO code.",
      { field: "deploymentBriefs.bidding.target.currency" });
  }
  return { strategy, target: { amount: amount === undefined ? null : amount, currency } };
}

function assertGoogleCreative(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "googleSearch must be an object.", { field: "deploymentBriefs.googleSearch" });
  }
  const extra = Object.keys(value).filter((k) => !["headlines", "descriptions", "keywordThemes"].includes(k));
  if (extra.length) {
    throw fail("VALIDATION", "googleSearch accepts headlines, descriptions and keywordThemes.",
      { field: "deploymentBriefs.googleSearch", unknown: extra });
  }
  const texts = (field, max, cap) => {
    const raw = value[field];
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) {
      throw fail("VALIDATION", `${field} must be a list.`, { field: `deploymentBriefs.googleSearch.${field}` });
    }
    if (raw.length > cap) {
      throw fail("VALIDATION", `${field} may hold at most ${cap} entries.`,
        { field: `deploymentBriefs.googleSearch.${field}`, max: cap });
    }
    return raw.map((t) => assertText(t, `deploymentBriefs.googleSearch.${field}`, max)).filter(Boolean);
  };
  return {
    headlines: texts("headlines", BRIEF_LIMITS.HEADLINE_MAX, 15),
    descriptions: texts("descriptions", BRIEF_LIMITS.BODY_MAX, 4),
    keywordThemes: texts("keywordThemes", 120, 50),
  };
}

/* ── THE LEAD FORM, AS GRAV STORES IT ────────────────────────────────────────
   Shape and bounds only. Whether it is complete, and whether Google would accept
   it, is the readiness evaluator's judgement (`googleLeadFormDefinition`) — one
   place, so the builder, submission and approval cannot disagree. Unknown keys
   are refused by name, including anything shaped like a delivery address, a
   secret or a provider id. */
const LEAD_FORM_TEXT_FIELDS = Object.freeze([
  "businessName", "headline", "description", "callToAction", "callToActionDescription",
  "privacyPolicyUrl", "postSubmitHeadline", "postSubmitDescription", "postSubmitCallToAction",
]);
function assertGoogleLeadForm(value, { campaignType }) {
  if (value === null || value === undefined) return null;
  const field = "deploymentBriefs.googleLeadForm";
  if (campaignType !== "google_lead_form") {
    throw fail("VALIDATION", "A lead form belongs only on a Search campaign with a lead form.", { field });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "googleLeadForm must be an object.", { field });
  }
  const allowed = [...LEAD_FORM_TEXT_FIELDS, "fields", "qualifyingQuestions"];
  const extra = Object.keys(value).filter((k) => !allowed.includes(k));
  if (extra.length) {
    throw fail("VALIDATION", `googleLeadForm accepts ${allowed.join(", ")}.`, { field, unknown: extra });
  }
  const caps = { ...LEAD_FORM_DRAFT_TEXT_MAX, callToAction: 40, postSubmitCallToAction: 40 };
  const out = {};
  for (const key of LEAD_FORM_TEXT_FIELDS) {
    out[key] = value[key] === undefined || value[key] === null ? "" : assertText(value[key], `${field}.${key}`, caps[key]);
  }
  const codesList = (key, cap) => {
    const raw = value[key];
    if (raw === null || raw === undefined) return [];
    if (!Array.isArray(raw)) throw fail("VALIDATION", `${key} must be a list.`, { field: `${field}.${key}` });
    if (raw.length > cap) throw fail("VALIDATION", `${key} may hold at most ${cap} entries.`, { field: `${field}.${key}`, max: cap });
    return raw.map((t) => assertText(t, `${field}.${key}`, 40)).filter(Boolean);
  };
  out.fields = codesList("fields", 12);
  /* Stored even above Google's limit of five, so the evaluator can say
     "this asks six" rather than the write silently dropping one. */
  out.qualifyingQuestions = codesList("qualifyingQuestions", 12);
  return out;
}

function assertMetaCreative(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw fail("VALIDATION", "metaSingleImage must be an object.", { field: "deploymentBriefs.metaSingleImage" });
  }
  const extra = Object.keys(value).filter((k) => !["primaryText", "headline", "callToAction", "image"].includes(k));
  if (extra.length) {
    throw fail("VALIDATION", "metaSingleImage accepts primaryText, headline, callToAction and image.",
      { field: "deploymentBriefs.metaSingleImage", unknown: extra });
  }
  const image = value.image;
  let resolved = { kind: "", contentId: "", capturedName: "" };
  if (image !== null && image !== undefined) {
    if (typeof image !== "object" || Array.isArray(image)) {
      throw fail("VALIDATION", "metaSingleImage.image must be an object.",
        { field: "deploymentBriefs.metaSingleImage.image" });
    }
    const contentId = assertText(image.contentId, "deploymentBriefs.metaSingleImage.image.contentId", 200);
    if (contentId && !/^[A-Za-z0-9_.:-]{1,200}$/.test(contentId)) {
      throw fail("VALIDATION",
        "A contentId is the identifier the content library published. It is not a URL or a path.",
        { field: "deploymentBriefs.metaSingleImage.image.contentId" });
    }
    resolved = {
      kind: str(image.kind)
        ? assertEnum(image.kind, CONTENT_KIND_CODES, "deploymentBriefs.metaSingleImage.image.kind", "a content kind")
        : "",
      contentId,
      capturedName: assertText(image.capturedName, "deploymentBriefs.metaSingleImage.image.capturedName", 300),
    };
  }
  return {
    primaryText: assertText(value.primaryText, "deploymentBriefs.metaSingleImage.primaryText", BRIEF_LIMITS.BODY_MAX),
    headline: assertText(value.headline, "deploymentBriefs.metaSingleImage.headline", BRIEF_LIMITS.HEADLINE_MAX),
    callToAction: assertText(value.callToAction, "deploymentBriefs.metaSingleImage.callToAction", BRIEF_LIMITS.CALL_TO_ACTION_MAX),
    image: resolved,
  };
}

function assertTimezone(value) {
  const tz = assertText(value, "deploymentBriefs.timezone", BRIEF_LIMITS.TIMEZONE_MAX);
  if (!tz) return "";
  /* An IANA zone name, validated by asking the platform rather than against a list
     GRAV would have to maintain and would get wrong. */
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw fail("VALIDATION", "That is not a timezone GRAV recognises. Use a name like Asia/Kolkata.",
      { field: "deploymentBriefs.timezone" });
  }
  return tz;
}

function applyPayload(target, payload) {
  if (has(payload, "name")) target.name = assertName(payload.name);
  if (has(payload, "objective")) target.objective = assertEnum(payload.objective, CAMPAIGN_OBJECTIVE_CODES, "objective", "a campaign objective");
  if (has(payload, "description")) target.description = assertText(payload.description, "description", LIMITS.DESCRIPTION_MAX);
  if (has(payload, "channels")) target.channels = assertChannels(payload.channels);

  if (!target.audience) target.audience = { reference: "", qualificationNotes: "" };
  if (has(payload, "audienceReference")) target.audience.reference = assertText(payload.audienceReference, "audienceReference", LIMITS.AUDIENCE_REF_MAX);
  if (has(payload, "qualificationNotes")) target.audience.qualificationNotes = assertText(payload.qualificationNotes, "qualificationNotes", LIMITS.QUALIFICATION_NOTES_MAX);

  if (has(payload, "contentRefs")) target.contentRefs = assertContentRefs(payload.contentRefs);

  if (has(payload, "conversionGoal")) {
    target.conversionGoal = payload.conversionGoal === null
      ? null
      : assertEnum(payload.conversionGoal, CONVERSION_GOAL_CODES, "conversionGoal", "a conversion goal");
  }
  if (has(payload, "utmCampaign")) target.utmCampaign = assertUtm(payload.utmCampaign);

  if (!target.schedule) target.schedule = { startDate: "", endDate: "" };
  if (has(payload, "startDate") || has(payload, "endDate")) {
    const schedule = assertSchedule(payload, target.schedule || {});
    target.schedule.startDate = schedule.startDate;
    target.schedule.endDate = schedule.endDate;
  }

  const budget = assertBudget(payload);
  if (budget !== undefined) target.budget = budget;

  /* After the channels, because a brief is only valid for a channel the plan uses
     and one payload may change both at once. */
  if (has(payload, "deploymentBriefs")) {
    target.deploymentBriefs = assertDeploymentBriefs(payload.deploymentBriefs, {
      channels: [...(target.channels || [])],
    });
  } else if (has(payload, "channels")) {
    /* ── A CHANNEL CHANGE CANNOT ORPHAN A BRIEF ──────────────────────────────
       Validation only ran when `deploymentBriefs` was in the payload, so removing a
       channel on its own left a brief for a channel the plan no longer uses. Two
       ways that could have been resolved, and both are wrong:

         drop the orphaned brief  →  GRAV silently deletes work a marketer typed,
                                     and they find out when readiness stops
                                     mentioning a channel they thought was set up.
         keep it                  →  the plan carries a brief nothing evaluates and
                                     nothing can deploy, and the next channel change
                                     silently resurrects it.

       So the edit is REFUSED, before any history row or projection, and the refusal
       says what to send instead. Losing somebody's work is not a decision GRAV gets
       to make on their behalf. */
    const kept = [...(target.channels || [])];
    const orphaned = (target.deploymentBriefs || [])
      .map((b) => str(b.channel))
      .filter((channel) => channel && !kept.includes(channel));

    if (orphaned.length) {
      throw fail("VALIDATION",
        `Removing ${orphaned.join(", ")} would leave ${orphaned.length === 1 ? "a brief" : "briefs"} for ${orphaned.length === 1 ? "a channel" : "channels"} the plan no longer uses. GRAV will not delete what you wrote: send the revised channel list and the revised briefs together.`,
        { field: "channels", orphanedBriefs: orphaned, accepted: ["channels", "deploymentBriefs"] });
    }
  }

  return target;
}

/* ═══ READS ═════════════════════════════════════════════════════════════════ */


function assertLimit(limit) {
  if (limit === undefined || limit === null || limit === "") return LIMITS.PAGE_DEFAULT;
  let n;
  if (typeof limit === "number") n = limit;
  else if (typeof limit === "string" && /^\d+$/.test(limit.trim())) n = Number(limit.trim());
  else {
    throw fail("VALIDATION", `limit must be a whole number between 1 and ${LIMITS.PAGE_MAX}.`,
      { field: "limit", min: 1, max: LIMITS.PAGE_MAX });
  }
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.PAGE_MAX) {
    /* Refused, not clamped: a caller paging by a size it believes it chose skips
       rows in silence. */
    throw fail("VALIDATION", `limit must be a whole number between 1 and ${LIMITS.PAGE_MAX}.`,
      { field: "limit", min: 1, max: LIMITS.PAGE_MAX });
  }
  return n;
}

/* ── HOW MANY PENDING CREATIONS THE LIST WILL DESCRIBE ──────────────────────
   Bounded, because the block is not paginated. Its `total` is the true count, so a
   reader is never misled about how many there are — only about how many are
   enumerated, and `capped` says so. A deployment with more than this many
   unfinished creations has an operational problem, not a paging problem. */
const PENDING_CREATION_LIMIT = 50;

/**
 * One page of a company's plans, plus a separate block of pending creations.
 *
 * ── PENDING CREATIONS ARE NOT IN THE ORDINARY PAGE ─────────────────────────
 * They used to be appended to `campaignDrafts` as synthetic rows built from
 * history. That broke the list contract in three ways at once: a page could exceed
 * the size the caller asked for, `page.total` disagreed with the number of real
 * plans, and the same synthetic rows reappeared on every page as the reader moved
 * through them.
 *
 * So `campaignDrafts` now holds confirmed plan documents only — filtered by the
 * requested state, paginated against those plans alone — and anything recorded but
 * not yet projected is returned under `pendingCreations`, whose scope is
 * deliberately independent of ordinary pages and which carries its own total.
 *
 * ── AND A PLAN THAT EXISTS BUT IS BEHIND IS NOT PENDING ────────────────────
 * It is an ordinary plan. It stays in `campaignDrafts` and carries `repairPending:
 * true` when it lands on the requested page. Whether a plan exists is asked of the
 * whole company, not inferred from the ids on the current page — a plan on page
 * three would otherwise look like a pending creation to page one.
 */
async function list({ companyId, state = null, limit, page = 1, env = process.env } = {}) {
  const company = assertCompany(companyId);
  const pageSize = assertLimit(limit);

  const pageNumber = (() => {
    if (page === undefined || page === null || page === "") return 1;
    const n = typeof page === "number" ? page : (/^\d+$/.test(str(page)) ? Number(str(page)) : NaN);
    if (!Number.isInteger(n) || n < 1) {
      throw fail("VALIDATION", "page must be a whole number of 1 or more.", { field: "page" });
    }
    return n;
  })();

  const wantedState = state
    ? assertEnum(state, DRAFT_STATE_CODES, "state", "a campaign plan state")
    : null;

  /* Finish any interrupted write first, so the page that follows describes the
     plans as they actually are. One extra query in the common case, no writes. */
  const repair = await reconcileCompany({ companyId: company });
  const stillPending = repair.pending || [];

  const selector = { companyId: company };
  if (wantedState) selector.state = wantedState;

  /* ── THE TOTAL DESCRIBES CONFIRMED PLANS, AND NOTHING ELSE ────────────────
     A client pages on this. Adding pending creations to it would make the count
     disagree with the rows and the last page come back short. */
  const total = await MarketingCampaignDraft.countDocuments(selector);
  const rows = await MarketingCampaignDraft.find(selector)
    .sort({ createdAt: -1, _id: -1 })
    .skip((pageNumber - 1) * pageSize)
    .limit(pageSize);

  /* Company-wide, not page-wide: a plan that exists on another page is not a
     pending creation. */
  const pendingIds = stillPending.map((p) => new mongoose.Types.ObjectId(p.draftId));
  const projected = pendingIds.length
    ? await MarketingCampaignDraft
      .find({ companyId: company, _id: { $in: pendingIds } })
      .select("_id").lean()
    : [];
  const projectedIds = new Set(projected.map((d) => String(d._id)));

  /* Behind its own history, but present. An ordinary plan with a safe flag. */
  const behind = new Set(
    stillPending.filter((p) => projectedIds.has(p.draftId)).map((p) => p.draftId),
  );

  /* ── PENDING CREATIONS: RECORDED, NOT YET A PLAN ──────────────────────────
     Built from the newest history row, because that is the only record of them. */
  const unprojected = stillPending
    .filter((p) => !projectedIds.has(p.draftId))
    .map((p) => ({ draftId: p.draftId, terminal: Boolean(p.terminal) }));

  const pendingRows = unprojected.length
    ? await MarketingCampaignDraftHistory.aggregate([
      {
        $match: {
          companyId: company,
          draftId: { $in: unprojected.map((p) => new mongoose.Types.ObjectId(p.draftId)) },
        },
      },
      { $sort: { revision: -1 } },
      { $group: { _id: "$draftId", newest: { $first: "$$ROOT" } } },
    ])
    : [];

  const terminalOf = new Map(unprojected.map((p) => [p.draftId, p.terminal]));

  /* The same state filter the ordinary page uses, against the recorded state. A
     pending creation of a draft must not appear when the caller asked for approved
     plans. */
  const pendingAll = pendingRows
    .filter((p) => !wantedState || p.newest.toState === wantedState)
    .sort((a, b) => new Date(a.newest.at) - new Date(b.newest.at));

  const pendingItems = pendingAll.slice(0, PENDING_CREATION_LIMIT).map((p) => ({
    /* The same signed identifier every other row carries, so a client has one way
       to address a plan. Never a database id. */
    campaignDraftId: identity.encodeDraftId(
      { companyId: str(company), draftId: str(p._id) }, env,
    ),
    reference: p.newest.draftRef,
    name: p.newest.resulting?.name || null,
    /* The state the recorded revision asked for. */
    state: p.newest.toState,
    createdAt: p.newest.at || null,
    /* ── WHETHER OPENING IT WILL WORK ────────────────────────────────────────
       A plan whose recorded creation can still be applied opens normally, because
       the read repairs it. One blocked by an ownership conflict does not, and a
       client needs to know before offering a link. Nothing about WHY — that is an
       operator's question and is in the server log. */
    readable: !terminalOf.get(String(p._id)),
  }));

  return {
    rows: rows.map((d) => ({
      ...present(d, { companyId: company, env }),
      /* Safe and boolean. False for every plan in the ordinary case. */
      repairPending: behind.has(String(d._id)),
    })),
    /* ── ONE STABLE SHAPE, SEPARATE FROM PAGINATION ───────────────────────────
       Returned identically on every ordinary page, because its scope is not the
       page. `total` is the true count; `items` is capped. */
    pendingCreations: {
      items: pendingItems,
      total: pendingAll.length,
      limit: PENDING_CREATION_LIMIT,
      capped: pendingAll.length > PENDING_CREATION_LIMIT,
    },
    page: {
      number: pageNumber,
      size: pageSize,
      /* Confirmed, matching plans only. */
      total,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

/**
 * The deployment readiness of one plan.
 *
 * ── A READ THAT WRITES NOTHING AND CALLS NOBODY ────────────────────────────
 * It loads the plan — which reconciles, as every read here does — hands a snapshot
 * to a pure evaluator and returns the verdict. No provider is contacted, no
 * readiness result is stored, and no deployment record is created. A readiness
 * answer is a judgement about a document at a moment, not a fact about it, and
 * persisting one would immediately be read as current truth by something.
 *
 * The revision evaluated travels with the answer, so a result held by a client
 * cannot be confused with a later revision of the same plan.
 */
async function deploymentReadiness({ companyId, campaignDraftId, env = process.env, now = new Date() } = {}) {
  const { company, draft } = await load(companyId, campaignDraftId, env);

  /* A plain snapshot, so the evaluator cannot reach a mongoose document's methods
     and cannot trigger a lazy load. */
  const snapshot = canonical(draft);

  const verdict = readiness.evaluate({ plan: snapshot, now });

  return {
    campaignDraftId: identity.encodeDraftId(
      { companyId: str(company), draftId: str(draft._id) }, env,
    ),
    reference: draft.draftRef,
    /* ── WHICH VERSION THIS VERDICT IS ABOUT ─────────────────────────────────
       A readiness answer is about one revision. Publishing it means a client can
       tell a stale result from a current one rather than assuming. */
    evaluatedRevision: draft.revision,
    planState: draft.state,
    ...verdict,
    vocabulary: readiness.vocabulary,
  };
}

/** One plan, with its history, and what the viewer may do with it. */
async function detail({ companyId, campaignDraftId, user = null, env = process.env } = {}) {
  /* `load` reconciles. */
  const { company, draft } = await load(companyId, campaignDraftId, env);

  const history = await MarketingCampaignDraftHistory
    .find({ companyId: company, draftId: draft._id })
    .sort({ revision: 1, at: 1 })
    .lean();

  return {
    draft: present(draft, { companyId: company, env }),
    viewerActions: viewerActionsFor(draft, user),
    history: history.map((h) => ({
      kind: h.kind,
      revision: h.revision,
      fromState: h.fromState || null,
      toState: h.toState,
      changedFields: h.changedFields || [],
      before: h.before || null,
      after: h.after || null,
      reason: h.reason || "",
      /* A name, not an employee record. An audit row says who acted; it is not a
         directory lookup. */
      actor: { name: h.actor?.name || "", role: h.actor?.role || "" },
      at: h.at,
    })),
  };
}

/* Served with the data so a client never hard-codes a label, a state or a
   transition. */
const vocabulary = Object.freeze({
  states: DRAFT_STATES,
  decisions: APPROVAL_DECISIONS,
  objectives: CAMPAIGN_OBJECTIVES,
  conversionGoals: CONVERSION_GOALS,
  channels: MARKETING_CHANNELS.map((c) => ({ code: c.code, label: c.label, role: c.role })),
  contentKinds: CONTENT_KINDS,
  historyKinds: HISTORY_KINDS,
  limits: LIMITS,
  /* Everything a builder needs for a Google lead form, from the one constants
     file the evaluator also reads. */
  googleLeadForm: LEAD_FORM_VOCABULARY,
  ownership: Object.freeze({
    writes: "grav_marketing",
    decides: "grav_administrator",
    /* Said out loud: Sales has no part in this. */
    salesRole: "none",
    approvalMeans: "Approval is a GRAV decision about a GRAV plan. It creates nothing in any advertising channel and commits no spending.",
  }),
});

/**
 * The stored plan, reconciled and company-scoped, for the deployment path.
 *
 * ── WHY THE DEPLOYMENT PATH DOES NOT QUERY THE COLLECTION ITSELF ───────────
 * `load` decodes the signed identifier, verifies its company against the
 * caller's, and reconciles the plan against its own history before returning
 * it. A deployment that read the collection directly would skip all three, and
 * the third matters most: an unreconciled plan can disagree with its own audit
 * trail, and creating a campaign from one would spend money against a revision
 * nobody approved.
 *
 * Returns the document, not a presented view — the mapper needs the stored
 * fields, and `present()` reshapes them for a screen.
 */
async function loadForDeployment({ companyId, campaignDraftId, env = process.env } = {}) {
  const { draft } = await load(companyId, campaignDraftId, env);
  return draft;
}

module.exports = {
  create,
  update,
  submit,
  decide,
  cancel,
  list,
  detail,
  deploymentReadiness,
  loadForDeployment,
  present,
  canonical,
  vocabulary,
  /* The repair, exported so an operator seam or a test can drive it directly.
     Both are company-scoped. */
  reconcileDraft,
  reconcileCompany,
  reconcileIdentityClaims,
  STAGES,
  /* Exported for tests, which assert the boundaries directly rather than only
     through a route. */
  __internals: {
    assertAcceptableFields, assertChannels, assertContentRefs, assertBudget,
    assertSchedule, assertUtm, assertRevision, assertTransition, assertNotSelfApproval,
    selfApprovalProblem, viewerActionsFor,
    isApprover, isAuthor, auditView, applyPayload, projectionOf, reserveHistory,
    projectHistory, actorFrom, CREATE_FIELDS, UPDATE_FIELDS,
    REFUSED_WORDS, REFUSED_NAMES, isRefusedField, words,
  },
};
