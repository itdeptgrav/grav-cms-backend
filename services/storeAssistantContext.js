"use strict";

const PurchaseOrder = require("../models/CMS_Models/Store/PurchaseOrder");
const PurchaseOrderSettings = require("../models/CMS_Models/Store/PurchaseOrderSettings");
const WorkOrderSettings = require("../models/CMS_Models/Store/WorkOrderSettings");
const WorkerWorkOrder = require("../models/CMS_Models/Store/WorkerWorkOrder");
const StockIssuance = require("../models/CMS_Models/Inventory/Operations/StockIssuance");
const StockItem = require("../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../models/CMS_Models/Inventory/Products/RawItem");
const ManufacturingWorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const { CONTRACTS } = require("./storeApplicationFieldContracts");
const { includesTerm } = require("./ai/semanticCatalogue");

const contract = (id) => CONTRACTS.find((item) => item.id === id);
const CONFIG = Object.freeze({
  purchase_order: {
    model: PurchaseOrder, contract: contract("store.purchase_order"), identity: "poNumber", label: "purchase order",
  },
  worker_work_order: {
    model: WorkerWorkOrder, contract: contract("store.worker_work_order"), identity: "workOrderNumber", label: "worker work order",
  },
  order_request: {
    model: CustomerRequest, contract: contract("store.customer_request_view"), identity: "requestId", label: "order request",
  },
  manufacturing_work_order: {
    model: ManufacturingWorkOrder, contract: contract("store.manufacturing_work_order_view"), identity: "workOrderNumber", label: "manufacturing work order",
  },
  stock_item_bom: {
    model: StockItem, contract: contract("store.stock_item_bom_view"), identity: "name", label: "stock item",
  },
});

const SETTINGS = Object.freeze({
  purchase_order_numbering: {
    model: PurchaseOrderSettings, contract: contract("store.purchase_order_settings"), label: "purchase order numbering",
  },
  worker_work_order_numbering: {
    model: WorkOrderSettings, contract: contract("store.worker_work_order_settings"), label: "worker work order numbering",
  },
});

const ENTITY_HINTS = Object.freeze([
  ["purchase_order_numbering", ["purchase order numbering", "po numbering", "next po number", "next purchase order number"]],
  ["worker_work_order_numbering", ["worker work order numbering", "worker order numbering", "next worker order number"]],
  ["stock_issuance", ["stock issuance", "material issuance", "materials issued", "issued material"]],
  ["manufacturing_work_order", ["manufacturing work order", "manufacturing order", "production work order"]],
  ["worker_work_order", ["worker work order", "worker order", "job work order"]],
  ["order_request", ["order request", "customer request", "store po"]],
  ["stock_item_bom", ["bill of materials", "bom", "stock item"]],
  ["store_vendor", ["vendor", "supplier"]],
  ["store_worker", ["contract worker", "worker"]],
  ["purchase_order", ["store purchase order", "purchase order", "po"]],
]);

function hintedEntity(message) {
  for (const [entity, terms] of ENTITY_HINTS) {
    if (terms.some((term) => includesTerm(message, term))) return entity;
  }
  return null;
}

async function identities(entity) {
  const config = CONFIG[entity];
  if (!config) return [];
  return config.model.find({ [config.identity]: { $nin: [null, ""] } })
    .select(config.identity).sort({ updatedAt: -1 }).lean();
}

function matchIdentity(rows, identity, message) {
  const matches = (rows || []).filter((row) => includesTerm(message, row?.[identity]));
  if (matches.length === 1) return { found: true, identity: matches[0][identity] };
  if (matches.length > 1) return { ambiguous: true, matches: matches.map((row) => row[identity]) };
  return { found: false };
}

async function resolveRecord(entity, message) {
  const config = CONFIG[entity];
  if (!config) return { found: false };
  const resolution = matchIdentity(await identities(entity), config.identity, message);
  if (!resolution.found) return resolution;
  const record = await config.model.findOne({ [config.identity]: resolution.identity })
    .select(`${config.contract.projection()} -_id`).lean();
  return record ? { found: true, record, identity: resolution.identity, label: config.label } : { found: false };
}

async function resolveAnyRecord(message) {
  const hinted = hintedEntity(message);
  if (["store_vendor", "store_worker"].includes(hinted)) {
    return { entity: hinted, resolution: await resolveParty(hinted, message) };
  }
  if (CONFIG[hinted]) return { entity: hinted, resolution: await resolveRecord(hinted, message) };
  /* Read side by side. Each is an independent identity read, and in turn
     they made every unhinted Store question wait for five round trips —
     a quarter of a second on Atlas before anything else could happen. The
     order of the results, and so every answer, is unchanged. */
  const entities = Object.keys(CONFIG);
  const lists = await Promise.all(entities.map((entity) => identities(entity)));
  const candidates = [];
  entities.forEach((entity, index) => {
    const resolution = matchIdentity(lists[index], CONFIG[entity].identity, message);
    if (resolution.found) candidates.push({ entity, resolution });
  });
  if (candidates.length !== 1) {
    if (!candidates.length) {
      const kinds = ["store_vendor", "store_worker"];
      const resolved = await Promise.all(kinds.map((entity) => resolveParty(entity, message)));
      const parties = kinds.map((entity, index) => ({ entity, resolution: resolved[index] }))
        .filter((item) => item.resolution.found);
      if (parties.length === 1) return parties[0];
      if (parties.length > 1) return { ambiguous: true, matches: parties.map((item) => `${item.entity}:${item.resolution.identity}`) };
    }
    return candidates.length > 1
      ? { ambiguous: true, matches: candidates.map((item) => `${item.entity}:${item.resolution.identity}`) }
      : { found: false };
  }
  return { entity: candidates[0].entity, resolution: await resolveRecord(candidates[0].entity, message) };
}

async function loadVendors() {
  const rows = await PurchaseOrder.find({ vendorName: { $nin: [null, ""] } })
    .select("vendorName vendorPhone vendorAddress vendorGstin shipToAddress billToAddress updatedAt -_id")
    .sort({ updatedAt: -1 }).lean();
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.vendorName || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => ({
    name: row.vendorName, phone: row.vendorPhone || "", address: row.vendorAddress || "",
    gstin: row.vendorGstin || "", shipTo: row.shipToAddress || "", billTo: row.billToAddress || "",
  }));
}

async function loadWorkers() {
  const rows = await WorkerWorkOrder.find({ workerName: { $nin: [null, ""] } })
    .select("workerName workerPhone workerAddress workerGstin workerNotes updatedAt -_id")
    .sort({ updatedAt: -1 }).lean();
  const seen = new Set();
  return rows.filter((row) => {
    const key = String(row.workerName || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row) => ({
    name: row.workerName, phone: row.workerPhone || "", address: row.workerAddress || "",
    gstin: row.workerGstin || "", notes: row.workerNotes || "",
  }));
}

async function resolveParty(entity, message) {
  const rows = entity === "store_vendor" ? await loadVendors() : await loadWorkers();
  const matches = rows.filter((row) => includesTerm(message, row.name));
  if (matches.length === 1) return { found: true, identity: matches[0].name, record: matches[0] };
  if (matches.length > 1) return { ambiguous: true, matches: matches.map((row) => row.name) };
  return { found: false };
}

async function loadSettings(entity) {
  const config = SETTINGS[entity];
  if (!config) return { found: false };
  const value = await config.model.findOne({ key: "global" }).select(`${config.contract.projection()} -_id`).lean();
  return value
    ? { found: true, record: value, identity: config.label, label: config.label }
    : { found: false, identity: config.label, label: config.label };
}

function nextNumber(settings) {
  if (!settings?.found) return null;
  const row = settings.record;
  const next = Number(row.counter || 0) + 1;
  return `${row.prefix || ""}${String(next).padStart(Number(row.padding || 0), "0")}${row.suffix || ""}`;
}

async function loadPurchaseOrders() {
  return PurchaseOrder.find({}).select(`${contract("store.purchase_order").projection()} -_id`).sort({ createdAt: -1 }).lean();
}

async function loadWorkerWorkOrders() {
  return WorkerWorkOrder.find({}).select(`${contract("store.worker_work_order").projection()} -_id`).sort({ createdAt: -1 }).lean();
}

async function loadOrderRequests() {
  return CustomerRequest.find({ status: { $in: ["quotation_sales_approved", "in_progress", "completed"] } })
    .select(`${contract("store.customer_request_view").projection()} -_id`).sort({ createdAt: -1 }).lean();
}

function statusStats(rows) {
  const byStatus = {};
  for (const row of rows || []) {
    const key = String(row.status || "Not recorded");
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  return { total: (rows || []).length, byStatus };
}

async function resolveIssuance(message) {
  const request = await resolveRecord("order_request", message);
  if (!request.found) return request;
  const internal = await CustomerRequest.findOne({ requestId: request.identity }).select("_id").lean();
  if (!internal) return { found: false };
  const rows = await StockIssuance.find({ manufacturingOrder: internal._id })
    .select(`${contract("store.stock_issuance_view").projection()} -_id`).sort({ createdAt: -1 }).lean();
  return { found: true, record: rows, identity: request.identity, label: "stock issuance" };
}

function pathValues(value, path) {
  const segments = String(path || "").split(".").filter(Boolean);
  const walk = (node, index) => {
    if (node === null || node === undefined) return [];
    if (Array.isArray(node)) return node.flatMap((item) => walk(item, index));
    if (index >= segments.length) return [node];
    return walk(node[segments[index]], index + 1);
  };
  return walk(value, 0).filter((item) => item !== undefined);
}

const variantMatch = (workOrder, variants) => {
  if (!variants?.length) return null;
  if (workOrder.variantId) {
    const exact = variants.find((item) => String(item._id) === String(workOrder.variantId));
    if (exact) return exact;
  }
  if (workOrder.variantAttributes?.length) {
    const exact = variants.find((variant) => workOrder.variantAttributes.every((wanted) => (
      variant.attributes?.some((actual) => actual.name === wanted.name && actual.value === wanted.value)
    )));
    if (exact) return exact;
  }
  return variants[0];
};

async function workOrdersForRequest(message) {
  const request = await resolveRecord("order_request", message);
  if (!request.found) return request;
  const internal = await CustomerRequest.findOne({ requestId: request.identity }).select("_id").lean();
  if (!internal) return { found: false };
  const rows = await ManufacturingWorkOrder.find({ customerRequestId: internal._id })
    .select(`${contract("store.manufacturing_work_order_view").projection()} -_id`).sort({ createdAt: 1 }).lean();
  const calculationRows = await ManufacturingWorkOrder.find({ customerRequestId: internal._id })
    .select("workOrderNumber stockItemId variantId variantAttributes quantity rawMaterials").sort({ createdAt: 1 }).lean();
  return { found: true, identity: request.identity, requestId: internal._id, request: request.record, rows, calculationRows };
}

async function requirementsFromWorkOrders(workOrders) {
  const entries = [];
  for (const wo of workOrders || []) {
    for (const material of wo.rawMaterials || []) {
      if (!material.rawItemId) continue;
      entries.push({
        rawItemId: String(material.rawItemId), variantId: material.rawItemVariantId ? String(material.rawItemVariantId) : "",
        rawItemName: material.name || "", rawItemSku: material.sku || "",
        variantCombination: material.rawItemVariantCombination || [], unit: material.unit || "",
        quantityRequired: Number(material.quantityRequired || 0), unitCost: Number(material.unitCost || 0),
        totalCost: Number(material.totalCost || 0), workOrderNumber: wo.workOrderNumber || "",
      });
    }
  }

  // Older work orders can predate rawMaterials snapshots. Reconstruct their
  // requirement from the exact StockItem variant instead of guessing zero.
  if (!entries.length && workOrders?.length) {
    const ids = [...new Set(workOrders.map((wo) => wo.stockItemId).filter(Boolean).map(String))];
    const stockItems = await StockItem.find({ _id: { $in: ids } }).select("name variants").lean();
    const byId = new Map(stockItems.map((item) => [String(item._id), item]));
    for (const wo of workOrders) {
      const variant = variantMatch(wo, byId.get(String(wo.stockItemId))?.variants || []);
      for (const material of variant?.rawItems || []) {
        if (!material.rawItemId) continue;
        const required = Number(material.quantity || material.requiredQuantity || 0) * Number(wo.quantity || 0);
        const unitCost = Number(material.unitCost || material.cost || 0);
        entries.push({
          rawItemId: String(material.rawItemId), variantId: material.variantId ? String(material.variantId) : "",
          rawItemName: material.rawItemName || "", rawItemSku: material.rawItemSku || "",
          variantCombination: material.variantCombination || [], unit: material.unit || material.baseUnit || "",
          quantityRequired: required, unitCost, totalCost: required * unitCost,
          workOrderNumber: wo.workOrderNumber || "",
        });
      }
    }
  }

  const totals = new Map();
  for (const entry of entries) {
    const key = `${entry.rawItemId}|${entry.variantId}`;
    const row = totals.get(key) || { ...entry, quantityRequired: 0, totalCost: 0, workOrders: [] };
    row.quantityRequired += entry.quantityRequired;
    row.totalCost += entry.totalCost;
    if (entry.workOrderNumber && !row.workOrders.includes(entry.workOrderNumber)) row.workOrders.push(entry.workOrderNumber);
    totals.set(key, row);
  }
  const rawIds = [...new Set([...totals.values()].map((row) => row.rawItemId))];
  const rawItems = rawIds.length
    ? await RawItem.find({ _id: { $in: rawIds } }).select("quantity minStock unit customUnit variants._id variants.quantity variants.minStock variants.unitConversions").lean()
    : [];
  const rawById = new Map(rawItems.map((item) => [String(item._id), item]));
  const statusRank = { out_of_stock: 0, shortage: 1, low: 2, ok: 3, unknown: 4 };
  const items = [...totals.values()].map((row) => {
    const raw = rawById.get(row.rawItemId);
    const variant = row.variantId ? raw?.variants?.find((item) => String(item._id) === row.variantId) : null;
    const available = raw ? Number(variant ? variant.quantity || 0 : raw.quantity || 0) : null;
    const minStock = raw ? Number(variant?.minStock ?? raw.minStock ?? 0) : null;
    const shortfall = available === null ? null : Math.max(0, row.quantityRequired - available);
    const status = available === null ? "unknown"
      : available <= 0 ? "out_of_stock"
        : shortfall > 0 ? "shortage"
          : available - row.quantityRequired <= minStock ? "low" : "ok";
    return {
      ...row, available, minStock, shortfall, status,
      nativeUnit: raw?.customUnit || raw?.unit || row.unit || "",
      unitConversions: variant?.unitConversions || [],
    };
  }).sort((a, b) => (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9));
  return {
    items,
    summary: {
      totalRawItems: items.length,
      totalWorkOrders: (workOrders || []).length,
      totalRequired: items.reduce((sum, row) => sum + row.quantityRequired, 0),
      totalAvailable: items.reduce((sum, row) => sum + (row.available === null ? 0 : row.available), 0),
      shortfallCount: items.filter((row) => Number(row.shortfall) > 0).length,
      totalCost: items.reduce((sum, row) => sum + row.totalCost, 0),
    },
  };
}

async function materialRequirements(entity, message) {
  if (entity === "manufacturing_work_order") {
    const wo = await resolveRecord(entity, message);
    if (!wo.found) return wo;
    const calculationRow = await ManufacturingWorkOrder.findOne({ workOrderNumber: wo.identity })
      .select("workOrderNumber stockItemId variantId variantAttributes quantity rawMaterials").lean();
    return { found: true, identity: wo.identity, ...(await requirementsFromWorkOrders(calculationRow ? [calculationRow] : [])) };
  }
  const related = await workOrdersForRequest(message);
  if (!related.found) return related;
  return { found: true, identity: related.identity, ...(await requirementsFromWorkOrders(related.calculationRows)) };
}

async function issuanceProgress(message) {
  const related = await workOrdersForRequest(message);
  if (!related.found) return related;
  const requirements = await requirementsFromWorkOrders(related.calculationRows);
  const issuanceRows = await StockIssuance.find({ manufacturingOrder: related.requestId })
    .select("direction createdAt reason items.rawItem items.rawItemName items.rawItemSku items.variantId items.variantCombination items.issuedQty items.issuedUnit items.nativeQty items.nativeUnit").lean();
  const required = new Map(requirements.items.map((row) => [`${row.rawItemId}|${row.variantId}`, { ...row, totalIssued: 0 }]));
  const extras = new Map();
  for (const issuance of issuanceRows) {
    for (const item of issuance.items || []) {
      const key = `${String(item.rawItem || "")}|${String(item.variantId || "")}`;
      const signed = Number(item.nativeQty || 0) * (issuance.direction === "credit" ? -1 : 1);
      const row = required.get(key);
      if (row) {
        let inRequiredUnit = signed;
        if (row.nativeUnit && row.unit && row.nativeUnit !== row.unit) {
          const conversion = (row.unitConversions || []).find((item) => (
            (item.fromUnit === row.nativeUnit && item.toUnit === row.unit) ||
            (item.fromUnit === row.unit && item.toUnit === row.nativeUnit)
          ));
          if (Number(conversion?.quantity)) {
            inRequiredUnit = conversion.fromUnit === row.nativeUnit
              ? signed * Number(conversion.quantity)
              : signed / Number(conversion.quantity);
          }
        }
        row.totalIssued += inRequiredUnit;
      }
      else {
        const extra = extras.get(key) || {
          rawItemName: item.rawItemName || "", rawItemSku: item.rawItemSku || "",
          variantCombination: item.variantCombination || [], unit: item.nativeUnit || item.issuedUnit || "", totalIssued: 0,
        };
        extra.totalIssued += signed;
        extras.set(key, extra);
      }
    }
  }
  const items = [...required.values()].map((row) => {
    const diff = row.quantityRequired - row.totalIssued;
    return {
      rawItemName: row.rawItemName, rawItemSku: row.rawItemSku, variantCombination: row.variantCombination,
      unit: row.unit, totalRequired: row.quantityRequired, totalIssued: row.totalIssued,
      remaining: Math.max(0, diff), excess: Math.max(0, -diff),
      status: row.totalIssued <= 0 ? "not_issued" : diff > 0.001 ? "partial" : diff < -0.001 ? "over_issued" : "met",
    };
  });
  return {
    found: true, identity: related.identity, items, extraItems: [...extras.values()], issuanceCount: issuanceRows.length,
    summary: {
      totalItems: items.length,
      notIssued: items.filter((row) => row.status === "not_issued").length,
      partial: items.filter((row) => row.status === "partial").length,
      met: items.filter((row) => row.status === "met").length,
      overIssued: items.filter((row) => row.status === "over_issued").length,
    },
  };
}

module.exports = {
  hintedEntity, resolveRecord, resolveAnyRecord, resolveIssuance, loadSettings, nextNumber,
  loadPurchaseOrders, loadWorkerWorkOrders, loadOrderRequests, statusStats, pathValues,
  workOrdersForRequest, materialRequirements, issuanceProgress,
  loadVendors, loadWorkers, resolveParty,
};
