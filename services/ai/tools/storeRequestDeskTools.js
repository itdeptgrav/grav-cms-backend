"use strict";

const { registerTool } = require("../toolRegistry");
const { STORE_CATALOGUE_ID } = require("../../storeSemanticContract");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const {
  OPERATIONS, TYPES, STAGES, SORTS, queryRequestDesk, renderRequestDesk,
} = require("../../storeRequestDeskAssistantContext");
const { sanitizeAssistantLinks } = require("../assistantLinks");

const mayRead = (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ));

registerTool({
  name: "store_request_desk_query",
  application: "store_purchase",
  modelSelectable: true,
  semantic: { catalogue: STORE_CATALOGUE_ID, domains: ["store_records"], subjects: ["request_desk"] },
  description:
    "Query the unified Store Request Desk across manufacturing requirements, material requests, fulfilment requests, classified purchase/service requests and authorised legacy item-addition requests. Use for Store questions asking for requests, latest/recent requests, request counts, whether requests exist, requests by stage/type/date/requester/department, and grouped request totals. This capability returns the same five-source business surface as the Store Request Desk; do not substitute accounting vouchers or one record collection.",
  permission: mayRead,
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: OPERATIONS },
      type: { type: "string", enum: TYPES },
      stage: { type: "string", enum: STAGES },
      query: { type: "string", maxLength: 200 },
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      sort: { type: "string", enum: SORTS },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["operation", "type", "stage", "sort", "limit"],
    additionalProperties: false,
  },
  matches: (message) => /\b(request desk|requests?|requisitions?|mrfs?|material demands?|fulfilment queue)\b/i.test(String(message || "")),
  provideContext: ({ user, args }) => queryRequestDesk({ user, args }),
  renderAnswer: renderRequestDesk,
  buildLinks: ({ data }) => sanitizeAssistantLinks((data?.navigation || []).filter((row) => row.recordId).map((row) => {
    const id = encodeURIComponent(String(row.recordId || ""));
    const href = row.type === "manufacturing" ? `/store/dashboard/order-requests/${id}`
      : row.type === "fulfilment" ? `/store/dashboard/order-requests/intake/${id}`
        : row.type === "purchase_service" ? `/store/dashboard/order-requests/quote/${id}`
          : `/store/dashboard/order-requests/mrf/${id}`;
    return { label: `Open ${row.label || "request"}`, href };
  })),
});

module.exports = { mayRead };
