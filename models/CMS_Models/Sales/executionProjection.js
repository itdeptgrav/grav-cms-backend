// models/CMS_Models/Sales/executionProjection.js
//
// THE EXECUTION PROJECTION — the exact shape of what crosses from Sales to
// Merchandising, defined once and embedded wherever it is stored.
//
// ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
// Two records hold this projection: the Sales handover version that states it,
// and the Merchandising Execution File that keeps the accepted copy. The file
// held it as `Schema.Types.Mixed`, which is not a copy of a contract — it is
// the absence of one. Anything at all could be written into the accepted
// projection and nothing would object: a stray `price` copied by a future
// helper, a renamed field silently arriving as a second spelling, a nested
// object of a shape nobody agreed. The allowlist that guards the door meant
// nothing once the record behind it accepted everything.
//
// So the shape is declared once, here, and both records embed it. Mongoose's
// strict mode then does what the allowlist alone could not: an unexpected
// field is not stored, so it cannot later escape through a response, appear
// in an export, or become the field somebody starts relying on.
//
// ── WHOSE SHAPE IT IS ───────────────────────────────────────────────────────
// Sales'. It lives in the Sales model namespace because Sales authors every
// field in it and Merchandising only ever reads them. The rules ABOUT these
// fields — reconciliation, the split × drop mapping, the units they produce —
// are in `services/sales/handoverContract.js`, imported by both applications.
//
// ── WHAT HAS NOWHERE TO GO ──────────────────────────────────────────────────
// No price, cost, margin, quotation, payment term, credit line, currency
// amount, customer record, buyer contact, negotiation or pipeline state. The
// producer refuses those by name at the door; this schema has no field that
// could hold one, which is the stronger of the two guarantees because it
// survives somebody adding a new door.
"use strict";

const mongoose = require("mongoose");
const { ORDER_FULFILMENT_MODELS } = require("../../../constants/orderFulfilment");

/** One confirmed split of the line — a colourway / attribute / size tuple. */
const breakdownSchema = new mongoose.Schema(
  {
    lineSplitRef: { type: String, trim: true, required: true },
    attributes: [
      new mongoose.Schema(
        { name: { type: String, trim: true }, value: { type: String, trim: true } },
        { _id: false },
      ),
    ],
    sizeRange: { type: String, trim: true },
    quantity: { type: Number, min: 1, required: true },
  },
  { _id: false },
);

/* ── THE DELIVERY COMMITMENT ────────────────────────────────────────────────
 * The one authoritative committed date in the system. Authored by Sales at
 * issue, displayed read-only in Merchandising, and never patched by anybody:
 * a change is a new version.
 *
 * `targetExFactoryDate` exists in the contract and is almost always ABSENT.
 * It is stored only when Sales explicitly supplies an authoritative value —
 * never derived from the delivery date, because "delivery minus an invented
 * lead time" is a date nobody committed to. M5's anchor contract reads these
 * fields; nothing before it may guess at them. */
const deliverySchema = new mongoose.Schema(
  {
    dropRef: { type: String, trim: true, required: true },
    committedDeliveryDate: { type: Date, required: true },
    quantity: { type: Number, min: 1, required: true },
    nominatedFactoryRef: { type: String, trim: true },
    targetExFactoryDate: { type: Date },
  },
  { _id: false },
);

/* ── THE SPLIT × DROP MAPPING ───────────────────────────────────────────────
 * Present only when the line genuinely has two axes: more than one confirmed
 * split AND more than one delivery. It is a JOIN and nothing else — it names
 * the split and the drop by their own references and states how many pieces
 * connect them.
 *
 * Deliberately no attributes, no dates and no factory: those are properties of
 * the rows this references, and copying them here would create a second place
 * for a committed date to be right, which is a second place for it to be
 * wrong. `services/sales/handoverContract.js` joins them at derivation. */
const allocationSchema = new mongoose.Schema(
  {
    allocationRef: { type: String, trim: true, required: true },
    lineSplitRef: { type: String, trim: true, required: true },
    dropRef: { type: String, trim: true, required: true },
    quantity: { type: Number, min: 1, required: true },
  },
  { _id: false },
);

/* ── THE BUYER'S SPECIAL-PROCESS REQUIREMENT ────────────────────────────────
 * Whether THIS line's buyer requires embroidery, printing and washing — the
 * line-level fact a style route cannot supply, because two lines of one style
 * may differ. Stated by Sales at issue, frozen with the version, and copied
 * with the rest of the projection into the Merchandising file that accepts it.
 *
 * Optional, and never defaulted: a version issued without it (every legacy
 * version) states nothing, which is different from "not required". A definite
 * answer carries the buyer approval it rests on, resolved by the server from
 * the order's own stored record — never typed. See
 * services/sales/lineProcessRequirement.js for the rules. */
const processEvidenceSchema = new mongoose.Schema(
  {
    /* BUYER_PO — the buyer-approved ORDER: the quotation round the customer
       approved on this order, with the purchase order they uploaded as proof.
       It proves the buyer approved the order; the Sales-authored
       `buyerSpecification` says what in it the answer rests on.

       INTERNAL_ORDER — a genuine company order, which has no buyer to approve
       it. Sales authorises it instead: the order is marked an internal order,
       a named Sales approver signed the round off, and the person issuing the
       handover says why. It is NOT available to a customer's order that Sales
       pushed through without the customer's approval — there a real buyer
       exists and has not answered, so that line stays UNKNOWN. */
    kind: { type: String, enum: ["BUYER_PO", "INTERNAL_ORDER"], required: true },
    buyerApprovalRef: { type: String, trim: true, required: true },
    /* Which negotiation round was approved — pinned, so a later round cannot
       quietly stand in for the one the buyer signed. */
    approvalRevision: { type: Number, default: null },
    approvedAt: { type: Date, default: null },
    poNumber: { type: String, trim: true, default: "" },
    poDate: { type: Date, default: null },
    /* The buyer's document — required for, and only for, a buyer PO. */
    documentRef: { type: String, trim: true, default: "",
      required: function requiredForBuyerPo() { return this.kind === "BUYER_PO"; } },
    documentName: { type: String, trim: true, default: "" },

    /* ── AN INTERNAL ORDER'S AUTHORITY ────────────────────────────────── */
    /* Who signed the order off inside the company, when it was marked an
       internal order, and why this process answer was authorised — the actor
       is read from the order, the reason is said by the issuer. */
    authorisedById: { type: mongoose.Schema.Types.ObjectId, default: undefined },
    authorisedAt: { type: Date, default: null },
    internalOrderMarkedAt: { type: Date, default: null },
    reason: { type: String, trim: true, default: "", maxlength: 300,
      required: function requiredForInternal() { return this.kind === "INTERNAL_ORDER"; } },
  },
  { _id: false },
);

const processRequirementSchema = new mongoose.Schema(
  {
    process: { type: String, enum: ["EMBROIDERY", "PRINTING", "WASHING", "OTHER"], required: true },
    /* What an OTHER process is. Free text, so PPC can never match it to a
       route stage — which is why a required OTHER blocks planning. */
    otherLabel: { type: String, trim: true, default: "", maxlength: 80 },
    requirement: { type: String, enum: ["REQUIRED", "NOT_REQUIRED", "UNKNOWN"], required: true },
    /* What the buyer approved, in their document's terms: "left chest logo,
       3 colours", "no wash". Required with a definite answer. */
    buyerSpecification: { type: String, trim: true, default: "", maxlength: 500 },
    evidence: { type: processEvidenceSchema, default: undefined },
  },
  { _id: false },
);

const processRequirementsSchema = new mongoose.Schema(
  {
    processes: { type: [processRequirementSchema], default: undefined },
    statedAt: { type: Date, required: true },
    statedBy: {
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true },
    },
  },
  { _id: false },
);

/**
 * A fresh instance of the projection schema.
 *
 * A factory rather than a shared singleton: mongoose attaches parent-specific
 * state to a compiled subschema, and two records embedding one instance have
 * produced surprising validation behaviour before. Each caller gets its own.
 */
function executionProjectionSchema() {
  return new mongoose.Schema(
    {
      /* Sales' own identities for the order and the line. `orderLineRef` is
         the CustomerRequest item's permanent `lineRef` — not its style, which
         may legitimately appear on two commercial lines of one order. */
      orderRef: { type: String, trim: true, required: true },
      orderLineRef: { type: String, trim: true, required: true },

      // Optional for historical handovers. New issues always stamp it from
      // the confirmed CustomerRequest; the receiver never guesses it.
      fulfilmentModel: { type: String, enum: ORDER_FULFILMENT_MODELS },

      styleRef: { type: String, trim: true, required: true },
      buyerStyleRef: { type: String, trim: true },
      productName: { type: String, trim: true, required: true },

      /* ── THE STYLE'S STABLE IDENTITY ─────────────────────────────────
         `styleRef` above is a DISPLAY code — `styleCode` on the SampleStyle,
         which somebody can rename. It stays, because it is what a person
         reads and what a printed card shows.

         This is the record. Merchandising joins its own Development File to
         its own Execution File on it, so a renamed style code cannot silently
         break the link between what was sampled and what is being made. It is
         an identity, not a commercial fact: nothing about price, margin or the
         buyer relationship crosses with it.

         Optional, because handover versions issued before it existed do not
         carry one and must stay readable. The join falls back to `styleRef`
         for those. */
      sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: null },

      /* Sourced display labels only — a name to print on a card, never a CRM
         record, a contact, or a channel to the buyer. */
      buyerDisplayLabel: { type: String, trim: true },
      brandDisplayLabel: { type: String, trim: true },

      totalQuantity: { type: Number, min: 1, required: true },
      breakdown: [breakdownSchema],
      deliveries: {
        type: [deliverySchema],
        validate: [
          (v) => Array.isArray(v) && v.length > 0,
          "At least one delivery commitment is required.",
        ],
      },
      allocations: [allocationSchema],

      packingRequirement: { type: String, trim: true },
      testingRequirement: { type: String, trim: true },
      deliveryRequirement: { type: String, trim: true },

      /* Absent on every version issued without a statement — never defaulted. */
      processRequirements: { type: processRequirementsSchema, default: undefined },
    },
    { _id: false },
  );
}

module.exports = { executionProjectionSchema };
