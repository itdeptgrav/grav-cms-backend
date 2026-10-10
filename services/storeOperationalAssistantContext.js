"use strict";

const PurchaseOrder = require("../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SupplierOffer = require("../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const ServiceOrder = require("../models/CMS_Models/Inventory/Operations/ServiceOrder");
const StockCount = require("../models/CMS_Models/Inventory/Operations/StockCount");
const StockReservation = require("../models/CMS_Models/Inventory/Operations/StockReservation");
const MRF = require("../models/CMS_Models/Inventory/Operations/MRF");
const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
const Acc_BudgetCommitment = require("../models/Accountant_model/Acc_BudgetCommitment");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const { Acc_Company } = require("../models/Accountant_model/Acc_MasterModels");
const GoodsReceipt = require("../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptDisposition = require("../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const tenantContext = require("./storePurchase/tenantContext.service");
const exceptions = require("./storePurchase/poExceptionsRegister.service");
const valuationRoutes = require("../routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes");

const VIEWS = Object.freeze(["operations", "inventory_valuation", "purchase_exceptions"]);
const OPERATIONS = Object.freeze(["summary", "list"]);

function access(user) {
  const ctx = user?.storePurchaseAccess;
  return ctx?.companyId ? ctx : null;
}

async function operationsSummary(ctx) {
  const co = { companyId: ctx.companyId };
  const legacy = tenantContext.tenantFilter(ctx);
  const pairs = await Promise.all([
    MRF.countDocuments({ ...legacy, status: "APPROVED", storeReviewedAt: null }),
    SupplierOffer.countDocuments({ ...co, status: "ACTIVE" }),
    PurchaseOrder.countDocuments({ ...co, status: "DRAFT" }),
    PurchaseOrder.countDocuments({ ...co, status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } }),
    StockReservation.countDocuments({ ...co, active: true, backorderedQty: { $gt: 0 } }),
    StockReservation.countDocuments({ ...co, active: true, status: "RESERVED" }),
    StockReservation.countDocuments({ ...co, active: true, status: "PARTIALLY_ISSUED" }),
    ServiceOrder.countDocuments({ ...co, status: "COMPLETION_REPORTED" }),
    StockCount.countDocuments({ ...co, status: { $in: StockCount.OPEN_STATUSES } }),
  ]);
  const keys = [
    "requests to classify", "active supplier quotations", "purchase orders to issue",
    "purchase orders to receive", "reservation shortages", "reservations ready to pick",
    "partly issued reservations", "services awaiting acceptance", "open stock counts",
  ];
  return keys.map((label, index) => ({ label, count: pairs[index] }));
}

const mapBy = (rows, key) => {
  const out = new Map();
  for (const row of rows) {
    const value = String(row[key] || "");
    if (!out.has(value)) out.set(value, []);
    out.get(value).push(row);
  }
  return out;
};

async function purchaseExceptions(ctx, { operation, limit }) {
  const scope = tenantContext.tenantFilter(ctx);
  const cap = Math.max(1, parseInt(process.env.PO_REGISTER_SCAN_CAP, 10) || 1000);
  const [storedMatchCount, purchaseOrders] = await Promise.all([
    PurchaseOrder.countDocuments(scope),
    PurchaseOrder.find(scope).sort({ orderDate: -1, _id: -1 }).limit(cap).lean(),
  ]);
  const requestIds = [...new Set(purchaseOrders.map((row) => row.spendRequestId).filter(Boolean).map(String))];
  const poIds = purchaseOrders.map((row) => row._id);
  const [spend, commitments, vouchers, receipts, inspections, dispositions, company] = await Promise.all([
    requestIds.length ? SpendRequest.find({ _id: { $in: requestIds } }).lean() : [],
    requestIds.length ? Acc_BudgetCommitment.find({ spendRequestId: { $in: requestIds } }).lean() : [],
    poIds.length ? Acc_Voucher.find({ voucherType: "purchase", purchaseOrderId: { $in: poIds } })
      .select("voucherNumber status referenceNumber voucherDate grandTotal purchaseOrderId inventoryEntries").lean() : [],
    poIds.length ? GoodsReceipt.find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds } })
      .select("receiptNumber status purchaseOrderId lines").lean() : [],
    poIds.length ? GoodsReceiptInspection.find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds } })
      .select("goodsReceiptId purchaseOrderId lines").lean() : [],
    poIds.length ? GoodsReceiptDisposition.find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds } })
      .select("goodsReceiptId purchaseOrderId poItemId dispositionType quantity").lean() : [],
    Acc_Company.findById(ctx.companyId).select("baseCurrency currencySymbol").lean(),
  ]);
  const spendById = new Map(spend.map((row) => [String(row._id), row]));
  const commitmentByRequest = new Map(commitments.map((row) => [String(row.spendRequestId), row]));
  const all = exceptions.buildExceptionsRegister({
    purchaseOrders,
    spendRequestsById: spendById,
    commitmentsByRequestId: commitmentByRequest,
    vouchersByPoId: mapBy(vouchers, "purchaseOrderId"),
    goodsReceiptsByPoId: mapBy(receipts, "purchaseOrderId"),
    inspectionsByPoId: mapBy(inspections, "purchaseOrderId"),
    dispositionsByPoId: mapBy(dispositions, "purchaseOrderId"),
    asOf: new Date(),
  });
  const rows = exceptions.sortRows(exceptions.filterRows(all, { unresolvedOnly: true }));
  const currencyKnown = Boolean(company?.baseCurrency);
  return {
    operation,
    storedMatchCount,
    inspectedCount: purchaseOrders.length,
    coverageComplete: purchaseOrders.length >= storedMatchCount,
    summary: exceptions.summarize(rows, {
      currency: company?.baseCurrency || null,
      currencyBasis: currencyKnown ? "company_base_currency" : "not_recorded",
      currencySymbol: company?.currencySymbol || null,
    }),
    rows: operation === "list" ? rows.slice(0, limit) : [],
  };
}

async function inventoryValuation(ctx, { operation, limit, query }) {
  const filter = tenantContext.tenantFilter(ctx);
  const { summary, valued } = await valuationRoutes.summarizeCompany(filter, ctx.companyId);
  const q = String(query || "").trim().toLowerCase();
  const rows = valued.filter((row) => !q || [row.name, row.sku].some((value) => String(value || "").toLowerCase().includes(q)))
    .sort((a, b) => Number(b.knownValue || 0) - Number(a.knownValue || 0)).slice(0, limit)
    .map((row) => ({
      name: row.name, sku: row.sku, unit: row.unit, companyOnHand: row.companyOnHand,
      customerOnHand: row.customerOnHand, knownValue: row.knownValue,
      averageUnitCost: row.averageUnitCost, fullyValued: row.fullyValued,
      reconciled: row.reconciled, attention: row.attention,
    }));
  return { operation, summary, rows: operation === "list" ? rows : [] };
}

async function queryStoreOperational({ user, args = {} } = {}) {
  const ctx = access(user);
  if (!ctx) return { ok: false, reason: "Store & Purchase company access could not be verified." };
  const view = VIEWS.includes(args.view) ? args.view : null;
  const operation = OPERATIONS.includes(args.operation) ? args.operation : null;
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 5));
  if (!view || !operation) return { ok: false, reason: "That Store workspace query is outside the catalogue." };
  if (view === "operations") return { ok: true, view, operation, rows: await operationsSummary(ctx) };
  if (view === "inventory_valuation") return { ok: true, view, ...(await inventoryValuation(ctx, { operation, limit, query: args.query })) };
  return { ok: true, view, ...(await purchaseExceptions(ctx, { operation, limit })) };
}

function renderStoreOperational({ data } = {}) {
  if (!data?.ok) return data?.reason || "I couldn't verify that Store workspace query.";
  if (data.view === "operations") return `Store operations: ${data.rows.map((row) => `${row.label}: ${row.count}`).join("; ")}.`;
  if (data.view === "inventory_valuation") {
    const summary = Object.entries(data.summary || {}).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => `${key}: ${value}`).join("; ");
    const rows = data.rows?.length ? ` Items: ${data.rows.map((row) => `${row.name || row.sku}: value ${row.knownValue ?? "not fully known"}, company stock ${row.companyOnHand ?? "not recorded"} ${row.unit || ""}`).join(" | ")}.` : "";
    return `Inventory valuation summary: ${summary}.${rows}`;
  }
  const s = data.summary || {};
  const coverage = data.coverageComplete ? "all matching orders inspected" : `${data.inspectedCount} of ${data.storedMatchCount} matching orders inspected`;
  const rows = data.rows?.length ? ` Highest-priority orders: ${data.rows.map((row) => `${row.poNumber}: ${row.exceptions.map((item) => item.label).join(", ")}`).join(" | ")}.` : "";
  return `Purchase exceptions: orders needing attention ${s.ordersNeedingAttention || 0}; past expected delivery ${s.pastExpectedDelivery || 0}; still to receive ${s.stillToReceive || 0}; awaiting inspection ${s.awaitingInspection || 0}; quarantine unresolved ${s.quarantineUnresolved || 0}; financial variances ${s.financialVariances || 0}. Coverage: ${coverage}.${rows}`;
}

module.exports = { VIEWS, OPERATIONS, operationsSummary, queryStoreOperational, renderStoreOperational };
