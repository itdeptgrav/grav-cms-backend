// test/store-purchase/service-order.route.test.js
//
// SERVICE ORDER LIFECYCLE — issue → start → supplier completion → department
// acceptance (or a correction and rework). Store drives it up to completion;
// only the requesting department accepts or asks for a correction; and NOTHING
// here creates a purchase order, a goods receipt or a stock movement.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Employee = require("../../models/Employee");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/service-orders", require("../../routes/CMS_Routes/Inventory/Operations/serviceOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/service-orders`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (emp, path, { method = "GET", body, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenFor(emp)}`,
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* Give an employee a Store & Purchase membership in a company, the way the
   established tenant contract resolves one. */
const member = (emp, companyId) =>
  SpCompanyMembership.create({ companyId, employeeRef: emp._id, email: emp.email, isActive: true });

async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({ companyName: `SOL Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const storeDept = (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));
  const store = await Employee.create({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, isActive: true, gender: "Other", biometricId: `ST${n}`, department: "Store", accessDepartmentId: storeDept._id });
  const requester = await Employee.create({ firstName: "Rutu", lastName: `R${n}`, email: `req${n}@demo.example`, isActive: true, gender: "Other", biometricId: `RQ${n}`, department: "Logistics" });
  const other = await Employee.create({ firstName: "Zed", lastName: `Z${n}`, email: `zed${n}@demo.example`, isActive: true, gender: "Other", biometricId: `ZZ${n}`, department: "Logistics" });
  return { company, store, requester, other };
}

const mkOrder = (s, over = {}) =>
  ServiceOrder.create({
    companyId: s.company._id, serviceOrderNumber: `SVO/2026-27/${String(seq++).padStart(4, "0")}`,
    spendRequestId: new mongoose.Types.ObjectId(), spendRequestNumber: `SR-${seq}`,
    vendorName: "Fix It Co", title: "AMC", department: "Logistics",
    requestedById: s.requester.biometricId, requestedByName: "Rutu",
    lines: [{ serviceCode: "SVC-1", serviceName: "AMC", description: "Annual visit", billingUnit: "visit", sacCode: "9987", quantity: 4, rate: 2500, netAmount: 10000, gstRate: 18, gstAmount: 1800, lineTotal: 11800 }],
    subtotal: 10000, taxAmount: 1800, totalAmount: 11800, status: "DRAFT",
    ...over,
  });

describe("the service order lifecycle", () => {
  test("register and detail speak service, and list this company's orders", async () => {
    const s = await seed();
    await mkOrder(s);
    const reg = await call(s.store, "/");
    expect(reg.status).toBe(200);
    expect(reg.body.serviceOrders).toHaveLength(1);
    expect(reg.body.serviceOrders[0].serviceOrderNumber).toMatch(/^SVO\//);
    expect(reg.body.pagination.total).toBe(1);

    const det = await call(s.store, `/${reg.body.serviceOrders[0]._id}`);
    expect(det.status).toBe(200);
    expect(det.body.serviceOrder.lines[0].billingUnit).toBe("visit");
    expect(det.body.serviceOrder.lines[0].sacCode).toBe("9987");
  });

  test("Store drives issue → start → report-completion, then the requester accepts", async () => {
    const s = await seed();
    const so = await mkOrder(s);
    expect((await call(s.store, `/${so._id}/issue`, { method: "PATCH", body: {} })).body.serviceOrder.status).toBe("ISSUED");
    expect((await call(s.store, `/${so._id}/start`, { method: "PATCH", body: {} })).body.serviceOrder.status).toBe("IN_PROGRESS");
    const rep = await call(s.store, `/${so._id}/report-completion`, { method: "PATCH", body: { note: "done" } });
    expect(rep.body.serviceOrder.status).toBe("COMPLETION_REPORTED");
    /* Reporting completion creates NO purchase order and NO stock movement. */
    expect(await PurchaseOrder.countDocuments({})).toBe(0);

    const acc = await call(s.requester, `/${so._id}/accept`, { method: "PATCH", body: { note: "looks good" } });
    expect(acc.status).toBe(200);
    expect(acc.body.serviceOrder.status).toBe("ACCEPTED");
    expect(acc.body.serviceOrder.acceptance.byName).toBeTruthy();
  });

  test("acceptance is refused before completion is reported", async () => {
    const s = await seed();
    const so = await mkOrder(s, { status: "IN_PROGRESS" });
    const r = await call(s.requester, `/${so._id}/accept`, { method: "PATCH", body: {} });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("INVALID_TRANSITION");
  });

  test("only the requester may accept or request a correction", async () => {
    const s = await seed();
    const so = await mkOrder(s, { status: "COMPLETION_REPORTED" });
    /* Store cannot accept. */
    expect((await call(s.store, `/${so._id}/accept`, { method: "PATCH", body: {} })).status).toBe(403);
    /* A different employee cannot. */
    expect((await call(s.other, `/${so._id}/accept`, { method: "PATCH", body: {} })).status).toBe(403);
    expect((await call(s.other, `/${so._id}/request-correction`, { method: "PATCH", body: { reason: "x" } })).status).toBe(403);
  });

  test("a correction needs a reason and rework can loop back to completion and acceptance", async () => {
    const s = await seed();
    const so = await mkOrder(s, { status: "COMPLETION_REPORTED" });
    /* Reason required. */
    const noReason = await call(s.requester, `/${so._id}/request-correction`, { method: "PATCH", body: {} });
    expect(noReason.status).toBe(400);
    expect(noReason.body.reason).toBe("REASON_REQUIRED");

    const corr = await call(s.requester, `/${so._id}/request-correction`, { method: "PATCH", body: { reason: "missed a unit" } });
    expect(corr.body.serviceOrder.status).toBe("REWORK_REQUIRED");
    expect(corr.body.serviceOrder.rework.note).toBe("missed a unit");

    /* Store re-works: back to in progress, complete again, requester accepts. */
    expect((await call(s.store, `/${so._id}/start`, { method: "PATCH", body: {} })).body.serviceOrder.status).toBe("IN_PROGRESS");
    expect((await call(s.store, `/${so._id}/report-completion`, { method: "PATCH", body: {} })).body.serviceOrder.status).toBe("COMPLETION_REPORTED");
    expect((await call(s.requester, `/${so._id}/accept`, { method: "PATCH", body: {} })).body.serviceOrder.status).toBe("ACCEPTED");
  });

  test("Store may cancel before acceptance; an accepted order is immutable", async () => {
    const s = await seed();
    const so = await mkOrder(s, { status: "ISSUED" });
    const c = await call(s.store, `/${so._id}/cancel`, { method: "PATCH", body: { note: "supplier withdrew" } });
    expect(c.body.serviceOrder.status).toBe("CANCELLED");

    /* Cancelled is terminal — every lifecycle endpoint refuses it. Cancel is
       sent with a reason so the 409 is about the terminal status, not a
       missing reason. */
    for (const ep of ["issue", "start", "report-completion"]) {
      expect((await call(s.store, `/${so._id}/${ep}`, { method: "PATCH", body: {} })).status).toBe(409);
    }
    expect((await call(s.store, `/${so._id}/cancel`, { method: "PATCH", body: { reason: "again" } })).status).toBe(409);

    /* An accepted order is equally immutable. */
    const acc = await mkOrder(s, { status: "ACCEPTED" });
    expect((await call(s.store, `/${acc._id}/cancel`, { method: "PATCH", body: { reason: "again" } })).status).toBe(409);
    expect((await call(s.requester, `/${acc._id}/request-correction`, { method: "PATCH", body: { reason: "x" } })).status).toBe(409);
    expect((await call(s.store, `/${acc._id}/report-completion`, { method: "PATCH", body: {} })).status).toBe(409);
  });

  test("an invalid stage jump is a clear 409", async () => {
    const s = await seed();
    const so = await mkOrder(s); // DRAFT
    /* Cannot report completion on a draft. */
    const r = await call(s.store, `/${so._id}/report-completion`, { method: "PATCH", body: {} });
    expect(r.status).toBe(409);
    expect(r.body.currentStatus).toBe("DRAFT");
  });

  test("every transition records actor, time and note in history", async () => {
    const s = await seed();
    const so = await mkOrder(s);
    await call(s.store, `/${so._id}/issue`, { method: "PATCH", body: { note: "sent" } });
    const doc = await ServiceOrder.findById(so._id).lean();
    const issued = doc.history.find((h) => h.action === "issued");
    expect(issued).toBeTruthy();
    expect(issued.byName).toBeTruthy();
    expect(issued.at).toBeTruthy();
    expect(issued.note).toBe("sent");
    expect(doc.issued.byName).toBeTruthy();
  });

  test("a non-store viewer cannot list, and a stranger cannot view an order", async () => {
    const s = await seed();
    const so = await mkOrder(s);
    expect((await call(s.requester, "/")).status).toBe(403);
    /* The requester may view their own order. */
    expect((await call(s.requester, `/${so._id}`)).status).toBe(200);
    /* An unrelated employee cannot. */
    expect((await call(s.other, `/${so._id}`)).status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * TENANT ISOLATION, RACE SAFETY, AND STABLE REQUESTER IDENTITY (S2 correction)
 * ═════════════════════════════════════════════════════════════════════════ */
describe("tenant isolation and race safety", () => {
  const storeDeptFor = async (n) =>
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));

  const mkStore = async (n) => {
    const dept = await storeDeptFor(n);
    return Employee.create({ firstName: "St", lastName: `${n}`, email: `st${n}@x.example`, isActive: true, gender: "Other", biometricId: `ST${n}`, department: "Store", accessDepartmentId: dept._id });
  };
  const mkEmp = (n, over = {}) =>
    Employee.create({ firstName: "Em", lastName: `${n}`, email: `em${n}@x.example`, isActive: true, gender: "Other", biometricId: `EM${n}`, department: "Logistics", ...over });

  const orderIn = (companyId, over = {}) =>
    ServiceOrder.create({
      companyId, serviceOrderNumber: `SVO/2026-27/${String(seq++).padStart(4, "0")}`,
      spendRequestId: new mongoose.Types.ObjectId(), spendRequestNumber: `SR-${seq}`,
      vendorName: "V", title: "AMC", department: "Logistics", requestedByName: "R",
      lines: [{ serviceCode: "SVC-1", serviceName: "AMC", billingUnit: "visit", quantity: 1, rate: 100, netAmount: 100, gstRate: 0, gstAmount: 0, lineTotal: 100 }],
      subtotal: 100, taxAmount: 0, totalAmount: 100, status: "DRAFT", ...over,
    });

  test("Company A cannot list, view or mutate Company B's service orders", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const B = await Acc_Company.create({ companyName: `B ${n}`, booksFromDate: new Date("2026-04-01") });
    const storeA = await mkStore(`A${n}`); await member(storeA, A._id);
    await orderIn(A._id);
    const bOrder = await orderIn(B._id);

    /* List returns only A's orders. */
    const list = await call(storeA, "/");
    expect(list.status).toBe(200);
    expect(list.body.serviceOrders).toHaveLength(1);
    expect(list.body.serviceOrders.every((o) => o.serviceOrderNumber)).toBe(true);
    /* B's order is not found for A — view and every mutation. */
    expect((await call(storeA, `/${bOrder._id}`)).status).toBe(404);
    expect((await call(storeA, `/${bOrder._id}/issue`, { method: "PATCH", body: {} })).status).toBe(404);
    expect((await call(storeA, `/${bOrder._id}/cancel`, { method: "PATCH", body: { reason: "x" } })).status).toBe(404);
    /* And B's order was not mutated. */
    expect((await ServiceOrder.findById(bOrder._id)).status).toBe("DRAFT");
  });

  test("a multi-company actor with no valid selection fails closed", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const B = await Acc_Company.create({ companyName: `B ${n}`, booksFromDate: new Date("2026-04-01") });
    const store = await mkStore(`M${n}`);
    await member(store, A._id); await member(store, B._id);

    /* No company chosen — refused, not defaulted to "all". */
    const none = await call(store, "/");
    expect(none.status).toBeGreaterThanOrEqual(400);
    expect(none.body.serviceOrders).toBeUndefined();
    /* Naming a company they do not belong to is also refused. */
    const foreign = await call(store, "/", { company: String(new mongoose.Types.ObjectId()) });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
  });

  test("selecting an authorised company exposes only that company's records", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const B = await Acc_Company.create({ companyName: `B ${n}`, booksFromDate: new Date("2026-04-01") });
    const store = await mkStore(`S${n}`);
    await member(store, A._id); await member(store, B._id);
    await orderIn(A._id); await orderIn(A._id);
    await orderIn(B._id);

    const inA = await call(store, "/", { company: String(A._id) });
    expect(inA.status).toBe(200);
    expect(inA.body.serviceOrders).toHaveLength(2);
    const inB = await call(store, "/", { company: String(B._id) });
    expect(inB.body.serviceOrders).toHaveLength(1);
  });

  test("a requester in Company A cannot view or accept a Company B order", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const B = await Acc_Company.create({ companyName: `B ${n}`, booksFromDate: new Date("2026-04-01") });
    const req = await mkEmp(`RQ${n}`); await member(req, A._id);
    /* An order in B for which this person is (implausibly) the requester. */
    const bOrder = await orderIn(B._id, { requestedBy: req._id, status: "COMPLETION_REPORTED" });
    expect((await call(req, `/${bOrder._id}`)).status).toBe(404);
    expect((await call(req, `/${bOrder._id}/accept`, { method: "PATCH", body: {} })).status).toBe(404);
    expect((await ServiceOrder.findById(bOrder._id)).status).toBe("COMPLETION_REPORTED");
  });

  test("requester ownership is by Employee id, not a mutable/blank biometric", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const req = await mkEmp(`RQ${n}`, { biometricId: `RQ${n}` }); await member(req, A._id);
    /* Somebody else whose biometric equals the order's STALE biometric string. */
    const impostor = await mkEmp(`IMP${n}`, { biometricId: "SHARED-BIO" }); await member(impostor, A._id);
    const so = await orderIn(A._id, {
      requestedBy: req._id, requestedById: "SHARED-BIO", status: "COMPLETION_REPORTED",
    });
    /* The impostor's matching biometric must NOT let them accept — id wins. */
    expect((await call(impostor, `/${so._id}/accept`, { method: "PATCH", body: {} })).status).toBe(403);
    /* The real requester accepts through their Employee id. */
    const ok = await call(req, `/${so._id}/accept`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.serviceOrder.status).toBe("ACCEPTED");
  });

  test("a legacy order without requestedBy still matches on the biometric fallback", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const req = await mkEmp(`RQ${n}`, { biometricId: `LEG${n}` }); await member(req, A._id);
    const so = await orderIn(A._id, { requestedById: `LEG${n}`, status: "COMPLETION_REPORTED" }); // no requestedBy
    const ok = await call(req, `/${so._id}/accept`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.serviceOrder.status).toBe("ACCEPTED");
  });

  test("two concurrent identical transitions: one success, one clean conflict, one history entry", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const store = await mkStore(`S${n}`); await member(store, A._id);
    const so = await orderIn(A._id, { status: "DRAFT" });

    const [a, b] = await Promise.all([
      call(store, `/${so._id}/issue`, { method: "PATCH", body: {} }),
      call(store, `/${so._id}/issue`, { method: "PATCH", body: {} }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    /* The conflict is clean — a current-state 409 with a reason, never a
       Mongoose version error surfaced as a generic 500. */
    const conflict = [a, b].find((r) => r.status === 409);
    expect(conflict.body.reason).toBe("INVALID_TRANSITION");
    expect(conflict.body.currentStatus).toBe("ISSUED");
    /* Exactly one "issued" history entry. */
    const doc = await ServiceOrder.findById(so._id).lean();
    expect(doc.status).toBe("ISSUED");
    expect(doc.history.filter((h) => h.action === "issued")).toHaveLength(1);
  });

  test("cancellation requires a reason and records it; the order and history survive", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const store = await mkStore(`S${n}`); await member(store, A._id);
    const so = await orderIn(A._id, { status: "ISSUED" });

    const noReason = await call(store, `/${so._id}/cancel`, { method: "PATCH", body: {} });
    expect(noReason.status).toBe(400);
    expect(noReason.body.reason).toBe("REASON_REQUIRED");
    /* Nothing was cancelled. */
    expect((await ServiceOrder.findById(so._id)).status).toBe("ISSUED");

    const ok = await call(store, `/${so._id}/cancel`, { method: "PATCH", body: { reason: "supplier withdrew" } });
    expect(ok.status).toBe(200);
    expect(ok.body.serviceOrder.status).toBe("CANCELLED");
    const doc = await ServiceOrder.findById(so._id).lean();
    expect(doc.cancellation.note).toBe("supplier withdrew");
    expect(doc.history.find((h) => h.action === "cancelled").note).toBe("supplier withdrew");
    /* The order still exists with its earlier history intact. */
    expect(doc.history.length).toBeGreaterThanOrEqual(1);
  });

  test("the whole lifecycle creates no purchase order (no goods/stock/accounting record)", async () => {
    const n = seq++;
    const A = await Acc_Company.create({ companyName: `A ${n}`, booksFromDate: new Date("2026-04-01") });
    const store = await mkStore(`S${n}`); await member(store, A._id);
    const req = await mkEmp(`RQ${n}`); await member(req, A._id);
    const so = await orderIn(A._id, { requestedBy: req._id });

    await call(store, `/${so._id}/issue`, { method: "PATCH", body: {} });
    await call(store, `/${so._id}/start`, { method: "PATCH", body: {} });
    await call(store, `/${so._id}/report-completion`, { method: "PATCH", body: {} });
    await call(req, `/${so._id}/accept`, { method: "PATCH", body: {} });
    expect((await ServiceOrder.findById(so._id)).status).toBe("ACCEPTED");
    expect(await PurchaseOrder.countDocuments({})).toBe(0);
  });
});

/* ── S3: Service Order detail exposes a truthful supplier-billing state ─────
   The detail response carries a `billing` block so the Store screen can show
   whether an accepted order is not-ready / ready / drafted / pending / posted,
   list every voucher separately with distinct per-status totals, and never
   invent a "paid" state. Vouchers are created directly (the accounting hook is
   exercised elsewhere); here we only assert what the SO detail reports. */
describe("S3 — service order billing state on the detail page", () => {
  const Acc_Voucher = require("../../models/Accountant_model/Acc_VoucherModels").Acc_Voucher;

  const mkVoucher = (companyId, soId, { status = "draft", amount = 11800, number } = {}) =>
    Acc_Voucher.create({
      companyId, voucherType: "purchase",
      voucherNumber: number || `V/${seq++}/${Math.random().toString(36).slice(2)}`,
      voucherDate: new Date("2026-08-10"), status, grandTotal: amount,
      serviceOrderId: soId,
    });

  const detailOf = async (store, so) => {
    const r = await call(store, `/${so._id}`);
    expect(r.status).toBe(200);
    return r.body.billing;
  };

  test("an order that is not yet accepted is not ready for billing", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "IN_PROGRESS" });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("not-ready");
    expect(b.ready).toBe(false);
    expect(b.hasLiveVoucher).toBe(false);
    expect(b.vouchers).toEqual([]);
  });

  test("an accepted order with no bill is ready", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("ready");
    expect(b.ready).toBe(true);
    expect(b.hasLiveVoucher).toBe(false);
    expect(b.totals).toEqual({ draft: 0, pending: 0, posted: 0 });
  });

  test("a draft bill makes the state drafted and shows the draft total", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    await mkVoucher(s.company._id, so._id, { status: "draft", amount: 11800 });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("drafted");
    expect(b.hasLiveVoucher).toBe(true);
    expect(b.totals.draft).toBe(11800);
    expect(b.totals.posted).toBe(0);
    expect(b.vouchers).toHaveLength(1);
  });

  test("a pending bill makes the state pending", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    await mkVoucher(s.company._id, so._id, { status: "pending_approval", amount: 9000 });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("pending");
    expect(b.totals.pending).toBe(9000);
  });

  test("a posted bill makes the state posted and shows the posted total", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    await mkVoucher(s.company._id, so._id, { status: "posted", amount: 11800 });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("posted");
    expect(b.totals.posted).toBe(11800);
  });

  test("only cancelled bills leave an accepted order billable again (never 'paid')", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    await mkVoucher(s.company._id, so._id, { status: "cancelled", amount: 11800 });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("ready");
    expect(b.hasLiveVoucher).toBe(false);
    expect(JSON.stringify(b).toLowerCase()).not.toContain("paid");
  });

  test("multiple bills are listed separately with distinct per-status totals", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    await mkVoucher(s.company._id, so._id, { status: "posted", amount: 5000 });
    await mkVoucher(s.company._id, so._id, { status: "draft", amount: 1200 });
    await mkVoucher(s.company._id, so._id, { status: "cancelled", amount: 999 });
    const b = await detailOf(s.store, so);
    expect(b.state).toBe("posted"); // a live posted bill wins over a draft
    expect(b.totals.posted).toBe(5000);
    expect(b.totals.draft).toBe(1200);
    expect(b.vouchers).toHaveLength(3); // every voucher returned, cancelled included
  });

  // Requirement 15 — a genuine Accounting-query failure must read as
  // "unavailable", never silently as "ready / no bills" (which would invite a
  // duplicate bill).
  test("an accounting-query failure reports 'unavailable', never 'ready'", async () => {
    const s = await seed(); await member(s.store, s.company._id);
    const so = await mkOrder(s, { status: "ACCEPTED" });
    const spy = jest.spyOn(Acc_Voucher, "find").mockImplementationOnce(() => {
      throw new Error("accounting temporarily unavailable");
    });
    try {
      const b = await detailOf(s.store, so);
      expect(b.state).toBe("unavailable");
      expect(b.ready).toBe(false);
      expect(b.hasLiveVoucher).toBe(false);
      expect(typeof b.message).toBe("string");
      expect(b.message.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });
});

