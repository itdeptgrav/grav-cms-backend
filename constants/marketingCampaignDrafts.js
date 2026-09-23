// constants/marketingCampaignDrafts.js
//
// THE GRAV CAMPAIGN PLAN: ITS LIFECYCLE, AND WHAT EACH STATE DOES NOT MEAN.
//
// ── A GRAV CAMPAIGN IS A PLAN, NOT AN ADVERTISEMENT ────────────────────────
// Nothing in this chunk reaches Google Ads or Meta. A record here is a document
// GRAV owns: what somebody intends to run, who approved it, and on what terms.
// `approved` means a human with authority agreed to the plan. It does not mean
// anything exists in an advertising account, no budget is committed, and no money
// can be spent as a consequence of it.
//
// That distinction is the whole reason the states are named the way they are.
// `approved` is the obvious word for the end of an approval flow and it is also
// the word somebody will read as "live". So every label and every `means` below
// says what the state does not imply, and the deployment step that would make a
// plan real is a separate chunk with its own record.
//
// ── AND THE ENGINE BEHIND EMAIL IS STILL INVISIBLE ─────────────────────────
// `email` is one of the channels a plan may select. Nothing here names what
// sends it.
"use strict";

const pair = (code, label, extra = {}) => Object.freeze({ code, label, ...extra });
const codes = (list) => Object.freeze(list.map((x) => x.code));

/* ── THE LIFECYCLE ──────────────────────────────────────────────────────────
   Six states. Three are the happy path and three are the ways a plan stops.

   `returned` exists because "rejected" and "needs another look" are different
   decisions with different consequences, and collapsing them would make an
   approver choose between killing a plan and approving one they have questions
   about. A returned plan is editable again; a rejected one is finished. */
const DRAFT_STATES = [
  pair("draft", "Draft", {
    means: "Being written. Editable by Marketing, visible to nobody who has to decide on it yet.",
    editable: true,
    terminal: false,
  }),
  pair("awaiting_approval", "Awaiting approval", {
    /* ── IMMUTABLE, AND THAT IS THE POINT OF SUBMITTING ──────────────────
       An approver must decide on the document they read. If the author can edit
       it while it waits, an approval attaches to a version that no longer
       exists, and the audit trail says somebody approved something they never
       saw. So a submitted plan is frozen until a decision unfreezes it. */
    means: "Submitted for a decision and frozen. Editing it again needs it returned first.",
    editable: false,
    terminal: false,
  }),
  pair("approved", "Approved", {
    /* The sentence that has to survive every future screen. */
    means: "An administrator agreed to this plan. NOTHING has been created in any advertising channel, no budget is committed and no money can be spent because of this.",
    editable: false,
    terminal: false,
  }),
  pair("returned", "Returned for changes", {
    means: "Sent back with a reason. Editable again, and its revision history shows what it looked like when it was returned.",
    editable: true,
    terminal: false,
  }),
  pair("rejected", "Rejected", {
    means: "Declined. Not editable and not resubmittable; a new plan is the way forward.",
    editable: false,
    terminal: true,
  }),
  pair("cancelled", "Cancelled", {
    means: "Withdrawn by Marketing before a decision, or stood down afterwards. Kept for the record.",
    editable: false,
    terminal: true,
  }),
];

/* ── THE TRANSITION TABLE IS THE RULE ───────────────────────────────────────
   A closed map, so a transition nobody listed cannot happen. Written as
   `from → [to]` rather than checked with a chain of ifs, because a chain of ifs
   is where the eleventh case gets forgotten.

   `actor` says WHO may make each move, and it is deliberately not uniform:
   Marketing owns the plan and may submit or cancel it; an administrator decides.
   Sales appears nowhere — a handover decision is Sales' and a campaign approval
   is not. */
const TRANSITIONS = Object.freeze({
  draft: Object.freeze({
    awaiting_approval: Object.freeze({ actor: "marketing", action: "submit" }),
    cancelled: Object.freeze({ actor: "marketing", action: "cancel" }),
  }),
  awaiting_approval: Object.freeze({
    approved: Object.freeze({ actor: "approver", action: "approve" }),
    rejected: Object.freeze({ actor: "approver", action: "reject" }),
    returned: Object.freeze({ actor: "approver", action: "return" }),
    /* Marketing may withdraw a submission. An approver deciding on a plan its
       author has abandoned is a waste of everybody's time, and the alternative —
       forcing a rejection — puts a decision in the record that nobody made. */
    cancelled: Object.freeze({ actor: "marketing", action: "cancel" }),
  }),
  returned: Object.freeze({
    awaiting_approval: Object.freeze({ actor: "marketing", action: "submit" }),
    cancelled: Object.freeze({ actor: "marketing", action: "cancel" }),
  }),
  approved: Object.freeze({
    /* An approved plan can be stood down before anything is deployed. It cannot
       go back to draft: editing an approved plan would carry the approval onto
       text nobody approved. */
    cancelled: Object.freeze({ actor: "approver", action: "cancel" }),
  }),
  /* Terminal. Present as empty objects rather than absent, so a lookup for a
     terminal state returns "no transitions" instead of undefined. */
  rejected: Object.freeze({}),
  cancelled: Object.freeze({}),
});

/* The decisions an approver may record, and which state each produces. One
   closed list, so a decision word that is not one of these is refused by name
   rather than silently treated as a rejection. */
const APPROVAL_DECISIONS = [
  pair("approve", "Approve", { to: "approved", requiresReason: false }),
  pair("return", "Return for changes", {
    to: "returned",
    /* A reason is REQUIRED. "Returned" with no explanation is a plan the author
       cannot act on, and it is the decision most likely to be made in a hurry. */
    requiresReason: true,
  }),
  pair("reject", "Reject", { to: "rejected", requiresReason: true }),
];

/* ── WHAT A CAMPAIGN IS TRYING TO DO ────────────────────────────────────────
   GRAV's own objectives, deliberately not the providers' vocabularies. Google
   calls it an advertising channel type and Meta calls it an objective, they do
   not line up, and a plan written before a channel is chosen cannot use either.
   The deployment chunk maps these onto each provider's own words. */
const CAMPAIGN_OBJECTIVES = [
  pair("awareness", "Awareness", { means: "Reach people who do not know GRAV yet." }),
  pair("traffic", "Website traffic", { means: "Bring people to a GRAV page." }),
  pair("lead_generation", "Lead generation", { means: "Collect enquiries GRAV can qualify." }),
  pair("engagement", "Engagement", { means: "Get responses from people already reached." }),
  pair("retention", "Retention", { means: "Keep existing customers buying." }),
];

/* ── THE GOAL A CAMPAIGN WILL BE JUDGED BY ──────────────────────────────────
   Declared in the plan, so the measure is agreed before the spending rather
   than chosen afterwards from whatever looks best.

   `qualified_prospect` and `sales_handover` are GRAV-owned outcomes and are the
   ones that will eventually be comparable across channels. The others are
   provider- or analytics-counted and are not. Nothing in this chunk measures any
   of them — the plan records the intention. */
const CONVERSION_GOALS = [
  pair("form_submission", "Form submission", { owner: "grav", means: "Somebody completed a GRAV form." }),
  pair("qualified_prospect", "Qualified prospect", { owner: "grav", means: "A person GRAV qualified as worth Sales' time." }),
  pair("sales_handover", "Sales handover", { owner: "grav", means: "A prospect accepted into the Sales pipeline." }),
  pair("page_view", "Page view", { owner: "analytics", means: "Counted by website analytics, not by GRAV." }),
  pair("channel_conversion", "Channel-reported conversion", {
    owner: "provider",
    means: "Counted by the advertising channel on its own definition. Not comparable between channels.",
  }),
];

/* ── THE BOUNDS ─────────────────────────────────────────────────────────────
   Every one is enforced by refusing rather than trimming. A name silently cut to
   120 characters is a name the author did not write. */
const LIMITS = Object.freeze({
  NAME_MAX: 120,
  DESCRIPTION_MAX: 4000,
  QUALIFICATION_NOTES_MAX: 4000,
  DECISION_REASON_MAX: 2000,
  AUDIENCE_REF_MAX: 200,
  CONTENT_REFS_MAX: 50,
  CHANNELS_MAX: 4,
  UTM_MAX: 100,
  /* A campaign may be planned up to two years out. Longer is almost always a
     typo in the year, and a plan running to 2126 is worth refusing loudly. */
  PLAN_HORIZON_DAYS: 731,
  PAGE_DEFAULT: 25,
  PAGE_MAX: 100,
});

/* ── THE UTM CAMPAIGN IDENTITY ──────────────────────────────────────────────
   This is the string that will appear in a destination URL, so it travels
   through a browser, a web server log and an analytics property. It may contain
   only characters that survive all three without encoding, and it is lower-cased
   on the way in because analytics tools treat `Winter` and `winter` as two
   campaigns and a marketer then reconciles two halves of one number. */
const UTM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;

/* ── WHAT A HISTORY ROW RECORDS ─────────────────────────────────────────────
   Append-only. One row per change, whatever the kind — a field edit and an
   approval are both things somebody did, and keeping them in one sequence is
   what makes the record readable as a story. */
const HISTORY_KINDS = [
  pair("created", "Created"),
  pair("edited", "Edited"),
  pair("submitted", "Submitted for approval"),
  pair("approved", "Approved"),
  pair("returned", "Returned for changes"),
  pair("rejected", "Rejected"),
  pair("cancelled", "Cancelled"),
];

module.exports = {
  DRAFT_STATES,
  DRAFT_STATE_CODES: codes(DRAFT_STATES),
  EDITABLE_STATES: Object.freeze(DRAFT_STATES.filter((s) => s.editable).map((s) => s.code)),
  TERMINAL_STATES: Object.freeze(DRAFT_STATES.filter((s) => s.terminal).map((s) => s.code)),
  TRANSITIONS,
  APPROVAL_DECISIONS,
  APPROVAL_DECISION_CODES: codes(APPROVAL_DECISIONS),
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_CODES: codes(CAMPAIGN_OBJECTIVES),
  CONVERSION_GOALS,
  CONVERSION_GOAL_CODES: codes(CONVERSION_GOALS),
  HISTORY_KINDS,
  HISTORY_KIND_CODES: codes(HISTORY_KINDS),
  LIMITS,
  UTM_PATTERN,
  state: (code) => DRAFT_STATES.find((s) => s.code === code) || null,
  decision: (code) => APPROVAL_DECISIONS.find((d) => d.code === code) || null,
};
