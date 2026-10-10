// services/mail/orderLinesMail.js
//
// THE PRODUCT, ITS VARIANTS AND ITS PHOTO, IN AN EMAIL  (9 Oct 2026, owner)
//
// "The variant-wise detail is not showing properly … and the product photo
// is not coming." Two causes, both here:
//
//   1. Every product photo in this database lives on a VARIANT
//      (`StockItem.variants[].images`, 2 153 URLs); the root `images[]` is
//      empty on every product. The production mails and the MO sheet read the
//      root only, so they showed "no photo" for everything.
//   2. The production mails listed a product once with its sizes squeezed
//      into one line, or not at all, and the work-order rows named the
//      product without its size.
//
// `loadStock` reads the images once per mail; `photoFor` picks the variant
// matched by attributes, else the first variant with a photo, else the root;
// `productLinesHtml` draws one product row — thumbnail, name, reference, then
// ONE LINE PER VARIANT ("Size: 30 × 10 pcs") — and `workOrderRowsHtml` names
// the variant on every work-order row. Every mail that lists an order's lines
// reads these, so they cannot drift apart again. Outlook-safe table HTML.
"use strict";

const mongoose = require("mongoose");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));
const norm = (s) => String(s ?? "").trim().toLowerCase();
const model = (name, path) => (mongoose.models[name] || require(path));
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");

/** A mail-sized thumbnail: Cloudinary is re-encoded inline, anything else is used as is. */
function thumb(url, w = 120) {
  const raw = typeof url === "string" ? url : url?.url || "";
  if (!raw) return null;
  const m = raw.match(/^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(.*)$/);
  return m ? `${m[1]}c_fill,w_${w},h_${w},q_auto,f_jpg/${m[2]}` : raw;
}

/** The images of the product's variant matched by attributes, else the first variant with any, else the root. */
function photoFor(stock, attributes = []) {
  if (!stock) return null;
  const attrs = (Array.isArray(attributes) ? attributes : []).filter((a) => a && a.value != null);
  const variants = Array.isArray(stock.variants) ? stock.variants : [];
  if (attrs.length) {
    const matched = variants.find((v) => attrs.every((ia) =>
      (v.attributes || []).some((va) => norm(va.name) === norm(ia.name) && norm(va.value) === norm(ia.value))));
    if (matched?.images?.[0]) return matched.images[0];
  }
  for (const v of variants) if (v?.images?.[0]) return v.images[0];
  return (stock.images || [])[0] || null;
}

/** Map of stock-item id → { name, reference, images, variants[{attributes, images}] }. Never throws. */
async function loadStock(ids = []) {
  const wanted = [...new Set((ids || []).map((id) => String(id?._id || id || "")).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!wanted.length) return new Map();
  try {
    const docs = await StockItem().find({ _id: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("name reference images variants.attributes variants.images").lean();
    return new Map(docs.map((d) => [String(d._id), d]));
  } catch (err) {
    console.warn("[orderLinesMail] stock photos unavailable:", err?.message || err);
    return new Map();
  }
}

/** "Size: 30 · Colour: Navy" — never "base" or blank for a real variant. */
function variantLabel(attributes = []) {
  return (Array.isArray(attributes) ? attributes : [])
    .filter((a) => a && a.value != null && String(a.value).trim())
    .map((a) => (a.name ? `${esc(a.name)}: ${esc(a.value)}` : esc(a.value)))
    .join(" &middot; ");
}

const thumbCell = (url) => (url
  ? `<td style="padding:8px;border-bottom:1px solid #eee;width:64px;vertical-align:top"><img src="${esc(thumb(url))}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:4px;border:1px solid #e2e8f0" /></td>`
  : `<td style="padding:8px;border-bottom:1px solid #eee;width:64px;vertical-align:top"><div style="width:56px;height:56px;border-radius:4px;border:1px solid #e2e8f0;background:#f8fafc"></div></td>`);

/**
 * One row per product: photo | name, reference, one line per variant | total.
 * @param {Array} items  CustomerRequest.items (stockItemId, stockItemName, stockItemReference, totalQuantity, variants[{attributes, quantity}])
 * @param {Map} stock    from loadStock
 */
function productLinesHtml(items = [], stock = new Map()) {
  const rows = (items || []).map((i) => {
    const s = stock.get(String(i.stockItemId?._id || i.stockItemId || ""));
    const variants = (i.variants || []).filter((v) => (v?.quantity || 0) > 0 || (v?.attributes || []).length);
    const photo = photoFor(s, variants[0]?.attributes) || (i.stockItemImages || [])[0] || null;
    const variantLines = variants.map((v) => {
      const label = variantLabel(v.attributes) || "Standard";
      return `<div style="font-size:12px;color:#374151;margin-top:3px"><span style="color:#64748b">${label}</span> &nbsp;&times;&nbsp; <strong>${esc(v.quantity || 0)} pcs</strong></div>`;
    }).join("");
    const total = i.totalQuantity || variants.reduce((n, v) => n + (v.quantity || 0), 0);
    return `
      <tr>
        ${thumbCell(photo)}
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">
          <strong>${esc(i.stockItemName || s?.name || "Unnamed product")}</strong>
          ${(i.stockItemReference || s?.reference) ? `<br><span style="font-size:11px;color:#888;font-family:monospace">${esc(i.stockItemReference || s?.reference)}</span>` : ""}
          ${variantLines}
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;white-space:nowrap;vertical-align:top"><strong>${esc(total)} pcs</strong>${variants.length > 1 ? `<br><span style="font-size:11px;color:#888">${variants.length} variants</span>` : ""}</td>
      </tr>`;
  }).join("");
  if (!rows) return "";
  return `
    <h4 style="margin:20px 0 6px;font-size:13px">Products (${items.length})</h4>
    <table style="width:100%;border-collapse:collapse;border:1px solid #eee">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:6px 8px;text-align:left;font-size:11px;color:#666" colspan="2">PRODUCT &middot; VARIANTS</th>
        <th style="padding:6px 8px;text-align:right;font-size:11px;color:#666">QTY</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Work-order rows: number | product + variant | qty | status. `label(wo)` names the order. */
function workOrderRowsHtml(workOrders = [], stock = new Map(), label = (wo) => wo?.workOrderNumber || "—", limit = 40) {
  return (workOrders || []).slice(0, limit).map((wo) => {
    const s = stock.get(String(wo.stockItemId?._id || wo.stockItemId || ""));
    const variant = variantLabel(wo.variantAttributes || wo.attributes || []);
    const photo = photoFor(s, wo.variantAttributes || wo.attributes || []);
    return `
      <tr>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:12px;vertical-align:top">${esc(label(wo))}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">
          ${photo ? `<img src="${esc(thumb(photo, 80))}" width="28" height="28" alt="" style="display:inline-block;width:28px;height:28px;object-fit:cover;border-radius:3px;border:1px solid #e2e8f0;vertical-align:middle;margin-right:6px" />` : ""}${esc(wo.stockItemName || wo.productName || s?.name || "—")}
          ${variant ? `<br><span style="font-size:11px;color:#64748b">${variant}</span>` : ""}
        </td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;text-align:right;vertical-align:top">${esc(wo.quantity ?? wo.totalQuantity ?? "—")}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:12px;vertical-align:top">${esc(String(wo.status || "pending").replace(/_/g, " "))}</td>
      </tr>`;
  }).join("");
}

module.exports = { thumb, photoFor, loadStock, variantLabel, productLinesHtml, workOrderRowsHtml, esc };
