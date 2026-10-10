"use strict";

/**
 * Safe read projection for the Store Request Desk.
 *
 * The screen is a union of five independently-authorised sources.  The
 * assistant must query that same business surface rather than guessing that
 * the word "request" means one Mongo collection.  Raw documents, attachments,
 * money, approval identities and unrestricted notes never leave this module.
 */

const mongoose = require("mongoose");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockIssuance = require("../models/CMS_Models/Inventory/Operations/StockIssuance");
const MRF = require("../models/CMS_Models/Inventory/Operations/MRF");
const RawItemAddRequest = require("../models/CMS_Models/Inventory/Operations/RawItemAddRequest");
const IntakeRequest = require("../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../models/Employee");
const tenantContext = require("./storePurchase/tenantContext.service");
const { CAPABILITIES } = require("./storePurchase/capabilities");
const { resolveFulfilmentAccess } = require("./access/fulfilmentAccess");

const OPERATIONS = Object.freeze(["list", "count", "exists", "group_count"]);
const TYPES = Object.freeze(["all", "manufacturing", "material", "fulfilment", "purchase_service", "item_addition"]);
const STAGES = Object.freeze(["all", "needs_action", "in_progress", "completed"]);
const SORTS = Object.freeze(["newest", "oldest"]);
const SOURCE_LABELS = Object.freeze({
  manufacturing: "manufacturing requirements",
  material: "material requests",
  item_addition: "item addition requests",
  fulfilment: "fulfilment requests",
  purchase_service: "purchase or service requests",
});

const clean = (value) => String(value || "").trim();
const lower = (value) => clean(value).toLowerCase();
const iso = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

function stageFor(type, row) {
  if (type === "manufacturing") {
    if (row.status === "completed" || row.isFullyVerified) return { key: "completed", label: "Completed" };
    if (row.hasIssuance) return { key: "in_progress", label: "Issuing in progress" };
    return { key: "needs_action", label: "Needs Store action" };
  }
  if (type === "material") {
    if (["REJECTED", "CANCELLED", "ISSUED", "COMPLETED"].includes(row.status)) {
      return { key: "completed", label: ["ISSUED", "COMPLETED"].includes(row.status) ? "Completed" : row.status };
    }
    if (row.status === "PARTIALLY_RETURNED") return { key: "in_progress", label: "Partly returned" };
    return { key: "needs_action", label: row.status === "PARTIALLY_ISSUED" ? "Partly issued" : "Ready to issue" };
  }
  if (type === "item_addition") {
    if (["ADDED", "RESOLVED", "REJECTED"].includes(row.status) || row.approvalStatus === "TL_REJECTED") {
      return { key: "completed", label: row.status === "ADDED" ? "Added" : row.status === "RESOLVED" ? "Resolved" : "Rejected" };
    }
    if (row.approvalStatus === "TL_APPROVED") return { key: "needs_action", label: row.status === "MATCHED" ? "Ready to register" : "Needs item matching" };
    return { key: "in_progress", label: "Waiting for approval" };
  }
  if (type === "fulfilment") return { key: "needs_action", label: "Needs fulfilment decision" };
  const terminal = ["rejected", "cancelled"];
  if (terminal.includes(row.status)) return { key: "completed", label: row.status === "rejected" ? "Rejected" : "Withdrawn" };
  if (["requester_confirmed", "requester_revision_requested"].includes(row.status)) {
    return { key: "needs_action", label: row.status === "requester_confirmed" ? "Ready to send to Finance" : "Needs requote" };
  }
  return { key: "in_progress", label: clean(row.status).replace(/_/g, " ") || "In progress" };
}

function safeRow(type, row) {
  const stage = stageFor(type, row);
  const products = Array.isArray(row.products) ? row.products : [];
  const items = Array.isArray(row.items) ? row.items : [];
  const identity = type === "manufacturing" ? row.requestId
    : type === "material" ? row.mrfNumber
      : type === "fulfilment" ? row.requestNumber
        : type === "purchase_service" ? row.requestNumber
          : products.map((item) => item.itemName).filter(Boolean).join(", ");
  const title = type === "manufacturing" ? row.customerName
    : type === "material" ? row.reason
      : type === "item_addition" ? products.map((item) => item.itemName).filter(Boolean).join(", ")
        : row.title || items.map((item) => item.name).filter(Boolean).slice(0, 3).join(", ");
  return {
    recordId: clean(row._id || row.id),
    type,
    typeLabel: SOURCE_LABELS[type],
    number: clean(identity) || "Not recorded",
    title: clean(title) || "Not recorded",
    requestedBy: clean(type === "manufacturing" ? row.customerName : row.requestedForName || row.requestedByName) || "Not recorded",
    department: clean(type === "manufacturing" ? row.organizationName : row.requestedForDept || row.department || row.requestedByDept) || "Not recorded",
    date: iso(type === "purchase_service" ? row.updatedAt : row.createdAt),
    status: clean(row.status) || "Not recorded",
    stage: stage.label,
    stageGroup: stage.key,
  };
}

async function actorEmployee(user) {
  const clauses = [];
  if (mongoose.isValidObjectId(user?.id)) clauses.push({ _id: user.id });
  if (user?.employeeId) clauses.push({ biometricId: user.employeeId }, { identityId: user.employeeId });
  if (user?.email) clauses.push({ email: lower(user.email) });
  if (!clauses.length) return null;
  return Employee.findOne({ $or: clauses })
    .select("_id email biometricId identityId accessDepartmentId additionalDepartmentIds department isActive status")
    .lean();
}

async function manufacturingRows() {
  const requests = await CustomerRequest.find({ status: { $in: ["quotation_sales_approved", "in_progress", "completed"] } })
    .select("requestId customerInfo status createdAt")
    .limit(500)
    .lean();
  const ids = requests.map((row) => row._id);
  if (!ids.length) return [];
  const [work, issuance] = await Promise.all([
    WorkOrder.aggregate([
      { $match: { customerRequestId: { $in: ids } } },
      { $group: { _id: "$customerRequestId", total: { $sum: 1 }, verified: { $sum: { $cond: [{ $eq: ["$storeDepartmentVerified", true] }, 1, 0] } } } },
    ]),
    StockIssuance.aggregate([
      { $match: { manufacturingOrder: { $in: ids }, direction: "debit" } },
      { $group: { _id: "$manufacturingOrder", total: { $sum: 1 } } },
    ]),
  ]);
  const workById = new Map(work.map((row) => [String(row._id), row]));
  const issuedById = new Map(issuance.map((row) => [String(row._id), row.total]));
  return requests.flatMap((row) => {
    const stat = workById.get(String(row._id));
    if (!stat?.total) return [];
    return [safeRow("manufacturing", {
      _id: row._id,
      requestId: row.requestId,
      customerName: row.customerInfo?.name,
      organizationName: row.customerInfo?.organizationName,
      status: row.status,
      createdAt: row.createdAt,
      isFullyVerified: stat.verified === stat.total,
      hasIssuance: Boolean(issuedById.get(String(row._id))),
    })];
  });
}

async function materialRows(access) {
  const records = await MRF.find(tenantContext.tenantFilter(access))
    .select("mrfNumber requestedForName requestedForDept reason status tlApproved autoForwarded createdAt")
    .sort({ createdAt: -1 }).limit(500).lean();
  return records.filter((row) => row.tlApproved || row.autoForwarded).map((row) => safeRow("material", row));
}

async function itemAdditionRows(access) {
  if (!access.capabilitySet?.has(CAPABILITIES.LEGACY_READ)) return null;
  const records = await RawItemAddRequest.find(tenantContext.tenantFilter({ ...access, legacyMode: true }))
    .select("requestedByName requestedByDept products approvalStatus status createdAt")
    .sort({ createdAt: -1 }).limit(500).lean();
  return records.filter((row) => row.status !== "RESOLVED").map((row) => safeRow("item_addition", row));
}

async function fulfilmentRows() {
  const rows = await IntakeRequest.find({ status: "needs_classification" })
    .select("requestNumber title requestedByName department items status createdAt")
    .sort({ createdAt: -1 }).limit(150).lean();
  return rows.map((row) => safeRow("fulfilment", row));
}

async function purchaseServiceRows(access) {
  const scoped = tenantContext.tenantFilter(access);
  const rows = await SpendRequest.find({ $and: [scoped, { intakeRequestId: { $exists: true, $ne: null } }] })
    .select("requestNumber title requestedByName department items status createdAt updatedAt")
    .sort({ updatedAt: -1 }).limit(200).lean();
  return rows.map((row) => safeRow("purchase_service", row));
}

async function loadRequestDesk({ user }) {
  const access = user?.storePurchaseAccess;
  if (!access?.capabilitySet?.has(CAPABILITIES.READ)) {
    return { rows: [], sources: {}, unavailable: Object.values(SOURCE_LABELS), failed: [] };
  }
  const employee = await actorEmployee(user);
  const fulfilment = employee ? await resolveFulfilmentAccess(employee).catch(() => ({ allowed: false })) : { allowed: false };
  const loaders = [
    ["manufacturing", () => manufacturingRows()],
    ["material", () => materialRows(access)],
    ["item_addition", () => itemAdditionRows(access)],
    ["fulfilment", fulfilment.allowed ? () => fulfilmentRows() : null],
    ["purchase_service", fulfilment.allowed ? () => purchaseServiceRows(access) : null],
  ];
  const rows = [];
  const sources = {};
  const unavailable = [];
  const failed = [];
  await Promise.all(loaders.map(async ([key, loader]) => {
    if (!loader) {
      sources[key] = "unavailable";
      unavailable.push(SOURCE_LABELS[key]);
      return;
    }
    try {
      const result = await loader();
      if (result === null) {
        sources[key] = "unavailable";
        unavailable.push(SOURCE_LABELS[key]);
      } else {
        sources[key] = "ok";
        rows.push(...result);
      }
    } catch {
      sources[key] = "failed";
      failed.push(SOURCE_LABELS[key]);
    }
  }));
  return { rows, sources, unavailable: unavailable.sort(), failed: failed.sort() };
}

function withinDate(row, from, to) {
  if (!from && !to) return true;
  const value = row.date ? new Date(row.date).getTime() : NaN;
  if (!Number.isFinite(value)) return false;
  if (from && value < new Date(`${from}T00:00:00.000Z`).getTime()) return false;
  if (to && value > new Date(`${to}T23:59:59.999Z`).getTime()) return false;
  return true;
}

async function queryRequestDesk({ user, args = {} } = {}) {
  const loaded = await loadRequestDesk({ user });
  const operation = OPERATIONS.includes(args.operation) ? args.operation : "list";
  const type = TYPES.includes(args.type) ? args.type : "all";
  const stage = STAGES.includes(args.stage) ? args.stage : "all";
  const sort = SORTS.includes(args.sort) ? args.sort : "newest";
  const query = lower(args.query);
  let rows = loaded.rows.filter((row) => (
    (type === "all" || row.type === type)
    && (stage === "all" || row.stageGroup === stage)
    && withinDate(row, args.from, args.to)
    && (!query || [row.number, row.title, row.requestedBy, row.department, row.status, row.stage]
      .some((value) => lower(value).includes(query)))
  ));
  rows.sort((a, b) => {
    const delta = new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime();
    return sort === "oldest" ? delta : -delta;
  });
  const count = rows.length;
  const limit = Math.min(20, Math.max(1, Number.isInteger(args.limit) ? args.limit : 10));
  if (operation === "group_count") {
    const groups = new Map();
    for (const row of rows) groups.set(row.typeLabel, (groups.get(row.typeLabel) || 0) + 1);
    return { ok: true, operation, count, groups: [...groups].map(([label, value]) => ({ label, count: value })).sort((a, b) => b.count - a.count), ...loaded, rows: undefined };
  }
  const selectedRows = rows.slice(0, limit);
  const navigation = selectedRows.map((row) => ({
    type: row.type,
    recordId: row.recordId,
    label: row.number,
  }));
  const visibleRows = selectedRows.map(({ recordId: _recordId, ...row }) => row);
  return {
    ok: true,
    operation,
    count,
    rows: operation === "list" ? visibleRows : [],
    navigation,
    sources: loaded.sources,
    unavailable: loaded.unavailable,
    failed: loaded.failed,
  };
}

function renderRequestDesk({ data }) {
  const caveat = [
    data?.unavailable?.length ? `Unavailable to you: ${data.unavailable.join(", ")}.` : "",
    data?.failed?.length ? `Could not load: ${data.failed.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  if (!data?.ok) return "I couldn't read the Store Request Desk safely.";
  if (data.operation === "exists") return `${data.count ? "Yes" : "No"}. ${data.count} matching request${data.count === 1 ? "" : "s"} found.${caveat ? ` ${caveat}` : ""}`;
  if (data.operation === "count") return `${data.count} matching request${data.count === 1 ? "" : "s"} found.${caveat ? ` ${caveat}` : ""}`;
  if (data.operation === "group_count") return `${data.groups.length ? data.groups.map((row) => `${row.label}: ${row.count}`).join("; ") : "No matching requests were found."}${caveat ? `. ${caveat}` : ""}`;
  if (!data.rows?.length) return `No matching requests were found.${caveat ? ` ${caveat}` : ""}`;
  const answer = data.rows.map((row, index) => `${index + 1}. ${row.number} — ${row.typeLabel} — ${row.title} — ${row.stage} — ${row.date ? row.date.slice(0, 10) : "date not recorded"}`).join("\n");
  return `${answer}${caveat ? `\n${caveat}` : ""}`;
}

module.exports = {
  OPERATIONS, TYPES, STAGES, SORTS, SOURCE_LABELS,
  stageFor, safeRow, loadRequestDesk, queryRequestDesk, renderRequestDesk,
};
