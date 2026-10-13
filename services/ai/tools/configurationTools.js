"use strict";

const { registerTool } = require("../toolRegistry");
const {
  CONFIGURATION_CATALOGUE_ID, CATALOGUE, metric, metricFromText,
} = require("../../configurationSemanticContract");
const { loadConfigurations, resolveNamed } = require("../../configurationAssistantContext");

const mayRead = (user) => Boolean(user?.id);
const dateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
};

async function claimConfigurationMetric({ message } = {}) {
  const loaded = await loadConfigurations();
  const categoryResolution = resolveNamed(loaded.categories, message);
  const templateResolution = resolveNamed(loaded.templates, message);
  const named = categoryResolution.found ? categoryResolution.record.name
    : templateResolution.found ? templateResolution.record.name : "";
  const stripped = named
    ? String(message).replace(new RegExp(named.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ")
    : message;
  const definition = metricFromText(stripped) || metricFromText(message);
  if (!definition) return null;
  if (!["category", "template"].includes(definition.query)) return { metric: definition.id };
  const resolution = definition.query === "category" ? categoryResolution : templateResolution;
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function renderList(rows, label) {
  if (!rows?.length) return `No ${label.toLowerCase()} are recorded.`;
  return `${label} (${rows.length}): ${rows.map((row) => row.name).join("; ")}.`;
}

function renderNamed(definition, resolution) {
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      return `That matches more than one ${definition.entity.replace(/_/g, " ")}: ${resolution.matches.map((row) => row.name).join(", ")}. Please use the recorded name.`;
    }
    return `I couldn't match one ${definition.entity.replace(/_/g, " ")} exactly. Please use its recorded name.`;
  }
  const row = resolution.record;
  let value = row[definition.path];
  if (definition.valueType === "date_time") value = dateTime(value);
  if (definition.valueType === "list") value = Array.isArray(value) ? value.join(", ") : value;
  if (definition.valueType === "field_values") {
    value = (value || []).map((item) => `${item.fieldName}: ${item.value || "not recorded"}`).join(", ");
  }
  if (definition.valueType === "boolean") value = value ? "yes" : "no";
  return value === null || value === undefined || value === ""
    ? `${row.name}'s ${definition.label.toLowerCase()} is not recorded.`
    : `${row.name}'s ${definition.label.toLowerCase()} is ${value}.`;
}

function renderRequests(definition, value) {
  if (!value?.found) return "The Requests settings record is not present, so I won't infer its current value.";
  let answer = value[definition.path];
  if (definition.valueType === "boolean") answer = answer ? "enabled" : "disabled";
  if (definition.valueType === "date_time") answer = dateTime(answer);
  return answer === null || answer === undefined || answer === ""
    ? `${definition.label} is not recorded.`
    : `${definition.label} is ${answer}.`;
}

function renderConfigurationMetric({ data } = {}) {
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which configuration information was requested.";
  if (definition.query === "category_list") return renderList(data.value, definition.label);
  if (definition.query === "template_list") return renderList(data.value, definition.label);
  if (definition.query === "requests") return renderRequests(definition, data.value);
  return renderNamed(definition, data.value);
}

registerTool({
  name: "config_metric",
  modelSelectable: false,
  semantic: {
    catalogue: CONFIGURATION_CATALOGUE_ID,
    domains: ["measurement_configuration", "request_configuration"],
    subjects: ["measurement_category", "measurement_template", "requests_settings"],
  },
  description: "One exact read-only CMS configuration fact from the typed Configuration catalogue.",
  permission: mayRead,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"], additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimConfigurationMetric,
  provideContext: async ({ message, args }) => {
    const definition = metric(args?.metric);
    const loaded = await loadConfigurations();
    if (definition?.query === "category_list") return { definition, value: loaded.categories };
    if (definition?.query === "template_list") return { definition, value: loaded.templates };
    if (definition?.query === "requests") return { definition, value: loaded.requests };
    const rows = definition?.query === "category" ? loaded.categories : loaded.templates;
    return { definition, value: resolveNamed(rows, message) };
  },
  renderAnswer: renderConfigurationMetric,
});

module.exports = { claimConfigurationMetric, renderConfigurationMetric };
