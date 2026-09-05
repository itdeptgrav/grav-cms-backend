// test/project-manager/manufacturing-order-detail-contract.route.test.js
//
// Chunk 3B. One manufacturing order, four endpoints, one set of answers.
//
// Chunk 3A made the register's list a tested projection. The three detail reads
// were left deriving their own figures, so the same order could be 62% complete
// on the register and something else on the page you opened from it — the
// disagreement 3A's handoff recorded as the first thing 3B had to fix.
//
// The core of this file is a matrix: for one stored order, the list row and all
// three detail responses must agree, field by field, on the eight canonical
// values. It is written as a comparison rather than as expected constants on
// purpose — a shared formula that drifts fails here even if every endpoint
// remains internally consistent.
//
// Two of these tests reproduce defects rather than describing intent:
// `/:id/detailed` threw a 500 on any order that had a work order, and its
// raw-material summary was silently empty because the field it reads was not
// selected.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
/* Registered, not used: the tracking route populates WorkOrder.forwardedToVendor,
   and mongoose throws MissingSchemaError if the referenced model was never
   compiled in this process. server.js loads it at boot; a test app does not. */
require("../../models/Vendor_Models/vendor");
const { listManufacturingOrders } = require("../../services/manufacturing/moList.service");

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-03T09:00:00Z");
const inDays = (n) => new Date(NOW.getTime() + n * DAY);

/** The eight values every one of the four reads must agree on. */
const CANONICAL = [
  "totalQuantity", "workOrdersCount", "completedQuantity", "completionPercentage",
  "derivedStatus", "displayStatus", "deadline", "deadlineRisk",
];

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/manufacturing/manufacturing-orders",
    require("../../routes/CMS_Routes/Manufacturing/Manufacturing-Order/manufacturingOrderRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/manufacturing-orders`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = () =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), email: `pm${++seq}@t.example`, role: "project_manager" },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );

const call = (path, { auth = true } = {}) =>
  fetch(`${base}${path}`, { headers: auth ? { Authorization: `Bearer ${token()}` } : {} })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function mo(over = {}) {
  const n = ++seq;
  const { customerInfo, ...rest } = over;
  return CustomerRequest.create({
    requestId: `REQ-${String(n).padStart(4, "0")}`,
    status: "quotation_sales_approved",
    priority: "medium",
    customerInfo: { name: `Customer ${n}`, email: `c${n}@test.example`, ...customerInfo },
    items: [{ totalQuantity: 10 }],
    ...rest,
  });
}

const wo = (order, over = {}) =>
  WorkOrder.create({
    workOrderNumber: `WO-${++seq}`,
    customerRequestId: order._id,
    quantity: 10,
    ...over,
  });

/** A work order carrying an allocated raw material, for the `/detailed` case. */
async function woWithRawMaterial(order, over = {}) {
  const n = ++seq;
  const raw = await RawItem.create({ name: `Cotton ${n}`, sku: `CTN-${n}`, unit: "m", quantity: 500, minStock: 0 });
  return wo(order, {
    rawMaterials: [{
      rawItemId: raw._id, name: raw.name, sku: raw.sku, unit: "m",
      quantityRequired: 12, unitCost: 40, totalCost: 480,
    }],
    ...over,
  });
}

/** The list row for one order — the reference every detail read is compared to. */
async function listRow(order) {
  const { manufacturingOrders } = await listManufacturingOrders({ limit: 100 }, { now: NOW });
  return manufacturingOrders.find((r) => String(r._id) === String(order._id));
}

/** All three detail responses for one order. */
async function details(order) {
  const [plain, detailed, tracking] = await Promise.all([
    call(`/${order._id}`),
    call(`/${order._id}/detailed`),
    call(`/emplloyeeTracking/${order._id}`),
  ]);
  return { plain, detailed, tracking };
}

/* ═══ 1 · THE DEFECTS, REPRODUCED ═════════════════════════════════════════ */

describe("/:id/detailed defects", () => {
  test("an order with a work order does not 500", async () => {
    // `const totalQuantity = wo.quantity` inside the work-order mapper shadowed
    // the outer accumulator, and the next line did `totalQuantity += ...` — an
    // assignment to a const. Every order that had a work order threw
    // "Assignment to constant variable" and answered 500. An order with none
    // never entered the mapper, which is why this went unnoticed.
    const order = await mo();
    await wo(order);

    const res = await call(`/${order._id}/detailed`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.manufacturingOrder.workOrders).toHaveLength(1);
  });

  test("raw-material requirements are not silently empty", async () => {
    // The route reads `wo.rawMaterials` but its `.select(...)` never listed the
    // field, so the lean document did not carry it and the summary was always
    // `[]` — an order with allocated material reported none.
    const order = await mo();
    await woWithRawMaterial(order);

    const res = await call(`/${order._id}/detailed`);

    expect(res.status).toBe(200);
    expect(res.body.manufacturingOrder.rawMaterialRequirements.length).toBeGreaterThan(0);
    const [rm] = res.body.manufacturingOrder.rawMaterialRequirements;
    expect(rm.name).toMatch(/^Cotton /);
  });

  test("the aggregate quantity is the sum of the work orders, not a shadowed value", async () => {
    const order = await mo();
    await wo(order, { quantity: 10 });
    await wo(order, { quantity: 25 });

    const { body } = await call(`/${order._id}/detailed`);
    // This endpoint reports aggregate units under `progress.units`, not
    // `workOrderStats` — that name belongs to /emplloyeeTracking/:id.
    expect(body.manufacturingOrder.progress.units.total).toBe(35);
  });
});

/* ═══ 2 · THE AGREEMENT MATRIX ════════════════════════════════════════════ */

/**
 * One order, four reads, eight fields. Compared against the list rather than
 * against constants: a formula that drifts fails here even when each endpoint
 * is internally consistent.
 */
async function expectAgreement(order) {
  const row = await listRow(order);
  const { plain, detailed, tracking } = await details(order);

  /* A date crosses HTTP as an ISO string and comes back from the service as a
     Date. Comparing them raw compares a representation, not a value. */
  const comparable = (v) =>
    v instanceof Date ? v.toISOString()
      : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString()
        : v;

  for (const [name, res] of Object.entries({ plain, detailed, tracking })) {
    expect(res.status).toBe(200);
    const mo = res.body.manufacturingOrder;
    for (const field of CANONICAL) {
      expect({ endpoint: name, field, value: comparable(mo[field]) })
        .toEqual({ endpoint: name, field, value: comparable(row[field]) });
    }
  }
  return { row, plain, detailed, tracking };
}

describe("list and detail agree on the canonical fields", () => {
  test("an order with no work orders", async () => {
    const order = await mo();
    const { row } = await expectAgreement(order);

    expect(row.workOrdersCount).toBe(0);
    expect(row.completedQuantity).toBe(0);
    expect(row.completionPercentage).toBe(0);
    expect(row.displayStatus).toBe("pending");
  });

  test("scheduled work", async () => {
    const order = await mo();
    await wo(order, { status: "scheduled" });
    const { row } = await expectAgreement(order);
    expect(row.displayStatus).toBe("in_progress");
  });

  test("planned work", async () => {
    const order = await mo();
    await wo(order, { status: "planned" });
    const { row } = await expectAgreement(order);
    expect(row.displayStatus).toBe("in_progress");
  });

  test("partial progress", async () => {
    const order = await mo();
    await wo(order, { quantity: 10, status: "in_progress", productionCompletion: { overallCompletedQuantity: 4 } });
    const { row } = await expectAgreement(order);

    expect(row.completedQuantity).toBe(4);
    expect(row.completionPercentage).toBe(40);
    expect(row.displayStatus).toBe("in_progress");
  });

  test("completed work", async () => {
    const order = await mo();
    await wo(order, { quantity: 10, status: "completed", productionCompletion: { overallCompletedQuantity: 10 } });
    const { row } = await expectAgreement(order);

    expect(row.completionPercentage).toBe(100);
    expect(row.displayStatus).toBe("completed");
  });

  test("over-completion reports 100% and keeps the real completed quantity", async () => {
    const order = await mo();
    await wo(order, { quantity: 10, status: "completed", productionCompletion: { overallCompletedQuantity: 25 } });
    const { row, plain, detailed, tracking } = await expectAgreement(order);

    expect(row.completionPercentage).toBe(100);
    // The units are the real count and may exceed what was ordered.
    expect(row.completedQuantity).toBe(25);
    for (const res of [plain, detailed, tracking]) {
      expect(res.body.manufacturingOrder.completedQuantity).toBe(25);
      expect(res.body.manufacturingOrder.completionPercentage).toBe(100);
    }
  });

  test("all work orders cancelled", async () => {
    const order = await mo();
    await wo(order, { status: "cancelled" });
    await wo(order, { status: "cancelled" });
    const { row } = await expectAgreement(order);

    expect(row.displayStatus).toBe("cancelled");
    expect(row.workOrdersCount).toBe(2);
  });

  test("a delivery deadline", async () => {
    const order = await mo({ customerInfo: { deliveryDeadline: inDays(-4) } });
    await wo(order, { status: "in_progress" });
    const { row } = await expectAgreement(order);
    expect(row.deadlineRisk).toBe("overdue");
  });

  test("the estimated completion is used when there is no delivery deadline", async () => {
    const order = await mo({ estimatedCompletion: inDays(3) });
    await wo(order, { status: "in_progress" });
    const { row } = await expectAgreement(order);

    expect(row.deadlineRisk).toBe("due_soon");
    expect(new Date(row.deadline).toISOString()).toBe(inDays(3).toISOString());
  });

  test("no deadline at all", async () => {
    const order = await mo();
    await wo(order, { status: "in_progress" });
    const { row } = await expectAgreement(order);

    expect(row.deadline).toBeNull();
    expect(row.deadlineRisk).toBe("none");
  });

  test("every detail response bounds the percentage", async () => {
    const order = await mo();
    await wo(order, { quantity: 3, productionCompletion: { overallCompletedQuantity: 99 } });
    const { plain, detailed, tracking } = await details(order);

    for (const res of [plain, detailed, tracking]) {
      const pct = res.body.manufacturingOrder.completionPercentage;
      expect(Number.isFinite(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
  });
});

/* ═══ 3 · NOTHING WAS TAKEN AWAY ══════════════════════════════════════════ */

describe("existing contracts are preserved", () => {
  test("the misspelled tracking URL stays reachable", async () => {
    // The live PM detail page calls /emplloyeeTracking/:id. Correcting the
    // spelling would break it, so the typo is part of the contract.
    const order = await mo();
    const res = await call(`/emplloyeeTracking/${order._id}`);
    expect(res.status).toBe(200);
    expect(res.body.manufacturingOrder.moNumber).toBe(`MO-${order.requestId}`);
  });

  test("each endpoint keeps its own established fields", async () => {
    // Presence, not an exact key list: additive fields must stay allowed.
    const order = await mo({ finalOrderPrice: 4200, measurementName: "Chest 40" });
    await woWithRawMaterial(order, { status: "in_progress" });
    const { plain, detailed, tracking } = await details(order);

    for (const key of ["_id", "moNumber", "customerInfo", "finalOrderPrice", "priority", "status", "workOrders"]) {
      expect(plain.body.manufacturingOrder).toHaveProperty(key);
    }
    for (const key of ["_id", "moNumber", "workOrders", "rawMaterialRequirements", "summary", "progress"]) {
      expect(detailed.body.manufacturingOrder).toHaveProperty(key);
    }
    for (const key of ["_id", "moNumber", "workOrders", "workOrderStats", "rawMaterialRequirements", "timeline", "requestTypeBadge"]) {
      expect(tracking.body.manufacturingOrder).toHaveProperty(key);
    }
  });

  test("each endpoint's existing `status` keeps its own meaning", async () => {
    // `status` does NOT mean the same thing on all three, which is exactly why
    // the canonical value is published as `derivedStatus` instead of being
    // written over it:
    //
    //   /:id                     the CustomerRequest's STORED status
    //   /emplloyeeTracking/:id   the CustomerRequest's STORED status
    //   /:id/detailed            its own legacy derivation, in its own
    //                            vocabulary (pending | planning | in_production
    //                            | completed) — note `in_production`, which is
    //                            not one of the canonical four
    //
    // Overwriting any of them would silently change what an existing caller
    // reading `status` receives.
    const order = await mo();
    await wo(order, { status: "in_progress" });
    const { plain, detailed, tracking } = await details(order);

    expect(plain.body.manufacturingOrder.status).toBe("quotation_sales_approved");
    expect(tracking.body.manufacturingOrder.status).toBe("quotation_sales_approved");

    // Untouched, and genuinely different from the canonical answer here: no
    // units are complete, so its own rule says "pending" while the shared
    // derivation says work has started.
    expect(detailed.body.manufacturingOrder.status).toBe("pending");
    expect(["pending", "planning", "in_production", "completed"])
      .toContain(detailed.body.manufacturingOrder.status);

    // The canonical value is the same on all three regardless.
    for (const res of [plain, detailed, tracking]) {
      expect(res.body.manufacturingOrder.derivedStatus).toBe("in_progress");
      expect(res.body.manufacturingOrder.displayStatus).toBe("in_progress");
    }
  });

  test("nested legacy progress fields are untouched", async () => {
    const order = await mo();
    await wo(order, { quantity: 10, status: "in_progress", productionCompletion: { overallCompletedQuantity: 4 } });
    const { detailed } = await details(order);

    const [woRow] = detailed.body.manufacturingOrder.workOrders;
    expect(woRow).toHaveProperty("progress");
    expect(woRow.progress).toHaveProperty("completedUnits");
    expect(detailed.body.manufacturingOrder.progress.units).toHaveProperty("total");
  });

  test("a detail read is not restricted to sales-approved orders", async () => {
    // Neither /:id nor /:id/detailed filtered on status before, and adding that
    // filter would 404 orders these pages can currently open.
    const order = await mo({ status: "in_progress" });
    const { plain, detailed, tracking } = await details(order);
    for (const res of [plain, detailed, tracking]) expect(res.status).toBe(200);
  });
});

/* ═══ 4 · ERRORS AND ACCESS ═══════════════════════════════════════════════ */

describe("errors and access are unchanged", () => {
  const paths = (id) => [`/${id}`, `/${id}/detailed`, `/emplloyeeTracking/${id}`];

  test("an invalid ObjectId is still a 400", async () => {
    for (const p of paths("not-an-id")) {
      const res = await call(p);
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
  });

  test("a valid ObjectId for a missing order is still a 404", async () => {
    for (const p of paths(new mongoose.Types.ObjectId())) {
      const res = await call(p);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    }
  });

  test("anonymous access is still refused", async () => {
    const order = await mo();
    for (const p of paths(order._id)) {
      const res = await call(p, { auth: false });
      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty("manufacturingOrder");
    }
  });
});
