"use strict";

/**
 * The item list behind every voucher line's name box (13 Oct 2026).
 *
 * `GET /api/accountant/vouchers/stock-items`   — sales, credit notes, proforma
 * `GET /api/accountant/vouchers/raw-materials` — purchase, debit notes
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────
 * 1. Every item twice. Each list joined the CMS catalogue (StockItem /
 *    RawItem) with the accountant's Acc_StockItem — the Tally import — and
 *    dropped a Tally row only when its name matched EXACTLY, case aside.
 *    Tally spells the same goods its own way ("SuitingFabric 80/20 PC Plain"
 *    vs "SUITING FABRIC 80/20 PC PLAIN"), so both were offered. The sales
 *    list also listed inactive and deleted products, and offered the men's
 *    and women's version of a garment under one bare name.
 * 2. Prices from fields that are not where the price lives. A raw item has no
 *    `basePrice`: what it costs is on its purchase orders, and per supplier on
 *    each variant. A product's price is per size (`variants[].salesPrice`);
 *    `baseSalesPrice` is only the fallback the proforma itself uses.
 * 3. HSN and GST from fields that do not exist. A raw item has no `hsnCode`
 *    or `gstRate` at all, and no product has `salesTax` set, so every line
 *    arrived with HSN blank and GST 0% — and because 0 is a number, the
 *    voucher forms overwrote their own rate with it.
 *
 * ── WHERE EACH FIGURE COMES FROM NOW ────────────────────────────────────────
 * Sales (a product):
 *   price — the size's own `salesPrice`, else `baseSalesPrice` (the proforma's
 *           `rateOf`). A product whose sizes are priced differently is offered
 *           once per size, so the price on the line is the size's price.
 *   GST   — the product's own rate when recorded, else the Tally item's, else
 *           the company's garment rule the proforma uses: 5% below Rs. 2,499,
 *           18% at or above (lib/salesJourney/quotationMath.js).
 *   HSN   — the product's, else the Tally item's.
 * Purchase (a raw material):
 *   price — the latest purchase-order rate for that material and variant,
 *           else that material's latest PO rate, else the primary supplier's
 *           price on the variant, else any supplier's.
 *   GST   — the Tally item's, else the latest PO line that recorded a rate.
 *           Otherwise UNKNOWN (null), never 0: the form keeps its own rate.
 *   HSN   — the Tally item's. The CMS records none for raw materials (the
 *           customs tariff code on a raw item is not the GST HSN).
 * Every row says where its figures came from (`priceSource`, `taxRateSource`,
 * `hsnSource`), and a figure nobody recorded is null, not a guess.
 *
 * A Tally item that matches no CMS item is still offered — it may be a
 * service or a material bought only through accounts.
 */

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** The proforma's slab (lib/salesJourney/quotationMath.js `getGSTPercentage`). */
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

/** "Size: 30" / "Fancy Corner / 14*20" */
function variantLabelOf(v) {
  if (Array.isArray(v?.attributes) && v.attributes.length)
    return v.attributes.map((a) => a?.value).filter(Boolean).join(" / ");
  if (Array.isArray(v?.combination) && v.combination.length)
    return v.combination.filter(Boolean).join(" / ");
  return "";
}

/**
 * Index Tally items by every spelling they carry, so a CMS item can find its
 * twin by its own name or any alias. Returns { find(names) → tally row, used }.
 */
function tallyIndex(tallyRows) {
  const by = new Map();
  for (const t of tallyRows) {
    for (const n of [t.name, ...(t.aliases || [])]) {
      const k = norm(n);
      if (k && !by.has(k)) by.set(k, t);
    }
  }
  const used = new Set();
  return {
    find(names) {
      for (const n of names) {
        const t = by.get(norm(n));
        if (t) {
          used.add(String(t._id));
          return t;
        }
      }
      return null;
    },
    used,
  };
}

const tallyOnlyRow = (t, priceField) => ({
  _id: t._id,
  name: t.name,
  aliases: t.aliases || [],
  hsnCode: t.hsnCode || "",
  baseUnit: t.baseUnit || "Nos",
  taxRate: typeof t.taxRate === "number" ? t.taxRate : null,
  [priceField]: num(t[priceField]),
  hsnSource: t.hsnCode ? "tally" : null,
  taxRateSource: typeof t.taxRate === "number" ? "tally" : null,
  priceSource: num(t[priceField]) ? "tally" : null,
  source: "tally",
  detail: "Accounts only",
});

// ── Sales: finished products ────────────────────────────────────────────────
function salesCatalogue(products, tallyRows) {
  const tally = tallyIndex(tallyRows);
  const out = [];
  for (const p of products) {
    if (p.deletedAt || p.isActive === false) continue;
    const twin = tally.find([p.name, ...(p.additionalNames || [])]);
    const ownRate = parseTaxRate(p.salesTax);
    const hsn = p.hsnCode || twin?.hsnCode || "";
    const detail = [p.genderCategory, p.category, p.reference].filter(Boolean).join(" · ");
    const base = {
      _id: p._id,
      aliases: p.additionalNames || [],
      hsnCode: hsn,
      hsnSource: p.hsnCode ? "product" : twin?.hsnCode ? "tally" : null,
      baseUnit: p.unit || twin?.baseUnit || "Nos",
      standardCost: num(p.baseCost),
      closingQuantity: p.totalQuantityOnHand || 0,
      category: p.category,
      reference: p.reference,
      gender: p.genderCategory || "",
      detail,
      source: twin ? "cms+tally" : "cms",
    };
    const rateFor = (price) => {
      if (ownRate !== null) return { taxRate: ownRate, taxRateSource: "product" };
      if (twin && typeof twin.taxRate === "number" && twin.taxRate > 0)
        return { taxRate: twin.taxRate, taxRateSource: "tally" };
      const slab = garmentSlabRate(price);
      return { taxRate: slab, taxRateSource: slab === null ? null : "slab" };
    };

    const variants = (p.variants || []).filter((v) => v && v.status !== "inactive");
    const priced = variants.filter((v) => num(v.salesPrice));
    const distinct = new Set(priced.map((v) => num(v.salesPrice)));

    if (distinct.size > 1) {
      /* Sizes priced differently: one row per size, so the line takes the
         price of the size sold. The line still points at the product. */
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
    const price = [...distinct][0] || num(p.baseSalesPrice);
    out.push({
      ...base,
      name: p.name,
      productName: p.name,
      standardSellingPrice: price,
      priceSource: distinct.size ? "variant" : price ? "product" : null,
      ...rateFor(price),
    });
  }
  for (const t of tallyRows)
    if (!tally.used.has(String(t._id))) out.push(tallyOnlyRow(t, "standardSellingPrice"));
  return out;
}

// ── Purchase: raw materials ─────────────────────────────────────────────────
/**
 * `poLines` is the latest-first list of purchase-order lines:
 * { rawItem, variantId, unitPrice, gstRate }.
 */
function purchaseCatalogue(rawItems, tallyRows, poLines) {
  const tally = tallyIndex(tallyRows);
  const lastPrice = new Map(); // "raw|variant" and "raw|" → price
  const lastGst = new Map(); // "raw" → rate
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
    const twin = tally.find([r.name, ...nick]);
    const gst =
      twin && typeof twin.taxRate === "number" && twin.taxRate > 0
        ? { taxRate: twin.taxRate, taxRateSource: "tally" }
        : lastGst.has(raw)
          ? { taxRate: lastGst.get(raw), taxRateSource: "purchase_order" }
          : { taxRate: null, taxRateSource: null };
    const base = {
      _id: r._id,
      sku: r.sku || "",
      aliases: nick,
      hsnCode: twin?.hsnCode || "",
      hsnSource: twin?.hsnCode ? "tally" : null,
      baseUnit: r.customUnit || r.unit || twin?.baseUnit || "Nos",
      category: r.customCategory || r.category || "",
      detail: [r.customCategory || r.category, r.sku].filter(Boolean).join(" · "),
      source: twin ? "cms_raw+tally" : "cms_raw",
      ...gst,
    };
    const supplierPrice = (v) => {
      const list = Array.isArray(v?.vendorNicknames) ? v.vendorNicknames : [];
      const primary = r.primaryVendor
        ? list.find((n) => String(n.vendor) === String(r.primaryVendor) && num(n.price))
        : null;
      const any = list.find((n) => num(n.price));
      return num((primary || any)?.price);
    };
    const priceOf = (v) => {
      const vid = v?._id ? String(v._id) : "";
      if (vid && lastPrice.has(`${raw}|${vid}`))
        return { standardCost: lastPrice.get(`${raw}|${vid}`), priceSource: "purchase_order" };
      const sp = v ? supplierPrice(v) : null;
      if (sp) return { standardCost: sp, priceSource: "supplier" };
      if (lastPrice.has(`${raw}|`))
        return { standardCost: lastPrice.get(`${raw}|`), priceSource: "purchase_order" };
      if (twin && num(twin.standardCost))
        return { standardCost: num(twin.standardCost), priceSource: "tally" };
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
    const one = priced.find((p) => p.standardCost) || { ...priceOf(variants[0]) };
    out.push({
      ...base,
      name: r.name,
      productName: r.name,
      ...(variants.length === 1 ? { variantId: variants[0]._id, variantLabel: variantLabelOf(variants[0]) } : {}),
      standardCost: one.standardCost ?? null,
      priceSource: one.priceSource ?? null,
    });
  }
  for (const t of tallyRows)
    if (!tally.used.has(String(t._id))) out.push(tallyOnlyRow(t, "standardCost"));
  return out;
}

/** A search box filter over the built rows (names, aliases, HSN, SKU, reference). */
function matchesQuery(row, q) {
  if (!q) return true;
  const needle = String(q).toLowerCase();
  return [row.name, row.productName, row.hsnCode, row.sku, row.reference, ...(row.aliases || [])]
    .some((v) => String(v || "").toLowerCase().includes(needle));
}

module.exports = {
  salesCatalogue,
  purchaseCatalogue,
  garmentSlabRate,
  parseTaxRate,
  variantLabelOf,
  matchesQuery,
  norm,
};
