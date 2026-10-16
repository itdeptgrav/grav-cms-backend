"use strict";

/**
 * ONE price rule for a raw material's variant, shared by the purchase-side
 * voucher item list (voucherItemCatalogue.purchaseCatalogue → purchase
 * vouchers, debit notes) and the Stock Summary (stockSummary.rawItemRow).
 *
 * 16 Oct 2026, owner: "in the invoices … the stock items need the correct
 * price, and in the stock summary the price must be the same." The two had
 * drifted: the voucher list fell back to ANOTHER variant's purchase-order
 * price before this variant's own supplier price, took a purchase-unit price
 * as a stock-unit one, and preferred the primary supplier where the summary
 * took the first listed one. Both now read their prices here, in this order:
 *
 *   1. the latest purchase-order price for THIS variant      — purchase_order
 *   2. this variant's own supplier price (primary supplier first) — supplier
 *   3. the latest purchase-order price for the material      — purchase_order
 *
 * Every purchase-order price is per STOCK unit: a line in boxes is divided by
 * the pieces in a box, through the unit master the goods receipt converts with
 * (receiptPosting.resolveConversion). A line in a unit that cannot be
 * converted is skipped — never read as if it were per stock unit.
 *
 * What the two screens still mean differently, on purpose: the Stock Summary
 * values stock at what was PAID for it (the weighted average of the variant's
 * receipts) and uses this rule only where nothing was received; a purchase bill
 * is filled with what the supplier charges NOW (this rule). For a variant
 * never received the two figures are the same number.
 */

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
const normUnit = (u) => String(u || "").trim().toLowerCase();

/** Stock units in ONE purchase unit (direct or reverse conversion); 1 for the same unit; null when unknown. */
function unitFactor(units, fromUnit, toUnit) {
  const a = normUnit(fromUnit);
  const b = normUnit(toUnit);
  if (!a || !b || a === b) return 1;
  const find = (name) => (units || []).find((u) => normUnit(u.name) === name) || {};
  const nameOf = (c) => normUnit(c.toUnit && c.toUnit.name !== undefined ? c.toUnit.name : c.toUnit);
  const direct = (find(a).conversions || []).find((c) => nameOf(c) === b);
  if (direct && num(direct.quantity)) return num(direct.quantity);
  const reverse = (find(b).conversions || []).find((c) => nameOf(c) === a);
  if (reverse && num(reverse.quantity)) return 1 / num(reverse.quantity);
  return null;
}

/**
 * The latest purchase-order price per stock unit, by material and by variant.
 * `orders` newest first, lines { rawItem, variantId, unit, unitPrice };
 * `unitOf(rawItemId)` → the material's stock unit.
 * → (rawItemId, variantId | null) → price or null.
 */
function latestPoPrices(orders, unitOf, units) {
  const byVariant = new Map();
  const byItem = new Map();
  for (const o of orders || [])
    for (const l of o.items || []) {
      const item = l.rawItem ? String(l.rawItem) : null;
      const price = num(l.unitPrice);
      if (!item || !price) continue;
      const f = unitFactor(units, l.unit, unitOf(item));
      if (!f) continue;
      const perStock = price / f;
      if (!byItem.has(item)) byItem.set(item, perStock);
      const key = `${item}:${l.variantId ? String(l.variantId) : ""}`;
      if (l.variantId && !byVariant.has(key)) byVariant.set(key, perStock);
    }
  return (rawItemId, variantId) => {
    const item = String(rawItemId);
    return (variantId ? byVariant.get(`${item}:${variantId}`) : byItem.get(item)) || null;
  };
}

/** A variant's own supplier price: the material's primary supplier first, else the first priced one. */
function supplierPrice(item, variant) {
  const list = Array.isArray(variant && variant.vendorNicknames) ? variant.vendorNicknames : [];
  const primary = item && item.primaryVendor
    ? list.find((n) => String(n.vendor) === String(item.primaryVendor) && num(n.price))
    : null;
  return num((primary || list.find((n) => num(n.price)) || {}).price);
}

/**
 * The price of one variant by the shared rule → { price, source } (both null
 * when nothing is recorded). `poPrice` is from latestPoPrices.
 */
function variantPrice(item, variant, poPrice) {
  const id = variant && variant._id ? String(variant._id) : null;
  const po = typeof poPrice === "function" ? poPrice : () => null;
  if (id && num(po(item._id, id))) return { price: num(po(item._id, id)), source: "purchase_order" };
  const sp = supplierPrice(item, variant);
  if (sp) return { price: sp, source: "supplier" };
  if (num(po(item._id, null))) return { price: num(po(item._id, null)), source: "purchase_order" };
  return { price: null, source: null };
}

module.exports = { unitFactor, latestPoPrices, supplierPrice, variantPrice };
