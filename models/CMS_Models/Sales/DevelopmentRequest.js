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

/**
 * A reference image, BY REFERENCE. Never a payload — Merchandising links, not
 * stores, and the bytes live in the application's media store.
 *
 * ── WHY THERE IS NO RAW URL FIELD ANY MORE ──────────────────────────────────
 * There is one, and it is still called `url`, but it is no longer somewhere a
 * person types. Sales attaches a picture through the same browser→CDN upload the
 * rest of the application uses (`lib/cloudinaryUpload.js`), and the form sends
 * back what that upload returned. A typed URL would have let a buyer reference
 * point at anything at all — a link that rots, an image on somebody else's
 * server, a page that is not an image — and every downstream reader (the
 * Development file, the handover review, the accepted order) would show the
 * breakage without being able to explain it.
 *
 * `storageRef` is the media store's own id for the object, which is what makes
 * the attachment traceable to the upload rather than to a string. `referenceType`
 * says what the picture IS, because "front view" and "the buyer's own sample
 * photo" are read differently by the person selecting fabric.
 */
const REFERENCE_TYPE = Object.freeze({
  PRODUCT: "PRODUCT",
  ARTWORK: "ARTWORK",
  BUYER_SAMPLE: "BUYER_SAMPLE",
  TRIM: "TRIM",
  PACKAGING: "PACKAGING",
  OTHER: "OTHER",
});

const {
  MARKET, SEASON, INTENDED_USE, FIT, FABRIC_FAMILY, PERFORMANCE,
  SAMPLE_TYPE, PROCESS_STATE, TESTING, CERTIFICATION, SUSTAINABILITY, keysOf,
} = require("../../../services/sales/developmentBriefVocabulary");

/* ── THE BUYER'S BRIEF, IN THREE GROUPS ─────────────────────────────────────
   Typed fields, not a `preferences` object. A blob would make every one of
   these unqueryable and unvalidatable, and "the buyer wants it breathable"
   would be a string nobody could count across orders.

   Three groups because they answer three different questions, and the
   Merchandising brief shows them as three blocks: WHO it is for, WHAT it
   should be like, and WHAT HAS TO BE MADE.

   Every field is optional. An early brief legitimately has almost none of
   them, and an empty field means "Sales has not said" — which the brief shows
   in those words rather than inventing a default. */

/**
 * A controlled choice with room for the buyer's own words after it.
 *
 * The note is not a second way to say the same thing: the choice is what
 * reports count and what a selection is checked against, and the note is the
 * qualification that would otherwise be lost ("relaxed, but not boxy through
 * the shoulder"). Hence `maxlength` short enough that nobody writes an essay
 * where a field was wanted.
 */
const chosen = (values, { note = 300 } = {}) => ({
  /* ── `choice`, NOT `value` ───────────────────────────────────────────
     `value` is a FORBIDDEN field name on this request: it means the
     opportunity's value, and `assertNoForbiddenFields` refuses it at any
     depth so a commercial fact cannot travel inside a nested object. A
     controlled choice called `value` collided with that guard. Renaming the
     field was the right way round — weakening a check that exists to keep
     Sales' commercial record in Sales, to suit a field name, is not. */
  choice: { type: String, enum: [...values, ""], default: "", uppercase: true, trim: true },
  note: { type: String, trim: true, default: "", maxlength: note },
});

/** Several controlled choices, with one note covering the set. */
const chosenMany = (values, { note = 300 } = {}) => ({
  values: { type: [{ type: String, enum: values, uppercase: true, trim: true }], default: [] },
  note: { type: String, trim: true, default: "", maxlength: note },
});

/**
 * ── REQUIRED / NOT REQUIRED / NOT CONFIRMED, AND A DETAIL ─────────────────
 * Three answers because a blank is unreadable: nobody can tell "the buyer said
 * no" from "Sales has not asked yet", and those lead to different actions. The
 * detail is only meaningful when the answer is REQUIRED, which the form
 * enforces by only showing it then and the service enforces by refusing a
 * detail on any other answer.
 */
const processSchema = new mongoose.Schema({
  state: {
    type: String, enum: [...keysOf(PROCESS_STATE), ""], default: "", uppercase: true, trim: true,
  },
  detail: { type: String, trim: true, default: "", maxlength: 600 },
}, { _id: false });

const customerDirectionSchema = new mongoose.Schema({
  /* Where it will be sold. */
  market: chosen(keysOf(MARKET)),
  /* When it is for. The year is its own number so the enum does not go stale. */
  season: {
    choice: { type: String, enum: [...keysOf(SEASON), ""], default: "", uppercase: true, trim: true },
    year: { type: Number, min: 2000, max: 2100, default: null },
    note: { type: String, trim: true, default: "", maxlength: 300 },
  },
  intendedUse: chosen(keysOf(INTENDED_USE)),
  /* Only when the buyer actually said it. Never inferred from the account. */
  targetCustomer: { type: String, trim: true, default: "", maxlength: 300 },
}, { _id: false });

const productDirectionSchema = new mongoose.Schema({
  fit: chosen(keysOf(FIT)),
  fabric: chosenMany(keysOf(FABRIC_FAMILY), { note: 600 }),
  /* The buyer's own words: "60/40 linen cotton", "at least 70% natural". A
     fixed list cannot hold a ratio. */
  composition: { type: String, trim: true, default: "", maxlength: 300 },
  /* GSM, ounces, or how it should feel in the hand. One field because a buyer
     says one or the other and never both. */
  weightOrFeel: { type: String, trim: true, default: "", maxlength: 300 },
  /* "Warm ivory, not optic white." Free text on purpose — a dropdown of
     colours loses the sentence that mattered. */
  coloursWanted: { type: String, trim: true, default: "", maxlength: 600 },
  performance: chosenMany(keysOf(PERFORMANCE), { note: 600 }),
  /* Buttons, labels, logo placement, stitching. The buyer's words. */
  trimsAndBranding: { type: String, trim: true, default: "", maxlength: 600 },
  /* ── WHAT THE BUYER DOES NOT WANT ─────────────────────────────────
     Its own field rather than a line in the summary, because it is the one
     thing a merchandiser must read before selecting anything, and prose
     buries it. */
  avoid: { type: String, trim: true, default: "", maxlength: 600 },
}, { _id: false });

const developmentNeedSchema = new mongoose.Schema({
  sampleType: chosen(keysOf(SAMPLE_TYPE)),
  sampleQuantity: { type: Number, min: 0, max: 10000, default: null },
  /* As the buyer names them — "S, M, L" or "UK 8–16". Not an enum: size
     vocabularies differ by market and by buyer. */
  sampleSizes: { type: [{ type: String, trim: true, maxlength: 24 }], default: [] },
  samplePackaging: { type: String, trim: true, default: "", maxlength: 600 },

  printing: { type: processSchema, default: () => ({}) },
  embroidery: { type: processSchema, default: () => ({}) },
  washFinish: { type: processSchema, default: () => ({}) },

  testing: chosenMany(keysOf(TESTING), { note: 600 }),
  certification: chosenMany(keysOf(CERTIFICATION), { note: 600 }),
  sustainability: chosenMany(keysOf(SUSTAINABILITY), { note: 600 }),
}, { _id: false });

const imageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true, required: true, maxlength: 2000 },
    caption: { type: String, trim: true, default: "", maxlength: 200 },
    /* The media store's id for the uploaded object. Absent on images attached
       before the upload control existed, which stay readable. */
    storageRef: { type: String, trim: true, default: "" },
    referenceType: {
      type: String, enum: Object.values(REFERENCE_TYPE), default: REFERENCE_TYPE.PRODUCT,
    },
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

    /* ── THE BUYER'S BRIEF ────────────────────────────────────────────────
       Sales owns every one of these; Merchandising reads them and has no
       write for any of them. A request issued before they existed carries
       none, loads exactly as it did, and shows honest absence states. */
    customerDirection: { type: customerDirectionSchema, default: () => ({}) },
    productDirection: { type: productDirectionSchema, default: () => ({}) },
    developmentNeed: { type: developmentNeedSchema, default: () => ({}) },

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
  PROCESS_STATE_KEYS: keysOf(PROCESS_STATE),
  REFERENCE_TYPE,
  REQUEST_STATE, MATERIAL_CATEGORY, FORBIDDEN_FIELDS,
  SalesDevelopmentRequest: mongoose.models.SalesDevelopmentRequest
    || mongoose.model("SalesDevelopmentRequest", requestSchema),
};
