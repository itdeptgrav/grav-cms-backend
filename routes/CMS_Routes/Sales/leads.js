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
const { findLeadDuplicates, findAccountDuplicates } = require("../../../services/crmDuplicates");
const { isSalesManager } = require("../../../services/salesAccess");
const { computeSubmissionReadiness, computeQualificationReadiness } = require("../../../services/leadReadiness");
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
function sanitizeContacts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((c) => c && typeof c === "object" && String(c.name || "").trim())
    .slice(0, 25)
    .map((c) => ({
      name: String(c.name).trim(),
      role: String(c.role || "").trim() || undefined,
      email: String(c.email || "").trim().toLowerCase() || undefined,
      phone: String(c.phone || "").trim() || undefined,
      isDecisionMaker: Boolean(c.isDecisionMaker),
    }));
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
  "estimatedAnnualQuantityConfidence", "estimatedAnnualRevenueConfidence",
  "estimatedUnitPriceConfidence",
];

function pickEditable(body = {}) {
  const out = {};
  for (const key of LEAD_EDITABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
  }
  for (const key of CLEARABLE_ENUM_FIELDS) {
    if (out[key] === "") out[key] = undefined;
  }
  if (Object.prototype.hasOwnProperty.call(out, "contacts")) {
    out.contacts = sanitizeContacts(out.contacts);
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
async function ambiguousContactChannels(lead) {
  try {
    const matches = await findLeadDuplicates(
      Lead,
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

/** Every CallEvent that matches this lead's numbers/names. */
async function matchedCallEvents(lead) {
  try {
    const { identityFor } = require("../../../services/customerIdentityLookup.service");
    const { buildRecordingFilter } = require("../../../services/callRecordingMatch.service");
    const CallEvent = require("../../../models/CallEvent");
    const identity = await identityFor({ leadId: lead._id });
    if (!identity) return [];
    const filter = buildRecordingFilter(identity);
    if (!filter) return [];
    return await CallEvent.find(filter).select("received rejected startTime durationSec driveFileId direction").lean();
  } catch (e) {
    console.error("[leads] call evidence lookup failed:", e.message);
    return [];
  }
}

/** The WhatsApp conversation for this lead's number, if there is one. */
async function matchedWhatsAppMessages(lead) {
  try {
    const WhatsAppConversation = require("../../../models/CMS_Models/Sales/WhatsAppConversation");
    const { WhatsAppMessage } = require("../../../models/CMS_Models/Sales/WhatsAppMessage");
    const tails = [lead.phone, lead.whatsapp, ...((lead.contacts || []).map((c) => c.phone))]
      .map((p) => String(p || "").replace(/\D/g, "").slice(-10))
      .filter((t) => t.length === 10);
    if (!tails.length) return [];
    const conv = await WhatsAppConversation.findOne({
      waId: { $in: [...new Set(tails)].map((t) => new RegExp(`${t}$`)) },
    }).select("_id").lean();
    if (!conv) return [];
    return await WhatsAppMessage.find({ conversationId: conv._id }).select("direction timestamp").lean();
  } catch (e) {
    console.error("[leads] whatsapp evidence lookup failed:", e.message);
    return [];
  }
}

/** Did anyone actually try to reach this lead? Any call, or any message we sent. */
async function hasRealOutreachEvidence(lead) {
  const [calls, msgs, ambiguous] = await Promise.all([
    matchedCallEvents(lead), matchedWhatsAppMessages(lead), ambiguousContactChannels(lead),
  ]);
  // Both channels are matched by phone, so both are withheld together when the
  // phone itself is ambiguous — see ambiguousContactChannels's own comment.
  if (ambiguous.phone) return false;
  // A call that rang counts as an attempt whether or not it connected — that is
  // exactly what "attempted" means.
  return calls.length > 0 || msgs.some((m) => m.direction === "outgoing");
}

/** Did the customer actually respond? A connected call, or a message FROM them. */
async function hasRealTwoWayEvidence(lead) {
  const [calls, msgs, ambiguous] = await Promise.all([
    matchedCallEvents(lead), matchedWhatsAppMessages(lead), ambiguousContactChannels(lead),
  ]);
  if (ambiguous.phone) return false;
  // `received` is the device's own call-log truth, not a duration guess.
  return calls.some((c) => c.received === true) || msgs.some((m) => m.direction === "incoming");
}

// Lead correction chunk — the per-target facts services/leadQualification.js
// needs but cannot look up itself (it stays pure/DB-free by design). Only
// queries what the specific target actually requires.
async function computeTransitionContext(lead, targetState, body = {}) {
  const context = {};
  if (targetState === "contactAttempted") {
    const logged = Boolean(
      await Activity.exists({
        leadId: lead._id,
        isActive: true,
        status: "completed",
        activityType: { $in: OUTREACH_ATTEMPT_ACTIVITY_TYPES },
      }),
    );
    // A LOGGED activity is a salesperson's own claim. Real device/channel
    // evidence is not. Either satisfies the gate (27 Aug 2026, explicit
    // request that these stages "are needed to make it genuine upon fetching
    // the call event schema... so accordingly enable that button"), so a
    // salesperson who actually rang the customer is not blocked merely for
    // not having typed it in afterwards.
    context.hasOutreachAttempt = logged || (await hasRealOutreachEvidence(lead));
  }
  if (targetState === "contacted") {
    const logged = Boolean(
      await Activity.exists({
        leadId: lead._id,
        isActive: true,
        status: "completed",
        outcome: { $in: Array.from(SUCCESSFUL_CONTACT_OUTCOMES) },
      }),
    );
    context.hasSuccessfulContact = logged || (await hasRealTwoWayEvidence(lead));
  }
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

    let leadsQuery = Lead.find(filter)
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
      Lead.countDocuments(filter),
      leadsQuery.lean(),
    ]);

    // Pipeline stats — OPT-IN via ?stats=1 (27 Aug 2026, explicit performance
    // request: "currently it is taking too much time to load the page of
    // prospects, leads, pipeline, order book").
    //
    // This used to run unconditionally on every single list load: an unbounded
    // `Lead.find({...}).lean()` over the WHOLE collection, pulling every active
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
      const grouped = await Lead.aggregate([
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
    const { company, email, phone, website, excludeId } = req.body || {};
    const candidate = { company, email, phone, website };
    const [leadMatches, accountMatches] = await Promise.all([
      findLeadDuplicates(Lead, candidate, excludeId || null),
      findAccountDuplicates(
        Account,
        { companyName: company, website, primaryEmail: email, primaryPhone: phone },
        null,
      ),
    ]);
    res.json({
      success: true,
      leadMatches,
      accountMatches,
      hasMatches: leadMatches.length > 0 || accountMatches.length > 0,
    });
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

    const lead = await createWithRef(Lead, data);
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
    res.status(400).json({ success: false, message: err.message });
  }
});

// GET /api/cms/crm/leads/:id
router.get("/:id", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
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
    const lead = await Lead.findById(req.params.id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    const before = lead.toObject();

    const patchData = pickEditable(req.body);
    if (!(await authorizeOwnerSourceChange(req, patchData))) {
      return res.status(403).json({ success: false, message: "Only a Sales manager can reassign a Lead's owner or source." });
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
        const context = targetState ? await computeTransitionContext(lead, targetState, req.body) : {};
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
    res.status(400).json({ success: false, message: err.message });
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
    const lead = await Lead.findById(req.params.id);
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
      const context = targetState ? await computeTransitionContext(lead, targetState, req.body) : {};
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

    const lead = await Lead.findById(req.params.id);
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

    const context = await computeTransitionContext(lead, qualificationState, { duplicateOf });
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
async function checkStrongDuplicates(lead) {
  const candidate = { company: lead.company, email: lead.email, phone: lead.phone, website: lead.website };
  const [leadMatches, accountMatches] = await Promise.all([
    findLeadDuplicates(Lead, candidate, lead._id),
    findAccountDuplicates(
      Account,
      { companyName: lead.company, website: lead.website, primaryEmail: lead.email, primaryPhone: lead.phone },
      null,
    ),
  ]);
  const hasStrong = leadMatches.some((m) => m.confidence === "high") || accountMatches.some((m) => m.confidence === "high");
  return { leadMatches, accountMatches, hasUnreviewedStrongDuplicates: hasStrong && !lead.duplicateReviewedAt };
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
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "Set up the customer once the Prospect is an Active Lead." });
    }

    // Already linked — hand back the same account, never a second one.
    if (lead.accountId) {
      const existing = await Account.findById(lead.accountId).lean();
      if (existing) return res.json({ success: true, accountId: String(existing._id), account: existing, created: false });
      // Dangling link (account was deleted) — fall through and re-create.
    }

    const companyName =
      String(lead.company || "").trim() ||
      [lead.firstName, lead.lastName].filter(Boolean).join(" ").trim() ||
      "New customer";
    const account = await Account.create({
      companyName,
      displayName: companyName,
      assignedTo: lead.assignedTo || req.user?.id,
      assignedToName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    lead.accountId = account._id;
    await lead.save();

    await recordChange(req, {
      departmentSlug: "sales",
      entity: "crm-account",
      entityId: account._id,
      entityLabel: account.companyName,
      action: "create",
      summary: `Created account ${account.accountId} — ${account.companyName} (customer setup on Lead ${lead.leadId || lead._id})`,
      after: account.toObject(),
    });

    res.status(201).json({ success: true, accountId: String(account._id), account: account.toObject(), created: true });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.patch("/:id/next-action", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "A Prospect sets its first action in Prospect Setup — start working the Lead first." });
    }

    const subject = String(req.body?.subject || "").trim();
    if (!subject) return res.status(400).json({ success: false, message: "A next action needs a short description." });
    const due = req.body?.dueDate ? new Date(req.body.dueDate) : null;
    if (!due || Number.isNaN(due.getTime())) return res.status(400).json({ success: false, message: "A next action needs a valid due date." });

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
        await canonical.save();
        activity = canonical;
      } else {
        activity = await Activity.create({
          leadId: lead._id, activityType: "follow_up", subject, dueDate: due, status: "planned",
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
        await Lead.updateOne({ _id: lead._id }, leadPrevNext ? { $set: { nextFollowUpAt: leadPrevNext } } : { $unset: { nextFollowUpAt: "" } });
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
    const lead = await Lead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    const { leadMatches, accountMatches } = await checkStrongDuplicates(lead);
    const isDraft = lead.captureStatus === "draft";
    const { checks, ready } = isDraft ? computeSubmissionReadiness(lead) : { checks: [], ready: false };
    const qualification = isDraft ? null : computeQualificationReadiness(lead);
    res.json({ success: true, checks, ready, leadMatches, accountMatches, qualification });
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
    const lead = await Lead.findById(req.params.id);
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
    const lead = await Lead.findById(req.params.id);
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

// POST /api/cms/crm/leads/:id/convert-to-active — the direct path (20 Aug
// 2026, explicit request): the salesperson converts a ready Prospect
// straight to an Active Lead, no HOD review in between. Same readiness gate
// /submit enforced, same create-Activity-then-flip-then-rollback reliability
// pattern /approve uses — just one call instead of submit-then-approve, and
// reviewStatus never passes through "submitted" (so the Prospect is never
// locked read-only waiting on anyone). /submit, /approve, /return-for-info
// and /reject below are left in place — nothing forces their use anymore,
// but removing working, reachable routes wasn't asked for.
router.post("/:id/convert-to-active", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
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
    const { checks, ready } = computeSubmissionReadiness(lead);
    if (!ready) {
      return res.status(400).json({
        success: false,
        message: "This Prospect isn't ready to convert yet.",
        checks,
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
      subject: String(lead.pendingFirstAction.subject).trim(),
      description: lead.pendingFirstAction.notes ? String(lead.pendingFirstAction.notes).trim() : undefined,
      dueDate: lead.pendingFirstAction.dueDate,
      status: "planned",
      ownerId: lead.assignedTo || req.user?.id,
      ownerName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    try {
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
    const lead = await Lead.findById(req.params.id);
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
    const { checks, ready } = computeSubmissionReadiness(lead);
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

// POST /api/cms/crm/leads/:id/convert-to-active — the DIRECT path.
//
// Prospect Setup's own button (DraftWorkspace.js) has called this since the
// review hop was dropped on 20 Aug 2026 — "Send to HOD and then HOD approval…
// these are not needed" — but the route was never written, so the button has
// been posting into a 404 and no Prospect could reach Active Leads through the
// UI at all. Written 22 Aug 2026.
//
// It is /approve minus the review state machine, and nothing else:
//
//   • No applyApprove — that asserts the Prospect is AWAITING REVIEW, which is
//     exactly the hop this path removes. `reviewStatus` is still stamped
//     "approved" so the record reads consistently to everything that displays
//     it (leadReview.js, the Prospects filters, the workspace chip).
//   • The readiness CHECKLIST still gates it. The review hop was removed; the
//     bar was not. The UI disables the button on the same computation, so this
//     is the server refusing what the client already refuses — not a new rule.
//   • Same create-Activity-then-flip-then-rollback order as /approve, for the
//     same reason: an Active Lead must never exist without its first follow-up,
//     and a failed flip must not strand an Activity.
//
// /approve stays exactly as it is. Nothing is torn out — a workflow that does
// route Prospects through a reviewer still works.
router.post("/:id/convert-to-active", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (lead.captureStatus !== "draft") {
      return res.status(400).json({
        success: false,
        message: lead.captureStatus === "active"
          ? "This is already an Active Lead."
          : "Only a Prospect can be converted to an Active Lead.",
      });
    }

    const { checks, ready } = computeSubmissionReadiness(lead);
    if (!ready) {
      return res.status(400).json({
        success: false,
        message: "This Prospect isn't ready to become an Active Lead yet.",
        checks,
      });
    }

    // Belt and braces: readiness covers the first action, but this route
    // dereferences it below and a 500 would be a poor way to say so.
    const first = lead.pendingFirstAction || {};
    if (!String(first.subject || "").trim() || !first.dueDate) {
      return res.status(400).json({
        success: false,
        message: "Set the first follow-up — an Active Lead starts with something scheduled.",
      });
    }

    const before = lead.toObject();

    // Activity FIRST, flip second, roll the Activity back if the flip fails.
    const activity = await Activity.create({
      leadId: lead._id,
      activityType: "follow_up",
      subject: String(first.subject).trim(),
      description: first.notes ? String(first.notes).trim() : undefined,
      dueDate: first.dueDate,
      status: "planned",
      ownerId: lead.assignedTo || req.user?.id,
      ownerName: lead.assignedToName || req.user?.name,
      createdBy: actor(req),
      updatedBy: actor(req),
    });

    try {
      lead.captureStatus = "active";
      // qualificationState is untouched — it stays "new". Converting says this
      // is worth working, not that it has been qualified.
      lead.reviewStatus = "approved";
      lead.reviewedAt = new Date();
      lead.reviewedBy = actor(req);
      lead.reviewReason = undefined;
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
    const lead = await Lead.findById(req.params.id);
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
    const lead = await Lead.findById(req.params.id);
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
    const lead = await Lead.findById(req.params.id);
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
// isRestricted/canSeeRestricted rule, plus refuses entirely for a still-Draft
// Lead — a Draft has no operational Activities to expose (see
// pendingFirstAction instead).
router.get("/:id/activities", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .select("_id captureStatus createdBy assignedTo")
      .lean();
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "Prospects don't have Activities yet — start working the Lead first." });
    }

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
    const lead = await Lead.findById(req.params.id);
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

router.post("/:id/activities", salesAuth, async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id)
      .select("_id firstName lastName captureStatus createdBy assignedTo assignedToName")
      .lean();
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    // Lead correction chunk: a Draft has no operational Activities yet — its
    // "first action" lives at pendingFirstAction until POST /:id/approve.
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "Prospects don't have Activities yet — start working the Lead first." });
    }

    const { activityType, subject } = req.body || {};
    if (!activityType || !subject) {
      return res.status(400).json({ success: false, message: "activityType and subject are required." });
    }
    // Structured outcome vocabulary (Lead correction chunk) — enforced here,
    // at the Lead-scoped endpoint, rather than on the shared Activity model
    // (which also serves free-text Account/Journey activities untouched by
    // this chunk).
    if (req.body.outcome && !ACTIVITY_OUTCOME_CODES.includes(req.body.outcome)) {
      return res.status(400).json({ success: false, message: `outcome must be one of: ${ACTIVITY_OUTCOME_CODES.join(", ")}` });
    }
    // Interaction metadata (command-centre chunk) — validated here, at the
    // Lead-scoped endpoint, like `outcome`; blank/omitted is always fine.
    if (req.body.channel && !ACTIVITY_CHANNEL_CODES.includes(req.body.channel)) {
      return res.status(400).json({ success: false, message: `channel must be one of: ${ACTIVITY_CHANNEL_CODES.join(", ")}` });
    }
    if (req.body.direction && !ACTIVITY_DIRECTION_CODES.includes(req.body.direction)) {
      return res.status(400).json({ success: false, message: `direction must be one of: ${ACTIVITY_DIRECTION_CODES.join(", ")}` });
    }

    const isTask = ACTIVITY_TASK_TYPES.has(activityType);
    const data = {
      leadId: lead._id,
      activityType,
      subject,
      description: req.body.description,
      activityDate: req.body.activityDate,
      dueDate: req.body.dueDate,
      priority: req.body.priority,
      contactId: req.body.contactId,
      contactName: req.body.contactName,
      channel: req.body.channel,
      direction: req.body.direction,
      visibility: req.body.visibility,
      outcome: req.body.outcome,
      nextActionDate: req.body.nextActionDate,
      createdBy: actor(req),
      updatedBy: actor(req),
      ownerId: req.body.ownerId || req.user?.id,
      ownerName: req.body.ownerName || req.user?.name,
    };
    if (isTask) {
      if (!data.dueDate) return res.status(400).json({ success: false, message: "A task or follow-up needs a due date." });
      if (!data.ownerId) return res.status(400).json({ success: false, message: "A task or follow-up needs an owner." });
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

    // lastContactedAt correctness (Lead correction chunk): update ONLY for a
    // genuinely successful two-way contact outcome — not for every logged
    // interaction (a "No Answer" is an attempt, not a contact), and never for
    // a forward-looking task/follow-up (nothing was contacted yet).
    if (!isTask && SUCCESSFUL_CONTACT_OUTCOMES.has(data.outcome)) {
      await Lead.updateOne(
        { _id: lead._id },
        { $set: { lastContactedAt: data.activityDate || new Date(), updatedBy: actor(req) } },
      );
    }

    // A planned FOLLOW-UP added here can be sooner than whatever the Lead was
    // banding on, so the headline has to be recomputed. This route created the
    // Activity and then left `nextFollowUpAt` untouched, which was survivable
    // only while `next-action` cancelled everything else — with several open
    // follow-ups now legal, a stale date would put the Lead in the wrong
    // urgency band. An internal `task` deliberately does not move it; see
    // services/leadNextAction.js for why.
    if (isTask && data.activityType === "follow_up") {
      const openNow = await Activity.find({
        leadId: lead._id, isActive: true, activityType: "follow_up", status: "planned",
      }).lean();
      await Lead.updateOne(
        { _id: lead._id },
        { $set: { nextFollowUpAt: nextFollowUpAt(openNow), updatedBy: actor(req) } },
      );
    }

    res.status(201).json({ success: true, activity });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
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
    const lead = await Lead.findById(req.params.id);
    if (!lead)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });
    if (isRestricted(lead) && !(await canSeeRestricted(lead, req))) {
      return res.status(403).json({ success: false, message: "You don't have access to this Lead." });
    }
    if (refuseIfLocked(res, lead)) return;
    // Lead correction chunk: same rule as the canonical endpoint above — a
    // Draft has no operational Activities yet.
    if (lead.captureStatus === "draft") {
      return res.status(400).json({ success: false, message: "Prospects don't have Activities yet — start working the Lead first." });
    }

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
    const before = await Lead.findById(req.params.id).lean();
    if (!before)
      return res
        .status(404)
        .json({ success: false, message: "Lead not found" });

    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      { isActive: false, archivedAt: new Date(), archivedBy: actor(req) },
      { new: true },
    );
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
