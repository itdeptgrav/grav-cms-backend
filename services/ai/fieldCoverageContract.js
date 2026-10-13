"use strict";

/**
 * Compile a source-schema coverage contract.
 *
 * Every persisted path is either exposed through a typed semantic concept or
 * excluded with a durable reason. A newly added model field therefore fails
 * the assistant audit instead of silently becoming unavailable or, worse,
 * being passed to a model through a broad document read.
 */

const SECRET_PATH = /(^|\.)(password|passwordhash|secret|token|otp|hash)(\.|$)/i;
const contracts = new Map();

function mongooseSchemaPaths(schema, prefix = "") {
  if (!schema?.paths) return [];
  const out = [];
  for (const [name, schemaType] of Object.entries(schema.paths)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (schemaType?.schema) out.push(...mongooseSchemaPaths(schemaType.schema, path));
    else out.push(path);
  }
  return [...new Set(out)].sort();
}

function compileFieldCoverageContract({
  id,
  schemaPaths = [],
  exposed = [],
  excluded = {},
  sourceModels = [],
  sourceCollections = [],
  sourceAdapters = [],
  coverageMode = "full_schema",
  projectionPaths = [],
} = {}) {
  if (!id || typeof id !== "string") throw new Error("field coverage contract id is required");
  const paths = [...new Set(schemaPaths.map(String))].sort();
  if (coverageMode === "full_schema" && paths.length === 0) {
    throw new Error(`full_schema ${id} requires at least one schema path`);
  }
  if (!["full_schema", "projection_view"].includes(coverageMode)) {
    throw new Error(`invalid field coverage mode in ${id}`);
  }
  const classifiedPaths = coverageMode === "projection_view"
    ? [...new Set(projectionPaths.map(String))].sort()
    : paths;
  if (coverageMode === "projection_view" && classifiedPaths.length === 0) {
    throw new Error(`projection_view ${id} requires projectionPaths`);
  }
  const exposedByPath = new Map();
  for (const definition of exposed) {
    if (!definition?.path || exposedByPath.has(definition.path)) {
      throw new Error(`invalid or duplicate exposed path in ${id}`);
    }
    exposedByPath.set(definition.path, Object.freeze({ ...definition }));
  }
  const excludedByPath = new Map(Object.entries(excluded).map(([path, reason]) => [path, String(reason || "").trim()]));

  const contract = Object.freeze({
    id,
    coverageMode,
    sourceModels: Object.freeze([...new Set(sourceModels.map((value) => String(value).replace(/\\/g, "/")))]),
    sourceCollections: Object.freeze([...new Set(sourceCollections.map(String))]),
    sourceAdapters: Object.freeze([...new Set(sourceAdapters.map(String))]),
    schemaPaths: Object.freeze(paths),
    classifiedPaths: Object.freeze(classifiedPaths),
    exposed: Object.freeze(Object.fromEntries(exposedByPath)),
    excluded: Object.freeze(Object.fromEntries(excludedByPath)),
    projection() {
      return [...exposedByPath.keys()].join(" ");
    },
    audit() {
      const issues = [];
      const schemaSet = new Set(paths);
      const classifiedSet = new Set(classifiedPaths);
      for (const path of classifiedPaths) {
        if (!schemaSet.has(path)) issues.push({ type: "projection_field_missing_from_schema", path });
        const isExposed = exposedByPath.has(path);
        const isExcluded = excludedByPath.has(path);
        if (!isExposed && !isExcluded) issues.push({ type: "unclassified_source_field", path });
        if (isExposed && isExcluded) issues.push({ type: "field_both_exposed_and_excluded", path });
      }
      for (const [path, definition] of exposedByPath) {
        if (!classifiedSet.has(path)) issues.push({ type: "exposed_field_outside_contract_scope", path });
        if (!definition.id || !definition.label || !definition.valueType) {
          issues.push({ type: "incomplete_exposed_field", path });
        }
        if (SECRET_PATH.test(path)) issues.push({ type: "secret_field_exposed", path });
      }
      for (const [path, reason] of excludedByPath) {
        if (!classifiedSet.has(path)) issues.push({ type: "excluded_field_outside_contract_scope", path });
        if (!reason) issues.push({ type: "excluded_field_without_reason", path });
      }
      return {
        ok: issues.length === 0,
        id,
        coverageMode,
        schemaFieldCount: paths.length,
        classifiedFieldCount: classifiedPaths.length,
        exposedFieldCount: exposedByPath.size,
        excludedFieldCount: excludedByPath.size,
        issues,
      };
    },
  });
  contracts.set(id, contract);
  return contract;
}

const getFieldCoverageContracts = () => [...contracts.values()];
const clearFieldCoverageContracts = () => contracts.clear();

module.exports = {
  compileFieldCoverageContract,
  mongooseSchemaPaths,
  getFieldCoverageContracts,
  _clearFieldCoverageContracts: clearFieldCoverageContracts,
};
