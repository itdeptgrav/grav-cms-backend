// models/CMS_Models/Sales/DevelopmentRequest.js
//
// SALES ASKS MERCHANDISING TO SELECT MATERIALS. SALES-OWNED.
//
// The PRE-order twin of `SalesHandoverVersion`: a versioned, immutable
// statement issued by Sales against one Journey product line, carrying only
// the facts Merchandising needs to choose fabric, trims and sample packaging.
//
// ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
// Before this, a merchandiser learned that a style needed materials by being
// told, and selected them through a Sales-authenticated form on the sample
// style. That made material selection a side effect of a Sales screen: no
// version, no request, no acceptance, no audit of who asked or when, and no
// way for R&D or Costing to know whether the selection they were reading was
// the one Sales had asked for.
//
// A request makes it a record. Sales asks, once, with a version; Merchandising
// accepts or asks a question; and everything downstream points at a version
// rather than at whatever the style happened to say that afternoon.
//
// ── WHAT IT CARRIES, AND WHAT IT CANNOT ─────────────────────────────────────
// Enough to select materials: which product line, which buyer, what the style
// is, reference images, what is wanted, which categories, by when, and the
// registered product where one is being reused.
//
// Not the opportunity value, the negotiation history, the margin, Sales'
// internal notes, the buyer-message history or any other pipeline stage. Those
// are refused BY NAME at issue — a field silently stripped is a field somebody
// believes they sent.
//
// ── AND IT IS ROOTED ON A PERMANENT LINE REFERENCE ──────────────────────────
// `productLineRef`, minted by `enquiryProductLineIdentity.js`. Never the array
// position, never the product name, never a mutable index: a Development File
// lives on this reference for months and must survive every edit Sales makes
// to the enquiry underneath it.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

const dateOnly = (extra = {}) => ({
  type: String, trim: true,
  match: [/^\d{4}-\d{2}-\d{2}$/, "Use a calendar date, YYYY-MM-DD."],
  ...extra,
});

const REQUEST_STATE = Object.freeze({
  ISSUED: "ISSUED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED: "CANCELLED",
});

/**
 * What Merchandising is being asked to select.
 *
 * A closed list, so the register can report on it and so a request cannot ask
 * for something no Merchandising screen can answer. `SAMPLE_PACKAGING` is
 * explicitly sample-stage: the packing a sample travels in, not the confirmed
 * order's packing instruction, which is M3's and comes later.
 */
const MATERIAL_CATEGORY = Object.freeze({
  FABRIC: "FABRIC",
  TRIMS: "TRIMS",
  LABELS: "LABELS",
  ACCESSORIES: "ACCESSORIES",
  SAMPLE_PACKAGING: "SAMPLE_PACKAGING",
});

/* ── WHAT MAY NEVER TRAVEL ────────────────────────────────────────────────
   Named so a refusal can say which field and why it stays in Sales. These are
   not merely absent from the schema — a caller who sends one is told. */
const FORBIDDEN_FIELDS = Object.freeze({
  opportunityValue: "the opportunity's value, which is Sales' commercial record",
  value: "the opportunity's value, which is Sales' commercial record",
  margin: "margin, which is Sales' commercial record",
  price: "price — Merchandising selects materials, it does not quote them",
  unitPrice: "price — Merchandising selects materials, it does not quote them",
  negotiation: "negotiation history, which stays in Sales",
  quotation: "the quotation, which is Sales' commercial record",
  internalNote: "Sales' internal note, which is not a Merchandising fact",
  salesNote: "Sales' internal note, which is not a Merchandising fact",
  message: "the buyer conversation, which stays in Sales",
  messages: "the buyer conversation, which stays in Sales",
  thread: "the buyer conversation, which stays in Sales",
  contact: "buyer contact, which stays in Sales",
  email: "buyer contact, which stays in Sales",
  stage: "the pipeline stage, which is Sales' own workflow",
  pipelineStage: "the pipeline stage, which is Sales' own workflow",
  probability: "the pipeline probability, which is Sales' own workflow",
});

/** A reference image, by URL. Never a payload — Merchandising links, not stores. */
const imageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true, maxlength: 2000 },
    caption: { type: String, trim: true, default: "", maxlength: 200 },
  },
  { _id: false },
);

const requestSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    /* Stable across every version of this request. */
    requestRef: { type: String, trim: true, required: true, immutable: true },
    versionNo: { type: Number, min: 1, required: true, immutable: true },

    /* ── THE GRAIN ───────────────────────────────────────────────────────
       One Journey product line. Both are immutable: a request that could be
       re-pointed at a different line would make every Development File built
       on it meaningless. */
    journeyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    journeyRef: { type: String, trim: true, default: "" },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    productLineRef: { type: String, trim: true, required: true, index: true, immutable: true },

    state: { type: String, enum: Object.values(REQUEST_STATE), default: REQUEST_STATE.ISSUED, index: true },

    /* ── THE SAFE FACTS ──────────────────────────────────────────────────
       Display labels, deliberately: a name to show, not a foreign key
       Merchandising could follow into Sales' own records. */
    buyerDisplayLabel: { type: String, trim: true, default: "", maxlength: 200 },
    accountRef: { type: String, trim: true, default: "" },

    productName: { type: String, trim: true, required: true, maxlength: 200 },
    styleRef: { type: String, trim: true, default: "", maxlength: 120 },
    /* The sample style this request is about, where Sales has raised one.
       Optional: a custom style needs no record before selection can begin. */
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* The registered finished good being reused, where the request is a
       repeat. Its approved BOM becomes adoptable source evidence. */
    stockItemId: { type: mongoose.Schema.Types.ObjectId, default: null },

    referenceImages: { type: [imageSchema], default: [] },

    requirementSummary: { type: String, trim: true, default: "", maxlength: 4000 },
    requestedCategories: [{ type: String, enum: Object.values(MATERIAL_CATEGORY) }],

    requiredByDate: dateOnly({ default: null }),

    /* Sales' own authority, stamped from the resolved session. */
    requestedBy: actorRef(),
    requestedAt: { type: Date, default: null },

    supersedesVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true, collection: "sales_development_requests", strict: true },
);

requestSchema.index({ companyId: 1, requestRef: 1, versionNo: 1 }, { unique: true });

/* ── ONE CURRENT VERSION PER REQUEST, ENFORCED BY THE DATABASE ────────────
   Partial, so superseded and cancelled versions accumulate beside the one in
   force. The same device the handover version and the change notice use. */
requestSchema.index(
  { companyId: 1, requestRef: 1 },
  { unique: true, partialFilterExpression: { state: "ISSUED" }, name: "one_issued_request_version" },
);

/* ── ONE OPEN REQUEST PER PRODUCT LINE ────────────────────────────────────
   Two live requests for one line would be two development jobs for one thing,
   and Merchandising could not tell which selection answered which. */
requestSchema.index(
  { companyId: 1, journeyId: 1, productLineRef: 1 },
  { unique: true, partialFilterExpression: { state: "ISSUED" }, name: "one_open_request_per_line" },
);

/* The register's own read. */
requestSchema.index({ companyId: 1, state: 1, createdAt: -1 });

/* ── ISSUED MEANS IMMUTABLE ───────────────────────────────────────────────
   Only the supersession and cancellation bookkeeping moves afterwards. A
   correction is a REISSUE — a new version — so what Merchandising already
   accepted stays what it was. */
const MUTABLE_AFTER_ISSUE = new Set([
  "state", "supersededByVersionId", "supersededAt",
  "cancelledAt", "cancellationReason", "updatedAt", "__v",
]);

requestSchema.pre("save", function freezeIssued(next) {
  if (this.isNew) return next();
  const touched = this.modifiedPaths().filter((p) => !MUTABLE_AFTER_ISSUE.has(p.split(".")[0]));
  if (touched.length) {
    const err = new Error(
      `An issued development request is frozen. ${touched.join(", ")} cannot change — `
      + "reissue it instead, so what Merchandising already accepted stays what it was.",
    );
    err.name = "DevelopmentRequestImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  REQUEST_STATE, MATERIAL_CATEGORY, FORBIDDEN_FIELDS,
  SalesDevelopmentRequest: mongoose.models.SalesDevelopmentRequest
    || mongoose.model("SalesDevelopmentRequest", requestSchema),
};
