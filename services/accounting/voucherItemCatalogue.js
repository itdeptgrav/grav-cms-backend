"use strict";

/**
 * The item list behind every voucher line's name box (13 Oct 2026, owner).
 *
 * `GET /api/accountant/vouchers/stock-items`   — sales, credit notes, proforma
 * `GET /api/accountant/vouchers/raw-materials` — purchase, debit notes
 *
 * Everything comes from the CMS. Tally is not read anywhere — the owner: "we
 * don't need to depend on Tally; fetch those things from the CMS where they
 * already exist". Picking a row fills the line's name, HSN, unit, price and
 * GST.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * Each list joined the CMS catalogue with the Tally import and dropped a Tally
 * row only when its spelling matched exactly, so items showed twice; the
 * men's and women's version of a garment shared one bare name; inactive
 * products were listed; prices were read from fields where no price is kept;
 * and HSN / GST from fields that do not exist, so every line got a blank HSN
 * and 0% GST — which, being a number, overwrote the line's own rate.
 *
 * ── WHERE EACH FIGURE COMES FROM ────────────────────────────────────────────
 * Sales (a product):
 *   With a customer chosen, that customer's own PI lines come FIRST — the
 *   agreed price and GST, the name as the PI wrote it (with the size). Then
 *   every live product:
 *   price — the size's own price, else the base price (the proforma's rule);
 *           a product whose sizes are priced differently is offered per size.
 *   GST   — the product's own rate; else the rate of the latest sales bill
 *           for it; else the company's garment rule the PI uses (5% below
 *           Rs. 2,499, 18% at or above).
 *   HSN   — the product's; else any PI line for it; else the latest sales
 *           bill for it.
 * Purchase (a raw material):
 *   price — the latest purchase-order rate for that variant; else the
 *           material's latest PO rate; else the primary supplier's price on
 *           the variant; else the latest purchase bill's rate.
 *   GST   — the latest PO line that recorded one; else the latest purchase
 *           bill for it; else UNKNOWN (null) — the line keeps its own rate.
 *   HSN   — the latest purchase bill for it (the CMS records none on a raw
 *           item; its customs tariff code is not the GST HSN).
 * "The latest bill for it" is an accounting voucher line carrying the item's
 * id, or failing that its name — the bills the accountant already entered.
 * Every row says where its figures came from (`priceSource`, `taxRateSource`,
 * `hsnSource`).
 */

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** The PI's slab (lib/salesJourney/quotationMath.js `getGSTPercentage`). */
function garmentSlabRate(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  return p < 2499 ? 5 : 18;
}

function parseTaxRate(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return raw;
  const m = String(raw).match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

/** "30" / "Fancy Corner / 14*20" */
function variantLabelOf(v) {
  if (Array.isArray(v?.attributes) && v.attributes.length)
    return v.attributes.map((a) => a?.value).filter(Boolean).join(" / ");
  if (Array.isArray(v?.combination) && v.combination.length)
    return v.combination.filter(Boolean).join(" / ");
  return "";
}

/**
 * What earlier bills say about an item. `lines` are voucher inventory lines,
 * LATEST FIRST: { stockItemId, stockItemName, rate, taxRate, taxAmount,
 * hsnCode, isCharge }. Each figure is the latest one actually recorded, so a
 * bill with no HSN does not hide an older bill that had one.
 */
function billHistory(lines) {
  const byId = new Map();
  const byName = new Map();
  const take = (map, key, l) => {
    if (!key) return;
    const h = map.get(key) || {};
    if (h.hsnCode == null && l.hsnCode) h.hsnCode = String(l.hsnCode).trim();
    /* A 0 on an old bill is far more often "not entered" than an exempt
       item, so only a recorded rate counts. */
    if (h.taxRate == null && num(l.taxRate)) h.taxRate = Number(l.taxRate);
    if (h.rate == null && num(l.rate)) h.rate = num(l.rate);
    map.set(key, h);
  };
  for (const l of lines || []) {
    if (!l || l.isCharge) continue;
    take(byId, l.stockItemId ? String(l.stockItemId) : null, l);
    take(byName, norm(l.stockItemName), l);
  }
  return {
    /** Figures for an item: by id first, then by any of its names. */
    of(id, names = []) {
      const out = {};
      const fill = (h) => {
        if (!h) return;
        for (const k of ["hsnCode", "taxRate", "rate"]) if (out[k] == null && h[k] != null) out[k] = h[k];
      };
      if (id) fill(byId.get(String(id)));
      for (const n of names) fill(byName.get(norm(n)));
      return out;
    },
  };
}

// ── Sales: finished products ────────────────────────────────────────────────
/**
 * @param products     StockItem documents
 * @param bills        billHistory over SALES voucher lines
 * @param piLines      every PI line, latest first: { stockItemId, itemName,
 *                     hsnCode, unitPrice, gstPercentage, quotationNumber,
 *                     forCustomer (true when the chosen customer's) }
 */
function salesCatalogue(products, bills, piLines = []) {
  const piHsn = new Map(); // product id → an HSN some PI recorded
  for (const l of piLines)
    if (l.stockItemId && l.hsnCode && !piHsn.has(String(l.stockItemId)))
      piHsn.set(String(l.stockItemId), String(l.hsnCode).trim());

  const out = [];
  const live = new Map();
  for (const p of products) {
    if (p.deletedAt || p.isActive === false) continue;
    live.set(String(p._id), p);
  }

  // 1. The chosen customer's PI lines, first: what was agreed with them.
  const seenPi = new Set();
  for (const l of piLines) {
    if (!l.forCustomer) continue;
    const key = `${l.stockItemId}|${norm(l.itemName)}`;
    if (seenPi.has(key)) continue;
    seenPi.add(key);
    const p = live.get(String(l.stockItemId || ""));
    const hist = bills.of(l.stockItemId, [l.itemName, p?.name].filter(Boolean));
    const hsn = l.hsnCode || p?.hsnCode || piHsn.get(String(l.stockItemId)) || hist.hsnCode || "";
    out.push({
      _id: l.stockItemId || null,
      name: l.itemName,
      productName: p?.name || l.description || l.itemName,
      aliases: [],
      hsnCode: hsn,
      hsnSource: l.hsnCode ? "pi" : p?.hsnCode ? "product" : piHsn.get(String(l.stockItemId)) ? "pi" : hist.hsnCode ? "bill" : null,
      baseUnit: p?.unit || "Pcs",
      standardSellingPrice: num(l.unitPrice),
      priceSource: "pi",
      taxRate: typeof l.gstPercentage === "number" ? l.gstPercentage : garmentSlabRate(l.unitPrice),
      taxRateSource: typeof l.gstPercentage === "number" ? "pi" : "slab",
      piNumber: l.quotationNumber || "",
      detail: `On this customer's PI${l.quotationNumber ? " " + l.quotationNumber : ""}`,
      source: "pi",
    });
  }

  // 2. Every live product.
  for (const p of live.values()) {
    const ownRate = parseTaxRate(p.salesTax);
    const hist = bills.of(p._id, [p.name, ...(p.additionalNames || [])]);
    const hsn = p.hsnCode || piHsn.get(String(p._id)) || hist.hsnCode || "";
    const base = {
      _id: p._id,
      aliases: p.additionalNames || [],
      hsnCode: hsn,
      hsnSource: p.hsnCode ? "product" : piHsn.get(String(p._id)) ? "pi" : hist.hsnCode ? "bill" : null,
      baseUnit: p.unit || "Nos",
      standardCost: num(p.baseCost),
      closingQuantity: p.totalQuantityOnHand || 0,
      category: p.category,
      reference: p.reference,
      gender: p.genderCategory || "",
      detail: [p.genderCategory, p.category, p.reference].filter(Boolean).join(" · "),
      source: "cms",
    };
    const rateFor = (price) => {
      if (ownRate !== null) return { taxRate: ownRate, taxRateSource: "product" };
      if (num(hist.taxRate)) return { taxRate: hist.taxRate, taxRateSource: "bill" };
      const slab = garmentSlabRate(price);
      return { taxRate: slab, taxRateSource: slab === null ? null : "slab" };
    };
    const variants = (p.variants || []).filter((v) => v && v.status !== "inactive");
    const priced = variants.filter((v) => num(v.salesPrice));
    const distinct = new Set(priced.map((v) => num(v.salesPrice)));

    if (distinct.size > 1) {
      for (const v of priced) {
        const label = variantLabelOf(v);
        const price = num(v.salesPrice);
        out.push({
          ...base,
          name: label ? `${p.name} · ${label}` : p.name,
          productName: p.name,
          variantId: v._id,
          variantLabel: label,
          standardSellingPrice: price,
          priceSource: "variant",
          ...rateFor(price),
        });
      }
      continue;
    }
    const price = [...distinct][0] || num(p.baseSalesPrice) || num(hist.rate);
    out.push({
      ...base,
      name: p.name,
      productName: p.name,
      standardSellingPrice: price,
      priceSource: distinct.size ? "variant" : num(p.baseSalesPrice) ? "product" : price ? "bill" : null,
      ...rateFor(price),
    });
  }
  return out;
}

// ── Purchase: raw materials ─────────────────────────────────────────────────
/**
 * @param rawItems  RawItem documents
 * @param bills     billHistory over PURCHASE voucher lines
 * @param poLines   purchase-order lines, latest first:
 *                  { rawItem, variantId, unitPrice, gstRate }
 */
function purchaseCatalogue(rawItems, bills, poLines = []) {
  const lastPrice = new Map();
  const lastGst = new Map();
  for (const l of poLines) {
    const raw = String(l.rawItem || "");
    if (!raw) continue;
    const price = num(l.unitPrice);
    if (price) {
      const kv = `${raw}|${l.variantId || ""}`;
      if (!lastPrice.has(kv)) lastPrice.set(kv, price);
      if (!lastPrice.has(`${raw}|`)) lastPrice.set(`${raw}|`, price);
    }
    if (num(l.gstRate) && !lastGst.has(raw)) lastGst.set(raw, Number(l.gstRate));
  }

  const out = [];
  for (const r of rawItems) {
    const raw = String(r._id);
    const nick = (r.vendorNicknames || [])
      .map((v) => (typeof v === "string" ? v : v?.name || v?.nickname || ""))
      .filter(Boolean);
    const hist = bills.of(r._id, [r.name, ...nick]);
    const gst = lastGst.has(raw)
      ? { taxRate: lastGst.get(raw), taxRateSource: "purchase_order" }
      : num(hist.taxRate)
        ? { taxRate: hist.taxRate, taxRateSource: "bill" }
        : { taxRate: null, taxRateSource: null };
    const base = {
      _id: r._id,
      sku: r.sku || "",
      aliases: nick,
      hsnCode: hist.hsnCode || "",
      hsnSource: hist.hsnCode ? "bill" : null,
      baseUnit: r.customUnit || r.unit || "Nos",
      category: r.customCategory || r.category || "",
      detail: [r.customCategory || r.category, r.sku].filter(Boolean).join(" · "),
      source: "cms_raw",
      ...gst,
    };
    const supplierPrice = (v) => {
      const list = Array.isArray(v?.vendorNicknames) ? v.vendorNicknames : [];
      const primary = r.primaryVendor
        ? list.find((n) => String(n.vendor) === String(r.primaryVendor) && num(n.price))
        : null;
      return num((primary || list.find((n) => num(n.price)))?.price);
    };
    const priceOf = (v) => {
      const vid = v?._id ? String(v._id) : "";
      if (vid && lastPrice.has(`${raw}|${vid}`))
        return { standardCost: lastPrice.get(`${raw}|${vid}`), priceSource: "purchase_order" };
      if (lastPrice.has(`${raw}|`))
        return { standardCost: lastPrice.get(`${raw}|`), priceSource: "purchase_order" };
      const sp = v ? supplierPrice(v) : null;
      if (sp) return { standardCost: sp, priceSource: "supplier" };
      if (num(hist.rate)) return { standardCost: hist.rate, priceSource: "bill" };
      return { standardCost: null, priceSource: null };
    };

    const variants = (r.variants || []).filter(Boolean);
    const priced = variants.map((v) => ({ v, ...priceOf(v) }));
    const distinct = new Set(priced.map((p) => p.standardCost).filter(Boolean));
    if (variants.length > 1 && distinct.size > 1) {
      for (const p of priced) {
        const label = variantLabelOf(p.v);
        out.push({
          ...base,
          name: label ? `${r.name} · ${label}` : r.name,
          productName: r.name,
          variantId: p.v._id,
          variantLabel: label,
          standardCost: p.standardCost,
          priceSource: p.priceSource,
        });
      }
      continue;
    }
    const one = priced.find((p) => p.standardCost) || priceOf(variants[0]);
    out.push({
      ...base,
      name: r.name,
      productName: r.name,
      ...(variants.length === 1 ? { variantId: variants[0]._id, variantLabel: variantLabelOf(variants[0]) } : {}),
      standardCost: one.standardCost ?? null,
      priceSource: one.priceSource ?? null,
    });
  }
  return out;
}

/** A search box filter over the built rows (names, aliases, HSN, SKU, reference, PI). */
function matchesQuery(row, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  return [row.name, row.productName, row.hsnCode, row.sku, row.reference, row.piNumber, ...(row.aliases || [])]
    .some((v) => String(v || "").toLowerCase().includes(needle));
}

module.exports = {
  salesCatalogue,
  purchaseCatalogue,
  billHistory,
  garmentSlabRate,
  parseTaxRate,
  variantLabelOf,
  matchesQuery,
  norm,
};
