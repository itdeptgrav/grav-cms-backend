"use strict";

const PurchaseOrder = require("../models/CMS_Models/Store/PurchaseOrder");
const WorkerWorkOrder = require("../models/CMS_Models/Store/WorkerWorkOrder");
const StockIssuance = require("../models/CMS_Models/Inventory/Operations/StockIssuance");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const ManufacturingWorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const { CONTRACTS } = require("./storeApplicationFieldContracts");
const { DEFINITIONS } = require("./storeSemanticContract");
const { includesTerm } = require("./ai/semanticCatalogue");
const { pathValues } = require("./storeAssistantContext");

const RECORDS = "__records__";
const NONE = "__none__";
const RESOLVE_FROM_RECORDS = "__resolve_from_authorised_records__";
const OPERATIONS = Object.freeze(["list", "count", "exists", "sum", "average", "minimum", "maximum", "group_count"]);
const FILTER_OPERATORS = Object.freeze([NONE, "equals", "contains", "greater_than", "less_than", "at_least", "at_most", "is_recorded", "is_missing"]);
const SORTS = Object.freeze(["ascending", "descending"]);
const scanCap = () => Math.max(1, parseInt(process.env.STORE_ASSISTANT_COLLECTION_SCAN_CAP, 10) || 2000);

const contract = (id) => CONTRACTS.find((item) => item.id === id);
const ENTITY_SPECS = Object.freeze([
  { id: "purchase_order", label: "purchase order", model: PurchaseOrder, contract: contract("store.purchase_order"), identity: "poNumber" },
  { id: "worker_work_order", label: "worker work order", model: WorkerWorkOrder, contract: contract("store.worker_work_order"), identity: "workOrderNumber" },
  { id: "order_request", label: "order request", model: CustomerRequest, contract: contract("store.customer_request_view"), identity: "requestId" },
  { id: "manufacturing_work_order", label: "manufacturing work order", model: ManufacturingWorkOrder, contract: contract("store.manufacturing_work_order_view"), identity: "workOrderNumber" },
  { id: "stock_item_bom", label: "stock item", model: StockItem, contract: contract("store.stock_item_bom_view"), identity: "name" },
  { id: "stock_issuance", label: "stock issuance", model: StockIssuance, contract: contract("store.stock_issuance_view"), identity: "createdAt" },
]);
const SPEC_BY_ID = new Map(ENTITY_SPECS.map((item) => [item.id, item]));
const DEFINITIONS_BY_ENTITY = Object.freeze(Object.fromEntries(ENTITY_SPECS.map((spec) => [
  spec.id,
  Object.freeze(DEFINITIONS.filter((item) => item.entity === spec.id && item.query === "record_field")),
])));
const DEFINITION_BY_ID = new Map(Object.values(DEFINITIONS_BY_ENTITY).flat().map((item) => [item.id, item]));

function text(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function display(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  if (valueType === "money" && Number.isFinite(Number(value))) {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value));
  }
  return text(value);
}

function definitionFor(entity, id, allowSpecial = false) {
  if (allowSpecial && [RECORDS, NONE].includes(id)) return id;
  const definition = DEFINITION_BY_ID.get(id);
  return definition?.entity === entity ? definition : null;
}

function comparable(value, valueType) {
  if (["number", "money"].includes(valueType)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  if (valueType === "date_time") {
    const instant = new Date(value).getTime();
    return Number.isFinite(instant) ? instant : null;
  }
  if (valueType === "boolean") {
    const normalized = text(value).trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
    return null;
  }
  return text(value).trim().toLowerCase();
}

function filterMatches(record, definition, operator, rawValue) {
  const values = pathValues(record, definition.path);
  if (operator === "is_recorded") return values.length > 0;
  if (operator === "is_missing") return values.length === 0;
  const wanted = comparable(rawValue, definition.valueType);
  if (wanted === null || wanted === "") return false;
  return values.some((value) => {
    const actual = comparable(value, definition.valueType);
    if (actual === null) return false;
    if (operator === "equals") return actual === wanted;
    if (operator === "contains") return text(actual).includes(text(wanted).toLowerCase());
    if (operator === "greater_than") return actual > wanted;
    if (operator === "less_than") return actual < wanted;
    if (operator === "at_least") return actual >= wanted;
    if (operator === "at_most") return actual <= wanted;
    return false;
  });
}

function dateMatches(record, definition, from, to) {
  if (!definition || (!from && !to)) return true;
  const low = from ? new Date(`${from}T00:00:00.000+05:30`).getTime() : null;
  const high = to ? new Date(`${to}T23:59:59.999+05:30`).getTime() : null;
  return pathValues(record, definition.path).some((value) => {
    const instant = new Date(value).getTime();
    return Number.isFinite(instant) && (low === null || instant >= low) && (high === null || instant <= high);
  });
}

function explicitOutputs(entity, message) {
  const beforeFilter = String(message || "").split(/\b(?:for|where|whose|with|from)\b/i)[0];
  if (!/\b(list|show|give|display|tell)\b/i.test(beforeFilter)) return [];
  return (DEFINITIONS_BY_ENTITY[entity] || [])
    .map((definition) => ({
      definition,
      alias: [...(definition.aliases || [])].sort((a, b) => b.length - a.length)
        .find((alias) => includesTerm(beforeFilter, alias)),
    }))
    .filter((item) => item.alias)
    .sort((a, b) => beforeFilter.toLowerCase().indexOf(a.alias.toLowerCase())
      - beforeFilter.toLowerCase().indexOf(b.alias.toLowerCase()))
    .map((item) => item.definition)
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 3);
}

function reconcileFilter(args, entity, message, suffix = "") {
  const fieldKey = `filterMetric${suffix}`;
  const operatorKey = `filterOperator${suffix}`;
  const valueKey = `filterValue${suffix}`;
  const definition = definitionFor(entity, args[fieldKey]);
  const filterClause = (String(message || "").match(/\b(?:for|where|whose|with|from)\b([\s\S]*)/i) || [])[1] || "";
  const fieldGrounded = definition?.aliases?.some((alias) => includesTerm(message, alias));
  const noValue = ["is_recorded", "is_missing"].includes(args[operatorKey]);
  const presenceGrounded = args[operatorKey] === "is_missing"
    ? /\b(missing|not recorded|without|blank|empty|no value)\b/i.test(message)
    : args[operatorKey] === "is_recorded"
      ? /\b(recorded|available|present|filled|set)\b/i.test(message)
      : false;
  const valueGrounded = typeof args[valueKey] === "string" && includesTerm(message, args[valueKey].replace(/_/g, " "));
  const resolvable = definition?.valueType === "text" && ["equals", "contains"].includes(args[operatorKey]);
  const fieldInFilterClause = definition?.aliases?.some((alias) => (
    includesTerm(filterClause, alias)
    || String(alias).split(/\s+/).some((word) => word.length >= 3 && includesTerm(filterClause, word))
  ));
  if (!definition || !fieldGrounded
      || (noValue && !presenceGrounded)
      || (!noValue && !valueGrounded && !(resolvable && fieldInFilterClause))) {
    args[fieldKey] = NONE;
    args[operatorKey] = NONE;
    delete args[valueKey];
  } else if (!noValue && !valueGrounded && resolvable && fieldInFilterClause) {
    args[valueKey] = RESOLVE_FROM_RECORDS;
  }
}

function reconcileArgs(entity, proposed = {}, message = "") {
  const args = { ...proposed };
  const outputs = explicitOutputs(entity, message);
  if (args.operation !== "list") {
    args.outputMetric2 = NONE;
    args.outputMetric3 = NONE;
  } else if (outputs.length) {
    args.metric = outputs[0].id;
    args.outputMetric2 = outputs[1]?.id || NONE;
    args.outputMetric3 = outputs[2]?.id || NONE;
  } else if (args.metric === RECORDS) {
    args.outputMetric2 = NONE;
    args.outputMetric3 = NONE;
  }
  for (const suffix of ["", "2", "3"]) reconcileFilter(args, entity, message, suffix);
  const spec = SPEC_BY_ID.get(entity);
  const status = DEFINITIONS_BY_ENTITY[entity]?.find((item) => item.path === "status");
  if (status && spec?.model.schema.path("status")?.enumValues?.length) {
    const selected = spec.model.schema.path("status").enumValues
      .find((value) => includesTerm(message, String(value).replace(/_/g, " ")));
    if (selected) {
      args.filterMetric = status.id;
      args.filterOperator = "equals";
      args.filterValue = selected;
    }
  }
  if (args.operation === "group_count") {
    for (const suffix of ["", "2", "3"]) {
      if (args[`filterMetric${suffix}`] === args.metric) {
        args[`filterMetric${suffix}`] = NONE;
        args[`filterOperator${suffix}`] = NONE;
        delete args[`filterValue${suffix}`];
      }
    }
  }
  if (!args.from && !args.to) {
    args.dateMetric = NONE;
    delete args.from;
    delete args.to;
  }
  return args;
}

function validate(entity, args = {}) {
  const spec = SPEC_BY_ID.get(entity);
  const operation = OPERATIONS.includes(args.operation) ? args.operation : null;
  const selected = definitionFor(entity, args.metric, true);
  const outputs = [args.outputMetric2 || NONE, args.outputMetric3 || NONE].map((id) => definitionFor(entity, id, true));
  const filters = ["", "2", "3"].map((suffix) => ({
    definition: definitionFor(entity, args[`filterMetric${suffix}`] || NONE, true),
    operator: FILTER_OPERATORS.includes(args[`filterOperator${suffix}`]) ? args[`filterOperator${suffix}`] : NONE,
    value: args[`filterValue${suffix}`],
  }));
  const dateDefinition = definitionFor(entity, args.dateMetric || NONE, true);
  if (!spec || !operation || !selected || outputs.some((item) => !item) || filters.some((item) => !item.definition) || !dateDefinition) {
    return { error: "That Store collection query is outside the safe catalogue." };
  }
  if (["sum", "average", "minimum", "maximum"].includes(operation)
      && (selected === RECORDS || !["number", "money"].includes(selected.valueType))) {
    return { error: "That calculation requires a catalogued numeric field." };
  }
  if (operation === "group_count" && selected === RECORDS) return { error: "A grouped count needs a catalogued field." };
  for (const filter of filters) {
    if ((filter.definition === NONE) !== (filter.operator === NONE)) return { error: "A Store filter field and operator must be supplied together." };
    if (filter.definition !== NONE && !["is_recorded", "is_missing"].includes(filter.operator) && !text(filter.value)) {
      return { error: "That Store filter needs a value from the question." };
    }
  }
  if (dateDefinition !== NONE && dateDefinition.valueType !== "date_time") return { error: "A date range requires a catalogued Store date field." };
  if ((args.from || args.to) && dateDefinition === NONE) return { error: "A date range was supplied without a Store date field." };
  return { spec, operation, selected, outputs: outputs.filter((item) => item !== NONE), filters: filters.filter((item) => item.definition !== NONE), dateDefinition };
}

async function queryCollection({ entity, args, message } = {}) {
  const reconciled = reconcileArgs(entity, args, message);
  const checked = validate(entity, reconciled);
  if (checked.error) return { ok: false, reason: checked.error };
  const { spec, operation, selected, outputs, filters, dateDefinition } = checked;
  const cap = scanCap();
  const storedCount = await spec.model.countDocuments({});
  const records = await spec.model.find({}).select(`${spec.contract.projection()} -_id`).limit(cap).lean();
  for (const filter of filters) {
    if (filter.value !== RESOLVE_FROM_RECORDS) continue;
    const candidates = [...new Set(records.flatMap((row) => pathValues(row, filter.definition.path)).map(text).filter(Boolean))]
      .filter((value) => includesTerm(message, value)).sort((a, b) => b.length - a.length);
    if (candidates.length > 1 && candidates[0].length === candidates[1].length) {
      return { ok: false, reason: `More than one ${filter.definition.label} matches. Please give the exact recorded value.` };
    }
    filter.value = candidates[0] || Symbol("no_authorised_value_match");
  }
  const query = text(reconciled.query).trim().toLowerCase();
  const matched = records.filter((row) => {
    if (query && !pathValues(row, spec.identity).some((value) => text(value).toLowerCase().includes(query))) return false;
    if (!filters.every((filter) => filterMatches(row, filter.definition, filter.operator, filter.value))) return false;
    return dateMatches(row, dateDefinition === NONE ? null : dateDefinition, reconciled.from, reconciled.to);
  });
  const truncated = storedCount > cap;
  if (["count", "exists"].includes(operation)) return { ok: true, operation, count: matched.length, label: spec.label, truncated };
  const values = selected === RECORDS ? [] : matched.flatMap((row) => pathValues(row, selected.path));
  if (["sum", "average", "minimum", "maximum"].includes(operation)) {
    const numbers = values.map(Number).filter(Number.isFinite);
    let value = null;
    if (numbers.length) {
      if (operation === "sum") value = numbers.reduce((total, item) => total + item, 0);
      if (operation === "average") value = numbers.reduce((total, item) => total + item, 0) / numbers.length;
      if (operation === "minimum") value = Math.min(...numbers);
      if (operation === "maximum") value = Math.max(...numbers);
    }
    return { ok: true, operation, value, valueCount: numbers.length, fieldLabel: selected.label, label: spec.label, truncated };
  }
  const direction = reconciled.sort === "descending" ? -1 : 1;
  const limit = Math.min(20, Math.max(1, Number.isInteger(reconciled.limit) ? reconciled.limit : 10));
  if (operation === "group_count") {
    const groups = new Map();
    for (const row of matched) {
      const keys = pathValues(row, selected.path).map((value) => display(value, selected.valueType)).filter(Boolean);
      for (const key of new Set(keys.length ? keys : ["Not recorded"])) groups.set(key, (groups.get(key) || 0) + 1);
    }
    const rows = [...groups].map(([value, count]) => ({ value, count }))
      .sort((a, b) => direction * (a.count - b.count) || a.value.localeCompare(b.value)).slice(0, limit);
    return { ok: true, operation, rows, fieldLabel: selected.label, label: spec.label, truncated };
  }
  const selectedOutputs = selected === RECORDS ? outputs : [selected, ...outputs];
  const rows = matched.map((row) => ({
    subject: text(pathValues(row, spec.identity)[0]) || spec.label,
    values: selectedOutputs.map((definition) => ({ label: definition.label, values: pathValues(row, definition.path).map((value) => display(value, definition.valueType)).filter(Boolean) })),
  })).slice(0, limit);
  return { ok: true, operation, rows, count: matched.length, outputFieldLabels: selectedOutputs.map((item) => item.label), label: spec.label, truncated };
}

function renderCollectionQuery({ data } = {}) {
  if (!data?.ok) return data?.reason || "I couldn't verify that Store collection query.";
  const plural = `${data.label}${data.label.endsWith("s") ? "" : "s"}`;
  const bounded = data.truncated ? " The inspected set was bounded, so additional matches may exist." : "";
  if (data.operation === "exists") return `${data.count ? "Yes" : "No"}. ${data.count}${data.truncated ? " or more" : ""} matching ${plural} were found.${bounded}`;
  if (data.operation === "count") return `${data.count}${data.truncated ? " or more" : ""} matching ${plural} were found.${bounded}`;
  if (["sum", "average", "minimum", "maximum"].includes(data.operation)) {
    return data.value === null ? `No numeric ${data.fieldLabel} values were recorded.${bounded}`
      : `${data.fieldLabel} ${data.operation}: ${data.value}, from ${data.valueCount} recorded values.${bounded}`;
  }
  if (!data.rows?.length) return `No matching ${plural} were found.${bounded}`;
  if (data.operation === "group_count") return `${data.fieldLabel} grouped counts: ${data.rows.map((row) => `${row.value}: ${row.count}`).join("; ")}.${bounded}`;
  if (!data.outputFieldLabels?.length) return `Matching ${plural}: ${data.rows.map((row) => row.subject).join("; ")}.${bounded}`;
  return `${data.outputFieldLabels.join(", ")}: ${data.rows.map((row) => `${row.subject}: ${row.values.map((field) => `${field.label}: ${field.values.join(", ") || "not recorded"}`).join("; ")}`).join(" | ")}.${bounded}`;
}

module.exports = {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY, RECORDS, NONE, RESOLVE_FROM_RECORDS,
  OPERATIONS, FILTER_OPERATORS, SORTS, scanCap, reconcileArgs, validate,
  filterMatches, dateMatches, queryCollection, renderCollectionQuery,
};
