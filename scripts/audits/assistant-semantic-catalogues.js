#!/usr/bin/env node
"use strict";

const hr = require("../../services/hrSemanticMetrics");
const accounting = require("../../services/accountingSemanticCatalogue");
const sales = require("../../services/salesCustomerContract");
const storePurchase = require("../../services/storeSupplierContract");
const storePurchaseSchema = require("../../services/storePurchaseUniversalContract");
const inventory = require("../../services/inventoryItemContract");
const inventoryLocations = require("../../services/inventoryLocationContract");
const planner = require("../../services/plannerSemanticContract");
const configurations = require("../../services/configurationSemanticContract");
const storeApplication = require("../../services/storeApplicationFieldContracts");
const store = require("../../services/storeSemanticContract");
const { getFieldCoverageContracts } = require("../../services/ai/fieldCoverageContract");
const { APPLICATIONS } = require("../../services/ai/cmsApplicationManifest");
const registry = require("../../services/ai/toolRegistry");
require("../../services/ai/tools/hrTools");
require("../../services/ai/tools/accountingTools");
require("../../services/ai/tools/salesTools");
require("../../services/ai/tools/storePurchaseTools");
require("../../services/ai/tools/storePurchaseUniversalTools");
require("../../services/ai/tools/storePurchaseCollectionTools");
require("../../services/ai/tools/inventoryTools");
require("../../services/ai/tools/plannerTools");
require("../../services/ai/tools/configurationTools");
require("../../services/ai/tools/storeTools");
require("../../services/ai/tools/storeCollectionTools");

const catalogues = [
  hr.CATALOGUE, accounting.CATALOGUE, sales.CATALOGUE, storePurchase.CATALOGUE, storePurchaseSchema.CATALOGUE,
  inventory.CATALOGUE, inventoryLocations.CATALOGUE, planner.CATALOGUE, configurations.CATALOGUE, store.CATALOGUE,
];
const issues = [];
const reports = catalogues.map((catalogue) => {
  const report = catalogue.audit();
  for (const issue of report.issues) issues.push({ catalogue: catalogue.id, ...issue });
  return { catalogue: catalogue.id, ...report };
});

for (const tool of registry._tools.values()) {
  if (!/^(hr|acc|sales|store|inventory|planner|config)_/.test(tool.name)) continue;
  if (!tool.semantic) {
    issues.push({ type: "tool_without_semantic_metadata", tool: tool.name });
    continue;
  }
  const catalogue = catalogues.find((item) => item.id === tool.semantic.catalogue);
  if (!catalogue) {
    issues.push({ type: "tool_unknown_catalogue", tool: tool.name, catalogue: tool.semantic.catalogue });
    continue;
  }
  for (const domain of tool.semantic.domains) {
    if (!catalogue.domains[domain]) issues.push({ type: "tool_unknown_domain", tool: tool.name, domain });
  }
  for (const subject of tool.semantic.subjects) {
    if (!catalogue.entities[subject]) issues.push({ type: "tool_unknown_subject", tool: tool.name, subject });
  }
  if (tool.application && !APPLICATIONS.some((application) => application.id === tool.application)) {
    issues.push({ type: "tool_unknown_application", tool: tool.name, application: tool.application });
  }
}

const fieldContracts = [sales.FIELD_CONTRACT, storePurchase.FIELD_CONTRACT, inventory.FIELD_CONTRACT]
  .concat(storePurchaseSchema.CONTRACTS)
  .concat([
    inventoryLocations.LOCATION_BALANCE_FIELD_CONTRACT,
    inventoryLocations.WAREHOUSE_LOCATION_FIELD_CONTRACT,
  ])
  .concat([planner.GOAL_FIELD_CONTRACT, planner.TASK_FIELD_CONTRACT])
  .concat([
    configurations.CATEGORY_FIELD_CONTRACT,
    configurations.TEMPLATE_FIELD_CONTRACT,
    configurations.REQUESTS_FIELD_CONTRACT,
  ])
  .concat(storeApplication.CONTRACTS)
  .map((contract) => contract.audit());
for (const report of fieldContracts) {
  for (const issue of report.issues) issues.push({ contract: report.id, ...issue });
}

const semanticConcepts = new Set(catalogues.flatMap((catalogue) => Object.keys(catalogue.metrics)));
for (const contract of getFieldCoverageContracts()) {
  for (const definition of Object.values(contract.exposed)) {
    if (!semanticConcepts.has(definition.id)) {
      issues.push({ type: "field_without_semantic_concept", contract: contract.id, path: definition.path, concept: definition.id });
    }
  }
}

const result = {
  ok: issues.length === 0,
  catalogues: reports,
  fieldContracts,
  registeredTools: [...registry._tools.values()].filter((tool) => /^(hr|acc|sales|store|inventory|planner|config)_/.test(tool.name)).length,
  issues,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
