// test/store-purchase/po-reconciliation.route.test.js
//
// PURCHASE RECONCILIATION — proves the GET /:id/reconciliation route resolves
// every join through the STORED identifiers (spendRequestId, spendLineId,
// purchaseOrderId, poItemId) against real documents, company-scoped, read-only.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Acc_BudgetCommitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, token, opts = {}) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) }, method: opts.method || "GET", ...(opts.body ? { body: JSON.stringify(opts.body) } : {}) })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor(company) {
  const n = ++seq;
  const email = `po${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "PO", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "PO" });
  return tokenFor({ id: String(employeeRef), email });
}

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

test("the route resolves request → commitment → PO line → posted voucher, all by stored id", async () => {
  const co = await company();
  const token = await actor(co);
  const spendLineId = new mongoose.Types.ObjectId();
  const poItemId = new mongoose.Types.ObjectId();
  const ledgerId = new mongoose.Types.ObjectId();

  const sr = await SpendRequest.create({
    companyId: co._id, requestNumber: `SR-${seq}`, requestType: "PRODUCT", status: "ordered", title: "Bolts", purpose: "For the line",
    items: [{ _id: spendLineId, name: "Bolt", whyNeeded: "production", quantity: 10, rate: 100, amount: 1000, unit: "pcs" }],
    totalAmount: 1000, grandTotal: 1180, gstPercent: 18, taxAmount: 180,
    requestedBy: new mongoose.Types.ObjectId(), requestedByName: "R",
  });

  await Acc_BudgetCommitment.create({
    companyId: co._id, spendRequestId: sr._id, amount: 1000, status: "released",
    allocations: [{ spendLineId, amount: 1000, releasedAmount: 1000, remainingAmount: 0, status: "released", ledgerId, ledgerName: "Repairs", name: "Bolt" }],
  });

  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${seq}`, status: "ISSUED",
    createdBy: new mongoose.Types.ObjectId(), vendorName: "Acme", spendRequestId: sr._id, spendRequestNumber: sr.requestNumber,
    subtotal: 1000, taxAmount: 180, totalAmount: 1180,
    items: [{ _id: poItemId, spendLineId, itemName: "Bolt", sku: "B1", unit: "pcs", quantity: 10, unitPrice: 100, totalPrice: 1000, gstRate: 18, gstAmount: 180, receivedQuantity: 10, pendingQuantity: 0 }],
    deliveries: [{ deliveryDate: new Date("2026-05-01"), quantityReceived: 10, invoiceNumber: "INV-9" }],
  });

  // A real GoodsReceipt + immutable inspection accepting all 10 — the accepted
  // evidence a three-way match needs, joined by the stored poItemId.
  const grlId = new mongoose.Types.ObjectId();
  await GoodsReceipt.create({
    companyId: co._id, receiptNumber: `GRN/${seq}`, purchaseOrderId: po._id, status: "RECORDED",
    lines: [{ _id: grlId, poItemId, poUnit: "pcs", receivedQuantity: 10 }],
  });
  await GoodsReceiptInspection.create({
    companyId: co._id, goodsReceiptId: (await GoodsReceipt.findOne({ purchaseOrderId: po._id }))._id, purchaseOrderId: po._id,
    lines: [{ goodsReceiptLineId: grlId, poItemId, unit: "pcs", receivedQuantity: 10, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }],
  });

  await Acc_Voucher.create({
    companyId: co._id, voucherType: "purchase", voucherTypeName: "Purchase", voucherNumber: `PV-${seq}`,
    status: "posted", referenceNumber: "INV-9", voucherDate: new Date("2026-05-02"), grandTotal: 1180,
    purchaseOrderId: po._id,
    inventoryEntries: [{ poItemId, spendLineId, stockItemName: "Bolt", unit: "pcs", quantity: 10, rate: 100, amount: 1000, taxAmount: 180 }],
  });

  const r = await call(`/api/cms/purchase-orders/${po._id}/reconciliation`, token);
  expect(r.status).toBe(200);
  const rec = r.body.reconciliation;

  // Joins resolved by stored id.
  expect(rec.source.request.number).toBe(sr.requestNumber);
  expect(rec.source.commitment.id).toBeTruthy();
  expect(rec.source.heads.map((h) => h.ledgerName)).toContain("Repairs");

  const line = rec.lines[0];
  expect(line.spendLine).toBe(String(spendLineId));
  expect(line.requestNumber).toBe(sr.requestNumber);
  expect(line.budgetHead.ledgerName).toBe("Repairs");
  expect(line.approvedLineAmount).toBe(1000);
  expect(line.committedAmount).toBe(1000);
  expect(line.orderedTotal).toBe(1180);
  expect(line.receivedQty).toBe(10);
  expect(line.acceptedQty).toBe(10);              // from the immutable inspection
  expect(line.billed.total).toBe(1180);
  expect(line.billed.posted).toBe(1180);          // voucher matched by poItemId
  expect(line.threeWayMatched).toBe(true);
  expect(line.statuses).toContain("Three-way matched");

  expect(rec.summary.budgetActual).toBe(1180);    // posted only
  expect(rec.receipts[0].invoiceNumber).toBe("INV-9");
  expect(rec.exceptions).toHaveLength(0);
});

test("a foreign-company purchase order is not found (company-scoped read)", async () => {
  const co = await company();
  const other = await company();
  const token = await actor(co);
  const po = await PurchaseOrder.create({
    companyId: other._id, poNumber: `PO/${seq}`, status: "ISSUED", vendorName: "X", createdBy: new mongoose.Types.ObjectId(),
    subtotal: 0, taxAmount: 0, totalAmount: 0, items: [],
  });
  const r = await call(`/api/cms/purchase-orders/${po._id}/reconciliation`, token);
  expect(r.status).toBe(404);
});

test("a legacy PO with no spend request reconciles honestly (no request, no crash)", async () => {
  const co = await company();
  const token = await actor(co);
  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${seq}`, status: "ISSUED", vendorName: "Y", createdBy: new mongoose.Types.ObjectId(),
    subtotal: 500, taxAmount: 0, totalAmount: 500,
    items: [{ _id: new mongoose.Types.ObjectId(), itemName: "Legacy widget", unit: "pcs", quantity: 5, unitPrice: 100, totalPrice: 500, receivedQuantity: 0, pendingQuantity: 5 }],
  });
  const r = await call(`/api/cms/purchase-orders/${po._id}/reconciliation`, token);
  expect(r.status).toBe(200);
  expect(r.body.reconciliation.source.request).toBeNull();
  expect(r.body.reconciliation.exceptions.some((e) => e.code === "NO_REQUEST")).toBe(true);
  expect(r.body.reconciliation.lines[0].statuses).toContain("Legacy evidence incomplete");
});

/* ── Chunk 8 — Store payment recording is RETIRED; Accounting owns payment truth ── */

test("Store payment recording is retired — POST /:id/payment and PATCH /:id/payment-status refuse and write nothing", async () => {
  const co = await company();
  const token = await actor(co);
  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED", vendorName: "Z", createdBy: new mongoose.Types.ObjectId(),
    subtotal: 500, taxAmount: 0, totalAmount: 500, paymentStatus: "PENDING", payments: [],
    items: [{ _id: new mongoose.Types.ObjectId(), itemName: "Widget", unit: "pcs", quantity: 5, unitPrice: 100, totalPrice: 500, receivedQuantity: 0, pendingQuantity: 5 }],
  });

  const pay = await call(`/api/cms/purchase-orders/${po._id}/payment`, token, { method: "POST", body: { amount: 100, paymentMethod: "CASH" } });
  expect(pay.status).toBe(410);
  expect(pay.body.reason).toBe("STORE_PAYMENT_RETIRED");
  expect(pay.body.accounting.href).toContain("purchase-vouchers");

  const st = await call(`/api/cms/purchase-orders/${po._id}/payment-status`, token, { method: "PATCH", body: { status: "COMPLETED" } });
  expect(st.status).toBe(410);
  expect(st.body.reason).toBe("STORE_PAYMENT_RETIRED");

  // No Store payment truth was created or changed.
  const after = await PurchaseOrder.findById(po._id).lean();
  expect(after.payments || []).toHaveLength(0);
  expect(after.paymentStatus).toBe("PENDING");
});

test("historical Store payments remain readable, clearly labelled legacy and read-only", async () => {
  const co = await company();
  const token = await actor(co);
  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED", vendorName: "Z", createdBy: new mongoose.Types.ObjectId(),
    subtotal: 500, taxAmount: 0, totalAmount: 500, paymentStatus: "PARTIAL",
    payments: [{ amount: 200, paymentMethod: "BANK_TRANSFER", referenceNumber: "OLD-1", date: new Date("2026-05-01") }],
    items: [{ _id: new mongoose.Types.ObjectId(), itemName: "Widget", unit: "pcs", quantity: 5, unitPrice: 100, totalPrice: 500, receivedQuantity: 0, pendingQuantity: 5 }],
  });
  const r = await call(`/api/cms/purchase-orders/${po._id}/payments`, token);
  expect(r.status).toBe(200);
  expect(r.body.legacy).toBe(true);
  expect(r.body.legacyNote).toMatch(/legacy store payment records/i);
  expect(r.body.payments).toHaveLength(1);
  expect(r.body.totalPaid).toBe(200);
});
