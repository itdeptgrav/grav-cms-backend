"use strict";

const LocationBalance = require("../models/CMS_Models/Inventory/Operations/LocationBalance");
const Warehouse = require("../models/CMS_Models/Inventory/Configurations/Warehouse");
const tenantContext = require("./storePurchase/tenantContext.service");
const storeLocations = require("./storePurchase/storeLocations.service");
const { resolveInventoryItem } = require("./inventoryItemContext");

const round4 = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;

async function buildInventoryLocationContext({ user, message, history = [], recognizedSubject = null, recordId = null } = {}) {
  const item = recognizedSubject || await resolveInventoryItem({ user, message, history, recordId });
  if (!item?.found) return { item, positions: [], located: 0, unallocated: 0, unit: "" };

  const ctx = user?.storePurchaseAccess;
  const record = item.record;
  const rows = await LocationBalance.find({
    companyId: ctx.companyId,
    itemId: record._id,
    locationId: { $type: "objectId" },
    onHand: { $gt: 0.0001 },
  }).select("variantId warehouseId locationId onHand createdAt updatedAt").lean();

  const warehouseIds = [...new Set(rows.map((row) => String(row.warehouseId)).filter(Boolean))];
  const warehouses = warehouseIds.length
    ? await Warehouse.find({ $and: [tenantContext.tenantFilter(ctx), { _id: { $in: warehouseIds } }] })
      // The embedded location id is an internal join key. MongoDB does not
      // retain it when only selected location subfields are projected, so the
      // balance.locationId could never be resolved to its rack/shelf record.
      .select("name shortName status locations._id locations.code locations.name locations.kind locations.type locations.status locations.parent locations.capacity")
      .lean()
    : [];
  const byWarehouse = new Map(warehouses.map((warehouse) => [String(warehouse._id), warehouse]));
  const variants = new Map((record.variants || []).map((variant) => [String(variant._id), variant]));

  const positions = rows.map((row) => {
    const warehouse = byWarehouse.get(String(row.warehouseId));
    const location = warehouse ? storeLocations.locationIn(warehouse, row.locationId) : null;
    if (!warehouse || !location) return null;
    const address = storeLocations.addressOf(warehouse, location);
    const variant = row.variantId ? variants.get(String(row.variantId)) : null;
    return {
      warehouse: warehouse.name || "",
      warehouseCode: warehouse.shortName || "",
      locationCode: location.code || "",
      locationName: location.name || "",
      kind: location.kind || "AREA",
      type: location.type || "",
      address: address.display,
      shortAddress: address.short,
      variant: variant ? (variant.combination || []).join(" · ") : "",
      variantSku: variant?.sku || "",
      onHand: round4(row.onHand),
      capacity: location.capacity?.value ?? null,
      capacityUnit: location.capacity?.unit || "",
      updatedAt: row.updatedAt || null,
    };
  }).filter(Boolean).sort((a, b) => (
    a.warehouse.localeCompare(b.warehouse) || a.shortAddress.localeCompare(b.shortAddress)
  ));

  const located = round4(positions.reduce((sum, position) => sum + position.onHand, 0));
  const onHand = round4(record.quantity || 0);
  return {
    item,
    positions,
    located,
    unallocated: round4(Math.max(0, onHand - located)),
    onHand,
    unit: record.customUnit || record.unit || "",
  };
}

module.exports = { buildInventoryLocationContext };
