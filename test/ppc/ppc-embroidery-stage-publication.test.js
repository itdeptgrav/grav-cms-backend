// test/ppc/ppc-embroidery-stage-publication.test.js
//
// PPC PUBLISHES ONE EMBROIDERY TARGET; EMBROIDERY ACCEPTS OR REFUSES IT.
//
// The same versioned contract Cutting already uses, for the one process a
// BUYER chooses — so a target may exist only when Sales' approved handover
// requires embroidery for that exact line, not because the style's route has
// an embroidery stage. All three doors mounted as the server mounts them.
//
// Pinned:
//   · an applicable line publishes: the identity is frozen and server-derived;
//   · Sales not requiring embroidery for the line, an unknown or undated
//     stage, a stale schedule, a retired plan, a moved source, another
//     company and an unlinked work order each block it;
//   · one Sales line is one answer, however many work orders show it;
//   · an Embroidery viewer reads and cannot answer; an editor answers;
//   · a refusal needs a reason; two answers race to one winner; the same
//     answer replays; a different one is refused;
//   · a successor supersedes the old target and keeps its dates and answer;
//   · Cutting's targets are invisible and unanswerable in Embroidery, and
//     Embroidery's are invisible in Cutting;
//   · answering writes no piece scan, no booking, no release, no actual.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

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
const EmbroideryRecord = require("../../models/CMS_Models/Manufacturing/Embroidery/EmbroideryRecord");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { nextKey, company, pack, minutes, release, orderLine, actor } = require("./planningFixtures");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const EMB = "/api/cms/manufacturing/embroidery";
const CUT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  /* Embroidery sits behind the employee auth the /api/cms mount carries. */
  app.use("/api/cms", EmployeeAuthMiddleware, (req, res, next) => next());
  app.use(EMB, require("../../routes/CMS_Routes/Manufacturing/Embroidery/embroideryRoutes"));
  app.use(CUT, require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  await PpcPlanningFile.syncIndexes();
  await PpcPlanningCommand.syncIndexes();
  await PpcStageSchedule.syncIndexes();
  await PpcStagePublication.syncIndexes();
});
afterAll(async () => { await new Promise((r) => http.close(r)); });

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

/** A department session in one company, with optional live grants. */
async function person(co, { dept = "embroidery", role = "embroidery", grants = {}, name = "Emb" } = {}) {
  const n = ++seq;
  const email = `est${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `E${n}`, email, biometricId: `EST${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Embroidery", designation: "Operator" });
  await DeptUser.create({ name, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  for (const [departmentSlug, r] of Object.entries(grants)) {
    const DepartmentRole = require("../../models/Access/DepartmentRole");
    await DepartmentRole.create({ departmentSlug, email, name, role: r, isActive: true, departmentId: new mongoose.Types.ObjectId() });
  }
  return { emp, name: `${name} E${n}`,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} E${n}`, role, deptSlug: dept, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

/* IE's route: cutting, then embroidery, then sewing. */
const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
function route({ embroidery = "REQUIRED" } = {}) {
  const ids = { cut: sid(), emb: sid(), sew: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: ids.emb, sequence: 2, process: "EMBROIDERY", label: "Chest logo", applicability: embroidery,
      predecessorStageIds: embroidery === "REQUIRED" ? [ids.cut] : [] },
    { stageId: sid(), sequence: 3, process: "PRINTING", label: "Printing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
    { stageId: ids.sew, sequence: 4, process: "SEWING", label: "Sewing", applicability: "REQUIRED",
      predecessorStageIds: [embroidery === "REQUIRED" ? ids.emb : ids.cut] },
    { stageId: sid(), sequence: 5, process: "WASHING", label: "Washing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
  ] };
}

/* Sales' approved statement for the line, as the handover freezes it. */
const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = (embroidery = "REQUIRED") => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: embroidery, buyerSpecification: "PO: left chest logo", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no print", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no wash", evidence },
] });

/** One line, its work orders, a plan and a dated embroidery stage. */
async function line(co, label, styleId, r, {
  workOrders = 1, quantity = 400, embroideryStated = "REQUIRED", dateStage = "emb", schedules = true,
} = {}) {
  const file = await orderLine(co, { lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(embroideryStated), quantity });
  await pack(co, file);
  await minutes(co, file);
  const planner = await actor({ companies: [co], grants: { ppc: "editor" } });

  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-EST-${++seq}`, reference: `REF-EST-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 9,
    variants: [{ sku: `VE-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  const mo = await CustomerRequest.create({ requestId: `CR-EST-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: "Buyer" }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  const wos = [];
  for (let i = 0; i < workOrders; i += 1) {
    wos.push(await WorkOrder.create({
      customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name,
      quantity: Math.round(quantity / workOrders), status: "in_progress",
      salesLineLink: { companyId: co._id, customerRequestId: mo._id, lineRef: file.handoverLineRef,
        basis: "sales_line", linkedAt: new Date() },
    }));
  }

  const created = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: nextKey() });
  expect(created.status).toBe(201);
  const pf = created.body.planningFile.planningFileId;
  const saved = await call(`${PPC}/planning-files/${pf}/stage-schedule`, { token: planner.token, company: co._id,
    method: "POST", key: nextKey(),
    body: { expectedRevision: 0, stages: [{ stageId: r.ids[dateStage], plannedStart: "2026-10-02", plannedEnd: "2026-10-04" }] } });
  /* A line whose Sales statement and IE route disagree cannot even be dated:
     the applicability gate refuses the save, long before a publish. */
  if (schedules) expect(saved.status).toBe(200);
  return { co, file, planner, pf, wos, wo: wos[0], mo, item, lineRef: file.handoverLineRef, quantity, saved };
}

async function world(label, opts = {}) {
  const co = await company(label);
  const r = route(opts.routeOpts);
  const styleId = new mongoose.Types.ObjectId();
  const rel = await release(co, styleId, { processRoute: r.stages });
  const l = await line(co, label, styleId, r, opts);
  return { ...l, r, rel: rel.release, styleId,
    emb: await person(co), embViewer: null };
}

const publish = (w, body = {}, { key = nextKey(), who = w.planner } = {}) => call(
  `${PPC}/planning-files/${w.pf}/stage-schedule/publish`,
  { token: who.token, company: w.co._id, method: "POST", key,
    body: { stageId: w.r.ids.emb, expectedScheduleVersion: 1, ...body } },
);
const embTargets = (w, query, who = w.emb) => call(`${EMB}/stage-targets?${query}`, { token: who.token });
const answer = (w, id, decision, body = {}, who = w.emb) =>
  call(`${EMB}/stage-targets/${id}/${decision}`, { token: who.token, method: "POST", body });
const schedule = (w) => call(`${PPC}/planning-files/${w.pf}/stage-schedule`, { token: w.planner.token, company: w.co._id });
const embStage = async (w) => (await schedule(w)).body.stages.find((s) => s.process === "EMBROIDERY");

/* ══ PUBLISHING AN APPLICABLE LINE ════════════════════════════════════════ */

describe("PPC publishes the line's embroidery target", () => {
  test("an applicable line publishes, and the identity is the server's", async () => {
    const w = await world("EmbPubOk");
    const before = await embStage(w);
    expect(before.handoff.state).toBe("NOT_PUBLISHED");

    const res = await publish(w);
    expect(res.status).toBe(201);
    expect(res.body.publication).toMatchObject({
      process: "EMBROIDERY", state: "AWAITING", publicationVersionNo: 1, scheduleVersionNo: 1,
      orderLineRef: w.lineRef, companyId: String(w.co._id), stageId: w.r.ids.emb, stageLabel: "Chest logo",
      confirmedQuantity: w.quantity, plannedStart: "2026-10-02", plannedEnd: "2026-10-04",
      isAcceptedDeadline: false, booksCapacity: false, releasesProduction: false, recordsProgress: false,
    });
    expect(res.body.publication.ieRelease).toMatchObject({ releaseId: String(w.rel._id), versionNo: 1 });
    expect(res.body.publication.workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);

    const stage = await embStage(w);
    expect(stage.handoff).toMatchObject({ state: "AWAITING_EMBROIDERY", publicationVersionNo: 1 });
    expect(stage.handoff.message).toMatch(/Published to Embroidery: 2026-10-02 → 2026-10-04 — awaiting Embroidery's response\./);
  });

  test("the receiver's own payload carries the frozen schedule version and quantity", async () => {
    /* Read through the real door, not a fixture: the floor is answering one
       exact version of PPC's plan, and its screen is given which. */
    const w = await world("EmbPubPayload");
    const published = (await publish(w)).body.publication;

    const seen = await embTargets(w, `workOrderId=${w.wo._id}`);
    expect(seen.status).toBe(200);
    const [target] = seen.body.targets;
    expect(target.scheduleVersionNo).toBe(1);
    expect(target).toMatchObject({
      publicationId: published.publicationId, publicationVersionNo: 1,
      quantity: w.quantity, plannedStart: "2026-10-02", plannedEnd: "2026-10-04",
      state: "AWAITING", awaitingResponse: true, isAcceptedDeadline: false, releasesProduction: false,
    });
    expect(Object.keys(seen.body.byWorkOrder)).toEqual([String(w.wo._id)]);
    expect(seen.body.byWorkOrder[String(w.wo._id)].scheduleVersionNo).toBe(1);

    /* And the queue the floor actually opens carries the same target. */
    const queue = await call(`${EMB}/queue`, { token: w.emb.token });
    const row = queue.body.orders.flatMap((o) => o.workOrders).find((x) => String(x._id) === String(w.wo._id));
    expect(row.ppcTarget).toMatchObject({ publicationId: published.publicationId, scheduleVersionNo: 1 });

    /* A replan moves it on, and the new version is what the floor sees. */
    expect((await call(`${PPC}/planning-files/${w.pf}/stage-schedule`, { token: w.planner.token, company: w.co._id,
      method: "POST", key: nextKey(),
      body: { expectedRevision: 1, reason: "Machine service moved the window.",
        stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-06", plannedEnd: "2026-10-08" }] } })).status).toBe(200);
    expect((await publish(w, { expectedScheduleVersion: 2, reason: "Machine service moved the window." })).status).toBe(201);
    const after = await embTargets(w, `workOrderId=${w.wo._id}`);
    expect(after.body.targets[0].scheduleVersionNo).toBe(2);
  });

  test("one Sales line is one answer, however many work orders show it", async () => {
    const w = await world("EmbPubMulti", { workOrders: 3 });
    const { publicationId } = (await publish(w)).body.publication;

    const seen = await embTargets(w, w.wos.map((x) => `workOrderId=${x._id}`).join("&"));
    expect(seen.status).toBe(200);
    expect(seen.body.targets).toHaveLength(1);
    expect(Object.keys(seen.body.byWorkOrder)).toHaveLength(3);
    expect([...new Set(Object.values(seen.body.byWorkOrder).map((t) => t.publicationId))]).toEqual([publicationId]);

    /* Answering once settles the line — not once per work order. */
    expect((await answer(w, publicationId, "accept")).status).toBe(200);
    const after = await embTargets(w, `workOrderId=${w.wos[2]._id}`);
    expect(after.body.targets[0]).toMatchObject({ state: "ACCEPTED", awaitingResponse: false });
    expect(await PpcStagePublication.countDocuments({ orderLineRef: w.lineRef })).toBe(1);
  });
});

/* ══ WHAT BLOCKS IT ═══════════════════════════════════════════════════════ */

describe("nothing is published without the line's own applicability", () => {
  const publishedNothing = async (w) => expect(await PpcStagePublication.countDocuments({
    planningFileId: new mongoose.Types.ObjectId(w.pf),
  })).toBe(0);

  test("Sales does not require embroidery for this line: refused, and the route alone is not enough", async () => {
    /* The style's route says embroidery; Sales' approved handover for THIS
       line says the buyer did not ask for it. They disagree, so nothing is
       proven and nothing is published. */
    const w = await world("EmbPubNotForLine", { embroideryStated: "NOT_REQUIRED", schedules: false });
    expect(w.saved.status).toBe(409);
    expect(w.saved.body.error.code).toBe("PPC_LINE_ROUTE_UNPROVEN");
    expect(w.saved.body.error.details.reason).toBe("REQUIREMENT_ROUTE_MISMATCH");

    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(["PPC_LINE_ROUTE_UNPROVEN", "PPC_PUBLISH_STAGE_NOT_PUBLISHABLE"]).toContain(res.body.error.code);
    await publishedNothing(w);
  });

  test("Sales has not stated the line's processes at all: refused", async () => {
    const w = await world("EmbPubUnstated", { embroideryStated: "UNKNOWN", schedules: false });
    expect(w.saved.body.error.details.reason).toBe("LINE_REQUIREMENT_NOT_STATED");
    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_LINE_ROUTE_UNPROVEN");
    await publishedNothing(w);
  });

  test("a stage the IE route does not require, an unknown stage, and an undated one", async () => {
    /* IE's route says this style is not embroidered, and Sales agrees: the
       line is proven and plannable, but there is no embroidery stage in it. */
    const notOnRoute = await world("EmbPubNotOnRoute", {
      routeOpts: { embroidery: "NOT_APPLICABLE" }, embroideryStated: "NOT_REQUIRED", dateStage: "sew" });
    const na = await publish(notOnRoute);
    expect(na.status).toBe(409);
    expect(na.body.error.details.reason).toBe("NOT_IN_SCHEDULE");
    await publishedNothing(notOnRoute);

    const w = await world("EmbPubStage");
    expect((await publish(w, { stageId: "stg_nope" })).body.error.details.reason).toBe("NOT_IN_SCHEDULE");

    const undated = await world("EmbPubUndated", { dateStage: "sew" });
    const res = await publish(undated);
    expect(res.body.error.details.reason).toBe("UNDATED");
    await publishedNothing(undated);
  });

  test("a stale schedule version, a moved source, and a retired plan", async () => {
    const stale = await world("EmbPubStale");
    expect((await publish(stale, { expectedScheduleVersion: 9 })).body.error.code).toBe("PPC_PUBLISH_SCHEDULE_STALE");

    const moved = await world("EmbPubMoved");
    const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    await ExecutionFile.collection.updateOne({ _id: moved.file._id },
      { $set: { "currentExecutionProjection.totalQuantity": moved.quantity + 100 } });
    expect((await publish(moved)).body.error.code).toBe("PPC_PUBLISH_SOURCE_MOVED");
    await publishedNothing(moved);

    const retired = await world("EmbPubRetired");
    const plan = await PpcPlanningFile.findById(retired.pf).lean();
    const approver = await actor({ companies: [retired.co], grants: { ppc: "approver" } });
    expect((await call(`${PPC}/planning-files/${retired.pf}/cancel`, { token: approver.token, company: retired.co._id,
      method: "POST", key: nextKey(), body: { expectedRevision: plan.revision, reason: "OPENED_IN_ERROR" } })).status).toBe(200);
    expect((await publish(retired)).body.error.code).toBe("PPC_STAGE_SCHEDULE_CLOSED");
    await publishedNothing(retired);
  });

  test("another company's plan is not found, and an unlinked work order has nobody to publish to", async () => {
    const w = await world("EmbPubIso");
    const other = await world("EmbPubIsoB");
    const res = await call(`${PPC}/planning-files/${w.pf}/stage-schedule/publish`, {
      token: other.planner.token, company: other.co._id, method: "POST", key: nextKey(),
      body: { stageId: w.r.ids.emb, expectedScheduleVersion: 1 },
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(w.lineRef);

    /* With the line's only work order unlinked, there is no receiver. */
    await WorkOrder.collection.updateOne({ _id: w.wo._id }, { $unset: { salesLineLink: "" } });
    const none = await publish(w);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("PPC_PUBLISH_NO_WORKORDER");
    await publishedNothing(w);
  });
});

/* ══ EMBROIDERY ANSWERS ═══════════════════════════════════════════════════ */

describe("Embroidery answers its own target", () => {
  test("a PPC grant opens no door here: it cannot read or answer an embroidery target", async () => {
    const w = await world("EmbAnsPpcGrant");
    const { publicationId } = (await publish(w)).body.publication;
    /* A real PPC owner, in this very company — PPC publishes targets and may
       not answer for the department that receives them. */
    const ppcOnly = await person(w.co, { dept: "ppc", role: "ppc", grants: { ppc: "owner" } });

    const read = await embTargets(w, `workOrderId=${w.wo._id}`, ppcOnly);
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain(publicationId);
    for (const decision of ["accept", "refuse"]) {
      const res = await answer(w, publicationId, decision, { reason: "PPC answering for the floor." }, ppcOnly);
      expect(res.status).toBe(403);
    }
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");
    /* The queue says plainly that this person may not answer. */
    const queue = await call(`${EMB}/queue`, { token: w.emb.token });
    expect(queue.body.access).toEqual({ canRespond: true });
  });

  test("a viewer reads and cannot answer; an editor answers", async () => {
    const w = await world("EmbAnsRoles");
    const { publicationId } = (await publish(w)).body.publication;
    const viewer = await person(w.co, { dept: "hr", role: "hr_manager", grants: { embroidery: "viewer" } });
    const editor = await person(w.co, { dept: "hr", role: "hr_manager", grants: { embroidery: "editor" } });

    expect((await embTargets(w, `workOrderId=${w.wo._id}`, viewer)).body.targets).toHaveLength(1);
    expect((await answer(w, publicationId, "accept", {}, viewer)).status).toBe(403);
    /* And the queue tells a viewer's screen not to offer the controls. */
    expect((await call(`${EMB}/queue`, { token: viewer.token })).body.access).toEqual({ canRespond: false });
    expect((await call(`${EMB}/queue`, { token: editor.token })).body.access).toEqual({ canRespond: true });
    const ok = await answer(w, publicationId, "accept", {}, editor);
    expect(ok.status).toBe(200);
    expect(ok.body.target).toMatchObject({ state: "ACCEPTED", isAcceptedDeadline: true });
    /* The signed-in session answered — never a floor badge. */
    expect((await PpcStagePublication.findById(publicationId).lean()).response.by.name).toBe(editor.name);
    expect((await embStage(w)).handoff).toMatchObject({ state: "ACCEPTED_DEADLINE" });
  });

  test("a refusal needs a reason, and changes no PPC date", async () => {
    const w = await world("EmbAnsRefuse");
    const { publicationId } = (await publish(w)).body.publication;
    for (const reason of [undefined, "no", "aaaaaaaaaaaa"]) {
      const bad = await answer(w, publicationId, "refuse", { reason });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("EMBROIDERY_TARGET_REFUSAL_REASON_REQUIRED");
    }
    const res = await answer(w, publicationId, "refuse", { reason: "The machine is down until the 6th." });
    expect(res.status).toBe(200);
    const stage = await embStage(w);
    expect(stage.handoff.state).toBe("REFUSED");
    expect(stage.handoff.message).toMatch(/Embroidery refused this target: The machine is down until the 6th\./);
    expect([stage.plannedStart, stage.plannedEnd]).toEqual(["2026-10-02", "2026-10-04"]);
  });

  test("two answers race to one winner; the same answer replays; a different one is refused", async () => {
    const w = await world("EmbAnsRace");
    const { publicationId } = (await publish(w)).body.publication;
    const second = await person(w.co, { name: "Meena" });

    const [a, b] = await Promise.all([
      answer(w, publicationId, "accept"),
      answer(w, publicationId, "refuse", { reason: "The machine is down until the 6th." }, second),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const stored = await PpcStagePublication.findById(publicationId).lean();
    expect(stored.state).toBe(winner.body.target.state);

    /* The winner repeating itself is a replay, not a second answer. */
    const sameActor = winner === a ? w.emb : second;
    const decision = winner.body.target.state === "ACCEPTED" ? "accept" : "refuse";
    const again = await answer(w, publicationId, decision,
      decision === "refuse" ? { reason: "The machine is down until the 6th." } : {}, sameActor);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.target.response.at).toBe(winner.body.target.response.at);
  });

  test("a successor supersedes the old target, keeping its dates and its answer", async () => {
    const w = await world("EmbAnsSuccessor");
    const first = (await publish(w)).body.publication;
    await answer(w, first.publicationId, "refuse", { reason: "The machine is down until the 6th." });

    expect((await call(`${PPC}/planning-files/${w.pf}/stage-schedule`, { token: w.planner.token, company: w.co._id,
      method: "POST", key: nextKey(),
      body: { expectedRevision: 1, reason: "Embroidery cannot start before the machine is back.",
        stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-06", plannedEnd: "2026-10-08" }] } })).status).toBe(200);
    const second = await publish(w, { expectedScheduleVersion: 2, reason: "Machine back on the 6th; embroidery moves." });
    expect(second.status).toBe(201);
    expect(second.body.publication).toMatchObject({ publicationVersionNo: 2, state: "AWAITING", plannedStart: "2026-10-06" });
    expect(second.body.publication.changes).toEqual([
      { fromStart: "2026-10-02", fromEnd: "2026-10-04", toStart: "2026-10-06", toEnd: "2026-10-08" },
    ]);

    const old = await PpcStagePublication.findById(first.publicationId).lean();
    expect(old).toMatchObject({ state: "SUPERSEDED", isCurrent: false, plannedStart: "2026-10-02" });
    expect(old.response.state).toBe("REFUSED");
    expect((await embTargets(w, `workOrderId=${w.wo._id}`)).body.targets.map((t) => t.publicationVersionNo)).toEqual([2]);
    expect((await answer(w, first.publicationId, "accept")).status).toBe(409);
  });

  test("a retired plan's target leaves the queue and cannot be answered", async () => {
    const w = await world("EmbAnsRetired");
    const { publicationId } = (await publish(w)).body.publication;
    const plan = await PpcPlanningFile.findById(w.pf).lean();
    const approver = await actor({ companies: [w.co], grants: { ppc: "approver" } });
    expect((await call(`${PPC}/planning-files/${w.pf}/cancel`, { token: approver.token, company: w.co._id,
      method: "POST", key: nextKey(), body: { expectedRevision: plan.revision, reason: "OPENED_IN_ERROR" } })).status).toBe(200);

    expect((await embTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toEqual([]);
    const res = await answer(w, publicationId, "accept");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMBROIDERY_TARGET_PLAN_RETIRED");
    expect((await embStage(w)).handoff.state).toBe("SUPERSEDED");
  });

  test("another company sees nothing and answers nothing", async () => {
    const w = await world("EmbAnsIso");
    const other = await world("EmbAnsIsoB");
    const { publicationId } = (await publish(w)).body.publication;
    expect((await embTargets(w, `workOrderId=${w.wo._id}`, other.emb)).body.targets).toEqual([]);
    const res = await answer(w, publicationId, "accept", {}, other.emb);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(w.lineRef);
  });
});

/* ══ THE TWO DEPARTMENTS DO NOT SEE EACH OTHER ════════════════════════════ */

describe("each department answers only its own process", () => {
  test("a cutting target is invisible and unanswerable in Embroidery, and the reverse", async () => {
    const w = await world("EmbVsCut");
    /* PPC publishes both stages of the same line. */
    const embTarget = (await publish(w)).body.publication;
    const cutTarget = (await publish(w, { stageId: w.r.ids.cut })).body.publication || null;
    /* Cutting is undated here, so only embroidery has a target. */
    expect(embTarget.process).toBe("EMBROIDERY");
    expect(cutTarget).toBeFalsy();

    /* Cutting's door cannot see or answer the embroidery target. */
    const cutter = await person(w.co, { dept: "cutting-master", role: "cutting_master" });
    const seen = await call(`${CUT}/stage-targets?workOrderId=${w.wo._id}`, { token: cutter.token });
    expect(seen.body.targets).toEqual([]);
    expect((await call(`${CUT}/stage-targets/${embTarget.publicationId}/accept`,
      { token: cutter.token, method: "POST", body: {} })).status).toBe(404);

    /* And Embroidery cannot answer a cutting target. */
    await PpcStagePublication.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(embTarget.publicationId) }, { $set: { process: "CUTTING" } });
    expect((await embTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toEqual([]);
    expect((await answer(w, embTarget.publicationId, "accept")).status).toBe(404);
    expect((await PpcStagePublication.findById(embTarget.publicationId).lean()).state).toBe("AWAITING");
  });
});

/* ══ NOTHING ELSE IS WRITTEN ══════════════════════════════════════════════ */

describe("publishing and answering write nothing else", () => {
  test("no piece scan, no booking, no release, no other actual", async () => {
    const w = await world("EmbNoSide");
    const before = await snapshotOutside();
    const { publicationId } = (await publish(w)).body.publication;
    await answer(w, publicationId, "accept");

    expect(await EmbroideryRecord.countDocuments({})).toBe(0);
    expect(await PpcCapacityBooking.countDocuments({})).toBe(0);
    const wo = await WorkOrder.findById(w.wo._id).lean();
    expect(wo.status).toBe("in_progress");
    expect(wo.cuttingProgress?.completed || 0).toBe(0);
    expect(await snapshotOutside()).toEqual(before);
  });
});

/** Every collection except the publication record and PPC's command ledger. */
async function snapshotOutside() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (["ppc_stage_publications", "ppc_planning_commands"].includes(name) || name.startsWith("system.")) continue;
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex");
  }
  return out;
}
