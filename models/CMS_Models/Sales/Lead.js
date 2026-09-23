// models/CRM_Models/Lead.js
//
// Lead — a pre-Journey prospect and qualification record (ADR-002). It may
// exist without an Account. It owns source, initial person/company info, the
// first requirement summary, qualification, contact attempts and conversion
// outcome. It does NOT own styles, samples, costing, quotations, negotiation,
// orders, production, shipment or delivery — those belong to the Sales
// Journey once conversion happens (Chunk 5, not implemented here).
//
// LEGACY VS CANONICAL, READ THIS FIRST.
// This model carries two state fields, but — after review — exactly ONE
// piece of code may ever write either of them: services/leadQualification.js.
// See that file's header for the full design; the short version:
//
//   `stage`             — the ORIGINAL enum (new/contacted/qualified/
//                          proposal_sent/negotiation/won/lost). Still
//                          readable without migration, and existing records
//                          created before this revision may still carry
//                          `won` with the old probability=100/
//                          convertedToCustomer side effect — untouched, no
//                          migration runs. But no code path can WRITE `stage`
//                          directly anymore, and no NEW write can ever
//                          produce `proposal_sent`, `negotiation` or `won`
//                          again: routes/CMS_Routes/Sales/leads.js and
//                          routes/CMS_Routes/Sales/callSchedule.js both call
//                          services/leadQualification.js, which either
//                          derives `stage` FROM a validated `qualificationState`
//                          change (deriveLegacyStage) or rejects the request.
//
//   `qualificationState` — the CANONICAL pre-Journey vocabulary (§3 of the
//                          chunk task): new, contacted, qualified,
//                          readyToConvert, nurture, disqualified, duplicate,
//                          converted. Every transition is checked against the
//                          explicit graph in constants/crm.js
//                          (LEAD_QUALIFICATION_TRANSITIONS) — `disqualified`
//                          and `duplicate` are terminal, `converted` is
//                          reserved for the future conversion service and is
//                          never a valid target of any endpoint in this chunk.
//
// `stage` and `qualificationState` cannot contradict each other because
// there is no longer a second writer for either one to drift out of sync
// with the other — `services/leadQualification.js`'s
// applyQualificationTransition() sets both, in one place, from one validated
// input, every time.
//
// Same split for conversion outcome: `convertedToCustomer` / `convertedCustomerId`
// / `convertedAt` (top-level) are LEGACY — read-only from every code path in
// this chunk (the side effect that used to set them on "won" was removed).
// The canonical placeholders live under `conversion.*` below and remain
// fully unset until the Chunk 5 conversion bridge exists.
const mongoose = require("mongoose");
const { companyOwnershipFields, addCompanyIndexes, sealCompanyOwnership } = require("./companyOwnership");
const {
  LEAD_QUALIFICATION_STATE_CODES,
  LEAD_CAPTURE_STATUS_CODES,
  LEAD_REVIEW_STATUS_CODES,
  CUSTOMER_POTENTIAL_CODES,
  REQUIREMENT_CERTAINTY_CODES,
  BUDGET_STATUS_CODES,
  REQUIREMENT_UNIT_CODES,
  LEAD_SOURCE_CODES,
  CONTACT_ROLE_CODES,
  CONTACT_STATUS_CODES,
  PREFERRED_CHANNEL_CODES,
} = require("../../../constants/crm");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
});

const activitySchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["call", "email", "meeting", "note", "status_change", "task"],
    },
    title: { type: String, trim: true },
    description: { type: String, trim: true },
    performedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    performedByName: { type: String },
    scheduledAt: { type: Date },
    completedAt: { type: Date },
    outcome: { type: String, trim: true },
  },
  { _id: true, timestamps: true },
);

// Draft workspace §7 "Research evidence" — a structured, repeatable evidence
// entry supporting a commercial-potential estimate (or a general research
// claim). Only DOCUMENT REFERENCES are stored, never binary file data: an
// uploaded evidence document goes through the app's existing Cloudinary
// uploader (app/api/cloudinary/upload), and only its returned url/publicId/
// filename are kept here — exactly the "store references, not blobs" rule
// every other attachment in this app follows. Enums are inlined here (not in
// constants/crm.js) on purpose: this is a Lead-local vocabulary, the same way
// `industry`/`source` above are inlined rather than promoted to shared
// lookups.
const evidenceSchema = new mongoose.Schema(
  {
    // Which estimate/claim this evidence supports — lets the "Researched or
    // higher estimates need supporting evidence" rule tie a piece of evidence
    // to the specific figure it backs.
    claim: {
      type: String,
      enum: ["annual_quantity", "annual_revenue", "requirement", "general"],
      default: "general",
    },
    evidenceType: {
      type: String,
      enum: [
        "website",
        "news_article",
        "financial_report",
        "tender_notice",
        "industry_report",
        "contact_statement",
        "internal_note",
        "other",
      ],
      default: "other",
    },
    sourceUrl: { type: String, trim: true },
    documentReference: { type: String, trim: true },
    attachmentUrl: { type: String, trim: true },
    attachmentName: { type: String, trim: true },
    attachmentPublicId: { type: String, trim: true },
    note: { type: String, trim: true },
    evidenceDate: { type: Date },
    confidence: {
      type: String,
      enum: ["assumed", "researched", "contact_confirmed", "document_confirmed"],
    },
  },
  { _id: true, timestamps: true },
);

/* ── THE PEOPLE ON A PROSPECT ───────────────────────────────────────────────
 * B2B garment buyers are rarely one person: a merchandiser, a purchase
 * manager, an admin head and whoever actually signs are four different people
 * from the first call onwards. `contacts[]` is where they live.
 *
 * LEAD-LOCAL, deliberately. These are NOT CRMContacts. A CRMContact belongs to
 * an Account, and creating one for a Prospect that may never convert produces
 * an orphan customer record — polluting Contact search, the Contact duplicate
 * checker and every Account-side count with somebody nobody has qualified.
 * They are promoted to real Contacts when the Account is created (Chunk 5).
 *
 * ── CONTACTS ARE THE CANONICAL PERSON DATA ─────────────────────────────────
 * Once a Prospect has `contacts[]`, the PRIMARY contact is the authority for
 * every person-specific value. The Lead's own top-level `firstName`,
 * `lastName`, `designation`, `email`, `phone`, `whatsapp` and the four
 * communication-preference fields become COMPATIBILITY MIRRORS, written FROM
 * the primary and never back into it. Duplicate detection, identityFor, call
 * and WhatsApp matching, the readiness gate and every card read those
 * top-level fields; mirroring keeps all of that working, and a single
 * direction of authority is what stops the two disagreeing.
 *
 * Records captured before `contacts[]` existed have none, and are read exactly
 * as they always were. See syncPrimaryContactMirrors below.
 *
 * `role` (free text) and `isDecisionMaker` are RETAINED unchanged. Old values
 * are prose a salesperson typed — "buyer for the north region" — and are not
 * reinterpreted as enum codes; `roleCode` is the new, separate, structured
 * field and existing rows simply have none. `decisionMakerName`/
 * `decisionMakerRole` on the Lead itself likewise stay the canonical single
 * decision-maker for the qualification check.
 */
const leadContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    jobTitle: { type: String, trim: true },
    department: { type: String, trim: true },

    /* The existing canonical CRM contact roles (constants/crm.js
       CONTACT_ROLES), unchanged. Deliberately NOT a new generic taxonomy:
       these are the roles this business actually deals with, and they are what
       a CRMContact carries after promotion, so a parallel vocabulary would
       have to be mapped — lossily — at conversion. The list is not restated
       here; restating it is how a comment ends up describing a vocabulary that
       has since grown. A later UI may surface the common ones first. */
    roleCode: { type: String, enum: CONTACT_ROLE_CODES },
    /* LEGACY, untouched: free-text role, and the decision-maker flag the
       readiness gate already reads. Not migrated into `roleCode` — prose is
       not an enum value, and guessing which code somebody meant would put
       invented structure into the record. */
    role: { type: String, trim: true },
    isDecisionMaker: { type: Boolean, default: false },

    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },

    /* Person-specific communication preferences. These previously sat on the
       LEAD, which was wrong the moment a second contact existed: a purchase
       manager and a site admin do not share a preferred channel or a good time
       to call. The Lead's copies remain as mirrors of the primary. */
    preferredChannel: { type: String, enum: PREFERRED_CHANNEL_CODES },
    bestContactTime: { type: String, enum: ["morning", "afternoon", "evening", "anytime"] },
    contactTimeNote: { type: String, trim: true },
    preferredLanguage: { type: String, trim: true },

    /* Exactly one active primary — enforced by the schema hook below and again
       at the route boundary, because a rule only the frontend keeps is not a
       rule. */
    isPrimary: { type: Boolean, default: false },
    /* active · left_organization · do_not_contact, from the CRM's own list.
       `do_not_contact` will block outreach to THIS person while leaving the
       other contacts reachable (Chunk 3); nothing enforces it yet. */
    status: { type: String, enum: CONTACT_STATUS_CODES, default: "active" },
    notes: { type: String, trim: true },

    /* Normalised identity, kept ON the person rather than in a record-level
       array, so a later duplicate result can say WHICH contact matched rather
       than only that the record did (Chunk 4). Derived, never client-supplied
       — see the pre-validate hook below. */
    normalizedEmail: { type: String, trim: true, lowercase: true },
    normalizedPhone: { type: String, trim: true },
    normalizedWhatsapp: { type: String, trim: true },

    /* Set at Account promotion (Chunk 5) so the Lead's own timeline can still
       resolve people afterwards, and so a re-run cannot double-create.
       Additive and unused for now — introducing it here costs nothing and
       saves a second schema change on a collection this size. */
    promotedContactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },
  },
  { _id: true },
);

const leadSchema = new mongoose.Schema(
  {
    /* ── COMPANY OWNERSHIP (Chunk 3B1) ────────────────────────────────────
       Server-derived at creation, never from the request. See
       models/CMS_Models/Sales/companyOwnership.js for the hierarchy and why
       every level carries the company directly rather than through a join. */
    ...companyOwnershipFields(),

    // Server-assigned, atomic per-year sequence (services/leadRef.js) —
    // mirrors SalesJourney.journeyId exactly. Required + immutable because a
    // Lead is always created WITH its reference already reserved (see
    // leads.js `POST /`, which calls createWithRef before this document is
    // ever saved) — there is no auto-generating pre-save hook here, on
    // purpose, so there is one place this value comes from, not two.
    leadId: { type: String, required: true, unique: true, immutable: true, trim: true },

    // ── Capture status (Draft Lead chunk) — ORTHOGONAL to qualificationState
    // below; see this file's header and constants/crm.js's own block comment
    // for why "draft" is never added to that enum instead. Default "active"
    // covers any creation path that doesn't set it explicitly; an EXISTING
    // pre-chunk record has no value here at all (no migration runs) and every
    // query treats that missing value as "active" too — see leads.js.
    captureStatus: { type: String, enum: LEAD_CAPTURE_STATUS_CODES, default: "active" },

    // ── Prospect review status (Prospect → HOD Review → Active Lead workflow)
    // — a THIRD, independent axis (see constants/crm.js's block comment).
    // Only meaningful while captureStatus is "draft" (a Prospect): begins
    // "researching", moves to "submitted" on Submit to HOD (read-only until
    // reviewed), then a HOD/admin approves ("approved" + captureStatus flips
    // to "active"), returns ("returned", editable again) or rejects
    // ("rejected" + captureStatus flips to "archived"). Default "researching"
    // so a newly-captured Prospect is immediately in the salesperson's hands;
    // a missing value (pre-workflow record) also reads as "researching". Only
    // services/leadReview.js writes this — never a generic PATCH.
    reviewStatus: { type: String, enum: LEAD_REVIEW_STATUS_CODES, default: "researching" },
    // "Why should we pursue this?" — the short justification a HOD reviews.
    // Distinct from `requirements` (a CONFIRMED requirement), `notes`
    // (general) and `organisationNotes` (org research): this is the case FOR
    // pursuing, part of the submission checklist (services/leadReadiness.js).
    pursuitJustification: { type: String, trim: true },
    // Review audit trail — who submitted/reviewed and when, plus the HOD's
    // reason on a return or reject (required for both). Server-set only.
    submittedAt: { type: Date },
    submittedBy: actorRef(),
    reviewedAt: { type: Date },
    reviewedBy: actorRef(),
    reviewReason: { type: String, trim: true },

    /* ── WHY THIS PROSPECT BECAME A LEAD ─────────────────────────────────────
     * A Prospect is only a possible customer. What turns it into a Lead is not
     * a commercial estimate — it is an observed signal that the customer wants
     * something: they asked for a catalogue, a sample, a price.
     *
     * Recorded as its own small group rather than folded into `notes`, because
     * "what made us believe this was real" is the one fact a later review, a
     * manager, or the salesperson themselves will actually go looking for, and
     * a free-text note is where questions like that go to be lost.
     *
     * The signal is a fixed vocabulary so it can be counted — "how many Leads
     * came from a sample request" is a question the business can ask of this
     * field and cannot ask of prose. `interestNote` carries the specifics that
     * a vocabulary cannot.
     *
     * Additive. Nothing reads these before conversion, and every existing
     * Prospect and Lead keeps working with them empty. */
    interestSignal: {
      type: String,
      enum: [
        "requested_product_info",
        "requested_catalogue",
        "requested_sample",
        "requested_quotation",
        "requested_meeting",
        "shared_requirement",
        "asked_price_or_delivery",
        "agreed_to_continue",
        "other",
      ],
      // No default, for the same reason `source` has none: an unset signal
      // must fail the conversion check rather than quietly pass it as "other".
    },
    interestNote: { type: String, trim: true },
    /* Server-set at conversion, exactly like submittedBy/reviewedBy above. The
       client never sends these — who confirmed the interest, and when, is a
       claim the server has to make on its own or it is worth nothing. */
    interestConfirmedAt: { type: Date },
    interestConfirmedBy: actorRef(),

    // "Archive Draft" (not the general hard-archive below) — who and when.
    // Deliberately separate from archivedAt/archivedBy: those belong to the
    // pre-existing isActive soft-delete (DELETE /:id), a different action
    // with different meaning that a Draft-only archive must not collide with.
    draftArchivedAt: { type: Date },
    draftArchivedBy: actorRef(),
    // Stamped when a salesperson has reviewed the duplicate-check results for
    // this Draft's CURRENT identity fields — cleared automatically the moment
    // any of those fields change again (see the pre-save hook below), so a
    // stale review can never silently satisfy the activation checklist for
    // different data. Read by services/leadReadiness.js via the route, which
    // also always re-runs the check live at activation regardless.
    duplicateReviewedAt: { type: Date },

    // Lead Capture chunk. Which half of "Prospect" the salesperson led
    // with — drives the form's field emphasis only; validation below accepts
    // either half regardless of this value. Not enum-locked in constants/crm
    // for the same reason `industry`/`companySize` below aren't: a small,
    // Lead-local set, not a cross-module vocabulary.
    prospectType: { type: String, enum: ["company", "individual"], default: "individual" },

    // Basic Info. `firstName` is no longer required at the field level — Lead
    // Chunk 1 explicitly allows a company-first capture with no contact name
    // yet identified. The cross-field rule ("company OR firstName") is
    // enforced by the validator below, on the document, so it also protects a
    // later PATCH from blanking both. routes/CMS_Routes/Sales/leads.js
    // additionally checks this at the API boundary for a clean 400 message.
    firstName: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          return Boolean(String(v || "").trim()) || Boolean(String(this.company || "").trim());
        },
        message: "Provide a company name or a first name.",
      },
    },
    lastName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },

    // Company Info. Mirrors the same cross-field validator as `firstName`
    // above, for the same reason a validator only on ONE side of an OR rule
    // is not enough: Mongoose skips a path's validator entirely when that
    // path's own value is `undefined` (a Lead created company-only never
    // touches `firstName`, so firstName's validator alone would never fire on
    // a later PATCH that blanks `company` back to ""). Attaching the mirror
    // here means whichever of the two fields actually holds a request's
    // change is the one that validates the pair.
    company: {
      type: String,
      trim: true,
      validate: {
        validator: function (v) {
          return Boolean(String(v || "").trim()) || Boolean(String(this.firstName || "").trim());
        },
        message: "Provide a company name or a first name.",
      },
    },
    designation: { type: String, trim: true },
    // Customer segment — ONE consistent dimension (what TYPE of buying
    // organisation this is), not a mix of industry/product/programme.
    // Retaxonomized on correction (Prospect capture chunk) — codes after
    // "other" are LEGACY, kept only so pre-existing records with those
    // values keep validating; the UI (lib/leadQualification.js-adjacent
    // CUSTOMER_SEGMENT_OPTIONS in leadSections.js) never offers them again.
    // No `default` — genuinely unset until a real choice is made; this field
    // isn't gated by any readiness check today, but the principle (never
    // silently substitute a default for "nobody chose this") applies the
    // same way it does to `source` below.
    industry: {
      type: String,
      enum: [
        "corporate",
        "institutional",
        "hospitality",
        "retail_brand",
        "export_buyer",
        "distributor",
        "individual",
        "other",
        // legacy — no longer offered in the UI
        "garments",
        "retail",
        "wholesale",
        "export",
        "school_uniform",
        "healthcare",
      ],
    },
    companySize: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
    },
    website: { type: String, trim: true },
    // Draft workspace §3 "Organisation research" — free-text findings about
    // the org itself (locations, group structure, recent news...), distinct
    // from `notes` (general) and `requirements` (the immediate ask).
    organisationNotes: { type: String, trim: true },

    // Draft workspace §4 "Commercial potential" — a light read on whether/how
    // much this prospect might buy, for ANY garment buyer (uniforms, brands,
    // exporters...), NOT a copy of CRMAccount's full garmentSalesProfile (that
    // richness belongs to the Account once one exists; a Lead stays lightweight
    // per this file's own header). customerPotential reuses
    // CUSTOMER_POTENTIAL_CODES — the same codes Account.garmentSalesProfile
    // already uses — rather than a second, Lead-local vocabulary for the same
    // idea. `estimatedWearerCount` is retained (unused by the current UI) so no
    // pre-existing data is lost; the generalised UI captures annual quantity/
    // revenue instead.
    customerPotential: { type: String, enum: CUSTOMER_POTENTIAL_CODES },
    estimatedWearerCount: { type: Number, min: 0 },
    // Estimated ANNUAL figures, each with its own confidence — distinct from
    // the CONFIRMED, opportunity-specific `estimatedQuantity` under
    // Requirements below (researched potential must stay clearly separate from
    // a confirmed requirement). Confidence codes are inlined (Lead-local), same
    // vocabulary as evidenceSchema.confidence above.
    estimatedAnnualQuantity: { type: Number, min: 0 },
    estimatedAnnualQuantityConfidence: {
      type: String,
      enum: ["assumed", "researched", "contact_confirmed", "document_confirmed"],
    },
    estimatedAnnualRevenue: { type: Number, min: 0 },
    estimatedAnnualRevenueConfidence: {
      type: String,
      enum: ["assumed", "researched", "contact_confirmed", "document_confirmed"],
    },
    // Unit economics — ₹ per piece. Grounds the annual revenue estimate
    // (quantity × unit price), so revenue isn't a free-floating guess.
    estimatedUnitPrice: { type: Number, min: 0 },
    estimatedUnitPriceConfidence: {
      type: String,
      enum: ["assumed", "researched", "contact_confirmed", "document_confirmed"],
    },
    // Per-figure source, attached INLINE to each estimate (a link, a document
    // reference, or a "confirmed by <name> on <date>" note). Once a figure's
    // basis is "researched" or higher, this is what backs it — no separate
    // evidence record needed. The qualification gate reads these directly (see
    // services/leadReadiness.js computeQualificationReadiness).
    estimatedAnnualQuantitySource: { type: String, trim: true },
    estimatedAnnualRevenueSource: { type: String, trim: true },
    estimatedUnitPriceSource: { type: String, trim: true },

    // Draft workspace §6 "Procurement information" — how this prospect buys
    // and from whom today, gathered as research, not a formal RFQ record.
    decisionMakerName: { type: String, trim: true },
    decisionMakerRole: { type: String, trim: true },
    procurementProcess: { type: String, trim: true },
    existingSupplier: { type: String, trim: true },
    // The full stakeholder list (Chunk B) — see leadContactSchema above.
    contacts: { type: [leadContactSchema], default: undefined },

    // Draft workspace §7 "Research evidence" — where the above came from.
    // `researchNotes` is a section-level overall note; `evidence[]` is the
    // structured, multi-entry list (see evidenceSchema above). `evidenceLinks`
    // is the earlier flat one-URL-per-line field, retained so no pre-existing
    // data is lost — the current UI writes `evidence[]` instead.
    researchNotes: { type: String, trim: true },
    evidenceLinks: [{ type: String, trim: true }],
    evidence: [evidenceSchema],

    // Lead Details — the CHANNEL a Prospect was found through, distinct from
    // `sourcedBy` below (the EMPLOYEE who found it). Extended (Prospect
    // capture chunk) with google/linkedin/directory/field_visit — additive
    // only, no code removed and no migration: existing records keep reading
    // fine, only new capture gains the finer-grained choices. Display labels
    // (not these codes) live in lib/leadQualification.js's SOURCES.
    source: {
      type: String,
      /* The codes live in constants/crm.js LEAD_SOURCES, in their original
         order, so the model, the lookups endpoint and every label agree.
         `marketing_campaign` (Marketing handover chunk) and `indiamart`
         (IndiaMART routing, 2026-09-22) were added there — additive only: no
         existing record's `source` changes and no migration runs. `indiamart`
         is what a buyer enquiry routed from IndiaMART carries, so it is never
         reported as a Marketing campaign. */
      enum: LEAD_SOURCE_CODES,
      // No `default` (correction) — "Lead source recorded" is a genuine
      // readiness/activation check (services/leadReadiness.js); a silent
      // "other" default let that check pass even when nobody had actually
      // picked a source. Every write path (Quick Capture, Prospect Setup's
      // OriginSection) now only sends `source` when a real choice was made.
    },

    /* ── WHERE THIS PROSPECT ACTUALLY CAME FROM ──────────────────────────────
     * `source` is a category; these are the specifics that make it findable
     * again. "Referral" is only useful if somebody recorded WHO referred them;
     * "trade show" is only useful with the name of the show.
     *
     * Three separate fields rather than one free-text blob because two of them
     * are conditional on the source and one is not — folding them together
     * would mean parsing prose to answer "which exhibition produced the most
     * Prospects", which is a question the business will ask.
     *
     * All optional, all additive. Nothing reads them as a gate. */
    sourceDetails: { type: String, trim: true },
    referredBy: { type: String, trim: true },
    campaignOrEvent: { type: String, trim: true },

    /* ── WHAT MARKETING HANDED OVER, IF ANYTHING ────────────────────────────
     * A COMPACT PROJECTION, NOT A SECOND MARKETING STORE.
     *
     * Present only on a Prospect created by the Marketing application's
     * handover (services/sales/marketingProspectIntake.service.js is the only
     * writer). Every other Lead has no such field, no migration runs, and
     * nothing in the existing Prospect or Lead workflow reads it.
     *
     * WHY IT IS HERE AND NOT ONLY ON THE RECEIPT. A salesperson opening a
     * Prospect must see, in the record itself, that Marketing sent it, from
     * which campaign, on what permission, and how fresh that is — otherwise
     * they call somebody whose consent state they cannot see. The full
     * package, the evidence and the decision live on the receipt
     * (models/CMS_Models/Sales/MarketingProspectIntake.js); this is the label
     * on the front of the record.
     *
     * WHAT IT MAY NEVER GROW: the raw engagement stream, a marketing score, or
     * anything a Sales screen would then have to keep in step with Mautic.
     * Duplicating Marketing's event store here is exactly the "second activity
     * timeline inside Sales" the roadmap forbids.
     *
     * IT CARRIES NO LIFECYCLE MEANING. `captureStatus`, `reviewStatus` and
     * `qualificationState` remain the only lifecycle axes, each with its
     * single existing writer. A handover cannot move any of them. */
    marketingHandover: {
      /* The identity Marketing and Sales both quote. Unique per company (see
         the partial index below), which is what makes a redelivered handover
         event structurally incapable of creating a second Prospect. */
      handoverRef: { type: String, trim: true },
      receivedAt: { type: Date },
      campaignId: { type: String, trim: true },
      campaignName: { type: String, trim: true },
      assetName: { type: String, trim: true },
      sourceSystem: { type: String, trim: true },
      /* Marketing permission as it stood when Sales was told. A stale copy is
         better than no copy only because it is dated: `permissionAsOf` is what
         lets a salesperson see that it is stale. */
      emailConsent: { type: String, trim: true },
      phoneConsent: { type: String, trim: true },
      permissionAsOf: { type: Date },
      lastEngagedAt: { type: Date },
      accountFit: { type: String, trim: true },
      intent: { type: String, trim: true },
      handoverReason: { type: String, trim: true },
      recommendedAction: { type: String, trim: true },
      /* Which data provider enriched this person, by name — so an enriched
         field is never presented as something GRAV observed itself. */
      dataProviders: [{ type: String, trim: true }],
      /* ── WHEN THE HANDOVER CAME FROM A LEAD SOURCE (IndiaMART) ─────────────
         Additive (2026-09-22). What the buyer's enquiry was, under GRAV's own
         reference (MSE-…) — never the source's id — and when it was made,
         with where that time came from. Absent on every campaign handover. */
      sourceEnquiry: {
        source: { type: String, trim: true },
        sourceRef: { type: String, trim: true },
        kind: { type: String, trim: true },
        channel: { type: String, trim: true },
        submittedAt: { type: Date },
        submittedAtText: { type: String, trim: true },
        submittedAtProvenance: { type: String, trim: true },
        submittedAtConfirmedBy: { type: String, trim: true },
      },
    },

    /* An early observation of what the customer might want — deliberately NOT
     * `requirements[]`, which is a structured commitment made on an Active
     * Lead. This is the sentence a salesperson writes after one phone call,
     * and it is allowed to be wrong. */
    possibleNeed: { type: String, trim: true },

    /* ── WHAT IS ACTUALLY KNOWN ABOUT A POSSIBLE CUSTOMER ────────────────────
     * Factual, optional context a salesperson can record before anybody has
     * qualified anything. Deliberately NOT commercial: no quantities, budgets,
     * delivery dates or revenue estimates live here — those are an Active
     * Lead's business, and asking for them this early is how an invented
     * figure becomes an indistinguishable "fact".
     *
     * Controlled vocabularies where the options are fixed, so they can be
     * counted; free text only where a vocabulary genuinely cannot carry the
     * answer. Every one is optional, none gates conversion, and all of them
     * survive Prospect → Lead untouched — it is the same record. */

    /* What KIND of buyer this is, in the words the sales floor uses. Distinct
     * from `industry` (the "Customer segment" taxonomy used in reporting),
     * which is a qualification judgement made later. */
    businessType: {
      type: String,
      enum: [
        "hotel_hospitality",
        "hospital_healthcare",
        "school_education",
        "corporate_office",
        "industrial_workwear",
        "retail_fashion",
        "distributor_wholesaler",
        "government_institution",
        "individual",
        "other",
      ],
    },
    // How they would rather be reached, and when — the difference between a
    // follow-up that lands and one that annoys.
    preferredContactMethod: { type: String, enum: ["call", "whatsapp", "email", "none"] },
    bestContactTime: { type: String, enum: ["morning", "afternoon", "evening", "anytime"] },
    contactTimeNote: { type: String, trim: true },
    preferredLanguage: { type: String, trim: true },
    /* A BROAD, early guess at what they might buy — a fixed vocabulary so it
     * can be counted and filtered. Deliberately separate from
     * `productInterest[]`, which is derived from `requirementItems[]` (the
     * confirmed, per-product requirement on an Active Lead) and would be
     * overwritten by that sync. These two answer different questions: "what do
     * we think they're in the market for" and "what have they actually asked
     * us to quote". */
    productInterests: [{
      type: String,
      enum: [
        "uniforms",
        "workwear",
        "hospitality_linen",
        "corporate_apparel",
        "school_wear",
        "healthcare_garments",
        "custom_garments",
        "not_known",
      ],
    }],
    // LEGACY. Unchanged enum, unchanged default, unchanged meaning — see the
    // file header. Only ever written by services/leadQualification.js now,
    // derived from a validated qualificationState change.
    stage: {
      type: String,
      enum: [
        "new",
        "contacted",
        "qualified",
        "proposal_sent",
        "negotiation",
        "won",
        "lost",
      ],
      default: "new",
    },

    // CANONICAL. §3 of the chunk task, codes reproduced verbatim from the
    // spec (see constants/crm.js). Every change is validated against
    // LEAD_QUALIFICATION_TRANSITIONS (also constants/crm.js) by
    // services/leadQualification.js — see file header.
    qualificationState: {
      type: String,
      enum: LEAD_QUALIFICATION_STATE_CODES,
      default: "new",
    },
    // Required by the canonical transition API for `disqualified`/`duplicate`/
    // `nurture` outcomes. Free text — the checklist itself is Chunk 3 scope.
    qualificationReason: { type: String, trim: true },
    // The GENUINE existing Lead/Account link required to set qualificationState
    // to "duplicate" (Lead correction chunk) — services/leadQualification.js
    // refuses that transition unless the referenced record was verified to
    // actually exist at the moment of the move (routes/CMS_Routes/Sales/
    // leads.js). Not a merge — the two records stay independent; this only
    // records which one this Lead was identified as a duplicate of.
    duplicateOf: {
      type: { type: String, enum: ["lead", "account"] },
      id: { type: mongoose.Schema.Types.ObjectId },
    },
    // Evidence that qualification information was actually gathered, e.g. the
    // date a requirement summary was received. Not auto-set by this chunk —
    // Chunk 3's qualification workspace is expected to populate it.
    requirementReceivedAt: { type: Date },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      /* ── NO DEFAULT ────────────────────────────────────────────────────────
       * It defaulted to "medium", which made every record claim a priority
       * nobody had chosen — and made the Prospect form's "Optional / Not set"
       * a lie twice over: new Prospects arrived as Medium, and choosing "Not
       * set" sent "" into an enum that refused it.
       *
       * Unset is now a real state. The Leads list already handled it:
       * `PRIORITY_RANK[a.priority] ?? 2` sorts an absent priority exactly
       * where "medium" used to sit, so ordering is unchanged for every record
       * that never had one deliberately.
       *
       * Records already holding "medium" keep it. This removes the default for
       * NEW documents; it does not migrate existing ones, and a stored
       * "medium" is indistinguishable from a chosen one — which is precisely
       * the ambiguity the default created and why it is going. */
    },
    estimatedValue: { type: Number, default: 0 },
    probability: { type: Number, min: 0, max: 100, default: 20 },
    expectedCloseDate: { type: Date },

    // Requirements. `requirementItems` is the STRUCTURED, per-product breakdown
    // (each garment with its own quantity); `productInterest` (the flat list of
    // product names) and `estimatedQuantity` (the total across items) are kept
    // in sync from it so the existing readiness gate and duplicate-matching
    // keep working unchanged.
    requirementItems: [
      new mongoose.Schema(
        {
          product: { type: String, trim: true },
          quantity: { type: Number, min: 0 },
          /* Per row, because one requirement can mix them: 400 shirts and 200
             metres of the same fabric. Left unset rather than defaulted — the
             form shows "pieces" as the pre-selected answer, but storing that
             for a row nobody typed would claim a unit the customer never gave. */
          unit: { type: String, enum: REQUIREMENT_UNIT_CODES },
        },
        { _id: false },
      ),
    ],
    productInterest: [{ type: String, trim: true }],
    estimatedQuantity: { type: Number },
    deliveryTimeline: { type: String, trim: true },
    // "Expected requirement date" (Lead Capture chunk form) — when the
    // customer needs the product, distinct from `expectedCloseDate` above
    // (the legacy sales-pipeline close-date field, which this form does not
    // use).
    requirementDate: { type: Date },
    /* Optional DETAIL behind `budgetStatus`. Free text, and deliberately still
       free text: existing values like "₹50L approved for FY26" stay readable
       and editable exactly as typed. Nothing reinterprets or migrates them. */
    budget: { type: String, trim: true },
    /* Where the money stands, as a state rather than a figure — see
       constants/crm.js BUDGET_STATUSES for why. Optional; no stage reads it. */
    budgetStatus: { type: String, enum: BUDGET_STATUS_CODES },
    /* The one thing most likely to stop this order, in the salesperson's own
       words. Optional. Not a stage input — a fact worth having on the record
       before somebody quotes. */
    keyObjection: { type: String, trim: true },
    requirements: { type: String, trim: true },
    /* The programme this requirement belongs to — "hotel opening", "annual
       staff uniforms", "school term intake". The one genuinely missing
       requirement field: without it a 400-shirt line reads the same whether it
       is a one-off event or the start of a yearly cycle. */
    requirementUseCase: { type: String, trim: true },
    // Lead correction chunk — how firmly the CONFIRMED current requirement
    // above is actually known, separate from `estimatedAnnual*Confidence`
    // (which grades the RESEARCHED annual commercial potential, not this).
    // Gates the "Qualified" checklist — see services/leadReadiness.js.
    requirementCertainty: { type: String, enum: REQUIREMENT_CERTAINTY_CODES, default: "unknown" },

    // Assignment. `assignedTo` is the changeable OWNER — who is currently
    // responsible for working the Lead. `sourcedBy` (Lead Capture chunk) is
    // permanent credit for who actually found/originated the opportunity;
    // for an ordinary salesperson the two are almost always the same person,
    // but a manager capturing a Lead on someone else's behalf can set them
    // independently (see leads.js POST /). Both default to the creator when
    // omitted. Neither is the audit-only `createdBy` below.
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    assignedToName: { type: String },
    sourcedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SalesDepartment",
    },
    sourcedByName: { type: String },

    // Location
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" },

    // Tracking
    lastContactedAt: { type: Date },
    nextFollowUpAt: { type: Date },
    lostReason: { type: String, trim: true },
    notes: { type: String, trim: true },
    tags: [{ type: String, trim: true }],

    // Draft workspace §8 "First next action" — the INTENDED first follow-up,
    // captured while still a Draft (which must not get a real Activity yet).
    // POST /:id/activate turns this into the actual shared CRMActivity and
    // sets nextFollowUpAt from the same dueDate; until then it lives only
    // here. Plain nested object (no sub-schema class), matching `conversion`
    // below's own style for a small cohesive group.
    pendingFirstAction: {
      subject: { type: String, trim: true },
      dueDate: { type: Date },
      notes: { type: String, trim: true },
      /* WHO this one action is aimed at — an embedded contact's `_id`, not a
         CRMContact. Optional: a general next action ("chase the tender
         document") is about the record, and every existing record has none.

         Deliberately ONE action with an optional target, not a follow-up
         schedule per person. A Prospect has one thing to do next; giving each
         contact their own would turn a work queue into four. */
      leadContactId: { type: mongoose.Schema.Types.ObjectId },
    },

    // ── Conversion — LEGACY (top-level). See file header. Not written by any
    // canonical code path in this chunk; kept for read compatibility only.
    convertedToCustomer: { type: Boolean, default: false },
    convertedCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    convertedAt: { type: Date },

    // ── Conversion — CANONICAL placeholders (§4). Deliberately unset by this
    // chunk; no conversion endpoint exists yet. Chunk 5 is the only future
    // writer.
    conversion: {
      accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },
      contactId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMContact" },
      journeyId: { type: mongoose.Schema.Types.ObjectId, ref: "SalesJourney" },
      convertedAt: { type: Date },
      convertedBy: actorRef(),
    },

    // Related
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount" },
    // LEGACY embedded timeline. Readable only — nothing in the codebase
    // appends to it anymore (PATCH /:id/stage and POST /:id/activity, the
    // last two writers, were both moved onto the shared CRMActivity model;
    // see leads.js). Existing pre-fix entries are never migrated or deleted.
    activities: [activitySchema],

    // ── Duplicate-detection foundations (§7). Normalized, indexed helpers
    // only — no matching UI, no auto-merge in this chunk. Recomputed on save
    // whenever their source field changes.
    normalizedCompany: { type: String, trim: true, lowercase: true },
    emailDomain: { type: String, trim: true, lowercase: true },
    normalizedPhone: { type: String, trim: true },
    /* The record's own WhatsApp number, normalised like the rest. It had no
       derived form, so a cross-record identity check could not see it — a Lead
       whose WhatsApp matched another Lead's looked unique. Additive: existing
       records gain it on their next save. */
    normalizedWhatsapp: { type: String, trim: true, index: true },
    websiteDomain: { type: String, trim: true, lowercase: true },

    // ── Audit actors (§4), matching the Step-01 CRM convention (Activity.js,
    // SalesJourney.js). Server-assigned only — see leads.js.
    createdBy: actorRef(),
    updatedBy: actorRef(),
    archivedAt: { type: Date },
    archivedBy: actorRef(),

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// ── Normalized fields for future duplicate matching (Chunk 4). Pure derived
// data — never read as a source of truth, only as a lookup aid.
const digitsOnly = (s) => String(s || "").replace(/\D+/g, "");
const domainOf = (email) => {
  const at = String(email || "").split("@")[1];
  return at ? at.toLowerCase().trim() : "";
};
const hostOf = (url) => {
  if (!url) return "";
  try {
    const withProto = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    return new URL(withProto).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return String(url).replace(/^www\./i, "").toLowerCase().trim();
  }
};

/* ── ONE PRIMARY, AND THE MIRRORS THAT FOLLOW IT ────────────────────────────
 * Everything below runs on WRITE only. A read never mutates a record — a GET
 * that quietly materialises a contact would rewrite history on every page
 * load, and would do it under whichever user happened to open the page.
 *
 * The form adapter presents a legacy record's top-level person as a synthetic
 * contact for display; it becomes real the first time somebody saves.
 */

/* ── TWO CHANNEL VOCABULARIES, MAPPED ONCE ─────────────────────────────────
   A contact carries the CRM's own `PREFERRED_CHANNELS` (email · phone ·
   messaging · portal · none) — the same list CRMContact uses, so promotion to
   a real Contact at Account creation is lossless.

   The Lead's legacy `preferredContactMethod` is a different, older set (call ·
   whatsapp · email · none) written for the Prospect form. Mirroring one onto
   the other without a translation writes an invalid enum value and the whole
   save fails — which is exactly what happened the first time this ran.

   `portal` has no legacy equivalent, so the mirror is cleared rather than
   guessed at: an absent preference is honest, a wrong one is not. */
const LEGACY_CONTACT_METHOD = {
  phone: "call",
  messaging: "whatsapp",
  email: "email",
  none: "none",
  // portal → undefined
};

/** The comparable form of a phone number: digits only, matching the Lead's own
 *  `normalizedPhone` rule so a contact and a record normalise identically. */
const contactPhone = (v) => String(v ?? "").replace(/\D+/g, "");
const contactEmail = (v) => String(v ?? "").trim().toLowerCase();

/** A structural violation of the contact contract. Carries `status: 400` so a
 *  route's existing catch reports it as the client error it is. */
class LeadContactError extends Error {
  constructor(message) {
    super(message);
    this.name = "LeadContactError";
    this.status = 400;
  }
}

/**
 * Normalise each contact's identity, then ASSERT the primary contract.
 *
 * ── IT VALIDATES, IT NO LONGER REPAIRS ─────────────────────────────────────
 * The first version of this silently settled a malformed list: several
 * primaries became "the last one wins", no primary became "the first active
 * one". Both are guesses. This function cannot know which contact somebody
 * just clicked, and choosing by array order means a reorder in the UI silently
 * moves the primary. A rejected save is visible and correctable; a repaired
 * one is neither.
 *
 * So the rules are assertions:
 *   · an Individual Prospect has at most ONE contact — `prospectType` is the
 *     authority, and a record that needs several must be changed to
 *     Organisation deliberately, not overridden here;
 *   · at most one contact may be marked primary;
 *   · only an ACTIVE contact may be primary;
 *   · several active contacts with none marked is ambiguous and refused.
 *
 * The single permitted inference: one active contact and nothing marked
 * becomes primary. There is no choice to get wrong.
 *
 * A Prospect with no contacts at all is valid — early capture often knows only
 * the company. A Prospect whose contacts are all inactive may have no primary;
 * it simply cannot convert.
 */
function settleContacts(lead) {
  const list = lead.contacts;
  if (!Array.isArray(list) || list.length === 0) return null;

  for (const c of list) {
    c.normalizedEmail = contactEmail(c.email) || undefined;
    c.normalizedPhone = contactPhone(c.phone) || undefined;
    c.normalizedWhatsapp = contactPhone(c.whatsapp) || undefined;
    if (!c.status) c.status = "active";
  }

  /* ── `prospectType` IS THE AUTHORITY ──────────────────────────────────
     An earlier version inferred the type from the presence of a company name,
     so an explicitly Individual Prospect with an employer on file was treated
     as an Organisation — overriding a choice the user actually made, forever
     and invisibly. A record that genuinely needs several people is changed to
     Organisation deliberately. Extra contacts are neither demoted nor
     deleted: the save is refused and says why. */
  if (lead.prospectType === "individual" && list.length > 1) {
    throw new LeadContactError(
      "An Individual Prospect can have only one contact — that person IS the prospect. Change its type to Organisation to record several people.",
    );
  }

  const active = list.filter((c) => c.status === "active");
  const flagged = list.filter((c) => c.isPrimary);

  if (flagged.length > 1) {
    throw new LeadContactError("Only one contact can be the primary contact. Mark exactly one.");
  }
  if (flagged.length === 1 && flagged[0].status !== "active") {
    throw new LeadContactError(
      `The primary contact must be active — "${flagged[0].name}" is marked ${flagged[0].status.replace(/_/g, " ")}. Mark another active contact as primary.`,
    );
  }
  if (flagged.length === 1) return flagged[0];

  /* Nothing marked. One active contact is unambiguous; several is a question
     only the user can answer. */
  if (active.length === 1) {
    active[0].isPrimary = true;
    return active[0];
  }
  if (active.length > 1) {
    throw new LeadContactError("Mark which of these people is the primary contact.");
  }
  return null;   // contacts exist but none is active — valid, cannot convert
}

/**
 * Copy the primary contact's person data onto the Lead's legacy fields.
 *
 * ONE DIRECTION ONLY. Syncing both ways would create two authorities that
 * agree until the first conflicting edit, and then quietly disagree forever.
 * The primary contact is the authority; these fields are its shadow, kept
 * because duplicate detection, identityFor, call/WhatsApp matching, the
 * readiness gate and every list column read them.
 *
 * A record with no contacts is left completely alone — that is a legacy
 * Prospect, and its top-level fields are its real data.
 */
function syncPrimaryContactMirrors(lead) {
  const primary = settleContacts(lead);
  if (!primary) return;

  const parts = String(primary.name || "").trim().split(/\s+/).filter(Boolean);
  lead.firstName = parts[0] || "";
  lead.lastName = parts.slice(1).join(" ");
  lead.designation = primary.jobTitle || primary.role || "";
  lead.email = primary.email || "";
  lead.phone = primary.phone || "";
  lead.whatsapp = primary.whatsapp || "";
  lead.preferredContactMethod = LEGACY_CONTACT_METHOD[primary.preferredChannel];
  lead.bestContactTime = primary.bestContactTime || undefined;
  lead.contactTimeNote = primary.contactTimeNote || "";
  lead.preferredLanguage = primary.preferredLanguage || "";
}

/* Runs before validation so a required `name` is still enforced by Mongoose,
   and before the identity hook below so the mirrored phone/email are what get
   normalised into normalizedPhone/emailDomain. */
leadSchema.pre("validate", function (next) {
  if (!this.isModified("contacts") && !this.isModified("prospectType")) return next();
  try {
    syncPrimaryContactMirrors(this);
  } catch (err) {
    /* A contract violation, not a crash — handed to Mongoose so it surfaces
       through the same path every other validation failure uses. */
    return next(err);
  }
  next();
});

/* ── THE PROJECTIONS ARE DERIVED, NOT MAINTAINED ─────────────────────────────
   `productInterest[]` (flat product names) and `estimatedQuantity` (the total)
   are views of `requirementItems[]`, and the form used to send all three. Two
   writers of one fact eventually disagree, and here the disagreement would be
   silent: the readiness gate reads the projections, so a stale total could
   qualify a Lead whose lines say otherwise. The rows are now the only thing
   anybody edits, and these follow from them.

   Only when `requirementItems` is actually touched — a Lead that predates the
   structured rows keeps whatever its projections already hold, because
   rebuilding them from an empty array would erase real data. */
leadSchema.pre("save", function (next) {
  if (this.isModified("requirementItems")) {
    const rows = (this.requirementItems || []).filter((r) => String(r.product ?? "").trim());
    this.productInterest = rows.map((r) => String(r.product).trim());
    const quantities = rows.filter((r) => r.quantity != null && r.quantity !== "");
    this.estimatedQuantity = quantities.length
      ? quantities.reduce((sum, r) => sum + (Number(r.quantity) || 0), 0)
      : undefined;
  }
  next();
});

leadSchema.pre("save", function (next) {
  /* ── EVERY IDENTITY THE DUPLICATE CHECK READS ──────────────────────────
     A duplicate review certifies the identity data it was performed against.
     `whatsapp` and the people in `contacts[]` are both identity now — the
     cross-record ambiguity check matches on them — so changing either has to
     retire the review. Leaving them out meant adding a second contact whose
     number already sat on another Lead kept a green "reviewed" stamp that had
     never seen that number. */
  const identityChanged =
    this.isModified("company") || this.isModified("email") ||
    this.isModified("phone") || this.isModified("website") ||
    this.isModified("whatsapp") || this.isModified("contacts");
  if (this.isModified("company")) this.normalizedCompany = String(this.company || "").trim().toLowerCase();
  if (this.isModified("email")) this.emailDomain = domainOf(this.email);
  if (this.isModified("phone")) this.normalizedPhone = digitsOnly(this.phone);
  /* The record's own WhatsApp number, normalised like the rest. It had no
     derived form, so a cross-record identity check could not see it — a Lead
     whose WhatsApp matched another Lead's looked unique. Additive; existing
     records gain it on their next save and are matched on the raw field
     meanwhile. */
  if (this.isModified("whatsapp")) this.normalizedWhatsapp = digitsOnly(this.whatsapp);
  if (this.isModified("website")) this.websiteDomain = hostOf(this.website);
  // A duplicate review is only meaningful for the identity data it was
  // performed against — see the field's own comment above.
  if (identityChanged && this.duplicateReviewedAt) this.duplicateReviewedAt = undefined;
  next();
});

// ── Indexes (§4) — only what the Lead Inbox / qualification access patterns
// in the roadmap actually need. No speculative Journey-stage indexes.
leadSchema.index({ isActive: 1, assignedTo: 1, updatedAt: -1 });
leadSchema.index({ captureStatus: 1, assignedTo: 1, updatedAt: -1 });
leadSchema.index({ qualificationState: 1 });
leadSchema.index({ normalizedCompany: 1 });
leadSchema.index({ emailDomain: 1 });
leadSchema.index({ normalizedPhone: 1 });
leadSchema.index({ websiteDomain: 1 });
leadSchema.index({ nextFollowUpAt: 1 });
leadSchema.index({ "conversion.accountId": 1 });
leadSchema.index({ "conversion.journeyId": 1 });

/* ── ONE PROSPECT PER MARKETING HANDOVER, ENFORCED BY THE DATABASE ──────────
   The Sales intake ledger already refuses a second receipt for the same
   handover. This is the same guarantee stated about STATE rather than about
   events: even if two intakes raced past the ledger, only one of them can
   create a Prospect carrying the reference.

   `partialFilterExpression` is what keeps it additive — the index covers only
   documents that actually have the field, so every existing Lead (and every
   Lead created by hand from now on) is outside it and cannot collide. */
leadSchema.index(
  { companyId: 1, "marketingHandover.handoverRef": 1 },
  {
    unique: true,
    partialFilterExpression: { "marketingHandover.handoverRef": { $type: "string" } },
  },
);

const LeadModel = mongoose.model("Lead", leadSchema);

// Exposed as static helpers (same pattern as Mongoose's own Model.find/
// Model.create being static properties on the model constructor) so
// services/crmDuplicates.js's findLeadDuplicates can normalize a CANDIDATE
// the exact same way this file's own pre-save hook above normalizes a
// STORED Lead. Two independently-written normalizers that happen to agree
// today would silently drift the moment either one changes — this is the
// one place either the hook or the duplicate-check service reads the
// normalization rule from.
LeadModel.normalizeCompany = (s) => String(s || "").trim().toLowerCase();
LeadModel.normalizePhoneDigits = digitsOnly;
LeadModel.normalizeEmailDomain = domainOf;
LeadModel.normalizeWebsiteDomain = hostOf;
/* The contact normalisers, exposed for the same reason as the four above: a
   later duplicate check must normalise a CANDIDATE person exactly the way the
   hook normalised a STORED one. */
LeadModel.normalizeContactPhone = contactPhone;
LeadModel.normalizeContactEmail = contactEmail;
LeadModel.settleContacts = settleContacts;
LeadModel.LeadContactError = LeadContactError;

/* Company-prefixed indexes for the scoped list and lookup patterns. */
addCompanyIndexes(leadSchema, [{ "leadId": 1 }, { "captureStatus": 1, "updatedAt": -1 }, { "ownerId": 1 }]);


/* Ownership is stamped once, at creation, from the server-resolved company.
   Nothing after that — a PATCH, an archive, a replacement — may move it.
   See sealCompanyOwnership() in ./companyOwnership.js. */
sealCompanyOwnership(leadSchema);
module.exports = LeadModel;
