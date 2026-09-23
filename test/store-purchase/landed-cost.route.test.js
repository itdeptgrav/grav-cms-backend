// test/store-purchase/landed-cost.route.test.js
//
// Landed-cost V2 — the Accounting allocation API and its overlay on Store
// valuation. Eligibility, idempotency, revision, voucher-status exclusion, and
// that the overlay changes no stock/voucher/ledger record.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

// Accounting side — mock accountantAuth to read a test user header.
jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "auth required" });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const LandedCostAllocation = require("../../models/CMS_Models/Inventory/Valuation/LandedCostAllocation");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;
const ACCT = { id: new mongoose.Types.ObjectId().toString(), name: "Acct", role: "accountant" };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/landed-costs", require("../../routes/CMS_Routes/Inventory/valuation/landedCostRoutes"));
  app.use("/api/cms/inventory/valuation", require("../../routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes"));
  app.use("/api/cms/inventory/overview", require("../../routes/CMS_Routes/Inventory/overview/overview"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

// Accounting call (x-test-user).
const acct = (path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(ACCT) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

// Store call (employee JWT; single membership auto-resolves the tenant).
const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "Store", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const store = (path, token) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
async function storeActor(company) {
  const n = ++seq;
  const email = `st${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "St", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "St" });
  return tokenFor({ id: String(employeeRef), email });
}

const oid = () => new mongoose.Types.ObjectId();

// A company with a charge ledger.
async function company() {
  const n = ++seq;
  const c = await Acc_Company.create({ companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const g = await Acc_Group.create({ companyId: c._id, name: "Indirect Expenses", nature: "expense" });
  const freight = await Acc_Ledger.create({ companyId: c._id, name: `Inward Freight ${n}`, groupId: g._id, groupName: g.name, nature: "expense" });
  const gstLed = await Acc_Ledger.create({ companyId: c._id, name: `IGST Input ${n}`, groupId: g._id, groupName: g.name, nature: "expense" });
  return { c, freight, gstLed };
}

// A PO + two received RawItems (base values 1000 and 2000) + a posted purchase
// voucher carrying an eligible freight charge (₹300) and a GST charge (₹180).
async function scenario({ voucherStatus = "posted", linkPO = true, sameCompany = true, service = false, charge = 300 } = {}) {
  const { c, freight, gstLed } = await company();
  const poCompany = sameCompany ? c._id : (await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") }))._id;
  const po = await PurchaseOrder.create({
    companyId: poCompany, poNumber: `PO/${seq}`, vendorName: "V",
    items: [{ itemName: "A", quantity: 10, unitPrice: 100, totalPrice: 1000 }],
    subtotal: 3000, totalAmount: 3000, createdBy: oid(),
  });
  // Two received items priced at 100 (qty 10 → base 1000) and 200 (qty 10 → base 2000).
  const itemA = await RawItem.create({
    companyId: c._id, sku: `RAW-A-${seq}`, name: "Item A", unit: "PCS", quantity: 10,
    stockTransactions: [{ type: "ADD", quantity: 10, unitPrice: 100, purchaseOrderId: po._id, reason: "Purchase Order Delivery", createdAt: new Date("2026-08-01") }],
  });
  const itemB = await RawItem.create({
    companyId: c._id, sku: `RAW-B-${seq}`, name: "Item B", unit: "PCS", quantity: 10,
    stockTransactions: [{ type: "ADD", quantity: 10, unitPrice: 200, purchaseOrderId: po._id, reason: "Purchase Order Delivery", createdAt: new Date("2026-08-01") }],
  });
  const voucher = await Acc_Voucher.create({
    companyId: c._id, voucherType: "purchase", voucherNumber: `V/${seq}/${Math.random().toString(36).slice(2)}`,
    voucherDate: new Date("2026-08-10"), status: voucherStatus, grandTotal: 3480,
    purchaseOrderId: linkPO ? po._id : undefined, purchaseOrderNumber: linkPO ? po.poNumber : undefined,
    serviceOrderId: service ? oid() : undefined,
    ledgerEntries: [{ ledgerId: freight._id, ledgerName: freight.name, type: "Dr", amount: 3480 }],
    inventoryEntries: [
      { isCharge: true, stockItemName: "Inward freight", quantity: 0, chargeLedgerId: freight._id, chargeDescription: "Inward freight", amount: charge },
      { isCharge: true, stockItemName: "IGST Input Credit", quantity: 0, chargeLedgerId: gstLed._id, chargeDescription: "IGST Input Credit", amount: 180 },
    ],
  });
  const v = await Acc_Voucher.findById(voucher._id).lean();
  const freightLineId = String(v.inventoryEntries.find((e) => e.chargeDescription === "Inward freight")._id);
  const gstLineId = String(v.inventoryEntries.find((e) => e.chargeDescription === "IGST Input Credit")._id);
  const midA = String((await RawItem.findById(itemA._id).lean()).stockTransactions[0]._id);
  const midB = String((await RawItem.findById(itemB._id).lean()).stockTransactions[0]._id);
  return { c, po, voucher: v, itemA, itemB, midA, midB, freightLineId, gstLineId };
}

// ── Eligibility ──────────────────────────────────────────────────────────────
describe("eligibility", () => {
  // 6
  for (const st of ["draft", "pending_approval", "cancelled", "void"]) {
    test(`a ${st} voucher is ineligible`, async () => {
      const s = await scenario({ voucherStatus: st });
      const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe("NOT_POSTED");
    });
  }

  // 7
  test("an unlinked voucher is refused", async () => {
    const s = await scenario({ linkPO: false });
    const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("UNLINKED");
  });
  test("a cross-company voucher/PO is refused", async () => {
    const s = await scenario({ sameCompany: false });
    const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("CROSS_COMPANY");
  });

  // 8
  test("a service-order supplier bill cannot create inventory landed cost", async () => {
    const s = await scenario({ service: true });
    const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("SERVICE_BILL");
  });

  test("a posted linked voucher exposes charges and received lines", async () => {
    const s = await scenario();
    const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(r.status).toBe(200);
    expect(r.body.goodsReceived).toBe(true);
    expect(r.body.receivedLines).toHaveLength(2);
    const freight = r.body.charges.find((c) => c.description === "Inward freight");
    const gst = r.body.charges.find((c) => c.description.includes("IGST"));
    expect(freight.hint).toBe("eligible");
    expect(gst.hint).toBe("excluded"); // 9 — GST hinted excluded, never pre-selected
  });
});

// ── Allocation, idempotency, revision ────────────────────────────────────────
describe("allocation", () => {
  const allocate = (s, over = {}) =>
    acct("/api/cms/inventory/landed-costs", { method: "POST", body: {
      voucherId: String(s.voucher._id),
      charges: [{ chargeLineId: s.freightLineId }],
      targetMovementIds: [s.midA, s.midB],
      ...over,
    } });

  // 1
  test("₹300 across base ₹1,000 and ₹2,000 stores ₹100 and ₹200", async () => {
    const s = await scenario();
    const r = await allocate(s);
    expect([200, 201]).toContain(r.status);
    const tA = r.body.allocation.targets.find((t) => t.movementId === s.midA);
    const tB = r.body.allocation.targets.find((t) => t.movementId === s.midB);
    expect(tA.allocatedAmount).toBe(100);
    expect(tB.allocatedAmount).toBe(200);
    expect(tA.allocatedPerUnit).toBe(10); // 100 / 10
  });

  // 9
  test("selecting the GST charge line is refused", async () => {
    const s = await scenario();
    const r = await allocate(s, { charges: [{ chargeLineId: s.gstLineId }] });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("INELIGIBLE_CHARGE");
  });

  // 10
  test("saving the same allocation twice does not double it", async () => {
    const s = await scenario();
    expect([200, 201]).toContain((await allocate(s)).status);
    const second = await allocate(s);
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe("ALLOCATION_EXISTS");
    expect(await LandedCostAllocation.countDocuments({ sourceVoucherId: s.voucher._id, status: "active" })).toBe(1);
  });

  // 11
  test("revision requires a reason and preserves the prior distribution", async () => {
    const s = await scenario();
    await allocate(s);
    const noReason = await allocate(s, { revise: true });
    expect(noReason.status).toBe(400);
    expect(noReason.body.reason).toBe("REASON_REQUIRED");
    // A genuine revision: allocate only to A.
    const revised = await allocate(s, { revise: true, reason: "freight re-billed", targetMovementIds: [s.midA] });
    expect([200, 201]).toContain(revised.status);
    expect(revised.body.allocation.previousTotal).toBe(300);
    expect(Array.isArray(revised.body.allocation.previousDistribution)).toBe(true);
    expect(revised.body.allocation.reason).toBe("freight re-billed");
    expect(await LandedCostAllocation.countDocuments({ sourceVoucherId: s.voucher._id, status: "active" })).toBe(1);
    expect(await LandedCostAllocation.countDocuments({ sourceVoucherId: s.voucher._id, status: "superseded" })).toBe(1);
  });

  test("no goods received → allocation refused with a clear message", async () => {
    const s = await scenario();
    await RawItem.deleteMany({ _id: { $in: [s.itemA._id, s.itemB._id] } });
    const r = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(r.body.goodsReceived).toBe(false);
    expect(r.body.message).toMatch(/no goods/i);
  });
});

// ── Valuation overlay + immutability ─────────────────────────────────────────
describe("valuation overlay", () => {
  const allocate = (s) =>
    acct("/api/cms/inventory/landed-costs", { method: "POST", body: {
      voucherId: String(s.voucher._id), charges: [{ chargeLineId: s.freightLineId }], targetMovementIds: [s.midA, s.midB],
    } });

  // 13 + 20
  test("the base stock-transaction price and stock quantity are never changed", async () => {
    const s = await scenario();
    const beforeA = await RawItem.findById(s.itemA._id).lean();
    await allocate(s);
    const afterA = await RawItem.findById(s.itemA._id).lean();
    expect(afterA.stockTransactions[0].unitPrice).toBe(100); // base unchanged
    expect(afterA.quantity).toBe(beforeA.quantity); // qty unchanged
    expect(JSON.stringify(afterA.stockTransactions)).toBe(JSON.stringify(beforeA.stockTransactions));
    // ledger entries on the voucher untouched
    const v = await Acc_Voucher.findById(s.voucher._id).lean();
    expect(v.ledgerEntries[0].amount).toBe(3480);
  });

  // 14 + 15 (through the read path)
  test("valuation shows base + landed as the effective known value", async () => {
    const s = await scenario();
    await allocate(s);
    const token = await storeActor(s.c);
    const r = await store(`/api/cms/inventory/valuation/item/${s.itemA._id}`, token);
    expect(r.status).toBe(200);
    expect(r.body.valuation.baseStockValue).toBe(1000);
    expect(r.body.valuation.landedInStock).toBe(100); // ₹100 of freight
    expect(r.body.valuation.knownValue).toBe(1100);
    expect(r.body.valuation.avgCost).toBe(110); // 100 + 10/unit
  });

  // 19
  test("overview, report summary and item detail agree, all including landed cost", async () => {
    const s = await scenario();
    await allocate(s);
    const token = await storeActor(s.c);
    const [sum, ov] = await Promise.all([
      store("/api/cms/inventory/valuation/summary", token),
      store("/api/cms/inventory/overview", token),
    ]);
    // A(1000+100) + B(2000+200) = 3300
    expect(sum.body.summary.knownInventoryValue).toBe(3300);
    expect(sum.body.summary.landedInStock).toBe(300);
    expect(ov.body.stats.rawItems.knownInventoryValue).toBe(3300);
  });

  // 12
  test("cancelling the source voucher removes landed cost from valuation but keeps the record", async () => {
    const s = await scenario();
    await allocate(s);
    await Acc_Voucher.updateOne({ _id: s.voucher._id }, { $set: { status: "cancelled" } });
    const token = await storeActor(s.c);
    const r = await store(`/api/cms/inventory/valuation/item/${s.itemA._id}`, token);
    expect(r.body.valuation.knownValue).toBe(1000); // landed excluded
    expect(r.body.valuation.landedInStock).toBe(0);
    // history retained
    expect(await LandedCostAllocation.countDocuments({ sourceVoucherId: s.voucher._id })).toBe(1);
  });
});

// ── V2 correction — manual refusal, variant identity, hydration ─────────────
describe("V2 correction", () => {
  const allocate = (s, body = {}) =>
    acct("/api/cms/inventory/landed-costs", { method: "POST", body: {
      voucherId: String(s.voucher._id), targetMovementIds: [s.midA, s.midB], ...body,
    } });

  // manual charges refused
  test("a manual charge (manual:true) is refused", async () => {
    const s = await scenario();
    const r = await allocate(s, { charges: [{ manual: true, description: "Off-bill freight", amount: 500 }] });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("MANUAL_NOT_SUPPORTED");
  });
  test("an off-bill charge (no chargeLineId, bare amount) is refused", async () => {
    const s = await scenario();
    const r = await allocate(s, { charges: [{ amount: 500 }] });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("MANUAL_NOT_SUPPORTED");
  });

  // saved selection is exposed for hydration
  test("an existing allocation exposes its saved charge lines and targets", async () => {
    const s = await scenario();
    await allocate(s, { charges: [{ chargeLineId: s.freightLineId }], targetMovementIds: [s.midA] }); // only A
    const ws = await acct(`/api/cms/inventory/landed-costs/workspace/${s.voucher._id}`);
    expect(ws.body.existing).toBeTruthy();
    expect(ws.body.existing.charges.map((c) => String(c.chargeLineId))).toEqual([s.freightLineId]);
    expect(ws.body.existing.targets.map((t) => String(t.movementId))).toEqual([s.midA]); // NOT all receipts
  });

  // variant identity is resolved and duplicate-item receipts are distinguishable
  test("receipt lines resolve variant name/SKU and stay distinguishable", async () => {
    const { c, freight } = await company();
    const po = await PurchaseOrder.create({ companyId: c._id, poNumber: `PO/${++seq}`, vendorName: "V", items: [{ itemName: "T", quantity: 1, unitPrice: 1, totalPrice: 1 }], subtotal: 1, totalAmount: 1, createdBy: oid() });
    const vRed = oid(); const vBlue = oid();
    const item = await RawItem.create({
      companyId: c._id, sku: `RAW-V-${seq}`, name: "T-Shirt", unit: "PCS", quantity: 20,
      variants: [{ _id: vRed, sku: "TS-RED", combination: ["Red"], quantity: 10 }, { _id: vBlue, sku: "TS-BLUE", combination: ["Blue"], quantity: 10 }],
      stockTransactions: [
        { type: "VARIANT_ADD", quantity: 10, unitPrice: 100, purchaseOrderId: po._id, variantId: vRed, invoiceNumber: "INV-1", createdAt: new Date("2026-08-01") },
        { type: "VARIANT_ADD", quantity: 10, unitPrice: 200, purchaseOrderId: po._id, variantId: vBlue, invoiceNumber: "INV-2", createdAt: new Date("2026-08-02") },
      ],
    });
    const voucher = await Acc_Voucher.create({
      companyId: c._id, voucherType: "purchase", voucherNumber: `V/${++seq}`, voucherDate: new Date("2026-08-10"),
      status: "posted", grandTotal: 3000, purchaseOrderId: po._id, purchaseOrderNumber: po.poNumber,
      ledgerEntries: [{ ledgerId: freight._id, ledgerName: freight.name, type: "Dr", amount: 3000 }],
      inventoryEntries: [{ isCharge: true, stockItemName: "Inward freight", quantity: 0, chargeLedgerId: freight._id, chargeDescription: "Inward freight", amount: 300 }],
    });
    const ws = await acct(`/api/cms/inventory/landed-costs/workspace/${voucher._id}`);
    expect(ws.status).toBe(200);
    expect(ws.body.receivedLines).toHaveLength(2);
    const red = ws.body.receivedLines.find((r) => r.variantSku === "TS-RED");
    const blue = ws.body.receivedLines.find((r) => r.variantSku === "TS-BLUE");
    expect(red.variantName).toBe("Red");
    expect(blue.variantName).toBe("Blue");
    // distinguishable: different movement ids and different variant identity
    expect(red.movementId).not.toBe(blue.movementId);
  });
});
