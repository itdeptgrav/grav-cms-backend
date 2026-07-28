// services/mrfUnits.service.js
//
// ── The unit rule for MRFs ────────────────────────────────────────────────
// The unit the REQUESTER picked (item.unit) is authoritative. Every quantity
// shown, entered or compared anywhere in the MRF flow — requested, available,
// issued, returned, remaining — is expressed in that unit.
//
// item.baseUnit is only the catalogue's own unit. Conversion to it happens at
// exactly one boundary: the moment stock is added to or deducted from RawItem.
//
// Before this module, `/:id/stock-check` returned RawItem.quantity (base unit)
// while the store UI printed it against item.unit, and `/approve` compared a
// requested qty in packets against an available qty in pieces. Both read as
// wrong numbers to the store person. Anything needing "how much is available"
// must now go through availableInRequestedUnit / enrichItemsWithStock.

const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../models/CMS_Models/Inventory/Configurations/Unit");

/** Convert a quantity between two named units. Falls back to identity. */
async function convertQty(qty, fromUnit, toUnit) {
  if (qty == null || !fromUnit || !toUnit || fromUnit === toUnit) return qty;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const d = (fromDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === toUnit);
      if (d?.quantity) return qty * d.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const r = (toDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === fromUnit);
      if (r?.quantity) return qty / r.quantity;
    }
    return qty;
  } catch { return qty; }
}

/** name → [{ name, factor }] in both directions, for the requester's unit picker. */
async function buildUnitConversions() {
  const units = await Unit.find({}).populate("conversions.toUnit", "name").lean();
  const map = {};
  units.forEach(u => {
    if (!map[u.name]) map[u.name] = [];
    (u.conversions || []).forEach(c => {
      const toName = c.toUnit?.name || c.toUnit;
      if (!toName || !c.quantity || c.quantity <= 0) return;
      if (!map[u.name].some(x => x.name === toName))
        map[u.name].push({ name: toName, factor: c.quantity });
      if (!map[toName]) map[toName] = [];
      if (!map[toName].some(x => x.name === u.name))
        map[toName].push({ name: u.name, factor: +(1 / c.quantity).toFixed(8) });
    });
  });
  return map;
}

/** Stock on hand for an MRF line, in the line's own base unit. */
function availableInBaseUnit(rawDoc, item) {
  if (!rawDoc) return null;
  if (item.variantId && Array.isArray(rawDoc.variants) && rawDoc.variants.length) {
    const v = rawDoc.variants.find(vv => String(vv._id) === String(item.variantId));
    if (v) return v.quantity || 0;
    // The variant the requester chose no longer exists on the product.
    return 0;
  }
  if (!item.variantId && item.variantCombination?.length && rawDoc.variants?.length) {
    const v = rawDoc.variants.find(vv =>
      vv.combination?.length === item.variantCombination.length &&
      vv.combination.every((val, i) => val === item.variantCombination[i])
    );
    if (v) return v.quantity || 0;
  }
  return rawDoc.quantity || 0;
}

/** Stock on hand for an MRF line, converted into the REQUESTER's unit. */
async function availableInRequestedUnit(rawDoc, item) {
  const base = availableInBaseUnit(rawDoc, item);
  if (base === null) return null;
  const from = item.baseUnit || rawDoc?.customUnit || rawDoc?.unit || "";
  if (!from || !item.unit || from === item.unit) return base;
  const converted = await convertQty(base, from, item.unit);
  return converted == null ? base : converted;
}

const round = (n) => (n == null ? null : Math.round(Number(n) * 1000) / 1000);

/**
 * Attach live stock to every line of an MRF, all figures in the line's own
 * requester-chosen unit.
 *
 * Returns lines with:
 *   available          stock on hand, in item.unit  ← what the UI must print
 *   availableBase      the same figure in item.baseUnit, for reference
 *   remainingToIssue   still owed, in item.unit
 *   shortfall          how much of the remainder cannot be covered
 *   stockStatus        ok | low | shortage | out_of_stock | unknown
 */
async function enrichItemsWithStock(items = []) {
  const ids = [...new Set(items.map(i => i.rawItem?.toString()).filter(Boolean))];
  const docs = ids.length
    ? await RawItem.find({ _id: { $in: ids } })
      .select("name quantity unit customUnit minStock variants").lean()
    : [];
  const byId = new Map(docs.map(d => [String(d._id), d]));

  const out = [];
  for (const item of items) {
    const doc = byId.get(item.rawItem?.toString());
    const availableBase = availableInBaseUnit(doc, item);
    const available = round(await availableInRequestedUnit(doc, item));

    // minStock lives in base units — convert it too, or the "low stock"
    // threshold gets compared against a number in a different unit.
    let minStock = 0;
    if (doc) {
      const variantMin = item.variantId
        ? doc.variants?.find(v => String(v._id) === String(item.variantId))?.minStock
        : undefined;
      const rawMin = variantMin ?? doc.minStock ?? 0;
      const from = item.baseUnit || doc.customUnit || doc.unit || "";
      minStock = round(
        from && item.unit && from !== item.unit
          ? await convertQty(rawMin, from, item.unit)
          : rawMin
      ) || 0;
    }

    const requestedQty = item.requestedQty || 0;
    const issuedQty = item.issuedQty || 0;
    const dead = ["REJECTED", "UNFULFILLED"].includes(item.itemStatus);
    // Compare stock against what is still owed, not the original full request —
    // once part has been issued, stock only needs to cover the remainder.
    const remainingToIssue = dead ? 0 : Math.max(0, round(requestedQty - issuedQty));
    const shortfall = available !== null ? Math.max(0, round(remainingToIssue - available)) : null;

    let stockStatus = "unknown";
    if (remainingToIssue <= 0) stockStatus = "ok";
    else if (available !== null) {
      if (available <= 0) stockStatus = "out_of_stock";
      else if (shortfall > 0) stockStatus = "shortage";
      else if (available - remainingToIssue <= minStock) stockStatus = "low";
      else stockStatus = "ok";
    }

    out.push({
      ...item,
      available,          // ← in item.unit
      availableBase,      // ← in item.baseUnit
      minStock,
      shortfall,
      remainingToIssue,
      stockStatus,
      returnedQty: item.returnedQty || 0,
    });
  }
  return out;
}

module.exports = {
  convertQty,
  buildUnitConversions,
  availableInBaseUnit,
  availableInRequestedUnit,
  enrichItemsWithStock,
};
