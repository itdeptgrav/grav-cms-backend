// test/store-purchase/purchase-workspace.route.test.js
//
// THE PURCHASE WORKSPACE READ — WHAT NEEDS SOURCING, DRAFTED, ORDERED, DONE.
//
// The mistakes that matter here are all ones that make a screen look tidy while
// misreporting money or state: a cancelled order counted as completed, two
// currencies added into one figure, an expired quotation relabelled withdrawn,
// a pending receipt quantity recomputed behind Receive's back, or a source that
// threw reported as an empty tab.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const svc = require("../../services/storePurchase/purchaseWorkspace.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `PW${seq}`, name: "Pw", email: "p@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    .then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(co, { grant = "store", role = "approver" } = {}) {
  const n = ++seq; const email = `pw${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, name: "PW", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "PW" });
  return tokenFor({ id: String(employeeRef), email });
}
async function outsider(co) {
  const n = ++seq; const email = `no${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "No" });
  return tokenFor({ id: String(employeeRef), email });
}

const makePO = (co, over = {}) => PurchaseOrder.create({
  companyId: co._id, poNumber: `PO/${++seq}`, status: over.status || "ISSUED",
  createdBy: new mongoose.Types.ObjectId(),
  vendorName: over.vendorName || "Acme Mills", vendor: new mongoose.Types.ObjectId(),
  subtotal: 0, taxAmount: 0, totalAmount: over.totalAmount ?? 100000,
  ...(over.currency ? { currency: over.currency } : {}),
  ...(over.orderDate ? { orderDate: over.orderDate } : {}),
  ...(over.expectedDeliveryDate ? { expectedDeliveryDate: over.expectedDeliveryDate } : {}),
  items: over.items || [{
    _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(),
    itemName: "Fabric", sku: "F-1", unit: "m", quantity: 100, unitPrice: 10, totalPrice: 1000,
    receivedQuantity: 0, pendingQuantity: 100, status: "PENDING",
  }],
});

const makeSO = (co, over = {}) => ServiceOrder.create({
  companyId: co._id, serviceOrderNumber: `SVO/${++seq}`, status: over.status || "ISSUED",
  spendRequestId: new mongoose.Types.ObjectId(), spendRequestNumber: `SR-${seq}`,
  vendorName: over.vendorName || "Fix It Co", title: over.title || "AMC",
  department: over.department || "Logistics",
  requestedById: `RQ${seq}`, requestedByName: "Rutu",
  lines: [{ serviceCode: "SVC-1", serviceName: "AMC", billingUnit: "visit", quantity: 1, rate: 500, netAmount: 500, gstRate: 0, gstAmount: 0, lineTotal: 500 }],
  subtotal: 500, taxAmount: 0, totalAmount: over.totalAmount ?? 500,
});

/**
 * An approved spend request — the demand that starts purchasing.
 *
 * Written straight to the collection rather than through the request router:
 * this suite is testing how the workspace READS approved demand, and driving a
 * five-step approval chain to reach one state would test that chain instead.
 */
const makeNeed = (co, over = {}) => SpendRequest.collection.insertOne({
  companyId: co._id,
  requestNumber: over.requestNumber || `SR/${++seq}`,
  title: over.title || "Two laptops for the sampling room",
  requestType: over.requestType || "PRODUCT",
  status: over.status || "approved",
  department: over.department || "Sampling",
  requestedByName: over.requestedByName || "Rutu",
  neededBy: over.neededBy || null,
  priority: over.priority || "NORMAL",
  totalAmount: over.totalAmount ?? 120000,
  financeApprovedAt: over.financeApprovedAt || new Date("2026-09-01"),
  createdAt: new Date("2026-08-25"),
  purpose: "Sampling capacity",
}).then((r) => ({ _id: r.insertedId, requestNumber: over.requestNumber || `SR/${seq}` }));

/** A supplier quotation, with every field its own validator requires. */
const makeOffer = (co, over = {}) => SupplierOffer.create({
  companyId: co._id,
  supplierId: new mongoose.Types.ObjectId(),
  supplierName: over.supplierName || "Acme Mills",
  itemId: new mongoose.Types.ObjectId(),
  itemName: over.itemName || "Fabric",
  quotationReference: over.quotationReference || `Q/${++seq}`,
  purchaseUom: "m",
  unitPriceMinor: 1000,
  priceBasis: "TAX_EXCLUSIVE",
  currency: "INR",
  status: over.status || "ACTIVE",
  ...(Object.prototype.hasOwnProperty.call(over, "validUntil") ? { validUntil: over.validUntil } : {}),
  createdBy: new mongoose.Types.ObjectId(),
});

const WS = "/api/cms/purchase-orders/workspace";

/* ── ROUTE ORDERING AND ACCESS ───────────────────────────────────────────── */

describe("reaching the workspace", () => {
  test("`workspace` is not swallowed by the purchase-order id route", async () => {
    const co = await company(); const token = await actor(co);
    const res = await call(`${WS}?stage=on-order`, { token });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stage).toBe("on-order");
  });

  test("the Store read capability is required", async () => {
    const co = await company(); const token = await outsider(co);
    const res = await call(WS, { token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.rows).toBeUndefined();
  });

  test("all four tabs are served, and an unknown one falls back", async () => {
    const co = await company(); const token = await actor(co);
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      const r = await call(`${WS}?stage=${stage}`, { token });
      expect(r.status).toBe(200);
      expect(r.body.stage).toBe(stage);
    }
    const bad = await call(`${WS}?stage=nonsense&type=nonsense&status=nonsense`, { token });
    expect(bad.body.stage).toBe("to-source");
    expect(bad.body.type).toBe("all");
    expect(bad.body.status).toBe("open");
  });

  test("another company's purchasing is never visible", async () => {
    const a = await company(); const b = await company();
    const tokenB = await actor(b);
    await makePO(a, { vendorName: "Acme Mills", status: "ISSUED" });
    await makeSO(a, { vendorName: "Fix It Co" });
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      const r = await call(`${WS}?stage=${stage}`, { token: tokenB });
      expect(r.body.rows).toEqual([]);
    }
  });
});

/* ── STAGE MAPPING FROM STORED STATUS ────────────────────────────────────── */

describe("stage comes from stored status", () => {
  test("material orders map exactly as documented", () => {
    expect(svc.MATERIAL_STAGE).toEqual({
      DRAFT: "draft-orders",
      ISSUED: "on-order",
      PARTIALLY_RECEIVED: "on-order",
      COMPLETED: "completed",
    });
    /* CANCELLED is deliberately absent — it is not a tab. */
    expect(svc.MATERIAL_STAGE.CANCELLED).toBeUndefined();
  });

  test("service orders map exactly as documented, including the two live middles", () => {
    expect(svc.SERVICE_STAGE.DRAFT).toBe("draft-orders");
    expect(svc.SERVICE_STAGE.ISSUED).toBe("on-order");
    expect(svc.SERVICE_STAGE.IN_PROGRESS).toBe("on-order");
    /* The supplier says done; the department has not accepted. Not completed. */
    expect(svc.SERVICE_STAGE.COMPLETION_REPORTED).toBe("on-order");
    /* A correction is outstanding, so the order is live. */
    expect(svc.SERVICE_STAGE.REWORK_REQUIRED).toBe("on-order");
    expect(svc.SERVICE_STAGE.ACCEPTED).toBe("completed");
    expect(svc.SERVICE_STAGE.CANCELLED).toBeUndefined();
  });

  test("a draft material order appears under Draft orders and nowhere else", async () => {
    const co = await company(); const token = await actor(co);
    const po = await makePO(co, { status: "DRAFT" });
    const draft = await call(`${WS}?stage=draft-orders&type=material`, { token });
    expect(draft.body.rows.map((r) => r.id)).toContain(String(po._id));
    for (const stage of ["on-order", "completed"]) {
      const r = await call(`${WS}?stage=${stage}&type=material`, { token });
      expect(r.body.rows.map((x) => x.id)).not.toContain(String(po._id));
    }
  });

  test("a partially received order is on order, and its stored line state is read not recomputed", async () => {
    const co = await company(); const token = await actor(co);
    const po = await makePO(co, {
      status: "PARTIALLY_RECEIVED",
      items: [
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Fabric", sku: "F", unit: "m", quantity: 100, unitPrice: 1, totalPrice: 100, receivedQuantity: 40, pendingQuantity: 60, status: "PARTIALLY_RECEIVED" },
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Thread", sku: "T", unit: "cone", quantity: 5, unitPrice: 1, totalPrice: 5, receivedQuantity: 5, pendingQuantity: 0, status: "COMPLETED" },
      ],
    });
    const r = await call(`${WS}?stage=on-order&type=material`, { token });
    const row = r.body.rows.find((x) => x.id === String(po._id));
    expect(row.exactStatus).toBe("PARTIALLY_RECEIVED");
    /* One line still awaits receipt. Counted from the order's OWN stored line
       statuses — no quantity is recomputed and no receipt-control state is
       derived, both of which belong to Receive. */
    expect(row.linesAwaitingReceipt).toBe(1);
    expect(row.lineCount).toBe(2);
    expect(row).not.toHaveProperty("pendingQuantity");
    expect(row).not.toHaveProperty("receivedQuantity");
  });

  test("a service order in each live status lands on order with its exact status", async () => {
    const co = await company(); const token = await actor(co);
    const made = {};
    for (const status of ["ISSUED", "IN_PROGRESS", "COMPLETION_REPORTED", "REWORK_REQUIRED"]) {
      made[status] = await makeSO(co, { status });
    }
    const r = await call(`${WS}?stage=on-order&type=service`, { token });
    for (const [status, so] of Object.entries(made)) {
      const row = r.body.rows.find((x) => x.id === String(so._id));
      expect(row).toBeTruthy();
      expect(row.exactStatus).toBe(status);
      expect(row.recordType).toBe("service-order");
    }
  });
});

/* ── CANCELLED / SUPERSEDED / WITHDRAWN / EXPIRED KEEP THEIR STATUS ──────── */

describe("closed records keep their exact status", () => {
  test("a cancelled order is never called completed", async () => {
    const co = await company(); const token = await actor(co);
    const po = await makePO(co, { status: "CANCELLED" });
    const so = await makeSO(co, { status: "CANCELLED" });

    /* Not in any of the four tabs. */
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      const r = await call(`${WS}?stage=${stage}`, { token });
      const ids = r.body.rows.map((x) => x.id);
      expect(ids).not.toContain(String(po._id));
      expect(ids).not.toContain(String(so._id));
    }
    /* But findable through the explicit status filter, with the real word. */
    const closed = await call(`${WS}?stage=completed&status=closed`, { token });
    const poRow = closed.body.rows.find((x) => x.id === String(po._id));
    expect(poRow).toBeTruthy();
    expect(poRow.exactStatus).toBe("CANCELLED");
    expect(poRow.exactStatus).not.toBe("COMPLETED");
  });

  test("an expired offer keeps its stored status and is flagged expired separately", () => {
    const asOf = new Date("2026-09-28");
    const live = svc.stageOfOffer({ status: "ACTIVE", validUntil: new Date("2026-12-31") }, asOf);
    expect(live).toEqual({ stage: "to-source", expired: false });

    const stale = svc.stageOfOffer({ status: "ACTIVE", validUntil: new Date("2026-01-01") }, asOf);
    /* Out of To source — nobody can source from it — but its stored status is
       untouched, because expiry is what the clock did, not what a person did. */
    expect(stale).toEqual({ stage: null, expired: true });

    const row = svc.offerRow(
      { _id: "o1", status: "ACTIVE", validUntil: new Date("2026-01-01"), supplierName: "S", itemName: "Fabric", quotationReference: "Q-1", revision: 2, currency: "INR" },
      { purchaseType: "material", asOf, hrefBase: "/store/dashboard/supplier-offers" },
    );
    expect(row.exactStatus).toBe("ACTIVE");
    expect(row.expired).toBe(true);
    expect(row.exactStatus).not.toBe("WITHDRAWN");
  });

  test("withdrawn and superseded offers are closed, not completed", () => {
    const asOf = new Date("2026-09-28");
    for (const status of ["WITHDRAWN", "SUPERSEDED"]) {
      expect(svc.stageOfOffer({ status, validUntil: null }, asOf).stage).toBeNull();
    }
    expect(svc.CLOSED_STATUS).toEqual(expect.arrayContaining(["CANCELLED", "SUPERSEDED", "WITHDRAWN"]));
  });
});

/* ── MONEY AND UNITS ────────────────────────────────────────────────────── */

describe("money and units", () => {
  test("two currencies are never added into one figure", () => {
    const s = svc.summarise([
      { recordType: "material-order", totalAmount: 100000, currency: "INR" },
      { recordType: "material-order", totalAmount: 900, currency: "USD" },
      { recordType: "service-order", totalAmount: 50000, currency: "INR" },
    ]);
    const by = Object.fromEntries(s.totalsByCurrency.map((t) => [t.currency, t.amount]));
    expect(by.INR).toBe(150000);
    expect(by.USD).toBe(900);
    /* No single combined total exists to be misread. */
    expect(s).not.toHaveProperty("totalAmount");
    expect(s).not.toHaveProperty("grandTotal");
  });

  test("an order with no recorded amount is counted, never valued at zero", () => {
    const s = svc.summarise([
      { recordType: "material-order", totalAmount: null, currency: "INR" },
      { recordType: "material-order", totalAmount: 100, currency: "INR" },
    ]);
    expect(s.unvaluedCount).toBe(1);
    expect(s.totalsByCurrency).toEqual([{ currency: "INR", amount: 100 }]);
  });

  /* ── ONLY THINGS THAT HAVE AN ORDERED VALUE ────────────────────────────
     A quotation is a rate for a quantity nobody committed to, a decision is an
     open question, and an approved need has an APPROVED amount, not an ordered
     one. Counting any of them as "not valued" would report them as orders
     somebody forgot to price. */
  test("needs, quotations and decisions are not counted as unpriced orders", () => {
    const s = svc.summarise([
      { recordType: "material-order", totalAmount: 500, currency: "INR" },
      { recordType: "need", approvedAmount: 9999, currency: "INR" },
      { recordType: "offer", currency: "INR" },
      { recordType: "decision", currency: null },
    ]);
    expect(s.totalsByCurrency).toEqual([{ currency: "INR", amount: 500 }]);
    expect(s.unvaluedCount).toBe(0);
    /* The figures describe one order, though four rows are on screen. */
    expect(s.valuedRecordCount).toBe(1);
    expect(s.rowCount).toBe(4);
    /* Needs are counted in their own right, never valued. */
    expect(s.needCount).toBe(1);
  });

  test("an approved need's amount never reaches the stage total", () => {
    const s = svc.summarise([{ recordType: "need", approvedAmount: 100000, totalAmount: 100000, currency: "INR" }]);
    expect(s.totalsByCurrency).toEqual([]);
    expect(s.needCount).toBe(1);
  });

  test("a mixed-unit order reports a line count, never a summed quantity", async () => {
    const co = await company(); const token = await actor(co);
    /* Metres and cones have no total. */
    const po = await makePO(co, {
      status: "ISSUED",
      items: [
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Fabric", sku: "F", unit: "m", quantity: 100, unitPrice: 1, totalPrice: 100, receivedQuantity: 0, pendingQuantity: 100, status: "PENDING" },
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Thread", sku: "T", unit: "cone", quantity: 20, unitPrice: 1, totalPrice: 20, receivedQuantity: 0, pendingQuantity: 20, status: "PENDING" },
      ],
    });
    const r = await call(`${WS}?stage=on-order&type=material`, { token });
    const row = r.body.rows.find((x) => x.id === String(po._id));
    expect(row.lineCount).toBe(2);
    expect(row.title).toBe("2 items");
    for (const field of ["totalQuantity", "quantity", "orderedQuantity"]) {
      expect(row).not.toHaveProperty(field);
    }
  });

  test("an offer carries no order value to be mistaken for a commitment", () => {
    const row = svc.offerRow(
      { _id: "o2", status: "ACTIVE", validUntil: new Date("2027-01-01"), supplierName: "S", itemName: "Fabric", quotationReference: "Q-2", revision: 1, currency: "INR" },
      { purchaseType: "material", asOf: new Date("2026-09-28"), hrefBase: "/store/dashboard/supplier-offers" },
    );
    /* A quotation is a rate for a quantity nobody has committed to. */
    expect(row).not.toHaveProperty("totalAmount");
    expect(row.currency).toBe("INR");
  });
});

/* ── ROW SHAPES DO NOT BORROW EACH OTHER'S FIELDS ────────────────────────── */

describe("the row contract", () => {
  test("a service row carries no material-only field, and vice versa", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, { status: "ISSUED", expectedDeliveryDate: new Date("2026-10-10") });
    await makeSO(co, { status: "ISSUED", department: "Logistics" });
    const r = await call(`${WS}?stage=on-order`, { token });

    const material = r.body.rows.find((x) => x.recordType === "material-order");
    const service = r.body.rows.find((x) => x.recordType === "service-order");

    expect(material.expectedDate).toBeTruthy();
    expect(material.linesAwaitingReceipt).toBeDefined();
    expect(material).not.toHaveProperty("requestedFor");

    /* A service has no delivery and no receipt lines. Absent, not null — a null
       "Expected" column invites somebody to read a date into it. */
    expect(service).not.toHaveProperty("expectedDate");
    expect(service).not.toHaveProperty("linesAwaitingReceipt");
    expect(service.requestedFor).toBe("Logistics");
  });

  test("every row names its record type and purchase type", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, { status: "ISSUED" });
    await makeSO(co, { status: "ISSUED" });
    const r = await call(`${WS}?stage=on-order`, { token });
    for (const row of r.body.rows) {
      expect(["material-order", "service-order", "offer", "decision"]).toContain(row.recordType);
      expect(["material", "service", "freight"]).toContain(row.purchaseType);
      expect(typeof row.exactStatus).toBe("string");
      expect(row.nextAction.code).toBeTruthy();
      expect(row.nextAction.href).toMatch(/^\/store\/dashboard\//);
    }
  });
});

/* ── NEXT ACTIONS OPEN EXISTING WORKFLOWS ───────────────────────────────── */

describe("next actions", () => {
  test("a draft order continues in the existing editor; an issued one opens detail", async () => {
    const co = await company(); const token = await actor(co);
    const draft = await makePO(co, { status: "DRAFT" });
    const live = await makePO(co, { status: "ISSUED" });

    const d = await call(`${WS}?stage=draft-orders&type=material`, { token });
    const dRow = d.body.rows.find((x) => x.id === String(draft._id));
    expect(dRow.nextAction.code).toBe("CONTINUE_DRAFT");
    expect(dRow.nextAction.href).toBe(`/store/dashboard/operations/purchase-order/new-edit-purchase-order/${String(draft._id)}`);

    const o = await call(`${WS}?stage=on-order&type=material`, { token });
    const oRow = o.body.rows.find((x) => x.id === String(live._id));
    expect(oRow.nextAction.code).toBe("REVIEW_ORDER");
    expect(oRow.nextAction.href).toBe(`/store/dashboard/operations/purchase-order/${String(live._id)}`);
  });

  test("a draft service order offers issuing, on its existing detail page", async () => {
    const co = await company(); const token = await actor(co);
    const so = await makeSO(co, { status: "DRAFT" });
    const r = await call(`${WS}?stage=draft-orders&type=service`, { token });
    const row = r.body.rows.find((x) => x.id === String(so._id));
    expect(row.nextAction.code).toBe("ISSUE_ORDER");
    expect(row.nextAction.href).toBe(`/store/dashboard/operations/service-orders/${String(so._id)}`);
  });

  test("a completed order offers viewing, not an action it cannot take", async () => {
    const co = await company(); const token = await actor(co);
    const po = await makePO(co, { status: "COMPLETED" });
    const r = await call(`${WS}?stage=completed&type=material`, { token });
    expect(r.body.rows.find((x) => x.id === String(po._id)).nextAction.code).toBe("VIEW_COMPLETED");
  });

  /* ── THE LABEL MUST MATCH THE DESTINATION ──────────────────────────────
     This link opens ONE quotation's detail page, which is not a comparison.
     It used to be labelled "Compare offers", promising a screen it did not
     open; comparing is what the sourcing decision does, and that is a
     different row with its own destination. */
  test("an active offer opens that one quotation, and says so", () => {
    const row = svc.offerRow(
      { _id: "o3", status: "ACTIVE", validUntil: new Date("2027-01-01"), supplierName: "S", itemName: "Fabric", quotationReference: "Q-3", revision: 1, currency: "INR" },
      { purchaseType: "material", asOf: new Date("2026-09-28"), hrefBase: "/store/dashboard/supplier-offers" },
    );
    expect(row.nextAction.code).toBe("REVIEW_OFFER");
    expect(row.nextAction.label).toBe("Review quotation");
    expect(row.nextAction.label).not.toMatch(/compare/i);
    expect(row.nextAction.href).toBe("/store/dashboard/supplier-offers/o3");
  });

  /* Freight has no `[id]` route at all — the previous link pointed at a page
     that does not exist. */
  test("a freight quotation opens the freight register, the route that exists", () => {
    const row = svc.offerRow(
      { _id: "f1", status: "ACTIVE", validUntil: new Date("2027-01-01"), supplierName: "Transporter", laneLabel: "Tiruppur → Bengaluru", quotationReference: "FQ-1", currency: "INR" },
      {
        purchaseType: "freight", asOf: new Date("2026-09-28"),
        registerHref: "/store/dashboard/supplier-offers?subject=freight",
      },
    );
    expect(row.nextAction.href).toBe("/store/dashboard/supplier-offers?subject=freight");
    expect(row.nextAction.code).toBe("OPEN_FREIGHT_REGISTER");
    /* Never a per-id freight page, because there is none to open. */
    expect(row.nextAction.href).not.toMatch(/supplier-offers\/f1/);
  });

  test("no action anywhere promises a comparison it does not open", () => {
    /* `COMPARE_OFFERS` is gone rather than left unused: a spare label reading
       "Compare offers" is the next person's trap. */
    expect(svc.ACTION.COMPARE_OFFERS).toBeUndefined();
  });

  test("a sourcing decision points at the existing decisions register", () => {
    const open = svc.decisionRow({ costingId: "c1", costingLabel: "Oxford Shirt", lineKey: "fabric", itemName: "Fabric", candidates: [{}, {}] });
    expect(open.nextAction.code).toBe("RECORD_DECISION");
    expect(open.nextAction.href).toBe("/store/dashboard/supplier-offers/sourcing-decisions");
    expect(open.stage).toBe("to-source");
    expect(open.exactStatus).toBe("DECISION_REQUIRED");
    expect(open.candidateCount).toBe(2);
    const done = svc.decisionRow({ costingId: "c1", lineKey: "fabric", decided: true });
    expect(done.nextAction.code).toBe("REVIEW_DECISION");
  });
});

/* ── EXCEPTIONS LINK, THEIR RULES ARE NOT COPIED ────────────────────────── */

describe("purchase exceptions", () => {
  test("an exception becomes an indicator and a link to the affected order's register", () => {
    const poId = new mongoose.Types.ObjectId();
    const row = svc.materialRow(
      { _id: poId, poNumber: "PO/1", vendorName: "Acme", status: "ISSUED", items: [], totalAmount: 1, currency: "INR" },
      { exceptionsByPo: new Map([[String(poId), { summary: "Overdue delivery", groups: ["Overdue delivery"] }]]) },
    );
    expect(row.exceptionSummary).toBe("Overdue delivery");
    expect(row.exceptionHref).toBe("/store/dashboard/operations/purchase-exceptions");
    /* The exception outranks the ordinary review action. */
    expect(row.nextAction.code).toBe("RESOLVE_EXCEPTION");
    /* And the row still opens the order itself. */
    expect(row.nextAction.href).toBe(`/store/dashboard/operations/purchase-order/${String(poId)}`);
  });

  test("the adapter asks the exceptions register rather than reimplementing it", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/storePurchase/purchaseWorkspace.service.js"), "utf8");
    expect(src).toContain('require("./poExceptionsRegister.service")');
    expect(src).toContain("buildExceptionsRegister");
    /* No second calculation: none of the register's own rule vocabulary is
       re-derived here. */
    for (const rule of ["outstandingExpectation", "overdue", "asOf.getTime", "daysLate"]) {
      expect(src).not.toContain(rule);
    }
  });
});

/* ── HONESTY ABOUT WHAT WAS READ ────────────────────────────────────────── */

describe("honesty", () => {
  test("a truncated read says so rather than implying a company-wide total", async () => {
    const prev = process.env.PURCHASE_WORKSPACE_ORDER_CAP;
    process.env.PURCHASE_WORKSPACE_ORDER_CAP = "1";
    try {
      const co = await company(); const token = await actor(co);
      await makePO(co, { status: "ISSUED" });
      await makePO(co, { status: "ISSUED" });
      const r = await call(`${WS}?stage=on-order&type=material`, { token });
      expect(r.body.coverage.truncated).toBe(true);
      expect(r.body.coverage.note).toMatch(/older matching records may exist/i);
      expect(r.body.sources.materialOrders.coverage.scanCap).toBe(1);
      expect(r.body.sources.materialOrders.coverage.storedMatchCount).toBe(2);
      expect(r.body.pagination.scope).toBe("composedSet");
    } finally {
      if (prev === undefined) delete process.env.PURCHASE_WORKSPACE_ORDER_CAP;
      else process.env.PURCHASE_WORKSPACE_ORDER_CAP = prev;
    }
  });

  test("every source reports its own availability", async () => {
    const co = await company(); const token = await actor(co);
    const r = await call(`${WS}?stage=to-source`, { token });
    expect(r.body.sources).toBeTruthy();
    expect(Array.isArray(r.body.unavailable)).toBe(true);
    /* Present and true, not absent. */
    for (const key of Object.keys(r.body.sources)) {
      expect(typeof r.body.sources[key].available).toBe("boolean");
    }
  });

  test("a source that throws is reported, never rendered as an empty tab", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, { status: "ISSUED" });
    /* Driven rather than asserted about: the point is that the composition
       keeps going and SAYS the source failed. */
    jest.spyOn(ServiceOrder, "countDocuments").mockRejectedValue(new Error("service register unavailable"));
    const r = await call(`${WS}?stage=on-order&type=all`, { token });
    expect(r.status).toBe(200);
    expect(r.body.sources.serviceOrders.available).toBe(false);
    expect(r.body.unavailable.map((u) => u.source)).toContain("serviceOrders");
    expect(r.body.unavailable.find((u) => u.source === "serviceOrders").reason).toMatch(/service register unavailable/);
    /* And the material rows still arrived. */
    expect(r.body.rows.length).toBeGreaterThan(0);
  });
});

/* ── THE ADAPTER WRITES NOTHING ─────────────────────────────────────────── */

describe("read-only", () => {
  test("reading every tab and type mutates no purchasing document", async () => {
    const co = await company(); const token = await actor(co);
    const po = await makePO(co, { status: "ISSUED" });
    const so = await makeSO(co, { status: "ISSUED" });

    const snapshot = async () => ({
      pos: await PurchaseOrder.find({ companyId: co._id }).sort({ _id: 1 }).lean(),
      sos: await ServiceOrder.find({ companyId: co._id }).sort({ _id: 1 }).lean(),
      offers: await SupplierOffer.countDocuments({ companyId: co._id }),
      poCount: await PurchaseOrder.countDocuments({}),
      soCount: await ServiceOrder.countDocuments({}),
    });

    const before = await snapshot();
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      for (const type of ["all", "material", "service", "freight"]) {
        for (const status of ["open", "closed", "all"]) {
          await call(`${WS}?stage=${stage}&type=${type}&status=${status}`, { token });
        }
      }
    }
    expect(await snapshot()).toEqual(before);
    expect(String(po._id) && String(so._id)).toBeTruthy();
  });

  test("the service exposes no write helper and never touches Receive", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/storePurchase/purchaseWorkspace.service.js"), "utf8");
    const body = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    for (const write of [".save(", "updateOne", "updateMany", "insertOne", "insertMany",
      ".create(", "deleteOne", "deleteMany", "findOneAndUpdate", "bulkWrite", "$set", "$inc"]) {
      expect(body).not.toContain(write);
    }
    /* Receive's authorities are never reached: no receipt-control derivation,
       no goods-receipt read, no inspection or put-away. */
    for (const receive of ["goodsReceiptControl", "GoodsReceipt", "deriveControl",
      "Inspection", "Putaway", "Disposition", "customerMaterial"]) {
      expect(src).not.toContain(receive);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   THE TWO MATERIAL-ORDER FILTERS

   A supplier id and an exact purchase-order status are fields only a purchase
   order has. They are applied in the ADAPTER so that the rows, the per-currency
   figures and the record count all describe the same set. Applying them in the
   page instead would have left the value strip and the "showing N of M" count
   covering the stage BEFORE the filter — figures reporting a different set from
   the rows beneath them, which a buyer cannot check by eye.
   ────────────────────────────────────────────────────────────────────────── */
describe("supplier and exact-status filtering", () => {
  it("narrows to one supplier, and the summary and pagination follow the rows", async () => {
    const co = await company();
    const token = await actor(co);
    const vendorA = new mongoose.Types.ObjectId();
    await makePO(co, { status: "ISSUED", totalAmount: 100 }).then((po) =>
      PurchaseOrder.updateOne({ _id: po._id }, { $set: { vendor: vendorA } }));
    await makePO(co, { status: "ISSUED", totalAmount: 250 }).then((po) =>
      PurchaseOrder.updateOne({ _id: po._id }, { $set: { vendor: vendorA } }));
    await makePO(co, { status: "ISSUED", totalAmount: 900 });   // a different supplier

    const res = await call(`${WS}?stage=on-order&type=material&vendor=${vendorA}`, { token });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);

    /* The figures describe exactly these rows — not the stage before the
       filter, which would have carried the 900 as well. */
    expect(res.body.pagination.totalItems).toBe(2);
    expect(res.body.summary.rowCount).toBe(2);
    const inr = res.body.summary.totalsByCurrency.find((t) => t.currency === "INR");
    expect(inr.amount).toBe(350);
  });

  it("an exact status narrows the stage's set and never widens it", async () => {
    const co = await company();
    const token = await actor(co);
    const issuedPo = await makePO(co, { status: "ISSUED" });
    await makePO(co, { status: "PARTIALLY_RECEIVED" });
    await makePO(co, { status: "COMPLETED" });

    const issued = await call(`${WS}?stage=on-order&poStatus=ISSUED`, { token });
    expect(issued.body.rows.map((r) => r.reference)).toEqual([issuedPo.poNumber]);
    expect(issued.body.rows[0].exactStatus).toBe("ISSUED");

    /* COMPLETED is not in On order, so asking for it there is an empty answer —
       not a redefinition of the tab that drags a completed order into it. */
    const wrongTab = await call(`${WS}?stage=on-order&poStatus=COMPLETED`, { token });
    expect(wrongTab.status).toBe(200);
    expect(wrongTab.body.rows).toEqual([]);
    expect(wrongTab.body.pagination.totalItems).toBe(0);
  });

  /* ── THE CASE THE STAGE FILTER DOES NOT COVER ──────────────────────────────
     With `status=open` a later pass drops any row whose stage is not the one
     asked for, so a widening status filter is caught there anyway. With
     `status=all` that pass is deliberately skipped — so the narrowing has to
     happen in the query itself, and only this case proves it does. */
  it("an exact status still cannot widen a stage when closed records are included", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { status: "ISSUED" });
    const completed = await makePO(co, { status: "COMPLETED" });

    const res = await call(`${WS}?stage=on-order&status=all&poStatus=COMPLETED`, { token });
    expect(res.status).toBe(200);
    /* COMPLETED belongs to Completed. Asking for it inside On order is empty,
       even with every lifecycle included — a completed order must never be
       reported as still out with a supplier. */
    expect(res.body.rows.map((r) => r.reference)).not.toContain(completed.poNumber);
    expect(res.body.rows).toEqual([]);
  });

  it("an unknown or malformed filter value is ignored rather than trusted", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await makePO(co, { status: "ISSUED" });

    /* A bad status must not become part of a Mongo query, and a non-ObjectId
       vendor must not reach `filter.vendor`, where it would throw a cast error
       and turn a typo in a URL into a 500. */
    const bogusStatus = await call(`${WS}?stage=on-order&poStatus=NOT_A_STATUS`, { token });
    expect(bogusStatus.status).toBe(200);
    expect(bogusStatus.body.rows.map((r) => r.reference)).toContain(po.poNumber);
    expect(bogusStatus.body.poStatus).toBe("");

    const bogusVendor = await call(`${WS}?stage=on-order&vendor=not-an-id`, { token });
    expect(bogusVendor.status).toBe(200);
    expect(bogusVendor.body.rows.map((r) => r.reference)).toContain(po.poNumber);
    expect(bogusVendor.body.vendor).toBe("");
  });

  it("asking for a supplier reads only material orders, and says so", async () => {
    const co = await company();
    const token = await actor(co);
    const vendorA = new mongoose.Types.ObjectId();
    await makePO(co, { status: "ISSUED" }).then((po) =>
      PurchaseOrder.updateOne({ _id: po._id }, { $set: { vendor: vendorA } }));
    await makeSO(co, { status: "ISSUED" });

    const all = await call(`${WS}?stage=on-order`, { token });
    expect([...new Set(all.body.rows.map((r) => r.recordType))].sort())
      .toEqual(["material-order", "service-order"]);
    expect(all.body.materialOnly).toBe(false);
    expect(all.body.sources.serviceOrders).toBeDefined();

    /* A service order has no such supplier field, so it is not read at all.
       Reporting it as read and contributing nothing is a different claim from
       not having been asked — and only the second one is true. */
    const filtered = await call(`${WS}?stage=on-order&vendor=${vendorA}`, { token });
    expect(filtered.body.materialOnly).toBe(true);
    expect([...new Set(filtered.body.rows.map((r) => r.recordType))]).toEqual(["material-order"]);
    expect(filtered.body.sources.serviceOrders).toBeUndefined();
  });

  it("a supplier filter suppresses quotations and decisions in To source too", async () => {
    const co = await company();
    const token = await actor(co);
    const vendorA = new mongoose.Types.ObjectId();

    const plain = await call(`${WS}?stage=to-source`, { token });
    expect(plain.body.materialOnly).toBe(false);

    const filtered = await call(`${WS}?stage=to-source&vendor=${vendorA}`, { token });
    expect(filtered.body.materialOnly).toBe(true);
    expect(filtered.body.sources.materialOffers).toBeUndefined();
    expect(filtered.body.sources.serviceOffers).toBeUndefined();
    expect(filtered.body.sources.freightOffers).toBeUndefined();
    expect(filtered.body.sources.sourcingDecisions).toBeUndefined();
  });

  it("the filters are echoed back, so the page can state what was applied", async () => {
    const co = await company();
    const token = await actor(co);
    const vendorA = new mongoose.Types.ObjectId();
    const res = await call(`${WS}?stage=on-order&vendor=${vendorA}&poStatus=ISSUED`, { token });
    expect(res.body.vendor).toBe(String(vendorA));
    expect(res.body.poStatus).toBe("ISSUED");
  });

  it("company isolation still holds with the filters applied", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const vendorA = new mongoose.Types.ObjectId();
    const ours = await makePO(mine, { status: "ISSUED" });
    await PurchaseOrder.updateOne({ _id: ours._id }, { $set: { vendor: vendorA } });
    const notOurs = await makePO(theirs, { status: "ISSUED" });
    await PurchaseOrder.updateOne({ _id: notOurs._id }, { $set: { vendor: vendorA } });

    const res = await call(`${WS}?stage=on-order&vendor=${vendorA}`, { token });
    expect(res.body.rows.map((r) => r.reference)).toEqual([ours.poNumber]);
  });

  it("a closed-status filter still reaches cancelled orders, keeping their status", async () => {
    const co = await company();
    const token = await actor(co);
    const cancelled = await makePO(co, { status: "CANCELLED" });

    const res = await call(`${WS}?stage=on-order&status=closed&poStatus=CANCELLED`, { token });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.reference === cancelled.poNumber);
    expect(row).toBeDefined();
    expect(row.exactStatus).toBe("CANCELLED");
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   SEARCH MUST NOT UNDO COMPANY SCOPING

   `tenantFilter` returns an `$or` whenever legacy read-through is on, which is
   the default. A source read that then assigns its own `filter.$or` for the
   search terms REPLACES that clause, and the query silently loses its company
   scope — so typing in the search box would show another company's orders.
   ────────────────────────────────────────────────────────────────────────── */
describe("search keeps company scoping", () => {
  it("a search does not reach another company's purchase orders", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makePO(mine, { status: "ISSUED", vendorName: "Sharedname Mills" });
    const notOurs = await makePO(theirs, { status: "ISSUED", vendorName: "Sharedname Mills" });

    const res = await call(`${WS}?stage=on-order&type=material&search=Sharedname`, { token });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.reference)).not.toContain(notOurs.poNumber);
    expect(res.body.rows).toHaveLength(1);
  });

  it("a search does not reach another company's service orders", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    await makeSO(mine, { status: "ISSUED", vendorName: "Sharedsvc Co" });
    const notOurs = await makeSO(theirs, { status: "ISSUED", vendorName: "Sharedsvc Co" });

    const res = await call(`${WS}?stage=on-order&type=service&search=Sharedsvc`, { token });
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.reference)).not.toContain(notOurs.serviceOrderNumber);
    expect(res.body.rows).toHaveLength(1);
  });
});


/* ──────────────────────────────────────────────────────────────────────────
   1 + 2. TO SOURCE BEGINS AT THE APPROVED NEED

   Purchasing starts when somebody approves a need, not when a supplier has
   already quoted. A workspace whose first tab only fills up after an offer
   exists hides the work that most needs doing.
   ────────────────────────────────────────────────────────────────────────── */
describe("approved needs in To source", () => {
  it("an approved need with no offer and no decision still appears", async () => {
    const co = await company();
    const token = await actor(co);
    const need = await makeNeed(co, { title: "Two laptops" });

    const res = await call(`${WS}?stage=to-source`, { token });
    expect(res.status).toBe(200);
    const row = res.body.rows.find((r) => r.reference === need.requestNumber);
    expect(row).toBeDefined();
    expect(row.recordType).toBe("need");
    expect(row.stage).toBe("to-source");
    /* Nothing has been sourced, so there is no supplier to name. */
    expect(row.supplierLabel).toBe("");
  });

  it("each need is labelled Material or Outside service by its request type", async () => {
    const co = await company();
    const token = await actor(co);
    const product = await makeNeed(co, { requestType: "PRODUCT" });
    const service = await makeNeed(co, { requestType: "SERVICE" });
    /* A legacy SOFTWARE request is a service, exactly as the model labels it
       on screen — never silently reclassified as a material. */
    const legacy = await makeNeed(co, { requestType: "SOFTWARE" });

    const res = await call(`${WS}?stage=to-source`, { token });
    const byRef = Object.fromEntries(res.body.rows.map((r) => [r.reference, r]));
    expect(byRef[product.requestNumber].purchaseType).toBe("material");
    expect(byRef[service.requestNumber].purchaseType).toBe("service");
    expect(byRef[legacy.requestNumber].purchaseType).toBe("service");
  });

  it("the type filter selects needs by their kind", async () => {
    const co = await company();
    const token = await actor(co);
    const product = await makeNeed(co, { requestType: "PRODUCT" });
    const service = await makeNeed(co, { requestType: "SERVICE" });

    const mat = await call(`${WS}?stage=to-source&type=material`, { token });
    expect(mat.body.rows.map((r) => r.reference)).toContain(product.requestNumber);
    expect(mat.body.rows.map((r) => r.reference)).not.toContain(service.requestNumber);

    const svcOnly = await call(`${WS}?stage=to-source&type=service`, { token });
    expect(svcOnly.body.rows.map((r) => r.reference)).toContain(service.requestNumber);
    expect(svcOnly.body.rows.map((r) => r.reference)).not.toContain(product.requestNumber);
  });

  it("freight has no approved-demand source, so no need is invented for it", async () => {
    const co = await company();
    const token = await actor(co);
    await makeNeed(co, { requestType: "PRODUCT" });
    await makeNeed(co, { requestType: "SERVICE" });

    /* A request is raised as PRODUCT or SERVICE; there is no freight demand
       record anywhere, and manufacturing one from a material request would be
       a guess presented as a fact. */
    const res = await call(`${WS}?stage=to-source&type=freight`, { token });
    expect(res.body.rows.filter((r) => r.recordType === "need")).toEqual([]);
  });

  it("only approved demand appears — not draft, pending, rejected or already ordered", async () => {
    const co = await company();
    const token = await actor(co);
    const approved = await makeNeed(co, { status: "approved" });
    const ordered = await makeNeed(co, { status: "ordered" });
    const pending = await makeNeed(co, { status: "pending_finance" });
    const rejected = await makeNeed(co, { status: "rejected" });
    /* Alive, but finance sent it back over the FIGURE. Not approved, so not
       something to ring a supplier about. */
    const exception = await makeNeed(co, { status: "budget_exception" });

    const res = await call(`${WS}?stage=to-source`, { token });
    const refs = res.body.rows.map((r) => r.reference);
    expect(refs).toContain(approved.requestNumber);
    for (const other of [ordered, pending, rejected, exception]) {
      expect(refs).not.toContain(other.requestNumber);
    }
  });

  it("an approved need carries what a buyer needs before ringing anyone", async () => {
    const co = await company();
    const token = await actor(co);
    const need = await makeNeed(co, {
      department: "Cutting", requestedByName: "Meena",
      neededBy: new Date("2026-11-01"), priority: "URGENT", totalAmount: 45000,
    });

    const res = await call(`${WS}?stage=to-source`, { token });
    const row = res.body.rows.find((r) => r.reference === need.requestNumber);
    expect(row.requestedFor).toBe("Cutting");
    expect(row.requestedByName).toBe("Meena");
    expect(row.priority).toBe("URGENT");
    expect(row.approvedAmount).toBe(45000);
    expect(new Date(row.neededBy).toISOString()).toContain("2026-11-01");
  });

  it("a need's action opens the approved request, and this read writes nothing", async () => {
    const co = await company();
    const token = await actor(co);
    const need = await makeNeed(co);

    const res = await call(`${WS}?stage=to-source`, { token });
    const row = res.body.rows.find((r) => r.reference === need.requestNumber);
    expect(row.nextAction.href).toBe(`/store/dashboard/order-requests/quote/${need._id}`);

    /* The request is untouched: same status, no order reference minted. */
    const after = await SpendRequest.collection.findOne({ _id: need._id });
    expect(after.status).toBe("approved");
    expect(after.orderReference).toBeUndefined();
  });

  it("needs are company-scoped like every other source", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const ours = await makeNeed(mine);
    const notOurs = await makeNeed(theirs);

    const res = await call(`${WS}?stage=to-source`, { token });
    const refs = res.body.rows.map((r) => r.reference);
    expect(refs).toContain(ours.requestNumber);
    expect(refs).not.toContain(notOurs.requestNumber);
  });

  it("needs appear only in To source, never in a later stage", async () => {
    const co = await company();
    const token = await actor(co);
    const need = await makeNeed(co);

    for (const stage of ["draft-orders", "on-order", "completed"]) {
      const res = await call(`${WS}?stage=${stage}`, { token });
      expect(res.body.rows.map((r) => r.reference)).not.toContain(need.requestNumber);
    }
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   3 + 4. CLOSED IS ONE ORTHOGONAL VIEW

   A cancelled order has no stage. Giving it one either drops it or repeats it
   under all four tabs, and both were happening.
   ────────────────────────────────────────────────────────────────────────── */
describe("cancelled and closed", () => {
  it("an expired ACTIVE offer appears in the closed view, exactly once", async () => {
    const co = await company();
    const token = await actor(co);
    await makeOffer(co, {
      supplierName: "Lapsed Mills", quotationReference: "Q-EXPIRED",
      status: "ACTIVE", validUntil: new Date("2026-01-01"),
    });

    const res = await call(`${WS}?stage=to-source&status=closed`, { token });
    expect(res.status).toBe(200);
    const hits = res.body.rows.filter((r) => r.reference === "Q-EXPIRED");
    /* Reached by its expiry DATE — a status query could never find it, which
       is why the closed view used to be missing it entirely. */
    expect(hits).toHaveLength(1);
    /* Its stored status is preserved verbatim; expiry sits beside it. */
    expect(hits[0].exactStatus).toBe("ACTIVE");
    expect(hits[0].expired).toBe(true);
  });

  it("an unexpired ACTIVE offer stays out of the closed view", async () => {
    const co = await company();
    const token = await actor(co);
    await makeOffer(co, {
      supplierName: "Live Mills", quotationReference: "Q-LIVE",
      status: "ACTIVE", validUntil: new Date("2099-01-01"),
    });
    const res = await call(`${WS}?stage=to-source&status=closed`, { token });
    expect(res.body.rows.map((r) => r.reference)).not.toContain("Q-LIVE");
  });

  it("an offer with no validity date is never treated as expired", async () => {
    const co = await company();
    const token = await actor(co);
    await makeOffer(co, { supplierName: "Undated", quotationReference: "Q-NODATE", status: "ACTIVE" });
    const res = await call(`${WS}?stage=to-source&status=closed`, { token });
    expect(res.body.rows.map((r) => r.reference)).not.toContain("Q-NODATE");
  });

  it("a cancelled order appears once in the closed view and in no stage tab", async () => {
    const co = await company();
    const token = await actor(co);
    const cancelled = await makePO(co, { status: "CANCELLED" });

    const closed = await call(`${WS}?status=closed`, { token });
    expect(closed.body.rows.filter((r) => r.reference === cancelled.poNumber)).toHaveLength(1);

    /* It used to be repeated under every tab, because the stage constraint was
       simply skipped whenever the lifecycle filter was not `open`. */
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      const res = await call(`${WS}?stage=${stage}`, { token });
      expect(res.body.rows.map((r) => r.reference)).not.toContain(cancelled.poNumber);
    }
  });

  it("the closed view is the same list whichever stage tab is in the URL", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { status: "CANCELLED" });

    const seen = [];
    for (const stage of ["to-source", "draft-orders", "on-order", "completed"]) {
      const res = await call(`${WS}?stage=${stage}&status=closed`, { token });
      expect(res.body.stageApplies).toBe(false);
      seen.push(res.body.rows.map((r) => r.reference).sort().join("|"));
    }
    /* Orthogonal: the stage in the URL does not change what closed contains. */
    expect(new Set(seen).size).toBe(1);
  });

  it("a cancelled order is never relabelled as completed", async () => {
    const co = await company();
    const token = await actor(co);
    const cancelled = await makePO(co, { status: "CANCELLED" });
    const done = await makePO(co, { status: "COMPLETED" });

    const completed = await call(`${WS}?stage=completed`, { token });
    expect(completed.body.rows.map((r) => r.reference)).toContain(done.poNumber);
    expect(completed.body.rows.map((r) => r.reference)).not.toContain(cancelled.poNumber);

    const closed = await call(`${WS}?status=closed`, { token });
    const row = closed.body.rows.find((r) => r.reference === cancelled.poNumber);
    expect(row.exactStatus).toBe("CANCELLED");
    expect(row.stage).toBeNull();
  });

  it("an old status=all link resolves forward rather than failing", async () => {
    const co = await company();
    const token = await actor(co);
    const issued = await makePO(co, { status: "ISSUED" });
    const cancelled = await makePO(co, { status: "CANCELLED" });

    const res = await call(`${WS}?stage=on-order&status=all`, { token });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("open");
    expect(res.body.stageApplies).toBe(true);
    expect(res.body.rows.map((r) => r.reference)).toContain(issued.poNumber);
    /* And it does not smuggle the closed record back into a stage tab. */
    expect(res.body.rows.map((r) => r.reference)).not.toContain(cancelled.poNumber);
  });

  it("the stage and the stored status are separate facts on every row", async () => {
    const co = await company();
    const token = await actor(co);
    const partly = await makePO(co, { status: "PARTIALLY_RECEIVED" });

    const res = await call(`${WS}?stage=on-order`, { token });
    const row = res.body.rows.find((r) => r.reference === partly.poNumber);
    expect(row.stage).toBe("on-order");
    expect(row.exactStatus).toBe("PARTIALLY_RECEIVED");
    expect(row.stage).not.toBe(row.exactStatus);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   8. A ROW IS COMPLETE ON ITS OWN

   The page used to fetch the whole legacy purchase-order register a second
   time to recover payment, receipt progress and the data its actions run on.
   A valid row must never lose those because a second request failed.
   ────────────────────────────────────────────────────────────────────────── */
describe("the row carries its own payment, receipt and action data", () => {
  it("a material row carries payment status, receipt total and per-line quantities", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await makePO(co, {
      status: "PARTIALLY_RECEIVED",
      items: [
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Fabric", sku: "F", unit: "m", quantity: 100, unitPrice: 1, totalPrice: 100, receivedQuantity: 40, pendingQuantity: 60, status: "PARTIALLY_RECEIVED" },
        { _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(), itemName: "Thread", sku: "T", unit: "cone", quantity: 20, unitPrice: 1, totalPrice: 20, receivedQuantity: 20, pendingQuantity: 0, status: "COMPLETED" },
      ],
    });
    await PurchaseOrder.updateOne({ _id: po._id }, { $set: { paymentStatus: "PARTIAL", totalReceived: 60 } });

    const res = await call(`${WS}?stage=on-order&type=material`, { token });
    const row = res.body.rows.find((r) => r.reference === po.poNumber);

    expect(row.paymentStatus).toBe("PARTIAL");
    /* Drives whether Cancel may be offered at all. */
    expect(row.totalReceived).toBe(60);

    /* Receipt progress is counted from these, per line, with each line's own
       unit — so nothing downstream can add metres to cones. */
    expect(row.items).toHaveLength(2);
    expect(row.items[0]).toMatchObject({ unit: "m", quantity: 100, receivedQuantity: 40, status: "PARTIALLY_RECEIVED" });
    expect(row.items[1]).toMatchObject({ unit: "cone", quantity: 20, receivedQuantity: 20, status: "COMPLETED" });
  });

  it("an unpaid order says PENDING rather than leaving payment unreported", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await makePO(co, { status: "ISSUED" });
    const res = await call(`${WS}?stage=on-order&type=material`, { token });
    expect(res.body.rows.find((r) => r.reference === po.poNumber).paymentStatus).toBe("PENDING");
  });

  it("a draft order carries the zero receipt total its Cancel action depends on", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await makePO(co, { status: "DRAFT" });
    const res = await call(`${WS}?stage=draft-orders&type=material`, { token });
    const row = res.body.rows.find((r) => r.reference === po.poNumber);
    /* Zero, not absent: absent would read as "unknown" and suppress Cancel on
       an order that is perfectly cancellable. */
    expect(row.totalReceived).toBe(0);
    expect(row.exactStatus).toBe("DRAFT");
  });

  it("a service row carries no receipt or payment fields it has no basis for", async () => {
    const co = await company();
    const token = await actor(co);
    const so = await makeSO(co, { status: "ISSUED" });
    const res = await call(`${WS}?stage=on-order&type=service`, { token });
    const row = res.body.rows.find((r) => r.reference === so.serviceOrderNumber);
    /* A service is accepted, not received. */
    expect(row.items).toBeUndefined();
    expect(row.totalReceived).toBeUndefined();
    expect(row.paymentStatus).toBeUndefined();
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   LEGACY EXACT-STATUS LINKS ACTUALLY RETURN THEIR ORDERS

   Keeping the WORD `?status=ISSUED` is not compatibility. If the workspace
   opens its default tab, "To source" contains no issued orders, so the link
   that used to list them lists nothing — and reads as though the orders are
   gone. These assert the rows, not the parsed query.
   ────────────────────────────────────────────────────────────────────────── */
describe("legacy exact-status links", () => {
  it("?status=ISSUED returns the issued material orders, not an empty tab", async () => {
    const co = await company();
    const token = await actor(co);
    const issued = await makePO(co, { status: "ISSUED" });
    const draft = await makePO(co, { status: "DRAFT" });

    /* No `stage` in the URL — exactly what an old bookmark carries. */
    const res = await call(`${WS}?poStatus=ISSUED`, { token });
    expect(res.status).toBe(200);
    const refs = res.body.rows.map((r) => r.reference);
    expect(refs).toContain(issued.poNumber);
    expect(refs).not.toContain(draft.poNumber);
    /* And it opened the stage those orders live in. */
    expect(res.body.stage).toBe("on-order");
    expect(res.body.stageInferred).toBe(true);
  });

  it("each legacy status opens the stage its orders belong to, with rows", async () => {
    const co = await company();
    const token = await actor(co);
    const made = {
      DRAFT: await makePO(co, { status: "DRAFT" }),
      ISSUED: await makePO(co, { status: "ISSUED" }),
      PARTIALLY_RECEIVED: await makePO(co, { status: "PARTIALLY_RECEIVED" }),
      COMPLETED: await makePO(co, { status: "COMPLETED" }),
    };
    const expected = {
      DRAFT: "draft-orders", ISSUED: "on-order",
      PARTIALLY_RECEIVED: "on-order", COMPLETED: "completed",
    };

    for (const [status, stage] of Object.entries(expected)) {
      const res = await call(`${WS}?poStatus=${status}`, { token });
      expect(res.body.stage).toBe(stage);
      /* The point of the whole exercise: the link lists its orders. */
      expect(res.body.rows.map((r) => r.reference)).toContain(made[status].poNumber);
      expect(res.body.rows.every((r) => r.exactStatus === status)).toBe(true);
    }
  });

  it("?status=CANCELLED opens the closed view and lists the cancelled order", async () => {
    const co = await company();
    const token = await actor(co);
    const cancelled = await makePO(co, { status: "CANCELLED" });

    const res = await call(`${WS}?poStatus=CANCELLED`, { token });
    expect(res.body.status).toBe("closed");
    expect(res.body.stageApplies).toBe(false);
    expect(res.body.rows.map((r) => r.reference)).toContain(cancelled.poNumber);
    /* Never relabelled to fit a tab. */
    expect(res.body.rows.find((r) => r.reference === cancelled.poNumber).exactStatus).toBe("CANCELLED");
  });

  it("an explicit stage wins, and the status only narrows it", async () => {
    const co = await company();
    const token = await actor(co);
    const issued = await makePO(co, { status: "ISSUED" });
    const partly = await makePO(co, { status: "PARTIALLY_RECEIVED" });

    const res = await call(`${WS}?stage=on-order&poStatus=ISSUED`, { token });
    expect(res.body.stage).toBe("on-order");
    expect(res.body.stageInferred).toBe(false);
    const refs = res.body.rows.map((r) => r.reference);
    expect(refs).toContain(issued.poNumber);
    expect(refs).not.toContain(partly.poNumber);
  });

  it("an explicit stage that disagrees with the status returns nothing, honestly", async () => {
    const co = await company();
    const token = await actor(co);
    await makePO(co, { status: "ISSUED" });

    /* Asking for ISSUED inside Completed is an empty answer, not a reason to
       move the order or to silently ignore one of the two. */
    const res = await call(`${WS}?stage=completed&poStatus=ISSUED`, { token });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.stage).toBe("completed");
  });

  it("status=all is no filter at all, and lists the stage", async () => {
    const co = await company();
    const token = await actor(co);
    const issued = await makePO(co, { status: "ISSUED" });
    const partly = await makePO(co, { status: "PARTIALLY_RECEIVED" });

    const res = await call(`${WS}?stage=on-order&poStatus=all`, { token });
    expect(res.body.poStatus).toBe("");
    /* Said out loud, so the page drops the chip rather than claiming a filter
       the server ignored. */
    expect(res.body.poStatusApplied).toBe(false);
    const refs = res.body.rows.map((r) => r.reference);
    expect(refs).toContain(issued.poNumber);
    expect(refs).toContain(partly.poNumber);
  });

  it("an unknown status is no filter, not a filter nothing can match", async () => {
    const co = await company();
    const token = await actor(co);
    const issued = await makePO(co, { status: "ISSUED" });

    const res = await call(`${WS}?stage=on-order&poStatus=NOT_A_STATUS`, { token });
    expect(res.body.poStatusApplied).toBe(false);
    /* An empty list here would read as "there are no orders". */
    expect(res.body.rows.map((r) => r.reference)).toContain(issued.poNumber);
  });

  it("an unknown status does not drag the view somewhere it was not asked to go", async () => {
    const co = await company();
    const token = await actor(co);
    const res = await call(`${WS}?poStatus=NOT_A_STATUS`, { token });
    expect(res.body.stage).toBe("to-source");
    expect(res.body.stageInferred).toBe(false);
  });
});

/* ──────────────────────────────────────────────────────────────────────────
   THE APPROVED NEED'S DESTINATION IS A ROUTE CONTRACT

   `/store/dashboard/order-requests/{id}` reads `/api/cms/store/order-requests/
   {id}` — a store requirement and its work orders, a different record
   entirely. The spend request's own page is the `quote` route.
   ────────────────────────────────────────────────────────────────────────── */
describe("an approved need links to the page that can open it", () => {
  it("the destination is the quote route, exactly", async () => {
    const co = await company();
    const token = await actor(co);
    const need = await makeNeed(co);

    const res = await call(`${WS}?stage=to-source`, { token });
    const row = res.body.rows.find((r) => r.reference === need.requestNumber);
    expect(row.nextAction.href).toBe(`/store/dashboard/order-requests/quote/${need._id}`);
    /* Not the generic route, which serves a different record. */
    expect(row.nextAction.href).not.toBe(`/store/dashboard/order-requests/${need._id}`);
    expect(row.nextAction.href).toMatch(/\/order-requests\/quote\/[0-9a-f]{24}$/);
  });

  it("the API that page loads serves this exact request", async () => {
    /* ── THE CONTRACT THE LINK DEPENDS ON ─────────────────────────────────
       The quote page loads through `GET /api/requests/spend/{id}`, so that
       route must answer with THIS request. Asserting only that the href
       contains the id would have passed for the generic route too — which
       reads `/api/cms/store/order-requests/{id}`, an entirely different
       record. This drives the real route and checks the record that comes
       back. */
    const co = await company();
    const Employee = require("../../models/Employee");
    const biometricId = `PWEMP${++seq}`;
    /* Inserted rather than `create`d: the Employee schema defaults `gender` to
       "" and then refuses it against its own enum, so a minimal fixture cannot
       be saved through the model. This suite is testing a purchasing route, not
       the HR schema, and inventing a gender for a fixture person to satisfy a
       validator would be the wrong fix. */
    const empId = new mongoose.Types.ObjectId();
    await Employee.collection.insertOne({
      _id: empId, firstName: "Rutu", lastName: "P",
      email: `emp${seq}@x.example`, biometricId, isActive: true,
    });
    const token = tokenFor({ id: String(empId), employeeId: biometricId, email: `emp${seq}@x.example` });

    const need = await makeNeed(co, { title: "Two laptops for sampling" });
    /* The viewer is the requester, so the route's own ownership check passes
       without needing a fulfilment grant — this test is about the ROUTE, not
       about who may see somebody else's request. */
    await SpendRequest.collection.updateOne({ _id: need._id }, { $set: { requestedBy: empId } });

    const spendApp = express();
    spendApp.use(express.json());
    spendApp.use("/api/requests/spend", require("../../routes/CMS_Routes/Requests/spendRequests"));
    const spendServer = await new Promise((resolve) => {
      const srv = spendApp.listen(0, () => resolve(srv));
    });
    try {
      const port = spendServer.address().port;
      const r = await fetch(`http://127.0.0.1:${port}/api/requests/spend/${need._id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await r.json().catch(() => null);
      expect(r.status).toBe(200);
      /* The exact approved request, by its own number — not merely a 200. */
      expect(body.request.requestNumber).toBe(need.requestNumber);
      expect(body.request.title).toBe("Two laptops for sampling");
      /* And still approved, so the page's "Create purchase order" action is
         the one it will offer. */
      expect(body.request.status).toBe("approved");
    } finally {
      await new Promise((resolve) => spendServer.close(resolve));
    }
  });

  it("the generic order-requests route is a different API, not an alias", () => {
    /* Why the href had to change at all: the two routes read different
       endpoints, so the generic one cannot serve a spend request. */
    const fs = require("fs");
    const genericPage = "/Users/risheeray/grav-cms/app/store/dashboard/order-requests/[id]/page.js";
    const quotePage = "/Users/risheeray/grav-cms/app/store/dashboard/order-requests/quote/[id]/page.js";
    const generic = fs.readFileSync(genericPage, "utf8");
    const quote = fs.readFileSync(quotePage, "utf8");

    expect(generic).toContain("/api/cms/store/order-requests/");
    expect(generic).not.toContain("spendApi");

    /* The quote page loads the spend request and carries the action that
       turns it into an order. */
    expect(quote).toContain("spendApi");
    expect(quote).toMatch(/spendApi\(`\/\$\{id\}`\)/);
    expect(quote).toContain("/purchase-order");
    expect(quote).toContain("Create purchase order");
    /* An approved SERVICE becomes a service order from the same page. */
    expect(quote).toContain("/service-order");
  });
});
