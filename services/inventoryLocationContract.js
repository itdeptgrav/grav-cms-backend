"use strict";

const LocationBalance = require("../models/CMS_Models/Inventory/Operations/LocationBalance");
const Warehouse = require("../models/CMS_Models/Inventory/Configurations/Warehouse");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const INVENTORY_LOCATION_CATALOGUE_ID = "inventory_locations";

const DEFINITIONS = Object.freeze([
  {
    id: "item.locations",
    label: "Physical storage locations",
    aliases: ["where", "location", "locations", "rack", "shelf", "bin", "storage position", "stored", "kept"],
    valueType: "location_list",
    path: ["warehouse.name", "warehouse.shortName", "locations.code", "locations.name", "locations.kind", "locations.type", "locations.status", "locations.parent", "locations.capacity.value", "locations.capacity.unit", "balance.onHand"],
  },
  {
    id: "item.location_count",
    label: "Physical storage location count",
    aliases: ["location count", "number of locations", "number of positions", "how many locations"],
    valueType: "number",
    path: ["balance.locationId"],
  },
  {
    id: "item.located_quantity",
    label: "Located physical quantity",
    aliases: ["located quantity", "placed quantity", "assigned quantity", "quantity in locations"],
    valueType: "quantity",
    path: ["balance.onHand"],
  },
  {
    id: "item.unallocated_quantity",
    label: "Unallocated physical quantity",
    aliases: ["unallocated quantity", "unassigned quantity", "not put away", "not located"],
    valueType: "quantity",
    path: ["item.quantity", "balance.onHand"],
  },
].map((definition) => Object.freeze({
  ...definition,
  aliases: Object.freeze(definition.aliases),
  path: Object.freeze(definition.path),
  temporal: "current",
  source: "inventory_location_projection",
  domain: "physical_location",
  entity: "inventory_item",
})));

const CATALOGUE = compileSemanticCatalogue({
  id: INVENTORY_LOCATION_CATALOGUE_ID,
  domains: [{
    id: "physical_location",
    label: "physical stock location",
    aliases: ["warehouse location", "rack location", "shelf location", "stock placement", "put away"],
  }],
  entities: [{ id: "inventory_item", label: "inventory item", aliases: ["raw item", "material", "stock item"] }],
  metrics: DEFINITIONS,
});

const LOCATION_BALANCE_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "inventory.location_balance",
  sourceModels: ["models/CMS_Models/Inventory/Operations/LocationBalance.js"],
  schemaPaths: mongooseSchemaPaths(LocationBalance.schema),
  exposed: [
    { path: "onHand", id: "item.located_quantity", label: "Quantity at position", valueType: "number" },
    { path: "createdAt", id: "item.locations", label: "Position balance created at", valueType: "date_time" },
    { path: "updatedAt", id: "item.locations", label: "Position balance updated at", valueType: "date_time" },
  ],
  excluded: {
    _id: "Internal projection-row identifier.",
    __v: "Database concurrency metadata.",
    companyId: "Server-owned tenancy boundary.",
    itemId: "Internal join; the item is resolved through its authorised business name or SKU.",
    variantId: "Internal join; variant identity is rendered from the authorised item master.",
    warehouseId: "Internal join; the warehouse business name and code are rendered.",
    locationId: "Internal join; the location business address is rendered.",
  },
});

// Warehouse is a large operational/configuration aggregate. This contract is
// intentionally a projection view for the read model used by this capability;
// layout geometry, QR tokens, audit actor ids and archive machinery are not
// passed to Qwen or returned by this tool.
const WAREHOUSE_LOCATION_PATHS = Object.freeze([
  "name", "shortName", "status", "locations._id", "locations.code", "locations.name",
  "locations.kind", "locations.type", "locations.status", "locations.parent",
  "locations.capacity.value", "locations.capacity.unit",
]);
const WAREHOUSE_LOCATION_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "inventory.warehouse_location_projection",
  sourceModels: ["models/CMS_Models/Inventory/Configurations/Warehouse.js"],
  schemaPaths: mongooseSchemaPaths(Warehouse.schema),
  coverageMode: "projection_view",
  projectionPaths: WAREHOUSE_LOCATION_PATHS,
  exposed: WAREHOUSE_LOCATION_PATHS.filter((path) => path !== "locations._id").map((path) => ({
    path,
    id: "item.locations",
    label: `Physical location ${path}`,
    valueType: path.endsWith(".value") ? "number" : "text",
  })),
  excluded: {
    "locations._id": "Internal join key used to match a verified location balance to its rack, shelf or bin.",
  },
});

module.exports = {
  INVENTORY_LOCATION_CATALOGUE_ID,
  CATALOGUE,
  DEFINITIONS,
  LOCATION_BALANCE_FIELD_CONTRACT,
  WAREHOUSE_LOCATION_FIELD_CONTRACT,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (value) => CATALOGUE.resolveMetric(value),
};
