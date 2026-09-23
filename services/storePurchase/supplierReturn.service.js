// services/storePurchase/supplierReturn.service.js
//
// SUPPLIER RETURN — the canonical stock-out for damaged/rejected goods leaving
// the company back to a vendor. This is the ONE implementation of that mutation:
// the PO returns route and the Goods Receipt exception-resolution handoff both
// call it, so there are never two versions of "take damaged stock off the shelf
// and record the return against the PO line".
//
// A supplier return is an EXTERNAL stock-out: it decreases the chosen location's
// balance AND decreases company-wide RawItem on-hand exactly once, both inside
// the caller's unit of work, capped so cumulative returns can never exceed the
// PO line's received quantity. The return itself is an embedded subdocument on
// the PurchaseOrder; the caller builds it (so caller-specific provenance — e.g.
// Goods Receipt / inspection / disposition ids — can be attached) and this
// service performs the guarded push + the two stock mutations + compensation.
//
// It was extracted verbatim from routes/.../returnRequests.js; the route now
// delegates here so its behaviour is unchanged.

"use strict";

const mongoose = require("mongoose");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const locStock = require("./locationStock.service");
const tenantContext = require("./tenantContext.service");
const { fail } = require("./errors");

/* ── A NARROW SEAM FOR PROVING INTERLEAVINGS ────────────────────────────────
 * Each contested boundary announces itself so a test can hold one request there
 * and drive another to completion — proving the guard rather than hoping for a
 * collision. Switched off unless a test runner is running: outside one, `at()`
 * returns its argument and `hooks` is null. The route re-exports `__hooks` so
 * the existing return tests keep registering on this same object. */
const TESTING = Boolean(process.env.JEST_WORKER_ID) || process.env.NODE_ENV === "test";
const hooks = TESTING ? Object.create(null) : null;
const at = TESTING
  ? async function at(point, ctx = {}) {
    const fn = hooks[point];
    if (typeof fn === "function") await fn(ctx);
    return ctx;
  }
  : async (point, ctx = {}) => ctx;

/**
 * Find the variant a return line refers to, if it names one. Kept separate from
 * the write so availability can be checked before anything is changed.
 */
function matchVariant(rawItem, variantId, variantCombination) {
  if (variantId && rawItem.variants?.length) {
    const byId = rawItem.variants.id(variantId);
    if (byId) return byId;
  }
  if (variantCombination?.length && rawItem.variants?.length) {
    return rawItem.variants.find((v) =>
      v.combination?.length === variantCombination.length &&
      v.combination.every((val, i) => val === variantCombination[i]),
    ) || null;
  }
  return null;
}

/**
 * Move stock for a return, refusing rather than clamping. The check and the
 * write are one operation (a conditional `$inc` whose filter carries the
 * sufficiency guard) so a concurrent movement that emptied the shelf first makes
 * this one's filter fail to match — refused, having changed nothing. The ledger
 * line is appended in the same pipeline so it can never be lost separately.
 */
async function moveStock({
  rawItemId, variantId, variantCombination, delta, txn, session = null, operationId = null,
}) {
  const q = RawItem.findById(rawItemId);
  if (session) q.session(session);
  const rawItem = await q;
  if (!rawItem) {
    throw fail("VALIDATION", "That item is no longer in the catalogue, so its stock cannot be adjusted.", {
      rawItemId: String(rawItemId || ""),
    });
  }

  const wantsVariant = Boolean(variantId) || Boolean(variantCombination?.length);
  const matchedVariant = matchVariant(rawItem, variantId, variantCombination);

  // A named variant that cannot be found is a refusal — never fall through to
  // adjusting only the parent balance.
  if (wantsVariant && !matchedVariant) {
    throw fail(
      "INVALID_TRANSITION",
      `That variant of "${rawItem.name}" is no longer in the catalogue, so its stock cannot be adjusted. Nothing was changed.`,
      {
        reason: "VARIANT_NOT_FOUND",
        itemName: rawItem.name,
        variantId: variantId ? String(variantId) : null,
        variantCombination: variantCombination || [],
      },
    );
  }

  const take = delta < 0 ? Math.abs(delta) : 0;
  const filter = { _id: rawItem._id };
  if (take > 0) {
    filter.quantity = { $gte: take };
    if (matchedVariant) {
      filter.variants = { $elemMatch: { _id: matchedVariant._id, quantity: { $gte: take } } };
    }
  }

  const statusExpr = (qtyExpr, minExpr) => ({
    $switch: {
      branches: [
        { case: { $lte: [qtyExpr, 0] }, then: "Out of Stock" },
        { case: { $lte: [qtyExpr, { $ifNull: [minExpr, 0] }] }, then: "Low Stock" },
      ],
      default: "In Stock",
    },
  });

  const nextQty = { $add: [{ $ifNull: ["$quantity", 0] }, delta] };

  // The variant's balance, read where it is being written (never from the stale
  // JavaScript snapshot) so the ledger's before/after chain stays correct.
  const variantQtyNow = matchedVariant
    ? {
      $ifNull: [
        {
          $first: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$variants", []] },
                  as: "v",
                  cond: { $eq: ["$$v._id", matchedVariant._id] },
                },
              },
              as: "v",
              in: { $ifNull: ["$$v.quantity", 0] },
            },
          },
        },
        0,
      ],
    }
    : null;

  // A test parks here to make the pre-write read genuinely stale.
  await at("stock:beforeWrite", { rawItemId: rawItem._id, operationId });

  const stampedAt = new Date();
  const pipeline = [
    {
      $set: {
        stockTransactions: {
          $concatArrays: [
            { $ifNull: ["$stockTransactions", []] },
            [{
              ...txn,
              operationId,
              previousQuantity: { $ifNull: ["$quantity", 0] },
              newQuantity: nextQty,
              ...(matchedVariant ? {
                variantPreviousQuantity: variantQtyNow,
                variantNewQuantity: { $add: [variantQtyNow, delta] },
              } : {}),
              createdAt: stampedAt,
              updatedAt: stampedAt,
            }],
          ],
        },
        quantity: nextQty,
      },
    },
    {
      $set: {
        status: statusExpr("$quantity", "$minStock"),
        ...(matchedVariant ? {
          variants: {
            $map: {
              input: { $ifNull: ["$variants", []] },
              as: "v",
              in: {
                $cond: [
                  { $eq: ["$$v._id", matchedVariant._id] },
                  {
                    $mergeObjects: ["$$v", {
                      quantity: { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
                      status: statusExpr(
                        { $add: [{ $ifNull: ["$$v.quantity", 0] }, delta] },
                        { $ifNull: ["$$v.minStock", { $ifNull: ["$minStock", 0] }] },
                      ),
                    }],
                  },
                  "$$v",
                ],
              },
            },
          },
        } : {}),
      },
    },
  ];

  const update = RawItem.findOneAndUpdate(filter, pipeline, { new: true });
  if (session) update.session(session);
  const updated = await update;

  if (!updated) {
    const now = await RawItem.findById(rawItem._id).lean();
    const available = now?.quantity || 0;
    const variantNow = matchedVariant
      ? (now?.variants || []).find((v) => String(v._id) === String(matchedVariant._id))
      : null;
    if (matchedVariant && (variantNow?.quantity || 0) < take) {
      throw fail(
        "INVALID_TRANSITION",
        `Cannot take ${take} of that variant of "${rawItem.name}" out of stock — only ${variantNow?.quantity || 0} is there. Nothing was changed.`,
        { reason: "INSUFFICIENT_VARIANT_STOCK", available: variantNow?.quantity || 0, requested: take, itemName: rawItem.name },
      );
    }
    throw fail(
      "INVALID_TRANSITION",
      `Cannot take ${take} ${rawItem.unit || "unit"} of "${rawItem.name}" out of stock — only ${available} is there. Nothing was changed.`,
      { reason: "INSUFFICIENT_STOCK", available, requested: take, itemName: rawItem.name },
    );
  }

  const newQuantity = updated.quantity || 0;
  return { previousQuantity: newQuantity - delta, newQuantity };
}

/**
 * The guard that makes two simultaneous returns safe: the sum of existing
 * returns for this line plus the new quantity must not exceed the line's
 * received quantity — computed by MongoDB as part of the update's own filter, so
 * the loser's filter re-evaluates against the winner's already-updated document
 * and simply does not match. Cancelled returns still count (the stock stays out).
 */
function returnableGuard(poItemId, dmgQty) {
  const alreadyReturned = {
    $sum: {
      $map: {
        input: { $filter: { input: { $ifNull: ["$returnRequests", []] }, as: "r", cond: { $eq: ["$$r.poItemId", poItemId] } } },
        as: "r",
        in: { $ifNull: ["$$r.damagedQuantity", 0] },
      },
    },
  };
  const received = {
    $ifNull: [
      { $first: { $map: {
        input: { $filter: { input: { $ifNull: ["$items", []] }, as: "i", cond: { $eq: ["$$i._id", poItemId] } } },
        as: "i", in: { $ifNull: ["$$i.receivedQuantity", 0] },
      } } },
      0,
    ],
  };
  return { $expr: { $lte: [{ $add: [dmgQty, alreadyReturned] }, received] } };
}

// FAIL-CLOSED base factor for crediting a replacement in the SAME basis the
// outbound stock left in.
//   · A return WITH frozen evidence uses it: factor 1 only when its business and
//     base units are the same, otherwise the frozen finite, positive factor (or a
//     refusal).
//   · A LEGACY return with NO frozen evidence never silently assumes 1:1 — factor
//     1 is allowed only when its business unit normalizes to the RawItem's CURRENT
//     registered base unit; when they differ, the replacement is refused with an
//     honest legacy-conversion blocker (evidence must be added deliberately, not
//     guessed).
function frozenBaseFactor(returnReq, registeredBaseUnit) {
  const norm = (u) => String(u || "").trim().toLowerCase();
  const unit = norm(returnReq?.unit);
  const frozenBase = norm(returnReq?.baseUnit);
  if (frozenBase) {
    if (frozenBase === unit) return 1;
    const f = Number(returnReq?.conversionFactor);
    if (!Number.isFinite(f) || f <= 0) {
      throw fail("VALIDATION",
        `No valid unit conversion is frozen on this return (${returnReq?.unit || "?"} → ${returnReq?.baseUnit}), so its replacement stock cannot be credited.`,
        { reason: "RETURN_CONVERSION_MISSING", returnId: String(returnReq?._id || "") });
    }
    return f;
  }
  // Legacy return — no frozen basis.
  const regBase = norm(registeredBaseUnit);
  if (!regBase || regBase === unit) return 1;
  throw fail("VALIDATION",
    `This return predates unit-conversion tracking and its unit (${returnReq?.unit || "?"}) differs from the item's stock unit (${registeredBaseUnit}). A replacement cannot be credited until its conversion is recorded.`,
    { reason: "LEGACY_CONVERSION_REQUIRED", returnId: String(returnReq?._id || "") });
}

/** What is actually left on a line, read fresh — only after the atomic guard refused. */
function returnableNow(po, poItemId) {
  const item = (po.items || []).find((i) => String(i._id) === String(poItemId));
  const received = item?.receivedQuantity || 0;
  const alreadyReturned = (po.returnRequests || [])
    .filter((r) => String(r.poItemId) === String(poItemId))
    .reduce((sum, r) => sum + (r.damagedQuantity || 0), 0);
  return { received, alreadyReturned, remaining: Math.max(0, received - alreadyReturned) };
}

/**
 * The canonical supplier-return stock mutation, shared by the PO returns route
 * and the Goods Receipt exception handoff. The caller builds `newReturn` (so it
 * can attach its own provenance) and runs this inside its own unit of work.
 *
 * Order matters: the guarded push wins the room BEFORE any stock moves, then the
 * company on-hand and the location balance come off; a stock failure compensates
 * the push so a return never stands without the deduction behind it.
 *
 * @returns {{ moved, before }} the RawItem before/after and the line's remaining.
 */
async function raiseSupplierReturnStock({
  session, tenant, po, poItem, dmgQty, stockQty, stockUnit, reason, loc, rawUnit, actor, operationId, idempotencyKey, newReturn,
}) {
  // ONE unit contract. `dmgQty` is the BUSINESS quantity in the PO line's unit —
  // it drives the cumulative returnable guard and the return record. `stockQty`
  // is the converted BASE quantity actually held by RawItem / LocationBalance and
  // is REQUIRED — every caller resolves and validates it (there is no implicit
  // stockQty = dmgQty fallback, which silently mis-scaled converted returns).
  if (!(typeof stockQty === "number" && Number.isFinite(stockQty) && stockQty > 0)) {
    throw fail("VALIDATION", "A validated base (stock) quantity is required to raise a supplier return.", { reason: "STOCK_QTY_REQUIRED" });
  }
  const takeQty = stockQty;

  const q = PurchaseOrder.findOneAndUpdate(
    { _id: po._id, ...tenantContext.tenantFilter(tenant), ...returnableGuard(poItem._id, dmgQty) },
    { $push: { returnRequests: newReturn } },
    { new: true },
  );
  if (session) q.session(session);
  const updated = await q;

  if (!updated) {
    const fresh = await PurchaseOrder.findOne({ _id: po._id, ...tenantContext.tenantFilter(tenant) }).lean();
    const state = fresh ? returnableNow(fresh, poItem._id) : { received: 0, alreadyReturned: 0, remaining: 0 };
    throw fail(
      "INVALID_TRANSITION",
      state.alreadyReturned > 0
        ? `Only ${state.remaining} ${poItem.unit} of "${poItem.itemName}" can still be returned — ${state.received} was received and ${state.alreadyReturned} has already been returned.`
        : `Damaged qty (${dmgQty}) cannot exceed received qty (${state.received}).`,
      {
        reason: "RETURNABLE_QUANTITY_EXCEEDED",
        receivedQuantity: state.received, alreadyReturnedQuantity: state.alreadyReturned,
        remainingReturnable: state.remaining, requested: dmgQty, unit: poItem.unit, itemName: poItem.itemName,
      },
    );
  }
  const before = returnableNow(updated, poItem._id);

  await at("returnCreate:beforeStock", { poId: po._id, operationId });
  let moved;
  try {
    // RawItem on-hand comes off in the STOCK (base) quantity.
    moved = await moveStock({
      rawItemId: poItem.rawItem, variantId: poItem.variantId, variantCombination: poItem.variantCombination,
      delta: -takeQty, session, operationId,
      txn: {
        type: poItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
        quantity: takeQty, baseUnit: stockUnit || rawUnit?.customUnit || rawUnit?.unit || "",
        reason: `Return request — damaged/faulty (PO: ${po.poNumber})`,
        notes: reason || "Damaged goods reported by store",
        variantId: poItem.variantId || undefined,
        variantCombination: poItem.variantCombination?.length ? poItem.variantCombination : undefined,
        purchaseOrder: po.poNumber, purchaseOrderId: po._id, performedBy: actor?.id || null,
      },
    });

    if (loc) {
      // The chosen location comes off in the same STOCK (base) quantity.
      const out = await locStock.applyLocationOut(session, {
        companyId: tenant.companyId, siteId: tenant.siteId || null,
        item: { _id: poItem.rawItem, unit: rawUnit?.unit, customUnit: rawUnit?.customUnit },
        variantId: poItem.variantId || null,
        warehouse: loc.warehouse, location: loc.location,
        quantity: takeQty, type: "supplier_return",
        source: { kind: "supplier_return", id: po._id, reference: po.poNumber, returnId: newReturn._id, poLineId: poItem._id },
        actor: { id: actor?.id || null, name: actor?.name || "" },
        note: reason || "Damaged goods returned to supplier",
        idempotencyKey: locStock.movementLineKey(idempotencyKey || "", newReturn._id, "supplier_return"),
        operationKey: idempotencyKey || "",
      });
      if (!out.ok) {
        throw fail("INVALID_TRANSITION", `${loc.location.code} no longer holds ${takeQty} of "${poItem.itemName}". Nothing was changed.`, { reason: out.reason });
      }
    }
  } catch (stockError) {
    const gate = await at("returnCreate:beforeCompensate", { poId: po._id, operationId, skip: false });
    if (gate.skip) throw stockError;
    const undo = PurchaseOrder.updateOne({ _id: po._id }, { $pull: { returnRequests: { operationId } } });
    if (session) undo.session(session);
    await undo.catch((e) => console.error("[supplier-return] could not undo the return after a stock failure:", e.message));
    throw stockError;
  }

  return { moved, before };
}

module.exports = {
  at, matchVariant, moveStock, returnableGuard, returnableNow, raiseSupplierReturnStock, frozenBaseFactor,
};
if (TESTING) module.exports.__hooks = hooks;
