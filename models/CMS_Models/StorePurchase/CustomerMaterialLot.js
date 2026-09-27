// models/CMS_Models/StorePurchase/CustomerMaterialLot.js
//
// STOCK THE FACTORY HOLDS AND DOES NOT OWN.
//
// On a job-work order the customer sends the fabric. It sits on our shelf, it is
// counted in our stock-take, it occupies our warehouse — and it is not ours. It
// was bought by somebody else, for one order, and using it for anything else is
// not a stock decision, it is using a customer's property without permission.
//
// ── WHY THIS IS NOT A FLAG ON RawItem ───────────────────────────────────────
// The tempting version is a boolean: `customerOwned: true`. It fails on the
// first real question. Two customers send the same poplin. One customer sends
// poplin for two different orders. One order needs poplin on two different
// lines. In every case `RawItem.quantity` is a single number that has already
// lost the distinction that matters, and no amount of filtering afterwards can
// recover it — the information was never stored.
//
// So ownership is a LOT: an immutable record of one arrival, naming whose it is,
// which order it came for, which line of which document, and how much of it is
// still there. Availability is answered from lots. `RawItem.quantity` remains
// the PHYSICAL total — what a stock-take should find on the shelf — and that is
// all it is.
//
// ── WHAT "NEVER AVAILABLE" MEANS HERE, PRECISELY ────────────────────────────
// Four rules, in decreasing order of how obvious they are and increasing order
// of how often they get broken:
//
//   1  It cannot satisfy another CUSTOMER's order. Obvious, and the one everyone
//      remembers.
//   2  It cannot satisfy another ORDER for the same customer. Less obvious and
//      just as wrong: the customer sent this fabric for that order, and the two
//      orders may have different prices, different deliveries, and different
//      answers about who pays for a shortfall.
//   3  It cannot satisfy another LINE of the same order. A merchandiser stated
//      1,200m for the body and 300m for the sleeves; quietly taking body fabric
//      for sleeves makes the body short later, and nobody will remember why.
//   4  It cannot be silently substituted from another lot at all. If the right
//      lot is short, the answer is a short-closure or another receipt, both of
//      which somebody signs. A substitution nobody signed is a discrepancy
//      discovered at delivery.
//
// The model cannot enforce those on its own — allocation does — but it stores
// every fact each rule needs, and stores them at the grain the rules ask about,
// which is the part a schema can actually guarantee.
//
// ── AND IT IS NOT A SECOND STOCK LEDGER ─────────────────────────────────────
// Every lot names the GRN and GRN line that created it, and the stock and
// location movements that GRN wrote. It is a PROVENANCE AND OWNERSHIP record
// over the existing movements, not a parallel set of them. Reconciling a lot
// against `RawItem` and against the location balance must be possible by
// following stored ids, which is why they are all here.
//
// ── THIS PHASE STOPS AT "RECEIVED AND HELD" ─────────────────────────────────
// `issuedQuantity` and `returnedQuantity` exist and stay zero. Production issue,
// return to customer and barcode marking are the next phase; the fields are
// declared now because `availableQuantity` is meaningless without them and a
// balance that means one thing today and another next month is how a stock
// figure stops being trusted.
"use strict";

const mongoose = require("mongoose");

const STATUS = Object.freeze({
  /* Received and held. The only status this phase can produce. */
  HELD: "HELD",
  /* Nothing left: fully issued to production, fully returned, or both. */
  EXHAUSTED: "EXHAUSTED",
});
const STATUSES = Object.freeze(Object.values(STATUS));

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/* ── ONE MOVEMENT OF ONE LOT ─────────────────────────────────────────────────
   Append-only. Every entry names the act, the quantity, the balance after, and
   who did it — and carries the same provenance the lot does, so a movement read
   on its own still says whose goods moved and against which order. A movement
   that lost that would be indistinguishable from an ordinary stock movement,
   which is exactly the confusion this whole model exists to prevent. */
const lotMovementSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      /* ── TWO KINDS OF "RETURN", AND WHY ONE WORD WOULD NOT DO ────────────
         `RETURNED` used to stand here alone, and it was ambiguous in a way that
         would eventually have cost somebody real fabric. "Returned" means two
         opposite things about a lot:

           · the material left the FACTORY and went back to its owner — the
             quantity is gone from our shelf and we no longer hold it;
           · the material came back from PRODUCTION to Store — the quantity is
             still ours to hold and is available again.

         One word for both would make `returnedQuantity` unreadable: is it stock
         we no longer have, or stock we have again? Every balance built on it
         would be wrong half the time and nobody could tell which half.

         So the word is spelled out. `RETURNED_TO_CUSTOMER` is the only one this
         phase writes, and `returnedQuantity` counts exactly it.
         `RETURNED_FROM_PRODUCTION` is declared and NOT implemented — see the
         balance note below — because declaring it now is what stops the next
         person reaching for the ambiguous word. */
      enum: [
        "RECEIVED",                 // the arrival that created the lot
        "ISSUED",                   // to production, against the order it belongs to
        "RETURNED_TO_CUSTOMER",     // left the factory, back to its owner
        "RETURNED_FROM_PRODUCTION", // declared, not implemented — see below
        "ADJUSTED",                 // a counted correction, with a reason (later)
      ],
      required: true,
    },
    quantity: { type: Number, required: true },
    baseUnit: { type: String, trim: true, default: "" },
    availableAfter: { type: Number, required: true, min: 0 },

    /* ── WHICH OPERATION WROTE THIS ───────────────────────────────────────
       The identity recovery queries by. Without it, "did my return post?" could
       only be answered by looking for a movement that resembled the one
       expected — and an unrelated return from last month resembles it perfectly.

       `operationKey` is the idempotency key of the request that created the
       movement, and `operationType` says which kind of act it was. Together with
       the addressed document and the lot, they identify one operation exactly. */
    operationKey: { type: String, trim: true, default: "" },
    operationType: {
      type: String,
      enum: ["", "RECEIPT", "ISSUE", "RETURN_TO_CUSTOMER"],
      default: "",
    },
    /* The STABLE document this movement was addressed against — not the
       revision's `_id`, which changes when a revision is issued. */
    documentRef: { type: String, trim: true, default: "" },

    /* ── TWO DATES ────────────────────────────────────────────────────────
       `at` is when the movement is deemed to have happened — the effective
       business date, which for a return is the day the lorry left. `recordedAt`
       is when somebody typed it in. Routinely days apart, and the one a customer
       argues about is the first. */
    at: { type: Date, required: true, default: Date.now },
    recordedAt: { type: Date, default: Date.now },
    by: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
    },
    reason: { type: String, trim: true, default: "" },

    /* ── PROVENANCE CARRIED ON EVERY MOVEMENT ─────────────────────────────
       Not only on the lot. A movement extracted into a report has to be able to
       say whose goods moved and against what, without a join back. */
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
    goodsReceiptNumber: { type: String, trim: true, default: "" },
    /* The RawItem stock transaction and warehouse/location movement this lot
       movement corresponds to — so a lot reconciles to the physical ledgers by
       stored id rather than by matching numbers and hoping. */
    stockTransactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationMovementId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── WHERE IT WENT, ON AN ISSUE ───────────────────────────────────────
       The production order it was handed to, and the work order within it where
       one was named. On the MOVEMENT rather than only on the issue record,
       because "which of these movements went to WO-1183" is a question asked of
       the lot, and answering it by joining out to a separate collection is how a
       traceability query stops being run. */
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    manufacturingOrderNumber: { type: String, trim: true, default: "" },
    workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
    workOrderNumber: { type: String, trim: true, default: "" },
    /* The canonical record this movement belongs to — a `StockIssuance` for an
       issue, a `CustomerMaterialReturn` for a return. Set in the same transaction
       that creates it, on the exact movement, by id. */
    stockIssuanceId: { type: mongoose.Schema.Types.ObjectId, default: null },
    customerReturnId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialReturn", default: null },
    /* On a return to the customer: what they signed for. */
    customerReference: { type: String, trim: true, default: "" },
    /* Where it was taken from, so a movement reads without the lot header. */
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationCode: { type: String, trim: true, default: "" },
  },
  { _id: true },
);

const customerMaterialLotSchema = new mongoose.Schema(
  {
    /* ── WHOSE COMPANY HOLDS IT ───────────────────────────────────────────
       The factory's company. Not the customer's — the customer is not a tenant
       here, they are the owner of the goods. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── WHOSE GOODS ──────────────────────────────────────────────────────
       The stable Customer id, resolved on the server from the Sales handover
       chain. Required: a lot with no provable owner is the one record in this
       design that must not exist, because the only safe thing to do with stock
       nobody can attribute is nothing at all. */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    /* What the customer read as when this arrived. A snapshot for reading the
       lot back as it was — never the thing joined on. */
    customerLabel: { type: String, trim: true, default: "" },
    customerCode: { type: String, trim: true, default: "" },

    /* ── FOR WHICH ORDER, AND WHICH LINE OF IT ────────────────────────────
       Rules 2 and 3 in the header live or die on these two. */
    orderRef: { type: String, trim: true, required: true, index: true },
    /* ── THE PERMANENT SALES ORDER LINE ───────────────────────────────────
       `CustomerRequest.items[].lineRef` — the `LN-…` token Sales mints once per
       commercial line and never reissues.

       This used to hold the EXPECTATION's line reference, which duplicated
       `expectationLineRef` below and left the lot unable to name the Sales line
       at all. That mattered the moment production issue arrived: a WorkOrder
       proves what it is making through `salesLineLink.lineRef`, which is this
       token — so without it there is no way to show that a lot and a WorkOrder
       are about the same commercial line except by comparing styles and buyers,
       which is exactly the guessing this whole design refuses.

       Optional for lots created before the correction; every write since carries
       it, and an issue is refused without it rather than guessed. */
    orderLineRef: { type: String, trim: true, default: "", index: true },
    executionFileId: { type: mongoose.Schema.Types.ObjectId, ref: "ExecutionFile", required: true, index: true },

    /* ── AGAINST WHICH DOCUMENT, AND WHICH REVISION OF IT ─────────────────
       `documentRef` is stable across revisions; `expectationRevisionNo` names
       the exact revision this receipt was recorded against, so a later revision
       never rewrites the provenance of an earlier arrival. */
    expectationId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialExpectation", required: true },
    documentRef: { type: String, trim: true, required: true, index: true },
    expectationRevisionNo: { type: Number, required: true },
    expectationLineRef: { type: String, trim: true, required: true },

    /* ── WHAT IT IS ───────────────────────────────────────────────────────
       Store's catalogue identity. The material is an ordinary catalogue item;
       what is unusual is who owns this quantity of it. */
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true, index: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },

    /* ── WHICH ARRIVAL ────────────────────────────────────────────────────
       One lot per received GRN line. The pair is unique (declared below), which
       is what makes a replayed receipt unable to create a second lot even if it
       somehow got past the idempotency claim. */
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", required: true, index: true },
    goodsReceiptNumber: { type: String, trim: true, required: true },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* ── WHERE IT IS ──────────────────────────────────────────────────────── */
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, trim: true, default: "" },
    locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationCode: { type: String, trim: true, default: "" },

    /* ── HOW MUCH ARRIVED ─────────────────────────────────────────────────
       Both the unit it was counted in and the base unit it converts to. The
       receipt unit is kept because that is what the delivery note said and what
       a dispute is argued in; the base quantity is what every balance uses. */
    receiptUnit: { type: String, trim: true, required: true },
    receiptQuantity: { type: Number, required: true, min: 0 },
    baseUnit: { type: String, trim: true, required: true },
    baseQuantity: { type: Number, required: true, min: 0 },

    /* ── HOW MUCH IS STILL THERE ──────────────────────────────────────────
       In BASE units, always. `availableQuantity` is the number allocation reads;
       the other two are how it got there, kept so the balance is explainable
       rather than merely current.

       ── WHAT EACH ONE COUNTS, PRECISELY ──────────────────────────────────
         availableQuantity  held by Store, ours to issue or return
         issuedQuantity     handed to production against this order line
         returnedQuantity   sent back to the CUSTOMER — off our shelf for good

       `returnedQuantity` is NOT "came back from production". That would make the
       sum below count one physical quantity twice: material returned from
       production is available again, so it belongs in `availableQuantity`, and
       counting it here as well would inflate the lot by exactly the amount that
       came back. The distinction is why the movement enum spells both out.

       If `RETURNED_FROM_PRODUCTION` is implemented later it must move quantity
       from `issuedQuantity` back to `availableQuantity` and leave
       `returnedQuantity` alone — the sum stays `baseQuantity` throughout, which
       is what the validator below enforces.

       `min: 0` is not decoration. A negative lot balance would mean the factory
       had issued more of a customer's fabric than the customer sent, which is
       not a number to be stored and reconciled later — it is a thing that must
       not be writable. */
    availableQuantity: { type: Number, required: true, min: 0 },
    issuedQuantity: { type: Number, default: 0, min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: STATUSES, default: STATUS.HELD, required: true, index: true },

    receivedAt: { type: Date, required: true },
    receivedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
    },

    /* ── HAS IT BEEN LABELLED ─────────────────────────────────────────────
       A count, not a flag, and not the barcodes themselves: the labels live in
       the Barcode collection and point AT this lot, which is the direction that
       keeps one barcode system rather than two. This is the cheap answer to
       "does this lot have a label yet", so the Store screen does not join to
       find out — and a REPRINT deliberately does not change it, because
       reprinting the same label is not a second label. */
    /* When something last happened to this lot. A cheap sort key for "what moved
       recently", so a register does not reach into the movement array to order
       its rows. */
    lastMovementAt: { type: Date, default: null },

    labelCount: { type: Number, default: 0, min: 0 },
    lastLabelledAt: { type: Date, default: null },

    /* ── HOW MUCH OF THIS LOT IS ALREADY CLAIMED BY A LABEL ────────────────
       The quantity, not the count. `labelCount` answers "has this been
       labelled"; only a quantity can answer "may another 300 metres be
       labelled", and without it six labels of 300 could be printed for a lot
       holding 500 — each of them believable, and four of them wrong.

       THE RULE: `labelledQuantity <= availableQuantity`, always. It is enforced
       in the print filter as a condition, so two simultaneous prints cannot both
       pass it.

       WHEN MATERIAL LEAVES, ITS LABELS LEAVE WITH IT. A sticker is stuck to the
       roll; issuing that roll to production sends the sticker to the cutting
       table, and returning it sends the sticker back to the customer. So a
       decrement of `availableQuantity` caps this in the same write rather than
       leaving a lot with 0 held and 500 claimed — which would have reported the
       whole remaining quantity as unlabelable forever. */
    labelledQuantity: { type: Number, default: 0, min: 0 },
    lastAllocationSeq: { type: Number, default: 0, min: 0 },

    movements: { type: [lotMovementSchema], default: [] },
  },
  { timestamps: true, collection: "customer_material_lots" },
);

/* ── ONE LOT PER RECEIVED GRN LINE ───────────────────────────────────────────
   The last line of defence behind the idempotency claim and the transaction. If
   a replay ever reached lot creation, this index is what stops a second lot
   rather than doubling a customer's stock. */
customerMaterialLotSchema.index(
  { companyId: 1, goodsReceiptId: 1, goodsReceiptLineId: 1 }, { unique: true },
);

/* The allocation question: what is held for THIS customer, THIS order, THIS
   line, of THIS material, that still has something in it. Every clause the four
   ownership rules need, in one index, so the correct query is also the fast one
   — a correct rule that is slow is a rule somebody works around. */
customerMaterialLotSchema.index({
  companyId: 1, customerId: 1, orderRef: 1, orderLineRef: 1, rawItemId: 1, status: 1,
});
/* "Everything we hold for this customer", and "everything against this
   document" — the two register reads. */
customerMaterialLotSchema.index({ companyId: 1, customerId: 1, receivedAt: -1 });
customerMaterialLotSchema.index({ companyId: 1, documentRef: 1, expectationLineRef: 1 });
/* Physical reconciliation: what customer-owned stock sits in this location. */
customerMaterialLotSchema.index({ companyId: 1, locationId: 1, rawItemId: 1 });

/* ── THE BALANCE MUST ALWAYS ADD UP ──────────────────────────────────────────
   available + issued + returned === baseQuantity, always. Checked before every
   write rather than trusted, because the three numbers are updated by different
   acts in different phases and the first one to drift would be discovered as a
   shortfall on a shop floor. */
customerMaterialLotSchema.pre("validate", function balanceAddsUp(next) {
  const sum = r4((this.availableQuantity || 0) + (this.issuedQuantity || 0) + (this.returnedQuantity || 0));
  if (sum !== r4(this.baseQuantity)) {
    return next(new Error(
      `Customer material lot balance does not add up: available ${this.availableQuantity} + issued `
      + `${this.issuedQuantity} + returned ${this.returnedQuantity} is ${sum}, not the received ${this.baseQuantity}.`,
    ));
  }
  /* Status follows the balance rather than being set independently — a stored
     status that disagrees with the number beside it is worse than no status. */
  this.status = r4(this.availableQuantity) > 0 ? STATUS.HELD : STATUS.EXHAUSTED;
  return next();
});

const CustomerMaterialLot = mongoose.models.CustomerMaterialLot
  || mongoose.model("CustomerMaterialLot", customerMaterialLotSchema);

module.exports = { CustomerMaterialLot, STATUS, STATUSES };
