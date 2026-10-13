"use strict";

const { registerTool } = require("../toolRegistry");
const { includesTerm } = require("../semanticCatalogue");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const {
  CATALOGUE_ID, ENTITY_SPECS, DEFINITIONS_BY_ENTITY, WORKFLOW_BY_ENTITY,
} = require("../../storePurchaseUniversalContract");
const {
  queryCollection, renderCollectionQuery, RECORDS, NONE, OPERATIONS, FILTER_OPERATORS, SORTS,
} = require("../../storePurchaseCollectionContext");
const { recordLink } = require("../assistantLinks");

const mayReadStore = (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ));

for (const entity of ENTITY_SPECS) {
  const definitions = DEFINITIONS_BY_ENTITY[entity.id] || [];
  const metricIds = definitions.map((definition) => definition.id);
  const meanings = Object.fromEntries(definitions.map((definition) => [definition.id, {
    label: definition.label.replace(new RegExp(`^${entity.label}\\s+`, "i"), ""),
    aliases: definition.aliases,
  }]));
  const entityTerms = [entity.label, ...(entity.aliases || [])];
  registerTool({
    name: `store_collection_${entity.id}_query`,
    application: "store_purchase",
    modelSelectable: true,
    /* `labels` are the names this family answers to, longest-first. Routing
       uses the LONGEST one a question contains, so "goods receipt put-aways"
       reaches the put-away capability rather than the goods-receipt one
       whose shorter name is a prefix of it. */
    semantic: {
      catalogue: CATALOGUE_ID,
      domains: [entity.id],
      subjects: [entity.id],
      labels: [...entityTerms].sort((a, b) => b.length - a.length),
    },
    description: `Query authorised ${entity.label} records as a collection. Use for plural/list, count, existence, filter, date-range, numeric aggregate or grouped-count questions. For count/existence use the records metric. Use no filter and no date field unless the question explicitly asks for them; status wording filters the status concept rather than a quantity.${entity.id === "goods_receipt" ? " These are already-recorded receipts only; expected, pending or not-yet-received arrivals belong to the receiving-register capability." : ""} The model chooses only catalogued semantic fields; database fields and raw records remain hidden.`,
    permission: mayReadStore,
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", enum: OPERATIONS },
        metric: {
          type: "string", enum: [RECORDS, ...metricIds],
          "x-semanticOptions": { [RECORDS]: { label: "records", aliases: ["records", "entries", "documents", "how many", "any"] }, ...meanings },
        },
        outputMetric2: {
          type: "string", enum: [NONE, ...metricIds],
          "x-semanticOptions": { [NONE]: { label: "no second output field", aliases: ["only"] }, ...meanings },
        },
        outputMetric3: {
          type: "string", enum: [NONE, ...metricIds],
          "x-semanticOptions": { [NONE]: { label: "no third output field", aliases: ["only"] }, ...meanings },
        },
        filterMetric: {
          type: "string", enum: [NONE, ...metricIds],
          "x-semanticOptions": { [NONE]: { label: "no field filter", aliases: ["all"] }, ...meanings },
          /* ── WHICH ALIASES ARE RECORDED VALUES ────────────────────────
             The workflow concept lists both its NAME and its recorded
             VALUES among its aliases, and a caller that cannot tell them
             apart reports the field where it was asked to filter by it:
             "reserved barcodes" listed every barcode with its state
             beside it. Declaring the values says which word means what. */
          ...(WORKFLOW_BY_ENTITY[entity.id] ? {
            "x-semanticValues": Object.fromEntries(
              (WORKFLOW_BY_ENTITY[entity.id].fields || []).map((field) => [
                `sp.${entity.id}.${String(field.path).toLowerCase()}`, field.recorded,
              ]),
            ),
          } : {}),
        },
        filterOperator: { type: "string", enum: FILTER_OPERATORS },
        filterValue: { type: "string", maxLength: 200 },
        filterMetric2: {
          type: "string", enum: [NONE, ...metricIds],
          "x-semanticOptions": { [NONE]: { label: "no second field filter", aliases: ["all"] }, ...meanings },
        },
        filterOperator2: { type: "string", enum: FILTER_OPERATORS },
        filterValue2: { type: "string", maxLength: 200 },
        filterMetric3: {
          type: "string", enum: [NONE, ...metricIds],
          "x-semanticOptions": { [NONE]: { label: "no third field filter", aliases: ["all"] }, ...meanings },
        },
        filterOperator3: { type: "string", enum: FILTER_OPERATORS },
        filterValue3: { type: "string", maxLength: 200 },
        dateMetric: {
          type: "string", enum: [NONE, ...definitions.filter((definition) => definition.valueType === "date_time").map((definition) => definition.id)],
          "x-semanticOptions": { [NONE]: { label: "no date range", aliases: ["current", "all time"] }, ...meanings },
        },
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
    matches: (message) => entityTerms.some((term) => includesTerm(message, term)),
    provideContext: ({ user, args, message }) => queryCollection({ entity: entity.id, user, args, message }),
    renderAnswer: renderCollectionQuery,
    buildLinks: ({ data }) => (data?.navigation || []).map((item) => (
      recordLink(item.entity, item.recordId, item.label)
    )).filter(Boolean),
  });
}

module.exports = { renderCollectionQuery };
