// services/inventory/labelQuantityStock.service.js
//
// A LABEL'S CORRECTED FIGURE MOVES THE STOCK IN HAND  (12 Oct 2026, owner)
//
// Inventory › Label quantity overwrites what a raw-item label says. The owner
// asked that the same change reach the material's in-hand quantity — "upon
// doing the edit of the raw item barcode, the corresponding qty also needs to
// reduce from the inventory in-hand qty" — behind a checkbox that is ticked by
// default. The reasoning: a label stands for a roll or a pack; if it is
// corrected from 25 to 20 metres the person measured 20, so the five metres
// do not exist and an in-hand figure still counting them is wrong.
//
// So a label edit with `adjustStock` posts ONE stock movement for the same
// delta, written the way the Store's own issue and the QC defect debit write
// one (services/manufacturing/qcDefectStock.service.js — whose `moveItem`,
// `toBaseQuantity` and `shelfOfLabel` are reused here, so the arithmetic, the
// guards and the ledger row are the same code):
//
//   · RawItem.quantity and the variant's quantity move by the delta in the
//     item's registered unit, ONE guarded atomic update — a debit the balance
//     no longer covers is refused, never taken negative;
//   · a row is pushed onto RawItem.stockTransactions[] — VARIANT_REDUCE /
//     REDUCE for a decrease, VARIANT_ADD / ADD for an increase — with reason
//     "Label quantity corrected" and the label id, the from → to figures and
//     the typed reason in `notes`, so Stock movements, the ledger routes and
//     the valuation read it like any adjustment;
//   · if the label sits on a shelf (a LocationMovement balance under this
//     sticker) the shelf's balance moves too — a decrease up to what it holds
//     there, an increase onto the same shelf — best effort, as the QC debit
//     does: a refused shelf movement leaves the stock movement standing.
//
// ONLY A LABEL THAT IS STOCK MOVES STOCK. A label inside an unrecorded
// receiving count (RESERVED / PRINTED / APPLIED) names goods the receipt has
// not booked yet; its figure is corrected but nothing moves, and the answer
// says so (`skipped`, NOT_STOCK). Voided and customer-owned labels never
// reach here — the route refuses them first.
//
// The label's own figure is written by the route BEFORE this runs; when the
// stock cannot move (balance short, item in the trash, no unit conversion)
// the label keeps its corrected figure — the sticker's truth does not depend
// on the ledger — and the failure is returned, written on the edit and said
// in the response. `applyLabelQuantityDelta` therefore RETURNS a block rather
// than throwing.
"use strict";

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const locStock = require("../storePurchase/locationStock.service");
const { moveItem, toBaseQuantity, shelfOfLabel, ITEM_SELECT } = require("../manufacturing/qcDefectStock.service");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();
const REASON = "Label quantity corrected";
const STOCK_STATES = new Set(["", "ACTIVATED"]);

/** Does this label stand for stock the company holds right now? */
function labelIsStock(b) {
  if (!b) return false;
  if (b.voidedAt || str(b.identityState).toUpperCase() === "VOIDED") return false;
  if (b.customerMaterial?.lotId) return false;
  return STOCK_STATES.has(str(b.identityState).toUpperCase());
}

/** Why a label's edit moves no stock, or "" when it does. */
function notStockReason(b) {
  if (labelIsStock(b)) return "";
  if (b?.voidedAt || str(b?.identityState).toUpperCase() === "VOIDED") return "This label was voided; it stands for no stock.";
  if (b?.customerMaterial?.lotId) return "This label is customer-owned material; the company's stock does not carry it.";
  return "This label is inside a receiving count that has not been recorded yet, so its goods are not in stock. The label's figure is corrected; stock moves when the receipt is recorded.";
}

const actorOf = (actor) => ({
  performedBy: actor?.id && /^[0-9a-f]{24}$/i.test(String(actor.id)) ? actor.id : null,
  performedByName: actor?.name || actor?.email || "Store",
});

/**
 * Move the material's in-hand quantity by (to − from) in the label's unit.
 * Never throws for a Store-side refusal — the block says whether stock moved.
 * @returns {{ applied:boolean, skipped?:boolean, error?:string, errorCode?:string, ... }}
 */
async function applyLabelQuantityDelta({ session = null, barcode, from, to, actor, reason = "", editAt = new Date() }) {
  const delta = r4(Number(to) - Number(from));
  const base = { applied: false, at: editAt, delta, unit: barcode?.unit || "" };
  const refuse = (err) => ({ ...base, error: err.message, errorCode: err.code || "STOCK_MOVE_FAILED" });
  try {
    if (!Number.isFinite(delta) || delta === 0) return { ...base, skipped: true, error: "The label's figure did not change.", errorCode: "NO_CHANGE" };
    if (!labelIsStock(barcode)) return { ...base, skipped: true, error: notStockReason(barcode), errorCode: "NOT_STOCK" };

    const q = RawItem.findById(barcode.rawItem).select(ITEM_SELECT);
    const item = await (session ? q.session(session) : q);
    if (!item) return { ...base, error: "The raw item behind this label is not on record (it may be in the trash), so its stock could not be moved.", errorCode: "ITEM_NOT_FOUND" };
    const hasVariant = barcode.variantId && (item.variants || []).some((v) => String(v._id) === String(barcode.variantId));
    if (barcode.variantId && !hasVariant) return { ...base, error: "The label's variant is no longer on the raw item, so its stock could not be moved.", errorCode: "VARIANT_NOT_FOUND" };
    const variantId = hasVariant ? barcode.variantId : null;

    const conv = await toBaseQuantity({ quantity: Math.abs(delta), labelUnit: barcode.unit, item, session });
    const baseDelta = r4(Math.sign(delta) * conv.quantity);

    const companyId = barcode.companyId || item.companyId || null;
    const shelf = await shelfOfLabel(companyId, barcode);
    const shelfQty = shelf ? (delta < 0 ? r4(Math.min(conv.quantity, shelf.onHand)) : conv.quantity) : 0;

    const notes = [
      `Label: ${String(barcode._id)}`,
      `${r4(from)} → ${r4(to)} ${barcode.unit || ""}`.trim(),
      reason ? `Reason: ${reason}` : "",
      conv.converted ? conv.note : "",
      "Inventory › Label quantity",
    ].filter(Boolean).join(" | ");

    const moved = await moveItem({
      session, rawItemId: item._id, variantId, delta: baseDelta,
      tx: {
        reason: REASON, notes, ...actorOf(actor),
        variantCombination: barcode.variantCombination || [],
        ...(shelfQty > 0 ? locStock.txLocationSnapshot(shelf.warehouse, shelf.location) : {}),
      },
    });

    /* the shelf, best effort */
    let location = null;
    if (shelfQty > 0) {
      try {
        const locVariant = await locStock.locationVariantFor(session, companyId, item, variantId, shelf.warehouse._id, shelf.location._id);
        const common = {
          companyId, siteId: null, item, variantId: locVariant,
          warehouse: shelf.warehouse, location: shelf.location, quantity: shelfQty,
          actor: { id: actor?.id, name: actor?.name || actor?.email || "Store" },
          note: `${REASON}${reason ? ` · ${reason}` : ""}`,
          source: { kind: "label_quantity_edit", id: barcode._id, reference: String(barcode._id) },
          idempotencyKey: `label-qty:${String(barcode._id)}:${new Date(editAt).getTime()}`,
          barcodeId: barcode._id, barcodeLabel: `${r4(to)} ${barcode.unit || ""}`.trim(),
        };
        const out = delta < 0
          ? await locStock.applyLocationOut(session, { ...common, type: "adjustment" })
          : await locStock.applyLocationIn(session, { ...common, type: "adjustment", intent: "receive" });
        if (out?.ok) location = { warehouseId: shelf.warehouse._id, locationId: shelf.location._id, locationCode: shelf.location.code || "", quantity: shelfQty, movementId: out.movement?._id || null };
        else console.warn("[label quantity stock] shelf movement refused:", out?.reason);
      } catch (err) { console.warn("[label quantity stock] shelf movement failed:", err.message); }
    }

    return {
      applied: true, at: editAt, delta, unit: barcode.unit || "",
      baseDelta, baseUnit: conv.unit,
      rawItemId: item._id, variantId,
      transactionId: moved.txnId,
      previousQuantity: moved.prevTotal, newQuantity: moved.newTotal,
      variantPreviousQuantity: moved.variantPrev, variantNewQuantity: moved.variantNew,
      location, error: "", errorCode: "",
    };
  } catch (err) {
    if (err?.code === "INSUFFICIENT_STOCK") err.message = "The Store's balance for this raw item (or its variant) does not cover the reduction — the stock may already have been issued. The label's figure was changed; the stock was not.";
    console.warn("[label quantity stock] not applied:", err.message);
    return refuse(err);
  }
}

/* ── THE LABEL'S VARIANT CORRECTED (16 Oct 2026, owner: "I just want to change
   the product variant and the number") ────────────────────────────────────
   A sticker printed for the wrong variant (Navy Blue for Black) is moved to a
   variant ALREADY REGISTERED on the same raw item. With the stock box ticked
   the goods follow the label: the label's OLD figure leaves the OLD variant
   and its NEW figure lands on the NEW one — two ordinary stock rows, so the
   item total moves by (to − from) and each variant by what it gained or lost.
   The debit goes first and is guarded; if the credit then fails the debit is
   put back, so a variant is never left short. The shelf the sticker sits on
   follows the same way, best effort. Never throws — the block says what
   happened, exactly like applyLabelQuantityDelta. */
async function applyLabelVariantMove({ session = null, barcode, newVariant, from, to, actor, reason = "", editAt = new Date() }) {
  const base = { applied: false, at: editAt, kind: "variant", delta: r4(Number(to) - Number(from)), unit: barcode?.unit || "" };
  const refuse = (err) => ({ ...base, error: err.message, errorCode: err.code || "STOCK_MOVE_FAILED" });
  try {
    if (!labelIsStock(barcode)) return { ...base, skipped: true, error: notStockReason(barcode), errorCode: "NOT_STOCK" };
    const q = RawItem.findById(barcode.rawItem).select(ITEM_SELECT);
    const item = await (session ? q.session(session) : q);
    if (!item) return { ...base, error: "The raw item behind this label is not on record (it may be in the trash), so its stock could not be moved.", errorCode: "ITEM_NOT_FOUND" };
    const oldId = barcode.variantId && (item.variants || []).some((v) => String(v._id) === String(barcode.variantId)) ? barcode.variantId : null;
    if (barcode.variantId && !oldId) return { ...base, error: "The label's old variant is no longer on the raw item, so its stock could not be moved.", errorCode: "VARIANT_NOT_FOUND" };
    const newId = newVariant._id;

    const outQ = await toBaseQuantity({ quantity: Math.abs(Number(from)), labelUnit: barcode.unit, item, session });
    const inQ = await toBaseQuantity({ quantity: Math.abs(Number(to)), labelUnit: barcode.unit, item, session });
    const oldName = (barcode.variantCombination || []).join(" · ") || "no variant";
    const newName = (newVariant.combination || []).join(" · ");
    const notes = (dir) => [
      `Label: ${String(barcode._id)}`,
      `Variant ${oldName} → ${newName}`,
      `${r4(from)} → ${r4(to)} ${barcode.unit || ""}`.trim(),
      reason ? `Reason: ${reason}` : "",
      dir,
      "Inventory › Label quantity",
    ].filter(Boolean).join(" | ");
    const tx = (combination, dir) => ({ reason: REASON, notes: notes(dir), ...actorOf(actor), variantCombination: combination || [] });

    const out = await moveItem({ session, rawItemId: item._id, variantId: oldId, delta: -outQ.quantity, tx: tx(barcode.variantCombination, "off the old variant") });
    let inn;
    try {
      inn = await moveItem({ session, rawItemId: item._id, variantId: newId, delta: inQ.quantity, tx: tx(newVariant.combination, "onto the new variant") });
    } catch (err) {
      await moveItem({ session, rawItemId: item._id, variantId: oldId, delta: outQ.quantity, tx: tx(barcode.variantCombination, "put back — the new variant could not take it") }).catch(() => {});
      throw err;
    }

    /* the shelf, best effort: off under the old variant, on under the new */
    let location = null;
    const companyId = barcode.companyId || item.companyId || null;
    const shelf = await shelfOfLabel(companyId, barcode);
    if (shelf) {
      try {
        const common = {
          companyId, siteId: null, item, warehouse: shelf.warehouse, location: shelf.location,
          actor: { id: actor?.id, name: actor?.name || actor?.email || "Store" },
          note: `${REASON} · variant ${oldName} → ${newName}${reason ? ` · ${reason}` : ""}`,
          source: { kind: "label_quantity_edit", id: barcode._id, reference: String(barcode._id) },
          barcodeId: barcode._id, barcodeLabel: `${r4(to)} ${barcode.unit || ""}`.trim(),
          type: "adjustment",
        };
        const outVar = await locStock.locationVariantFor(session, companyId, item, oldId, shelf.warehouse._id, shelf.location._id);
        const off = await locStock.applyLocationOut(session, { ...common, variantId: outVar, quantity: r4(Math.min(outQ.quantity, shelf.onHand)), idempotencyKey: `label-var-out:${String(barcode._id)}:${new Date(editAt).getTime()}` });
        if (off?.ok) {
          const inVar = await locStock.locationVariantFor(session, companyId, item, newId, shelf.warehouse._id, shelf.location._id);
          const on = await locStock.applyLocationIn(session, { ...common, variantId: inVar, quantity: inQ.quantity, intent: "receive", idempotencyKey: `label-var-in:${String(barcode._id)}:${new Date(editAt).getTime()}` });
          if (on?.ok) location = { warehouseId: shelf.warehouse._id, locationId: shelf.location._id, locationCode: shelf.location.code || "" };
          else console.warn("[label variant stock] shelf movement in refused:", on?.reason);
        } else console.warn("[label variant stock] shelf movement out refused:", off?.reason);
      } catch (err) { console.warn("[label variant stock] shelf movement failed:", err.message); }
    }

    return {
      applied: true, kind: "variant", at: editAt, delta: base.delta, unit: barcode.unit || "",
      baseDelta: r4(inQ.quantity - outQ.quantity), baseUnit: inQ.unit,
      rawItemId: item._id,
      fromVariant: { variantId: oldId, combination: barcode.variantCombination || [], out: outQ.quantity, newQuantity: out.variantNew },
      toVariant: { variantId: newId, combination: newVariant.combination || [], in: inQ.quantity, newQuantity: inn.variantNew },
      previousQuantity: out.prevTotal, newQuantity: inn.newTotal,
      transactionIds: [out.txnId, inn.txnId],
      location, error: "", errorCode: "",
    };
  } catch (err) {
    if (err?.code === "INSUFFICIENT_STOCK") err.message = "The old variant's balance does not cover the label's figure — the stock may already have been issued. The label's variant was changed; the stock was not.";
    console.warn("[label variant stock] not applied:", err.message);
    return refuse(err);
  }
}

module.exports = { applyLabelQuantityDelta, applyLabelVariantMove, labelIsStock, notStockReason, REASON };
