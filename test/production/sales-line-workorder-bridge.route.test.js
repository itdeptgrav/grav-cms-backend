// test/production/sales-line-workorder-bridge.route.test.js
//
// THE CONFIRMED SALES LINE ↔ WORK ORDER BRIDGE, THROUGH THE REAL ROUTES.
//
// Every live creation path, mounted as server.js mounts it, proves that a new
// WorkOrder carries exactly one permanent Sales `lineRef` and one server-proved
// company — and that the read contract answers within one company only.
//
// Tests whose names contain "[identity]" are the ones the mutation check
// re-runs with the stored line reference removed from the creation paths;
// they must fail when it is gone.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const departmentWrites = require("../../Middlewear/departmentWriteGuard");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ReturnRequest = require("../../models/CMS_Models/Manufacturing/Return/ReturnRequest");
const Measurement = require("../../models/Customer_Models/Measurement");
const EmployeeMpc = require("../../models/Customer_Models/Employee_Mpc");
const MeasurementSizeConfig = require("../../models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const { createWorkOrdersAndProgress } = require("../../routes/CMS_Routes/Sales/quotationRoutes");
const bridge = require("../../services/production/salesLineWorkOrderLink.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales", departmentWrites("sales", { entity: "quotation" }),
    require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  app.use("/api/cms/manufacturing/work-orders",
    require("../../routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes"));
  app.use("/api/cms/manufacturing/return-requests",
    require("../../routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

/* ═══ FIXTURES ═════════════════════════════════════════════════════════════ */

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true, text }; }
    return { status: r.status, body: parsed, text };
  });

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `slb${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "L", lastName: `Bridge${n}`, email, biometricId: `SLB${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "U", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "U", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return jwt.sign(
    { id: String(emp._id), email, name: "L", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const journey = await SalesJourney.create({
    journeyId: `SJ-SLB-${n}`, companyId: co._id, accountId: new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "J", isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-SLB-${n}`, journeyId: journey._id, companyId: co._id,
    accountId: new mongoose.Types.ObjectId(), title: "E", isActive: true,
    products: [{ product: "Tee", quantity: 1 }],
  });
  return { co, journey, enquiry };
}

const style = (ctx, label) => SampleStyle.create({
  sampleStyleId: `SS-SLB-${label}-${++seq}`, productName: `Tee ${label}`, styleCode: `ST-SLB-${label}`,
  journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id,
  materials: { status: "pending", rawItems: [] },
  techSheet: { technical: { status: "draft" } },
});

/** A product in two sizes: variants[0] = S, variants[1] = M. */
const product = (label, { routed = true } = {}) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-SLB-${label}-${++seq}`, reference: `REF-SLB-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  operations: routed ? [{ type: "Side seam", operationCode: "SEW-1", totalSeconds: 90 }] : [],
  variants: [
    { sku: `VS-${label}-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "S" }] },
    { sku: `VM-${label}-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] },
  ],
});
const S = 0;
const M = 1;
const sizeOf = (item, i) => ({ variantId: String(item.variants[i]._id), attributes: item.variants[i].attributes.map((a) => ({ name: a.name, value: a.value })) });

/** A request whose quotation awaits Sales approval. `lines`: {item, styleId, size, qty}. */
async function pendingRequest(lines, extra = {}) {
  const items = lines.map(({ item, styleId, size = S, qty = 5 }) => ({
    stockItemId: item._id,
    ...(styleId ? { sampleStyleId: styleId } : {}),
    stockItemName: item.name, stockItemReference: item.reference,
    variants: [{ ...sizeOf(item, size), quantity: qty }],
    totalQuantity: qty,
  }));
  const req = await CustomerRequest.create({
    requestId: `CR-SLB-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: "Northwind Apparel Ltd", email: "b@x.test", phone: "1" },
    items, status: "pending", ...extra,
  });
  req.quotations.push({
    quotationNumber: `QT-SLB-${seq}`, date: new Date(), validUntil: new Date(Date.now() + 8.64e7),
    items: items.map((i) => ({ stockItemId: i.stockItemId, itemName: i.stockItemName, quantity: i.totalQuantity, unitPrice: 0 })),
    grandTotal: 0, status: "sent_to_customer",
  });
  req.status = "quotation_sent";
  await req.save();
  return req;
}

const codeOf = (b) => b?.error?.code || b?.code || null;
const SALES_OK = { sales: "owner" };
const PM_OK = { "project-manager": "owner" };
const PPC_VIEW = { ppc: "viewer" };

const approve = (req, token, co, body = {}) =>
  call(`/api/cms/sales/requests/${req._id}/quotation/sales-approve`,
    { method: "POST", token, company: co, body: { acknowledgeNoCustomerApproval: true, ...body } });
const markInternal = (req, token, co) =>
  call(`/api/cms/sales/requests/${req._id}/mark-internal-order`, { method: "PATCH", token, company: co, body: {} });
const linesView = (refs, token, co) =>
  call(`/api/cms/manufacturing/work-orders/sales-line-links/lines?${refs.map((r) => `lineRef=${encodeURIComponent(r)}`).join("&")}`, { token, company: co });
const workOrdersView = (ids, token, co) =>
  call(`/api/cms/manufacturing/work-orders/sales-line-links/work-orders?workOrderId=${ids.map(String).join(",")}`, { token, company: co });

const wosFor = (req) => WorkOrder.find({ customerRequestId: req._id }).sort({ createdAt: 1, _id: 1 }).lean();
const storedLineRefs = async (req) => (await CustomerRequest.findById(req._id).lean()).items.map((i) => i.lineRef);

/* ═══ SALES RELEASE — BULK ═════════════════════════════════════════════════ */

describe("Sales release (bulk)", () => {
  test("[identity] two lines of the same product each get their own WorkOrder, linked to exactly that line", async () => {
    const ctx = await company("Bulk2");
    const item = await product("Bulk2");
    const s = await style(ctx, "Bulk2");
    /* Same product, same style, SAME size — two delivery commitments. Only the
       permanent line reference can tell these apart. */
    const req = await pendingRequest([
      { item, styleId: s._id, size: M, qty: 3 },
      { item, styleId: s._id, size: M, qty: 7 },
    ]);
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    const res = await approve(req, token, ctx.co._id);
    expect(res.status).toBe(200);

    const refs = await storedLineRefs(req);
    expect(new Set(refs).size).toBe(2);
    const wos = await wosFor(req);
    expect(wos).toHaveLength(2);
    const byRef = new Map(wos.map((w) => [w.salesLineLink?.lineRef, w]));
    expect([...byRef.keys()].sort()).toEqual([...refs].sort());
    for (const [i, ref] of refs.entries()) {
      const wo = byRef.get(ref);
      expect(wo.quantity).toBe([3, 7][i]);
      expect(String(wo.salesLineLink.companyId)).toBe(String(ctx.co._id));
      expect(String(wo.salesLineLink.customerRequestId)).toBe(String(req._id));
      expect(wo.salesLineLink.basis).toBe("sales_line");
    }
  });

  test("[identity] one line in two sizes makes two WorkOrders on the SAME line", async () => {
    const ctx = await company("BulkSizes");
    const item = await product("BulkSizes");
    const s = await style(ctx, "BulkSizes");
    const req = await pendingRequest([{ item, styleId: s._id, size: S, qty: 2 }]);
    await CustomerRequest.updateOne({ _id: req._id }, { $push: { "items.0.variants": { ...sizeOf(item, M), quantity: 4 } } });
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    expect((await approve(req, token, ctx.co._id)).status).toBe(200);
    const [ref] = await storedLineRefs(req);
    const wos = await wosFor(req);
    expect(wos).toHaveLength(2);
    for (const w of wos) expect(w.salesLineLink.lineRef).toBe(ref);
  });

  test("[identity] identity submitted by the browser is ignored", async () => {
    const ctx = await company("Forge");
    const item = await product("Forge");
    const s = await style(ctx, "Forge");
    const other = await company("ForgeOther");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    const res = await approve(req, token, ctx.co._id, {
      lineRef: "LN-aaaaaaaaaaaa", companyId: String(other.co._id),
      salesLineLink: { lineRef: "LN-bbbbbbbbbbbb", companyId: String(other.co._id) },
    });
    expect(res.status).toBe(200);
    const [wo] = await wosFor(req);
    expect(wo.salesLineLink.lineRef).toBe((await storedLineRefs(req))[0]);
    expect(wo.salesLineLink.lineRef).not.toMatch(/^LN-(a|b)+$/);
    expect(String(wo.salesLineLink.companyId)).toBe(String(ctx.co._id));
  });

  test("[identity] a legacy request whose lines have no stored reference is named first, then linked", async () => {
    const ctx = await company("Legacy");
    const item = await product("Legacy");
    const s = await style(ctx, "Legacy");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    /* Strip the reference straight in the collection — a record from before
       line identity existed. */
    await CustomerRequest.collection.updateOne({ _id: req._id }, { $unset: { "items.0.lineRef": "" } });
    expect((await CustomerRequest.findById(req._id).lean()).items[0].lineRef).toBeUndefined();
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    expect((await approve(req, token, ctx.co._id)).status).toBe(200);
    const [stored] = await storedLineRefs(req);
    expect(stored).toMatch(/^LN-[0-9a-f]{12}$/);
    const [wo] = await wosFor(req);
    expect(wo.salesLineLink.lineRef).toBe(stored);
  });

  test("[identity] a retried release reuses the WorkOrder it already made for a line", async () => {
    const ctx = await company("Retry");
    const routed = await product("RetryA");
    const unrouted = await product("RetryB", { routed: false });
    const sA = await style(ctx, "RetryA");
    const sB = await style(ctx, "RetryB");
    const req = await pendingRequest([{ item: routed, styleId: sA._id }, { item: unrouted, styleId: sB._id }]);
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    /* First attempt: the routed line's WorkOrder is saved, then the release
       refuses on the unrouted product — the request itself is not saved. */
    const first = await approve(req, token, ctx.co._id);
    expect(first.status).toBe(409);
    const afterFirst = await wosFor(req);
    expect(afterFirst).toHaveLength(1);

    await StockItem.updateOne({ _id: unrouted._id }, { $set: { operations: [{ type: "Hem", operationCode: "H-1", totalSeconds: 30 }] } });
    const second = await approve(req, token, ctx.co._id);
    expect(second.status).toBe(200);

    const wos = await wosFor(req);
    expect(wos).toHaveLength(2);
    expect(wos.filter((w) => String(w.stockItemId) === String(routed._id)).map((w) => String(w._id)))
      .toEqual([String(afterFirst[0]._id)]);
    expect(new Set(wos.map((w) => w.salesLineLink.lineRef)).size).toBe(2);
  });

  test("a foreign-company actor creates nothing", async () => {
    const owner = await company("ForeignOwner");
    const item = await product("Foreign");
    const s = await style(owner, "Foreign");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    const mine = await company("ForeignActing");
    const token = await actor({ companies: [mine.co], grants: SALES_OK });

    const res = await approve(req, token, mine.co._id);
    expect(res.status).toBe(403);
    expect(await wosFor(req)).toHaveLength(0);
  });

  test("[identity] the internal-order release links too, and numbers stay canonical", async () => {
    const ctx = await company("Internal");
    const item = await product("Internal");
    const s = await style(ctx, "Internal");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    await CustomerRequest.updateOne({ _id: req._id }, { $set: { status: "pending" } });
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    expect((await markInternal(req, token, ctx.co._id)).status).toBe(200);
    const [wo] = await wosFor(req);
    expect(wo.salesLineLink.lineRef).toBe((await storedLineRefs(req))[0]);
    /* WorkOrder numbering (and so every barcode built from it) is unchanged. */
    expect(wo.workOrderNumber).toBe(`WO-${wo._id}`);
  });

  test("[identity] the sampling release (no acting company) links to the style owner's company", async () => {
    const ctx = await company("Sampling");
    const item = await product("Sampling");
    const s = await style(ctx, "Sampling");
    const req = await CustomerRequest.create({
      requestId: `CR-SLB-SMP-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "In-house" }, orderOrigin: "sampling", sampleStyleId: s._id, isInternalOrder: true,
      items: [{ stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference, variants: [{ ...sizeOf(item, S), quantity: 2 }], totalQuantity: 2 }],
      status: "quotation_sales_approved",
    });
    const { createdWorkOrders } = await createWorkOrdersAndProgress(req, new mongoose.Types.ObjectId());
    expect(createdWorkOrders).toHaveLength(1);
    const [wo] = await wosFor(req);
    expect(wo.salesLineLink.lineRef).toBe(req.items[0].lineRef);
    expect(String(wo.salesLineLink.companyId)).toBe(String(ctx.co._id));
  });
});

/* ═══ SALES RELEASE — MEASUREMENT ══════════════════════════════════════════ */

describe("Sales release (measurement)", () => {
  /**
   * A measurement PO for one product on two lines — size S and size M — with
   * one person on each, and a size configuration that resolves Chest < 40 to S
   * and Chest ≥ 40 to M. `people` sets each person's line size and chest.
   */
  async function measurementWorld(name, people, { lineQty = null } = {}) {
    const ctx = await company(name);
    const item = await product(name);
    const s = await style(ctx, name);
    await MeasurementSizeConfig.create({
      name: `${name} chest`, productId: item._id, garmentCategory: "Top", measurementParameter: "Chest",
      createdBy: new mongoose.Types.ObjectId(),
      rules: [
        { fromValue: 0, toValue: 40, sizeValue: "S", variantId: item.variants[S]._id },
        { fromValue: 40, toValue: 99, sizeValue: "M", variantId: item.variants[M]._id },
      ],
    });
    const employees = [];
    for (const p of people) {
      const mpc = await EmployeeMpc.create({
        customerId: new mongoose.Types.ObjectId(), name: `${p.name} ${++seq}`, uin: `U${seq}`, gender: "female",
        productId: item._id, quantity: p.qty || 1, productName: item.name,
      });
      employees.push({
        employeeId: mpc._id, employeeName: mpc.name, employeeUIN: mpc.uin, gender: "female",
        products: [{
          productId: item._id, productName: item.name, variantId: String(item.variants[p.line]._id),
          variantName: p.line === S ? "S" : "M", quantity: p.qty || 1,
          measurements: [{ measurementName: "Chest", value: String(p.chest) }], measuredAt: new Date(),
        }],
        isCompleted: true, completedAt: new Date(),
      });
    }
    const measurement = await Measurement.create({
      organizationId: new mongoose.Types.ObjectId(), organizationName: "Org", name: `M-${++seq}`,
      registeredEmployeeIds: employees.map((e) => e.employeeId), employeeMeasurements: employees,
      totalRegisteredEmployees: employees.length, measuredEmployees: employees.length, pendingEmployees: 0,
      completionRate: 100, createdBy: new mongoose.Types.ObjectId(),
    });
    const qtyOn = (size) => people.filter((p) => p.line === size).reduce((n, p) => n + (p.qty || 1), 0);
    const req = await pendingRequest([
      { item, styleId: s._id, size: S, qty: lineQty?.[S] ?? qtyOn(S) },
      { item, styleId: s._id, size: M, qty: lineQty?.[M] ?? qtyOn(M) },
    ], { requestType: "measurement_conversion", measurementId: measurement._id });
    return { ctx, item, req, employees };
  }

  test("[identity] people are grouped by their confirmed line; no WorkOrder mixes lines", async () => {
    const w = await measurementWorld("MeasOk", [
      { name: "Asha", line: S, chest: 36 },
      { name: "Bharat", line: M, chest: 42, qty: 2 },
    ]);
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await approve(w.req, token, w.ctx.co._id);
    expect(res.status).toBe(200);

    const [refS, refM] = await storedLineRefs(w.req);
    const wos = await wosFor(w.req);
    expect(wos).toHaveLength(2);
    const onS = wos.find((x) => x.salesLineLink.lineRef === refS);
    const onM = wos.find((x) => x.salesLineLink.lineRef === refM);
    expect(onS.variantId).toBe(String(w.item.variants[S]._id));
    expect(onM.variantId).toBe(String(w.item.variants[M]._id));
    expect(onS.quantity).toBe(1);
    expect(onM.quantity).toBe(2);

    const progressS = await EmployeeProductionProgress.find({ workOrderId: onS._id }).lean();
    const progressM = await EmployeeProductionProgress.find({ workOrderId: onM._id }).lean();
    expect(progressS.map((p) => String(p.employeeId))).toEqual([String(w.employees[0].employeeId)]);
    expect(progressM.map((p) => String(p.employeeId))).toEqual([String(w.employees[1].employeeId)]);
    /* Unit ranges are numbered per WorkOrder from 1, as before. */
    expect([progressM[0].unitStart, progressM[0].unitEnd]).toEqual([1, 2]);
    expect(onM.workOrderNumber).toBe(`WO-${onM._id}`);
  });

  test("a person whose measured size conflicts with their line is refused, not moved", async () => {
    /* Bharat is on the S line but measures M. The old factory would have put
       Bharat on an M WorkOrder together with the M line's people. */
    const w = await measurementWorld("MeasConflict", [
      { name: "Asha", line: M, chest: 44 },
      { name: "Bharat", line: S, chest: 45 },
    ]);
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });
    const before = await CustomerRequest.findById(w.req._id).lean();

    const res = await approve(w.req, token, w.ctx.co._id);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe("WORK_ORDER_MEASUREMENT_LINE_CONFLICT");
    const conflict = res.body.error.details.conflicts.find((c) => c.kind === "measured_size_differs");
    expect(conflict.person).toMatch(/^Bharat/);
    expect(conflict.lineSize).toBe("S");
    expect(conflict.measuredSize).toBe("M");
    expect(res.body.message).toMatch(/Sales must move them/);

    expect(await wosFor(w.req)).toHaveLength(0);
    const after = await CustomerRequest.findById(w.req._id).lean();
    expect(after.status).toBe(before.status);
    expect(after.items.map((i) => i.variants.map((v) => [v.variantId, v.quantity])))
      .toEqual(before.items.map((i) => i.variants.map((v) => [v.variantId, v.quantity])));
    expect((await Measurement.findById(w.req.measurementId).lean()).employeeMeasurements[1].products[0].variantId.toString())
      .toBe(String(w.item.variants[S]._id));
  });

  test("a line whose people do not add up to its confirmed quantity is refused", async () => {
    const w = await measurementWorld("MeasQty", [
      { name: "Asha", line: S, chest: 36 },
      { name: "Bharat", line: M, chest: 42 },
    ], { lineQty: { [S]: 1, [M]: 3 } });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await approve(w.req, token, w.ctx.co._id);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe("WORK_ORDER_MEASUREMENT_LINE_CONFLICT");
    const conflict = res.body.error.details.conflicts.find((c) => c.kind === "line_quantity_differs");
    expect(conflict).toMatchObject({ size: "M", confirmedQuantity: 3, peopleQuantity: 1 });
    expect(await wosFor(w.req)).toHaveLength(0);
  });

  test("[identity] a repeated measurement release creates no second WorkOrder on either line", async () => {
    const w = await measurementWorld("MeasRetry", [
      { name: "Asha", line: S, chest: 36 },
      { name: "Bharat", line: M, chest: 42 },
    ]);
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });
    expect((await approve(w.req, token, w.ctx.co._id)).status).toBe(200);
    const first = await wosFor(w.req);
    expect(first).toHaveLength(2);

    const again = await approve(w.req, token, w.ctx.co._id);
    expect(again.status).toBeGreaterThanOrEqual(400);
    const after = await wosFor(w.req);
    expect(after.map((x) => [String(x._id), x.salesLineLink.lineRef]))
      .toEqual(first.map((x) => [String(x._id), x.salesLineLink.lineRef]));
  });

  test("an actor of another company cannot release a measurement order", async () => {
    const w = await measurementWorld("MeasForeign", [{ name: "Asha", line: S, chest: 36 }, { name: "Bharat", line: M, chest: 42 }]);
    const other = await company("MeasForeignOther");
    const token = await actor({ companies: [other.co], grants: SALES_OK });
    const res = await approve(w.req, token, other.co._id);
    expect(res.status).toBe(403);
    expect(await wosFor(w.req)).toHaveLength(0);
  });
});

/* ═══ ADD PRODUCT (measurement person edit) ════════════════════════════════ */

describe("add product to a measurement order", () => {
  const changePerson = (req, employeeId, token, co, body) =>
    call(`/api/cms/sales/requests/${req._id}/person/${employeeId}`, { method: "PUT", token, company: co, body });

  /** Product A carried (with a WorkOrder on the floor); product B on two lines. */
  async function addWorld(name, { bLines }) {
    const ctx = await company(name);
    const a = await product(`${name}A`);
    const b = await product(`${name}B`);
    const sA = await style(ctx, `${name}A`);
    const sB = await style(ctx, `${name}B`);
    const mpc = await EmployeeMpc.create({
      customerId: new mongoose.Types.ObjectId(), name: `P ${++seq}`, uin: `U${seq}`, gender: "female",
      productId: a._id, quantity: 2, productName: a.name,
    });
    const measurement = await Measurement.create({
      organizationId: new mongoose.Types.ObjectId(), organizationName: "Org", name: `M-${++seq}`,
      registeredEmployeeIds: [mpc._id],
      employeeMeasurements: [{
        employeeId: mpc._id, employeeName: mpc.name, employeeUIN: mpc.uin, gender: "female",
        products: [{ productId: a._id, productName: a.name, variantId: String(a.variants[S]._id), variantName: "S", quantity: 2, measurements: [], measuredAt: new Date() }],
        isCompleted: true, completedAt: new Date(),
      }],
      totalRegisteredEmployees: 1, measuredEmployees: 1, pendingEmployees: 0, completionRate: 100,
      createdBy: new mongoose.Types.ObjectId(),
    });
    const req = await pendingRequest([
      { item: a, styleId: sA._id, size: S, qty: 2 },
      ...bLines.map((size) => ({ item: b, styleId: sB._id, size, qty: 1 })),
    ], { requestType: "measurement_conversion", measurementId: measurement._id });
    await WorkOrder.create({
      customerRequestId: req._id, stockItemId: a._id, sampleStyleId: sA._id,
      variantId: String(a.variants[S]._id), quantity: 2, status: "pending",
      operations: [{ operationType: "Side seam", operationCode: "SEW-1", plannedTimeSeconds: 90, status: "pending" }],
    });
    return { ctx, a, b, mpc, req };
  }
  const moveOntoB = (w, token, size) => changePerson(w.req, w.mpc._id, token, w.ctx.co._id, {
    products: [
      { productId: String(w.a._id), variantId: String(w.a.variants[S]._id), quantity: 2, productName: w.a.name },
      { productId: String(w.b._id), variantId: String(w.b.variants[size]._id), quantity: 1, productName: w.b.name },
    ],
  });

  test("[identity] the new WorkOrder is linked to the line with that product AND size, not the first line", async () => {
    const w = await addWorld("AddExact", { bLines: [S, M] });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });
    const [, bS, bM] = await storedLineRefs(w.req);

    const res = await moveOntoB(w, token, M);
    expect(res.status).toBe(200);
    const created = await WorkOrder.findOne({ customerRequestId: w.req._id, stockItemId: w.b._id }).lean();
    expect(created.salesLineLink.lineRef).toBe(bM);
    expect(created.salesLineLink.lineRef).not.toBe(bS);
    expect(String(created.salesLineLink.companyId)).toBe(String(w.ctx.co._id));

    /* The units landed on that same line's quantity, not the first B line. */
    const after = await CustomerRequest.findById(w.req._id).lean();
    const lineOf = (ref) => after.items.find((i) => i.lineRef === ref);
    expect(lineOf(bM).variants[0].quantity).toBe(2);
    expect(lineOf(bS).variants[0].quantity).toBe(1);
  });

  test("two lines with the same product and size refuse as ambiguous and create nothing", async () => {
    const w = await addWorld("AddAmb", { bLines: [M, M] });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await moveOntoB(w, token, M);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe("WORK_ORDER_SALES_LINE_AMBIGUOUS");
    expect(await WorkOrder.countDocuments({ customerRequestId: w.req._id, stockItemId: w.b._id })).toBe(0);
  });
});

/* ═══ SPLIT ════════════════════════════════════════════════════════════════ */

describe("split", () => {
  async function releasedWorkOrder(name) {
    const ctx = await company(name);
    const item = await product(name);
    const s = await style(ctx, name);
    const req = await pendingRequest([{ item, styleId: s._id, qty: 10 }]);
    const sales = await actor({ companies: [ctx.co], grants: SALES_OK });
    expect((await approve(req, sales, ctx.co._id)).status).toBe(200);
    const raw = await RawItem.create({ name: `Fabric ${++seq}`, sku: `RAW-SLB-${seq}`, unit: "m", quantity: 1000, createdBy: new mongoose.Types.ObjectId() });
    const [wo] = await wosFor(req);
    await WorkOrder.collection.updateOne({ _id: wo._id }, { $set: { rawMaterials: [{
      _id: new mongoose.Types.ObjectId(), rawItemId: raw._id, name: raw.name, sku: raw.sku, unit: "m",
      quantityRequired: 20, quantityAllocated: 0, quantityIssued: 0, unitCost: 10, totalCost: 200, allocationStatus: "not_allocated",
    }] } });
    return { ctx, req, wo: await WorkOrder.findById(wo._id).lean(), style: s };
  }
  const split = (wo, token, co) => call(`/api/cms/manufacturing/work-orders/${wo._id}/allocate-raw-materials`,
    { method: "PUT", token, company: co, body: { quantity: 6, splitRemaining: true } });

  test("[identity] the child inherits the parent's line and company exactly; a retry makes no second child", async () => {
    const w = await releasedWorkOrder("Split");
    const pm = await actor({ companies: [w.ctx.co], grants: PM_OK });

    expect((await split(w.wo, pm, w.ctx.co._id)).status).toBe(200);
    const child = await WorkOrder.findOne({ parentWorkOrderId: w.wo._id }).lean();
    expect(child.salesLineLink).toMatchObject({
      lineRef: w.wo.salesLineLink.lineRef, basis: "split_parent",
    });
    expect(String(child.salesLineLink.companyId)).toBe(String(w.ctx.co._id));
    expect(String(child.salesLineLink.customerRequestId)).toBe(String(w.req._id));
    expect(String(child.salesLineLink.parentWorkOrderId)).toBe(String(w.wo._id));

    /* The parent's own link is untouched by the split. */
    const parent = await WorkOrder.findById(w.wo._id).lean();
    expect(parent.salesLineLink.lineRef).toBe(w.wo.salesLineLink.lineRef);
    expect(parent.salesLineLink.basis).toBe("sales_line");

    expect((await split(parent, pm, w.ctx.co._id)).status).toBe(200);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: w.wo._id })).toBe(1);
  });

  test("a historical unlinked parent yields an unlinked child — never a guessed line", async () => {
    const ctx = await company("SplitLegacy");
    const item = await product("SplitLegacy");
    const s = await style(ctx, "SplitLegacy");
    /* Same request, same product, one line — everything a guess would need. */
    const req = await pendingRequest([{ item, styleId: s._id, qty: 10 }]);
    const raw = await RawItem.create({ name: `Fabric ${++seq}`, sku: `RAW-SLB-${seq}`, unit: "m", quantity: 1000, createdBy: new mongoose.Types.ObjectId() });
    const legacy = await WorkOrder.create({
      customerRequestId: req._id, stockItemId: item._id, sampleStyleId: s._id,
      variantId: String(item.variants[S]._id), quantity: 10, originalQuantity: 10, status: "pending",
      operations: [{ operationType: "Side seam", operationCode: "SEW-1", plannedTimeSeconds: 60, status: "pending" }],
      rawMaterials: [{ rawItemId: raw._id, name: raw.name, sku: raw.sku, unit: "m", quantityRequired: 20, quantityAllocated: 0, quantityIssued: 0, unitCost: 10, totalCost: 200, allocationStatus: "not_allocated" }],
    });
    const pm = await actor({ companies: [ctx.co], grants: PM_OK });

    expect((await split(legacy, pm, ctx.co._id)).status).toBe(200);
    const child = await WorkOrder.findOne({ parentWorkOrderId: legacy._id }).lean();
    expect(child).toBeTruthy();
    expect(child.salesLineLink).toBeUndefined();
    expect((await WorkOrder.findById(legacy._id).lean()).salesLineLink).toBeUndefined();
  });

  test("an actor of another company cannot split", async () => {
    const w = await releasedWorkOrder("SplitForeign");
    const other = await company("SplitForeignOther");
    const pm = await actor({ companies: [other.co], grants: PM_OK });

    const res = await split(w.wo, pm, other.co._id);
    expect(res.status).toBe(403);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: w.wo._id })).toBe(0);
  });
});

/* ═══ RETURN / REMAKE ══════════════════════════════════════════════════════ */

describe("return / remake", () => {
  async function returnWorld(name, dispatchType, { sourceLinked = true } = {}) {
    const ctx = await company(name);
    const item = await product(name);
    const s = await style(ctx, name);
    const original = await pendingRequest([{ item, styleId: s._id, qty: 6 }]);
    let source;
    if (sourceLinked) {
      const sales = await actor({ companies: [ctx.co], grants: SALES_OK });
      expect((await approve(original, sales, ctx.co._id)).status).toBe(200);
      [source] = await wosFor(original);
    } else {
      source = await WorkOrder.create({
        customerRequestId: original._id, stockItemId: item._id, sampleStyleId: s._id,
        variantId: String(item.variants[S]._id), quantity: 6, status: "completed",
      });
    }
    const products = (qty) => [{
      stockItemId: item._id, variantId: String(item.variants[S]._id), productName: item.name, productRef: item.reference,
      variantAttributes: [], returnQuantity: qty, workOrderId: source._id,
    }];
    const rr = await ReturnRequest.create({
      returnRequestNumber: `RR-SLB-${++seq}`, originalMoId: original._id,
      dispatchType, status: "store_processing", customerName: "Northwind Apparel Ltd",
      ...(dispatchType === "person_wise"
        ? { persons: [
          { employeeId: new mongoose.Types.ObjectId(), employeeName: "Asha", employeeUIN: `U${seq}A`, gender: "female", products: products(2) },
          { employeeId: new mongoose.Types.ObjectId(), employeeName: "Bharat", employeeUIN: `U${seq}B`, gender: "male", products: products(1) },
        ] }
        : { bulkProducts: products(4) }),
    });
    return { ctx, original, source, rr };
  }
  const createMo = (rr, token, co) =>
    call(`/api/cms/manufacturing/return-requests/${rr._id}/create-mo`, { method: "POST", token, company: co, body: {} });

  for (const dispatchType of ["person_wise", "bulk"]) {
    test(`[identity] ${dispatchType}: the remake carries its OWN return line and an explicit origin`, async () => {
      const w = await returnWorld(`Ret${dispatchType}`, dispatchType);
      const pm = await actor({ companies: [w.ctx.co], grants: PM_OK });

      const res = await createMo(w.rr, pm, w.ctx.co._id);
      expect(res.status).toBe(200);
      const newReq = await CustomerRequest.findById(res.body.newMoId).lean();
      const remakes = await wosFor(newReq);
      expect(remakes).toHaveLength(1);
      const [remake] = remakes;

      expect(remake.salesLineLink.basis).toBe("return_line");
      expect(String(remake.salesLineLink.customerRequestId)).toBe(String(newReq._id));
      expect(remake.salesLineLink.lineRef).toBe(newReq.items[0].lineRef);
      /* Not a claim to be the original line… */
      expect(remake.salesLineLink.lineRef).not.toBe(w.source.salesLineLink.lineRef);
      /* …but it says exactly where it came from. */
      expect(remake.salesLineLink.origin.sourceWorkOrderIds.map(String)).toEqual([String(w.source._id)]);
      expect(String(remake.salesLineLink.origin.originalCustomerRequestId)).toBe(String(w.original._id));
      expect(String(remake.salesLineLink.origin.returnRequestId)).toBe(String(w.rr._id));
      expect(remake.salesLineLink.origin.sourceLines.map((l) => [String(l.customerRequestId), l.lineRef]))
        .toEqual([[String(w.original._id), w.source.salesLineLink.lineRef]]);
      expect(String(remake.salesLineLink.companyId)).toBe(String(w.ctx.co._id));
    });
  }

  test("a remake of an unlinked historical source names no original line", async () => {
    const w = await returnWorld("RetLegacy", "bulk", { sourceLinked: false });
    const pm = await actor({ companies: [w.ctx.co], grants: PM_OK });

    const res = await createMo(w.rr, pm, w.ctx.co._id);
    expect(res.status).toBe(200);
    const [remake] = await wosFor({ _id: res.body.newMoId });
    expect(remake.salesLineLink.basis).toBe("return_line");
    expect(remake.salesLineLink.origin.sourceLines).toEqual([]);
    expect(remake.salesLineLink.origin.sourceWorkOrderIds.map(String)).toEqual([String(w.source._id)]);
  });

  test("an actor of another company cannot remake this company's return, and nothing is created", async () => {
    const w = await returnWorld("RetForeign", "bulk");
    const other = await company("RetForeignOther");
    const pm = await actor({ companies: [other.co], grants: PM_OK });
    const requestsBefore = await CustomerRequest.countDocuments({});

    const res = await createMo(w.rr, pm, other.co._id);
    expect(res.status).toBe(403);
    expect(await CustomerRequest.countDocuments({})).toBe(requestsBefore);
    expect(await WorkOrder.countDocuments({ "salesLineLink.basis": "return_line" })).toBe(0);
    expect((await ReturnRequest.findById(w.rr._id).lean()).status).toBe("store_processing");
  });

  test("[identity] a retried remake makes no second return line or WorkOrder", async () => {
    const w = await returnWorld("RetRetry", "person_wise");
    const pm = await actor({ companies: [w.ctx.co], grants: PM_OK });

    const first = await createMo(w.rr, pm, w.ctx.co._id);
    expect(first.status).toBe(200);
    const remakes = await WorkOrder.find({ "salesLineLink.basis": "return_line" }).lean();
    expect(remakes).toHaveLength(1);

    const again = await createMo(w.rr, pm, w.ctx.co._id);
    expect(again.status).toBe(400);
    const after = await WorkOrder.find({ "salesLineLink.basis": "return_line" }).lean();
    expect(after.map((x) => [String(x._id), x.salesLineLink.lineRef]))
      .toEqual(remakes.map((x) => [String(x._id), x.salesLineLink.lineRef]));
  });
});

/* ═══ THE READ CONTRACT ════════════════════════════════════════════════════ */

describe("read contract", () => {
  async function releasedLine(name) {
    const ctx = await company(name);
    const item = await product(name);
    const s = await style(ctx, name);
    const req = await pendingRequest([{ item, styleId: s._id }]);
    const sales = await actor({ companies: [ctx.co], grants: SALES_OK });
    expect((await approve(req, sales, ctx.co._id)).status).toBe(200);
    const [wo] = await wosFor(req);
    return { ctx, req, item, style: s, wo, lineRef: wo.salesLineLink.lineRef };
  }

  test("[identity] line → WorkOrders and WorkOrder → line, within the actor's company", async () => {
    const w = await releasedLine("Read");
    const viewer = await actor({ companies: [w.ctx.co], grants: PPC_VIEW });

    const lines = await linesView([w.lineRef, "LN-000000000000"], viewer, w.ctx.co._id);
    expect(lines.status).toBe(200);
    expect(lines.body.lines[0]).toMatchObject({
      lineRef: w.lineRef, state: "linked", customerRequestId: String(w.req._id),
    });
    expect(lines.body.lines[0].workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);
    expect(lines.body.lines[0].workOrders[0]).toMatchObject({ basis: "sales_line", workOrderNumber: w.wo.workOrderNumber });
    expect(lines.body.lines[1]).toMatchObject({ lineRef: "LN-000000000000", state: "unlinked", workOrders: [] });

    const back = await workOrdersView([w.wo._id], viewer, w.ctx.co._id);
    expect(back.status).toBe(200);
    expect(back.body.workOrders[0]).toMatchObject({ workOrderId: String(w.wo._id), state: "linked", lineRef: w.lineRef });
  });

  test("another company's line and WorkOrder read as unlinked and disclose nothing", async () => {
    const theirs = await releasedLine("ReadTheirs");
    const mine = await company("ReadMine");
    const viewer = await actor({ companies: [mine.co], grants: PPC_VIEW });

    const lines = await linesView([theirs.lineRef], viewer, mine.co._id);
    expect(lines.status).toBe(200);
    expect(lines.body.lines).toEqual([{ lineRef: theirs.lineRef, state: "unlinked", customerRequestId: null, workOrders: [], returnWorkOrders: [] }]);

    const back = await workOrdersView([theirs.wo._id], viewer, mine.co._id);
    expect(back.body.workOrders).toEqual([{ workOrderId: String(theirs.wo._id), state: "unlinked" }]);

    for (const secret of [String(theirs.ctx.co._id), String(theirs.req._id), theirs.wo.workOrderNumber]) {
      expect(lines.text).not.toContain(secret);
      expect(back.text).not.toContain(secret);
    }

    /* And naming their company in the header does not help a non-member: the
       header only selects among the actor's own memberships. */
    const forged = await linesView([theirs.lineRef], viewer, theirs.ctx.co._id);
    if (forged.status === 200) {
      expect(forged.body.companyId).toBe(String(mine.co._id));
      expect(forged.body.lines[0].state).toBe("unlinked");
    } else {
      expect(forged.status).toBeGreaterThanOrEqual(400);
    }
    expect(forged.text).not.toContain(theirs.wo.workOrderNumber);
  });

  test("historical WorkOrders stay unlinked even when product, request and style all match", async () => {
    const w = await releasedLine("ReadLegacy");
    const legacy = await WorkOrder.create({
      customerRequestId: w.req._id, stockItemId: w.item._id, sampleStyleId: w.style._id,
      variantId: String(w.item.variants[S]._id), quantity: 5, status: "pending",
    });
    const viewer = await actor({ companies: [w.ctx.co], grants: PPC_VIEW });

    const lines = await linesView([w.lineRef], viewer, w.ctx.co._id);
    expect(lines.body.lines[0].workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);
    const back = await workOrdersView([legacy._id], viewer, w.ctx.co._id);
    expect(back.body.workOrders).toEqual([{ workOrderId: String(legacy._id), state: "unlinked" }]);
  });

  test("[identity] a split child and a remake are reported against the line", async () => {
    const w = await releasedLine("ReadFamily");
    const raw = await RawItem.create({ name: `Fabric ${++seq}`, sku: `RAW-SLB-${seq}`, unit: "m", quantity: 1000, createdBy: new mongoose.Types.ObjectId() });
    await WorkOrder.collection.updateOne({ _id: w.wo._id }, { $set: { rawMaterials: [{
      _id: new mongoose.Types.ObjectId(), rawItemId: raw._id, name: raw.name, sku: raw.sku, unit: "m",
      quantityRequired: 10, quantityAllocated: 0, quantityIssued: 0, unitCost: 1, totalCost: 10, allocationStatus: "not_allocated",
    }] } });
    const pm = await actor({ companies: [w.ctx.co], grants: PM_OK });
    expect((await call(`/api/cms/manufacturing/work-orders/${w.wo._id}/allocate-raw-materials`,
      { method: "PUT", token: pm, company: w.ctx.co._id, body: { quantity: 3, splitRemaining: true } })).status).toBe(200);

    const rr = await ReturnRequest.create({
      returnRequestNumber: `RR-SLB-${++seq}`, originalMoId: w.req._id, dispatchType: "bulk", status: "store_processing",
      customerName: "N", bulkProducts: [{ stockItemId: w.item._id, variantId: String(w.item.variants[S]._id), productName: w.item.name, variantAttributes: [], returnQuantity: 1, workOrderId: w.wo._id }],
    });
    const made = await call(`/api/cms/manufacturing/return-requests/${rr._id}/create-mo`, { method: "POST", token: pm, company: w.ctx.co._id, body: {} });
    expect(made.status).toBe(200);

    const viewer = await actor({ companies: [w.ctx.co], grants: PPC_VIEW });
    const [line] = (await linesView([w.lineRef], viewer, w.ctx.co._id)).body.lines;
    expect(line.workOrders.map((x) => x.basis).sort()).toEqual(["sales_line", "split_parent"]);
    expect(line.returnWorkOrders).toHaveLength(1);
    expect(line.returnWorkOrders[0].origin.sourceLines).toEqual([{ customerRequestId: String(w.req._id), lineRef: w.lineRef }]);
  });

  test("requires a PPC read role and company membership", async () => {
    const w = await releasedLine("ReadAuth");
    const salesOnly = await actor({ companies: [w.ctx.co], grants: SALES_OK });
    expect((await linesView([w.lineRef], salesOnly, w.ctx.co._id)).status).toBe(403);

    const nonMember = await actor({ companies: [], grants: PPC_VIEW });
    const r = await linesView([w.lineRef], nonMember, w.ctx.co._id);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(r.body)).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    const tooMany = Array.from({ length: bridge.MAX_KEYS + 1 }, (_, i) => `LN-${String(i).padStart(12, "0")}`);
    const viewer = await actor({ companies: [w.ctx.co], grants: PPC_VIEW });
    expect((await linesView(tooMany, viewer, w.ctx.co._id)).status).toBe(400);
  });
});

/* ═══ THE MODEL ════════════════════════════════════════════════════════════ */

describe("WorkOrder model", () => {
  const link = (requestId, over = {}) => ({
    companyId: new mongoose.Types.ObjectId(), customerRequestId: requestId,
    lineRef: "LN-0123456789ab", basis: "sales_line", ...over,
  });

  test("a historical WorkOrder saves unrelated edits and stays without a link", async () => {
    const legacy = await WorkOrder.create({ customerRequestId: new mongoose.Types.ObjectId(), quantity: 3, status: "pending" });
    legacy.priority = "high";
    await legacy.save();
    const raw = await WorkOrder.collection.findOne({ _id: legacy._id });
    expect("salesLineLink" in raw).toBe(false);
  });

  test("a link cannot be added to, or changed on, an existing WorkOrder", async () => {
    const reqId = new mongoose.Types.ObjectId();
    const legacy = await WorkOrder.create({ customerRequestId: reqId, quantity: 3, status: "pending" });
    legacy.salesLineLink = link(reqId);
    await expect(legacy.save()).rejects.toThrow(/cannot be added or changed/);

    const linked = await WorkOrder.create({ customerRequestId: reqId, quantity: 3, status: "pending", salesLineLink: link(reqId) });
    linked.salesLineLink.lineRef = "LN-ba9876543210";
    await expect(linked.save()).rejects.toThrow(/cannot be added or changed/);
    linked.salesLineLink = undefined;
    await expect(linked.save()).rejects.toThrow(/cannot be added or changed/);
  });

  test("a new link must name the WorkOrder's own request and a real line reference", async () => {
    const reqId = new mongoose.Types.ObjectId();
    await expect(WorkOrder.create({
      customerRequestId: reqId, quantity: 1, salesLineLink: link(new mongoose.Types.ObjectId()),
    })).rejects.toThrow(/different customer request/);
    await expect(WorkOrder.create({
      customerRequestId: reqId, quantity: 1, salesLineLink: link(reqId, { lineRef: "LINE-1" }),
    })).rejects.toThrow();
    await expect(WorkOrder.create({
      customerRequestId: reqId, quantity: 1, salesLineLink: link(reqId, { companyId: undefined }),
    })).rejects.toThrow();
  });
});
