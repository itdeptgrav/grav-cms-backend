// test/industrial-engineering/ie-lane-a-lifecycle.test.js
//
// IE LANE A — A CLOSED STYLE PROVES OWNERSHIP; IT DOES NOT DELETE AN ORDER.
//
// The decision: company ownership is permanent record provenance, and lifecycle
// status controls QUEUE PARTICIPATION rather than ownership. Before Lane A a
// terminal style made its work order vanish from IE — the Chunk 1C audit
// measured six of the seven orders whose two style references AGREED lost
// exactly that way.
//
// What must NOT change is any cross-company protection, and what must not
// change AT ALL is Merchandising: its queues still exclude the same styles they
// always did. Both are asserted here rather than assumed.
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
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const {
  styleOwnershipClause,
} = require("../../services/companyContext/merchandisingScope.service");
const { OWNERSHIP_MODE } = require("../../services/industrialEngineering/ieOrders.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
  }).then(async (r) => {
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text || "null"); } catch { body = { nonJson: true }; }
    return { status: r.status, body };
  });

async function ieViewer(co) {
  const n = ++seq;
  const email = `lane${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "L", lastName: `A${n}`, email, biometricId: `LA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "U", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
  await DepartmentRole.create({
    departmentSlug: "ie", email, name: "U", role: "viewer", isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });
  return jwt.sign(
    { id: String(emp._id), email, name: "L", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

async function company(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-LA-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "J", isActive: true,
  });
  const enq = await Enquiry.create({
    enquiryId: `ENQ-LA-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: "E", isActive: true, products: [{ product: "Tee", quantity: 1 }],
  });
  return { co, journey, enquiry: enq };
}

const product = (label) => StockItem.create({
  name: `Tee ${label}`, sku: `SKU-LA-${label}-${++seq}`, reference: `REF-LA-${label}-${seq}`,
  category: "Garment", createdBy: new mongoose.Types.ObjectId(),
  quantityOnHand: 0, minStock: 0, maxStock: 10,
  variants: [{ sku: `VAR-LA-${label}-${seq}`, cost: 0, salesPrice: 0 }],
});

const workOrder = (label, { stockItem, status = "scheduled" } = {}) => WorkOrder.create({
  workOrderNumber: `WO-LA-${label}-${++seq}`,
  ...(stockItem ? {
    stockItemId: stockItem._id, stockItemName: stockItem.name, stockItemReference: stockItem.reference,
  } : {}),
  quantity: 100, originalQuantity: 100, status,
  timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
  customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
  estimatedCost: 5000, actualCost: 5100,
});

const style = (ctx, label, { workOrderIds, status, isActive, stockItem } = {}) =>
  SampleStyle.create({
    sampleStyleId: `SS-LA-${label}-${++seq}`, productName: `Tee ${label}`,
    styleCode: `ST-${label}`, variantLabel: "Navy",
    journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id,
    ...(stockItem ? { sourceStockItemId: stockItem._id } : {}),
    ...(status ? { status } : {}),
    ...(isActive === undefined ? {} : { isActive }),
    materials: { status: "pending", rawItems: [] },
    techSheet: { technical: { status: "draft" } },
    ...(workOrderIds ? { production: { workOrderIds } } : {}),
  });

/** One company, one product, one open order, one style of the given lifecycle. */
async function world(label, { status, isActive, orderStatus = "scheduled" } = {}) {
  const ctx = await company(label);
  const item = await product(label);
  const order = await workOrder(label, { stockItem: item, status: orderStatus });
  const s = await style(ctx, label, { workOrderIds: [order._id], status, isActive, stockItem: item });
  const token = await ieViewer(ctx.co);
  return { ...ctx, product: item, order, style: s, token };
}

const open = (w) => call(`/orders/${w.order._id}`, { token: w.token, company: w.co._id });

/* ══ 1–3, 5. A CLOSED STYLE STILL PROVES ITS ORDER ════════════════════════ */

describe("lifecycle status no longer erases a work order", () => {
  test("1 — a COMPLETED style admits its order, with no warning", async () => {
    /* The normal case: development finished and the factory is making it.
       Completed is not a defect and must never be reported as one. */
    const w = await world("Completed", { status: "completed" });
    const res = await open(w);

    expect(res.status).toBe(200);
    expect(res.body.styles.map((s) => s.styleId)).toEqual([String(w.style._id)]);
    expect(res.body.styles[0].lifecycle).toMatchObject({
      lifecycleStatus: "completed", recordActive: true, historical: true, warnings: [],
    });
    expect(res.body.order.historicalStyles).toBe(1);
    /* No warning, and nothing in the gaps calls it defective. */
    expect(JSON.stringify(res.body.order.gaps)).not.toMatch(/CANCELLED_STYLE|INACTIVE_STYLE/);
  });

  test("2 — a CANCELLED style admits its order and returns a typed warning", async () => {
    const w = await world("Cancelled", { status: "cancelled" });
    const res = await open(w);

    expect(res.status).toBe(200);
    expect(res.body.styles.map((s) => s.styleId)).toEqual([String(w.style._id)]);
    expect(res.body.styles[0].lifecycle.lifecycleStatus).toBe("cancelled");
    expect(res.body.styles[0].lifecycle.historical).toBe(true);
    expect(res.body.styles[0].lifecycle.warnings.map((x) => x.code))
      .toEqual(["CANCELLED_STYLE_ON_ACTIVE_ORDER"]);

    /* And the LIST carries it, because a list row has no styles on it. */
    const gap = res.body.order.gaps.find((g) => g.code === "CANCELLED_STYLE_ON_ACTIVE_ORDER");
    expect(gap).toMatchObject({ owner: "INDUSTRIAL_ENGINEERING", action: "REVIEW_STYLE_LIFECYCLE" });
    const list = await call("/orders", { token: w.token, company: w.co._id });
    expect(list.body.rows[0].gaps.map((g) => g.code)).toContain("CANCELLED_STYLE_ON_ACTIVE_ORDER");
  });

  test("3 — an INACTIVE style admits its order and warns while the order is open", async () => {
    const w = await world("Inactive", { isActive: false });
    const res = await open(w);

    expect(res.status).toBe(200);
    expect(res.body.styles[0].lifecycle).toMatchObject({
      lifecycleStatus: "active", recordActive: false, historical: true,
    });
    expect(res.body.styles[0].lifecycle.warnings.map((x) => x.code))
      .toEqual(["INACTIVE_STYLE_ON_ACTIVE_ORDER"]);
  });

  test("a closed style behind a CLOSED order is history, not a contradiction", async () => {
    /* No warning is fabricated where the combination is valid: the work
       finished, and the record was closed afterwards. */
    for (const [label, spec] of [
      ["DoneCancelled", { status: "cancelled", orderStatus: "completed" }],
      ["DoneInactive", { isActive: false, orderStatus: "completed" }],
    ]) {
      const w = await world(label, spec);
      const res = await open(w);
      expect(res.status).toBe(200);
      expect(res.body.styles[0].lifecycle.warnings).toEqual([]);
      expect(res.body.styles[0].lifecycle.historical).toBe(true);
    }
  });

  test("5 — an ACTIVE style behaves exactly as before", async () => {
    const w = await world("Active");
    const res = await open(w);
    expect(res.status).toBe(200);
    expect(res.body.styles[0].lifecycle).toMatchObject({
      lifecycleStatus: "active", recordActive: true, historical: false, warnings: [],
    });
    expect(res.body.order.historicalStyles).toBe(0);
  });

  test("both lifecycle faults at once are reported once each", async () => {
    const w = await world("Both", { status: "cancelled", isActive: false });
    const res = await open(w);
    expect(res.body.styles[0].lifecycle.warnings.map((x) => x.code).sort())
      .toEqual(["CANCELLED_STYLE_ON_ACTIVE_ORDER", "INACTIVE_STYLE_ON_ACTIVE_ORDER"]);
  });
});

/* ══ 4. MERCHANDISING IS UNCHANGED ════════════════════════════════════════ */

describe("ownership and queue eligibility are separate concepts", () => {
  test("4 — terminal and inactive styles stay OUT of the active Merchandising queue", async () => {
    const ctx = await company("QueueScope");
    const active = await style(ctx, "QActive");
    const completed = await style(ctx, "QCompleted", { status: "completed" });
    const cancelled = await style(ctx, "QCancelled", { status: "cancelled" });
    const inactive = await style(ctx, "QInactive", { isActive: false });

    /* The default — what every Merchandising caller passes — is unchanged. */
    const queueClause = await styleOwnershipClause(ctx.co._id);
    const queued = await SampleStyle.find(queueClause).select("_id").lean();
    expect(queued.map((r) => String(r._id))).toEqual([String(active._id)]);

    /* IE's mode proves ownership for all four. */
    const ieClause = await styleOwnershipClause(ctx.co._id, OWNERSHIP_MODE);
    const owned = await SampleStyle.find(ieClause).select("_id").lean();
    expect(owned.map((r) => String(r._id)).sort()).toEqual(
      [active, completed, cancelled, inactive].map((x) => String(x._id)).sort(),
    );
  });

  test("6 — a missing or company-less journey stays unprovable even with an owned enquiry", async () => {
    /* Lane A relaxed the LIFECYCLE clauses and nothing else. The parentage
       rule is untouched: a style that names a journey is proved by that
       journey or by nothing. */
    const ctx = await company("ParentageLaneA");
    const item = await product("ParentageLaneA");
    const order = await workOrder("ParentageLaneA", { stockItem: item });
    const s = await style(ctx, "ParentageLaneA", {
      workOrderIds: [order._id], status: "completed", stockItem: item,
    });
    const token = await ieViewer(ctx.co);

    /* It works while the journey resolves... */
    expect((await call(`/orders/${order._id}`, { token, company: ctx.co._id })).status).toBe(200);

    /* ...and stops the moment the journey dangles, enquiry notwithstanding. */
    await SampleStyle.collection.updateOne({ _id: s._id },
      { $set: { journeyId: new mongoose.Types.ObjectId() } });
    expect((await call(`/orders/${order._id}`, { token, company: ctx.co._id })).status).toBe(404);

    /* And the same for a journey that resolves but carries no company. */
    const unowned = await SalesJourney.create({
      journeyId: `SJ-LA-UNOWNED-${++seq}`, accountId: new mongoose.Types.ObjectId(),
      ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "J", isActive: true,
    });
    await SampleStyle.collection.updateOne({ _id: s._id }, { $set: { journeyId: unowned._id } });
    expect((await call(`/orders/${order._id}`, { token, company: ctx.co._id })).status).toBe(404);
  });

  test("7 — a journey/enquiry company conflict follows the journey", async () => {
    const owner = await company("LaneAJourneyOwner");
    const other = await company("LaneAEnquiryOther");
    const item = await product("LaneASplit");
    const order = await workOrder("LaneASplit", { stockItem: item });
    await SampleStyle.create({
      sampleStyleId: `SS-LA-SPLIT-${++seq}`, productName: "Tee", styleCode: "ST-LASplit",
      journeyId: owner.journey._id, enquiryId: other.enquiry._id,
      status: "completed", sourceStockItemId: item._id,
      materials: { status: "pending", rawItems: [] },
      techSheet: { technical: { status: "draft" } },
      production: { workOrderIds: [order._id] },
    });

    const ownerToken = await ieViewer(owner.co);
    const otherToken = await ieViewer(other.co);
    expect((await call(`/orders/${order._id}`, { token: ownerToken, company: owner.co._id })).status)
      .toBe(200);
    /* The enquiry's company gets nothing — it was never a second claim. */
    expect((await call(`/orders/${order._id}`, { token: otherToken, company: other.co._id })).status)
      .toBe(404);
  });
});

/* ══ 8–9. CROSS-COMPANY PROTECTION IS UNWEAKENED ══════════════════════════ */

describe("Lane A weakens no cross-company protection", () => {
  test("8 — a cross-company reference conflict is still denied to both", async () => {
    /* And now with TERMINAL styles on both ends, which the old rule would have
       made invisible for the wrong reason. */
    const one = await company("LaneAConfOne");
    const two = await company("LaneAConfTwo");
    const item = await product("LaneAConf");
    const order = await workOrder("LaneAConf", { stockItem: item });

    await style(one, "LaneAConfDirect", {
      workOrderIds: [order._id], status: "completed", stockItem: await product("LaneAConfD"),
    });
    const lineStyle = await style(two, "LaneAConfLine", { status: "cancelled", stockItem: item });
    const request = await require("../../models/Customer_Models/CustomerRequest").create({
      requestId: `CR-LA-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "Northwind", email: "b@x.test", phone: "1" },
      items: [{ stockItemId: item._id, sampleStyleId: lineStyle._id, totalQuantity: 10 }],
    });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { customerRequestId: request._id } });

    for (const ctx of [one, two]) {
      const token = await ieViewer(ctx.co);
      const list = await call("/orders", { token, company: ctx.co._id });
      expect(list.body.rows.map((r) => r.orderId)).not.toContain(String(order._id));
      expect((await call(`/orders/${order._id}`, { token, company: ctx.co._id })).status).toBe(404);
    }
  });

  test("9 — a same-company reference conflict still attaches no disputed style", async () => {
    const ctx = await company("LaneASameConf");
    const item = await product("LaneASameConf");
    const order = await workOrder("LaneASameConf", { stockItem: item });
    const directStyle = await style(ctx, "LaneASameDirect", {
      workOrderIds: [order._id], status: "completed", stockItem: await product("LaneASameD"),
    });
    const lineStyle = await style(ctx, "LaneASameLine", { status: "cancelled", stockItem: item });
    const request = await require("../../models/Customer_Models/CustomerRequest").create({
      requestId: `CR-LAS-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "Northwind", email: "b@x.test", phone: "1" },
      items: [{ stockItemId: item._id, sampleStyleId: lineStyle._id, totalQuantity: 10 }],
    });
    await WorkOrder.updateOne({ _id: order._id }, { $set: { customerRequestId: request._id } });

    const token = await ieViewer(ctx.co);
    const res = await call(`/orders/${order._id}`, { token, company: ctx.co._id });
    expect(res.status).toBe(200);
    expect(res.body.order.styleLinkState).toBe("REFERENCES_CONFLICT");
    expect(res.body.styles).toEqual([]);
    expect(res.body.order.gaps.map((g) => g.code)).toContain("STYLE_LINK_CONFLICT");
    expect(JSON.stringify(res.body)).not.toMatch(String(directStyle._id));
    expect(JSON.stringify(res.body)).not.toMatch(String(lineStyle._id));
  });
});

/* ══ 10–12. AGREEMENT, NON-DISCLOSURE AND READ-ONLY ═══════════════════════ */

function allKeys(value, out = []) {
  if (Array.isArray(value)) { value.forEach((v) => allKeys(v, out)); return out; }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) { out.push(k); allKeys(v, out); }
  }
  return out;
}
const FORBIDDEN_KEY = /journey|enquiry|customer|buyer|supplier|quotation|salar|wage|rate|cost|margin|price|amount|invoice|payment|account/i;

describe("Lane A keeps every existing guarantee", () => {
  test("10 — endpoint and audit agree on a terminal style's order", async () => {
    const { classifyOrder } = require("../../services/industrialEngineering/ieOrderAudit");
    const { styleOwnersFor } = require("../../services/industrialEngineering/ieOrders.service");

    for (const spec of [
      { status: "completed" }, { status: "cancelled" }, { isActive: false }, {},
    ]) {
      const w = await world(`Agree${spec.status || (spec.isActive === false ? "Inactive" : "Active")}`, spec);
      const endpoint = await open(w);

      const orderDoc = await WorkOrder.findById(w.order._id)
        .select("_id workOrderNumber status stockItemId customerRequestId").lean();
      const naming = await SampleStyle.find({ "production.workOrderIds": orderDoc._id })
        .select("_id").lean();
      const owners = await styleOwnersFor(naming.map((x) => String(x._id)));
      const audit = classifyOrder({
        order: orderDoc, request: null,
        directStyleIds: naming.map((x) => String(x._id)),
        companyOf: (sid) => owners.get(String(sid)) || null,
      });

      expect(audit.visibleToOneCompany).toBe(endpoint.status === 200);
      expect(audit.displayableStyles).toBe(endpoint.body.styles.length);
    }
  });

  test("11 — no commercial, customer, payroll or Sales-parent field leaves", async () => {
    const w = await world("LaneANonDisclosure", { status: "cancelled" });
    const responses = [
      await open(w),
      await call("/orders", { token: w.token, company: w.co._id }),
    ];
    for (const res of responses) {
      expect([...new Set(allKeys(res.body))].filter((k) => FORBIDDEN_KEY.test(k))).toEqual([]);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/Northwind/);
      expect(text).not.toMatch(String(w.journey._id));
      expect(text).not.toMatch(String(w.enquiry._id));
      expect(text).not.toMatch(/5000|5100/);
    }
  });

  test("12 — reading a terminal style's order writes nothing", async () => {
    const w = await world("LaneAReadOnly", { status: "cancelled", isActive: false });
    const before = await SampleStyle.findById(w.style._id).lean();

    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "bulkWrite", "deleteOne", "deleteMany"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];
    try {
      await open(w);
      await call("/orders", { token: w.token, company: w.co._id });
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    /* The style's lifecycle is READ, never repaired. */
    expect(await SampleStyle.findById(w.style._id).lean()).toEqual(before);
  });
});
