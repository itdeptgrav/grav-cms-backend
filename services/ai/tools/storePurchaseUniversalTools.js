"use strict";

const { registerTool } = require("../toolRegistry");
const { includesTerm } = require("../semanticCatalogue");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const {
  CATALOGUE_ID, CATALOGUE, ENTITY_SPECS, DEFINITIONS_BY_ENTITY, metric,
} = require("../../storePurchaseUniversalContract");
const {
  resolveEntity, recogniseCatalogueEntity, valuesAtPath,
} = require("../../storePurchaseUniversalContext");
const {
  queryReceiveWorkspace, renderReceiveQuery, OPERATIONS, STAGES, SOURCES, DATE_BASES,
} = require("../../receiveWorkspaceAssistantContext");
const { recordLink, sanitizeAssistantLinks } = require("../assistantLinks");

const mayReadStore = (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ));

// This is a query-shape contract, independent of any Store entity or field.
// It prevents plural/aggregate/filter questions from being sent to a tool that
// can only resolve one exact record.
const looksLikeCollectionQuestion = (message) => /\b(?:how many|count|number of|any|all|list|show|which|group(?:ed)?|average|avg|sum|minimum|maximum|between)\b/i
  .test(String(message || ""));

function displayOne(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "boolean") return value ? "Yes" : "No";
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  if (typeof value === "object") {
    const rendered = JSON.stringify(value);
    return rendered.length > 1200 ? `${rendered.slice(0, 1197)}...` : rendered;
  }
  return String(value);
}

function displayValues(values, valueType) {
  const rendered = values.map((value) => displayOne(value, valueType)).filter(Boolean);
  return rendered.length ? [...new Set(rendered)].join(", ") : null;
}

function renderEntityMetric({ data } = {}) {
  const definition = data?.definition;
  const resolution = data?.resolution;
  if (!definition) return "I couldn't verify which Store & Purchase field was requested.";
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).filter(Boolean).join(", ");
      return choices
        ? `That matches more than one ${data.entityLabel}: ${choices}. Please give its exact recorded reference.`
        : `That matches more than one ${data.entityLabel}. Please give its exact recorded reference.`;
    }
    return `I couldn't match one ${data.entityLabel} exactly. Please give its recorded name or business reference.`;
  }
  const value = displayValues(valuesAtPath(resolution.record, definition.path), definition.valueType);
  const subject = resolution.label || data.entityLabel;
  const field = definition.label.replace(new RegExp(`^${data.entityLabel}\\s+`, "i"), "");
  return value === null
    ? `${subject}'s ${field} is not recorded.`
    : `${subject}'s ${field} is ${value}.`;
}

function priorSubject(history, entity) {
  const turns = Array.isArray(history) ? history : [];
  const previous = [...turns].reverse().find((turn) => turn?.role === "assistant" && turn?.contextState?.subject);
  const subject = previous?.contextState?.subject;
  return subject?.kind === "store_purchase_record" && subject?.entity === entity
    ? String(subject.label || "")
    : "";
}

for (const entity of ENTITY_SPECS) {
  if (entity.collectionOnly) continue;
  const definitions = DEFINITIONS_BY_ENTITY[entity.id] || [];
  const metricIds = definitions.map((definition) => definition.id);
  const entityTerms = [entity.label, ...(entity.aliases || [])];
  const resolveMetric = (message) => CATALOGUE.resolveMetric(message, { entity: entity.id });

  registerTool({
    name: `store_record_${entity.id}_field`,
    application: "store_purchase",
    modelSelectable: true,
    semantic: {
      catalogue: CATALOGUE_ID,
      domains: [entity.id],
      subjects: [entity.id],
      labels: [...entityTerms].sort((a, b) => b.length - a.length),
    },
    description: `Read one exact, authorised ${entity.label} field. Select the semantic field that answers the question; physical database fields and unrestricted documents are never exposed.${entity.id === "goods_receipt" ? " A goods receipt exists only after an arrival is recorded; this capability cannot answer expected, pending or not-yet-received arrivals." : ""}`,
    permission: mayReadStore,
    parameters: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          enum: metricIds,
          "x-semanticOptions": Object.fromEntries(definitions.map((definition) => [
            definition.id,
            {
              label: definition.label.replace(new RegExp(`^${entity.label}\\s+`, "i"), ""),
              aliases: definition.aliases,
            },
          ])),
        },
      },
      required: ["metric"],
      additionalProperties: false,
    },
    matches: (message) => !looksLikeCollectionQuestion(message) && (
      entityTerms.some((term) => includesTerm(message, term)) || Boolean(resolveMetric(message))
    ),
    claim: ({ message }) => {
      if (looksLikeCollectionQuestion(message)) return null;
      if (!entityTerms.some((term) => includesTerm(message, term))) return null;
      const definition = resolveMetric(message);
      return definition ? { metric: definition.id } : null;
    },
    recognizeSubject: async ({ user, message }) => {
      if (entityTerms.some((term) => includesTerm(message, term))) {
        return resolveEntity({ entity: entity.id, user, message, includeRecord: false });
      }
      return recogniseCatalogueEntity({ entity: entity.id, user, message });
    },
    provideContext: async ({ user, message, args, recognizedSubject, history }) => {
      const definition = metric(args?.metric);
      const resolution = await resolveEntity({
        entity: entity.id,
        user,
        message,
        subject: priorSubject(history, entity.id),
        recognizedSubject,
      });
      return {
        entity: entity.id,
        entityLabel: entity.label,
        definition: definition?.entity === entity.id ? definition : null,
        resolution,
        ...(resolution.found ? {
          subject: { kind: "store_purchase_record", entity: entity.id, label: resolution.label },
        } : {}),
      };
    },
    renderAnswer: renderEntityMetric,
    buildLinks: ({ data }) => {
      const resolution = data?.resolution;
      const link = resolution?.found
        ? recordLink(entity.id, resolution.recordId, resolution.label)
        : null;
      return link ? [link] : [];
    },
  });
}

registerTool({
  name: "store_receive_query",
  application: "store_purchase",
  modelSelectable: true,
  semantic: {
    catalogue: CATALOGUE_ID,
    domains: ["goods_receipt", "purchase_order", "customer_material_expectation"],
    subjects: ["goods_receipt", "purchase_order", "customer_material_expectation"],
  },
  description: "Query the authorised Store receiving register across expected arrivals and recorded goods receipts. This is the only capability for expected, pending or not-yet-received arrivals: an expected GRN means an arrival expected before a GRN exists. Supports existence, count and list questions; purchased or customer-owned sources; expected/receipt date ranges; and action/completion stages. Use this for plural, aggregate, filtered or date-range receiving questions, not for one exact record field.",
  permission: mayReadStore,
  parameters: {
    type: "object",
    properties: {
      operation: { type: "string", enum: OPERATIONS },
      /* ── THE REGISTER'S STAGES, IN THE WORDS PEOPLE USE ──────────────
         A stage IS a status here: an arrival is expected, or waiting for
         somebody, or finished. Nothing else in Store records "pending"
         receiving work — an inspection record exists only once the
         decision is made — so these aliases are what let a question about
         pending or outstanding arrivals reach the one capability that
         knows. Declared on the capability, for every caller: the
         deterministic palette reads them, and so does the model. */
      stage: {
        type: "string",
        enum: STAGES,
        "x-semanticOptions": {
          all: { label: "any stage", aliases: ["any stage", "all stages"] },
          expected: {
            label: "expected",
            aliases: ["expected", "upcoming", "due", "not yet received", "awaited", "incoming"],
          },
          action_required: {
            label: "needs action",
            aliases: ["pending", "outstanding", "needs action", "action required", "awaiting", "to do", "unfinished", "open"],
          },
          completed: {
            label: "completed",
            aliases: ["completed", "complete", "finished", "done", "closed"],
          },
          recorded: {
            label: "recorded",
            aliases: ["recorded", "received", "booked"],
          },
        },
      },
      source: {
        type: "string",
        enum: SOURCES,
        "x-semanticOptions": {
          all: { label: "any source", aliases: ["any source", "all sources"] },
          purchased: { label: "purchased", aliases: ["purchased", "bought", "supplier", "vendor"] },
          customer_owned: { label: "customer owned", aliases: ["customer owned", "customer material", "job work"] },
        },
      },
      dateBasis: {
        type: "string",
        enum: DATE_BASES,
        "x-semanticOptions": {
          none: { label: "no date range", aliases: ["all time"] },
          expected_date: {
            label: "expected date",
            aliases: ["expected", "expected date", "expected delivery", "expected delivery date", "due date", "arriving"],
          },
          receipt_date: {
            label: "receipt date",
            aliases: ["receipt date", "received on", "recorded on", "date received"],
          },
        },
      },
      from: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      to: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      query: { type: "string", maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["operation", "stage", "source", "dateBasis"],
    additionalProperties: false,
  },
  // Match the receiving workspace itself, not every record whose status happens
  // to contain "received". A purchase-order status such as "partially received"
  // belongs to the purchase-order collection capability.
  matches: (message) => /\b(receiving|receipts?|grn|arrivals?|arriving|expected delivery|put[ -]?away|inspection)\b/i.test(String(message || "")),
  provideContext: ({ user, args, message }) => queryReceiveWorkspace({ user, args, message }),
  renderAnswer: renderReceiveQuery,
  buildLinks: ({ data }) => sanitizeAssistantLinks((data?.rows || []).map((row) => ({
    label: `Open ${row.reference || row.orderReference || "record"}`,
    href: row.nextAction?.href,
  }))),
});

module.exports = { renderEntityMetric, displayValues, priorSubject, renderReceiveQuery, looksLikeCollectionQuestion };
