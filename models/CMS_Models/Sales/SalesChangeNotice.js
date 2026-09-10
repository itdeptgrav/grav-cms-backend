// models/CMS_Models/Sales/SalesChangeNotice.js
//
// A BUYER-AUTHORISED CHANGE, AS SALES STATES IT. SALES-OWNED.
//
// The M7 counterpart to `SalesHandoverVersion`, and deliberately the same
// shape: a versioned, immutable statement issued by Sales, carrying only the
// safe confirmed execution delta, announced through Sales' own outbox.
//
// ── WHY MERCHANDISING CANNOT CREATE ONE ─────────────────────────────────────
// Sales owns and authorises commercial change. There is no Merchandising route
// that writes this model, no Merchandising service that imports it, and a test
// scans for both. What Merchandising does is RECEIVE one and record the
// internal execution impact — which is a different thing from agreeing to it,
// and a much smaller thing than authorising it.
//
// ── THE PAYLOAD IS THE TYPED PROJECTION, AND NOTHING ELSE ───────────────────
// `before` and `after` are `executionProjectionSchema()` — the same 14 fields
// M2.1 tightened the handover down to after `Mixed` let an unexpected one
// through. Buyer messages, negotiation history, price, margin, payment terms
// and internal Sales notes are not in that schema, so they cannot persist and
// cannot escape. `strict: true` is the mechanism; the allowlist check at issue
// is the diagnosis, so a caller sending one is told which field and whose it is
// rather than watching it silently vanish.
//
// ── STABLE IDENTITY ACROSS VERSIONS ─────────────────────────────────────────
// `changeRef` is minted once and never changes. Version 2 of a change is the
// same change; a merchandiser who assessed version 1 must be able to see that
// what arrived is a revision of the thing they already looked at, not a new
// one. The partial unique index gives exactly one ISSUED version per ref.
"use strict";

const mongoose = require("mongoose");

const { executionProjectionSchema } = require("./executionProjection");

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

/** Where a notice version is. Only Sales moves it. */
const NOTICE_STATE = Object.freeze({
  ISSUED: "ISSUED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED: "CANCELLED",
});

/**
 * What kind of change this is.
 *
 * Closed, because the kind decides which Merchandising records are likely
 * affected and a free-text kind could not be reported on. `CANCELLATION` is
 * here rather than being a separate mechanism: a cancelled line IS a change to
 * the confirmed requirement, and routing it through the same versioned notice
 * means it inherits the same identity, audit and acknowledgement machinery.
 */
const CHANGE_KIND = Object.freeze({
  QUANTITY: "QUANTITY",
  DELIVERY_DATE: "DELIVERY_DATE",
  SPLIT: "SPLIT",
  PACKING_REQUIREMENT: "PACKING_REQUIREMENT",
  TESTING_REQUIREMENT: "TESTING_REQUIREMENT",
  DELIVERY_REQUIREMENT: "DELIVERY_REQUIREMENT",
  STYLE_REFERENCE: "STYLE_REFERENCE",
  CANCELLATION: "CANCELLATION",
});

/* ── WHAT MAY NEVER APPEAR ────────────────────────────────────────────────
   Named so the refusal can say which field and who owns it. These are not
   merely absent from the schema — a caller who sends one is told, because a
   silently stripped field is a caller who believes they sent something. */
const FORBIDDEN_FIELDS = Object.freeze({
  message: "the buyer conversation, which stays in Sales",
  messages: "the buyer conversation, which stays in Sales",
  email: "buyer contact, which stays in Sales",
  contact: "buyer contact, which stays in Sales",
  thread: "the buyer conversation, which stays in Sales",
  negotiation: "negotiation history, which stays in Sales",
  quotation: "the quotation, which is Sales' commercial record",
  price: "Sales' commercial record — Merchandising executes a requirement, not a price",
  unitPrice: "Sales' commercial record — Merchandising executes a requirement, not a price",
  margin: "Sales' commercial record",
  paymentTerms: "payment terms, which are Sales' commercial record",
  terms: "commercial terms, which stay in Sales",
  internalNote: "Sales' internal note, which is not a Merchandising fact",
  salesNote: "Sales' internal note, which is not a Merchandising fact",
});

const noticeSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    /* Stable across every version of this change — see the header. */
    changeRef: { type: String, trim: true, required: true, immutable: true },
    versionNo: { type: Number, min: 1, required: true, immutable: true },

    /* M2.1's permanent line identity. Never a style id: one order can carry
       the same style on two commercial lines, and a style id cannot tell them
       apart. */
    handoverRef: { type: String, trim: true, required: true, immutable: true },
    handoverLineRef: { type: String, trim: true, required: true, immutable: true },

    state: { type: String, enum: Object.values(NOTICE_STATE), default: NOTICE_STATE.ISSUED, index: true },
    changeKind: { type: String, enum: Object.values(CHANGE_KIND), required: true, immutable: true },

    /* The typed projection, both sides. Nothing else fits. */
    before: { type: executionProjectionSchema(), default: null },
    after: { type: executionProjectionSchema(), default: null },

    /* Sales' own reason, and Sales' own authority. */
    reasonCode: { type: String, trim: true, default: "", maxlength: 80 },
    reason: { type: String, trim: true, default: "", maxlength: 2000 },
    authorisedBy: actorRef(),
    authorisedAt: { type: Date, default: null },

    effectiveFrom: dateOnly({ default: null }),

    supersedesVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancellationReason: { type: String, trim: true, default: "", maxlength: 2000 },
  },
  { timestamps: true, collection: "sales_change_notices", strict: true },
);

noticeSchema.index({ companyId: 1, changeRef: 1, versionNo: 1 }, { unique: true });

/* ── ONE CURRENT VERSION PER CHANGE, ENFORCED BY THE DATABASE ─────────────
   Partial, so superseded and cancelled versions accumulate freely beside the
   one in force. The same device the handover version uses. */
noticeSchema.index(
  { companyId: 1, changeRef: 1 },
  { unique: true, partialFilterExpression: { state: "ISSUED" }, name: "one_issued_change_version" },
);

/* The receiver's own read: every change on one order line, newest first. */
noticeSchema.index({ companyId: 1, handoverRef: 1, handoverLineRef: 1, createdAt: -1 });

/* ── ISSUED MEANS IMMUTABLE ───────────────────────────────────────────────
   Only the supersession and cancellation bookkeeping may move afterwards. A
   change Merchandising has already assessed cannot be edited underneath them;
   a correction is a new version. */
const MUTABLE_AFTER_ISSUE = new Set([
  "state", "supersededByVersionId", "supersededAt",
  "cancelledAt", "cancellationReason", "updatedAt", "__v",
]);

noticeSchema.pre("save", function freezeIssued(next) {
  if (this.isNew) return next();
  const touched = this.modifiedPaths().filter((p) => !MUTABLE_AFTER_ISSUE.has(p.split(".")[0]));
  if (touched.length) {
    const err = new Error(
      `An issued change notice is frozen. ${touched.join(", ")} cannot change — `
      + "issue a new version instead, so what Merchandising already assessed stays what it was.",
    );
    err.name = "SalesChangeNoticeImmutable";
    err.touched = touched;
    return next(err);
  }
  return next();
});

module.exports = {
  NOTICE_STATE, CHANGE_KIND, FORBIDDEN_FIELDS,
  SalesChangeNotice: mongoose.models.SalesChangeNotice
    || mongoose.model("SalesChangeNotice", noticeSchema),
};
