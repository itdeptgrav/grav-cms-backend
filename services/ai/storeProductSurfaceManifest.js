"use strict";

/**
 * Store is a product surface, not a route folder. Its screens read Store,
 * Inventory, Requests, Costing, Manufacturing and shared master endpoints.
 * This manifest is the release boundary for those reads.
 */

const CATALOGUED = "catalogued";
const PARTIAL = "partial";
const EXCLUDED = "excluded";

const surface = (id, patterns, status, details = {}) => Object.freeze({
  id,
  patterns: Object.freeze(patterns.map((pattern) => new RegExp(pattern))),
  status,
  ...details,
  tools: Object.freeze([...(details.tools || [])]),
});

const SURFACES = Object.freeze([
  surface("item_master", ["^/api/cms/raw-items(?:/|$)"], CATALOGUED, {
    tools: ["inventory_item_metric", "store_collection_inventory_item_master_query", "store_collection_stock_ledger_query"],
  }),
  surface("supplier_master", ["^/api/cms/vendors(?:/|$)", "^/api/cms/inventory/vendors(?:/|$)"], CATALOGUED, {
    tools: ["store_supplier_metric", "store_collection_supplier_master_query"],
  }),
  surface("warehouse_and_units", ["^/api/cms/warehouses(?:/|$)", "^/api/cms/units(?:/|$)"], CATALOGUED, {
    tools: ["store_record_warehouse_field", "store_collection_warehouse_query", "store_record_unit_field", "store_collection_unit_query"],
  }),
  surface("physical_locations", ["^/api/cms/inventory/locations(?:/|$)"], CATALOGUED, {
    tools: ["inventory_location_metric", "store_record_storage_position_field", "store_collection_storage_position_query", "store_collection_location_movement_query"],
  }),
  surface("labels_and_traceability", ["^/api/cms/inventory/barcodes(?:/|$)"], CATALOGUED, {
    tools: ["store_record_barcode_field", "store_collection_barcode_query", "store_collection_location_movement_query"],
  }),
  surface("request_desk", ["^/api/cms/inventory/mrf(?:/|$)", "^/api/requests/(?:intake|spend)(?:/|$)", "^/api/cms/store/order-requests(?:/|$)"], CATALOGUED, {
    tools: ["store_request_desk_query", "store_record_material_request_field", "store_collection_material_request_query", "store_record_intake_request_field", "store_collection_intake_request_query", "store_record_spend_request_field", "store_collection_spend_request_query"],
  }),
  surface("purchase_orders", ["^/api/cms/(?:store/)?purchase-orders(?:/|$)", "^/api/cms/inventory/operations/purchase-orders(?:/|$)"], CATALOGUED, {
    tools: ["store_record_purchase_order_field", "store_collection_purchase_order_query", "store_receive_query"],
  }),
  surface("receiving_and_customer_material", ["^/api/cms/store/(?:goods-receipts|customer-materials)(?:/|$)", "^/api/cms/inventory/operations/deliveries(?:/|$)"], CATALOGUED, {
    tools: ["store_receive_query", "store_record_goods_receipt_field", "store_collection_goods_receipt_query"],
  }),
  surface("reservations_requisitions_and_issuance", ["^/api/cms/inventory/requisitions(?:/|$)", "^/api/cms/inventory/stock-(?:adjustments|ledger|counts)(?:/|$)"], CATALOGUED, {
    tools: ["store_record_requisition_field", "store_collection_requisition_query", "store_record_stock_reservation_field", "store_collection_stock_reservation_query", "store_record_stock_ledger_field", "store_collection_stock_ledger_query", "store_record_stock_count_field", "store_collection_stock_count_query"],
  }),
  surface("services", ["^/api/cms/services(?:/|$)", "^/api/cms/inventory/services(?:/|$)", "^/api/cms/service-orders(?:/|$)"], CATALOGUED, {
    tools: ["store_record_service_field", "store_collection_service_query", "store_record_service_order_field", "store_collection_service_order_query"],
  }),
  surface("sourcing", ["^/api/cms/inventory/(?:supplier-offers|service-offers|freight-offers|sourcing-decisions)(?:/|$)"], CATALOGUED, {
    tools: ["store_collection_supplier_offer_query", "store_collection_service_supplier_offer_query", "store_collection_freight_offer_query", "store_collection_sourcing_decision_query"],
  }),
  surface("operational_configuration", ["^/api/cms/(?:machines|machine-types|operations|operation-codes|operation-groups)(?:/|$)"], CATALOGUED, {
    tools: ["store_collection_machine_query", "store_collection_machine_type_query", "store_collection_operation_query", "store_collection_operation_code_query", "store_collection_operation_group_query"],
  }),
  surface("store_records", ["^/api/cms/store/(?:products|warehouses|work-orders|work-orders-worker)(?:/|$)"], CATALOGUED, {
    tools: ["store_metric", "store_legacy_collection_manufacturing_work_order_query", "store_legacy_collection_worker_work_order_query", "store_legacy_collection_stock_item_bom_query"],
  }),
  surface("settings", ["^/api/cms/inventory/store-settings(?:/|$)"], CATALOGUED, {
    tools: ["store_record_store_settings_field", "store_collection_store_settings_query"],
  }),
  surface("valuation", ["^/api/cms/inventory/valuation(?:/|$)"], CATALOGUED, {
    tools: ["store_operational_workspace_query", "store_record_landed_cost_allocation_field", "store_collection_landed_cost_allocation_query"],
  }),
  surface("operational_overviews", ["^/api/cms/inventory/overview(?:/|$)", "^/api/cms/raw-items/accountability(?:/|$)"], CATALOGUED, {
    tools: ["store_operational_workspace_query", "store_collection_inventory_item_master_query", "store_collection_stock_ledger_query", "store_collection_storage_position_query"],
  }),
  surface("purchase_exceptions", ["^/api/cms/inventory/operations/purchase-orders/reports/exceptions(?:/|$)"], CATALOGUED, {
    tools: ["store_operational_workspace_query"],
  }),
  surface("costing_dependency", ["^/api/costings(?:/|$)"], EXCLUDED, {
    reason: "Costing is a separate permission domain. Store may show a sourcing reference, but Store access alone cannot expose the raw costing record.",
  }),
  surface("workforce_lookup", ["^/api/cms/employees/operators(?:/|$)"], EXCLUDED, {
    reason: "Operator endpoints are selector dependencies. Store tools expose recorded actor labels, not the HR employee master.",
  }),
  surface("manufacturing_lookup", ["^/api/cms/manufacturing/cutting-master/raw-item-barcode(?:/|$)"], EXCLUDED, {
    reason: "This is a mutation form lookup owned by Manufacturing; authorised label facts use the Store barcode catalogue.",
  }),
  surface("uploads_and_imports", ["^/api/(?:cloudinary/upload|upload-to-drive)", "^/api/cms/(?:warehouses|machines|machine-types|operations|operation-codes)/import(?:/|$)"], EXCLUDED, {
    reason: "Uploads and imports are mutation transports and are outside the read assistant.",
  }),
]);

function classifyEndpoint(endpoint) {
  // Later entries are deliberate exceptions to broad families (for example a
  // derived purchase-exceptions report beneath the purchase-order prefix).
  return [...SURFACES].reverse().find((entry) => entry.patterns.some((pattern) => pattern.test(endpoint))) || null;
}

module.exports = { SURFACES, CATALOGUED, PARTIAL, EXCLUDED, classifyEndpoint };
