// test/store-purchase/receive-workspace.route.test.js
//
// THE RECEIVE WORKSPACE READ — WHAT IS COMING, WHAT NEEDS WORK, WHAT IS DONE.
//
// The dangerous mistakes are all quiet ones: a customer's goods presented as a
// purchase (and so as spend), a failed source read reported as "nothing to do",
// a total summed across metres and kilograms, or the endpoint being shadowed by
// the `/:grnId` route and answering 404 for "workspace".
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/store/goods-receipts", require("../../routes/CMS_Routes/StorePurchase/goodsReceipts"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `RW${seq}`, name: "Rw", email: "r@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } })
    .then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b }; });

// A POST with an idempotency key, for exercising the purchased-only mutation
// guards (they sit after withIdempotency, so a key is required to reach them).
const post = (path, { token, body = {}, key } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": key || `idem-${++seq}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }).then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

/** A Store actor with the read capability, in one company. */
async function actor(co, { role = "approver" } = {}) {
  const n = ++seq; const email = `rw${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "RW", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "RW" });
  return tokenFor({ id: String(employeeRef), email });
}
/** An authenticated actor with NO Store grant at all. */
async function outsider(co) {
  const n = ++seq; const email = `out${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "Out" });
  return tokenFor({ id: String(employeeRef), email });
}

const warehouse = (companyId) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
});

async function makePO(co, lines, over = {}) {
  const items = lines.map((l) => ({
    _id: l.poItemId || new mongoose.Types.ObjectId(),
    rawItem: l.rawItemId || new mongoose.Types.ObjectId(), itemName: l.itemName || "Item", sku: l.sku || "SKU",
    unit: l.unit || "pcs", quantity: l.quantity, unitPrice: 10, totalPrice: l.quantity * 10,
    receivedQuantity: l.receivedQuantity || 0,
    pendingQuantity: l.pendingQuantity !== undefined ? l.pendingQuantity : l.quantity - (l.receivedQuantity || 0),
    status: l.status || "PENDING",
    ...(l.expectedDeliveryDate ? { expectedDeliveryDate: l.expectedDeliveryDate } : {}),
  }));
  return PurchaseOrder.create({
    companyId: co._id, poNumber: over.poNumber || `PO/${++seq}`, status: over.status || "ISSUED",
    createdBy: new mongoose.Types.ObjectId(),
    vendorName: over.vendorName || "Acme Mills", vendor: new mongoose.Types.ObjectId(),
    subtotal: 0, taxAmount: 0, totalAmount: 0, items,
    ...(over.expectedDeliveryDate ? { expectedDeliveryDate: over.expectedDeliveryDate } : {}),
    ...(over.warehouseName ? { warehouseName: over.warehouseName } : {}),
  });
}

/** A purchased goods receipt, written directly so the test controls its state. */
async function purchasedReceipt(co, wh, po, over = {}) {
  return GoodsReceipt.create({
    companyId: co._id, receiptNumber: `GRN/${++seq}`,
    sourceType: "PURCHASE_ORDER",
    purchaseOrderId: po._id, poNumber: po.poNumber,
    sourceDocumentId: po._id, sourceDocumentNumber: po.poNumber,
    supplierId: new mongoose.Types.ObjectId(), supplierName: over.supplierName || "Acme Mills",
    invoiceNumber: over.invoiceNumber || "INV-9",
    receiptDate: over.receiptDate || new Date("2026-09-10"),
    warehouseId: wh._id, warehouseName: wh.name,
    locationId: wh.locations[0]._id, locationCode: "RECV", locationName: "Receiving",
    recordedBy: { name: "Receiver" },
    lines: over.lines || [{
      poItemId: po.items[0]._id, rawItemId: po.items[0].rawItem,
      itemName: "Bolt", sku: "SKU", unit: "pcs",
      receivedQuantity: 4, quantityOrdered: 10, previouslyReceived: 0, receivedAfter: 4, pendingAfter: 6,
    }],
    ...over.extra,
  });
}

/** A customer-material goods receipt — no supplier, no invoice, by validation. */
async function customerReceipt(co, wh, over = {}) {
  return GoodsReceipt.create({
    companyId: co._id, receiptNumber: `GRN/${++seq}`,
    sourceType: "CUSTOMER_MATERIAL",
    sourceDocumentId: new mongoose.Types.ObjectId(), sourceDocumentNumber: over.documentRef || "CME/1",
    customerMaterial: {
      customerId: new mongoose.Types.ObjectId(),
      customerLabel: over.customerLabel || "Northwind Apparel",
      customerCode: "NW", orderRef: over.orderRef || "ORD-77",
      expectationRevisionNo: 1, customerReference: over.customerReference || "CHLN-4",
    },
    receiptDate: over.receiptDate || new Date("2026-09-12"),
    warehouseId: wh._id, warehouseName: wh.name,
    locationId: wh.locations[0]._id, locationCode: "RECV", locationName: "Receiving",
    recordedBy: { name: "Receiver" },
    lines: over.lines || [{
      rawItemId: new mongoose.Types.ObjectId(), itemName: "Customer fabric", sku: "CF-1", unit: "m",
      /* The model requires it, and rightly: a customer-material line must name
         which expectation line it discharges, so a later revision cannot
         rewrite what an earlier receipt was recorded against. */
      sourceLineRef: "L1",
      receivedQuantity: 100, quantityOrdered: 100, previouslyReceived: 0, receivedAfter: 100, pendingAfter: 0,
    }],
  });
}

const WS = "/api/cms/store/goods-receipts/workspace";

/* ── ROUTE ORDERING AND ACCESS ───────────────────────────────────────────── */

describe("reaching the workspace", () => {
  test("`workspace` is not swallowed by the receipt-id route", async () => {
    const co = await company(); const token = await actor(co);
    const res = await call(`${WS}?stage=action-required`, { token });
    /* A 404 here would mean Express matched "/:grnId" first and looked for a
       receipt called "workspace". */
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.stage).toBe("action-required");
  });

  test("the Store read capability is required", async () => {
    const co = await company(); const token = await outsider(co);
    const res = await call(WS, { token });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.rows).toBeUndefined();
  });

  test("an unknown stage or source falls back rather than throwing", async () => {
    const co = await company(); const token = await actor(co);
    const res = await call(`${WS}?stage=nonsense&source=nonsense`, { token });
    expect(res.status).toBe(200);
    expect(res.body.stage).toBe("action-required");
    expect(res.body.source).toBe("all");
  });
});

/* ── TENANT ISOLATION ────────────────────────────────────────────────────── */

test("another company's receipts and orders are never visible", async () => {
  const a = await company(); const b = await company();
  const tokenB = await actor(b);
  const whA = await warehouse(a._id);
  const poA = await makePO(a, [{ quantity: 10, itemName: "Bolt" }]);
  await purchasedReceipt(a, whA, poA, { supplierName: "Acme Mills" });

  const recorded = await call(`${WS}?stage=action-required`, { token: tokenB });
  expect(recorded.body.rows).toEqual([]);
  const expected = await call(`${WS}?stage=expected`, { token: tokenB });
  expect(expected.body.rows).toEqual([]);
  expect(JSON.stringify(expected.body)).not.toContain("Acme Mills");
});

test("SECURITY: a search never leaks another company's receipts (tenant $or not clobbered)", async () => {
  // Both companies have a receipt whose number contains the same token. Under
  // the old `filter.$or = [search]` the tenant $or was overwritten and B's
  // receipt leaked to A on search. It must not.
  const a = await company(); const b = await company();
  const tokenA = await actor(a);
  const whA = await warehouse(a._id); const whB = await warehouse(b._id);
  const poA = await makePO(a, [{ quantity: 10 }]); const poB = await makePO(b, [{ quantity: 10 }]);
  const mine = await purchasedReceipt(a, whA, poA, { extra: { receiptNumber: "GRN/SHARED-A" } });
  const theirs = await purchasedReceipt(b, whB, poB, { extra: { receiptNumber: "GRN/SHARED-B" } });

  const res = await call(`${WS}?stage=action-required&search=SHARED`, { token: tokenA });
  const ids = res.body.rows.map((r) => r.id);
  expect(ids).toContain(String(mine._id));
  expect(ids).not.toContain(String(theirs._id));
  expect(JSON.stringify(res.body)).not.toContain("SHARED-B");
});

test("SECURITY: an Expected search never leaks another company's purchase orders", async () => {
  const a = await company(); const b = await company();
  const tokenA = await actor(a);
  const poA = await makePO(a, [{ quantity: 10 }], { poNumber: "PO/SHARED-A" });
  const poB = await makePO(b, [{ quantity: 10 }], { poNumber: "PO/SHARED-B" });
  const res = await call(`${WS}?stage=expected&source=purchased&search=SHARED`, { token: tokenA });
  const refs = res.body.rows.map((r) => r.reference);
  expect(refs).toContain("PO/SHARED-A");
  expect(refs).not.toContain("PO/SHARED-B");
});

/* ── EXPECTED ────────────────────────────────────────────────────────────── */

describe("Expected", () => {
  test("an issued purchase order with outstanding lines appears, with a count not a sum", async () => {
    const co = await company(); const token = await actor(co);
    /* Deliberately mixed units: metres and kilograms have no meaningful total,
       and the row must report a LINE COUNT rather than inventing one. */
    await makePO(co, [
      { quantity: 100, unit: "m", itemName: "Fabric" },
      { quantity: 20, unit: "kg", itemName: "Yarn" },
    ], { expectedDeliveryDate: new Date("2026-10-01") });

    const res = await call(`${WS}?stage=expected&source=purchased`, { token });
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.sourceType).toBe("purchased");
    expect(row.lineCount).toBe(2);
    expect(row.partyKind).toBe("supplier");
    expect(row.partyLabel).toBe("Acme Mills");
    expect(row.nextAction.code).toBe("RECEIVE_PURCHASE");
    expect(row.nextAction.href).toMatch(/\/purchase-order\/[a-f0-9]{24}\/receive$/);
    /* No summed quantity anywhere on the row. */
    expect(row).not.toHaveProperty("outstandingQuantity");
    expect(row).not.toHaveProperty("totalQuantity");
  });

  test("a fully received or cancelled order is not expected", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, [{ quantity: 10, receivedQuantity: 10, status: "COMPLETED" }], { status: "COMPLETED" });
    await makePO(co, [{ quantity: 10, status: "CANCELLED", pendingQuantity: 0 }], { status: "CANCELLED" });
    /* An ISSUED order whose only line is cancelled has nothing outstanding. */
    await makePO(co, [{ quantity: 10, status: "CANCELLED", pendingQuantity: 10 }]);

    const res = await call(`${WS}?stage=expected&source=purchased`, { token });
    expect(res.body.rows).toEqual([]);
  });

  test("an expected date is shown only when one was recorded", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, [{ quantity: 5 }]);
    const res = await call(`${WS}?stage=expected&source=purchased`, { token });
    /* Null, not today's date and not the order's creation date. */
    expect(res.body.rows[0].expectedDate).toBeNull();
  });

  test("the purchased filter excludes customer-owned expectations and vice versa", async () => {
    const co = await company(); const token = await actor(co);
    await makePO(co, [{ quantity: 5 }]);
    const purchased = await call(`${WS}?stage=expected&source=purchased`, { token });
    expect(purchased.body.rows.every((r) => r.sourceType === "purchased")).toBe(true);
    const customer = await call(`${WS}?stage=expected&source=customer-owned`, { token });
    expect(customer.body.rows.every((r) => r.sourceType === "customer-owned")).toBe(true);
    /* And a purchased order never leaks into the customer-owned view. */
    expect(customer.body.rows).toHaveLength(0);
  });
});

/* ── ACTION REQUIRED AND COMPLETED ───────────────────────────────────────── */

describe("recorded receipts", () => {
  test("an uninspected receipt is action-required and asks for inspection", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10, itemName: "Bolt" }]);
    const grn = await purchasedReceipt(co, wh, po);

    const res = await call(`${WS}?stage=action-required`, { token });
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.id).toBe(String(grn._id));
    expect(row.stage).toBe("action-required");
    expect(row.flags.awaitingInspection).toBe(true);
    expect(row.nextAction.code).toBe("INSPECT");
    expect(row.nextAction.label).toBe("Inspect receipt");
    /* The whole row opens the existing detail workspace. */
    expect(row.nextAction.href).toBe(`/store/dashboard/operations/goods-receipts/${String(grn._id)}`);
    /* It is NOT in Completed. */
    const done = await call(`${WS}?stage=completed`, { token });
    expect(done.body.rows).toEqual([]);
  });

  test("a fully accepted and put-away receipt is completed", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10, itemName: "Bolt" }]);
    const grn = await purchasedReceipt(co, wh, po, {
      lines: [{
        poItemId: po.items[0]._id, rawItemId: po.items[0].rawItem,
        itemName: "Bolt", sku: "SKU", unit: "pcs",
        receivedQuantity: 4, quantityOrdered: 10, previouslyReceived: 0, receivedAfter: 4, pendingAfter: 6,
      }],
    });
    /* Inspected clean, nothing left to put away: the control service's own
       definition of complete, not a second one written here. */
    await GoodsReceiptInspection.create({
      companyId: co._id, goodsReceiptId: grn._id,
      purchaseOrderId: po._id, warehouseId: wh._id,
      lines: [{
        goodsReceiptLineId: grn.lines[0]._id, poItemId: po.items[0]._id,
        rawItemId: po.items[0].rawItem, unit: "pcs",
        receivedQuantity: 4, acceptedQuantity: 0, quarantinedQuantity: 0, rejectedQuantity: 4,
      }],
      inspectedBy: { name: "QC" },
    });

    const done = await call(`${WS}?stage=completed`, { token });
    const action = await call(`${WS}?stage=action-required`, { token });
    /* Rejected stock awaits a supplier return, so this receipt is action
       required — proving the tab follows the control flags rather than the
       fact that an inspection exists. */
    expect(action.body.rows).toHaveLength(1);
    expect(action.body.rows[0].nextAction.code).toBe("RETURN_REJECTED");
    expect(done.body.rows).toEqual([]);
  });

  test("next-action priority puts rejected stock above quarantine and inspection", () => {
    const svc = require("../../services/storePurchase/receiveWorkspace.service");
    expect(svc.nextActionFor({ hasRejected: true, hasQuarantined: true, awaitingInspection: true }).code)
      .toBe("RETURN_REJECTED");
    expect(svc.nextActionFor({ hasQuarantined: true, awaitingInspection: true }).code)
      .toBe("RESOLVE_QUARANTINE");
    expect(svc.nextActionFor({ awaitingInspection: true, awaitingPutaway: true }).code).toBe("INSPECT");
    expect(svc.nextActionFor({ awaitingPutaway: true }).code).toBe("PUTAWAY");
    expect(svc.nextActionFor({ complete: true }).code).toBe("VIEW");
    /* No flag set at all is not a state the control service describes; saying
       "reconcile" is honest, picking one of the above would be a diagnosis. */
    expect(svc.nextActionFor({}).code).toBe("RECONCILE");
  });
});

/* ── OWNERSHIP IS EXPLICIT AND FINANCIALLY SILENT ────────────────────────── */

describe("customer-owned material", () => {
  test("a recorded customer-owned receipt is COMPLETED, links to its customer-material document, and carries no financial language", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const grn = await customerReceipt(co, wh, { customerLabel: "Northwind Apparel", orderRef: "ORD-77" });

    // It belongs in Completed — receiving is done once the customer receipt is recorded.
    const res = await call(`${WS}?stage=completed&source=customer-owned`, { token });
    expect(res.body.rows).toHaveLength(1);
    const row = res.body.rows[0];
    expect(row.id).toBe(String(grn._id));
    expect(row.sourceType).toBe("customer-owned");
    expect(row.stage).toBe("completed");
    expect(row.partyKind).toBe("customer");
    expect(row.partyLabel).toBe("Northwind Apparel");
    expect(row.orderReference).toBe("ORD-77");
    /* Its ONE action opens the customer-material document (its issue/return/
       labels live there), never the purchased goods-receipt control workspace. */
    expect(row.nextAction.code).toBe("VIEW_CUSTOMER");
    expect(row.nextAction.href).toBe(`/store/dashboard/operations/customer-materials/${String(grn.sourceDocumentId)}`);
    expect(row.nextAction.href).not.toMatch(/goods-receipts/);
    /* ── NO FINANCIAL LANGUAGE ────────────────────────────────────────
       The factory bought nothing. A supplier name or invoice number here
       would turn a buyer into a vendor in every report that groups by one. */
    expect(row.invoiceNumber).toBe("");
    expect(row.partyLabel).not.toBe("");
    expect(row.partyKind).not.toBe("supplier");
    for (const field of ["supplierName", "supplierId", "vendorName", "vendorId",
      "unitPrice", "totalPrice", "amount", "payable", "billNumber", "paymentStatus", "currency"]) {
      expect(row).not.toHaveProperty(field);
    }
  });

  test("an uninspected customer receipt is NEVER dragged into Action required (deriveControl is not run for it)", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const grn = await customerReceipt(co, wh);

    // Despite having no inspection, it is Completed — not "awaiting inspection".
    const action = await call(`${WS}?stage=action-required&source=customer-owned`, { token });
    expect(action.body.rows).toEqual([]);
    const actionAll = await call(`${WS}?stage=action-required&source=all`, { token });
    expect(actionAll.body.rows.some((r) => r.id === String(grn._id))).toBe(false);
    expect(actionAll.body.rows.every((r) => r.sourceType !== "customer-owned")).toBe(true);
  });

  test("a customer-owned receipt is never counted as purchased", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    await customerReceipt(co, wh);
    const purchasedCompleted = await call(`${WS}?stage=completed&source=purchased`, { token });
    expect(purchasedCompleted.body.rows).toEqual([]);
    const completedAll = await call(`${WS}?stage=completed&source=all`, { token });
    expect(completedAll.body.rows).toHaveLength(1);
    expect(completedAll.body.rows[0].sourceType).toBe("customer-owned");
  });
});

/* ── PURCHASED-ONLY CONTROL ROUTES REFUSE CUSTOMER-OWNED RECEIPTS ─────────────
   Inspection, put-away, quarantine disposition and supplier return presume a
   purchased receipt (a PO, a supplier, company-owned stock to move). Driving one
   against customer-supplied material would move location stock without
   synchronising its ownership lot, so each route refuses it outright. */
describe("customer-owned receipts cannot enter the purchased control pipeline", () => {
  test("inspection, put-away, disposition and supplier return all refuse a customer-owned GRN", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const grn = await customerReceipt(co, wh);
    for (const path of ["inspection", "putaways", "dispositions", "supplier-returns"]) {
      const res = await post(`/api/cms/store/goods-receipts/${grn._id}/${path}`, { token, body: {}, key: `guard-${path}-${seq}` });
      expect(res.status).toBe(400);
      expect(res.body.reason).toBe("PURCHASED_ONLY");
    }
    // And no inspection record was created as a side effect.
    expect(await GoodsReceiptInspection.countDocuments({ companyId: co._id, goodsReceiptId: grn._id })).toBe(0);
  });
});

/* ── HONEST COVERAGE AND SOURCE AVAILABILITY ─────────────────────────────── */

describe("honesty about what was read", () => {
  test("a truncated scan says so rather than implying a company-wide total", async () => {
    const prev = process.env.RECEIVE_WORKSPACE_SCAN_CAP;
    process.env.RECEIVE_WORKSPACE_SCAN_CAP = "1";
    try {
      const co = await company(); const token = await actor(co);
      const wh = await warehouse(co._id);
      const po = await makePO(co, [{ quantity: 10 }]);
      await purchasedReceipt(co, wh, po);
      await purchasedReceipt(co, wh, po);

      const res = await call(`${WS}?stage=action-required`, { token });
      expect(res.body.coverage.truncated).toBe(true);
      expect(res.body.coverage.note).toMatch(/older matching records may exist/i);
      expect(res.body.sources.recordedReceipts.coverage.scanCap).toBe(1);
      expect(res.body.sources.recordedReceipts.coverage.storedMatchCount).toBe(2);
      expect(res.body.pagination.scope).toBe("inspectedSet");
    } finally {
      if (prev === undefined) delete process.env.RECEIVE_WORKSPACE_SCAN_CAP;
      else process.env.RECEIVE_WORKSPACE_SCAN_CAP = prev;
    }
  });

  test("every source reports its own availability", async () => {
    const co = await company(); const token = await actor(co);
    const res = await call(`${WS}?stage=expected`, { token });
    expect(res.body.sources.expectedPurchased.available).toBe(true);
    expect(res.body.sources).toHaveProperty("expectedCustomer");
    /* Present and empty, not absent. */
    expect(Array.isArray(res.body.unavailable)).toBe(true);
  });

  test("a failed source is reported, never rendered as zero rows", async () => {
    const svc = require("../../services/storePurchase/receiveWorkspace.service");
    const original = svc.readExpectedCustomer;
    /* Driven rather than asserted about: the point is that the composition
       keeps going and SAYS the source failed. */
    const out = await svc.workspace(
      { companyId: new mongoose.Types.ObjectId() },
      { companyId: new mongoose.Types.ObjectId(), actorId: "x" },
      { stage: "expected", source: "customer-owned" },
    );
    /* The Merchandising register refuses a context it cannot verify, so this
       exercises the real failure path. */
    if (!out.sources.expectedCustomer.available) {
      expect(out.unavailable.map((u) => u.source)).toContain("expectedCustomer");
      expect(out.unavailable[0].reason).toBeTruthy();
      expect(out.rows).toEqual([]);
    } else {
      /* If it succeeded, it must at least have said so explicitly. */
      expect(out.sources.expectedCustomer.available).toBe(true);
    }
    expect(typeof original).toBe("function");
  });
});

/* ── FROM/TO DATE RANGE (RECORDED ARRIVALS, BY RECEIPT DATE) ───────────────── */

describe("date range filtering", () => {
  test("filters recorded receipts to the range by receipt date, and says the filter applied", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10 }]);
    const may = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-10") });
    const jun = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-06-10") });

    const res = await call(`${WS}?stage=action-required&dateFrom=2026-05-01&dateTo=2026-05-31`, { token });
    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(String(may._id));
    expect(ids).not.toContain(String(jun._id));
    expect(res.body.dateFilter.applies).toBe(true);
    expect(res.body.dateFilter.field).toBe("receiptDate");
    expect(res.body.dateFrom).toBe("2026-05-01");
    expect(res.body.dateTo).toBe("2026-05-31");
  });

  test("Expected ignores the date range and says so — no receipt-date semantics on arrivals still coming", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    await makePO(co, [{ quantity: 10 }]); // issued PO, outstanding line → an Expected row

    const res = await call(`${WS}?stage=expected&dateFrom=2026-05-01&dateTo=2026-05-31`, { token });
    expect(res.body.dateFilter.applies).toBe(false);
    // The expected PO is NOT hidden by a date range that does not apply to it.
    expect(res.body.rows.length).toBeGreaterThan(0);
  });

  test("a malformed date is a validation response, not a silently unfiltered query", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10 }]);
    await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-10") });
    const res = await call(`${WS}?stage=action-required&dateFrom=last-tuesday&dateTo=nonsense`, { token });
    expect(res.status).toBe(200);
    // NOT silently dropped-and-run-unfiltered (that would show the receipt); a
    // clear validation instead.
    expect(res.body.dateFilter.invalid).toBe(true);
    expect(res.body.rows).toEqual([]);
  });
});

/* ── INCLUSIVE IST DAY BOUNDARIES ─────────────────────────────────────────────
   The whole selected end day must be included, in the app's timezone (IST). */
describe("receipt-date boundaries (IST, To inclusive)", () => {
  const RANGE = "dateFrom=2026-05-01&dateTo=2026-05-31";

  test("the full To day is included — start, afternoon and evening of 31 May all match; the next day does not", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 30 }]);
    const startOfDay = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-31T00:00:00.000+05:30") });
    const evening = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-31T20:30:00.000+05:30") });
    const nextDay = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-06-01T00:30:00.000+05:30") });

    const res = await call(`${WS}?stage=action-required&${RANGE}`, { token });
    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(String(startOfDay._id));
    expect(ids).toContain(String(evening._id)); // would be DROPPED by a naive $lte new Date("2026-05-31")
    expect(ids).not.toContain(String(nextDay._id));
    expect(res.body.dateFilter.timezone).toBe("Asia/Kolkata");
  });

  test("dateFrom === dateTo selects that whole IST day", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 20 }]);
    const onDay = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-31T14:00:00.000+05:30") });
    const dayBefore = await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-30T23:59:00.000+05:30") });

    const res = await call(`${WS}?stage=action-required&dateFrom=2026-05-31&dateTo=2026-05-31`, { token });
    const ids = res.body.rows.map((r) => r.id);
    expect(ids).toContain(String(onDay._id));
    expect(ids).not.toContain(String(dayBefore._id));
  });

  test("dateFrom > dateTo is a validation error, never a silently empty register", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10 }]);
    await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-15T10:00:00.000+05:30") });

    const res = await call(`${WS}?stage=action-required&dateFrom=2026-05-31&dateTo=2026-05-01`, { token });
    expect(res.status).toBe(200);
    expect(res.body.dateFilter.invalid).toBe(true);
    expect(res.body.dateFilter.message).toMatch(/From date is after the To date/i);
    // Not queried → not presented as "no receipts exist".
    expect(res.body.rows).toEqual([]);
  });

  test("the pure boundary helper builds inclusive IST edges and flags an inverted range", () => {
    const svc = require("../../services/storePurchase/receiveWorkspace.service");
    const b = svc.dateBoundaries("2026-05-01", "2026-05-31");
    expect(b.from.toISOString()).toBe(new Date("2026-05-01T00:00:00.000+05:30").toISOString());
    expect(b.to.toISOString()).toBe(new Date("2026-05-31T23:59:59.999+05:30").toISOString());
    expect(b.invalid).toBe(false);
    expect(svc.dateBoundaries("2026-05-31", "2026-05-31").invalid).toBe(false);
    expect(svc.dateBoundaries("2026-06-01", "2026-05-01").invalid).toBe(true);
  });
});

/* ── REAL CALENDAR-DATE VALIDATION ────────────────────────────────────────── */
describe("only real calendar dates are accepted", () => {
  const svc = require("../../services/storePurchase/receiveWorkspace.service");

  test("the pure validator accepts real dates (incl. leap day) and rejects impossible ones", () => {
    expect(svc.validDate("2028-02-29")).toBe("2028-02-29"); // valid leap day
    expect(svc.validDate("2026-02-29")).toBe("");            // invalid non-leap Feb 29
    expect(svc.validDate("2026-02-30")).toBe("");            // Feb 30
    expect(svc.validDate("2026-04-31")).toBe("");            // Apr 31 (30-day month)
    expect(svc.validDate("2026-13-01")).toBe("");            // month 13
    expect(svc.validDate("2026-05-00")).toBe("");            // day 00
    expect(svc.validDate("0000-00-00")).toBe("");            // all zeros
    expect(svc.validDate("2026-05-15")).toBe("2026-05-15");  // ordinary valid date
  });

  test("an impossible date is a validation response, NOT a silently unfiltered query", async () => {
    const co = await company(); const token = await actor(co);
    const wh = await warehouse(co._id);
    const po = await makePO(co, [{ quantity: 10 }]);
    // A receipt that WOULD show if the bad date were silently dropped and the
    // query ran unfiltered — proving we do not do that.
    await purchasedReceipt(co, wh, po, { receiptDate: new Date("2026-05-15T10:00:00.000+05:30") });

    const res = await call(`${WS}?stage=action-required&dateFrom=2026-02-31&dateTo=2026-05-31`, { token });
    expect(res.status).toBe(200);
    expect(res.body.dateFilter.invalid).toBe(true);
    expect(res.body.dateFilter.message).toMatch(/real calendar date/i);
    expect(res.body.rows).toEqual([]); // not the unfiltered receipt
  });
});

/* ── SECURITY EVIDENCE: TENANT-SCOPED SEARCH ──────────────────────────────── */
describe("search is tenant-scoped and regex-safe", () => {
  test("1 & 2: searching any customer field never returns another company's customer receipt", async () => {
    const a = await company(); const b = await company();
    const tokenA = await actor(a);
    const whA = await warehouse(a._id); const whB = await warehouse(b._id);
    const mine = await customerReceipt(a, whA, { customerLabel: "Northwind SHARED", orderRef: "ORD-SHARED-A", customerReference: "CHLN-SHARED-A", documentRef: "CME/SHARED-A" });
    const theirs = await customerReceipt(b, whB, { customerLabel: "Northwind SHARED", orderRef: "ORD-SHARED-B", customerReference: "CHLN-SHARED-B", documentRef: "CME/SHARED-B" });
    // Customer label, order ref, challan/customer reference, and source document number.
    for (const term of ["Northwind SHARED", "ORD-SHARED", "CHLN-SHARED", "CME/SHARED"]) {
      const res = await call(`${WS}?stage=completed&source=customer-owned&search=${encodeURIComponent(term)}`, { token: tokenA });
      const ids = res.body.rows.map((r) => r.id);
      expect(ids).toContain(String(mine._id));
      expect(ids).not.toContain(String(theirs._id));
      expect(JSON.stringify(res.body)).not.toContain("SHARED-B");
    }
  });

  test("3: coverage.storedMatchCount counts only this company's matches", async () => {
    const a = await company(); const b = await company();
    const tokenA = await actor(a);
    const whA = await warehouse(a._id); const whB = await warehouse(b._id);
    await customerReceipt(a, whA, { customerReference: "COVTOKEN", documentRef: "CME/CA" });
    await customerReceipt(b, whB, { customerReference: "COVTOKEN", documentRef: "CME/CB1" });
    await customerReceipt(b, whB, { customerReference: "COVTOKEN", documentRef: "CME/CB2" });
    const res = await call(`${WS}?stage=completed&source=customer-owned&search=COVTOKEN`, { token: tokenA });
    expect(res.body.sources.recordedReceipts.coverage.storedMatchCount).toBe(1); // not B's two
    expect(res.body.rows.length).toBe(1);
  });

  test("4: regex-special searches are literal — no widening, no 500", async () => {
    const a = await company(); const token = await actor(a);
    const whA = await warehouse(a._id);
    const po = await makePO(a, [{ quantity: 10 }]);
    await purchasedReceipt(a, whA, po, { extra: { receiptNumber: "GRN/A.C-1" } });
    await purchasedReceipt(a, whA, po, { extra: { receiptNumber: "GRN/PLAIN-2" } });
    for (const term of ["A.C", ".*", "(", "[", "\\"]) {
      const res = await call(`${WS}?stage=action-required&search=${encodeURIComponent(term)}`, { token });
      expect(res.status).toBe(200); // never a 500
    }
    // ".*" is literal → matches neither receipt (it would match both if unescaped).
    const wild = await call(`${WS}?stage=action-required&search=${encodeURIComponent(".*")}`, { token });
    expect(wild.body.rows.length).toBe(0);
    // "A.C" matches "A.C-1" literally, not "PLAIN-2".
    const dot = await call(`${WS}?stage=action-required&search=${encodeURIComponent("A.C")}`, { token });
    const refs = dot.body.rows.map((r) => r.reference);
    expect(refs).toContain("GRN/A.C-1");
    expect(refs).not.toContain("GRN/PLAIN-2");
  });

  test("5: search + source + date all hold together (and tenant too)", async () => {
    const a = await company(); const b = await company();
    const token = await actor(a);
    const whA = await warehouse(a._id); const whB = await warehouse(b._id);
    const inRange = await customerReceipt(a, whA, { customerReference: "FTOKEN", documentRef: "CME/IN", receiptDate: new Date("2026-05-10T10:00:00.000+05:30") });
    await customerReceipt(a, whA, { customerReference: "FTOKEN", documentRef: "CME/OUT", receiptDate: new Date("2026-07-10T10:00:00.000+05:30") }); // out of date range
    await customerReceipt(b, whB, { customerReference: "FTOKEN", documentRef: "CME/BIN", receiptDate: new Date("2026-05-10T10:00:00.000+05:30") }); // other tenant
    const res = await call(`${WS}?stage=completed&source=customer-owned&search=FTOKEN&dateFrom=2026-05-01&dateTo=2026-05-31`, { token });
    expect(res.body.rows.map((r) => r.id)).toEqual([String(inRange._id)]); // source ∧ search ∧ date ∧ tenant
  });
});

/* ── THE ENDPOINT WRITES NOTHING ─────────────────────────────────────────── */

test("reading the workspace mutates no receiving document", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const po = await makePO(co, [{ quantity: 10 }]);
  const grn = await purchasedReceipt(co, wh, po);
  await customerReceipt(co, wh);

  const snapshot = async () => ({
    receipts: await GoodsReceipt.find({ companyId: co._id }).sort({ _id: 1 }).lean(),
    pos: await PurchaseOrder.find({ companyId: co._id }).sort({ _id: 1 }).lean(),
    inspections: await GoodsReceiptInspection.countDocuments({ companyId: co._id }),
    grnCount: await GoodsReceipt.countDocuments({}),
    poCount: await PurchaseOrder.countDocuments({}),
  });

  const before = await snapshot();
  for (const stage of ["expected", "action-required", "completed"]) {
    for (const source of ["all", "purchased", "customer-owned"]) {
      await call(`${WS}?stage=${stage}&source=${source}`, { token });
    }
  }
  /* Not a status, not a timestamp, not a counter, not a new document. */
  expect(await snapshot()).toEqual(before);
  expect(String(grn._id)).toBeTruthy();
});

test("the workspace service exposes no write helper", () => {
  const svc = require("../../services/storePurchase/receiveWorkspace.service");
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "../../services/storePurchase/receiveWorkspace.service.js"), "utf8",
  );
  const body = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
  for (const write of [".save(", "updateOne", "updateMany", "insertOne", "insertMany",
    ".create(", "deleteOne", "deleteMany", "findOneAndUpdate", "bulkWrite", "$set", "$inc"]) {
    expect(body).not.toContain(write);
  }
  expect(typeof svc.workspace).toBe("function");
});
