"use strict";

const { registerTool } = require("../toolRegistry");
const { recordLink } = require("../assistantLinks");
const { CAPABILITIES } = require("../../storePurchase/capabilities");
const {
  INVENTORY_CATALOGUE_ID,
  CATALOGUE,
  metricFromText,
  metric,
} = require("../../inventoryItemContract");
const { resolveInventoryItem } = require("../../inventoryItemContext");
const {
  INVENTORY_LOCATION_CATALOGUE_ID,
  CATALOGUE: LOCATION_CATALOGUE,
  metricFromText: locationMetricFromText,
  metric: locationMetric,
} = require("../../inventoryLocationContract");
const { buildInventoryLocationContext } = require("../../inventoryLocationContext");

const mayReadInventory = (user) => Boolean(user?.storePurchaseAccess?.capabilitySet?.has(CAPABILITIES.READ));

function getPath(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, key) => (
    current && Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
  ), value);
}

async function claimInventoryItemMetric({ user, message } = {}) {
  const definition = metricFromText(message);
  if (!definition) return null;
  if (/\b(raw item|inventory item|stock item|material)\b/i.test(String(message || ""))) {
    return { metric: definition.id };
  }
  const resolution = await resolveInventoryItem({ user, message });
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function display(value, valueType) {
  if (value === null || value === undefined || value === "") return null;
  if (valueType === "number") {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString("en-IN", { maximumFractionDigits: 4 })
      : null;
  }
  if (valueType === "date_time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  }
  return String(value);
}

const nonEmpty = (value) => value !== null && value !== undefined && value !== "";

function renderAttributes(record) {
  const parts = (record.attributes || []).map((row) => {
    const values = Array.isArray(row.values) ? row.values.filter(nonEmpty).join(", ") : "";
    return row.name && values ? `${row.name}: ${values}` : row.name || null;
  }).filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

function renderVariants(record) {
  const parts = (record.variants || []).map((row) => {
    const identity = [row.sku, ...(row.combination || [])].filter(nonEmpty).join(" / ") || "Unnamed variant";
    const details = [`quantity ${display(Number(row.quantity || 0), "number")}`, row.status].filter(nonEmpty);
    if (nonEmpty(row.minStock)) details.push(`minimum ${display(row.minStock, "number")}`);
    if (nonEmpty(row.maxStock)) details.push(`maximum ${display(row.maxStock, "number")}`);
    return `${identity}: ${details.join(", ")}`;
  });
  return parts.length ? parts.join("; ") : null;
}

function renderDiscounts(record) {
  const parts = (record.discounts || []).map((row) => (
    nonEmpty(row.minQuantity) && nonEmpty(row.price)
      ? `from ${display(row.minQuantity, "number")}: ${display(row.price, "number")}`
      : null
  )).filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

function renderBudgetLedger(record) {
  if (!record.budgetLedgerName) return null;
  const parts = [record.budgetLedgerName];
  if (record.budgetLedgerSetByName) parts.push(`set by ${record.budgetLedgerSetByName}`);
  const at = display(record.budgetLedgerSetAt, "date_time");
  if (at) parts.push(`at ${at}`);
  return parts.join(", ");
}

function renderInventoryItemMetric({ data } = {}) {
  const resolution = data?.item;
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which inventory field was requested.";
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).map((row) => row.sku ? `${row.name} (${row.sku})` : row.name)
        .filter(Boolean).join(", ");
      if (resolution.suggested) {
        return choices
          ? `I couldn't match one inventory item exactly. Choose the intended item below: ${choices}.`
          : "I couldn't match one inventory item exactly. Choose the intended item below.";
      }
      return choices
        ? `That matches more than one inventory item: ${choices}. Choose the intended item below.`
        : "That matches more than one inventory item. Choose the intended item below.";
    }
    return "I couldn't match one inventory item exactly. Please give its name or SKU as recorded in Store & Purchase.";
  }
  const record = resolution.record;
  const subject = record.name || record.sku || "That inventory item";
  if (definition.id === "item.physical_quantity" && data.stockReconciliation?.mismatch) {
    const unit = data.stockReconciliation.unit ? ` ${data.stockReconciliation.unit}` : "";
    return `${subject}'s item master records ${display(data.stockReconciliation.masterOnHand, "number")}${unit} on hand, while its physical locations record ${display(data.stockReconciliation.locatedOnHand, "number")}${unit}. The stock records conflict and need reconciliation.`;
  }
  if (definition.valueType === "stock_shortfall") return renderStockShortfall(subject, record);
  let value = null;
  if (definition.valueType === "attributes") value = renderAttributes(record);
  else if (definition.valueType === "variants") value = renderVariants(record);
  else if (definition.valueType === "discounts") value = renderDiscounts(record);
  else if (definition.valueType === "budget_ledger") value = renderBudgetLedger(record);
  else value = display(getPath(record, definition.path), definition.valueType);
  return value === null
    ? `${subject}'s ${definition.label.toLowerCase()} is not recorded.`
    : `${subject}'s ${definition.label.toLowerCase()} is ${value}.`;
}

/**
 * How far below its minimum this item has fallen.
 *
 * Three different answers, and the difference matters. An item with no
 * minimum recorded is not "short by 0" — Store has never been told what
 * enough looks like, and saying zero would read as reassurance. An item at
 * or above its minimum is not short. Only the third case is a shortfall, and
 * it is stated with both figures so the reader can check it.
 */
function renderStockShortfall(subject, record) {
  const unit = record.customUnit || record.unit ? ` ${record.customUnit || record.unit}` : "";
  const onHand = Number(record.quantity);
  const minimum = Number(record.minStock);
  const have = Number.isFinite(onHand) ? onHand : 0;
  if (!Number.isFinite(minimum) || minimum <= 0) {
    return `${subject} has no minimum stock recorded, so Store cannot say whether it is short. It holds ${display(have, "number")}${unit} on hand.`;
  }
  if (have >= minimum) {
    return `${subject} is not short: ${display(have, "number")}${unit} on hand against a minimum of ${display(minimum, "number")}${unit}.`;
  }
  return `${subject} is short by ${display(minimum - have, "number")}${unit} — ${display(have, "number")}${unit} on hand against a minimum of ${display(minimum, "number")}${unit}.`;
}

async function claimInventoryLocationMetric({ user, message, history } = {}) {
  const definition = locationMetricFromText(message);
  if (!definition) return null;
  const resolution = await resolveInventoryItem({ user, message, history });
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function renderInventoryLocationMetric({ data } = {}) {
  const resolution = data?.item;
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which physical-location fact was requested.";
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).map((row) => row.sku ? `${row.name} (${row.sku})` : row.name)
        .filter(Boolean).join(", ");
      if (resolution.suggested) {
        return choices
          ? `I couldn't match one inventory item exactly. Choose the intended item below: ${choices}.`
          : "I couldn't match one inventory item exactly. Choose the intended item below.";
      }
      return choices
        ? `That matches more than one inventory item: ${choices}. Choose the intended item below.`
        : "That matches more than one inventory item. Choose the intended item below.";
    }
    return "I couldn't match one inventory item exactly. Please give its name or SKU as recorded in Store & Purchase.";
  }
  const subject = resolution.record.name || resolution.record.sku || "That inventory item";
  const unit = data.unit ? ` ${data.unit}` : "";
  if (definition.id === "item.location_count") {
    return `${subject} is held in ${data.positions.length.toLocaleString("en-IN")} physical ${data.positions.length === 1 ? "position" : "positions"}.`;
  }
  if (definition.id === "item.located_quantity") {
    return `${subject} has ${display(data.located, "number")}${unit} assigned to physical locations.`;
  }
  if (definition.id === "item.unallocated_quantity") {
    return `${subject} has ${display(data.unallocated, "number")}${unit} not assigned to a physical location.`;
  }
  if (!data.positions.length) {
    return data.onHand > 0
      ? `${subject} has ${display(data.onHand, "number")}${unit} on hand, but no physical rack, shelf or bin is recorded for it.`
      : `${subject} has no recorded physical stock position.`;
  }
  const positions = data.positions.map((position) => {
    const variant = position.variant ? ` (${position.variant})` : "";
    return `${position.address}${variant}: ${display(position.onHand, "number")}${unit}`;
  });
  const allocation = data.unallocated > 0
    ? ` ${display(data.unallocated, "number")}${unit} remains unallocated.`
    : "";
  return `${subject} is kept at ${positions.join("; ")}.${allocation}`;
}

function inventoryChoiceLinks(resolution) {
  if (resolution?.found) {
    const record = resolution.record;
    const link = recordLink("inventory_item_master", record?._id, record?.name || record?.sku);
    return link ? [link] : [];
  }
  return [];
}

function inventoryPromptChoices(resolution, definition) {
  if (!resolution?.ambiguous || !definition) return [];
  return (resolution.matches || []).map((row) => {
    const name = row?.name || row?.sku;
    if (!name) return null;
    const label = row?.sku ? `${name} (${row.sku})` : name;
    let prompt;
    if (definition.id === "item.physical_quantity") prompt = `stock of ${name}`;
    else if (definition.id === "item.locations") prompt = `where is ${name} kept?`;
    else prompt = `${definition.label} of ${name}`;
    /* ── AND THE RECORD'S OWN ID ──────────────────────────────────────
       `prompt` is how the conversational assistant follows up: it asks the
       question again with the item named, which is fine in a conversation
       where the next turn is read by the same resolver.

       The command palette cannot work that way. Re-searching a longer
       phrase is a second guess at the same ambiguous words, and an item
       whose name is contained in another's could never be picked. So each
       choice also carries the canonical id of the record it stands for,
       and the palette resolves BY that, never by the label. */
    const recordId = row?._id ? String(row._id) : "";
    return { label, prompt, recordId, kind: "prompt" };
  }).filter(Boolean);
}

registerTool({
  name: "inventory_item_metric",
  application: "store_purchase",
  // Exact catalogue aliases still claim deterministically. For unseen
  // paraphrases, Qwen may select only a semantic metric id after the server has
  // already resolved the real inventory identity. It never sees the record or
  // chooses a database path.
  modelSelectable: true,
  semantic: { catalogue: INVENTORY_CATALOGUE_ID, domains: ["item_master"], subjects: ["inventory_item"] },
  description: "Read one exact, current, authorised raw-item master concept for a named material or SKU, including identity, classification, unit, physical stock on hand, stock limits, status, description, attributes, variants and audit dates. Choose only the semantic metric id; GRAV independently resolves the real item and database field.",
  permission: mayReadInventory,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimInventoryItemMetric,
  recognizeSubject: ({ user, message, history }) => resolveInventoryItem({ user, message, history }),
  provideContext: async ({ user, message, history, args, recognizedSubject }) => {
    /* `args.recordId` is present only when the person PICKED this record
       from an earlier ambiguity. It is a canonical id, read under the same
       tenant scope, never the label they saw. */
    const item = (args?.recordId ? null : recognizedSubject)
      || await resolveInventoryItem({ user, message, history, recordId: args?.recordId });
    const definition = metric(args?.metric);
    let stockReconciliation = null;
    if (definition?.id === "item.physical_quantity" && item?.found) {
      const location = await buildInventoryLocationContext({
        user,
        message,
        history,
        recognizedSubject: item,
      });
      const masterOnHand = Number(item.record?.quantity || 0);
      const locatedOnHand = Number(location.located || 0);
      stockReconciliation = {
        masterOnHand,
        locatedOnHand,
        unit: location.unit || item.record?.customUnit || item.record?.unit || "",
        mismatch: Math.abs(masterOnHand - locatedOnHand) > 0.0001,
      };
    }
    return {
      definition,
      item,
      stockReconciliation,
      subject: item?.found ? { type: "inventory_item", name: item.record.name || "", sku: item.record.sku || "" } : null,
    };
  },
  renderAnswer: renderInventoryItemMetric,
  buildLinks: ({ data }) => inventoryChoiceLinks(data?.item),
  buildChoices: ({ data }) => inventoryPromptChoices(data?.item, data?.definition),
});

registerTool({
  name: "inventory_location_metric",
  application: "store_purchase",
  modelSelectable: true,
  semantic: {
    catalogue: INVENTORY_LOCATION_CATALOGUE_ID,
    domains: ["physical_location"],
    subjects: ["inventory_item"],
  },
  description: "Read the exact physical warehouse, rack, shelf or bin positions for one authorised inventory item, or its location count, located quantity or unallocated quantity. Use this for where/which-rack/storage-position questions; do not substitute item status or total stock.",
  permission: mayReadInventory,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(LOCATION_CATALOGUE.metrics) } },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (message) => Boolean(locationMetricFromText(message)),
  claim: claimInventoryLocationMetric,
  recognizeSubject: ({ user, message, history }) => resolveInventoryItem({ user, message, history }),
  provideContext: async ({ user, message, history, args, recognizedSubject }) => {
    const definition = locationMetric(args?.metric);
    const location = await buildInventoryLocationContext({
      user, message, history, recordId: args?.recordId,
      recognizedSubject: args?.recordId ? null : recognizedSubject,
    });
    return {
      definition,
      ...location,
      subject: location.item?.found
        ? { type: "inventory_item", name: location.item.record.name || "", sku: location.item.record.sku || "" }
        : null,
    };
  },
  renderAnswer: renderInventoryLocationMetric,
  buildLinks: ({ data }) => inventoryChoiceLinks(data?.item),
  buildChoices: ({ data }) => inventoryPromptChoices(data?.item, data?.definition),
});

module.exports = {
  claimInventoryItemMetric,
  renderInventoryItemMetric,
  claimInventoryLocationMetric,
  renderInventoryLocationMetric,
  inventoryChoiceLinks,
  inventoryPromptChoices,
};
