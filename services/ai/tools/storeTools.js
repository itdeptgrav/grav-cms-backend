"use strict";

const { registerTool } = require("../toolRegistry");
const {
  STORE_CATALOGUE_ID, CATALOGUE, metric, metricFromText,
} = require("../../storeSemanticContract");
const documentSequence = require("../../storePurchase/documentSequence.service");
const {
  hintedEntity, resolveRecord, resolveAnyRecord, resolveIssuance, loadSettings, nextNumber,
  loadPurchaseOrders, loadWorkerWorkOrders, loadOrderRequests, statusStats, pathValues,
  workOrdersForRequest, materialRequirements, issuanceProgress,
  loadVendors, loadWorkers, resolveParty,
} = require("../../storeAssistantContext");

// Store is a separate CMS application. Being signed in is not authority to
// read it: use the same database-verified application grant that opens the
// Store UI, and require its read capability.
const mayReadStore = (user) => Boolean(
  user?.applicationAccess?.store?.allowed &&
  user.applicationAccess.store.capabilities?.read,
);

const AGGREGATE_QUERIES = new Set([
  "purchase_order_list", "purchase_order_stats", "worker_work_order_list",
  "worker_work_order_stats", "order_request_list", "next_number",
  "vendor_list", "worker_list",
]);

async function claimStoreMetric({ message } = {}) {
  const aggregate = metricFromText(message);
  if (aggregate && AGGREGATE_QUERIES.has(aggregate.query)) return { metric: aggregate.id };

  const hinted = hintedEntity(message);
  if (["purchase_order_numbering", "worker_work_order_numbering"].includes(hinted)) {
    const definition = metricFromText(message, { entity: hinted });
    return definition ? { metric: definition.id } : null;
  }
  if (hinted === "stock_issuance") {
    const definition = metricFromText(message, { entity: "stock_issuance" });
    if (!definition) return null;
    const resolution = await resolveIssuance(message);
    return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
  }

  const resolved = await resolveAnyRecord(message);
  if (!resolved?.entity || !resolved.resolution) return null;
  const definition = metricFromText(message, { entity: resolved.entity });
  return definition && (resolved.resolution.found || resolved.resolution.ambiguous)
    ? { metric: definition.id }
    : null;
}

const dateTime = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
};
const money = (value) => Number.isFinite(Number(value))
  ? new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(value))
  : value;

function formatValue(value, type) {
  if (type === "date_time") return dateTime(value);
  if (type === "money") return money(value);
  if (type === "boolean") return value === true ? "yes" : value === false ? "no" : value;
  if (Array.isArray(value)) return value.map((item) => formatValue(item, type)).join(", ");
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

function renderResolutionFailure(definition, resolution) {
  const entity = String(definition?.entity || "record").replace(/_/g, " ");
  if (resolution?.ambiguous) {
    const choices = (resolution.matches || []).join(", ");
    return `That matches more than one ${entity}${choices ? `: ${choices}` : ""}. Please use the exact recorded number or name.`;
  }
  return `I couldn't match one ${entity} exactly. Please use its recorded number or name.`;
}

function renderRecordField(definition, resolution) {
  if (!resolution?.found) return renderResolutionFailure(definition, resolution);
  const values = pathValues(resolution.record, definition.path)
    .filter((value) => value !== null && value !== undefined && value !== "");
  const unique = [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
  if (!unique.length) return `${resolution.identity}'s ${definition.label.toLowerCase()} is not recorded.`;
  const rendered = unique.map((value) => formatValue(value, definition.valueType)).filter(Boolean);
  return `${resolution.identity}'s ${definition.label.toLowerCase()} is ${rendered.join("; ")}.`;
}

function renderList(rows, type) {
  if (!rows?.length) return `No ${type} are recorded.`;
  const identity = type === "purchase orders" ? "poNumber"
    : type === "worker work orders" ? "workOrderNumber" : "requestId";
  const shown = rows.slice(0, 30).map((row) => {
    const name = row[identity];
    const party = row.vendorName || row.workerName || row.customerInfo?.name;
    return [name, party, row.status].filter(Boolean).join(" — ");
  });
  return `${type[0].toUpperCase()}${type.slice(1)} (${rows.length}): ${shown.join("; ")}${rows.length > shown.length ? `; and ${rows.length - shown.length} more` : ""}.`;
}

function renderStats(value, label) {
  if (!value) return `I couldn't verify ${label.toLowerCase()}.`;
  const statuses = Object.entries(value.byStatus || {}).map(([status, count]) => `${status}: ${count}`).join(", ");
  return `${label}: ${value.total} total${statuses ? ` (${statuses})` : ""}.`;
}

function renderRequestWorkOrders(value) {
  if (!value?.found) return renderResolutionFailure({ entity: "order_request" }, value);
  if (!value.rows?.length) return `${value.identity} has no manufacturing work orders.`;
  const rows = value.rows.map((row) => [row.workOrderNumber, row.stockItemName, `${row.quantity || 0}`, row.status]
    .filter(Boolean).join(" — "));
  return `${value.identity}'s manufacturing work orders (${value.rows.length}): ${rows.join("; ")}.`;
}

function renderVerification(value) {
  if (!value?.found) return renderResolutionFailure({ entity: "order_request" }, value);
  const total = value.rows?.length || 0;
  const verified = (value.rows || []).filter((row) => row.storeDepartmentVerified === true).length;
  const percent = total ? Math.round((verified / total) * 100) : 0;
  return `${value.identity}'s Store verification is ${verified} of ${total} work orders (${percent}%).`;
}

function safeMaterialRows(value, shortagesOnly) {
  return (value?.items || []).filter((row) => !shortagesOnly || Number(row.shortfall) > 0).map((row) => {
    const variant = row.variantCombination?.length ? ` (${row.variantCombination.join(", ")})` : "";
    const availability = row.available === null
      ? "availability unknown"
      : `required ${row.quantityRequired} ${row.unit || ""}, available ${row.available}, shortfall ${row.shortfall}`;
    return `${row.rawItemName || row.rawItemSku}${variant}: ${availability}; ${row.status}`;
  });
}

function renderMaterials(value, shortagesOnly = false) {
  if (!value?.found) return renderResolutionFailure({ entity: "order_request" }, value);
  const rows = safeMaterialRows(value, shortagesOnly);
  if (!rows.length) return shortagesOnly
    ? `${value.identity} has no recorded raw-material shortfall.`
    : `${value.identity} has no recorded raw-material requirement.`;
  const summary = value.summary || {};
  return `${value.identity}'s ${shortagesOnly ? "raw-material shortfalls" : "raw-material requirements"} ` +
    `(${rows.length} shown; ${summary.shortfallCount || 0} short): ${rows.join("; ")}.`;
}

function renderIssuance(value) {
  if (!value?.found) return renderResolutionFailure({ entity: "order_request" }, value);
  const items = (value.items || []).map((row) => (
    `${row.rawItemName || row.rawItemSku}: required ${row.totalRequired} ${row.unit || ""}, ` +
    `issued ${row.totalIssued}, remaining ${row.remaining}, excess ${row.excess}; ${row.status}`
  ));
  const extras = (value.extraItems || []).map((row) => `${row.rawItemName || row.rawItemSku}: ${row.totalIssued} ${row.unit || ""} issued outside the BOM`);
  const summary = value.summary || {};
  return `${value.identity}'s issuance progress (${value.issuanceCount || 0} issuance records; ` +
    `${summary.met || 0} met, ${summary.partial || 0} partial, ${summary.notIssued || 0} not issued, ` +
    `${summary.overIssued || 0} over-issued): ${[...items, ...extras].join("; ") || "no material lines"}.`;
}

function renderStoreMetric({ data } = {}) {
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which Store data point was requested.";
  if (definition.query === "record_field") return renderRecordField(definition, data.resolution);
  if (definition.query === "party_field") return renderRecordField(definition, data.resolution);
  if (definition.query === "purchase_order_list") return renderList(data.value, "purchase orders");
  if (definition.query === "worker_work_order_list") return renderList(data.value, "worker work orders");
  if (definition.query === "order_request_list") return renderList(data.value, "order requests");
  if (definition.query === "vendor_list") {
    return data.value?.length ? `Store vendors (${data.value.length}): ${data.value.map((row) => row.name).join("; ")}.` : "No Store vendors are recorded.";
  }
  if (definition.query === "worker_list") {
    return data.value?.length ? `Store workers (${data.value.length}): ${data.value.map((row) => row.name).join("; ")}.` : "No Store workers are recorded.";
  }
  if (definition.query.endsWith("_stats")) return renderStats(data.value, definition.label);
  if (definition.query === "request_work_orders") return renderRequestWorkOrders(data.value);
  if (definition.query === "request_verification") return renderVerification(data.value);
  if (["request_materials", "work_order_materials"].includes(definition.query)) return renderMaterials(data.value, false);
  if (["request_shortfalls", "work_order_shortfalls"].includes(definition.query)) return renderMaterials(data.value, true);
  if (definition.query === "request_issuance") return renderIssuance(data.value);
  if (definition.query === "next_number") {
    return data.value
      ? `${definition.label} is ${data.value}.`
      : `${definition.label} cannot be calculated because its numbering settings are not recorded.`;
  }
  return "I couldn't verify that Store answer.";
}

registerTool({
  name: "store_metric",
  application: "store",
  // Catalogue claims handle known language deterministically. Qwen is allowed
  // to link an unseen paraphrase to a semantic concept id, never to a database
  // path. provideContext independently resolves the real entity below, so a
  // concept for another record type cannot execute against this message.
  modelSelectable: true,
  semantic: {
    catalogue: STORE_CATALOGUE_ID,
    domains: ["store_records"],
    subjects: Object.keys(CATALOGUE.entities),
  },
  description: "Read one semantic concept from one exact identified Store record, or a specialised Store relationship/numbering result. Use when the question identifies a particular order, request, vendor, worker or other record and asks for one of its attributes. Do not use for plural lists, counts, existence, filtering, date ranges, aggregates or grouping; those require the matching collection-query capability. GRAV independently resolves the exact business entity and never exposes database fields.",
  permission: mayReadStore,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"], additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimStoreMetric,
  recognizeSubject: async ({ message }) => {
    const resolved = await resolveAnyRecord(message);
    if (!resolved?.entity || !resolved.resolution) return null;
    return { entity: resolved.entity, ...resolved.resolution };
  },
  provideContext: async ({ message, args, user }) => {
    const definition = metric(args?.metric);
    if (!definition) return { definition: null };
    if (definition.query === "purchase_order_list") return { definition, value: await loadPurchaseOrders() };
    if (definition.query === "purchase_order_stats") return { definition, value: statusStats(await loadPurchaseOrders()) };
    if (definition.query === "worker_work_order_list") return { definition, value: await loadWorkerWorkOrders() };
    if (definition.query === "worker_work_order_stats") return { definition, value: statusStats(await loadWorkerWorkOrders()) };
    if (definition.query === "order_request_list") return { definition, value: await loadOrderRequests() };
    if (definition.query === "vendor_list") return { definition, value: await loadVendors() };
    if (definition.query === "worker_list") return { definition, value: await loadWorkers() };
    if (definition.query === "request_work_orders" || definition.query === "request_verification") {
      return { definition, value: await workOrdersForRequest(message) };
    }
    if (["request_materials", "request_shortfalls"].includes(definition.query)) {
      return { definition, value: await materialRequirements("order_request", message) };
    }
    if (["work_order_materials", "work_order_shortfalls"].includes(definition.query)) {
      return { definition, value: await materialRequirements("manufacturing_work_order", message) };
    }
    if (definition.query === "request_issuance") return { definition, value: await issuanceProgress(message) };
    if (definition.query === "next_number") {
      /* ── THE NEXT PURCHASE ORDER NUMBER IS THE REGISTER'S ─────────────
           Two PO counters exist: the legacy Store screen's settings row
           (`PO-0001`, counter 0) and the Store & Purchase document sequence
           that numbers every order actually raised (`PO/2026-27/0013`).
           Asked "next po number", this answered from the legacy one. The
           owner's call, 8 Oct 2026: it means the register — so it is read
           from the sequence, for this person's company, without moving it
           (`peek`), and rendered by the sequence's own `format`. No company,
           no number: it fails closed rather than guessing one. */
      if (definition.entity === "purchase_order_numbering") {
        const companyId = user?.storePurchaseAccess?.companyId;
        if (!companyId) return { definition, value: null };
        const { fiscalYear, issued } = await documentSequence.peek({ companyId, documentType: "PURCHASE_ORDER" });
        return {
          definition,
          value: documentSequence.format({ documentType: "PURCHASE_ORDER", fiscalYear, sequence: issued + 1 }),
        };
      }
      return { definition, value: nextNumber(await loadSettings(definition.entity)) };
    }
    // Model-linked paraphrases receive the same entity-first boundary as
    // deterministic claims. A schema-valid concept for the wrong Store entity
    // is not executable merely because Qwen selected it.
    if (definition.query === "record_field" || definition.query === "party_field") {
      const resolved = await resolveAnyRecord(message);
      if (!resolved?.entity || resolved.entity !== definition.entity) {
        return {
          definition,
          resolution: resolved?.ambiguous
            ? { ambiguous: true, matches: resolved.matches || [] }
            : { found: false },
        };
      }
    }
    if (["purchase_order_numbering", "worker_work_order_numbering"].includes(definition.entity)) {
      return { definition, resolution: await loadSettings(definition.entity) };
    }
    if (definition.entity === "stock_issuance") {
      return { definition, resolution: await resolveIssuance(message) };
    }
    if (["store_vendor", "store_worker"].includes(definition.entity)) {
      return { definition, resolution: await resolveParty(definition.entity, message) };
    }
    return { definition, resolution: await resolveRecord(definition.entity, message) };
  },
  renderAnswer: renderStoreMetric,
});

module.exports = { claimStoreMetric, renderStoreMetric };
