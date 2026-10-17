"use strict";

/**
 * Stock summary for accounting (13 Oct 2026, owner): what the inventory held,
 * by day end, month end or year end — quantity, rate and value — read from
 * the CMS inventory, not typed into accounts.
 *
 * ── RAW MATERIALS (RawItem) — a real period statement ────────────────────────
 * Every movement is in `stockTransactions` with `previousQuantity`,
 * `newQuantity` and `createdAt`, so for any period:
 *   opening  = the quantity just before `from`
 *   inward   = every increase inside the period
 *   outward  = every decrease inside the period
 *   closing  = the quantity at the end of `to`
 * "The quantity at T" is the `newQuantity` of the last movement at or before
 * T; before the first movement it is that movement's `previousQuantity`; with
 * no movement at all it is the item's current quantity. When the period ends
 * today or later, closing is the item's CURRENT quantity. Any change with no
 * movement record — a gap in the history, or today's figure differing from
 * where the history ends — is its own `adjustment` column, so every line
 * reads opening + inward − outward + adjustment = closing.
 *
 * Rate — weighted average of what was paid: every receipt movement with a
 * unit price up to `to` (Σ qty × price ÷ Σ qty); else the latest purchase-
 * order rate; else the primary supplier's listed price. `rateSource` says
 * which. Value = closing × rate; no rate → no value, never 0.
 *
 * ── FINISHED PRODUCTS (StockItem) — today only ───────────────────────────────
 * The product catalogue keeps no movement ledger (see
 * productCatalogueBridge.service.js), so there is no honest "as at" figure for
 * a past date. They are listed with today's quantity and cost and marked
 * `asOfToday: true`; the screen says so.
 */

const DAY = 86400000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The quantity of an item at instant `t`, from its movements (oldest first). */
function quantityAt(moves, t, current) {
  if (!moves.length) return current;
  let q = null;
  for (const m of moves) {
    if (m.at <= t) q = m.after;
    else break;
  }
  return q === null ? moves[0].before : q;
}

function rawItemRow(item, { from, to, now, lastPoPrice }) {
  const moves = (item.stockTransactions || [])
    .map((t) => ({
      at: new Date(t.createdAt || t.updatedAt || 0),
      before: num(t.previousQuantity),
      after: num(t.newQuantity),
      price: num(t.unitPrice),
    }))
    .filter((m) => !isNaN(m.at))
    .sort((a, b) => a.at - b.at);
  const current = num(item.quantity);
  const opening = quantityAt(moves, new Date(from.getTime() - 1), current);
  const historyClose = quantityAt(moves, to, current);
  const closing = to >= now ? current : historyClose;
  let inward = 0, outward = 0, inQty = 0, inCost = 0;
  for (const m of moves) {
    const d = m.after - m.before;
    if (m.at >= from && m.at <= to) {
      if (d > 0) inward += d;
      else outward += -d;
    }
    if (m.at <= to && d > 0 && m.price > 0) {
      inQty += d;
      inCost += d * m.price;
    }
  }
  let rate = null, rateSource = null;
  if (inQty > 0) {
    rate = inCost / inQty;
    rateSource = "weighted_receipts";
  } else if (lastPoPrice) {
    rate = lastPoPrice;
    rateSource = "purchase_order";
  } else {
    const prices = (item.variants || []).flatMap((v) => (v.vendorNicknames || []).map((n) => num(n.price))).filter((p) => p > 0);
    if (prices.length) {
      rate = prices[0];
      rateSource = "supplier";
    }
  }
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    kind: "raw",
    _id: item._id,
    name: item.name,
    sku: item.sku || "",
    category: item.customCategory || item.category || "Uncategorised",
    unit: item.customUnit || item.unit || "",
    opening: round(opening),
    inward: round(inward),
    outward: round(outward),
    closing: round(closing),
    rate: rate === null ? null : Math.round(rate * 100) / 100,
    rateSource,
    value: rate === null ? null : Math.round(closing * rate * 100) / 100,
    openingValue: rate === null ? null : Math.round(opening * rate * 100) / 100,
    /* A change with no movement record (a gap in the history, or today's
       quantity differing from where the history ends) is shown as its own
       figure, so every line reads opening + in − out + adjustment = closing
       and the gap is visible rather than hidden. */
    adjustment: round(closing - (opening + inward - outward)),
    movements: moves.filter((m) => m.at >= from && m.at <= to).length,
    tracked: moves.length > 0,
    asOfToday: false,
  };
}

function productRow(p) {
  const variants = (p.variants || []).filter((v) => v && v.status !== "inactive");
  const qty = variants.length ? variants.reduce((s, v) => s + num(v.quantityOnHand), 0) : num(p.totalQuantityOnHand);
  const variantCosts = variants.map((v) => num(v.cost)).filter((c) => c > 0);
  const rate = num(p.averageCost) || num(p.baseCost) || (variantCosts.length ? variantCosts.reduce((a, b) => a + b, 0) / variantCosts.length : 0) || null;
  return {
    kind: "product",
    _id: p._id,
    name: p.name,
    sku: p.reference || "",
    category: [p.category, p.genderCategory].filter(Boolean).join(" · ") || "Uncategorised",
    unit: p.unit || "Pcs",
    opening: null,
    inward: null,
    outward: null,
    closing: qty,
    rate: rate ? Math.round(rate * 100) / 100 : null,
    rateSource: rate ? (num(p.averageCost) ? "average_cost" : num(p.baseCost) ? "base_cost" : "variant_cost") : null,
    value: rate ? Math.round(qty * rate * 100) / 100 : null,
    openingValue: null,
    adjustment: null,
    movements: null,
    tracked: false,
    asOfToday: true,
  };
}

/** IST day bounds for "YYYY-MM-DD". */
function istDay(ds, end) {
  const [y, m, d] = String(ds).split("-").map(Number);
  const start = Date.UTC(y, m - 1, d) - 330 * 60000;
  return new Date(end ? start + DAY - 1 : start);
}

function summarise(rows) {
  const sum = (k) => rows.reduce((s, r) => s + (r[k] == null ? 0 : r[k]), 0);
  return {
    items: rows.length,
    value: Math.round(sum("value") * 100) / 100,
    openingValue: Math.round(sum("openingValue") * 100) / 100,
    withoutRate: rows.filter((r) => r.rate == null).length,
    withStock: rows.filter((r) => r.closing > 0).length,
    withAdjustment: rows.filter((r) => r.adjustment).length,
  };
}

module.exports = { quantityAt, rawItemRow, productRow, istDay, summarise };
