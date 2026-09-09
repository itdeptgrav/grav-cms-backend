// test/project-manager/work-order-planning-characterization.route.test.js
//
// Chunk 4A. What work-order planning ACTUALLY does today.
//
// ── HOW TO READ THIS FILE ───────────────────────────────────────────────────
// This is a characterisation suite, not a specification. Every assertion is a
// statement about observed behaviour, and a number of them describe behaviour
// that is wrong. Those are marked
//
//     CHARACTERISATION — UNSAFE
//
// and each names what a correct implementation should do instead. Chunk 4B is
// expected to DELETE or invert them; a green run here means "the system still
// behaves the way the audit recorded", not "the system is correct".
//
// Assertions with no such marker describe behaviour that is fine and should
// survive Chunk 4B.
//
// Nothing here changes production code. The whole point is to pin the contract
// before anyone proposes a new lifecycle for it.
//
// Route: routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js
// Mount: server.js:1541 — app.use("/api/cms/manufacturing/work-orders", …)
//        NO departmentWrites guard. Router-local auth only.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const ChangeLog = require("../../models/Access/ChangeLog");
require("../../models/Vendor_Models/vendor");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Exactly as server.js:1541 mounts it — no department guard.
  app.use(
    "/api/cms/manufacturing/work-orders",
    require("../../routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/work-orders`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = (over = {}) =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), email: `p${++seq}@t.example`, role: "project_manager", ...over },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );

const call = (path, { method = "GET", body, auth = true, tok } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${tok || token()}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const rawItem = (over = {}) => {
  const n = ++seq;
  return RawItem.create({
    name: `Cotton ${n}`, sku: `CTN-${n}`, unit: "m", quantity: 1000, minStock: 0, ...over,
  });
};

/**
 * A work order with one raw-material line and two operations.
 * `perUnit` is the BOM requirement per produced unit.
 */
async function workOrder({ quantity = 10, perUnit = 2, stock = 1000, unit = "m", rawUnit = "m", status = "pending", withRaw = true, ops = 2, timeline = false } = {}) {
  const n = ++seq;
  const ri = withRaw ? await rawItem({ unit: rawUnit, quantity: stock }) : null;
  return WorkOrder.create({
    workOrderNumber: `WO-${String(n).padStart(4, "0")}`,
    quantity,
    originalQuantity: quantity,
    status,
    /* Off by default so the absent-timeline case can be exercised. The main
       generator (routes/CMS_Routes/Sales/quotationRoutes.js) DOES set one. */
    ...(timeline ? { timeline: { totalEstimatedSeconds: 0 } } : {}),
    operations: Array.from({ length: ops }, (_, i) => ({
      operationType: `Op ${i + 1}`, operationCode: `OP-${i + 1}`, plannedTimeSeconds: 60, status: "pending",
    })),
    rawMaterials: withRaw ? [{
      rawItemId: ri._id, name: ri.name, sku: ri.sku, unit,
      quantityRequired: perUnit * quantity, quantityAllocated: 0, quantityIssued: 0,
      unitCost: 10, totalCost: 10 * perUnit * quantity, allocationStatus: "not_allocated",
    }] : [],
  });
}

const reload = (wo) => WorkOrder.findById(wo._id).lean();

const allocate = (wo, body) => call(`/${wo._id}/allocate-raw-materials`, { method: "PUT", body });
const planOps = (wo, body) => call(`/${wo._id}/plan-operations`, { method: "PUT", body });
const complete = (wo, body = {}) => call(`/${wo._id}/complete-planning`, { method: "POST", body });
const startProd = (wo) => call(`/${wo._id}/start-production`, { method: "POST", body: {} });

/* ═══ 1 · ACCESS BOUNDARY ═════════════════════════════════════════════════ */

describe("access boundary", () => {
  const endpoints = (id) => [
    ["GET", `/${id}/planning`, undefined],
    ["PUT", `/${id}/allocate-raw-materials`, { quantity: 1 }],
    ["PUT", `/${id}/plan-operations`, { operations: [] }],
    ["POST", `/${id}/complete-planning`, {}],
    ["POST", `/${id}/start-production`, {}],
  ];

  test("anonymous is refused on every planning endpoint", async () => {
    const wo = await workOrder();
    for (const [method, path, body] of endpoints(wo._id)) {
      const res = await call(path, { method, body, auth: false });
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    }
  });

  test("an expired session is refused", async () => {
    const wo = await workOrder();
    const stale = jwt.sign({ id: String(new mongoose.Types.ObjectId()) }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await complete(wo);
    expect(res.status).toBe(200);               // a valid session works…
    const refused = await call(`/${wo._id}/complete-planning`, { method: "POST", body: {}, tok: stale });
    expect(refused.status).toBe(401);           // …an expired one does not
  });

  // CHARACTERISATION — UNSAFE.
  // The router is mounted with NO departmentWrites guard (server.js:1541), so
  // authentication is the ONLY gate. Any signed-in employee of any department —
  // cutting, QC, packaging, sales — can allocate stock, rewrite the operation
  // plan and mark planning complete on any work order. Chunk 4B should decide
  // the ownership boundary; this test records that today there is none.
  test("CHARACTERISATION — UNSAFE: any authenticated employee may mutate planning", async () => {
    const wo = await workOrder();
    const outsider = token({ role: "quality_control", email: "qc@t.example" });

    const res = await call(`/${wo._id}/complete-planning`, { method: "POST", body: {}, tok: outsider });

    expect(res.status).toBe(200);
    expect((await reload(wo)).status).toBe("scheduled");
  });

  // CHARACTERISATION — UNSAFE.
  // Not one planning mutation writes an audit record. There is no recordChange
  // call in workOrderRoutes.js and no auditTrail floor under
  // /api/cms/manufacturing (server.js mounts it only on /api/hr, /api/employees).
  test("CHARACTERISATION — UNSAFE: no planning mutation is audited", async () => {
    const wo = await workOrder();
    await allocate(wo, { quantity: 5 });
    await planOps(wo, { operations: [] });
    await complete(wo);

    expect(await ChangeLog.countDocuments({})).toBe(0);
  });
});

/* ═══ 2 · IDENTIFIERS ═════════════════════════════════════════════════════ */

describe("identifier handling", () => {
  test("a missing but valid ObjectId is a 404 everywhere", async () => {
    const ghost = new mongoose.Types.ObjectId();
    for (const [method, path, body] of [
      ["GET", `/${ghost}/planning`, undefined],
      ["PUT", `/${ghost}/allocate-raw-materials`, { quantity: 1 }],
      ["PUT", `/${ghost}/plan-operations`, { operations: [] }],
      ["POST", `/${ghost}/complete-planning`, {}],
      ["POST", `/${ghost}/start-production`, {}],
    ]) {
      const res = await call(path, { method, body });
      expect(res.status).toBe(404);
    }
  });

  // CHARACTERISATION — UNSAFE.
  // None of these routes validates the id shape, so a CastError from
  // findById() falls through to the catch-all and becomes a 500. The detail
  // endpoints on the manufacturing-order router return 400 for the same input
  // (they call ObjectId.isValid first); planning is inconsistent with them.
  test("CHARACTERISATION — UNSAFE: a malformed id is a 500, not a 400", async () => {
    for (const [method, path, body] of [
      ["GET", "/not-an-id/planning", undefined],
      ["PUT", "/not-an-id/allocate-raw-materials", { quantity: 1 }],
      ["PUT", "/not-an-id/plan-operations", { operations: [] }],
      ["POST", "/not-an-id/complete-planning", {}],
      ["POST", "/not-an-id/start-production", {}],
    ]) {
      const res = await call(path, { method, body });
      expect(res.status).toBe(500);
    }
  });
});

/* ═══ 3 · GET /:id/planning — READ ════════════════════════════════════════ */

describe("GET /:id/planning", () => {
  test("reports per-material stock, requirement and sufficiency", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });
    const { status, body } = await call(`/${wo._id}/planning`);

    expect(status).toBe(200);
    const [rm] = body.workOrder.rawMaterials;
    expect(rm.currentStock).toBe(1000);
    expect(rm.requiredPerUnit).toBe(2);
    expect(rm.status).toBe("sufficient");
    expect(rm.maxUnitsFromThisMaterial).toBe(500);
  });

  test("insufficient stock is reported as such", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 6 });
    const { body } = await call(`/${wo._id}/planning`);
    const [rm] = body.workOrder.rawMaterials;

    expect(rm.status).toBe("partial");
    expect(rm.maxUnitsFromThisMaterial).toBe(3);   // floor(6 / 2)
  });

  // CHARACTERISATION — UNSAFE.
  // `maxProducibleQuantity: Math.max(1, maxProducibleQuantity)`. With zero
  // stock the honest answer is 0, and the screen is told 1 — an order that
  // cannot be produced at all is presented as producible in quantity one.
  test("CHARACTERISATION — UNSAFE: zero stock still reports maxProducibleQuantity 1", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 0 });
    const { body } = await call(`/${wo._id}/planning`);

    expect(body.workOrder.rawMaterials[0].maxUnitsFromThisMaterial).toBe(0);
    expect(body.workOrder.rawMaterials[0].status).toBe("insufficient");
    expect(body.workOrder.maxProducibleQuantity).toBe(1);   // should be 0
  });

  // CHARACTERISATION — UNSAFE.
  // convertQuantity() logs a warning and RETURNS THE INPUT UNCHANGED when no
  // conversion path exists. A requirement in metres is then compared against a
  // stock figure in kilograms as though the numbers were commensurable.
  test("CHARACTERISATION — UNSAFE: a missing unit conversion silently keeps the original number", async () => {
    // BOM asks for metres; the raw item is registered in kilograms; no Unit
    // document defines a path between them.
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 100, unit: "m", rawUnit: "kg" });
    const { body } = await call(`/${wo._id}/planning`);
    const [rm] = body.workOrder.rawMaterials;

    expect(rm.rawItemRegisteredUnit).toBe("kg");
    // 2 metres per unit was treated as 2 kilograms per unit.
    expect(rm.requiredPerUnit).toBe(2);
    expect(rm.maxUnitsFromThisMaterial).toBe(50);
  });

  test("a declared conversion IS applied", async () => {
    const cm = await Unit.create({ name: "cm" });
    await Unit.create({ name: "m", conversions: [{ toUnit: cm._id, quantity: 100 }] });
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000, unit: "m", rawUnit: "cm" });

    const { body } = await call(`/${wo._id}/planning`);
    expect(body.workOrder.rawMaterials[0].requiredPerUnit).toBe(200);   // 2 m → 200 cm
  });
});

/* ═══ 4 · PUT /:id/allocate-raw-materials ═════════════════════════════════ */

describe("PUT /:id/allocate-raw-materials", () => {
  test("a full-quantity allocation sets planned and allocates against stock", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });
    const res = await allocate(wo, { quantity: 10 });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.status).toBe("planned");
    expect(after.rawMaterials[0].quantityAllocated).toBe(20);
    expect(after.rawMaterials[0].allocationStatus).toBe("fully_allocated");
  });

  test("a reduced quantity without splitting sets partial_allocation", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    await allocate(wo, { quantity: 6 });

    const after = await reload(wo);
    expect(after.status).toBe("partial_allocation");
    expect(after.quantity).toBe(6);
    expect(after.originalQuantity).toBe(10);
  });

  test("quantity bounds are enforced", async () => {
    const wo = await workOrder({ quantity: 10 });
    expect((await allocate(wo, { quantity: 0 })).status).toBe(400);
    expect((await allocate(wo, { quantity: -1 })).status).toBe(400);
    expect((await allocate(wo, { quantity: 11 })).status).toBe(400);
  });

  test("short stock produces a partial allocation rather than a refusal", async () => {
    // Store remains authoritative: the work order records what it COULD get.
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 5 });
    const res = await allocate(wo, { quantity: 10 });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.rawMaterials[0].quantityRequired).toBe(20);
    expect(after.rawMaterials[0].quantityAllocated).toBe(5);
    expect(after.rawMaterials[0].allocationStatus).toBe("partially_allocated");
  });

  // CHARACTERISATION — UNSAFE.
  // The route computes `canProduceQuantity` across every material and then
  // NEVER READS IT. A caller may allocate 10 units against stock for 2; the
  // computed limit is discarded and the work order is written as though the
  // quantity were achievable.
  test("CHARACTERISATION — UNSAFE: the computed producible limit is not enforced", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 4 });   // supports 2 units
    const res = await allocate(wo, { quantity: 10 });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.quantity).toBe(10);            // accepted in full
    expect(after.status).toBe("planned");       // and called "planned"
    expect(after.rawMaterials[0].quantityAllocated).toBe(4);   // though only 4 exist
  });

  /* ── FIXED in Chunk 4A.1 — regression, not characterisation ───────────────
     `quantity` is now accepted only as a finite JSON number greater than zero
     and no greater than the work order's current quantity. Everything else is
     a controlled 400 that writes nothing.

     Before the fix these three tests recorded three different broken outcomes:
     a 500 for strings and objects, a silent reduction to 1 unit for `true`,
     and — worst — an omitted quantity UNSETTING the stored quantity while
     returning 200. */

  test("REGRESSION: every malformed quantity is a controlled 400 that writes nothing", async () => {
    const malformed = [
      ["omitted", undefined],
      ["null", null],
      ["true", true],
      ["false", false],
      ["numeric string", "5"],
      ["arbitrary string", "abc"],
      ["array", [5]],
      ["empty array", []],
      ["object", { value: 5 }],
      ["zero", 0],
      ["negative", -1],
      ["above current quantity", 11],
    ];

    for (const [label, bad] of malformed) {
      const wo = await workOrder({ quantity: 10, perUnit: 2 });
      const before = await reload(wo);

      const res = await allocate(wo, bad === undefined ? {} : { quantity: bad });

      expect({ label, status: res.status }).toEqual({ label, status: 400 });
      expect(res.body.success).toBe(false);

      // Nothing moved: quantity, basis, status, notes, materials, children.
      const after = await reload(wo);
      expect({ label, q: after.quantity }).toEqual({ label, q: before.quantity });
      expect(after.originalQuantity).toBe(before.originalQuantity);
      expect(after.status).toBe(before.status);
      expect(after.planningNotes).toBe(before.planningNotes);
      expect(after.rawMaterials[0].quantityRequired).toBe(before.rawMaterials[0].quantityRequired);
      expect(after.rawMaterials[0].quantityAllocated).toBe(before.rawMaterials[0].quantityAllocated);
      expect(after.rawMaterials[0].allocationStatus).toBe(before.rawMaterials[0].allocationStatus);
      expect(await WorkOrder.countDocuments({ parentWorkOrderId: wo._id })).toBe(0);
    }
  });

  test("REGRESSION: a rejected split request creates no child", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const res = await allocate(wo, { quantity: "6", splitRemaining: true });

    expect(res.status).toBe(400);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: wo._id })).toBe(0);
  });

  test("REGRESSION: a valid integer quantity still succeeds", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const res = await allocate(wo, { quantity: 6 });

    expect(res.status).toBe(200);
    expect((await reload(wo)).quantity).toBe(6);
  });

  test("REGRESSION: a fractional quantity is still accepted", async () => {
    // No durable contract forbids fractional quantities — the schema says
    // `min: 1`, not `integer` — so the fix must not quietly introduce one.
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const res = await allocate(wo, { quantity: 2.5 });

    expect(res.status).toBe(200);
    expect((await reload(wo)).quantity).toBe(2.5);
  });

  test("REGRESSION: exactly the current quantity is accepted", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    expect((await allocate(wo, { quantity: 10 })).status).toBe(200);
  });

  test("REGRESSION: a work order with no usable stored quantity is refused safely", async () => {
    // The state defect #3 used to CREATE. Allocation must not try to divide by
    // it, and must not invent a replacement.
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    await WorkOrder.collection.updateOne({ _id: wo._id }, { $unset: { quantity: "" } });

    const res = await allocate(wo, { quantity: 5 });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    const after = await reload(wo);
    expect(after.quantity).toBeUndefined();      // still unset, not invented
    expect(after.status).toBe("pending");
  });

  /* ── FIXED in Chunk 4A.1 ──────────────────────────────────────────────────
     The per-unit basis is now taken from the work order's CURRENT
     pre-mutation quantity, not from `originalQuantity` against an
     already-rescaled requirement. Replaying is a no-op; a genuine later
     reduction scales from the stable current basis. */

  test("REGRESSION: replaying an identical allocation does not shrink the requirement", async () => {
    const wo = await workOrder({ quantity: 100, perUnit: 1, stock: 1000000 });  // 100 required

    await allocate(wo, { quantity: 60 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBe(60);

    await allocate(wo, { quantity: 60 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBe(60);

    await allocate(wo, { quantity: 60 });
    const after = await reload(wo);
    expect(after.rawMaterials[0].quantityRequired).toBe(60);
    expect(after.quantity).toBe(60);
    expect(after.originalQuantity).toBe(100);
  });

  test("REGRESSION: a genuine later reduction scales from the current basis", async () => {
    const wo = await workOrder({ quantity: 100, perUnit: 1, stock: 1000000 });

    await allocate(wo, { quantity: 60 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBe(60);

    // 1 unit of material per produced unit throughout — 30 units needs 30.
    await allocate(wo, { quantity: 30 });
    const after = await reload(wo);
    expect(after.rawMaterials[0].quantityRequired).toBe(30);
    expect(after.quantity).toBe(30);

    await allocate(wo, { quantity: 30 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBe(30);
  });

  test("REGRESSION: a non-integral per-unit basis survives replay", async () => {
    const wo = await workOrder({ quantity: 8, perUnit: 2.5, stock: 1000000 });  // 20 required

    await allocate(wo, { quantity: 6 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBeCloseTo(15, 6);

    await allocate(wo, { quantity: 6 });
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBeCloseTo(15, 6);
  });

  // CHARACTERISATION — UNSAFE.
  // Allocation rewrites `status` from whatever it was, with no transition
  // guard. A work order already in production, or completed, is silently
  // returned to "planned".
  test("CHARACTERISATION — UNSAFE: allocation accepts any starting state and resets it", async () => {
    for (const from of ["in_progress", "completed", "cancelled", "forwarded", "scheduled"]) {
      const wo = await workOrder({ quantity: 10, status: from });
      const res = await allocate(wo, { quantity: 10 });

      expect(res.status).toBe(200);
      expect((await reload(wo)).status).toBe("planned");
    }
  });

  test("planning does NOT deduct or reserve stock — Store stays authoritative", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });
    const before = await RawItem.findById(wo.rawMaterials[0].rawItemId).lean();

    await allocate(wo, { quantity: 10 });

    const after = await RawItem.findById(wo.rawMaterials[0].rawItemId).lean();
    expect(after.quantity).toBe(before.quantity);
    // The only record of intent lives on the work order.
    expect((await reload(wo)).rawMaterials[0].quantityAllocated).toBe(20);
  });
});

/* ═══ 5 · SPLIT ALLOCATION ════════════════════════════════════════════════ */

describe("split allocation", () => {
  test("splitting creates one child work order for the remainder", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const res = await allocate(wo, { quantity: 6, splitRemaining: true });

    expect(res.body.splitCreated).toBe(true);
    expect(res.body.remainingQuantity).toBe(4);

    const children = await WorkOrder.find({ parentWorkOrderId: wo._id }).lean();
    expect(children).toHaveLength(1);
    expect(children[0].quantity).toBe(4);
    expect(children[0].isSplitOrder).toBe(true);
    expect(children[0].status).toBe("pending");
  });

  // DISPROVEN SUSPICION — recorded because it was suspected and is not true.
  // Replaying an identical split does NOT create a second child: the first
  // call set workOrder.quantity = quantity, so `remainingQuantity` is 0 on the
  // replay and the split branch is skipped. The requirement-shrinking defect
  // above still applies to the parent.
  test("replaying an identical split does NOT create a second child", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });

    await allocate(wo, { quantity: 6, splitRemaining: true });
    const first = await WorkOrder.countDocuments({ parentWorkOrderId: wo._id });

    const replay = await allocate(wo, { quantity: 6, splitRemaining: true });

    expect(replay.status).toBe(200);
    expect(replay.body.splitCreated).toBe(false);
    expect(replay.body.remainingQuantity).toBe(0);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: wo._id })).toBe(first);
  });

  /* ── FIXED in Chunk 4A.1, generalised in 4A.2 ─────────────────────────────
     Before the fix, children were saved with NO number. `workOrderNumber` is
     uniquely and non-sparsely indexed, so the first child anywhere stored
     `null` and every later split — any work order, any user — died on E11000.

     4A.1 assigned a number on the split path alone. 4A.2 moved the rule to the
     WorkOrder model's pre-validate hook and settled on ONE format for every
     newly created record — `WO-<full 24-character ObjectId>` — so the split
     path no longer assigns anything itself and the two Sales generators and
     both return/rework generators are covered by the same invariant.
     See test/project-manager/work-order-identity.test.js. */

  test("REGRESSION: two unrelated work orders can both be split", async () => {
    const first = await workOrder({ quantity: 10, perUnit: 2 });
    const second = await workOrder({ quantity: 10, perUnit: 2 });

    const a = await allocate(first, { quantity: 6, splitRemaining: true });
    const b = await allocate(second, { quantity: 4, splitRemaining: true });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.splitCreated).toBe(true);
    expect(b.body.splitCreated).toBe(true);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: first._id })).toBe(1);
    expect(await WorkOrder.countDocuments({ parentWorkOrderId: second._id })).toBe(1);
  });

  test("REGRESSION: every split child has a non-empty, unique number", async () => {
    const parents = [];
    for (let i = 0; i < 4; i++) parents.push(await workOrder({ quantity: 10, perUnit: 2 }));
    for (const p of parents) expect((await allocate(p, { quantity: 6, splitRemaining: true })).status).toBe(200);

    const children = await WorkOrder.find({ isSplitOrder: true }).lean();
    expect(children).toHaveLength(4);

    const numbers = children.map((c) => c.workOrderNumber);
    for (const n of numbers) {
      expect(typeof n).toBe("string");
      expect(n.length).toBeGreaterThan(0);
    }
    expect(new Set(numbers).size).toBe(4);
  });

  test("REGRESSION: the response reports the child's real stored number", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const res = await allocate(wo, { quantity: 6, splitRemaining: true });

    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();
    expect(res.body.newWorkOrder.workOrderNumber).toBe(child.workOrderNumber);
    expect(res.body.newWorkOrder._id).toBe(String(child._id));
  });

  test("REGRESSION: the child carries the canonical model-level number", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    await allocate(wo, { quantity: 6, splitRemaining: true });
    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();

    // The canonical model-level identity — the full ObjectId, not a
    // truncation of it.
    expect(child.workOrderNumber).toBe(`WO-${child._id.toString()}`);
    expect(child.workOrderNumber).toMatch(/^WO-[0-9a-f]{24}$/);
  });

  test("REGRESSION: the generated number is not mistaken for a unit barcode", async () => {
    // Every barcode parser in the codebase requires `parts.length >= 3 &&
    // parts[0] === "WO"` (10 call sites, e.g. workOrderRoutes.js:66,
    // productionCompletionRoutes.js:14). A child number has exactly two parts,
    // so it can never be parsed as a scan.
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    await allocate(wo, { quantity: 6, splitRemaining: true });
    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();

    const parts = child.workOrderNumber.split("-");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("WO");
    expect(parts.length >= 3).toBe(false);

    // …and the unit barcode built from the same short id still parses.
    const barcode = `${child.workOrderNumber}-001`;
    const bParts = barcode.split("-");
    expect(bParts.length >= 3 && bParts[0] === "WO").toBe(true);
    expect(bParts[1]).toBe(child._id.toString());

    // The cutting route's normaliser leaves it alone (already WO-prefixed).
    expect(child.workOrderNumber.startsWith("WO-")).toBe(true);
  });

  test("REGRESSION: split lineage and the parent's own number are preserved", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2 });
    const parentNumber = wo.workOrderNumber;

    await allocate(wo, { quantity: 6, splitRemaining: true });

    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();
    expect(String(child.parentWorkOrderId)).toBe(String(wo._id));
    expect(child.isSplitOrder).toBe(true);
    expect(child.splitReason).toBe("Split due to raw material allocation");
    expect(child.quantity).toBe(4);
    expect(child.status).toBe("pending");
    expect((await reload(wo)).workOrderNumber).toBe(parentNumber);
  });

});

/* ═══ 6 · PUT /:id/plan-operations ════════════════════════════════════════ */

describe("PUT /:id/plan-operations", () => {
  test("planned time and notes are written and the operation is marked scheduled", async () => {
    const wo = await workOrder();
    const opId = String(wo.operations[0]._id);

    const res = await planOps(wo, { operations: [{ _id: opId, plannedTimeSeconds: 900, notes: "double seam" }] });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    const op = after.operations.find((o) => String(o._id) === opId);
    expect(op.plannedTimeSeconds).toBe(900);
    expect(op.notes).toBe("double seam");
    expect(op.status).toBe("scheduled");
  });

  test("an empty operations array is accepted and changes nothing", async () => {
    const wo = await workOrder();
    const res = await planOps(wo, { operations: [] });

    expect(res.status).toBe(200);
    expect((await reload(wo)).operations[0].status).toBe("pending");
  });

  // CHARACTERISATION — UNSAFE.
  // `for (const opUpdate of operations)` iterates the body directly. Anything
  // not iterable throws a TypeError and is reported as a 500.
  test("CHARACTERISATION — UNSAFE: a non-array operations value is a 500, not a 400", async () => {
    const wo = await workOrder();
    for (const bad of [undefined, null, 5, { _id: "x" }]) {
      const res = await planOps(wo, { operations: bad });
      expect(res.status).toBe(500);
    }
  });

  // CHARACTERISATION — UNSAFE.
  // A STRING is iterable, so it does not throw: the loop walks its characters,
  // each of which has no `_id`, every lookup misses, and the caller is told
  // "Operations confirmed successfully" having changed nothing.
  test("CHARACTERISATION — UNSAFE: a string operations value reports success and does nothing", async () => {
    const wo = await workOrder();
    const res = await planOps(wo, { operations: "abc" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Operations confirmed successfully");
    expect((await reload(wo)).operations.every((o) => o.status === "pending")).toBe(true);
  });

  // CHARACTERISATION — UNSAFE.
  // An id that matches no operation is skipped with `continue`, and the
  // response is a 200 saying "Operations confirmed successfully". A caller
  // sending a stale or wrong plan is told it was applied.
  test("CHARACTERISATION — UNSAFE: unknown operation ids are silently skipped", async () => {
    const wo = await workOrder();
    const res = await planOps(wo, {
      operations: [{ _id: String(new mongoose.Types.ObjectId()), plannedTimeSeconds: 900 }],
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe("Operations confirmed successfully");
    const after = await reload(wo);
    expect(after.operations.every((o) => o.status === "pending")).toBe(true);
  });

  // CHARACTERISATION — UNSAFE.
  // Partial application: a body mixing one real and one unknown id applies the
  // real one and reports success for both.
  test("CHARACTERISATION — UNSAFE: a mixed valid/unknown body is applied partially and reported as success", async () => {
    const wo = await workOrder();
    const realId = String(wo.operations[0]._id);

    const res = await planOps(wo, {
      operations: [
        { _id: realId, plannedTimeSeconds: 300 },
        { _id: String(new mongoose.Types.ObjectId()), plannedTimeSeconds: 900 },
      ],
    });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.operations.find((o) => String(o._id) === realId).plannedTimeSeconds).toBe(300);
    expect(after.operations.filter((o) => o.status === "scheduled")).toHaveLength(1);
  });

  // CHARACTERISATION — UNSAFE.
  // `opUpdate.plannedTimeSeconds || operation.plannedTimeSeconds || 0` — an
  // explicit 0 is falsy, so "this operation takes no time" cannot be recorded.
  // The previous value silently survives.
  test("CHARACTERISATION — UNSAFE: an explicit zero duration cannot be stored", async () => {
    const wo = await workOrder();
    const opId = String(wo.operations[0]._id);
    await planOps(wo, { operations: [{ _id: opId, plannedTimeSeconds: 900 }] });

    await planOps(wo, { operations: [{ _id: opId, plannedTimeSeconds: 0 }] });

    const after = await reload(wo);
    expect(after.operations.find((o) => String(o._id) === opId).plannedTimeSeconds).toBe(900);
  });

  // CHARACTERISATION — UNSAFE.
  // `if (totalPlannedSeconds)` — a legitimate total of 0 is discarded.
  test("CHARACTERISATION — UNSAFE: a zero totalPlannedSeconds is discarded", async () => {
    const wo = await workOrder();
    await planOps(wo, { operations: [], totalPlannedSeconds: 500 });
    expect((await reload(wo)).timeline.totalPlannedSeconds).toBe(500);

    await planOps(wo, { operations: [], totalPlannedSeconds: 0 });
    expect((await reload(wo)).timeline.totalPlannedSeconds).toBe(500);
  });

  test("duplicate operation ids apply the last value, not a doubled one", async () => {
    const wo = await workOrder();
    const opId = String(wo.operations[0]._id);

    await planOps(wo, {
      operations: [
        { _id: opId, plannedTimeSeconds: 300 },
        { _id: opId, plannedTimeSeconds: 700 },
      ],
    });

    expect((await reload(wo)).operations.find((o) => String(o._id) === opId).plannedTimeSeconds).toBe(700);
  });

  // CHARACTERISATION — UNSAFE.
  // No transition guard: operations may be re-planned on a work order that is
  // already in production or completed.
  test("CHARACTERISATION — UNSAFE: operations may be re-planned in any state", async () => {
    const wo = await workOrder({ status: "in_progress" });
    const res = await planOps(wo, { operations: [{ _id: String(wo.operations[0]._id), plannedTimeSeconds: 42 }] });

    expect(res.status).toBe(200);
    expect((await reload(wo)).operations[0].plannedTimeSeconds).toBe(42);
  });
});

/* ═══ 7 · POST /:id/complete-planning ═════════════════════════════════════ */

describe("POST /:id/complete-planning", () => {
  test("it records who planned, when, and moves the work order to scheduled", async () => {
    const wo = await workOrder();
    const res = await complete(wo, { planningNotes: "ready" });

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.status).toBe("scheduled");
    expect(after.plannedAt).toBeTruthy();
    expect(after.plannedBy).toBeTruthy();
    expect(after.planningNotes).toBe("ready");
  });

  // CHARACTERISATION — UNSAFE.
  // The handler performs NO validation of any kind. Planning can be declared
  // complete on a work order with unallocated materials and unplanned
  // operations — the state that "scheduled" is supposed to rule out.
  test("CHARACTERISATION — UNSAFE: planning completes with nothing allocated and nothing planned", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 0 });

    const res = await complete(wo);

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.status).toBe("scheduled");
    expect(after.rawMaterials[0].allocationStatus).toBe("not_allocated");
    expect(after.rawMaterials[0].quantityAllocated).toBe(0);
    expect(after.operations.every((o) => o.status === "pending")).toBe(true);
  });

  // CHARACTERISATION — UNSAFE.
  // `workOrder.status = "scheduled"` is unconditional, so a completed or
  // cancelled work order is dragged back into the schedule.
  test("CHARACTERISATION — UNSAFE: completing planning accepts and overwrites any state", async () => {
    for (const from of ["pending", "planned", "in_progress", "completed", "cancelled", "forwarded"]) {
      const wo = await workOrder({ status: from });
      const res = await complete(wo);

      expect(res.status).toBe(200);
      expect((await reload(wo)).status).toBe("scheduled");
    }
  });

  // CHARACTERISATION — UNSAFE.
  // A replay overwrites plannedAt and plannedBy, so the record of when
  // planning was actually finished — and by whom — is destroyed by any repeat.
  test("CHARACTERISATION — UNSAFE: replaying completion replaces the original timestamp and planner", async () => {
    const wo = await workOrder();
    const first = token({ email: "first@t.example" });
    await call(`/${wo._id}/complete-planning`, { method: "POST", body: {}, tok: first });
    const once = await reload(wo);

    await new Promise((r) => setTimeout(r, 5));
    await complete(wo);
    const twice = await reload(wo);

    expect(new Date(twice.plannedAt).getTime()).toBeGreaterThan(new Date(once.plannedAt).getTime());
    expect(String(twice.plannedBy)).not.toBe(String(once.plannedBy));
  });

  test("planningNotes are preserved when the replay omits them", async () => {
    const wo = await workOrder();
    await complete(wo, { planningNotes: "first pass" });
    await complete(wo, {});
    expect((await reload(wo)).planningNotes).toBe("first pass");
  });
});

/* ═══ 8 · POST /:id/start-production ══════════════════════════════════════ */

describe("POST /:id/start-production", () => {
  test("it refuses unless the state is scheduled or ready_to_start", async () => {
    for (const from of ["pending", "planned", "partial_allocation", "in_progress", "completed", "cancelled"]) {
      const wo = await workOrder({ status: from, withRaw: false });
      const res = await startProd(wo);
      expect(res.status).toBe(400);
    }
  });

  test("it refuses while any raw material is not issued", async () => {
    const wo = await workOrder({ status: "scheduled" });
    await allocate(wo, { quantity: 10 });          // fully_allocated, NOT issued
    const res = await startProd(wo);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/raw materials are fully issued/i);
  });

  test("it starts once every material is issued", async () => {
    const wo = await workOrder({ status: "scheduled", timeline: true });
    await WorkOrder.updateOne(
      { _id: wo._id },
      { $set: { "rawMaterials.$[].allocationStatus": "issued" } },
    );

    const res = await startProd(wo);

    expect(res.status).toBe(200);
    const after = await reload(wo);
    expect(after.status).toBe("in_progress");
    expect(after.timeline.actualStartDate).toBeTruthy();
    expect(after.operations.every((o) => o.status === "pending")).toBe(true);
  });

  // CHARACTERISATION — UNSAFE.
  // `workOrder.timeline.actualStartDate = new Date()` dereferences a
  // subdocument that has no schema default. `timeline: timelineSchema` is
  // undefined on any work order created without one, so the assignment throws
  // and the caller gets a 500 with no usable message. The main generator
  // (quotationRoutes) does set a timeline, so this is latent rather than
  // routine — but nothing in the model or the route enforces it.
  test("CHARACTERISATION — UNSAFE: start-production 500s when the timeline subdocument is absent", async () => {
    const wo = await workOrder({ status: "scheduled" });          // no timeline
    expect((await reload(wo)).timeline).toBeUndefined();
    await WorkOrder.updateOne({ _id: wo._id }, { $set: { "rawMaterials.$[].allocationStatus": "issued" } });

    const res = await startProd(wo);

    expect(res.status).toBe(500);
    expect((await reload(wo)).status).toBe("scheduled");           // nothing written
  });

  // CHARACTERISATION — worth a decision, not obviously a defect.
  // A work order with NO raw materials passes the issuance check vacuously
  // (`[].some(...)` is false), so it can start with nothing issued.
  test("CHARACTERISATION: a work order with no raw materials starts unconditionally", async () => {
    const wo = await workOrder({ status: "scheduled", withRaw: false, timeline: true });
    const res = await startProd(wo);

    expect(res.status).toBe(200);
    expect((await reload(wo)).status).toBe("in_progress");
  });

  // CHARACTERISATION — UNSAFE.
  // start-production resets every operation to "pending", discarding the
  // "scheduled" marks plan-operations wrote moments earlier.
  test("CHARACTERISATION — UNSAFE: starting production discards the operation planning marks", async () => {
    const wo = await workOrder({ status: "scheduled", timeline: true });
    await planOps(wo, { operations: [{ _id: String(wo.operations[0]._id), plannedTimeSeconds: 300 }] });
    expect((await reload(wo)).operations[0].status).toBe("scheduled");

    await WorkOrder.updateOne({ _id: wo._id }, { $set: { "rawMaterials.$[].allocationStatus": "issued", status: "scheduled" } });
    await startProd(wo);

    const after = await reload(wo);
    expect(after.operations[0].status).toBe("pending");
    expect(after.operations[0].plannedTimeSeconds).toBe(300);   // the time survives
  });
});

/* ═══ 9 · THE THREE-STEP SEQUENCE AND ITS PARTIAL FAILURES ════════════════ */

describe("the three-step planning sequence", () => {
  test("the happy path leaves a scheduled, allocated, operation-planned work order", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });

    expect((await allocate(wo, { quantity: 10 })).status).toBe(200);
    expect((await planOps(wo, { operations: [{ _id: String(wo.operations[0]._id), plannedTimeSeconds: 300 }] })).status).toBe(200);
    expect((await complete(wo)).status).toBe(200);

    const after = await reload(wo);
    expect(after.status).toBe("scheduled");
    expect(after.rawMaterials[0].allocationStatus).toBe("fully_allocated");
    expect(after.plannedAt).toBeTruthy();
  });

  // CHARACTERISATION — UNSAFE.
  // The frontend runs three independent requests and throws on the first
  // failure, with no compensation. Stopping after step 1 leaves a work order
  // whose quantity has already been reduced and whose materials are allocated,
  // in "planned"/"partial_allocation", with no marker that planning was
  // abandoned. Nothing distinguishes it from a plan still in progress.
  test("CHARACTERISATION — UNSAFE: stopping after allocation leaves a silently half-planned order", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });

    await allocate(wo, { quantity: 6, splitRemaining: true });
    // steps 2 and 3 never happen

    const after = await reload(wo);
    expect(after.status).toBe("partial_allocation");
    expect(after.quantity).toBe(6);                                  // already changed
    expect(after.rawMaterials[0].allocationStatus).toBe("fully_allocated");
    expect(after.operations.every((o) => o.status === "pending")).toBe(true);
    expect(after.plannedAt == null).toBe(true);
    // And the child work order exists regardless — now with a real number.
    const child = await WorkOrder.findOne({ parentWorkOrderId: wo._id }).lean();
    expect(child).toBeTruthy();
    expect(child.workOrderNumber).toMatch(/^WO-[0-9a-f]{24}$/);
  });

  // CHARACTERISATION — UNSAFE.
  // Stopping after step 2 leaves operations marked "scheduled" on a work order
  // that is NOT scheduled — the operation vocabulary and the work-order
  // vocabulary disagree, and only the missing plannedAt hints at it.
  test("CHARACTERISATION — UNSAFE: stopping after operation planning leaves scheduled operations on an unscheduled order", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 2, stock: 1000 });

    await allocate(wo, { quantity: 10 });
    await planOps(wo, { operations: [{ _id: String(wo.operations[0]._id), plannedTimeSeconds: 300 }] });
    // step 3 never happens

    const after = await reload(wo);
    expect(after.status).toBe("planned");
    expect(after.operations[0].status).toBe("scheduled");
    expect(after.plannedAt == null).toBe(true);
  });

  // REGRESSION (Chunk 4A.1).
  // Re-running the whole sequence is exactly what a user does after a failed
  // attempt. Step 1 is now idempotent, so the requirement survives it — though
  // the sequence as a whole is still three unguarded requests, and everything
  // else in this section remains characterisation of unsafe behaviour.
  test("REGRESSION: retrying the whole sequence no longer corrupts the material requirement", async () => {
    const wo = await workOrder({ quantity: 10, perUnit: 10, stock: 100000 });

    for (let attempt = 0; attempt < 2; attempt++) {
      await allocate(wo, { quantity: 10 });
      await planOps(wo, { operations: [] });
      await complete(wo);
    }
    expect((await reload(wo)).rawMaterials[0].quantityRequired).toBe(100);

    const wo2 = await workOrder({ quantity: 10, perUnit: 10, stock: 100000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      await allocate(wo2, { quantity: 5 });
      await complete(wo2);
    }
    expect((await reload(wo2)).rawMaterials[0].quantityRequired).toBe(50);   // stable
  });
});

/* ═══ 10 · QUERY COUNT ════════════════════════════════════════════════════ */

describe("query behaviour", () => {
  // CHARACTERISATION — UNSAFE (performance).
  // GET /:id/planning issues one RawItem.findById per material inside a
  // Promise.all map, plus up to two Unit.findOne per material through
  // convertQuantity (which is called WITHOUT the batching unitMap here).
  // allocate-raw-materials already batches both; this read does not.
  test("CHARACTERISATION — UNSAFE: GET /:id/planning is N+1 in raw items", async () => {
    const wo = await workOrder({ quantity: 10, withRaw: false });
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await rawItem());
    await WorkOrder.updateOne({ _id: wo._id }, {
      $set: {
        rawMaterials: items.map((ri) => ({
          rawItemId: ri._id, name: ri.name, sku: ri.sku, unit: "m",
          quantityRequired: 20, quantityAllocated: 0, quantityIssued: 0,
          unitCost: 10, totalCost: 200, allocationStatus: "not_allocated",
        })),
      },
    });

    let rawItemFinds = 0;
    mongoose.set("debug", (coll, method) => {
      if (coll === "rawitems" && method === "findOne") rawItemFinds++;
    });
    await call(`/${wo._id}/planning`);
    mongoose.set("debug", false);

    // One per material — not one batched $in query.
    expect(rawItemFinds).toBe(5);
  });

  test("allocate-raw-materials batches its raw-item and unit reads", async () => {
    const wo = await workOrder({ quantity: 10, withRaw: false });
    const items = [];
    for (let i = 0; i < 5; i++) items.push(await rawItem());
    await WorkOrder.updateOne({ _id: wo._id }, {
      $set: {
        rawMaterials: items.map((ri) => ({
          rawItemId: ri._id, name: ri.name, sku: ri.sku, unit: "m",
          quantityRequired: 20, quantityAllocated: 0, quantityIssued: 0,
          unitCost: 10, totalCost: 200, allocationStatus: "not_allocated",
        })),
      },
    });

    let rawItemQueries = 0;
    mongoose.set("debug", (coll, method) => {
      if (coll === "rawitems" && (method === "find" || method === "findOne")) rawItemQueries++;
    });
    await allocate(wo, { quantity: 10 });
    mongoose.set("debug", false);

    expect(rawItemQueries).toBe(1);
  });
});
