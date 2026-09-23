// services/storePurchase/goodsReceiptControl.service.js
//
// GOODS RECEIPT — INSPECTION, QUARANTINE & PUT-AWAY (V1)
//
// The controlled stages AFTER a numbered GoodsReceipt proves arrival:
//   Recorded — awaiting inspection
//   Inspected — accepted quantity awaiting put-away
//   Quarantined / Rejected — awaiting supplier return
//   Put away
//
// It NEVER creates a second stock authority: quarantine, rejection and put-away
// are internal location transfers through the SAME LocationBalance /
// LocationMovement machinery, in one unit of work. Company-wide on-hand
// (RawItem) is never changed by inspection or put-away — only WHERE stock sits.
// It never calls Receiving or Quarantine stock "available".

"use strict";

const mongoose = require("mongoose");
const locStock = require("./locationStock.service");
const tenantContext = require("./tenantContext.service");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const GoodsReceiptPutawayPosition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutawayPosition");
const GoodsReceiptDisposition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
// The canonical supplier-return stock mutation — reused, never reproduced.
const supplierReturn = require("./supplierReturn.service");
const { fail } = require("./errors");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const TOL = 0.0001;
const num = (v) => (typeof v === "number" && Number.isFinite(v));

// FAIL-CLOSED unit conversion factor (base per received unit). Same unit → 1;
// a differing unit demands finite, positive stored evidence. Missing / zero /
// negative / non-finite evidence refuses BEFORE any write.
function resolveFactor(poUnit, baseUnit, storedFactor, itemName, goodsReceiptLineId) {
  const same = String(poUnit || "") === String(baseUnit || "");
  if (same) return 1;
  const f = Number(storedFactor);
  if (!Number.isFinite(f) || f <= 0) {
    throw fail("VALIDATION",
      `No valid unit conversion is recorded for "${itemName}" (received ${poUnit || "?"}, stored in ${baseUnit || "?"}), so it cannot be inspected.`,
      { reason: "UOM_CONVERSION_MISSING", goodsReceiptLineId, poUnit: poUnit || "", baseUnit: baseUnit || "" });
  }
  return f;
}

// ── STAGES ───────────────────────────────────────────────────────────────────
// Precedence keeps the most urgent unresolved exception in the headline. A
// receipt is "Complete" only when quarantine decisions, supplier returns and
// put-away are ALL finished. Register FILTERS use the independent flags below,
// so a mixed receipt matches every operational state it genuinely contains.
const STAGE = Object.freeze({
  AWAITING_INSPECTION: "Awaiting inspection",
  QUARANTINE_DECISION: "Quarantine decision required",
  SUPPLIER_RETURN: "Supplier return required",
  AWAITING_PUTAWAY: "Awaiting put-away",
  COMPLETE: "Complete",
});

// Σ a numeric field per goodsReceiptLineId across a set of records.
function sumByLine(records, qtyOf) {
  const m = new Map();
  for (const rec of (records || [])) {
    const k = String(rec.goodsReceiptLineId);
    m.set(k, r4((m.get(k) || 0) + (Number(qtyOf(rec)) || 0)));
  }
  return m;
}

/**
 * Build the control view for one receipt (pure). Reconciles each line — WITHOUT
 * mutating any stored document — from the immutable inspection, the recorded
 * put-aways, the quarantine dispositions, and the supplier returns/replacements
 * this receipt originated. Derives the headline stage, register flags/counts,
 * valid actions and actionable blockers.
 *
 * @param {object}   goodsReceipt  lean GRN (lines[])
 * @param {object?}  inspection    the one inspection, if recorded
 * @param {object[]} putaways      put-away records for this GRN
 * @param {object}   ctx           { receivingLocationActive, usableAvailable, quarantineAvailable, returnsAvailable }
 * @param {object}   extras        { dispositions[], supplierReturns[] } — supplierReturns are
 *                                 PO returnRequests whose provenance is THIS receipt, each with
 *                                 { goodsReceiptLineId, damagedQuantity, receipts[] } for replacements.
 */
function deriveControl(goodsReceipt, inspection = null, putaways = [], ctx = {}, extras = {}) {
  const grLines = Array.isArray(goodsReceipt.lines) ? goodsReceipt.lines : [];
  const dispositions = extras.dispositions || [];
  const supplierReturns = extras.supplierReturns || [];

  const inspByLine = new Map();
  for (const il of (inspection?.lines || [])) inspByLine.set(String(il.goodsReceiptLineId), il);
  const putawayByLine = sumByLine(putaways, (p) => p.quantity);
  const releasedByLine = sumByLine(dispositions.filter((d) => d.dispositionType === "RELEASE"), (d) => d.quantity);
  const rejectedDispByLine = sumByLine(dispositions.filter((d) => d.dispositionType === "REJECT"), (d) => d.quantity);
  const returnedByLine = sumByLine(supplierReturns, (r) => r.damagedQuantity);
  // Replacement received counts only where a receipt actually proves it arrived.
  const replacementByLine = new Map();
  for (const r of supplierReturns) {
    const k = String(r.goodsReceiptLineId);
    const got = (r.receipts || []).reduce((s, rc) => s + (Number(rc.quantityReceived) || 0), 0);
    if (got) replacementByLine.set(k, r4((replacementByLine.get(k) || 0) + got));
  }

  const lines = grLines.map((l) => {
    const id = String(l._id);
    const il = inspByLine.get(id) || null;
    const received = r4(l.receivedQuantity);
    const initiallyAccepted = il ? r4(il.acceptedQuantity) : null;
    const initiallyQuarantined = il ? r4(il.quarantinedQuantity) : null;
    const initiallyRejected = il ? r4(il.rejectedQuantity) : null;

    const quarantineReleased = r4(releasedByLine.get(id) || 0);
    const quarantineRejected = r4(rejectedDispByLine.get(id) || 0);
    const putAway = r4(putawayByLine.get(id) || 0);
    const returnedToSupplier = r4(returnedByLine.get(id) || 0);
    const replacementReceived = r4(replacementByLine.get(id) || 0);

    // Accepted PUT-AWAY CAPACITY grows when quarantine is released into Receiving.
    const acceptedCapacity = il ? r4(initiallyAccepted + quarantineReleased) : null;
    const remainingToPutAway = il ? r4(Math.max(0, acceptedCapacity - putAway)) : 0;
    // Rejected pool = rejected at inspection + rejected out of quarantine.
    const rejectedTotal = il ? r4(initiallyRejected + quarantineRejected) : 0;
    const rejectedAwaitingReturn = il ? r4(Math.max(0, rejectedTotal - returnedToSupplier)) : 0;
    const unresolvedQuarantine = il ? r4(Math.max(0, initiallyQuarantined - quarantineReleased - quarantineRejected)) : 0;
    // Accepted-not-yet-put-away (incl. released) sits in Receiving before inspection
    // the whole received quantity does.
    const stillInReceiving = il ? remainingToPutAway : received;

    return {
      goodsReceiptLineId: id,
      itemName: l.itemName || "", sku: l.sku || "",
      variantCombination: l.variantCombination || [],
      unit: l.poUnit || "",
      received,
      // Original inspection figures (immutable).
      accepted: initiallyAccepted, quarantined: initiallyQuarantined, rejected: initiallyRejected,
      // Derived resolution figures (never stored on the original documents).
      quarantineReleased, quarantineRejected, unresolvedQuarantine,
      acceptedCapacity, putAway, remainingToPutAway, stillInReceiving,
      rejectedTotal, returnedToSupplier, rejectedAwaitingReturn, replacementReceived,
      note: il?.note || "",
      inspected: Boolean(il),
    };
  });

  const inspected = Boolean(inspection);
  // NO cross-unit totals anywhere: readiness is booleans + per-line counts, and
  // any quantity summary is grouped STRICTLY by normalised unit.
  const hasRemainingToPutAway = inspected && lines.some((x) => x.remainingToPutAway > TOL);
  const hasUnresolvedQuarantine = inspected && lines.some((x) => x.unresolvedQuarantine > TOL);
  const hasRejectedAwaitingReturn = inspected && lines.some((x) => x.rejectedAwaitingReturn > TOL);
  const remainingToPutAwayByUnit = {};
  for (const x of lines) {
    if (x.remainingToPutAway > TOL) remainingToPutAwayByUnit[x.unit || "?"] = r4((remainingToPutAwayByUnit[x.unit || "?"] || 0) + x.remainingToPutAway);
  }

  let stage;
  if (!inspected) stage = STAGE.AWAITING_INSPECTION;
  else if (hasUnresolvedQuarantine) stage = STAGE.QUARANTINE_DECISION;
  else if (hasRejectedAwaitingReturn) stage = STAGE.SUPPLIER_RETURN;
  else if (hasRemainingToPutAway) stage = STAGE.AWAITING_PUTAWAY;
  else stage = STAGE.COMPLETE;

  const flags = {
    awaitingInspection: !inspected && lines.length > 0,
    awaitingPutaway: inspected && hasRemainingToPutAway,
    // Register-filter flags reflect the RESOLVED state, not the original decision:
    // hasQuarantined ⇒ unresolved quarantine remains; hasRejected ⇒ rejected stock
    // still awaits physical supplier return.
    hasQuarantined: hasUnresolvedQuarantine,
    hasRejected: hasRejectedAwaitingReturn,
    // Complete ONLY when quarantine, supplier return AND put-away are all done.
    complete: inspected && !hasUnresolvedQuarantine && !hasRejectedAwaitingReturn && !hasRemainingToPutAway,
  };
  const counts = {
    linesAwaitingInspection: !inspected ? lines.length : 0,
    linesNeedingQuarantineDecision: lines.filter((x) => x.unresolvedQuarantine > TOL).length,
    linesAwaitingSupplierReturn: lines.filter((x) => x.rejectedAwaitingReturn > TOL).length,
    linesNeedingPutaway: lines.filter((x) => x.remainingToPutAway > TOL).length,
  };

  // Actions + honest blockers.
  const blockers = [];
  if (!ctx.receivingLocationActive) {
    blockers.push({ code: "NO_RECEIVING_LOCATION", message: "This receipt has no recorded Receiving location, so its stock movements cannot be posted safely." });
  }
  const canInspect = !inspected && lines.length > 0 && Boolean(ctx.receivingLocationActive);
  const canPutaway = inspected && hasRemainingToPutAway && Boolean(ctx.receivingLocationActive);
  const canDisposition = inspected && hasUnresolvedQuarantine && Boolean(ctx.receivingLocationActive);
  const canSupplierReturn = inspected && hasRejectedAwaitingReturn && Boolean(ctx.receivingLocationActive);
  if (canPutaway && !ctx.usableAvailable) {
    blockers.push({ code: "NO_USABLE_LOCATION", message: "This warehouse has no active usable-stock location to put stock away into." });
  }
  if (canDisposition && !ctx.returnsAvailable) {
    blockers.push({ code: "NO_RETURNS_LOCATION", message: "This warehouse has no active returns location, so quarantine cannot be rejected." });
  }
  if (canSupplierReturn && !ctx.returnsAvailable) {
    blockers.push({ code: "NO_RETURNS_LOCATION", message: "This warehouse has no active returns location holding the rejected stock." });
  }

  return {
    stage, flags, counts, lines,
    hasRemainingToPutAway, remainingToPutAwayByUnit,
    inspected,
    actions: {
      canInspect,
      canPutaway: canPutaway && Boolean(ctx.usableAvailable),
      canDisposition,
      canSupplierReturn,
    },
    blockers,
  };
}

// ── INSPECTION VALIDATION (pure) ─────────────────────────────────────────────
// Every line's accepted + quarantined + rejected must be non-negative and add
// EXACTLY to that line's received quantity, in that line's own unit. Never sums
// across units.
function validateInspection({ goodsReceipt, lines }) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw fail("VALIDATION", "An inspection decision is required for every line.", { reason: "NO_LINES" });
  }
  const grById = new Map((goodsReceipt.lines || []).map((l) => [String(l._id), l]));
  const seen = new Set();
  const plans = [];
  for (const grLineId of grById.keys()) {
    const input = lines.find((x) => String(x.goodsReceiptLineId) === grLineId);
    if (!input) {
      throw fail("VALIDATION", "Every received line must be inspected.", { reason: "LINE_MISSING", goodsReceiptLineId: grLineId });
    }
  }
  for (const input of lines) {
    const grLineId = String(input.goodsReceiptLineId);
    const gl = grById.get(grLineId);
    if (!gl) throw fail("VALIDATION", "A line does not belong to this receipt.", { reason: "UNKNOWN_LINE", goodsReceiptLineId: grLineId });
    if (seen.has(grLineId)) throw fail("VALIDATION", "A line was inspected twice.", { reason: "DUPLICATE_LINE", goodsReceiptLineId: grLineId });
    seen.add(grLineId);

    const accepted = Number(input.acceptedQuantity);
    const quarantined = Number(input.quarantinedQuantity);
    const rejected = Number(input.rejectedQuantity);
    for (const [label, v] of [["accepted", accepted], ["quarantined", quarantined], ["rejected", rejected]]) {
      if (!num(v) || v < 0) {
        throw fail("VALIDATION", `The ${label} quantity for "${gl.itemName}" must be zero or more.`, { reason: "INVALID_QUANTITY", goodsReceiptLineId: grLineId });
      }
    }
    const received = r4(gl.receivedQuantity);
    // Rounded decisions must reconcile EXACTLY to the stored received quantity.
    if (r4(accepted + quarantined + rejected) !== received) {
      throw fail("VALIDATION",
        `Accepted + quarantined + rejected for "${gl.itemName}" must equal the received quantity (${received} ${gl.poUnit || ""}).`,
        { reason: "LINE_DOES_NOT_RECONCILE", goodsReceiptLineId: grLineId, received });
    }
    // FAIL CLOSED on unit conversion. A factor of 1 is allowed only when the
    // received and base units are demonstrably identical; a differing unit needs
    // finite, positive conversion evidence, written before any movement.
    const factor = resolveFactor(gl.poUnit, gl.baseUnit, gl.conversionFactor, gl.itemName, grLineId);
    plans.push({
      goodsReceiptLineId: grLineId, poItemId: gl.poItemId, rawItemId: gl.rawItemId, variantId: gl.variantId,
      variantCombination: gl.variantCombination || [], itemName: gl.itemName || "", sku: gl.sku || "",
      unit: gl.poUnit || "", baseUnit: gl.baseUnit || gl.poUnit || "", conversionFactor: factor,
      received, accepted: r4(accepted), quarantined: r4(quarantined), rejected: r4(rejected),
      quarantinedBase: r4(quarantined * factor), rejectedBase: r4(rejected * factor),
      note: typeof input.note === "string" ? input.note : "",
    });
  }
  return { plans };
}

// A two-leg internal move through the SAME location machinery the transfer route
// uses. Returns the created movement ids. Company on-hand is untouched.
async function internalMove(session, tenant, o) {
  const item = { _id: o.rawItemId, unit: o.baseUnit };
  const common = {
    companyId: tenant.companyId, siteId: tenant.siteId, item, variantId: o.variantId || null,
    transferId: o.transferId, actor: o.actor, note: o.note || "", idempotencyKey: o.idempotencyKey || "",
    source: { kind: o.sourceKind, id: o.sourceId || o.transferId, reference: o.reference || "" },
  };
  const dec = await locStock.decLocationGuardedReturning(session, tenant.companyId, o.rawItemId, o.variantId || null, o.fromWarehouse._id, o.fromLocation._id, o.quantityBase);
  if (!dec.ok) {
    throw fail("VALIDATION", `The Receiving location no longer holds ${o.quantityBase} ${o.baseUnit} of "${o.itemName}".`, { reason: "INSUFFICIENT_AT_RECEIVING", goodsReceiptLineId: o.goodsReceiptLineId });
  }
  await locStock.incLocationReturning(session, tenant.companyId, o.rawItemId, o.variantId || null, o.toWarehouse._id, o.toLocation._id, o.quantityBase);
  const [out, inn] = await LocationMovement.create([
    { ...tenantContext.stamp(tenant), ...locStock.buildMovement({ ...common, warehouse: o.fromWarehouse, location: o.fromLocation, direction: "out", quantity: o.quantityBase, type: "transfer_out" }) },
    { ...tenantContext.stamp(tenant), ...locStock.buildMovement({ ...common, warehouse: o.toWarehouse, location: o.toLocation, direction: "in", quantity: o.quantityBase, type: "transfer_in" }) },
  ], { session, ordered: true });
  return { outId: out._id, inId: inn._id };
}

/**
 * Record the inspection and post quarantine/returns moves atomically.
 * @returns {{ inspection }}
 */
async function applyInspection({ session, tenant, goodsReceipt, warehouse, receivingLocation, quarantineLocation, returnsLocation, plans, actor, idempotencyKey }) {
  const needsQuarantine = plans.some((p) => p.quarantinedBase > TOL);
  const needsReturns = plans.some((p) => p.rejectedBase > TOL);
  if (needsQuarantine && !quarantineLocation) throw fail("VALIDATION", "This warehouse has no active quarantine location for the quarantined stock.", { reason: "NO_QUARANTINE_LOCATION" });
  if (needsReturns && !returnsLocation) throw fail("VALIDATION", "This warehouse has no active returns location for the rejected stock.", { reason: "NO_RETURNS_LOCATION" });

  const inspectionId = new mongoose.Types.ObjectId();
  const inspectionLines = [];
  for (const p of plans) {
    let quarantineOut = null, quarantineIn = null, returnsOut = null, returnsIn = null;
    if (p.quarantinedBase > TOL) {
      const mv = await internalMove(session, tenant, {
        rawItemId: p.rawItemId, variantId: p.variantId, baseUnit: p.baseUnit, itemName: p.itemName,
        fromWarehouse: warehouse, fromLocation: receivingLocation, toWarehouse: warehouse, toLocation: quarantineLocation,
        quantityBase: p.quarantinedBase, transferId: new mongoose.Types.ObjectId(),
        sourceKind: "grn_inspection_quarantine", sourceId: inspectionId, reference: goodsReceipt.receiptNumber,
        actor, note: `Quarantine — GRN ${goodsReceipt.receiptNumber}`, idempotencyKey: `${idempotencyKey}:q:${p.goodsReceiptLineId}`, goodsReceiptLineId: p.goodsReceiptLineId,
      });
      quarantineOut = mv.outId; quarantineIn = mv.inId;
    }
    if (p.rejectedBase > TOL) {
      const mv = await internalMove(session, tenant, {
        rawItemId: p.rawItemId, variantId: p.variantId, baseUnit: p.baseUnit, itemName: p.itemName,
        fromWarehouse: warehouse, fromLocation: receivingLocation, toWarehouse: warehouse, toLocation: returnsLocation,
        quantityBase: p.rejectedBase, transferId: new mongoose.Types.ObjectId(),
        sourceKind: "grn_inspection_reject", sourceId: inspectionId, reference: goodsReceipt.receiptNumber,
        actor, note: `Rejected — GRN ${goodsReceipt.receiptNumber}`, idempotencyKey: `${idempotencyKey}:r:${p.goodsReceiptLineId}`, goodsReceiptLineId: p.goodsReceiptLineId,
      });
      returnsOut = mv.outId; returnsIn = mv.inId;
    }
    inspectionLines.push({
      goodsReceiptLineId: p.goodsReceiptLineId, poItemId: p.poItemId, rawItemId: p.rawItemId, variantId: p.variantId,
      variantCombination: p.variantCombination, itemName: p.itemName, sku: p.sku,
      unit: p.unit, receivedQuantity: p.received, acceptedQuantity: p.accepted, quarantinedQuantity: p.quarantined, rejectedQuantity: p.rejected,
      note: p.note, baseUnit: p.baseUnit, conversionFactor: p.conversionFactor,
      quarantineMovementOutId: quarantineOut, quarantineMovementInId: quarantineIn,
      returnsMovementOutId: returnsOut, returnsMovementInId: returnsIn,
    });
  }

  const [inspection] = await GoodsReceiptInspection.create([{
    _id: inspectionId, companyId: tenant.companyId, siteId: tenant.siteId || null,
    goodsReceiptId: goodsReceipt._id, receiptNumber: goodsReceipt.receiptNumber, purchaseOrderId: goodsReceipt.purchaseOrderId,
    warehouseId: warehouse._id, warehouseName: warehouse.name || "",
    receivingLocationId: receivingLocation._id, receivingLocationCode: receivingLocation.code || "",
    inspectedAt: new Date(), inspectedBy: { id: actor.id || null, name: actor.name || "" },
    note: typeof plans.overallNote === "string" ? plans.overallNote : "",
    idempotencyKey: idempotencyKey || "", lines: inspectionLines,
  }], session ? { session } : {});

  // The per-line operational positions — the atomic guard for put-away AND
  // quarantine disposition AND supplier return. One per line. Rebuildable from
  // the immutable inspection + dispositions + put-aways + supplier returns, so
  // this is a projection, never a stock authority.
  await GoodsReceiptPutawayPosition.create(
    plans.map((p) => ({
      companyId: tenant.companyId, goodsReceiptId: goodsReceipt._id, goodsReceiptLineId: p.goodsReceiptLineId, inspectionId, unit: p.unit,
      accepted: p.accepted, posted: 0,
      quarantined: p.quarantined, quarantineResolved: 0,
      rejected: p.rejected, returned: 0,
    })),
    session ? { session, ordered: true } : { ordered: true },
  );

  return { inspection };
}

/**
 * Put away accepted stock (Receiving → Usable Stock), partial or full.
 * @returns {{ putaway }}
 */
async function applyPutaway({ session, tenant, goodsReceipt, inspection, controlLine, warehouse, receivingLocation, usableLocation, quantity, actor, idempotencyKey, note }) {
  const factor = resolveFactor(controlLine.unit, controlLine.baseUnit, controlLine.conversionFactor, controlLine.itemName, controlLine.goodsReceiptLineId);
  const requested = r4(quantity);

  // ── ATOMIC over-put-away guard ──────────────────────────────────────────────
  // A single-document guarded increment: it moves `posted` up by `requested`
  // ONLY if that keeps posted ≤ accepted. Two concurrent put-aways serialise
  // here — the one that no longer fits matches nothing and is refused BEFORE any
  // location movement. In the transaction, this increment rolls back on failure.
  const reserved = await GoodsReceiptPutawayPosition.findOneAndUpdate(
    { companyId: tenant.companyId, goodsReceiptLineId: controlLine.goodsReceiptLineId, $expr: { $lte: [{ $add: ["$posted", requested] }, { $add: ["$accepted", TOL] }] } },
    { $inc: { posted: requested } },
    { new: true, ...(session ? { session } : {}) },
  );
  if (!reserved) {
    throw fail("VALIDATION", `That put-away would exceed the accepted quantity for "${controlLine.itemName}".`, { reason: "OVER_PUTAWAY", goodsReceiptLineId: controlLine.goodsReceiptLineId });
  }

  const quantityBase = r4(quantity * factor);
  const transferId = new mongoose.Types.ObjectId();
  const mv = await internalMove(session, tenant, {
    rawItemId: controlLine.rawItemId, variantId: controlLine.variantId, baseUnit: controlLine.baseUnit, itemName: controlLine.itemName,
    fromWarehouse: warehouse, fromLocation: receivingLocation, toWarehouse: warehouse, toLocation: usableLocation,
    quantityBase, transferId, sourceKind: "grn_putaway", sourceId: goodsReceipt._id, reference: goodsReceipt.receiptNumber,
    actor, note: note || `Put away — GRN ${goodsReceipt.receiptNumber}`, idempotencyKey: idempotencyKey || "", goodsReceiptLineId: controlLine.goodsReceiptLineId,
  });
  const [putaway] = await GoodsReceiptPutaway.create([{
    companyId: tenant.companyId, siteId: tenant.siteId || null,
    goodsReceiptId: goodsReceipt._id, inspectionId: inspection._id, goodsReceiptLineId: controlLine.goodsReceiptLineId, receiptNumber: goodsReceipt.receiptNumber,
    poItemId: controlLine.poItemId, rawItemId: controlLine.rawItemId, variantId: controlLine.variantId, itemName: controlLine.itemName, sku: controlLine.sku,
    warehouseId: warehouse._id, fromLocationId: receivingLocation._id, fromLocationCode: receivingLocation.code || "",
    toLocationId: usableLocation._id, toLocationCode: usableLocation.code || "", toLocationName: usableLocation.name || "",
    quantity: r4(quantity), unit: controlLine.unit, baseQuantity: quantityBase, baseUnit: controlLine.baseUnit,
    transferId, movementOutId: mv.outId, movementInId: mv.inId,
    actor: { id: actor.id || null, name: actor.name || "" }, at: new Date(), note: note || "", idempotencyKey: idempotencyKey || "",
  }], session ? { session } : {});
  return { putaway };
}

/**
 * Resolve a quarantined quantity: RELEASE it back to Receiving (it becomes
 * accepted stock awaiting ordinary put-away) or REJECT it to Returns (it becomes
 * rejected stock awaiting supplier return). Partial and repeated dispositions are
 * allowed, but a single atomic guarded increment refuses one that would resolve
 * more than the line's quarantined quantity. Releasing raises the line's accepted
 * put-away capacity, rejecting raises its returnable pool — both in the SAME
 * atomic increment as the guard, and rolled back with the move on any failure.
 * The original inspection is never edited.
 * @returns {{ disposition }}
 */
async function applyDisposition({ session, tenant, goodsReceipt, inspection, controlLine, dispositionType, warehouse, quarantineLocation, toLocation, quantity, reason, note, evidenceRef, actor, idempotencyKey }) {
  const factor = resolveFactor(controlLine.unit, controlLine.baseUnit, controlLine.conversionFactor, controlLine.itemName, controlLine.goodsReceiptLineId);
  const requested = r4(quantity);

  // ── ATOMIC quarantine-remainder guard + capacity increase ────────────────────
  // Reserve against the quarantined quantity and, in the same document write,
  // raise the capacity the resolution creates (accepted for RELEASE, rejected for
  // REJECT). Two concurrent dispositions serialise here; the one that no longer
  // fits matches nothing and is refused BEFORE any location movement.
  const inc = dispositionType === "RELEASE"
    ? { quarantineResolved: requested, accepted: requested }
    : { quarantineResolved: requested, rejected: requested };
  const reserved = await GoodsReceiptPutawayPosition.findOneAndUpdate(
    { companyId: tenant.companyId, goodsReceiptLineId: controlLine.goodsReceiptLineId, $expr: { $lte: [{ $add: ["$quarantineResolved", requested] }, { $add: ["$quarantined", TOL] }] } },
    { $inc: inc },
    { new: true, ...(session ? { session } : {}) },
  );
  if (!reserved) {
    throw fail("VALIDATION", `That decision would resolve more than the quarantined quantity for "${controlLine.itemName}".`, { reason: "OVER_DISPOSITION", goodsReceiptLineId: controlLine.goodsReceiptLineId });
  }

  const quantityBase = r4(quantity * factor);
  const transferId = new mongoose.Types.ObjectId();
  const isRelease = dispositionType === "RELEASE";
  const mv = await internalMove(session, tenant, {
    rawItemId: controlLine.rawItemId, variantId: controlLine.variantId, baseUnit: controlLine.baseUnit, itemName: controlLine.itemName,
    fromWarehouse: warehouse, fromLocation: quarantineLocation, toWarehouse: warehouse, toLocation,
    quantityBase, transferId,
    sourceKind: isRelease ? "grn_disposition_release" : "grn_disposition_reject", sourceId: goodsReceipt._id, reference: goodsReceipt.receiptNumber,
    actor, note: `${isRelease ? "Quarantine released" : "Quarantine rejected"} — GRN ${goodsReceipt.receiptNumber}`, idempotencyKey: idempotencyKey || "", goodsReceiptLineId: controlLine.goodsReceiptLineId,
  });

  const [disposition] = await GoodsReceiptDisposition.create([{
    companyId: tenant.companyId, siteId: tenant.siteId || null,
    goodsReceiptId: goodsReceipt._id, inspectionId: inspection._id, receiptNumber: goodsReceipt.receiptNumber, purchaseOrderId: goodsReceipt.purchaseOrderId,
    goodsReceiptLineId: controlLine.goodsReceiptLineId, poItemId: controlLine.poItemId,
    rawItemId: controlLine.rawItemId, variantId: controlLine.variantId, variantCombination: controlLine.variantCombination || [], itemName: controlLine.itemName, sku: controlLine.sku,
    dispositionType, quantity: r4(quantity), unit: controlLine.unit, baseQuantity: quantityBase, baseUnit: controlLine.baseUnit, conversionFactor: factor,
    warehouseId: warehouse._id,
    fromLocationId: quarantineLocation._id, fromLocationCode: quarantineLocation.code || "", fromLocationName: quarantineLocation.name || "",
    toLocationId: toLocation._id, toLocationCode: toLocation.code || "", toLocationName: toLocation.name || "",
    transferId, movementOutId: mv.outId, movementInId: mv.inId,
    reason, note: note || "", evidenceRef: evidenceRef || "",
    actor: { id: actor.id || null, name: actor.name || "" }, at: new Date(), idempotencyKey: idempotencyKey || "",
  }], session ? { session } : {});

  return { disposition };
}

/**
 * Hand rejected stock off to the CANONICAL supplier-return operation — the stock
 * mutation itself is NOT reproduced here. This adds only what the GRN context
 * requires: an atomic per-line guard so cumulative returns cannot exceed this
 * line's rejected quantity, and GRN provenance stored on the return. The return
 * is raised FROM the Returns location where the rejected stock sits; it decreases
 * that location AND company-wide RawItem on-hand exactly once (inside supplier-
 * return's own logic).
 * @returns {{ returnRequest }}
 */
async function applyGrnSupplierReturn({ session, tenant, goodsReceipt, inspection, controlLine, po, poItem, returnsLocation, rawUnit, quantity, reason, actor, operationId, idempotencyKey, inspectionRejected, rejectDispositions }) {
  const requested = r4(quantity);

  // BUSINESS vs STOCK quantity. `requested` is the business quantity in the line's
  // received unit (it drives the returnable guard + the PO returnable guard + the
  // return record). The rejected stock sits in Returns in the FROZEN BASE unit, so
  // RawItem / the location come off the CONVERTED base quantity. Fails closed on
  // missing / invalid conversion evidence.
  const factor = resolveFactor(controlLine.unit, controlLine.baseUnit, controlLine.conversionFactor, controlLine.itemName, controlLine.goodsReceiptLineId);
  const baseQty = r4(requested * factor);

  // ── ATOMIC returnable guard: returned + requested ≤ this line's rejected ─────
  // The {new:true} result gives the post-increment total, so this operation owns
  // exactly the window [returnedBefore, returnedAfter) of the ordered rejected
  // pool — two concurrent returns get NON-OVERLAPPING windows and therefore never
  // allocate the same rejected source twice.
  const reserved = await GoodsReceiptPutawayPosition.findOneAndUpdate(
    { companyId: tenant.companyId, goodsReceiptLineId: controlLine.goodsReceiptLineId, $expr: { $lte: [{ $add: ["$returned", requested] }, { $add: ["$rejected", TOL] }] } },
    { $inc: { returned: requested } },
    { new: true, ...(session ? { session } : {}) },
  );
  if (!reserved) {
    throw fail("VALIDATION", `That return would exceed the rejected quantity awaiting supplier return for "${controlLine.itemName}".`, { reason: "OVER_SUPPLIER_RETURN", goodsReceiptLineId: controlLine.goodsReceiptLineId });
  }
  const returnedBefore = r4(r4(reserved.returned) - requested);

  // Deterministic allocation of this window across the ordered rejected sources:
  // the inspection rejection first, then REJECT dispositions by creation time.
  const sources = [];
  if (r4(inspectionRejected) > TOL) sources.push({ sourceType: "INSPECTION_REJECTION", sourceId: inspection._id, quantity: r4(inspectionRejected) });
  for (const d of (rejectDispositions || [])) sources.push({ sourceType: "QUARANTINE_DISPOSITION", sourceId: d._id, quantity: r4(d.quantity) });
  const rejectionAllocations = allocateRejectedSources({ rBefore: returnedBefore, quantity: requested, sources, factor, unit: controlLine.unit, baseUnit: controlLine.baseUnit });

  const newReturn = {
    _id: new mongoose.Types.ObjectId(),
    poItemId: poItem._id, rawItem: poItem.rawItem, itemName: poItem.itemName, sku: poItem.sku,
    unit: poItem.unit, variantId: poItem.variantId || null, variantCombination: poItem.variantCombination || [],
    damagedQuantity: requested, returnedQuantity: 0, pendingReturnQty: requested, status: "PENDING",
    // Frozen conversion basis — the stock quantity actually taken off, so a
    // replacement is credited on the SAME basis.
    baseQuantity: baseQty, baseUnit: controlLine.baseUnit, conversionFactor: factor,
    reason, reportedBy: actor.id || null, reportedAt: new Date(), operationId, receipts: [],
    // Snapshot the Returns location the rejected stock leaves from.
    sourceWarehouseId: returnsLocation.warehouse._id, sourceLocationId: returnsLocation.location._id,
    sourceWarehouseName: returnsLocation.warehouse.name || "", sourceWarehouseShortName: returnsLocation.warehouse.shortName || "",
    sourceLocationCode: returnsLocation.location.code || "", sourceLocationName: returnsLocation.location.name || "",
    // Goods Receipt exception provenance + which rejected sources it consumed.
    goodsReceiptId: goodsReceipt._id, goodsReceiptLineId: controlLine.goodsReceiptLineId, inspectionId: inspection._id, receiptNumber: goodsReceipt.receiptNumber,
    rejectionAllocations,
    createdAt: new Date(), updatedAt: new Date(),
  };

  await supplierReturn.raiseSupplierReturnStock({
    session, tenant, po, poItem, dmgQty: requested, stockQty: baseQty, stockUnit: controlLine.baseUnit, reason, loc: returnsLocation, rawUnit,
    actor, operationId, idempotencyKey, newReturn,
  });

  return { returnRequest: newReturn };
}

/**
 * Allocate the business quantity [rBefore, rBefore+quantity) across the ordered
 * rejected sources (inspection rejection first, then REJECT dispositions by
 * creation time). Pure + deterministic; cumulative allocation equals `quantity`
 * exactly. Each allocation carries the base quantity on the frozen factor.
 */
function allocateRejectedSources({ rBefore, quantity, sources, factor, unit, baseUnit }) {
  const start = r4(rBefore);
  const end = r4(rBefore + quantity);
  const out = [];
  let cursor = 0;
  for (const s of (sources || [])) {
    const sStart = cursor;
    const sEnd = r4(cursor + s.quantity);
    cursor = sEnd;
    const lo = Math.max(sStart, start);
    const hi = Math.min(sEnd, end);
    const take = r4(hi - lo);
    if (take > TOL) {
      out.push({ sourceType: s.sourceType, sourceId: s.sourceId, quantity: take, unit: unit || "", baseQuantity: r4(take * factor), baseUnit: baseUnit || "" });
    }
    if (cursor >= end - TOL) break;
  }
  return out;
}

module.exports = {
  STAGE, deriveControl, validateInspection, applyInspection, applyPutaway, applyDisposition, applyGrnSupplierReturn, allocateRejectedSources, internalMove,
};
