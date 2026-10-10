"use strict";

const PurchaseOrder = require("../models/CMS_Models/Store/PurchaseOrder");
const PurchaseOrderSettings = require("../models/CMS_Models/Store/PurchaseOrderSettings");
const WorkOrderSettings = require("../models/CMS_Models/Store/WorkOrderSettings");
const WorkerWorkOrder = require("../models/CMS_Models/Store/WorkerWorkOrder");
const StockIssuance = require("../models/CMS_Models/Inventory/Operations/StockIssuance");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const ManufacturingWorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const metricId = (entity, path) => `store.${entity}.${String(path).replace(/[^a-zA-Z0-9]+/g, "_")}`;
const field = (path, entity, valueType = "text") => ({ id: metricId(entity, path), label: path, valueType, path });
const fields = (paths, entity) => paths.map((path) => field(path, entity));
const excluded = (paths, reason) => Object.fromEntries(paths.map((path) => [path, reason]));

const PO_ID = ["_id", "__v", "createdBy", "updatedBy"];
const PO_PATHS = mongooseSchemaPaths(PurchaseOrder.schema);
const PO_EXPOSED = PO_PATHS.filter((path) => !PO_ID.includes(path));
const PURCHASE_ORDER_CONTRACT = compileFieldCoverageContract({
  id: "store.purchase_order",
  sourceModels: ["models/CMS_Models/Store/PurchaseOrder.js"],
  schemaPaths: PO_PATHS,
  exposed: fields(PO_EXPOSED, "purchase_order"),
  excluded: excluded(PO_ID, "Internal database or actor identifier; not required for a Store purchase-order answer."),
});

function settingsContract(id, model, sourceModel, entity) {
  return compileFieldCoverageContract({
    id,
    sourceModels: [sourceModel],
    schemaPaths: mongooseSchemaPaths(model.schema),
    exposed: fields(["prefix", "suffix", "padding", "counter", "createdAt", "updatedAt"], entity),
    excluded: {
      _id: "Internal singleton identifier.",
      __v: "Database concurrency metadata.",
      key: "Internal singleton key; the settings type supplies the business identity.",
    },
  });
}

const PURCHASE_ORDER_SETTINGS_CONTRACT = settingsContract(
  "store.purchase_order_settings", PurchaseOrderSettings,
  "models/CMS_Models/Store/PurchaseOrderSettings.js", "purchase_order_numbering",
);
const WORK_ORDER_SETTINGS_CONTRACT = settingsContract(
  "store.worker_work_order_settings", WorkOrderSettings,
  "models/CMS_Models/Store/WorkOrderSettings.js", "worker_work_order_numbering",
);

const WORKER_WO_PATHS = mongooseSchemaPaths(WorkerWorkOrder.schema);
const WORKER_WO_EXCLUDED = {
  _id: "Internal record identifier; work-order number is the conversational identity.",
  __v: "Database concurrency metadata.",
  createdBy: "Internal actor identifier.",
  updatedBy: "Internal actor identifier.",
  paymentUpiId: "Sensitive payment credential; excluded from conversational context.",
  paymentAccountNumber: "Sensitive bank-account identifier; excluded from conversational context.",
  paymentIfscCode: "Sensitive bank-routing identifier; excluded from conversational context.",
  paymentChequeNumber: "Sensitive payment instrument identifier; excluded from conversational context.",
  "documents.url": "Direct attachment URL; files require a separately authorised document tool.",
  "documents.fileId": "Internal attachment identifier.",
  "documents.publicId": "Internal attachment identifier.",
};
const WORKER_WORK_ORDER_CONTRACT = compileFieldCoverageContract({
  id: "store.worker_work_order",
  sourceModels: ["models/CMS_Models/Store/WorkerWorkOrder.js"],
  schemaPaths: WORKER_WO_PATHS,
  exposed: fields(WORKER_WO_PATHS.filter((path) => !WORKER_WO_EXCLUDED[path]), "worker_work_order"),
  excluded: WORKER_WO_EXCLUDED,
});

function projectionContract({ id, model, sourceModel, projectionPaths, excludedPaths = [], entity }) {
  return compileFieldCoverageContract({
    id,
    coverageMode: "projection_view",
    sourceModels: [sourceModel],
    schemaPaths: mongooseSchemaPaths(model.schema),
    projectionPaths,
    exposed: fields(projectionPaths.filter((path) => !excludedPaths.includes(path)), entity),
    excluded: excluded(excludedPaths, "Internal relationship identifier used only for the deterministic Store join."),
  });
}

const CUSTOMER_REQUEST_PATHS = [
  "requestId", "customerInfo.name", "status", "priority", "requestType", "createdAt", "updatedAt",
  "pmApproved", "pmApprovedAt", "pmRejected", "pmRejectedAt", "pmRejectionNote",
  "items.stockItemId", "items.stockItemName", "items.stockItemReference", "items.totalQuantity",
  "items.variants.attributes.name", "items.variants.attributes.value", "items.variants.quantity",
];
const CUSTOMER_REQUEST_VIEW_CONTRACT = projectionContract({
  id: "store.customer_request_view", model: CustomerRequest,
  sourceModel: "models/Customer_Models/CustomerRequest.js", projectionPaths: CUSTOMER_REQUEST_PATHS,
  excludedPaths: ["items.stockItemId"], entity: "order_request",
});

const MANUFACTURING_WO_PATHS = [
  "customerRequestId", "workOrderNumber", "stockItemId", "stockItemName", "stockItemReference",
  "variantAttributes.name", "variantAttributes.value", "quantity", "status", "createdAt",
  "storeDepartmentVerified", "storeDepartmentVerifiedAt", "storeDepartmentNotes",
  "rawMaterials.name", "rawMaterials.sku", "rawMaterials.rawItemId", "rawMaterials.rawItemVariantId",
  "rawMaterials.rawItemVariantCombination", "rawMaterials.unit", "rawMaterials.quantityRequired",
  "rawMaterials.quantityAllocated", "rawMaterials.quantityIssued", "rawMaterials.unitCost",
  "rawMaterials.totalCost", "rawMaterials.allocationStatus",
];
const MANUFACTURING_WORK_ORDER_VIEW_CONTRACT = projectionContract({
  id: "store.manufacturing_work_order_view", model: ManufacturingWorkOrder,
  sourceModel: "models/CMS_Models/Manufacturing/WorkOrder/WorkOrder.js", projectionPaths: MANUFACTURING_WO_PATHS,
  excludedPaths: ["customerRequestId", "stockItemId", "rawMaterials.rawItemId", "rawMaterials.rawItemVariantId"],
  entity: "manufacturing_work_order",
});

const STOCK_ITEM_PATHS = [
  "name", "genderCategory", "variants.attributes.name", "variants.attributes.value",
  "variants.rawItems.rawItemId", "variants.rawItems.rawItemName", "variants.rawItems.rawItemSku",
  "variants.rawItems.variantId", "variants.rawItems.variantCombination", "variants.rawItems.requiredQuantity",
  "variants.rawItems.allowancePercent", "variants.rawItems.quantity", "variants.rawItems.unit",
  "variants.rawItems.baseUnit", "variants.rawItems.unitCost", "variants.rawItems.totalCost",
];
const STOCK_ITEM_VIEW_CONTRACT = projectionContract({
  id: "store.stock_item_bom_view", model: StockItem,
  sourceModel: "models/CMS_Models/Inventory/Products/StockItem.js", projectionPaths: STOCK_ITEM_PATHS,
  excludedPaths: ["variants.rawItems.rawItemId", "variants.rawItems.variantId"], entity: "stock_item_bom",
});

const ISSUANCE_PATHS = [
  "manufacturingOrder", "direction", "createdAt", "performedBy", "reason",
  "items.rawItem", "items.rawItemName", "items.rawItemSku", "items.variantId",
  "items.variantCombination", "items.issuedQty", "items.issuedUnit", "items.nativeQty", "items.nativeUnit",
];
const STOCK_ISSUANCE_VIEW_CONTRACT = projectionContract({
  id: "store.stock_issuance_view", model: StockIssuance,
  sourceModel: "models/CMS_Models/Inventory/Operations/StockIssuance.js", projectionPaths: ISSUANCE_PATHS,
  excludedPaths: ["manufacturingOrder", "performedBy", "items.rawItem", "items.variantId"],
  entity: "stock_issuance",
});

const CONTRACTS = Object.freeze([
  PURCHASE_ORDER_CONTRACT, PURCHASE_ORDER_SETTINGS_CONTRACT, WORK_ORDER_SETTINGS_CONTRACT,
  WORKER_WORK_ORDER_CONTRACT, CUSTOMER_REQUEST_VIEW_CONTRACT,
  MANUFACTURING_WORK_ORDER_VIEW_CONTRACT, STOCK_ITEM_VIEW_CONTRACT, STOCK_ISSUANCE_VIEW_CONTRACT,
]);

module.exports = { CONTRACTS, metricId };
