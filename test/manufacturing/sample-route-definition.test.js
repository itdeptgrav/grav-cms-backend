// test/manufacturing/sample-route-definition.test.js
//
// R&D DEFINES THE SAMPLE'S OPERATION ROUTE, BEFORE ANYTHING IS RELEASED.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// The release now refuses a product with no operations — correctly, because a
// work order routed through nothing has nothing to progress through, nothing to
// scan against and nothing to inspect. But R&D had no action that could clear
// the refusal: the only way to add an operation was a per-operation endpoint
// taking free-text `type` and `machineType`, which cannot express an order and
// matches on spelling.
//
// So the route is chosen from the operation master BY IDENTITY, in the order
// given, and saved whole. No rate is entered anywhere: R&D says which
// operations and in what sequence, and what an operator minute costs stays the
// company policy's, read at costing time.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const Account = require("../../models/CMS_Models/Sales/Account");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, user } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A company, a member, a style, and the product it is registered as. */
async function world({ withProduct = true } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Route ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `route-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "R", lastName: `L${n}`, email, biometricId: `RT${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });

  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-RT-${n}`, companyId: co._id, name: `Journey ${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const product = withProduct
    ? await StockItem.create({
      name: "Soumya Tshirt", reference: `PROD-SHI-SOUTSH-${n}`, category: "Shirt",
      operations: [], createdBy: emp._id,
      /* One variant with its own SKU: `variants.sku` is uniquely indexed, so
         two products with an empty variant list collide on a null key. */
      variants: [{ sku: `PROD-${n}-V1`, attributes: [], quantity: 0, cost: 0, salesPrice: 0 }],
    })
    : null;
  const style = await SampleStyle.create({
    sampleStyleId: `SS-2026-${String(n).padStart(4, "0")}`, styleCode: `SC-${n}`,
    productName: "Soumya Tshirt", journeyId: journey._id, companyId: co._id,
    materials: { rawItems: [] },
    ...(product ? { production: { stockItemId: product._id } } : {}),
  });
  return {
    co, style, product,
    user: { id: String(emp._id), name: "R", role: "sales" },
  };
}

/** Three operations in the master, deliberately out of alphabetical order. */
async function master() {
  const n = ++seq;
  const [collar, side, hem] = await Operation.create([
    { name: "Collar attach", operationCode: `OP-COL-${n}`, totalSam: 1.5, durationSeconds: 90, machineType: "SNLS" },
    { name: "Side seam", operationCode: `OP-SID-${n}`, totalSam: 2, durationSeconds: 120, machineType: "Overlock" },
    { name: "Bottom hem", operationCode: `OP-HEM-${n}`, totalSam: 1, durationSeconds: 60, machineType: "Flatlock" },
  ]);
  return { collar, side, hem };
}

/* ═══ 1 · CHOOSING FROM THE MASTER, BY IDENTITY ═══════════════════════════ */

describe("the routing picker", () => {
  test("it offers the master's operations with their code, machine and SAM — and no money", async () => {
    const w = await world();
    const { collar } = await master();
    const r = await call(`/${w.style._id}/operations/search?q=Collar`, { user: w.user });
    expect(r.status).toBe(200);

    const row = r.body.operations.find((o) => o.id === String(collar._id));
    expect(row).toMatchObject({
      name: "Collar attach",
      machineType: "SNLS",
      totalSam: 1.5,
    });
    expect(row.operationCode).toMatch(/^OP-COL-/);
    /* ── R&D IS NEVER ASKED FOR A RATE ────────────────────────────────
       What an operator minute costs is the company's own assumption, read
       from policy at costing time. A figure entered here would be a second,
       undated answer. */
    expect(JSON.stringify(r.body)).not.toMatch(/salary|rate|cost|₹/i);
  });

  test("a style this company cannot prove answers nothing", async () => {
    const mine = await world();
    const theirs = await world();
    const r = await call(`/${theirs.style._id}/operations/search?q=Collar`, { user: mine.user });
    /* Missing and foreign are one answer. */
    expect(r.status).toBe(404);
  });
});

/* ═══ 2 · SAVING THE ROUTE, IN ORDER ══════════════════════════════════════ */

describe("saving a draft sample route", () => {
  test("the order asked for is the order stored", async () => {
    /* ── A ROUTE IS A SEQUENCE ────────────────────────────────────────
       Collar before side seam before hem. The old per-operation endpoint
       could only append, so a reorder was impossible to express. */
    const w = await world();
    const { collar, side, hem } = await master();
    const r = await call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user,
      body: { operationIds: [String(collar._id), String(side._id), String(hem._id)] },
    });
    expect(r.status).toBe(200);
    expect(r.body.operations.map((o) => o.name)).toEqual(["Collar attach", "Side seam", "Bottom hem"]);
    expect(r.body.operations.map((o) => o.position)).toEqual([1, 2, 3]);

    const stored = await StockItem.findById(w.product._id).lean();
    expect(stored.operations.map((o) => o.type)).toEqual(["Collar attach", "Side seam", "Bottom hem"]);
    /* SAM becomes the planned seconds the work order carries. */
    expect(stored.operations[0].totalSeconds).toBe(90);
    /* And no rate was written. */
    expect(stored.operations.every((o) => !o.operatorCost && !o.operatorSalary)).toBe(true);
  });

  test("reordering replaces the route rather than appending to it", async () => {
    const w = await world();
    const { collar, side, hem } = await master();
    const put = (ids) => call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user, body: { operationIds: ids.map(String) },
    });
    await put([collar._id, side._id, hem._id]);
    const again = await put([hem._id, collar._id]);
    expect(again.status).toBe(200);

    const stored = await StockItem.findById(w.product._id).lean();
    /* Two operations, in the new order — not five. */
    expect(stored.operations.map((o) => o.type)).toEqual(["Bottom hem", "Collar attach"]);
  });

  test("names, codes and times come from the master, whatever was sent", async () => {
    /* A snapshot a caller can dictate is not a snapshot. */
    const w = await world();
    const { collar } = await master();
    await call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user,
      body: {
        operationIds: [String(collar._id)],
        operations: [{ type: "Something else", totalSeconds: 99999, operatorCost: 500 }],
      },
    });
    const stored = await StockItem.findById(w.product._id).lean();
    expect(stored.operations[0].type).toBe("Collar attach");
    expect(stored.operations[0].totalSeconds).toBe(90);
    expect(stored.operations[0].operatorCost).toBe(0);
  });

  test("an empty route is refused — it is the state the guard exists to stop", async () => {
    const w = await world();
    const r = await call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user, body: { operationIds: [] },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("ROUTE_EMPTY");
    expect(r.body.message).toMatch(/routed through nothing cannot be produced or inspected/);
  });

  test("an operation that is not in the master is refused, not invented", async () => {
    const w = await world();
    const r = await call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user,
      body: { operationIds: [String(new mongoose.Types.ObjectId())] },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/no longer in the operation master/);
  });

  test("a style with no registered product says so, rather than failing obscurely", async () => {
    const w = await world({ withProduct: false });
    const { collar } = await master();
    const r = await call(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user, body: { operationIds: [String(collar._id)] },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("PRODUCT_NOT_REGISTERED");
  });

  test("another company's style cannot be routed", async () => {
    const mine = await world();
    const theirs = await world();
    const { collar } = await master();
    const r = await call(`/${theirs.style._id}/operations/route`, {
      method: "PUT", user: mine.user, body: { operationIds: [String(collar._id)] },
    });
    expect(r.status).toBe(404);
    const untouched = await StockItem.findById(theirs.product._id).lean();
    expect(untouched.operations).toHaveLength(0);
  });
});

/* ═══ 3 · AND A RELEASED ROUTE IS NOT REACHED FROM HERE ═══════════════════ */

test("re-routing the product does not touch a work order already released", async () => {
  /* ── THE FROZEN COPY IS THE GARMENT'S OWN ─────────────────────────────
     A work order carries its route from the moment it is created. Changing
     the product afterwards must never change what a garment already in
     production was routed through — the pieces on the floor were made to the
     old sequence. */
  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const w = await world();
  const { collar, side, hem } = await master();
  await call(`/${w.style._id}/operations/route`, {
    method: "PUT", user: w.user, body: { operationIds: [String(collar._id), String(side._id)] },
  });

  const released = await WorkOrder.create({
    workOrderNumber: `WO-FROZEN-${++seq}`,
    stockItemId: w.product._id,
    stockItemName: "Soumya Tshirt",
    quantity: 6,
    status: "in_progress",
    operations: [
      { operationType: "Collar attach", operationCode: "OP-COL", plannedTimeSeconds: 90, status: "pending" },
      { operationType: "Side seam", operationCode: "OP-SID", plannedTimeSeconds: 120, status: "pending" },
    ],
  });

  await call(`/${w.style._id}/operations/route`, {
    method: "PUT", user: w.user, body: { operationIds: [String(hem._id)] },
  });

  const after = await WorkOrder.findById(released._id).lean();
  expect(after.operations.map((o) => o.operationType)).toEqual(["Collar attach", "Side seam"]);
  /* The product moved on; the released garment did not. */
  const product = await StockItem.findById(w.product._id).lean();
  expect(product.operations.map((o) => o.type)).toEqual(["Bottom hem"]);
});
