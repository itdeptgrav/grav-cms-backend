// test/store-purchase/po-exceptions-register.route.test.js
//
// PURCHASE EXCEPTIONS REGISTER — proves GET /reports/exceptions aggregates the
// company's orders read-only, company-scoped, with CONSTANT query cost (no
// per-PO reconciliation round-trip), correct derived pagination, currency
// separation, and cancelled-voucher exclusion.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

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
afterEach(() => jest.restoreAllMocks());

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, token) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor(company) {
  const n = ++seq;
  const email = `reg${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "REG", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "REG" });
  return tokenFor({ id: String(employeeRef), email });
}
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

// Seed one PO with an optional linked request/commitment/voucher.
async function seedPO(co, { poNumber, status = "ISSUED", orderDate, received = 0, accepted = null, inspect = true, ordered = 10, rate = 100, gst = 18,
  withRequest = true, voucher = null, vendorName = "Acme", released = false,
  lineExpected = null, headerExpected = null, lineStatus } = {}) {
  const spendLineId = new mongoose.Types.ObjectId();
  const poItemId = new mongoose.Types.ObjectId();
  let spendRequestId = null;
  if (withRequest) {
    const sr = await SpendRequest.create({
      companyId: co._id, requestNumber: `SR-${++seq}`, requestType: "PRODUCT", status: "ordered", title: "T", purpose: "P",
      items: [{ _id: spendLineId, name: "Bolt", whyNeeded: "prod", quantity: ordered, rate, amount: ordered * rate, unit: "pcs" }],
      totalAmount: ordered * rate, requestedBy: new mongoose.Types.ObjectId(), requestedByName: "R",
    });
    spendRequestId = sr._id;
    await Acc_BudgetCommitment.create({
      companyId: co._id, spendRequestId: sr._id, amount: ordered * rate, status: released ? "released" : "committed",
      allocations: [{ spendLineId, amount: ordered * rate, releasedAmount: released ? ordered * rate : 0, remainingAmount: released ? 0 : ordered * rate, status: released ? "released" : "committed", ledgerId: new mongoose.Types.ObjectId(), ledgerName: "Repairs" }],
    });
  }
  const gstAmount = Math.round(ordered * rate * gst) / 100;
  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber, status, createdBy: new mongoose.Types.ObjectId(), vendorName,
    orderDate: orderDate || new Date("2026-05-01"), ...(headerExpected ? { expectedDeliveryDate: headerExpected } : {}),
    spendRequestId, spendRequestNumber: withRequest ? `SR-${seq}` : undefined,
    subtotal: ordered * rate, taxAmount: gstAmount, totalAmount: ordered * rate + gstAmount,
    items: [{ _id: poItemId, spendLineId: withRequest ? spendLineId : undefined, itemName: "Bolt", sku: "B1", unit: "pcs",
      quantity: ordered, unitPrice: rate, totalPrice: ordered * rate, gstRate: gst, gstAmount,
      ...(lineExpected ? { expectedDeliveryDate: lineExpected } : {}), ...(lineStatus ? { status: lineStatus } : {}),
      receivedQuantity: received, pendingQuantity: Math.max(0, ordered - received) }],
  });
  // Receipt + immutable inspection for what was received, so a fully-received line
  // has ACCEPTED evidence (and is not stuck "awaiting inspection").
  if (received > 0 && inspect) {
    const acc = accepted == null ? received : accepted;
    const grlId = new mongoose.Types.ObjectId();
    const grn = await GoodsReceipt.create({
      companyId: co._id, receiptNumber: `GRN-${++seq}`, purchaseOrderId: po._id, status: "RECORDED",
      lines: [{ _id: grlId, poItemId, poUnit: "pcs", receivedQuantity: received }],
    });
    await GoodsReceiptInspection.create({
      companyId: co._id, goodsReceiptId: grn._id, purchaseOrderId: po._id,
      lines: [{ goodsReceiptLineId: grlId, poItemId, unit: "pcs", receivedQuantity: received, acceptedQuantity: acc, quarantinedQuantity: 0, rejectedQuantity: received - acc }],
    });
  }
  if (voucher) {
    await Acc_Voucher.create({
      companyId: co._id, voucherType: "purchase", voucherTypeName: "Purchase", voucherNumber: `PV-${++seq}`,
      status: voucher.status, referenceNumber: voucher.ref || "INV", voucherDate: voucher.date || new Date("2026-05-03"),
      grandTotal: voucher.total || ordered * rate + gstAmount, purchaseOrderId: po._id,
      inventoryEntries: [{ poItemId, spendLineId, stockItemName: "Bolt", unit: "pcs", quantity: voucher.qty ?? ordered, rate: voucher.rate ?? rate, amount: (voucher.qty ?? ordered) * (voucher.rate ?? rate), taxAmount: voucher.tax ?? gstAmount }],
    });
  }
  return po;
}

test("aggregates the company's orders into a severity-ordered, paginated register", async () => {
  const co = await company();
  const token = await actor(co);
  // A clean, matched order (excluded from the default unresolved view).
  await seedPO(co, { poNumber: "PO/CLEAN", status: "COMPLETED", received: 10, released: true, voucher: { status: "posted" } });
  // Partly received → LOW "still to receive".
  await seedPO(co, { poNumber: "PO/PEND", status: "PARTIALLY_RECEIVED", received: 4 });
  // Price variance → HIGH.
  await seedPO(co, { poNumber: "PO/PRICE", status: "COMPLETED", received: 10, voucher: { status: "posted", rate: 130 } });

  const r = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  expect(r.status).toBe(200);
  const reg = r.body.register;
  // Clean order excluded by default (unresolved-only); two need attention.
  expect(reg.pagination.total).toBe(2);
  expect(reg.summary.ordersNeedingAttention).toBe(2);
  // HIGH (price) sorts before LOW (pending).
  expect(reg.rows.map((x) => x.poNumber)).toEqual(["PO/PRICE", "PO/PEND"]);
  expect(reg.rows[0].exceptions.some((e) => e.group === "PRICE_VARIANCE")).toBe(true);
  expect(reg.rows[0].reconciliationHref).toContain("?tab=reconciliation");
  // scope=all includes the clean order too.
  const all = await call(`/api/cms/purchase-orders/reports/exceptions?scope=all`, token);
  expect(all.body.register.pagination.total).toBe(3);
});

test("pagination total reflects the full DERIVED result, not the page", async () => {
  const co = await company();
  const token = await actor(co);
  for (let i = 0; i < 5; i++) await seedPO(co, { poNumber: `PO/M${i}`, status: "PARTIALLY_RECEIVED", received: 3 });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions?pageSize=2&page=1`, token);
  expect(r.body.register.pagination.total).toBe(5);
  expect(r.body.register.pagination.totalPages).toBe(3);
  expect(r.body.register.rows).toHaveLength(2);
  const p3 = await call(`/api/cms/purchase-orders/reports/exceptions?pageSize=2&page=3`, token);
  expect(p3.body.register.rows).toHaveLength(1);
});

test("query cost is CONSTANT — no reconciliation round-trip per order (no N+1)", async () => {
  const co = await company();
  const token = await actor(co);
  for (let i = 0; i < 4; i++) await seedPO(co, { poNumber: `PO/N${i}`, status: "PARTIALLY_RECEIVED", received: 2, voucher: { status: "posted", rate: 130 } });

  const poFind = jest.spyOn(PurchaseOrder, "find");
  const srFind = jest.spyOn(SpendRequest, "find");
  const bcFind = jest.spyOn(Acc_BudgetCommitment, "find");
  const vFind = jest.spyOn(Acc_Voucher, "find");

  const r = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  expect(r.status).toBe(200);
  expect(r.body.register.pagination.total).toBe(4);

  // One batched query each, regardless of the four orders on the page.
  expect(poFind).toHaveBeenCalledTimes(1);
  expect(srFind).toHaveBeenCalledTimes(1);
  expect(bcFind).toHaveBeenCalledTimes(1);
  expect(vFind).toHaveBeenCalledTimes(1);
});

test("currency comes from the company base currency with provenance — not invented per order", async () => {
  const co = await company();   // Acc_Company defaults baseCurrency "INR", currencySymbol "₹"
  const token = await actor(co);
  await seedPO(co, { poNumber: "PO/CUR", status: "COMPLETED", received: 10, voucher: { status: "posted", rate: 130 } });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  const reg = r.body.register;
  expect(reg.currency).toBe("INR");
  expect(reg.currencyBasis).toBe("company_base_currency");
  expect(reg.summary.aggregateAvailable).toBe(true);
  expect(reg.summary.total.currency).toBe("INR");
});

test("with NO recorded company base currency, no currency is invented and no cross-order total is produced", async () => {
  const co = await company();
  await Acc_Company.updateOne({ _id: co._id }, { $unset: { baseCurrency: "" } });   // company records none
  const token = await actor(co);
  await seedPO(co, { poNumber: "PO/NOCUR", status: "COMPLETED", received: 10, voucher: { status: "posted", rate: 130 } });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  const reg = r.body.register;
  expect(reg.currency).toBeNull();
  expect(reg.currencyBasis).toBe("not_recorded");
  expect(reg.summary.total).toBeNull();
  expect(reg.summary.aggregateAvailable).toBe(false);
  expect(reg.limitations.some((l) => /currency is recorded|currency is not recorded|no company base currency/i.test(l))).toBe(true);
});

test("coverage is honest above and below the scan cap", async () => {
  const co = await company();
  const token = await actor(co);
  for (let i = 0; i < 3; i++) await seedPO(co, { poNumber: `PO/C${i}`, status: "PARTIALLY_RECEIVED", received: 2 });

  // Below the cap → complete coverage.
  const full = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  expect(full.body.register.coverage.coverageComplete).toBe(true);
  expect(full.body.register.coverage.storedMatchCount).toBe(3);
  expect(full.body.register.coverage.inspectedCount).toBe(3);

  // Force the cap below the population → incomplete, disclosed prominently.
  process.env.PO_REGISTER_SCAN_CAP = "2";
  try {
    const capped = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
    const cov = capped.body.register.coverage;
    expect(cov.coverageComplete).toBe(false);
    expect(cov.storedMatchCount).toBe(3);
    expect(cov.inspectedCount).toBe(2);
    expect(capped.body.register.pagination.scope).toBe("inspectedResultSet");
    expect(capped.body.register.limitations.some((l) => /most recent matching orders/i.test(l))).toBe(true);
  } finally {
    delete process.env.PO_REGISTER_SCAN_CAP;
  }
});

test("an outstanding line past its stored expected date is 'Past expected delivery', not undated", async () => {
  const co = await company();
  const token = await actor(co);
  await seedPO(co, { poNumber: "PO/LATE", status: "PARTIALLY_RECEIVED", received: 2, lineExpected: new Date("2000-01-01") });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions?group=PAST_EXPECTED_DELIVERY`, token);
  const row = r.body.register.rows.find((x) => x.poNumber === "PO/LATE");
  expect(row).toBeTruthy();
  const ex = row.exceptions.find((e) => e.group === "PAST_EXPECTED_DELIVERY");
  expect(ex.dateSource).toBe("line");
  expect(ex.expectedDate).toContain("2000-01-01");
});

test("a cancelled line is not shown as outstanding, but its live bill still surfaces", async () => {
  const co = await company();
  const token = await actor(co);
  // Cancelled order, part-received, with a posted bill at a variant rate.
  await seedPO(co, { poNumber: "PO/CANC", status: "CANCELLED", lineStatus: "CANCELLED", received: 4,
    lineExpected: new Date("2000-01-01"), voucher: { status: "posted", rate: 130, qty: 4 } });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions?scope=all`, token);
  const row = r.body.register.rows.find((x) => x.poNumber === "PO/CANC");
  expect(row).toBeTruthy();
  expect(row.exceptions.some((e) => e.group === "STILL_TO_RECEIVE" || e.group === "PAST_EXPECTED_DELIVERY")).toBe(false);
  expect(row.totals.billedLive).toBeGreaterThan(0);   // financial history preserved
});

test("a cancelled voucher is history — it raises no live financial exception", async () => {
  const co = await company();
  const token = await actor(co);
  // Received in full, and the only bill is cancelled → "received, bill not linked",
  // never a price variance from the void bill.
  await seedPO(co, { poNumber: "PO/VOID", status: "COMPLETED", received: 10, voucher: { status: "cancelled", rate: 130 } });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions`, token);
  const row = r.body.register.rows.find((x) => x.poNumber === "PO/VOID");
  expect(row).toBeTruthy();
  expect(row.exceptions.some((e) => e.group === "PRICE_VARIANCE")).toBe(false);
  expect(row.exceptions.some((e) => e.group === "RECEIVED_NO_BILL")).toBe(true);
  expect(row.totals.billedLive).toBe(0);
});

test("the register is company-scoped — another company's orders never appear", async () => {
  const co = await company();
  const other = await company();
  const token = await actor(co);
  await seedPO(other, { poNumber: "PO/OTHER", status: "PARTIALLY_RECEIVED", received: 1 });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions?scope=all`, token);
  expect(r.body.register.rows.every((x) => x.poNumber !== "PO/OTHER")).toBe(true);
});

test("a group filter narrows to orders carrying that exception group", async () => {
  const co = await company();
  const token = await actor(co);
  await seedPO(co, { poNumber: "PO/PEND2", status: "PARTIALLY_RECEIVED", received: 3 });
  await seedPO(co, { poNumber: "PO/PRICE2", status: "COMPLETED", received: 10, voucher: { status: "posted", rate: 130 } });
  const r = await call(`/api/cms/purchase-orders/reports/exceptions?group=PRICE_VARIANCE`, token);
  expect(r.body.register.rows.map((x) => x.poNumber)).toEqual(["PO/PRICE2"]);
});
