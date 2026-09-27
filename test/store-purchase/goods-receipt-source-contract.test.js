// test/store-purchase/goods-receipt-source-contract.test.js
//
// ONE RECEIPT RECORD, TWO KINDS OF ARRIVAL — AND THE OLD KIND IS UNCHANGED.
//
// A goods receipt used to discharge exactly one thing: a Purchase Order. It now
// discharges either that or a customer-supplied material expectation, and it
// says which. The risk in a change like that is entirely on the OLD path: a
// shared implementation is precisely where a regression hides, and a purchase
// receipt that quietly started behaving differently would not announce itself.
//
// So this suite is about the contract and the compatibility:
//
//   1  A PURCHASE RECEIPT STILL REQUIRES ITS PURCHASE ORDER. The `required`
//      that used to stand unconditionally on `purchaseOrderId` and `poItemId`
//      got weaker; the document did not. What replaced it refuses every invalid
//      combination.
//
//   2  ONE RECEIPT NAMES ONE SOURCE. It cannot mix kinds, and it cannot span two
//      documents of the same kind.
//
//   3  AN EXISTING RECEIPT READS AS WHAT IT IS. `sourceType` defaults to
//      PURCHASE_ORDER, so every row written before the field existed is correct
//      without being touched.
//
//   4  THE MIGRATION FILLS THE GENERIC JOIN and nothing else — it is rerunnable,
//      it invents no source, and it writes nothing without `--apply`.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const migration = require("../../scripts/migrations/goods-receipt-source-contract");

let seq = 0;
const oid = () => new mongoose.Types.ObjectId();
const dry = (o) => migration.run({ ...o, jsonPath: null });
const apply = (o) => migration.run({ ...o, apply: true, jsonPath: null });

const purchase = (over = {}) => ({
  companyId: over.companyId || oid(),
  receiptNumber: `GRN/P/${String(++seq).padStart(4, "0")}`,
  sourceType: "PURCHASE_ORDER",
  purchaseOrderId: over.purchaseOrderId || oid(),
  poNumber: over.poNumber || `PO-${seq}`,
  status: "RECORDED",
  lines: over.lines || [{ poItemId: oid(), receivedQuantity: 5, poUnit: "pcs" }],
  ...over.extra,
});

const customer = (over = {}) => ({
  companyId: over.companyId || oid(),
  receiptNumber: `GRN/C/${String(++seq).padStart(4, "0")}`,
  sourceType: "CUSTOMER_MATERIAL",
  sourceDocumentId: over.sourceDocumentId || oid(),
  sourceDocumentNumber: over.sourceDocumentNumber || `CSM-${seq}`,
  status: "RECORDED",
  customerMaterial: {
    customerId: over.customerId || oid(),
    /* `??` and not `||`: a test passing an explicit null is asking for the
       field to be ABSENT, and `||` would helpfully default it to 1 and make the
       test pass for the wrong reason. */
    expectationRevisionNo: over.revisionNo === undefined ? 1 : over.revisionNo,
  },
  lines: over.lines || [{ sourceLineRef: `CML-${seq}`, receivedQuantity: 5, poUnit: "Metre" }],
  ...over.extra,
});

/* ══ 1 — THE PURCHASE PATH IS UNCHANGED ══════════════════════════════════ */

describe("a purchase receipt still requires everything it always did", () => {
  test("it saves, and back-fills its own generic source join", async () => {
    const poId = oid();
    const g = new GoodsReceipt(purchase({ purchaseOrderId: poId, poNumber: "PO-77" }));
    await g.validate();
    /* The generic join is derived from the purchase order rather than demanded
       of every existing caller — which is why no call site had to change. */
    expect(String(g.sourceDocumentId)).toBe(String(poId));
    expect(g.sourceDocumentNumber).toBe("PO-77");
  });

  test("without a purchase order it is refused", async () => {
    const g = new GoodsReceipt({ ...purchase(), purchaseOrderId: undefined, poNumber: "" });
    await expect(g.validate()).rejects.toThrow(/source document|purchaseOrderId/i);
  });

  test("without a purchase-order line it is refused", async () => {
    const g = new GoodsReceipt(purchase({ lines: [{ receivedQuantity: 5 }] }));
    await expect(g.validate()).rejects.toThrow(/must name its purchase-order line/);
  });

  test("its source document cannot be some other order", async () => {
    const g = new GoodsReceipt(purchase());
    g.sourceDocumentId = oid();
    await expect(g.validate()).rejects.toThrow(/must be its purchase order/);
  });

  test("an existing receipt with no sourceType reads as a purchase receipt", async () => {
    const co = oid();
    await GoodsReceipt.collection.insertOne({
      companyId: co, receiptNumber: `GRN/LEGACY/${++seq}`,
      purchaseOrderId: oid(), poNumber: "PO-OLD", status: "RECORDED",
      lines: [{ poItemId: oid(), receivedQuantity: 3 }],
    });
    const read = await GoodsReceipt.findOne({ companyId: co }).lean();
    /* Not stored on the row, but the schema default makes every reader see the
       truth: there was no other kind of receipt when it was written. */
    const hydrated = GoodsReceipt.hydrate(read);
    expect(hydrated.sourceType).toBe("PURCHASE_ORDER");
  });
});

/* ══ 2 — ONE RECEIPT, ONE SOURCE ═════════════════════════════════════════ */

describe("a receipt cannot mix sources", () => {
  test("a customer-material receipt carrying purchase-order lines is refused", async () => {
    const g = new GoodsReceipt(customer({
      lines: [{ sourceLineRef: "CML-1", poItemId: oid(), receivedQuantity: 5 }],
    }));
    await expect(g.validate()).rejects.toThrow(/no purchase-order or spend line/);
  });

  test("a customer-material receipt naming a purchase order is refused", async () => {
    const g = new GoodsReceipt(customer({ extra: { purchaseOrderId: oid() } }));
    await expect(g.validate()).rejects.toThrow(/no purchase order/);
  });

  test("a customer-material receipt must name its revision", async () => {
    const g = new GoodsReceipt(customer({ revisionNo: null }));
    await expect(g.validate()).rejects.toThrow(/expectation revision/);
  });

  test("a valid customer-material receipt saves", async () => {
    const g = new GoodsReceipt(customer());
    await expect(g.validate()).resolves.toBeUndefined();
  });

  test("every receipt must name a source document", async () => {
    const g = new GoodsReceipt({
      companyId: oid(), receiptNumber: `GRN/X/${++seq}`,
      sourceType: "CUSTOMER_MATERIAL", status: "RECORDED", lines: [],
    });
    await expect(g.validate()).rejects.toThrow(/must name the source document/);
  });
});

/* ══ 3 & 4 — THE MIGRATION ═══════════════════════════════════════════════ */

describe("the source-contract migration", () => {
  test("it fills the generic join on existing purchase receipts", async () => {
    const co = oid();
    const poId = oid();
    const poItem = oid();
    await GoodsReceipt.collection.insertOne({
      companyId: co, receiptNumber: `GRN/M/${++seq}`,
      purchaseOrderId: poId, poNumber: "PO-M1", status: "RECORDED",
      lines: [{ _id: oid(), poItemId: poItem, receivedQuantity: 7 }],
    });

    const before = await dry({ companyId: String(co) });
    expect(before.report.before.wouldStamp).toBe(1);
    expect(before.report.before.lineFills).toBe(1);
    expect(before.text).toMatch(/DRY RUN — nothing written/);
    /* Nothing written by a dry run. */
    let row = await GoodsReceipt.collection.findOne({ companyId: co });
    expect(row.sourceDocumentId).toBeUndefined();

    const out = await apply({ companyId: String(co) });
    expect(out.report.result.headers).toBe(1);
    expect(out.report.result.lines).toBe(1);

    row = await GoodsReceipt.collection.findOne({ companyId: co });
    expect(row.sourceType).toBe("PURCHASE_ORDER");
    expect(String(row.sourceDocumentId)).toBe(String(poId));
    expect(row.sourceDocumentNumber).toBe("PO-M1");
    expect(String(row.lines[0].sourceLineId)).toBe(String(poItem));
    /* And it changed nothing else. */
    expect(row.lines[0].receivedQuantity).toBe(7);
    expect(String(row.purchaseOrderId)).toBe(String(poId));
  });

  test("it is rerunnable", async () => {
    const co = oid();
    await GoodsReceipt.collection.insertOne({
      companyId: co, receiptNumber: `GRN/M/${++seq}`,
      purchaseOrderId: oid(), poNumber: "PO-M2", status: "RECORDED",
      lines: [{ _id: oid(), poItemId: oid(), receivedQuantity: 1 }],
    });
    await apply({ companyId: String(co) });
    const second = await apply({ companyId: String(co) });
    expect(second.report.before.wouldStamp).toBe(0);
    expect(second.report.result.headers).toBe(0);
  });

  test("it invents no source for a receipt that names no order", async () => {
    const co = oid();
    await GoodsReceipt.collection.insertOne({
      companyId: co, receiptNumber: `GRN/M/${++seq}`, status: "RECORDED", lines: [],
    });
    const out = await apply({ companyId: String(co) });
    expect(out.report.before.unexplained).toHaveLength(1);
    expect(out.report.result.headers).toBe(0);
    expect(out.text).toMatch(/CANNOT BE EXPLAINED/);
    /* A receipt that cannot say what it discharges is a data problem for a
       person, not a formatting one for a script. */
    const row = await GoodsReceipt.collection.findOne({ companyId: co });
    expect(row.sourceDocumentId).toBeUndefined();
  });

  test("it leaves a customer-material receipt alone", async () => {
    const co = oid();
    await new GoodsReceipt(customer({ companyId: co })).save();
    const out = await apply({ companyId: String(co) });
    expect(out.report.before.wouldStamp).toBe(0);
  });

  test("it builds the two indexes that the schema deliberately does not", async () => {
    const out = await apply({});
    const names = (await GoodsReceipt.collection.indexes()).map((i) => i.name);
    for (const spec of migration.INDEXES) expect(names).toContain(spec.name);
    expect(out.report.result.indexes).toBeGreaterThanOrEqual(0);
  });

  test("--company-id touches only that company", async () => {
    const mine = oid();
    const theirs = oid();
    for (const co of [mine, theirs]) {
      await GoodsReceipt.collection.insertOne({
        companyId: co, receiptNumber: `GRN/M/${++seq}`,
        purchaseOrderId: oid(), poNumber: "PO-S", status: "RECORDED",
        lines: [{ _id: oid(), poItemId: oid(), receivedQuantity: 1 }],
      });
    }
    await apply({ companyId: String(mine) });
    expect((await GoodsReceipt.collection.findOne({ companyId: mine })).sourceDocumentId).toBeTruthy();
    expect((await GoodsReceipt.collection.findOne({ companyId: theirs })).sourceDocumentId).toBeUndefined();
  });
});
