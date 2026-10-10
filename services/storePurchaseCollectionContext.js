"use strict";

const {
  ENTITY_SPECS, DEFINITIONS_BY_ENTITY, metric,
} = require("./storePurchaseUniversalContract");
const {
  scopeFor, identityValues, valuesAtPath,
} = require("./storePurchaseUniversalContext");
const { includesTerm } = require("./ai/semanticCatalogue");

const RECORDS = "__records__";
const NONE = "__none__";
const RESOLVE_FROM_RECORDS = "__resolve_from_authorised_records__";
const OPERATIONS = Object.freeze(["list", "count", "exists", "sum", "average", "minimum", "maximum", "group_count"]);
const FILTER_OPERATORS = Object.freeze([NONE, "equals", "contains", "greater_than", "less_than", "at_least", "at_most", "is_recorded", "is_missing"]);
const SORTS = Object.freeze(["ascending", "descending"]);
const scanCap = () => Math.max(1, parseInt(process.env.STORE_ASSISTANT_COLLECTION_SCAN_CAP, 10) || 2000);

const specById = new Map(ENTITY_SPECS.map((entry) => [entry.id, entry]));

function definitionFor(entity, id, { allowSpecial = false } = {}) {
  if (allowSpecial && (id === RECORDS || id === NONE)) return id;
  const definition = metric(id);
  return definition?.entity === entity ? definition : null;
}

function text(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

// Business labels commonly differ only by punctuation or a harmless plural
// (for example, "Gaurav enterprise" versus the stored "Gaurav Enterprises").
// Keep this deliberately narrower than fuzzy search: identity resolution may
// normalise those surface differences, but it must never guess a different
// supplier, document reference or person from edit distance alone.
function normaliseIdentityPhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")
      ? token.slice(0, -1)
      : token))
    .join(" ");
}

function phraseIncluded(haystack, needle) {
  const source = normaliseIdentityPhrase(haystack);
  const target = normaliseIdentityPhrase(needle);
  return Boolean(target && ` ${source} `.includes(` ${target} `));
}

function normaliseTextValue(value) {
  return text(value)
    .toLowerCase()
    .replace(/[\u2019']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve an implied collection constraint from server-authorised identity
 * values. Qwen never sees or chooses these values. A unique longest match is
 * safe to turn into an equality filter; tied fields/values are clarification,
 * never a reason to execute a broader query.
 */
function inferIdentityConstraint({ spec, definitions = [], records = [], message = "" } = {}) {
  const identityDefinitions = spec.identityPaths
    .map((path) => definitions.find((definition) => definition.path === path && definition.valueType === "text"))
    .filter(Boolean);
  const matches = [];
  for (const definition of identityDefinitions) {
    const values = [...new Set(records.flatMap((record) => valuesAtPath(record, definition.path))
      .map((value) => text(value).trim()).filter(Boolean))];
    for (const value of values) {
      const normalised = normaliseIdentityPhrase(value);
      if (normalised.length < 3 || !phraseIncluded(message, value)) continue;
      matches.push({ definition, value, length: normalised.length });
    }
  }
  if (!matches.length) return { found: false, ambiguous: false };
  matches.sort((a, b) => b.length - a.length
    || spec.identityPaths.indexOf(a.definition.path) - spec.identityPaths.indexOf(b.definition.path)
    || a.value.localeCompare(b.value));
  const longest = matches[0].length;
  const winners = matches.filter((match) => match.length === longest);
  const unique = [...new Map(winners.map((match) => [
    `${match.definition.id}\u0000${String(match.value).trim().toLowerCase()}`, match,
  ])).values()];
  if (unique.length !== 1) {
    return {
      found: false,
      ambiguous: true,
      labels: unique.slice(0, 5).map((match) => `${match.definition.label}: ${match.value}`),
    };
  }
  return { found: true, ambiguous: false, definition: unique[0].definition, value: unique[0].value };
}

function unresolvedConstraintTail(message, spec) {
  const source = String(message || "");
  const entityTerms = [spec.label, ...(spec.aliases || [])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  let entityEnd = -1;
  const lower = source.toLowerCase();
  for (const term of entityTerms) {
    const index = lower.indexOf(String(term).toLowerCase());
    if (index >= 0) entityEnd = Math.max(entityEnd, index + String(term).length);
  }
  if (entityEnd < 0) return "";
  const afterEntity = source.slice(entityEnd);
  const match = afterEntity.match(/\b(?:of|for|from|by|with|whose|where)\b([\s\S]*)/i);
  if (!match) return "";
  return normaliseIdentityPhrase(match[1]);
}

function display(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  if (typeof value === "object") return JSON.stringify(value).slice(0, 500);
  return String(value);
}

function comparable(value, valueType) {
  if (valueType === "number") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (valueType === "date_time") {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (valueType === "boolean") {
    const normalized = text(value).trim().toLowerCase();
    if (["true", "yes", "1"].includes(normalized)) return true;
    if (["false", "no", "0"].includes(normalized)) return false;
    return null;
  }
  return normaliseTextValue(value);
}

function filterMatches(record, definition, operator, rawValue) {
  if (!definition || operator === NONE) return true;
  const values = valuesAtPath(record, definition.path);
  if (operator === "is_recorded") return values.length > 0;
  if (operator === "is_missing") return values.length === 0;
  const wanted = comparable(rawValue, definition.valueType);
  if (wanted === null || wanted === "") return false;
  return values.some((value) => {
    const actual = comparable(value, definition.valueType);
    if (actual === null) return false;
    if (operator === "equals") return actual === wanted;
    if (operator === "contains") return text(actual).toLowerCase().includes(text(wanted).toLowerCase());
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
  return valuesAtPath(record, definition.path).some((value) => {
    const instant = new Date(value).getTime();
    return Number.isFinite(instant) && (low === null || instant >= low) && (high === null || instant <= high);
  });
}

function labelFor(spec, record) {
  return identityValues(spec, record)[0] || spec.label;
}

/**
 * Does this exact recorded VALUE stand alone in the question?
 *
 * `includesTerm` treats a hyphen as a word boundary, which is right for
 * aliases — "16mm-flex-pipe" names the same thing as "16mm flex pipe" — and
 * wrong for a closed status value: "half-approved material requests" was
 * read as the APPROVED ones, and answered with a filter nobody asked for.
 * A status is a whole word or it is not that status.
 */
function valueStandsAlone(message, value) {
  const term = String(value ?? "").trim().toLowerCase();
  if (!term) return false;
  /* A separator INSIDE the value is flexible — the recorded `1-10` is the
     same band as "1 10" and `PARTIALLY_RECEIVED` the same status as
     "partially received". A separator at the EDGE is a boundary and is not
     crossed, which is the whole point: "half-approved" is not "approved". */
  const escaped = term
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[\s_-]+/g, "[\\s_-]+");
  return new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`, "i")
    .test(String(message || "").toLowerCase());
}

/**
 * The question with the entity's own name taken out of it.
 *
 * ── WHY A VALUE CAN HIDE INSIDE A NAME ────────────────────────────────────
 * An account's `lifecycleStage` records "customer", and the entity is called
 * a "customer account". "Customer accounts" is the NAME of what is being
 * asked for, not a filter on it — grounding the value there turned a plain
 * list into a search for accounts at the customer stage and answered "none
 * found" about records that were sitting in the collection.
 *
 * But the same word IS a filter when it appears anywhere else: "sales
 * journeys from source sales" means the ones whose source is sales. So the
 * name is removed from the sentence and the value is looked for in what is
 * left — not suppressed outright, which would lose the second question to
 * save the first.
 */
function withoutEntityName(spec, message) {
  let text = String(message || "");
  const names = [spec.label, ...(spec.aliases || [])]
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s_-]+/g, "[\\s_-]+");
    text = text.replace(new RegExp(`(^|[^a-z0-9-])${escaped}(s?)([^a-z0-9-]|$)`, "gi"), "$1 $3");
  }
  return text;
}

function enumValueFromQuestion(spec, definition, message) {
  if (!definition) return null;
  const values = spec.model.schema.path(definition.path)?.enumValues || [];
  const outside = withoutEntityName(spec, message);
  return values.find((value) => valueStandsAlone(outside, value)) || null;
}

function filterFieldAliases(entity, definition) {
  const spec = specById.get(entity);
  const enumTerms = new Set((spec?.model.schema.path(definition.path)?.enumValues || [])
    .filter((value) => value !== null && value !== undefined && String(value).trim())
    .map((value) => normaliseTextValue(String(value).replace(/_/g, " "))));
  return (definition.aliases || []).filter((alias) => !enumTerms.has(normaliseTextValue(alias)));
}

function explicitFilterDefinition(entity, message) {
  const clause = (String(message || "").match(/\b(?:for|where|whose|with|from|of|by)\b([\s\S]*)/i) || [])[1] || "";
  if (!clause) return null;
  const matches = (DEFINITIONS_BY_ENTITY[entity] || []).flatMap((definition) => (
    filterFieldAliases(entity, definition).flatMap((alias) => (
      includesTerm(clause, alias) ? [{ definition, length: normaliseTextValue(alias).length }] : []
    ))
  ));
  if (!matches.length) return null;
  matches.sort((a, b) => b.length - a.length);
  const longest = matches[0].length;
  const winners = [...new Map(matches.filter((match) => match.length === longest)
    .map((match) => [match.definition.id, match.definition])).values()];
  return winners.length === 1 ? winners[0] : null;
}

function singleNumericValue(value) {
  const matches = String(value || "").match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
  if (matches.length !== 1) return null;
  const parsed = Number(matches[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? String(parsed) : null;
}

function dateFieldAliases(definition) {
  const aliases = [...(definition.aliases || []), ...(definition.dateAliases || [])];
  return [...new Set(aliases.flatMap((alias) => {
    const natural = normaliseTextValue(alias);
    const shortened = natural.replace(/\b(?:date|at)\b$/i, "").trim();
    return shortened && shortened.length >= 3 ? [natural, shortened] : [natural];
  }).filter(Boolean))];
}

function explicitDateDefinition(entity, message) {
  const matches = (DEFINITIONS_BY_ENTITY[entity] || [])
    .filter((definition) => definition.valueType === "date_time")
    .flatMap((definition) => dateFieldAliases(definition).flatMap((alias) => (
      includesTerm(message, alias) ? [{ definition, length: alias.length }] : []
    )));
  if (!matches.length) return null;
  matches.sort((a, b) => b.length - a.length);
  const longest = matches[0].length;
  const winners = [...new Map(matches.filter((match) => match.length === longest)
    .map((match) => [match.definition.id, match.definition])).values()];
  return winners.length === 1 ? winners[0] : null;
}

function explicitOutputDefinitions(entity, message) {
  const definitions = DEFINITIONS_BY_ENTITY[entity] || [];
  const textValue = String(message || "");
  if (!/\b(list|show|give|display|tell)\b/i.test(textValue)) return [];
  const firstConnector = textValue.search(/\b(?:for|where|whose|with|from|of|by)\b/i);
  const candidates = definitions.flatMap((definition) => {
    const aliases = (definition.aliases || []).filter((alias) => {
      if (!includesTerm(textValue, alias)) return false;
      const aliasIndex = textValue.toLowerCase().indexOf(String(alias).toLowerCase());
      // A connector inside the field's own label ("sync for revision") is
      // still part of the requested output. A field first mentioned after the
      // connector ("PO number from vendor Acme") belongs to the constraint.
      return firstConnector < 0 || aliasIndex <= firstConnector;
    });
    if (!aliases.length) return [];
    const best = aliases.sort((a, b) => b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length)[0];
    return [{ definition, alias: best, index: textValue.toLowerCase().indexOf(best.toLowerCase()) }];
  }).sort((a, b) => a.index - b.index || b.alias.length - a.alias.length);
  const selected = [];
  for (const candidate of candidates) {
    if (selected.some((item) => item.id === candidate.definition.id)) continue;
    selected.push(candidate.definition);
    if (selected.length === 3) break;
  }
  return selected;
}

function reconcileFilterSlot(args, entity, message, suffix = "") {
  const metricKey = `filterMetric${suffix}`;
  const operatorKey = `filterOperator${suffix}`;
  const valueKey = `filterValue${suffix}`;
  let selectedFilter = definitionFor(entity, args[metricKey]);
  const filterClause = (String(message || "").match(/\b(?:for|where|whose|with|from|of|by)\b([\s\S]*)/i) || [])[1] || "";
  const explicitFilter = suffix === "" ? explicitFilterDefinition(entity, message) : null;
  const selectedWasGrounded = selectedFilter
    && filterFieldAliases(entity, selectedFilter).some((alias) => includesTerm(filterClause, alias));
  if (explicitFilter && !selectedWasGrounded) {
    selectedFilter = explicitFilter;
    args[metricKey] = explicitFilter.id;
  }
  const spec = specById.get(entity);
  const enumValue = enumValueFromQuestion(spec, selectedFilter, filterClause);
  if (enumValue !== null) args[valueKey] = enumValue;
  if ((!String(args[valueKey] ?? "").trim()) && selectedFilter?.valueType === "number") {
    const derivedNumber = singleNumericValue(filterClause);
    if (derivedNumber !== null) args[valueKey] = derivedNumber;
  }
  if ((!String(args[valueKey] ?? "").trim()) && selectedFilter?.valueType === "boolean") {
    if (/\b(?:true|yes|enabled)\b/i.test(filterClause)) args[valueKey] = "true";
    if (/\b(?:false|no|disabled)\b/i.test(filterClause)) args[valueKey] = "false";
  }
  const numericGrounded = selectedFilter?.valueType === "number"
    && Number.isFinite(Number(args[valueKey]))
    && (String(message || "").match(/-?\d[\d,]*(?:\.\d+)?/g) || [])
      .map((value) => Number(value.replace(/,/g, "")))
      .some((value) => value === Number(args[valueKey]));
  /* A value is grounded only when it stands alone in the question, for the
     same reason a status enum value is matched that way. */
  const valueGrounded = numericGrounded || (typeof args[valueKey] === "string"
    && valueStandsAlone(message, args[valueKey]));
  const fieldGrounded = selectedFilter?.aliases?.some((alias) => includesTerm(message, alias));
  const fieldInFilterClause = selectedFilter?.aliases?.some((alias) => (
    includesTerm(filterClause, alias)
    || String(alias).split(/\s+/).some((word) => word.length >= 3 && includesTerm(filterClause, word))
  ));
  const noValue = ["is_recorded", "is_missing"].includes(args[operatorKey]);
  const presenceGrounded = args[operatorKey] === "is_missing"
    ? /\b(missing|not recorded|without|blank|empty|no value)\b/i.test(message)
    : args[operatorKey] === "is_recorded"
      ? /\b(recorded|available|present|filled|set)\b/i.test(message)
      : false;
  const mayResolveTextValue = selectedFilter?.valueType === "text"
    && ["equals", "contains"].includes(args[operatorKey]) && fieldInFilterClause;
  if (!selectedFilter || !fieldGrounded
      || (noValue && !presenceGrounded)
      || (!noValue && !valueGrounded && !mayResolveTextValue)) {
    args[metricKey] = NONE;
    args[operatorKey] = NONE;
    delete args[valueKey];
  } else if (!valueGrounded && mayResolveTextValue) {
    args[valueKey] = RESOLVE_FROM_RECORDS;
  }
}

/**
 * Qwen proposes semantic slots; the server removes any slot that has no trace
 * in the user's words and derives closed status values from the model enum.
 * This cannot add a broader filter than the user asked for.
 */
function reconcileArgs(entity, rawArgs = {}, message = "") {
  const args = { ...rawArgs };
  const spec = specById.get(entity);
  const definitions = DEFINITIONS_BY_ENTITY[entity] || [];
  if (!spec) return args;

  const explicitOutputs = args.operation === "list" ? explicitOutputDefinitions(entity, message) : [];
  if (explicitOutputs.length) {
    args.metric = explicitOutputs[0].id;
    args.outputMetric2 = explicitOutputs[1]?.id || NONE;
    args.outputMetric3 = explicitOutputs[2]?.id || NONE;
  } else {
    if (["count", "exists"].includes(args.operation)) args.metric = RECORDS;
    for (const key of ["outputMetric2", "outputMetric3"]) {
      const selected = definitionFor(entity, args[key]);
      const explicit = selected?.aliases?.some((alias) => includesTerm(message, alias));
      if (!explicit || ["count", "exists", "sum", "average", "minimum", "maximum", "group_count"].includes(args.operation)) {
        args[key] = NONE;
      }
    }
  }
  if (args.operation === "list") {
    const selected = definitionFor(entity, args.metric);
    const explicitlyRequested = selected?.aliases?.some((alias) => includesTerm(message, alias));
    if (!explicitlyRequested) args.metric = RECORDS;
  }

  /* ── THE STATUS CONCEPT, WHATEVER IT IS CALLED ──────────────────────────
     This looked for a definition whose path is literally `status`, which is
     most families and not all: a development file records `lifecycleStatus`,
     an execution file `state`. For those, "new development files" grounded
     nothing and was answered with EVERY development file — a list of all of
     them under a sentence somebody reads as the new ones.

     So the status concept is found by what it IS: a closed set of recorded
     values on this model. The root `status` path still wins when there are
     several, because that is the one people mean. */
  /* ── THE WORKFLOW FIELD THE QUESTION ACTUALLY NAMES ────────────────────
     A family can record more than one closed workflow set — a stock-ledger
     entry has a `status` AND an `applicationState`. Preferring the one
     called `status` meant "pending stock ledger entries" was grounded
     against a field that records no such value, filtered to nothing, and
     answered "none found" about two records that were there.

     So the field is chosen by whose recorded values the question names,
     and `status` only breaks a tie. */
  const workflowCandidates = definitions.filter((definition) => (
    !definition.path.includes(".")
      && /^(status|state|phase|stage)$|(?:Status|State|Phase|Stage)$/.test(definition.path)
      && (spec.model.schema.path(definition.path)?.enumValues || []).length > 1
  ));
  const named = workflowCandidates.filter((definition) => (
    enumValueFromQuestion(spec, definition, message)
  ));
  const rootStatus = named.find((definition) => definition.path === "status")
    || named[0]
    || workflowCandidates.find((definition) => definition.path === "status")
    || workflowCandidates[0];
  const namedFilter = explicitFilterDefinition(entity, message);
  const statusValue = (!namedFilter || namedFilter.id === rootStatus?.id)
    ? enumValueFromQuestion(spec, rootStatus, message)
    : null;
  reconcileFilterSlot(args, entity, message);
  reconcileFilterSlot(args, entity, message, "2");
  reconcileFilterSlot(args, entity, message, "3");
  let filters = ["", "2", "3"].map((suffix) => ({
    metric: args[`filterMetric${suffix}`],
    operator: args[`filterOperator${suffix}`],
    value: args[`filterValue${suffix}`],
  })).filter((filter) => filter.metric && filter.metric !== NONE);
  if (statusValue) {
    filters = [
      { metric: rootStatus.id, operator: "equals", value: statusValue },
      ...filters.filter((filter) => filter.metric !== rootStatus.id),
    ];
  }
  if (args.operation === "group_count") {
    filters = filters.filter((filter) => !(filter.metric === args.metric && filter.value === RESOLVE_FROM_RECORDS));
  }
  filters = filters.filter((filter, index, all) => all.findIndex((candidate) => (
    candidate.metric === filter.metric && candidate.operator === filter.operator
      && text(candidate.value) === text(filter.value)
  )) === index).slice(0, 3);
  for (const [index, suffix] of ["", "2", "3"].entries()) {
    const filter = filters[index];
    args[`filterMetric${suffix}`] = filter?.metric || NONE;
    args[`filterOperator${suffix}`] = filter?.operator || NONE;
    if (filter) args[`filterValue${suffix}`] = filter.value;
    else delete args[`filterValue${suffix}`];
  }

  if (!args.from && !args.to) {
    args.dateMetric = NONE;
    delete args.from;
    delete args.to;
  } else {
    const dateDefinitions = definitions.filter((definition) => definition.valueType === "date_time");
    const explicitDate = explicitDateDefinition(entity, message);
    if (explicitDate) args.dateMetric = explicitDate.id;
    else if (dateDefinitions.length === 1) args.dateMetric = dateDefinitions[0].id;
    else args.dateMetric = NONE;
  }
  return args;
}

function validate({ entity, args = {} }) {
  const spec = specById.get(entity);
  if (!spec) return { error: "That Store & Purchase entity is not catalogued." };
  const operation = OPERATIONS.includes(args.operation) ? args.operation : null;
  const selected = definitionFor(entity, args.metric, { allowSpecial: true });
  const outputDefinitions = [args.outputMetric2 || NONE, args.outputMetric3 || NONE]
    .map((id) => definitionFor(entity, id, { allowSpecial: true }));
  const filterSlots = ["", "2", "3"].map((suffix) => ({
    definition: definitionFor(entity, args[`filterMetric${suffix}`] || NONE, { allowSpecial: true }),
    operator: FILTER_OPERATORS.includes(args[`filterOperator${suffix}`]) ? args[`filterOperator${suffix}`] : NONE,
    value: args[`filterValue${suffix}`],
  }));
  const dateDefinition = definitionFor(entity, args.dateMetric, { allowSpecial: true });
  if (!operation || !selected || outputDefinitions.some((item) => !item)
      || filterSlots.some((item) => !item.definition) || !dateDefinition) {
    return { error: "The requested collection query is outside the Store & Purchase catalogue." };
  }
  if (["sum", "average", "minimum", "maximum"].includes(operation)
      && (selected === RECORDS || selected.valueType !== "number")) {
    return { error: "That calculation requires a catalogued numeric field." };
  }
  if (operation === "group_count" && selected === RECORDS) {
    return { error: "The group query needs a catalogued output field." };
  }
  for (const filter of filterSlots) {
    if (filter.definition === NONE && filter.operator !== NONE) return { error: "A filter operator was supplied without a filter field." };
    if (filter.definition !== NONE && filter.operator === NONE) return { error: "A filter field was supplied without a filter operator." };
    if (filter.definition !== NONE && !["is_recorded", "is_missing"].includes(filter.operator) && !text(filter.value).trim()) {
      return { error: "That filter needs a value from the question." };
    }
  }
  if (dateDefinition !== NONE && dateDefinition.valueType !== "date_time") return { error: "A date range requires a catalogued date field." };
  const from = args.from || "";
  const to = args.to || "";
  if ((from || to) && dateDefinition === NONE) return { error: "A date range was supplied without a date field." };
  if (dateDefinition !== NONE && !from && !to) return { error: "A date field was selected without a date range from the question." };
  if (from && to && new Date(from) > new Date(to)) return { error: "The From date is after the To date." };
  return {
    spec, operation, selected,
    outputDefinitions: outputDefinitions.filter((item) => item !== NONE),
    filters: filterSlots.filter((item) => item.definition !== NONE),
    dateDefinition, from, to,
  };
}

async function queryCollection({ entity, user, args, message } = {}) {
  const reconciled = reconcileArgs(entity, args, message);
  const checked = validate({ entity, args: reconciled });
  if (checked.error) return { ok: false, reason: checked.error, entity };
  const { spec, operation, selected, outputDefinitions, filters, dateDefinition, from, to } = checked;
  const scope = scopeFor(spec, user);
  if (scope === null) return { ok: false, reason: "Store & Purchase company access could not be verified.", entity };
  const cap = scanCap();
  const storedCount = await spec.model.countDocuments(scope);
  const contract = require("./storePurchaseUniversalContract").CONTRACTS
    .find((entry) => entry.id === `store_purchase.schema.${entity}`);
  const records = await spec.model.find(scope).select(`${contract.projection()} _id`).limit(cap).lean();
  for (const filter of filters) {
    if (filter.value !== RESOLVE_FROM_RECORDS) continue;
    const candidates = [...new Set(records.flatMap((record) => valuesAtPath(record, filter.definition.path))
      .map((value) => text(value).trim()).filter(Boolean))]
      .filter((value) => phraseIncluded(message, value))
      .sort((a, b) => b.length - a.length);
    if (candidates.length > 1 && candidates[0].length === candidates[1].length) {
      return { ok: false, reason: `More than one ${filter.definition.label} matches that wording. Please give the exact value.`, entity };
    }
    filter.value = candidates[0] || Symbol("no_authorised_value_match");
  }
  const definitions = DEFINITIONS_BY_ENTITY[entity] || [];
  const inferred = inferIdentityConstraint({ spec, definitions, records, message });
  if (inferred.ambiguous) {
    return {
      ok: false,
      reason: `More than one recorded ${spec.label} identity matches that wording. Please give the exact reference or name.`,
      entity,
    };
  }
  const alreadyConstrained = inferred.found && filters.some((filter) => (
    filter.definition.id === inferred.definition.id
      && normaliseIdentityPhrase(filter.value) === normaliseIdentityPhrase(inferred.value)
  ));
  if (inferred.found && !alreadyConstrained) {
    if (filters.length >= 3) {
      return { ok: false, reason: "I couldn't safely apply every requested filter. Please make the question more specific.", entity };
    }
    filters.push({ definition: inferred.definition, operator: "equals", value: inferred.value });
  }
  const groundedQuery = text(reconciled.query).trim();
  const query = groundedQuery && phraseIncluded(message, groundedQuery)
    ? groundedQuery.toLowerCase()
    : "";
  const hasEffectiveConstraint = filters.length > 0 || Boolean(query)
    || dateDefinition !== NONE || Boolean(from || to);
  /* ── WHAT WAS ACTUALLY NARROWED ───────────────────────────────────────
     Reported so a caller can tell a list of everything from a list that
     happens to be everything. Without it, "stock of a material nobody ever
     registered" came back as every material in the catalogue: the words
     named no record, nothing was applied, and the whole collection read as
     the answer. Additive — nothing here changes what is returned. */
  const appliedConstraints = filters.length + (query ? 1 : 0)
    + (dateDefinition !== NONE ? 1 : 0) + (from || to ? 1 : 0);
  if (!hasEffectiveConstraint && unresolvedConstraintTail(message, spec)) {
    return {
      ok: false,
      reason: `I couldn't safely match the requested ${spec.label} constraint to an authorised recorded value. Please give the exact name or business reference.`,
      entity,
    };
  }
  let matched = records.filter((record) => {
    if (query && !identityValues(spec, record).some((value) => phraseIncluded(value, query))) return false;
    if (!filters.every((filter) => filterMatches(record, filter.definition, filter.operator, filter.value))) return false;
    return dateMatches(record, dateDefinition === NONE ? null : dateDefinition, from, to);
  });
  const truncated = storedCount > cap;
  const limit = Math.min(20, Math.max(1, Number.isInteger(reconciled.limit) ? reconciled.limit : 10));
  const direction = reconciled.sort === "descending" ? -1 : 1;
  const values = selected === RECORDS ? [] : matched.flatMap((record) => valuesAtPath(record, selected.path));

  if (operation === "count" || operation === "exists") {
    return {
      ok: true, entity, entityLabel: spec.label, operation, count: matched.length,
      truncated, scannedCount: records.length, storedCount, appliedConstraints,
      navigation: matched.slice(0, limit).map((record) => ({
        entity, recordId: String(record._id || ""), label: labelFor(spec, record),
      })),
    };
  }
  if (["sum", "average", "minimum", "maximum"].includes(operation)) {
    const numbers = values.map(Number).filter(Number.isFinite);
    let value = null;
    if (numbers.length) {
      if (operation === "sum") value = numbers.reduce((total, item) => total + item, 0);
      if (operation === "average") value = numbers.reduce((total, item) => total + item, 0) / numbers.length;
      if (operation === "minimum") value = Math.min(...numbers);
      if (operation === "maximum") value = Math.max(...numbers);
    }
    return { ok: true, entity, entityLabel: spec.label, operation, fieldLabel: selected.label, value, valueCount: numbers.length, count: matched.length, truncated, scannedCount: records.length, storedCount, appliedConstraints };
  }
  if (operation === "group_count") {
    const groups = new Map();
    for (const record of matched) {
      const own = valuesAtPath(record, selected.path);
      const keys = own.length ? own.map((value) => display(value, selected.valueType)).filter(Boolean) : ["Not recorded"];
      for (const key of new Set(keys)) groups.set(key, (groups.get(key) || 0) + 1);
    }
    const rows = [...groups].map(([value, count]) => ({ value, count }))
      .sort((a, b) => direction * (a.count - b.count) || a.value.localeCompare(b.value)).slice(0, limit);
    return { ok: true, entity, entityLabel: spec.label, operation, fieldLabel: selected.label, rows, count: matched.length, truncated, scannedCount: records.length, storedCount, appliedConstraints };
  }
  const selectedOutputs = selected === RECORDS ? outputDefinitions : [selected, ...outputDefinitions];
  const selectedRows = matched.map((record) => ({
    navigation: { entity, recordId: String(record._id || ""), label: labelFor(spec, record) },
    subject: labelFor(spec, record),
    /* ── WHAT THE ORDER IS ACTUALLY BY ────────────────────────────────
       The rows used to be ordered by the DISPLAYED text of their first
       output field, and when the question asked for the records themselves
       there was no output field, so every row compared equal and
       "descending" changed nothing: "the latest five material requests"
       answered with the five OLDEST.

       A displayed date is no better to sort by — `20/5/2026` against
       `5/6/2026` compares as text, so June sorts before May. So the sort
       key is the RAW first value, falling back to when the record was
       created, which is what "latest" means for a list of records. */
    sortKey: sortValueOf(record, selectedOutputs[0]),
    values: selectedOutputs.map((definition) => ({
        label: definition.label,
        values: valuesAtPath(record, definition.path)
          .map((value) => display(value, definition.valueType)).filter(Boolean),
      })),
  })).sort((a, b) => direction * compareSortKeys(a.sortKey, b.sortKey)).slice(0, limit);
  const navigation = selectedRows.map((row) => row.navigation);
  const rows = selectedRows.map(({ navigation: _navigation, sortKey: _sortKey, ...row }) => row);
  return {
    ok: true, entity, entityLabel: spec.label, operation,
    fieldLabel: selectedOutputs.length ? selectedOutputs[0].label : "records",
    outputFieldLabels: selectedOutputs.map((definition) => definition.label),
    rows, count: matched.length, truncated, scannedCount: records.length, storedCount,
    appliedConstraints, navigation,
  };
}

/**
 * The value a list is ordered BY.
 *
 * The first selected output field's own raw value when there is one, and
 * otherwise when the record was created — the only ordering that makes
 * "latest" mean anything for a list of whole records. Never the displayed
 * string: a date formatted for a reader does not sort as a date.
 */
function sortValueOf(record, definition) {
  if (definition) {
    const [first] = valuesAtPath(record, definition.path);
    if (first !== undefined && first !== null && first !== "") return first;
  }
  return record?.createdAt ?? record?._id ?? null;
}

/** Numbers and dates compare as themselves; everything else as text. */
function compareSortKeys(left, right) {
  const asTime = (value) => (value instanceof Date ? value.getTime() : null);
  const leftTime = asTime(left);
  const rightTime = asTime(right);
  if (leftTime !== null && rightTime !== null) return leftTime - rightTime;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return text(left).localeCompare(text(right));
}

function renderCollectionQuery({ data } = {}) {
  if (!data?.ok) return data?.reason || "I couldn't verify that Store & Purchase query.";
  const plural = `${data.entityLabel}${data.entityLabel.endsWith("s") ? "" : "s"}`;
  const bounded = data.truncated ? " This is a bounded inspected set, so additional matches may exist." : "";
  if (data.operation === "exists") return `${data.count ? "Yes" : "No"}. ${data.count}${data.truncated ? " or more" : ""} matching ${plural} were found.${bounded}`;
  if (data.operation === "count") return `There ${data.count === 1 ? "is" : "are"} ${data.count}${data.truncated ? " or more" : ""} matching ${plural}.${bounded}`;
  if (["sum", "average", "minimum", "maximum"].includes(data.operation)) {
    return data.value === null
      ? `No recorded numeric values were found for ${data.fieldLabel}.${bounded}`
      : `The ${data.operation} for ${data.fieldLabel} is ${data.value}, across ${data.valueCount} recorded value${data.valueCount === 1 ? "" : "s"}.${bounded}`;
  }
  if (!data.rows?.length) return `No matching ${plural} were found.${bounded}`;
  if (data.operation === "group_count") {
    return `${data.fieldLabel} grouped counts: ${data.rows.map((row) => `${row.value}: ${row.count}`).join("; ")}.${bounded}`;
  }
  if (!data.outputFieldLabels?.length) return `Matching ${plural}: ${data.rows.map((row) => row.subject).join("; ")}.${bounded}`;
  return `${data.outputFieldLabels.join(", ")}: ${data.rows.map((row) => {
    const values = row.values.map((field) => `${field.label}: ${field.values.length ? field.values.join(", ") : "not recorded"}`);
    return `${row.subject}: ${values.join("; ")}`;
  }).join(" | ")}.${bounded}`;
}

module.exports = {
  queryCollection, renderCollectionQuery, validate, filterMatches, dateMatches,
  sortValueOf, compareSortKeys, valueStandsAlone, withoutEntityName,
  reconcileArgs, enumValueFromQuestion, explicitOutputDefinitions, explicitFilterDefinition,
  explicitDateDefinition,
  normaliseIdentityPhrase, normaliseTextValue, inferIdentityConstraint, unresolvedConstraintTail,
  RECORDS, NONE, RESOLVE_FROM_RECORDS, OPERATIONS, FILTER_OPERATORS, SORTS, scanCap,
};
