// models/CMS_Models/Sales/CustomerChangeRequest.js
//
// WHAT THE CUSTOMER ASKED TO CHANGE, AND WHERE IT WAS SENT.
//
// ── WHY THIS IS A RECORD AND NOT A NOTE ────────────────────────────────────
// A customer's rejection used to survive as free text in three places at once:
// `customerApproval.note`, a `history` entry, and — if somebody pressed "Send
// to R&D for Rework" — a `sample.revisions[]` note written in different words
// for a different audience. None of them says WHAT KIND of change was asked
// for, so nothing could answer the questions the business actually has:
//
//   · which products are held up by the customer right now, and with whom?
//   · how often does a rejection turn out to be a fabric problem?
//   · is this product allowed to be invoiced yet?
//
// So the decision is stored once, typed, queryable, and append-only.
//
// ── APPEND-ONLY, LIKE EVERY OTHER DECISION IN THIS DOMAIN ──────────────────
// A request is never edited into a different request. Re-routing the same
// complaint elsewhere SUPERSEDES the first one and writes a second, exactly as
// `SalesChangeNotice` versions a change and `customerApprovalLog` appends a
// reversal. The identity fields are `immutable: true` so a request cannot be
// quietly re-parented onto another product.
//
// ── ITS SHAPE IS `DevelopmentRequest`'s ────────────────────────────────────
// Same keys, same guarantees: `companyId` + a stable ref, the journey, the
// enquiry and the product LINE (never the product name, which is renameable),
// all immutable, with a unique index on the ref.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const {
  CHANGE_CATEGORY_CODES,
  CHANGE_DESTINATION_CODES,
  CHANGE_REQUEST_STATUSES,
} = require("../../../services/sales/customerChangeRouting.service");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* The same image shape the rest of Sales stores, so the existing uploader and
   the existing resolver both work unchanged — Cloudinary's `publicId`, Drive's
   legacy `fileId`, or a bare URL. */
const attachmentSchema = new mongoose.Schema(
  {
    fileId: { type: String, trim: true },
    publicId: { type: String, trim: true },
    name: { type: String, trim: true },
    url: { type: String, trim: true },
  },
  { _id: false },
);

const CHANGE_REF_PATTERN = /^CCR-[0-9a-f]{12}$/;
const mintChangeRef = () => `CCR-${crypto.randomBytes(6).toString("hex")}`;

const customerChangeRequestSchema = new mongoose.Schema(
  {
    /* ── IDENTITY ────────────────────────────────────────────────────────
       Every one of these is immutable. A change request that could be moved
       between products is not evidence of anything. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    changeRef: { type: String, trim: true, required: true, unique: true, immutable: true, default: mintChangeRef },

    journeyId: { type: mongoose.Schema.Types.ObjectId, index: true, immutable: true },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
    /* The product LINE, not its name: a rename must not orphan the record, and
       one enquiry legitimately carries the same product name twice. */
    productLineRef: { type: String, trim: true, index: true, immutable: true },
    /* Carried for reading only — the line reference is the join key. */
    productName: { type: String, trim: true },
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", index: true, immutable: true },

    /* ── THE DECISION THIS ANSWERS ───────────────────────────────────────
       Which customer rejection this change came from. `decidedAt` doubles as
       the staleness check: a request raised against a decision that has since
       been reversed or replaced is refused rather than applied to a product
       that has moved on. */
    sourceDecision: {
      approved: { type: Boolean },
      decidedAt: { type: Date },
      decidedBy: actorRef(),
      note: { type: String, trim: true, maxlength: 2000 },
    },

    /* ── WHAT WAS ASKED FOR ──────────────────────────────────────────────── */
    categories: [{ type: String, enum: CHANGE_CATEGORY_CODES }],
    /* The customer's own words, kept apart from anything we tell a department.
       R&D's instruction is written for R&D; the customer's sentence is
       evidence and is never rewritten. */
    customerFeedback: { type: String, trim: true, maxlength: 4000 },
    internalInstructions: { type: String, trim: true, maxlength: 4000 },
    attachments: { type: [attachmentSchema], default: [] },

    /* ── WHERE IT WENT ───────────────────────────────────────────────────
       Both are stored. When they differ, somebody overrode the rule, and the
       record says so rather than making it look like the system chose. */
    suggestedDestination: { type: String, enum: CHANGE_DESTINATION_CODES },
    destination: { type: String, enum: CHANGE_DESTINATION_CODES, index: true },
    /* Who owns it now — the department, resolved at routing time. */
    owner: { type: String, trim: true },

    /* Where the product stood before this reopened anything, so "what did this
       cost us" is answerable without replaying the whole history. */
    previousStage: { type: String, trim: true },
    previousState: {
      materialsStatus: { type: String, trim: true },
      bomApprovalStatus: { type: String, trim: true },
      techSheetStatus: { type: String, trim: true },
      sampleStatus: { type: String, trim: true },
      sampleRounds: { type: Number, min: 0 },
    },

    status: { type: String, enum: CHANGE_REQUEST_STATUSES, default: "OPEN", index: true },

    /* ── WHAT THE ROUTING PRODUCED ───────────────────────────────────────
       Filled in as the work happens, so the request points at its own
       consequences rather than leaving somebody to correlate timestamps. */
    result: {
      bomApprovalRound: { type: Number, min: 0 },
      techSheetRevision: { type: Number, min: 0 },
      sampleRoundNo: { type: Number, min: 0 },
      replacementProductLineRef: { type: String, trim: true },
      replacementSampleStyleId: { type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle" },
    },

    /* The request this one replaced, when somebody re-routed the same
       complaint. Forward-only: the superseded one keeps its own record. */
    supersedesChangeRef: { type: String, trim: true },

    /* ── IDEMPOTENCY ─────────────────────────────────────────────────────
       A retry after a lost response must not create a second request, and
       must not open a second sample round. The client sends the same key; the
       unique index below is what actually enforces it. */
    idempotencyKey: { type: String, trim: true },

    createdBy: actorRef(),
    routedAt: { type: Date },
    routedBy: actorRef(),
    resolvedAt: { type: Date },
    resolvedBy: actorRef(),
    resolutionNote: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true },
);

/* One request per idempotency key per company — the retry guard. Partial, so
   the many requests without a key do not collide on null. */
customerChangeRequestSchema.index(
  { companyId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
/* The two questions this record exists to answer: what is open on this
   product, and what is open across this enquiry. */
customerChangeRequestSchema.index({ companyId: 1, productLineRef: 1, status: 1, createdAt: -1 });
customerChangeRequestSchema.index({ companyId: 1, enquiryId: 1, status: 1 });
customerChangeRequestSchema.index({ companyId: 1, sampleStyleId: 1, createdAt: -1 });

/* A minted ref must look like one — the same guard `productLineRef` carries. */
customerChangeRequestSchema.pre("validate", function ensureChangeRef(next) {
  if (!this.changeRef) this.changeRef = mintChangeRef();
  if (!CHANGE_REF_PATTERN.test(this.changeRef)) {
    return next(new Error(`"${this.changeRef}" is not a change reference this system issued.`));
  }
  next();
});

module.exports = mongoose.models.CustomerChangeRequest
  || mongoose.model("CustomerChangeRequest", customerChangeRequestSchema);
module.exports.CHANGE_REF_PATTERN = CHANGE_REF_PATTERN;
module.exports.mintChangeRef = mintChangeRef;
