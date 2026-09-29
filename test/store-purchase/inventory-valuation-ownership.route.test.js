// test/store-purchase/inventory-valuation-ownership.route.test.js
//
// OWNERSHIP-AWARE VALUATION — customer-supplied stock is physically held but is
// the customer's property. It must be EXCLUDED from company inventory value and
// company-owned on-hand, reported separately as customer-owned on-hand, never
// valued, never landed-costed, and never drag the company figure into
// MISSING_INBOUND_PRICE / indeterminate. RawItem.quantity stays the honest
// PHYSICAL total; reconciliation replays every physical movement; company value
// replays only company-owned movements.
//
// The engine scenarios are pure and deterministic; the route scenarios prove the
// two provenance paths end to end — the explicit `ownership` marker on new
// movements, and the CustomerMaterialLot.movements[].stockTransactionId link that
// recovers historical customer movements with no backfill.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { valueItem, summarizeValued } = require("../../services/inventoryValuation.service");

let server, base, seq = 0;
let clock = 1_700_000_000_000;
const oid = () => new mongoose.Types.ObjectId();
const at = () => new Date(clock++);

// Movement factories with explicit ids so a customer set can name them.
const companyReceipt = (qty, price, id = oid()) => ({ _id: id, type: "ADD", quantity: qty, unitPrice: price, purchaseOrderId: oid(), createdAt: at() });
const customerIn = (qty, id = oid(), extra = {}) => ({ _id: id, type: "ADD", quantity: qty, createdAt: at(), ...extra }); // unpriced
const customerOut = (qty, id = oid(), extra = {}) => ({ _id: id, type: "REDUCE", quantity: qty, createdAt: at(), ...extra });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/valuation", require("../../routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(oid()), role: "store_manager", employeeId: `VO${seq}`, name: "VO", email: "vo@test.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
async function actor(co) {
  const n = ++seq; const email = `vo${n}@test.example`; const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "VO", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "VO" });
  return tokenFor({ id: String(employeeRef), email });
}
const mkItem = (co, over = {}) => RawItem.create({
  companyId: co._id, sku: over.sku || `RAW-${++seq}`, name: over.name || `Item ${seq}`,
  unit: over.unit || "m", category: "Fabric",
  quantity: over.quantity != null ? over.quantity : 0,
  variants: over.variants || [], stockTransactions: over.stockTransactions || [],
});

/* ══ PURE ENGINE — THE SEPARATION LOGIC ════════════════════════════════════ */

describe("valueItem separates company and customer ownership", () => {
  test("a mixed receipt values only company stock; customer stock is on-hand but never valued", () => {
    const c1 = oid(); const cust1 = oid();
    const item = {
      _id: oid(), unit: "m", quantity: 15,
      stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1)],
    };
    const v = valueItem(item, { customerOwnedTxIds: new Set([String(cust1)]) });

    expect(v.physicalOnHand).toBe(15);
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.customerOwnedOnHand).toBe(5);
    // Company value is 10 × 20 only — the customer's 5 are excluded, never ₹0.
    expect(v.knownValue).toBe(200);
    expect(v.avgCost).toBe(20);
    // Customer stock does NOT make the company figure incomplete/indeterminate…
    expect(v.indeterminate).toBe(false);
    expect(v.valueState).toBe("complete");
    expect(v.unvaluedQty).toBe(0);
    // …and never raises MISSING_INBOUND_PRICE for being unpriced.
    expect(v.reasons).not.toContain("MISSING_INBOUND_PRICE");
    // Physical reconciles against the stored total (company + customer).
    expect(v.reconciled).toBe(true);
    expect(v.hasCustomerOwnedStock).toBe(true);
  });

  test("WITHOUT the split, the same customer stock WOULD corrupt the company figure (proves the fix matters)", () => {
    const c1 = oid(); const cust1 = oid();
    const item = { _id: oid(), unit: "m", quantity: 15, stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1)] };
    // No ownership info at all → the old behaviour: the unpriced customer inbound
    // is treated as company stock and drags the item into partly-unvalued.
    const v = valueItem(item, {});
    expect(v.unvaluedQty).toBe(5);
    expect(v.valueState).toBe("partly_unvalued");
    expect(v.reasons).toContain("MISSING_INBOUND_PRICE");
  });

  test("a customer ISSUE reduces customer on-hand and never touches company value or makes it indeterminate", () => {
    const c1 = oid(); const cust1 = oid(); const cust2 = oid();
    const item = {
      _id: oid(), unit: "m", quantity: 12,
      stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1), customerOut(3, cust2)],
    };
    const v = valueItem(item, { customerOwnedTxIds: new Set([String(cust1), String(cust2)]) });
    expect(v.physicalOnHand).toBe(12);
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.customerOwnedOnHand).toBe(2); // 5 received − 3 issued
    // The customer outbound is excluded, so the company replay never sees an
    // "outbound while unvalued stock is on hand" and never goes indeterminate.
    expect(v.indeterminate).toBe(false);
    expect(v.knownValue).toBe(200);
  });

  test("a customer RETURN reduces customer on-hand, company value unchanged", () => {
    const c1 = oid(); const cust1 = oid(); const cust2 = oid();
    const item = {
      _id: oid(), unit: "m", quantity: 12,
      stockTransactions: [companyReceipt(10, 20, c1), customerIn(4, cust1), customerOut(2, cust2)],
    };
    const v = valueItem(item, { customerOwnedTxIds: new Set([String(cust1), String(cust2)]) });
    expect(v.customerOwnedOnHand).toBe(2);
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.knownValue).toBe(200);
    expect(v.physicalOnHand).toBe(12);
  });

  test("landed cost is NEVER applied to customer stock, only to company receipts", () => {
    const c1 = oid(); const cust1 = oid();
    const item = { _id: oid(), unit: "m", quantity: 15, stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1)] };
    // A landed allocation naming the CUSTOMER movement must not value it.
    const onCustomer = valueItem(item, {
      customerOwnedTxIds: new Set([String(cust1)]),
      landedByMovement: new Map([[String(cust1), { perUnit: 7, sources: [] }]]),
    });
    expect(onCustomer.knownValue).toBe(200); // unchanged — no landed on customer stock
    expect(onCustomer.reasons).toContain("LANDED_WITHOUT_BASE");
    expect(onCustomer.hasLandedCost).toBe(false);
    // The same allocation on the COMPANY receipt DOES apply.
    const onCompany = valueItem(item, {
      customerOwnedTxIds: new Set([String(cust1)]),
      landedByMovement: new Map([[String(c1), { perUnit: 5, sources: [] }]]),
    });
    expect(onCompany.knownValue).toBe(250); // 10 × (20 + 5)
    expect(onCompany.hasLandedCost).toBe(true);
  });

  test("the explicit ownership:'CUSTOMER' marker excludes a movement even without the lot set", () => {
    const c1 = oid(); const cust1 = oid();
    const item = {
      _id: oid(), unit: "m", quantity: 8,
      stockTransactions: [companyReceipt(6, 10, c1), customerIn(2, cust1, { ownership: "CUSTOMER" })],
    };
    const v = valueItem(item, {}); // no customerOwnedTxIds — relies on the marker
    expect(v.companyOwnedOnHand).toBe(6);
    expect(v.customerOwnedOnHand).toBe(2);
    expect(v.knownValue).toBe(60);
    expect(v.indeterminate).toBe(false);
  });

  test("with no customer stock at all, behaviour is exactly as before (backward compatible)", () => {
    const item = { _id: oid(), unit: "m", quantity: 10, stockTransactions: [companyReceipt(10, 20)] };
    const v = valueItem(item, {});
    expect(v.knownValue).toBe(200);
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.customerOwnedOnHand).toBe(0);
    expect(v.physicalOnHand).toBe(10);
    expect(v.hasCustomerOwnedStock).toBe(false);
  });

  test("the summary exposes physical, company-owned and customer-owned on-hand, and a customer-free company value", () => {
    const c1 = oid(); const cust1 = oid();
    const mixed = valueItem(
      { _id: oid(), unit: "m", quantity: 15, stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1)] },
      { customerOwnedTxIds: new Set([String(cust1)]) },
    );
    const plain = valueItem({ _id: oid(), unit: "m", quantity: 4, stockTransactions: [companyReceipt(4, 50)] }, {});
    const s = summarizeValued([mixed, plain]);
    // Company value excludes customer property: 200 + 200 = 400 (never the customer's 5×?).
    expect(s.companyInventoryValue).toBe(400);
    expect(s.knownInventoryValue).toBe(400);
    // Three on-hand views, grouped by unit, never summed across units.
    expect(s.physicalOnHandByUnit.m).toBe(19); // 15 + 4
    expect(s.companyOwnedOnHandByUnit.m).toBe(14); // 10 + 4
    expect(s.customerOwnedOnHandByUnit.m).toBe(5);
    expect(s.customerOwnedItemCount).toBe(1);
  });
});

/* ══ ROUTE — THE TWO PROVENANCE PATHS, END TO END ══════════════════════════ */

describe("GET /item/:id and /summary separate ownership from real data", () => {
  test("the ownership marker on a stored movement is honoured through the route", async () => {
    const co = await company(); const token = await actor(co);
    const c1 = oid(); const cust1 = oid();
    const item = await mkItem(co, {
      quantity: 15,
      stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1, { ownership: "CUSTOMER" })],
    });
    const res = await call(`/api/cms/inventory/valuation/item/${item._id}`, { token });
    expect(res.status).toBe(200);
    const v = res.body.valuation;
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.customerOwnedOnHand).toBe(5);
    expect(v.physicalOnHand).toBe(15);
    expect(v.knownValue).toBe(200);
    expect(v.reasons).not.toContain("MISSING_INBOUND_PRICE");
  });

  test("a CustomerMaterialLot's stockTransactionId link recovers customer movements with no marker (historical path)", async () => {
    const co = await company(); const token = await actor(co);
    const c1 = oid(); const cust1 = oid();
    // The customer inbound carries NO ownership marker — as a historical row would not.
    const item = await mkItem(co, {
      quantity: 15,
      stockTransactions: [companyReceipt(10, 20, c1), customerIn(5, cust1)],
    });
    // The lot links its RECEIVED movement to that exact stock transaction.
    await CustomerMaterialLot.create({
      companyId: co._id,
      customerId: oid(), customerLabel: "Northwind", customerCode: "NW",
      orderRef: "ORD-9", orderLineRef: "L1",
      rawItemId: item._id,
      documentRef: "CME/9", expectationId: oid(), expectationRevisionNo: 1, expectationLineRef: "L1",
      executionFileId: oid(),
      goodsReceiptId: oid(), goodsReceiptNumber: "GRN/9", goodsReceiptLineId: oid(),
      receiptUnit: "m", receiptQuantity: 5, baseUnit: "m", baseQuantity: 5,
      availableQuantity: 5, issuedQuantity: 0, returnedQuantity: 0,
      receivedAt: at(),
      movements: [{
        type: "RECEIVED", quantity: 5, baseUnit: "m", availableAfter: 5,
        stockTransactionId: cust1, goodsReceiptId: oid(), goodsReceiptNumber: "GRN/9", at: at(),
      }],
    });

    const res = await call(`/api/cms/inventory/valuation/item/${item._id}`, { token });
    expect(res.status).toBe(200);
    const v = res.body.valuation;
    expect(v.companyOwnedOnHand).toBe(10);
    expect(v.customerOwnedOnHand).toBe(5);
    expect(v.knownValue).toBe(200); // customer 5 excluded by lot provenance
    expect(v.reasons).not.toContain("MISSING_INBOUND_PRICE");

    // The company summary excludes the customer property and reports it separately.
    const sum = await call(`/api/cms/inventory/valuation/summary`, { token });
    expect(sum.body.summary.companyInventoryValue).toBe(200);
    expect(sum.body.summary.companyOwnedOnHandByUnit.m).toBe(10);
    expect(sum.body.summary.customerOwnedOnHandByUnit.m).toBe(5);
    expect(sum.body.summary.physicalOnHandByUnit.m).toBe(15);
  });
});
