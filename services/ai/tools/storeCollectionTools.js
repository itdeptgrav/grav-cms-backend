"use strict";

const { registerTool } = require("../toolRegistry");
const { STORE_CATALOGUE_ID } = require("../../storeSemanticContract");
const {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY, RECORDS, NONE,
  OPERATIONS, FILTER_OPERATORS, SORTS, queryCollection, renderCollectionQuery,
} = require("../../storeCollectionContext");

const mayReadStore = (user) => Boolean(
  user?.applicationAccess?.store?.allowed && user.applicationAccess.store.capabilities?.read,
);

function semanticOptions(definitions, specials = []) {
  return Object.fromEntries([
    ...specials.map((id) => [id, { label: id === RECORDS ? "records" : "none", aliases: [id === RECORDS ? "records" : "none"] }]),
    ...definitions.map((item) => [item.id, { label: item.label, aliases: item.aliases || [] }]),
  ]);
}

for (const entity of ENTITY_SPECS) {
  const definitions = DEFINITIONS_BY_ENTITY[entity.id];
  const fieldIds = definitions.map((item) => item.id);
  const fields = [RECORDS, ...fieldIds];
  const optionalFields = [NONE, ...fieldIds];
  registerTool({
    name: `store_legacy_collection_${entity.id}_query`,
    application: "store",
    modelSelectable: true,
    semantic: { catalogue: STORE_CATALOGUE_ID, domains: ["store_records"], subjects: [entity.id] },
    description: `Query authorised ${entity.label} records as a collection. Use for plural lists, counts, existence, filters, date ranges, numeric aggregates and grouped counts. Choose only catalogue concepts; GRAV owns database execution and rendering.`,
    permission: mayReadStore,
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: OPERATIONS },
        metric: { type: "string", enum: fields, "x-semanticOptions": semanticOptions(definitions, [RECORDS]) },
        outputMetric2: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        outputMetric3: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        filterMetric: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        filterOperator: { type: "string", enum: FILTER_OPERATORS },
        filterValue: { type: "string", maxLength: 200 },
        filterMetric2: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        filterOperator2: { type: "string", enum: FILTER_OPERATORS },
        filterValue2: { type: "string", maxLength: 200 },
        filterMetric3: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        filterOperator3: { type: "string", enum: FILTER_OPERATORS },
        filterValue3: { type: "string", maxLength: 200 },
        dateMetric: { type: "string", enum: optionalFields, "x-semanticOptions": semanticOptions(definitions, [NONE]) },
        from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        query: { type: "string", maxLength: 200 },
        sort: { type: "string", enum: SORTS },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: [
        "operation", "metric", "outputMetric2", "outputMetric3",
        "filterMetric", "filterOperator",
        "filterMetric2", "filterOperator2",
        "filterMetric3", "filterOperator3", "dateMetric",
      ],
      additionalProperties: false,
    },
    matches: () => false,
    provideContext: ({ args, message }) => queryCollection({ entity: entity.id, args, message }),
    renderAnswer: renderCollectionQuery,
  });
}

module.exports = { mayReadStore };
