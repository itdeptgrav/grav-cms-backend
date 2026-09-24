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
// is, reference images, what is wanted, which categories, by when, the buyer's
// stated per-piece ceiling where one exists, and the registered product where
// one is being reused. The ceiling is a read-only constraint from Sales, not a
// price Merchandising sets or approves.
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

    /* A BUYER constraint, not Merchandising's price. Optional because many
       early briefs have none; complete when present so an amount never appears
       without its currency or basis. */
    targetPriceCeiling: {
      amount: { type: Number, min: 0, default: null },
      currency: { type: String, trim: true, uppercase: true, maxlength: 8, default: "" },
      basis: { type: String, enum: ["PER_PIECE"], default: undefined },
    },

    /* Sales' own authority, stamped from the resolved session. */
    requestedBy: actorRef(),
    requestedAt: { type: Date, default: null },

    supersedesVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, default: "", maxlength: 2000 },

    /* ── WHAT SALES RELEASED, AND EXACTLY WHICH REVISION ──────────────────
       Stamped onto the version in force when Sales authorises, the same way
       `cancelledAt` and `cancellationReason` are — a terminal fact about this
       version, not a second record of it.

       The authoritative identity of a released selection is
       `{companyId, developmentFileId, revisionNo}`. `companyId` is already on
       this document and immutable; the other two are here. Recording only the
       journey and the product line — which is what the release used to carry —
       names a FILE rather than a REVISION, and a file's approved revision
       moves. R&D would then receive whichever selection happened to be current
       when the event was processed, not the one Sales reviewed and authorised.

       `developmentFileId` is resolved on the server from this request's own
       journey and product line inside the acting company. It is never taken
       from the caller, and nothing is ever looked up by `bomRevisionNo`: it is
       compared against Merchandising's records and then recorded. */
    release: {
      releaseReference: { type: String, trim: true, default: "" },
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      bomRevisionNo: { type: Number, default: null },
      authorisedAt: { type: Date, default: null },
      authorisedBy: actorRef(),
      /* The caller's key, kept so a replay can be recognised as the same act
         and a key re-sent against a DIFFERENT revision can be refused. */
      idempotencyKey: { type: String, trim: true, default: "" },
      correlationId: { type: String, trim: true, default: "" },
    },

    /* ── EVERY RELEASE THIS REQUEST HAS EVER AUTHORISED ───────────────────
       `release` above is the MOST RECENT one, kept where it was so nothing
       reading it has to change. This is the whole series.

       A line can be released more than once: Sales releases revision 1, the
       customer changes their mind, Merchandising approves revision 2 and
       Sales releases that. Overwriting `release` each time would erase the
       first decision — who took it, when, and which selection it committed
       the company to — and that decision is exactly what a later question
       about what R&D built is answered from. So a release is APPENDED, never
       edited, and the first entry stays byte-for-byte what it was.

       Nothing here is derived. Whether a release is still CURRENT is decided
       by comparing its `bomRevisionNo` with the file's approved revision at
       read time; storing a "stale" flag would need a writer on every approval
       and would be wrong the moment one was missed. */
    releases: [new mongoose.Schema({
      releaseReference: { type: String, trim: true, default: "" },
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      bomRevisionNo: { type: Number, default: null },
      authorisedAt: { type: Date, default: null },
      authorisedBy: actorRef(),
      idempotencyKey: { type: String, trim: true, default: "" },
      correlationId: { type: String, trim: true, default: "" },
      /* What reopened the materials after the PREVIOUS release, when this is
         not the first. Written from the Sales reopen that caused it. */
      supersedesBomRevisionNo: { type: Number, default: null },
    }, { _id: false })],

    /* ── OR SALES ASKED FOR THE SELECTION TO CHANGE ───────────────────────
       The same decision point as `release`, answered the other way, and bound
       to a revision for the same reason: it is an answer ABOUT revision N, and
       a reader who cannot tell which N cannot tell whether it has been
       answered since.

       Unlike `release` this is not once-for-all. Sales may ask for changes on
       revision 1, Merchandising may approve revision 2, and Sales may ask
       again — so what is recorded is the LAST decision and the revision it
       answered. The full history lives in the audit trail and in the BOM
       revisions themselves, which is where history belongs. */
    materialChangeRequest: {
      developmentFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      bomRevisionNo: { type: Number, default: null },
      reason: { type: String, trim: true, default: "", maxlength: 2000 },
      requestedAt: { type: Date, default: null },
      requestedBy: actorRef(),
      idempotencyKey: { type: String, trim: true, default: "" },
      correlationId: { type: String, trim: true, default: "" },
    },
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
