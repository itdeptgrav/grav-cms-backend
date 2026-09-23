// constants/marketingContentPlan.js
//
// THE MARKETING CONTENT PLANNER: WHAT IS INTENDED, WHEN, AND BY WHOM.
//
// ── A PLAN, NOT A PUBLISHER ────────────────────────────────────────────────
// An item here is somebody's intention to produce a piece of content for a
// date. Nothing in the planner creates, schedules, sends or publishes anything,
// and no workflow state means otherwise. `approved` means "approved to go
// ahead"; it is not "live".
//
// ── PLANNED IS NOT ACTUAL ──────────────────────────────────────────────────
// `planned` is the date somebody typed. Whether the content was actually
// scheduled or published is a different question, answered only by an existing
// source — today, the content library's own report on a linked asset. The
// planner never lets anybody type "published", so a calendar cannot claim a
// publication nobody observed.
"use strict";

const freeze = Object.freeze;
const pair = (code, label, extra = {}) => freeze({ code, label, ...extra });
const codes = (list) => freeze(list.map((x) => x.code));

/* ── WHAT IS BEING MADE ─────────────────────────────────────────────────────
   The first three are the content library's own kinds, so an item of that type
   can be linked to the asset that realises it. The rest are planned here and
   produced elsewhere. */
const CONTENT_TYPES = [
  pair("email", "Email", { libraryKind: "email" }),
  pair("landing_page", "Landing page", { libraryKind: "landing_page" }),
  pair("form", "Form", { libraryKind: "form" }),
  pair("social_post", "Social post"),
  pair("blog_article", "Blog article"),
  pair("advert", "Advert"),
  pair("video", "Video"),
  pair("print", "Print piece"),
  pair("event", "Event"),
  pair("other", "Other"),
];
const CONTENT_TYPE_CODES = codes(CONTENT_TYPES);

/* ── WHERE IT WILL APPEAR ───────────────────────────────────────────────────
   GRAV's own channel words. No advertising network or tool is named: a plan is
   written before anybody decides which provider will carry it. */
const CHANNELS = [
  pair("email", "Email"),
  pair("website", "Website"),
  pair("social", "Social media"),
  pair("paid_search", "Paid search"),
  pair("paid_social", "Paid social"),
  pair("events", "Events"),
  pair("print", "Print"),
  pair("other", "Other"),
];
const CHANNEL_CODES = codes(CHANNELS);

/* ── WORKFLOW ───────────────────────────────────────────────────────────────
   Where the PLAN is. Never where the content is in the world. */
const STATES = [
  pair("idea", "Idea", { means: "Somebody wants this. Nothing has been started." }),
  pair("drafting", "In progress", { means: "Somebody is preparing this content." }),
  pair("in_review", "Awaiting approval", {
    means: "Submitted for approval. Only notes can change until it is approved, returned or withdrawn.",
  }),
  pair("approved", "Approved", {
    means: "Approved to go ahead. This does not mean it has been scheduled or published anywhere.",
  }),
  pair("cancelled", "Cancelled", { means: "No longer planned. Kept for the record." }),
];
const STATE_CODES = codes(STATES);
const STATE_BY_CODE = freeze(Object.fromEntries(STATES.map((s) => [s.code, s])));

/* What may change in each state. Notes are a working conversation and stay
   open until an item is cancelled; everything that was approved is frozen. */
const EDITABLE = freeze({
  idea: "all",
  drafting: "all",
  in_review: "notes",
  approved: "notes",
  cancelled: "none",
});

/* ── WHO MAY MOVE AN ITEM, AND WHERE ────────────────────────────────────────
   `marketing` is anybody who may use Marketing (marketing, admin, CEO).
   `approver` is an administrator or the CEO — the same people who decide on
   campaign plans. Sales never reaches this router at all. */
const ACTIONS = [
  pair("start", "Start work", { from: freeze(["idea"]), to: "drafting", actor: "marketing", reason: "optional" }),
  pair("submit", "Submit for approval", { from: freeze(["idea", "drafting"]), to: "in_review", actor: "marketing", reason: "optional" }),
  pair("withdraw", "Withdraw from approval", { from: freeze(["in_review"]), to: "drafting", actor: "marketing", reason: "optional" }),
  pair("approve", "Approve", { from: freeze(["in_review"]), to: "approved", actor: "approver", reason: "optional" }),
  pair("return", "Return for changes", { from: freeze(["in_review"]), to: "drafting", actor: "approver", reason: "required" }),
  pair("reopen", "Reopen for changes", { from: freeze(["approved"]), to: "drafting", actor: "marketing", reason: "required" }),
  pair("cancel", "Cancel", { from: freeze(["idea", "drafting", "in_review"]), to: "cancelled", actor: "marketing", reason: "optional" }),
  pair("cancel_approved", "Cancel an approved item", { from: freeze(["approved"]), to: "cancelled", actor: "approver", reason: "required" }),
];
const ACTION_CODES = codes(ACTIONS);
const ACTION_BY_CODE = freeze(Object.fromEntries(ACTIONS.map((a) => [a.code, a])));

/* What an item needs before anybody can be asked to approve it. */
const SUBMISSION_REQUIRES = freeze([
  pair("brief", "A brief", { means: "Say what this content is for." }),
  pair("owner", "An owner", { means: "Somebody has to be responsible for it." }),
  pair("planned", "A planned date", { means: "An approver needs to know when it is intended for." }),
  pair("creative", "A creative draft", {
    means: "A social post, advert or video needs a concept and at least one platform version, each with its copy, before it can be approved.",
  }),
]);

/* ═══════════════════════════════════════════════════════════════════════════
   THE CREATIVE DRAFT
   ═══════════════════════════════════════════════════════════════════════════
   One idea, one concept, and any number of platform versions of it. A version
   is NOT a separate post: it has no state, no date and no publication of its
   own. The item is what is planned, approved and (elsewhere, by somebody)
   eventually published; its versions are how it is meant to look on each
   platform. */

/* The types an approver cannot judge without the words and the look. */
const CREATIVE_TYPES = freeze(["social_post", "advert", "video"]);

/* Where somebody intends a version to appear. A planning choice only: GRAV
   holds no connection to any of these and posts to none of them. */
const PLATFORMS = [
  pair("instagram", "Instagram"),
  pair("facebook", "Facebook"),
  pair("linkedin", "LinkedIn"),
  pair("x", "X"),
  pair("youtube", "YouTube"),
  pair("pinterest", "Pinterest"),
  pair("whatsapp", "WhatsApp"),
  pair("website", "Website"),
  pair("email", "Email"),
  pair("print", "Print"),
  pair("other", "Other"),
];
const PLATFORM_CODES = codes(PLATFORMS);

const FORMATS = [
  pair("single_image", "Single image"),
  pair("carousel", "Carousel"),
  pair("short_video", "Short video"),
  pair("long_video", "Long video"),
  pair("story", "Story"),
  pair("text_only", "Text only"),
  pair("article", "Article"),
  pair("document", "Document"),
  pair("other", "Other"),
];
const FORMAT_CODES = codes(FORMATS);

const CALLS_TO_ACTION = [
  pair("none", "No call to action"),
  pair("learn_more", "Learn more"),
  pair("shop_now", "Shop now"),
  pair("get_quote", "Get a quote"),
  pair("contact_us", "Contact us"),
  pair("book_now", "Book now"),
  pair("sign_up", "Sign up"),
  pair("download", "Download"),
  pair("visit_website", "Visit website"),
];
const CALL_TO_ACTION_CODES = codes(CALLS_TO_ACTION);

/* A reference is a picture already in the company's advertising image library,
   or a written note. There is no third kind: GRAV has no store for video,
   documents or design files, so a reference to one is a note saying where it
   is, and says so. */
const REFERENCE_KINDS = [
  pair("image", "Image from the advertising image library", {
    means: "An image already stored in this company's advertising image library. GRAV holds these exact bytes.",
  }),
  pair("media", "File from the creative media library", {
    means: "One exact version of a file in this company's creative media library. GRAV holds these exact bytes, and the reference names that version for ever — a newer version is never swapped in.",
  }),
  pair("note", "Written reference", {
    means: "A description of a visual, a shoot or a file. Nothing is stored; it is text somebody wrote.",
  }),
];
const REFERENCE_KIND_CODES = codes(REFERENCE_KINDS);

/* What GRAV can say about a referenced file now. Generic codes, shared by
   every kind; the words a screen shows come from REFERENCE_STATUS_BY_KIND,
   because "the library" means a different library for each kind. */
const REFERENCE_STATUS = [
  pair("available", "Available", { means: "The referenced file is stored and can be shown." }),
  pair("withdrawn", "Withdrawn", { means: "The referenced file was withdrawn. It is not shown and should be replaced." }),
  pair("missing", "Missing", { means: "The referenced file can no longer be found." }),
  pair("changed", "Stored file changed", { means: "The stored copy no longer matches the version that was referenced, so it is not shown." }),
  pair("not_stored", "Not a stored file", { means: "A written reference. There is no file behind it." }),
];

const REFERENCE_STATUS_BY_KIND = freeze({
  media: freeze([
    pair("available", "In the creative media library", { means: "This exact version is in the company's creative media library and can be previewed." }),
    pair("withdrawn", "Withdrawn from the creative media library", {
      means: "This version was withdrawn from the creative media library. It is not shown, and the creative needs another file.",
    }),
    pair("missing", "No longer in the creative media library", {
      means: "This version can no longer be found in the creative media library. It is not shown, and the creative needs another file.",
    }),
    pair("changed", "Stored copy changed", {
      means: "The creative media library's stored copy no longer matches this version, so it is not shown. The creative needs another file.",
    }),
  ]),
  image: freeze([
    pair("available", "In the advertising image library", { means: "The referenced image is in the company's advertising image library." }),
    pair("withdrawn", "Withdrawn from the advertising image library", {
      means: "The referenced image was withdrawn from the advertising image library and should be replaced.",
    }),
    pair("missing", "No longer in the advertising image library", {
      means: "The referenced image can no longer be found in the advertising image library.",
    }),
  ]),
  note: freeze([
    pair("not_stored", "Not a stored file", { means: "A written reference. There is no file behind it." }),
  ]),
});

/* ── WHETHER AN ITEM'S APPROVAL STILL STANDS ───────────────────────────────
   Separate from the workflow state. `state: approved` records that somebody
   approved it; this says whether what they approved is still what exists. */
const APPROVAL_STATUS = [
  pair("not_approved", "Not approved", { means: "Nobody has approved this item." }),
  pair("valid", "Approval stands", { means: "The creative that was approved is unchanged and every file in it can still be shown." }),
  pair("invalid", "Approval no longer stands", {
    means: "The item was approved, but what was approved can no longer be shown as approved. Reopen it, fix the creative and submit it again.",
  }),
];
const APPROVAL_INVALID_REASONS = [
  pair("creative_changed", "The creative changed after approval", { means: "The creative on the item is not the one that was approved." }),
  pair("media_withdrawn", "A file in it was withdrawn", { means: "A file the approved creative uses has been withdrawn." }),
  pair("media_missing", "A file in it is missing", { means: "A file the approved creative uses can no longer be found." }),
  pair("media_changed", "A stored file changed", { means: "A stored file the approved creative uses no longer matches the version that was approved." }),
];

const MEDIA_STORE = freeze({
  images: true,
  formats: freeze(["JPEG", "PNG"]),
  otherMedia: false,
  gap: "GRAV stores images (JPEG and PNG) in the company's creative media library and advertising image library. It cannot store video yet (see the creative media library's video blockers), nor audio, documents or design files, so those can only be described in a written reference, which is labelled as not a stored file.",
});

/* ── WHETHER IT HAS ACTUALLY APPEARED ───────────────────────────────────────
   Derived at read time from the content library's report on a linked asset.
   Never stored, never typed. */
const PUBLICATION = [
  pair("no_linked_asset", "No linked content", {
    means: "This item is not linked to anything in the content library, so GRAV cannot say whether it has appeared.",
  }),
  pair("published", "Published", {
    means: "The content library reports the linked asset as published. That does not prove it was sent, delivered or seen.",
  }),
  pair("scheduled", "Scheduled", {
    means: "The content library reports the linked asset set to publish at the date shown. It has not appeared yet.",
  }),
  pair("not_published", "Not published", {
    means: "The content library reports the linked asset as not published.",
  }),
  pair("unknown", "Not reported", {
    means: "The content library did not report whether the linked asset is published.",
  }),
  pair("asset_missing", "Linked content not found", {
    means: "The linked asset is no longer in the content library.",
  }),
  pair("unavailable", "Cannot check", {
    means: "The content library cannot be read right now, so GRAV cannot say whether the linked content has appeared.",
  }),
];
const PUBLICATION_CODES = codes(PUBLICATION);

const CAMPAIGN_LINK = [
  pair("linked", "Linked campaign plan", { means: "This item belongs to the campaign plan shown." }),
  pair("campaign_missing", "Campaign plan not found", {
    means: "The linked campaign plan can no longer be found for this company.",
  }),
];

const CONTENT_LIBRARY = [
  pair("not_needed", "Not needed", { means: "No item on this page links to the content library." }),
  pair("available", "Read", { means: "The content library was read for this page." }),
  pair("unavailable", "Cannot be read", {
    means: "The content library cannot be read right now. Plans are unaffected; publication cannot be checked.",
  }),
  pair("not_configured", "Not set up", {
    means: "This company has no content library, so linked content cannot be checked.",
  }),
];

const LIMITS = freeze({
  TITLE_MAX: 160,
  BRIEF_MAX: 4000,
  NOTES_MAX: 4000,
  REASON_MAX: 1000,
  CAPTURED_NAME_MAX: 300,
  CONTENT_ID_PATTERN: /^[A-Za-z0-9_.:-]{1,200}$/,
  IDEMPOTENCY_KEY_PATTERN: /^[A-Za-z0-9_.:-]{8,120}$/,
  CALENDAR_MAX_DAYS: 62,
  PAGE_DEFAULT: 25,
  PAGE_MAX: 100,
  HISTORY_MAX: 500,
  YEAR_MIN: 2000,
  YEAR_MAX: 2100,
  /* How much of the content library one read may page through to find linked
     assets. Beyond this an asset is reported as `unavailable`, never as
     missing: not finding it in part of the library proves nothing. */
  LIBRARY_PAGES_PER_KIND: 20,
  CONCEPT_MAX: 2000,
  CAPTION_MAX: 5000,
  CTA_TEXT_MAX: 80,
  VARIANTS_MAX: 10,
  REFERENCES_MAX: 10,
  REFERENCE_NOTE_MAX: 500,
});

/* A time zone for a viewer who names none. GRAV's own. */
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

module.exports = freeze({
  CONTENT_TYPES,
  CONTENT_TYPE_CODES,
  CHANNELS,
  CHANNEL_CODES,
  STATES,
  STATE_CODES,
  STATE_BY_CODE,
  EDITABLE,
  ACTIONS,
  ACTION_CODES,
  ACTION_BY_CODE,
  SUBMISSION_REQUIRES,
  PUBLICATION,
  PUBLICATION_CODES,
  CAMPAIGN_LINK,
  CONTENT_LIBRARY,
  LIMITS,
  DEFAULT_TIME_ZONE,
  CREATIVE_TYPES,
  PLATFORMS,
  PLATFORM_CODES,
  FORMATS,
  FORMAT_CODES,
  CALLS_TO_ACTION,
  CALL_TO_ACTION_CODES,
  REFERENCE_KINDS,
  REFERENCE_KIND_CODES,
  REFERENCE_STATUS,
  REFERENCE_STATUS_BY_KIND,
  APPROVAL_STATUS,
  APPROVAL_INVALID_REASONS,
  MEDIA_STORE,
});
