"use strict";
// services/storePurchase/dayBook.service.js
//
// THE STORE'S DAY BOOK (4 Oct 2026, owner): everything the Store did on a day
// (or a span of days) — purchase orders raised and what happened to them,
// goods receipts recorded, customer material received, raw items issued to
// orders (and against which PPC request), MRF issues to departments, manual
// stock adjustments, shelf movements and transfers, labels printed. One read,
// company-scoped the way every Store list is (tenantFilter, legacy read-through
// included), on the IST day window every other report uses.

const mongoose = require("mongoose");
const tenantContext = require("./tenantContext.service");
const { attachActorNames } = require("../actorNames");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

const str = (v) => (v == null ? "" : String(v).trim());
const combo = (c) => (Array.isArray(c) ? c.map(str).filter(Boolean).join(" · ") : str(c));
const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

async function dayBook(tenant, { start, end, from, to }) {
  const T = tenantContext.tenantFilter(tenant);
  const scoped = (extra) => ({ $and: [T, extra] });
  const win = (field) => ({ [field]: { $gte: start, $lt: end } });

  const [pos, actions, grns, lots, issuances, mrfIssues, txRows, movements, labels] = await Promise.all([
    PurchaseOrder.find(scoped(win("createdAt"))).select("poNumber vendorName status orderDate expectedDeliveryDate items subtotal taxAmount totalAmount sourceMrfNumber createdBy createdAt").sort({ createdAt: 1 }).lean(),
    SpActionHistory.find(scoped(win("at"))).select("entityType documentNumber action actorName at previousState resultingState reason").sort({ at: 1 }).lean(),
    GoodsReceipt.find(scoped({ ...win("receiptDate"), status: { $ne: "VOID" } })).select("receiptNumber sourceType poNumber supplierName customerMaterial invoiceNumber warehouseName locationCode receiptDate recordedBy lines status").sort({ receiptDate: 1 }).lean(),
    CustomerMaterialLot.find(scoped(win("receivedAt"))).select("customerLabel orderRef documentRef goodsReceiptNumber itemName variantCombination receiptQuantity receiptUnit baseQuantity baseUnit warehouseName locationCode receivedAt receivedBy").sort({ receivedAt: 1 }).lean(),
    StockIssuance.find(scoped(win("createdAt"))).sort({ createdAt: 1 }).lean(),
    MRF.aggregate([
      { $match: T },
      { $unwind: "$items" }, { $unwind: "$items.issueHistory" },
      { $match: { "items.issueHistory.recordedAt": { $gte: start, $lt: end } } },
      { $project: { _id: 0, mrfNumber: 1, requestedForName: 1, requestedForDept: 1, rawItemName: "$items.rawItemName", variantCombination: "$items.variantCombination", unit: "$items.unit", issuedQty: "$items.issueHistory.issuedQty", notes: "$items.issueHistory.notes", recordedAt: "$items.issueHistory.recordedAt", recordedBy: "$items.issueHistory.recordedBy" } },
      { $sort: { recordedAt: 1 } },
    ]),
    RawItem.aggregate([
      { $match: T },
      { $unwind: "$stockTransactions" },
      { $match: { "stockTransactions.createdAt": { $gte: start, $lt: end } } },
      { $project: { _id: 0, rawItemId: "$_id", name: 1, sku: 1, unit: 1, tx: "$stockTransactions" } },
      { $sort: { "tx.createdAt": 1 } },
    ]),
    LocationMovement.find(scoped(win("createdAt"))).select("itemId variantId type direction quantity baseUnit warehouseName locationCode locationName transferId source actorName note barcodeLabel createdAt").sort({ createdAt: 1 }).lean(),
    Barcode.find(scoped({ ...win("createdAt"), identityState: { $nin: ["VOIDED", "RESERVED"] } })).select("rawItemName rawItemSku variantCombination quantity unit purchaseOrderNumber vendorName goodsReceiptNumber identityState printBatchKey generatedBy customerMaterial createdAt").sort({ createdAt: 1 }).lean(),
  ]);

  await Promise.all([
    attachActorNames(pos, "createdBy").catch(() => null),
    attachActorNames(labels, "generatedBy").catch(() => null),
    attachActorNames(mrfIssues, "recordedBy").catch(() => null),
  ]);

  /* names for shelf movements and the request names for issues */
  const itemIds = [...new Set(movements.map((m) => String(m.itemId || "")).filter(Boolean))];
  const items = itemIds.length ? await RawItem.find({ _id: { $in: itemIds } }).select("name sku variants._id variants.combination").lean() : [];
  const itemById = new Map(items.map((i) => [String(i._id), i]));
  const moIds = [...new Set(issuances.map((i) => String(i.manufacturingOrder || "")).filter(Boolean))];
  const orders = moIds.length ? await CustomerRequest.find({ _id: { $in: moIds } }).select("requestId materialRequests.requestNumber materialRequests._id").lean() : [];
  const requestNumber = new Map();
  for (const o of orders) for (const r of o.materialRequests || []) requestNumber.set(String(r._id), r.requestNumber);

  const nameOf = (v) => (v && typeof v === "object" ? str(v.name) : str(v));

  const purchaseOrders = pos.map((p) => ({
    at: p.createdAt, poNumber: str(p.poNumber), vendorName: str(p.vendorName), status: str(p.status), orderDate: p.orderDate || null, expectedDeliveryDate: p.expectedDeliveryDate || null,
    lines: (p.items || []).length, quantity: round((p.items || []).reduce((n, i) => n + (Number(i.quantity) || 0), 0)),
    subtotal: round(p.subtotal), tax: round(p.taxAmount), total: round(p.totalAmount), sourceMrfNumber: str(p.sourceMrfNumber), by: str(p.createdByName) || nameOf(p.createdBy),
    items: (p.items || []).map((i) => ({ itemName: str(i.itemName), variant: str(i.variantName) || combo(i.variantCombination), quantity: round(i.quantity), unit: str(i.unit), unitPrice: round(i.unitPrice), totalPrice: round(i.totalPrice) })),
  }));
  const goodsReceipts = grns.map((g) => ({
    at: g.receiptDate || null, receiptNumber: str(g.receiptNumber), sourceType: str(g.sourceType), poNumber: str(g.poNumber),
    party: str(g.supplierName) || str(g.customerMaterial?.customerLabel), orderRef: str(g.customerMaterial?.orderRef), invoiceNumber: str(g.invoiceNumber), warehouseName: str(g.warehouseName), locationCode: str(g.locationCode),
    by: nameOf(g.recordedBy), lines: (g.lines || []).length, quantity: round((g.lines || []).reduce((n, l) => n + (Number(l.receivedQuantity) || 0), 0)),
    items: (g.lines || []).map((l) => ({ itemName: str(l.itemName), variant: combo(l.variantCombination), sku: str(l.sku), receivedQuantity: round(l.receivedQuantity), poUnit: str(l.poUnit), baseQuantity: round(l.baseQuantity), baseUnit: str(l.baseUnit) })),
  }));
  const customerMaterial = lots.map((l) => ({
    at: l.receivedAt, customer: str(l.customerLabel), orderRef: str(l.orderRef), documentRef: str(l.documentRef), receiptNumber: str(l.goodsReceiptNumber),
    itemName: str(l.itemName), variant: combo(l.variantCombination), quantity: round(l.receiptQuantity), unit: str(l.receiptUnit), baseQuantity: round(l.baseQuantity), baseUnit: str(l.baseUnit),
    warehouseName: str(l.warehouseName), locationCode: str(l.locationCode), by: nameOf(l.receivedBy),
  }));
  const issues = [];
  for (const iss of issuances) {
    for (const it of iss.items || []) {
      issues.push({
        at: iss.createdAt, direction: iss.direction, kind: iss.direction === "credit" ? "Return" : "Issue", ownership: str(iss.ownership) || "COMPANY_OWNED",
        moNumber: str(iss.moNumber), customerName: str(iss.customerName),
        request: iss.materialRequestId ? (requestNumber.get(String(iss.materialRequestId)) || "request") : "",
        rawItemName: str(it.rawItemName), rawItemSku: str(it.rawItemSku), variant: combo(it.variantCombination),
        issuedQty: round(it.issuedQty), issuedUnit: str(it.issuedUnit), nativeQty: round(it.nativeQty), nativeUnit: str(it.nativeUnit),
        warehouseName: str(it.warehouseName), locationCode: str(it.locationCode), by: str(iss.performedByName), reason: str(iss.reason), notes: str(it.notes),
      });
    }
  }
  const mrf = mrfIssues.map((m) => ({ at: m.recordedAt, mrfNumber: str(m.mrfNumber), requestedFor: str(m.requestedForName), department: str(m.requestedForDept), rawItemName: str(m.rawItemName), variant: combo(m.variantCombination), issuedQty: round(m.issuedQty), unit: str(m.unit), by: str(m.recordedByName), notes: str(m.notes) }));
  const AUTO = /^Purchase Order Delivery|^Issued for Work Order|MRF Issue —|^GRN /i;
  const stockTransactions = txRows.map((r) => ({
    at: r.tx.createdAt || null, rawItemName: str(r.name), rawItemSku: str(r.sku), type: str(r.tx.type), variant: combo(r.tx.variantCombination),
    quantity: round(r.tx.quantity), unit: str(r.unit), previousQuantity: round(r.tx.previousQuantity), newQuantity: round(r.tx.newQuantity),
    reason: str(r.tx.reason), notes: str(r.tx.notes), purchaseOrder: str(r.tx.purchaseOrder), supplier: str(r.tx.supplier),
    by: str(r.tx.performedByName), automatic: AUTO.test(str(r.tx.reason)) || Boolean(str(r.tx.purchaseOrder)),
  }));
  const shelfMoves = movements.map((m) => {
    const it = itemById.get(String(m.itemId || ""));
    const v = it && m.variantId ? (it.variants || []).find((x) => String(x._id) === String(m.variantId)) : null;
    return { at: m.createdAt, type: str(m.type), direction: str(m.direction), rawItemName: str(it?.name), rawItemSku: str(it?.sku), variant: combo(v?.combination), quantity: round(m.quantity), unit: str(m.baseUnit), warehouseName: str(m.warehouseName), location: str(m.locationCode) || str(m.locationName), label: str(m.barcodeLabel), source: [str(m.source?.kind), str(m.source?.reference || m.source?.orderRef)].filter(Boolean).join(" "), transfer: m.transferId ? String(m.transferId).slice(-6) : "", by: str(m.actorName), note: str(m.note) };
  });
  const labelsPrinted = labels.map((b) => ({ at: b.createdAt, rawItemName: str(b.rawItemName), rawItemSku: str(b.rawItemSku), variant: combo(b.variantCombination), quantity: round(b.quantity), unit: str(b.unit), poNumber: str(b.purchaseOrderNumber), vendorName: str(b.vendorName) || str(b.customerMaterial?.customerLabel), receiptNumber: str(b.goodsReceiptNumber), state: str(b.identityState) || "ACTIVATED", batch: str(b.printBatchKey).slice(-8), by: str(b.generatedByName) || nameOf(b.generatedBy) }));
  const actionsOut = actions.map((a) => ({ at: a.at, entityType: str(a.entityType), documentNumber: str(a.documentNumber), action: str(a.action), from: str(a.previousState), to: str(a.resultingState), by: str(a.actorName), reason: str(a.reason) }));

  return {
    window: { from, to },
    generatedAt: new Date(),
    figures: {
      purchaseOrders: purchaseOrders.length, purchaseValue: round(purchaseOrders.reduce((n, p) => n + p.total, 0)),
      goodsReceipts: goodsReceipts.length, receiptLines: goodsReceipts.reduce((n, g) => n + g.lines, 0),
      customerMaterialLots: customerMaterial.length,
      issues: issues.filter((i) => i.direction === "debit").length, returns: issues.filter((i) => i.direction === "credit").length, issuesAgainstRequests: issues.filter((i) => i.request).length,
      mrfIssues: mrf.length, manualAdjustments: stockTransactions.filter((t) => !t.automatic).length, shelfMoves: shelfMoves.length, labelsPrinted: labelsPrinted.length, actions: actionsOut.length,
    },
    purchaseOrders, actions: actionsOut, goodsReceipts, customerMaterial, issues, mrfIssues: mrf, stockTransactions, shelfMoves, labelsPrinted,
  };
}

module.exports = { dayBook };
