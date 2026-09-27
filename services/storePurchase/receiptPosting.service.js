// services/storePurchase/receiptPosting.service.js
//
// THE PHYSICAL ACT OF RECEIVING — ONCE, FOR EVERY KIND OF ARRIVAL.
//
// Two quite different documents can bring goods through the gate. A Purchase
// Order: the factory bought them, there is a supplier, an invoice and a spend. A
// customer-supplied material expectation on a job-work order: the customer sent
// them, nothing was bought, and there is no supplier, no value and nothing
// payable.
//
// Everything COMMERCIAL about those two is different. Everything PHYSICAL about
// them is identical: something arrived, it was counted in some unit, that unit
// was converted to the item's base unit, the item's balance moved, a warehouse
// location's balance moved, and a numbered receipt now says so.
//
// This module is that identical part, extracted from the purchase-order receipt
// implementation rather than copied out of it. The extraction is the point: a
// second receiving path would mean a second unit-conversion rule, a second
// over-receipt rule and a second stock-in — and the first time they disagreed,
// one kind of goods would post differently from the other for reasons nobody
// could find.
//
// ── WHAT THIS MODULE DOES NOT KNOW ──────────────────────────────────────────
// It does not know what a purchase order is, or what an expectation is. It is
// handed a `source` descriptor that has already answered the questions only the
// source can answer — which lines exist, how much is outstanding on each, what
// provenance to stamp — and it performs the movement. That is the seam: the
// source decides WHAT may be received and this decides HOW it is posted.
//
// ── AND WHY THE OVER-RECEIPT RULE LIVES HERE ────────────────────────────────
// Because it is the same rule, and because it must run BEFORE any write. Each
// source computes its own `pending`; the refusal itself is one function, so
// "never book more than is outstanding" cannot end up meaning two things.
"use strict";

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const locStock = require("./locationStock.service");
const sequences = require("./documentSequence.service");
const { fail } = require("./errors");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/* ── STRICT UNIT CONVERSION ──────────────────────────────────────────────────
   A MISSING path refuses; it never silently passes the number through. The PO
   route's own older `convertQuantity` returned the input unchanged when no path
   existed, which for an authoritative receipt is a lie: it books 5 rolls as 5
   metres and the shelf disagrees with the ledger for ever.

   Moved here verbatim. Re-exported from `goodsReceipt.service` so every existing
   caller is untouched. */
async function resolveConversion({ quantity, fromUnit, toUnit, session = null }) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) {
    return { baseQuantity: r4(quantity), factor: 1, note: "" };
  }
  const q = (m) => (session ? m.session(session) : m);
  const fromDoc = await q(Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name")).lean();
  const direct = (fromDoc?.conversions || []).find((c) => (c.toUnit?.name || c.toUnit) === toUnit);
  if (direct?.quantity) {
    return {
      baseQuantity: r4(quantity * direct.quantity),
      factor: direct.quantity,
      note: `${quantity} ${fromUnit} = ${r4(quantity * direct.quantity)} ${toUnit}`,
    };
  }
  const toDoc = await q(Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name")).lean();
  const reverse = (toDoc?.conversions || []).find((c) => (c.toUnit?.name || c.toUnit) === fromUnit);
  if (reverse?.quantity) {
    return {
      baseQuantity: r4(quantity / reverse.quantity),
      factor: 1 / reverse.quantity,
      note: `${quantity} ${fromUnit} = ${r4(quantity / reverse.quantity)} ${toUnit}`,
    };
  }
  throw fail("VALIDATION",
    `No unit conversion from "${fromUnit}" to "${toUnit}" is configured, so this receipt cannot be recorded.`,
    { reason: "UOM_CONVERSION_MISSING", field: "unit", fromUnit, toUnit });
}

/* ── ONE OVER-RECEIPT RULE ───────────────────────────────────────────────────
   Refuse, never book surplus. Surplus that arrives without anybody deciding to
   accept it is a discrepancy, and booking it quietly turns a discrepancy into a
   stock figure nobody can question later.

   Each source supplies its own `pending`; the refusal is shared so the sentence
   and the code are the same whichever gate the goods came through. */
function assertWithinPending({ requested, pending, label, unit, details = {} }) {
  if (r4(requested) > r4(pending)) {
    throw fail("VALIDATION",
      `Cannot receive ${requested} ${unit} for "${label}": only ${r4(pending)} ${unit} remain outstanding.`,
      { reason: "OVER_RECEIPT", pending: r4(pending), requested: r4(requested), ...details });
  }
}

/** The item's own registered unit — what every balance is kept in. */
async function baseUnitOf(rawItemId, fallback = "", session = null) {
  if (!rawItemId) return fallback;
  const q = RawItem.findById(rawItemId).select("unit customUnit");
  const doc = await (session ? q.session(session) : q).lean();
  if (!doc) return fallback;
  return doc.customUnit || doc.unit || fallback;
}

/* ── THE CANONICAL RawItem STOCK-IN ──────────────────────────────────────────
   The SAME ledger the purchase route has always used. Moved here unchanged so
   customer-owned goods move the physical balance through one implementation
   rather than a second one that drifts.

   Note what it does and does not mean: it moves the PHYSICAL total, which is
   what a stock-take should find on the shelf. It says nothing about who owns it.
   Ownership of customer goods is the lot's job, and `RawItem.quantity` including
   customer-owned stock is correct precisely because the shelf does too. */
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

/** A receipt number from the shared GOODS_RECEIPT sequence. */
const allocateReceiptNumber = ({ companyId, session, siteId = null }) => sequences
  .allocate({ companyId, documentType: "GOODS_RECEIPT", session, siteId });

/**
 * Move the stock and the location balances for every plan, in the caller's
 * session, and stamp each plan with the movement ids it created.
 *
 * ── WHY THE IDS ARE STAMPED BACK ────────────────────────────────────────────
 * So the receipt line — and, for customer goods, the ownership lot — can NAME
 * the physical movements it caused. Reconciliation then follows stored ids
 * rather than matching quantities and dates and hoping, which is the difference
 * between a ledger that can be audited and one that can only be believed.
 *
 * @param {object}   source  `{ type, documentId, documentNumber, stockMeta(plan),
 *                             locationSource() }` — the provenance only the
 *                             source can supply.
 */
async function postMovements({
  session, tenant, plans, receiptNumber, header, actor, idempotencyKey, source,
}) {
  const companyId = tenant.companyId;
  const wh = header.warehouse || null;
  const loc = header.location || null;
  const locSnap = loc ? locStock.txLocationSnapshot(wh, loc) : {};

  /* Only the plans that move stock. A plan with no `rawItemId` still gets a
     receipt line — it records that something arrived — but moves no balance,
     and must never produce a malformed movement instead. */
  const byRawItem = new Map();
  for (const pl of plans) {
    if (!pl.rawItemId) continue;
    if (!byRawItem.has(pl.rawItemId)) byRawItem.set(pl.rawItemId, []);
    byRawItem.get(pl.rawItemId).push(pl);
  }

  for (const [rawItemId, itemPlans] of byRawItem) {
    const rawItem = session
      ? await RawItem.findById(rawItemId).session(session)
      : await RawItem.findById(rawItemId);
    if (!rawItem) {
      throw fail("VALIDATION", "Stock item for a receipt line no longer exists.",
        { reason: "RAW_ITEM_MISSING", rawItemId });
    }
    for (const pl of itemPlans) {
      pl.__txId = applyStockIn(rawItem, pl, {
        ...source.stockMeta(pl, { receiptNumber, header }),
        performedBy: actor.id,
        ...locSnap,
      });
    }
    await rawItem.save(session ? { session } : {});

    for (const pl of itemPlans) {
      let mvId = null;
      if (loc) {
        const out = await locStock.applyLocationIn(session, {
          companyId, siteId: tenant.siteId, item: rawItem, variantId: pl.variantId || null,
          warehouse: wh, location: loc, quantity: pl.baseQuantity,
          type: "receipt", intent: "receive",
          /* ── PROVENANCE ON THE LOCATION MOVEMENT ITSELF ────────────────
             Extended rather than replaced: the existing movement record gains a
             new `kind` for customer goods instead of a parallel ledger being
             built beside it. A warehouse report reading movements sees both
             kinds of arrival in one place, told apart by what they say. */
          source: source.locationSource(pl),
          actor: { id: actor.id, name: actor.name },
          note: `GRN ${receiptNumber}`,
          idempotencyKey: locStock.movementLineKey(idempotencyKey || "", pl.lineKey, "grn"),
          operationKey: idempotencyKey || "",
        });
        mvId = out?.movement?._id || null;
      }
      pl.__mvId = mvId;
    }
  }
  return plans;
}

module.exports = {
  r4,
  resolveConversion,
  assertWithinPending,
  baseUnitOf,
  applyStockIn,
  allocateReceiptNumber,
  postMovements,
};
