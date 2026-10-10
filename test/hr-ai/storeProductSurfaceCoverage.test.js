"use strict";

const registry = require("../../services/ai/toolRegistry");
for (const name of [
  "storePurchaseTools", "storePurchaseUniversalTools", "storePurchaseCollectionTools",
  "inventoryTools", "storeTools", "storeCollectionTools", "storeRequestDeskTools", "storeOperationalTools",
]) require(`../../services/ai/tools/${name}`);
const { inventoryStoreProduct } = require("../../services/ai/storeProductSurfaceInventory");
const { SURFACES, PARTIAL, classifyEndpoint } = require("../../services/ai/storeProductSurfaceManifest");

describe("actual Store product surface coverage", () => {
  test("every frontend Store API family is classified and no read surface is partial", () => {
    const endpoints = inventoryStoreProduct();
    expect(endpoints.length).toBeGreaterThan(100);
    expect(endpoints.filter(({ endpoint }) => !classifyEndpoint(endpoint))).toEqual([]);
    expect(SURFACES.filter((surface) => surface.status === PARTIAL)).toEqual([]);
  });

  test("every catalogued surface names registered deterministic capabilities", () => {
    for (const surface of SURFACES) {
      if (surface.status !== "catalogued") continue;
      expect(surface.tools.length).toBeGreaterThan(0);
      for (const name of surface.tools) expect(registry.getTool(name)).toBeTruthy();
    }
  });
});
