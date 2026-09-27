// models/CMS_Models/Merchandising/CustomerMaterialExpectation.js
//
// WHAT THE CUSTOMER IS SENDING US, ON A JOB-WORK ORDER.
//
// On a full-package order the factory buys the materials, and every record that
// follows — a purchase order, a supplier, a price, a payable — exists because
// somebody bought something. On a JOB WORK order the customer supplies the
// fabric and the trims, and none of those records exist: nothing was bought,
// nobody is owed money, and there is no purchase value to put in a ledger.
//
// What DOES exist is an expectation. Merchandising states, against a confirmed
// order, which materials the customer has undertaken to send, how much of each,
// in what unit, and by when. Store reads it so that when a lorry arrives they
// know what it should contain and can say whether it does.
//
// ── WHY THIS IS NOT A PURCHASE ORDER ────────────────────────────────────────
// It would have been much less work to reuse one. A PurchaseOrder carries a
// vendor, negotiated prices, tax treatment, payment terms and a payable, and
// every one of those would be either empty or a lie on this document. An empty
// price field is read by somebody as free; a vendor field holding the customer's
// name turns a buyer into a supplier in every report that groups by vendor. A
// document whose fields must all be ignored is worse than a document that does
// not have them.
//
// So this has no vendor, no price, no currency, no tax, no payment term and no
// value. There is nowhere for one to arrive, which is the only reliable way to
// keep one out.
//
// ── AND IT IS NOT A RECEIPT ─────────────────────────────────────────────────
// Nothing here says anything has arrived. There is no received quantity, no
// short-shipment field, no receipt status and no stock effect — because
// receiving customer-owned goods means owning a lot of stock the factory does
// not own, and that needs the goods-receipt path and ownership lots, which are
// the NEXT phase and not this one.
//
// A "received" field defaulting to zero would be read as "nothing has arrived
// yet" the moment it appeared on a screen, which is a claim this document cannot
// support: it does not know. So the field does not exist, and the screens say
// receipt recording is not available yet rather than showing an empty column.
//
// ── THREE STATES, AND WHY NOT MORE ──────────────────────────────────────────
//   DRAFT     — being composed. Editable. At most one per execution file.
//   ISSUED    — stated to Store and to the customer. Frozen; a change is a new
//               revision, so what was issued stays readable exactly as issued.
//   CANCELLED — withdrawn, with a reason. The lines stay for the record.
//
// There is deliberately no RECEIVED, PARTIALLY_RECEIVED or CLOSED. Each of those
// is a statement about goods arriving, which nothing in this phase observes.
//
// ── REVISIONS, AND WHAT "CURRENT" MEANS ─────────────────────────────────────
// One document per revision, numbered from 1 per execution file. A new revision
// opens as a DRAFT carrying the issued revision's lines forward — with their
// line references intact, so "the interlining line" is the same line across
// revisions and a conversation about it does not have to say which revision it
// is in.
//
// There is no SUPERSEDED state. The current issued revision is simply the
// highest-numbered one in ISSUED, which is derived rather than stored — a stored
// "current" flag is a second source of truth that goes stale exactly when two
// revisions are issued close together.
"use strict";

const mongoose = require("mongoose");

const {
  ORDER_FULFILMENT_MODELS,
} = require("../../../constants/orderFulfilment");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

const STATE = Object.freeze({
  DRAFT: "DRAFT",
  ISSUED: "ISSUED",
  CANCELLED: "CANCELLED",
});
const STATES = Object.freeze(Object.values(STATE));

/** A state that can still be edited. */
const EDITABLE_STATES = Object.freeze([STATE.DRAFT]);

/* ── ONE EXPECTED MATERIAL ───────────────────────────────────────────────────
   Identity comes from Store's catalogue and is written by the server, never by
   the client: `rawItemId` and `variantId` are the reference, and the name, code
   and variant reading are snapshots taken from the catalogue at the moment the
   line was added. The snapshot is for reading a revision as it was issued —
   Store renaming an item later must not silently rewrite a document the
   customer was sent.

   What Merchandising ADDS is the quantity, the unit and the date. Nothing
   else. */
const lineSchema = new mongoose.Schema({
  /* ── A LINE'S OWN NAME, STABLE ACROSS REVISIONS ──────────────────────────
     Carried forward when a revision is opened from an issued one, so the same
     material is the same line throughout the order's life. An index position
     would not do: inserting a line above would renumber everything below it and
     every reference to "line 3" in an email would start pointing somewhere
     else. */
  lineRef: { type: String, trim: true, required: true },

  /* Store's catalogue, by reference. */
  rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  /* Read from the catalogue by the server. A client that sends a name is not
     refused — its name is simply not used. */
  rawItemName: { type: String, trim: true, required: true, maxlength: 200 },
  rawItemSku: { type: String, trim: true, default: "" },
  variantCombination: [{ type: String, trim: true }],

  /* ── WHAT IS EXPECTED ───────────────────────────────────────────────────
     A quantity greater than zero: a line expecting nothing is not an
     expectation, and a zero would be read downstream as "cancelled" by one
     reader and "unknown" by another. Removing the line says it plainly. */
  requiredQuantity: { type: Number, required: true, min: 0.0001 },
  /* The unit the quantity is IN, snapshotted as a name. Store owns the unit
     master; this records which one was meant when the line was written, because
     a conversion factor edited later changes what a stored quantity MEANS and
     must not retroactively change what the customer was asked for. */
  unit: { type: String, trim: true, required: true, maxlength: 40 },

  /* When the customer has undertaken to have it here. Optional: a customer who
     has not committed to a date has not, and inventing one would put a
     deadline in a report that nobody agreed to. */
  expectedArrivalDate: { type: Date, default: null },

  /* Anything a person needs to know about this line. Not a place for a price. */
  note: { type: String, trim: true, default: "", maxlength: 1000 },

  addedAt: { type: Date, default: Date.now },

  /* ── SHORT CLOSURE ──────────────────────────────────────────────────────
     Store saying "no more of this is coming". It is NOT a receipt and it does
     not manufacture stock: the received quantity is whatever the goods receipts
     say it is, and this only stops the line expecting more.

     It lives on the line rather than in a derived status because it is a
     DECISION somebody took, with a reason and an actor, and a derived value
     cannot hold either. Reopening is an explicit audited act that clears it. */
  shortClosedAt: { type: Date, default: null },
  shortClosedBy: {
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
  },
  shortCloseReason: { type: String, trim: true, default: "", maxlength: 1000 },
}, { _id: true });

const expectationSchema = new mongoose.Schema(
  {
    /* ── OWNERSHIP ────────────────────────────────────────────────────────
       From the resolved company context, never the payload. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── LINEAGE ──────────────────────────────────────────────────────────
       Which execution file this belongs to, and which order that file is
       executing. Both are stored: the file is how Merchandising reaches it, and
       the order reference is how Store, the customer and every downstream
       reader recognise it without having to know Merchandising's own
       numbering. */
    executionFileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "ExecutionFile", required: true, index: true,
    },
    fileNumber: { type: String, trim: true, default: "" },
    orderRef: { type: String, trim: true, default: "", index: true },
    /* ── THE PERMANENT SALES ORDER LINE ───────────────────────────────────
       `CustomerRequest.items[].lineRef` (`LN-…`), copied from the execution
       file's own projection. Not the handover line and not the style: this is
       the token a WorkOrder's `salesLineLink.lineRef` carries, so it is the only
       thing that can prove a production order and a customer-material document
       are about the same commercial line without comparing styles and buyers.

       Defaulted empty for documents created before it was stamped; issuing
       against such a document is refused rather than guessed. */
    salesOrderLineRef: { type: String, trim: true, default: "", index: true },
    handoverRef: { type: String, trim: true, default: "" },
    handoverLineRef: { type: String, trim: true, default: "" },

    /* ── WHY THIS DOCUMENT IS ALLOWED TO EXIST ────────────────────────────
       Stamped from the execution file's own projection at creation, so the
       eligibility that permitted it is on the record rather than re-derived
       later from a projection that may since have been revised. A document that
       could not say why it exists would be unexplainable the first time
       somebody asked. */
    fulfilmentModel: { type: String, enum: ORDER_FULFILMENT_MODELS, required: true },

    /* ── WHOSE GOODS THESE ARE ────────────────────────────────────────────
       The Customer's own id, resolved on the server by walking
       `currentHandoverVersionId → SalesHandoverVersion.sourceRecord.recordId →
       CustomerRequest.customerId`, and NEVER accepted from a payload — a client
       that could name the customer could attribute one customer's fabric to
       another by editing a form.

       `buyerDisplayLabel` below is not a substitute and never was. It is a
       string Sales composed for a person to read: not unique, not stable under
       a rename, and not something anything joins to. Inventory ownership needs
       a reference, so ownership is carried here and the label travels as a
       snapshot for reading the document back as it was.

       Optional on the DOCUMENT because Phase 1 drafts exist without it and stay
       readable. It is REQUIRED to issue, and required for any receipt: an
       ownership lot with no provable owner is the one record in this whole
       design that must not exist. */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    /* Which confirmed Sales request the ownership descends from. */
    customerRequestId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    /* What the customer read as when this was stamped. A snapshot, never the
       authority — see `customerId`. */
    customerSnapshot: {
      customerCode: { type: String, trim: true, default: "" },
      customerLabel: { type: String, trim: true, default: "" },
      customerName: { type: String, trim: true, default: "" },
      requestRef: { type: String, trim: true, default: "" },
    },

    /* Display snapshots, for reading the document without four joins. Never
       the authority — the file and the order reference are. */
    styleRef: { type: String, trim: true, default: "" },
    buyerStyleRef: { type: String, trim: true, default: "" },
    productName: { type: String, trim: true, default: "" },
    buyerDisplayLabel: { type: String, trim: true, default: "" },

    /* ── THE DOCUMENT AND ITS REVISION ────────────────────────────────────
       `documentRef` is what a person quotes. It is stable across revisions —
       the revision number distinguishes them, because "CSM-4 revision 2" is one
       document that changed and two unrelated codes would hide that. */
    documentRef: { type: String, trim: true, required: true, index: true },
    revisionNo: { type: Number, required: true, min: 1 },

    state: { type: String, enum: STATES, default: STATE.DRAFT, required: true, index: true },

    /* Optimistic concurrency, as every other Merchandising record uses: an edit
       composed against a revision that has since moved is refused rather than
       silently overwriting the other change. */
    revision: { type: Number, default: 0 },

    /* ── THE RECEIPT SERIALISATION TOKEN ──────────────────────────────────
       NOT a count of receipts, and nothing reads its value. It exists so that
       recording a receipt WRITES to this document, which makes two simultaneous
       receipts against the same document conflict in the database instead of
       both succeeding.

       It is needed because the over-receipt check is a read followed by a write:
       two transactions both read "nothing received yet", both find the full
       quantity pending, and both insert a goods receipt. Snapshot isolation does
       not stop them — it only conflicts on documents they BOTH touch — so this is
       the document they are both made to touch. The loser gets a write conflict,
       the driver retries it, and the retry re-reads the receipts and refuses the
       over-receipt properly.

       Deliberately separate from `revision`: that is Merchandising's optimistic
       concurrency for AUTHORING, and bumping it on receipt would make every
       merchandiser's in-flight edit fail because Store took a delivery. These are
       two different kinds of contention and they need two different fields. */
    receiptSerial: { type: Number, default: 0 },

    lines: { type: [lineSchema], default: [] },

    /* What the customer and Store both need to know that is not a line —
       consolidation, labelling, where to deliver. Not a price, not a term. */
    instructions: { type: String, trim: true, default: "", maxlength: 4000 },

    createdBy: actorRef(),
    createdAt: { type: Date, default: Date.now },
    issuedBy: actorRef(),
    issuedAt: { type: Date, default: null },
    cancelledBy: actorRef(),
    cancelledAt: { type: Date, default: null },
    /* Required when cancelling. A withdrawal with no reason leaves Store
       guessing whether to expect the lorry. */
    cancellationReason: { type: String, trim: true, default: "", maxlength: 1000 },

    /* Which issued revision this one was opened from, so the chain is readable
       forwards and backwards. Null on the first. */
    revisedFromRevisionNo: { type: Number, default: null },

    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "merchandising_customer_material_expectations" },
);

/* One revision number per execution file, per company. */
expectationSchema.index(
  { companyId: 1, executionFileId: 1, revisionNo: 1 }, { unique: true },
);

/* ── AT MOST ONE DRAFT PER FILE ──────────────────────────────────────────────
   Two open drafts for one order is not a state anybody can act on: Store would
   have two answers to "what is coming", and issuing one would leave the other
   silently stale. A second draft is refused by this index rather than by a read
   that two simultaneous requests would both pass. */
expectationSchema.index(
  { companyId: 1, executionFileId: 1 },
  {
    unique: true,
    name: "one_open_draft_per_execution_file",
    partialFilterExpression: { state: STATE.DRAFT },
  },
);

/* Store's register: the issued documents for a company, newest first. */
expectationSchema.index({ companyId: 1, state: 1, issuedAt: -1 });
/* Reaching a document by the order somebody quoted. */
expectationSchema.index({ companyId: 1, orderRef: 1, revisionNo: -1 });

module.exports = {
  STATE,
  STATES,
  EDITABLE_STATES,
  CustomerMaterialExpectation: mongoose.models.CustomerMaterialExpectation
    || mongoose.model("CustomerMaterialExpectation", expectationSchema),
};
