// services/mrfScanMatch.service.js
//
// SCAN A BARCODE TO MATCH A REQUESTED LINE TO INVENTORY  (14 Oct 2026, owner)
//
// The Store's "Match to Inventory" popup took a typed name or SKU. Now the
// Store person can scan instead: whatever the scanner (or the camera) reads is
// handed here, and the answer is the product — and its variant, when the code
// names one — for the popup to select. The person still checks it and presses
// Confirm Match; nothing here writes.
//
// What a scanned code may be, tried in this order:
//
//   1. One of OUR raw-item labels — `itemid=<id>`, the legacy `RawItem=<id>`,
//      the label's URL (`…/item-info?itemid=<id>`, what a phone camera hands
//      over) or the bare id. Read with the same parser QC uses
//      (`rawMaterialIdOf`), which is the backend's mirror of the Store's own
//      `parseItemQr`. The label names its material AND its variant. A VOIDED
//      label names nothing and is refused with the reason.
//   2. A raw item's own id (the bare 24-hex form, when no label has it).
//   3. A product SKU printed as a barcode: an EXACT match (case and the
//      surrounding spaces ignored) on the item's SKU or on a variant's SKU.
//      Variant SKUs are not unique (20 repeats on 14 Oct 2026), so a code that
//      is several products' SKU is answered with the candidates, never a guess.
//
// A shelf LOCATION label is refused by name. Anything else is "not found",
// said with the code, so the person knows exactly what was read.
"use strict";

const { rawMaterialIdOf } = require("./manufacturing/qcBarcodeIdentity");
const { identityRefusal } = require("./storePurchase/labelIdentity");

const LOCATION = /(?:^|[?&])loc=LOC-/i;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/** What a scanned value is, before anything is read. */
function classifyScan(raw) {
  const code = String(raw ?? "").trim();
  if (!code) return { kind: "empty", code };
  if (LOCATION.test(code)) return { kind: "location", code };
  const id = rawMaterialIdOf(code);
  if (id) return { kind: "label", code, id };
  return { kind: "code", code };
}

const ITEM_FIELDS = "name sku unit customUnit quantity variants";

/**
 * The scanned code as a product.
 *
 * @param {object} p
 * @param {string} p.code              what the scanner read
 * @param {object} p.tenantFilter      the caller's company clause (may hold `$or`)
 * @param {object} p.RawItem, p.Barcode  the models (passed in, for tests)
 * @param {(item) => object} p.format  the popup's product shape
 * @returns {Promise<object>} `{ found: true, via, rawItem, variantId, label? }`
 *   or `{ found: false, reason, message, candidates? }`
 */
async function matchScannedCode({ code, tenantFilter = {}, RawItem, Barcode, format = (x) => x }) {
  const scan = classifyScan(code);
  const scoped = (clause) => ({ $and: [tenantFilter, clause] });

  if (scan.kind === "empty") {
    return { found: false, reason: "EMPTY", message: "Nothing was scanned." };
  }
  if (scan.kind === "location") {
    return {
      found: false, reason: "LOCATION_LABEL",
      message: "That is a shelf location label, not a product. Scan the product's label or barcode.",
    };
  }

  if (scan.kind === "label") {
    const label = await Barcode.findOne(scoped({ _id: scan.id })).lean();
    if (label) {
      if (String(label.identityState || "") === "VOIDED") {
        const refusal = identityRefusal(label);
        return { found: false, reason: "LABEL_VOIDED", message: refusal ? refusal.message : "This label was voided." };
      }
      const item = await RawItem.findOne(scoped({ _id: label.rawItem })).select(ITEM_FIELDS).lean();
      if (!item) {
        return {
          found: false, reason: "MATERIAL_GONE",
          message: `This label is for ${label.rawItemName || "a material"} that is no longer in the inventory.`,
        };
      }
      const variant = label.variantId ? (item.variants || []).find((v) => sameId(v._id, label.variantId)) : null;
      return {
        found: true, via: "label", code: scan.code,
        rawItem: format(item),
        variantId: variant ? String(variant._id) : null,
        /* a variant the label names but the item no longer has: the product is
           still right, the variant must be chosen */
        variantGone: Boolean(label.variantId && !variant),
        label: { id: String(label._id), quantity: label.quantity, unit: label.unit || "" },
      };
    }
    const item = await RawItem.findOne(scoped({ _id: scan.id })).select(ITEM_FIELDS).lean();
    if (item) return { found: true, via: "item-id", code: scan.code, rawItem: format(item), variantId: null };
    return {
      found: false, reason: "NOT_FOUND",
      message: "No raw-item label or product with this code is on record. Check the label, or search by name.",
    };
  }

  /* ── a SKU printed as a barcode ─────────────────────────────────────── */
  const exact = new RegExp(`^\\s*${escapeRegex(scan.code)}\\s*$`, "i");
  const items = await RawItem.find(scoped({ $or: [{ sku: exact }, { "variants.sku": exact }] }))
    .select(ITEM_FIELDS).limit(20).lean();
  const candidates = [];
  for (const item of items) {
    if (exact.test(String(item.sku || ""))) candidates.push({ rawItem: format(item), variantId: null, via: "item-sku" });
    for (const v of item.variants || []) {
      if (exact.test(String(v.sku || ""))) candidates.push({ rawItem: format(item), variantId: String(v._id), via: "variant-sku" });
    }
  }
  if (candidates.length === 1) {
    const [only] = candidates;
    return { found: true, via: only.via, code: scan.code, rawItem: only.rawItem, variantId: only.variantId };
  }
  if (candidates.length > 1) {
    return {
      found: false, reason: "AMBIGUOUS", code: scan.code, candidates,
      message: `“${scan.code}” is the SKU of ${candidates.length} products. Pick the right one.`,
    };
  }
  return {
    found: false, reason: "NOT_FOUND", code: scan.code,
    message: `No product in inventory has the barcode or SKU “${scan.code}”. Check the code, or search by name.`,
  };
}

module.exports = { classifyScan, matchScannedCode };
