#!/usr/bin/env node
"use strict";

const registry = require("../../services/ai/toolRegistry");
require("../../services/ai/tools/storePurchaseTools");
require("../../services/ai/tools/storePurchaseUniversalTools");
require("../../services/ai/tools/storePurchaseCollectionTools");
require("../../services/ai/tools/inventoryTools");
require("../../services/ai/tools/storeTools");
require("../../services/ai/tools/storeCollectionTools");
require("../../services/ai/tools/storeRequestDeskTools");
require("../../services/ai/tools/storeOperationalTools");
const { inventoryStoreProduct } = require("../../services/ai/storeProductSurfaceInventory");
const { SURFACES, CATALOGUED, PARTIAL, classifyEndpoint } = require("../../services/ai/storeProductSurfaceManifest");

const inventory = inventoryStoreProduct();
const unclassified = inventory.filter(({ endpoint }) => !classifyEndpoint(endpoint));
const missingTools = [];
for (const surface of SURFACES) {
  for (const tool of surface.tools) {
    if (!registry.getTool(tool)) missingTools.push({ surface: surface.id, tool });
  }
}
const partial = SURFACES.filter((surface) => surface.status === PARTIAL);
const result = {
  complete: unclassified.length === 0 && missingTools.length === 0 && partial.length === 0,
  endpoints: inventory.length,
  surfaces: SURFACES.length,
  catalogued: SURFACES.filter((surface) => surface.status === CATALOGUED).length,
  partial: partial.map(({ id, reason }) => ({ id, reason })),
  unclassified,
  missingTools,
  endpointCoverage: inventory.map(({ endpoint, files }) => {
    const surface = classifyEndpoint(endpoint);
    return { endpoint, surface: surface?.id || null, status: surface?.status || "unclassified", files };
  }),
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.complete) process.exitCode = 1;
