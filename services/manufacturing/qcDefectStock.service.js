// services/manufacturing/qcDefectStock.service.js
//
// A DEFECT FOUND BY QC LEAVES THE STORE'S STOCK  (10 Oct 2026, owner)
//
// Raw-material QC records, per label, how much of it is defective
// (QCRawItemInspection.defectiveQuantity). Until now that figure went nowhere:
// the Store's on-hand for the raw item and its variant still counted the
// defective metres as good stock, and the label still read its full quantity.
// The owner: "the defected qty need to reduce from the corresponding raw
// item-variant qty ... and keep the history for that raw item variant debit,
// the stock transaction, as like others".
//
// So a defective verdict is a stock DEBIT, written the way the Store's own
// issue writes one (routes/CMS_Routes/Inventory/Products/stockAdjustments.js):
//
//   · the LABEL's own quantity drops first (the owner's rule from 2 Oct 2026:
//     what a label stands for is what is left on it) — guarded at zero;
//   · RawItem.quantity and the variant's quantity move by ONE guarded, atomic
//     update — the guard is in the query, so a concurrent issue that empties
//     the balance first leaves this one refused, never negative; if it is
//     refused the label's figure is put straight back, so the two never
//     disagree;
//   · a row is pushed onto RawItem.stockTransactions[] — type VARIANT_REDUCE
//     (REDUCE for an item with no variant), reason "QC defect", with the
//     item's and the variant's before/after, who recorded it and the MO, GRN
//     and defect reasons in the notes — so the Store's Stock movements page,
//     the ledger routes and the valuation read it exactly like any issue;
//   · if the label sits on a shelf (a LocationMovement balance under this
//     sticker) the shelf's balance drops too, up to what it holds there, so
//     located + unallocated = on hand keeps holding. Best effort: a refused
//     shelf debit leaves the stock debit standing (the stock IS gone) and is
//     logged.
//
// A RE-CHECK that replaces a defective verdict first puts the earlier debit
// back (a credit row, reason "QC defect reversed") and then applies the new
// one, so the stock always reflects the STANDING verdict and the history
// shows both movements.
//
// If stock cannot be moved (the Store already issued the label past this
// figure, the item is in the trash, no unit conversion), the verdict is STILL
// saved — QC's finding is a fact whatever the Store's balance says — and the
// failure is written on the record (`stockDebit.applied: false`,
// `stockDebit.error`) and said in the response, so nobody has to guess
// whether stock moved. `applyDefectDebit` therefore RETURNS a failure block
// rather than throwing, and writes nothing durable before the point at which
// it can still fail (label → item with undo → shelf best-effort).
//
// Quantities are in the LABEL's unit. When that is the item's registered unit
// the figure is used as is; otherwise the unit register's conversion is used
// (receiptPosting.resolveConversion — the same reader the GRN credit used, so
// the credit and this debit agree).
"use strict";

const mongoose = require("mongoose");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock = require("../storePurchase/locationStock.service");
const storeLoc = require("../storePurchase/storeLocations.service");
const { resolveConversion } = require("../storePurchase/receiptPosting.service");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const sameUnit = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const isOid = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const REASON_DEBIT = "QC defect";
const REASON_CREDIT = "QC defect reversed";
const ITEM_SELECT = "name sku unit customUnit quantity minStock variants companyId";

/** The label's figure, in the item's registered unit. */
async function toBaseQuantity({ quantity, labelUnit, item, session }) {
  const base = item.customUnit || item.unit || "";
  if (!labelUnit || !base || sameUnit(labelUnit, base)) return { quantity: r4(quantity), unit: base || labelUnit || "", converted: false };
  const conv = await resolveConversion({ quantity, fromUnit: labelUnit, toUnit: base, session });
  const converted = r4(conv?.baseQuantity);
  if (!(converted > 0)) {
    const err = new Error(`No unit conversion from "${labelUnit}" to "${base}" is configured, so the defective quantity could not be taken off the stock.`);
    err.code = "NO_CONVERSION";
    throw err;
  }
  return { quantity: converted, unit: base, converted: true, note: conv.note || "" };
}

const statusOf = (qty, minStock) => (qty <= 0 ? "Out of Stock" : qty <= (minStock || 0) ? "Low Stock" : "In Stock");

/**
 * One guarded movement of the item (and its variant) by `delta` base units,
 * with the ledger row pushed and saved. Throws when the guard refuses.
 */
async function moveItem({ session, rawItemId, variantId, delta, tx }) {
  const debit = delta < 0;
  const abs = r4(Math.abs(delta));
  const guard = debit ? { quantity: { $gte: abs - 1e-6 } } : {};
  const variantGuard = variantId
    ? { variants: { $elemMatch: { _id: variantId, ...(debit ? { quantity: { $gte: abs - 1e-6 } } : {}) } } }
    : {};
  const update = { $inc: { quantity: delta } };
  const opts = { new: true, session };
  if (variantId) { update.$inc["variants.$[v].quantity"] = delta; opts.arrayFilters = [{ "v._id": variantId }]; }
  const updated = await RawItem.findOneAndUpdate({ _id: rawItemId, ...guard, ...variantGuard }, update, opts);
  if (!updated) {
    const err = new Error(debit
      ? "The Store's balance for this raw item (or its variant) no longer covers the defective quantity — it may already have been issued."
      : "The raw item (or variant) the earlier debit was taken from was not found.");
    err.code = debit ? "INSUFFICIENT_STOCK" : "ITEM_NOT_FOUND";
    throw err;
  }
  const newTotal = r4(updated.quantity);
  const prevTotal = r4(newTotal - delta);
  const v = variantId ? (updated.variants || []).find((x) => String(x._id) === String(variantId)) : null;
  const variantNew = v ? r4(v.quantity) : null;
  const variantPrev = v ? r4(variantNew - delta) : null;
  updated.status = statusOf(newTotal, updated.minStock);
  if (v) v.status = statusOf(variantNew, v.minStock || updated.minStock);
  const now = new Date();
  updated.stockTransactions.push({
    ...tx,
    type: debit ? (variantId ? "VARIANT_REDUCE" : "REDUCE") : (variantId ? "VARIANT_ADD" : "ADD"),
    quantity: abs,
    previousQuantity: prevTotal, newQuantity: newTotal,
    ...(variantId ? {
      variantId, variantCombination: v?.combination || tx.variantCombination || [],
      variantPreviousQuantity: variantPrev, variantNewQuantity: variantNew,
    } : {}),
    createdAt: now, updatedAt: now,
  });
  await updated.save({ session });
  const saved = updated.stockTransactions[updated.stockTransactions.length - 1];
  return { item: updated, txnId: saved._id, prevTotal, newTotal, variantPrev, variantNew };
}

/** The label's figure moves with the stock; a debit is guarded at zero. */
async function moveLabel({ session, barcodeId, delta }) {
  const abs = r4(Math.abs(delta));
  const guard = delta < 0 ? { quantity: { $gte: abs - 1e-6 } } : {};
  const moved = await Barcode.findOneAndUpdate({ _id: barcodeId, ...guard }, { $inc: { quantity: delta } }, { new: true, session });
  if (!moved) {
    const err = new Error("The label's own quantity no longer covers the defective quantity — it may already have been issued off it.");
    err.code = "EXCEEDS_LABEL";
    throw err;
  }
  return { before: r4(moved.quantity - delta), after: r4(moved.quantity) };
}

/** Where the label sits, if anywhere: the first shelf holding it, with what it holds there. */
async function shelfOfLabel(companyId, barcode) {
  if (!isOid(companyId)) return null;
  try {
    const { balances } = await storeLoc.markingBalances(companyId, barcode._id);
    const b = (balances || []).find((x) => x.onHand > 0);
    if (!b) return null;
    const wh = await Warehouse.findById(b.warehouseId).lean();
    const loc = wh ? locStock.findLocation(wh, b.locationId) : null;
    if (!wh || !loc) return null;
    return { warehouse: wh, location: loc, onHand: r4(b.onHand) };
  } catch (err) {
    console.warn("[qc defect stock] shelf lookup failed:", err.message);
    return null;
  }
}

const actorOf = (actor) => ({
  performedBy: isOid(actor?.id) ? actor.id : null,
  performedByName: actor?.name || actor?.email || "QC",
});

/**
 * Apply the debit for a defective verdict. Never throws for a Store-side
 * refusal — the returned block says whether stock moved.
 * @returns the `stockDebit` block to store on the inspection.
 */
async function applyDefectDebit({ session = null, inspection, barcode, actor, labelQuantity, labelUnit }) {
  const at = new Date();
  const base = { applied: false, at, quantity: r4(labelQuantity), unit: labelUnit || "" };
  const refuse = (err) => ({ ...base, error: err.message, errorCode: err.code || "DEBIT_FAILED" });
  try {
    if (!(labelQuantity > 0)) return { ...base, error: "No defective quantity to take off the stock.", errorCode: "NO_QUANTITY" };
    const q = RawItem.findById(barcode.rawItem).select(ITEM_SELECT);
    const item = await (session ? q.session(session) : q);
    if (!item) return { ...base, error: "The raw item behind this label is not on record (it may be in the trash).", errorCode: "ITEM_NOT_FOUND" };
    const hasVariant = barcode.variantId && (item.variants || []).some((v) => String(v._id) === String(barcode.variantId));
    if (barcode.variantId && !hasVariant) return { ...base, error: "The label's variant is no longer on the raw item, so its stock could not be reduced.", errorCode: "VARIANT_NOT_FOUND" };
    const variantId = hasVariant ? barcode.variantId : null;
    const conv = await toBaseQuantity({ quantity: labelQuantity, labelUnit, item, session });

    const companyId = barcode.companyId || item.companyId || null;
    const shelf = await shelfOfLabel(companyId, barcode);
    const shelfQty = shelf ? r4(Math.min(conv.quantity, shelf.onHand)) : 0;

    const notes = [
      `MO: ${inspection.moNumber || "—"}`,
      inspection.goodsReceiptNumber ? `GRN: ${inspection.goodsReceiptNumber}` : "",
      `Label: ${String(barcode._id)}`,
      (inspection.defects || []).length ? `Defects: ${inspection.defects.map((d) => d.code).join(", ")}` : "",
      conv.converted ? conv.note : "",
      `QC record: ${String(inspection._id)}`,
    ].filter(Boolean).join(" | ");

    /* 1. the label (guarded) */
    const label = await moveLabel({ session, barcodeId: barcode._id, delta: -r4(labelQuantity) });

    /* 2. the item + variant (guarded); on refusal put the label straight back */
    let moved;
    try {
      moved = await moveItem({
        session, rawItemId: item._id, variantId, delta: -conv.quantity,
        tx: {
          reason: REASON_DEBIT, notes, ...actorOf(actor),
          variantCombination: barcode.variantCombination || [],
          ...(shelfQty > 0 ? locStock.txLocationSnapshot(shelf.warehouse, shelf.location) : {}),
        },
      });
    } catch (err) {
      await Barcode.updateOne({ _id: barcode._id }, { $inc: { quantity: r4(labelQuantity) } }, { session });
      throw err;
    }

    /* 3. the shelf, best effort */
    let location = null;
    if (shelfQty > 0) {
      try {
        const locVariant = await locStock.locationVariantFor(session, companyId, item, variantId, shelf.warehouse._id, shelf.location._id);
        const out = await locStock.applyLocationOut(session, {
          companyId, siteId: null, item, variantId: locVariant,
          warehouse: shelf.warehouse, location: shelf.location, quantity: shelfQty,
          actor: { id: actor?.id, name: actor?.name || actor?.email || "QC" },
          type: "issue", note: `${REASON_DEBIT} · ${inspection.moNumber || ""}`.trim(),
          source: { kind: "qc_raw_item_inspection", id: inspection._id, reference: String(inspection._id) },
          idempotencyKey: `qc-defect:${String(inspection._id)}`,
          barcodeId: barcode._id, barcodeLabel: `${barcode.quantity} ${barcode.unit}`,
        });
        if (out.ok) location = { warehouseId: shelf.warehouse._id, locationId: shelf.location._id, locationCode: shelf.location.code || "", quantity: shelfQty, movementId: out.movement?._id || null };
        else console.warn("[qc defect stock] shelf debit refused:", out.reason);
      } catch (err) { console.warn("[qc defect stock] shelf debit failed:", err.message); }
    }

    return {
      applied: true, at,
      quantity: r4(labelQuantity), unit: labelUnit || "",
      baseQuantity: conv.quantity, baseUnit: conv.unit,
      rawItemId: item._id, variantId,
      transactionId: moved.txnId,
      previousQuantity: moved.prevTotal, newQuantity: moved.newTotal,
      variantPreviousQuantity: moved.variantPrev, variantNewQuantity: moved.variantNew,
      labelBefore: label.before, labelAfter: label.after,
      location, error: "", errorCode: "",
    };
  } catch (err) {
    console.warn("[qc defect stock] debit not applied:", err.message);
    return refuse(err);
  }
}

/**
 * Put an earlier debit back: the verdict it belonged to is being replaced.
 * THROWS when the credit cannot be written — a re-check must not leave the
 * old debit standing beside a new one.
 * @returns the reversal fields, or null when nothing had been applied.
 */
async function reverseDefectDebit({ session = null, prior, actor, replacedById }) {
  const d = prior.stockDebit;
  if (!d || !d.applied || d.reversedAt) return null;
  const q = RawItem.findById(d.rawItemId || prior.rawItemId).select(ITEM_SELECT);
  const item = await (session ? q.session(session) : q);
  if (!item) { const e = new Error("The raw item the earlier debit was taken from is not on record, so it could not be put back."); e.code = "ITEM_NOT_FOUND"; throw e; }
  const variantId = d.variantId && (item.variants || []).some((v) => String(v._id) === String(d.variantId)) ? d.variantId : null;
  const moved = await moveItem({
    session, rawItemId: item._id, variantId, delta: r4(d.baseQuantity),
    tx: {
      reason: REASON_CREDIT, ...actorOf(actor),
      notes: `MO: ${prior.moNumber || "—"} | Label: ${String(prior.barcodeId)} | Re-check replaced QC record ${String(prior._id)} by ${String(replacedById)} | Reverses stock transaction ${String(d.transactionId)}`,
      ...(d.location?.quantity > 0 ? { warehouseId: d.location.warehouseId, locationId: d.location.locationId, locationCode: d.location.locationCode || "" } : {}),
    },
  });
  await Barcode.updateOne({ _id: prior.barcodeId }, { $inc: { quantity: r4(d.quantity) } }, { session });
  if (d.location?.quantity > 0 && d.location.warehouseId) {
    try {
      const wh = await Warehouse.findById(d.location.warehouseId).lean();
      const loc = wh ? locStock.findLocation(wh, d.location.locationId) : null;
      const companyId = item.companyId || wh?.companyId || null;
      if (wh && loc && isOid(companyId)) {
        const locVariant = await locStock.locationVariantFor(session, companyId, item, variantId, wh._id, loc._id);
        await locStock.applyLocationIn(session, {
          companyId, siteId: null, item, variantId: locVariant,
          warehouse: wh, location: loc, quantity: r4(d.location.quantity),
          actor: { id: actor?.id, name: actor?.name || actor?.email || "QC" },
          type: "adjustment", intent: "receive", note: `${REASON_CREDIT} · ${prior.moNumber || ""}`.trim(),
          source: { kind: "qc_raw_item_inspection", id: prior._id, reference: String(prior._id) },
          idempotencyKey: `qc-defect-reverse:${String(prior._id)}`,
          barcodeId: prior.barcodeId, barcodeLabel: "",
        });
      }
    } catch (err) { console.warn("[qc defect stock] shelf credit failed:", err.message); }
  }
  return { reversedAt: new Date(), reversalTransactionId: moved.txnId, reversedById: replacedById };
}

module.exports = { applyDefectDebit, reverseDefectDebit, REASON_DEBIT, REASON_CREDIT };
