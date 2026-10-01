// test/store-purchase/customer-material-issue.route.test.js
//
// HANDING A CUSTOMER'S MATERIAL TO PRODUCTION, AND GIVING BACK WHAT IS LEFT.
//
// Received customer material is now operational: it can be issued to the one
// production order it was sent for, and unused quantity can go back to its owner.
// Both take stock off the shelf. What this suite proves is that neither can take
// it off the WRONG shelf, for the wrong order, or twice.
//
//   1  ISSUE MOVES EVERYTHING TOGETHER. Lot, RawItem, location, issue record and
//      audit commit in one transaction, and the lot's own balance equation holds.
//
//   2  THE PRODUCTION ORDER IS PROVEN, NOT GUESSED. A WorkOrder qualifies only
//      when its stored `salesLineLink` names this company, this order and this
//      permanent sales line. A WorkOrder without that link is REFUSED — an
//      unprovable relationship is not a weak yes — and nothing is ever matched by
//      product, style, buyer or SKU.
//
//   3  NOTHING THE CLIENT CLAIMS IS BELIEVED. Every identity is resolved from the
//      lot; a posted value that disagrees is refused rather than ignored, because
//      ignoring it returns a success for an operation nobody asked for.
//
//   4  NO OVERDRAW, EVER. Not by a single request, not by two at once.
//
//   5  A RETRY RETURNS THE FIRST RESULT and moves nothing twice.
//
//   6  RETURN TO CUSTOMER IS NOT RETURN FROM PRODUCTION. Only held quantity may
//      go back; quantity with production is on a cutting table. And it creates no
//      vendor, purchase-order or payable record.
//
//   7  OWNERSHIP ISOLATION HOLDS. Two customers, two orders of one customer, two
//      lines of one order — and an ordinary company issue cannot touch any of it.
//
//   8  NO COMMERCIAL EFFECT. No price, currency, tax, valuation or payable is
//      produced by any of it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const {
  CustomerMaterialExpectation,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/store/customer-materials", require("../../routes/CMS_Routes/StorePurchase/customerMaterials"));
  app.use("/api/cms/inventory/operations/barcodes", require("../../routes/CMS_Routes/Inventory/Operations/barcodes"));
  app.use("/api/cms/stock-adjustments", require("../../routes/CMS_Routes/Inventory/Products/stockAdjustments"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const txt = await r.text();
    let b = null;
    try { b = JSON.parse(txt || "null"); } catch { b = txt; }
    return { status: r.status, body: b };
  });

const key = () => `cmi-${++seq}-${Math.random().toString(36).slice(2)}`;
const oid = () => new mongoose.Types.ObjectId();
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const lineRef = () => `LN-${String(++seq).padStart(12, "0").slice(-12)}`;

const tokenFor = (over = {}) => jwt.sign(
  { id: String(oid()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

async function actor(co, role = "approver") {
  const n = ++seq;
  const email = `ci${n}@x.example`;
  const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "CI", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "CI" });
  return tokenFor({ id: String(employeeRef), email });
}

/**
 * A whole job-work world with material already RECEIVED into a lot.
 *
 * The lot is created directly. The receipt path that creates one is the subject
 * of its own suite, and driving it through HTTP here would make every issue test
 * fail for reasons about receiving.
 *
 * The execution file, handover version and work orders go straight into their
 * collections for the same reason their own validation is not what is under test.
 */
async function world({
  held = 1000, orderRef, salesLine, customer, variant = false, withWorkOrder = true,
} = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01") });
  await Unit.create({ companyId: co._id, name: "Metre", status: "Active" });

  const cust = customer || await Customer.create({
    name: `Buyer ${n}`, email: `cicust${n}@grav.in`, customerId: `CUST-${n}`,
    profile: { companyName: `Buyer Trading ${n}` },
  });
  const sales = salesLine || lineRef();
  const request = await CustomerRequest.create({
    requestId: `MO-${n}`, customerId: cust._id,
    items: [{ product: `Tee ${n}`, quantity: 500, lineRef: sales }],
  });
  const versionId = oid();
  await SalesHandoverVersion.collection.insertOne({
    _id: versionId, companyId: co._id,
    sourceRecord: {
      app: "sales", recordType: "customer_request",
      recordId: request._id, sourceVersion: "1", issuedAt: new Date(),
    },
  });

  const fileId = oid();
  const order = orderRef || `ORD-${n}`;
  await ExecutionFile.collection.insertOne({
    _id: fileId, companyId: co._id, fileNumber: `MEF-${n}`, handoverRef: `HO-${n}`,
    handoverLineRef: `HOL-${n}`, executionPhase: "COORDINATION", lifecycleStatus: "OPEN",
    revision: 0, currentHandoverVersionId: versionId,
    currentExecutionProjection: {
      orderRef: order, orderLineRef: sales, buyerDisplayLabel: `Buyer ${n}`,
      productName: `Tee ${n}`, styleRef: `ST-${n}`, fulfilmentModel: "JOB_WORK",
    },
    createdAt: new Date(), updatedAt: new Date(),
  });

  const variants = variant
    ? [{ combination: ["Navy"], sku: `RAW-${n}-NV`, quantity: held }]
    : undefined;
  const item = await RawItem.create({
    companyId: co._id, name: `Customer poplin ${n}`, sku: `RAW-CP-${n}`,
    category: "Fabric", usedAs: "FABRIC", unit: "Metre",
    /* The PHYSICAL balance already includes the customer's material, because the
       shelf does. That is exactly what makes the ordinary-issue guard necessary. */
    quantity: held, minStock: 0, maxStock: 0,
    ...(variants ? { variants } : {}),
  });
  const variantId = variant ? item.variants[0]._id : null;

  const wh = await Warehouse.create({
    companyId: co._id, name: `WH ${n}`, shortName: `W${n}`, status: "Active",
    locations: [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "OTHER", name: "Other", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const loc = wh.locations[0];

  /* The location balance must agree with the shelf, or the guarded decrement
     refuses for the wrong reason. */
  const locStock = require("../../services/storePurchase/locationStock.service");
  await locStock.incLocation(null, co._id, item._id, variantId, wh._id, loc._id, held);

  const cmLine = `CML-${n}`;
  const doc = await CustomerMaterialExpectation.create({
    companyId: co._id, executionFileId: fileId, fileNumber: `MEF-${n}`,
    orderRef: order, salesOrderLineRef: sales, fulfilmentModel: "JOB_WORK",
    documentRef: `CSM-2026-${String(n).padStart(4, "0")}`,
    revisionNo: 1, state: "ISSUED", revision: 1,
    customerId: cust._id, customerRequestId: request._id,
    customerSnapshot: {
      customerCode: cust.customerId,
      customerLabel: cust.profile?.companyName || cust.name,
      customerName: cust.name, requestRef: request.requestId,
    },
    lines: [{
      lineRef: cmLine, rawItemId: item._id, variantId,
      variantCombination: variant ? ["Navy"] : [],
      rawItemName: item.name, rawItemSku: item.sku,
      requiredQuantity: 1200, unit: "Metre", addedAt: new Date(),
    }],
    issuedAt: new Date(),
  });

  const grnId = oid();
  const lot = await CustomerMaterialLot.create({
    companyId: co._id, customerId: cust._id,
    customerLabel: cust.profile.companyName, customerCode: cust.customerId,
    orderRef: order, orderLineRef: sales, executionFileId: fileId,
    expectationId: doc._id, documentRef: doc.documentRef,
    expectationRevisionNo: 1, expectationLineRef: cmLine,
    rawItemId: item._id, variantId, variantCombination: variant ? ["Navy"] : [],
    itemName: item.name, sku: item.sku,
    goodsReceiptId: grnId, goodsReceiptNumber: `GRN/2026-27/${String(n).padStart(4, "0")}`,
    goodsReceiptLineId: oid(),
    warehouseId: wh._id, warehouseName: wh.name,
    locationId: loc._id, locationCode: loc.code,
    receiptUnit: "Metre", receiptQuantity: held,
    baseUnit: "Metre", baseQuantity: held,
    availableQuantity: held, issuedQuantity: 0, returnedQuantity: 0,
    receivedAt: new Date(), receivedBy: { name: "St" },
    movements: [{
      type: "RECEIVED", quantity: held, baseUnit: "Metre", availableAfter: held,
      at: new Date(), goodsReceiptId: grnId,
    }],
  });

  let workOrder = null;
  if (withWorkOrder) {
    const woId = oid();
    await WorkOrder.collection.insertOne({
      _id: woId, companyId: co._id, workOrderNumber: `WO-${n}`,
      customerRequestId: request._id,
      salesLineLink: {
        companyId: co._id, customerRequestId: request._id, lineRef: sales, basis: "sales_line",
      },
      createdAt: new Date(), updatedAt: new Date(),
    });
    workOrder = { _id: woId, number: `WO-${n}` };
  }

  return {
    co, cust, request, fileId, orderRef: order, salesLine: sales, cmLine,
    doc, item, variantId, wh, loc, other: wh.locations[1], lot, workOrder,
    token: await actor(co),
    viewerToken: await actor(co, "viewer"),
  };
}

const ISSUE = (w) => `/api/cms/store/customer-materials/${w.doc._id}/issues`;
const RETURN = (w) => `/api/cms/store/customer-materials/${w.doc._id}/customer-returns`;

const issue = (w, over = {}) => call(ISSUE(w), {
  method: "POST", token: over.token || w.token, idempotencyKey: over.idempotencyKey || key(),
  body: {
    manufacturingOrderId: over.manufacturingOrderId !== undefined
      ? over.manufacturingOrderId : String(w.request._id),
    ...(over.workOrderId !== undefined
      ? { workOrderId: over.workOrderId }
      : (w.workOrder ? { workOrderId: String(w.workOrder._id) } : {})),
    lots: over.lots || [{ lotId: String(w.lot._id), quantity: 400 }],
    ...(over.claimed ? { claimed: over.claimed } : {}),
    note: over.note || "For cutting",
  },
});

const returnToCustomer = (w, over = {}) => call(RETURN(w), {
  method: "POST", token: over.token || w.token, idempotencyKey: over.idempotencyKey || key(),
  body: {
    lots: over.lots || [{ lotId: String(w.lot._id), quantity: 100 }],
    reason: over.reason !== undefined ? over.reason : "Surplus after cutting",
    customerReference: over.customerReference || "RTN-1",
    ...(over.claimed ? { claimed: over.claimed } : {}),
  },
});

const freshLot = (w) => CustomerMaterialLot.findById(w.lot._id).lean();
const freshItem = (w) => RawItem.findById(w.item._id).lean();
const locOnHand = async (w) => {
  const locStock = require("../../services/storePurchase/locationStock.service");
  /* The session is the FIRST argument; null means "outside a transaction". */
  return locStock.locationOnHand(null, w.co._id, w.item._id, w.variantId, w.wh._id, w.loc._id);
};

/* ══ 1 — ONE TRANSACTION, AND THE EQUATION HOLDS ═════════════════════════ */

describe("issuing to production", () => {
  test("moves the lot, the shelf, the location and writes the issue record", async () => {
    const w = await world({ held: 1000 });
    const res = await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 400 }] });

    expect(res.status).toBe(201);
    const lot = await freshLot(w);
    /* available + issued + returned === received, always. */
    expect(lot.availableQuantity).toBe(600);
    expect(lot.issuedQuantity).toBe(400);
    expect(lot.returnedQuantity).toBe(0);
    expect(r4(lot.availableQuantity + lot.issuedQuantity + lot.returnedQuantity))
      .toBe(lot.baseQuantity);
    expect(lot.status).toBe("HELD");

    /* The physical shelf fell by the same amount. */
    expect((await freshItem(w)).quantity).toBe(600);
    expect(await locOnHand(w)).toBe(600);

    /* And the canonical handover record says whose material it was. */
    const issuance = await StockIssuance.findById(res.body.issuance._id).lean();
    expect(issuance.ownership).toBe("CUSTOMER_OWNED");
    expect(issuance.direction).toBe("debit");
    expect(issuance.moNumber).toBe(w.request.requestId);
    expect(String(issuance.items[0].customerMaterialLotId)).toBe(String(w.lot._id));
    expect(issuance.items[0].orderLineRef).toBe(w.salesLine);
    expect(issuance.items[0].expectationLineRef).toBe(w.cmLine);
    expect(issuance.items[0].locationCode).toBe("RECV");

    /* The lot movement names where it went, and joins to the ledgers by id. */
    const moved = lot.movements.find((m) => m.type === "ISSUED");
    expect(moved.quantity).toBe(400);
    expect(moved.availableAfter).toBe(600);
    expect(moved.manufacturingOrderNumber).toBe(w.request.requestId);
    expect(moved.workOrderNumber).toBe(w.workOrder.number);
    expect(String(moved.stockIssuanceId)).toBe(String(issuance._id));
    expect(moved.stockTransactionId).toBeTruthy();
    expect(moved.locationMovementId).toBeTruthy();

    /* The location movement carries the ownership. */
    const mv = await LocationMovement.findById(moved.locationMovementId).lean();
    expect(mv.direction).toBe("out");
    expect(mv.source.kind).toBe("customer_material_issue");
    expect(String(mv.source.customerMaterialLotId)).toBe(String(w.lot._id));
    expect(mv.source.orderLineRef).toBe(w.salesLine);
  });

  test("partial issues accumulate until the lot is empty", async () => {
    const w = await world({ held: 1000 });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 600 }] });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 400 }] });

    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(0);
    expect(lot.issuedQuantity).toBe(1000);
    /* Nothing left, so the lot is exhausted rather than held. */
    expect(lot.status).toBe("EXHAUSTED");
    expect((await freshItem(w)).quantity).toBe(0);
  });

  test("several explicitly chosen lots move in one operation", async () => {
    const w = await world({ held: 600 });
    /* A second delivery of the same material for the same line. */
    const second = await CustomerMaterialLot.create({
      ...w.lot.toObject(), _id: undefined,
      goodsReceiptId: oid(), goodsReceiptNumber: "GRN/2026-27/9999", goodsReceiptLineId: oid(),
      receiptQuantity: 400, baseQuantity: 400, availableQuantity: 400,
      movements: [{ type: "RECEIVED", quantity: 400, baseUnit: "Metre", availableAfter: 400, at: new Date() }],
    });
    await RawItem.updateOne({ _id: w.item._id }, { $inc: { quantity: 400 } });
    const locStock = require("../../services/storePurchase/locationStock.service");
    await locStock.incLocation(null, w.co._id, w.item._id, w.variantId, w.wh._id, w.loc._id, 400);

    const res = await issue(w, {
      lots: [
        { lotId: String(w.lot._id), quantity: 600 },
        { lotId: String(second._id), quantity: 300 },
      ],
    });
    expect(res.status).toBe(201);
    /* One issue record, two lines, each naming its own lot. */
    const issuance = await StockIssuance.findById(res.body.issuance._id).lean();
    expect(issuance.items).toHaveLength(2);
    expect(new Set(issuance.items.map((i) => String(i.customerMaterialLotId))).size).toBe(2);
    expect((await freshLot(w)).availableQuantity).toBe(0);
    expect((await CustomerMaterialLot.findById(second._id).lean()).availableQuantity).toBe(100);
  });

  test("a variant lot issues from that variant only", async () => {
    const w = await world({ held: 500, variant: true });
    const res = await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 200 }] });
    expect(res.status).toBe(201);
    const item = await freshItem(w);
    expect(item.variants[0].quantity).toBe(300);
    expect(item.quantity).toBe(300);
  });
});

/* ══ 2 — THE PRODUCTION ORDER IS PROVEN ══════════════════════════════════ */

describe("proving where it is going", () => {
  test("a work order on the same order and sales line is accepted", async () => {
    const w = await world();
    expect((await issue(w)).status).toBe(201);
  });

  test("a work order with no sales-line link is refused, not assumed", async () => {
    const w = await world({ withWorkOrder: false });
    const legacy = oid();
    await WorkOrder.collection.insertOne({
      _id: legacy, companyId: w.co._id, workOrderNumber: "WO-LEGACY",
      customerRequestId: w.request._id, createdAt: new Date(), updatedAt: new Date(),
    });
    /* It may be a perfectly valid order that simply predates the link. That is
       the point: the relationship cannot be PROVEN, so it is not asserted. */
    const res = await issue(w, { workOrderId: String(legacy) });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("WORK_ORDER_LINK_UNPROVEN");
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("a work order for a different sales line is refused", async () => {
    const w = await world();
    const other = oid();
    await WorkOrder.collection.insertOne({
      _id: other, companyId: w.co._id, workOrderNumber: "WO-OTHERLINE",
      customerRequestId: w.request._id,
      salesLineLink: {
        companyId: w.co._id, customerRequestId: w.request._id,
        lineRef: lineRef(), basis: "sales_line",
      },
      createdAt: new Date(), updatedAt: new Date(),
    });
    const res = await issue(w, { workOrderId: String(other) });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("WORK_ORDER_LINE_MISMATCH");
  });

  test("a work order for a different order is refused", async () => {
    const w = await world();
    const elsewhere = await world();
    const res = await issue(w, { workOrderId: String(elsewhere.workOrder._id) });
    /* Another company's work order answers as absent; a same-company one on a
       different order answers as a mismatch. Either way, nothing moves. */
    expect([400, 404]).toContain(res.status);
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("a production order that is not this material's order is refused", async () => {
    const w = await world();
    const elsewhere = await world();
    const res = await issue(w, {
      manufacturingOrderId: String(elsewhere.request._id),
      workOrderId: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("MANUFACTURING_ORDER_MISMATCH");
  });

  test("nothing is matched by product, style or buyer", async () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/storePurchase/customerMaterialIssue.service.js"),
      "utf8",
    );
    /* The proof is stored references agreeing. A match on any of these
       legitimately repeats across two commercial lines of one order, which is
       exactly why the permanent line reference exists. */
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const banned of [/productName/, /styleRef/, /buyerDisplayLabel/, /\bsku\b.*===/, /description/]) {
      expect(code).not.toMatch(banned);
    }
    expect(code).toMatch(/salesLineLink/);
  });

  test("an issue against a withdrawn document is refused", async () => {
    const w = await world();
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, {
      $set: { state: "CANCELLED", cancellationReason: "Buyer changed plan." },
    });
    const res = await issue(w);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("EXPECTATION_CANCELLED");
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });
});

/* ══ 3 — THE CLIENT IS NOT BELIEVED ══════════════════════════════════════ */

describe("a claimed identity that disagrees", () => {
  test.each([
    ["customer", "customerId"],
    ["sales order", "orderRef"],
    ["sales order line", "orderLineRef"],
    ["material", "rawItemId"],
    ["document line", "expectationLineRef"],
  ])("a wrong %s is refused rather than ignored", async (_label, field) => {
    const w = await world();
    const wrong = field.endsWith("Id") ? String(oid()) : "SOMETHING-ELSE";
    const res = await issue(w, { claimed: { [field]: wrong } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("CLAIMED_IDENTITY_MISMATCH");
    expect(res.body.error.details.field).toBe(field);
    /* Ignoring it would return a success for an operation nobody asked for. */
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("a matching claim is simply accepted", async () => {
    const w = await world();
    const res = await issue(w, {
      claimed: {
        customerId: String(w.cust._id), orderRef: w.orderRef,
        orderLineRef: w.salesLine, expectationLineRef: w.cmLine,
      },
    });
    expect(res.status).toBe(201);
  });

  test("the wrong location is refused, and the right one is read from the lot", async () => {
    const w = await world();
    const res = await issue(w, { claimed: { locationId: String(w.other._id) } });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("WRONG_LOCATION");
  });

  test("another company's lot answers as one that does not exist", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await call(ISSUE(mine), {
      method: "POST", token: mine.token, idempotencyKey: key(),
      body: {
        manufacturingOrderId: String(mine.request._id),
        lots: [{ lotId: String(theirs.lot._id), quantity: 10 }],
      },
    });
    expect(res.status).toBe(404);
    expect((await CustomerMaterialLot.findById(theirs.lot._id).lean()).availableQuantity).toBe(1000);
  });

  test("lots from two different customers cannot move in one operation", async () => {
    const a = await world();
    const b = await world();
    /* Put b's lot into a's company so the company scope is not what refuses it. */
    await CustomerMaterialLot.updateOne({ _id: b.lot._id }, { $set: { companyId: a.co._id } });
    const res = await call(ISSUE(a), {
      method: "POST", token: a.token, idempotencyKey: key(),
      body: {
        manufacturingOrderId: String(a.request._id),
        lots: [
          { lotId: String(a.lot._id), quantity: 10 },
          { lotId: String(b.lot._id), quantity: 10 },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("LOTS_NOT_ONE_SET");
  });
});

/* ══ 4 — NO OVERDRAW ════════════════════════════════════════════════════ */

describe("more than the lot holds", () => {
  test("is refused before anything moves", async () => {
    const w = await world({ held: 500 });
    const res = await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 600 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("INSUFFICIENT_IN_LOT");
    /* And it says the system will not find the difference elsewhere. */
    expect(res.body.error.details.substitution).toBe("NOT_AUTOMATIC");
    expect((await freshItem(w)).quantity).toBe(500);
    expect(await locOnHand(w)).toBe(500);
  });

  test("zero and negative quantities are refused", async () => {
    const w = await world();
    for (const quantity of [0, -5, null, "abc"]) {
      const res = await issue(w, { lots: [{ lotId: String(w.lot._id), quantity }] });
      expect(res.status).toBe(400);
    }
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("two simultaneous issues cannot between them overdraw the lot", async () => {
    const w = await world({ held: 100 });
    const [a, b] = await Promise.all([
      issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 100 }] }),
      issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 100 }] }),
    ]);
    expect([a, b].filter((r) => r.status === 201)).toHaveLength(1);

    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(0);
    expect(lot.issuedQuantity).toBe(100);
    expect((await freshItem(w)).quantity).toBe(0);
    expect(await locOnHand(w)).toBe(0);
    expect(await StockIssuance.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ══ 5 — REPLAY ═════════════════════════════════════════════════════════ */

describe("a retry of an issue that already landed", () => {
  test("returns the first result and moves nothing twice", async () => {
    const w = await world({ held: 1000 });
    const k = key();
    const first = await issue(w, { idempotencyKey: k, lots: [{ lotId: String(w.lot._id), quantity: 400 }] });
    expect(first.status).toBe(201);

    const retry = await issue(w, { idempotencyKey: k, lots: [{ lotId: String(w.lot._id), quantity: 400 }] });
    expect([200, 201]).toContain(retry.status);
    expect(String(retry.body.issuance._id)).toBe(String(first.body.issuance._id));

    const lot = await freshLot(w);
    expect(lot.issuedQuantity).toBe(400);
    expect(lot.availableQuantity).toBe(600);
    expect((await freshItem(w)).quantity).toBe(600);
    expect(await StockIssuance.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await LocationMovement.countDocuments({ companyId: w.co._id, direction: "out" })).toBe(1);
  });
});

/* ══ ROLLBACK ═══════════════════════════════════════════════════════════ */

describe("if any step fails", () => {
  test("the lot, the shelf, the location and the issue record all roll back", async () => {
    const w = await world({ held: 1000 });
    const real = StockIssuance.create;
    /* The last step. If the rollback is real, everything before it goes too. */
    StockIssuance.create = jest.fn(() => { throw new Error("issue store unavailable"); });
    try {
      const res = await issue(w);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      StockIssuance.create = real;
    }
    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(1000);
    expect(lot.issuedQuantity).toBe(0);
    expect(lot.movements.filter((m) => m.type === "ISSUED")).toHaveLength(0);
    expect((await freshItem(w)).quantity).toBe(1000);
    expect(await locOnHand(w)).toBe(1000);
    expect(await StockIssuance.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await LocationMovement.countDocuments({ companyId: w.co._id, direction: "out" })).toBe(0);
  });
});

/* ══ 6 — RETURN TO CUSTOMER ═════════════════════════════════════════════ */

describe("giving unused material back to its owner", () => {
  test("a partial return takes it off the shelf exactly once", async () => {
    const w = await world({ held: 1000 });
    const res = await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 250 }] });
    expect(res.status).toBe(201);

    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(750);
    expect(lot.returnedQuantity).toBe(250);
    expect(lot.issuedQuantity).toBe(0);
    expect(r4(lot.availableQuantity + lot.issuedQuantity + lot.returnedQuantity))
      .toBe(lot.baseQuantity);

    expect((await freshItem(w)).quantity).toBe(750);
    expect(await locOnHand(w)).toBe(750);

    const moved = lot.movements.find((m) => m.type === "RETURNED_TO_CUSTOMER");
    expect(moved.quantity).toBe(250);
    expect(moved.reason).toBe("Surplus after cutting");
    expect(moved.customerReference).toBe("RTN-1");
    const mv = await LocationMovement.findById(moved.locationMovementId).lean();
    expect(mv.source.kind).toBe("customer_material_return");
    expect(String(mv.source.customerId)).toBe(String(w.cust._id));
  });

  test("a full return empties the lot", async () => {
    const w = await world({ held: 300 });
    await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 300 }] });
    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(0);
    expect(lot.returnedQuantity).toBe(300);
    expect(lot.status).toBe("EXHAUSTED");
    expect((await freshItem(w)).quantity).toBe(0);
  });

  test("more than is held cannot be returned", async () => {
    const w = await world({ held: 200 });
    const res = await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 250 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("INSUFFICIENT_IN_LOT");
    expect((await freshItem(w)).quantity).toBe(200);
  });

  test("quantity already with production cannot be returned to the customer", async () => {
    const w = await world({ held: 500 });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 400 }] });
    /* 100 is held; 400 is on a cutting table and is not Store's to give back. */
    const res = await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 200 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.available).toBe(100);

    const ok = await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 100 }] });
    expect(ok.status).toBe(201);
    const lot = await freshLot(w);
    expect(lot.availableQuantity).toBe(0);
    expect(lot.issuedQuantity).toBe(400);
    expect(lot.returnedQuantity).toBe(100);
  });

  test("a reason is required", async () => {
    const w = await world();
    const res = await returnToCustomer(w, { reason: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.field).toBe("reason");
  });

  test("a retry does not return it twice", async () => {
    const w = await world({ held: 500 });
    const k = key();
    await returnToCustomer(w, { idempotencyKey: k, lots: [{ lotId: String(w.lot._id), quantity: 100 }] });
    await returnToCustomer(w, { idempotencyKey: k, lots: [{ lotId: String(w.lot._id), quantity: 100 }] });
    const lot = await freshLot(w);
    expect(lot.returnedQuantity).toBe(100);
    expect(lot.availableQuantity).toBe(400);
    expect((await freshItem(w)).quantity).toBe(400);
  });

  test("it may be recorded even after the document is withdrawn", async () => {
    const w = await world({ held: 400 });
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, { $set: { state: "CANCELLED" } });
    /* A withdrawal is one of the main reasons material goes back. */
    const res = await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 400 }] });
    expect(res.status).toBe(201);
  });

  test("it creates no vendor return, purchase order or payable", async () => {
    const w = await world({ held: 300 });
    await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 300 }] });
    /* Nothing was bought, so there is nothing to credit. */
    expect(await PurchaseOrder.countDocuments({ companyId: w.co._id })).toBe(0);
    const lot = await freshLot(w);
    const text = JSON.stringify(lot);
    for (const banned of ["vendor", "supplier", "payable", "unitPrice", "taxRate", "purchaseOrder"]) {
      expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  test("returning from production is not available, and does not share a word", () => {
    const { CustomerMaterialLot: M } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
    const types = M.schema.path("movements").schema.path("type").options.enum;
    /* The ambiguous word is gone: `RETURNED` alone meant both "back to the
       customer" and "back from production", which made `returnedQuantity`
       unreadable. */
    expect(types).not.toContain("RETURNED");
    expect(types).toContain("RETURNED_TO_CUSTOMER");
    /* Declared so nobody reaches for the ambiguous word — and nothing writes it. */
    expect(types).toContain("RETURNED_FROM_PRODUCTION");
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/storePurchase/customerMaterialIssue.service.js"),
      "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/RETURNED_FROM_PRODUCTION/);
  });
});

/* ══ 7 — OWNERSHIP ISOLATION ════════════════════════════════════════════ */

describe("customer-owned stock is never free stock", () => {
  test("an ordinary company issue cannot consume a customer's lot", async () => {
    const w = await world({ held: 1000 });
    /* The whole 1000 is the customer's. The physical balance says 1000 because
       the shelf does — which is exactly why the guard is needed. */
    const res = await call("/api/cms/stock-adjustments/issue", {
      method: "POST", token: w.token, idempotencyKey: key(),
      body: {
        direction: "debit",
        items: [{
          rawItemId: String(w.item._id), issuedQty: 50, issuedUnit: "Metre",
          warehouseId: String(w.wh._id), locationId: String(w.loc._id),
        }],
        reason: "Ordinary issue",
      },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.details?.reason).toBe("CUSTOMER_OWNED_STOCK_NOT_AVAILABLE");
    expect(res.body.error.details.customerHeld).toBe(1000);
    expect(res.body.error.details.available).toBe(0);
    /* Nothing moved. */
    expect((await freshItem(w)).quantity).toBe(1000);
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("and it can still issue the factory's own share of the same material", async () => {
    const w = await world({ held: 1000 });
    /* The factory bought 200 of the same poplin; the customer sent 1000. */
    await RawItem.updateOne({ _id: w.item._id }, { $inc: { quantity: 200 } });
    const locStock = require("../../services/storePurchase/locationStock.service");
    await locStock.incLocation(null, w.co._id, w.item._id, w.variantId, w.wh._id, w.loc._id, 200);

    const res = await call("/api/cms/stock-adjustments/issue", {
      method: "POST", token: w.token, idempotencyKey: key(),
      body: {
        direction: "debit",
        items: [{
          rawItemId: String(w.item._id), issuedQty: 200, issuedUnit: "Metre",
          warehouseId: String(w.wh._id), locationId: String(w.loc._id),
        }],
        reason: "Ordinary issue of our own",
      },
    });
    expect(res.status).toBeLessThan(400);
    /* The customer's 1000 is untouched. */
    expect((await freshLot(w)).availableQuantity).toBe(1000);
    expect((await freshItem(w)).quantity).toBe(1000);
  });

  test("two customers' material of the same item never mixes", async () => {
    const a = await world({ held: 500 });
    const b = await world({ held: 500, customer: a.cust });
    await issue(a, { lots: [{ lotId: String(a.lot._id), quantity: 500 }] });
    /* b's lot is for a different ORDER of the same customer and is untouched. */
    expect((await CustomerMaterialLot.findById(b.lot._id).lean()).availableQuantity).toBe(500);
    const res = await issue(b, { lots: [{ lotId: String(a.lot._id), quantity: 10 }] });
    expect(res.status).toBe(404);
  });

  test("two lines of one order hold separate lots that cannot cover each other", async () => {
    const w = await world({ held: 400 });
    const otherLine = `CML-OTHER-${++seq}`;
    const sibling = await CustomerMaterialLot.create({
      ...w.lot.toObject(), _id: undefined,
      expectationLineRef: otherLine,
      goodsReceiptId: oid(), goodsReceiptNumber: "GRN/SIB", goodsReceiptLineId: oid(),
      receiptQuantity: 100, baseQuantity: 100, availableQuantity: 100,
      movements: [{ type: "RECEIVED", quantity: 100, baseUnit: "Metre", availableAfter: 100, at: new Date() }],
    });
    /* Two document lines, so they are not one set and cannot move together. */
    const res = await call(ISSUE(w), {
      method: "POST", token: w.token, idempotencyKey: key(),
      body: {
        manufacturingOrderId: String(w.request._id),
        lots: [
          { lotId: String(w.lot._id), quantity: 400 },
          { lotId: String(sibling._id), quantity: 100 },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("LOTS_NOT_ONE_SET");
    expect(res.body.error.details.field).toBe("expectationLineRef");
  });
});

/* ══ 8 — NO COMMERCIAL EFFECT ═══════════════════════════════════════════ */

describe("no money moves", () => {
  test("neither an issue nor a return produces a price, tax, valuation or payable", async () => {
    const w = await world({ held: 500 });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 300 }] });
    await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 200 }] });

    const issuance = await StockIssuance.findOne({ companyId: w.co._id }).lean();
    const item = await freshItem(w);
    const lot = await freshLot(w);
    for (const [name, doc] of [["issuance", issuance], ["lot", lot]]) {
      const text = JSON.stringify(doc);
      for (const banned of ["unitPrice", "taxRate", "payable", "currency", "valuation", "gstNumber"]) {
        expect(text).not.toContain(banned, `${name}: ${banned}`);
      }
    }
    /* The stock transactions record the movement and no money. */
    for (const tx of item.stockTransactions) {
      expect(tx.unitPrice || 0).toBe(0);
      expect(tx.supplier || "").toBe("");
      expect(tx.supplierId || null).toBeNull();
    }
    expect(await PurchaseOrder.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ PERMISSIONS ════════════════════════════════════════════════════════ */

describe("who may do what", () => {
  test("a viewer may read and may not issue or return", async () => {
    const w = await world();
    expect((await call(`/api/cms/store/customer-materials/${w.doc._id}`, { token: w.viewerToken })).status)
      .toBe(200);
    expect((await issue(w, { token: w.viewerToken })).status).toBe(403);
    expect((await returnToCustomer(w, { token: w.viewerToken })).status).toBe(403);
    expect((await freshLot(w)).availableQuantity).toBe(1000);
  });

  test("a viewer may read a lot's movements and its labels", async () => {
    const w = await world();
    const mv = await call(
      `/api/cms/store/customer-materials/${w.doc._id}/lots/${w.lot._id}/movements`,
      { token: w.viewerToken },
    );
    expect(mv.status).toBe(200);
    expect(mv.body.movements[0].type).toBe("RECEIVED");
    const lb = await call(
      `/api/cms/store/customer-materials/${w.doc._id}/lots/${w.lot._id}/labels`,
      { token: w.viewerToken },
    );
    expect(lb.status).toBe(200);
    expect(lb.body.reprintEffect).toBe("NONE");
  });
});

/* ══ BARCODE OWNERSHIP LABELS ═══════════════════════════════════════════ */

describe("the label that says this is not ours", () => {
  /* A print REQUIRES an idempotency key — the route refuses without one, because a
     keyless retry is how one roll acquired two stickers. */
  const print = (w, body, token) => call(
    `/api/cms/store/customer-materials/${w.doc._id}/lots/${w.lot._id}/labels`,
    { method: "POST", token: token || w.token, idempotencyKey: key(), body: body || {} },
  );

  test("it carries the whole ownership chain and no purchase fact", async () => {
    const w = await world({ held: 600 });
    const res = await print(w, { quantity: 300 });
    expect(res.status).toBe(201);
    const label = res.body.label;

    expect(label.banner).toBe("CUSTOMER-SUPPLIED MATERIAL — NOT COMPANY-OWNED");
    expect(label.ownership).toBe("CUSTOMER_OWNED");
    expect(label.customer.label).toBe(w.cust.profile.companyName);
    expect(label.orderRef).toBe(w.orderRef);
    expect(label.orderLineRef).toBe(w.salesLine);
    expect(label.expectationLineRef).toBe(w.cmLine);
    expect(label.documentRef).toBe(w.doc.documentRef);
    expect(label.lot.goodsReceiptNumber).toBe(w.lot.goodsReceiptNumber);
    expect(label.quantity).toBe(300);
    expect(label.unit).toBe("Metre");
    expect(label.where.locationCode).toBe("RECV");

    const stored = await Barcode.findById(label.barcodeId).lean();
    expect(String(stored.companyId)).toBe(String(w.co._id));
    expect(stored.vendor).toBeNull();
    expect(stored.unitPrice).toBeNull();
    expect(stored.purchaseOrder).toBeNull();
    const text = JSON.stringify(label);
    for (const banned of ["vendor", "unitPrice", "purchaseOrder", "taxRate"]) {
      expect(text).not.toContain(banned);
    }
  });

  test("a label for more than is held is refused", async () => {
    const w = await world({ held: 100 });
    const res = await print(w, { quantity: 200 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("LABEL_EXCEEDS_HELD");
  });

  test("scanning it shows customer-owned status, not ordinary stock", async () => {
    const w = await world({ held: 400 });
    const printed = await print(w, { quantity: 400 });
    const scan = await call(
      `/api/cms/inventory/operations/barcodes/${printed.body.label.barcodeId}`,
      { token: w.token },
    );
    expect(scan.status).toBe(200);
    expect(scan.body.ownership.kind).toBe("CUSTOMER_OWNED");
    expect(scan.body.ownership.banner).toMatch(/NOT COMPANY-OWNED/);
    expect(scan.body.ownership.availableAsGeneralStock).toBe(false);
    expect(scan.body.ownership.usableFor).toContain(w.orderRef);
    expect(scan.body.ownership.lot.availableQuantity).toBe(400);
  });

  test("a cross-company scan is refused", async () => {
    const mine = await world();
    const theirs = await world({ held: 200 });
    const printed = await call(
      `/api/cms/store/customer-materials/${theirs.doc._id}/lots/${theirs.lot._id}/labels`,
      { method: "POST", token: theirs.token, idempotencyKey: key(), body: { quantity: 200 } },
    );
    const scan = await call(
      `/api/cms/inventory/operations/barcodes/${printed.body.label.barcodeId}`,
      { token: mine.token },
    );
    /* Answered as absent, because the existence of the label is itself the thing
       being protected. */
    expect(scan.status).toBe(404);
  });

  test("reprinting creates no stock, receipt, lot or balance change", async () => {
    const w = await world({ held: 500 });
    await print(w, { quantity: 500 });
    const before = {
      lots: await CustomerMaterialLot.countDocuments({ companyId: w.co._id }),
      labels: await Barcode.countDocuments({ companyId: w.co._id }),
      item: (await freshItem(w)).quantity,
      available: (await freshLot(w)).availableQuantity,
      movements: await LocationMovement.countDocuments({ companyId: w.co._id }),
    };

    const reprint = await call(
      `/api/cms/store/customer-materials/${w.doc._id}/lots/${w.lot._id}/labels`,
      { token: w.token },
    );
    expect(reprint.status).toBe(200);
    expect(reprint.body.labels).toHaveLength(1);
    expect(reprint.body.reprintEffect).toBe("NONE");

    expect(await CustomerMaterialLot.countDocuments({ companyId: w.co._id })).toBe(before.lots);
    expect(await Barcode.countDocuments({ companyId: w.co._id })).toBe(before.labels);
    expect((await freshItem(w)).quantity).toBe(before.item);
    expect((await freshLot(w)).availableQuantity).toBe(before.available);
    expect(await LocationMovement.countDocuments({ companyId: w.co._id })).toBe(before.movements);
  });

  test("an ordinary label still scans as company-owned", async () => {
    const w = await world();
    const ordinary = await Barcode.create({
      rawItem: w.item._id, rawItemName: w.item.name, rawItemSku: w.item.sku,
      quantity: 10, unit: "Metre",
    });
    const scan = await call(
      `/api/cms/inventory/operations/barcodes/${ordinary._id}`, { token: w.token },
    );
    expect(scan.status).toBe(200);
    expect(scan.body.ownership.kind).toBe("COMPANY_OWNED");
    expect(scan.body.ownership.availableAsGeneralStock).toBe(true);
    /* And the existing payload is unchanged. */
    expect(scan.body.barcode.rawItemSku).toBe(w.item.sku);
  });
});

/* ══ OPERATIONAL STANDING ═══════════════════════════════════════════════ */

describe("what the detail read now reports", () => {
  test("available, issued and returned per line, from the lots", async () => {
    const w = await world({ held: 1000 });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 400 }] });
    await returnToCustomer(w, { lots: [{ lotId: String(w.lot._id), quantity: 100 }] });

    const res = await call(`/api/cms/store/customer-materials/${w.doc._id}`, { token: w.token });
    const line = res.body.standing.lines[0];
    expect(line.availableQuantity).toBe(500);
    expect(line.issuedQuantity).toBe(400);
    expect(line.returnedToCustomerQuantity).toBe(100);
    expect(line.operationalStanding).toBe("PARTLY_ISSUED");
    expect(line.lots).toHaveLength(1);
    expect(line.lots[0].goodsReceiptNumber).toBe(w.lot.goodsReceiptNumber);
    expect(line.lots[0].label.printed).toBe(false);
    /* And the document roll-up. */
    expect(res.body.standing.availableQuantity).toBe(500);
    expect(res.body.standing.issuedQuantity).toBe(400);
    expect(res.body.standing.returnedToCustomerQuantity).toBe(100);
  });

  test("a fully issued line says so", async () => {
    const w = await world({ held: 300 });
    await issue(w, { lots: [{ lotId: String(w.lot._id), quantity: 300 }] });
    const res = await call(`/api/cms/store/customer-materials/${w.doc._id}`, { token: w.token });
    expect(res.body.standing.lines[0].operationalStanding).toBe("FULLY_ISSUED");
  });
});
