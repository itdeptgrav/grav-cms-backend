"use strict";

const registry = require("../../services/ai/toolRegistry");
const store = require("../../services/storeSemanticContract");
const supplier = require("../../services/storeSupplierContract");
const universal = require("../../services/storePurchaseUniversalContract");
const inventory = require("../../services/inventoryItemContract");
const locations = require("../../services/inventoryLocationContract");

registry._clear();
for (const moduleName of [
  "storePurchaseTools", "storePurchaseUniversalTools", "storePurchaseCollectionTools", "inventoryTools", "storeTools", "storeCollectionTools", "storeRequestDeskTools", "storeOperationalTools",
]) {
  delete require.cache[require.resolve(`../../services/ai/tools/${moduleName}`)];
  require(`../../services/ai/tools/${moduleName}`);
}

const catalogues = new Map([
  [store.STORE_CATALOGUE_ID, store.CATALOGUE],
  [supplier.STORE_PURCHASE_CATALOGUE_ID, supplier.CATALOGUE],
  [universal.CATALOGUE_ID, universal.CATALOGUE],
  [inventory.INVENTORY_CATALOGUE_ID, inventory.CATALOGUE],
  [locations.INVENTORY_LOCATION_CATALOGUE_ID, locations.CATALOGUE],
]);

describe("Store and Store & Purchase runtime coverage", () => {
  const tools = [...registry._tools.values()].filter((tool) => (
    tool.application === "store" || tool.application === "store_purchase"
  ));

  test("every Store capability is registered, closed, rendered and application-owned", () => {
    const collectionOnly = universal.ENTITY_SPECS.filter((entry) => entry.collectionOnly).length;
    expect(tools).toHaveLength(13 + (universal.ENTITY_SPECS.length * 2) - collectionOnly);
    for (const tool of tools) {
      expect(["store", "store_purchase"]).toContain(tool.application);
      expect(tool.semantic).toEqual(expect.objectContaining({
        catalogue: expect.any(String), domains: expect.any(Array),
      }));
      expect(catalogues.has(tool.semantic.catalogue)).toBe(true);
      expect(tool.renderAnswer).toEqual(expect.any(Function));
      expect(tool.parameters.additionalProperties).toBe(false);
      if (tool.name === "store_receive_query") {
        expect(Object.keys(tool.parameters.properties)).toEqual([
          "operation", "stage", "source", "dateBasis", "from", "to", "query", "limit",
        ]);
        expect(tool.parameters.required).toEqual(["operation", "stage", "source", "dateBasis"]);
      } else if (tool.name === "store_request_desk_query") {
        expect(Object.keys(tool.parameters.properties)).toEqual([
          "operation", "type", "stage", "query", "from", "to", "sort", "limit",
        ]);
        expect(tool.parameters.required).toEqual(["operation", "type", "stage", "sort", "limit"]);
      } else if (tool.name === "store_operational_workspace_query") {
        expect(Object.keys(tool.parameters.properties)).toEqual(["view", "operation", "query", "limit"]);
        expect(tool.parameters.required).toEqual(["view", "operation", "limit"]);
      } else if (tool.name.startsWith("store_collection_") || tool.name.startsWith("store_legacy_collection_")) {
        expect(Object.keys(tool.parameters.properties)).toEqual([
          "operation", "metric", "outputMetric2", "outputMetric3",
          "filterMetric", "filterOperator", "filterValue",
          "filterMetric2", "filterOperator2", "filterValue2",
          "filterMetric3", "filterOperator3", "filterValue3",
          "dateMetric", "from", "to", "query", "sort", "limit",
        ]);
        expect(tool.parameters.required).toEqual([
          "operation", "metric", "outputMetric2", "outputMetric3",
          "filterMetric", "filterOperator",
          "filterMetric2", "filterOperator2",
          "filterMetric3", "filterOperator3", "dateMetric",
        ]);
      } else {
        expect(Object.keys(tool.parameters.properties || {})).toEqual(["metric"]);
        expect(tool.parameters.required).toEqual(["metric"]);
        expect(tool.parameters.properties.metric.enum.length).toBeGreaterThan(0);
      }
      expect(JSON.stringify(tool.parameters)).not.toMatch(/database|collection|physicalPath|companyId|siteId/i);
    }
  });

  test("receiving-register relevance does not hijack purchase-order status questions", () => {
    const receive = tools.find((tool) => tool.name === "store_receive_query");
    const purchaseOrder = tools.find((tool) => tool.name === "store_record_purchase_order_field");
    const purchaseOrders = tools.find((tool) => tool.name === "store_collection_purchase_order_query");
    expect(receive.matches("any GRN expected in June 2026?")).toBe(true);
    expect(receive.matches("how many purchase orders are partially received?")).toBe(false);
    expect(purchaseOrder.matches("how many purchase orders are partially received?")).toBe(false);
    expect(purchaseOrders.matches("how many purchase orders are partially received?")).toBe(true);
  });

  test("every safe semantic field is reachable through exactly its catalogue tools", () => {
    for (const [catalogueId, catalogue] of catalogues) {
      const offered = new Set(tools
        .filter((tool) => tool.semantic.catalogue === catalogueId)
        .flatMap((tool) => tool.parameters.properties.metric?.enum || [])
        .filter((id) => !String(id).startsWith("__")));
      expect([...offered].sort()).toEqual(Object.keys(catalogue.metrics).sort());
    }
  });

  test("Store and Store & Purchase deny unauthorised and cross-application callers", () => {
    const storeUser = {
      id: "employee",
      applicationAccess: { store: { allowed: true, capabilities: { read: true } } },
      storePurchaseAccess: { capabilitySet: new Set() },
    };
    const purchaseUser = {
      id: "employee",
      applicationAccess: { store: { allowed: false, capabilities: null } },
      storePurchaseAccess: { capabilitySet: new Set(["sp.read"]) },
    };
    for (const tool of tools) {
      expect(tool.permission({})).toBe(false);
      expect(tool.permission(storeUser)).toBe(tool.application === "store");
      expect(tool.permission(purchaseUser)).toBe(tool.application === "store_purchase");
    }
  });
});
