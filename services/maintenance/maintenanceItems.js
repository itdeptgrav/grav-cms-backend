// services/maintenance/maintenanceItems.js
//
// MAINTENANCE'S VIEW OF THE ITEM MASTER — the Store's own RawItem records,
// filtered to the types Maintenance Settings allows. Nothing is copied: every
// row here IS the Store's item, read, never written. Turning a type off in
// Settings only removes it from this view; the item is untouched.
//
// The filter is applied HERE, on the server, for every list, detail and
// write. A Maintenance user cannot widen it from the browser.
"use strict";

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const { NOT_CLASSIFIED } = require("./maintenanceSettings");

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const exactNoCase = (t) => new RegExp(`^${escape(t)}$`, "i");

/**
 * The Mongo filter for "a type in this list". Pure. Named types match without
 * case (the Store's form can save "asset"); NOT_CLASSIFIED matches an item
 * with no type at all — missing, null or "".
 */
function visibilityFilter(types) {
  const list = Array.isArray(types) ? types : [];
  const named = list.filter((t) => t !== NOT_CLASSIFIED);
  const ors = [];
  if (named.length) ors.push({ productType: { $in: named.map(exactNoCase) } });
  if (list.includes(NOT_CLASSIFIED)) ors.push({ productType: { $in: [null, ""] } });
  return ors.length ? { $or: ors } : { _id: { $in: [] } };
}

/** The visible type an item falls under, as the settings name it. */
function typeOf(item, visible) {
  const t = String(item?.productType || "").trim();
  if (!t) return NOT_CLASSIFIED;
  return visible.find((v) => v.toLowerCase() === t.toLowerCase()) || t;
}

const LIST_FIELDS = "name sku category customCategory productType unit customUnit quantity minStock maxStock status usedAs updatedAt variants.quantity variants.combination";

function itemRow(i, visible) {
  return {
    id: String(i._id),
    name: i.name,
    sku: i.sku || "",
    type: typeOf(i, visible),
    category: i.customCategory || i.category || "",
    unit: i.customUnit || i.unit || "",
    quantity: typeof i.quantity === "number" ? i.quantity : null,
    minStock: i.minStock ?? null,
    status: i.status || "",
    usedAs: i.usedAs || "",
    variants: (i.variants || []).length,
    updatedAt: i.updatedAt || null,
  };
}

/** Every visible item, optionally narrowed to one visible type and a search. */
async function listItems(visible, { search = "", type = "" } = {}) {
  const clauses = [visibilityFilter(visible)];
  /* A type the settings do not allow narrows to nothing — never past the view. */
  if (type) {
    const allowed = visible.find((v) => v.toLowerCase() === String(type).toLowerCase());
    clauses.push(allowed ? visibilityFilter([allowed]) : { _id: { $in: [] } });
  }
  const needle = String(search || "").trim();
  if (needle) {
    const rx = new RegExp(escape(needle), "i");
    clauses.push({ $or: [{ name: rx }, { sku: rx }, { category: rx }, { customCategory: rx }, { productType: rx }] });
  }
  const rows = await RawItem.find({ $and: clauses }).select(LIST_FIELDS).sort({ name: 1 }).limit(1000).lean();

  /* Counts per visible type, over the WHOLE view (not the search), so the
     filter chips say how many each type holds. */
  const counts = {};
  for (const t of visible) counts[t] = await RawItem.countDocuments(visibilityFilter([t]));
  return { items: rows.map((r) => itemRow(r, visible)), counts };
}

/** Where an item's stock sits, from the Store's own location balances. */
async function locationsOf(itemId) {
  const rows = await LocationBalance.find({ itemId, locationId: { $ne: null }, quantity: { $gt: 0 } })
    .select("warehouseId locationId variantId quantity").lean();
  if (!rows.length) return [];
  const warehouses = await Warehouse.find({ _id: { $in: [...new Set(rows.map((r) => String(r.warehouseId)))] } })
    .select("name code locations._id locations.code locations.name").lean();
  const byLocation = new Map();
  for (const w of warehouses) for (const l of w.locations || []) byLocation.set(String(l._id), { warehouse: w.code || w.name, code: l.code, name: l.name });
  return rows.map((r) => ({ ...(byLocation.get(String(r.locationId)) || { warehouse: "", code: "", name: "" }), quantity: r.quantity }));
}

/** One visible item, or null when it does not exist or is not in the view. */
async function visibleItem(id, visible) {
  if (!mongoose.isValidObjectId(String(id || ""))) return null;
  return RawItem.findOne({ $and: [{ _id: id }, visibilityFilter(visible)] }).lean();
}

function itemDetailView(i, visible, locations) {
  return {
    ...itemRow(i, visible),
    description: i.description || "",
    maxStock: i.maxStock ?? null,
    variantList: (i.variants || []).map((v) => ({
      id: String(v._id),
      combination: (v.combination || []).join(" · "),
      sku: v.sku || "",
      quantity: typeof v.quantity === "number" ? v.quantity : null,
    })),
    locations,
  };
}

module.exports = { visibilityFilter, typeOf, listItems, visibleItem, itemDetailView, locationsOf };
