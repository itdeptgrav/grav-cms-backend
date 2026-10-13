"use strict";

const { registerTool } = require("../toolRegistry");
const {
  SALES_CATALOGUE_ID,
  CATALOGUE,
  metricFromText,
  metric,
} = require("../../salesCustomerContract");
const { resolveCustomer } = require("../../salesCustomerContext");

const mayReadSales = (user) => Boolean(
  user?.applicationAccess?.sales?.allowed && user.applicationAccess.sales.capabilities?.read,
);

function getPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, key) => (
    current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
  ), value);
}

async function claimCustomerMetric({ user, message } = {}) {
  const definition = metricFromText(message);
  if (!definition) return null;
  if (/\b(customer|buyer|client)\b/i.test(String(message || ""))) return { metric: definition.id };
  const resolution = await resolveCustomer({ user, message });
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function display(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  return String(value);
}

function renderCustomerMetric({ data } = {}) {
  const resolution = data?.customer;
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which customer field was requested.";
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).map((row) => (
        row.customerId ? `${row.name} (${row.customerId})` : row.name
      )).filter(Boolean).join(", ");
      return choices
        ? `That matches more than one customer: ${choices}. Please give the customer ID.`
        : "That matches more than one customer. Please give the customer ID.";
    }
    return "I couldn't match one customer exactly. Please give the customer name or customer ID as recorded in Sales.";
  }
  const record = resolution.record;
  const subject = record.name || record.profile?.companyName || record.customerId || "That customer";
  if (definition.valueType === "payment_terms") {
    const schedule = Array.isArray(record.paymentTerms?.schedule) ? record.paymentTerms.schedule : [];
    const parts = schedule.map((step) => `${step.name}: ${step.percentage}%`);
    if (record.paymentTerms?.notes) parts.push(`Notes: ${record.paymentTerms.notes}`);
    return parts.length
      ? `${subject}'s payment terms are ${parts.join("; ")}.`
      : `${subject}'s payment terms are not recorded.`;
  }
  if (definition.valueType === "assigned_products") {
    const rows = Array.isArray(record.assignedStockItems) ? record.assignedStockItems : [];
    const names = rows.map((row) => row.stockItemReference
      ? `${row.stockItemName || "Product"} (${row.stockItemReference})`
      : row.stockItemName).filter(Boolean);
    return names.length
      ? `${subject}'s assigned products are ${names.join(", ")}.`
      : `${subject} has no recorded assigned products.`;
  }
  const value = display(getPath(record, definition.path), definition.valueType);
  return value === null
    ? `${subject}'s ${definition.label.toLowerCase()} is not recorded.`
    : `${subject}'s ${definition.label.toLowerCase()} is ${value}.`;
}

registerTool({
  name: "sales_customer_metric",
  application: "sales",
  modelSelectable: false,
  semantic: { catalogue: SALES_CATALOGUE_ID, domains: ["customer_master"], subjects: ["customer"] },
  description: "One exact, current, authorised Sales customer-master field. Catalogue-only and read-only.",
  permission: mayReadSales,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimCustomerMetric,
  provideContext: async ({ user, message, args }) => ({
    definition: metric(args?.metric),
    customer: await resolveCustomer({ user, message }),
  }),
  renderAnswer: renderCustomerMetric,
});

module.exports = { claimCustomerMetric, renderCustomerMetric };
