// test/industrial-engineering/ie-chunk-1d-writers.route.test.js
//
// IE CHUNK 1D — ALL SIX WORK-ORDER WRITERS, THROUGH THEIR REAL ROUTES.
//
// An earlier version of this file claimed six-writer route coverage while
// mounting only the Sales router and exercising only the main approval path.
// It also mounted that router BARE — without the department guard server.js
// puts in front of it — and then proved that an employee in department `Tech`
// could approve a Sales order. That was the test's fault, not the route's, and
// it is why this file now mounts each router exactly as server.js does.
//
// ── TWO INDEPENDENT CHECKS, AND NEITHER SUBSTITUTES FOR THE OTHER ───────────
// Department authority answers "may you perform this act". Company membership
// answers "whose books are you in". The shared membership service says so in
// its own header: it provides identity and company scope, deliberately not
// capability. Every writer below is proved to enforce both.
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

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  /* Mounted exactly as server.js mounts them — the Sales prefix behind its
     department guard, the two Manufacturing routers bare because their own
     per-route guards are what governs the writers under test. */
  app.use("/api/cms/sales", departmentWrites("sales", { entity: "quotation" }),
    require("../../routes/CMS_Routes/Sales/quotationRoutes"));
  app.use("/api/cms/manufacturing/work-orders",
    require("../../routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes"));
  app.use("/api/cms/manufacturing/return-requests",
    require("../../routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes"));
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

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
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

/**
 * An actor with explicit department grants and company memberships.
 * `grants` is `{ slug: role }`; an approver/owner commits directly, an editor's
 * write is queued as a ChangeRequest by the shared guard.
 */
async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `w6${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "W", lastName: `Six${n}`, email, biometricId: `W6${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "U", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "W" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "U", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return jwt.sign(
    { id: String(emp._id), email, name: "W", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const journey = await SalesJourney.create({
    journeyId: `SJ-6-${n}`, companyId: co._id, accountId: new mongoose.Types.ObjectId(),
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "J", isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-6-${n}`, journeyId: journey._id, companyId: co._id,
    accountId: new mongoose.Types.ObjectId(), title: "E", isActive: true,
    products: [{ product: "Tee", quantity: 1 }],
  });
  return { co, journey, enquiry };
}

const style = (ctx, label) => SampleStyle.create({
  sampleStyleId: `SS-6-${label}-${++seq}`, productName: `Tee ${label}`, styleCode: `ST-6-${label}`,
  journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id,
  materials: { status: "pending", rawItems: [] },
  techSheet: { technical: { status: "draft" } },
});

const product = (label) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-6-${label}-${++seq}`, reference: `REF-6-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  operations: [{ type: "Side seam", operationCode: "SEW-1", totalSeconds: 90 }],
  variants: [{ sku: `VAR-6-${label}-${seq}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }],
});

async function pendingRequest(lines, extra = {}) {
  const items = lines.map(({ item, styleId, qty = 5 }) => ({
    stockItemId: item._id,
    ...(styleId ? { sampleStyleId: styleId } : {}),
    stockItemName: item.name, stockItemReference: item.reference,
    variants: [{ variantId: String(item.variants[0]._id), attributes: [{ name: "Size", value: "M" }], quantity: qty }],
    totalQuantity: qty,
  }));
  const req = await CustomerRequest.create({
    requestId: `CR-6-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: "Northwind Apparel Ltd", email: "b@x.test", phone: "1" },
    items, status: "pending", ...extra,
  });
  req.quotations.push({
    quotationNumber: `QT-6-${seq}`, date: new Date(), validUntil: new Date(Date.now() + 8.64e7),
    items: items.map((i) => ({ stockItemId: i.stockItemId, itemName: i.stockItemName, quantity: i.totalQuantity, unitPrice: 0 })),
    grandTotal: 0, status: "sent_to_customer",
  });
  req.status = "quotation_sent";
  await req.save();
  return req;
}

/**
 * Put a department into the "an administrator has configured roles" state.
 *
 * `departmentWrites` fails OPEN until a department has its first role — that is
 * deliberate, and it is what makes the guard safe to add to a live department.
 * So a refusal test has to configure the department first (against somebody
 * else), or it is measuring the fail-open path rather than the guard.
 */
const configureDepartment = (departmentSlug) => DepartmentRole.create({
  departmentSlug, email: `admin-${departmentSlug}-${++seq}@grav.test`, name: "Configured",
  role: "owner", isActive: true, departmentId: new mongoose.Types.ObjectId(),
});

const codeOf = (b) => b?.error?.code || b?.code || null;
const SALES_OK = { sales: "owner" };
const PM_OK = { "project-manager": "owner" };

const approve = (req, token, co) =>
  call(`/api/cms/sales/requests/${req._id}/quotation/sales-approve`,
    { method: "POST", token, company: co, body: { acknowledgeNoCustomerApproval: true } });

const wosFor = (req) => WorkOrder.find({ customerRequestId: req._id }).lean();

/* ══ WRITER 1 — MAIN SALES APPROVAL ═══════════════════════════════════════ */

describe("writer 1 — main Sales approval (authority: sales)", () => {
  const build = async (name, lines) => {
    const ctx = await company(name);
    const items = [];
    for (const l of lines) items.push({ ...l, item: await product(`${name}${items.length}`) });
    const withStyles = [];
    for (const l of items) {
      withStyles.push({ item: l.item, styleId: l.linked === false ? null : (await style(ctx, `${name}${withStyles.length}`))._id });
    }
    return { ctx, req: await pendingRequest(withStyles), items, withStyles };
  };

  test("an authorised Sales member releases, and the exact line style is stored", async () => {
    const { ctx, req, withStyles } = await build("W1", [{}, {}]);
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    expect((await approve(req, token, ctx.co._id)).status).toBe(200);
    const created = await wosFor(req);
    expect(created).toHaveLength(2);
    const byProduct = Object.fromEntries(created.map((w) => [String(w.stockItemId), String(w.sampleStyleId)]));
    for (const line of withStyles) {
      expect(byProduct[String(line.item._id)]).toBe(String(line.styleId));
    }
    for (const w of created) expect(mongoose.Types.ObjectId.isValid(w.sampleStyleId)).toBe(true);
  });

  test("an actor without Sales authority is refused and writes nothing", async () => {
    const { ctx, req } = await build("W1Dept", [{}]);
    await configureDepartment("sales");
    /* A member of the company, in a real department — but not Sales. This is
       the case the previous test file wrongly proved was allowed. */
    const token = await actor({ companies: [ctx.co], grants: { "project-manager": "owner" } });
    const res = await approve(req, token, ctx.co._id);
    expect([401, 403]).toContain(res.status);
    expect(await wosFor(req)).toHaveLength(0);
  });

  test("a company non-member with Sales authority is refused and writes nothing", async () => {
    const { ctx, req } = await build("W1Member", [{}]);
    await company("W1MemberOther");
    const token = await actor({ companies: [], grants: SALES_OK });
    const res = await approve(req, token, ctx.co._id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res.body)).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(await wosFor(req)).toHaveLength(0);
  });

  test("unresolved, ambiguous and foreign evidence each refuse with their typed code", async () => {
    /* unresolved */
    const a = await build("W1Unres", [{ linked: false }]);
    const t1 = await actor({ companies: [a.ctx.co], grants: SALES_OK });
    const r1 = await approve(a.req, t1, a.ctx.co._id);
    expect(r1.status).toBe(400);
    expect(codeOf(r1.body)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
    expect(await wosFor(a.req)).toHaveLength(0);

    /* ambiguous — two lines, one product, two styles */
    const ctx = await company("W1Amb");
    const shared = await product("W1Amb");
    const s1 = await style(ctx, "W1AmbA");
    const s2 = await style(ctx, "W1AmbB");
    const req = await pendingRequest([{ item: shared, styleId: s1._id }, { item: shared, styleId: s2._id }]);
    const t2 = await actor({ companies: [ctx.co], grants: SALES_OK });
    const r2 = await approve(req, t2, ctx.co._id);
    expect(r2.status).toBe(409);
    expect(codeOf(r2.body)).toBe("WORK_ORDER_STYLE_LINK_AMBIGUOUS");
    expect(await wosFor(req)).toHaveLength(0);

    /* foreign — a member of another company */
    const b = await build("W1Foreign", [{}]);
    const mine = await company("W1Acting");
    const t3 = await actor({ companies: [mine.co], grants: SALES_OK });
    const r3 = await approve(b.req, t3, mine.co._id);
    expect(r3.status).toBe(403);
    expect(codeOf(r3.body)).toBe("WORK_ORDER_STYLE_COMPANY_MISMATCH");
    expect(JSON.stringify(r3.body)).not.toMatch(String(b.ctx.co._id));
    expect(await wosFor(b.req)).toHaveLength(0);
  });

  test("a multi-company actor must choose", async () => {
    const { ctx, req } = await build("W1Multi", [{}]);
    const second = await company("W1MultiSecond");
    const token = await actor({ companies: [ctx.co, second.co], grants: SALES_OK });
    const res = await approve(req, token, null);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe("COMPANY_SELECTION_REQUIRED");
    expect(await wosFor(req)).toHaveLength(0);
  });
});

/* ══ WRITER 2 — INTERNAL / COMPANY-ORDER RELEASE ══════════════════════════ */

describe("writer 2 — internal order release (authority: sales)", () => {
  const markInternal = (req, token, co) =>
    call(`/api/cms/sales/requests/${req._id}/mark-internal-order`,
      { method: "PATCH", token, company: co, body: {} });

  test("stores the exact line style", async () => {
    const ctx = await company("W2");
    const item = await product("W2");
    const s = await style(ctx, "W2");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    await CustomerRequest.updateOne({ _id: req._id }, { $set: { status: "pending" } });
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    const res = await markInternal(req, token, ctx.co._id);
    expect(res.status).toBe(200);
    const created = await wosFor(req);
    expect(created.length).toBeGreaterThan(0);
    for (const w of created) expect(String(w.sampleStyleId)).toBe(String(s._id));
  });

  test("refuses without Sales authority, and refuses an unlinked line typed", async () => {
    const ctx = await company("W2Refuse");
    const item = await product("W2Refuse");
    const bare = await pendingRequest([{ item }]);
    await CustomerRequest.updateOne({ _id: bare._id }, { $set: { status: "pending" } });

    await configureDepartment("sales");
    const wrongDept = await actor({ companies: [ctx.co], grants: PM_OK });
    expect([401, 403]).toContain((await markInternal(bare, wrongDept, ctx.co._id)).status);
    expect(await wosFor(bare)).toHaveLength(0);

    const sales = await actor({ companies: [ctx.co], grants: SALES_OK });
    const res = await markInternal(bare, sales, ctx.co._id);
    expect(res.status).toBe(400);
    expect(codeOf(res.body)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
    expect(await wosFor(bare)).toHaveLength(0);
  });
});

/* ══ WRITER 3 — ADD-VARIANT ═══════════════════════════════════════════════ */

describe("writer 3 — add-variant work order (authority: sales)", () => {
  const changePerson = (req, employeeId, token, co, body) =>
    call(`/api/cms/sales/requests/${req._id}/person/${employeeId}`,
      { method: "PUT", token, company: co, body });

  /**
   * A measurement-conversion PO that already has one work order on the floor,
   * with a person carrying NO units of a second product. Moving them onto that
   * product is the case `createWorkOrderForVariant` exists for: the PO has
   * never carried it, so a work order must be built for it.
   */
  async function measurementWorld(name, { secondLineStyle = "own", extraLine = null } = {}) {
    const ctx = await company(name);
    const carried = await product(`${name}A`);
    const added = await product(`${name}B`);
    const carriedStyle = await style(ctx, `${name}A`);
    const addedStyle = secondLineStyle === "own" ? await style(ctx, `${name}B`) : secondLineStyle;

    const mpc = await EmployeeMpc.create({
      customerId: new mongoose.Types.ObjectId(), name: `Person ${++seq}`,
      uin: `UIN${seq}`, gender: "female",
      productId: carried._id, quantity: 2, productName: carried.name,
    });
    const measurement = await Measurement.create({
      organizationId: new mongoose.Types.ObjectId(), organizationName: "Org",
      name: `M-${++seq}`, registeredEmployeeIds: [mpc._id],
      employeeMeasurements: [{
        employeeId: mpc._id, employeeName: mpc.name, employeeUIN: mpc.uin, gender: "female",
        products: [{
          productId: carried._id, productName: carried.name, variantId: String(carried.variants[0]._id),
          variantName: "M", quantity: 2, measurements: [], measuredAt: new Date(),
        }],
        isCompleted: true, completedAt: new Date(),
      }],
      totalRegisteredEmployees: 1, measuredEmployees: 1, pendingEmployees: 0, completionRate: 100,
      createdBy: new mongoose.Types.ObjectId(),
    });

    const lines = [{ item: carried, styleId: carriedStyle._id, qty: 2 }];
    /* The second product's line: linked, unlinked, or duplicated — this is the
       evidence `createWorkOrderForVariant` must prove or refuse on. */
    if (addedStyle !== null) lines.push({ item: added, styleId: addedStyle._id ?? addedStyle, qty: 1 });
    else lines.push({ item: added, styleId: null, qty: 1 });
    if (extraLine) lines.push({ item: added, styleId: extraLine._id, qty: 1 });

    const req = await pendingRequest(lines, {
      requestType: "measurement_conversion", measurementId: measurement._id,
    });
    /* One work order already on the floor, so `hasWorkOrders` is true and the
       add-variant branch is reachable. */
    await WorkOrder.create({
      workOrderNumber: `WO-MC-${++seq}`, customerRequestId: req._id,
      stockItemId: carried._id, sampleStyleId: carriedStyle._id,
      variantId: String(carried.variants[0]._id), quantity: 2, status: "pending",
      operations: [{ operationType: "Side seam", operationCode: "SEW-1", plannedTimeSeconds: 90, status: "pending" }],
    });
    return { ctx, req, mpc, added, addedStyle, carried };
  }

  const moveOnto = (w, token, co) => changePerson(w.req, w.mpc._id, token, co, {
    products: [
      { productId: String(w.carried._id), variantId: String(w.carried.variants[0]._id), quantity: 2, productName: w.carried.name },
      { productId: String(w.added._id), variantId: String(w.added.variants[0]._id), quantity: 3, productName: w.added.name },
    ],
  });

  test("creates a real work order carrying the exact request-line style", async () => {
    const w = await measurementWorld("W3Real");
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await moveOnto(w, token, w.ctx.co._id);
    expect(res.status).toBe(200);

    /* A genuinely NEW work order for the product the PO never carried. */
    const created = await WorkOrder.findOne({
      customerRequestId: w.req._id, stockItemId: w.added._id,
    }).lean();
    expect(created).toBeTruthy();
    expect(String(created.sampleStyleId)).toBe(String(w.addedStyle._id));
    expect(mongoose.Types.ObjectId.isValid(created.sampleStyleId)).toBe(true);
  });

  test("an unlinked line refuses typed, before any work order or request write", async () => {
    const w = await measurementWorld("W3Unlinked", { secondLineStyle: null });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });
    const beforeWo = await WorkOrder.countDocuments({ customerRequestId: w.req._id });
    const beforeItems = (await CustomerRequest.findById(w.req._id).lean()).items.length;

    const res = await moveOnto(w, token, w.ctx.co._id);
    expect(res.status).toBe(400);
    expect(codeOf(res.body)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
    expect(await WorkOrder.countDocuments({ customerRequestId: w.req._id })).toBe(beforeWo);
    expect((await CustomerRequest.findById(w.req._id).lean()).items.length).toBe(beforeItems);
  });

  test("duplicate lines for the added product refuse as ambiguous", async () => {
    const ctx = await company("W3AmbCtx");
    const dupe = await style(ctx, "W3AmbDupe");
    const w = await measurementWorld("W3Amb", { extraLine: dupe });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await moveOnto(w, token, w.ctx.co._id);
    expect(res.status).toBe(409);
    expect(codeOf(res.body)).toBe("WORK_ORDER_STYLE_LINK_AMBIGUOUS");
    expect(await WorkOrder.countDocuments({ customerRequestId: w.req._id, stockItemId: w.added._id }))
      .toBe(0);
  });

  test("a foreign-company style refuses non-disclosingly", async () => {
    const foreign = await company("W3ForeignOwner");
    const foreignStyle = await style(foreign, "W3Foreign");
    const w = await measurementWorld("W3ForeignActing", { secondLineStyle: foreignStyle });
    const token = await actor({ companies: [w.ctx.co], grants: SALES_OK });

    const res = await moveOnto(w, token, w.ctx.co._id);
    expect(res.status).toBe(403);
    expect(codeOf(res.body)).toBe("WORK_ORDER_STYLE_COMPANY_MISMATCH");
    expect(JSON.stringify(res.body)).not.toMatch(String(foreign.co._id));
    expect(await WorkOrder.countDocuments({ customerRequestId: w.req._id, stockItemId: w.added._id }))
      .toBe(0);
  });

  test("is refused without Sales authority, and by a company non-member", async () => {
    const w = await measurementWorld("W3Auth");
    await configureDepartment("sales");
    const wrongDept = await actor({ companies: [w.ctx.co], grants: PM_OK });
    expect([401, 403]).toContain((await moveOnto(w, wrongDept, w.ctx.co._id)).status);
    expect(await WorkOrder.countDocuments({ customerRequestId: w.req._id, stockItemId: w.added._id }))
      .toBe(0);

    const w2 = await measurementWorld("W3Member");
    await company("W3MemberOther");
    const nonMember = await actor({ companies: [], grants: SALES_OK });
    const res = await moveOnto(w2, nonMember, w2.ctx.co._id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(res.body)).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(await WorkOrder.countDocuments({ customerRequestId: w2.req._id, stockItemId: w2.added._id }))
      .toBe(0);
  });
});

/* ══ WRITER 4 — WORK-ORDER SPLIT ══════════════════════════════════════════ */

describe("writer 4 — work-order split (authority: project-manager)", () => {
  async function splittable(ctx, styleId, { canonical = true } = {}) {
    const raw = await RawItem.create({
      name: `Fabric ${++seq}`, sku: `RAW-${seq}`, unit: "m", quantity: 1000,
      createdBy: new mongoose.Types.ObjectId(),
    });
    return WorkOrder.create({
      workOrderNumber: `WO-SPLIT-${++seq}`, quantity: 10, originalQuantity: 10, status: "pending",
      ...(canonical ? { sampleStyleId: styleId } : {}),
      operations: [{ operationType: "Side seam", operationCode: "SEW-1", plannedTimeSeconds: 60, status: "pending" }],
      rawMaterials: [{
        rawItemId: raw._id, name: raw.name, sku: raw.sku, unit: "m",
        quantityRequired: 20, quantityAllocated: 0, quantityIssued: 0,
        unitCost: 10, totalCost: 200, allocationStatus: "not_allocated",
      }],
    });
  }
  const split = (wo, token, co) =>
    call(`/api/cms/manufacturing/work-orders/${wo._id}/allocate-raw-materials`,
      { method: "PUT", token, company: co, body: { quantity: 6, splitRemaining: true } });

  test("an authorised PM splits, and the child carries the resolved source style", async () => {
    const ctx = await company("W4");
    const s = await style(ctx, "W4");
    const wo = await splittable(ctx, s._id);
    const token = await actor({ companies: [ctx.co], grants: PM_OK });

    const res = await split(wo, token, ctx.co._id);
    expect(res.status).toBe(200);
    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();
    expect(child).toBeTruthy();
    expect(String(child.sampleStyleId)).toBe(String(s._id));
  });

  test("without PM authority it is refused and no child exists", async () => {
    const ctx = await company("W4Dept");
    const s = await style(ctx, "W4Dept");
    const wo = await splittable(ctx, s._id);
    await configureDepartment("project-manager");
    const token = await actor({ companies: [ctx.co], grants: { sales: "owner" } });

    const res = await split(wo, token, ctx.co._id);
    expect([401, 403]).toContain(res.status);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: wo._id })).toBe(0);
  });

  test("a company non-member is refused, and an unresolvable source refuses typed", async () => {
    const ctx = await company("W4Member");
    await company("W4MemberOther");
    const s = await style(ctx, "W4Member");
    const wo = await splittable(ctx, s._id);

    const nonMember = await actor({ companies: [], grants: PM_OK });
    const r1 = await split(wo, nonMember, ctx.co._id);
    expect(r1.status).toBeGreaterThanOrEqual(400);
    expect(codeOf(r1.body)).toBe("TENANT_MEMBERSHIP_UNPROVEN");
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: wo._id })).toBe(0);

    /* A legacy source nothing can resolve: refused, never a null child. */
    const orphan = await splittable(ctx, null, { canonical: false });
    const member = await actor({ companies: [ctx.co], grants: PM_OK });
    const r2 = await split(orphan, member, ctx.co._id);
    expect(r2.status).toBe(400);
    expect(codeOf(r2.body)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: orphan._id })).toBe(0);
  });
});

/* ══ WRITERS 5 & 6 — RETURN / REMAKE ══════════════════════════════════════ */

describe("writers 5 & 6 — return remake (authority: project-manager)", () => {
  async function returnWorld(name, dispatchType, { canonical = true } = {}) {
    const ctx = await company(name);
    const item = await product(name);
    const s = await style(ctx, name);
    const originalMo = await CustomerRequest.create({
      requestId: `REQ-ORIG-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "Northwind Apparel Ltd", email: "b@x.test" },
      status: "quotation_sales_approved",
    });
    const source = await WorkOrder.create({
      workOrderNumber: `WO-RET-SRC-${++seq}`, customerRequestId: originalMo._id,
      stockItemId: item._id, ...(canonical ? { sampleStyleId: s._id } : {}),
      quantity: 6, status: "completed",
    });
    const products = (qty) => [{
      stockItemId: item._id, variantId: "", productName: item.name, productRef: item.reference,
      variantAttributes: [], returnQuantity: qty, workOrderId: source._id,
    }];
    const rr = await ReturnRequest.create({
      returnRequestNumber: `RR-6-${++seq}`, originalMoId: originalMo._id,
      dispatchType, status: "store_processing", customerName: "Northwind Apparel Ltd",
      ...(dispatchType === "person_wise"
        ? { persons: [
          { employeeId: new mongoose.Types.ObjectId(), employeeName: "Asha", employeeUIN: `U${seq}A`, gender: "female", products: products(2) },
          { employeeId: new mongoose.Types.ObjectId(), employeeName: "Bharat", employeeUIN: `U${seq}B`, gender: "male", products: products(3) },
        ] }
        : { bulkProducts: products(4) }),
    });
    return { ctx, item, style: s, source, rr };
  }
  const createMo = (rr, token, co) =>
    call(`/api/cms/manufacturing/return-requests/${rr._id}/create-mo`,
      { method: "POST", token, company: co, body: {} });
  const remade = (source) => WorkOrder.find({
    _id: { $ne: source._id }, workOrderNumber: { $not: /^WO-RET-SRC-/ },
  }).lean();

  for (const [label, dispatchType] of [["5 — person-wise", "person_wise"], ["6 — bulk", "bulk"]]) {
    test(`${label}: an authorised PM remakes, and the style is inherited from the source`, async () => {
      const w = await returnWorld(`W${dispatchType}`, dispatchType);
      const token = await actor({ companies: [w.ctx.co], grants: PM_OK });

      const res = await createMo(w.rr, token, w.ctx.co._id);
      expect(res.status).toBe(200);
      const created = await remade(w.source);
      expect(created.length).toBeGreaterThan(0);
      for (const wo of created) expect(String(wo.sampleStyleId)).toBe(String(w.style._id));
    });

    test(`${label}: refused without PM authority, and nothing downstream is written`, async () => {
      const w = await returnWorld(`W${dispatchType}Dept`, dispatchType);
      await configureDepartment("project-manager");
      const token = await actor({ companies: [w.ctx.co], grants: { sales: "owner" } });
      const before = await WorkOrder.countDocuments();

      const res = await createMo(w.rr, token, w.ctx.co._id);
      expect([401, 403]).toContain(res.status);
      expect(await WorkOrder.countDocuments()).toBe(before);
      /* And the return itself did not advance. */
      expect((await ReturnRequest.findById(w.rr._id).lean()).status).toBe("store_processing");
    });

    test(`${label}: an unresolvable source refuses typed, before any record`, async () => {
      const w = await returnWorld(`W${dispatchType}Orphan`, dispatchType, { canonical: false });
      const token = await actor({ companies: [w.ctx.co], grants: PM_OK });
      const beforeWo = await WorkOrder.countDocuments();
      const beforeReq = await CustomerRequest.countDocuments();

      const res = await createMo(w.rr, token, w.ctx.co._id);
      expect(res.status).toBe(400);
      expect(codeOf(res.body)).toBe("WORK_ORDER_STYLE_LINK_REQUIRED");
      /* No work order, no Measurement, no CustomerRequest, no status change. */
      expect(await WorkOrder.countDocuments()).toBe(beforeWo);
      expect(await CustomerRequest.countDocuments()).toBe(beforeReq);
      expect((await ReturnRequest.findById(w.rr._id).lean()).status).toBe("store_processing");
    });

    test(`${label}: a company non-member is refused`, async () => {
      const w = await returnWorld(`W${dispatchType}Member`, dispatchType);
      await company(`W${dispatchType}MemberOther`);
      const token = await actor({ companies: [], grants: PM_OK });
      const before = await WorkOrder.countDocuments();

      const res = await createMo(w.rr, token, w.ctx.co._id);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(codeOf(res.body)).toBe("TENANT_MEMBERSHIP_UNPROVEN");
      expect(await WorkOrder.countDocuments()).toBe(before);
    });
  }
});

/* ══ ACROSS ALL WRITERS ═══════════════════════════════════════════════════ */

describe("invariants across every writer", () => {
  test("no work order anywhere is stored with a null canonical style", async () => {
    expect(await WorkOrder.countDocuments({ sampleStyleId: null })).toBe(0);
  });

  test("a released order is visible to its own company in IE and to nobody else", async () => {
    const ctx = await company("XVis");
    const other = await company("XVisOther");
    const item = await product("XVis");
    const s = await style(ctx, "XVis");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    const sales = await actor({ companies: [ctx.co], grants: SALES_OK });
    expect((await approve(req, sales, ctx.co._id)).status).toBe(200);
    const created = (await wosFor(req))[0];

    const mine = await actor({ companies: [ctx.co], grants: { ie: "viewer" } });
    const detail = await call(`/api/cms/ie/orders/${created._id}`, { token: mine, company: ctx.co._id });
    expect(detail.status).toBe(200);
    expect(detail.body.styles[0].linkedVia).toBe("WORK_ORDER_SAMPLE_STYLE_ID");

    const theirs = await actor({ companies: [other.co], grants: { ie: "viewer" } });
    expect((await call(`/api/cms/ie/orders/${created._id}`, { token: theirs, company: other.co._id })).status)
      .toBe(404);

    const forbidden = /journey|enquiry|customer|buyer|supplier|quotation|salar|wage|rate|cost|margin|price|amount|invoice|payment|account/i;
    const keys = (v, out = []) => {
      if (Array.isArray(v)) { v.forEach((x) => keys(x, out)); return out; }
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k); keys(x, out); }
      return out;
    };
    expect([...new Set(keys(detail.body))].filter((k) => forbidden.test(k))).toEqual([]);
    expect(JSON.stringify(detail.body)).not.toMatch(/Northwind/);
  });

  test("an unexpected fault is still a safe 500 with no internals", async () => {
    const ctx = await company("XErr");
    const item = await product("XErr");
    const s = await style(ctx, "XErr");
    const req = await pendingRequest([{ item, styleId: s._id }]);
    const token = await actor({ companies: [ctx.co], grants: SALES_OK });

    const boom = jest.spyOn(WorkOrder.prototype, "save")
      .mockRejectedValueOnce(new Error("disk on fire /etc/secret"));
    try {
      const res = await approve(req, token, ctx.co._id);
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toMatch(/disk on fire|etc\/secret/);
    } finally { boom.mockRestore(); }
  });
});
