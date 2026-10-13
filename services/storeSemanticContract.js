"use strict";

const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { CONTRACTS } = require("./storeApplicationFieldContracts");

const STORE_CATALOGUE_ID = "store";

const ENTITY_META = Object.freeze({
  purchase_order: { label: "store purchase order", aliases: ["purchase order", "po"] },
  purchase_order_collection: { label: "store purchase orders", aliases: ["purchase orders", "po list"] },
  purchase_order_numbering: { label: "purchase order numbering", aliases: ["po numbering", "next po number"] },
  worker_work_order: { label: "worker work order", aliases: ["worker order", "job work order"] },
  worker_work_order_collection: { label: "worker work orders", aliases: ["worker order list", "job work orders"] },
  worker_work_order_numbering: { label: "worker work order numbering", aliases: ["worker order numbering", "next worker work order number"] },
  order_request: { label: "store order request", aliases: ["order request", "customer request", "store po"] },
  order_request_collection: { label: "store order requests", aliases: ["order requests", "customer requests visible to store"] },
  manufacturing_work_order: { label: "manufacturing work order", aliases: ["manufacturing order", "production work order"] },
  stock_item_bom: { label: "stock item bill of materials", aliases: ["stock item bom", "bill of materials", "bom"] },
  stock_issuance: { label: "stock issuance", aliases: ["material issuance", "materials issued"] },
  store_vendor: { label: "Store purchase-order vendor", aliases: ["vendor", "supplier"] },
  store_worker: { label: "Store work-order worker", aliases: ["worker", "contract worker"] },
});

const CONTRACT_ENTITY = Object.freeze({
  "store.purchase_order": "purchase_order",
  "store.purchase_order_settings": "purchase_order_numbering",
  "store.worker_work_order_settings": "worker_work_order_numbering",
  "store.worker_work_order": "worker_work_order",
  "store.customer_request_view": "order_request",
  "store.manufacturing_work_order_view": "manufacturing_work_order",
  "store.stock_item_bom_view": "stock_item_bom",
  "store.stock_issuance_view": "stock_issuance",
});

const words = (value) => String(value || "")
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .replace(/[._]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const leafAliases = Object.freeze({
  poNumber: ["po number", "purchase order number", "order number"],
  workOrderNumber: ["work order number", "worker order number", "order number"],
  requestId: ["request id", "request number", "order request number"],
  vendorName: ["vendor", "vendor name", "supplier", "supplier name"],
  vendorPhone: ["vendor phone", "supplier phone", "vendor contact"],
  vendorAddress: ["vendor address", "supplier address"],
  vendorGstin: ["vendor gstin", "supplier gstin", "vendor gst number"],
  workerName: ["worker", "worker name"],
  workerPhone: ["worker phone", "worker contact"],
  workerAddress: ["worker address"],
  workerGstin: ["worker gstin", "worker gst number"],
  workerNotes: ["worker notes"],
  status: ["status", "workflow status", "progress", "stage", "how far along"],
  priority: ["priority"],
  orderType: ["order type"],
  requestType: ["request type"],
  reasonForPurchase: ["reason", "purchase reason", "reason for purchase"],
  paymentTerms: ["payment terms"],
  deliveryTerms: ["delivery terms"],
  invoiceNumber: ["invoice", "invoice number", "bill number"],
  shipToAddress: ["ship to", "shipping address", "ship to address"],
  billToAddress: ["bill to", "billing address", "bill to address"],
  subtotalBeforeGST: ["subtotal", "subtotal before gst", "pre gst total"],
  totalGST: ["total gst", "gst total", "tax total"],
  grandTotal: ["grand total", "total amount", "order total", "value"],
  poDate: ["po date", "purchase order date", "order date"],
  expectedDate: ["expected date", "expected delivery date"],
  receivedDate: ["received date", "date received"],
  issueDate: ["issue date", "issued date"],
  dueDate: ["due date", "deadline"],
  paymentMethod: ["payment method", "mode of payment"],
  paymentBankName: ["bank name", "payment bank"],
  paymentAccountHolderName: ["account holder", "account holder name"],
  paymentNotes: ["payment notes"],
  workArea: ["work area", "work location", "scope of work"],
  workAreaSize: ["work area size", "work size"],
  workAreaUnit: ["work area unit", "work size unit"],
  prefix: ["prefix", "number prefix"],
  suffix: ["suffix", "number suffix"],
  padding: ["padding", "number padding", "zero padding"],
  counter: ["counter", "last number", "sequence counter"],
  createdAt: ["created at", "creation date", "created date"],
  updatedAt: ["updated at", "last updated", "modified date"],
});

const nestedAliases = Object.freeze({
  "items.itemName": ["items", "line items", "item names"],
  "items.description": ["item descriptions", "line descriptions"],
  "items.itemSize": ["item sizes", "line sizes"],
  "items.hsnCode": ["hsn codes", "item hsn"],
  "items.quantity": ["item quantities", "line quantities"],
  "items.unit": ["item units", "units of measure"],
  "items.unitPrice": ["item prices", "unit prices", "rates"],
  "items.gstPercentage": ["item gst rates", "gst percentages"],
  "items.priceBeforeGST": ["item totals before gst", "line subtotals"],
  "items.gstAmount": ["item gst amounts", "line gst"],
  "items.priceIncludingGST": ["item totals including gst", "line totals"],
  "items.totalQuantity": ["requested quantities", "total requested quantities"],
  "items.stockItemName": ["items", "requested items", "requested stock items", "product names"],
  "customerInfo.name": ["customer", "customer name"],
  "rawMaterials.name": ["raw materials", "raw material names"],
  "rawMaterials.quantityRequired": ["raw material quantities required", "material required quantities"],
  "rawMaterials.quantityIssued": ["raw material quantities issued", "material issued quantities"],
  "rawMaterials.allocationStatus": ["raw material allocation status", "material allocation statuses"],
  "variants.rawItems.rawItemName": ["bom raw items", "bom materials"],
  "variants.rawItems.requiredQuantity": ["bom required quantities", "material requirement per item"],
  "items.rawItemName": ["issued materials", "issued raw items"],
  "items.issuedQty": ["issued quantities", "material quantities issued"],
  "items.issuedUnit": ["issuance units", "issued units"],
});

const inferType = (path) => {
  if (/(At|Date)$/.test(path)) return "date_time";
  if (/(Total|Amount|Price|Cost)$/i.test(path)) return "money";
  if (/(quantity|Qty|padding|counter|Size|Percentage)$/i.test(path)) return "number";
  if (/^(is|pm|storeDepartment).*(Approved|Rejected|Verified)$/.test(path) || /Approved$|Rejected$|Verified$/.test(path)) return "boolean";
  if (path.includes(".")) return "list";
  return "text";
};

const fieldDefinitions = CONTRACTS.flatMap((contract) => {
  const entity = CONTRACT_ENTITY[contract.id];
  return Object.values(contract.exposed).map((field) => {
    const pathWords = words(field.path);
    const leaf = field.path.split(".").pop();
    const aliases = nestedAliases[field.path] || (field.path.includes(".") ? [] : (leafAliases[leaf] || [pathWords]));
    return Object.freeze({
      id: field.id,
      label: `${ENTITY_META[entity].label} ${pathWords}`,
      aliases: Object.freeze([...new Set(aliases)]),
      valueType: inferType(field.path),
      path: field.path,
      query: "record_field",
      temporal: "recorded",
      source: contract.id,
      domain: "store_records",
      entity,
    });
  });
});

const aggregate = (id, label, aliases, valueType, query, entity) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), valueType, path: null, query,
  temporal: "current", source: "store_read_adapter", domain: "store_records", entity,
});

const AGGREGATES = Object.freeze([
  aggregate("store.purchase_orders", "Store purchase orders", ["purchase order list", "list purchase orders", "all purchase orders"], "record_list", "purchase_order_list", "purchase_order_collection"),
  aggregate("store.purchase_order_stats", "Purchase order statistics", ["purchase order counts", "po counts", "purchase orders by status"], "summary", "purchase_order_stats", "purchase_order_collection"),
  aggregate("store.worker_work_orders", "Worker work orders", ["worker work order list", "list worker orders", "all worker work orders"], "record_list", "worker_work_order_list", "worker_work_order_collection"),
  aggregate("store.worker_work_order_stats", "Worker work order statistics", ["worker work order counts", "worker orders by status", "worker order counts by stage", "worker work order summary", "worker order summary", "worker order stages"], "summary", "worker_work_order_stats", "worker_work_order_collection"),
  aggregate("store.order_requests", "Store order requests", ["order request list", "orders visible to store", "store orders"], "record_list", "order_request_list", "order_request_collection"),
  aggregate("store.vendors", "Store purchase-order vendors", ["vendor list", "vendors", "supplier list", "purchase order vendors"], "record_list", "vendor_list", "store_vendor"),
  aggregate("store.workers", "Store work-order workers", ["worker list", "workers", "contract worker list"], "record_list", "worker_list", "store_worker"),
  aggregate("store.order_request_work_orders", "Order request work orders", ["work orders for request", "work orders in order", "request work orders"], "record_list", "request_work_orders", "order_request"),
  aggregate("store.order_request_verification", "Order request Store verification progress", ["store verification progress", "work order verification", "verification progress"], "summary", "request_verification", "order_request"),
  aggregate("store.order_request_material_requirements", "Order request raw material requirements", ["raw material requirements", "materials required", "material requirement", "bom requirement"], "summary", "request_materials", "order_request"),
  aggregate("store.order_request_material_shortfalls", "Order request raw material shortfalls", ["raw material shortfalls", "material shortages", "shortages", "what material is short"], "summary", "request_shortfalls", "order_request"),
  aggregate("store.order_request_issuance_progress", "Order request material issuance progress", ["issuance progress", "material issue progress", "required versus issued", "materials remaining to issue"], "summary", "request_issuance", "order_request"),
  aggregate("store.manufacturing_work_order_material_requirements", "Manufacturing work order raw material requirements", ["raw material requirements", "materials required", "material requirement"], "summary", "work_order_materials", "manufacturing_work_order"),
  aggregate("store.manufacturing_work_order_material_shortfalls", "Manufacturing work order raw material shortfalls", ["raw material shortfalls", "material shortages", "shortages"], "summary", "work_order_shortfalls", "manufacturing_work_order"),
  aggregate("store.next_purchase_order_number", "Next purchase order number", ["next po number", "next purchase order number"], "text", "next_number", "purchase_order_numbering"),
  aggregate("store.next_worker_work_order_number", "Next worker work order number", ["next worker order number", "next worker work order number"], "text", "next_number", "worker_work_order_numbering"),
]);

const party = (id, label, aliases, path, entity) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), valueType: "text", path,
  query: "party_field", temporal: "latest_recorded", source: "store_read_adapter",
  domain: "store_records", entity,
});
const PARTY_DEFINITIONS = Object.freeze([
  party("store.vendor.name", "Store vendor name", ["vendor name", "supplier name", "name"], "name", "store_vendor"),
  party("store.vendor.phone", "Store vendor phone", ["vendor phone", "supplier phone", "phone", "contact number"], "phone", "store_vendor"),
  party("store.vendor.address", "Store vendor address", ["vendor address", "supplier address", "address"], "address", "store_vendor"),
  party("store.vendor.gstin", "Store vendor GSTIN", ["vendor gstin", "supplier gstin", "gstin", "gst number"], "gstin", "store_vendor"),
  party("store.vendor.ship_to", "Store vendor latest ship-to address", ["ship to", "shipping address"], "shipTo", "store_vendor"),
  party("store.vendor.bill_to", "Store vendor latest bill-to address", ["bill to", "billing address"], "billTo", "store_vendor"),
  party("store.worker.name", "Store worker name", ["worker name", "name"], "name", "store_worker"),
  party("store.worker.phone", "Store worker phone", ["worker phone", "phone", "contact number"], "phone", "store_worker"),
  party("store.worker.address", "Store worker address", ["worker address", "address"], "address", "store_worker"),
  party("store.worker.gstin", "Store worker GSTIN", ["worker gstin", "gstin", "gst number"], "gstin", "store_worker"),
  party("store.worker.notes", "Store worker notes", ["worker notes", "notes"], "notes", "store_worker"),
]);

const DEFINITIONS = Object.freeze([...fieldDefinitions, ...AGGREGATES, ...PARTY_DEFINITIONS]);

const CATALOGUE = compileSemanticCatalogue({
  id: STORE_CATALOGUE_ID,
  domains: [{
    id: "store_records", label: "store records",
    aliases: ["store", "purchase order", "worker work order", "order request", "request desk", "material request", "fulfilment request", "stock issuance", "bill of materials"],
  }],
  entities: Object.entries(ENTITY_META).map(([id, meta]) => ({ id, ...meta })),
  metrics: DEFINITIONS,
});

module.exports = {
  STORE_CATALOGUE_ID, CATALOGUE, DEFINITIONS, ENTITY_META,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (text, options) => CATALOGUE.resolveMetric(text, options),
};
