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
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock = require("./locationStock.service");
const sequences = require("./documentSequence.service");
const { fail } = require("./errors");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

// ── Strict unit conversion — a MISSING path refuses, never silently passes ───
// (The PO route's convertQuantity returns the input unchanged when no path
// exists; for an authoritative receipt that is dishonest, so this throws.)
async function resolveConversion({ quantity, fromUnit, toUnit, session = null }) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) {
    return { baseQuantity: r4(quantity), factor: 1, note: "" };
  }
  const q = (m) => (session ? m.session(session) : m);
  const fromDoc = await q(Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name")).lean();
  const direct = (fromDoc?.conversions || []).find((c) => (c.toUnit?.name || c.toUnit) === toUnit);
  if (direct?.quantity) {
    return { baseQuantity: r4(quantity * direct.quantity), factor: direct.quantity, note: `${quantity} ${fromUnit} = ${r4(quantity * direct.quantity)} ${toUnit}` };
  }
  const toDoc = await q(Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name")).lean();
  const reverse = (toDoc?.conversions || []).find((c) => (c.toUnit?.name || c.toUnit) === fromUnit);
  if (reverse?.quantity) {
    return { baseQuantity: r4(quantity / reverse.quantity), factor: 1 / reverse.quantity, note: `${quantity} ${fromUnit} = ${r4(quantity / reverse.quantity)} ${toUnit}` };
  }
  throw fail("VALIDATION", `No unit conversion from "${fromUnit}" to "${toUnit}" is configured, so this receipt cannot be recorded.`, {
    reason: "UOM_CONVERSION_MISSING", field: "unit", fromUnit, toUnit,
  });
}

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
    // V1 over-receipt policy: refuse. No silent surplus without inspection.
    if (r4(qty) > pending) {
      throw fail("VALIDATION", `Cannot receive ${qty} ${poItem.unit} for "${poItem.itemName}": only ${pending} ${poItem.unit} remain outstanding.`, {
        reason: "OVER_RECEIPT", poItemId: key, pending, requested: r4(qty),
      });
    }

    const rawItemId = poItem.rawItem?._id || poItem.rawItem || null;
    const unitDoc = rawItemId
      ? await (session ? RawItem.findById(rawItemId).session(session) : RawItem.findById(rawItemId)).select("unit customUnit").lean()
      : null;
    const baseUnit = unitDoc ? (unitDoc.customUnit || unitDoc.unit) : (poItem.unit || "");
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

// The canonical RawItem stock-in — the SAME ledger the PO route uses. Mutates
// the live RawItem doc and returns the created stockTransaction's id, so the
// receipt can link the movement it caused.
function applyStockIn(rawItem, plan, txMeta) {
  const q = plan.baseQuantity;
  const previousBaseQty = rawItem.quantity || 0;
  if (plan.variantId) {
    let variant = rawItem.variants.id(plan.variantId) || null;
    if (!variant && plan.variantCombination?.length) {
      variant = rawItem.variants.find(
        (v) => v.combination?.length === plan.variantCombination.length
          && v.combination.every((val, i) => val === plan.variantCombination[i]),
      ) || null;
    }
    if (variant) {
      variant.quantity = (variant.quantity || 0) + q;
      variant.status = variant.quantity === 0 ? "Out of Stock"
        : variant.quantity <= (variant.minStock || rawItem.minStock || 0) ? "Low Stock" : "In Stock";
      if (!variant.sku) variant.sku = plan.variantSku || `${rawItem.sku}-var`;
    } else {
      rawItem.variants.push({
        combination: plan.variantCombination || [], quantity: q,
        minStock: rawItem.minStock || 0, maxStock: rawItem.maxStock || 0,
        sku: plan.variantSku || `${rawItem.sku}-var-${rawItem.variants.length + 1}`, status: "In Stock",
      });
    }
    rawItem.quantity = rawItem.variants.reduce((sm, v) => sm + (v.quantity || 0), 0);
  } else {
    rawItem.quantity = (rawItem.quantity || 0) + q;
  }
  rawItem.status = rawItem.quantity === 0 ? "Out of Stock"
    : rawItem.quantity <= (rawItem.minStock || 0) ? "Low Stock" : "In Stock";

  rawItem.stockTransactions.unshift({
    type: plan.variantId ? "VARIANT_ADD" : "ADD",
    quantity: q,
    ...(plan.variantId ? { variantId: plan.variantId, variantCombination: plan.variantCombination } : {}),
    previousQuantity: previousBaseQty,
    newQuantity: rawItem.quantity,
    ...txMeta,
  });
  return rawItem.stockTransactions[0]._id;
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
  // allocate() returns the already-formatted number (e.g. "GRN/2026-27/0001").
  const { number: receiptNumber } = await sequences.allocate({ companyId, documentType: "GOODS_RECEIPT", session, siteId: tenant.siteId || null });

  const wh = header.warehouse || null;
  const loc = header.location || null;
  const locSnap = loc ? locStock.txLocationSnapshot(wh, loc) : {};

  const grnLines = [];
  // Group only the plans that move stock (have a rawItemId). A plan with no
  // rawItemId still gets a GRN line + PO update in the build loop below, but no
  // stock/location movement — never a malformed early entry.
  const byRawItem = new Map();
  for (const pl of plans) {
    if (!pl.rawItemId) continue;
    if (!byRawItem.has(pl.rawItemId)) byRawItem.set(pl.rawItemId, []);
    byRawItem.get(pl.rawItemId).push(pl);
  }

  // Stock + location movement, per distinct RawItem (loaded once with session).
  for (const [rawItemId, itemPlans] of byRawItem) {
    const rawItem = session ? await RawItem.findById(rawItemId).session(session) : await RawItem.findById(rawItemId);
    if (!rawItem) throw fail("VALIDATION", `Stock item for a receipt line no longer exists.`, { reason: "RAW_ITEM_MISSING", rawItemId });
    for (const pl of itemPlans) {
      const txId = applyStockIn(rawItem, pl, {
        reason: "Goods Receipt", supplier: purchaseOrder.vendorName, supplierId: purchaseOrder.vendor,
        unitPrice: pl.unitPrice, purchaseOrder: purchaseOrder.poNumber, purchaseOrderId: purchaseOrder._id,
        invoiceNumber: header.invoiceNumber || "", notes: `GRN ${receiptNumber}${pl.conversionNote ? ` (${pl.conversionNote})` : ""}`,
        performedBy: actor.id, ...locSnap,
      });
      pl.__txId = txId;
    }
    await rawItem.save(session ? { session } : {});
    for (const pl of itemPlans) {
      let mvId = null;
      if (loc) {
        const out = await locStock.applyLocationIn(session, {
          companyId, siteId: tenant.siteId, item: rawItem, variantId: pl.variantId || null,
          warehouse: wh, location: loc, quantity: pl.baseQuantity, type: "receipt", intent: "receive",
          source: { kind: "po_receipt", id: purchaseOrder._id, reference: purchaseOrder.poNumber },
          actor: { id: actor.id, name: actor.name },
          note: `GRN ${receiptNumber}`,
          idempotencyKey: locStock.movementLineKey(idempotencyKey || "", pl.poItemId, "grn"),
          operationKey: idempotencyKey || "",
        });
        mvId = out?.movement?._id || null;
      }
      pl.__mvId = mvId;
    }
  }

  // Update PO line state and build GRN lines with resulting figures.
  for (const pl of plans) {
    const poItem = purchaseOrder.items.find((it) => String(it._id) === pl.poItemId);
    poItem.receivedQuantity = r4((Number(poItem.receivedQuantity) || 0) + pl.receivedQuantity);
    poItem.pendingQuantity = r4(Math.max(0, (Number(poItem.quantity) || 0) - poItem.receivedQuantity));
    poItem.status = poItem.receivedQuantity >= poItem.quantity ? "COMPLETED" : poItem.receivedQuantity > 0 ? "PARTIALLY_RECEIVED" : "PENDING";
    grnLines.push({
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

module.exports = { validateReceiptLines, applyReceipt, applyStockIn, resolveConversion };
