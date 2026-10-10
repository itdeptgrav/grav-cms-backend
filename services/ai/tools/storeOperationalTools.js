"use strict";

const { registerTool } = require("../toolRegistry");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const { VIEWS, OPERATIONS, queryStoreOperational, renderStoreOperational } = require("../../storeOperationalAssistantContext");
const { recordLink } = require("../assistantLinks");

function claimOperationalWorkspace({ message } = {}) {
  const text = String(message || "");
  const operation = /\b(?:list|show|which|top|highest|items?)\b/i.test(text) && !/\b(?:overview|summary|total|how many|count)\b/i.test(text)
    ? "list"
    : "summary";
  const limitMatch = text.match(/\b(\d{1,2})\b/);
  const limit = Math.min(20, Math.max(1, Number(limitMatch?.[1]) || 5));
  if (/\b(?:operations? overview|operations? summary|work queue|needs? attention)\b/i.test(text)) {
    return { view: "operations", operation: "summary", limit };
  }
  if (/\b(?:inventory valuation|stock valuation|stock value)\b/i.test(text)) {
    return { view: "inventory_valuation", operation, limit };
  }
  if (/\b(?:purchase exceptions?|reconciliation exceptions?|late delivery|past expected delivery)\b/i.test(text)) {
    return { view: "purchase_exceptions", operation, limit };
  }
  return null;
}

registerTool({
  name: "store_operational_workspace_query",
  application: "store_purchase",
  modelSelectable: true,
  semantic: { catalogue: "store_purchase_schema", domains: ["purchase_order", "stock_ledger", "stock_count", "stock_reservation", "landed_cost_allocation"], subjects: [] },
  description: "Read deterministic Store operational summaries and bounded lists for the operations attention dashboard, inventory valuation, or purchase exceptions. Use this for cross-record operational totals, valuation, items needing attention, late receipts, reconciliation exceptions and work queues; use entity collection tools for ordinary stored-field filters.",
  permission: (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ)),
  parameters: {
    type: "object",
    properties: {
      view: { type: "string", enum: VIEWS },
      operation: { type: "string", enum: OPERATIONS },
      query: { type: "string", maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["view", "operation", "limit"],
    additionalProperties: false,
  },
  matches: (message) => /\b(?:operations? overview|needs? attention|work queue|inventory valuation|stock value|stock valuation|purchase exceptions?|reconciliation exceptions?|late delivery|past expected delivery)\b/i.test(String(message || "")),
  claim: claimOperationalWorkspace,
  provideContext: ({ user, args }) => queryStoreOperational({ user, args }),
  renderAnswer: renderStoreOperational,
  buildLinks: ({ data }) => data?.view === "purchase_exceptions"
    ? (data.rows || []).map((row) => recordLink("purchase_order", row.poId, row.poNumber)).filter(Boolean)
    : [],
});

module.exports = { claimOperationalWorkspace, renderStoreOperational };
