#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { APPLICATIONS, CATALOGUED, PARTIAL, PENDING, EXCLUDED } = require("../../services/ai/cmsApplicationManifest");
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
require("../../services/storeApplicationFieldContracts");
const { getFieldCoverageContracts } = require("../../services/ai/fieldCoverageContract");
const { inventorySourceFiles } = require("../../services/ai/sourceInventory");

const root = path.resolve(__dirname, "../..");
const issues = [];
const seenIds = new Set();
const seenRoots = new Set();

function jsFiles(relativeRoot) {
  const absolute = path.join(root, relativeRoot);
  if (!fs.existsSync(absolute)) return null;
  const stack = [absolute];
  const files = [];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(target);
    }
  }
  return files.sort();
}

const contractedModels = new Set(getFieldCoverageContracts().flatMap((contract) => contract.sourceModels));
const contractedCollections = new Set(getFieldCoverageContracts().flatMap((contract) => contract.sourceCollections || []));
const contractedAdapters = new Set(getFieldCoverageContracts().flatMap((contract) => contract.sourceAdapters || []));

const applications = APPLICATIONS.map((application) => {
  if (seenIds.has(application.id)) issues.push({ type: "duplicate_application_id", application: application.id });
  seenIds.add(application.id);
  if (![CATALOGUED, PARTIAL, PENDING, EXCLUDED].includes(application.status)) {
    issues.push({ type: "invalid_application_status", application: application.id, status: application.status });
  }
  if (application.status === EXCLUDED && !application.reason) {
    issues.push({ type: "excluded_without_reason", application: application.id });
  }
  if (application.status === PENDING && (!Array.isArray(application.terms) || application.terms.length === 0)) {
    issues.push({ type: "pending_application_without_runtime_terms", application: application.id });
  }
  let routeFiles = 0;
  const entryFiles = [];
  for (const routeRoot of application.routeRoots) {
    if (seenRoots.has(routeRoot)) issues.push({ type: "duplicate_route_root", application: application.id, routeRoot });
    seenRoots.add(routeRoot);
    const files = jsFiles(routeRoot);
    if (files === null) issues.push({ type: "missing_route_root", application: application.id, routeRoot });
    else {
      routeFiles += files.length;
      entryFiles.push(...files);
    }
  }
  const inventory = inventorySourceFiles({ root, entryFiles });
  const schemaModels = new Set(inventory.mongoModels);
  const tools = [...registry._tools.values()]
    .filter((tool) => (application.toolPrefixes || []).some((prefix) => tool.name.startsWith(prefix)))
    .map((tool) => tool.name)
    .sort();
  if ([CATALOGUED, PARTIAL].includes(application.status) && !tools.length) {
    issues.push({ type: "catalogued_application_without_tools", application: application.id });
  }
  const sourceExclusions = application.excludedSources || {};
  for (const [source, reason] of Object.entries(sourceExclusions)) {
    if (!String(reason || "").trim()) issues.push({ type: "source_exclusion_without_reason", application: application.id, source });
    const [kind, ...rest] = source.split(":");
    const value = rest.join(":");
    const discovered = kind === "mongo" ? schemaModels.has(value)
      : kind === "firestore" ? inventory.firestoreCollections.includes(value)
        : kind === "adapter" ? inventory.externalModules.includes(value) : false;
    if (!discovered) issues.push({ type: "source_exclusion_not_discovered", application: application.id, source });
  }
  const excludedModels = [...schemaModels].filter((model) => sourceExclusions[`mongo:${model}`]);
  const contracted = [...schemaModels].filter((model) => contractedModels.has(model));
  const uncontracted = [...schemaModels]
    .filter((model) => !contractedModels.has(model) && !sourceExclusions[`mongo:${model}`])
    .sort();
  const contractedFirestoreCollections = inventory.firestoreCollections
    .filter((collection) => contractedCollections.has(collection));
  const uncontractedFirestoreCollections = inventory.firestoreCollections
    .filter((collection) => !contractedCollections.has(collection) && !sourceExclusions[`firestore:${collection}`]);
  const contractedExternalModules = inventory.externalModules
    .filter((moduleName) => contractedAdapters.has(moduleName));
  const uncontractedExternalModules = inventory.externalModules
    .filter((moduleName) => !contractedAdapters.has(moduleName) && !sourceExclusions[`adapter:${moduleName}`]);
  if (application.status === CATALOGUED) {
    if (uncontracted.length) issues.push({
      type: "catalogued_application_has_uncontracted_models",
      application: application.id,
      count: uncontracted.length,
    });
    if (uncontractedFirestoreCollections.length) issues.push({
      type: "catalogued_application_has_uncontracted_firestore",
      application: application.id,
      count: uncontractedFirestoreCollections.length,
    });
    if (inventory.unresolvedCollections.length) issues.push({
      type: "catalogued_application_has_unresolved_firestore",
      application: application.id,
      count: inventory.unresolvedCollections.length,
    });
    if (uncontractedExternalModules.length) issues.push({
      type: "catalogued_application_has_uncontracted_external_adapter",
      application: application.id,
      modules: uncontractedExternalModules,
    });
  }
  return {
    id: application.id,
    status: application.status,
    routeFiles,
    tools: tools.length,
    schemaModels: schemaModels.size,
    schemaModelFiles: inventory.mongoModels,
    contractedSchemaModels: contracted.length,
    excludedSchemaModels: excludedModels.length,
    excludedSources: Object.entries(sourceExclusions).map(([source, reason]) => ({ source, reason })),
    uncontractedSchemaModels: uncontracted,
    firestoreCollections: inventory.firestoreCollections.length,
    firestoreCollectionNames: inventory.firestoreCollections,
    contractedFirestoreCollections: contractedFirestoreCollections.length,
    uncontractedFirestoreCollections,
    unresolvedCollectionReferences: inventory.unresolvedCollections,
    externalDataModules: inventory.externalModules,
    contractedExternalDataModules: contractedExternalModules,
    uncontractedExternalDataModules: uncontractedExternalModules,
    scannedSourceFiles: inventory.scannedFiles,
    reason: application.reason || null,
  };
});

const pending = applications.filter((application) => application.status === PENDING);
const partial = applications.filter((application) => application.status === PARTIAL);
const discoveredModels = new Set(applications.flatMap((application) => application.schemaModelFiles));
const discoveredCollections = new Set(applications.flatMap((application) => application.firestoreCollectionNames));
const discoveredAdapters = new Set(applications.flatMap((application) => application.externalDataModules));
const result = {
  complete: pending.length === 0 && partial.length === 0 && issues.length === 0,
  applications: applications.length,
  catalogued: applications.filter((application) => application.status === CATALOGUED).length,
  partial: partial.length,
  pending: pending.length,
  excluded: applications.filter((application) => application.status === EXCLUDED).length,
  routeFiles: applications.reduce((sum, application) => sum + application.routeFiles, 0),
  schemaModels: discoveredModels.size,
  contractedSchemaModels: [...discoveredModels].filter((model) => contractedModels.has(model)).length,
  uncontractedSchemaModels: [...new Set(applications
    .filter((application) => application.status !== EXCLUDED)
    .flatMap((application) => application.uncontractedSchemaModels))].length,
  firestoreCollections: discoveredCollections.size,
  contractedFirestoreCollections: [...discoveredCollections]
    .filter((collection) => contractedCollections.has(collection)).length,
  uncontractedFirestoreCollections: [...new Set(applications
    .filter((application) => application.status !== EXCLUDED)
    .flatMap((application) => application.uncontractedFirestoreCollections))].length,
  externalDataAdapters: discoveredAdapters.size,
  contractedExternalDataAdapters: [...discoveredAdapters]
    .filter((moduleName) => contractedAdapters.has(moduleName)).length,
  uncontractedExternalDataAdapters: [...new Set(applications
    .filter((application) => application.status !== EXCLUDED)
    .flatMap((application) => application.uncontractedExternalDataModules))].length,
  unresolvedCollectionReferences: applications.reduce(
    (sum, application) => sum + application.unresolvedCollectionReferences.length,
    0
  ),
  pendingApplications: pending.map((application) => application.id),
  partialApplications: partial.map((application) => application.id),
  modelCoverageByApplication: Object.fromEntries(applications
    .filter((application) => application.status !== EXCLUDED && application.schemaModels)
    .map((application) => [application.id, {
      discovered: application.schemaModels,
      contracted: application.contractedSchemaModels,
      pending: application.uncontractedSchemaModels,
    }])),
  firestoreCoverageByApplication: Object.fromEntries(applications
    .filter((application) => application.status !== EXCLUDED && application.firestoreCollections)
    .map((application) => [application.id, {
      discovered: application.firestoreCollections,
      contracted: application.contractedFirestoreCollections,
      pending: application.uncontractedFirestoreCollections,
      unresolvedReferences: application.unresolvedCollectionReferences,
    }])),
  issues,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (issues.length) process.exitCode = 1;
