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
const {
  LEAD_QUALIFICATION_STATE_CODES,
  LEAD_CAPTURE_STATUS_CODES,
  LEAD_REVIEW_STATUS_CODES,
  CUSTOMER_POTENTIAL_CODES,
  REQUIREMENT_CERTAINTY_CODES,
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

// Multiple people on a pre-Account Lead. B2B garment buyers are rarely one
// person — a buyer, a merchandiser, a finance approver, the decision-maker.
// These are LEAD-LOCAL only: they are NOT CRMContacts (those belong to an
// Account, created at conversion). `decisionMakerName`/`decisionMakerRole`
// below remain the single canonical decision-maker for backward compatibility
// and the qualification check; a contact flagged `isDecisionMaker` ALSO
// satisfies that check (see services/leadReadiness.js).
const leadContactSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, required: true },
    role: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    isDecisionMaker: { type: Boolean, default: false },
  },
  { _id: true },
);

const leadSchema = new mongoose.Schema(
  {
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
      enum: [
        "website",
        "referral",
        "cold_call",
        "trade_show",
        "social_media",
        "existing_customer",
        "advertisement",
        "walk_in",
        "google",
        "linkedin",
        "directory",
        "field_visit",
        "other",
      ],
      // No `default` (correction) — "Lead source recorded" is a genuine
      // readiness/activation check (services/leadReadiness.js); a silent
      // "other" default let that check pass even when nobody had actually
      // picked a source. Every write path (Quick Capture, Prospect Setup's
      // OriginSection) now only sends `source` when a real choice was made.
    },
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
      default: "medium",
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
        { product: { type: String, trim: true }, quantity: { type: Number, min: 0 } },
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
    budget: { type: String, trim: true },
    requirements: { type: String, trim: true },
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

leadSchema.pre("save", function (next) {
  const identityChanged =
    this.isModified("company") || this.isModified("email") ||
    this.isModified("phone") || this.isModified("website");
  if (this.isModified("company")) this.normalizedCompany = String(this.company || "").trim().toLowerCase();
  if (this.isModified("email")) this.emailDomain = domainOf(this.email);
  if (this.isModified("phone")) this.normalizedPhone = digitsOnly(this.phone);
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

module.exports = LeadModel;
