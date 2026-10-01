"use strict";
// services/storePurchase/customerMaterialLabel.service.js
//
// THE STICKER THAT SAYS "THIS IS NOT OURS".
//
// A roll of a customer's fabric sits on the same rack as our own, looks the same,
// and scans the same. Somebody will cut it for the wrong order — and the person
// who does it will have had no way to know, because nothing on the roll said
// otherwise. That is the whole problem this label solves, and it is why the
// ownership banner is not decoration.
//
// ── IT EXTENDS THE EXISTING BARCODE SYSTEM ──────────────────────────────────
// One collection, one scan endpoint, one printing path. Product marking and
// purchase receipts already write `Barcode` documents; a customer-owned label is
// a third kind of the same thing, told apart by `customerMaterial.lotId`. A
// second collection would mean a second scanner configuration, a second warehouse
// report, and a scan that found nothing because it looked in the wrong place.
//
// ── WHAT A REPRINT IS, AND IS NOT ───────────────────────────────────────────
// A sticker falls off a roll and has to be replaced. That is a REPRINT: the same
// label, on new paper. It must not create stock, a receipt, another lot or a
// balance change — so it is a READ. Nothing is written, not even a print counter,
// because the same label printed twice is one label and a counter that said "2"
// would invite somebody to wonder whether two rolls exist.
//
// ── AND NO PRICE, EVER ──────────────────────────────────────────────────────
// The purchase path puts vendor and unit price on its labels, which is right for
// goods we bought. Putting either on a customer's roll would print a valuation of
// somebody else's property on their own material. The Barcode model refuses it;
// this file never offers it.

const mongoose = require("mongoose");

const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const { fail } = require("./errors");
/* One implementation of "does this lot belong to the document in the URL", shared
   with the issue and return paths so a label cannot be scoped more loosely than a
   movement. */
const issue = require("./customerMaterialIssue.service");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** The banner, in one place, so no screen or label invents its own wording. */
const OWNERSHIP_BANNER = "CUSTOMER-SUPPLIED MATERIAL — NOT COMPANY-OWNED";

/**
 * The document in the URL and the lot, proven to belong together.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * The check used to read `if (isId(docId) && lot.expectationId !== docId)`. The
 * guard was conditional on the id being WELL FORMED, so the one input an attacker
 * controls decided whether the check ran at all: `/customer-materials/x/lots/
 * <someone else's lot>/labels` skipped it entirely and printed an ownership label
 * — customer name, order, quantities — for a lot on a document the caller had
 * never been shown. A malformed document id is now a refusal, not a bypass.
 *
 * ── AND IT BINDS ON THE STABLE DOCUMENT, NOT THE REVISION ROW ───────────────
 * `expectationId` is one revision's `_id`. Material received against revision 2
 * and still on the shelf when revision 3 is issued would have become unlabelable
 * and untraceable through the current document. The binding is the stable
 * `documentRef`, the execution file, the customer and the permanent sales line —
 * the same test the issue and return paths apply, from one implementation.
 */
async function addressedLot(ctx, { docId, lotId }, session = null) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store.");
  if (!isId(lotId)) throw fail("NOT_FOUND", "That lot was not found.");

  /* Throws NOT_FOUND for a malformed id, a missing document, or one belonging to
     another company. */
  const doc = await issue.addressedDocument(ctx, docId, session);

  const lot = await CustomerMaterialLot
    .findOne({ _id: lotId, companyId: ctx.companyId }).session(session);
  if (!lot) throw fail("NOT_FOUND", "That lot was not found in this company.");

  try {
    issue.assertLotBelongsTo(lot, doc);
  } catch (err) {
    /* Answers exactly as a lot that does not exist. Reporting WHY it was refused
       would confirm that the lot exists on some other document — which is the
       disclosure the check is here to prevent. The specific reason is kept for
       the log, not for the response. */
    if (err?.name === "StorePurchaseError") {
      throw fail("NOT_FOUND", "That lot was not found on this document.", {
        reason: "LOT_NOT_ON_THIS_DOCUMENT",
      });
    }
    throw err;
  }
  return { doc, lot };
}

/** The lot alone, for the read paths that do not need the document. */
async function lotOf(ctx, { docId, lotId }, session = null) {
  const { lot } = await addressedLot(ctx, { docId, lotId }, session);
  return lot;
}

/** Everything a label prints, from the lot. Nothing computed, nothing guessed. */
function labelView(barcode, lot) {
  const cm = barcode.customerMaterial || {};
  return {
    /* The scannable identity — the Barcode document's own id, as the existing
       system already encodes. */
    barcodeId: str(barcode._id),
    /* The sentence, first, because it is the reason the label exists. */
    banner: OWNERSHIP_BANNER,
    ownership: "CUSTOMER_OWNED",
    customer: {
      id: str(cm.customerId), label: str(cm.customerLabel), code: str(cm.customerCode),
    },
    orderRef: str(cm.orderRef),
    orderLineRef: str(cm.orderLineRef),
    documentRef: str(cm.documentRef),
    againstRevisionNo: cm.expectationRevisionNo ?? null,
    expectationLineRef: str(cm.expectationLineRef),
    material: {
      name: str(barcode.rawItemName), sku: str(barcode.rawItemSku),
      variantCombination: (barcode.variantCombination || []).map(str),
      variantSku: str(barcode.variantSku),
    },
    lot: {
      id: str(cm.lotId),
      goodsReceiptNumber: str(cm.goodsReceiptNumber),
      receivedAt: lot?.receivedAt || null,
    },
    quantity: barcode.quantity,
    unit: str(barcode.unit),
    /* WHICH claim on the lot this sticker is, so a roll found on a floor traces
       to one allocation rather than to "one of this lot's labels". */
    allocation: { ref: str(cm.allocationRef), seq: cm.allocationSeq ?? null },
    where: {
      warehouseName: str(cm.warehouseName), locationCode: str(cm.locationCode),
    },
    printedAt: barcode.createdAt || null,
    /* Deliberately absent: vendor, unitPrice, purchaseOrder. Nothing was bought,
       and the model refuses them on this kind of label. */
  };
}

/**
 * THE LABEL THIS KEY ALREADY PRODUCED, if any.
 *
 * The Barcode is the canonical evidence that a print happened: it is the thing a
 * scanner reads, it carries the key, and it is created in the same transaction as
 * the claim on the lot. So "did this operation land?" is answered by looking for
 * it — never by looking for "a label on this lot", which any earlier print would
 * satisfy.
 */
async function labelForKey(ctx, { docId, lotId, printKey }, session = null) {
  const key = str(printKey);
  if (!key) return null;
  const { lot } = await addressedLot(ctx, { docId, lotId }, session);
  const barcode = await Barcode.findOne({
    companyId: ctx.companyId,
    "customerMaterial.lotId": lot._id,
    "customerMaterial.printKey": key,
  }).session(session);
  if (!barcode) return null;
  return {
    label: labelView(barcode, lot), banner: OWNERSHIP_BANNER,
    created: false, replay: true,
    allocation: {
      ref: str(barcode.customerMaterial?.allocationRef),
      seq: barcode.customerMaterial?.allocationSeq ?? null,
      quantity: barcode.quantity,
      baseUnit: str(barcode.unit),
      lotHeld: r4(lot.availableQuantity),
      lotLabelled: r4(lot.labelledQuantity),
      stillLabelable: r4(Math.max(
        0, r4(lot.availableQuantity) - r4(lot.labelledQuantity),
      )),
    },
  };
}

/**
 * PLAN a label — an ALLOCATION of part of the lot, not a description of it.
 *
 * ── THE PARTITION RULE, STATED ONCE ─────────────────────────────────────────
 * A lot may carry several labels: a delivery of six rolls is six stickers, and one
 * sticker reading "3,000 m" is useless on a shop floor. So each label names the
 * quantity on the thing it is stuck to, and:
 *
 *     the sum of a lot's label quantities may never exceed the quantity the lot
 *     PHYSICALLY HOLDS
 *
 * The physically held quantity is the partition — `availableQuantity`, what is on
 * the shelf now — and not the quantity received. Received would be wrong in a way
 * that matters: after 400 of a 500 m lot has gone to the cutting room, labels
 * totalling 500 could still be printed, and 400 m of them would be stickers for
 * material that is no longer there for anybody to find.
 *
 * ── WHAT THE OLD CHECK ALLOWED ──────────────────────────────────────────────
 * It compared ONE requested quantity against the held quantity and ignored every
 * label already printed. Four separate labels of 300 for a lot holding 400 each
 * passed on their own; together they claimed 1,200. Nothing in the system
 * disagreed, and four rolls went to the floor each marked with metres that did
 * not exist.
 *
 * This stage writes NOTHING. It returns either a `replay` (this key already has a
 * label) or a quantity to claim.
 */
async function planLabel(ctx, { docId, lotId, quantity, printKey = "" }, session = null) {
  const { doc, lot } = await addressedLot(ctx, { docId, lotId }, session);

  /* An exact replay: the same key already produced a label, so nothing is
     allocated and nothing is written. */
  const already = await labelForKey(ctx, { docId, lotId, printKey }, session);
  if (already) return { doc, lot, replay: true, result: already };

  const held = r4(lot.availableQuantity);
  const claimedAlready = r4(lot.labelledQuantity);
  const labelable = r4(Math.max(0, held - claimedAlready));
  const want = quantity === undefined || quantity === null || str(quantity) === ""
    ? labelable
    : r4(quantity);

  if (!(want > 0)) {
    /* Defaulting to "whatever is left" and finding nothing left is a different
       thing from asking for zero, and says so. */
    if (labelable <= 0) {
      throw fail("VALIDATION",
        `Every unit of lot ${str(lot.goodsReceiptNumber)} that is on the shelf is already on a `
        + `label — ${held} ${str(lot.baseUnit)} held, ${claimedAlready} labelled.`,
        {
          reason: "NOTHING_LEFT_TO_LABEL",
          held, labelled: claimedAlready, labelable,
        });
    }
    throw fail("VALIDATION", "A label needs a quantity greater than zero.", { field: "quantity" });
  }

  if (want > labelable) {
    throw fail("VALIDATION",
      `Lot ${str(lot.goodsReceiptNumber)} holds ${held} ${str(lot.baseUnit)}, of which `
      + `${claimedAlready} is already on labels, so only ${labelable} may be labelled — `
      + `not ${want}.`,
      {
        reason: "LABEL_EXCEEDS_HELD",
        held, labelled: claimedAlready, labelable, requested: want,
      });
  }

  return { doc, lot, quantity: want, replay: false };
}

/**
 * POST the label: claim the quantity and create the sticker, in ONE transaction.
 *
 * ── WHY THE SESSION IS NOT OPTIONAL HERE ────────────────────────────────────
 * These are two writes to two collections. They used to be sequential with a
 * `catch` between them that put the claim back — which handles a thrown error and
 * does nothing whatsoever about the process being killed in the gap, a redeploy
 * landing mid-request, or the connection dropping. The gap was small and the
 * consequence was permanent: the lot went on holding a claim for quantity no
 * sticker accounted for, and that quantity could never be labelled again.
 *
 * With a session both writes commit or neither does. Without one — a standalone
 * mongod — the claim is still taken first and the compensation still runs, but the
 * route marks the operation BEFORE the mutation so an interrupted attempt is
 * reported as needing reconciliation rather than silently retried. That is an
 * honest degraded mode, not atomicity.
 */
async function postLabel(ctx, {
  doc, lot, quantity, actor, printKey = "", session = null,
}) {
  const want = r4(quantity);

  /* ── 1. CLAIM THE QUANTITY, OR BE REFUSED ─────────────────────────────────
     `$expr` puts the partition rule in the FILTER, so the server decides against
     the stored row. The check in `planLabel` is the readable message; this is the
     one that cannot be raced. */
  const claimed = await CustomerMaterialLot.findOneAndUpdate(
    {
      _id: lot._id,
      companyId: ctx.companyId,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$labelledQuantity", 0] }, want] },
          { $ifNull: ["$availableQuantity", 0] },
        ],
      },
    },
    {
      $inc: { labelledQuantity: want, labelCount: 1, lastAllocationSeq: 1 },
      $set: { lastLabelledAt: new Date() },
    },
    { new: true, session },
  );
  if (!claimed) {
    const fresh = await CustomerMaterialLot.findById(lot._id).session(session).lean();
    const nowHeld = r4(fresh?.availableQuantity || 0);
    const nowLabelled = r4(fresh?.labelledQuantity || 0);
    throw fail("CONFLICT",
      `Lot ${str(lot.goodsReceiptNumber)} cannot take a label for ${want} ${str(lot.baseUnit)} — `
      + `${nowHeld} held, ${nowLabelled} already labelled. Nothing was printed.`,
      {
        reason: "LABEL_ALLOCATION_LOST",
        held: nowHeld, labelled: nowLabelled,
        labelable: r4(Math.max(0, nowHeld - nowLabelled)), requested: want,
      });
  }

  const allocationSeq = claimed.lastAllocationSeq;
  const allocationRef = `${str(lot.goodsReceiptNumber) || str(lot._id)}/L${allocationSeq}`;

  /* ── 2. AND THE STICKER, IN THE SAME TRANSACTION ──────────────────────── */
  let barcode;
  try {
    [barcode] = await Barcode.create([{
      /* Company-scoped, which is what makes a cross-company scan refusable. */
      companyId: ctx.companyId,
      rawItem: lot.rawItemId,
      rawItemName: str(lot.itemName),
      rawItemSku: str(lot.sku),
      variantId: lot.variantId || null,
      variantCombination: (lot.variantCombination || []).map(str),
      quantity: want,
      unit: str(lot.baseUnit),
      /* No vendor, no unitPrice, no purchaseOrder — the model refuses them here. */
      generatedBy: actor?.id || null,
      customerMaterial: {
        lotId: lot._id,
        goodsReceiptId: lot.goodsReceiptId,
        goodsReceiptNumber: str(lot.goodsReceiptNumber),
        goodsReceiptLineId: lot.goodsReceiptLineId,
        customerId: lot.customerId,
        customerLabel: str(lot.customerLabel),
        customerCode: str(lot.customerCode),
        orderRef: str(lot.orderRef),
        orderLineRef: str(lot.orderLineRef),
        executionFileId: lot.executionFileId,
        documentRef: str(lot.documentRef),
        expectationRevisionNo: lot.expectationRevisionNo,
        expectationLineRef: str(lot.expectationLineRef),
        warehouseId: lot.warehouseId,
        warehouseName: str(lot.warehouseName),
        locationId: lot.locationId,
        locationCode: str(lot.locationCode),
        printCount: 1,
        lastPrintedAt: new Date(),
        allocationRef,
        allocationSeq,
        printKey: str(printKey),
      },
    }], session ? { session, ordered: true } : { ordered: true });
  } catch (err) {
    /* Without a transaction the claim would otherwise stay spent on a label that
       was never created. This is a compensation, not atomicity — see the note
       above on why the route does not rely on it. */
    if (!session) {
      await CustomerMaterialLot.updateOne(
        { _id: lot._id, companyId: ctx.companyId },
        { $inc: { labelledQuantity: -want, labelCount: -1 } },
      );
    }
    throw err;
  }

  return {
    label: labelView(barcode, claimed),
    banner: OWNERSHIP_BANNER,
    created: true,
    allocation: {
      ref: allocationRef, seq: allocationSeq,
      quantity: want, baseUnit: str(lot.baseUnit),
      lotHeld: r4(claimed.availableQuantity),
      lotLabelled: r4(claimed.labelledQuantity),
      stillLabelable: r4(Math.max(0, r4(claimed.availableQuantity) - r4(claimed.labelledQuantity))),
    },
  };
}

/**
 * The labels a lot already has — which is what a REPRINT reads.
 *
 * A read, and nothing more. See the header.
 */
async function labelsFor(ctx, { docId, lotId }) {
  const lot = await lotOf(ctx, { docId, lotId });
  const rows = await Barcode.find({
    companyId: ctx.companyId, "customerMaterial.lotId": lot._id,
  }).sort({ createdAt: -1 }).lean();
  const held = r4(lot.availableQuantity);
  const labelled = r4(lot.labelledQuantity);
  return {
    banner: OWNERSHIP_BANNER,
    lotId: str(lot._id),
    goodsReceiptNumber: str(lot.goodsReceiptNumber),
    labels: rows.map((b) => labelView(b, lot)),
    /* The partition, stated, so a screen can show what is left to label instead
       of offering a quantity that will be refused. */
    partition: {
      basis: "PHYSICALLY_HELD",
      held, labelled,
      stillLabelable: r4(Math.max(0, held - labelled)),
      baseUnit: str(lot.baseUnit),
    },
    /* Said out loud on the response, because a screen offering "Reprint" should
       be able to state that it changes nothing. */
    reprintEffect: "NONE",
  };
}

/**
 * One lot's whole history: the arrival, every issue, every return.
 *
 * Read straight off the lot's append-only movement array, so the order is the
 * order things happened in and nothing has to be reconstructed from three
 * collections.
 */
async function movementsFor(ctx, { docId, lotId }) {
  const lot = await lotOf(ctx, { docId, lotId });
  return {
    lotId: str(lot._id),
    goodsReceiptNumber: str(lot.goodsReceiptNumber),
    customer: { id: str(lot.customerId), label: str(lot.customerLabel) },
    orderRef: str(lot.orderRef),
    orderLineRef: str(lot.orderLineRef),
    baseUnit: str(lot.baseUnit),
    received: lot.baseQuantity,
    availableQuantity: lot.availableQuantity,
    issuedQuantity: lot.issuedQuantity,
    returnedToCustomerQuantity: lot.returnedQuantity,
    movements: (lot.movements || []).map((m) => ({
      id: str(m._id),
      type: str(m.type),
      quantity: m.quantity,
      baseUnit: str(m.baseUnit),
      availableAfter: m.availableAfter,
      /* ── TWO DATES, BOTH SAID ────────────────────────────────────────────
         `at` is when it happened in the business — the day the operator entered,
         which for a return is the day the material left. `recordedAt` is when the
         row was written. A history that showed only one of them could not explain
         why a return entered on Monday appears in a Wednesday audit trail. */
      at: m.at || null,
      recordedAt: m.recordedAt || null,
      by: str(m.by?.name),
      reason: str(m.reason),
      goodsReceiptNumber: str(m.goodsReceiptNumber),
      manufacturingOrderNumber: str(m.manufacturingOrderNumber),
      workOrderNumber: str(m.workOrderNumber),
      customerReference: str(m.customerReference),
      locationCode: str(m.locationCode),
      /* The physical ledgers this movement corresponds to, by stored id, so a
         reconciliation follows references rather than matching numbers. */
      stockTransactionId: m.stockTransactionId ? str(m.stockTransactionId) : null,
      locationMovementId: m.locationMovementId ? str(m.locationMovementId) : null,
      stockIssuanceId: m.stockIssuanceId ? str(m.stockIssuanceId) : null,
      customerReturnId: m.customerReturnId ? str(m.customerReturnId) : null,
      /* WHICH operation wrote this row. A reconciliation can name the operation
         rather than describing a movement that looks like several others. */
      operationKey: str(m.operationKey),
      operationType: str(m.operationType),
      documentRef: str(m.documentRef),
    })),
  };
}

module.exports = {
  OWNERSHIP_BANNER, addressedLot, lotOf, labelView, labelForKey,
  planLabel, postLabel, labelsFor, movementsFor,
};
