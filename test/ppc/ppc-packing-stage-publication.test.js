// test/ppc/ppc-packing-stage-publication.test.js
//
// PPC PUBLISHES ONE PACKING TARGET; PACKAGING & DISPATCH ANSWERS IT.
//
// The fourth receiver on the same versioned contract, and the plainest: no
// buyer statement to satisfy (packing is not a process a buyer chooses per
// line) and no capacity booking to prove (PPC reserves sewing lines, not
// packing benches). What is left is the contract itself.
//
// ── THE SENTENCE THIS FILE KEEPS STRAIGHT ───────────────────────────────────
// Packing a unit is, in this system, the authoritative "this unit is fully
// done" signal: `packagingRoutes.js` writes packagingRecords and moves the
// work order's completed quantity. ACCEPTING A TARGET IS NOT THAT. It is
// Packaging & Dispatch saying it can pack inside a window PPC asked about.
// Every test that answers a target asserts nothing was packed, labelled,
// scanned, counted, dispatched, booked or released.
//
// Pinned:
//   · an applicable, dated packing stage publishes, wholly server-derived;
//   · an unknown, not-applicable or undated stage, a stale schedule, a
//     retired plan, a moved source and an unlinked work order each block it;
//   · one Sales line is one answer, however many work orders show it;
//   · a Packaging viewer reads and cannot answer; an editor answers;
//   · PPC, Production, Cutting, Embroidery and an ungranted department
//     cannot read or answer;
//   · a refusal needs a reason; two answers race to one winner; the same
//     answer replays; a different one is refused;
//   · a successor supersedes the old target, keeps its dates and its answer,
//     and needs a fresh one;
//   · cutting, embroidery and sewing targets are invisible and unanswerable
//     here, and packing targets are invisible on their doors;
//   · another company's and unlinked work orders reveal nothing.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const fx = require("./planningFixtures");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const DispatchChallan = require("../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const PACK = "/api/cms/manufacturing/packaging/packing-targets";
const CUT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use(PACK, require("../../routes/CMS_Routes/Manufacturing/Packaging/packingTargetRoutes"));
  app.use(CUT, require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcPlanningCommand, PpcStageSchedule, PpcStagePublication]) {
    await m.syncIndexes();
  }
});
afterAll(() => new Promise((r) => http.close(r)));

const call = (path, { token, method = "GET", body, company: co, key } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(co ? { "X-Costing-Company": String(co) } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const key = fx.nextKey;
const WINDOW = Object.freeze({ start: "2026-11-02", end: "2026-11-04" });

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;

/** IE's route: cutting, sewing, then packing. */
function route({ packing = "REQUIRED" } = {}) {
  const ids = { cut: sid(), sew: sid(), pack: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: ids.sew, sequence: 2, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [ids.cut] },
    { stageId: ids.pack, sequence: 3, process: "PACKING", label: "Cartoning", applicability: packing,
      predecessorStageIds: packing === "REQUIRED" ? [ids.sew] : [] },
  ] };
}

/* Sales' approved statement: no embroidery, no print, no wash. Packing is not
   a buyer-chosen process, so the statement says nothing about it — and the
   route alone decides, which is what the publish command must rely on. */
const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no embroidery", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no print", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no wash", evidence },
] });

/** A department session in one company, with optional live grants. */
async function person(co, { dept = "packaging-dispatch", role = "packaging-dispatch", grants = {}, name = "Pack" } = {}) {
  const n = ++seq;
  const email = `pkt${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `P${n}`, email, biometricId: `PKT${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Packaging", designation: "Packer" });
  await DeptUser.create({ name, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({ departmentSlug, email, name, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId() });
  }
  return { emp, email, name: `${name} P${n}`,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} P${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

/**
 * One company, one applicable Sales line with work orders, a plan, and a
 * dated packing stage. Packaging's own viewer and editor always exist, so a
 * test never accidentally measures the "no grant has ever been given" branch.
 */
async function world(label, {
  workOrders = 1, quantity = 600, packing = "REQUIRED", dateStage = "pack", schedules = true,
} = {}) {
  const co = await fx.company(label);
  const r = route({ packing });
  const styleId = new mongoose.Types.ObjectId();
  const rel = await fx.release(co, styleId, { processRoute: r.stages });
  const file = await fx.orderLine(co, {
    lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(), quantity,
  });
  await fx.pack(co, file);
  await fx.minutes(co, file);

  const w = {
    co, file, r, styleId, quantity, rel: rel.release, lineRef: file.handoverLineRef,
    planner: await fx.actor({ companies: [co], grants: { ppc: "editor" } }),
    approver: await fx.actor({ companies: [co], grants: { ppc: "approver" } }),
    pkgViewer: await person(co, { grants: { "packaging-dispatch": "viewer" }, name: "Viewer" }),
    pkgEditor: await person(co, { grants: { "packaging-dispatch": "editor" }, name: "Editor" }),
  };

  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-PKT-${++seq}-${Date.now()}`,
    reference: `REF-PKT-${seq}`, category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 9,
    variants: [{ sku: `VP-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  w.item = item;
  w.mo = await CustomerRequest.create({ requestId: `CR-PKT-${++seq}-${Date.now()}`,
    customerId: new mongoose.Types.ObjectId(), customerInfo: { name: "Buyer" }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  w.wos = [];
  for (let i = 0; i < workOrders; i += 1) {
    w.wos.push(await WorkOrder.create({
      customerRequestId: w.mo._id, stockItemId: item._id, stockItemName: item.name,
      quantity: Math.round(quantity / workOrders), status: "in_progress",
      salesLineLink: { companyId: co._id, customerRequestId: w.mo._id, lineRef: w.lineRef,
        basis: "sales_line", linkedAt: new Date() },
    }));
  }
  w.wo = w.wos[0];

  const created = await call(`${PPC}/order-book/${w.lineRef}/planning-file`,
    { token: w.planner.token, company: co._id, method: "POST", body: {}, key: key() });
  expect(created.status).toBe(201);
  w.planId = created.body.planningFile.planningFileId;

  w.saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`, { token: w.planner.token,
    company: co._id, method: "POST", key: key(),
    body: { expectedRevision: 0,
      stages: [{ stageId: r.ids[dateStage], plannedStart: WINDOW.start, plannedEnd: WINDOW.end }] } });
  if (schedules) expect(w.saved.status).toBe(200);
  return w;
}

const publish = (w, body = {}, { who = w.planner, k = key() } = {}) => call(
  `${PPC}/planning-files/${w.planId}/stage-schedule/publish`,
  { token: who.token, company: w.co._id, method: "POST", key: k,
    body: { stageId: w.r.ids.pack, expectedScheduleVersion: 1, ...body } },
);

const targetsFor = (w, query, who = w.pkgEditor) => call(`${PACK}?${query}`,
  { token: who.token, company: w.co._id });

const answer = (w, id, decision, body = {}, who = w.pkgEditor) => call(`${PACK}/${id}/${decision}`,
  { token: who.token, company: w.co._id, method: "POST", body });

/* ══ PUBLISHING ═══════════════════════════════════════════════════════════ */

describe("PPC publishes one packing target for one Sales line", () => {
  test("saving dates publishes nothing; publishing freezes the whole identity", async () => {
    const w = await world("pack-ok");
    /* The schedule save alone reaches nobody. */
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
    expect((await targetsFor(w, `moId=${w.mo._id}`)).body.targets).toEqual([]);

    const out = await publish(w);
    expect(out.status).toBe(201);
    const p = out.body.publication;
    expect(p.process).toBe("PACKING");
    expect(p.state).toBe("AWAITING");
    expect(p.publicationVersionNo).toBe(1);
    expect(p.scheduleVersionNo).toBe(1);
    expect(p.stageId).toBe(w.r.ids.pack);
    expect(p.stageLabel).toBe("Cartoning");
    expect(p.plannedStart).toBe(WINDOW.start);
    expect(p.plannedEnd).toBe(WINDOW.end);
    expect(p.orderLineRef).toBe(w.lineRef);
    expect(p.confirmedQuantity).toBe(w.quantity);
    expect(p.ieRelease.releaseRef).toBe(w.rel.releaseRef);
    expect(p.workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);
    expect(p.publishedByName).toBe(w.planner.name);
    expect(p.publishedAt).toBeTruthy();
    /* Packing reserves nothing, so it carries no booking block. */
    expect(p.capacityBooking).toBeNull();
    expect(p.isAcceptedDeadline).toBe(false);
    expect(p.booksCapacity).toBe(false);
    expect(p.releasesProduction).toBe(false);
    /* And no booking was created by publishing one. */
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a retried publish returns the original, not a second target", async () => {
    const w = await world("pack-retry");
    const k = key();
    const first = await publish(w, {}, { k });
    expect(first.status).toBe(201);
    const again = await publish(w, {}, { k });
    expect(again.body.publication.publicationId).toBe(first.body.publication.publicationId);
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("an unknown, not-applicable or undated packing stage publishes nothing", async () => {
    /* Unknown stage id. */
    const w = await world("pack-unknown");
    const unknown = await publish(w, { stageId: "stg_nope" });
    expect(unknown.status).toBe(409);
    expect(unknown.body.error.details.reason).toBe("NOT_IN_SCHEDULE");

    /* Dated, but the frozen route does not require packing for this line. */
    const notApplicable = await world("pack-na", { packing: "NOT_APPLICABLE", dateStage: "sew" });
    const tried = await publish(notApplicable, { stageId: notApplicable.r.ids.pack });
    expect(tried.status).toBe(409);
    expect(["NOT_IN_SCHEDULE", "NOT_REQUIRED"]).toContain(tried.body.error.details.reason);

    /* Required, on the route, in the schedule — and with no dates. */
    const undated = await world("pack-undated", { dateStage: "sew" });
    const blank = await publish(undated, { stageId: undated.r.ids.pack });
    expect(blank.status).toBe(409);
    expect(blank.body.error.details.reason).toBe("UNDATED");

    for (const x of [w, notApplicable, undated]) {
      expect(await PpcStagePublication.countDocuments({ companyId: x.co._id })).toBe(0);
    }
  });

  test("a stale schedule version, a retired plan and a moved source each block", async () => {
    const stale = await world("pack-stale");
    const out = await publish(stale, { expectedScheduleVersion: 9 });
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_SCHEDULE_STALE");

    /* A plan that no longer owns its line publishes nothing from it. */
    const retired = await world("pack-retired");
    const cancelled = await call(`${PPC}/planning-files/${retired.planId}/cancel`, { token: retired.approver.token,
      company: retired.co._id, method: "POST", key: key(),
      body: { expectedRevision: (await PpcPlanningFile.findById(retired.planId).lean()).revision,
        reason: "ORDER_CANCELLED_UPSTREAM", note: "The buyer withdrew this order line." } });
    expect(cancelled.status).toBe(200);
    const dead = await publish(retired);
    expect(dead.status).toBe(409);
    expect(dead.body.error.code).toBe("PPC_STAGE_SCHEDULE_CLOSED");

    /* A frozen input that has moved since the plan was built. */
    const moved = await world("pack-moved");
    await fx.SalesHandoverVersion.updateOne({ _id: moved.file.currentHandoverVersionId },
      { $set: { "executionProjection.totalQuantity": moved.quantity + 50 } });
    const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    await ExecutionFile.updateOne({ _id: moved.file._id },
      { $set: { "currentExecutionProjection.totalQuantity": moved.quantity + 50 } });
    const shifted = await publish(moved);
    expect(shifted.status).toBe(409);
    expect(shifted.body.error.code).toBe("PPC_PUBLISH_SOURCE_MOVED");

    for (const x of [stale, retired, moved]) {
      expect(await PpcStagePublication.countDocuments({ companyId: x.co._id })).toBe(0);
    }
  });

  test("a work order of another company or another line may not be named", async () => {
    const w = await world("pack-foreignwo");
    const other = await world("pack-foreignwo-b");
    for (const id of [String(other.wo._id), String(new mongoose.Types.ObjectId())]) {
      const res = await publish(w, { workOrderIds: [id] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PPC_PUBLISH_WORKORDER_INELIGIBLE");
      /* And the refusal discloses nothing about the other company's line. */
      expect(JSON.stringify(res.body)).not.toContain(other.lineRef);
    }
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a historical unlinked work order is not a receiver", async () => {
    const w = await world("pack-unlinked", { workOrders: 1 });
    await WorkOrder.updateOne({ _id: w.wo._id }, { $unset: { salesLineLink: "" } });
    const out = await publish(w);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_NO_WORKORDER");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ PACKAGING & DISPATCH'S OWN DOOR ══════════════════════════════════════ */

describe("Packaging & Dispatch reads and answers its own targets", () => {
  test("one Sales line is one answer, however many work orders show it", async () => {
    const w = await world("pack-grain", { workOrders: 3 });
    const id = (await publish(w)).body.publication.publicationId;

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.targets).toHaveLength(1);
    expect(seen.body.targets[0]).toMatchObject({
      publicationId: id, scheduleVersionNo: 1, quantity: w.quantity,
      plannedStart: WINDOW.start, plannedEnd: WINDOW.end, state: "AWAITING",
      awaitingResponse: true, isAcceptedDeadline: false,
      completesPacking: false, authorisesDispatch: false, releasesProduction: false,
    });
    expect(Object.keys(seen.body.byWorkOrder).sort()).toEqual(w.wos.map((x) => String(x._id)).sort());
    for (const row of Object.values(seen.body.byWorkOrder)) expect(row.publicationId).toBe(id);

    /* Answering on one settles the line. */
    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    const after = await targetsFor(w, `workOrderId=${w.wos[2]._id}`);
    expect(after.body.byWorkOrder[String(w.wos[2]._id)].state).toBe("ACCEPTED");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id, state: "AWAITING" })).toBe(0);
  });

  test("a viewer reads and cannot answer; an editor answers", async () => {
    const w = await world("pack-roles");
    const id = (await publish(w)).body.publication.publicationId;

    const read = await targetsFor(w, `moId=${w.mo._id}`, w.pkgViewer);
    expect(read.status).toBe(200);
    expect(read.body.targets).toHaveLength(1);
    expect(read.body.access).toEqual({ canRespond: false });
    const refused = await answer(w, id, "accept", {}, w.pkgViewer);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");

    const editorRead = await targetsFor(w, `moId=${w.mo._id}`);
    expect(editorRead.body.access).toEqual({ canRespond: true });
    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.state).toBe("ACCEPTED");
    expect(said.body.target.isAcceptedDeadline).toBe(true);
    /* The responder is the session, and nothing else. */
    expect(said.body.target.response.byName).toBe(w.pkgEditor.name);
  });

  test("PPC, Production, Cutting, Embroidery and an ungranted person open no door here", async () => {
    const w = await world("pack-strangers");
    const id = (await publish(w)).body.publication.publicationId;

    const outsiders = {
      ppc: w.planner,
      production: await fx.actor({ companies: [w.co], grants: { "project-manager": "editor" } }),
      cutting: await fx.actor({ companies: [w.co], grants: { cutting_master: "editor" } }),
      embroidery: await fx.actor({ companies: [w.co], grants: { embroidery: "editor" } }),
      none: await fx.actor({ companies: [w.co] }),
    };
    for (const [who, p] of Object.entries(outsiders)) {
      const read = await targetsFor(w, `moId=${w.mo._id}`, p);
      expect([who, read.status]).toEqual([who, 403]);
      for (const decision of ["accept", "refuse"]) {
        const tried = await answer(w, id, decision, { reason: "We would rather not." }, p);
        expect([who, decision, tried.status]).toEqual([who, decision, 403]);
      }
    }
    /* PPC published it and still cannot answer it. */
    const still = await PpcStagePublication.findById(id).lean();
    expect(still.state).toBe("AWAITING");
    expect(still.response?.state).toBeUndefined();
  });

  test("a refusal needs a reason, and carries it back to PPC", async () => {
    const w = await world("pack-refuse");
    const id = (await publish(w)).body.publication.publicationId;

    for (const reason of [undefined, "", "   ", "no", "aaaaaaaaaaaa"]) {
      const tried = await answer(w, id, "refuse", reason === undefined ? {} : { reason });
      expect(tried.status).toBe(400);
      expect(tried.body.error.code).toBe("PACKING_TARGET_REFUSAL_REASON_REQUIRED");
    }
    const said = await answer(w, id, "refuse", { reason: "Cartons for this style arrive on the 6th." });
    expect(said.status).toBe(200);
    expect(said.body.target.state).toBe("REFUSED");
    expect(said.body.target.response.reason).toBe("Cartons for this style arrive on the 6th.");

    /* PPC sees the refusal on its own schedule, and its dates did not move. */
    const seen = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id });
    const pack = seen.body.stages.find((s) => s.process === "PACKING");
    expect(pack.handoff.state).toBe("REFUSED");
    expect(pack.handoff.message).toContain("Cartons for this style arrive");
    expect(pack.plannedStart).toBe(WINDOW.start);
  });

  test("two answers race to one winner; the same answer replays; a different one is refused", async () => {
    const w = await world("pack-race");
    const id = (await publish(w)).body.publication.publicationId;
    const second = await person(w.co, { grants: { "packaging-dispatch": "editor" }, name: "Second" });

    const [a, b] = await Promise.all([
      answer(w, id, "accept"),
      answer(w, id, "refuse", { reason: "The carton stock is not in yet." }, second),
    ]);
    expect([a, b].filter((r) => r.status === 200)).toHaveLength(1);
    const loser = [a, b].find((r) => r.status !== 200);
    expect(loser.body.error.code).toBe("PACKING_TARGET_ALREADY_ANSWERED");

    const settled = await PpcStagePublication.findById(id).lean();
    const winner = settled.state === "ACCEPTED" ? w.pkgEditor : second;
    const decision = settled.state === "ACCEPTED" ? "accept" : "refuse";

    const again = await answer(w, id, decision, { reason: "The carton stock is not in yet." }, winner);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.target.state).toBe(settled.state);

    const flip = await answer(w, id, decision === "accept" ? "refuse" : "accept",
      { reason: "On reflection we cannot." }, winner);
    expect(flip.status).toBe(409);
    const unchanged = await PpcStagePublication.findById(id).lean();
    expect(unchanged.state).toBe(settled.state);
    expect(String(unchanged.response.at)).toBe(String(settled.response.at));
  });

  test("a retired plan's target leaves the queue and cannot be answered", async () => {
    const w = await world("pack-retire-answer");
    const id = (await publish(w)).body.publication.publicationId;
    const cancelled = await call(`${PPC}/planning-files/${w.planId}/cancel`, { token: w.approver.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: (await PpcPlanningFile.findById(w.planId).lean()).revision,
        reason: "ORDER_CANCELLED_UPSTREAM", note: "The buyer withdrew this order line." } });
    expect(cancelled.status).toBe(200);

    expect((await targetsFor(w, `moId=${w.mo._id}`)).body.targets).toEqual([]);
    const tried = await answer(w, id, "accept");
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("PACKING_TARGET_PLAN_RETIRED");
    expect((await PpcStagePublication.findById(id).lean()).state).toBe("AWAITING");
  });

  test("a successor keeps the old target's dates and answer, and needs a fresh one", async () => {
    const w = await world("pack-successor");
    const first = (await publish(w)).body.publication;
    expect((await answer(w, first.publicationId, "accept")).status).toBe(200);

    const saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`, { token: w.planner.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: 1, reason: "Cartons now land two days later than planned.",
        stages: [{ stageId: w.r.ids.pack, plannedStart: "2026-11-04", plannedEnd: "2026-11-06" }] } });
    expect(saved.status).toBe(200);

    const next = await publish(w, { expectedScheduleVersion: 2, reason: "Cartons now land two days later than planned." });
    expect(next.status).toBe(201);
    const p = next.body.publication;
    expect(p.publicationVersionNo).toBe(2);
    expect(p.state).toBe("AWAITING");
    expect(p.changes).toEqual([{ fromStart: WINDOW.start, fromEnd: WINDOW.end,
      toStart: "2026-11-04", toEnd: "2026-11-06" }]);

    const old = await PpcStagePublication.findById(first.publicationId).lean();
    expect(old.state).toBe("SUPERSEDED");
    expect(old.isCurrent).toBe(false);
    expect(old.plannedStart).toBe(WINDOW.start);
    expect(old.response.state).toBe("ACCEPTED");
    expect(String(old.supersededByVersionId)).toBe(p.publicationId);

    /* Only the successor is in the queue, and only it can be answered. */
    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets.map((t) => t.publicationId)).toEqual([p.publicationId]);
    const stranger = await person(w.co, { grants: { "packaging-dispatch": "editor" }, name: "Third" });
    const stale = await answer(w, first.publicationId, "accept", {}, stranger);
    expect(stale.status).toBe(409);
    const fresh = await answer(w, p.publicationId, "accept");
    expect(fresh.status).toBe(200);
    expect(fresh.body.target.plannedStart).toBe("2026-11-04");
  });
});

/* ══ BOUNDARIES ═══════════════════════════════════════════════════════════ */

describe("what a packing answer is not, and what this door must not show", () => {
  test("answering writes no packaging record, label, scan, quantity, dispatch, booking or release", async () => {
    const w = await world("pack-writes-nothing");
    const before = await WorkOrder.find({ "salesLineLink.companyId": w.co._id }).sort({ _id: 1 }).lean();
    const id = (await publish(w)).body.publication.publicationId;

    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.completesPacking).toBe(false);
    expect(said.body.target.authorisesDispatch).toBe(false);
    expect(said.body.target.releasesProduction).toBe(false);
    expect(said.body.target.booksCapacity).toBe(false);

    /* The work orders are byte-identical: no packagingRecords, no packed
       units, no packagedQuantity, no completion moved. */
    const after = await WorkOrder.find({ "salesLineLink.companyId": w.co._id }).sort({ _id: 1 }).lean();
    expect(after).toEqual(before);
    for (const wo of after) {
      expect(wo.packagingRecords || []).toEqual([]);
      expect(wo.packagedQuantity || 0).toBe(0);
      expect(wo.dispatchedQuantity || 0).toBe(0);
    }
    expect(await DispatchChallan.countDocuments({})).toBe(0);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await CustomerRequest.countDocuments({ _id: w.mo._id })).toBe(1);

    /* And the stored publication gained no field beyond the answer. */
    const stored = await PpcStagePublication.findById(id).lean();
    expect(stored.capacityBooking).toBeNull();
    expect(Object.keys(stored.response).sort()).toEqual(["at", "by", "reason", "state"]);
  });

  test("a cutting target is invisible here and unanswerable here", async () => {
    const w = await world("pack-notcutting");
    /* The cutting stage is DATED BY A RESERVATION — a cutting window cannot
       be typed — and that reservation writes its own schedule version on top
       of the packing dates this world already saved. */
    await fx.reserveCutting(w.co, { planningFileId: w.planId, actor: w.planner, from: "2026-10-01" });
    const cut = await publish(w, { stageId: w.r.ids.cut, expectedScheduleVersion: 2 });
    expect(cut.status).toBe(201);
    expect(cut.body.publication.process).toBe("CUTTING");

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets).toEqual([]);
    for (const decision of ["accept", "refuse"]) {
      const tried = await answer(w, cut.body.publication.publicationId, decision,
        { reason: "This is not ours to answer." });
      expect(tried.status).toBe(404);
      expect(tried.body.error.code).toBe("PACKING_TARGET_NOT_FOUND");
    }
    expect((await PpcStagePublication.findById(cut.body.publication.publicationId).lean()).state).toBe("AWAITING");

    /* And symmetrically: Cutting's own door does not show the packing one. */
    const cutter = await person(w.co, { dept: "cutting-master", role: "cutting_master", name: "Cutter" });
    const packId = (await publish(w, { expectedScheduleVersion: 2 })).body.publication.publicationId;
    const onCut = await call(`${CUT}/stage-targets?workOrderId=${w.wo._id}`, { token: cutter.token });
    expect(onCut.status).toBe(200);
    expect(onCut.body.targets.map((t) => t.publicationId)).not.toContain(packId);
  });

  test("another company's target, and an unlinked work order, reveal nothing", async () => {
    const mine = await world("pack-mine");
    const theirs = await world("pack-theirs");
    const theirId = (await publish(theirs)).body.publication.publicationId;
    expect((await publish(mine)).status).toBe(201);

    const peek = await call(`${PACK}?moId=${theirs.mo._id}`,
      { token: mine.pkgEditor.token, company: mine.co._id });
    expect(peek.status).toBe(200);
    expect(peek.body.targets).toEqual([]);
    expect(peek.body.byWorkOrder).toEqual({});
    const tried = await answer(mine, theirId, "accept");
    expect(tried.status).toBe(404);
    expect(tried.body.error.code).toBe("PACKING_TARGET_NOT_FOUND");

    /* A historical work order with no Sales-line link is nobody's. */
    const orphan = await WorkOrder.create({ customerRequestId: mine.mo._id, stockItemId: mine.item._id,
      stockItemName: mine.item.name, quantity: 10, status: "in_progress" });
    const asked = await call(`${PACK}?workOrderId=${orphan._id}`,
      { token: mine.pkgEditor.token, company: mine.co._id });
    expect(asked.status).toBe(200);
    expect(asked.body.byWorkOrder).toEqual({});
    const byMo = await call(`${PACK}?moId=${mine.mo._id}`,
      { token: mine.pkgEditor.token, company: mine.co._id });
    expect(Object.keys(byMo.body.byWorkOrder)).toEqual([String(mine.wo._id)]);
  });
});
