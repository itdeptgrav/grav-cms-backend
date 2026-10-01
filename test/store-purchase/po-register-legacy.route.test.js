// test/store-purchase/po-register-legacy.route.test.js
//
// THE LEGACY PURCHASE-ORDER REGISTER — GET /api/cms/.../purchase-orders
//
// Kept because callers outside the Purchase workspace still use it, so it is
// secured rather than removed.
//
// ── THE BUG THIS SUITE EXISTS FOR ───────────────────────────────────────────
// `tenantContext.tenantFilter` returns an `$or` whenever legacy read-through is
// on, which is the default. This handler then assigned its own `filter.$or` for
// the search terms, REPLACING the company clause — so the query kept the search
// and dropped the tenancy, and typing in the box returned another company's
// orders. The search was also handed to `$regex` unescaped, so punctuation in a
// supplier's name acted as pattern syntax.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `LG${seq}`, name: "Lg", email: "l@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    .then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(co) {
  const n = ++seq; const email = `lg${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "LG", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "LG" });
  return tokenFor({ id: String(employeeRef), email });
}

const makePO = (co, over = {}) => PurchaseOrder.create({
  companyId: co._id, poNumber: over.poNumber || `PO/${++seq}`, status: over.status || "ISSUED",
  createdBy: new mongoose.Types.ObjectId(),
  vendorName: over.vendorName || "Acme Mills", vendor: new mongoose.Types.ObjectId(),
  subtotal: 0, taxAmount: 0, totalAmount: over.totalAmount ?? 1000,
  items: [{
    _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(),
    itemName: over.itemName || "Fabric", sku: "F-1", unit: "m",
    quantity: 10, unitPrice: 1, totalPrice: 10,
    receivedQuantity: 0, pendingQuantity: 10, status: "PENDING",
  }],
});

const REG = "/api/cms/purchase-orders";

/* ── SEARCH MUST NOT UNDO COMPANY SCOPING ────────────────────────────────── */

describe("searching the legacy register stays inside the company", () => {
  it("returns this company's matching order", async () => {
    const co = await company();
    const token = await actor(co);
    const mine = await makePO(co, { vendorName: "Northwind Textiles" });

    const res = await call(`${REG}?search=Northwind`, { token });
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders.map((p) => p.poNumber)).toContain(mine.poNumber);
  });

  it("never returns another company's matching order", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const ours = await makePO(mine, { vendorName: "Sharedname Textiles" });
    const notOurs = await makePO(theirs, { vendorName: "Sharedname Textiles" });

    const res = await call(`${REG}?search=Sharedname`, { token });
    expect(res.status).toBe(200);
    const numbers = res.body.purchaseOrders.map((p) => p.poNumber);
    expect(numbers).toContain(ours.poNumber);
    expect(numbers).not.toContain(notOurs.poNumber);
  });

  it("a search on the item name is scoped too, not only the supplier", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makePO(mine, { itemName: "Herringbone" });
    const notOurs = await makePO(theirs, { itemName: "Herringbone" });

    const res = await call(`${REG}?search=Herringbone`, { token });
    expect(res.body.purchaseOrders.map((p) => p.poNumber)).not.toContain(notOurs.poNumber);
  });

  it("a search combined with a status filter is still scoped", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makePO(mine, { vendorName: "Combo Mills", status: "ISSUED" });
    const notOurs = await makePO(theirs, { vendorName: "Combo Mills", status: "ISSUED" });

    const res = await call(`${REG}?search=Combo&status=ISSUED`, { token });
    expect(res.body.purchaseOrders.map((p) => p.poNumber)).not.toContain(notOurs.poNumber);
  });

  it("company-level counts describe this company only", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makePO(mine, { status: "ISSUED" });
    await makePO(theirs, { status: "ISSUED" });
    await makePO(theirs, { status: "ISSUED" });

    const res = await call(`${REG}?search=Acme`, { token });
    /* The rows were already hidden; an unscoped count would still leak the
       other company's VOLUME. */
    expect(res.body.stats.issued).toBe(1);
    expect(res.body.stats.total).toBe(1);
  });
});

/* ── THE SEARCH IS TEXT, NOT A PATTERN ───────────────────────────────────── */

describe("regex-special search text is treated as text", () => {
  it("a dot does not stand for any character", async () => {
    const co = await company();
    const token = await actor(co);
    const literal = await makePO(co, { vendorName: "A.C Mills" });
    const wouldMatchUnescaped = await makePO(co, { vendorName: "ABC Mills" });

    const res = await call(`${REG}?search=${encodeURIComponent("A.C")}`, { token });
    const numbers = res.body.purchaseOrders.map((p) => p.poNumber);
    expect(numbers).toContain(literal.poNumber);
    /* Unescaped, `A.C` would match "ABC" as well and silently widen the
       search past what was typed. */
    expect(numbers).not.toContain(wouldMatchUnescaped.poNumber);
  });

  it("a wildcard cannot broaden the query to everything", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { vendorName: "Plain Mills" });

    const res = await call(`${REG}?search=${encodeURIComponent(".*")}`, { token });
    expect(res.status).toBe(200);
    /* `.*` matches every string when it is a pattern. As text it matches none
       of these names. */
    expect(res.body.purchaseOrders).toHaveLength(0);
  });

  it("unbalanced pattern punctuation is answered, not thrown", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { vendorName: "Plain Mills" });

    /* `(` is an unterminated group: as a pattern it makes `new RegExp` throw,
       which would turn a typo in a search box into a 500. */
    const res = await call(`${REG}?search=${encodeURIComponent("Mills (")}`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.purchaseOrders)).toBe(true);
  });

  it("the escaping does not stop an ordinary search working", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await makePO(co, { vendorName: "Ordinary Mills" });
    const res = await call(`${REG}?search=ordinary`, { token });
    expect(res.body.purchaseOrders.map((p) => p.poNumber)).toContain(po.poNumber);
  });
});

/* ── THE ENDPOINT IS KEPT, AND STILL WORKS ───────────────────────────────── */

describe("the legacy register still answers its existing callers", () => {
  it("lists without a search, scoped", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const ours = await makePO(mine);
    const notOurs = await makePO(theirs);

    const res = await call(REG, { token });
    expect(res.status).toBe(200);
    const numbers = res.body.purchaseOrders.map((p) => p.poNumber);
    expect(numbers).toContain(ours.poNumber);
    expect(numbers).not.toContain(notOurs.poNumber);
  });

  it("status=all is not treated as a status", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { status: "DRAFT" });
    await makePO(co, { status: "ISSUED" });

    const res = await call(`${REG}?status=all`, { token });
    expect(res.body.purchaseOrders).toHaveLength(2);
  });

  it("refuses a caller with no company membership", async () => {
    const res = await call(REG, { token: tokenFor() });
    expect([401, 403]).toContain(res.status);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   THE SAME DEFECT, THE SAME FILE

   `GET /reports/exceptions` builds its filter the same way and had the same
   bug: it escaped its search correctly but still assigned `filter.$or` over
   the tenancy clause.
   ────────────────────────────────────────────────────────────────────────── */
describe("the exceptions register search is scoped too", () => {
  it("a searched exceptions read never reaches another company", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makePO(mine, { vendorName: "Exception Mills", status: "PARTIALLY_RECEIVED" });
    const notOurs = await makePO(theirs, { vendorName: "Exception Mills", status: "PARTIALLY_RECEIVED" });

    const res = await call(`/api/cms/purchase-orders/reports/exceptions?q=${encodeURIComponent("Exception Mills")}`, { token });
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(String(notOurs._id));
    expect(body).not.toContain(notOurs.poNumber);
  });

  it("an unsearched exceptions read is scoped as it always was", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const notOurs = await makePO(theirs, { status: "PARTIALLY_RECEIVED" });

    const res = await call("/api/cms/purchase-orders/reports/exceptions", { token });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(notOurs.poNumber);
  });
});
