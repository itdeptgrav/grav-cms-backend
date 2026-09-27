// test/store-purchase/customer-material-integrity.route.test.js
//
// THE REPAIRS, EACH PROVED AGAINST STORED RECORDS.
//
// Phase 3 shipped customer-owned issue, return and labelling, and every one of the
// defects below was reachable through a route. They are grouped as they were
// found, because each has a different failure and a different cost:
//
//   1  THE DOCUMENT IN THE URL WAS DECORATION. Both operations resolved the
//      document from the LOT, so `/documents/A/issues` happily moved a lot
//      belonging to document B — and the audit trail, the idempotency entity and
//      the response then all named A for an act performed on B. Nothing in the
//      trail contradicted itself, which is what makes that kind of error
//      permanent.
//
//   2  THE LABEL'S DOCUMENT CHECK COULD BE TURNED OFF BY THE CALLER. It read
//      `if (isId(docId) && ...)`, so a malformed document id skipped it entirely
//      and printed a customer's name, order and quantities for a lot on a document
//      the caller had never been shown.
//
//   3  THE EFFECT WAS MARKED BEFORE ANYTHING WAS VALIDATED. A request refused for
//      a bad quantity left an EFFECT_APPLIED record; the operator corrected the
//      form, retried with the same key, and was told to reconcile an operation
//      that had never happened.
//
//   4  RECOVERY ASKED AN EXISTENCE QUESTION OF THE WHOLE COLLECTION. "Does any lot
//      carry a return movement?" — which an unrelated return from last month
//      answers yes to. A failed return reported success, and a real gap in the
//      stock ledger was closed with a false one.
//
//   5  THE DATE THE OPERATOR ENTERED WAS PARSED, ECHOED AND THROWN AWAY. The
//      movement stored `new Date()`, so the stock ledger disagreed with the
//      delivery note and nothing recorded which was right.
//
//   7  A LABEL'S QUANTITY WAS CHECKED ALONE. Four labels of 300 for a lot holding
//      400 each passed on their own and together claimed 1,200 — four rolls on the
//      floor, each marked with metres that did not exist.
//
// Every test below reads the STORED result back: the lot, the issuance, the return
// record, the barcode, the idempotency record, the audit entry. None of them
// asserts on source text, because source text is not what a route does.
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
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const { CustomerMaterialReturn } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialReturn");
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
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
const movements = require("../../services/storePurchase/customerMaterialIssue.service");
const labelService = require("../../services/storePurchase/customerMaterialLabel.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/store/customer-materials",
    require("../../routes/CMS_Routes/StorePurchase/customerMaterials"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); unitOfWork.__setTransactionSupport(null); });

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
    return { status: r.status, body: b, headers: r.headers };
  });

const key = () => `cmx-${++seq}-${Math.random().toString(36).slice(2)}`;
const oid = () => new mongoose.Types.ObjectId();
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const salesLineRef = () => `LN-${String(++seq).padStart(12, "0").slice(-12)}`;

const tokenFor = (over = {}) => jwt.sign(
  {
    id: String(oid()), role: "store_manager", employeeId: `ST${seq}`,
    name: "St", email: "s@x.example", ...over,
  },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

async function actor(co, role = "approver") {
  const n = ++seq;
  const email = `cx${n}@x.example`;
  const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "CX", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "CX" });
  return tokenFor({ id: String(employeeRef), email });
}

/**
 * A company with a warehouse, a store actor and an item — and then any number of
 * customer-material documents inside it.
 *
 * Built in two parts deliberately. Nearly every repair here is about telling two
 * documents apart, so the company, the rack and the catalogue item are SHARED —
 * which is the situation that makes the documents easy to confuse, and the one the
 * old code confused.
 */
async function company({ physical = 2000 } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await Unit.create({ companyId: co._id, name: "Metre", status: "Active" });

  const item = await RawItem.create({
    companyId: co._id, name: `Poplin ${n}`, sku: `RAW-P-${n}`,
    category: "Fabric", usedAs: "FABRIC", unit: "Metre",
    quantity: physical, minStock: 0, maxStock: 0,
  });

  const wh = await Warehouse.create({
    companyId: co._id, name: `WH ${n}`, shortName: `W${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "OTHER", name: "Other", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const loc = wh.locations[0];

  const locStock = require("../../services/storePurchase/locationStock.service");
  await locStock.incLocation(null, co._id, item._id, null, wh._id, loc._id, physical);

  return {
    co, item, wh, loc, other: wh.locations[1],
    token: await actor(co),
    locStock,
  };
}

/**
 * One issued customer-material document in that company, with material already
 * received into a lot, plus the sales order and work order behind it.
 */
async function document(c, {
  held = 1000, customer = null, salesLine = null, orderRef = null,
  documentRef = null, revisionNo = 1, cmLine = null, executionFileId = null,
  customerRequest = null, withWorkOrder = true, state = "ISSUED", createLot = true,
} = {}) {
  const n = ++seq;
  const cust = customer || await Customer.create({
    name: `Buyer ${n}`, email: `cxc${n}@grav.in`, customerId: `CUST-${n}`,
    profile: { companyName: `Buyer Trading ${n}` },
  });
  const sales = salesLine || salesLineRef();
  const request = customerRequest || await CustomerRequest.create({
    requestId: `MO-${n}`, customerId: cust._id,
    items: [{ product: `Tee ${n}`, quantity: 500, lineRef: sales }],
  });

  let fileId = executionFileId;
  if (!fileId) {
    const versionId = oid();
    await SalesHandoverVersion.collection.insertOne({
      _id: versionId, companyId: c.co._id,
      /* Distinct, because this collection carries a unique
         {companyId, handoverRef, handoverLineRef, versionNo} and two documents in
         ONE company is the whole point of this suite. */
      handoverRef: `HO-${n}`, handoverLineRef: `HOL-${n}`, versionNo: 1,
      sourceRecord: {
        app: "sales", recordType: "customer_request",
        recordId: request._id, sourceVersion: "1", issuedAt: new Date(),
      },
    });
    fileId = oid();
    await ExecutionFile.collection.insertOne({
      _id: fileId, companyId: c.co._id, fileNumber: `MEF-${n}`, handoverRef: `HO-${n}`,
      handoverLineRef: `HOL-${n}`, executionPhase: "COORDINATION", lifecycleStatus: "OPEN",
      revision: 0, currentHandoverVersionId: versionId,
      currentExecutionProjection: {
        orderRef: orderRef || `ORD-${n}`, orderLineRef: sales,
        buyerDisplayLabel: `Buyer ${n}`, productName: `Tee ${n}`,
        styleRef: `ST-${n}`, fulfilmentModel: "JOB_WORK",
      },
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  const order = orderRef || `ORD-${n}`;
  const line = cmLine || `CML-${n}`;
  const ref = documentRef || `CSM-2026-${String(n).padStart(4, "0")}`;

  const doc = await CustomerMaterialExpectation.create({
    companyId: c.co._id, executionFileId: fileId, fileNumber: `MEF-${n}`,
    orderRef: order, salesOrderLineRef: sales, fulfilmentModel: "JOB_WORK",
    documentRef: ref, revisionNo, state, revision: revisionNo,
    customerId: cust._id, customerRequestId: request._id,
    customerSnapshot: {
      customerCode: cust.customerId,
      customerLabel: cust.profile?.companyName || cust.name,
      customerName: cust.name, requestRef: request.requestId,
    },
    lines: [{
      lineRef: line, rawItemId: c.item._id, variantId: null, variantCombination: [],
      rawItemName: c.item.name, rawItemSku: c.item.sku,
      requiredQuantity: 1200, unit: "Metre", addedAt: new Date(),
    }],
    issuedAt: new Date(),
  });

  let lot = null;
  if (createLot) {
    const grnId = oid();
    lot = await CustomerMaterialLot.create({
      companyId: c.co._id, customerId: cust._id,
      customerLabel: cust.profile.companyName, customerCode: cust.customerId,
      orderRef: order, orderLineRef: sales, executionFileId: fileId,
      expectationId: doc._id, documentRef: ref,
      expectationRevisionNo: revisionNo, expectationLineRef: line,
      rawItemId: c.item._id, variantId: null, variantCombination: [],
      itemName: c.item.name, sku: c.item.sku,
      goodsReceiptId: grnId, goodsReceiptNumber: `GRN/2026-27/${String(n).padStart(4, "0")}`,
      goodsReceiptLineId: oid(),
      warehouseId: c.wh._id, warehouseName: c.wh.name,
      locationId: c.loc._id, locationCode: c.loc.code,
      receiptUnit: "Metre", receiptQuantity: held,
      baseUnit: "Metre", baseQuantity: held,
      availableQuantity: held, issuedQuantity: 0, returnedQuantity: 0,
      receivedAt: new Date(), receivedBy: { name: "St" },
      movements: [{
        type: "RECEIVED", quantity: held, baseUnit: "Metre", availableAfter: held,
        at: new Date(), goodsReceiptId: grnId,
      }],
    });
  }

  let workOrder = null;
  if (withWorkOrder) {
    const woId = oid();
    await WorkOrder.collection.insertOne({
      _id: woId, companyId: c.co._id, workOrderNumber: `WO-${n}`,
      customerRequestId: request._id,
      salesLineLink: {
        companyId: c.co._id, customerRequestId: request._id,
        lineRef: sales, basis: "sales_line",
      },
      createdAt: new Date(), updatedAt: new Date(),
    });
    workOrder = { _id: woId, number: `WO-${n}` };
  }

  return {
    doc, lot, cust, request, workOrder, fileId,
    documentRef: ref, orderRef: order, salesLine: sales, cmLine: line,
  };
}

const issueAt = (c, d, over = {}) => call(
  `/api/cms/store/customer-materials/${over.docId || d.doc._id}/issues`,
  {
    method: "POST", token: over.token || c.token, idempotencyKey: over.idempotencyKey || key(),
    body: {
      manufacturingOrderId: over.manufacturingOrderId !== undefined
        ? over.manufacturingOrderId : String(d.request._id),
      ...(over.workOrderId !== undefined
        ? { workOrderId: over.workOrderId }
        : (d.workOrder ? { workOrderId: String(d.workOrder._id) } : {})),
      lots: over.lots || [{ lotId: String(d.lot._id), quantity: 400 }],
      ...(over.claimed ? { claimed: over.claimed } : {}),
      note: over.note || "For cutting",
    },
  },
);

const returnAt = (c, d, over = {}) => call(
  `/api/cms/store/customer-materials/${over.docId || d.doc._id}/customer-returns`,
  {
    method: "POST", token: over.token || c.token, idempotencyKey: over.idempotencyKey || key(),
    body: {
      lots: over.lots || [{ lotId: String(d.lot._id), quantity: 100 }],
      reason: over.reason !== undefined ? over.reason : "Surplus after cutting",
      customerReference: over.customerReference || "RTN-1",
      ...(over.returnedOn !== undefined ? { returnedOn: over.returnedOn } : {}),
    },
  },
);

/**
 * Print a label.
 *
 * The key is REQUIRED by the route and travels as the header, so a helper that
 * omitted it would be testing a request the server refuses. `noKey: true` is how a
 * test asks for that refusal deliberately.
 */
const printAt = (c, d, over = {}) => call(
  `/api/cms/store/customer-materials/${over.docId || d.doc._id}/lots/${over.lotId || d.lot._id}/labels`,
  {
    method: "POST", token: over.token || c.token,
    ...(over.noKey ? {} : { idempotencyKey: over.printKey || key() }),
    body: {
      ...(over.quantity !== undefined ? { quantity: over.quantity } : {}),
    },
  },
);

const lotNow = (lot) => CustomerMaterialLot.findById(lot._id).lean();
const itemQty = async (c) => (await RawItem.findById(c.item._id).lean()).quantity;
const onHand = (c) => c.locStock.locationOnHand(
  null, c.co._id, c.item._id, null, c.wh._id, c.loc._id,
);

/* ═════════════════════════════════════════════════════════════════════════
   1 — THE DOCUMENT IN THE URL IS THE ONE THAT IS ACTED ON
   ═══════════════════════════════════════════════════════════════════════ */

describe("a mutation is bound to the document in its URL", () => {
  test("document A's URL cannot issue document B's lot", async () => {
    const c = await company();
    const a = await document(c, { held: 1000 });
    const b = await document(c, { held: 1000 });

    const res = await issueAt(c, b, { docId: String(a.doc._id) });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/LOT_NOT_ON_THIS_DOCUMENT/);

    /* Neither lot moved, and no issuance was written for either. */
    expect((await lotNow(a.lot)).availableQuantity).toBe(1000);
    expect((await lotNow(b.lot)).availableQuantity).toBe(1000);
    expect(await StockIssuance.countDocuments({ companyId: c.co._id })).toBe(0);
    expect(await itemQty(c)).toBe(2000);
  });

  test("and cannot return it either", async () => {
    const c = await company();
    const a = await document(c);
    const b = await document(c);

    const res = await returnAt(c, b, { docId: String(a.doc._id) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/LOT_NOT_ON_THIS_DOCUMENT/);
    expect((await lotNow(b.lot)).availableQuantity).toBe(1000);
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(0);
  });

  test("a request mixing lots from two documents is refused whole", async () => {
    /* The dangerous shape, because one of the two lots IS on the document and a
       per-lot check that stopped at the first valid one would post half of it. */
    const c = await company();
    const a = await document(c, { held: 1000 });
    const b = await document(c, { held: 1000 });

    const res = await issueAt(c, a, {
      lots: [
        { lotId: String(a.lot._id), quantity: 100 },
        { lotId: String(b.lot._id), quantity: 100 },
      ],
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await lotNow(a.lot)).availableQuantity).toBe(1000);
    expect((await lotNow(b.lot)).availableQuantity).toBe(1000);
    expect(await StockIssuance.countDocuments({ companyId: c.co._id })).toBe(0);
    expect(await LocationMovement.countDocuments({ companyId: c.co._id, type: "issue" })).toBe(0);
  });

  test("a lot received against an EARLIER revision is still usable through the current one", async () => {
    /* The binding is the stable `documentRef`, not the revision row's `_id`.
       Requiring the latest `_id` would orphan material that is physically on the
       shelf and was validly received — the lot would become unissuable and
       unreturnable, and Store would have no way to move it at all. */
    const c = await company();
    const r1 = await document(c, { held: 1000, revisionNo: 1 });
    const r2 = await document(c, {
      held: 0, createLot: false, revisionNo: 2,
      documentRef: r1.documentRef, cmLine: r1.cmLine,
      customer: r1.cust, customerRequest: r1.request,
      salesLine: r1.salesLine, orderRef: r1.orderRef,
      executionFileId: r1.fileId, withWorkOrder: false,
    });

    /* Addressed through revision 2; the lot belongs to revision 1. */
    const res = await issueAt(c, { ...r1, doc: r2.doc }, {
      lots: [{ lotId: String(r1.lot._id), quantity: 250 }],
    });

    expect(res.status).toBe(201);
    expect((await lotNow(r1.lot)).availableQuantity).toBe(750);

    /* And the trail names the stable document, which is the same for both
       revisions — so history reads continuously across a revision. */
    expect(res.body.documentRef).toBe(r1.documentRef);
    const issuance = await StockIssuance.findById(res.body.issuance._id).lean();
    expect(issuance.items[0].documentRef).toBe(r1.documentRef);
  });

  test("a lot whose execution file does not match the document is refused", async () => {
    /* Defensive, and the reason is boring and real: a lot could reach this state
       through a bad migration or a hand edit. The permanent identities are checked
       one by one so no single wrong field can carry material onto another job. */
    const c = await company();
    const d = await document(c);
    await CustomerMaterialLot.updateOne(
      { _id: d.lot._id }, { $set: { executionFileId: oid() } },
    );

    const res = await issueAt(c, d);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/execution file/i);
    expect((await lotNow(d.lot)).availableQuantity).toBe(1000);
  });

  test("a lot on a different permanent sales line is refused", async () => {
    /* Two lines of one order are two different garments. Material for one of them
       is not material for the other, however similar the fabric. */
    const c = await company();
    const d = await document(c);
    await CustomerMaterialLot.updateOne(
      { _id: d.lot._id }, { $set: { orderLineRef: salesLineRef() } },
    );

    const res = await issueAt(c, d);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/permanent sales order line|sales order/i);
    expect((await lotNow(d.lot)).availableQuantity).toBe(1000);
  });

  test("a lot whose expectation line is not on the document is refused", async () => {
    const c = await company();
    const d = await document(c);
    await CustomerMaterialLot.updateOne(
      { _id: d.lot._id }, { $set: { expectationLineRef: "CML-not-here" } },
    );

    const res = await issueAt(c, d);
    expect(JSON.stringify(res.body)).toMatch(/LOT_LINE_NOT_ON_DOCUMENT/);
  });

  test("a document id from another company answers as not found", async () => {
    const c1 = await company();
    const c2 = await company();
    const mine = await document(c1);
    const theirs = await document(c2);

    /* c1's token, c2's document. It must not confirm the document exists. */
    const res = await call(
      `/api/cms/store/customer-materials/${theirs.doc._id}/issues`,
      {
        method: "POST", token: c1.token, idempotencyKey: key(),
        body: {
          manufacturingOrderId: String(theirs.request._id),
          lots: [{ lotId: String(mine.lot._id), quantity: 10 }],
        },
      },
    );
    expect(res.status).toBe(404);
    expect((await lotNow(mine.lot)).availableQuantity).toBe(1000);
  });

  test("a malformed document id is a refusal, not a skipped check", async () => {
    const c = await company();
    const d = await document(c);
    const res = await issueAt(c, d, { docId: "not-an-object-id" });
    expect(res.status).toBe(404);
    expect((await lotNow(d.lot)).availableQuantity).toBe(1000);
  });

  test("the audit row, the idempotency entity and the response all name one document", async () => {
    const c = await company();
    const d = await document(c);
    const k = key();

    const res = await issueAt(c, d, { idempotencyKey: k });
    expect(res.status).toBe(201);

    const record = await SpIdempotencyRecord.findOne({
      companyId: c.co._id, key: k,
    }).lean();
    expect(String(record.resultEntityId)).toBe(String(d.doc._id));
    expect(record.resultEntityType).toBe("CUSTOMER_MATERIAL_ISSUE");
    /* And the recovery receipt written with the marker names the same document,
       which is what a recovery long afterwards reads. */
    expect(String(record.recoveryReceipt.entityId)).toBe(String(d.doc._id));
    expect(record.recoveryReceipt.documentNumber).toBe(d.documentRef);

    const history = await SpActionHistory.findOne({
      companyId: c.co._id, entityId: d.doc._id, action: "STOCK_ISSUED",
    }).lean();
    expect(history.documentNumber).toBe(d.documentRef);
    expect(history.metadata.documentRef).toBe(d.documentRef);

    /* And the physical movement carries the same document. */
    const move = await LocationMovement.findOne({
      companyId: c.co._id, type: "issue",
    }).lean();
    expect(move.source.reference).toBe(d.documentRef);
    expect(String(move.source.id)).toBe(String(d.doc._id));
    expect(res.body.documentRef).toBe(d.documentRef);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   2 — THE LABEL IS SCOPED THE SAME WAY
   ═══════════════════════════════════════════════════════════════════════ */

describe("printing an ownership label", () => {
  test("a malformed document id refuses and prints nothing", async () => {
    /* The old check was `isId(docId) && lot.expectationId !== docId`, so this
       exact request — the one input a caller fully controls — skipped it and
       printed the customer's name, order and quantities. */
    const c = await company();
    const d = await document(c);

    const res = await printAt(c, d, { docId: "x", quantity: 100 });
    expect(res.status).toBe(404);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(0);
    expect((await lotNow(d.lot)).labelledQuantity || 0).toBe(0);
  });

  test("another document's lot in the same company refuses, and does not confirm it exists", async () => {
    const c = await company();
    const a = await document(c);
    const b = await document(c);

    const res = await printAt(c, b, { docId: String(a.doc._id), quantity: 50 });
    expect(res.status).toBe(404);
    /* Not "belongs to another document" — that sentence would confirm the lot is
       real and tell a caller where to look. */
    expect(String(res.body.message || "")).toMatch(/not found on this document/i);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": b.lot._id })).toBe(0);
  });

  test("a lot from another company refuses", async () => {
    const c1 = await company();
    const c2 = await company();
    const mine = await document(c1);
    const theirs = await document(c2);

    const res = await call(
      `/api/cms/store/customer-materials/${mine.doc._id}/lots/${theirs.lot._id}/labels`,
      /* A key is sent, because without one the route refuses for THAT reason first
         and this test would pass without proving anything about ownership. */
      { method: "POST", token: c1.token, idempotencyKey: key(), body: { quantity: 10 } },
    );
    expect(res.status).toBe(404);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": theirs.lot._id })).toBe(0);
  });

  test("a lot received against an earlier revision can still be labelled", async () => {
    const c = await company();
    const r1 = await document(c, { held: 600, revisionNo: 1 });
    const r2 = await document(c, {
      held: 0, createLot: false, revisionNo: 2,
      documentRef: r1.documentRef, cmLine: r1.cmLine,
      customer: r1.cust, customerRequest: r1.request,
      salesLine: r1.salesLine, orderRef: r1.orderRef,
      executionFileId: r1.fileId, withWorkOrder: false,
    });

    const res = await printAt(c, { lot: r1.lot }, {
      docId: String(r2.doc._id), quantity: 300,
    });
    expect(res.status).toBe(201);
    expect(res.body.label.documentRef).toBe(r1.documentRef);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   7 — A LABEL IS AN ALLOCATION, AND THE SUM IS WHAT MATTERS
   ═══════════════════════════════════════════════════════════════════════ */

describe("label quantity", () => {
  test("several labels are allowed up to the quantity held, and not past it", async () => {
    /* Six rolls in one delivery are six labels. Four labels of 300 for a lot
       holding 1000 are three labels and a refusal. */
    const c = await company();
    const d = await document(c, { held: 1000 });

    for (const q of [300, 300, 300]) {
      const ok = await printAt(c, d, { quantity: q });
      expect(ok.status).toBe(201);
    }
    const lot = await lotNow(d.lot);
    expect(lot.labelledQuantity).toBe(900);
    expect(lot.labelCount).toBe(3);

    const tooMuch = await printAt(c, d, { quantity: 300 });
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(tooMuch.body)).toMatch(/LABEL_EXCEEDS_HELD/);
    expect(tooMuch.body.error.details.labelable).toBe(100);

    /* The refusal created nothing. */
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(3);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(900);

    /* And the last 100 still can be labelled. */
    const last = await printAt(c, d, { quantity: 100 });
    expect(last.status).toBe(201);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(1000);
  });

  test("each label carries its own allocation identity", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });

    const one = await printAt(c, d, { quantity: 200 });
    const two = await printAt(c, d, { quantity: 200 });

    expect(one.body.allocation.seq).toBe(1);
    expect(two.body.allocation.seq).toBe(2);
    expect(one.body.allocation.ref).not.toBe(two.body.allocation.ref);
    expect(one.body.allocation.ref).toContain(d.lot.goodsReceiptNumber);
    expect(two.body.allocation.stillLabelable).toBe(100);

    /* Stored on the barcode, so a sticker on a floor traces to one claim. */
    const rows = await Barcode.find({ "customerMaterial.lotId": d.lot._id })
      .sort({ "customerMaterial.allocationSeq": 1 }).lean();
    expect(rows.map((b) => b.customerMaterial.allocationSeq)).toEqual([1, 2]);
    expect(rows.map((b) => b.quantity)).toEqual([200, 200]);
  });

  test("the same print key returns the first label and allocates nothing more", async () => {
    /* The printer timed out; the operator pressed Print again. That must not take
       a second slice out of the lot. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    const first = await printAt(c, d, { quantity: 200, printKey: pk });
    const second = await printAt(c, d, { quantity: 200, printKey: pk });

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    /* The stored response, returned verbatim — same status, same label — and said
       out loud on the header so a proxy log shows it was a replay and not a second
       print. */
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    expect(second.body.label.barcodeId).toBe(first.body.label.barcodeId);

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(200);
    expect((await lotNow(d.lot)).labelCount).toBe(1);
  });

  test("a reprint is a read: no barcode, no allocation, no print counter", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });
    await printAt(c, d, { quantity: 200 });
    const before = await lotNow(d.lot);

    const reprint = await call(
      `/api/cms/store/customer-materials/${d.doc._id}/lots/${d.lot._id}/labels`,
      { token: c.token },
    );
    expect(reprint.status).toBe(200);
    expect(reprint.body.labels).toHaveLength(1);
    expect(reprint.body.reprintEffect).toBe("NONE");
    /* The partition is stated, so a screen can offer what is left rather than a
       quantity that will be refused. */
    expect(reprint.body.partition).toMatchObject({
      basis: "PHYSICALLY_HELD", held: 500, labelled: 200, stillLabelable: 300,
    });

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    const after = await lotNow(d.lot);
    expect(after.labelledQuantity).toBe(before.labelledQuantity);
    expect(after.labelCount).toBe(before.labelCount);
    const bc = await Barcode.findOne({ "customerMaterial.lotId": d.lot._id }).lean();
    expect(bc.customerMaterial.printCount).toBe(1);
  });

  test("two simultaneous prints for the same remaining quantity: exactly one wins", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });

    const [a, b] = await Promise.all([
      printAt(c, d, { quantity: 500 }),
      printAt(c, d, { quantity: 500 }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(500);
  });

  test("issuing material takes its labels with it, so the rest can be labelled", async () => {
    /* The sticker is on the roll: issuing the roll sends the sticker to the
       cutting table. Without this the lot would be left claiming quantity it no
       longer holds, and nothing received against it later could ever be labelled. */
    const c = await company();
    const d = await document(c, { held: 1000 });

    await printAt(c, d, { quantity: 1000 });
    expect((await lotNow(d.lot)).labelledQuantity).toBe(1000);

    const res = await issueAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 600 }] });
    expect(res.status).toBe(201);

    const lot = await lotNow(d.lot);
    expect(lot.availableQuantity).toBe(400);
    /* Capped to what is still on the shelf — never left above it. */
    expect(lot.labelledQuantity).toBe(400);

    /* And nothing more may be labelled, because all 400 are already claimed. */
    const more = await printAt(c, d, { quantity: 1 });
    expect(more.status).toBeGreaterThanOrEqual(400);

    /* Whereas after a partial return there is room again. */
    await returnAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 100 }] });
    const after = await lotNow(d.lot);
    expect(after.availableQuantity).toBe(300);
    expect(after.labelledQuantity).toBe(300);
  });

  test("with no quantity given, a label claims what is left rather than the whole lot", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });

    await printAt(c, d, { quantity: 200 });
    const rest = await printAt(c, d, {});
    expect(rest.status).toBe(201);
    expect(rest.body.label.quantity).toBe(300);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(500);

    /* And when nothing is left, it says so in those words. */
    const none = await printAt(c, d, {});
    expect(JSON.stringify(none.body)).toMatch(/NOTHING_LEFT_TO_LABEL/);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   3 — NOTHING IS MARKED UNTIL A REQUEST HAS PASSED VALIDATION
   ═══════════════════════════════════════════════════════════════════════ */

describe("a refused request leaves no trace", () => {
  const recordFor = (c, k) => SpIdempotencyRecord.findOne({ companyId: c.co._id, key: k }).lean();

  test("an impossible quantity leaves no EFFECT_APPLIED marker, and the same key retries", async () => {
    /* This is the sequence that used to poison a key: the mark happened before
       any validation, so the operator's own correction was met with "reconcile,
       do not issue it again" for an operation that had never run. */
    const c = await company();
    const d = await document(c, { held: 100 });
    const k = key();

    const refused = await issueAt(c, d, {
      idempotencyKey: k, lots: [{ lotId: String(d.lot._id), quantity: 900 }],
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    const rec = await recordFor(c, k);
    expect(rec.status).not.toBe("EFFECT_APPLIED");
    expect(rec.effectAppliedAt == null).toBe(true);

    /* Nothing moved. */
    expect((await lotNow(d.lot)).availableQuantity).toBe(100);
    expect(await StockIssuance.countDocuments({ companyId: c.co._id })).toBe(0);

    /* And the very same key, with the same request, simply runs. (A CORRECTED
       body under the same key is a different request and is refused as key reuse —
       which is the right answer, and not the reconciliation dead end.) */
    const retry = await issueAt(c, d, {
      idempotencyKey: k, lots: [{ lotId: String(d.lot._id), quantity: 900 }],
    });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(retry.body)).not.toMatch(/RECONCILIATION/);

    /* A fresh key with a possible quantity succeeds outright. */
    const ok = await issueAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 90 }] });
    expect(ok.status).toBe(201);
    expect((await lotNow(d.lot)).availableQuantity).toBe(10);
  });

  test("an unprovable work order leaves no marker, and the correct one then works", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });

    /* A work order with no `salesLineLink` for this line — a relationship nobody
       can prove is not a weak yes. */
    const strayId = oid();
    await WorkOrder.collection.insertOne({
      _id: strayId, companyId: c.co._id, workOrderNumber: "WO-STRAY",
      createdAt: new Date(), updatedAt: new Date(),
    });

    const k = key();
    const refused = await issueAt(c, d, { idempotencyKey: k, workOrderId: String(strayId) });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await recordFor(c, k)).status).not.toBe("EFFECT_APPLIED");

    const ok = await issueAt(c, d);
    expect(ok.status).toBe(201);
  });

  test("a return with no reason leaves no marker", async () => {
    const c = await company();
    const d = await document(c);
    const k = key();

    const refused = await returnAt(c, d, { idempotencyKey: k, reason: "" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await recordFor(c, k)).status).not.toBe("EFFECT_APPLIED");
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(0);
    expect((await lotNow(d.lot)).availableQuantity).toBe(1000);
  });

  test("a rollback takes the marker with it", async () => {
    /* The write fails after the lot has already been decremented inside the
       transaction. Everything must come back, INCLUDING the marker — otherwise the
       retry is refused as a partially applied operation that applied nothing. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const k = key();

    jest.spyOn(StockIssuance, "create").mockRejectedValueOnce(new Error("issue store unavailable"));

    const failed = await issueAt(c, d, { idempotencyKey: k });
    expect(failed.status).toBe(500);

    const rec = await recordFor(c, k);
    expect(rec.status).not.toBe("EFFECT_APPLIED");
    /* And the lot is whole again. */
    expect((await lotNow(d.lot)).availableQuantity).toBe(500);
    expect(await itemQty(c)).toBe(2000);
    expect(await onHand(c)).toBe(2000);

    jest.restoreAllMocks();
    const ok = await issueAt(c, d);
    expect(ok.status).toBe(201);
    expect((await lotNow(d.lot)).availableQuantity).toBe(100);
  });

  test("a true replay returns the original result and moves nothing twice", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });
    const k = key();

    const first = await issueAt(c, d, { idempotencyKey: k });
    const again = await issueAt(c, d, { idempotencyKey: k });

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(String(again.body.issuance._id)).toBe(String(first.body.issuance._id));
    expect(again.headers.get("idempotency-replayed")).toBe("true");

    expect((await lotNow(d.lot)).availableQuantity).toBe(100);
    expect(await StockIssuance.countDocuments({ companyId: c.co._id })).toBe(1);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   4 — RECOVERY IDENTIFIES THE EXACT OPERATION
   ═══════════════════════════════════════════════════════════════════════ */

describe("recovery", () => {
  /**
   * Reach the one state recovery exists for: the effect marked, the canonical
   * record missing. It is only reachable without transactions — which is exactly
   * the deployment recovery is written for — so transactions are turned off and
   * the canonical write is made to fail.
   */
  async function markedButUnwritten(c, d, { model, k, lots }) {
    unitOfWork.__setTransactionSupport(false);
    const spy = jest.spyOn(model, "create").mockRejectedValue(new Error("store unavailable"));
    const res = model === StockIssuance
      ? await issueAt(c, d, { idempotencyKey: k, lots })
      : await returnAt(c, d, { idempotencyKey: k, lots });
    spy.mockRestore();
    unitOfWork.__setTransactionSupport(null);
    return res;
  }

  test("an unrelated earlier return does NOT make a failed return look successful", async () => {
    /* The old check was "does any lot in this company carry a RETURNED_TO_CUSTOMER
       movement?". So this exact situation — one completed return last week, one
       broken return today — reported success, and the operator was told their work
       had landed while the customer's material was still on the shelf. */
    const c = await company();
    const earlier = await document(c, { held: 1000 });
    const today = await document(c, { held: 1000 });

    const done = await returnAt(c, earlier, { lots: [{ lotId: String(earlier.lot._id), quantity: 50 }] });
    expect(done.status).toBe(201);
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(1);

    const k = key();
    const broke = await markedButUnwritten(c, today, {
      model: CustomerMaterialReturn, k, lots: [{ lotId: String(today.lot._id), quantity: 200 }],
    });
    expect(broke.status).toBe(500);

    /* The retry must be told the truth, in terms somebody can act on. */
    const retry = await returnAt(c, today, {
      idempotencyKey: k, lots: [{ lotId: String(today.lot._id), quantity: 200 }],
    });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    const details = retry.body.error.details;
    expect(details.reason).toBe("PARTIAL_RETURN_NEEDS_RECONCILIATION");
    expect(details.operationType).toBe("RETURN_TO_CUSTOMER");
    expect(details.operationKey).toBe(k);
    expect(details.recordFound).toBe(false);
    /* The exact lot and quantity, so the gap can be closed by hand. */
    expect(details.requested).toEqual([{ lotId: String(today.lot._id), quantity: 200 }]);
    expect(details.missing).toEqual([{ lotId: String(today.lot._id), quantity: 200 }]);

    /* And the earlier, unrelated return is untouched by any of it. */
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(1);
  });

  test("the audit row for a reconciliation names the operation, not just 'recovered'", async () => {
    const c = await company();
    const d = await document(c, { held: 400 });
    const k = key();

    await markedButUnwritten(c, d, {
      model: CustomerMaterialReturn, k, lots: [{ lotId: String(d.lot._id), quantity: 100 }],
    });
    await returnAt(c, d, { idempotencyKey: k, lots: [{ lotId: String(d.lot._id), quantity: 100 }] });

    const row = await SpActionHistory.findOne({
      companyId: c.co._id, entityId: d.doc._id,
      action: "RETURN_TO_CUSTOMER_RECONCILIATION_REQUIRED",
    }).lean();
    expect(row).toBeTruthy();
    expect(row.metadata.operationKey).toBe(k);
    expect(row.metadata.complete).toBe(false);
    expect(row.reason).toMatch(/no record for this operation key/i);
  });

  test("a broken ISSUE is not satisfied by an unrelated customer-owned issuance", async () => {
    const c = await company();
    const earlier = await document(c, { held: 500 });
    const today = await document(c, { held: 500 });

    expect((await issueAt(c, earlier)).status).toBe(201);

    const k = key();
    await markedButUnwritten(c, today, { model: StockIssuance, k });

    const retry = await issueAt(c, today, { idempotencyKey: k });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    expect(retry.body.error.details.reason).toBe("PARTIAL_ISSUE_NEEDS_RECONCILIATION");
    expect(retry.body.error.details.operationKey).toBe(k);
  });

  test("completeness is proved per lot: a record covering only one of two is not done", async () => {
    /* Asked against the stored record, because "found" and "complete" are two
       different questions and the second one is the one that matters. */
    const c = await company();
    const d = await document(c, { held: 1000 });
    const second = await document(c, { held: 1000 });

    const k = key();
    const done = await returnAt(c, d, {
      idempotencyKey: k, lots: [{ lotId: String(d.lot._id), quantity: 120 }],
    });
    expect(done.status).toBe(201);

    const ctx = { companyId: c.co._id };

    /* Exactly what was posted: found and complete. */
    const exact = await movements.findPostedOperation(ctx, {
      operationType: "RETURN_TO_CUSTOMER", idempotencyKey: k,
      expected: [{ lotId: String(d.lot._id), quantity: 120 }],
    });
    expect(exact).toMatchObject({ found: true, complete: true });
    expect(String(exact.record.idempotencyKey)).toBe(k);

    /* One more lot than the record accounts for: found, NOT complete. */
    const partial = await movements.findPostedOperation(ctx, {
      operationType: "RETURN_TO_CUSTOMER", idempotencyKey: k,
      expected: [
        { lotId: String(d.lot._id), quantity: 120 },
        { lotId: String(second.lot._id), quantity: 80 },
      ],
    });
    expect(partial.found).toBe(true);
    expect(partial.complete).toBe(false);

    /* A different quantity for the right lot is also not complete — a return of
       120 does not discharge a request for 300. */
    const wrongQty = await movements.findPostedOperation(ctx, {
      operationType: "RETURN_TO_CUSTOMER", idempotencyKey: k,
      expected: [{ lotId: String(d.lot._id), quantity: 300 }],
    });
    expect(wrongQty.complete).toBe(false);

    /* Another key finds nothing, however many returns the company has. */
    const other = await movements.findPostedOperation(ctx, {
      operationType: "RETURN_TO_CUSTOMER", idempotencyKey: key(),
      expected: [{ lotId: String(d.lot._id), quantity: 120 }],
    });
    expect(other).toMatchObject({ found: false, complete: false });
  });

  test("with no expectation to compare against, completeness is not assumed", async () => {
    /* A caller that cannot reconstruct what was asked for gets "not complete",
       never a guess. Assuming success is how the original defect behaved. */
    const c = await company();
    const d = await document(c, { held: 300 });
    const k = key();
    await returnAt(c, d, { idempotencyKey: k, lots: [{ lotId: String(d.lot._id), quantity: 50 }] });

    const out = await movements.findPostedOperation({ companyId: c.co._id }, {
      operationType: "RETURN_TO_CUSTOMER", idempotencyKey: k, expected: [],
    });
    expect(out.found).toBe(true);
    expect(out.complete).toBe(false);
  });

  test("a replayed return comes back with its own record and effective date", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });
    const k = key();

    const first = await returnAt(c, d, {
      idempotencyKey: k, returnedOn: "2026-09-12",
      lots: [{ lotId: String(d.lot._id), quantity: 75 }],
    });
    expect(first.status).toBe(201);

    const again = await returnAt(c, d, {
      idempotencyKey: k, returnedOn: "2026-09-12",
      lots: [{ lotId: String(d.lot._id), quantity: 75 }],
    });
    expect(again.status).toBe(201);
    expect(String(again.body.customerReturn.id)).toBe(String(first.body.customerReturn.id));

    /* Once only: one record, one movement, one decrement. */
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(1);
    const lot = await lotNow(d.lot);
    expect(lot.returnedQuantity).toBe(75);
    expect(lot.movements.filter((m) => m.type === "RETURNED_TO_CUSTOMER")).toHaveLength(1);
  });

  test("an issue stamps only the movement it created, by id", async () => {
    /* This replaced an array filter that matched "any ISSUED movement whose
       stockIssuanceId is null" — which, the first time it ran, would have stamped
       every historical issue that predated the field with a brand-new issuance. */
    const c = await company();
    const d = await document(c, { held: 1000 });

    /* A historical movement with no issuance reference, exactly as one written
       before the field existed. */
    await CustomerMaterialLot.updateOne({ _id: d.lot._id }, {
      $push: {
        movements: {
          type: "ISSUED", quantity: 10, baseUnit: "Metre", availableAfter: 990,
          at: new Date("2026-01-01"), reason: "before the field existed",
        },
      },
    });

    const res = await issueAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 100 }] });
    expect(res.status).toBe(201);

    const lot = await lotNow(d.lot);
    const historical = lot.movements.find((m) => m.reason === "before the field existed");
    const fresh = lot.movements.find((m) => m.quantity === 100 && m.type === "ISSUED");

    expect(historical.stockIssuanceId == null).toBe(true);
    expect(String(fresh.stockIssuanceId)).toBe(String(res.body.issuance._id));
  });

  test("every movement records which operation wrote it", async () => {
    const c = await company();
    const d = await document(c, { held: 800 });
    const ik = key();
    const rk = key();

    await issueAt(c, d, { idempotencyKey: ik, lots: [{ lotId: String(d.lot._id), quantity: 100 }] });
    await returnAt(c, d, { idempotencyKey: rk, lots: [{ lotId: String(d.lot._id), quantity: 50 }] });

    const lot = await lotNow(d.lot);
    const issued = lot.movements.find((m) => m.type === "ISSUED");
    const returned = lot.movements.find((m) => m.type === "RETURNED_TO_CUSTOMER");

    expect(issued.operationKey).toBe(ik);
    expect(issued.operationType).toBe("ISSUE");
    expect(issued.documentRef).toBe(d.documentRef);

    expect(returned.operationKey).toBe(rk);
    expect(returned.operationType).toBe("RETURN_TO_CUSTOMER");
    /* And the return movement points at its canonical record. */
    const record = await CustomerMaterialReturn.findOne({ companyId: c.co._id, idempotencyKey: rk }).lean();
    expect(String(returned.customerReturnId)).toBe(String(record._id));
    expect(String(record.lines[0].lotMovementId)).toBe(String(returned._id));
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   5 — THE DATE THE MATERIAL ACTUALLY LEFT
   ═══════════════════════════════════════════════════════════════════════ */

describe("a return's effective date", () => {
  test("survives to the database, and is kept apart from when it was keyed in", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });

    const res = await returnAt(c, d, {
      returnedOn: "2026-09-12", customerReference: "CHL-8891",
      lots: [{ lotId: String(d.lot._id), quantity: 120 }],
    });
    expect(res.status).toBe(201);

    const whenItLeft = new Date("2026-09-12").getTime();

    /* 1. The canonical record. */
    const record = await CustomerMaterialReturn.findOne({ companyId: c.co._id }).lean();
    expect(new Date(record.effectiveAt).getTime()).toBe(whenItLeft);
    expect(new Date(record.recordedAt).getTime()).toBeGreaterThan(whenItLeft);
    expect(record.customerReference).toBe("CHL-8891");

    /* 2. The lot's own movement — reloaded from the database, not from the
          response, because the response was never the thing that was wrong. */
    const lot = await lotNow(d.lot);
    const moved = lot.movements.find((m) => m.type === "RETURNED_TO_CUSTOMER");
    expect(new Date(moved.at).getTime()).toBe(whenItLeft);
    expect(new Date(moved.recordedAt).getTime()).toBeGreaterThan(whenItLeft);

    /* 3. The response, for the screen that asked. */
    expect(new Date(res.body.returnedAt).getTime()).toBe(whenItLeft);
    expect(new Date(res.body.effectiveAt).getTime()).toBe(whenItLeft);

    /* 4. The movement history Store reads. */
    const history = await labelService.movementsFor({ companyId: c.co._id }, {
      docId: String(d.doc._id), lotId: String(d.lot._id),
    });
    const row = history.movements.find((m) => m.type === "RETURNED_TO_CUSTOMER");
    expect(new Date(row.at).getTime()).toBe(whenItLeft);
    expect(row.recordedAt).toBeTruthy();

    /* 5. The standing every department reads — Store's detail, Merchandising's
          read-only block and PPC's availability all come through this. */
    const receipts = require("../../services/storePurchase/customerMaterialReceipt.service");
    const fresh = await CustomerMaterialExpectation.findById(d.doc._id);
    const standing = await receipts.standingFor({ companyId: c.co._id }, fresh);
    const lineStanding = standing.lines.find((l) => l.lineRef === d.cmLine);
    expect(new Date(lineStanding.latestReturn.when).getTime()).toBe(whenItLeft);
    expect(lineStanding.latestReturn.quantity).toBe(120);
    expect(lineStanding.latestReturn.customerReference).toBe("CHL-8891");

    /* 6. And the audit trail, on the day it happened. */
    const row6 = await SpActionHistory.findOne({
      companyId: c.co._id, entityId: d.doc._id, action: "STOCK_RETURNED_TO_CUSTOMER",
    }).lean();
    expect(new Date(row6.metadata.effectiveAt).getTime()).toBe(whenItLeft);
    expect(new Date(row6.at).getTime()).toBe(whenItLeft);
  });

  test("with no date given it is today, and still stored as a fact", async () => {
    const c = await company();
    const d = await document(c, { held: 300 });

    const before = Date.now();
    const res = await returnAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 30 }] });
    expect(res.status).toBe(201);

    const record = await CustomerMaterialReturn.findOne({ companyId: c.co._id }).lean();
    expect(new Date(record.effectiveAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(record.effectiveAt).toBeTruthy();
  });

  test("a date that is not a date is refused before anything moves", async () => {
    const c = await company();
    const d = await document(c, { held: 300 });

    const res = await returnAt(c, d, { returnedOn: "last Tuesday-ish" });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await lotNow(d.lot)).availableQuantity).toBe(300);
    expect(await CustomerMaterialReturn.countDocuments({ companyId: c.co._id })).toBe(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   1b — ONLY THE CURRENT ISSUED REVISION MAY RELEASE MATERIAL
   ═══════════════════════════════════════════════════════════════════════ */

describe("the document that releases material must be the one in force", () => {
  /** A further revision of an existing document, in whatever state. */
  const revise = (c, of, { revisionNo, state }) => document(c, {
    held: 0, createLot: false, revisionNo, state,
    documentRef: of.documentRef, cmLine: of.cmLine,
    customer: of.cust, customerRequest: of.request,
    salesLine: of.salesLine, orderRef: of.orderRef,
    executionFileId: of.fileId, withWorkOrder: false,
  });

  /** Nothing anywhere moved. */
  async function nothingMoved(c, d, held) {
    expect((await lotNow(d.lot)).availableQuantity).toBe(held);
    expect(await itemQty(c)).toBe(2000);
    expect(await onHand(c)).toBe(2000);
    expect(await StockIssuance.countDocuments({ companyId: c.co._id })).toBe(0);
    expect(await LocationMovement.countDocuments({ companyId: c.co._id, type: "issue" })).toBe(0);
    expect(await SpActionHistory.countDocuments({
      companyId: c.co._id, action: "STOCK_ISSUED",
    })).toBe(0);
  }

  test("a DRAFT document cannot issue, and writes nothing", async () => {
    /* A draft is Merchandising thinking out loud. Releasing fabric on the strength
       of a sentence nobody has finished writing is the whole problem. */
    const c = await company();
    const d = await document(c, { held: 800, state: "DRAFT" });

    const res = await issueAt(c, d);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.reason).toBe("EXPECTATION_NOT_ISSUED");
    expect(res.body.error.details.state).toBe("DRAFT");
    await nothingMoved(c, d, 800);
  });

  test("a cancelled document cannot issue", async () => {
    const c = await company();
    const d = await document(c, { held: 800, state: "CANCELLED" });

    const res = await issueAt(c, d);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.reason).toBe("EXPECTATION_CANCELLED");
    await nothingMoved(c, d, 800);
  });

  test("an older issued revision cannot issue once a newer one is issued", async () => {
    /* Revision 2 says something different from revision 1 — that is why it exists.
       Issuing against 1 is issuing against an instruction that was replaced, and
       nothing downstream would ever say so. */
    const c = await company();
    const r1 = await document(c, { held: 900, revisionNo: 1 });
    const r2 = await revise(c, r1, { revisionNo: 2, state: "ISSUED" });

    const res = await issueAt(c, r1, { lots: [{ lotId: String(r1.lot._id), quantity: 100 }] });
    expect(res.status).toBe(409);
    const detail = res.body.error.details;
    expect(detail.reason).toBe("EXPECTATION_SUPERSEDED");
    expect(detail.addressedRevisionNo).toBe(1);
    expect(detail.revisionInForce).toBe(2);
    /* It names the one to use, so the refusal is actionable. */
    expect(detail.currentDocId).toBe(String(r2.doc._id));
    await nothingMoved(c, r1, 900);

    /* And the current revision issues that very same lot without complaint. */
    const ok = await issueAt(c, { ...r1, doc: r2.doc }, {
      lots: [{ lotId: String(r1.lot._id), quantity: 100 }],
    });
    expect(ok.status).toBe(201);
    expect((await lotNow(r1.lot)).availableQuantity).toBe(800);
  });

  test("a newer DRAFT revision does NOT stop the issued one from working", async () => {
    /* The everyday case, and the one a naive "must be the highest revision" rule
       would break: Merchandising opens revision 3 and works on it for a week while
       Store keeps feeding the cutting room from revision 2. */
    const c = await company();
    const r1 = await document(c, { held: 500, revisionNo: 1 });
    await revise(c, r1, { revisionNo: 2, state: "DRAFT" });

    const res = await issueAt(c, r1, { lots: [{ lotId: String(r1.lot._id), quantity: 200 }] });
    expect(res.status).toBe(201);
    expect((await lotNow(r1.lot)).availableQuantity).toBe(300);
  });

  test("a cancelled newer revision does not resurrect the issued one underneath it", async () => {
    /* Withdrawing revision 2 withdraws the document. Treating revision 1 as back in
       force would be resurrecting a statement somebody deliberately replaced and
       then deliberately withdrew. */
    const c = await company();
    const r1 = await document(c, { held: 500, revisionNo: 1 });
    await revise(c, r1, { revisionNo: 2, state: "CANCELLED" });

    const res = await issueAt(c, r1);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.reason).toBe("EXPECTATION_CANCELLED");
    expect(res.body.error.details.revisionInForce).toBe(2);
    await nothingMoved(c, r1, 500);
  });

  test("a document with no customer cannot issue", async () => {
    /* A Phase 1 document. Material issued against it could not be traced to an
       owner afterwards, which is the one thing customer-owned stock exists to keep. */
    const c = await company();
    const d = await document(c, { held: 400 });
    await CustomerMaterialExpectation.updateOne(
      { _id: d.doc._id }, { $unset: { customerId: "" } },
    );

    const res = await issueAt(c, d);
    expect(res.body.error.details.reason).toBe("DOCUMENT_HAS_NO_CUSTOMER");
    await nothingMoved(c, d, 400);
  });

  test("a document with no permanent sales line cannot issue", async () => {
    const c = await company();
    const d = await document(c, { held: 400 });
    await CustomerMaterialExpectation.updateOne(
      { _id: d.doc._id }, { $set: { salesOrderLineRef: "" } },
    );

    const res = await issueAt(c, d);
    expect(res.body.error.details.reason).toBe("DOCUMENT_HAS_NO_SALES_LINE");
    await nothingMoved(c, d, 400);
  });

  /* ── THE GAP BETWEEN PLANNING AND POSTING ───────────────────────────────── */

  test("a cancellation between planning and posting rolls the whole issue back", async () => {
    /* The realistic sequence: Store opens the issue screen, Merchandising withdraws
       the document while the operator is reading it, Store presses Issue. The plan
       was made against a document that was still in force; by the time the stock
       moves it is not. Everything must come back — and the marker with it, so the
       retry is not refused as a partially applied operation. */
    const c = await company();
    const d = await document(c, { held: 600 });
    const k = key();

    /* Withdraw it at the moment the transaction has opened and the first lot is
       about to be re-read — after planning, inside posting. */
    const real = CustomerMaterialLot.findOne;
    let fired = false;
    jest.spyOn(CustomerMaterialLot, "findOne").mockImplementation(function patched(...args) {
      if (!fired) {
        fired = true;
        /* Outside the transaction, as Merchandising's own request would be. */
        return {
          session: () => CustomerMaterialExpectation
            .updateOne({ _id: d.doc._id }, { $set: { state: "CANCELLED" } })
            .then(() => real.apply(CustomerMaterialLot, args).session(null)),
        };
      }
      return real.apply(CustomerMaterialLot, args);
    });

    const res = await issueAt(c, d, { idempotencyKey: k });
    jest.restoreAllMocks();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/EXPECTATION_CANCELLED/);

    /* Nothing, anywhere. */
    await nothingMoved(c, d, 600);
    const rec = await SpIdempotencyRecord.findOne({ companyId: c.co._id, key: k }).lean();
    expect(rec.status).not.toBe("EFFECT_APPLIED");
    expect(rec.effectAppliedAt == null).toBe(true);
  });

  test("a revision issued between planning and posting rolls the whole issue back", async () => {
    const c = await company();
    const r1 = await document(c, { held: 600, revisionNo: 1 });
    const k = key();

    const real = CustomerMaterialLot.findOne;
    let fired = false;
    jest.spyOn(CustomerMaterialLot, "findOne").mockImplementation(function patched(...args) {
      if (!fired) {
        fired = true;
        return {
          session: () => revise(c, r1, { revisionNo: 2, state: "ISSUED" })
            .then(() => real.apply(CustomerMaterialLot, args).session(null)),
        };
      }
      return real.apply(CustomerMaterialLot, args);
    });

    const res = await issueAt(c, r1, { idempotencyKey: k });
    jest.restoreAllMocks();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/EXPECTATION_SUPERSEDED/);
    await nothingMoved(c, r1, 600);
    const rec = await SpIdempotencyRecord.findOne({ companyId: c.co._id, key: k }).lean();
    expect(rec.status).not.toBe("EFFECT_APPLIED");
  });

  /* ── AND RETURNS ARE NOT NARROWED BY ANY OF IT ──────────────────────────── */

  test("held material can still be returned after the document is cancelled", async () => {
    /* A withdrawal is one of the main REASONS material goes back. Blocking the
       return would leave the customer's fabric stranded on our rack with no
       operation able to move it. */
    const c = await company();
    const d = await document(c, { held: 500 });
    await CustomerMaterialExpectation.updateOne(
      { _id: d.doc._id }, { $set: { state: "CANCELLED" } },
    );

    const res = await returnAt(c, d, { lots: [{ lotId: String(d.lot._id), quantity: 500 }] });
    expect(res.status).toBe(201);
    const lot = await lotNow(d.lot);
    expect(lot.returnedQuantity).toBe(500);
    expect(lot.availableQuantity).toBe(0);
  });

  test("and after it has been superseded, from the older revision it was received against", async () => {
    const c = await company();
    const r1 = await document(c, { held: 400, revisionNo: 1 });
    const r2 = await revise(c, r1, { revisionNo: 2, state: "ISSUED" });

    const res = await returnAt(c, { ...r1, doc: r2.doc }, {
      lots: [{ lotId: String(r1.lot._id), quantity: 150 }],
    });
    expect(res.status).toBe(201);
    expect((await lotNow(r1.lot)).returnedQuantity).toBe(150);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
   3b — A FIRST PRINT IS ONE OPERATION, OR IT IS NONE
   ═══════════════════════════════════════════════════════════════════════ */

describe("printing is atomic and keyed", () => {
  test("a print with no key is refused before anything is read", async () => {
    /* Printing used to accept an OPTIONAL key, so the ordinary retry — the printer
       jammed, the operator pressed Print again — arrived with no key and took a
       second slice of the same roll. One roll, two stickers, two quantities. */
    const c = await company();
    const d = await document(c, { held: 500 });

    const res = await printAt(c, d, { quantity: 100, noKey: true });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).toMatch(/Idempotency-Key/i);

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(0);
    const lot = await lotNow(d.lot);
    expect(lot.labelledQuantity || 0).toBe(0);
    expect(lot.labelCount || 0).toBe(0);
  });

  test("the same key with a different quantity is a conflict, not a second label", async () => {
    /* The operator changed their mind about the roll's length and pressed Print
       again. That is a different request, and answering it with the first label
       would be a lie about what is on the sticker. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    const first = await printAt(c, d, { quantity: 100, printKey: pk });
    expect(first.status).toBe(201);

    const changed = await printAt(c, d, { quantity: 250, printKey: pk });
    expect(changed.status).toBe(409);
    expect(JSON.stringify(changed.body)).toMatch(/already used for a different request/i);

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(100);
  });

  test("the same key against a different LOT is a conflict too", async () => {
    const c = await company();
    const a = await document(c, { held: 500 });
    const b = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    expect((await printAt(c, a, { quantity: 100, printKey: pk })).status).toBe(201);

    /* Different target, same key: the claim is scoped to document and lot, so this
       cannot be answered with A's label. */
    const other = await printAt(c, b, { quantity: 100, printKey: pk });
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": b.lot._id })).toBe(0);
    expect((await lotNow(b.lot)).labelledQuantity || 0).toBe(0);
  });

  test("a failure creating the sticker leaves no claim on the lot", async () => {
    /* The claim and the Barcode are one transaction. If the sticker cannot be
       written the claim must not survive it — a claim with no sticker holds
       quantity that can never be labelled again and that nobody can explain. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    jest.spyOn(Barcode, "create").mockRejectedValueOnce(new Error("label printer service down"));
    const failed = await printAt(c, d, { quantity: 200, printKey: pk });
    jest.restoreAllMocks();

    expect(failed.status).toBe(500);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(0);
    const lot = await lotNow(d.lot);
    expect(lot.labelledQuantity || 0).toBe(0);
    expect(lot.labelCount || 0).toBe(0);
    /* And no marker, so the retry is not routed into reconciliation. */
    const rec = await SpIdempotencyRecord.findOne({ companyId: c.co._id, key: pk }).lean();
    expect(rec.status).not.toBe("EFFECT_APPLIED");

    /* The retry — same key, same request — simply prints. */
    const retry = await printAt(c, d, { quantity: 200, printKey: pk });
    expect(retry.status).toBe(201);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(200);
  });

  test("without transactions, an interrupted print is reported rather than repeated", async () => {
    /* On a standalone mongod the claim and the sticker cannot commit together, so
       the honest behaviour is not to pretend: the operation is marked before the
       mutation, and the retry says what state it is in instead of allocating again.

       This is the state the old `catch` compensation could not cover at all — it
       handles a thrown error and does nothing about a process being killed in the
       gap. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    unitOfWork.__setTransactionSupport(false);
    /* Kill it after the claim, before the sticker, in a way no catch can mend:
       the compensation itself fails too. */
    jest.spyOn(Barcode, "create").mockRejectedValue(new Error("killed"));
    const realUpdate = CustomerMaterialLot.updateOne;
    jest.spyOn(CustomerMaterialLot, "updateOne").mockImplementation((...args) => {
      const set = args[1] || {};
      /* Only the compensating decrement is suppressed. */
      if (set.$inc && "labelledQuantity" in set.$inc && set.$inc.labelledQuantity < 0) {
        return Promise.resolve({ acknowledged: true, modifiedCount: 0 });
      }
      return realUpdate.apply(CustomerMaterialLot, args);
    });

    const failed = await printAt(c, d, { quantity: 200, printKey: pk });
    jest.restoreAllMocks();
    unitOfWork.__setTransactionSupport(null);

    expect(failed.status).toBe(500);
    /* The premise of this test: the claim landed and the sticker did not. */
    expect((await lotNow(d.lot)).labelledQuantity).toBe(200);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(0);

    /* The retry does NOT print and does NOT allocate again. It names the leak. */
    const retry = await printAt(c, d, { quantity: 200, printKey: pk });
    expect(retry.status).toBeGreaterThanOrEqual(400);
    const detail = retry.body.error.details;
    expect(detail.reason).toBe("PARTIAL_LABEL_NEEDS_RECONCILIATION");
    expect(detail.operationKey).toBe(pk);
    expect(detail.lotId).toBe(String(d.lot._id));

    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(0);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(200);

    /* And the audit trail says which operation needs looking at. */
    const row = await SpActionHistory.findOne({
      companyId: c.co._id, action: "LABEL_RECONCILIATION_REQUIRED",
    }).lean();
    expect(row.metadata.operationKey).toBe(pk);
    expect(row.metadata.complete).toBe(false);
  });

  test("when the sticker DID land, the interrupted retry returns it", async () => {
    /* The other half of the three-way: allocation and Barcode both committed, only
       the bookkeeping afterwards failed. That is a success, and must be reported as
       one — with the original label, not a second. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    unitOfWork.__setTransactionSupport(false);
    /* Everything lands; the history write at the end is what fails. */
    const actionHistory = require("../../services/storePurchase/actionHistory.service");
    jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
    const failed = await printAt(c, d, { quantity: 150, printKey: pk });
    jest.restoreAllMocks();
    unitOfWork.__setTransactionSupport(null);

    expect(failed.status).toBe(500);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);

    const retry = await printAt(c, d, { quantity: 150, printKey: pk });
    expect(retry.status).toBe(200);
    expect(retry.body.label).toBeTruthy();
    expect(retry.headers.get("idempotency-recovered")).toBe("true");

    /* Still one sticker, still one claim. */
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(150);
  });

  test("two simultaneous requests with the same key produce one label", async () => {
    /* A double-click, or a client that retried before the first answer arrived. */
    const c = await company();
    const d = await document(c, { held: 500 });
    const pk = `print-${key()}`;

    const [a, b] = await Promise.all([
      printAt(c, d, { quantity: 200, printKey: pk }),
      printAt(c, d, { quantity: 200, printKey: pk }),
    ]);

    /* One of them may be told the first is still in progress; neither may produce
       a second label. */
    expect([a.status, b.status].filter((s) => s === 201).length).toBeLessThanOrEqual(1);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(200);
    expect((await lotNow(d.lot)).labelCount).toBe(1);
  });

  test("two simultaneous requests with DIFFERENT keys cannot over-allocate", async () => {
    /* Two people, two rolls, one lot that only has room for one of their claims. */
    const c = await company();
    const d = await document(c, { held: 300 });

    const [a, b] = await Promise.all([
      printAt(c, d, { quantity: 300 }),
      printAt(c, d, { quantity: 300 }),
    ]);
    const ok = [a, b].filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id })).toBe(1);
    expect((await lotNow(d.lot)).labelledQuantity).toBe(300);
  });

  test("a reprint still writes nothing at all", async () => {
    const c = await company();
    const d = await document(c, { held: 500 });
    await printAt(c, d, { quantity: 200 });

    const before = await lotNow(d.lot);
    const barcodesBefore = await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id });
    const historyBefore = await SpActionHistory.countDocuments({ companyId: c.co._id });

    /* No key, because a read needs none — and that is the proof it is a read. */
    const reprint = await call(
      `/api/cms/store/customer-materials/${d.doc._id}/lots/${d.lot._id}/labels`,
      { token: c.token },
    );
    expect(reprint.status).toBe(200);
    expect(reprint.body.reprintEffect).toBe("NONE");

    const after = await lotNow(d.lot);
    expect(after.labelledQuantity).toBe(before.labelledQuantity);
    expect(after.labelCount).toBe(before.labelCount);
    expect(after.lastLabelledAt).toEqual(before.lastLabelledAt);
    expect(await Barcode.countDocuments({ "customerMaterial.lotId": d.lot._id }))
      .toBe(barcodesBefore);
    expect(await SpActionHistory.countDocuments({ companyId: c.co._id })).toBe(historyBefore);
  });
});
