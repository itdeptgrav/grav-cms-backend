// test/manufacturing/cancelled-sample-returns-to-rnd.test.js
//
// CANCELLING THE WORK ORDER IS ONLY HALF THE TRANSITION.
//
// ── WHAT THE WALKTHROUGH FOUND ──────────────────────────────────────────────
// The cancellation moved WO-4b1902bd to `cancelled` and stopped there. The
// STYLE stayed at `production.status: "submitted"`, which is what R&D's page
// reads to decide what to render — so it kept showing "Sent to production",
// kept hiding the operation-route panel, and told the reader to "Define the
// sample operation route in R&D" while making that panel unreachable. The
// instruction was right and the door was locked.
//
// ── WHAT IS PROVED HERE ─────────────────────────────────────────────────────
// The whole round trip, in the order a person walks it: cancel → the style
// reopens → R&D saves a route → a replacement order is created → and the
// replacement inherits nothing from the attempt that was cancelled.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

/* The R&D routes authenticate through Sales' middleware; the work-order router
   authenticates employees by JWT and is left exactly as it runs in production,
   because the cancellation's own authorisation is part of what is under test. */
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
const Customer = require("../../models/Customer_Models/Customer");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionCompletionScanRecord =
  require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const QCInspection = require("../../models/CMS_Models/Manufacturing/QC/DefectRecord");
const CuttingMasterRecord =
  require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const EmployeeProductionProgress =
  require("../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

let server, rnd, wos, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  app.use("/api/cms/manufacturing/work-orders",
    require("../../routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  const root = `http://127.0.0.1:${server.address().port}/api/cms`;
  rnd = `${root}/crm/sample-styles`;
  wos = `${root}/manufacturing/work-orders`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const asRnd = (path, { method = "GET", body, user } = {}) =>
  fetch(`${rnd}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const cancel = (id, token, reason = "Created before its product had an operation route.") =>
  fetch(`${wos}/${id}/cancel-unrouted`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ reason }),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/**
 * A style that has been sent to production: company, employee, customer,
 * registered product with two variants, order quantities set by Sales, and a
 * real submission through the release flow.
 *
 * `withOperations` decides whether the product has a route — the walkthrough's
 * style had none, which is how it stranded.
 */
async function sentToProduction({ withOperations = false } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Return ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `return-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "R", lastName: `L${n}`, email, biometricId: `RN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });

  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-RN-${n}`, companyId: co._id, name: `Journey ${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const customer = await Customer.create({
    name: `Buyer ${n}`, email: `buyer-${n}@test.com`, phone: `90000000${n}`,
  });

  const ops = withOperations
    ? [{ type: "Collar attach", operationCode: `OP-COL-${n}`, totalSeconds: 90 }]
    : [];
  const product = await StockItem.create({
    name: "Soumya Tshirt", reference: `PROD-SHI-SOUTSH-${n}`, category: "Shirt",
    operations: ops, createdBy: emp._id,
    variants: [
      { sku: `PROD-${n}-V1`, attributes: [{ name: "Size", value: "M" }], quantity: 0, cost: 0, salesPrice: 100 },
      { sku: `PROD-${n}-V2`, attributes: [{ name: "Size", value: "L" }], quantity: 0, cost: 0, salesPrice: 100 },
    ],
  });

  const style = await SampleStyle.create({
    sampleStyleId: `SS-2026-${String(1000 + n)}`, styleCode: `SC-${n}`,
    productName: "Soumya Tshirt", journeyId: journey._id, companyId: co._id,
    materials: { rawItems: [] },
    production: {
      status: "stock_item_linked",
      customerId: customer._id,
      stockItemId: product._id,
      orderVariants: product.variants.map((v, i) => ({
        variantId: v._id, variantLabel: i === 0 ? "M" : "L", sku: v.sku, quantity: 3,
      })),
    },
  });

  const user = { id: String(emp._id), name: "R", role: "sales" };
  const token = jwt.sign(
    { id: String(emp._id), email, name: "Walkthrough", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
  return { co, emp, customer, product, style, user, token, n };
}

/** Send it. Returns the created work orders, or the refusal. */
const release = (w) => asRnd(`/${w.style._id}/production/submit`, { method: "POST", body: {}, user: w.user });

/** A style that reached production with a routeless product — the live state. */
async function stranded() {
  const w = await sentToProduction({ withOperations: false });
  /* The release refuses a routeless product now, so the stranded state is
     built the way it actually arose: work orders that already exist with no
     operations, recorded on the style. */
  const orders = await WorkOrder.create([{
    workOrderNumber: `WO-STR-${w.n}`, stockItemId: w.product._id,
    stockItemName: "Soumya Tshirt", quantity: 6, status: "pending",
    operations: [], customerName: "Walkthrough", createdBy: w.emp._id,
  }]);
  await SampleStyle.updateOne(
    { _id: w.style._id },
    { $set: { "production.status": "submitted", "production.workOrderIds": orders.map((o) => o._id) } },
  );
  return { ...w, workOrder: orders[0] };
}

/* ═══ 1 · THE SOLE UNROUTED ORDER IS CANCELLED, AND THE STYLE COMES BACK ══ */

describe("cancelling the sole unrouted order", () => {
  test("the style leaves `submitted` and route editing reopens", async () => {
    const w = await stranded();

    const before = await asRnd(`/${w.style._id}/production`, { user: w.user });
    expect(before.body.production.status).toBe("submitted");
    expect(before.body.production.routeEditingOpen).toBe(false);

    const r = await cancel(w.workOrder._id, w.token);
    expect(r.status).toBe(200);

    /* ── THE AUTHORITATIVE STATE, NOT A DISPLAY FLAG ──────────────────
       `production.status` is what the R&D page branches on. It goes back to
       the step whose product is registered — NOT to `not_started`, which
       would make R&D re-link a customer they never unlinked. */
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.production.status).toBe("stock_item_linked");

    const after = await asRnd(`/${w.style._id}/production`, { user: w.user });
    expect(after.body.production.routeEditingOpen).toBe(true);
    expect(after.body.production.liveWorkOrderCount).toBe(0);
    /* And the response says so, so the panel need not infer it. */
    expect(r.body.styleReturn).toMatchObject({ returned: true, status: "stock_item_linked" });
    expect(r.body.styleReturn.styleRef).toBe(w.style.sampleStyleId);
  });

  test("nothing is deleted — the order, the ids and the log all survive", async () => {
    const w = await stranded();
    await cancel(w.workOrder._id, w.token);

    const wo = await WorkOrder.findById(w.workOrder._id).lean();
    expect(wo).toBeTruthy();
    expect(wo.workOrderNumber).toBe(w.workOrder.workOrderNumber);
    expect(wo.quantity).toBe(6);

    const style = await SampleStyle.findById(w.style._id).lean();
    /* The cancelled order is still ON the style. Dropping the id would leave
       the work order alive in its own collection with nothing pointing at it. */
    expect(style.production.workOrderIds.map(String)).toContain(String(w.workOrder._id));
    /* And the style's own log records what happened, in R&D's own reading. */
    const entry = style.production.log.find((l) => l.kind === "attempt_cancelled");
    expect(entry).toBeTruthy();
    expect(entry.note).toMatch(/Created before its product had an operation route/);
    expect(entry.note).toMatch(w.workOrder.workOrderNumber);
  });
});

/* ═══ 2 · THE CANCELLED ATTEMPT STAYS VISIBLE ═════════════════════════════ */

describe("the cancelled attempt remains visible to R&D", () => {
  test("the readback carries the order, its reason, its actor and its date", async () => {
    const w = await stranded();
    await cancel(w.workOrder._id, w.token, "Created before its product had an operation route.");

    const r = await asRnd(`/${w.style._id}/production`, { user: w.user });
    const cancelled = r.body.production.cancelledWorkOrders;
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({
      workOrderNumber: w.workOrder.workOrderNumber,
      status: "cancelled",
    });
    expect(cancelled[0].cancellation.reason)
      .toBe("Created before its product had an operation route.");
    expect(cancelled[0].cancellation.by).toBe("Walkthrough");
    expect(cancelled[0].cancellation.at).toBeTruthy();

    /* It is in the full history too — history is every attempt, `live` is what
       still governs. */
    expect(r.body.production.workOrders).toHaveLength(1);
    expect(r.body.production.liveWorkOrderCount).toBe(0);
  });
});

/* ═══ 3 · A LIVE ORDER KEEPS ROUTE EDITING CLOSED ═════════════════════════ */

describe("another work order still governing the style", () => {
  test("cancelling one of two does not reopen route editing", async () => {
    const w = await stranded();
    /* A second order on the same style, still running. */
    const live = await WorkOrder.create({
      workOrderNumber: `WO-LIVE-${w.n}`, stockItemId: w.product._id,
      stockItemName: "Soumya Tshirt", quantity: 4, status: "in_progress",
      operations: [{ operationType: "Collar attach", operationCode: "OP-C", status: "pending" }],
      customerName: "Walkthrough", createdBy: w.emp._id,
    });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $push: { "production.workOrderIds": live._id } });

    const r = await cancel(w.workOrder._id, w.token);
    expect(r.status).toBe(200);

    /* The unrouted order IS cancelled — that was always permissible. */
    expect((await WorkOrder.findById(w.workOrder._id).lean()).status).toBe("cancelled");

    /* The style is NOT reopened, and the refusal names the order rather than
       counting it. */
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.production.status).toBe("submitted");
    expect(r.body.styleReturn.returned).toBe(false);
    expect(r.body.styleReturn.blockedBy).toEqual([
      { id: String(live._id), number: live.workOrderNumber, status: "in_progress" },
    ]);
    expect(r.body.nextStep).toMatch(live.workOrderNumber);

    /* And no `attempt_cancelled` entry was written — nothing was reopened. */
    expect(style.production.log.some((l) => l.kind === "attempt_cancelled")).toBe(false);
  });

  test("a completed attempt is not reopened either", async () => {
    const w = await stranded();
    const done = await WorkOrder.create({
      workOrderNumber: `WO-DONE-${w.n}`, stockItemId: w.product._id,
      stockItemName: "Soumya Tshirt", quantity: 4, status: "completed",
      completedQuantity: 4,
      operations: [{ operationType: "Collar attach", operationCode: "OP-C", status: "completed" }],
      customerName: "Walkthrough", createdBy: w.emp._id,
    });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $push: { "production.workOrderIds": done._id } });

    const r = await cancel(w.workOrder._id, w.token);
    expect(r.body.styleReturn.returned).toBe(false);
    /* A finished attempt must not be made to look unfinished. */
    expect((await SampleStyle.findById(w.style._id).lean()).production.status).toBe("submitted");
    expect(r.body.styleReturn.blockedBy[0].status).toBe("completed");
  });
});

/* ═══ 4 · R&D SAVES A ROUTE, AND A CLEAN REPLACEMENT IS CREATED ═══════════ */

describe("the replacement attempt", () => {
  /** Cancel, define a two-operation route, release again. */
  async function reroute(w) {
    await cancel(w.workOrder._id, w.token);
    const n = ++seq;
    const [collar, side] = await Operation.create([
      { name: "Collar attach", operationCode: `OP-COL-R${n}`, totalSam: 1.5, durationSeconds: 90, machineType: "SNLS" },
      { name: "Side seam", operationCode: `OP-SID-R${n}`, totalSam: 2, durationSeconds: 120, machineType: "Overlock" },
    ]);
    const saved = await asRnd(`/${w.style._id}/operations/route`, {
      method: "PUT", user: w.user,
      body: { operationIds: [String(side._id), String(collar._id)] },
    });
    expect(saved.status).toBe(200);
    const released = await release(w);
    return { released, collar, side };
  }

  test("the route is saved and the release is allowed again", async () => {
    const w = await stranded();
    const { released } = await reroute(w);
    expect(released.status).toBe(200);
    expect(released.body.workOrderIds.length).toBeGreaterThan(0);

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.production.status).toBe("submitted");
    /* Cumulative: the cancelled attempt's id is still there beside the new. */
    expect(style.production.workOrderIds.map(String)).toContain(String(w.workOrder._id));
    expect(style.production.workOrderIds.length).toBeGreaterThan(1);
    expect(style.production.log.some((l) => l.kind === "attempt_replaced")).toBe(true);
  });

  test("the replacement carries the saved operations IN ORDER", async () => {
    const w = await stranded();
    const { released, collar, side } = await reroute(w);

    const fresh = await WorkOrder.find({ _id: { $in: released.body.workOrderIds } }).lean();
    expect(fresh.length).toBeGreaterThan(0);
    for (const wo of fresh) {
      /* Side seam was listed FIRST. The order R&D chose is the order the work
         order carries — not alphabetical, not the master's own order. */
      expect(wo.operations.map((o) => o.operationType)).toEqual(["Side seam", "Collar attach"]);
      expect(wo.operations.map((o) => o.operationCode)).toEqual([side.operationCode, collar.operationCode]);
      expect(wo.operations.every((o) => o.status === "pending")).toBe(true);
    }
  });

  test("it inherits no scans, no progress, no QC and no cut pieces", async () => {
    const w = await stranded();

    /* The cancelled attempt's baggage, all of it. */
    const shortId = String(w.workOrder._id).slice(-8);
    await ProductionCompletionScanRecord.create({
      date: new Date(),
      scans: [{ barcodeId: `WO-${shortId}-001`, scannedAt: new Date(), scannedBy: "operator" }],
      voidedScans: [],
    });
    await CuttingMasterRecord.create({
      employeeId: w.emp._id, employeeName: "Cutter", date: "2026-09-01",
      entries: [{ woId: w.workOrder._id, woNumber: w.workOrder.workOrderNumber, quantityCut: 6, startUnit: 1, endUnit: 6 }],
      totalUnitsCut: 6,
    });
    await EmployeeProductionProgress.create({
      workOrderId: w.workOrder._id, employeeId: w.emp._id,
      employeeName: "Operator", lastCompletedUnit: 4,
    });
    /* A live scan would refuse the cancellation, so it is withdrawn first —
       the same state the reconciliation leaves behind. */
    await ProductionCompletionScanRecord.updateMany(
      { "scans.barcodeId": new RegExp(`^WO-${shortId}-`) },
      { $set: { scans: [] } },
    );

    const { released } = await reroute(w);
    const fresh = await WorkOrder.find({ _id: { $in: released.body.workOrderIds } }).lean();
    expect(fresh.length).toBeGreaterThan(0);

    for (const wo of fresh) {
      /* ── A REPLACEMENT STARTS AT ZERO ─────────────────────────────
         Its barcodes are derived from its OWN id, so the cancelled order's
         scans can never match it; nothing carries progress across. */
      expect(wo.completedQuantity || 0).toBe(0);
      expect(String(wo._id)).not.toBe(String(w.workOrder._id));
      expect(wo.status).toBe("pending");
      expect(wo.cancellation).toBeUndefined();

      const scanShort = String(wo._id).slice(-8);
      const scans = await ProductionCompletionScanRecord
        .find({ "scans.barcodeId": new RegExp(`^WO-${scanShort}-`) }).lean();
      expect(scans).toHaveLength(0);

      expect(await EmployeeProductionProgress.countDocuments({ workOrderId: wo._id })).toBe(0);
      expect(await QCInspection.countDocuments({ workOrderId: wo._id })).toBe(0);
      const cut = await CuttingMasterRecord.find({ "entries.woId": wo._id }).lean();
      expect(cut).toHaveLength(0);
    }

    /* And the cancelled attempt's OWN records are untouched — kept, not moved. */
    const oldCut = await CuttingMasterRecord.find({ "entries.woId": w.workOrder._id }).lean();
    expect(oldCut).toHaveLength(1);
    expect(await EmployeeProductionProgress.countDocuments({ workOrderId: w.workOrder._id })).toBe(1);
  });
});

/* ═══ 5 · THE ACCOUNT THE RESPONSE HANDS BACK ═════════════════════════════ */

describe("the cancellation response", () => {
  test("it carries the reason, the actor, the timestamp and the cutting fact", async () => {
    const w = await stranded();
    await CuttingMasterRecord.create({
      employeeId: w.emp._id, employeeName: "Cutter", date: "2026-09-02",
      entries: [
        { woId: w.workOrder._id, woNumber: w.workOrder.workOrderNumber, quantityCut: 4 },
        { woId: w.workOrder._id, woNumber: w.workOrder.workOrderNumber, quantityCut: 2 },
      ],
      totalUnitsCut: 6,
    });

    const r = await cancel(w.workOrder._id, w.token, "Routeless from the start.");
    expect(r.status).toBe(200);
    expect(r.body.cancellation).toMatchObject({
      reason: "Routeless from the start.",
      cuttingRecorded: true,
      operationsAtCancellation: 0,
      productionScansAtCancellation: 0,
    });
    expect(r.body.cancellation.by.name).toBe("Walkthrough");
    expect(r.body.cancellation.at).toBeTruthy();

    /* ── CUTTING IS COUNTED OFF THE FIELD THE MODEL ACTUALLY HAS ──────
       `CuttingMasterRecord` keys the work order on `entries[].woId`; there is
       no `workOrderId` on it at all, so the previous count matched nothing
       and the warning could never fire on an order that HAD been cut. */
    expect(r.body.cutting).toMatchObject({ records: 2, unitsCut: 6 });
    expect(r.body.cutting.note).toMatch(/NOT carried into a replacement order/);
    expect(r.body.cutting.note).toMatch(/6 pieces/);
    expect(r.body.cutting.note).toMatch(/starts at zero/);
  });

  test("no cutting means no warning, rather than a warning about nothing", async () => {
    const w = await stranded();
    const r = await cancel(w.workOrder._id, w.token);
    expect(r.body.cutting).toBeNull();
    expect(r.body.cancellation.cuttingRecorded).toBe(false);
  });
});

/* ═══ 6 · A REPLAY RECONCILES THE STYLE IT NEVER REACHED ══════════════════ */

describe("replaying a cancellation whose style was never returned", () => {
  /**
   * The live state: work order `cancelled`, style still `submitted`.
   *
   * Exactly what an order cancelled BEFORE the style-return existed looks
   * like — and what the walkthrough record was found in. Built by cancelling
   * and then putting the style back, rather than by hand, so the work order's
   * own `cancellation` is a real one.
   */
  async function alreadyCancelled() {
    const w = await stranded();
    const first = await cancel(w.workOrder._id, w.token, "Created before its product had an operation route.");
    expect(first.status).toBe(200);
    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "production.status": "submitted" }, $pull: { "production.log": { kind: "attempt_cancelled" } } },
    );
    return w;
  }

  test("the replay reconciles the style instead of returning early", async () => {
    const w = await alreadyCancelled();
    expect((await SampleStyle.findById(w.style._id).lean()).production.status).toBe("submitted");

    const r = await cancel(w.workOrder._id, w.token);
    expect(r.status).toBe(200);
    expect(r.body.replayed).toBe(true);

    /* The whole point: the style moves on the SECOND call. */
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.production.status).toBe("stock_item_linked");
    expect(r.body.styleReturn).toMatchObject({ returned: true, status: "stock_item_linked" });
  });

  test("it keeps the ORIGINAL reason, actor and timestamp", async () => {
    const w = await alreadyCancelled();
    const recorded = (await WorkOrder.findById(w.workOrder._id).lean()).cancellation;

    /* A different person replays it, much later, with a different reason in
       the body. None of that may overwrite what was actually recorded. */
    const other = await Employee.create({
      firstName: "Someone", lastName: "Else", email: `replayer-${w.n}@test.com`,
      biometricId: `RP${w.n}`, isActive: true, gender: "Other", department: "Tech",
    });
    const otherToken = jwt.sign(
      { id: String(other._id), email: other.email, name: "Someone Else", role: "employee", employeeId: other.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    );
    const r = await cancel(w.workOrder._id, otherToken, "A completely different reason.");

    expect(r.body.cancellation.reason).toBe("Created before its product had an operation route.");
    expect(r.body.cancellation.by.name).toBe("Walkthrough");
    expect(new Date(r.body.cancellation.at).toISOString()).toBe(new Date(recorded.at).toISOString());

    /* And the record itself is untouched by the replay. */
    const after = (await WorkOrder.findById(w.workOrder._id).lean()).cancellation;
    expect(after.reason).toBe(recorded.reason);
    expect(after.byName).toBe("Walkthrough");
    expect(new Date(after.at).toISOString()).toBe(new Date(recorded.at).toISOString());

    /* The style's log carries the original's facts too, not the replayer's. */
    const style = await SampleStyle.findById(w.style._id).lean();
    const entry = style.production.log.find((l) => l.kind === "attempt_cancelled");
    expect(entry.by.name).toBe("Walkthrough");
    expect(new Date(entry.at).toISOString()).toBe(new Date(recorded.at).toISOString());
  });

  test("repeated calls never append a second log entry", async () => {
    const w = await alreadyCancelled();
    for (let i = 0; i < 4; i += 1) await cancel(w.workOrder._id, w.token);

    const style = await SampleStyle.findById(w.style._id).lean();
    const entries = style.production.log.filter((l) => l.kind === "attempt_cancelled");
    /* Recognised by `workOrderId`, not by the note's prose — rewording the
       sentence must not turn one event into two. */
    expect(entries).toHaveLength(1);
    expect(String(entries[0].workOrderId)).toBe(String(w.workOrder._id));
    expect(style.production.status).toBe("stock_item_linked");
  });

  test("the replay returns the same complete contract as a first cancellation", async () => {
    const w = await stranded();
    await CuttingMasterRecord.create({
      employeeId: w.emp._id, employeeName: "Cutter", date: "2026-09-03",
      entries: [{ woId: w.workOrder._id, woNumber: w.workOrder.workOrderNumber, quantityCut: 6 }],
      totalUnitsCut: 6,
    });
    const first = await cancel(w.workOrder._id, w.token, "Routeless from the start.");
    const replay = await cancel(w.workOrder._id, w.token);

    /* Every key the panel reads, on both. */
    for (const key of ["success", "message", "workOrder", "cancellation", "cutting", "styleReturn", "nextStep"]) {
      expect(replay.body).toHaveProperty(key);
    }
    expect(replay.body.cancellation).toEqual(first.body.cancellation);
    expect(replay.body.cutting).toEqual(first.body.cutting);
    /* Including the cut-fabric warning, which a stub body dropped entirely. */
    expect(replay.body.cutting.note).toMatch(/NOT carried into a replacement order/);
    expect(replay.body.workOrder.status).toBe("cancelled");
    /* The style was already back, and the message says so rather than
       announcing the return a second time. */
    expect(replay.body.styleReturn).toMatchObject({ returned: true, alreadyReturned: true, wrote: false });
    expect(replay.body.styleReturn.message).toMatch(/already back with R&D/);
  });

  test("a replay does NOT reopen a style another order still governs", async () => {
    const w = await alreadyCancelled();
    const live = await WorkOrder.create({
      workOrderNumber: `WO-LIVE2-${w.n}`, stockItemId: w.product._id,
      stockItemName: "Soumya Tshirt", quantity: 4, status: "in_progress",
      operations: [{ operationType: "Collar attach", operationCode: "OP-C", status: "pending" }],
      customerName: "Walkthrough", createdBy: w.emp._id,
    });
    await SampleStyle.updateOne({ _id: w.style._id },
      { $push: { "production.workOrderIds": live._id } });

    const r = await cancel(w.workOrder._id, w.token);
    expect(r.body.replayed).toBe(true);
    expect(r.body.styleReturn.returned).toBe(false);
    expect(r.body.styleReturn.blockedBy[0].number).toBe(live.workOrderNumber);

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.production.status).toBe("submitted");
    expect(style.production.log.some((l) => l.kind === "attempt_cancelled")).toBe(false);
  });
});
