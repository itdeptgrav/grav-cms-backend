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
 * VALUE IS WORKED OUT VARIANT BY VARIANT (16 Oct 2026, owner: "some stock
 * items' values are not coming correctly"). Every raw material carries
 * variants, and variants of one material are bought at different prices — a
 * 24L button is not a 32L one, one fabric shade is not another. One blended
 * rate for the whole item over-valued some materials by lakhs and
 * under-valued others, and the supplier-price fallback took the FIRST
 * variant's price for all of them. Now each variant's closing quantity is
 * priced at that variant's own rate:
 *   1. the weighted average of what was paid on that variant's receipts up to
 *      `to` (Σ qty × price ÷ Σ qty) — `weighted_receipts`;
 *   2. else the SHARED price rule (materialPrices.variantPrice — the very rule
 *      the purchase voucher's item list fills a line with): this variant's
 *      latest purchase-order price in the stock unit, else its own supplier
 *      price (primary supplier first), else the material's latest
 *      purchase-order price — `purchase_order` / `supplier`;
 *   3. else the item's rate: what was paid for the material, else its
 *      supplier prices' average — `item_rate`.
 * A price on a goods receipt is per PURCHASE unit; the receipt line records
 * how many stock units one purchase unit made (`conversionFactor`), so the
 * price per stock unit is price ÷ factor (`factorByMovement`). A purchase
 * order in another unit is converted through the unit master the receipt
 * itself uses; with no conversion known its price is left out, never mixed
 * in as if it were per stock unit. Quantity not held by any variant (a
 * movement with no variant, or variants that do not add up to the item) is
 * valued at the item's rate. Quantity with no rate at all is counted in
 * `unvaluedQty` and left out of the value — never valued at 0.
 * The row's `rate` is the value ÷ the valued quantity (an average across
 * variants); `variants` lists each variant's quantity, rate and value.
 *
 * ── FINISHED PRODUCTS (StockItem) — today only ───────────────────────────────
 * The product catalogue keeps no movement ledger (see
 * productCatalogueBridge.service.js), so there is no honest "as at" figure for
 * a past date. They are listed with today's quantity and cost and marked
 * `asOfToday: true`; the screen says so.
 */

const { unitFactor, latestPoPrices, supplierPrice, variantPrice } = require("./materialPrices");

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

/** A variant's quantity at `t`: its own recorded before/after where every movement has one, else replayed back from today. */
function variantQuantityAt(moves, t, current, now) {
  if (t >= now) return current;
  if (moves.length && moves.every((m) => m.vAfter != null)) {
    let q = null;
    for (const m of moves) {
      if (m.at <= t) q = m.vAfter;
      else break;
    }
    return q === null ? (moves[0].vBefore != null ? moves[0].vBefore : 0) : q;
  }
  return moves.reduce((q, m) => (m.at > t ? q - m.signed : q), current);
}

/** Weighted average of priced receipts up to `to` (prices already per stock unit). */
function receiptRate(moves, to) {
  let q = 0, c = 0;
  for (const m of moves) {
    if (m.at <= to && m.signed > 0 && m.price > 0) {
      q += m.signed;
      c += m.signed * m.price;
    }
  }
  return q > 0 ? c / q : null;
}

const IN_TYPES = new Set(["ADD", "VARIANT_ADD", "PURCHASE_ORDER"]);
const OUT_TYPES = new Set(["REDUCE", "VARIANT_REDUCE", "CONSUME"]);

/**
 * One raw material's line. opts: { from, to, now,
 *   poPrice(variantId | null) → latest purchase-order price per stock unit, or null,
 *   factorByMovement: Map(movement id → stock units per purchase unit),
 *   lastPoPrice: a number (older callers; the item-level purchase-order price) }
 */
function rawItemRow(item, { from, to, now, lastPoPrice, poPrice, factorByMovement }) {
  const factors = factorByMovement instanceof Map ? factorByMovement : new Map();
  const moves = (item.stockTransactions || [])
    .map((t) => {
      const before = num(t.previousQuantity);
      const after = num(t.newQuantity);
      const dir = IN_TYPES.has(t.type) ? 1 : OUT_TYPES.has(t.type) ? -1 : Math.sign(after - before);
      const f = num(factors.get(String(t._id))) || 1;
      return {
        id: String(t._id || ""),
        at: new Date(t.createdAt || t.updatedAt || 0),
        before,
        after,
        /* what moved, by the movement's own quantity — the stored balance can
           be clamped (an issue larger than what was on record) */
        signed: dir * Math.abs(num(t.quantity) || after - before),
        price: num(t.unitPrice) / f,
        variant: t.variantId ? String(t.variantId) : null,
        vBefore: t.variantPreviousQuantity == null ? null : num(t.variantPreviousQuantity),
        vAfter: t.variantNewQuantity == null ? null : num(t.variantNewQuantity),
      };
    })
    .filter((m) => !isNaN(m.at))
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const current = num(item.quantity);
  const opening = quantityAt(moves, new Date(from.getTime() - 1), current);
  const historyClose = quantityAt(moves, to, current);
  const closing = to >= now ? current : historyClose;
  let inward = 0, outward = 0;
  for (const m of moves) {
    const d = m.after - m.before;
    if (m.at >= from && m.at <= to) {
      if (d > 0) inward += d;
      else outward += -d;
    }
  }

  /* the item's own rate: the fallback for a variant with nothing of its own,
     and the rate for quantity no variant holds */
  const poOf = (v) => {
    const p = typeof poPrice === "function" ? num(poPrice(v)) : 0;
    return p > 0 ? p : null;
  };
  let itemRate = receiptRate(moves, to);
  let itemSource = itemRate != null ? "weighted_receipts" : null;
  if (itemRate == null) {
    const p = poOf(null) || (num(lastPoPrice) > 0 ? num(lastPoPrice) : null);
    if (p) {
      itemRate = p;
      itemSource = "purchase_order";
    }
  }
  if (itemRate == null) {
    const prices = (item.variants || []).map((v) => supplierPrice(item, v)).filter(Boolean);
    if (prices.length) {
      itemRate = prices.reduce((a, b) => a + b, 0) / prices.length;
      itemSource = "supplier";
    }
  }

  /* each variant at its own rate */
  const variants = [];
  let value = 0, valuedQty = 0, unvaluedQty = 0, held = 0;
  const sources = new Set();
  for (const v of item.variants || []) {
    const id = String(v._id || "");
    const vm = moves.filter((m) => m.variant === id);
    const qty = Math.round(variantQuantityAt(vm, to, num(v.quantity), now) * 1000) / 1000;
    held += qty;
    let rate = receiptRate(vm, to);
    let source = rate != null ? "weighted_receipts" : null;
    if (rate == null) {
      const shared = variantPrice(item, v, (_item, variantId) => poOf(variantId));
      if (shared.price != null) [rate, source] = [shared.price, shared.source];
    }
    if (rate == null && itemRate != null) [rate, source] = [itemRate, "item_rate"];
    if (qty) {
      if (rate == null) unvaluedQty += Math.max(qty, 0);
      else {
        value += qty * rate;
        valuedQty += qty;
        sources.add(source);
      }
    }
    if (qty || vm.some((m) => m.at >= from && m.at <= to)) {
      variants.push({
        _id: id,
        name: (v.combination || []).filter(Boolean).join(" / ") || v.sku || "Variant",
        sku: v.sku || "",
        closing: qty,
        rate: rate == null ? null : Math.round(rate * 100) / 100,
        rateSource: source,
        value: rate == null ? null : Math.round(qty * rate * 100) / 100,
      });
    }
  }
  /* what the variants do not account for — at the item's rate */
  const rest = Math.round((closing - held) * 1000) / 1000;
  if (rest) {
    if (itemRate == null) unvaluedQty += Math.max(rest, 0);
    else {
      value += rest * itemRate;
      valuedQty += rest;
      sources.add(itemSource);
    }
  }

  const rate = valuedQty ? value / valuedQty : itemRate;
  const rateSource = rate == null ? null : sources.size > 1 ? "per_variant" : sources.size === 1 ? [...sources][0] : itemSource;
  const hasValue = rate != null;
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
    rate: hasValue ? Math.round(rate * 100) / 100 : null,
    rateSource,
    value: hasValue ? Math.round(value * 100) / 100 : null,
    openingValue: hasValue ? Math.round(opening * rate * 100) / 100 : null,
    unvaluedQty: round(unvaluedQty),
    variants,
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
    partlyValued: rows.filter((r) => r.rate != null && r.unvaluedQty > 0).length,
  };
}

module.exports = { quantityAt, rawItemRow, productRow, istDay, summarise, unitFactor, latestPoPrices };
