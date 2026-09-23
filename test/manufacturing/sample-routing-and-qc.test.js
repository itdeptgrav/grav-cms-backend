// test/manufacturing/sample-routing-and-qc.test.js
//
// A WORK ORDER WITH NO OPERATION ROUTE, AND THE FOUR PLACES IT LEAKED.
//
// ── WHAT THE WALKTHROUGH PRODUCED ───────────────────────────────────────────
// An R&D sample style reached production before its product had any
// operations. The work order was created anyway, with `Operations: 0`,
// `Barcodes needed: 0` and `Production: 0%` — a job that could be planned and
// scanned against while having nothing to progress through.
//
// Six production barcodes were then accepted against it. The endpoint reported
// "6 scans saved" and the order stayed at 0/6, because there was no operation
// for a completion scan to complete. QC listed the same order as ready to
// inspect, and looking up one of its pieces showed all 259 operations the
// company has ever defined — a list in which every row is wrong, presented
// exactly like a correct one.
//
// Four refusals close it, each where the fact is known: at creation, at the
// production preview, at the production save, and at QC.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

const jwt = require("jsonwebtoken");
const Employee = require("../../models/Employee");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionCompletionScanRecord =
  require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/manufacturing/production-completion",
    require("../../routes/CMS_Routes/Manufacturing/Production/productionCompletionRoutes"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/manufacturing/production-completion`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A work order, routed or not. Barcodes are `WO-<last 8 of id>-NNN`. */
async function workOrder({ operations = [], quantity = 6 } = {}) {
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-TEST-${++seq}`,
    stockItemName: "Soumya Tshirt",
    quantity,
    status: "pending",
    operations,
    customerName: "Walkthrough",
  });
  const shortId = String(wo._id).slice(-8);
  return {
    wo,
    shortId,
    barcodes: Array.from({ length: quantity }, (_, i) => `WO-${shortId}-${String(i + 1).padStart(3, "0")}`),
  };
}

const ROUTE = [
  { operationType: "Collar attach", operationCode: "OP-COLLAR", plannedTimeSeconds: 90, status: "pending" },
  { operationType: "Side seam", operationCode: "OP-SIDE", plannedTimeSeconds: 120, status: "pending" },
];

/* ═══ 1 · A SCAN NEEDS SOMETHING TO SCAN AGAINST ══════════════════════════ */

describe("production scans on a work order with no route", () => {
  test("the preview refuses every barcode, and says what to fix", async () => {
    const { barcodes, wo } = await workOrder({ operations: [] });
    const r = await call("/preview", { barcodes });
    expect(r.status).toBe(200);

    /* Not one of the six is offered as saveable. */
    expect(r.body.summary?.valid ?? r.body.valid?.length ?? 0).toBe(0);
    const detail = JSON.stringify(r.body);
    expect(detail).toMatch(/has no operation route/);
    expect(detail).toMatch(/WORK_ORDER_NOT_ROUTED/);
    expect(wo.workOrderNumber).toBeTruthy();
  });

  test("the save refuses the whole request and writes no scan at all", async () => {
    /* ── AN ORPHAN LOG IS WORSE THAN A REFUSAL ────────────────────────
       It looks exactly like progress: "6 scans saved", and an order still at
       0/6. Nothing partial is written either — a half-saved batch on a
       screen that showed six is a different lie. */
    const { barcodes } = await workOrder({ operations: [] });
    const before = await ProductionCompletionScanRecord.countDocuments({});

    const r = await call("/mark-done", { barcodes, scannedBy: "walkthrough" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("WORK_ORDER_NOT_ROUTED");
    expect(r.body.message).toMatch(/Nothing was saved/);
    expect(r.body.remedy).toBe("RECORD_OPERATIONS_IN_RND");

    expect(await ProductionCompletionScanRecord.countDocuments({})).toBe(before);
    const logged = await ProductionCompletionScanRecord.find({ "scans.barcodeId": { $in: barcodes } }).lean();
    expect(logged).toHaveLength(0);
  });

  test("a routed order accepts the same scans and records them", async () => {
    const { barcodes } = await workOrder({ operations: ROUTE });
    const r = await call("/mark-done", { barcodes, scannedBy: "walkthrough" });
    expect(r.status).toBe(200);

    const logged = await ProductionCompletionScanRecord.find({ "scans.barcodeId": { $in: barcodes } }).lean();
    const saved = logged.flatMap((d) => (d.scans || []).map((s) => s.barcodeId));
    /* Every one of the six, against an order that has somewhere to put them. */
    expect(new Set(saved)).toEqual(new Set(barcodes));
  });

  test("one unrouted barcode refuses the batch rather than saving the rest", async () => {
    const routed = await workOrder({ operations: ROUTE, quantity: 2 });
    const unrouted = await workOrder({ operations: [], quantity: 1 });
    const before = await ProductionCompletionScanRecord.countDocuments({});

    const r = await call("/mark-done", {
      barcodes: [...routed.barcodes, ...unrouted.barcodes],
      scannedBy: "walkthrough",
    });
    expect(r.status).toBe(409);
    /* And the routed half was NOT written: a partial save from a batch the
       person submitted as one is a result nobody can reconcile. */
    expect(await ProductionCompletionScanRecord.countDocuments({})).toBe(before);
    const anyRouted = await ProductionCompletionScanRecord
      .find({ "scans.barcodeId": { $in: routed.barcodes } }).lean();
    expect(anyRouted).toHaveLength(0);
  });
});

/* ═══ 2 · AND QC DOES NOT OFFER IT ════════════════════════════════════════ */

describe("QC eligibility", () => {
  /* The listing's own query, asserted directly: mounting the QC router needs
     an inspector session and a roster, and what is under test here is which
     work orders it will consider at all. */
  const qcSource = require("fs").readFileSync(
    require.resolve("../../routes/CMS_Routes/Manufacturing/QC/qcRoutes"), "utf8",
  );

  test("an unrouted work order is excluded in the query, not filtered after", async () => {
    /* Filtering afterwards would leave the counts on a card describing orders
       that cannot be worked on. */
    expect(qcSource).toMatch(/"operations\.0": \{ \$exists: true \}/);
    const listing = qcSource.slice(qcSource.indexOf("async function computeWorkOrderQcStats"));
    expect(listing.slice(0, 1200)).toMatch(/operations\.0/);
  });

  test("a piece with no route is refused, and the master sheet is never shown", async () => {
    /* ── THE 259-OPERATION LIST ───────────────────────────────────────
       It fell back to every operation the company has ever defined,
       reasoned as "a data-entry gap must not stop the line". For a piece
       routed through none of them, every row was wrong. */
    expect(qcSource).not.toMatch(/opSource = masterOps;/);
    expect(qcSource).toMatch(/code: "WORK_ORDER_NOT_ROUTED"/);
    expect(qcSource).toMatch(/there is nothing to inspect this piece against/);
    expect(qcSource).toMatch(/remedy: "RECORD_OPERATIONS_IN_RND"/);
  });

  test("the scope is the work order's frozen route, not the product's current one", async () => {
    /* The product's Operations tab can be edited after the garment was made.
       The piece was routed through what the work order says. */
    expect(qcSource).toMatch(/const getWorkOrderOperations = async/);
    expect(qcSource).toMatch(/getWorkOrderOperations\(workOrder\._id\)/);
  });

  test("the checkpoint roster is untouched", async () => {
    /* Nothing here widens who may inspect. The owner gate and the roster
       resolution are the same functions they were. */
    expect(qcSource).toMatch(/async function requireQcOwnerViewer/);
    expect(qcSource).toMatch(/Only the QC owner can see the department's orders/);
  });
});

/* ═══ 3 · AND THE ROUTE IS NEVER INVENTED ═════════════════════════════════ */

test("no operation is taken from the global master to fill a gap", async () => {
  /* A route assembled from the operation master is a route nobody designed.
     The refusals above exist so that never has to happen. */
  const releaseSource = require("fs").readFileSync(
    require.resolve("../../routes/CMS_Routes/Sales/quotationRoutes"), "utf8",
  );
  const creation = releaseSource.slice(
    releaseSource.indexOf("async function createWorkOrdersAndProgress"),
    releaseSource.indexOf("const unroutedRefusal"),
  );
  /* The route comes from the product and from nowhere else. */
  expect(creation).toMatch(/stockItem\.operations \|\| \[\]/);
  expect(creation).not.toMatch(/Operation\.find|OperationMaster/);
  /* And a product with none stops the release rather than being filled in. */
  expect(creation).toMatch(/unroutedProducts\.push/);
  expect(releaseSource).toMatch(/PRODUCTION_ROUTE_MISSING/);
  expect(releaseSource).toMatch(/Record its operations on the technical record in R&D first/);
});

/* ═══ 4 · AND THE SIX THAT WERE ALREADY WRITTEN ═══════════════════════════ */

describe("reconciling the walkthrough's orphan scans", () => {
  /* The script's own rules, exercised against the same models it uses. It is
     run by hand against a real database, so what is proved here is the
     narrowness: which rows it selects, what it leaves alone, and that it
     refuses when its precondition no longer holds. */
  const SCRIPT = require("fs").readFileSync(
    require.resolve("../../scripts/migrations/reconcile-walkthrough-2026-09-06.js"), "utf8",
  );

  test("it names exactly one work order and exactly six barcodes", () => {
    /* Nothing is derived from a pattern that could widen to a seventh. */
    expect(SCRIPT).toMatch(/const WORK_ORDER_ID = "6a9d3aeb1e6ac07e4b1902bd"/);
    for (let i = 1; i <= 6; i += 1) {
      expect(SCRIPT).toContain(`WO-4b1902bd-00${i}`);
    }
    expect(SCRIPT).not.toContain("WO-4b1902bd-007");
    /* No wildcard over barcodes or orders. */
    expect(SCRIPT).not.toMatch(/\$regex|deleteMany\(\{\}\)|updateMany/);
  });

  test("it refuses if the work order has since been routed", () => {
    /* Then the scans may be legitimate, and are not this script's business. */
    expect(SCRIPT).toMatch(/if \(\(wo\.operations \|\| \[\]\)\.length\)/);
    expect(SCRIPT).toMatch(/Its scans may be legitimate\. Nothing was changed\./);
  });

  test("it is a dry run until told otherwise, and voids before removing", () => {
    expect(SCRIPT).toMatch(/const APPLY = process\.argv\.includes\("--apply"\)/);
    expect(SCRIPT).toMatch(/DRY RUN/);
    /* The audit copy is written first: a row removed with no record of
       having existed cannot be asked about later. */
    const apply = SCRIPT.slice(SCRIPT.indexOf("if (!APPLY)"));
    expect(apply.indexOf("voidedScans")).toBeLessThan(apply.indexOf("$pull"));
  });

  test("it touches production completion scans and nothing else", () => {
    /* Cutting progress, employee progress, QC and every other work order are
       not referenced at all — the strongest form of "does not touch". */
    for (const model of ["CuttingProgress", "EmployeeProductionProgress", "QCInspection", "CustomerRequest"]) {
      expect(SCRIPT).not.toContain(model);
    }
  });

  test("the void leaves an auditable record on the model", async () => {
    const { barcodes } = await workOrder({ operations: [], quantity: 2 });
    const doc = await ProductionCompletionScanRecord.create({
      /* The record's own day bucket, which the model requires. */
      date: new Date(),
      scans: barcodes.map((bc) => ({ barcodeId: bc, scannedAt: new Date(), scannedBy: "walkthrough" })),
    });
    /* The same two writes the script makes, in the same order. */
    await ProductionCompletionScanRecord.updateOne(
      { _id: doc._id },
      { $push: { voidedScans: { $each: barcodes.map((bc) => ({ barcodeId: bc, voidedAt: new Date(), reason: "orphan" })) } } },
    );
    await ProductionCompletionScanRecord.updateOne(
      { _id: doc._id },
      { $pull: { scans: { barcodeId: { $in: barcodes } } } },
    );

    const after = await ProductionCompletionScanRecord.findById(doc._id).lean();
    /* Gone from the live list, so the barcodes can be scanned again… */
    expect(after.scans).toHaveLength(0);
    /* …and still answerable. */
    expect(after.voidedScans.map((v) => v.barcodeId).sort()).toEqual([...barcodes].sort());
    expect(after.voidedScans[0].reason).toBe("orphan");
  });
});

/* ═══ 5 · RETURNING A STRANDED ORDER TO R&D ═══════════════════════════════ */

describe("cancelling an unrouted sample order", () => {
  let cancelBase, token;
  beforeAll(async () => {
    /* A real signed-in employee: the router authenticates every route, and
       the cancellation is recorded in the actor's name. */
    const n = Date.now();
    const emp = await Employee.create({
      firstName: "Walkthrough", lastName: "User", email: `cancel-${n}@test.example`,
      biometricId: `CN${n}`, isActive: true, gender: "Other", department: "Tech",
    });
    token = jwt.sign(
      { id: String(emp._id), email: emp.email, name: "Walkthrough", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    );
    const app = express();
    app.use(express.json());
    app.use("/api/cms/manufacturing/work-orders",
      require("../../routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes"));
    await new Promise((r) => { cancelBase = app.listen(0, r); });
  });
  afterAll(async () => { await new Promise((r) => cancelBase.close(r)); });

  const cancel = (id, body = { reason: "Created before its product had an operation route." }) =>
    fetch(`http://127.0.0.1:${cancelBase.address().port}/api/cms/manufacturing/work-orders/${id}/cancel-unrouted`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  test("a stranded order is cancelled, with the account of why", async () => {
    const { wo } = await workOrder({ operations: [] });
    const r = await cancel(wo._id);
    expect(r.status).toBe(200);

    const after = await WorkOrder.findById(wo._id).lean();
    expect(after.status).toBe("cancelled");
    /* ── NOTHING IS DELETED ───────────────────────────────────────────
       The order, its number and its quantity are all still there. What
       changed is the status and the reason. */
    expect(after.workOrderNumber).toBe(wo.workOrderNumber);
    expect(after.quantity).toBe(wo.quantity);
    expect(after.cancellation).toMatchObject({
      reason: "Created before its product had an operation route.",
      byName: "Walkthrough",
      operationsAtCancellation: 0,
      productionScansAtCancellation: 0,
    });
    expect(after.cancellation.at).toBeTruthy();
    expect(r.body.nextStep).toMatch(/Define the sample operation route in R&D/);
  });

  test("it refuses without a reason", async () => {
    const { wo } = await workOrder({ operations: [] });
    const r = await cancel(wo._id, {});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("CANCEL_REASON_REQUIRED");
    expect((await WorkOrder.findById(wo._id).lean()).status).not.toBe("cancelled");
  });

  test("it refuses a routed order — that is a production decision, not a repair", async () => {
    const { wo } = await workOrder({ operations: ROUTE });
    const r = await cancel(wo._id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("WORK_ORDER_IS_ROUTED");
    expect((await WorkOrder.findById(wo._id).lean()).status).not.toBe("cancelled");
  });

  test("it refuses once a production scan exists — that is somebody's work", async () => {
    const { wo, barcodes } = await workOrder({ operations: [] });
    await ProductionCompletionScanRecord.create({
      date: new Date(),
      scans: [{ barcodeId: barcodes[0], scannedAt: new Date(), scannedBy: "operator" }],
    });
    const r = await cancel(wo._id);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("PRODUCTION_ACTIVITY_EXISTS");
    expect(r.body.productionScans).toBe(1);
  });

  test("another order's scan on the same day is not activity against this one", async () => {
    /* ── ONE DOCUMENT PER DATE, NOT PER ORDER ─────────────────────────
       A ProductionCompletionScanRecord holds every work order scanned that
       day. Counting the array rather than the matching barcodes would refuse
       this cancellation because a DIFFERENT order was scanned that morning —
       and the refusal would name a number the reader cannot account for. */
    const { wo } = await workOrder({ operations: [] });
    const other = await workOrder({ operations: ROUTE });
    await ProductionCompletionScanRecord.create({
      date: new Date(),
      scans: other.barcodes.slice(0, 3).map((b) => ({ barcodeId: b, scannedAt: new Date(), scannedBy: "operator" })),
    });

    const r = await cancel(wo._id);
    expect(r.status).toBe(200);
    expect((await WorkOrder.findById(wo._id).lean()).status).toBe("cancelled");
    /* And the other order is untouched. */
    expect((await WorkOrder.findById(other.wo._id).lean()).status).not.toBe("cancelled");
  });

  test("a scan already voided by the reconciliation does not block it", async () => {
    /* ── THE WALKTHROUGH'S EXACT STATE ────────────────────────────────
       Six scans were written against a routeless order and have been
       withdrawn. A withdrawn scan is not work somebody did against this
       order; treating it as one would leave the order stranded for ever. */
    const { wo, barcodes } = await workOrder({ operations: [] });
    await ProductionCompletionScanRecord.create({
      date: new Date(),
      scans: [],
      voidedScans: barcodes.map((bc) => ({
        barcodeId: bc, voidedAt: new Date(), reason: "Orphan scan: work order had no operation route.",
      })),
    });
    const r = await cancel(wo._id);
    expect(r.status).toBe(200);
    expect((await WorkOrder.findById(wo._id).lean()).status).toBe("cancelled");
  });

  test("cancelling twice is a replay, not a second cancellation", async () => {
    const { wo } = await workOrder({ operations: [] });
    expect((await cancel(wo._id)).status).toBe(200);
    const again = await cancel(wo._id);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);

    const after = await WorkOrder.findById(wo._id).lean();
    /* The first cancellation's account survives — the second did not
       overwrite who cancelled it or why. */
    expect(after.cancellation.byName).toBe("Walkthrough");
  });

  test("a cancelled order leaves QC entirely", async () => {
    /* It was already excluded for having no route; cancelling removes it by
       the criterion QC has always used as well. */
    const qcSource = require("fs").readFileSync(
      require.resolve("../../routes/CMS_Routes/Manufacturing/QC/qcRoutes"), "utf8",
    );
    expect(qcSource).toMatch(/status: \{ \$ne: "cancelled" \}/);
    /* And the status is a value the model permits, so the exclusion above is
       reachable rather than theoretical. */
    const enumValues = WorkOrder.schema.path("status").enumValues;
    expect(enumValues).toContain("cancelled");
  });

  /* ── AUTHORISED, NOT MERELY SIGNED IN ────────────────────────────────────
     Cancelling is the one write in this router that ends a record. It carries
     the codebase's own department-role guard, which fails open until a
     Production role exists — so both halves are proved: it lets everybody
     through while unconfigured, and refuses a signed-in employee who holds no
     role the moment it is configured. */
  test("cancelling is refused once Production roles are configured and the actor holds none", async () => {
    const { wo } = await workOrder({ operations: [] });
    const DepartmentRole = require("../../models/Access/DepartmentRole");
    await DepartmentRole.create({
      departmentSlug: "project-manager",
      email: `somebody-else-${Date.now()}@test.example`,
      name: "Somebody Else", role: "owner", isActive: true,
    });
    try {
      const r = await cancel(wo._id);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("NO_DEPARTMENT_ROLE");

      /* Refused means untouched — not cancelled-then-rejected. */
      const after = await WorkOrder.findById(wo._id).lean();
      expect(after.status).not.toBe("cancelled");
      expect(after.cancellation).toBeUndefined();
    } finally {
      await DepartmentRole.deleteMany({ departmentSlug: "project-manager" });
    }
  });
});
