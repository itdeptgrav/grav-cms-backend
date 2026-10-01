// routes/CMS_Routes/Sales/leads.js  →  /api/cms/crm/leads
//
// Lead Chunk 1 (docs/tasks/lead-chunk-01-foundation.md), revised after review:
// `stage` and `qualificationState` are no longer two independently-editable
// state machines. Every code path that can change either field routes
// through services/leadQualification.js — see that file's header for the
// full design. The short version that matters here:
//
//   • POST / and PATCH /:id whitelist client-editable business fields (see
//     LEAD_EDITABLE_FIELDS). `stage` is NOT a free-form whitelisted field
//     anymore — a submitted `stage` is either identical to the Lead's current
//     stage (safely ignored, so the grav-cms Edit Lead modal's habit of
//     resubmitting the whole form still works when the user only changed an
//     unrelated field) or it is routed through
//     services/leadQualification.js's legacy-compatibility resolver, which
//     rejects `proposal_sent`/`negotiation`/`won` outright and maps `lost` to
//     canonical `disqualified` (reason required).
//   • PATCH /:id/stage (legacy) and PATCH /:id/qualification-state
//     (canonical) both call the SAME shared service — they are two entry
//     points into one state machine, not two.
//   • The "won ⇒ probability 100 / convertedToCustomer" side effect is
//     removed entirely. Existing records that already carry that legacy data
//     from before this chunk are untouched (no migration) — no NEW write can
//     produce it again.
//   • PATCH /:id/stage no longer appends to the embedded `lead.activities[]`
//     — its only remaining job is the state change itself, audited via
//     recordChange like everything else here.
//   • POST /:id/activity (singular, legacy) also no longer appends to the
//     embedded array — it now translates its legacy request shape
//     ({type, title, description, scheduledAt, outcome}) into a shared
//     CRMActivity record, same as the plural endpoint below. Its response
//     stays backward-compatible (`lead` is still returned; `activity` is
//     added alongside it).
//   • GET/POST /:id/activities (plural, canonical) use the shared CRMActivity
//     model with `leadId` set, and now also accept `outcome`, `nextActionDate`
//     and `activityDate` — the fields the Account-Activity router already
//     supports, previously missing here.
//
// No Account, Contact or Journey is created, read, modified, or referenced as
// a side effect anywhere in this file. The Sales Journey model/API/UI are not
// touched.
const express = require("express");
const { scopeFor: dupScopeFor } = require("../../../services/companyContext/salesScope.service");
const { createServiceContext: dupServiceContext } = require("../../../services/companyContext/serviceScope.service");

/* The service context a duplicate check runs under: this request's already
   resolved company, so "is this a duplicate?" is answered from our own
   customers and never from somebody else's. */
const dupCtx = async (req) => {
  const scope = await dupScopeFor(req);
  /* `legacyAware`, because duplicate detection has to see the records that
     predate company ownership — and the factory grants that only where the
     company master proves exactly one company, never on this caller's say-so. */
  return dupServiceContext({
    companyId: scope.companyId,
    reason: "duplicate detection",
    legacyAware: true,
  });
};
/* The same scope, for matching a Lead against real call and WhatsApp evidence.
   `identityFor` takes a service context and THROWS without one; the callers
   here passed none, so every lookup threw into their own catch and returned
   "no evidence found". Auto-sync therefore logged nothing for ANY lead —
   silently, because a swallowed throw and an empty result look identical.
   `legacyAware` for the same reason duplicate detection needs it: a call
   placed before company ownership existed still belongs to this customer. */
const evidenceCtx = async (req) => {
  const scope = await dupScopeFor(req);
  return dupServiceContext({
    companyId: scope.companyId,
    reason: "call and message evidence matching",
    legacyAware: true,
  });
};
const {
  scopedFilter: scoped, scopeFor: salesScopeFor, scopeAndOwnership,
} = require("../../../services/companyContext/salesScope.service");
const { stripCompanyOwnershipInput } = require("../../../models/CMS_Models/Sales/companyOwnership");

/* ── A LEAD'S ACCOUNT IS CHECKED, NOT ASSUMED ───────────────────────────────
 * `accountId` is an ordinary editable field, so it arrives in the PATCH body
 * like any other — and pointing it at another company's account is how a Lead
 * that is mine by ownership becomes theirs by relationship. Resolved through
 * this request's own company clause, before anything is saved, with the same
 * answer for foreign and missing. Clearing the link stays allowed. */
async function assertLeadAccountInScope(accountId, scope) {
  if (!accountId) return;
  const account = await Account.findOne({ $and: [scope.clause, { _id: accountId }] })
    .select("_id").lean();
  if (!account) {
    const err = new Error("That account was not found.");
    err.status = 404;
    throw err;
  }
}

/** A tenant refusal keeps its own status rather than becoming a generic 500. */
function answeredTenantRefusal(res, err) {
  if (err?.name !== "StorePurchaseError") return false;
  res.status(err.status).json(err.toResponse());
  return true;
}
const router = express.Router();
const Lead = require("../../../models/CMS_Models/Sales/Lead");
const Account = require("../../../models/CMS_Models/Sales/Account");
const Activity = require("../../../models/CMS_Models/Sales/Activity");
const { nextFollowUpAt } = require("../../../services/leadNextAction");
const SalesDepartment = require("../../../models/SalesDepartment");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { recordChange } = require("../../../services/changeLog");
const { createWithRef } = require("../../../services/leadRef");
const {
  LeadTransitionError,
  applyQualificationTransition,
  applyLegacyStageChange,
  resolveInitialQualification,
} = require("../../../services/leadQualification");
const { findLeadDuplicates, findAccountDuplicates, findProspectDuplicates } = require("../../../services/crmDuplicates");
const { promoteLeadContacts, ContactPromotionError } = require("../../../services/leadContactPromotion");
const Contact = require("../../../models/CMS_Models/Sales/Contact");
const { isSalesManager } = require("../../../services/salesAccess");
const {
  computeSubmissionReadiness,
  computeRequirementIdentifiedReadiness,
  computeEnquiryReadiness,
} = require("../../../services/leadReadiness");
const prospectWork = require("../../../services/prospectWorkState");

/**
 * The derived work state for a page of Prospects, in ONE extra query.
 *
 * Attached to each Draft on the way out so the card and the detail header read
 * the same computation rather than each doing their own — two screens deriving
 * "where has this got to" separately is two screens that will eventually
 * disagree, and the one people believe is whichever they looked at last.
 *
 * Active Leads are left alone: this is a Prospect concept and does not apply
 * once the record has stages of its own.
 */
async function attachProspectWorkState(leads = []) {
  const drafts = leads.filter((l) => l.captureStatus === "draft");
  if (!drafts.length) return leads;

  /* One aggregate for every id on the page — see outreachFactsFor's own note
     on why this is not a per-card query. */
  const facts = await prospectWork.outreachFactsFor(Activity, drafts.map((l) => l._id));

  for (const lead of drafts) {
    const f = facts.get(String(lead._id)) || prospectWork.NO_FACTS;
    const { readyToConfirm } = computeSubmissionReadiness(lead, {
      /* The SAME fact the conversion route checks (hasSuccessfulInteraction),
         so a card that says "Ready to convert" is one that actually converts.
         Passing the weaker attempt fact here is what made the ladder
         self-contradictory: a run of no_answer calls sat below Follow-up on
         outcome but above it on readiness, and Ready takes precedence, so a
         Prospect nobody had spoken to presented as ready to become a Lead. */
      hasSuccessfulInteraction: f.hasSuccessfulInteraction,
    });
    lead.workState = {
      ...prospectWork.workStateFrom({ ...f, readyToConfirm }),
      lastContactAt: f.lastContactAt || null,
      /* ── ONE RULE FOR WHAT THE SCREEN SHOWS ────────────────────────────
         A legacy record mid-review is genuinely in review, and that is what
         both the card and the detail header must say. Deciding this here,
         once, is what stops the two disagreeing — the card used to prefer the
         derived state while the header preferred the review status, so the
         same Prospect read "Contacting" in the queue and "In Review" when
         opened. `legacy` also tells the list which records do not belong in
         the working filters at all. */
      legacy: ["submitted", "returned", "rejected"].includes(lead.reviewStatus)
        ? lead.reviewStatus
        : null,
    };
  }
  return leads;
}

/**
 * Has the customer actually ENGAGED with this Prospect — not just been dialled?
 *
 * The one readiness fact that needs the database, kept out of the pure
 * checklist and asked here instead. Two things deliberately fail it:
 *
 *   · a PLANNED follow-up, because an intention to ring somebody is not
 *     evidence that anybody rang them; and
 *   · a completed attempt with no successful outcome — a call that rang out, an
 *     outgoing email or WhatsApp nobody replied to, a blank outcome. The
 *     product rule is that a Prospect becomes a Lead only once the customer has
 *     genuinely engaged, so "we tried" is not the bar.
 *
 * `SUCCESSFUL_CONTACT_OUTCOMES` is the CRM's own definition of that engagement,
 * already used by the qualification gate, so this is one rule and not two. The
 * UI records it without anybody having to think about it: Quick Call stamps
 * replied_connected or no_answer, incoming email and WhatsApp stamp
 * replied_connected, and the manual composer exposes the same selector.
 */
async function hasSuccessfulInteraction(leadId) {
  return Boolean(
    await Activity.exists({
      leadId,
      isActive: true,
      status: "completed",
      activityType: { $in: OUTREACH_ATTEMPT_ACTIVITY_TYPES },
      outcome: { $in: [...SUCCESSFUL_CONTACT_OUTCOMES] },
    }),
  );
}
const {
  LeadReviewError,
  applySubmit,
  applyApprove,
  applyDirectConvert,
  applyReturn,
  applyReject,
} = require("../../../services/leadReview");
const {
  ACTIVITY_TASK_TYPES,
  ACTIVITY_OUTCOME_CODES,
  ACTIVITY_CHANNEL_CODES,
  ACTIVITY_DIRECTION_CODES,
  ACTIVITY_STATUS_CODES,
  ACTIVITY_PRIORITY_CODES,
  ACTIVITY_PROGRESS_STAGE_CODES,
  ACTIVITY_RESOLUTION_CODES,
  SUCCESSFUL_CONTACT_OUTCOMES,
  OUTREACH_ATTEMPT_ACTIVITY_TYPES,
  LEAD_QUALIFICATION_STATE_CODES,
  LEAD_INACTIVE_CAPTURE_STATUSES,
  LEGACY_LEAD_STAGE_TO_QUALIFICATION,
} = require("../../../constants/crm");

// Canonical states considered "active" for the Lead Inbox's default view — the
// daily working queue only: New, Contacting, Engaged, Qualified, Ready for
// Journey. Nurture is a deliberate PAUSE (its own "history"-adjacent view —
// see HISTORY_QUALIFICATION_STATES below and qualificationState=nurture) and
// the three terminal outcomes never belong in daily work either.
const ACTIVE_QUALIFICATION_STATES = LEAD_QUALIFICATION_STATE_CODES.filter(
  (c) => !["nurture", "disqualified", "duplicate", "converted"].includes(c),
);
// The three terminal outcomes — a Lead that reached one of these has LEFT the
// working queue for good (barring an authorised manager reopening a
// Disqualified Lead, not implemented in this chunk). qualificationState=history
// is this list, exactly the same alias pattern as "active" above.
const HISTORY_QUALIFICATION_STATES = ["disqualified", "duplicate", "converted"];

const actor = (req) => ({ id: req.user?.id, name: req.user?.name || "" });
const displayName = (lead) => `${lead.firstName || ""} ${lead.lastName || ""}`.trim();

// The legacy embedded-activity `type` vocabulary (call/email/meeting/note/
// status_change/task) does not exactly match CRMActivity's ACTIVITY_TYPE_CODES
// (note/call/email_log/meeting/task/site_visit/follow_up/other) — used only
// by the legacy-shaped POST /:id/activity below to translate one into the
// other. `status_change` has no CRMActivity equivalent and maps to "other".
const LEGACY_LEAD_ACTIVITY_TYPE_TO_CRM = {
  call: "call",
  email: "email_log",
  meeting: "meeting",
  note: "note",
  status_change: "other",
  task: "task",
};

/** Send a LeadTransitionError as its own status; anything else as a plain 400. */
function sendTransitionError(res, err) {
  const status = err instanceof LeadTransitionError ? err.status : 400;
  return res.status(status).json({ success: false, message: err.message });
}

/** Same, for the Prospect review workflow (services/leadReview.js). */
function sendReviewError(res, err) {
  const status = err instanceof LeadReviewError ? err.status : 400;
  return res.status(status).json({ success: false, message: err.message });
}

// Fields a client may set directly through POST / and PATCH /:id.
// `stage` is deliberately NOT here — see the file header and the `stage`
// handling inside each handler below. Everything else outside this list —
// leadId, qualificationState, qualificationReason, conversion.*,
// convertedToCustomer/convertedCustomerId/convertedAt, createdBy/updatedBy,
// archivedAt/archivedBy, isActive, activities[], and the derived
// normalizedCompany/emailDomain/normalizedPhone/websiteDomain — is
// server-controlled and silently ignored if present in the body.
// `assignedToName`/`sourcedByName` are deliberately NOT here (Permissions
// correction) — a client can never set an employee's display name directly;
// it is always derived server-side from the resolved assignedTo/sourcedBy id
// (see resolveEmployeeName below), so the two can never drift or be spoofed.
const LEAD_EDITABLE_FIELDS = [
  "prospectType",
  "firstName", "lastName", "email", "phone", "whatsapp",
  "company", "designation", "industry", "companySize", "website",
  "source", "priority", "estimatedValue", "probability", "expectedCloseDate",
  "requirementItems", "productInterest", "estimatedQuantity", "deliveryTimeline", "requirementDate", "budget", "requirements",
  "requirementCertainty",
  /* Lead form redesign chunk 1. `requirementUseCase` is the programme a
     requirement belongs to; `budgetStatus` and `keyObjection` are the Buying
     Process facts that had nowhere to go. All optional, none gating. */
  "requirementUseCase", "budgetStatus", "keyObjection",
  "assignedTo", "sourcedBy",
  "city", "state", "country",
  "nextFollowUpAt", "notes", "tags",
  "accountId",
  "requirementReceivedAt",
  // Draft workspace sections §3–§8 (Draft Lead chunk). `captureStatus`,
  // `draftArchivedAt/By` and `duplicateReviewedAt` are deliberately NOT here
  // — those are system-controlled, changed only by the dedicated endpoints
  // below (activate / archive-draft / review-duplicates), never by a generic
  // PATCH.
  "organisationNotes",
  "pursuitJustification",
  "customerPotential", "estimatedWearerCount",
  "estimatedAnnualQuantity", "estimatedAnnualQuantityConfidence",
  "estimatedAnnualRevenue", "estimatedAnnualRevenueConfidence",
  "estimatedUnitPrice", "estimatedUnitPriceConfidence",
  "estimatedAnnualQuantitySource", "estimatedAnnualRevenueSource", "estimatedUnitPriceSource",
  "decisionMakerName", "decisionMakerRole", "procurementProcess", "existingSupplier",
  "contacts",
  "researchNotes", "evidenceLinks", "evidence",
  "pendingFirstAction",
  /* ── THE INTEREST, BUT NOT ITS ATTESTATION ────────────────────────────────
     `interestSignal` and `interestNote` are the salesperson's own observation
     and are theirs to set or correct at any time — including through the HOD
     review path, which reaches readiness through PATCH rather than through the
     conversion dialog.

     `interestConfirmedBy` and `interestConfirmedAt` are deliberately ABSENT
     and stay server-set. Who vouched for this, and when, is the one part a
     client must never be able to write: a self-declared confirmation is not a
     confirmation, and this is exactly the field somebody gets asked about
     later. */
  "interestSignal",
  "interestNote",
  /* Source specifics and the early "what might they need" observation. Plain
     optional strings; none of them gates anything. `assignedTo` is NOT added
     here — ownership stays server-derived, and `assignedToName` is already
     excluded above for the same reason. */
  "sourceDetails",
  "referredBy",
  "campaignOrEvent",
  "possibleNeed",
  /* The factual Prospect context (see the Lead model's own note): what kind of
     buyer, how and when to reach them, and a broad guess at what they might
     want. All optional, none of them a gate, and all editable later on the
     Lead — this is the same record, so there is nothing to carry across. */
  "businessType",
  "preferredContactMethod",
  "bestContactTime",
  "contactTimeNote",
  "preferredLanguage",
  "productInterests",
];

/**
 * Sanitise an incoming `contacts` array (Chunk B) — the whole list is replaced
 * on each save (the section-save pattern the frontend already uses), so the
 * client is never trusted to preserve subdocument ids: nameless entries are
 * dropped, only the known fields survive, and the list is capped. `_id` is NOT
 * taken from the client (no mongoose import here, and a "replace the list"
 * model doesn't need it) — Mongoose assigns fresh ids and the client re-reads
 * them after the save.
 */
/* ── THE PEOPLE ON A PROSPECT, AS THE SERVER WILL ACCEPT THEM ───────────────
   Two jobs, and the second is the one that was missing.

   1. AN ALLOWLIST. A client cannot post `normalizedEmail`, `normalizedPhone`,
      `normalizedWhatsapp` or `promotedContactId`. Those are derived (the Lead
      model's hook) or server-set at Account promotion; a client-supplied
      normalised value is a client-supplied duplicate-match result.

   2. STABLE IDENTITY. The first version dropped every `_id` and handed
      Mongoose a fresh array, so each save minted new ids for the same people.
      That breaks everything the design depends on: a future
      `Activity.leadContactId` would dangle, a `promotedContactId` would detach
      from its person, and per-contact history would reset on every edit — an
      ordinary rename made all four contacts look newly created.

      So an existing `_id` is RESOLVED against this Lead's current contacts,
      never trusted. One that belongs to another Lead, or to nobody, is
      refused rather than quietly replaced — a client sending it has a bug, and
      silently minting a new id hides it. A resolved row keeps its id and its
      server-controlled `promotedContactId`.

   Malformed input is refused, never absorbed. A non-array used to become `[]`,
   which deleted every contact and returned 200; an oversized list was sliced;
   a row with no name vanished. Same principle as `productInterests`: silent
   data loss with a success response is the worst of both.

   Enum codes pass through VERBATIM so Mongoose refuses an invalid one with a
   visible 400. Empty strings become undefined so "not chosen" clears. */
const MAX_CONTACTS = 25;
const contactEnum = (v) => (String(v ?? "").trim() || undefined);
const contactText = (v) => (String(v ?? "").trim() || undefined);
const badContacts = (message) => Object.assign(new Error(message), { status: 400 });

/* ── ATTRIBUTION, AS PURE FUNCTIONS ─────────────────────────────────────────
   Auto-sync's matching lived inside the route closure, where the only way to
   test it was to stand up Gmail, a CallEvent log and a WhatsApp conversation.
   Two real bugs hid there for exactly that reason: a "unique" email match that
   returned the first address hitting anybody, and a message body read from a
   field nobody had selected.

   Lifted here and exported at the bottom of this file so each rule can be
   exercised on its own. Nothing about the behaviour changed in the move. */

/** `Name <a@b.com>, c@d.com` → ["a@b.com", "c@d.com"]. That header shape is
 *  ordinary, and comparing it whole never matches. */
function parseEmailAddresses(header) {
  return String(header || "")
    .split(",")
    .map((part) => {
      const angled = part.match(/<([^>]+)>/);
      return String(angled ? angled[1] : part).trim().toLowerCase();
    })
    .filter((a) => a.includes("@"));
}

const phoneTail = (v) => { const d = String(v ?? "").replace(/\D+/g, ""); return d.length > 10 ? d.slice(-10) : d; };

/**
 * The one contact an identity belongs to — or nothing.
 *
 * `hits.length === 1` is the whole rule. Two people on a shared desk line or a
 * purchasing@ mailbox is not a near-miss to be broken by picking the first; it
 * is a genuine "we cannot tell", and the Activity stays at Lead level where it
 * is still true.
 */
function matchContacts(contacts = [], { phone, email } = {}) {
  if (!contacts.length) return [];
  const tail = phoneTail(phone);
  if (tail) {
    const byPhone = contacts.filter((c) => [c.normalizedPhone, c.normalizedWhatsapp, c.phone, c.whatsapp]
      .some((v) => v && phoneTail(v) === tail));
    if (byPhone.length) return byPhone;
  }
  const mail = String(email || "").trim().toLowerCase();
  if (mail) {
    return contacts.filter((c) => String(c.normalizedEmail || c.email || "").toLowerCase() === mail);
  }
  return [];
}

function contactByIdentity(contacts = [], identity = {}) {
  const hits = matchContacts(contacts, identity);
  return hits.length === 1 ? { leadContactId: hits[0]._id, contactName: hits[0].name } : {};
}

/**
 * The one contact an email belongs to, across EVERY relevant address.
 *
 * This returned the first address that matched anybody, so a mail addressed to
 * the merchandiser AND the purchase manager was filed under whichever appeared
 * first in the header — a guess wearing a uniqueness check. Distinct contacts
 * are collected across all of them and attribution happens only when there is
 * exactly one. The salesperson's own connected address is excluded, or every
 * outbound mail would be filed under the sender.
 */
function contactByEmailAddresses(contacts = [], addresses = [], excludeEmail = null) {
  const mine = String(excludeEmail || "").trim().toLowerCase();
  const found = new Map();
  for (const addr of addresses) {
    if (!addr || addr === mine) continue;
    const hit = contactByIdentity(contacts, { email: addr });
    if (hit.leadContactId) found.set(String(hit.leadContactId), hit);
  }
  return found.size === 1 ? [...found.values()][0] : {};
}

/** A WhatsApp message's readable content: its text, a media caption, or — for
 *  a photo or document with neither — what it was. */
function whatsappBody(m) {
  return String(m?.text || m?.media?.caption || "").trim()
    || (m?.type && m.type !== "text" ? `[${m.type}]` : "");
}

/**
 * Resolve `leadContactId` against a Lead's own people.
 *
 * The id names a person INSIDE this Lead. One from another Lead would attach
 * somebody else's identity to this history, and one from nowhere would leave a
 * dangling reference that reads as a real person until you follow it — so both
 * are refused rather than dropped.
 *
 * `contactName` is derived here, never taken from the client. It is a snapshot
 * of what the person was called at the time, and a client that sends a name
 * contradicting the id it also sent is either stale or wrong; either way the
 * server's copy of the record is the one to believe.
 *
 * @returns {{leadContactId, contactName}} — empty when no id was supplied,
 *          which is legitimate: legacy history has none, and a general note is
 *          about the record rather than a person.
 */
function resolveLeadContact(lead, rawId, fallbackName) {
  if (rawId === undefined || rawId === null || rawId === "") {
    return { contactName: fallbackName };
  }
  const match = (lead.contacts || []).find((c) => String(c._id) === String(rawId));
  if (!match) {
    throw Object.assign(new Error("That contact is not on this Lead."), { status: 400 });
  }
  return { leadContactId: match._id, contactName: match.name };
}

async function resolveContacts(value, existing = [], prospectType = "company", lead = null) {
  if (!Array.isArray(value)) {
    throw badContacts("Contacts must be a list. Send an empty list to remove them all.");
  }
  if (value.length > MAX_CONTACTS) {
    throw badContacts(`A Prospect can hold at most ${MAX_CONTACTS} contacts — this request had ${value.length}.`);
  }

  const byId = new Map((existing || []).map((c) => [String(c._id), c]));
  const seen = new Set();

  const rows = value.map((c, i) => {
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      throw badContacts(`Contact ${i + 1} is not a contact.`);
    }
    if (!String(c.name || "").trim()) {
      throw badContacts(`Contact ${i + 1} needs a name.`);
    }

    /* An id is a claim about which person this row IS. Resolved, not trusted:
       one from another Lead would import a stranger's identity into this
       record, and one from nowhere is a client bug worth surfacing. */
    let kept = null;
    if (c._id !== undefined && c._id !== null && c._id !== "") {
      kept = byId.get(String(c._id));
      if (!kept) throw badContacts(`Contact ${i + 1} refers to a person who is not on this Prospect.`);
      if (seen.has(String(c._id))) throw badContacts(`Contact ${i + 1} is listed twice.`);
      seen.add(String(c._id));
    }

    return {
      ...(kept ? { _id: kept._id } : {}),
      name: String(c.name).trim(),
      jobTitle: contactText(c.jobTitle),
      department: contactText(c.department),
      roleCode: contactEnum(c.roleCode),
      /* LEGACY, retained verbatim: free-text role and the decision-maker flag
         the readiness gate already reads. Never reinterpreted as `roleCode`. */
      role: contactText(c.role),
      isDecisionMaker: Boolean(c.isDecisionMaker),
      email: String(c.email || "").trim().toLowerCase() || undefined,
      phone: contactText(c.phone),
      whatsapp: contactText(c.whatsapp),
      preferredChannel: contactEnum(c.preferredChannel),
      bestContactTime: contactEnum(c.bestContactTime),
      contactTimeNote: contactText(c.contactTimeNote),
      preferredLanguage: contactText(c.preferredLanguage),
      isPrimary: Boolean(c.isPrimary),
      status: contactEnum(c.status) || "active",
      notes: contactText(c.notes),
      /* Server-controlled, carried across an edit rather than re-sent. */
      ...(kept?.promotedContactId ? { promotedContactId: kept.promotedContactId } : {}),
    };
  });

  /* ── LOSING A PRIMARY IS A DECISION, NOT A SIDE EFFECT ─────────────────
     The model settles the one unambiguous case (a single active contact with
     nothing marked). Everything else it refuses. This adds the rule the model
     cannot see, because it needs the PREVIOUS state: once a Prospect has an
     active primary, every later save must say who the primary is. Removing or
     deactivating that person without naming a replacement is refused, rather
     than promoting whoever happens to sit first in the array. */
  /* Checked BEFORE the primary rules so the message names the real blocker.
     An Individual handed several people has a type problem, not a primary
     problem, and being told to "mark which contact is primary" would send
     somebody looking for the wrong fix. The model asserts this too — this is
     here for the wording, not the safety. */
  if (prospectType === "individual" && rows.length > 1) {
    throw badContacts(
      "An Individual Prospect can have only one contact — that person IS the prospect. Change its type to Organisation to record several people.",
    );
  }

  const priorPrimary = (existing || []).find((c) => c.isPrimary && c.status === "active");
  const marked = rows.filter((r) => r.isPrimary && r.status === "active");
  const active = rows.filter((r) => r.status === "active");
  if (priorPrimary && marked.length === 0 && active.length > 0) {
    /* Only when that person has actually GONE — removed from the list, or
       deactivated. A primary who is still present and active simply stays
       primary; the model settles that, and refuses if it is ambiguous. */
    const stillActive = rows.some((r) => String(r._id || "") === String(priorPrimary._id) && r.status === "active");
    if (!stillActive) {
      throw badContacts("Mark which contact is now the primary — this Prospect's primary contact was removed or deactivated.");
    }
  }

  /* ── HISTORY OUTLIVES THE PERSON ──────────────────────────────────────
     Once an Activity or the current next action can name an embedded contact,
     deleting that contact leaves a reference to nobody — a call in the
     timeline whose "who" resolves to nothing, and a planned follow-up aimed at
     a person the record no longer has.

     Somebody who has left, or asked not to be contacted, is a fact about the
     relationship, not a row to tidy away. So a referenced contact is kept and
     the status is the way to retire them; only somebody with no history at all
     can be removed outright. Scoped by leadId, so this asks about THIS Lead's
     history and no one else's. */
  if (lead) {
    const kept = new Set(rows.map((r) => String(r._id || "")));
    const dropped = (existing || []).filter((c) => !kept.has(String(c._id)));
    for (const gone of dropped) {
      /* Deliberately NOT filtered to `isActive` — a soft-deleted Activity
         still holds this contact's id, and removing the person would leave
         that reference pointing at nobody. An inactive Activity is hidden
         history, not disposable history. */
      const referenced = await Activity.exists({ leadId: lead._id, leadContactId: gone._id });
      const isTarget = String(lead.pendingFirstAction?.leadContactId || "") === String(gone._id);
      if (referenced || isTarget) {
        throw badContacts(
          `"${gone.name}" has history on this record${isTarget ? " and is the target of the current next action" : ""}. Mark them "Left organisation" or "Do not contact" instead of removing them.`,
        );
      }
    }
  }

  return rows;
}
// `reviewStatus`, `pursuitJustification` aside, and all the review audit
// fields (submittedAt/By, reviewedAt/By, reviewReason) are NOT editable via a
// generic PATCH — reviewStatus is written only by services/leadReview.js
// through the dedicated submit/approve/return/reject endpoints below, the
// same single-writer discipline captureStatus/qualificationState already have.

// Enum fields the UI can clear back to "unset" ("Not sure yet" / "Unknown").
// An empty string is NOT a valid enum value, so storing "" both fails schema
// validation AND never truly clears the field — the readiness checks (e.g.
// "Lead source recorded", "Customer segment") would keep passing on a value
// nobody chose. Normalising "" to `undefined` makes Mongoose $unset the path on
// save, so the value is genuinely gone and the check flips back to unmet.
const CLEARABLE_ENUM_FIELDS = [
  "source", "industry", "companySize", "customerPotential", "requirementCertainty",
  /* Same reason as `priority` below: "No preference" / "Not sure yet" must
     genuinely unset the field, not be refused by the enum. */
  "businessType", "preferredContactMethod", "bestContactTime",
  "estimatedAnnualQuantityConfidence", "estimatedAnnualRevenueConfidence",
  "estimatedUnitPriceConfidence",
  /* "Not discussed yet" must genuinely unset the field rather than be refused
     by the enum — the same rule every other optional select here follows. */
  "budgetStatus",
  /* So "Not set" in the Prospect form actually unsets it. Without this the
     empty string reached the enum and was refused, which made the only way to
     leave a priority blank never to have touched the control. */
  "priority",
];

/* ── HOW A NUMBER OR A DATE IS CLEARED ──────────────────────────────────────
   `crmApi` serialises with JSON.stringify, which DROPS a property whose value
   is `undefined`. Several form handlers used `undefined` to mean "clear this",
   so the field never reached the server, the PATCH said nothing about it, and
   the old value survived — a delete that reported success and changed nothing.

   `null` survives serialisation, so that is what "clear" is on the wire. Here
   it becomes `undefined` on the document, which is what actually unsets the
   path in Mongoose. Restricted to a named list: `null` on a field not listed
   below keeps its literal meaning rather than being silently reinterpreted. */
const CLEARABLE_VALUE_FIELDS = [
  "estimatedQuantity", "requirementDate", "expectedCloseDate", "requirementReceivedAt",
  "nextFollowUpAt",
  "estimatedAnnualQuantity", "estimatedAnnualRevenue", "estimatedUnitPrice",
  "estimatedAnnualQuantitySource", "estimatedAnnualRevenueSource", "estimatedUnitPriceSource",
  "estimatedValue", "probability", "budget",
  "keyObjection", "requirementUseCase",
];

function pickEditable(body = {}) {
  const out = {};
  for (const key of LEAD_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  for (const key of CLEARABLE_ENUM_FIELDS) {
    if (out[key] === "") out[key] = undefined;
  }
  for (const key of CLEARABLE_VALUE_FIELDS) {
    if (out[key] === null || out[key] === "") out[key] = undefined;
  }
  /* `contacts` is NOT sanitised here: resolving an `_id` needs the Lead's
     current contacts, which this pure function does not have. Both call sites
     handle it against the record they already loaded. */
  /* ── A MULTI-SELECT MUST NOT BE ABLE TO DELETE WHAT IT CANNOT READ ──────
     This turned anything that was not an array into `[]` and returned 200, so
     a malformed request — a client sending a bare string, a serialisation bug
     — silently wiped a saved list and reported success. Silent data loss with
     a success response is the worst of both: nothing to notice, nothing to
     retry. A malformed value is now refused, and the stored value is left
     exactly as it was.

     An explicit `[]` remains the way to clear the field: saying "none" and
     failing to say anything intelligible are different acts.

     Entries are trimmed, de-duplicated and capped so a client cannot post a
     thousand of them. Unknown CODES are left for the schema enum to refuse
     rather than silently dropped — a rejected save is visible, a silently
     discarded value is not. */
  if (Object.prototype.hasOwnProperty.call(out, "productInterests")) {
    if (!Array.isArray(out.productInterests)) {
      throw Object.assign(new Error("Product interests must be a list."), { status: 400 });
    }
    const list = [...new Set(
      out.productInterests.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean),
    )].slice(0, 20);
    /* ── "NOT KNOWN YET" IS AN ANSWER, NOT AN EXTRA OPTION ────────────────
       `["not_known", "uniforms"]` says both "we have no idea" and "we think
       it's uniforms". The UI makes the choice exclusive; this is the same rule
       enforced against every other client, because an invariant the server
       does not hold is a convention, not an invariant. */
    if (list.includes("not_known") && list.length > 1) {
      throw Object.assign(
        new Error('"Not known yet" cannot be combined with a specific product interest.'),
        { status: 400 },
      );
    }
    out.productInterests = list;
  }
  for (const key of ["contactTimeNote", "preferredLanguage"]) {
    if (typeof out[key] === "string") out[key] = out[key].trim();
  }
  return out;
}

// Permissions correction: the display name for assignedTo/sourcedBy is NEVER
// trusted from the client — it is always looked up server-side, either from
// the authenticated caller (the common "assigned to me" case, no DB hit) or
// from SalesDepartment (the manager-reassignment case).
async function resolveEmployeeName(employeeId, req) {
  if (!employeeId) return undefined;
  if (String(employeeId) === String(req.user?.id || "")) return req.user?.name;
  const employee = await SalesDepartment.findById(employeeId).select("name").lean();
  return employee?.name;
}

// Permissions correction: only a Sales manager may set assignedTo/sourcedBy
// to anyone OTHER than the caller themselves (including blanking it out —
// unassigning is still a reassignment away from whoever holds it now). An
// ordinary salesperson may only ever (re)confirm themselves, or leave the
// field untouched entirely, matching the frontend's own `canAssignOwner`
// gate (app/sales/dashboard/leads) — this is that gate's server-side backstop.
async function authorizeOwnerSourceChange(req, data) {
  const settingAssignedTo = Object.prototype.hasOwnProperty.call(data, "assignedTo");
  const settingSourcedBy = Object.prototype.hasOwnProperty.call(data, "sourcedBy");
  if (!settingAssignedTo && !settingSourcedBy) return true;
  const selfId = String(req.user?.id || "");
  const assignedToIsSelf = !settingAssignedTo || String(data.assignedTo || "") === selfId;
  const sourcedByIsSelf = !settingSourcedBy || String(data.sourcedBy || "") === selfId;
  if (assignedToIsSelf && sourcedByIsSelf) return true;
  return isSalesManager(req.user);
}

/* ── Real, unfalsifiable contact evidence ────────────────────────────────────
   Added 27 Aug 2026 on explicit request: the Contacting / Contacted gates were
   satisfied ONLY by a CRM Activity, which is a salesperson typing "I called
   them". These read the actual channel records instead — the device call log
   and the Meta WhatsApp thread — so the stage reflects what demonstrably
   happened, not what somebody said happened.

   BOTH SOURCES ARE IN MONGO, so this stays a couple of cheap indexed queries on
   a transition that already does several. Gmail is deliberately NOT consulted
   here: those messages live in the salesperson's own mailbox behind their
   personal OAuth token, which this server-side transition has no access to (and
   reaching out to Google mid-transition would make advancing a lead depend on a
   third-party API being up). Email evidence still counts — the Leads workspace
   surfaces it and one tap logs it as an Activity, which the gate above already
   accepts.

   Every lookup is wrapped: a matching failure must never block a legitimate
   transition, so evidence that cannot be read is treated as absent, and the
   logged-Activity path still stands. */

/**
 * Is this lead's phone genuinely THEIRS, or could a matched call/message
 * actually belong to a different lead that happens to share the number?
 *
 * 28 Aug 2026, explicit report with a real example: a lead's own email was
 * found to be shared by THREE different Leads in this database (a dev-data
 * artifact, but the ambiguity it exposes is a real one — the same failure
 * mode would occur with a shared company switchboard number in production).
 * Automatic evidence matched on a number/address that more than one lead
 * claims cannot honestly be credited to any single one of them; it could be a
 * call to the OTHER lead.
 *
 * Reuses findLeadDuplicates (services/crmDuplicates.js) rather than a second
 * matching implementation — it already computes exactly this ("does another
 * active Lead share this email/phone") for the duplicate-review flow, so this
 * is one fewer place the rule could drift.
 *
 * Fails CLOSED: a lookup error is treated as ambiguous (evidence suppressed),
 * not as clear. The failure mode of wrongly WITHHOLDING a real gate credit is
 * "log it by hand" — mildly annoying. The failure mode of wrongly GRANTING one
 * is a stage advanced on someone else's contact record — which is the exact
 * bug being fixed here.
 */
/* `req` is a REQUIRED argument, not an optional one: without it `dupCtx`
   cannot resolve the company scope, the resulting throw is swallowed by the
   catch below, and every channel comes back ambiguous — which silently
   disables auto-sync instead of failing loudly. It was referenced in the body
   without ever being a parameter until 5 Sep 2026, so the catch was the only
   branch that ever ran. */
async function ambiguousContactChannels(lead, req) {
  try {
    const matches = await findLeadDuplicates(
      Lead, await dupCtx(req),
      { company: lead.company, email: lead.email, phone: lead.phone, website: lead.website },
      lead._id,
    );
    return {
      email: matches.some((m) => m.matchedOn.includes("email")),
      phone: matches.some((m) => m.matchedOn.includes("phone")),
    };
  } catch (e) {
    console.error("[leads] ambiguity check failed:", e.message);
    return { email: true, phone: true };
  }
}

/**
 * Which IDENTITIES on this Lead also belong to some other Lead in the company.
 *
 * ── AN IDENTITY, NOT A PERSON ──────────────────────────────────────────────
 * The first version returned contact IDS, which is too coarse to be correct. A
 * purchase manager with a generic `purchasing@acme.com` on file and their own
 * direct line would have the whole CONTACT marked shared — and their unique
 * phone calls silently skipped along with the shared mailbox. One duplicated
 * address should cost you that address, not the person.
 *
 * So the unit is the normalised identity string: a phone tail, or an email.
 * A shared email cannot suppress a unique phone call to the same human, and a
 * shared phone cannot suppress their unique email.
 *
 * Returns a Set of those identity strings. Skipping is per event, decided by
 * whichever identity that event actually arrived on.
 *
 * Company-scoped like every other lookup here. The check reads both the
 * derived `normalized*` fields and the RAW ones, because a record that has not
 * been saved since `normalizedWhatsapp` was added has no derived value yet —
 * and a safety check that only protects records somebody has edited protects
 * nothing.
 *
 * This is the safety check auto-sync needs. The full cross-record duplicate
 * story is its own chunk; nothing here resolves or merges anything.
 */
const identityKey = (kind, value) => `${kind}:${value}`;

async function ambiguousContactIdentities(lead, req) {
  const shared = new Set();
  const list = (lead.contacts || []).filter((c) => c._id);
  if (!list.length) return shared;

  /* Every distinct identity this Lead's people carry, with the contacts that
     hold it — one lookup per identity, not per contact. */
  const identities = new Map();
  const add = (kind, raw) => {
    const value = kind === "email"
      ? String(raw || "").trim().toLowerCase()
      : phoneTail(raw);
    if (!value || (kind !== "email" && value.length !== 10)) return;
    identities.set(identityKey(kind, value), { kind, value });
  };
  for (const c of list) {
    add("phone", c.normalizedPhone || c.phone);
    add("phone", c.normalizedWhatsapp || c.whatsapp);
    add("email", c.normalizedEmail || c.email);
  }
  if (!identities.size) return shared;

  try {
    const scope = await scoped(req, {});
    for (const [key, { kind, value }] of identities) {
      let or;
      if (kind === "email") {
        or = [{ email: value }, { "contacts.normalizedEmail": value }, { "contacts.email": value }];
      } else {
        const re = new RegExp(`${value}$`);
        /* ── THE RAW FIELDS HOLD REAL PHONE NUMBERS ──────────────────────
           Derived AND raw, on both the record and its contacts. `whatsapp` has
           only just gained a normalised form, so an existing row is reachable
           only through the raw value — and a safety check that protects only
           records somebody has since edited protects nothing.

           The raw pattern has to tolerate separators: "+91 98000 00000" does
           not end with "9800000000". Digits interleaved with `\D*` matches the
           number however it was typed. Unindexed and deliberately narrow — one
           company scope, during auto-sync, per distinct identity — with the
           derived fields carrying the indexed load wherever they exist. */
        const loose = new RegExp(`${value.split("").join("\\D*")}$`);
        or = [
          { normalizedPhone: re }, { normalizedWhatsapp: re },
          { phone: loose }, { whatsapp: loose },
          { "contacts.normalizedPhone": re }, { "contacts.normalizedWhatsapp": re },
          { "contacts.phone": loose }, { "contacts.whatsapp": loose },
        ];
      }
      const other = await Lead.exists({ $and: [scope, { _id: { $ne: lead._id }, isActive: true, $or: or }] });
      if (other) shared.add(key);
    }
  } catch (e) {
    /* Unable to prove uniqueness is not the same as proving it — fail closed
       and skip attribution rather than guess. */
    console.error("[leads] contact ambiguity check failed:", e.message);
    return new Set(identities.keys());
  }
  return shared;
}

/** Every CallEvent that matches this lead's numbers/names. */
async function matchedCallEvents(lead, req) {
  try {
    const { identityFor } = require("../../../services/customerIdentityLookup.service");
    const { buildRecordingFilter } = require("../../../services/callRecordingMatch.service");
    const CallEvent = require("../../../models/CallEvent");
    const identity = await identityFor({ leadId: lead._id }, await evidenceCtx(req));
    if (!identity) return [];
    const filter = buildRecordingFilter(identity);
    if (!filter) return [];
    /* ── SELECT WHAT THE CALLER ACTUALLY READS ──────────────────────────
       Auto-sync reads `phoneNumber` (to attribute the call to a person) and
       `contactName`; neither was selected, so per-contact attribution could
       never match and the device's own label was always lost.

       `hasRecording` is a VIRTUAL, and `.lean()` strips virtuals — so the
       recording branch of the description was dead. `driveFileId` is the field
       the virtual reads; the caller derives it from that. */
    return await CallEvent.find(filter)
      .select("received rejected startTime durationSec driveFileId direction phoneNumber contactName")
      .lean();
  } catch (e) {
    console.error("[leads] call evidence lookup failed:", e.message);
    return [];
  }
}

/** The WhatsApp conversation for this lead's number, if there is one. */
async function matchedWhatsAppMessages(lead, req) {
  try {
    const WhatsAppConversation = require("../../../models/CMS_Models/Sales/WhatsAppConversation");
    const { WhatsAppMessage } = require("../../../models/CMS_Models/Sales/WhatsAppMessage");
    /* A contact's WhatsApp number counts too — it is the number messages
       actually arrive on, and reading only `c.phone` missed anybody whose
       WhatsApp differs from their phone. */
    const tails = [lead.phone, lead.whatsapp, ...((lead.contacts || []).flatMap((c) => [c.phone, c.whatsapp]))]
      .map((p) => String(p || "").replace(/\D/g, "").slice(-10))
      .filter((t) => t.length === 10);
    if (!tails.length) return [];
    /* ── EVERY MATCHING CONVERSATION, NOT THE FIRST ─────────────────────
       `findOne` returned one thread, so a Prospect whose merchandiser and
       purchase manager each have their own WhatsApp showed only one of them —
       and which one depended on insertion order. `find` returns them all, and
       ONE message query covers the lot rather than one per contact. */
    const convs = await WhatsAppConversation.find({
      waId: { $in: [...new Set(tails)].map((t) => new RegExp(`${t}$`)) },
    }).select("_id waId").lean();
    if (!convs.length) return [];
    const waById = new Map(convs.map((c) => [String(c._id), c.waId]));
    const rows = await WhatsAppMessage.find({ conversationId: { $in: convs.map((c) => c._id) } })
      /* `text` is read by the auto-sync description and was not selected, so
         every auto-logged WhatsApp lost its message body — the third time in
         this chunk that a field was read but never fetched. `type` and
         `media.caption` keep the context for a photo or document, which a bare
         "WhatsApp message" line would throw away. */
      .select("direction timestamp conversationId text type media.caption").lean();
    /* The number lives on the CONVERSATION, not on each message — carried here
       rather than looked for on a field the message does not have. Without it
       per-contact attribution silently never matches. */
    return rows.map((m) => ({ ...m, waId: waById.get(String(m.conversationId)) }));
  } catch (e) {
    console.error("[leads] whatsapp evidence lookup failed:", e.message);
    return [];
  }
}

// Lead correction chunk — the per-target facts services/leadQualification.js
// needs but cannot look up itself (it stays pure/DB-free by design). Only
// queries what the specific target actually requires.
async function computeTransitionContext(lead, targetState, body = {}, req) {
  const context = {};
  /* ── THE CONTACT GATES ARE NOT ASKED ANY MORE ──────────────────────────
     Two blocks here resolved "was an outreach attempt logged?" and "was there
     a successful two-way contact?" for the Contacting and Engaged moves. Both
     states are legacy-only now: nothing in the transition graph targets them,
     so these queries ran only for requests the service was about to refuse.

     The proof itself has not been dropped — it moved earlier. A Prospect only
     becomes a Lead on a successful interaction with a confirmed interest
     signal, so by the time a record is here that question is answered. The
     Their two evidence helpers went with them — they had no other caller, and
     an unused helper that reads like a live rule is how the next person
     re-derives a rule nobody enforces. `matchedCallEvents`,
     `matchedWhatsAppMessages` and `ambiguousContactChannels` stay: Prospect
     outreach reads all three. */
  if (targetState === "duplicate" && body.duplicateOf?.id) {
    const type = body.duplicateOf.type === "account" ? "account" : "lead";
    const Model = type === "account" ? Account : Lead;
    const exists = await Model.exists({ _id: body.duplicateOf.id, isActive: true });
    context.duplicateTarget = exists ? { type, id: body.duplicateOf.id } : null;
  }
  return context;
}

// "Restricted" capture statuses share one visibility rule: a Lead in either
// of them is "visible to its creator, assigned owner and authorised managers
// only" (Draft Lead chunk — extended so an ARCHIVED draft is exactly as
// private as a live one, never leaking to the wider team just because it was
// disposed). Active Leads (and legacy records with no captureStatus) are
// unaffected — the checks below run ONLY when isRestricted(lead) is true.
const isRestricted = (lead) => LEAD_INACTIVE_CAPTURE_STATUSES.includes(lead.captureStatus);

// `lead.assignedTo` may be a bare id or a populated {_id,...} (GET /:id
// populates it) — both are handled.
function isMineOrAssigned(lead, userId) {
  const assignedId = lead.assignedTo?._id || lead.assignedTo;
  return String(lead.createdBy?.id || "") === String(userId || "") ||
    (assignedId && String(assignedId) === String(userId || ""));
}

async function canSeeRestricted(lead, req) {
  if (isMineOrAssigned(lead, req.user?.id)) return true;
  return isSalesManager(req.user);
}

// A Lead is READ-ONLY (no generic edits, activities, qualification changes,
// or archiving) in two states:
//   • archived — a disposed Prospect / soft-deleted Lead.
//   • submitted — a Prospect awaiting HOD review: "Submitted Prospects become
//     read-only for the salesperson until reviewed." The HOD doesn't edit
//     fields either — they act through approve/return/reject — so submitted
//     is read-only for EVERYONE at the field level.
// Returns true (and answers with 409) when the mutation should be refused, so
// a handler can early-return. 409 Conflict — the request is valid but
// conflicts with the Lead's current state — rather than 400 (nothing about
// the request is malformed) or 403 (it isn't a permission problem). The
// dedicated review endpoints (submit/approve/return/reject) do NOT call this —
// they manage reviewStatus themselves.
function refuseIfLocked(res, lead) {
  if (lead.captureStatus === "archived") {
    res.status(409).json({ success: false, message: "This Prospect is archived and read-only." });
    return true;
  }
  if (lead.reviewStatus === "submitted") {
    res.status(409).json({ success: false, message: "This Prospect is submitted for HOD review and can't be edited until it's reviewed." });
    return true;
  }
  return false;
}

// GET /api/cms/crm/leads — list with filters + pipeline stats
//
// Chunk 2 (Lead Inbox) additions, both additive/opt-in — omitting either
// leaves every existing caller's behaviour unchanged:
//   • `scope=mine` — server-resolves to the authenticated user's own id,
//     the same convention salesJourneys.js uses (`?scope=mine`). A
//     client-supplied `assignedTo` cannot widen or impersonate this; scope
//     wins when both are present.
//   • `qualificationState=<code>|active|history|all` — `active` (the Inbox's
//     default) is the daily working queue only (see ACTIVE_QUALIFICATION_
//     STATES: excludes nurture and all three terminal outcomes); `history`
//     is the three terminal outcomes (converted/disqualified/duplicate),
//     with `conversion.journeyId` populated so a Converted row can link
//     straight to its Journey; a specific canonical code (including
//     `nurture`) matches exactly; `all`/omitted applies no filter.
//
// Draft Lead chunk addition — `captureStatus=draft|active|archived|all`:
//   • Omitted or unrecognized => "active" (matches "active" or a pre-chunk
//     record with no captureStatus at all). This is the SAFE default: a
//     caller that doesn't know this param exists can never "accidentally
//     include Drafts" in what reads as the ordinary Lead list.
//   • "archived" or "all" is downgraded to "active" for anyone who isn't a
//     Sales manager (admin/ceo, or approver/owner in the sales department) —
//     an ordinary salesperson has no reason to browse every archived Draft.
//   • Whenever the result CAN include Drafts (`draft` or `all`), a non-
//     manager is further restricted to Drafts they created or own — "visible
//     to its creator, assigned owner and authorised managers only". This
//     restriction is layered in with `$and` rather than overwriting
//     `filter.$or`, which `search` below may already be using for its own,
//     unrelated purpose.
router.get("/", salesAuth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      stage,
      priority,
      source,
      assignedTo,
      scope,
      onlyMine,
      qualificationState,
      captureStatus,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = req.query;

    const filter = { isActive: true };
    const andClauses = [];
    if (stage && stage !== "all") filter.stage = stage;
    if (priority && priority !== "all") filter.priority = priority;
    if (source && source !== "all") filter.source = source;
    if (scope === "mine") {
      filter.assignedTo = req.user?.id;
    } else if (assignedTo === "none") {
      // Real server-side "Unassigned" filter (Lead correction chunk) —
      // replaces the Lead Inbox's previous fetch-everything-then-filter-
      // client-side workaround. `$exists:false` matches both a Lead that was
      // never assigned and one explicitly unassigned via PATCH (which
      // $unsets the field rather than storing a literal null — see the Lead
      // model's own assignedTo comment).
      filter.assignedTo = { $exists: false };
    } else if (assignedTo) {
      filter.assignedTo = assignedTo;
    }
    if (qualificationState === "active") {
      // `null` here is deliberate and does double duty in MongoDB: it matches
      // both an explicit null AND a field that is entirely absent — which is
      // every Lead created before Chunk 1 (no migration ran; see
      // services/leadQualification.js). Without it, every pre-Chunk-1 Lead
      // would silently vanish from the Inbox's default view.
      filter.qualificationState = { $in: [...ACTIVE_QUALIFICATION_STATES, null] };
    } else if (qualificationState === "history") {
      filter.qualificationState = { $in: HISTORY_QUALIFICATION_STATES };
    } else if (qualificationState && LEAD_QUALIFICATION_STATE_CODES.includes(qualificationState)) {
      filter.qualificationState = qualificationState;
    }
    const isHistoryView = qualificationState === "history";

    const effectiveCaptureStatus = ["draft", "active", "archived", "all"].includes(captureStatus)
      ? captureStatus
      : "active";
    let manager = null; // resolved at most once per request
    const callerIsManager = async () => manager ?? (manager = await isSalesManager(req.user));
    // Restrict a non-manager to the draft/archived Leads they created or own —
    // the same rule canSeeRestricted enforces per-record. Managers see all.
    const mineOnly = { $or: [{ "createdBy.id": req.user?.id }, { assignedTo: req.user?.id }] };

    if (effectiveCaptureStatus === "active") {
      // "active" or missing captureStatus (legacy) — never draft/archived.
      filter.captureStatus = { $nin: LEAD_INACTIVE_CAPTURE_STATUSES };
    } else if (effectiveCaptureStatus === "draft" || effectiveCaptureStatus === "archived") {
      // draft/archived are private: a non-manager sees only their own. (No
      // silent downgrade to active — an owner/creator CAN list their own
      // archived drafts, they just can't see anyone else's.)
      //
      // `onlyMine=true` (Lead correction chunk) forces the same restriction
      // even for a manager — "My Drafts" must always mean the CALLER's own
      // drafts, never "every draft a manager happens to be allowed to
      // browse". Without this a manager's My Drafts view silently showed
      // everyone's drafts, which is a different (currently unbuilt) admin
      // capability, not this one.
      filter.captureStatus = effectiveCaptureStatus;
      if (onlyMine === "true" || !(await callerIsManager())) andClauses.push(mineOnly);
    } else if (effectiveCaptureStatus === "all") {
      // No captureStatus filter, but a non-manager still must not see other
      // people's draft/archived Leads mixed in — active is open to all,
      // restricted only if theirs.
      if (!(await callerIsManager())) {
        andClauses.push({ $or: [{ captureStatus: { $nin: LEAD_INACTIVE_CAPTURE_STATUSES } }, mineOnly] });
      }
    }

    if (search) {
      const re = new RegExp(search, "i");
      andClauses.push({
        $or: [
          { firstName: re },
          { lastName: re },
          { email: re },
          { phone: re },
          { company: re },
          { leadId: re },
        ],
      });
    }
    if (andClauses.length) filter.$and = andClauses;

    const sort = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const scopedList = await scoped(req, filter);
    let leadsQuery = Lead.find(scopedList)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .select("-activities");
    // History rows need the human Journey reference to link to it — populated
    // only here (not on every list load) since it's the one view that needs it.
    if (isHistoryView) leadsQuery = leadsQuery.populate("conversion.journeyId", "journeyId name");

    // Count and page run TOGETHER (27 Aug 2026). They were sequential, so every
    // list load paid both latencies end to end for no reason — neither depends
    // on the other.
    const [total, leads] = await Promise.all([
      Lead.countDocuments(scopedList),
      leadsQuery.lean(),
    ]);

    // Pipeline stats — OPT-IN via ?stats=1 (27 Aug 2026, explicit performance
    // request: "currently it is taking too much time to load the page of
    // prospects, leads, pipeline, order book").
    //
    // This used to run unconditionally on every single list load: an unbounded
    // `Lead.find(await scoped(req, {...})).lean()` over the WHOLE collection, pulling every active
    // lead into Node just to tally it in a forEach. Nothing in the frontend has
    // ever read the `pipelineStats` key (grepped across grav-clothing: zero
    // hits) — Prospects and Leads both throw it away — so the most expensive
    // query on the page was pure waste, and it got worse with every lead added.
    //
    // Kept rather than deleted, because the response shape is a public contract
    // this repo can't see all the consumers of. Two changes: it only runs when
    // asked for, and when it does run it's a $group aggregation, so the tallying
    // happens in Mongo and only ~7 rows cross the wire instead of the entire
    // collection.
    let pipelineStats;
    if (String(req.query.stats || "") === "1") {
      // NEITHER drafts NOR archived drafts count (Draft Lead chunk: "must not
      // affect existing pipeline statistics", extended to exclude archived
      // too). `$nin` still matches a pre-chunk record with no captureStatus at
      // all, so legacy Leads keep counting as active.
      /* The company clause belongs in the INITIAL $match — a funnel built
       from a global aggregate has already counted other companies' leads. */
    const grouped = await Lead.aggregate([
      { $match: await scoped(req, {}) },
        { $match: { isActive: true, captureStatus: { $nin: LEAD_INACTIVE_CAPTURE_STATUSES } } },
        {
          $group: {
            _id: "$stage",
            count: { $sum: 1 },
            value: { $sum: { $ifNull: ["$estimatedValue", 0] } },
            weighted: {
              $sum: {
                $divide: [
                  { $multiply: [{ $ifNull: ["$estimatedValue", 0] }, { $ifNull: ["$probability", 0] }] },
                  100,
                ],
              },
            },
          },
        },
      ]);

      pipelineStats = {
        new: 0, contacted: 0, qualified: 0, proposal_sent: 0,
        negotiation: 0, won: 0, lost: 0,
        totalPipelineValue: 0, weightedValue: 0, total: 0,
      };
      for (const g of grouped) {
        pipelineStats[g._id] = (pipelineStats[g._id] || 0) + g.count;
        pipelineStats.total += g.count;
        // Won/lost are settled — they are not still "in the pipeline", so they
        // contribute to the counts but never to the value totals. Same rule the
        // forEach this replaced applied.
        if (!["won", "lost"].includes(g._id)) {
          pipelineStats.totalPipelineValue += g.value;
          pipelineStats.weightedValue += g.weighted;
        }
      }
      pipelineStats.conversionRate =
        pipelineStats.total > 0
          ? Math.round((pipelineStats.won / pipelineStats.total) * 100)
          : 0;
    }

    /* Derived, not stored — see services/prospectWorkState.js. */
    await attachProspectWorkState(leads);

    res.json({
      success: true,
      leads,
      ...(pipelineStats ? { pipelineStats } : {}),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[leads] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/duplicate-check — Lead Capture chunk §6. Read-shaped,
// checks BOTH Leads and Accounts by phone/email/company/website-domain, and
// returns candidates without touching anything — the same "warn, never
// auto-merge" policy as accounts.js's own /duplicate-check. Placed before
// POST / on purpose (mirrors accounts.js's own route order) even though there
// is no actual path collision (no generic POST /:id handler exists here).
router.post("/duplicate-check", salesAuth, async (req, res) => {
  try {
    const { company, email, phone, website, excludeId, contacts } = req.body || {};
    /* `contacts` is optional and may hold UNSAVED rows — Quick Capture calls
       this before anything is written, which is the moment a warning is worth
       most. Each row is matched on its own identities and reported by name. */
    const { matches, hasMatches, leadMatches, accountMatches } = await findProspectDuplicates(
      { Lead, Contact, Account },
      await dupCtx(req),
      { company, email, phone, website, contacts: Array.isArray(contacts) ? contacts : [], _id: excludeId || null },
    );
    res.json({ success: true, matches, hasMatches, leadMatches, accountMatches });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads — create. Whitelisted fields only; leadId is
// server-allocated via the atomic per-year counter (services/leadRef.js). A
// submitted `stage` is resolved to an initial canonical/legacy pair via
// services/leadQualification.js BEFORE the document is created, so an
// invalid request (proposal_sent/negotiation/won, or a missing reason)
// creates nothing rather than creating a Lead and then failing to set it.
//
// Draft Lead chunk: `captureStatus` in the body selects Quick Capture
// ("draft") vs. the original one-shot flow ("active", also the default when
// omitted — full backward compatibility). "archived" is never a valid
// creation target. A Draft NEVER gets a real Activity here, regardless of
// whether `firstAction` was supplied — "does not require an initial Activity
// yet" is a hard rule, not just a default; a real Activity for it is only
// ever created by POST /:id/approve. If `firstAction` IS present on a draft
// creation, it's stored as `pendingFirstAction` instead, so nothing typed is
// lost — the Draft workspace's §8 section keeps editing that same field.
router.post("/", salesAuth, async (req, res) => {
  try {
    const captureStatus = req.body?.captureStatus === "draft" ? "draft" : "active";
    const isDraft = captureStatus === "draft";

    // Lead Capture chunk §1: "require EITHER a company name OR a person's first
    // name" — checked here for a clean, specific 400 before anything is
    // written; the same rule also lives as a document-level validator on the
    // Lead model itself (belt-and-braces against a future PATCH blanking
    // both, not just this endpoint). Also Quick Capture's own first rule —
    // the same identity requirement applies at either capture level.
    if (!String(req.body?.company || "").trim() && !String(req.body?.firstName || "").trim()) {
      return res.status(400).json({ success: false, message: "Provide a company name or a first name." });
    }

    // Lead Capture chunk §5: "First action" is captured alongside the Lead, not
    // validated as a Lead field (it produces a CRMActivity, not a Lead
    // column) — checked explicitly, with the same rule POST /:id/activities
    // already applies to a task/follow-up (subject + due date required).
    const { firstAction } = req.body || {};
    if (firstAction) {
      if (!String(firstAction.subject || "").trim()) {
        return res.status(400).json({ success: false, message: "The first action needs a short description of what's next." });
      }
      if (!firstAction.dueDate) {
        return res.status(400).json({ success: false, message: "The first action needs a follow-up date." });
      }
    }

    let initial;
    if (isDraft) {
      // A Draft's qualificationState is always the schema default and never
      // anything else — services/leadQualification.js refuses every
      // transition while captureStatus is "draft", so there is no legacy
      // `stage` to resolve here either; a client-submitted `stage` is simply
      // not honoured for a draft creation.
      initial = { qualificationState: "new", qualificationReason: undefined, stage: "new" };
    } else {
      try {
        initial = resolveInitialQualification(req.body?.stage, {
          reason: req.body?.reason,
          lostReason: req.body?.lostReason,
        });
      } catch (err) {
        return sendTransitionError(res, err);
      }
    }

    const data = pickEditable(req.body);
    /* A new Lead has no contacts to resolve an `_id` against — every row is
       new, and a client-supplied id can only be a mistake. */
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "contacts")) {
      data.contacts = await resolveContacts(req.body.contacts, [], req.body.prospectType);
    }

    // Permissions correction: only a Sales manager may direct a NEW Lead's
    // owner/source at anyone other than themselves — checked against exactly
    // what the client submitted, before any default-to-creator fills in.
    if (!(await authorizeOwnerSourceChange(req, data))) {
      return res.status(403).json({ success: false, message: "Only a Sales manager can assign a Lead's owner or source to someone else." });
    }

    Object.assign(data, initial); // qualificationState, qualificationReason, stage
    data.captureStatus = captureStatus;
    // Review status (Prospect → HOD Review workflow): a new Prospect begins
    // "researching" (the salesperson's to enrich, then submit). A Lead created
    // directly as "active" (the legacy one-shot path, not the Prospect flow)
    // never went through review, so it's "approved" — reviewStatus stays
    // meaningful only alongside a draft.
    data.reviewStatus = isDraft ? "researching" : "approved";
    // Owner: default to the creator ONLY when the client omitted `assignedTo`
    // entirely. Lead Capture chunk §3: "Managers can capture inbound leads,
    // assign them, or leave them unassigned" — a manager explicitly choosing
    // "Unassigned" sends `assignedTo: ""`, a real key with a falsy value,
    // which must NOT fall back to the creator the way an omitted key does.
    // hasOwnProperty (not pickEditable's presence in `data`, which is the
    // same thing here, but spelled out for clarity) is what tells the two
    // apart — a plain `data.assignedTo || req.user?.id` cannot.
    // `assignedToName` is never taken from the client (see LEAD_EDITABLE_FIELDS'
    // own comment) — always resolved server-side via resolveEmployeeName.
    if (!Object.prototype.hasOwnProperty.call(req.body, "assignedTo")) {
      data.assignedTo = req.user?.id;
      data.assignedToName = req.user?.name;
    } else if (!data.assignedTo) {
      data.assignedTo = undefined;
      data.assignedToName = undefined;
    } else {
      data.assignedToName = await resolveEmployeeName(data.assignedTo, req);
    }
    // Sourced by (Lead Capture chunk §3): permanent credit for who found the
    // opportunity, independent of assignedTo (the changeable owner). Defaults
    // to the creator exactly like assignedTo does — an ordinary salesperson
    // never has to think about this; a manager capturing on someone else's
    // behalf can set either or both explicitly (both are in
    // LEAD_EDITABLE_FIELDS, so pickEditable already carries a client-supplied
    // value through before this default runs). `sourcedByName` is likewise
    // always server-resolved, never client-trusted.
    if (!data.sourcedBy) {
      data.sourcedBy = req.user?.id;
      data.sourcedByName = req.user?.name;
    } else {
      data.sourcedByName = await resolveEmployeeName(data.sourcedBy, req);
    }
    data.createdBy = actor(req);
    data.updatedBy = actor(req);
    if (firstAction) {
      if (isDraft) {
        // Draft Lead chunk: never a real Activity yet — store the INTENT so
        // nothing typed is lost; the Draft workspace's §8 section keeps
        // editing this same field until POST /:id/approve turns it real.
        data.pendingFirstAction = firstAction;
      } else {
        // The first follow-up's due date IS the Lead's nextFollowUpAt — set
        // here, before creation, so the Inbox/work-queue see it immediately
        // with no second write.
        data.nextFollowUpAt = firstAction.dueDate;
      }
    }

    /* One company decision: the account check below and the ownership stamp
       are the same company, resolved once for this request. */
    const { scope: createScope, ownership } = await scopeAndOwnership(req);
    /* An account from another company is not an account. Checked before the
       create, so an invalid link writes no Lead at all. */
    await assertLeadAccountInScope(data.accountId, createScope);
    /* Ownership from the actor's own membership — proven, or nothing is
       created. Never from `data`, which is the request. */
    const lead = await createWithRef(Lead, { ...stripCompanyOwnershipInput(data), ...ownership });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "create",
      summary: isDraft ? `Draft Lead captured: ${lead.leadId}` : `Lead created: ${lead.leadId}`,
      after: lead.toObject(),
    });

    // Lead Capture chunk §5: "When saved, this should create: The Lead; Its first
    // CRM Activity/follow-up task" — atomic in intent (same request), so a
    // newly captured Lead can never land in a "no next action" queue. The
    // task's owner is the LEAD's owner (assignedTo), which may differ from
    // the creator when a manager captured it on someone else's behalf — and
    // falls back to the creator when the Lead itself was left unassigned (an
    // unowned Lead can still have an owned first task; nothing should be
    // ownerless). Draft Lead chunk: skipped entirely for a draft — see the
    // pendingFirstAction branch above.
    let activity = null;
    if (firstAction && !isDraft) {
      activity = await Activity.create({
        leadId: lead._id,
        activityType: "follow_up",
        subject: String(firstAction.subject).trim(),
        description: firstAction.notes ? String(firstAction.notes).trim() : undefined,
        dueDate: firstAction.dueDate,
        status: "planned",
        ownerId: lead.assignedTo || req.user?.id,
        ownerName: lead.assignedToName || req.user?.name,
        createdBy: actor(req),
        updatedBy: actor(req),
      });
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "crm-activity",
        entityId: activity._id,
        entityLabel: activity.subject,
        action: "create",
        summary: `follow_up: ${activity.subject} (Lead ${displayName(lead)}, first action at capture)`,
        after: activity.toObject(),
      });
    }

    res.status(201).json({ success: true, lead, activity });
  } catch (err) {
    console.error("[leads] POST /", err);
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/leads/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }))
      .populate("assignedTo", "name email")
      // Populated only here, not on the list — a Converted Lead's own page
      // needs the human Journey reference + name to link to it; the list
      // never shows this.
      .populate("conversion.journeyId", "journeyId name")
      .lean();
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    /* The SAME computation the list runs, through the same helper. The card
       and this page must not be able to disagree about where a Prospect has
       got to — two derivations of one idea is two answers, and the believed
       one is whichever was looked at last. */
    await attachProspectWorkState([lead]);
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id — whitelisted business-field update, plus
// legacy-compatible `stage` handling: unchanged from current is silently
// ignored (the Edit Lead modal always resubmits the whole form, including an
// untouched `stage`), a genuine change is routed through
// services/leadQualification.js exactly like PATCH /:id/stage below —
// `stage` and `qualificationState` are never edited independently, no
// matter which endpoint the client used.
router.patch("/:id", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    const before = lead.toObject();

    const patchData = stripCompanyOwnershipInput(pickEditable(req.body));
    /* Resolved against THIS Lead's current people, so an existing contact keeps
       its `_id` and its server-set `promotedContactId` across an edit. */
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "contacts")) {
      /* The type as it will be AFTER this request — a single PATCH may set
         the type and the contacts together. */
      patchData.contacts = await resolveContacts(req.body.contacts, lead.contacts || [], patchData.prospectType || lead.prospectType, lead);
    }
    if (!(await authorizeOwnerSourceChange(req, patchData))) {
      return res.status(403).json({ success: false, message: "Only a Sales manager can reassign a Lead's owner or source." });
    }
    /* Validated before ANY field is assigned: a bad account must not be the
       reason half a PATCH lands. `lead` was read under the same scope. */
    if (Object.prototype.hasOwnProperty.call(patchData, "accountId")) {
      await assertLeadAccountInScope(patchData.accountId, await salesScopeFor(req));
    }
    Object.assign(lead, patchData);
    // `assignedToName`/`sourcedByName` are never taken from the client —
    // whenever the id itself changed, re-resolve the name server-side.
    if (Object.prototype.hasOwnProperty.call(patchData, "assignedTo")) {
      lead.assignedToName = lead.assignedTo ? await resolveEmployeeName(lead.assignedTo, req) : undefined;
    }
    if (Object.prototype.hasOwnProperty.call(patchData, "sourcedBy")) {
      lead.sourcedByName = lead.sourcedBy ? await resolveEmployeeName(lead.sourcedBy, req) : undefined;
    }

    if (Object.prototype.hasOwnProperty.call(req.body, "stage")) {
      try {
        const targetState = LEGACY_LEAD_STAGE_TO_QUALIFICATION[req.body.stage];
        const context = targetState ? await computeTransitionContext(lead, targetState, req.body, req) : {};
        applyLegacyStageChange(lead, {
          stage: req.body.stage,
          reason: req.body.reason,
          lostReason: req.body.lostReason,
          actor: actor(req),
          context,
        });
      } catch (err) {
        return sendTransitionError(res, err);
      }
    }

    lead.updatedBy = actor(req);
    await lead.save();
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(err.status || 400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id/stage — LEGACY entry point, now a thin
// compatibility wrapper around services/leadQualification.js. Preserves the
// original request shape (`{stage, lostReason}`) for existing callers, but
// no longer writes `stage` directly, no longer produces the "won ⇒
// probability 100 / convertedToCustomer" side effect, and no longer appends
// to the embedded `activities[]` — the change is audited via recordChange
// instead. A `stage` identical to the Lead's current value is a no-op (still
// returns 200 with the unchanged Lead).
router.patch("/:id/stage", salesAuth, async (req, res) => {
  try {
    const { stage, lostReason, reason } = req.body || {};
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    const before = lead.toObject();
    const prevStage = lead.stage;

    let applied;
    try {
      const targetState = LEGACY_LEAD_STAGE_TO_QUALIFICATION[stage];
      const context = targetState ? await computeTransitionContext(lead, targetState, req.body, req) : {};
      applied = applyLegacyStageChange(lead, { stage, reason, lostReason, actor: actor(req), context });
    } catch (err) {
      return sendTransitionError(res, err);
    }

    if (applied) {
      await lead.save();
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "lead",
        entityId: lead._id,
        entityLabel: displayName(lead),
        action: "update",
        summary: `Stage: ${prevStage} → ${stage}`,
        before,
        after: lead.toObject(),
      });
    }
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id/qualification-state — CANONICAL state
// transition. Uses the SAME services/leadQualification.js as
// PATCH /:id/stage above — one validated state machine, two entry points.
router.patch("/:id/qualification-state", salesAuth, async (req, res) => {
  try {
    const { qualificationState, reason, nextAction, duplicateOf } = req.body || {};

    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    // Archived is read-only. (A DRAFT is already refused inside
    // applyQualificationTransition — its captureStatus is "draft" — so this
    // guard is specifically what closes the ARCHIVED gap: an archived Lead's
    // captureStatus is not "draft", so that service-level draft-guard would
    // otherwise let a new→contacted move through on a disposed record.)
    if (refuseIfLocked(res, lead)) return;

    const before = lead.toObject();
    const prevState = lead.qualificationState;

    const context = await computeTransitionContext(lead, qualificationState, { duplicateOf }, req);
    try {
      applyQualificationTransition(lead, { qualificationState, reason, actor: actor(req), nextAction, context });
    } catch (err) {
      return sendTransitionError(res, err);
    }

    // Nurture (Lead correction chunk): "requires reason, next action and
    // follow-up date" — the reason/next-action/date presence was already
    // validated inside the service above; here the route creates the actual
    // shared follow-up Activity + sets nextFollowUpAt, mirroring the SAME
    // create-then-save-with-rollback reliability pattern POST /:id/approve
    // uses, so a "nurtured" Lead can never end up with no real follow-up task.
    let nurtureActivity = null;
    if (qualificationState === "nurture") {
      nurtureActivity = await Activity.create({
        leadId: lead._id,
        activityType: "follow_up",
        subject: String(nextAction.subject).trim(),
        dueDate: nextAction.dueDate,
        status: "planned",
        ownerId: lead.assignedTo || req.user?.id,
        ownerName: lead.assignedToName || req.user?.name,
        createdBy: actor(req),
        updatedBy: actor(req),
      });
      lead.nextFollowUpAt = nextAction.dueDate;
    }

    try {
      await lead.save();
    } catch (err) {
      if (nurtureActivity) await Activity.deleteOne({ _id: nurtureActivity._id });
      throw err;
    }
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Qualification state: ${prevState} → ${qualificationState}`,
      before,
      after: lead.toObject(),
    });
    if (nurtureActivity) {
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "crm-activity",
        entityId: nurtureActivity._id,
        entityLabel: nurtureActivity.subject,
        action: "create",
        summary: `follow_up: ${nurtureActivity.subject} (Lead ${displayName(lead)}, created on nurture)`,
        after: nurtureActivity.toObject(),
      });
    }
    res.json({ success: true, lead, activity: nurtureActivity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── Draft Lead lifecycle (Draft Lead chunk) ─────────────────────────────────

/** Live duplicate re-check for a Lead's CURRENT identity fields, surfaced by
 *  GET /:id/readiness so the workspace can WARN about a likely duplicate
 *  (informational only — never a gate). Returns the raw matches plus a
 *  convenience boolean. */
/* Takes the request so the duplicate context is THIS caller's company — the
   helper cannot resolve one of its own without reaching for a global read. */
async function checkStrongDuplicates(lead, req) {
  const { matches, leadMatches, accountMatches, hasStrong } = await findProspectDuplicates(
    { Lead, Contact, Account }, await dupCtx(req), lead,
  );
  return {
    duplicateMatches: matches,
    leadMatches,
    accountMatches,
    hasUnreviewedStrongDuplicates: hasStrong && !lead.duplicateReviewedAt,
  };
}

// GET /api/cms/crm/leads/:id/readiness — the live checklist for whatever the
// Lead's next gated step is. Read-shaped, no side effect.
//   • For a Prospect (captureStatus:"draft"): the SUBMISSION readiness
//     (services/leadReadiness.js computeSubmissionReadiness) — exactly what
//     POST /:id/submit enforces — in `checks`/`ready`.
//   • For an Active Lead: `checks`/`ready` are empty (submission is behind
//     it); `qualification` carries the qualification checklist the Lead
//     correction chunk exposes for the "qualified"/"readyToConvert" moves.
// Duplicate matches are still surfaced (informational — see the Prospect
// capture chunk: a possible duplicate is worth flagging but never a gate).
// PATCH /api/cms/crm/leads/:id/next-action — set or update an Active Lead's
// single NEXT ACTION: the one open planned follow-up Activity (subject + due
// date) plus the Lead's `nextFollowUpAt` (so the work queue sorts by it). This
// reuses the existing CRMActivity follow-up — the SAME kind approval creates
// from `pendingFirstAction` — so it is NOT a separate task system, just the one
// forward action the command centre shows. It UPDATES the existing open
// follow-up in place (never piling up); it creates one only if none is open.
// Qualification is never touched here.
// POST /api/cms/crm/leads/:id/account
// Create (or return the already-linked) customer Account for this Lead, so the
// full "Customer setup" — contacts, locations, relationships, garment profile —
// can be done on the Active Lead against a REAL Account, before any Journey
// exists (the Sales Journey no longer has an "Account" stage). Idempotent: a
// Lead that already has an accountId gets that same account back, never a twin.
// At conversion the Journey links this same account rather than making a new one.
router.post("/:id/account", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "Set up the customer once the Prospect is an Active Lead." });
    }

    const { scope, ownership } = await scopeAndOwnership(req);
    const promoteArgs = { lead, scopeClause: scope.clause, ownership, actor: actor(req) };

    /* A promotion refusal is a FAILURE, not a footnote on a success. It used
       to come back as `success: true` with a conflict count, so the screen
       linked the customer and showed a mild note — while the people it was
       about had not been promoted and there is no screen anywhere for doing it
       by hand. 409: the customer was not set up, and here is exactly why. */
    const refuseConflicts = (e) => res.status(409).json({
      success: false,
      message: e.message,
      code: "contact_promotion_conflict",
      conflicts: e.conflicts,
    });

    /* ── PROMOTION IS A RECONCILIATION, NOT A ONE-SHOT ──────────────────────
       Run for a brand-new Account and for one that already exists. A Lead
       gains people after the customer is set up — the site coordinator turns
       up on the second call — and returning early because `accountId` was
       already set is exactly how those people stayed trapped on the Lead.
       Anybody already promoted resolves through their own
       `promotedContactId`, so a repeat run creates nothing. */

    // Already linked — hand back the same account, never a second one.
    if (lead.accountId) {
      const existing = await Account.findOne(await scoped(req, { _id: lead.accountId })).lean();
      if (existing) {
        let promoted;
        try {
          promoted = await promoteLeadContacts({ Contact, Lead }, { ...promoteArgs, account: existing });
        } catch (e) {
          /* Refused during preflight, so nothing was written: the Account
             stands, and not one contact or `promotedContactId` moved. */
          if (e instanceof ContactPromotionError) return refuseConflicts(e);
          throw e;
        }
        try {
          /* The primary belongs ON the Account, in this path too — it was only
             ever persisted for a freshly created one, so an Account that
             gained its first real contact through reconciliation kept pointing
             at nobody. Never overwrites a primary the Account already has:
             the service returns the incumbent's id unchanged in that case. */
          if (promoted.summary.primaryContactId) {
            await Account.updateOne(
              { _id: existing._id },
              { $set: { primaryContact: promoted.summary.primaryContactId } },
            );
          }
        } catch (e) {
          await promoted.undo();
          throw e;
        }
        const refreshed = await Account.findById(existing._id).lean();
        return res.json({
          success: true, accountId: String(existing._id), account: refreshed,
          created: false, contacts: promoted.summary,
        });
      }
      // Dangling link (account was deleted) — fall through and re-create.
    }

    const companyName =
      String(lead.company || "").trim() ||
      [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() ||
      "New customer";
    /* A converted Lead becomes an Account in the SAME company the lead was
       proved to belong to — not re-resolved, which could differ. */
    const account = await Account.create({
      companyId: lead.companyId,
      companyOwnership: lead.companyOwnership,
      companyName,
      displayName: companyName,
      assignedTo: lead.assignedTo || req.user?.id,
      assignedToName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    /* ── A HALF-SET-UP CUSTOMER IS WORSE THAN NONE ──────────────────────────
       The Account and the Lead's link to it were written BEFORE promotion, so
       any failure afterwards left a customer record on the Lead whose people
       had never arrived — and the salesperson had no way back, because the
       button only offers to create a customer that now appears to exist.
       Everything from here rolls back together. */
    const previousAccountId = lead.accountId || null;
    let promoted = null;
    let contacts;
    try {
      lead.accountId = account._id;
      await lead.save();

      promoted = await promoteLeadContacts({ Contact, Lead }, { ...promoteArgs, account });
      contacts = promoted.summary;

      if (contacts.primaryContactId) {
        await Account.updateOne({ _id: account._id }, { $set: { primaryContact: contacts.primaryContactId } });
      }

      await recordChange(req, {
        departmentSlug: "sales",
        entity: "crm-account",
        entityId: account._id,
        entityLabel: account.companyName,
        action: "create",
        summary: `Created account ${account.accountId} — ${account.companyName} (customer setup on Lead ${lead.leadId || lead._id})`,
        after: account.toObject(),
      });
    } catch (e) {
      if (promoted) await promoted.undo();
      await Account.deleteOne({ _id: account._id }).catch(() => {});
      /* Conditional, and not a `lead.save()`: the document in hand is from
         before promotion and carries the whole record. Writing it back would
         also write back anything another request changed in the meantime. The
         filter restores the link only while it is still the one this request
         set. */
      await Lead.updateOne(
        { _id: lead._id, accountId: account._id },
        previousAccountId ? { $set: { accountId: previousAccountId } } : { $unset: { accountId: "" } },
      ).catch(() => {});
      lead.accountId = previousAccountId || undefined;
      if (e instanceof ContactPromotionError) return refuseConflicts(e);
      throw e;
    }

    /* Refreshed, because `primaryContact` was written after the document in
       hand was built — returning the stale one told the screen the customer
       had no primary contact moments after choosing one. */
    const saved = await Account.findById(account._id).lean();
    res.status(201).json({ success: true, accountId: String(account._id), account: saved, created: true, contacts });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.patch("/:id/next-action", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    const subject = String(req.body?.subject || "").trim();
    if (!subject) return res.status(400).json({ success: false, message: "A next action needs a short description." });
    const due = req.body?.dueDate ? new Date(req.body.dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) return res.status(400).json({ success: false, message: "A next action needs a valid due date." });

    /* ── A DRAFT KEEPS ITS FIRST ACTION WHERE DRAFTS ALREADY KEEP IT ─────────
       A Prospect can now plan a follow-up, which it could not before. It does
       so through `pendingFirstAction` — the field the record already has —
       rather than through a live follow-up Activity.

       That is not a lesser path, it is the correct one. Approval turns
       `pendingFirstAction` into the Lead's first follow-up Activity, so the
       action a salesperson planned while prospecting becomes the same Activity
       afterwards: one continuous history, no duplicate, and no edit to the
       conversion path to prevent one. Writing a live Activity here instead
       would leave approval creating a SECOND follow-up from a field that was
       still set.

       `nextFollowUpAt` is stamped either way so the work queue sorts a
       Prospect alongside everything else. */
    /* Validated against this Lead before anything is written, so a bad id
       refuses the whole request rather than storing a pointer to nobody. */
    const target = resolveLeadContact(lead, req.body?.leadContactId);

    if (lead.captureStatus === "draft") {
      lead.pendingFirstAction = {
        subject,
        dueDate: due,
        notes: req.body?.description ? String(req.body.description).trim() : undefined,
        leadContactId: target.leadContactId,
      };
      lead.nextFollowUpAt = due;
      lead.updatedBy = actor(req);
      await lead.save();
      await recordChange(req, {
        departmentSlug: "sales", entity: "lead", entityId: lead._id, entityLabel: displayName(lead),
        action: "update", summary: `Next action set: ${subject} (${lead.leadId})`, after: lead.toObject(),
      });
      /* Same envelope as the Active path, so one frontend handles both. The
         planned action is echoed as `activity` in the shape the UI reads. */
      return res.json({
        success: true,
        lead,
        activity: { subject, dueDate: due, status: "planned", activityType: "follow_up", pending: true },
      });
    }

    // CANONICAL next action = the earliest-due open planned follow-up (tie-broken
    // by createdAt) — the SAME one the frontend picks. Any other open follow-up
    // is a competing leftover; we CANCEL those (keeping the record as history),
    // never delete, so exactly one open follow-up remains after this call.
    //
    // ── CORRECTED: THE HEADLINE IS DERIVED, NOT ENFORCED ────────────────────
    // This block used to CANCEL every open follow-up but the earliest, so a
    // salesperson who planned "call Monday" and then planned "email the
    // quotation" silently lost the call and was told "Next action set."
    //
    // A Lead still has exactly one HEADLINE next action — the Leads page bands
    // on it — but that is now computed from what is open
    // (services/leadNextAction.js), not achieved by destroying the rest. Real
    // work on a lead branches; a second intention is not a correction of the
    // first. To retire one deliberately, complete or cancel it.
    const open = await Activity.find({ leadId: lead._id, isActive: true, activityType: "follow_up", status: "planned" }).sort({ dueDate: 1, createdAt: 1 });
    const canonical = open[0] || null;

    // Snapshots for compensation — transactions aren't available on the
    // standalone dev/test Mongo, so if the Lead update fails after the Activity
    // writes we roll them back by hand rather than leave them inconsistent.
    const leadPrevNext = lead.nextFollowUpAt;
    const canonPrev = canonical ? { subject: canonical.subject, dueDate: canonical.dueDate, status: canonical.status } : null;
    let createdId = null;
    let activity;

    try {
      if (canonical) {
        canonical.subject = subject; canonical.dueDate = due; canonical.status = "planned"; canonical.updatedBy = actor(req);
        /* Same person the request named — an Active Lead's next action is a
           real Activity, so the target lives on it rather than on
           `pendingFirstAction`. */
        canonical.leadContactId = target.leadContactId;
        if (target.contactName) canonical.contactName = target.contactName;
        await canonical.save();
        activity = canonical;
      } else {
        activity = await Activity.create({
          leadId: lead._id, activityType: "follow_up", subject, dueDate: due, status: "planned",
          ...target,
          ownerId: lead.assignedTo || req.user?.id, ownerName: lead.assignedToName || req.user?.name,
          createdBy: actor(req), updatedBy: actor(req),
        });
        createdId = activity._id;
      }
      // Recomputed from everything still open, never just set to what was
      // typed: editing the headline to a LATER date can hand the headline to a
      // different follow-up, and `= due` would have left the Leads page banding
      // on an item that is no longer next.
      const openNow = await Activity.find({
        leadId: lead._id, isActive: true, activityType: "follow_up", status: "planned",
      }).lean();
      lead.nextFollowUpAt = nextFollowUpAt(openNow);
      lead.updatedBy = actor(req);
      await lead.save();
    } catch (err) {
      // Best-effort rollback so Activity and Lead never drift apart.
      try {
        if (createdId) await Activity.deleteOne({ _id: createdId });
        else if (canonical && canonPrev) { await Activity.updateOne({ _id: canonical._id }, { $set: { subject: canonPrev.subject, dueDate: canonPrev.dueDate, status: canonPrev.status } }); }
        await Lead.updateOne(await scoped(req, { _id: lead._id }), leadPrevNext ? { $set: { nextFollowUpAt: leadPrevNext } } : { $unset: { nextFollowUpAt: "" } });
      } catch { /* leave the thrown error as the reported cause */ }
      return res.status(400).json({ success: false, message: err.message || "Could not set the next action." });
    }

    await recordChange(req, {
      departmentSlug: "sales", entity: "lead", entityId: lead._id, entityLabel: displayName(lead),
      action: "update", summary: `Next action set: ${activity.subject} (${lead.leadId})`, after: lead.toObject(),
    });
    res.json({ success: true, lead, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get("/:id/readiness", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id })).lean();
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    const { leadMatches, accountMatches, duplicateMatches } = await checkStrongDuplicates(lead, req);
    const isDraft = lead.captureStatus === "draft";
    /* `readyToConfirm` and `preConfirmChecks` travel too: the screen gates its
       Convert button on the first and lists the second, so that the interest
       signal and note — which are typed into the dialog that button opens —
       are never presented as blockers before the dialog can open. `ready`
       still means the whole bar and is what conversion enforces. */
    const { checks, ready, readyToConfirm, preConfirmChecks } = isDraft
      ? computeSubmissionReadiness(lead, {
          hasSuccessfulInteraction: await hasSuccessfulInteraction(lead._id),
        })
      : { checks: [], ready: false, readyToConfirm: false, preConfirmChecks: [] };
    /* ── TWO GATES, REPORTED SEPARATELY ────────────────────────────────
       The Lead lifecycle has two forward steps and they ask for different
       things: Requirement Captured wants the requirement, Enquiry Ready
       wants everything an Enquiry cannot be raised without. Reporting one
       merged list would make the workspace show a salesperson the Enquiry bar
       while they are still trying to write down what the customer asked for.

       `qualification` keeps its old shape and meaning (the Enquiry bar) so
       nothing reading it breaks; the two named keys are what the stage
       checklists render. The server is the enforcer either way — this is the
       mirror, not the rule. */
    const qualification = isDraft ? null : computeEnquiryReadiness(lead);
    res.json({
      success: true,
      checks, ready, readyToConfirm, preConfirmChecks,
      leadMatches, accountMatches, duplicateMatches, qualification,
      requirementIdentified: isDraft ? null : computeRequirementIdentifiedReadiness(lead),
      enquiryReady: qualification,
    });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/review-duplicates — stamps duplicateReviewedAt,
// satisfying the readiness checklist's duplicate-review item for the Draft's
// CURRENT identity fields. Automatically cleared again the moment any of
// phone/email/company/website changes (see the Lead model's pre-save hook) —
// this can never certify a review of data that no longer exists.
router.post("/:id/review-duplicates", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    lead.duplicateReviewedAt = new Date();
    lead.updatedBy = actor(req);
    await lead.save();
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/leads/:id/archive-draft — "Archive Draft", NOT the
// ordinary hard-delete (DELETE /:id) below, which remains the general
// isActive soft-delete for any Lead regardless of capture status. Only valid
// while still a Draft; records who and when separately from that other
// action's archivedAt/archivedBy (see the Lead model's own comment).
router.patch("/:id/archive-draft", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (lead.captureStatus !== "draft") {
      // Covers "already archived" too — an archived draft can't be re-archived
      // (it's read-only), and an active Lead was never a draft.
      return res.status(400).json({ success: false, message: "Only a Prospect can be archived this way." });
    }
    if (!(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    // A submitted Prospect is locked — the salesperson can't archive it out
    // from under review; a HOD disposes of it via reject instead.
    if (refuseIfLocked(res, lead)) return;
    const before = lead.toObject();
    lead.captureStatus = "archived";
    lead.draftArchivedAt = new Date();
    lead.draftArchivedBy = actor(req);
    lead.updatedBy = actor(req);
    await lead.save();
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Draft archived: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── Prospect → HOD Review → Active Lead approval workflow ────────────────────
//
// A Prospect (captureStatus:"draft") no longer becomes an Active Lead by a
// salesperson pressing one button. The old POST /:id/activate ("Start Working
// Lead") is GONE — replaced by four review endpoints. The ONLY path from
// Prospect to Active Lead is a HOD/admin approving a submitted Prospect (see
// POST /:id/approve). services/leadReview.js is the single writer of
// reviewStatus, so this can't be bypassed. This is NOT "conversion" (Lead →
// Account/Contact/Sales Journey, a later chunk) — it's an internal review
// gate; the language throughout is "Approve as Active Lead", never "convert".

// POST /api/cms/crm/leads/:id/convert-to-active — THE conversion route, and
// the only one. The salesperson converts a ready Prospect straight to an
// Active Lead, no HOD review in between (20 Aug 2026, explicit request).
//
// A second `router.post("/:id/convert-to-active")` used to sit ~190 lines
// below this one. Express matches the first registration and never reaches the
// second, so that handler was unreachable code that read like live code — two
// implementations of one rule, free to drift apart, with the drift invisible
// because only one of them ever ran. This is the one that ran; the dead one is
// deleted, and the conversion suite now asserts the route is registered
// exactly once so it cannot come back.
//
// What was worth keeping from the dead copy is folded in below: an explicit
// check that the first action really is there before it is dereferenced.
// Everything else it did, this already did — and it stamped the review side by
// hand, where this delegates to services/leadReview.js's applyDirectConvert,
// the single writer of `reviewStatus` and the reason the state machine cannot
// be bypassed.
//
// Same readiness gate /submit enforces, same create-Activity-then-flip-then-
// rollback reliability pattern /approve uses. /submit, /approve,
// /return-for-info and /reject are left in place — nothing forces their use
// anymore, but removing working, reachable routes wasn't asked for.
router.post("/:id/convert-to-active", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }

    const before = lead.toObject();
    try {
      applyDirectConvert(lead, { actor: actor(req) }); // validates researching/returned state; stamps review side
    } catch (err) {
      return sendReviewError(res, err);
    }
    /* ── THE INTEREST THAT JUSTIFIES THE CONVERSION ────────────────────────
       Recorded on the record itself, before the readiness gate runs, so the
       gate's own interestSignal/interestNote checks judge what was just sent
       rather than what was there beforehand.

       The signal and the note come from the salesperson. WHO confirmed it and
       WHEN are set here from the authenticated request and are never read from
       the body: a client-supplied "confirmed by" is not a confirmation, it is
       an assertion, and this field exists precisely so somebody can be asked
       about it later. */
    if (req.body?.interestSignal !== undefined) lead.interestSignal = req.body.interestSignal;
    if (req.body?.interestNote !== undefined) lead.interestNote = String(req.body.interestNote || "").trim();
    if (lead.interestSignal || lead.interestNote) {
      lead.interestConfirmedAt = new Date();
      lead.interestConfirmedBy = actor(req);
    }

    const { checks, ready } = computeSubmissionReadiness(lead, {
      hasSuccessfulInteraction: await hasSuccessfulInteraction(lead._id),
    });
    if (!ready) {
      return res.status(400).json({
        success: false,
        message: "This Prospect isn't ready to convert yet.",
        checks,
      });
    }

    /* Belt and braces: readiness already requires the first action and its
       date, but this route dereferences both below and a 500 would be a poor
       way to say "you forgot the follow-up". */
    const first = lead.pendingFirstAction || {};
    if (!String(first.subject || "").trim() || !first.dueDate) {
      return res.status(400).json({
        success: false,
        message: "Set the first follow-up — an Active Lead starts with something scheduled.",
      });
    }

    if (Object.prototype.hasOwnProperty.call(req.body || {}, "assignedTo") && req.body.assignedTo) {
      lead.assignedTo = req.body.assignedTo;
      lead.assignedToName = await resolveEmployeeName(req.body.assignedTo, req);
    }

    // Create the first shared CRM follow-up Activity FIRST, while the Lead is
    // still a draft — same reliability pattern /approve uses: a Prospect can
    // never become an Active Lead with no first Activity, and a failed flip
    // never leaves an orphaned Activity.
    const activity = await Activity.create({
      leadId: lead._id,
      activityType: "follow_up",
      subject: String(first.subject).trim(),
      description: first.notes ? String(first.notes).trim() : undefined,
      dueDate: first.dueDate,
      /* The person the planned action was aimed at, carried onto the Activity
         it becomes. Re-resolved rather than copied: a contact removed between
         planning and converting must not leave a pointer to nobody, and this
         is inside the existing create-then-flip-then-rollback order, so a
         refusal here still leaves no half-converted record. */
      ...resolveLeadContact(lead, first.leadContactId),
      status: "planned",
      ownerId: lead.assignedTo || req.user?.id,
      ownerName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    try {
      lead.captureStatus = "active";
      lead.nextFollowUpAt = first.dueDate;
      lead.updatedBy = actor(req);
      await lead.save();
    } catch (err) {
      await Activity.deleteOne({ _id: activity._id });
      throw err;
    }

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Prospect converted to Active Lead: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "create",
      summary: `follow_up: ${activity.subject} (Lead ${displayName(lead)}, created on conversion)`,
      after: activity.toObject(),
    });
    res.json({ success: true, lead, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/submit — the salesperson submits a researched
// Prospect for HOD review. Enforces submission readiness server-side (the UI
// shows the same checklist, but this is the gate) and flips reviewStatus
// researching|returned → submitted, after which the Prospect is read-only
// (refuseIfLocked) until a HOD reviews it.
router.post("/:id/submit", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    // A Prospect is restricted-visible; its owner/creator (or a manager) may
    // submit it. Same access rule as every other Prospect mutation.
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    // Validate the review STATE first (must be a researching/returned
    // Prospect), with a precise message per bad case, before checking content
    // readiness — so an archived/submitted/active Lead never gets the
    // misleading "not ready" response. Non-mutating: applySubmit re-validates
    // and stamps the change once readiness passes.
    const before = lead.toObject();
    try {
      applySubmit(lead, { actor: actor(req) });
    } catch (err) {
      return sendReviewError(res, err);
    }
    // applySubmit set reviewStatus="submitted" in memory; only persist it if
    // the submission is actually READY (checked against the pre-submit data —
    // reviewStatus isn't part of the checklist, so reading `lead` is fine).
    /* ── THE INTEREST THAT JUSTIFIES THE CONVERSION ────────────────────────
       Recorded on the record itself, before the readiness gate runs, so the
       gate's own interestSignal/interestNote checks judge what was just sent
       rather than what was there beforehand.

       The signal and the note come from the salesperson. WHO confirmed it and
       WHEN are set here from the authenticated request and are never read from
       the body: a client-supplied "confirmed by" is not a confirmation, it is
       an assertion, and this field exists precisely so somebody can be asked
       about it later. */
    if (req.body?.interestSignal !== undefined) lead.interestSignal = req.body.interestSignal;
    if (req.body?.interestNote !== undefined) lead.interestNote = String(req.body.interestNote || "").trim();
    if (lead.interestSignal || lead.interestNote) {
      lead.interestConfirmedAt = new Date();
      lead.interestConfirmedBy = actor(req);
    }

    const { checks, ready } = computeSubmissionReadiness(lead, {
      hasSuccessfulInteraction: await hasSuccessfulInteraction(lead._id),
    });
    if (!ready) {
      return res.status(400).json({
        success: false,
        message: "This Prospect isn't ready to submit for review yet.",
        checks,
      });
    }
    await lead.save();
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Prospect submitted for HOD review: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/approve — approves a submitted Prospect AS an
// Active Lead. The ONLY path from Prospect to Active Lead.
// Optional `assignedTo` lets the approver assign a different owner IN the
// approval action only (by default the creator, already assignedTo, stays
// owner). Uses the same create-Activity-then-flip-then-rollback reliability
// pattern the old activate path used — a Prospect can never become an Active
// Lead with no first Activity, and a failed flip never leaves an orphaned
// Activity.
//
// NOT restricted to HOD/admin. Was gated by isSalesManager(); removed at the
// CEO's explicit request — any authenticated Sales CRM user (still gated by
// `salesAuth` above) may approve. reject/return-for-info below are untouched.
router.post("/:id/approve", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });

    const before = lead.toObject();
    try {
      applyApprove(lead, { actor: actor(req) }); // validates submitted state; stamps review side
    } catch (err) {
      return sendReviewError(res, err);
    }

    // Optional owner override — allowed ONLY here, inside the approval action.
    // The id is resolved to a name server-side (never client-trusted).
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "assignedTo") && req.body.assignedTo) {
      lead.assignedTo = req.body.assignedTo;
      lead.assignedToName = await resolveEmployeeName(req.body.assignedTo, req);
    }

    // Create the first shared CRM follow-up Activity FIRST, while the Lead is
    // still a draft (reliability — see the block comment above).
    const activity = await Activity.create({
      leadId: lead._id,
      activityType: "follow_up",
      subject: String(lead.pendingFirstAction.subject).trim(),
      description: lead.pendingFirstAction.notes ? String(lead.pendingFirstAction.notes).trim() : undefined,
      dueDate: lead.pendingFirstAction.dueDate,
      /* The same carry-over the direct conversion does. This path is retained
         rather than used by the current UI, but a Prospect approved through it
         must not silently lose the person its first follow-up was aimed at.
         Re-resolved, so a contact removed since planning refuses here rather
         than leaving a pointer to nobody — inside the existing
         create-then-flip-then-rollback order. */
      ...resolveLeadContact(lead, lead.pendingFirstAction.leadContactId),
      status: "planned",
      ownerId: lead.assignedTo || req.user?.id,
      ownerName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    try {
      // Prospect → Active Lead. qualificationState is untouched — it stays
      // "new" (a freshly-approved Lead has not been qualified). Review status
      // is already "approved" (applyApprove). nextFollowUpAt from the same
      // due date as the new Activity, so it lands in the work queue.
      lead.captureStatus = "active";
      lead.nextFollowUpAt = lead.pendingFirstAction.dueDate;
      lead.updatedBy = actor(req);
      await lead.save();
    } catch (err) {
      await Activity.deleteOne({ _id: activity._id });
      throw err;
    }

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Prospect approved as Active Lead: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "create",
      summary: `follow_up: ${activity.subject} (Lead ${displayName(lead)}, created on approval)`,
      after: activity.toObject(),
    });
    res.json({ success: true, lead, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/return-for-info — HOD/admin returns a submitted
// Prospect for more information. Reason required (shown to the salesperson).
// Stays a Prospect and becomes editable / re-submittable again.
router.post("/:id/return-for-info", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (!(await isSalesManager(req.user))) {
      return res.status(403).json({ success: false, message: "Only a HOD or admin can return a Prospect for more information." });
    }
    const before = lead.toObject();
    try {
      applyReturn(lead, { reason: req.body?.reason, actor: actor(req) });
    } catch (err) {
      return sendReviewError(res, err);
    }
    await lead.save();
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Prospect returned for more information: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/reject — HOD/admin rejects a submitted Prospect.
// Reason required. Reject IS archive: captureStatus → "archived",
// reviewStatus → "rejected" (services/leadReview.js applyReject sets both).
router.post("/:id/reject", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (!(await isSalesManager(req.user))) {
      return res.status(403).json({ success: false, message: "Only a HOD or admin can reject a Prospect." });
    }
    const before = lead.toObject();
    try {
      applyReject(lead, { reason: req.body?.reason, actor: actor(req) });
    } catch (err) {
      return sendReviewError(res, err);
    }
    await lead.save();
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      action: "update",
      summary: `Prospect rejected and archived: ${lead.leadId}`,
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/leads/:id/activities — the shared CRMActivity timeline for
// a pre-Account Lead. Same response shape as GET /api/cms/crm/activities.
//
// Lead correction chunk: this previously ran with NO Lead-level access check
// at all — a valid leadId returned that Lead's activities to any
// authenticated Sales caller, restricted or not. Now fetches the Lead first
// (like every other :id route in this file) and applies the same
// isRestricted/canSeeRestricted rule.
//
// It ALSO used to refuse a still-Draft Lead outright, on the reasoning that a
// Draft had no operational Activities to expose. That is no longer true and
// was never quite right: a Prospect is the record being rung and mailed, so
// its activities are the first ones there are. Drafts are served here like any
// other record — ownership, not capture status, is what gates this route.
router.get("/:id/activities", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }))
      .select("_id captureStatus createdBy assignedTo")
      .lean();
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    /* ── A PROSPECT IS WORKED BEFORE IT IS QUALIFIED ─────────────────────
       This refused a Draft outright: "Prospects don't have Activities yet —
       start working the Lead first." That inverted the actual job. A Prospect
       IS the record you ring, mail and message to discover whether interest
       exists; requiring conversion first meant either working the customer
       with no record of it, or converting on hope to unlock the buttons.

       Removed, not relaxed — everything that made this route safe is above
       and untouched: the company scope on the lookup, isRestricted /
       canSeeRestricted for ownership, and refuseIfLocked for archived and
       submitted records. A Draft was never a permission question.

       Qualification is unaffected. Logging outreach writes an Activity and
       nothing else — captureStatus stays "draft", qualificationState is not
       read or written here, and /qualification-state still refuses Drafts. */

    const { type, status, page = 1, limit = 50 } = req.query;
    const filter = { isActive: true, leadId: req.params.id };
    if (type && type !== "all") filter.activityType = type;
    if (status && status !== "all") filter.status = status;

    const total = await Activity.countDocuments(filter);
    const rows = await Activity.find(filter)
      .sort({ activityDate: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate("contactId", "firstName lastName")
      .lean();
    const now = Date.now();
    const activities = rows.map((a) => ({
      ...a,
      isOverdue: a.status === "planned" && a.dueDate && new Date(a.dueDate).getTime() < now,
    }));
    res.json({
      success: true,
      activities,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/activities — log a shared CRMActivity against
// this Lead. THE canonical replacement for the legacy embedded
// POST /:id/activity below. Fields are picked explicitly (not spread from
// req.body) so a client cannot attach an accountId or override leadId.
// Supports the same interaction metadata the Account-Activity router does —
// outcome and nextActionDate included, previously missing here.
// PATCH /api/cms/crm/leads/:id/activities/:activityId
//
// Edit ONE of a Lead's open items — the specific one, not whichever happens to
// be the headline.
//
// `next-action` deliberately always edits the canonical item, because that is
// what "plan the next move" means. Once a Lead can hold several open items that
// is no longer enough: "Update" on the third deadline has to change the third
// deadline. The generic PATCH /activities/:id would edit the row but leave
// `nextFollowUpAt` stale, so this lives here, where the Lead's headline is
// recomputed alongside it.
router.patch("/:id/activities/:activityId", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;

    // Scoped to THIS lead on purpose: an activity id from another record must
    // not be editable through this lead's URL.
    const activity = await Activity.findOne({ _id: req.params.activityId, leadId: lead._id, isActive: true });
    if (!activity) return res.status(404).json({ success: false, message: "No such item on this Lead." });

    if (req.body?.subject !== undefined) {
      const subject = String(req.body.subject || "").trim();
      if (!subject) return res.status(400).json({ success: false, message: "A next action needs a short description." });
      activity.subject = subject;
    }
    if (req.body?.dueDate !== undefined) {
      const due = req.body.dueDate ? new Date(req.body.dueDate) : null;
      if (!due || Number.isNaN(due.getTime())) {
        return res.status(400).json({ success: false, message: "A next action needs a valid due date." });
      }
      activity.dueDate = due;
    }
    // Status/priority — a reminder a salesperson can actually WORK: mark it
    // done, dismiss it, or bump its priority, not just retype its text and
    // date (28 Aug 2026, explicit request: "it should treat like in form of
    // reminder... set modify there status/progress"). Reuses the same
    // ACTIVITY_STATUS_CODES/ACTIVITY_PRIORITY_CODES every other Activity
    // write in this file already validates against.
    /* ── A REMINDER CAN BE RE-AIMED ───────────────────────────────────────
       `NextActionForm` was already sending `leadContactId` while editing a
       reminder, and this route ignored it — so the shared contact selector was
       visible, the field travelled, and nothing happened. Either the field
       stops being sent or the route honours it; honouring it is the useful
       half, because the person a follow-up is for genuinely changes.

       `null` clears the target, and clears the derived name with it: leaving a
       `contactName` behind would show a reminder still labelled with somebody
       it is no longer aimed at. */
    if (req.body?.leadContactId !== undefined) {
      if (req.body.leadContactId === null || req.body.leadContactId === "") {
        activity.leadContactId = undefined;
        activity.contactName = undefined;
      } else {
        const target = resolveLeadContact(lead, req.body.leadContactId);
        activity.leadContactId = target.leadContactId;
        activity.contactName = target.contactName;
      }
    }
    if (req.body?.priority !== undefined) {
      if (!ACTIVITY_PRIORITY_CODES.includes(req.body.priority)) {
        return res.status(400).json({ success: false, message: `priority must be one of: ${ACTIVITY_PRIORITY_CODES.join(", ")}` });
      }
      activity.priority = req.body.priority;
    }
    // The working sub-state (Planned/In Progress/Paused/Rescheduled) — stays
    // independent of `status` on purpose; see Activity.js's progressStage
    // comment for why folding it into `status` would be wrong.
    if (req.body?.progressStage !== undefined) {
      if (!ACTIVITY_PROGRESS_STAGE_CODES.includes(req.body.progressStage)) {
        return res.status(400).json({ success: false, message: `progressStage must be one of: ${ACTIVITY_PROGRESS_STAGE_CODES.join(", ")}` });
      }
      activity.progressStage = req.body.progressStage;
    }
    if (req.body?.resolution !== undefined) {
      if (req.body.resolution !== null && !ACTIVITY_RESOLUTION_CODES.includes(req.body.resolution)) {
        return res.status(400).json({ success: false, message: `resolution must be one of: ${ACTIVITY_RESOLUTION_CODES.join(", ")}` });
      }
      activity.resolution = req.body.resolution || undefined;
    }
    if (req.body?.status !== undefined) {
      if (!ACTIVITY_STATUS_CODES.includes(req.body.status)) {
        return res.status(400).json({ success: false, message: `status must be one of: ${ACTIVITY_STATUS_CODES.join(", ")}` });
      }
      const wasCompleted = activity.status === "completed";
      activity.status = req.body.status;
      if (req.body.status === "completed" && !wasCompleted) {
        activity.completedAt = new Date();
        activity.completedBy = actor(req);
      } else if (req.body.status !== "completed") {
        // Reopening a done/cancelled reminder back to planned, or dismissing
        // one — either way it's no longer "done", so the completion stamp
        // from a previous pass shouldn't linger and misreport when it was
        // actually finished.
        activity.completedAt = undefined;
        activity.completedBy = undefined;
      }
      // Reopening to "planned" resets the working sub-state too, unless the
      // caller explicitly set one in this same request — a reopened reminder
      // starts fresh, not stuck showing "Paused" from before it was resolved.
      if (req.body.status === "planned" && req.body.progressStage === undefined) {
        activity.progressStage = "planned";
      }
      // Landing anywhere other than "completed" without an EXPLICIT
      // resolution in this same request clears whatever resolution is
      // already on the row — a reopened reminder, or a bare Dismiss, is not
      // still carrying "Approved"/"Rejected" from a previous close. (Caught
      // live: reopening to Planned left `resolution: "approved"` stuck on an
      // otherwise-open reminder, which `reminderStatusOf` on the frontend
      // ignores while status stays "planned" — so purely a data-hygiene
      // issue today, but one worth not shipping.)
      if (req.body.status !== "completed" && req.body.resolution === undefined) {
        activity.resolution = undefined;
      }
      // A resolved reminder (completed) with no explicit resolution, and no
      // resolution already sitting on the row, gets the plain default —
      // "done". The `!activity.resolution` guard matters here: without it, a
      // status:"completed" PATCH that only touches something else (subject,
      // priority) on an already-Approved reminder would silently reset it to
      // "done".
      if (req.body.status === "completed" && req.body.resolution === undefined && !activity.resolution) {
        activity.resolution = "done";
      }
    }
    activity.updatedBy = actor(req);
    await activity.save();

    // Moving any follow-up can change which one is the headline.
    if (activity.activityType === "follow_up") {
      const openNow = await Activity.find({
        leadId: lead._id, isActive: true, activityType: "follow_up", status: "planned",
      }).lean();
      lead.nextFollowUpAt = nextFollowUpAt(openNow);
      lead.updatedBy = actor(req);
      await lead.save();
    }

    await recordChange(req, {
      departmentSlug: "sales", entity: "lead", entityId: lead._id, entityLabel: displayName(lead),
      action: "update", summary: `Updated: ${activity.subject} (${lead.leadId})`,
    });
    res.json({ success: true, lead, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * Create one Activity for a Lead — the shared body of `POST /:id/activities`,
 * extracted 28 Aug 2026 so the new auto-sync route (below) creates activities
 * through EXACTLY the same logic a person logging one by hand goes through:
 * the same validation, the same `recordChange` audit entry, the same
 * `lastContactedAt` update on a genuine two-way outcome, the same follow-up
 * headline recompute. A second, hand-rolled `Activity.create` call for
 * auto-sync would inevitably drift from this one over time; there is now only
 * one implementation of "what happens when an activity is logged for a Lead".
 *
 * Throws `{status, message}` on a validation failure — callers decide how to
 * report it (a request throws it back as an HTTP error; the bulk auto-sync
 * loop below catches it per-item and keeps going).
 */
async function createLeadActivity(req, lead, body = {}) {
  /* ── A DRAFT IS A RECORD YOU WORK, NOT ONE YOU WAIT ON ────────────────────
     This threw for any Draft, which is why the canonical POST /:id/activities
     appeared to accept a Prospect and then refused it one level down. A
     Prospect is precisely the record being rung and mailed to discover whether
     interest exists; the outreach has to be loggable while it is still a
     Prospect or it is not logged at all.

     Nothing that made this safe was in this check. Callers have already proved
     company scope, ownership (isRestricted/canSeeRestricted) and that the
     record is not archived or submitted. Writing an Activity touches neither
     captureStatus nor qualificationState, so a Prospect stays a Prospect. */
  const { activityType, subject } = body;
  if (!activityType || !subject) {
    throw { status: 400, message: "activityType and subject are required." };
  }
  if (body.outcome && !ACTIVITY_OUTCOME_CODES.includes(body.outcome)) {
    throw { status: 400, message: `outcome must be one of: ${ACTIVITY_OUTCOME_CODES.join(", ")}` };
  }
  if (body.channel && !ACTIVITY_CHANNEL_CODES.includes(body.channel)) {
    throw { status: 400, message: `channel must be one of: ${ACTIVITY_CHANNEL_CODES.join(", ")}` };
  }
  if (body.direction && !ACTIVITY_DIRECTION_CODES.includes(body.direction)) {
    throw { status: 400, message: `direction must be one of: ${ACTIVITY_DIRECTION_CODES.join(", ")}` };
  }

  const isTask = ACTIVITY_TASK_TYPES.has(activityType);
  const data = {
    leadId: lead._id,
    activityType,
    subject,
    description: body.description,
    activityDate: body.activityDate,
    dueDate: body.dueDate,
    priority: body.priority,
    contactId: body.contactId,
    /* Which person, and what they were called at the time. `leadContactId` is
       resolved against this Lead's own contacts; the name is derived from the
       match rather than trusted from the request. */
    ...resolveLeadContact(lead, body.leadContactId, body.contactName),
    channel: body.channel,
    direction: body.direction,
    visibility: body.visibility,
    outcome: body.outcome,
    nextActionDate: body.nextActionDate,
    createdBy: actor(req),
    updatedBy: actor(req),
    ownerId: body.ownerId || req.user?.id,
    ownerName: body.ownerName || req.user?.name,
  };
  if (isTask) {
    if (!data.dueDate) throw { status: 400, message: "A task or follow-up needs a due date." };
    if (!data.ownerId) throw { status: 400, message: "A task or follow-up needs an owner." };
    data.status = "planned";
  } else {
    data.status = "completed";
    data.completedAt = new Date();
    data.completedBy = actor(req);
  }

  const activity = await Activity.create(data);
  await recordChange(req, {
    departmentSlug: "sales",
    entity: "crm-activity",
    entityId: activity._id,
    entityLabel: activity.subject,
    action: "create",
    summary: `${activity.activityType}: ${activity.subject} (Lead ${displayName(lead)})`,
    after: activity.toObject(),
  });

  if (!isTask && SUCCESSFUL_CONTACT_OUTCOMES.has(data.outcome)) {
    await Lead.updateOne(await scoped(req, { _id: lead._id }), { $set: { lastContactedAt: data.activityDate || new Date(), updatedBy: actor(req) } },);
  }

  if (isTask && data.activityType === "follow_up") {
    const openNow = await Activity.find({
      leadId: lead._id, isActive: true, activityType: "follow_up", status: "planned",
    }).lean();
    await Lead.updateOne(await scoped(req, { _id: lead._id }), { $set: { nextFollowUpAt: nextFollowUpAt(openNow), updatedBy: actor(req) } },);
  }

  return activity;
}

router.post("/:id/activities", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }))
      /* `contacts` is here because an Activity may name one of them, and
         `resolveLeadContact` resolves that id against this Lead's own people
         rather than trusting it. Narrowing it out made every contact-targeted
         log look like a foreign id. */
      .select("_id firstName lastName captureStatus createdBy assignedTo assignedToName contacts")
      .lean();
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;

    const activity = await createLeadActivity(req, lead, req.body || {});
    res.status(201).json({ success: true, activity });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ success: false, message: err.message });
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/cms/crm/leads/:id/activities/auto-sync
 *
 * "Whatever message is detected for that customer's number, auto-log it — no
 * need to ask for the logs. Same for call, same for email." (28 Aug 2026,
 * explicit request.) Finds every real call/WhatsApp/email already matched to
 * this Lead and logs whichever of them isn't logged yet, with ZERO manual tap
 * — this is the one-request version of pressing "Log this call" on every row
 * QuickCall/QuickMessage/QuickEmail would otherwise have shown one at a time.
 *
 * REUSES THE SAME SAFEGUARDS the evidence GATE already earned the hard way
 * (27–28 Aug 2026): a channel whose phone/email is shared with another Lead
 * (`ambiguousContactChannels`) is skipped here too, for the identical reason —
 * auto-CREATING a permanent Activity record on an ambiguous match is a WORSE
 * mistake than a checkmark that's merely wrong, because a bad checkmark
 * disappears on refresh and a bad Activity sits in this Lead's timeline
 * forever, attributed to a contact that may never have happened. Ambiguous
 * channels are reported back (`skippedAmbiguous`) rather than silently
 * dropped, so the caller can say why, and the ONE-TAP manual log in
 * QuickCall/QuickMessage/QuickEmail stays available specifically for them —
 * this endpoint narrows what needs a human decision, it does not remove the
 * option to make one.
 *
 * De-duplicates against Activities THIS ROUTE (or a person) already created,
 * using the exact same "within 10 minutes" proximity match the frontend
 * panels use to decide what still needs logging — so calling this twice, or
 * calling it after someone manually logged one row, never double-logs.
 *
 * Email is scoped to the CALLER's own connected Gmail (`req.user.employeeId`)
 * — see services/gmailLeadMatch.service.js's header for why this can only
 * ever run inside an authenticated request, never a background job.
 */
router.post("/:id/activities/auto-sync", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }))
      /* `createdBy` and `assignedTo` are what `canSeeRestricted` reads. Without
         them the ownership test could not pass and this route answered 403 to
         the owner of any restricted record — invisible until Prospects began
         reaching it, because the Draft early-return used to sit just below. */
      .select("_id firstName lastName company phone whatsapp email contacts captureStatus createdBy assignedTo")
      .lean();
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    /* Auto-sync used to return an empty result for a Draft. A Prospect is the
       record most likely to have real call and message evidence and no typed
       activity yet, so it was switched off exactly where it was most useful.
       The ambiguity guard below is unchanged and still refuses to attribute a
       call or message whose number or address matches more than one record. */

    const TEN_MIN = 10 * 60 * 1000;
    const leadName = displayName(lead);
    const existing = await Activity.find({
      leadId: lead._id, isActive: true, activityType: { $in: ["call", "message", "email_log"] },
    }).select("activityType activityDate leadContactId").lean();

    /* ── TWO PEOPLE AT ONCE ARE NOT ONE EVENT ───────────────────────────
       The window used to be per CHANNEL: any call already logged within ten
       minutes suppressed the next one. Ring the merchandiser and then the
       purchase manager about the same order — as anybody would — and the
       second call silently never appeared.

       Partitioned by contact now. An Activity with no contact (legacy history,
       or evidence too ambiguous to attribute) stays in a shared bucket that
       ALSO suppresses re-importing that same source event, so an old
       unassigned row still stops a duplicate of itself. The ten-minute
       tolerance inside one contact/source identity is unchanged. */
    const key = (type, contactId) => `${type}::${contactId ? String(contactId) : "-"}`;
    const loggedTimes = new Map();
    for (const a of existing) {
      const t = new Date(a.activityDate || 0).getTime();
      if (!t) continue;
      const k = key(a.activityType, a.leadContactId);
      if (!loggedTimes.has(k)) loggedTimes.set(k, []);
      loggedTimes.get(k).push(t);
    }
    /* ── THE BUCKETS DO NOT MIX ─────────────────────────────────────────
       This used to fold every unattributed Activity into each contact's
       times, on the reasoning that an event logged before it could be
       attributed is still the same event. That needs a way to RECOGNISE the
       event, and there is none — `Activity` stores no source identity, so the
       only thing compared is a timestamp, which cannot tell "the same call,
       now attributed" from "a different call to a different person three
       minutes later".

       The cost of mixing was the exact defect this window was meant to fix:
       one unassigned call at 10:00 suppressed every contact's 10:03 call. Each
       bucket now deduplicates against itself alone. */
    const timesFor = (type, contactId) => loggedTimes.get(key(type, contactId)) || [];
    const isNew = (t, list) => !list.some((lt) => Math.abs(lt - t) < TEN_MIN);
    const remember = (type, contactId, t) => {
      const k = key(type, contactId);
      if (!loggedTimes.has(k)) loggedTimes.set(k, []);
      loggedTimes.get(k).push(t);
    };

    /* ── WHICH PERSON DID THIS BELONG TO? ────────────────────────────────
       Evidence arrives with a number or an address, not a name. When exactly
       ONE of this Lead's contacts owns that identity, the Activity can say who
       it was with. When two of them share it — a shared desk line, a generic
       purchasing@ mailbox — there is no way to tell, and guessing would put a
       call in the wrong person's history where nobody would ever check it.

       So this returns a contact or nothing, and nothing is a perfectly good
       answer: the Activity is still logged, still truthful, and stays at the
       Lead level with the external name the device reported. That mirrors the
       existing ambiguity policy one level down — that one refuses to attribute
       across RECORDS, this one across PEOPLE within a record.

       Normalisation matches what the Lead model stores (see its contact hook),
       so a "+91 98765 00011" in the call log finds a contact saved as
       "9876500011". */
    /* ── RESOLVING ONE EVENT, NOT A WHOLE CHANNEL ───────────────────────
       The previous version turned a shared identity into `{}` — no contact —
       and then logged the evidence at Lead level anyway. That is the safety
       rule inverted: an identity belonging to two Leads means the event might
       be the OTHER customer's, and copying it here duplicates potentially
       private correspondence onto a record it may have nothing to do with.
       Dropping the attribution does not make that safe; skipping does.

       Four outcomes, because they genuinely differ:
         unique + not shared  → log it, and say who it was with
         shared across Leads  → skip the event entirely
         ambiguous inside     → log at Lead level; both people are ours
         no contact match     → the legacy channel guard decides

       And the guard is per EVENT now, not per channel: a duplicated top-level
       phone no longer silences a call that uniquely belongs to one of this
       record's own contacts. */
    const hasContacts = (lead.contacts || []).length > 0;

    /* Is THIS identity one that also exists on another Lead? Asked of the
       identity the event arrived on, not of the person — a contact with a
       shared mailbox and a private mobile is ambiguous on one and unique on
       the other. */
    const identityShared = (kind, raw) => {
      const value = kind === "email" ? String(raw || "").trim().toLowerCase() : phoneTail(raw);
      if (!value) return false;
      return sharedIdentities.has(`${kind}:${value}`);
    };

    /* ── RESOLVING ONE EVENT ────────────────────────────────────────────
       Four outcomes, because they genuinely differ:
         unique + not shared  → log it, and say who it was with
         shared across Leads  → skip the event entirely
         several of OUR people, none shared → Lead level; it is still ours
         several of ours, one shared        → skip; it may be the other
                                              customer's correspondence
         no contact match     → the legacy channel guard decides

       Dropping only the attribution was never enough: an identity belonging to
       two Leads means the event might be the OTHER customer's, and copying it
       here duplicates potentially private correspondence onto a record it may
       have nothing to do with. */
    const resolveEvidence = (identity, channelAmbiguous) => {
      const kind = identity.email ? "email" : "phone";
      const raw = identity.email || identity.phone;
      if (!hasContacts) {
        return channelAmbiguous ? { skip: true } : { attribution: {} };
      }
      if (identityShared(kind, raw)) return { skip: true };
      const hits = matchContacts(lead.contacts, identity);
      if (hits.length === 1) {
        return { attribution: { leadContactId: hits[0]._id, contactName: hits[0].name } };
      }
      /* Two of OUR people on one number, and that number is not on anybody
         else's record — unattributable, but still this Lead's. */
      if (hits.length > 1) return { attribution: {} };
      return channelAmbiguous ? { skip: true } : { attribution: {} };
    };

    const resolveEmailEvidence = (addresses, exclude, channelAmbiguous) => {
      if (!hasContacts) {
        return channelAmbiguous ? { skip: true } : { attribution: {} };
      }
      const mine = String(exclude || "").trim().toLowerCase();
      const relevant = addresses.filter((a) => a && a !== mine);
      /* Any address on this message that is shared with another Lead takes the
         whole message out — we cannot tell whose thread it is. */
      if (relevant.some((a) => identityShared("email", a))) return { skip: true };

      const found = new Map();
      for (const addr of relevant) {
        for (const c of matchContacts(lead.contacts, { email: addr })) found.set(String(c._id), c);
      }
      if (found.size === 1) {
        const c = [...found.values()][0];
        return { attribution: { leadContactId: c._id, contactName: c.name } };
      }
      if (found.size > 1) return { attribution: {} };
      return channelAmbiguous ? { skip: true } : { attribution: {} };
    };

    const parseAddresses = parseEmailAddresses;
    const waBody = whatsappBody;

    const ambiguous = await ambiguousContactChannels(lead, req);
    /* Per-contact cross-record uniqueness — the top-level check above cannot
       see a secondary contact's identity. */
    const sharedIdentities = await ambiguousContactIdentities(lead, req);
    const logged = { calls: 0, messages: 0, emails: 0 };
    const skippedCounts = { calls: 0, messages: 0, emails: 0 };

    // ── Calls ──────────────────────────────────────────────────────────────
    const calls = await matchedCallEvents(lead, req);
    {
      for (const c of calls) {
        if (!c.startTime) continue;
        const t = new Date(c.startTime).getTime();
        /* Per event: a duplicated top-level phone no longer silences a call
           that uniquely belongs to one of this record's own contacts, and a
           number shared with another Lead is skipped rather than downgraded. */
        const res = resolveEvidence({ phone: c.phoneNumber }, ambiguous.phone);
        if (res.skip) { skippedCounts.calls++; continue; }
        const who = res.attribution;
        if (!isNew(t, timesFor("call", who.leadContactId))) continue;
        const connected = c.received === true;
        try {
          await createLeadActivity(req, lead, {
            activityType: "call",
            subject: connected ? "Call (from call log)" : c.rejected ? "Call rejected (from call log)" : "Call attempted (from call log)",
            direction: c.direction === "INCOMING" ? "inbound" : "outbound",
            /* A unique contact match names the person; otherwise the device's
               own label, or the record. `contactName` is only used when no
               contact was resolved — createLeadActivity derives it from the id
               whenever one is present. */
            contactName: c.contactName || leadName,
            ...who,
            activityDate: new Date(c.startTime).toISOString(),
            outcome: connected ? "replied_connected" : "no_answer",
            /* `hasRecording` is a virtual and `.lean()` strips it, so this
               branch never fired. `driveFileId` is what the virtual reads. */
            description: c.driveFileId ? "Auto-logged from a synced call recording, not typed in by hand." : "Auto-logged from the phone's call log, not typed in by hand.",
          });
          remember("call", who.leadContactId, t);
          logged.calls++;
        } catch (e) {
          console.error(`[leads] auto-sync call failed for ${lead._id}:`, e.message || e);
        }
      }
    }

    // ── WhatsApp ───────────────────────────────────────────────────────────
    const msgs = await matchedWhatsAppMessages(lead, req);
    {
      for (const m of msgs) {
        if (!m.timestamp) continue;
        const t = new Date(m.timestamp).getTime();
        const res = resolveEvidence({ phone: m.waId }, ambiguous.phone);
        if (res.skip) { skippedCounts.messages++; continue; }
        const who = res.attribution;
        if (!isNew(t, timesFor("message", who.leadContactId))) continue;
        const incoming = m.direction === "incoming";
        try {
          await createLeadActivity(req, lead, {
            activityType: "message",
            channel: "whatsapp",
            subject: incoming ? "WhatsApp reply (from chat log)" : "WhatsApp message (from chat log)",
            direction: incoming ? "inbound" : "outbound",
            contactName: leadName,
            ...who,
            activityDate: new Date(m.timestamp).toISOString(),
            outcome: incoming ? "replied_connected" : undefined,
            description: `Auto-logged from the synced WhatsApp chat, not typed in by hand.${waBody(m) ? ` "${waBody(m)}"` : ""}`,
          });
          remember("message", who.leadContactId, t);
          logged.messages++;
        } catch (e) {
          console.error(`[leads] auto-sync message failed for ${lead._id}:`, e.message || e);
        }
      }
    }

    // ── Email — only inside the caller's own authenticated request ────────
    if (req.user?.employeeId) {
      try {
        const { emailsForLead } = require("../../../services/gmailLeadMatch.service");
        const out = await emailsForLead({ employeeId: req.user.employeeId, leadId: lead._id });
        if (out?.connected) {
          for (const m of out.messages || []) {
            if (!m.sentAt) continue;
            const t = new Date(m.sentAt).getTime();
            const inbound = m.direction === "inbound";
            /* The customer's side of the exchange, never the connected
               mailbox. A shared address that two contacts both carry resolves
               to nothing — `contactFor` returns a match only when exactly one
               person owns it — and the email stays truthfully at Lead level. */
            const res = resolveEmailEvidence(
              inbound ? parseAddresses(m.fromAddress) : parseAddresses(m.to),
              out.connectedEmail,
              ambiguous.email,
            );
            if (res.skip) { skippedCounts.emails++; continue; }
            const who = res.attribution;
            if (!isNew(t, timesFor("email_log", who.leadContactId))) continue;
            try {
              await createLeadActivity(req, lead, {
                activityType: "email_log",
                subject: m.subject || (inbound ? "Email received" : "Email sent"),
                direction: inbound ? "inbound" : "outbound",
                contactName: leadName,
                ...who,
                activityDate: new Date(m.sentAt).toISOString(),
                outcome: inbound ? "replied_connected" : undefined,
                description: `Auto-logged from your connected Gmail, not typed in by hand.${m.snippet ? ` "${m.snippet}"` : ""}`,
              });
              remember("email_log", who.leadContactId, t);
              logged.emails++;
            } catch (e) {
              console.error(`[leads] auto-sync email failed for ${lead._id}:`, e.message || e);
            }
          }
        }
      } catch (e) {
        // No Google connection, no employee record, Gmail unreachable — all
        // non-fatal. Auto-sync degrades to "email skipped" rather than
        // failing the calls/WhatsApp sync that already succeeded above.
        console.error(`[leads] auto-sync email lookup failed for ${lead._id}:`, e.message || e);
      }
    } else if (ambiguous.email) {
      try {
        const { emailsForLead } = require("../../../services/gmailLeadMatch.service");
        const out = await emailsForLead({ employeeId: req.user?.employeeId, leadId: lead._id });
        skippedCounts.emails = out?.messages?.length || 0;
      } catch { /* best-effort count only */ }
    }

    res.json({
      success: true,
      logged,
      skipped: skippedCounts,
      skippedAmbiguous: { phone: ambiguous.phone, email: ambiguous.email },
    });
  } catch (err) {
    console.error("[leads] auto-sync activities failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// POST /api/cms/crm/leads/:id/activity — LEGACY request shape
// ({type, title, description, scheduledAt, outcome}), now translated into a
// shared CRMActivity record instead of appending to the embedded
// `activities[]` (review follow-up). Existing embedded entries from before
// this fix are completely untouched — nothing migrates or deletes them.
// Response stays backward-compatible: `lead` is still returned in the same
// shape callers of this endpoint already expect (its `activities[]` is
// simply unchanged rather than growing by one); `activity` is added
// alongside it, additive only.
router.post("/:id/activity", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findOne(await scoped(req, { _id: req.params.id }));
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    /* Kept in step with the canonical POST /:id/activities, which accepts a
       Draft. Leaving this one refusing would mean the same act succeeding or
       failing depending on which route the caller happened to reach. */

    const { type, title, description, scheduledAt, outcome } = req.body || {};
    // Structured outcome vocabulary (Lead correction chunk) — same rule as
    // the canonical endpoint; a blank/omitted outcome is still fine.
    if (outcome && !ACTIVITY_OUTCOME_CODES.includes(outcome)) {
      return res.status(400).json({ success: false, message: `outcome must be one of: ${ACTIVITY_OUTCOME_CODES.join(", ")}` });
    }
    const activity = await Activity.create({
      leadId: lead._id,
      activityType: LEGACY_LEAD_ACTIVITY_TYPE_TO_CRM[type] || "other",
      subject: title || `Logged ${String(type || "activity").replace(/_/g, " ")}`,
      description,
      activityDate: scheduledAt,
      status: "completed",
      completedAt: new Date(),
      completedBy: actor(req),
      outcome,
      ownerId: req.user?.id,
      ownerName: req.user?.name || "Sales",
      createdBy: actor(req),
      updatedBy: actor(req),
    });
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-activity",
      entityId: activity._id,
      entityLabel: activity.subject,
      action: "create",
      summary: `${activity.activityType}: ${activity.subject} (Lead ${displayName(lead)}, via legacy endpoint)`,
      after: activity.toObject(),
    });

    // lastContactedAt correctness (Lead correction chunk): only for a
    // genuinely successful contact outcome — see the canonical endpoint's own
    // comment. When it doesn't qualify, the Lead itself is left untouched
    // (no unnecessary save/audit entry for a field that didn't change).
    let leadAfter = lead.toObject();
    if (SUCCESSFUL_CONTACT_OUTCOMES.has(outcome)) {
      const before = lead.toObject();
      lead.lastContactedAt = new Date();
      lead.updatedBy = actor(req);
      await lead.save();
      leadAfter = lead.toObject();
      await recordChange(req, {
        departmentSlug: "sales",
        entity: "lead",
        entityId: lead._id,
        entityLabel: displayName(lead),
        action: "update",
        summary: "Activity logged via legacy endpoint (lastContactedAt updated)",
        before,
        after: leadAfter,
      });
    }

    res.json({ success: true, lead: leadAfter, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// DELETE /api/cms/crm/leads/:id — soft delete/archive.
router.delete("/:id", salesAuth, async (req, res) => {
  try {
    const before = await Lead.findOne(await scoped(req, { _id: req.params.id })).lean();
    if (!before)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });

    const lead = await Lead.findOneAndUpdate(await scoped(req, { _id: req.params.id }), { isActive: false, archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },);
    await recordChange(req, {
      departmentSlug: "sales",
      entity: "lead",
      entityId: lead._id,
      entityLabel: displayName(lead),
      // "archive" is not in the shared ChangeLog action enum (only
      // create/update/delete/approve/reject/import/export/other) — using it
      // would be silently swallowed by recordChange's own error handling.
      // "delete" matches both the enum and this endpoint's HTTP verb.
      action: "delete",
      before,
      after: lead.toObject(),
    });
    res.json({ success: true, message: "Lead deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;

/* Exported for tests: the attribution rules, exercised directly rather than
   through a Gmail account, a call log and a WhatsApp conversation. */
module.exports.__attribution = {
  parseEmailAddresses, matchContacts, contactByIdentity, contactByEmailAddresses, whatsappBody,
  ambiguousContactIdentities,
};
