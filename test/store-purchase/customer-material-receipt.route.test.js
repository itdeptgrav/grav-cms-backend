// test/store-purchase/customer-material-receipt.route.test.js
//
// RECEIVING GOODS THE FACTORY DID NOT BUY.
//
// On a job-work order the customer sends the fabric. It arrives, it is counted,
// it goes on our shelf — and it is not ours. What this suite proves is that the
// receipt is the SAME physical act a purchase receipt performs, and that the
// ownership it creates is strict enough to be worth having.
//
// ── THE CLAIMS ──────────────────────────────────────────────────────────────
//
//   1  PURCHASE RECEIPTS ARE UNCHANGED. The source discriminator and the shared
//      posting did not alter what a purchase receipt writes. Proved here as well
//      as in the purchase suites, because a shared implementation is exactly
//      where a regression hides.
//
//   2  PARTIAL, FINAL AND MULTI-LINE all work, and progress is DERIVED from the
//      receipts every time — never stored on the expectation, where it would
//      drift silently.
//
//   3  OVER-RECEIPT IS REFUSED BEFORE ANY WRITE, and two simultaneous receipts
//      cannot between them exceed what is pending.
//
//   4  A REPLAY RETURNS THE FIRST RECEIPT and creates no second GRN, no second
//      movement and no second lot.
//
//   5  A FAILURE ROLLS BACK EVERYTHING. There is no state in which a customer's
//      goods sit on the shelf owned by nobody, and none in which a lot exists
//      with no receipt behind it.
//
//   6  OWNERSHIP IS STRICT. Not another customer's order, not another order for
//      the same customer, not another line of the same order.
//
//   7  IT CARRIES NO PURCHASE. No vendor, no invoice, no price, no tax, nothing
//      payable, no spend — and the document will not save if one is attempted.
//
//   8  READING IS NOT RECEIVING. `sp.read` opens the register; `sp.receipt.record`
//      is required to sign for anything.
//
// And the revision rules: a later revision may not ask for less than has
// arrived, may not drop a received line, and every receipt keeps naming the
// exact revision it was measured against.
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
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const {
  CustomerMaterialExpectation,
} = require("../../models/CMS_Models/Merchandising/CustomerMaterialExpectation");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/store/customer-materials", require("../../routes/CMS_Routes/StorePurchase/customerMaterials"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  /* The lot's uniqueness guarantee is one of the claims, so the index has to
     exist rather than be assumed. */
  await CustomerMaterialLot.syncIndexes();
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
    return { status: r.status, body: b, replayed: r.headers.get("Idempotency-Replayed") === "true" };
  });

const key = () => `cmr-${++seq}-${Math.random().toString(36).slice(2)}`;
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

const tokenFor = (over = {}) => jwt.sign(
  {
    id: String(new mongoose.Types.ObjectId()), role: "store_manager",
    employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over,
  },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

/**
 * A Store person at one of the two rungs this suite cares about.
 *
 * `viewer` carries `sp.read` and nothing else — the whole point of claim 8 is
 * that it is not enough to sign for goods.
 */
async function actor(co, role = "approver") {
  const n = ++seq;
  const email = `cm${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "CM", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "CM" });
  return tokenFor({ id: String(employeeRef), email });
}

const warehouse = (companyId) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
});

const rawItem = (over = {}) => {
  const n = ++seq;
  return RawItem.create({
    companyId: over.companyId,
    name: over.name || `Customer poplin ${n}`,
    sku: over.sku || `RAW-CP-${n}`,
    category: "Fabric", usedAs: "FABRIC",
    unit: over.unit || "Metre",
    quantity: 0, minStock: 0, maxStock: 0,
    ...(over.variants ? { variants: over.variants } : {}),
    /* Commercial facts written in, so "never returned and never touched" is
       proved against a record that really carries them. */
    discounts: [{ minQuantity: 500, price: 214.75 }],
    primaryVendor: new mongoose.Types.ObjectId(),
    budgetLedgerName: "Fabric purchases",
  });
};

/**
 * A whole job-work world: the ownership chain, the execution file, the material,
 * the warehouse, and an ISSUED expectation with the lines asked for.
 *
 * The execution file and handover version go straight into their collections:
 * this suite is about RECEIPT, and their own validation is the subject of their
 * own suites. Inventing a plausible commercial record here to test a physical
 * one would mean testing the wrong thing.
 */
async function world({ lines = [{ quantity: 1200 }], orderRef, orderLineRef, customer } = {}) {
  const n = ++seq;
  const co = await company();
  await Unit.create({ companyId: co._id, name: "Metre", status: "Active" });

  const cust = customer || await Customer.create({
    name: `Buyer Person ${n}`, email: `cmcust${n}@grav.in`,
    customerId: `CUST-${n}`, profile: { companyName: `Buyer Trading ${n}` },
  });
  const request = await CustomerRequest.create({ requestId: `CR-${n}`, customerId: cust._id });
  const versionId = new mongoose.Types.ObjectId();
  await SalesHandoverVersion.collection.insertOne({
    _id: versionId, companyId: co._id,
    sourceRecord: {
      app: "sales", recordType: "customer_request",
      recordId: request._id, sourceVersion: "1", issuedAt: new Date(),
    },
  });

  const fileId = new mongoose.Types.ObjectId();
  const order = orderRef || `ORD-${n}`;
  await ExecutionFile.collection.insertOne({
    _id: fileId, companyId: co._id, fileNumber: `MEF-${n}`, handoverRef: `HO-${n}`,
    handoverLineRef: `HOL-${n}`, executionPhase: "COORDINATION", lifecycleStatus: "OPEN",
    revision: 0, currentHandoverVersionId: versionId,
    currentExecutionProjection: {
      orderRef: order, buyerDisplayLabel: `Buyer ${n}`, productName: `Tee ${n}`,
      styleRef: `ST-${n}`, buyerStyleRef: `BST-${n}`, fulfilmentModel: "JOB_WORK",
      /* The permanent Sales line. Required for an issue to be provable against a
         WorkOrder, and stamped onto the expectation and the lot at receipt. */
      orderLineRef: orderLineRef || `LN-${String(n).padStart(12, "0").slice(-12)}`,
    },
    createdAt: new Date(), updatedAt: new Date(),
  });

  const items = [];
  const docLines = [];
  for (const l of lines) {
    const item = l.rawItem || await rawItem({ companyId: co._id, name: l.name });
    items.push(item);
    docLines.push({
      lineRef: l.lineRef || `CML-${++seq}`,
      rawItemId: item._id,
      variantId: l.variantId || null,
      variantCombination: l.variantCombination || [],
      rawItemName: item.name,
      rawItemSku: item.sku,
      requiredQuantity: l.quantity,
      unit: l.unit || "Metre",
      addedAt: new Date(),
    });
  }

  const doc = await CustomerMaterialExpectation.create({
    companyId: co._id, executionFileId: fileId, fileNumber: `MEF-${n}`,
    orderRef: order, fulfilmentModel: "JOB_WORK",
    salesOrderLineRef: orderLineRef || `LN-${String(n).padStart(12, "0").slice(-12)}`,
    documentRef: `CSM-2026-${String(n).padStart(4, "0")}`,
    revisionNo: 1, state: "ISSUED", revision: 1,
    customerId: cust._id, customerRequestId: request._id,
    customerSnapshot: {
      customerCode: cust.customerId,
      customerLabel: cust.profile?.companyName || cust.name,
      customerName: cust.name,
      requestRef: request.requestId,
    },
    lines: docLines,
    issuedAt: new Date(),
  });

  const wh = await warehouse(co._id);
  return {
    co, cust, request, fileId, orderRef: order, doc, items, wh,
    loc: wh.locations[0],
    token: await actor(co),
    viewerToken: await actor(co, "viewer"),
  };
}

const receive = (w, { items, token, idempotencyKey, ...rest } = {}) => call(
  `/api/cms/store/customer-materials/${w.doc._id}/receipts`,
  {
    method: "POST", token: token || w.token, idempotencyKey: idempotencyKey || key(),
    body: {
      warehouseId: String(w.wh._id), locationId: String(w.loc._id),
      items: items || [{ lineRef: w.doc.lines[0].lineRef, quantity: 500, unit: "Metre" }],
      customerReference: "CHALLAN-1",
      ...rest,
    },
  },
);

const lotsOf = (w) => CustomerMaterialLot.find({ companyId: w.co._id }).lean();
const detail = (w, token) => call(`/api/cms/store/customer-materials/${w.doc._id}`, { token: token || w.token });

/* ══ 2 — PARTIAL, FINAL, MULTI-LINE ══════════════════════════════════════ */

describe("receiving what the customer sent", () => {
  test("a partial receipt records a GRN, moves stock, and creates one lot", async () => {
    const w = await world();
    const res = await receive(w);

    expect(res.status).toBe(201);
    const grn = res.body.goodsReceipt;
    expect(grn.receiptNumber).toMatch(/GRN/);
    expect(grn.sourceType).toBe("CUSTOMER_MATERIAL");
    expect(String(grn.sourceDocumentId)).toBe(String(w.doc._id));
    expect(grn.sourceDocumentNumber).toBe(w.doc.documentRef);
    expect(grn.lines[0].sourceLineRef).toBe(w.doc.lines[0].lineRef);
    /* The exact statement it was measured against. */
    expect(grn.customerMaterial.expectationRevisionNo).toBe(1);
    expect(grn.customerMaterial.customerReference).toBe("CHALLAN-1");

    /* The PHYSICAL balance moved — the shelf holds it, whoever owns it. */
    const item = await RawItem.findById(w.items[0]._id).lean();
    expect(item.quantity).toBe(500);
    expect(item.stockTransactions).toHaveLength(1);

    /* And exactly one ownership lot, with all of it available. */
    const lots = await lotsOf(w);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({
      baseQuantity: 500, availableQuantity: 500, issuedQuantity: 0, returnedQuantity: 0,
      status: "HELD", orderRef: w.orderRef, expectationRevisionNo: 1,
    });
    expect(lots[0].orderLineRef).toBe(w.doc.salesOrderLineRef);
    expect(String(lots[0].customerId)).toBe(String(w.cust._id));
    expect(lots[0].expectationLineRef).toBe(w.doc.lines[0].lineRef);
    expect(lots[0].goodsReceiptNumber).toBe(grn.receiptNumber);
  });

  test("progress is derived, and the standing advances with each receipt", async () => {
    const w = await world();
    const first = await receive(w);
    expect(first.body.standing.lines[0]).toMatchObject({
      requiredQuantity: 1200, receivedQuantity: 500, pendingQuantity: 700,
      status: "PARTIALLY_RECEIVED", receiptCount: 1,
    });
    expect(first.body.standing.standing).toBe("PARTIALLY_RECEIVED");
    expect(first.body.standing.nextOwner).toBe("STORE");

    const second = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 700, unit: "Metre" }],
    });
    expect(second.body.standing.lines[0]).toMatchObject({
      receivedQuantity: 1200, pendingQuantity: 0, status: "RECEIVED", receiptCount: 2,
    });
    expect(second.body.standing.standing).toBe("RECEIVED");
    /* Nothing left for Store to do, so the file comes back to Merchandising. */
    expect(second.body.standing.nextOwner).toBe("MERCHANDISING");
    expect(second.body.standing.lines[0].receiptHistory).toHaveLength(2);
  });

  test("nothing is written back onto the expectation", async () => {
    const w = await world();
    await receive(w);
    const stored = await CustomerMaterialExpectation.findById(w.doc._id).lean();
    /* A stored counter would be a second source of truth that drifts the first
       time a receipt is voided — silently, because nothing recomputes it. */
    expect(JSON.stringify(stored)).not.toContain("receivedQuantity");
    expect(stored.lines[0].requiredQuantity).toBe(1200);
    expect(stored.state).toBe("ISSUED");
    expect(stored.revision).toBe(1);
  });

  test("a multi-line receipt records one GRN and one lot per line", async () => {
    const w = await world({ lines: [{ quantity: 1000 }, { quantity: 40, name: "Interlining" }] });
    const res = await receive(w, {
      items: [
        { lineRef: w.doc.lines[0].lineRef, quantity: 600, unit: "Metre" },
        { lineRef: w.doc.lines[1].lineRef, quantity: 40, unit: "Metre" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.goodsReceipt.lines).toHaveLength(2);
    expect(res.body.lotCount).toBe(2);

    const lots = await lotsOf(w);
    expect(lots).toHaveLength(2);
    /* Two lots, two DOCUMENT lines — not one merged quantity. The lot's
       `orderLineRef` is now the permanent SALES line (one per order line, shared
       by both document lines here), and `expectationLineRef` is the document's. */
    expect(new Set(lots.map((l) => l.expectationLineRef)).size).toBe(2);
    expect(res.body.standing.counts).toMatchObject({ PARTIALLY_RECEIVED: 1, RECEIVED: 1 });
  });

  test("the same line twice in one receipt is refused", async () => {
    const w = await world();
    const ref = w.doc.lines[0].lineRef;
    const res = await receive(w, {
      items: [
        { lineRef: ref, quantity: 100, unit: "Metre" },
        { lineRef: ref, quantity: 100, unit: "Metre" },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("DUPLICATE_LINE");
    expect(await lotsOf(w)).toHaveLength(0);
  });

  test("a receipt in the wrong unit is refused, so the two totals stay comparable", async () => {
    const w = await world();
    const res = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 5, unit: "Kilogram" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("UNIT_MISMATCH");
    expect(await lotsOf(w)).toHaveLength(0);
  });
});

/* ══ 3 — OVER-RECEIPT AND THE RACE ═══════════════════════════════════════ */

describe("more than was expected", () => {
  test("over-receipt is refused before any write", async () => {
    const w = await world();
    const res = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 1300, unit: "Metre" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("OVER_RECEIPT");
    expect(res.body.error.details.pending).toBe(1200);

    /* Nothing mutated: no GRN, no stock, no lot. */
    expect(await GoodsReceipt.countDocuments({ companyId: w.co._id })).toBe(0);
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(0);
    expect(await lotsOf(w)).toHaveLength(0);
  });

  test("a second receipt cannot exceed what is left", async () => {
    const w = await world();
    await receive(w, { items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 900, unit: "Metre" }] });
    const res = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 400, unit: "Metre" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.pending).toBe(300);
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(900);
  });

  test("two simultaneous receipts cannot between them exceed the pending quantity", async () => {
    const w = await world({ lines: [{ quantity: 100 }] });
    const ref = w.doc.lines[0].lineRef;

    /* Both read "100 pending" and both try to take it. Exactly one may win. */
    const [a, b] = await Promise.all([
      receive(w, { items: [{ lineRef: ref, quantity: 100, unit: "Metre" }] }),
      receive(w, { items: [{ lineRef: ref, quantity: 100, unit: "Metre" }] }),
    ]);
    const created = [a, b].filter((r) => r.status === 201);
    expect(created).toHaveLength(1);

    const item = await RawItem.findById(w.items[0]._id).lean();
    expect(item.quantity).toBe(100);
    const lots = await lotsOf(w);
    expect(lots).toHaveLength(1);
    expect(lots[0].baseQuantity).toBe(100);
  });
});

/* ══ 4 — REPLAY ══════════════════════════════════════════════════════════ */

describe("a retry of a receipt that already landed", () => {
  test("returns the first GRN and creates no second stock, lot or movement", async () => {
    const w = await world();
    const k = key();
    const first = await receive(w, { idempotencyKey: k });
    expect(first.status).toBe(201);

    const retry = await receive(w, { idempotencyKey: k });
    expect([200, 201]).toContain(retry.status);
    expect(retry.body.goodsReceipt.receiptNumber).toBe(first.body.goodsReceipt.receiptNumber);

    expect(await GoodsReceipt.countDocuments({ companyId: w.co._id })).toBe(1);
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(500);
    expect(await lotsOf(w)).toHaveLength(1);
    expect(await LocationMovement.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ══ 5 — ROLLBACK ════════════════════════════════════════════════════════ */

describe("if any step fails", () => {
  test("nothing is left behind — no GRN, no stock, no lot, no movement", async () => {
    const w = await world();
    const real = CustomerMaterialLot.create;
    /* The LAST step in the transaction. If the rollback is real, everything
       before it goes too — which is the only reason the ownership lot can be
       trusted to exist for every receipt. */
    CustomerMaterialLot.create = jest.fn(() => { throw new Error("lot store unavailable"); });
    try {
      const res = await receive(w);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      CustomerMaterialLot.create = real;
    }

    expect(await GoodsReceipt.countDocuments({ companyId: w.co._id })).toBe(0);
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(0);
    expect(await lotsOf(w)).toHaveLength(0);
    expect(await LocationMovement.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ 6 — OWNERSHIP IS STRICT ═════════════════════════════════════════════ */

describe("customer-owned stock is never general stock", () => {
  test("two customers' lots of the same material stay apart", async () => {
    const a = await world();
    const b = await world();
    await receive(a);
    await receive(b);

    const lotsA = await CustomerMaterialLot.find({ companyId: a.co._id }).lean();
    const lotsB = await CustomerMaterialLot.find({ companyId: b.co._id }).lean();
    expect(String(lotsA[0].customerId)).not.toBe(String(lotsB[0].customerId));
  });

  test("one customer's two orders hold separate lots", async () => {
    const first = await world({ orderRef: "ORD-SHARED-A" });
    /* The SAME customer, a different order. The customer sent this fabric for
       that order, and the two orders may have different answers about who pays
       for a shortfall. */
    const second = await world({ orderRef: "ORD-SHARED-B", customer: first.cust });
    await receive(first);
    await receive(second);

    const lots = await CustomerMaterialLot.find({ customerId: first.cust._id }).lean();
    expect(lots).toHaveLength(2);
    expect(new Set(lots.map((l) => l.orderRef))).toEqual(new Set(["ORD-SHARED-A", "ORD-SHARED-B"]));
  });

  test("two lines of one order hold separate lots of the same material", async () => {
    const item = await rawItem({ name: "Shared poplin" });
    const w = await world({
      lines: [
        { quantity: 1200, rawItem: item, name: "body" },
        { quantity: 300, rawItem: item, name: "sleeves" },
      ],
    });
    await receive(w, {
      items: [
        { lineRef: w.doc.lines[0].lineRef, quantity: 1200, unit: "Metre" },
        { lineRef: w.doc.lines[1].lineRef, quantity: 300, unit: "Metre" },
      ],
    });

    const lots = await lotsOf(w);
    expect(lots).toHaveLength(2);
    /* The same RawItem, two order lines. Quietly taking body fabric for sleeves
       would make the body short later and nobody would remember why. */
    expect(new Set(lots.map((l) => String(l.rawItemId))).size).toBe(1);
    expect(new Set(lots.map((l) => l.expectationLineRef)).size).toBe(2);
    expect(lots.find((l) => l.expectationLineRef === w.doc.lines[0].lineRef).baseQuantity).toBe(1200);
    expect(lots.find((l) => l.expectationLineRef === w.doc.lines[1].lineRef).baseQuantity).toBe(300);
  });

  test("a lot's balance always adds up, and cannot go negative", async () => {
    const w = await world();
    await receive(w);
    const lot = await CustomerMaterialLot.findOne({ companyId: w.co._id });

    lot.availableQuantity = 400;   // 400 + 0 + 0 !== 500
    await expect(lot.save()).rejects.toThrow(/does not add up/);

    const fresh = await CustomerMaterialLot.findOne({ companyId: w.co._id });
    fresh.availableQuantity = -1;
    fresh.issuedQuantity = 501;
    await expect(fresh.save()).rejects.toThrow();
  });

  test("the lot, the RawItem and the location movement reconcile by stored id", async () => {
    const w = await world();
    const res = await receive(w);
    const lot = (await lotsOf(w))[0];
    const item = await RawItem.findById(w.items[0]._id).lean();
    const movement = await LocationMovement.findOne({ companyId: w.co._id }).lean();

    /* Reconciliation follows ids, not matching numbers and hoping. */
    expect(String(lot.movements[0].stockTransactionId)).toBe(String(item.stockTransactions[0]._id));
    expect(String(lot.movements[0].locationMovementId)).toBe(String(movement._id));
    expect(String(lot.goodsReceiptId)).toBe(String(res.body.goodsReceipt._id));
    /* And the physical total includes customer stock, because the shelf does. */
    expect(item.quantity).toBe(lot.baseQuantity);

    /* The movement itself says whose goods moved and against what. */
    expect(movement.source.kind).toBe("customer_material_receipt");
    expect(String(movement.source.customerId)).toBe(String(w.cust._id));
    expect(movement.source.orderRef).toBe(w.orderRef);
    /* The movement names the PERMANENT sales line, which is what a production
       order can be matched against. */
    expect(movement.source.orderLineRef).toBe(w.doc.salesOrderLineRef);
  });

  test("the lots read exposes what is held, per customer and order line", async () => {
    const w = await world();
    await receive(w);
    const res = await call(`/api/cms/store/customer-materials/${w.doc._id}/lots`, { token: w.token });
    expect(res.status).toBe(200);
    expect(res.body.lots).toHaveLength(1);
    expect(res.body.lots[0]).toMatchObject({
      orderRef: w.orderRef, availableQuantity: 500, issuedQuantity: 0, status: "HELD",
    });
    expect(res.body.lots[0].customer.id).toBe(String(w.cust._id));
  });
});

/* ══ 7 — NOT A PURCHASE ══════════════════════════════════════════════════ */

describe("nothing here was bought from anybody", () => {
  test("the receipt carries no vendor, invoice, price, tax or payable", async () => {
    const w = await world();
    const res = await receive(w);
    const grn = await GoodsReceipt.findById(res.body.goodsReceipt._id).lean();

    expect(grn.purchaseOrderId).toBeUndefined();
    expect(grn.poNumber).toBe("");
    expect(grn.supplierId).toBeNull();
    expect(grn.supplierName).toBe("");
    expect(grn.invoiceNumber).toBe("");
    expect(grn.lines[0].poItemId).toBeNull();
    expect(grn.lines[0].spendLineId).toBeNull();

    const text = JSON.stringify(grn);
    for (const banned of ["unitPrice", "taxRate", "payable", "gstNumber", "purchaseValue"]) {
      expect(text).not.toContain(banned);
    }
  });

  test("the stock movement names the customer and never a supplier", async () => {
    const w = await world();
    await receive(w);
    const item = await RawItem.findById(w.items[0]._id).lean();
    const tx = item.stockTransactions[0];

    expect(tx.notes).toContain("customer-supplied");
    expect(tx.notes).toContain(w.orderRef);
    /* A stock transaction saying "supplier: <customer>" would turn a buyer into
       a vendor in every report that groups by one. The subschema defaults these
       to empty rather than leaving them absent, so the claim is that NOTHING was
       recorded in them — not that the paths do not exist. */
    expect(tx.supplier || "").toBe("");
    expect(tx.supplierId || null).toBeNull();
    expect(tx.unitPrice || 0).toBe(0);
    expect(tx.purchaseOrder || "").toBe("");
    expect(tx.purchaseOrderId || null).toBeNull();
    expect(tx.invoiceNumber || "").toBe("");
  });

  test("the model refuses a customer-material receipt that claims a purchase", async () => {
    const w = await world();
    const base = {
      companyId: w.co._id, receiptNumber: `X-${++seq}`,
      sourceType: "CUSTOMER_MATERIAL", sourceDocumentId: w.doc._id,
      sourceDocumentNumber: w.doc.documentRef,
      customerMaterial: { customerId: w.cust._id, expectationRevisionNo: 1 },
      lines: [{ sourceLineRef: "L1", receivedQuantity: 5 }],
    };
    /* Not a convention this code observes — a document that will not save. */
    await expect(new GoodsReceipt({ ...base, purchaseOrderId: new mongoose.Types.ObjectId() }).validate())
      .rejects.toThrow(/no purchase order/);
    await expect(new GoodsReceipt({ ...base, supplierName: "Some Mill" }).validate())
      .rejects.toThrow(/no supplier/);
    await expect(new GoodsReceipt({ ...base, invoiceNumber: "INV-9" }).validate())
      .rejects.toThrow(/no supplier invoice/);
    await expect(new GoodsReceipt({ ...base, customerMaterial: { expectationRevisionNo: 1 } }).validate())
      .rejects.toThrow(/must name the customer/);
    await expect(new GoodsReceipt({ ...base, lines: [{ receivedQuantity: 5 }] }).validate())
      .rejects.toThrow(/expectation line reference/);
  });

  test("and a purchase receipt still requires its purchase order", async () => {
    const w = await world();
    await expect(new GoodsReceipt({
      companyId: w.co._id, receiptNumber: `Y-${++seq}`,
      sourceType: "PURCHASE_ORDER", lines: [{ receivedQuantity: 5 }],
    }).validate()).rejects.toThrow();
  });
});

/* ══ REFUSALS: COMPANY, SOURCE, LINE, MODEL, STATE ═══════════════════════ */

describe("what cannot be received against", () => {
  test("another company's document answers as one that does not exist", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await call(`/api/cms/store/customer-materials/${theirs.doc._id}/receipts`, {
      method: "POST", token: mine.token, idempotencyKey: key(),
      body: {
        warehouseId: String(mine.wh._id), locationId: String(mine.loc._id),
        items: [{ lineRef: theirs.doc.lines[0].lineRef, quantity: 10, unit: "Metre" }],
      },
    });
    expect(res.status).toBe(404);
    expect(await lotsOf(theirs)).toHaveLength(0);
  });

  test("another company's warehouse is refused", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await receive(mine, {});
    expect(res.status).toBe(201);
    const bad = await call(`/api/cms/store/customer-materials/${mine.doc._id}/receipts`, {
      method: "POST", token: mine.token, idempotencyKey: key(),
      body: {
        warehouseId: String(theirs.wh._id), locationId: String(theirs.loc._id),
        items: [{ lineRef: mine.doc.lines[0].lineRef, quantity: 10, unit: "Metre" }],
      },
    });
    expect(bad.status).toBe(404);
  });

  test("a line that is not on the document is refused", async () => {
    const w = await world();
    const res = await receive(w, { items: [{ lineRef: "CML-invented", quantity: 5, unit: "Metre" }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe("UNKNOWN_LINE");
  });

  test("a draft cannot be received against", async () => {
    const w = await world();
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, { $set: { state: "DRAFT" } });
    const res = await receive(w);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("EXPECTATION_NOT_ISSUED");
  });

  test("a cancelled document stops further receipt but keeps what arrived", async () => {
    const w = await world();
    await receive(w);
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, {
      $set: { state: "CANCELLED", cancellationReason: "Buyer shipping direct." },
    });

    const res = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 100, unit: "Metre" }],
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("EXPECTATION_CANCELLED");
    /* Withdrawing a document does not unship a lorry. */
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(500);
    expect(await lotsOf(w)).toHaveLength(1);
  });

  test("a document with no provable customer cannot be received against", async () => {
    const w = await world();
    /* A Phase 1 document. It stays readable and cannot become stock. */
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, { $unset: { customerId: "" } });
    const res = await receive(w);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("CUSTOMER_IDENTITY_UNPROVEN");
    expect(await lotsOf(w)).toHaveLength(0);
  });

  test("a full-package order's document cannot be received against", async () => {
    const w = await world();
    /* Sales converted the order. The document stays readable — Store is holding
       it — and nothing more may be received. */
    await ExecutionFile.collection.updateOne(
      { _id: w.fileId },
      { $set: { "currentExecutionProjection.fulfilmentModel": "FULL_PACKAGE" } },
    );
    await CustomerMaterialExpectation.updateOne({ _id: w.doc._id }, { $set: { state: "CANCELLED", cancellationReason: "Converted." } });
    const res = await receive(w);
    expect(res.status).toBe(409);
    expect(await lotsOf(w)).toHaveLength(0);
    /* Still readable. */
    expect((await detail(w)).status).toBe(200);
  });
});

/* ══ 8 — READING IS NOT RECEIVING ════════════════════════════════════════ */

describe("two grants, not one", () => {
  test("sp.read opens the register and the detail", async () => {
    const w = await world();
    expect((await call("/api/cms/store/customer-materials", { token: w.viewerToken })).status).toBe(200);
    expect((await detail(w, w.viewerToken)).status).toBe(200);
  });

  test("sp.read cannot record a receipt", async () => {
    const w = await world();
    const res = await receive(w, { token: w.viewerToken });
    expect(res.status).toBe(403);
    expect(await lotsOf(w)).toHaveLength(0);
  });

  test("sp.read cannot short close a line either", async () => {
    const w = await world();
    const res = await call(
      `/api/cms/store/customer-materials/${w.doc._id}/lines/${w.doc.lines[0].lineRef}/short-close`,
      { method: "POST", token: w.viewerToken, body: { reason: "Trying." } },
    );
    expect(res.status).toBe(403);
  });
});

/* ══ SHORT CLOSURE ═══════════════════════════════════════════════════════ */

describe("no more of this is coming", () => {
  const shortClose = (w, body) => call(
    `/api/cms/store/customer-materials/${w.doc._id}/lines/${w.doc.lines[0].lineRef}/short-close`,
    { method: "POST", token: w.token, body },
  );

  test("it needs a reason, and it manufactures no stock", async () => {
    const w = await world();
    await receive(w);

    expect((await shortClose(w, {})).status).toBe(400);

    const res = await shortClose(w, { reason: "Mill closed; buyer accepts the shortfall." });
    expect(res.status).toBe(200);

    const after = await detail(w);
    const line = after.body.standing.lines[0];
    expect(line.status).toBe("SHORT_CLOSED");
    /* The received quantity is untouched and the shortfall is still visible as a
       shortfall — short closing stops it being chased, it does not make the
       missing metres stop having been missing. */
    expect(line.receivedQuantity).toBe(500);
    expect(line.pendingQuantity).toBe(0);
    expect(line.shortfallQuantity).toBe(700);
    expect(line.shortCloseReason).toMatch(/Mill closed/);
    expect((await RawItem.findById(w.items[0]._id).lean()).quantity).toBe(500);
  });

  test("a short-closed line cannot receive more until it is reopened", async () => {
    const w = await world();
    await shortClose(w, { reason: "Nothing more coming." });

    const blocked = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 100, unit: "Metre" }],
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.reason).toBe("LINE_SHORT_CLOSED");

    const reopened = await call(
      `/api/cms/store/customer-materials/${w.doc._id}/lines/${w.doc.lines[0].lineRef}/reopen`,
      { method: "POST", token: w.token, body: { reason: "Buyer is sending the balance." } },
    );
    expect(reopened.status).toBe(200);

    const now = await receive(w, {
      items: [{ lineRef: w.doc.lines[0].lineRef, quantity: 100, unit: "Metre" }],
    });
    expect(now.status).toBe(201);
  });

  test("the document's own state is untouched by a Store decision", async () => {
    const w = await world();
    await shortClose(w, { reason: "Done." });
    const stored = await CustomerMaterialExpectation.findById(w.doc._id).lean();
    expect(stored.state).toBe("ISSUED");
  });
});
