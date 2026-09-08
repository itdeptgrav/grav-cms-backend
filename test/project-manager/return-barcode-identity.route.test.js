// test/project-manager/return-barcode-identity.route.test.js
//
// Chunk 4A.2 correction. Return/rework scan barcodes must resolve.
//
// ── THE DEFECT ──────────────────────────────────────────────────────────────
// `routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes.js` builds the
// person-wise return barcodes from the work order's `workOrderNumber`:
//
//     barcodes.push(`${woEntry.woDoc.workOrderNumber}-${unit}`)
//
// That was already wrong before 4A.2 — the field was empty, so it produced the
// literal string "undefined-001", which fails every parser's
// `parts[0] === "WO"` guard outright.
//
// 4A.2 gave every work order a canonical `WO-<full 24-char ObjectId>`, which
// made those barcodes PARSE — and that is the trap. The whole scan subsystem
// resolves the identifier segment against `workOrder._id.toString().slice(-8)`
// (11 call sites). A barcode carrying the FULL id parses cleanly and then
// resolves to nothing, which is a worse failure than being rejected.
//
// The two identifiers are deliberately separate concerns:
//   • `workOrderNumber`  — the canonical business identity, full ObjectId
//   • the scan segment   — `_id.slice(-8)`, what every barcode is built from
//                          and resolved by
//
// This suite pins the second. It does not touch the first, and it does not
// change the barcode FORMAT — only which identifier the return path feeds it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const ReturnRequest = require("../../models/CMS_Models/Manufacturing/Return/ReturnRequest");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Customer = require("../../models/Customer_Models/Customer");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const { __scanBarcodeFor: scanBarcodeFor } = require("../../routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/manufacturing/return-requests",
    require("../../routes/CMS_Routes/Manufacturing/Return/returnRequestRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/return-requests`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = () =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), email: `pm${++seq}@example.com`, role: "project_manager" },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );

const call = (path, { method = "POST", body = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** The parser every scan consumer shares (10 identical copies). */
const parseBarcode = (barcodeId) => {
  const parts = String(barcodeId).split("-");
  if (parts.length >= 3 && parts[0] === "WO") {
    return { success: true, woShortId: parts[1], unitNumber: parseInt(parts[2], 10) };
  }
  return { success: false };
};

/** The resolver rule, verbatim from productionCompletionRoutes.js:46. */
const resolveWorkOrder = (allWOs, shortId) =>
  allWOs.find((w) => w._id.toString().slice(-8) === shortId) || null;

/** A return request ready for /:id/create-mo, with two people on one product. */
async function personWiseReturn({ qtyA = 2, qtyB = 3 } = {}) {
  const n = ++seq;
  const customer = await Customer.create({ name: `Cust ${n}`, email: `cust${n}@example.com` });
  const originalMo = await CustomerRequest.create({
    requestId: `REQ-ORIG-${n}`, customerId: customer._id,
    customerInfo: { name: customer.name, email: customer.email },
    status: "quotation_sales_approved", priority: "high",
  });
  const stockItem = await StockItem.create({
    name: `Shirt ${n}`, reference: `SH-${n}`,
    category: "Apparel", createdBy: new mongoose.Types.ObjectId(),
    operations: [{ type: "Stitch", operationCode: "ST-1", totalSeconds: 60 }],
  });

  const products = (qty) => [{
    stockItemId: stockItem._id, variantId: "", productName: stockItem.name,
    productRef: stockItem.reference, variantAttributes: [], returnQuantity: qty,
  }];

  const rr = await ReturnRequest.create({
    returnRequestNumber: `RR-${n}`,
    originalMoId: originalMo._id,
    dispatchType: "person_wise",
    status: "store_processing",
    customerName: customer.name,
    persons: [
      { employeeId: new mongoose.Types.ObjectId(), employeeName: "Asha", employeeUIN: `U${n}A`, gender: "female", products: products(qtyA) },
      { employeeId: new mongoose.Types.ObjectId(), employeeName: "Bharat", employeeUIN: `U${n}B`, gender: "male", products: products(qtyB) },
    ],
  });
  return { rr, stockItem, customer, originalMo };
}

/* ── A LIMIT THIS SUITE CANNOT STEP OVER, STATED PLAINLY ────────────────────
   `EmployeeProductionProgress` has NO `assignedBarcodeIds` field in its schema.
   Mongoose runs strict by default, so the `$set: { assignedBarcodeIds }` at
   returnRequestRoutes.js:375 — and the four equivalents in quotationRoutes.js
   (1600, 1694, 1832, 2377, 2848) — are silently discarded. The barcodes this
   route computes have never reached the database.

   So "the barcode is stored in assignedBarcodeIds" cannot be asserted here.
   Adding the field would make it storable — and would simultaneously start
   persisting the four Sales builders, which still compose from
   `workOrderNumber` and therefore still would not resolve. That is the broad
   barcode refactor this chunk is told not to launch, so the field is left
   alone and the gap is reported instead.

   So the ROUTE-WIRING block at the bottom of this file spies on
   `EmployeeProductionProgress.findOneAndUpdate` and captures the update object
   BEFORE mongoose strips the unknown field, while letting the real write
   proceed. That is what proves the route actually passes the corrected
   barcodes — the helper-level block below proves only that the helper is
   correct, and a route that regressed to the old builder would keep it green. */

describe("return/rework scan barcodes — helper-level", () => {
  test("the barcode the route builds resolves to its own work order", async () => {
    // THE ASSERTION THAT FAILED BEFORE THIS CORRECTION. Built from
    // `workOrderNumber`, the segment was the full 24-character ObjectId and
    // resolveWorkOrder() returned null.
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });

    const res = await call(`/${rr._id}/create-mo`);
    expect(res.status).toBe(200);

    const workOrders = await WorkOrder.find({}).lean();
    expect(workOrders).toHaveLength(1);
    const wo = workOrders[0];

    const barcode = scanBarcodeFor(wo._id, 1);
    const parsed = parseBarcode(barcode);

    expect(parsed.success).toBe(true);
    const resolved = resolveWorkOrder(workOrders, parsed.woShortId);
    expect(resolved).not.toBeNull();
    expect(String(resolved._id)).toBe(String(wo._id));
  });

  test("the canonical number would NOT have resolved — the defect, pinned", async () => {
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    await call(`/${rr._id}/create-mo`);
    const workOrders = await WorkOrder.find({}).lean();
    const wo = workOrders[0];

    // What the route used to build.
    const oldStyle = `${wo.workOrderNumber}-001`;
    const parsedOld = parseBarcode(oldStyle);

    expect(parsedOld.success).toBe(true);                       // it parses…
    expect(resolveWorkOrder(workOrders, parsedOld.woShortId)).toBeNull();  // …and resolves to nothing

    // What it builds now.
    const parsedNew = parseBarcode(scanBarcodeFor(wo._id, 1));
    expect(resolveWorkOrder(workOrders, parsedNew.woShortId)).not.toBeNull();
  });

  test("the barcodes use the established scan format", async () => {
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    await call(`/${rr._id}/create-mo`);
    const [wo] = await WorkOrder.find({}).lean();

    for (const unit of [1, 7, 42, 999]) {
      expect(scanBarcodeFor(wo._id, unit)).toMatch(/^WO-[0-9a-f]{8}-\d{3}$/);
    }
  });

  test("the scan segment is the short id, NOT the canonical number", async () => {
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    await call(`/${rr._id}/create-mo`);
    const [wo] = await WorkOrder.find({}).lean();

    const barcode = scanBarcodeFor(wo._id, 1);
    expect(parseBarcode(barcode).woShortId).toBe(wo._id.toString().slice(-8));
    expect(parseBarcode(barcode).woShortId).not.toBe(wo._id.toString());
    expect(barcode).not.toContain(wo.workOrderNumber);

    // …and the canonical number is untouched by any of this.
    expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
  });

  test("the unit number survives the round trip", async () => {
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });
    await call(`/${rr._id}/create-mo`);
    const [wo] = await WorkOrder.find({}).lean();

    for (const unit of [1, 2, 3, 4, 5]) {
      expect(parseBarcode(scanBarcodeFor(wo._id, unit)).unitNumber).toBe(unit);
    }
  });

  test("no barcode ever contains 'undefined' or 'null'", async () => {
    // Exactly what this call site produced before Chunk 4A.2, when
    // workOrderNumber was empty on every work order.
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 2 });
    await call(`/${rr._id}/create-mo`);
    const [wo] = await WorkOrder.find({}).lean();

    const barcode = scanBarcodeFor(wo._id, 1);
    expect(barcode).not.toContain("undefined");
    expect(barcode).not.toContain("null");
  });

  test("unit ranges and employee assignments are preserved", async () => {
    // These the route DOES persist, so they are asserted end to end.
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });
    await call(`/${rr._id}/create-mo`);

    const progress = await EmployeeProductionProgress.find({}).sort({ unitStart: 1 }).lean();
    expect(progress).toHaveLength(2);
    expect(progress.map((p) => p.totalUnits)).toEqual([2, 3]);
    expect(progress.map((p) => [p.unitStart, p.unitEnd])).toEqual([[1, 2], [3, 5]]);
    expect(progress.map((p) => p.employeeName).sort()).toEqual(["Asha", "Bharat"]);
    for (const p of progress) expect(p.employeeUIN).toBeTruthy();

    // Every unit in each range yields a barcode that resolves to that person's
    // work order.
    const workOrders = await WorkOrder.find({}).lean();
    for (const p of progress) {
      for (let u = p.unitStart; u <= p.unitEnd; u++) {
        const parsed = parseBarcode(scanBarcodeFor(p.workOrderId, u));
        expect(parsed.unitNumber).toBe(u);
        expect(String(resolveWorkOrder(workOrders, parsed.woShortId)._id)).toBe(String(p.workOrderId));
      }
    }
  });

  test("assignedBarcodeIds is still not persisted — the gap, recorded", async () => {
    // Not a desired outcome. Pinned so the follow-up is visible and so this
    // suite cannot be read as proving storage works.
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    await call(`/${rr._id}/create-mo`);

    const progress = await EmployeeProductionProgress.find({}).lean();
    expect(progress.length).toBeGreaterThan(0);
    for (const p of progress) expect(p.assignedBarcodeIds).toBeUndefined();

    // Because the schema does not declare it.
    expect(EmployeeProductionProgress.schema.path("assignedBarcodeIds")).toBeUndefined();
  });

  test("the work order keeps its canonical number regardless", async () => {
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    await call(`/${rr._id}/create-mo`);

    for (const wo of await WorkOrder.find({}).lean()) {
      expect(wo.workOrderNumber).toBe(`WO-${wo._id.toString()}`);
      expect(wo.workOrderNumber).toMatch(/^WO-[0-9a-f]{24}$/);
    }
  });
});


/* ═══ ROUTE WIRING — what the route actually passes ═══════════════════════
 *
 * The helper-level block above proves `scanBarcodeFor` is correct. It does NOT
 * prove the route uses it: `assignedBarcodeIds` is not in the
 * EmployeeProductionProgress schema, so mongoose discards it and nothing about
 * the persisted document reveals which builder produced it. A regression to
 * `${woDoc.workOrderNumber}-${unit}` would leave every assertion above green.
 *
 * So this block intercepts `EmployeeProductionProgress.findOneAndUpdate`,
 * records the update object as the route hands it over — before mongoose
 * strips anything — and then calls through, so the persisted ranges and
 * assignments are still exercised for real.
 */

describe("return/rework scan barcodes — route wiring", () => {
  /** Capture every findOneAndUpdate the route makes, then call through. */
  async function captureCreateMo(rr) {
    const captured = [];
    const original = EmployeeProductionProgress.findOneAndUpdate;

    EmployeeProductionProgress.findOneAndUpdate = function spy(filter, update, options) {
      captured.push({
        filter: JSON.parse(JSON.stringify(filter)),
        set: JSON.parse(JSON.stringify(update.$set)),
      });
      return original.call(this, filter, update, options);
    };

    let res;
    try {
      res = await call(`/${rr._id}/create-mo`);
    } finally {
      EmployeeProductionProgress.findOneAndUpdate = original;
    }
    return { res, captured };
  }

  test("the route hands over barcodes that parse and resolve to the work order it created", async () => {
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });

    const { res, captured } = await captureCreateMo(rr);
    expect(res.status).toBe(200);

    // The interception saw the real calls, one per person.
    expect(captured).toHaveLength(2);

    const workOrders = await WorkOrder.find({}).lean();
    expect(workOrders).toHaveLength(1);

    for (const c of captured) {
      expect(Array.isArray(c.set.assignedBarcodeIds)).toBe(true);
      expect(c.set.assignedBarcodeIds).toHaveLength(c.set.totalUnits);

      for (const barcode of c.set.assignedBarcodeIds) {
        const parsed = parseBarcode(barcode);
        expect(parsed.success).toBe(true);

        const resolved = resolveWorkOrder(workOrders, parsed.woShortId);
        expect(resolved).not.toBeNull();
        expect(String(resolved._id)).toBe(String(c.filter.workOrderId));
      }
    }
  });

  test("each captured array is exactly the barcodes for that person's unit range", async () => {
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });
    const { captured } = await captureCreateMo(rr);

    for (const c of captured) {
      const expected = [];
      for (let u = c.set.unitStart; u <= c.set.unitEnd; u++) {
        expected.push(scanBarcodeFor(c.filter.workOrderId, u));
      }
      expect(c.set.assignedBarcodeIds).toEqual(expected);

      // And the parsed units match the captured range exactly.
      const units = c.set.assignedBarcodeIds.map((b) => parseBarcode(b).unitNumber);
      expect(units).toEqual(expected.map((_, i) => c.set.unitStart + i));
      expect(Math.min(...units)).toBe(c.set.unitStart);
      expect(Math.max(...units)).toBe(c.set.unitEnd);
    }
  });

  test("no handed-over barcode carries the canonical number, undefined or null", async () => {
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 2 });
    const { captured } = await captureCreateMo(rr);

    const [wo] = await WorkOrder.find({}).lean();
    const fullId = wo._id.toString();

    const all = captured.flatMap((c) => c.set.assignedBarcodeIds);
    expect(all.length).toBe(4);
    for (const barcode of all) {
      expect(barcode).not.toContain(fullId);            // not the canonical segment
      expect(barcode).not.toContain(wo.workOrderNumber);
      expect(barcode).not.toContain("undefined");
      expect(barcode).not.toContain("null");
      expect(barcode).toMatch(/^WO-[0-9a-f]{8}-\d{3}$/);
    }
  });

  test("the two employees get distinct, contiguous ranges with no gap or overlap", async () => {
    const { rr } = await personWiseReturn({ qtyA: 2, qtyB: 3 });
    const { captured } = await captureCreateMo(rr);

    const ordered = [...captured].sort((a, b) => a.set.unitStart - b.set.unitStart);
    expect(ordered.map((c) => [c.set.unitStart, c.set.unitEnd])).toEqual([[1, 2], [3, 5]]);

    // Every unit 1..5 appears exactly once across both handed-over arrays.
    const units = ordered.flatMap((c) =>
      c.set.assignedBarcodeIds.map((b) => parseBarcode(b).unitNumber));
    expect(units.slice().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(units).size).toBe(units.length);

    // Distinct employees, and the persisted documents agree with the capture.
    const employeeIds = captured.map((c) => String(c.filter.employeeId));
    expect(new Set(employeeIds).size).toBe(2);

    const progress = await EmployeeProductionProgress.find({}).sort({ unitStart: 1 }).lean();
    expect(progress.map((p) => [p.unitStart, p.unitEnd])).toEqual([[1, 2], [3, 5]]);
    expect(progress.map((p) => p.employeeName).sort()).toEqual(["Asha", "Bharat"]);
  });

  test("the old builder would have been caught by this capture", async () => {
    // The regression this block exists for: had the route still built from
    // `workOrderNumber`, the captured segment would be the full ObjectId and
    // would resolve to nothing.
    const { rr } = await personWiseReturn({ qtyA: 1, qtyB: 1 });
    const { captured } = await captureCreateMo(rr);
    const workOrders = await WorkOrder.find({}).lean();
    const [wo] = workOrders;

    const wouldHaveBeen = `${wo.workOrderNumber}-001`;
    expect(resolveWorkOrder(workOrders, parseBarcode(wouldHaveBeen).woShortId)).toBeNull();

    // What was actually handed over resolves.
    const actual = captured[0].set.assignedBarcodeIds[0];
    expect(actual).not.toBe(wouldHaveBeen);
    expect(resolveWorkOrder(workOrders, parseBarcode(actual).woShortId)).not.toBeNull();
  });
});
