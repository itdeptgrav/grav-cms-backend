"use strict";

const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const INVENTORY_CATALOGUE_ID = "inventory";

const DEFINITIONS = Object.freeze([
  ["item.name", "Item name", ["raw item name", "material name", "item name", "name"], "name", "text"],
  ["item.sku", "Item SKU", ["raw item sku", "material sku", "item code", "sku"], "sku", "text"],
  ["item.category", "Item category", ["raw item category", "material category", "item category", "category"], "category", "text"],
  ["item.custom_category", "Item custom category", ["custom category"], "customCategory", "text"],
  ["item.product_type", "Item product type", ["product type", "material type"], "productType", "text"],
  ["item.customs_tariff_code", "Customs tariff code", ["customs code", "tariff code", "customs tariff"], "customsTariffCode", "text"],
  ["item.used_as", "Item usage classification", ["used as", "usage classification", "item usage"], "usedAs", "text"],
  ["item.unit", "Stock unit", ["stock unit", "item unit", "unit of measure", "uom"], "unit", "text"],
  ["item.custom_unit", "Custom stock unit", ["custom unit"], "customUnit", "text"],
  ["item.default_ownership", "Default ownership", ["default ownership", "material ownership"], "defaultOwnership", "text"],
  ["item.default_tracking_level", "Default tracking level", ["tracking level", "default tracking"], "defaultTrackingLevel", "text"],
  ["item.physical_quantity", "Physical quantity on hand", ["physical stock", "physical quantity", "quantity on hand", "on hand quantity", "on hand", "stock quantity", "stock", "quantity", "physically have", "how much in stock", "available stock"], "quantity", "number"],
  ["item.minimum_stock", "Minimum stock", ["minimum stock", "min stock", "reorder threshold"], "minStock", "number"],
  /* ── A SHORTFALL IS NOT A NEW FIGURE ──────────────────────────────────
     It is the gap between two figures this record already carries, and the
     gap is what "minimum stock" MEANS: the level below which the item is
     short. Reading it as a concept of its own is what lets "shortfall for
     16mm flex pipe" be answered from the record rather than estimated from
     somewhere else — and when no minimum is recorded, the answer says so
     instead of calling the gap zero. */
  ["item.stock_shortfall", "Stock shortfall below minimum", [
    "shortfall", "stock shortfall", "short by", "shortage",
    "below minimum", "below minimum stock", "how short",
  ], ["quantity", "minStock"], "stock_shortfall"],
  ["item.maximum_stock", "Maximum stock", ["maximum stock", "max stock"], "maxStock", "number"],
  ["item.status", "Stock status", ["stock status", "item status", "availability status", "status"], "status", "text"],
  ["item.description", "Item description", ["item description", "material description", "description"], "description", "text"],
  ["item.notes", "Item notes", ["item notes", "material notes", "notes"], "notes", "text"],
  ["item.budget_ledger", "Budget ledger override", ["budget ledger", "budget head"], ["budgetLedgerName", "budgetLedgerSetByName", "budgetLedgerSetAt"], "budget_ledger"],
  ["item.attributes", "Item attributes", ["item attributes", "material attributes", "attributes"], ["attributes.name", "attributes.values"], "attributes"],
  ["item.variants", "Item variants", ["item variants", "material variants", "variants"], [
    "variants.combination", "variants.quantity", "variants.minStock", "variants.maxStock",
    "variants.sku", "variants.status", "variants.unitConversion.fromUnit",
    "variants.unitConversion.toUnit", "variants.unitConversion.quantity",
    "variants.unitConversions.fromUnit", "variants.unitConversions.toUnit", "variants.unitConversions.quantity",
  ], "variants"],
  ["item.quantity_discounts", "Quantity discounts", ["quantity discounts", "discount tiers", "discounts"], ["discounts.minQuantity", "discounts.price"], "discounts"],
  ["item.created_at", "Item created at", ["item created date", "material created date"], "createdAt", "date_time"],
  ["item.updated_at", "Item updated at", ["item updated date", "material last updated"], "updatedAt", "date_time"],
].map(([id, label, aliases, path, valueType]) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), path, valueType,
  temporal: "current",
  source: "inventory_raw_item_master",
  domain: "item_master",
  entity: "inventory_item",
})));

const EXCLUDED = Object.freeze({
  _id: "Internal database identifier; SKU is the business identifier.",
  __v: "Database concurrency metadata.",
  alternateVendors: "Internal supplier identifiers require a separately authorised relationship projection.",
  "attributes._id": "Embedded database identifier.",
  budgetLedgerId: "Internal ledger identifier; the recorded ledger name is exposed.",
  budgetLedgerSetBy: "Internal actor identifier; the actor name is exposed.",
  companyId: "Server-owned tenancy boundary; never a conversational data field.",
  createdBy: "Internal actor identifier.",
  deletedAt: "Trash lifecycle is excluded from ordinary live-item reads.",
  deletedBy: "Trash lifecycle internal actor identifier.",
  deletedByName: "Trash lifecycle is excluded from ordinary live-item reads.",
  "discounts._id": "Embedded database identifier.",
  identityUnique: "Internal duplicate-policy marker.",
  masterIdentityKey: "Derived duplicate-detection index.",
  primaryVendor: "Internal supplier identifier requires a separately authorised relationship projection.",
  siteId: "Server-owned tenancy/site boundary.",
  updatedBy: "Internal actor identifier.",
  "variants._id": "Embedded database identifier.",
  "variants.image": "Media URLs are not returned by the conversational text assistant.",
  "variants.vendorNicknames._id": "Embedded supplier-alias identifier.",
  "variants.vendorNicknames.createdAt": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.deliveryDays": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.nickname": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.notes": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.price": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.specifications._id": "Embedded supplier-alias identifier.",
  "variants.vendorNicknames.specifications.key": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.specifications.value": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.updatedAt": "Supplier quotation/alias history requires a separate sourcing contract.",
  "variants.vendorNicknames.vendor": "Internal supplier identifier requires a separate sourcing contract.",
  "stockTransactions._id": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.createdAt": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.invoiceNumber": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.locationCode": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.locationId": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.locationName": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.newQuantity": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.notes": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.operationId": "Internal idempotency metadata.",
  "stockTransactions.ownership": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.performedBy": "Internal actor identifier in the stock ledger.",
  "stockTransactions.previousQuantity": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.purchaseOrder": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.purchaseOrderId": "Internal purchase-order identifier in the stock ledger.",
  "stockTransactions.quantity": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.reason": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.supplier": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.supplierId": "Internal supplier identifier in the stock ledger.",
  "stockTransactions.type": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.unitPrice": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.updatedAt": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.variantCombination": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.variantId": "Internal variant identifier in the stock ledger.",
  "stockTransactions.variantNewQuantity": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.variantPreviousQuantity": "Stock movement history requires its own temporal ledger contract.",
  "stockTransactions.warehouseId": "Internal warehouse identifier in the stock ledger.",
  "stockTransactions.warehouseName": "Stock movement history requires its own temporal ledger contract.",
});

const physicalPaths = [...new Set(DEFINITIONS.flatMap((definition) => (
  Array.isArray(definition.path) ? definition.path : [definition.path]
)))];
const exposed = physicalPaths.map((path) => {
  const owner = DEFINITIONS.find((definition) => (Array.isArray(definition.path) ? definition.path : [definition.path]).includes(path));
  return { id: owner.id, label: owner.label, valueType: owner.valueType, path };
});

const FIELD_CONTRACT = compileFieldCoverageContract({
  id: "inventory.raw_item_master",
  sourceModels: ["models/CMS_Models/Inventory/Products/RawItem.js"],
  schemaPaths: mongooseSchemaPaths(RawItem.schema),
  exposed,
  excluded: EXCLUDED,
});

const CATALOGUE = compileSemanticCatalogue({
  id: INVENTORY_CATALOGUE_ID,
  domains: [{ id: "item_master", label: "inventory item master", aliases: ["raw item master", "material master", "stock item master"] }],
  entities: [{ id: "inventory_item", label: "inventory item", aliases: ["raw item", "material", "stock item"] }],
  metrics: DEFINITIONS,
});

module.exports = {
  INVENTORY_CATALOGUE_ID,
  CATALOGUE,
  FIELD_CONTRACT,
  DEFINITIONS,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (value) => CATALOGUE.resolveMetric(value),
};
