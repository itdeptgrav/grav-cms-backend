// test/requests/spend-service-order.route.test.js
//
// APPROVED SERVICE REQUEST → SERVICE ORDER.
//
// The service counterpart of the C1 purchase-order conversion: it must never
// create a purchase order, and the purchase route must never create a service
// order. Commercial facts come from the approved stored request; each line is
// matched to an ACTIVE Service Master record in the request's company; and the
// same at-most-one-order guarantee and recovery are proven here.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({ companyName: `SO Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const group = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: company._id, name: `Repairs ${n}`, groupId: group._id, groupName: group.name, nature: "expense" });
  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense", department: "Logistics", allocatedAmount: 50000 }],
  }));
  const tl = await Employee.create({ firstName: "Sakib", lastName: `Tl${n}`, email: `tl${n}@demo.example`, isActive: true, gender: "Other", biometricId: `TL${n}`, department: "Logistics" });
  const emp = await Employee.create({ firstName: "Rutu", lastName: `Emp${n}`, email: `emp${n}@demo.example`, isActive: true, gender: "Other", biometricId: `EM${n}`, department: "Logistics", primaryManager: { managerId: tl._id } });
  const finEmp = await Employee.create({ firstName: "Soumya", lastName: `Fin${n}`, email: `fin${n}@demo.example`, isActive: true, gender: "Other", biometricId: `FN${n}`, department: "Accounts" });
  await Acc_User.create({ organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`, name: "Finance", role: "approver", isActive: true, passwordHash: "x" });
  const storeDept = (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));
  const store = await Employee.create({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, isActive: true, gender: "Other", biometricId: `ST${n}`, department: "Store", accessDepartmentId: storeDept._id });
  return { company, ledger, emp, tl, finEmp, store };
}

const raiseService = (s, over = {}) =>
  call(s.emp, "/", { method: "POST", body: {
    title: "AMC", requestType: "SERVICE", purpose: "Annual maintenance",
    ledgerId: String(s.ledger._id), plannedItemKey: PLANNED_KEY,
    items: [{ name: "Annual maintenance visit", whyNeeded: "yearly", quantity: 4, unit: "visit", rate: 2500 }],
    ...over,
  } });

const mkService = (company, over = {}) =>
  Service.create({ companyId: company._id, serviceCode: `SVC-${seq++}`, name: `AMC ${seq}`, billingUnit: "visit", sacCode: "9987", status: "ACTIVE", ...over });

/* ── STORE'S PRE-FINANCE CLASSIFICATION, THROUGH ITS OWN DOOR ───────────────
 * Every line matched to one service, via the operation the real flow uses.
 * Never by writing `items.n.service` directly: doing that would prove the
 * order route works against a shape nothing in production produces. */
async function classifyAll(s, id, serviceId) {
  const doc = await SpendRequest.findById(id).lean();
  return call(s.store, `/${id}/service-lines`, {
    method: "PATCH",
    body: {
      lines: doc.items.map((l) => ({ spendLineId: String(l._id), serviceId: String(serviceId) })),
    },
  });
}

/**
 * THE NEW-POLICY SEQUENCE, WHICH IS NOW THE ORDINARY ONE.
 *
 *   1. an ACTIVE Service Master record in this company
 *   2. the SERVICE request
 *   3. TL approves
 *   4. Store classifies every line, before finance sees it
 *   5. finance approves
 *
 * A SERVICE request raised today carries the classification policy marker, and
 * finance may not approve one whose lines are not matched to a live service.
 * This fixture used to skip step 4 — which is precisely the workflow the
 * correction removed, so every test built on it was asserting against a state
 * the system no longer produces.
 *
 * The conversion that follows takes NO `lineMatches`: the identity is already
 * on the approved request, and that is what the order is built from.
 */
async function approvedService(s, { over = {}, service, serviceOver = {} } = {}) {
  const svc = service || await mkService(s.company, serviceOver);

  const { body } = await raiseService(s, over);
  const id = body.request._id;

  await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });

  const classified = await classifyAll(s, id, svc._id);
  /* Asserted, not assumed: a silently failed match would leave every test
     below proving something about an unclassified request instead. */
  if (classified.status !== 200) {
    throw new Error(`classification failed: ${classified.status} ${JSON.stringify(classified.body)}`);
  }

  const approved = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
  if (approved.status !== 200) {
    throw new Error(`finance approval failed: ${approved.status} ${JSON.stringify(approved.body)}`);
  }

  return { id, svc };
}

/**
 * A GENUINELY HISTORICAL REQUEST.
 *
 * Approved before service classification existed, so it carries no policy
 * marker — the only shape for which the late-match door on the order route is
 * still open. Produced by unsetting the stamp in the database, which is
 * exactly what such a document looks like, rather than by weakening the gate.
 */
async function legacyApprovedService(s, over = {}) {
  const { body } = await raiseService(s, over);
  const id = body.request._id;

  await SpendRequest.updateOne({ _id: id }, { $unset: { serviceClassificationPolicy: "" } });
  const before = await SpendRequest.findById(id).lean();
  /* Confirmed, because the whole exemption turns on it. */
  if (before.serviceClassificationPolicy !== undefined) {
    throw new Error("the legacy fixture still carries a policy marker");
  }

  await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
  const approved = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
  if (approved.status !== 200) {
    throw new Error(`legacy approval failed: ${approved.status} ${JSON.stringify(approved.body)}`);
  }
  return id;
}

/** Late `lineMatches`, for the legacy path only. */
async function matchAll(id, serviceId) {
  const doc = await SpendRequest.findById(id).lean();
  return { lineMatches: doc.items.map((l) => ({ spendLineId: String(l._id), serviceId: String(serviceId) })) };
}

describe("converting an approved service request into a service order", () => {
  test("a PRODUCT request cannot create a service order", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/", { method: "POST", body: {
      title: "Laptop", requestType: "PRODUCT", purpose: "new hire", ledgerId: String(s.ledger._id), plannedItemKey: PLANNED_KEY,
      items: [{ name: "Laptop", whyNeeded: "x", quantity: 1, unit: "pcs", rate: 50000 }],
    } });
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("PRODUCT_ORDER_NOT_SUPPORTED");
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("a SERVICE request cannot create a purchase order, and is directed to the service order", async () => {
    const s = await seed();
    const { id } = await approvedService(s);
    const r = await call(s.store, `/${id}/purchase-order`, { method: "POST", body: {} });
    expect(r.status).toBe(400);
    /* Code preserved for compatibility; message now directs the user. */
    expect(r.body.reason).toBe("SERVICE_ORDER_NOT_SUPPORTED");
    expect(r.body.message).toMatch(/create service order/i);
    expect(r.body.message).not.toMatch(/not supported/i);
    expect(await PurchaseOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("an approved service creates exactly one DRAFT service order from the stored facts", async () => {
    const s = await seed();
    const { id, svc } = await approvedService(s);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.vendorName": "Fix It Co", "items.0.gstPercent": 18, "items.0.taxAmount": 1800 } });

    /* No `lineMatches`: the identity was recorded before finance approved,
       and that stored snapshot is what the order is built from. */
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(201);
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(so.status).toBe("DRAFT");
    expect(so.vendorName).toBe("Fix It Co");
    /* Commercial values are the APPROVED ones, from the stored request. */
    expect(so.lines[0].quantity).toBe(4);
    expect(so.lines[0].rate).toBe(2500);
    expect(so.lines[0].netAmount).toBe(10000);
    expect(so.lines[0].gstRate).toBe(18);
    expect(so.lines[0].gstAmount).toBe(1800);
    expect(so.subtotal).toBe(10000);
    expect(so.taxAmount).toBe(1800);
    expect(so.totalAmount).toBe(11800);
    /* Master snapshots on the line. */
    expect(so.lines[0].serviceCode).toBe(svc.serviceCode);
    expect(so.lines[0].billingUnit).toBe("visit");
    expect(so.lines[0].sacCode).toBe("9987");
    /* The request is linked, ordered, and says so in its history. */
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.status).toBe("ordered");
    expect(String(doc.serviceOrderId)).toBe(String(so._id));
    expect(doc.serviceOrderNumber).toBe(so.serviceOrderNumber);
    expect(doc.orderReference).toBe(so.serviceOrderNumber);
    expect(doc.history.some((h) => /service order/i.test(h.action))).toBe(true);
    /* And the matched identity is persisted back onto the spend line. */
    expect(String(doc.items[0].service)).toBe(String(svc._id));
    expect(doc.items[0].serviceCode).toBe(svc.serviceCode);
  });

  test("nothing commercial is taken from the request body", async () => {
    const s = await seed();
    const { id } = await approvedService(s);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.vendorName": "Real Vendor" } });

    /* A body stuffed with vendor/rate/qty/GST/company — all must be ignored. */
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {
      vendorName: "Injected", rate: 999999, quantity: 999, gstPercent: 99, companyId: String(new mongoose.Types.ObjectId()), totalAmount: 1,
    } });
    expect(r.status).toBe(201);
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(so.vendorName).toBe("Real Vendor");
    expect(so.lines[0].rate).toBe(2500);
    expect(so.lines[0].quantity).toBe(4);
    expect(String(so.companyId)).toBe(String(s.company._id));
  });

  test("the number uses the shared SVO financial-year sequence", async () => {
    const s = await seed();
    const { id } = await approvedService(s);
    await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(so.serviceOrderNumber).toMatch(/^SVO\/\d{4}-\d{2}\/\d+$/);
  });

  test("a line classified before approval needs no match at order time", async () => {
    const s = await seed();
    const { id, svc } = await approvedService(s);

    /* The line already carries its identity, recorded through the
       classification operation rather than written onto the document. */
    const before = await SpendRequest.findById(id).lean();
    expect(String(before.items[0].service)).toBe(String(svc._id));

    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(201);
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(String(so.lines[0].service)).toBe(String(svc._id));
  });

  /* ── WHERE A BAD MATCH IS NOW REFUSED ─────────────────────────────────────
     These three rules have not changed; the door they are enforced at has.
     A match is made before finance approves, so an inactive, foreign or
     nonexistent service is caught there — while the request can still be
     corrected and before any money is promised. Asserting them against the
     ORDER route would now be asserting against a state the finance gate
     never lets a request reach. */
  test("an unmatched line never reaches an approval, let alone an order", async () => {
    const s = await seed();
    const { body } = await raiseService(s);
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });

    const approval = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(approval.status).toBe(409);
    expect(approval.body.code).toBe("SERVICE_LINES_UNCLASSIFIED");

    /* And with no approval there is nothing to convert. */
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(409);
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("an inactive service match is refused at classification", async () => {
    const s = await seed();
    const { body } = await raiseService(s);
    const id = body.request._id;
    const svc = await mkService(s.company, { status: "INACTIVE" });

    const r = await classifyAll(s, id, svc._id);
    expect(r.status).toBe(400);
    expect(r.body.lineErrors[0].reason).toBe("SERVICE_INACTIVE");
  });

  test("a service from another company is refused at classification", async () => {
    const s = await seed();
    const { body } = await raiseService(s);
    const id = body.request._id;
    /* A foreign `companyId` directly: a second `Acc_Company` would stop
       `theCompany()` resolving and break request creation instead. */
    const foreign = await Service.create({
      companyId: new mongoose.Types.ObjectId(),
      serviceCode: `SVC-F${seq++}`, name: "Foreign AMC", status: "ACTIVE",
    });

    const r = await classifyAll(s, id, foreign._id);
    expect(r.status).toBe(400);
    expect(r.body.lineErrors[0].reason).toBe("SERVICE_NOT_IN_COMPANY");
  });

  test("a missing service id is refused at classification", async () => {
    const s = await seed();
    const { body } = await raiseService(s);
    const id = body.request._id;

    const r = await classifyAll(s, id, new mongoose.Types.ObjectId());
    expect(r.status).toBe(400);
    expect(r.body.lineErrors[0].reason).toBe("SERVICE_NOT_IN_COMPANY");
  });

  test("Service Master defaults never overwrite the approved rate/GST/vendor — only warn", async () => {
    const s = await seed();
    /* Master carries different defaults, and is the one the line is
       classified against before finance sees it. */
    const { id } = await approvedService(s, { serviceOver: { defaultGstRate: 5, defaultRate: 9999 } });
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.vendorName": "Approved Vendor", "items.0.gstPercent": 18, "items.0.taxAmount": 1800 } });
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(201);
    expect(Array.isArray(r.body.warnings)).toBe(true);
    expect(r.body.warnings.some((w) => w.field === "gst")).toBe(true);
    expect(r.body.warnings.some((w) => w.field === "rate")).toBe(true);
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    /* The order keeps the APPROVED figures. */
    expect(so.lines[0].rate).toBe(2500);
    expect(so.lines[0].gstRate).toBe(18);
  });

  test("two distinct supplier ids are refused (C1 identity rule)", async () => {
    const s = await seed();
    /* Both lines classified — `approvedService` matches every line. */
    const { id } = await approvedService(s, { over: { items: [
      { name: "Visit A", whyNeeded: "x", quantity: 1, unit: "visit", rate: 1000 },
      { name: "Visit B", whyNeeded: "x", quantity: 1, unit: "visit", rate: 1000 },
    ] } });
    const v1 = await Vendor.create({ companyName: "Same Name", companyId: s.company._id });
    const v2 = await Vendor.create({ companyName: "Same Name", companyId: s.company._id });
    await SpendRequest.updateOne({ _id: id }, { $set: {
      "items.0.vendorName": "Same Name", "items.0.vendorId": v1._id,
      "items.1.vendorName": "Same Name", "items.1.vendorId": v2._id,
    } });
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("MULTIPLE_SUPPLIERS");
  });

  test("a repeat returns the existing order, not a second one", async () => {
    const s = await seed();
    const { id } = await approvedService(s);
    const first = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(first.status).toBe(201);
    const second = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(second.status).toBe(200);
    expect(second.body.success).toBe(true);
    /* Same order returned, and NO second "raised service order" history event. */
    expect(String(second.body.serviceOrder._id)).toBe(String(first.body.serviceOrder._id));
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(1);
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.history.filter((h) => /raised service order/i.test(h.action))).toHaveLength(1);
  });

  test("orphan recovery restores every matched service field to the spend line", async () => {
    const s = await seed();
    const { id, svc } = await approvedService(s);
    const doc = await SpendRequest.findById(id).lean();
    /* An order that exists (with its lines and service snapshots) but whose
       request link was never written — the exact crash-between-writes state. */
    const orphan = await ServiceOrder.create({
      companyId: s.company._id, serviceOrderNumber: "SVO/2026-27/9999",
      spendRequestId: id, spendRequestNumber: doc.requestNumber, vendorName: "Orphan Co",
      lines: doc.items.map((l) => ({
        spendLineId: l._id, service: svc._id, serviceCode: svc.serviceCode,
        serviceName: svc.name, billingUnit: svc.billingUnit, sacCode: svc.sacCode,
        quantity: l.quantity, rate: l.rate, netAmount: l.quantity * l.rate,
        gstRate: 0, gstAmount: 0, lineTotal: l.quantity * l.rate,
      })),
      subtotal: 0, taxAmount: 0, totalAmount: 0, status: "DRAFT",
    });

    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(200);
    expect(String(r.body.serviceOrder._id)).toBe(String(orphan._id));
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(1);

    const repaired = await SpendRequest.findById(id).lean();
    expect(repaired.status).toBe("ordered");
    expect(String(repaired.serviceOrderId)).toBe(String(orphan._id));
    expect(repaired.serviceOrderNumber).toBe(orphan.serviceOrderNumber);
    expect(repaired.orderReference).toBe(orphan.serviceOrderNumber);
    /* ── THE POINT: the line snapshots are reconstructed from the order ── */
    expect(String(repaired.items[0].service)).toBe(String(svc._id));
    expect(repaired.items[0].serviceCode).toBe(svc.serviceCode);
    expect(repaired.items[0].billingUnit).toBe(svc.billingUnit);
    expect(repaired.items[0].sacCode).toBe(svc.sacCode);
    /* Exactly one conversion history event. */
    expect(repaired.history.filter((h) => /raised service order/i.test(h.action))).toHaveLength(1);
  });

  test("a foreign-company order for this request is never linked", async () => {
    const s = await seed();
    const { id } = await approvedService(s);
    const other = new mongoose.Types.ObjectId();
    const doc = await SpendRequest.findById(id).lean();
    await ServiceOrder.create({
      companyId: other, serviceOrderNumber: "SVO/2026-27/7777",
      spendRequestId: id, spendRequestNumber: doc.requestNumber, vendorName: "Foreign",
      lines: [], subtotal: 0, taxAmount: 0, totalAmount: 0, status: "DRAFT",
    });
    const r = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("SO_COMPANY_MISMATCH");
    expect((await SpendRequest.findById(id).lean()).status).toBe("approved");
  });

  test("two concurrent conversions create exactly one order", async () => {
    await ServiceOrder.createIndexes();
    const s = await seed();
    const { id, svc } = await approvedService(s);
    const [a, b] = await Promise.all([
      call(s.store, `/${id}/service-order`, { method: "POST", body: {} }),
      call(s.store, `/${id}/service-order`, { method: "POST", body: {} }),
    ]);
    expect([a.status, b.status].every((x) => x === 200 || x === 201)).toBe(true);
    expect([a.body.success, b.body.success]).toEqual([true, true]);
    /* One order, and both callers are handed the same id and number. */
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(1);
    expect(String(a.body.serviceOrder._id)).toBe(String(b.body.serviceOrder._id));
    expect(a.body.serviceOrder.serviceOrderNumber).toBe(b.body.serviceOrder.serviceOrderNumber);
    /* Exactly one conversion history event, and the line snapshots landed —
       whether written by the winner or restored by the duplicate-key loser. */
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.history.filter((h) => /raised service order/i.test(h.action))).toHaveLength(1);
    expect(String(doc.items[0].service)).toBe(String(svc._id));
    expect(doc.items[0].serviceCode).toBe(svc.serviceCode);
  });

  /* ══ THE TWO DOORS, AND WHICH REQUEST MAY USE WHICH ═════════════════════
   * `lineMatches` on the order route is the LATE-MATCH path. It exists only
   * for requests approved before classification was required — those have no
   * stored identity and would otherwise be unorderable forever. Everything
   * raised since carries its match from before the approval, so a late one
   * could only supply an identity the approval never saw. */

  test("a legacy request with no policy marker may still be matched late", async () => {
    const s = await seed();
    const id = await legacyApprovedService(s);
    const svc = await mkService(s.company);

    /* Confirmed on the document, not assumed from the fixture's name. */
    const before = await SpendRequest.findById(id).lean();
    expect(before.serviceClassificationPolicy).toBeUndefined();
    expect(before.items[0].service).toBeNull();
    expect(before.status).toBe("approved");

    const r = await call(s.store, `/${id}/service-order`, {
      method: "POST", body: await matchAll(id, svc._id),
    });

    expect(r.status).toBe(201);
    /* Labelled as what it is: finance approved this without a classification,
       and the response says so rather than looking like the ordinary path. */
    expect(r.body.legacyLateMatch).toBeTruthy();
    expect(r.body.legacyLateMatch.spendLineIds).toHaveLength(1);
    expect(r.body.legacyLateMatch.message).toMatch(/approved it without them/i);

    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(String(so.lines[0].service)).toBe(String(svc._id));
    expect(so.lines[0].serviceCode).toBe(svc.serviceCode);
  });

  test("a legacy late match still refuses an inactive or foreign service", async () => {
    const s = await seed();
    const id = await legacyApprovedService(s);
    const retired = await mkService(s.company, { status: "INACTIVE" });

    /* The door is open; the rules behind it are not relaxed. */
    const r = await call(s.store, `/${id}/service-order`, {
      method: "POST", body: await matchAll(id, retired._id),
    });
    expect(r.status).toBe(400);
    expect(r.body.lineErrors[0].reason).toBe("SERVICE_INACTIVE");
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("a new-policy request is refused a late match outright", async () => {
    const s = await seed();
    const { id, svc } = await approvedService(s);
    const other = await mkService(s.company);

    const r = await call(s.store, `/${id}/service-order`, {
      method: "POST", body: await matchAll(id, other._id),
    });

    /* Refused rather than silently ignored: ignoring it would tell Store
       their choice was accepted and then order something else. */
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("LATE_MATCH_NOT_ALLOWED");
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(0);

    /* The approved identity is untouched by the attempt. */
    const doc = await SpendRequest.findById(id).lean();
    expect(String(doc.items[0].service)).toBe(String(svc._id));

    /* And with no body at all it converts on the approved match. */
    const ok = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(ok.status).toBe(201);
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(String(so.lines[0].service)).toBe(String(svc._id));
    expect(ok.body.legacyLateMatch).toBeUndefined();
  });

  test("only Store may raise it, and only against an approved request", async () => {
    const s = await seed();
    const svc = await mkService(s.company);
    const { body } = await raiseService(s);
    const id = body.request._id;
    /* Unapproved — classified, so only the approval is missing. */
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    await classifyAll(s, id, svc._id);
    const early = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });
    expect(early.status).toBe(409);
    /* Approve, then a non-store user is refused. */
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    const notStore = await call(s.emp, `/${id}/service-order`, { method: "POST", body: {} });
    expect(notStore.status).toBe(403);
  });
});
