// test/industrial-engineering/ie-orders.route.test.js
//
// IE CHUNK 1B — THE ORDER-WISE WORKLIST, AT THE WIRE.
//
// The claims worth holding are the ones that decide whether an IE department
// can navigate by order at all:
//
//   · the order is the WORK ORDER — the record production is authorised and
//     scheduled from — and never the customer request behind it;
//   · an order carries no company of its own, so it is listed only when a
//     style provably linked to it proves the company; foreign, missing and
//     unprovable ids are one answer;
//   · a style is attached only through a STORED reference. A product shared by
//     two styles is a typed gap, never a guess;
//   · the engineering shown inside an order is Chunk 1A's own — same route
//     sources, same comparison states, same duplicate-code ambiguity;
//   · no customer, quotation, price, cost or payment field leaves, checked by
//     walking every key of every payload;
//   · and a read writes nothing.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");

const { STATE } = require("../../services/industrialEngineering/routeComparison");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
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

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `ieo${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `O${n}`, email, biometricId: `IEO${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    token: jwt.sign(
      { id: String(emp._id), email, name: "IE Actor", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const ieViewer = (co) => actor({ companies: [co], grants: { ie: "viewer" } });

const op = (name, code, machineType = "SNLS", totalSam = 1) =>
  Operation.create({ name, operationCode: code, machineType, totalSam, durationSeconds: totalSam * 60 });

const techRow = (operationId, code, name, minutes, seconds) => ({
  operationId, operationCode: code, name, machineType: "SNLS",
  ...(minutes === undefined ? {} : { minutes }),
  ...(seconds === undefined ? {} : { seconds }),
});

const prodRow = (code, type, minutes, seconds) => ({
  type, operationCode: code, machineType: "SNLS",
  ...(minutes === undefined ? {} : { minutes }),
  ...(seconds === undefined ? {} : { seconds }),
});

/** A company with a proven Sales spine. */
async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner",
    name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `Enquiry ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });
  return { co, journey, enquiry, n };
}

const product = (label, { operations } = {}) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-${label}-${++seq}`, reference: `REF-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  variants: [{ sku: `VAR-${label}-${seq}`, cost: 0, salesPrice: 0 }],
  ...(operations ? { operations } : {}),
});

const style = (ctx, label, { operations, stockItem, workOrderIds, customerRequestId } = {}) =>
  SampleStyle.create({
    sampleStyleId: `SS-${label}-${++seq}`, productName: `Tee ${label}`,
    styleCode: `ST-${label}`, variantLabel: "Navy",
    journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id,
    ...(stockItem ? { sourceStockItemId: stockItem._id } : {}),
    materials: { status: "pending", rawItems: [] },
    techSheet: { technical: { status: "draft", ...(operations ? { operations } : {}) } },
    ...(workOrderIds || customerRequestId
      ? { production: { ...(workOrderIds ? { workOrderIds } : {}), ...(customerRequestId ? { customerRequestId } : {}) } }
      : {}),
  });

/**
 * A work order — the production authority. Its commercial fields are set on
 * purpose, so the non-disclosure tests are proving a refusal rather than an
 * absence of data.
 */
const workOrder = (label, { stockItem, customerRequestId, quantity = 500, status = "planned", planningState } = {}) =>
  WorkOrder.create({
    workOrderNumber: `WO-${label}-${++seq}`,
    ...(stockItem ? {
      stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference,
    } : {}),
    ...(customerRequestId ? { customerRequestId } : {}),
    quantity, originalQuantity: quantity, status,
    ...(planningState ? { planningState } : {}),
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    /* Everything below must never appear in an IE response. */
    customerId: new mongoose.Types.ObjectId(),
    customerName: "Northwind Apparel Ltd",
    estimatedCost: 184000,
    actualCost: 190500,
  });

/**
 * A customer request. `lines` is the honest shape — one entry per request
 * line, each with its OWN product and style, because that is what the
 * work-order generator loops over and what the order-line rule has to
 * discriminate between.
 */
const customerRequest = (label, { lines = [] } = {}) => CustomerRequest.create({
  requestId: `CR-${label}-${++seq}`,
  customerId: new mongoose.Types.ObjectId(),
  customerInfo: { name: "Northwind Apparel Ltd", email: "buyer@northwind.test", phone: "999" },
  items: lines.map(({ stockItem, styleId }) => ({
    ...(styleId ? { sampleStyleId: styleId } : {}),
    ...(stockItem ? { stockItemId: stockItem._id } : {}),
    stockItemName: "Tee", stockItemReference: "REF", totalQuantity: 500,
  })),
});

/** The common shape: one company, one product, one style, one work order. */
async function world(name, { operations, productOperations, link = "workOrder" } = {}) {
  const ctx = await company(name);
  const item = await product(name, { operations: productOperations });
  const wo = await workOrder(name, { stockItem: item });
  let request = null;
  let s;
  if (link === "workOrder") {
    s = await style(ctx, name, { operations, stockItem: item, workOrderIds: [wo._id] });
  } else {
    s = await style(ctx, name, { operations, stockItem: item });
    request = await customerRequest(name, { lines: [{ stockItem: item, styleId: s._id }] });
    await WorkOrder.updateOne({ _id: wo._id }, { $set: { customerRequestId: request._id } });
  }
  return { ...ctx, product: item, workOrder: wo, style: s, request };
}

/* ══ 1–5. ACCESS, COMPANY AND NON-DISCLOSURE ══════════════════════════════ */

describe("access and company isolation", () => {
  test("an IE user lists their company's production orders", async () => {
    const w = await world("List");
    const a = await ieViewer(w.co);
    const res = await call("/orders", { token: a.token, company: w.co._id });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toMatchObject({
      orderId: String(w.workOrder._id),
      reference: w.workOrder.workOrderNumber,
      status: "planned",
      plannedQuantity: 500,
      styleCount: 1,
    });
    expect(new Date(res.body.rows[0].plannedStartDate).toISOString())
      .toBe(new Date("2026-10-01").toISOString());
  });

  test("an IE user opens an owned order", async () => {
    const w = await world("Open");
    const a = await ieViewer(w.co);
    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });

    expect(res.status).toBe(200);
    expect(res.body.order.orderId).toBe(String(w.workOrder._id));
    expect(res.body.readOnly).toBe(true);
    expect(res.body.styles).toHaveLength(1);
    expect(res.body.styles[0].styleId).toBe(String(w.style._id));
    /* A safe way back into the existing Chunk 1A style endpoint. */
    expect(res.body.styles[0].href).toBe(`/api/cms/ie/styles/${w.style._id}`);
  });

  test("a non-IE user is denied both endpoints", async () => {
    const w = await world("NoGrant");
    for (const grants of [{}, { "project-manager": "owner" }, { sales: "owner" }, { store: "owner" }]) {
      const a = await actor({ companies: [w.co], grants });
      for (const path of ["/orders", `/orders/${w.workOrder._id}`]) {
        const res = await call(path, { token: a.token, company: w.co._id });
        expect(res.status).toBe(403);
        expect(res.body.error?.code || res.body.code).toBe("FORBIDDEN");
      }
    }
  });

  test("no session reaches either endpoint", async () => {
    for (const path of ["/orders", "/orders/abc"]) {
      expect((await call(path)).status).toBe(401);
    }
  });

  test("a foreign order is not listed, and its id is indistinguishable from an absent one", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const a = await ieViewer(mine.co);

    const list = await call("/orders", { token: a.token, company: mine.co._id });
    expect(list.body.rows.map((r) => r.orderId)).toEqual([String(mine.workOrder._id)]);

    const answers = [];
    for (const id of [
      String(theirs.workOrder._id),
      String(new mongoose.Types.ObjectId()),
      "not-an-object-id",
    ]) {
      answers.push(await call(`/orders/${id}`, { token: a.token, company: mine.co._id }));
    }
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(res.body.error?.code || res.body.code).toBe("NOT_FOUND");
    }
    /* Byte for byte the same refusal — anything else is an oracle. */
    expect(new Set(answers.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(JSON.stringify(answers[0].body)).not.toMatch(/Theirs|WO-Theirs/);
  });

  test("unprovable ownership fails closed — an order no style names is not listed", async () => {
    /* A work order that exists, in a company with real styles, but which
       nothing links to a style. `WorkOrder` carries no `companyId`, so there
       is no second way to attribute it and it is not shown to anybody. */
    const w = await world("Orphan");
    const loose = await workOrder("Loose", { stockItem: await product("Loose") });
    const a = await ieViewer(w.co);

    const list = await call("/orders", { token: a.token, company: w.co._id });
    expect(list.body.rows.map((r) => r.orderId)).toEqual([String(w.workOrder._id)]);

    const direct = await call(`/orders/${loose._id}`, { token: a.token, company: w.co._id });
    expect(direct.status).toBe(404);
  });

  test("the company is resolved server-side and a request cannot name another", async () => {
    const mine = await world("ServerSide");
    const theirs = await world("ServerSideOther");
    const a = await ieViewer(mine.co);

    for (const res of [
      await call(`/orders?actingCompanyId=${theirs.co._id}`, { token: a.token }),
      await call("/orders", { token: a.token, company: theirs.co._id }),
    ]) {
      expect(res.status).toBe(200);
      expect(res.body.rows.map((r) => r.orderId)).toEqual([String(mine.workOrder._id)]);
    }
  });

  test("a multi-company actor must choose, and may only choose their own", async () => {
    const one = await world("MultiOne");
    const two = await world("MultiTwo");
    const a = await actor({ companies: [one.co, two.co], grants: { ie: "viewer" } });

    const unchosen = await call("/orders", { token: a.token });
    expect(unchosen.status).toBe(409);
    expect(unchosen.body.error?.code || unchosen.body.code).toBe("COMPANY_SELECTION_REQUIRED");

    const chosen = await call("/orders", { token: a.token, company: two.co._id });
    expect(chosen.body.rows.map((r) => r.orderId)).toEqual([String(two.workOrder._id)]);
  });

  test("no IE order write route exists", async () => {
    const w = await world("ReadOnlyVerbs");
    const a = await actor({ companies: [w.co], grants: { ie: "owner" } });
    for (const path of ["/orders", `/orders/${w.workOrder._id}`, `/orders/${w.workOrder._id}/styles`]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await call(path, { method, token: a.token, company: w.co._id, body: {} });
        expect(res.status).toBe(404);
      }
    }
  });
});

/* ══ 6. PAGING ════════════════════════════════════════════════════════════ */

describe("the orders list is bounded and stable", () => {
  test("it pages without skipping or repeating an order", async () => {
    const ctx = await company("PageOrders");
    const item = await product("PageOrders");
    const refs = [];
    for (const n of [1, 2, 3]) {
      const wo = await workOrder(`PG${n}`, { stockItem: item });
      await style(ctx, `PG${n}`, { stockItem: item, workOrderIds: [wo._id] });
      refs.push(wo.workOrderNumber);
    }
    const a = await ieViewer(ctx.co);

    const seen = [];
    let cursor = null;
    let guard = 0;
    do {
      const res = await call(`/orders?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { token: a.token, company: ctx.co._id });
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(1);
      expect(res.body.sort).toBe("createdAt:desc,_id:desc");
      seen.push(...res.body.rows.map((r) => r.reference));
      cursor = res.body.nextCursor;
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen.sort()).toEqual(refs.sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("an oversized limit is bounded and the bound is published", async () => {
    const w = await world("BoundedOrders");
    const a = await ieViewer(w.co);
    const res = await call("/orders?limit=100000", { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
    expect(res.body.hasMore).toBe(false);
  });

  test("a nonsense limit or page marker is refused by name", async () => {
    const w = await world("BadOrderPaging");
    const a = await ieViewer(w.co);
    for (const path of ["/orders?limit=0", "/orders?limit=-1", "/orders?limit=abc", "/orders?cursor=nonsense"]) {
      const res = await call(path, { token: a.token, company: w.co._id });
      expect(res.status).toBe(400);
      expect(res.body.error?.code || res.body.code).toBe("VALIDATION");
    }
  });

  test("a forged page marker cannot reach another company's orders", async () => {
    const mine = await world("CursorOrdersMine");
    const theirs = await world("CursorOrdersTheirs");
    const a = await ieViewer(mine.co);
    const forged = Buffer.from(
      JSON.stringify({ t: Date.now() + 1e6, i: String(theirs.workOrder._id) }), "utf8",
    ).toString("base64url");
    const res = await call(`/orders?cursor=${encodeURIComponent(forged)}`,
      { token: a.token, company: mine.co._id });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.orderId)).toEqual([String(mine.workOrder._id)]);
  });
});

/* ══ 7–9. ORDER → STYLE, PROVED OR NOT AT ALL ═════════════════════════════ */

describe("an order carries only provably linked styles", () => {
  test("a style is attached through the work-order reference it stores", async () => {
    const w = await world("LinkWO", { link: "workOrder" });
    const a = await ieViewer(w.co);
    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });
    expect(res.body.styles).toHaveLength(1);
    expect(res.body.styles[0].linkedVia).toBe("STYLE_WORK_ORDER_REFERENCE");
  });

  test("a style is attached through the order line that names it", async () => {
    const w = await world("LinkLine", { link: "orderLine" });
    const a = await ieViewer(w.co);
    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });
    expect(res.body.styles).toHaveLength(1);
    expect(res.body.styles[0].styleId).toBe(String(w.style._id));
    expect(res.body.styles[0].linkedVia).toBe("ORDER_LINE_STYLE_REFERENCE");
  });

  test("a cross-company conflict is refused to BOTH companies, not attached to one", async () => {
    /* THE LEAK THIS REPLACED. The order was admitted to my company on the
       strength of my style naming it, before the request line — pointing at
       another company's style — was considered. Both companies saw it.

       Resolving the two references together makes the conflict visible from
       either seat, and the honest answer is that neither may have it. */
    const mine = await world("SharedOrder");
    const other = await company("SharedOrderForeign");
    const foreign = await style(other, "Foreign", {
      stockItem: mine.product, workOrderIds: [mine.workOrder._id],
    });

    const seatMine = await ieViewer(mine.co);
    const seatOther = await ieViewer(other.co);

    for (const [seat, co] of [[seatMine, mine.co], [seatOther, other.co]]) {
      const list = await call("/orders", { token: seat.token, company: co._id });
      expect(list.body.rows.map((r) => r.orderId)).not.toContain(String(mine.workOrder._id));
      const direct = await call(`/orders/${mine.workOrder._id}`, { token: seat.token, company: co._id });
      expect(direct.status).toBe(404);
    }
    /* And neither company's records leak through the other's refusal. */
    const refusal = await call(`/orders/${mine.workOrder._id}`,
      { token: seatMine.token, company: mine.co._id });
    expect(JSON.stringify(refusal.body)).not.toMatch(String(foreign._id));
    expect(JSON.stringify(refusal.body)).not.toMatch(/Foreign/);
  });

  test("a missing style link is a typed gap, not a guess", async () => {
    /* The order's product is named by NO style, so nothing links it. The
       order is still listed, because another of the company's orders proves
       the company — and it says what is missing rather than attaching
       something plausible. */
    const w = await world("GapMissing");
    const lonelyProduct = await product("Lonely");
    const orphanOrder = await workOrder("Orphan", { stockItem: lonelyProduct });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $addToSet: { "production.workOrderIds": orphanOrder._id } });

    const a = await ieViewer(w.co);
    const res = await call(`/orders/${orphanOrder._id}`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);

    /* It IS reachable — my own style names it — and it has one style. Now
       remove that link and confirm the gap. */
    await SampleStyle.updateOne({ _id: w.style._id },
      { $pull: { "production.workOrderIds": orphanOrder._id } });
    const after = await call(`/orders/${orphanOrder._id}`, { token: a.token, company: w.co._id });
    /* Nothing proves it any more, so it is not disclosed at all. */
    expect(after.status).toBe(404);
  });

  test("one request, two style lines, two orders — each gets only its own style", async () => {
    /* THE BUG THIS REPLACED. A request-level link attached every style on the
       request to every work order under it, so a two-line order answered for
       work it was not doing. The line rule matches the order's OWN product. */
    const ctx = await company("TwoLines");
    const itemA = await product("TwoLinesA");
    const itemB = await product("TwoLinesB");
    const styleA = await style(ctx, "TwoLinesA", { stockItem: itemA });
    const styleB = await style(ctx, "TwoLinesB", { stockItem: itemB });
    const request = await customerRequest("TwoLines", {
      lines: [{ stockItem: itemA, styleId: styleA._id }, { stockItem: itemB, styleId: styleB._id }],
    });
    const orderA = await workOrder("TwoLinesA", { stockItem: itemA, customerRequestId: request._id });
    const orderB = await workOrder("TwoLinesB", { stockItem: itemB, customerRequestId: request._id });

    const a = await ieViewer(ctx.co);
    const resA = await call(`/orders/${orderA._id}`, { token: a.token, company: ctx.co._id });
    const resB = await call(`/orders/${orderB._id}`, { token: a.token, company: ctx.co._id });

    expect(resA.body.styles.map((x) => x.styleId)).toEqual([String(styleA._id)]);
    expect(resB.body.styles.map((x) => x.styleId)).toEqual([String(styleB._id)]);
    /* Neither order carries the other's style, by id or by reference. */
    expect(JSON.stringify(resA.body)).not.toMatch(String(styleB._id));
    expect(JSON.stringify(resA.body)).not.toMatch(/ST-TwoLinesB/);
    expect(JSON.stringify(resB.body)).not.toMatch(String(styleA._id));
    expect(resA.body.styles[0].linkedVia).toBe("ORDER_LINE_STYLE_REFERENCE");
  });

  test("two lines sharing one StockItem are AMBIGUOUS — a product match alone is not enough", async () => {
    /* Requirement 5 exactly. The only line discriminator both records share is
       `stockItemId`; when two lines name one product it identifies nothing,
       and `variantId` cannot help — it holds the STOCK ITEM variant's id,
       which is common to both lines. So nothing is chosen. */
    const ctx = await company("SharedLine");
    const shared = await product("SharedLine");
    const styleA = await style(ctx, "SharedLineA", { stockItem: shared });
    const styleB = await style(ctx, "SharedLineB", { stockItem: shared });
    const request = await customerRequest("SharedLine", {
      lines: [{ stockItem: shared, styleId: styleA._id }, { stockItem: shared, styleId: styleB._id }],
    });
    const order = await workOrder("SharedLine", { stockItem: shared, customerRequestId: request._id });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });

    /* Admitted — both candidate styles are this company's, so whichever line
       it is, the order is theirs — and nothing is attached. */
    expect(res.status).toBe(200);
    expect(res.body.styles).toEqual([]);
    expect(res.body.order.styleLinkState).toBe("AMBIGUOUS_ORDER_LINES");
    expect(res.body.order.gaps.map((g) => g.code)).toContain("STYLE_LINK_AMBIGUOUS");
    expect(res.body.order.ieReadiness).toBe("UNKNOWN");
    /* Never the first, never the latest. */
    expect(JSON.stringify(res.body.styles)).not.toMatch(String(styleA._id));
    expect(JSON.stringify(res.body.styles)).not.toMatch(String(styleB._id));
  });

  test("a direct work-order reference resolves what the shared product cannot", async () => {
    /* The same ambiguous request, plus the one stored reference that IS
       order-specific. The style is attached, and the line ambiguity is still
       reported rather than quietly dropped. */
    const ctx = await company("SharedResolved");
    const shared = await product("SharedResolved");
    const order = await workOrder("SharedResolved", { stockItem: shared });
    const styleA = await style(ctx, "SharedResolvedA", { stockItem: shared, workOrderIds: [order._id] });
    const styleB = await style(ctx, "SharedResolvedB", { stockItem: shared });
    const request = await customerRequest("SharedResolved", {
      lines: [{ stockItem: shared, styleId: styleA._id }, { stockItem: shared, styleId: styleB._id }],
    });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { customerRequestId: request._id } });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    /* The direct reference is order-specific proof and is still attached; the
       request's ambiguity is reported beside it rather than used to withhold
       it. */
    expect(res.body.styles.map((x) => x.styleId)).toEqual([String(styleA._id)]);
    expect(res.body.styles[0].linkedVia).toBe("STYLE_WORK_ORDER_REFERENCE");
    expect(res.body.order.styleLinkState).toBe("AMBIGUOUS_ORDER_LINES");
    expect(res.body.order.gaps.map((g) => g.code)).toContain("STYLE_LINK_AMBIGUOUS");
  });

  test("an unrelated order under the same request is not admitted through another line's company", async () => {
    /* Requirement 9. The request holds my line and a line whose style is not
       mine; the work order for that OTHER line must not become visible to me
       just because we share paperwork. */
    const mine = await company("SiblingMine");
    const other = await company("SiblingOther");
    const myItem = await product("SiblingMineItem");
    const theirItem = await product("SiblingOtherItem");
    const myStyle = await style(mine, "SiblingMine", { stockItem: myItem });
    const theirStyle = await style(other, "SiblingOther", { stockItem: theirItem });

    const request = await customerRequest("Sibling", {
      lines: [{ stockItem: myItem, styleId: myStyle._id }, { stockItem: theirItem, styleId: theirStyle._id }],
    });
    const myOrder = await workOrder("SiblingMine", { stockItem: myItem, customerRequestId: request._id });
    const theirOrder = await workOrder("SiblingOther", { stockItem: theirItem, customerRequestId: request._id });

    const a = await ieViewer(mine.co);
    const list = await call("/orders", { token: a.token, company: mine.co._id });
    expect(list.body.rows.map((r) => r.orderId)).toEqual([String(myOrder._id)]);

    const direct = await call(`/orders/${theirOrder._id}`, { token: a.token, company: mine.co._id });
    expect(direct.status).toBe(404);
    expect(JSON.stringify(direct.body)).not.toMatch(/SiblingOther/);
  });

  test("a mixed-company request exposes neither company's order or style to the other", async () => {
    /* Both directions of the same request, checked from both seats. */
    const one = await company("MixedOne");
    const two = await company("MixedTwo");
    const itemOne = await product("MixedOneItem");
    const itemTwo = await product("MixedTwoItem");
    const styleOne = await style(one, "MixedOne", { stockItem: itemOne });
    const styleTwo = await style(two, "MixedTwo", { stockItem: itemTwo });

    const request = await customerRequest("Mixed", {
      lines: [{ stockItem: itemOne, styleId: styleOne._id }, { stockItem: itemTwo, styleId: styleTwo._id }],
    });
    const orderOne = await workOrder("MixedOne", { stockItem: itemOne, customerRequestId: request._id });
    const orderTwo = await workOrder("MixedTwo", { stockItem: itemTwo, customerRequestId: request._id });

    const seatOne = await ieViewer(one.co);
    const seatTwo = await ieViewer(two.co);

    const listOne = await call("/orders", { token: seatOne.token, company: one.co._id });
    const listTwo = await call("/orders", { token: seatTwo.token, company: two.co._id });
    expect(listOne.body.rows.map((r) => r.orderId)).toEqual([String(orderOne._id)]);
    expect(listTwo.body.rows.map((r) => r.orderId)).toEqual([String(orderTwo._id)]);

    const one_text = JSON.stringify(listOne.body);
    expect(one_text).not.toMatch(String(orderTwo._id));
    expect(one_text).not.toMatch(String(styleTwo._id));
    expect(one_text).not.toMatch(/MixedTwo/);
    const two_text = JSON.stringify(listTwo.body);
    expect(two_text).not.toMatch(String(orderOne._id));
    expect(two_text).not.toMatch(String(styleOne._id));
    expect(two_text).not.toMatch(/MixedOne/);
  });

  test("a work order whose own line names no style is omitted, not shown empty", async () => {
    /* Requirement 10. The request proves the company for my order; the second
       order's own line carries no style, so nothing proves it and it is not
       disclosed. */
    const ctx = await company("BareLine");
    const linked = await product("BareLineLinked");
    const bare = await product("BareLineBare");
    const s = await style(ctx, "BareLine", { stockItem: linked });
    const request = await customerRequest("BareLine", {
      lines: [{ stockItem: linked, styleId: s._id }, { stockItem: bare }],
    });
    const proven = await workOrder("BareLineProven", { stockItem: linked, customerRequestId: request._id });
    const unproven = await workOrder("BareLineUnproven", { stockItem: bare, customerRequestId: request._id });

    const a = await ieViewer(ctx.co);
    const list = await call("/orders", { token: a.token, company: ctx.co._id });
    expect(list.body.rows.map((r) => r.orderId)).toEqual([String(proven._id)]);
    expect((await call(`/orders/${unproven._id}`, { token: a.token, company: ctx.co._id })).status).toBe(404);
  });

  test("styles sharing a product are never attached through the product itself", async () => {
    /* The product bridge is one-to-many and is not a link. The order is proved
       by a direct reference to one style; its two siblings share the same
       product and are neither attached nor counted anywhere. */
    const ctx = await company("ProductBridge");
    const shared = await product("ProductBridge");
    const order = await workOrder("ProductBridge", { stockItem: shared });
    const anchor = await style(ctx, "BridgeAnchor", { stockItem: shared, workOrderIds: [order._id] });
    const sibA = await style(ctx, "BridgeSibA", { stockItem: shared });
    const sibB = await style(ctx, "BridgeSibB", { stockItem: shared });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });

    expect(res.status).toBe(200);
    expect(res.body.styles.map((x) => x.styleId)).toEqual([String(anchor._id)]);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(String(sibA._id));
    expect(text).not.toMatch(String(sibB._id));
    expect(text).not.toMatch(/unlinkedStyleCandidates|candidateStyles/);
  });

  test("a foreign style sharing a StockItem changes nothing in this company's response", async () => {
    /* BLOCKER 2. The candidate count used to be an unscoped tally of every
       style against the product, so adding a style in ANOTHER company moved a
       number in this one's response — small, but a disclosure of a tenant the
       caller cannot see. The count is gone; this pins that the response is
       byte-for-byte identical before and after. */
    const mine = await company("CandidateMine");
    const theirs = await company("CandidateTheirs");
    const shared = await product("CandidateShared");
    const order = await workOrder("Candidate", { stockItem: shared });
    await style(mine, "CandidateMine", { stockItem: shared, workOrderIds: [order._id] });

    const a = await ieViewer(mine.co);
    const before = await call(`/orders/${order._id}`, { token: a.token, company: mine.co._id });
    const beforeList = await call("/orders", { token: a.token, company: mine.co._id });
    expect(before.status).toBe(200);

    /* The other company adds a style against the very same product. */
    const foreign = await style(theirs, "CandidateTheirs", { stockItem: shared });

    const after = await call(`/orders/${order._id}`, { token: a.token, company: mine.co._id });
    const afterList = await call("/orders", { token: a.token, company: mine.co._id });

    expect(JSON.stringify(after.body)).toBe(JSON.stringify(before.body));
    expect(JSON.stringify(afterList.body)).toBe(JSON.stringify(beforeList.body));
    expect(JSON.stringify(after.body)).not.toMatch(String(foreign._id));
    expect(JSON.stringify(after.body)).not.toMatch(/CandidateTheirs/);
  });

  test("the line rule itself, as arithmetic", async () => {
    const { resolveOrderLine, orderGapsFor, orderReadinessOf, LINE_RESOLUTION } =
      require("../../services/industrialEngineering/ieOrders.service");
    const A = new mongoose.Types.ObjectId();
    const B = new mongoose.Types.ObjectId();
    const S1 = new mongoose.Types.ObjectId();
    const S2 = new mongoose.Types.ObjectId();
    const order = (stockItemId) => ({ _id: new mongoose.Types.ObjectId(), stockItemId });

    /* One matching line, one style. */
    expect(resolveOrderLine(order(A), { items: [{ stockItemId: A, sampleStyleId: S1 }] }))
      .toEqual({ state: LINE_RESOLUTION.RESOLVED, styleIds: [String(S1)] });

    /* Two lines, different products — only the order's own line counts. */
    expect(resolveOrderLine(order(B), {
      items: [{ stockItemId: A, sampleStyleId: S1 }, { stockItemId: B, sampleStyleId: S2 }],
    })).toEqual({ state: LINE_RESOLUTION.RESOLVED, styleIds: [String(S2)] });

    /* Two lines sharing the product, two styles — nothing is chosen. */
    expect(resolveOrderLine(order(A), {
      items: [{ stockItemId: A, sampleStyleId: S1 }, { stockItemId: A, sampleStyleId: S2 }],
    }).state).toBe(LINE_RESOLUTION.AMBIGUOUS);

    /* Two lines sharing the product AND the style — one answer, so resolved. */
    expect(resolveOrderLine(order(A), {
      items: [{ stockItemId: A, sampleStyleId: S1 }, { stockItemId: A, sampleStyleId: S1 }],
    })).toEqual({ state: LINE_RESOLUTION.RESOLVED, styleIds: [String(S1)] });

    /* A matching line naming no style makes the answer unknowable, not the
       other line's style. */
    expect(resolveOrderLine(order(A), {
      items: [{ stockItemId: A, sampleStyleId: S1 }, { stockItemId: A }],
    }).state).toBe(LINE_RESOLUTION.AMBIGUOUS);

    /* No line names this order's product. */
    expect(resolveOrderLine(order(B), { items: [{ stockItemId: A, sampleStyleId: S1 }] }).state)
      .toBe(LINE_RESOLUTION.UNRESOLVED);

    /* The request-level style applies to a single-line request... */
    expect(resolveOrderLine(order(B), { sampleStyleId: S1, items: [] }))
      .toEqual({ state: LINE_RESOLUTION.RESOLVED, styleIds: [String(S1)] });
    /* ...and NEVER to a request with several lines, where it cannot say which
       order it belongs to. */
    expect(resolveOrderLine(order(B), {
      sampleStyleId: S1,
      items: [{ stockItemId: A, sampleStyleId: S1 }, { stockItemId: B }],
    }).state).toBe(LINE_RESOLUTION.UNRESOLVED);

    expect(resolveOrderLine(order(A), null).state).toBe(LINE_RESOLUTION.UNRESOLVED);

    /* And the gaps each link status produces. */
    expect(orderReadinessOf([])).toBe("UNKNOWN");
    const codesFor = (linkStatus, extra = {}) => orderGapsFor({
      decision: { linkStatus, directStyleIds: [], lineStyleIds: [], ...extra },
      perStyle: [], readiness: "UNKNOWN",
    }).map((g) => g.code);

    expect(codesFor("UNRESOLVED_ORDER_LINE")).toEqual(["STYLE_LINK_UNRESOLVED"]);
    expect(codesFor("NO_STYLE_REFERENCE")).toEqual(["STYLE_LINK_UNRESOLVED"]);
    expect(codesFor("AMBIGUOUS_ORDER_LINES")).toEqual(["STYLE_LINK_AMBIGUOUS"]);
    expect(codesFor("REFERENCES_CONFLICT", {
      directStyleIds: [String(S1)], lineStyleIds: [String(S2)],
    })).toEqual(["STYLE_LINK_CONFLICT"]);
  });
});

/* ══ CONFLICTING REFERENCES, AND THE AUDIT AGREEING ══════════════════════ */

describe("direct and order-line references are resolved together", () => {
  /**
   * One order reachable by BOTH paths, with each path's style placed in a
   * company of the caller's choosing. Returns everything the two callers — the
   * endpoint and the Chunk 1C classifier — need to be compared on.
   */
  async function conflictWorld(name, { directIn, lineIn, sameStyle = false, directProvable = true }) {
    const ctx = await company(`${name}Main`);
    const item = await product(name);
    const order = await workOrder(name, { stockItem: item });

    const lineCtx = lineIn === "main" ? ctx : await company(`${name}Line`);
    const lineStyle = await style(lineCtx, `${name}Line`, { stockItem: item });

    let directStyle = null;
    if (directIn) {
      if (sameStyle) {
        await SampleStyle.updateOne({ _id: lineStyle._id },
          { $set: { "production.workOrderIds": [order._id] } });
        directStyle = lineStyle;
      } else {
        const directCtx = directIn === "main" ? ctx : await company(`${name}Direct`);
        directStyle = await style(directCtx, `${name}Direct`, {
          stockItem: await product(`${name}D`), workOrderIds: [order._id],
        });
        if (!directProvable) {
          /* A style naming the order whose own company cannot be proved: its
             journey is stripped to a dangling reference. */
          await SampleStyle.collection.updateOne({ _id: directStyle._id },
            { $set: { journeyId: new mongoose.Types.ObjectId() }, $unset: { enquiryId: "" } });
        }
      }
    }

    const request = await customerRequest(name, { lines: [{ stockItem: item, styleId: lineStyle._id }] });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { customerRequestId: request._id } });
    return { ctx, lineCtx, order, lineStyle, directStyle, item };
  }

  test("1 — direct style A and line style B, both in one company: visible, nothing attached", async () => {
    const w = await conflictWorld("ConfOne", { directIn: "main", lineIn: "main" });
    const a = await ieViewer(w.ctx.co);
    const res = await call(`/orders/${w.order._id}`, { token: a.token, company: w.ctx.co._id });

    expect(res.status).toBe(200);
    expect(res.body.order.styleLinkState).toBe("REFERENCES_CONFLICT");
    /* Visible, because whichever reference is right the order is theirs — and
       NO disputed style is attached. */
    expect(res.body.styles).toEqual([]);
    expect(res.body.order.ieReadiness).toBe("UNKNOWN");
    const gap = res.body.order.gaps.find((g) => g.code === "STYLE_LINK_CONFLICT");
    expect(gap).toBeTruthy();
    expect(gap.owner).toBe("INDUSTRIAL_ENGINEERING");
    expect(gap.action).toBe("RECONCILE_STYLE_REFERENCES");
    /* Neither disputed style is named anywhere in the payload. */
    expect(JSON.stringify(res.body)).not.toMatch(String(w.directStyle._id));
    expect(JSON.stringify(res.body)).not.toMatch(String(w.lineStyle._id));
  });

  test("2 — direct in company A and line in company B: 404 from both, listed by neither", async () => {
    const w = await conflictWorld("ConfTwo", { directIn: "other", lineIn: "main" });
    const seatMain = await ieViewer(w.ctx.co);
    const directCo = await SampleStyle.findById(w.directStyle._id).lean();
    expect(directCo).toBeTruthy();

    /* The direct style's own company seat. */
    const otherCompanyId = (await SalesJourney.findById(directCo.journeyId).lean()).companyId;
    const seatOther = await actor({
      companies: [{ _id: otherCompanyId }], grants: { ie: "viewer" },
    });

    for (const [seat, coId] of [[seatMain, w.ctx.co._id], [seatOther, otherCompanyId]]) {
      const list = await call("/orders", { token: seat.token, company: coId });
      expect(list.body.rows.map((r) => r.orderId)).not.toContain(String(w.order._id));
      const detail = await call(`/orders/${w.order._id}`, { token: seat.token, company: coId });
      expect(detail.status).toBe(404);
    }
  });

  test("3 — both references agreeing: attached once, no conflict", async () => {
    const w = await conflictWorld("ConfThree", { directIn: "main", lineIn: "main", sameStyle: true });
    const a = await ieViewer(w.ctx.co);
    const res = await call(`/orders/${w.order._id}`, { token: a.token, company: w.ctx.co._id });

    expect(res.status).toBe(200);
    expect(res.body.order.styleLinkState).toBe("BOTH_REFERENCES_AGREE");
    expect(res.body.styles.map((x) => x.styleId)).toEqual([String(w.lineStyle._id)]);
    expect(res.body.order.gaps.map((g) => g.code)).not.toContain("STYLE_LINK_CONFLICT");
  });

  test("4a — direct-only control", async () => {
    const ctx = await company("ConfDirectOnly");
    const item = await product("ConfDirectOnly");
    const order = await workOrder("ConfDirectOnly", { stockItem: item });
    const s = await style(ctx, "ConfDirectOnly", { stockItem: item, workOrderIds: [order._id] });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    expect(res.body.order.styleLinkState).toBe("DIRECT_WORK_ORDER_REFERENCE");
    expect(res.body.styles.map((x) => x.styleId)).toEqual([String(s._id)]);
  });

  test("4b — line-only control", async () => {
    const w = await conflictWorld("ConfLineOnly", { directIn: null, lineIn: "main" });
    const a = await ieViewer(w.ctx.co);
    const res = await call(`/orders/${w.order._id}`, { token: a.token, company: w.ctx.co._id });
    expect(res.body.order.styleLinkState).toBe("UNIQUE_ORDER_LINE_REFERENCE");
    expect(res.body.styles.map((x) => x.styleId)).toEqual([String(w.lineStyle._id)]);
  });

  test("5 — an unprovable conflicting style fails closed for everyone", async () => {
    /* A style naming the order whose own ownership cannot be proved. It could
       belong to anybody, so nobody may have the order. */
    const w = await conflictWorld("ConfUnprovable", {
      directIn: "main", lineIn: "main", directProvable: false,
    });
    const a = await ieViewer(w.ctx.co);
    const list = await call("/orders", { token: a.token, company: w.ctx.co._id });
    expect(list.body.rows.map((r) => r.orderId)).not.toContain(String(w.order._id));
    expect((await call(`/orders/${w.order._id}`, { token: a.token, company: w.ctx.co._id })).status)
      .toBe(404);
  });

  test("the audit classifier and the endpoint agree on every fixture", async () => {
    /* THE GUARANTEE. Both callers read `resolveOrderStyleLink`, so this proves
       what that buys: identical visibility, identical link state and identical
       attached-style decision for each shape above. A disagreement here is the
       exact fault the Chunk 1C review found. */
    const { classifyOrder } = require("../../services/industrialEngineering/ieOrderAudit");
    const { styleOwnersFor } = require("../../services/industrialEngineering/ieOrders.service");

    const fixtures = [
      ["agree", { directIn: "main", lineIn: "main", sameStyle: true }],
      ["conflictOneCo", { directIn: "main", lineIn: "main" }],
      ["conflictTwoCo", { directIn: "other", lineIn: "main" }],
      ["lineOnly", { directIn: null, lineIn: "main" }],
      ["unprovable", { directIn: "main", lineIn: "main", directProvable: false }],
    ];

    for (const [name, spec] of fixtures) {
      const w = await conflictWorld(`Agree${name}`, spec);
      const a = await ieViewer(w.ctx.co);
      const endpoint = await call(`/orders/${w.order._id}`, { token: a.token, company: w.ctx.co._id });

      const orderDoc = await WorkOrder.findById(w.order._id)
        .select("_id workOrderNumber status stockItemId customerRequestId").lean();
      const requestDoc = await CustomerRequest.findById(orderDoc.customerRequestId)
        .select("_id sampleStyleId items.stockItemId items.sampleStyleId").lean();
      const naming = await SampleStyle.find({ "production.workOrderIds": orderDoc._id })
        .select("_id").lean();
      const owners = await styleOwnersFor([
        ...naming.map((x) => String(x._id)),
        ...(requestDoc?.items || []).map((i) => String(i.sampleStyleId)).filter(Boolean),
        String(requestDoc?.sampleStyleId || ""),
      ].filter(Boolean));

      const audit = classifyOrder({
        order: orderDoc,
        request: requestDoc,
        directStyleIds: naming.map((x) => String(x._id)),
        companyOf: (sid) => owners.get(String(sid)) || null,
      });

      const endpointVisible = endpoint.status === 200;
      expect([name, audit.visibleToOneCompany]).toEqual([name, endpointVisible]);
      if (endpointVisible) {
        expect([name, audit.styleLinkStatus]).toEqual([name, endpoint.body.order.styleLinkState]);
        expect([name, audit.displayableStyles]).toEqual([name, endpoint.body.styles.length]);
      }
    }
  });
});

/* ══ CHUNK 1D — THE CANONICAL LINK, AT THE WIRE ══════════════════════════ */

describe("a work order carrying the canonical style link", () => {
  test("is visible in the IE list and detail with its own typed provenance", async () => {
    const ctx = await company("Canonical");
    const item = await product("Canonical");
    const s = await style(ctx, "Canonical", { stockItem: item });
    /* No `production.workOrderIds[]`, no request line — only the Chunk 1D
       field. Before it existed this order was invisible to IE entirely. */
    const order = await workOrder("Canonical", { stockItem: item });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: s._id } });

    const a = await ieViewer(ctx.co);
    const list = await call("/orders", { token: a.token, company: ctx.co._id });
    expect(list.body.rows.map((r) => r.orderId)).toEqual([String(order._id)]);
    expect(list.body.rows[0].styleLinkState).toBe("CANONICAL_WORK_ORDER_REFERENCE");

    const detail = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    expect(detail.status).toBe(200);
    expect(detail.body.styles.map((x) => x.styleId)).toEqual([String(s._id)]);
    expect(detail.body.styles[0].linkedVia).toBe("WORK_ORDER_SAMPLE_STYLE_ID");
    /* And the raw id is never published as an order field. */
    expect(Object.keys(detail.body.order)).not.toContain("sampleStyleId");
  });

  test("agreeing with a legacy reference yields one style, not two", async () => {
    const ctx = await company("CanonAgree");
    const item = await product("CanonAgree");
    const order = await workOrder("CanonAgree", { stockItem: item });
    const s = await style(ctx, "CanonAgree", { stockItem: item, workOrderIds: [order._id] });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: s._id } });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    expect(res.body.styles).toHaveLength(1);
    expect(res.body.order.styleLinkState).toBe("CANONICAL_WORK_ORDER_REFERENCE");
  });

  test("disagreeing with a legacy reference in one company attaches nothing", async () => {
    const ctx = await company("CanonConflict");
    const item = await product("CanonConflict");
    const order = await workOrder("CanonConflict", { stockItem: item });
    const canonical = await style(ctx, "CanonConflictA", { stockItem: item });
    const legacy = await style(ctx, "CanonConflictB", {
      stockItem: await product("CanonConflictB"), workOrderIds: [order._id],
    });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: canonical._id } });

    const a = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    expect(res.status).toBe(200);
    expect(res.body.order.styleLinkState).toBe("REFERENCES_CONFLICT");
    expect(res.body.styles).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(String(canonical._id));
    expect(JSON.stringify(res.body)).not.toMatch(String(legacy._id));
  });

  test("a cross-company canonical/legacy conflict is invisible to both", async () => {
    const one = await company("CanonXOne");
    const two = await company("CanonXTwo");
    const item = await product("CanonX");
    const order = await workOrder("CanonX", { stockItem: item });
    const mine = await style(one, "CanonXMine", { stockItem: item });
    await style(two, "CanonXTheirs", {
      stockItem: await product("CanonXT"), workOrderIds: [order._id],
    });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: mine._id } });

    for (const ctx of [one, two]) {
      const a = await ieViewer(ctx.co);
      const list = await call("/orders", { token: a.token, company: ctx.co._id });
      expect(list.body.rows.map((r) => r.orderId)).not.toContain(String(order._id));
      expect((await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id })).status)
        .toBe(404);
    }
  });

  test("the endpoint and the audit classify a canonical order identically", async () => {
    const { classifyOrder } = require("../../services/industrialEngineering/ieOrderAudit");
    const { styleOwnersFor } = require("../../services/industrialEngineering/ieOrders.service");
    const ctx = await company("CanonAgree2");
    const item = await product("CanonAgree2");
    const s = await style(ctx, "CanonAgree2", { stockItem: item });
    const order = await workOrder("CanonAgree2", { stockItem: item });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: s._id } });

    const a = await ieViewer(ctx.co);
    const endpoint = await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
    const doc = await WorkOrder.findById(order._id)
      .select("_id workOrderNumber status stockItemId customerRequestId sampleStyleId").lean();
    const owners = await styleOwnersFor([String(s._id)]);
    const audit = classifyOrder({
      order: doc, request: null, directStyleIds: [],
      companyOf: (sid) => owners.get(String(sid)) || null,
    });

    expect(audit.visibleToOneCompany).toBe(endpoint.status === 200);
    expect(audit.styleLinkStatus).toBe(endpoint.body.order.styleLinkState);
    expect(audit.displayableStyles).toBe(endpoint.body.styles.length);
    expect(audit.hasCanonicalLink).toBe(true);
  });

  test("a canonical read still mutates nothing", async () => {
    const ctx = await company("CanonReadOnly");
    const item = await product("CanonReadOnly");
    const s = await style(ctx, "CanonReadOnly", { stockItem: item });
    const order = await workOrder("CanonReadOnly", { stockItem: item });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { sampleStyleId: s._id } });
    const a = await ieViewer(ctx.co);
    const before = await WorkOrder.findById(order._id).lean();

    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "bulkWrite", "deleteOne"]
        .map((n) => jest.spyOn(mongoose.Model, n)),
    ];
    try {
      await call("/orders", { token: a.token, company: ctx.co._id });
      await call(`/orders/${order._id}`, { token: a.token, company: ctx.co._id });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); }
    expect(await WorkOrder.findById(order._id).lean()).toEqual(before);
  });
});

/* ══ 10–11. CHUNK 1A ENGINEERING, UNCHANGED INSIDE AN ORDER ═══════════════ */

describe("the engineering shown inside an order is Chunk 1A's own", () => {
  const openOrder = async (w) => {
    const a = await ieViewer(w.co);
    return call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });
  };

  test("every route-comparison state survives the order boundary", async () => {
    const [o1, o2] = [await op("A", "OC-1"), await op("B", "OC-2")];
    const cases = [
      ["OrdMatched", [techRow(o1._id, "OC-1", "A", 1, 0)], [prodRow("OC-1", "A", 1, 0)], STATE.MATCHED],
      ["OrdTime", [techRow(o1._id, "OC-1", "A", 1, 0)], [prodRow("OC-1", "A", 3, 0)], STATE.DIFFERENT_TIME],
      ["OrdSeq",
        [techRow(o1._id, "OC-1", "A", 1, 0), techRow(o2._id, "OC-2", "B", 1, 0)],
        [prodRow("OC-2", "B", 1, 0), prodRow("OC-1", "A", 1, 0)], STATE.DIFFERENT_SEQUENCE],
      ["OrdOps", [techRow(o1._id, "OC-1", "A", 1, 0)], [prodRow("OC-9", "Z", 1, 0)], STATE.DIFFERENT_OPERATIONS],
      ["OrdOnlyTech", [techRow(o1._id, "OC-1", "A", 1, 0)], undefined, STATE.ONLY_TECHNICAL_ROUTE],
      ["OrdOnlyProd", undefined, [prodRow("OC-1", "A", 1, 0)], STATE.ONLY_PRODUCT_ROUTE],
      ["OrdNone", undefined, undefined, STATE.NO_ROUTE],
      ["OrdAmbig", [techRow(o1._id, "OC-1", "A", 1, 0)],
        [{ type: "A", machineType: "SNLS", minutes: 1 }], STATE.AMBIGUOUS],
    ];

    const seen = new Set();
    for (const [name, operations, productOperations, expected] of cases) {
      const w = await world(name, { operations, productOperations });
      const res = await openOrder(w);
      expect(res.body.styles[0].comparisonState).toBe(expected);
      /* The two sources stay separate inside the order — neither is chosen. */
      expect(res.body.styles[0].routeSources.technical.source).toBe("SAMPLE_STYLE_TECHNICAL_ROUTE");
      expect(res.body.styles[0].routeSources.product.source).toBe("STOCK_ITEM_PRODUCT_ROUTE");
      seen.add(expected);
    }
    expect(seen.size).toBe(8);
  });

  test("a duplicated operation code still produces OPERATION_CODE_NOT_UNIQUE", async () => {
    const first = await op("Side seam", "TS008");
    await op("Side seam (both)", "TS008");
    const w = await world("OrderDupe", {
      operations: [techRow(first._id, "TS008", "Side seam", 1, 0)],
      productOperations: [prodRow("TS008", "Side seam", 1, 0)],
    });

    const res = await openOrder(w);
    expect(res.body.styles[0].comparisonState).toBe(STATE.AMBIGUOUS);
    expect(res.body.styles[0].gaps.map((g) => g.code)).toContain("OPERATION_CODE_NOT_UNIQUE");
    /* And the order is never READY on top of an ambiguous style. */
    expect(res.body.order.ieReadiness).toBe("BLOCKED");
    expect(res.body.styles[0].ieReadiness).toBe("AMBIGUOUS");
  });

  test("SAM and readiness roll up from the styles without being recalculated", async () => {
    const [o1, o2] = [await op("A", "SM-1"), await op("B", "SM-2")];
    const w = await world("OrderSam", {
      operations: [techRow(o1._id, "SM-1", "A", 1, 30), techRow(o2._id, "SM-2", "B", 0, 45)],
    });
    const res = await openOrder(w);

    expect(res.body.styles[0].samMinutes).toBe(2.25);
    expect(res.body.order.routeSummary).toMatchObject({
      styles: 1, stylesWithTechnicalRoute: 1, stylesWithoutTechnicalRoute: 0,
      stylesSamComplete: 1, totalSamMinutes: 2.25, samComplete: true,
    });
    expect(res.body.order.ieReadiness).toBe("READY");
    expect(res.body.order.stylesReady).toBe(1);
    expect(res.body.order.stylesWithGaps).toBe(0);
  });

  test("an untimed row keeps the order out of READY and the total honest", async () => {
    const [o1, o2] = [await op("A", "SI-1"), await op("B", "SI-2")];
    const w = await world("OrderSamPartial", {
      operations: [techRow(o1._id, "SI-1", "A", 2, 0), techRow(o2._id, "SI-2", "B")],
    });
    const res = await openOrder(w);
    expect(res.body.order.routeSummary.samComplete).toBe(false);
    expect(res.body.order.routeSummary.totalSamMinutes).toBe(2);
    expect(res.body.order.ieReadiness).toBe("BLOCKED");
    expect(res.body.order.gaps.map((g) => g.code)).toContain("ORDER_ENGINEERING_INCOMPLETE");
  });

  test("an order with no route anywhere is NOT_STARTED, never zero or ready", async () => {
    const w = await world("OrderNoRoute");
    const res = await openOrder(w);
    expect(res.body.order.ieReadiness).toBe("NOT_STARTED");
    expect(res.body.order.routeSummary.totalSamMinutes).toBeNull();
    expect(res.body.order.routeSummary.samComplete).toBe(false);
  });

  test("line planning is reported unavailable, never guessed", async () => {
    const w = await world("OrderLine");
    const a = await ieViewer(w.co);
    const list = await call("/orders", { token: a.token, company: w.co._id });
    const detail = await openOrder(w);
    for (const row of [list.body.rows[0], detail.body.order]) {
      expect(row.linePlanning.available).toBe(false);
      expect(row.linePlanning.limitation).toBe("NO_LINE_PLANNING_SOURCE");
    }
  });

  test("the planning axis is read exactly as Production reads it", async () => {
    const w = await world("OrderPlanning");
    const a = await ieViewer(w.co);

    /* A record created through the model carries `not_started` because the
       model's own invariant put it there — a true claim, made at creation. */
    const fresh = await call("/orders", { token: a.token, company: w.co._id });
    expect(fresh.body.rows[0].planningState).toBe("not_started");

    await WorkOrder.updateOne({ _id: w.workOrder._id }, { $set: { planningState: "released" } });
    const released = await call("/orders", { token: a.token, company: w.co._id });
    expect(released.body.rows[0].planningState).toBe("released");

    /* ── AND A LEGACY RECORD, WHICH PREDATES THE AXIS ──────────────────
       Stripped through the driver, because the model cannot write absence.
       It must read `unknown` — "we looked and the evidence does not say" —
       and never `not_started`, which would be a positive claim that planning
       had not begun. */
    await WorkOrder.collection.updateOne(
      { _id: w.workOrder._id }, { $unset: { planningState: "" } },
    );
    const legacy = await call("/orders", { token: a.token, company: w.co._id });
    expect(legacy.body.rows[0].planningState).toBe("unknown");
  });
});

/* ══ THE OPENED ORDER CARRIES ITS ROUTE ROWS ══════════════════════════════ */

describe("order detail returns the ordered operation rows, not just totals", () => {
  test("both sources return their rows, in stored order, with SAM agreeing", async () => {
    const [o1, o2] = [await op("A", "RR-1"), await op("B", "RR-2")];
    const w = await world("RowsDetail", {
      operations: [techRow(o1._id, "RR-1", "A", 1, 30), techRow(o2._id, "RR-2", "B", 0, 45)],
      productOperations: [prodRow("RR-1", "A", 1, 30), prodRow("RR-2", "B", 0, 45)],
    });
    const a = await ieViewer(w.co);
    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });

    expect(res.status).toBe(200);
    const style = res.body.styles[0];

    /* THE DEFECT THIS PINS: the worklist shape carried counts with no rows, so
       a screen drawing the route showed "no operations recorded" over a style
       that plainly had two. */
    expect(style.routeSources.technical.rows).toHaveLength(2);
    expect(style.routeSources.product.rows).toHaveLength(2);

    /* In stored order, with the fields a route table needs. */
    expect(style.routeSources.technical.rows.map((r) => r.sequence)).toEqual([1, 2]);
    expect(style.routeSources.technical.rows.map((r) => r.operationCode)).toEqual(["RR-1", "RR-2"]);
    expect(style.routeSources.technical.rows[0]).toMatchObject({
      name: "A", machineType: "SNLS", samMinutes: 1.5,
    });
    expect(style.routeSources.product.rows.map((r) => r.name)).toEqual(["A", "B"]);

    /* And the summary the rows sit beside still agrees with them. */
    expect(style.routeSources.technical.operationCount).toBe(2);
    expect(style.routeSources.technical.totalSamMinutes).toBe(2.25);
    expect(style.samMinutes).toBe(2.25);
    expect(style.comparisonState).toBe(STATE.MATCHED);
    expect(style.gaps).toBeDefined();
    expect(style.lifecycle).toBeDefined();
    expect(style.linkedVia).toBeDefined();
  });

  test("the rows equal the standalone style endpoint's, so the two cannot drift", async () => {
    const o1 = await op("A", "RR-3");
    const w = await world("RowsAgree", {
      operations: [techRow(o1._id, "RR-3", "A", 2, 0)],
      productOperations: [prodRow("RR-3", "A", 2, 0)],
    });
    const a = await ieViewer(w.co);
    const order = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });
    const style = await call(`/styles/${w.style._id}`, { token: a.token, company: w.co._id });

    expect(order.body.styles[0].routeSources.technical.rows)
      .toEqual(style.body.routes.technical.rows);
    expect(order.body.styles[0].routeSources.product.rows)
      .toEqual(style.body.routes.product.rows);
  });

  test("a HISTORICAL style still returns its rows — the reason they are not re-fetched", async () => {
    /* The standalone style read applies the active-style lifecycle admission.
       Lane A deliberately keeps completed, cancelled and archived styles on an
       order, so fetching per style would return nothing for exactly the styles
       this boundary exists to retain. */
    const o1 = await op("A", "RR-4");
    const w = await world("RowsHistorical", {
      operations: [techRow(o1._id, "RR-4", "A", 3, 0)],
    });
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { status: "cancelled" } });
    const a = await ieViewer(w.co);

    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });
    expect(res.status).toBe(200);
    const style = res.body.styles[0];
    expect(style.lifecycle.lifecycleStatus).toBe("cancelled");
    expect(style.lifecycle.historical).toBe(true);
    expect(style.routeSources.technical.rows).toHaveLength(1);
    expect(style.routeSources.technical.rows[0].samMinutes).toBe(3);
  });

  test("the rows carry no commercial, customer or Sales-parent field", async () => {
    const o1 = await op("A", "RR-5");
    const w = await world("RowsSafe", {
      operations: [techRow(o1._id, "RR-5", "A", 1, 0)],
      productOperations: [{
        type: "A", operationCode: "RR-5", machineType: "SNLS", minutes: 1, seconds: 0,
        operatorSalary: 31000, operatorCost: 9.5, salaryDept: "Stitching",
      }],
    });
    const a = await ieViewer(w.co);
    const res = await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });

    const rows = [
      ...res.body.styles[0].routeSources.technical.rows,
      ...res.body.styles[0].routeSources.product.rows,
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        "legacy", "machineType", "name", "operationCode", "operationId", "samMinutes",
        "sequence", "timeSeconds",
      ]);
    }
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/31000|Stitching|operatorCost/);
    expect(text).not.toMatch(String(w.journey._id));
    expect(text).not.toMatch(String(w.enquiry._id));
    expect(text).not.toMatch(/Northwind/);
  });
});

/* ══ 12. NOTHING COMMERCIAL LEAVES ════════════════════════════════════════ */

function allKeys(value, out = []) {
  if (Array.isArray(value)) { value.forEach((v) => allKeys(v, out)); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  }
  return out;
}

const FORBIDDEN_KEY = /journey|enquiry|customer|buyer|supplier|quotation|salar|wage|rate|cost|margin|price|amount|invoice|payment|account/i;

describe("no Sales, buyer, money or payroll field leaves an order response", () => {
  test("every key of every payload, recursively", async () => {
    const o1 = await op("Side seam", "ND-1");
    const w = await world("OrderNonDisclosure", {
      link: "orderLine",
      operations: [techRow(o1._id, "ND-1", "Side seam", 1, 30)],
      productOperations: [{
        type: "Side seam", operationCode: "ND-1", machineType: "SNLS", minutes: 2, seconds: 0,
        operatorSalary: 25000, operatorCost: 7.5, salaryDept: "Stitching", salaryDesig: "Operator",
      }],
    });
    const a = await ieViewer(w.co);

    const responses = [
      await call("/orders", { token: a.token, company: w.co._id }),
      await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id }),
      await call(`/orders/${new mongoose.Types.ObjectId()}`, { token: a.token, company: w.co._id }),
    ];

    for (const res of responses) {
      const offending = [...new Set(allKeys(res.body))].filter((k) => FORBIDDEN_KEY.test(k));
      expect(offending).toEqual([]);

      const text = JSON.stringify(res.body);
      /* The work order's own commercial fields, which the fixture DID set. */
      expect(text).not.toMatch(/Northwind/);
      expect(text).not.toMatch(String(w.workOrder.customerId));
      expect(text).not.toMatch(/184000|190500/);
      /* The customer request is a join hop and not a published record — not
         even its id, which is the key to quotations and payments. */
      expect(text).not.toMatch(String(w.request._id));
      expect(text).not.toMatch(/CR-OrderNonDisclosure/);
      /* And the Sales spine that proved the company stops at the proof. */
      expect(text).not.toMatch(String(w.journey._id));
      expect(text).not.toMatch(String(w.enquiry._id));
      expect(text).not.toMatch(/25000|Stitching|Operator/);
    }
  });

  test("an order row publishes only the declared operational fields", async () => {
    const w = await world("OrderShape");
    const a = await ieViewer(w.co);
    const res = await call("/orders", { token: a.token, company: w.co._id });
    expect(Object.keys(res.body.rows[0]).sort()).toEqual([
      "gaps", "historicalStyles", "ieReadiness", "linePlanning", "orderId", "plannedEndDate",
      "plannedQuantity", "plannedStartDate", "planningState", "priority", "product", "reference",
      "routeSummary", "status", "styleCount", "styleLinkState", "stylesReady", "stylesWithGaps",
    ]);
    expect(Object.keys(res.body.rows[0].product).sort()).toEqual(["name", "reference"]);
  });
});

/* ══ 13. A READ WRITES NOTHING ════════════════════════════════════════════ */

describe("nothing is written, migrated or backfilled by an order read", () => {
  test("no mutation path on any model is reached", async () => {
    const o1 = await op("A", "MUT-O1");
    const w = await world("OrderMutation", {
      operations: [techRow(o1._id, "MUT-O1", "A", 1, 0)],
      productOperations: [prodRow("MUT-O1", "A", 2, 0)],
    });
    const a = await ieViewer(w.co);

    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate",
        "findOneAndReplace", "replaceOne", "bulkWrite", "insertMany", "create",
        "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndDelete"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];
    try {
      for (const path of [
        "/orders", `/orders/${w.workOrder._id}`,
        `/orders/${new mongoose.Types.ObjectId()}`,
      ]) {
        const res = await call(path, { token: a.token, company: w.co._id });
        expect([200, 404]).toContain(res.status);
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  test("the order, its request, its styles and the product are unchanged afterwards", async () => {
    const o1 = await op("A", "UNCH-O1");
    const w = await world("OrderUnchanged", {
      link: "orderLine",
      operations: [techRow(o1._id, "UNCH-O1", "A", 1, 0)],
      productOperations: [prodRow("UNCH-O1", "A", 2, 0)],
    });
    const a = await ieViewer(w.co);

    const before = {
      order: await WorkOrder.findById(w.workOrder._id).lean(),
      request: await CustomerRequest.findById(w.request._id).lean(),
      style: await SampleStyle.findById(w.style._id).lean(),
      product: await StockItem.findById(w.product._id).lean(),
      operation: await Operation.findById(o1._id).lean(),
    };

    await call("/orders", { token: a.token, company: w.co._id });
    await call(`/orders/${w.workOrder._id}`, { token: a.token, company: w.co._id });

    expect(await WorkOrder.findById(w.workOrder._id).lean()).toEqual(before.order);
    expect(await CustomerRequest.findById(w.request._id).lean()).toEqual(before.request);
    expect(await SampleStyle.findById(w.style._id).lean()).toEqual(before.style);
    expect(await StockItem.findById(w.product._id).lean()).toEqual(before.product);
    expect(await Operation.findById(o1._id).lean()).toEqual(before.operation);
  });
});
