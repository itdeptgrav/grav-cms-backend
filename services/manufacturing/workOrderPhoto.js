// services/manufacturing/workOrderPhoto.js
//
// THE PHOTO FOR A WORK ORDER'S PRODUCT.
//
// Measured 24 Sep 2026: of 128 stock items, 8 have a product-level image and
// 105 have VARIANT images. So a screen that reads `stockItem.images[0]` — or
// no image at all, as the Packaging "Orders" cards did — shows a blank for
// almost everything, while the photos are sitting one level down.
//
// Resolved in the order that is most specific first:
//   1. the variant the work order names (`variantId`)        — 97 of 152
//   2. the variant whose attributes equal the work order's     — +5
//      (older work orders carry attributes but a stale or no variantId)
//   3. the product's own image
//   4. any variant's image — the right product, if not the right colour
// Anything else has no photo anywhere in the item master (26 of 152) and the
// caller shows a placeholder.
//
// Resolved at read time and never stored: a photo replaced in the item master
// shows on every screen that opens afterwards.

"use strict";

const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

const attrKey = (attrs) => (Array.isArray(attrs) ? attrs : [])
  .map((a) => `${String(a?.name ?? "").trim().toLowerCase()}=${String(a?.value ?? "").trim().toLowerCase()}`)
  .filter((s) => s !== "=")
  .sort()
  .join("|");

function photoFor(item, { variantId, variantAttributes } = {}) {
  if (!item) return null;
  const variants = Array.isArray(item.variants) ? item.variants : [];
  const byId = variantId ? variants.find((v) => String(v._id) === String(variantId)) : null;
  if (byId?.images?.[0]) return byId.images[0];
  const want = attrKey(variantAttributes);
  if (want) {
    const byAttr = variants.find((v) => attrKey(v.attributes) === want);
    if (byAttr?.images?.[0]) return byAttr.images[0];
  }
  if (item.images?.[0]) return item.images[0];
  return variants.find((v) => v.images?.[0])?.images?.[0] || null;
}

/**
 * Photos for a list of rows, one StockItem read for all of them.
 *
 * @param {Array<{stockItemId, variantId?, variantAttributes?}>} rows
 * @returns {Promise<Array<string|null>>} one URL (or null) per row, same order
 */
async function resolvePhotos(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(list.map((r) => r?.stockItemId && String(r.stockItemId)).filter(Boolean))];
  if (!ids.length) return list.map(() => null);
  const items = await StockItem.find({ _id: { $in: ids } })
    .select("images variants._id variants.images variants.attributes")
    .lean()
    .catch(() => []);
  const byId = new Map(items.map((i) => [String(i._id), i]));
  return list.map((r) => (r?.stockItemId ? photoFor(byId.get(String(r.stockItemId)), r) : null));
}

/**
 * The variant a work order is making, as attributes.
 *
 * The work order's own `variantAttributes` when it has them. Otherwise the
 * variant its `variantId` names. Otherwise — only when the product has exactly
 * ONE variant — that variant, flagged `inferred`: a product with one variant
 * can only be that variant, but the work order never said so (measured
 * 24 Sep 2026: the PPC walkthrough polo's work order carries no variant while
 * its product has exactly one, Size M). With several variants and nothing on
 * the work order the answer is honestly unknown, and says so.
 *
 * @returns {Promise<Array<{attributes: Array<{name,value}>, inferred: boolean}>>}
 */
async function resolveVariantAttributes(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const need = list.filter((r) => !(Array.isArray(r?.variantAttributes) && r.variantAttributes.length) && r?.stockItemId);
  const ids = [...new Set(need.map((r) => String(r.stockItemId)))];
  const items = ids.length
    ? await StockItem.find({ _id: { $in: ids } }).select("variants._id variants.attributes").lean().catch(() => [])
    : [];
  const byId = new Map(items.map((i) => [String(i._id), i]));
  return list.map((r) => {
    if (Array.isArray(r?.variantAttributes) && r.variantAttributes.length) return { attributes: r.variantAttributes, inferred: false };
    const item = r?.stockItemId ? byId.get(String(r.stockItemId)) : null;
    const variants = item?.variants || [];
    const named = r?.variantId ? variants.find((v) => String(v._id) === String(r.variantId)) : null;
    if (named?.attributes?.length) return { attributes: named.attributes, inferred: false };
    if (variants.length === 1 && variants[0].attributes?.length) return { attributes: variants[0].attributes, inferred: true };
    return { attributes: [], inferred: false };
  });
}

/** "Size: M, Colour: Navy" — plus a dagger when the variant was inferred. */
function variantText({ attributes, inferred } = {}) {
  const s = (attributes || [])
    .filter((a) => a && (a.value ?? "") !== "")
    .map((a) => (a.name ? `${a.name}: ${a.value}` : String(a.value)))
    .join(", ");
  if (!s) return "Not specified";
  return inferred ? `${s} †` : s;
}

module.exports = { resolvePhotos, photoFor, resolveVariantAttributes, variantText };
