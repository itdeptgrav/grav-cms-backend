// constants/marketing.js
//
// THE MARKETING APPLICATION'S OWN VOCABULARY.
//
// Separate from constants/crm.js on purpose. Marketing and Sales are separate
// bounded applications (ADR-004), and a shared vocabulary file is the first
// place two applications stop being separate: a Sales enum grows a marketing
// code, a marketing enum grows a lifecycle code, and six months later neither
// list can be changed without reading the other application.
//
// Nothing here names a Sales lifecycle state. A handover outcome says what
// SALES DECIDED about the handover — accepted, returned, rejected, linked to a
// duplicate — and says nothing about what the Prospect subsequently becomes.
// That is Sales' business and Marketing does not model it.
"use strict";

const pair = (code, label, meta = {}) => ({ code, label, ...meta });
const codes = (list) => list.map((x) => x.code);

/* ── HANDOVER LIFECYCLE ─────────────────────────────────────────────────────
   A handover is submitted once and then only receives an answer. There is no
   "editing" state: a marketer who wants to say something different submits a
   new handover, and the evidence behind the first one stays readable. */
const HANDOVER_STATES = [
  pair("AWAITING_REVIEW", "Awaiting Sales review"),
  pair("ACCEPTED", "Accepted by Sales"),
  pair("RETURNED", "Returned for nurture"),
  pair("REJECTED", "Rejected by Sales"),
  pair("DUPLICATE_LINKED", "Linked to an existing Sales record"),
  /* Refused before it ever reached Sales — consent, threshold or contract. A
     terminal state on the Marketing side only; Sales never sees one. */
  pair("BLOCKED", "Blocked before submission"),
];

/** The four answers Sales may give. Deliberately identical in spelling to the
 *  four states above so a reader never has to map one onto the other. */
const SALES_DECISIONS = [
  pair("ACCEPTED", "Accept and assign"),
  pair("RETURNED", "Return for nurture"),
  pair("REJECTED", "Reject"),
  pair("DUPLICATE_LINKED", "Link to an existing record"),
];

/* Which decisions need a reason from Sales. Accept does not: the reason a
   salesperson took a handover is that they took it. The other three change
   what Marketing does next, so the reason is the whole point of sending
   them back. */
const DECISION_REASON_REQUIRED = new Set(["RETURNED", "REJECTED", "DUPLICATE_LINKED"]);

/* ── CONSENT ────────────────────────────────────────────────────────────────
   The canonical marketing-permission states (product plan §7). `unknown` is
   the default and is NOT a synonym for "no": it means nobody has recorded an
   answer, which is a different fact and is reported as one. */
const CONSENT_STATES = [
  pair("unknown", "Not recorded"),
  pair("opted_in", "Opted in"),
  pair("opted_out", "Opted out"),
  pair("suppressed", "Suppressed"),
];

/* ── CHANNEL AND PURPOSE ────────────────────────────────────────────────────
   A consent record answers "may we contact this person, HOW, and FOR WHAT".
   Channel and purpose are separate axes and neither implies the other: a person
   who agreed to marketing email has not agreed to marketing phone calls, and a
   person reachable for transactional notices has not agreed to marketing at
   all.

   THE PURPOSE SPLIT IS THE POINT. The product plan is explicit: "Transactional
   customer communication is a separate purpose and must not be enabled by
   marketing consent." Folding them into one flag is how an order-confirmation
   address ends up in a campaign, and the person who receives it was never
   asked. So `transactional` is a purpose of its own, it is never consulted when
   deciding marketing eligibility, and no state on it can grant marketing. */
const CONSENT_CHANNELS = [
  pair("email", "Email"),
  pair("sms", "SMS"),
  pair("phone", "Phone"),
  pair("whatsapp", "WhatsApp"),
  pair("post", "Post"),
];

const CONSENT_PURPOSES = [
  pair("marketing", "Marketing"),
  /* Order confirmations, dispatch notices, invoices. A legitimate business
     communication that marketing consent neither grants nor withdraws. */
  pair("transactional", "Transactional"),
  /* Support and account administration. Listed so a future caller has somewhere
     honest to put it rather than reaching for `marketing`. */
  pair("service", "Service"),
];

/* The one channel/purpose pair that may put a person into a Mautic campaign.
   Named as a constant rather than spelled inline at each check, so "what counts
   as marketing permission" has exactly one definition. */
const MARKETING_EMAIL = Object.freeze({ channel: "email", purpose: "marketing" });

/* ── WHY A PERSON IS NOT ELIGIBLE, IN CODES A SCREEN CAN GROUP BY ───────────
   The Data Health destination (product plan §8) has to show "what is stopping
   these people from being reachable", and prose cannot be grouped or counted.
   These are stable: a screen may branch on them, so renaming one is a breaking
   change and adding one is additive.

   Each is a DIFFERENT business situation needing a different response, which is
   why there is not simply one "not consented":
     MISSING     nobody has ever asked this person            → ask them
     UNKNOWN     asked, no answer recorded                    → ask again
     WITHDRAWN   they said no                                 → leave them alone
     SUPPRESSED  the address is undeliverable or complained    → review, never send
     AMBIGUOUS   the record contradicts itself                → a human must look
     IDENTITY    no canonical person to hold consent for      → fix the mapping */
const CONSENT_INELIGIBLE_REASONS = [
  pair("CONSENT_MISSING", "No marketing consent has ever been recorded"),
  pair("CONSENT_UNKNOWN", "Marketing consent was asked for but no answer is recorded"),
  pair("CONSENT_WITHDRAWN", "The person opted out of marketing"),
  pair("CONSENT_SUPPRESSED", "The channel is suppressed for this person"),
  pair("CONSENT_AMBIGUOUS", "Several conflicting consent records exist"),
  pair("CONSENT_IDENTITY_MISSING", "No canonical GRAV person identity to resolve consent for"),
];

/* A handover may only be submitted for a person whose marketing permission is
   in one of these states. `opted_in` is the ordinary case. `unknown` is
   allowed because a handover is not a marketing send — it hands the person to
   a salesperson who will make a personal, consented business contact — but it
   is surfaced to Sales rather than hidden. Opted out and suppressed are
   refused outright: the person asked not to be marketed to, and routing them
   to a salesperson through a marketing campaign is the same act wearing a
   different hat. */
const CONSENT_STATES_ALLOWING_HANDOVER = new Set(["opted_in", "unknown"]);

/* ── THE ASSESSMENTS THAT TRAVEL WITH A HANDOVER ────────────────────────────
   Bands, not scores. A number invites a threshold nobody can explain; a band
   with its listed factors can be argued with. Both are computed by
   services/marketing/handoverAssessment.js from recorded evidence only. */
const FIT_BANDS = [
  pair("strong", "Strong account fit"),
  pair("possible", "Possible account fit"),
  pair("weak", "Weak account fit"),
  pair("unknown", "Not enough information"),
];

const INTENT_BANDS = [
  pair("explicit_request", "Explicit request"),
  pair("high", "Repeated meaningful engagement"),
  pair("moderate", "Some engagement"),
  pair("low", "Little or no engagement"),
];

/* What Marketing suggests Sales does first. A suggestion, never an
   instruction, and never a commercial act — no code here says "quote",
   "price" or "negotiate", because Marketing may not recommend those either. */
const RECOMMENDED_ACTIONS = [
  pair("call_within_one_business_day", "Call within one business day"),
  pair("call_within_three_business_days", "Call within three business days"),
  pair("email_introduction", "Send a personal introduction"),
  pair("research_before_contact", "Research before making contact"),
];

/* ── INTENT EVENTS ──────────────────────────────────────────────────────────
   The marketing observations this slice understands. Kept small on purpose:
   an event kind this application cannot act on is stored, acknowledged and
   ignored rather than silently treated as intent. */
const INTENT_EVENT_KINDS = [
  pair("form_submitted", "Form submitted", { explicit: true }),
  pair("callback_requested", "Callback requested", { explicit: true }),
  pair("quotation_requested", "Quotation requested", { explicit: true }),
  pair("sample_requested", "Sample requested", { explicit: true }),
  pair("consultation_requested", "Consultation requested", { explicit: true }),

  /* ── THE EMAIL LIFECYCLE, AS SIX DISTINCT FACTS ─────────────────────────
     Kept apart because they are different claims about the world and folding
     any two together overstates what is known.

     `email_sent` is OUR act: Mautic handed the message to a transport. It says
     nothing about whether anybody received it.

     `email_delivered` is the PROVIDER's report. Delivery is not engagement —
     nobody has done anything — and it exists here so "we sent 400 and 12
     bounced" is answerable, not so a person can be scored for receiving mail.

     `email_opened` is a POSSIBLE open and nothing more. Gmail, Outlook and
     every corporate security scanner fetch tracking pixels on the recipient's
     behalf, often before the person has looked at anything. It is the weakest
     evidence in this list and it may never qualify a handover by itself
     (EXPLICIT_REQUEST_KINDS and MEANINGFUL_ENGAGEMENT_KINDS both exclude it).

     `email_clicked` is stronger — somebody, or something, followed a link —
     but link-scanning appliances click every URL in a message before it is
     delivered. So a click is recorded with whatever uncertainty the evidence
     supports and is still not proof of buying intent.

     `email_bounced` keeps its hard/soft classification, because the two mean
     opposite things: one address is gone for good, the other was busy.

     `email_unsubscribed` is the person speaking. It outranks everything. */
  pair("email_sent", "Email sent", { explicit: false, telemetry: true }),
  pair("email_delivered", "Email delivered", { explicit: false, telemetry: true }),
  pair("email_opened", "Email opened (possible)", { explicit: false, telemetry: true }),
  pair("email_clicked", "Email link clicked", { explicit: false }),
  pair("email_bounced", "Email bounced", { explicit: false }),
  pair("email_unsubscribed", "Unsubscribed", { explicit: false }),
  /* Somebody in Mautic marked the contact contactable again. Recorded, never
     acted on: a re-subscribe in the marketing engine must not silently clear a
     GRAV suppression, because GRAV's consent record is the authority and a
     bounce that has been "fixed" in Mautic has not been fixed in reality. */
  pair("email_resubscribed", "Marked contactable again in the marketing engine", { explicit: false }),

  pair("page_viewed", "Page viewed", { explicit: false, telemetry: true }),
];

/* ── DELIBERATELY ABSENT ────────────────────────────────────────────────────
   No read duration, no exit time, no "looked at it for N seconds". A tracking
   pixel is fetched once, by whatever fetched it; everything after that is
   invention. Gmail's proxy in particular caches the image and serves it from
   Google, so even the single fetch is not reliably the person. A field for
   dwell time would be a number nobody could defend, presented to a salesperson
   as a fact about a human being. */

/** Kinds that are pure telemetry: they belong in Marketing's ledger and must
 *  never reach the CRM Activity timeline. */
const TELEMETRY_ONLY_KINDS = new Set(
  INTENT_EVENT_KINDS.filter((k) => k.telemetry).map((k) => k.code),
);

/** The kinds that ARE an explicit ask, and therefore clear the handover
 *  threshold on their own (product plan §4, "Handover threshold"). */
const EXPLICIT_REQUEST_KINDS = new Set(
  INTENT_EVENT_KINDS.filter((k) => k.explicit).map((k) => k.code),
);

/* Engagement that is meaningful but not an ask. A page view and an email open
   are neither — the plan is explicit that "a single open or general page view
   is not enough", and counting them towards a threshold is how that sentence
   stops being true. */
const MEANINGFUL_ENGAGEMENT_KINDS = new Set(["email_clicked"]);

/* ── BOUNCE CLASSIFICATION ──────────────────────────────────────────────────
   Hard and soft are opposite instructions. A hard bounce means the address does
   not exist and every future send to it damages the sending domain's
   reputation; a soft bounce means a full mailbox or a busy server, and
   suppressing on one would delete a real customer from every future campaign
   because their inbox was full on a Tuesday.

   `unknown` exists because the provider text is not always classifiable, and
   guessing in either direction is worse than saying so. It resolves to the
   conservative NON-SENDING state that asks for review — which is the same
   suppression a hard bounce produces — while recording that the classification
   was not confirmed, so nobody later reports it as a confirmed hard bounce. */
const BOUNCE_CLASSES = [
  pair("hard", "Hard bounce — the address is gone"),
  pair("soft", "Soft bounce — temporary"),
  pair("unknown", "Bounced, cause not classifiable"),
];

/* ── PROCESSING STATE ───────────────────────────────────────────────────────
   Kept on a RECEIPT, never on the observation. An event is a statement about
   something that already happened and cannot acquire workflow state later
   without becoming a different kind of record — one that can be edited, and
   therefore one whose history is no longer evidence. */
const EVENT_PROCESSING_STATES = [
  pair("RECORDED", "Recorded, nothing further required"),
  pair("IDENTITY_UNRESOLVED", "No canonical GRAV person could be resolved"),
  pair("SUPPRESSION_PENDING", "Suppression is required and not yet applied"),
  pair("SUPPRESSION_APPLIED", "Suppression applied to the canonical consent record"),
  /* The command is durably in history and a later valid consent decision stands
     over it. Settled — nothing is owed and nothing should retry — and
     deliberately NOT a claim that the person is suppressed now. */
  pair("SUPPRESSION_SUPERSEDED", "Superseded by a later consent decision"),
  pair("SUPPRESSION_FAILED", "Suppression could not be applied — retryable"),
  pair("ACTIVITY_NOT_APPLICABLE", "Not a milestone Sales needs to see"),
  pair("ACTIVITY_PENDING", "A CRM Activity is due and not yet written"),
  pair("ACTIVITY_PROJECTED", "A CRM Activity was written"),
  pair("ACTIVITY_FAILED", "The CRM Activity could not be written — retryable"),
  pair("IGNORED", "Understood and deliberately not acted on"),
];

/* Why an event was understood and not acted on. Stable, so Data Health can
   group them and nobody has to read prose to find out what was dropped. */
const EVENT_IGNORED_REASONS = [
  pair("TELEMETRY_ONLY", "Delivery telemetry — kept in Marketing"),
  pair("REPEAT_ENGAGEMENT", "The same person has already engaged this way recently"),
  pair("RESUBSCRIBE_NEEDS_REVIEW", "The marketing engine marked the contact contactable again; GRAV consent is unchanged"),
  pair("SOFT_BOUNCE", "Temporary bounce — recorded, never suppressed"),
  pair("UNSUPPORTED_KIND", "An event type this application does not model"),
];

/* ── OUTBOUND DELIVERY HEALTH (Chunk 1, slice 2) ────────────────────────────
   The STORED state of GRAV's attempt to project one person into Mautic.

   ── WHY THE RETRY SPLIT IS NOT IN THIS LIST ──────────────────────────────
   "Retry waiting" and "retry due" are the same stored fact — a scheduled
   retry — read at two different moments. Storing them separately would mean a
   row that says WAITING while its `nextAttemptAt` has passed, which is a lie
   that no write touched and that nothing would correct. So the stored state is
   `RETRY_SCHEDULED` and the waiting/due distinction is derived from
   `nextAttemptAt` wherever it is asked. `DELIVERY_EFFECTIVE_HEALTH` below is
   the read-time vocabulary, and it is what the Data Health API reports. */
const DELIVERY_HEALTH = [
  pair("NEVER_ATTEMPTED", "Never attempted"),
  /* An attempt is OPEN: begun, not yet settled. Its own stored state, because
     the alternative was leaving `health` at NEVER_ATTEMPTED while `attempts`
     was already 1 — a combination the schema's own invariant forbade and which
     reconciliation then read as "never projected". A crashed attempt looked
     identical to one that had never started, which is the opposite of what an
     operator needs to know. */
  pair("IN_FLIGHT", "Attempt in progress"),
  pair("SYNCHRONIZED", "Synchronized"),
  pair("RETRY_SCHEDULED", "Retry scheduled"),
  /* A failure that retrying cannot fix: a rejected write, a missing
     configuration, a refused credential, or a retry budget spent. Preserved for
     review rather than attempted for ever (product plan §10). */
  pair("BLOCKED_TERMINAL", "Blocked — needs a person"),
  /* Not a failure at all. The person has not agreed, or the channel is
     suppressed. Kept separate from TERMINAL because the fix is a conversation
     with the person, not an engineer. */
  pair("BLOCKED_CONSENT", "Blocked — no marketing permission"),
];

/** What a READER sees, with the scheduled state split by the clock. */
const DELIVERY_EFFECTIVE_HEALTH = [
  pair("NEVER_ATTEMPTED", "Never attempted"),
  pair("IN_FLIGHT", "Attempt in progress"),
  /* An open attempt older than a lease. Split from IN_FLIGHT by the clock, for
     the same reason RETRY_DUE is split from RETRY_WAITING. */
  pair("IN_FLIGHT_STALE", "Attempt started and never finished"),
  pair("SYNCHRONIZED", "Synchronized"),
  pair("RETRY_WAITING", "Retry waiting — backoff has not elapsed"),
  pair("RETRY_DUE", "Retry due now"),
  pair("BLOCKED_TERMINAL", "Blocked — needs a person"),
  pair("BLOCKED_CONSENT", "Blocked — no marketing permission"),
];

/* Whether a failure may be tried again. Classified from the error's own stable
   code, never from its message: a message is prose somebody may reword, and a
   retry policy that depends on prose is a retry policy that changes silently. */
const DELIVERY_FAILURE_CLASS = [
  pair("TRANSIENT", "Worth trying again"),
  pair("TERMINAL", "Retrying cannot fix this"),
  pair("CONSENT", "The person has not agreed"),
];

/* ── THE STABLE REASON VOCABULARY FOR DELIVERY ──────────────────────────────
   Grouped and counted by the Data Health API. Additive; renaming one is a
   breaking change. Deliberately distinct from the Mautic error codes they are
   derived from, because those say what went wrong technically and these say
   what an operator should do about it. */
/* ── THE LABEL SAYS "MARKETING ENGINE"; THE CODE STILL SAYS THE PRODUCT ─────
   Every `label` in this file is USER-FACING TEXT and names no product, because
   the engine is an implementation detail an operator must never have to learn.

   The provider-named CODES stay as they are. They are written into stored
   documents — outbox rows, outcome events, hold records — and renaming a stored
   value is a data migration, not a rename. They are translated on the way out
   instead: `providerPrivacy.publicVocabulary` and `publicReasonCode` map them to
   the GRAV-owned `MARKETING_ENGINE_*` codes at the response boundary, so the
   database keeps one name and the browser sees another. Serving one of these
   tables WITHOUT that translation puts the product name back on the wire. */
const DELIVERY_REASONS = [
  pair("DELIVERY_NEVER_ATTEMPTED", "No projection has been attempted yet"),
  pair("DELIVERY_OK", "Synchronized with the marketing engine"),
  pair("DELIVERY_IN_FLIGHT", "A projection attempt is in progress"),
  /* Its OWN reason, not DELIVERY_OK. A row whose last attempt never finished is
     not a healthy row, and reporting it as "synchronized with Mautic" told an
     operator the opposite of the truth. */
  pair("DELIVERY_IN_FLIGHT_STALE", "A projection attempt started and never finished"),
  pair("MAUTIC_UNREACHABLE", "The marketing engine could not be reached"),
  pair("MAUTIC_AUTH_REFUSED", "The marketing engine refused GRAV's credentials"),
  pair("MAUTIC_NOT_CONFIGURED", "The marketing engine integration is not configured"),
  pair("MAUTIC_WRITE_REJECTED", "The marketing engine rejected the contact write"),
  pair("PROJECTION_INVALID", "The person's data cannot be projected"),
  pair("RETRY_BUDGET_SPENT", "Retried the maximum number of times without success"),
  pair("CONSENT_INELIGIBLE", "Marketing permission does not allow projection"),
  /* ── THE ACQUISITION-SCOPE REFUSALS ─────────────────────────────────────
     Both mean "GRAV does not know enough to act safely", and both are
     deliberately not retried: the fix is a registration, not a wait. Without
     them, a missing configuration was read as "every segment and campaign is
     acquisition", which would have torn an accepted Prospect out of their
     transactional, service and Sales-assisted nurture automation too. */
  pair("ACQUISITION_SCOPE_MISSING", "No acquisition segments or campaigns are registered"),
  pair("ACQUISITION_SCOPE_UNVERIFIABLE", "The registered acquisition scope cannot be verified in the marketing engine"),
];

/* ── BOUNDED DETERMINISTIC BACKOFF ─────────────────────────────────────────
   Deterministic so a reconciliation report can state when a retry is due and be
   right, and bounded at both ends: a floor so a hammering loop cannot form, a
   ceiling so a long outage does not push the next attempt past anybody's shift,
   and a maximum count so a permanently broken record stops consuming attempts
   and starts asking for a person instead. */
const DELIVERY_RETRY = Object.freeze({
  BASE_MS: 60_000,          //  1 minute
  MAX_DELAY_MS: 6 * 60 * 60_000, //  6 hours
  MAX_ATTEMPTS: 8,
  /* How long a worker's claim on a row is honoured before another worker may
     take it. Longer than any single projection should take, short enough that a
     crashed worker does not strand the row for a shift. */
  CLAIM_TTL_MS: 5 * 60_000,
});

/* ── THE SALES-OWNED ACQUISITION HOLD ──────────────────────────────────────
   When Sales takes ownership of a Prospect, acquisition messaging to that ONE
   person must stop. These are the states of the command that makes it stop.

   ── WHY `REQUESTED` IS NOT `PAUSED` ──────────────────────────────────────
   The first version of this wrote a timestamp called `acquisitionPausedAt` the
   moment Sales accepted, while admitting in its own comment that nothing in
   Mautic had changed. Anybody reading the Prospect was told acquisition had
   stopped when the person was still in a running campaign. So the request and
   the confirmation are separate states, and the confirmation is written only
   after Mautic has been read back and agrees. */
const ACQUISITION_HOLD_STATES = [
  /* Sales has decided and Marketing owes Mautic a change. Nothing in Mautic has
     happened yet. An open attempt is this state plus `inFlightSince`, the same
     arrangement delivery state uses. */
  pair("REQUESTED", "Pause requested — not yet applied in the marketing engine"),
  /* Mautic has been changed AND read back. `confirmedAt` exists only here. */
  pair("APPLIED", "Acquisition stopped for this person"),
  /* The attempt failed. Still owed, still queryable, and retried when the
     failure was transient. The Sales decision is untouched by this. */
  pair("FAILED", "Pause attempt failed"),
  /* Settled without being applied, because something else already achieved it:
     a newer hold on the same person, or a consent suppression that stops every
     send for a stronger reason. Not a failure, and not retried for ever. */
  pair("SUPERSEDED", "No longer needed — superseded"),
];

/* Which Sales decision asked for the hold. Returning for nurture is absent on
   purpose: a return asks Marketing to CARRY ON, and this slice deliberately
   does not resume anything automatically either. */
const ACQUISITION_HOLD_REASONS = [
  pair("SALES_ACCEPTED", "Sales accepted and owns the Prospect"),
  pair("SALES_DUPLICATE_LINKED", "Sales linked the handover to an existing record"),
];

/* Why a hold stopped being owed. */
const ACQUISITION_HOLD_SUPERSEDED_BY = [
  pair("NEWER_HOLD", "A later hold on the same person is already applied"),
  pair("CONSENT_SUPPRESSED", "Canonical consent now suppresses this person entirely"),
];

/* ── THE DEDICATED, SALES-OWNED EXCLUSION FLAG IN MAUTIC ────────────────────
   A GRAV-owned boolean custom contact field. Two things make it necessary
   beside the membership removals:

     1. A membership removal stops the campaigns the person is in TODAY. This
        flag is what a future segment filter excludes on, so the person is not
        enrolled again tomorrow by a segment nobody has written yet.
     2. It is not a consent signal. Mautic's own way of stopping mail is
        do-not-contact, and using that here would record Sales ownership as if
        the person had unsubscribed — a permanent, visible, wrong claim about
        something only the person may decide.

   Provisioned by scripts/marketing/mautic-provision-dev.js. */
const ACQUISITION_HOLD_FIELD = "grav_acquisition_hold";

/* ── THE MAUTIC CONTENT INVENTORY ──────────────────────────────────────────
   The three asset kinds GRAV lists from Mautic. Mautic owns content storage,
   editing, publishing and sending (ADR-004); GRAV reads a catalogue.

   `landing_page` rather than `page`: "page" in a GRAV context means a screen in
   GRAV, and the two would be confused in every conversation. */
const CONTENT_KINDS = [
  pair("email", "Email"),
  pair("form", "Form"),
  pair("landing_page", "Landing page"),
];

/* ── WHAT A PUBLICATION STATE MAY CLAIM ────────────────────────────────────
   `published` means Mautic reported the asset published. It does not mean sent,
   delivered, opened or seen — those are different questions with different
   evidence, and this slice has none of it.

   `unknown` is a real state and not a failure: Mautic sent something that was
   not a boolean, and guessing "unpublished" is the guess a reader would act on. */
const CONTENT_PUBLICATION_STATES = [
  pair("published", "Published in the marketing engine"),
  pair("unpublished", "Not published in the marketing engine"),
  pair("unknown", "The marketing engine did not report a usable publication state"),
];

/* ── WEBSITE TRACKING CONFIGURATION ────────────────────────────────────────
   What a company administrator configures for the PUBLIC WEBSITE. None of it
   ever loads inside the GRAV employee application: these are identifiers GRAV
   stores on behalf of the site, and the site is a different origin with a
   different audience and a different consent story.

   ── WHY THE MODES ARE EXCLUSIVE ──────────────────────────────────────────
   A tag manager container and a directly installed measurement tag can both
   send the same page view, and a site running both double-counts everything
   without anybody noticing until the numbers are used for a decision. So a
   configuration names ONE installation strategy, and the stored identifiers are
   read against it rather than all being switched on because they are present. */
const TRACKING_MODES = [
  /* Nothing is active. Identifiers may remain stored so a later re-enable does
     not need them typed again, and none of them counts as live. */
  pair("disabled", "Disabled — no tracking is active"),
  /* One Google Tag Manager container, and the container decides what fires.
     GA4 and Meta identifiers may be recorded as documented destinations, and the
     website loader must install only the container: installing the container AND
     a direct tag is the duplicate-firing mistake. */
  pair("gtm", "Google Tag Manager — the container installs everything"),
  /* Measurement tags installed directly, with no container. */
  pair("direct", "Direct — measurement tags installed individually"),
];

/* The destinations a configuration can name. Stored identity only; GRAV never
   holds a credential for any of them in this slice. */
const TRACKING_DESTINATIONS = [
  pair("gtm", "Google Tag Manager container"),
  pair("ga4", "Google Analytics 4 measurement"),
  pair("meta_pixel", "Meta Pixel"),
];

/* ── WHAT IS KNOWN ABOUT WHETHER IT WORKS ──────────────────────────────────
   A saved identifier is not an installed tag. The distinction is the whole point
   of this vocabulary: somebody pasting a GA4 id into a form has told GRAV what
   they intend, and nothing has yet looked at the website to see whether it is
   there. Calling that "connected" would be a claim nobody checked. */
const TRACKING_VERIFICATION_STATES = [
  pair("not_configured", "Not configured"),
  /* The honest state for everything this slice can produce. */
  pair("saved_unverified", "Saved — not yet verified on the website"),
  /* RESERVED. Only a later probe that actually reads the public site may set
     this, and nothing in this slice writes it. */
  pair("verified", "Verified on the public website"),
  pair("failed", "Verification failed"),
];

/* ── SHAPES, BOUNDED ───────────────────────────────────────────────────────
   Anchored and length-bounded, because an unanchored pattern accepts a valid id
   with a payload appended to it. */
const TRACKING_ID_PATTERNS = Object.freeze({
  /* Google's container ids are `GTM-` plus a short uppercase alphanumeric. */
  gtmContainerId: /^GTM-[A-Z0-9]{4,10}$/,
  /* GA4 measurement ids are `G-` plus a short uppercase alphanumeric. */
  ga4MeasurementId: /^G-[A-Z0-9]{4,12}$/,
  /* Meta pixel ids are numeric. Bounded at both ends: a 400-digit "id" is not
     an id, it is somebody pasting something else into the field. */
  metaPixelId: /^[0-9]{8,20}$/,
});

/* ── FIELD NAMES THAT ARE REFUSED BY NAME ──────────────────────────────────
   This slice stores no provider secret, and "stores none" is enforced by
   refusing the fields rather than by ignoring them. Silently dropping a token
   somebody submitted would leave them believing GRAV holds it — and believing a
   secret is safely stored somewhere it is not is worse than a clear refusal.

   Matched on a normalised name, so `access_token`, `accessToken` and
   `ACCESS-TOKEN` are one entry. */
const TRACKING_REFUSED_FIELD_PARTS = Object.freeze([
  "accesstoken", "conversionstoken", "conversionsapi", "capitoken",
  "clientsecret", "clientid", "refreshtoken", "apikey", "apisecret",
  "token", "secret", "password", "credential", "privatekey", "bearer",
  /* Anything that would store executable content. */
  "script", "javascript", "html", "snippet", "customcode", "inline", "tagcode",
]);

/* ── CROSS-APPLICATION EVENT NAMES ──────────────────────────────────────────
   One closed list per direction. A kind the receiver does not implement is
   refused by name rather than retried for ever. */
const MARKETING_EVENT_KINDS = Object.freeze({
  HANDOVER_SUBMITTED: "marketing.prospect_handover.submitted",
});

const SALES_OUTCOME_EVENT_KINDS = Object.freeze({
  DECIDED: "sales.marketing_handover.decided",
});

module.exports = {
  TELEMETRY_ONLY_KINDS,
  BOUNCE_CLASSES,
  BOUNCE_CLASS_CODES: codes(BOUNCE_CLASSES),
  EVENT_PROCESSING_STATES,
  EVENT_PROCESSING_STATE_CODES: codes(EVENT_PROCESSING_STATES),
  EVENT_IGNORED_REASONS,
  EVENT_IGNORED_REASON_CODES: codes(EVENT_IGNORED_REASONS),

  DELIVERY_HEALTH,
  DELIVERY_HEALTH_CODES: codes(DELIVERY_HEALTH),
  DELIVERY_EFFECTIVE_HEALTH,
  DELIVERY_EFFECTIVE_HEALTH_CODES: codes(DELIVERY_EFFECTIVE_HEALTH),
  DELIVERY_FAILURE_CLASS,
  DELIVERY_FAILURE_CLASS_CODES: codes(DELIVERY_FAILURE_CLASS),
  DELIVERY_REASONS,
  DELIVERY_REASON_CODES: codes(DELIVERY_REASONS),
  DELIVERY_RETRY,

  CONSENT_CHANNELS,
  CONSENT_CHANNEL_CODES: codes(CONSENT_CHANNELS),
  CONSENT_PURPOSES,
  CONSENT_PURPOSE_CODES: codes(CONSENT_PURPOSES),
  MARKETING_EMAIL,
  CONSENT_INELIGIBLE_REASONS,
  CONSENT_INELIGIBLE_REASON_CODES: codes(CONSENT_INELIGIBLE_REASONS),

  HANDOVER_STATES,
  HANDOVER_STATE_CODES: codes(HANDOVER_STATES),
  SALES_DECISIONS,
  SALES_DECISION_CODES: codes(SALES_DECISIONS),
  DECISION_REASON_REQUIRED,

  CONSENT_STATES,
  CONSENT_STATE_CODES: codes(CONSENT_STATES),
  CONSENT_STATES_ALLOWING_HANDOVER,

  FIT_BANDS,
  FIT_BAND_CODES: codes(FIT_BANDS),
  INTENT_BANDS,
  INTENT_BAND_CODES: codes(INTENT_BANDS),
  RECOMMENDED_ACTIONS,
  RECOMMENDED_ACTION_CODES: codes(RECOMMENDED_ACTIONS),

  INTENT_EVENT_KINDS,
  INTENT_EVENT_KIND_CODES: codes(INTENT_EVENT_KINDS),
  EXPLICIT_REQUEST_KINDS,
  MEANINGFUL_ENGAGEMENT_KINDS,

  ACQUISITION_HOLD_STATES,
  ACQUISITION_HOLD_STATE_CODES: codes(ACQUISITION_HOLD_STATES),
  ACQUISITION_HOLD_REASONS,
  ACQUISITION_HOLD_REASON_CODES: codes(ACQUISITION_HOLD_REASONS),
  ACQUISITION_HOLD_SUPERSEDED_BY,
  ACQUISITION_HOLD_SUPERSEDED_BY_CODES: codes(ACQUISITION_HOLD_SUPERSEDED_BY),
  ACQUISITION_HOLD_FIELD,

  CONTENT_KINDS,
  CONTENT_KIND_CODES: codes(CONTENT_KINDS),
  CONTENT_PUBLICATION_STATES,
  CONTENT_PUBLICATION_STATE_CODES: codes(CONTENT_PUBLICATION_STATES),

  TRACKING_MODES,
  TRACKING_MODE_CODES: codes(TRACKING_MODES),
  TRACKING_DESTINATIONS,
  TRACKING_DESTINATION_CODES: codes(TRACKING_DESTINATIONS),
  TRACKING_VERIFICATION_STATES,
  TRACKING_VERIFICATION_STATE_CODES: codes(TRACKING_VERIFICATION_STATES),
  TRACKING_ID_PATTERNS,
  TRACKING_REFUSED_FIELD_PARTS,

  MARKETING_EVENT_KINDS,
  SALES_OUTCOME_EVENT_KINDS,
};
