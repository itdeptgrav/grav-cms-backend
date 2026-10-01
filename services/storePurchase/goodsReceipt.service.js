// services/storePurchase/goodsReceipt.service.js
//
// GOODS RECEIPT V1 — the ONE authoritative line-level receiving implementation.
//
// It does NOT fork the stock system: RawItem stock still moves through the
// established `stockTransactions` ledger, warehouse/location balances still move
// through `locationStock.applyLocationIn`, numbers still come from the
// `GOODS_RECEIPT` document sequence, and atomicity/idempotency still come from
// the caller's unit of work. This module adds the authoritative GoodsReceipt
// document and the per-line detail on top of that same authority.
//
// V1 proves RECEIPT ONLY. It never calls a quantity "accepted", and it REFUSES
// over-receipt rather than silently booking surplus — surplus handling belongs
// to the later quality/put-away chunks.

"use strict";

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const { fail } = require("./errors");
/* ── THE PHYSICAL ACT, SHARED WITH CUSTOMER-SUPPLIED MATERIAL ────────────────
   Unit conversion, over-receipt refusal, the RawItem stock-in, the warehouse
   movement and the number sequence were all defined in this file, and a second
   kind of arrival — a job-work customer sending fabric — needs every one of them
   to behave identically. They moved to `receiptPosting.service`; this file keeps
   what is specific to a PURCHASE: the purchase-order line state, the supplier
   provenance, and the legacy delivery summary.

   Nothing about the purchase path's behaviour changed, and the exports below are
   unchanged, because the purchase route is the one caller that must not notice
   this happened. */
const posting = require("./receiptPosting.service");
const receivingSession = require("./receivingSession.service");

const { r4, resolveConversion, applyStockIn } = posting;

/**
 * Validate every requested line against the PO and build immutable plans.
 * Runs BEFORE any write, so unknown/cancelled/foreign lines, non-positive
 * quantities, over-receipt and missing conversions all refuse with nothing
 * mutated. Reuses the PO's own line identity (`poItemId`) — never a name match.
 *
 * @returns {{ plans: object[], destination: {warehouse, location} }}
 */
async function validateReceiptLines({ purchaseOrder, items, tenant, session = null }) {
  if (!Array.isArray(items) || items.length === 0) {
    throw fail("VALIDATION", "At least one line is required.", { reason: "NO_LINES" });
  }

  const plans = [];
  const seenLine = new Set();
  for (const ri of items) {
    const poItem = purchaseOrder.items.find((it) => String(it._id) === String(ri.poItemId ?? ri.itemId));
    if (!poItem) {
      throw fail("VALIDATION", `Line ${ri.poItemId ?? ri.itemId} is not part of this purchase order.`, { reason: "UNKNOWN_LINE", poItemId: ri.poItemId ?? ri.itemId });
    }
    if (poItem.status === "CANCELLED") {
      throw fail("VALIDATION", `Line "${poItem.itemName}" is cancelled and cannot be received.`, { reason: "CANCELLED_LINE", poItemId: String(poItem._id) });
    }
    const key = String(poItem._id);
    if (seenLine.has(key)) {
      throw fail("VALIDATION", `Line "${poItem.itemName}" appears more than once in this receipt.`, { reason: "DUPLICATE_LINE", poItemId: key });
    }
    seenLine.add(key);

    const qty = Number(ri.quantity);
    if (!(qty > 0)) {
      throw fail("VALIDATION", `A positive received quantity is required for "${poItem.itemName}".`, { reason: "NON_POSITIVE_QTY", poItemId: key });
    }

    const ordered = Number(poItem.quantity) || 0;
    const previouslyReceived = Number(poItem.receivedQuantity) || 0;
    const pending = r4(Math.max(0, ordered - previouslyReceived));
    /* V1 over-receipt policy: refuse. No silent surplus without inspection.
       The refusal is the shared one, so "never book more than is outstanding"
       cannot come to mean two different things at two different gates. */
    posting.assertWithinPending({
      requested: qty, pending, label: poItem.itemName, unit: poItem.unit,
      details: { poItemId: key },
    });

    const rawItemId = poItem.rawItem?._id || poItem.rawItem || null;
    const baseUnit = await posting.baseUnitOf(rawItemId, poItem.unit || "", session);
    const conv = await resolveConversion({ quantity: qty, fromUnit: poItem.unit, toUnit: baseUnit, session });

    plans.push({
      poItemId: key,
      spendLineId: poItem.spendLineId ? String(poItem.spendLineId) : null,
      rawItemId: rawItemId ? String(rawItemId) : null,
      variantId: ri.variantId || poItem.variantId ? String(ri.variantId || poItem.variantId) : null,
      variantCombination: (ri.variantCombination && ri.variantCombination.length) ? ri.variantCombination : (poItem.variantCombination || []),
      itemName: poItem.itemName || "",
      sku: poItem.sku || "",
      variantSku: poItem.variantSku || "",
      poUnit: poItem.unit || "",
      receivedQuantity: r4(qty),
      baseUnit,
      baseQuantity: conv.baseQuantity,
      conversionFactor: conv.factor,
      conversionNote: conv.note,
      quantityOrdered: ordered,
      previouslyReceived,
      unitPrice: Number(poItem.unitPrice) || 0,
    });
  }
  return { plans };
}

/**
 * Apply a validated receipt atomically INSIDE the caller's unit-of-work session:
 * allocate the GRN, move stock + location balances, update PO lines, create the
 * GoodsReceipt with linked movement ids, and write a legacy-compatible delivery
 * summary that references the GRN. All effects are on `session`, so the caller's
 * transaction/idempotency machinery makes them once-or-not-at-all.
 *
 * @returns {{ goodsReceipt: object }}
 */
async function applyReceipt({ session, tenant, purchaseOrder, plans, header, actor, idempotencyKey }) {
  const companyId = tenant.companyId;

  /* ── A LINE COUNTED BY LABELLING CLOSES ON ITS LABELS ──────────────────────
     Checked BEFORE anything is written, inside this transaction: an open count
     whose applied labels do not hold exactly the quantity being recorded, or
     that still has a printed label nobody settled, refuses the whole receipt.
     A goods receipt whose number disagrees with the stickers on the floor is
     worse than no goods receipt, because everything downstream believes it.
     Lines with no open count are untouched — this returns an empty list and the
     receipt proceeds exactly as it always has. */
  const countedLines = await receivingSession.assertCountsAgree(tenant, { plans }, session);
  // allocate() returns the already-formatted number (e.g. "GRN/2026-27/0001").
  const { number: receiptNumber } = await posting.allocateReceiptNumber({
    companyId, session, siteId: tenant.siteId || null,
  });

  const wh = header.warehouse || null;
  const loc = header.location || null;
  const grnLines = [];

  /* ── THE PURCHASE SOURCE'S PROVENANCE ─────────────────────────────────────
     Everything the shared posting cannot know: that these goods were bought,
     from whom, at what price, against which order and under which invoice. The
     movement itself is identical for a customer's goods; this is the part that
     is not. */
  const source = {
    type: "PURCHASE_ORDER",
    documentId: purchaseOrder._id,
    documentNumber: purchaseOrder.poNumber,
    stockMeta: (pl) => ({
      reason: "Goods Receipt",
      supplier: purchaseOrder.vendorName, supplierId: purchaseOrder.vendor,
      unitPrice: pl.unitPrice,
      purchaseOrder: purchaseOrder.poNumber, purchaseOrderId: purchaseOrder._id,
      invoiceNumber: header.invoiceNumber || "",
      notes: `GRN ${receiptNumber}${pl.conversionNote ? ` (${pl.conversionNote})` : ""}`,
    }),
    locationSource: () => ({
      kind: "po_receipt", id: purchaseOrder._id, reference: purchaseOrder.poNumber,
    }),
  };

  /* The movement idempotency key is per line, as it always was — the plan
     carries the key under a source-neutral name so one posting implementation
     can serve both kinds of line. */
  for (const pl of plans) pl.lineKey = pl.poItemId;

  await posting.postMovements({
    session, tenant, plans, receiptNumber, header, actor, idempotencyKey, source,
  });

  // Update PO line state and build GRN lines with resulting figures.
  for (const pl of plans) {
    const poItem = purchaseOrder.items.find((it) => String(it._id) === pl.poItemId);
    poItem.receivedQuantity = r4((Number(poItem.receivedQuantity) || 0) + pl.receivedQuantity);
    poItem.pendingQuantity = r4(Math.max(0, (Number(poItem.quantity) || 0) - poItem.receivedQuantity));
    poItem.status = poItem.receivedQuantity >= poItem.quantity ? "COMPLETED" : poItem.receivedQuantity > 0 ? "PARTIALLY_RECEIVED" : "PENDING";
    grnLines.push({
      /* Both joins: the generic one every source fills, and the purchase-order
         one this source has always filled. A reader that does not care which
         kind of receipt this is can still name the line it discharges. */
      sourceLineId: pl.poItemId,
      poItemId: pl.poItemId, spendLineId: pl.spendLineId, rawItemId: pl.rawItemId, variantId: pl.variantId,
      variantCombination: pl.variantCombination, itemName: pl.itemName, sku: pl.sku, variantSku: pl.variantSku,
      poUnit: pl.poUnit, receivedQuantity: pl.receivedQuantity, baseUnit: pl.baseUnit, baseQuantity: pl.baseQuantity,
      conversionFactor: pl.conversionFactor, conversionNote: pl.conversionNote,
      quantityOrdered: pl.quantityOrdered, previouslyReceived: pl.previouslyReceived,
      receivedAfter: poItem.receivedQuantity, pendingAfter: poItem.pendingQuantity,
      stockLedgerRef: { rawItemId: pl.rawItemId, transactionId: pl.__txId || null },
      locationMovementId: pl.__mvId || null,
    });
  }

  // ── Completion is decided from LINE-LEVEL pending, never a mixed-unit total ─
  // A PO carrying metres, kilograms and pieces has no meaningful summed receipt
  // quantity, so the order status is derived per line: complete when every
  // non-cancelled line is fully received; partly received when any line has.
  const liveLines = purchaseOrder.items.filter((it) => it.status !== "CANCELLED");
  const anyReceived = liveLines.some((it) => (Number(it.receivedQuantity) || 0) > 0);
  const allComplete = liveLines.length > 0 && liveLines.every((it) => (Number(it.receivedQuantity) || 0) >= (Number(it.quantity) || 0));
  purchaseOrder.status = allComplete ? "COMPLETED" : anyReceived ? "PARTIALLY_RECEIVED" : purchaseOrder.status;

  // COMPATIBILITY ONLY — mixed-unit scalars kept so legacy readers do not break.
  // They are NOT authoritative and NOT for display; the authoritative per-line
  // figures live on the GoodsReceipt lines and the PO line pending states.
  purchaseOrder.totalReceived = r4((Number(purchaseOrder.totalReceived) || 0) + plans.reduce((s, p) => s + p.receivedQuantity, 0));
  purchaseOrder.totalPending = r4(purchaseOrder.items.reduce((s, it) => s + (Number(it.pendingQuantity) || 0), 0));

  const [goodsReceipt] = await GoodsReceipt.create([{
    companyId, siteId: tenant.siteId || null, receiptNumber,
    /* Said rather than inferred. A receipt whose kind is deduced from which
       other fields happen to be set is one schema change away from a customer's
       goods appearing in procurement spend. */
    sourceType: "PURCHASE_ORDER",
    sourceDocumentId: purchaseOrder._id,
    sourceDocumentNumber: purchaseOrder.poNumber || "",
    purchaseOrderId: purchaseOrder._id, poNumber: purchaseOrder.poNumber,
    supplierId: purchaseOrder.vendor || null, supplierName: purchaseOrder.vendorName || "",
    warehouseId: wh?._id || null, warehouseName: wh?.name || "",
    locationId: loc?._id || null, locationCode: loc?.code || "", locationName: loc?.name || "",
    invoiceNumber: header.invoiceNumber || "", receiptDate: header.receiptDate ? new Date(header.receiptDate) : new Date(),
    notes: header.notes || "", status: "RECORDED",
    recordedBy: { id: actor.id || null, name: actor.name || "" },
    idempotencyKey: idempotencyKey || "",
    lines: grnLines,
  }], session ? { session } : {});

  /* ── AND ONLY NOW ARE ITS LABELS STOCK ────────────────────────────────────
     Inside the same transaction, so a receipt that rolls back takes the
     activation with it and the count stays open — rather than leaving live
     stock identities for a delivery no document claims. Applied labels become
     ACTIVATED and carry this receipt; anything still reserved is voided, since
     an identity allocated for a package that never arrived must not be
     printable tomorrow. */
  await receivingSession.activateForReceipt(tenant, { matched: countedLines, goodsReceipt, actor }, session);

  // Legacy-compatible summary — one order-level delivery entry that REFERENCES
  // the authoritative GRN, so old readers keep working and no reader recomputes
  // stock from both records (the GRN is the source of truth; this points to it).
  // `quantityReceived` here is a COMPATIBILITY mixed-unit scalar — non-display,
  // non-authoritative; the per-line receipt figures live on the GRN.
  purchaseOrder.deliveries.unshift({
    deliveryDate: goodsReceipt.receiptDate,
    quantityReceived: r4(plans.reduce((s, p) => s + p.receivedQuantity, 0)),
    invoiceNumber: header.invoiceNumber || "",
    notes: `GRN ${receiptNumber}`,
    receivedBy: actor.id || null,
    goodsReceiptId: goodsReceipt._id,
    goodsReceiptNumber: receiptNumber,
  });

  await purchaseOrder.save(session ? { session } : {});
  return { goodsReceipt };
}

/* `applyStockIn` and `resolveConversion` are re-exported from their new home so
   every existing caller and test is untouched by the extraction. */
module.exports = { validateReceiptLines, applyReceipt, applyStockIn, resolveConversion };
