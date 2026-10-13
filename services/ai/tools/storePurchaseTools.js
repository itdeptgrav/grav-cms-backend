"use strict";

const { registerTool } = require("../toolRegistry");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const {
  STORE_PURCHASE_CATALOGUE_ID,
  CATALOGUE,
  metricFromText,
  metric,
} = require("../../storeSupplierContract");
const { resolveSupplier } = require("../../storeSupplierContext");
const { recordLink } = require("../assistantLinks");

const mayReadStore = (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ));

function getPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, key) => (
    current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
  ), value);
}

async function claimSupplierMetric({ user, message } = {}) {
  const definition = metricFromText(message);
  if (!definition) return null;
  if (/\b(supplier|vendor)\b/i.test(String(message || ""))) return { metric: definition.id };
  const resolution = await resolveSupplier({ user, message });
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function display(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  if (valueType === "text_list") return Array.isArray(value) && value.length ? value.join(", ") : null;
  return String(value);
}

function renderSupplierMetric({ data } = {}) {
  const resolution = data?.supplier;
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which supplier field was requested.";
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).map((row) => (
        row.supplierCode ? `${row.companyName} (${row.supplierCode})` : row.companyName
      )).filter(Boolean).join(", ");
      return choices
        ? `That matches more than one supplier: ${choices}. Please give the supplier code.`
        : "That matches more than one supplier. Please give the supplier code.";
    }
    return "I couldn't match one supplier exactly. Please give the supplier name or supplier code as recorded in Store & Purchase.";
  }
  const record = resolution.record;
  const subject = record.companyName || record.supplierCode || "That supplier";
  if (definition.valueType === "status_details") {
    const parts = definition.path.map((path) => {
      const valueType = path.endsWith(".at") ? "date_time" : "text";
      return display(getPath(record, path), valueType);
    }).filter(Boolean);
    return parts.length
      ? `${subject}'s ${definition.label.toLowerCase()} are ${parts.join("; ")}.`
      : `${subject}'s ${definition.label.toLowerCase()} are not recorded.`;
  }
  const value = display(getPath(record, definition.path), definition.valueType);
  return value === null
    ? `${subject}'s ${definition.label.toLowerCase()} is not recorded.`
    : `${subject}'s ${definition.label.toLowerCase()} is ${value}.`;
}

registerTool({
  name: "store_supplier_metric",
  application: "store_purchase",
  modelSelectable: true,
  semantic: { catalogue: STORE_PURCHASE_CATALOGUE_ID, domains: ["supplier_master"], subjects: ["supplier"] },
  description: "One exact, current, authorised Store & Purchase supplier-master field. Catalogue-only and read-only.",
  permission: mayReadStore,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimSupplierMetric,
  recognizeSubject: ({ user, message }) => resolveSupplier({ user, message }),
  provideContext: async ({ user, message, args }) => ({
    definition: metric(args?.metric),
    supplier: await resolveSupplier({ user, message }),
  }),
  renderAnswer: renderSupplierMetric,
  buildLinks: ({ data }) => {
    const record = data?.supplier?.record;
    const link = data?.supplier?.found
      ? recordLink("supplier_master", record?._id, record?.companyName || record?.supplierCode)
      : null;
    return link ? [link] : [];
  },
});

module.exports = { claimSupplierMetric, renderSupplierMetric };
