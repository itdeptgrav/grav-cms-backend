// test/ppc/ppc-cutting-stage-publication.test.js
//
// PPC PUBLISHES ONE CUTTING TARGET; CUTTING ACCEPTS OR REFUSES THAT VERSION.
//
// Both doors mounted as the server mounts them, in one in-memory database.
// Pinned:
//
//   · saving stage dates publishes nothing; publishing is its own command,
//     and freezes the whole identity — company, permanent Sales line, plan and
//     generation, schedule version, frozen IE release and stage, Sales'
//     confirmed quantity, the dates, every linked WorkOrder, actor and time;
//   · PPC reads "internal target only" → "awaiting Cutting's response" →
//     "accepted deadline" / "refused, with reason" / "superseded";
//   · a refusal needs a reason, changes no PPC date and completes nothing;
//   · a retried publish returns the original; a replan publishes a NEW version
//     carrying the old dates and the reason, and the old version keeps the
//     answer Cutting had already given it;
//   · two lines of one style keep separate targets;
//   · another company and another line are not found, and leak nothing;
//   · a historical unlinked WorkOrder, a stale schedule version and a moved
//     source each refuse, and publish nothing;
//   · PPC cannot answer for Cutting, Cutting cannot move PPC's dates, and
//     neither writes a booking, a Production release or a cut record;
//   · a plan that stops owning its line takes its target with it: PPC reads
//     it as superseded, Cutting cannot answer it, and a successor plan leaves
//     exactly one live target for the Sales line.
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
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const { nextKey, company, pack, minutes, release, orderLine, actor } = require("./planningFixtures");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const CUT = "/api/cms/manufacturing/cutting-master";
const CUTRES = "/api/cms/manufacturing/cutting-master/resources";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use(CUTRES, require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingResourceRoutes"));
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

/** A Cutting-department session in one company. */
async function cutter(co, { name = "Cutter" } = {}) {
  const n = ++seq;
  const email = `cut${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `C${n}`, email, biometricId: `CT${n}${Date.now()}`,
    isActive: true, gender: "Other", department: "Cutting", designation: "Cutting master" });
  await DeptUser.create({ name, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  /* An explicit Cutting grant. Publishing a resource configures the Cutting
     department, and once any grant exists the guard stops failing open on a
     department session alone — so a Cutting user in a configured department
     holds a role, exactly as a real one would. */
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  await DepartmentRole.create({ departmentSlug: "cutting-master", email, name, role: "editor",
    isActive: true, departmentId: new mongoose.Types.ObjectId() });
  return { emp, token: jwt.sign({ id: String(emp._id), email, name: `${name} C${n}`, role: "cutting_master",
    deptSlug: "cutting-master", employeeId: emp.biometricId },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

/* ── IE's route: cutting, then sewing. Printing and washing are answered. ── */
const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
function route() {
  const ids = { cut: sid(), sew: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: sid(), sequence: 2, process: "PRINTING", label: "Printing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
    { stageId: ids.sew, sequence: 3, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [ids.cut] },
    { stageId: sid(), sequence: 4, process: "WASHING", label: "Washing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
  ] };
}

/* Sales' approved statement for the line, as the handover freezes it. */
const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no embroidery", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no print", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no wash", evidence },
] });

/* ══ CUTTING'S OWN RESOURCE, AND THE RESERVATION ON IT ════════════════════
 *
 * A cutting stage's dates are written from a capacity reservation, never
 * typed — so a world that publishes a cutting target must have a published
 * Cutting resource and a booking on it, exactly as a real one would.
 */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 6
  ? { working: true, shifts: [{ shiftKey: "A", start: "09:00", end: "18:00", breakMinutes: 60 }] }
  : { working: false, shifts: [] }));

/** A Cutting editor of this company, and one published resource. */
async function cuttingResource(co, { efficiency = 90 } = {}) {
  const n = ++seq;
  const email = `cutres${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: "Res", lastName: `C${n}`, email,
    biometricId: `CRX${n}${Date.now()}`, isActive: true, gender: "Other", department: "Cutting" });
  await DeptUser.create({ name: "Res", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Res" });
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  await DepartmentRole.create({ departmentSlug: "cutting-master", email, name: "Res", role: "editor",
    isActive: true, departmentId: new mongoose.Types.ObjectId() });
  const token = jwt.sign({ id: String(emp._id), email, name: `Res C${n}`, role: "cutting_master",
    deptSlug: "cutting-master", employeeId: emp.biometricId },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

  const body = {
    resourceRef: `CUT-${n}-${Date.now()}`, name: `Table ${n}`, siteRef: "UNIT-1",
    resourceType: "STRAIGHT_KNIFE", timezone: "Asia/Kolkata", isActive: true,
    effectiveFrom: "2026-01-01", effectiveTo: null, weekPattern: WEEK, exceptions: [],
    crew: [{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }],
    operationalEfficiencyPercent: efficiency,
  };
  const saved = await call(`${CUTRES}`, { token, company: co._id, method: "POST", body });
  expect(saved.status).toBe(201);
  const live = await call(`${CUTRES}/${body.resourceRef}/publish`,
    { token, company: co._id, method: "POST", body: {} });
  expect(live.status).toBe(200);
  return live.body.resource;
}

/** Preview, then reserve — the only way a cutting stage gets dates. */
async function reserveCutting(w, { from = "2026-10-01" } = {}) {
  const seen = await call(`${PPC}/planning-files/${w.pf}/cutting-capacity?from=${from}`,
    { token: w.approver.token, company: w.co._id });
  expect(seen.status).toBe(200);
  const option = seen.body.preview.options?.[0];
  expect(option).toBeTruthy();
  /* The same `from` the preview was read with: the proof covers the window,
     so booking a different one is refused as stale. */
  const booked = await call(`${PPC}/planning-files/${w.pf}/cutting-capacity/book?from=${from}`,
    { token: w.approver.token, company: w.co._id, method: "POST", key: nextKey(),
      body: { resourceRef: option.resourceRef, proof: option.proof } });
  expect([booked.status, booked.body?.error?.code]).toEqual([201, undefined]);
  return booked.body;
}

/** One order line with its own WorkOrder and plan. */
async function line(co, label, styleId, r, { linkWorkOrder = true, quantity = 500, dateStage = "cut" } = {}) {
  /* A permanent Sales line reference in its real shape — the WorkOrder link
     refuses anything else. */
  const file = await orderLine(co, { lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(), quantity });
  await pack(co, file);
  await minutes(co, file);
  const planner = await actor({ companies: [co], grants: { ppc: "editor" } });

  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-P-${++seq}`, reference: `REF-P-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 5,
    variants: [{ sku: `VP-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  const mo = await CustomerRequest.create({ requestId: `CR-P-${++seq}`, customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: "Buyer" }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  const wo = await WorkOrder.create({
    customerRequestId: mo._id, stockItemId: item._id, stockItemName: item.name, quantity, status: "in_progress",
    ...(linkWorkOrder ? { salesLineLink: { companyId: co._id, customerRequestId: mo._id,
      lineRef: file.handoverLineRef, basis: "sales_line", linkedAt: new Date() } } : {}),
  });

  const created = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: nextKey() });
  expect(created.status).toBe(201);
  const pf = created.body.planningFile.planningFileId;
  const approver = await actor({ companies: [co], grants: { ppc: "approver" } });
  const out = { co, file, planner, approver, pf, wo, mo, item, r,
    lineRef: file.handoverLineRef, quantity };

  if (dateStage === "cut") {
    /* Cutting: a published resource and a reservation on it. The schedule
       version is written from the booking. */
    out.resource = await cuttingResource(co);
    out.booking = (await reserveCutting(out)).booking;
    /* The window the RESERVATION produced, not one this test chose. It is
       what the roster and the approved standard actually allow, so the
       assertions below read it rather than assert a date nobody authored. */
    out.win = { start: out.booking.windowStart, end: out.booking.windowEnd };
  } else {
    /* Any other stage is still PPC's own to date. */
    const saved = await call(`${PPC}/planning-files/${pf}/stage-schedule`, { token: planner.token, company: co._id,
      method: "POST", key: nextKey(),
      body: { expectedRevision: 0, stages: [{ stageId: r.ids[dateStage], plannedStart: "2026-10-01", plannedEnd: "2026-10-05" }] } });
    expect(saved.status).toBe(200);
    out.win = { start: "2026-10-01", end: "2026-10-05" };
  }
  return out;
}

/** A company with an IE release, its cutting user, and one ready line. */
async function world(label, opts = {}) {
  const co = await company(label);
  const r = route();
  const styleId = new mongoose.Types.ObjectId();
  const rel = await release(co, styleId, { processRoute: r.stages });
  const l = await line(co, label, styleId, r, opts);
  return { ...l, r, rel: rel.release, styleId, cutting: await cutter(co) };
}

const schedule = (w) => call(`${PPC}/planning-files/${w.pf}/stage-schedule`, { token: w.planner.token, company: w.co._id });
const publish = (w, body = {}, { key = nextKey(), who = w.planner } = {}) => call(
  `${PPC}/planning-files/${w.pf}/stage-schedule/publish`,
  { token: who.token, company: w.co._id, method: "POST", key,
    body: { stageId: w.r.ids.cut, expectedScheduleVersion: 1, ...body } },
);
const cuttingTargets = (w, query, who = w.cutting) => call(`${CUT}/stage-targets?${query}`, { token: who.token });
const answer = (w, id, decision, body = {}, who = w.cutting) => call(`${CUT}/stage-targets/${id}/${decision}`,
  { token: who.token, method: "POST", body });
const cutStage = async (w) => (await schedule(w)).body.stages.find((s) => s.process === "CUTTING");

/* ══ PUBLISHING ═══════════════════════════════════════════════════════════ */

describe("PPC publishes one cutting target", () => {
  test("saving dates publishes nothing; publishing freezes the whole identity", async () => {
    const w = await world("PubOk");
    const before = await cutStage(w);
    expect(before.handoff).toMatchObject({ state: "NOT_PUBLISHED" });
    expect(before.publication).toBeNull();
    expect(await PpcStagePublication.countDocuments({})).toBe(0);

    const res = await publish(w);
    expect(res.status).toBe(201);
    const p = res.body.publication;
    expect(p).toMatchObject({
      state: "AWAITING", publicationVersionNo: 1, isCurrent: true,
      companyId: String(w.co._id), orderLineRef: w.lineRef,
      planningFileId: String(w.pf), scheduleVersionNo: 1,
      process: "CUTTING", stageId: w.r.ids.cut, stageLabel: "Cutting",
      confirmedQuantity: w.quantity, plannedStart: w.win.start, plannedEnd: w.win.end,
      isAcceptedDeadline: false, booksCapacity: false, releasesProduction: false, recordsProgress: false,
    });
    expect(p.ieRelease).toMatchObject({ releaseId: String(w.rel._id), releaseRef: w.rel.releaseRef, versionNo: 1 });
    expect(p.planningGeneration).toBe((await PpcPlanningFile.findById(w.pf).lean()).generation);
    expect(p.workOrders.map((x) => [x.workOrderId, x.lineRef, x.basis]))
      .toEqual([[String(w.wo._id), w.lineRef, "sales_line"]]);
    expect(p.publishedByName).toBe(w.planner.name);
    expect(p.publishedAt).toBeTruthy();
  });

  test("PPC then reads awaiting, and Cutting sees it in its own queue", async () => {
    const w = await world("PubAwait");
    await publish(w);
    const stage = await cutStage(w);
    expect(stage.handoff).toMatchObject({ state: "AWAITING_CUTTING", publicationVersionNo: 1 });
    expect(stage.handoff.message).toMatch(/awaiting Cutting's response/);
    expect(stage.publication).toMatchObject({ state: "AWAITING" });

    const seen = await cuttingTargets(w, `workOrderId=${w.wo._id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.targets).toHaveLength(1);
    expect(seen.body.targets[0]).toMatchObject({
      orderLineRef: w.lineRef, quantity: w.quantity, plannedStart: w.win.start, plannedEnd: w.win.end,
      awaitingResponse: true, isAcceptedDeadline: false, releasesProduction: false,
    });
    /* And on the order, through the queue Cutting already uses. */
    const detail = await call(`${CUT}/manufacturing-orders/${w.mo._id}`, { token: w.cutting.token });
    expect(detail.body.workOrders[0].ppcTarget).toMatchObject({ publicationId: seen.body.targets[0].publicationId });
    const queue = await call(`${CUT}/manufacturing-orders`, { token: w.cutting.token });
    const row = queue.body.manufacturingOrders.find((o) => String(o._id) === String(w.mo._id));
    expect(row.awaitingPpcTargetCount).toBe(1);
  });

  test("a retried publish returns the original publication, not a second one", async () => {
    const w = await world("PubRetry");
    const key = nextKey();
    const a = await publish(w, {}, { key });
    const b = await publish(w, {}, { key });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.replayed).toBe(true);
    expect(b.body.publication.publicationId).toBe(a.body.publication.publicationId);
    expect(await PpcStagePublication.countDocuments({ planningFileId: new mongoose.Types.ObjectId(w.pf) })).toBe(1);
  });

  test("two lines of one style keep separate targets", async () => {
    const co = await company("PubTwin");
    const r = route();
    const styleId = new mongoose.Types.ObjectId();
    await release(co, styleId, { processRoute: r.stages });
    const a = { ...(await line(co, "TwinA", styleId, r)), r, cutting: await cutter(co) };
    const b = { ...(await line(co, "TwinB", styleId, r, { quantity: 300 })), r, cutting: a.cutting };

    expect((await publish(a)).status).toBe(201);
    const onlyA = await cuttingTargets(a, `workOrderId=${a.wo._id},${b.wo._id}`);
    expect(onlyA.body.targets).toHaveLength(1);
    expect(onlyA.body.targets[0].orderLineRef).toBe(a.lineRef);
    expect((await cutStage(b)).handoff.state).toBe("NOT_PUBLISHED");

    expect((await publish(b)).status).toBe(201);
    const both = await cuttingTargets(a, `workOrderId=${a.wo._id},${b.wo._id}`);
    expect(both.body.targets.map((t) => [t.orderLineRef, t.quantity]).sort())
      .toEqual([[a.lineRef, 500], [b.lineRef, 300]].sort());
    expect(both.body.byWorkOrder[String(a.wo._id)].orderLineRef).toBe(a.lineRef);
    expect(both.body.byWorkOrder[String(b.wo._id)].orderLineRef).toBe(b.lineRef);
  });
});

/* ══ WHAT IS REFUSED ══════════════════════════════════════════════════════ */

describe("nothing is published on a broken link", () => {
  const publishedNothing = async (w) => expect(await PpcStagePublication.countDocuments({
    planningFileId: new mongoose.Types.ObjectId(w.pf),
  })).toBe(0);

  test("a historical unlinked WorkOrder is not a receiver", async () => {
    const w = await world("PubUnlinked", { linkWorkOrder: false });
    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PUBLISH_NO_WORKORDER");
    expect(res.body.error.message).toMatch(/never matched by style, number or customer/);
    await publishedNothing(w);
    expect((await cutStage(w)).handoff).toMatchObject({ state: "NOT_CONNECTED", reason: "WORKORDER_NOT_LINKED" });
  });

  test("a WorkOrder of another company or another line may not be named", async () => {
    const w = await world("PubForeignWo");
    const other = await world("PubForeignWoB");
    for (const id of [String(other.wo._id), String(new mongoose.Types.ObjectId())]) {
      const res = await publish(w, { workOrderIds: [id] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("PPC_PUBLISH_WORKORDER_INELIGIBLE");
      expect(JSON.stringify(res.body)).not.toContain(other.lineRef);
    }
    await publishedNothing(w);
  });

  test("a stale schedule version, an undated other stage, and an unknown stage", async () => {
    const w = await world("PubStale");
    const stale = await publish(w, { expectedScheduleVersion: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PPC_PUBLISH_SCHEDULE_STALE");
    expect(stale.body.error.details).toMatchObject({ expectedScheduleVersion: 7, currentScheduleVersion: 1 });

    /* Sewing is another stage entirely, and this call refuses it. It is
       undated in this world, which is the first thing wrong with it.
       (It used to refuse as NO_RECEIVER; Production receives sewing targets
       now, and ppc-sewing-stage-publication.test.js owns that path and the
       remaining receiverless processes. Cutting's own behaviour is
       unchanged: this stage is not Cutting's, and nothing is published.) */
    const sewing = await publish(w, { stageId: w.r.ids.sew });
    expect(sewing.status).toBe(409);
    expect(sewing.body.error.code).toBe("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE");
    expect(sewing.body.error.details.reason).toBe("UNDATED");

    const unknown = await publish(w, { stageId: "stg_nope" });
    expect(unknown.body.error.details.reason).toBe("NOT_IN_SCHEDULE");
    await publishedNothing(w);
  });

  test("an undated cutting stage is not publishable", async () => {
    /* A schedule that dates sewing and leaves cutting blank. */
    const co = await company("PubUndated");
    const r = route();
    const styleId = new mongoose.Types.ObjectId();
    await release(co, styleId, { processRoute: r.stages });
    const w = { ...(await line(co, "Undated", styleId, r, { dateStage: "sew" })), r, cutting: await cutter(co) };

    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("UNDATED");
    expect(res.body.error.message).toMatch(/Plan it before publishing it/);
    await publishedNothing(w);
  });

  test("a source that has moved refuses until the plan is reconciled", async () => {
    const w = await world("PubMoved");
    /* Sales re-confirms the line at a different quantity: the plan is frozen
       on the old one, and a target must not be published from a basis that
       has moved underneath it. */
    const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    await ExecutionFile.collection.updateOne({ _id: w.file._id },
      { $set: { "currentExecutionProjection.totalQuantity": w.quantity + 250 } });
    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PUBLISH_SOURCE_MOVED");
    await publishedNothing(w);
  });

  test("the same schedule version cannot be published twice with different content", async () => {
    const w = await world("PubConflict");
    expect((await publish(w)).status).toBe(201);
    /* The dates move underneath, without a new schedule version. No command
       does this — a cutting window is written only from its booking — so the
       collections are written raw, and the RESERVATION is moved with them so
       that the content fence is what answers rather than the booking gate. */
    const { CuttingCapacityBooking } = require("../../models/CMS_Models/PPC/CuttingCapacityBooking");
    await PpcStageSchedule.collection.updateOne(
      { planningFileId: new mongoose.Types.ObjectId(w.pf) },
      { $set: { "stages.0.plannedEnd": "2026-10-09" } },
    );
    await CuttingCapacityBooking.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(w.booking.bookingId) },
      { $set: { windowEnd: "2026-10-09" } },
    );
    const res = await publish(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PUBLISH_CONTENT_CONFLICT");
    expect(await PpcStagePublication.countDocuments({ planningFileId: new mongoose.Types.ObjectId(w.pf) })).toBe(1);
  });

  test("another company's plan is not found, and its line is not disclosed", async () => {
    const w = await world("PubIso");
    const other = await world("PubIsoB");
    const res = await call(`${PPC}/planning-files/${w.pf}/stage-schedule/publish`, {
      token: other.planner.token, company: other.co._id, method: "POST", key: nextKey(),
      body: { stageId: w.r.ids.cut, expectedScheduleVersion: 1 },
    });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(w.lineRef);
    await publishedNothing(w);
  });
});

/* ══ CUTTING ANSWERS ══════════════════════════════════════════════════════ */

describe("Cutting accepts or refuses that exact version", () => {
  test("acceptance is the only thing that makes it an accepted deadline", async () => {
    const w = await world("AnsAccept");
    const { publicationId } = (await publish(w)).body.publication;

    const ok = await answer(w, publicationId, "accept");
    expect(ok.status).toBe(200);
    expect(ok.body.target).toMatchObject({ state: "ACCEPTED", isAcceptedDeadline: true, awaitingResponse: false });
    expect(ok.body.target.response).toMatchObject({ state: "ACCEPTED" });

    const stage = await cutStage(w);
    expect(stage.handoff).toMatchObject({ state: "ACCEPTED_DEADLINE" });
    expect(stage.handoff.message).toContain(`Cutting accepted this target: ${w.win.start} → ${w.win.end}.`);
    /* The same answer again, from the same person, is that answer — a double
       click is not a failure — but changing it needs a new published version. */
    const again = await answer(w, publicationId, "accept");
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.target.response.at).toBe(ok.body.target.response.at);

    const changedMind = await answer(w, publicationId, "refuse", { reason: "Actually the fabric lands late." });
    expect(changedMind.status).toBe(409);
    expect(changedMind.body.error.code).toBe("CUTTING_TARGET_ALREADY_ANSWERED");
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("ACCEPTED");
  });

  test("two Cutting editors answering at once: one answer stands, and it is not overwritten", async () => {
    const w = await world("AnsRace");
    const { publicationId } = (await publish(w)).body.publication;
    const second = await cutter(w.co, { name: "Meena" });

    /* Both are looking at the same awaiting target. */
    const [a, b] = await Promise.all([
      answer(w, publicationId, "accept"),
      answer(w, publicationId, "refuse", { reason: "Fabric for this line lands on the 4th." }, second),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const stored = await PpcStagePublication.findById(publicationId).lean();
    const winner = a.status === 200 ? a : b;
    expect(stored.state).toBe(winner.body.target.state);
    expect(String(stored.response.by.name)).toBe(winner.body.target.response.byName);
    /* And the loser is told whose decision it was, not silently ignored. */
    const loser = a.status === 200 ? b : a;
    expect(loser.body.error.code).toBe("CUTTING_TARGET_ALREADY_ANSWERED");
  });

  test("a target of a retired plan leaves Cutting's queue and cannot be answered", async () => {
    const w = await world("AnsRetired");
    const { publicationId } = (await publish(w)).body.publication;
    expect((await cuttingTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toHaveLength(1);

    /* PPC withdraws the plan: it no longer owns its line. */
    const plan = await PpcPlanningFile.findById(w.pf).lean();
    const approver = await actor({ companies: [w.co], grants: { ppc: "approver" } });
    const cancelled = await call(`${PPC}/planning-files/${w.pf}/cancel`, { token: approver.token, company: w.co._id,
      method: "POST", key: nextKey(), body: { expectedRevision: plan.revision, reason: "OPENED_IN_ERROR" } });
    expect(cancelled.status).toBe(200);

    expect((await cuttingTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toEqual([]);
    const res = await answer(w, publicationId, "accept");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CUTTING_TARGET_PLAN_RETIRED");
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");
  });

  test("a withdrawn plan's target reads as superseded on PPC's own screen", async () => {
    const w = await world("SupDisplay");
    const { publicationId } = (await publish(w)).body.publication;
    expect((await cutStage(w)).handoff.state).toBe("AWAITING_CUTTING");

    const plan = await PpcPlanningFile.findById(w.pf).lean();
    const approver = await actor({ companies: [w.co], grants: { ppc: "approver" } });
    expect((await call(`${PPC}/planning-files/${w.pf}/cancel`, { token: approver.token, company: w.co._id,
      method: "POST", key: nextKey(), body: { expectedRevision: plan.revision, reason: "OPENED_IN_ERROR" } })).status).toBe(200);

    const stage = await cutStage(w);
    expect(stage.handoff).toMatchObject({ state: "SUPERSEDED" });
    expect(stage.handoff.message).toMatch(/no longer owns its line.*Cutting cannot answer it/);
    expect(stage.publication).toMatchObject({ state: "SUPERSEDED", isAcceptedDeadline: false });
    /* The record itself is untouched — the reading is what changed. */
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");
  });

  test("a successor plan leaves exactly one live target for the Sales line", async () => {
    const w = await world("SupSuccessor");
    const first = (await publish(w)).body.publication;
    await answer(w, first.publicationId, "refuse", { reason: "Fabric for this line lands on the 4th." });

    /* PPC replaces the plan: the successor owns the line from here. */
    const plan = await PpcPlanningFile.findById(w.pf).lean();
    const approver = await actor({ companies: [w.co], grants: { ppc: "approver" } });
    const successor = await call(`${PPC}/planning-files/${w.pf}/successor`, { token: approver.token, company: w.co._id,
      method: "POST", key: nextKey(),
      body: { expectedRevision: plan.revision, reason: "The execution pack moved; this line needs a fresh plan." } });
    expect(successor.status).toBe(201);
    const pf2 = successor.body.planningFile.planningFileId;

    /* The retired plan's target is already unanswerable. */
    expect((await cuttingTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toEqual([]);

    /* The successor plans and publishes its own. */
    /* The successor reserves its own capacity from the 6th — the retired
       plan's reservation is still held, so this is a genuine second booking
       against the same resource. */
    const w2 = { ...w, pf: pf2 };
    w2.booking = (await reserveCutting(w2, { from: "2026-10-06" })).booking;
    w2.win = { start: w2.booking.windowStart, end: w2.booking.windowEnd };
    expect(w2.win.start).toBe("2026-10-06");
    const second = await publish(w2);
    expect(second.status).toBe(201);
    expect(second.body.publication).toMatchObject({ publicationVersionNo: 1, state: "AWAITING", plannedStart: w2.win.start });

    /* Exactly one live target for this line, and it is the successor's. */
    const live = await PpcStagePublication.find({ orderLineRef: w.lineRef, isCurrent: true }).lean();
    expect(live.map((p) => String(p.planningFileId))).toEqual([String(pf2)]);
    const old = await PpcStagePublication.findById(first.publicationId).lean();
    expect(old).toMatchObject({ state: "SUPERSEDED", isCurrent: false });
    expect(old.response.state).toBe("REFUSED");            // Cutting's answer is kept
    expect(String(old.supersededByVersionId)).toBe(second.body.publication.publicationId);

    /* Cutting sees one target: the successor's. */
    const seen = await cuttingTargets(w, `workOrderId=${w.wo._id}`);
    expect(seen.body.targets.map((t) => t.plannedStart)).toEqual([w2.win.start]);
  });

  test("Cutting's door answers only cutting targets", async () => {
    const w = await world("AnsProcess");
    const { publicationId } = (await publish(w)).body.publication;
    /* The publication record is the shape every published stage will use.
       Cutting must not see or answer another department's target. */
    await PpcStagePublication.collection.updateOne({ _id: new mongoose.Types.ObjectId(publicationId) },
      { $set: { process: "SEWING" } });

    expect((await cuttingTargets(w, `workOrderId=${w.wo._id}`)).body.targets).toEqual([]);
    const res = await answer(w, publicationId, "accept");
    expect(res.status).toBe(404);
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");
  });

  test("a refusal needs a reason, and changes no PPC date", async () => {
    const w = await world("AnsRefuse");
    const { publicationId } = (await publish(w)).body.publication;

    for (const reason of [undefined, "no", "aaaaaaaaaaaa"]) {
      const bad = await answer(w, publicationId, "refuse", { reason });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("CUTTING_TARGET_REFUSAL_REASON_REQUIRED");
    }
    const res = await answer(w, publicationId, "refuse", { reason: "Fabric for this line lands on the 4th." });
    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ state: "REFUSED", isAcceptedDeadline: false });

    const stage = await cutStage(w);
    expect(stage.handoff).toMatchObject({ state: "REFUSED" });
    expect(stage.handoff.message).toMatch(/Cutting refused this target: Fabric for this line lands on the 4th\./);
    /* PPC's own dates are untouched — a refusal is not a replan. */
    expect([stage.plannedStart, stage.plannedEnd]).toEqual([w.win.start, w.win.end]);
    expect((await PpcStageSchedule.findOne({ planningFileId: new mongoose.Types.ObjectId(w.pf) }).lean()).versionNo).toBe(1);
  });

  test("a replan publishes a new version and keeps the old target with its answer", async () => {
    const w = await world("AnsReplan");
    const first = (await publish(w)).body.publication;
    await answer(w, first.publicationId, "refuse", { reason: "Fabric lands on the 4th, cutting cannot start on the 1st." });

    /* PPC replans by MOVING THE RESERVATION. The schedule version that
       follows is written from the successor booking, not typed. */
    const seen = await call(`${PPC}/planning-files/${w.pf}/cutting-capacity?from=2026-10-05`,
      { token: w.approver.token, company: w.co._id });
    expect(seen.status).toBe(200);
    const option = seen.body.preview.options.find((o) => o.resourceRef === w.booking.resource.resourceRef);
    const moved = await call(`${PPC}/cutting-bookings/${w.booking.bookingId}/replan?from=2026-10-05`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: nextKey(),
        body: { resourceRef: option.resourceRef, proof: option.proof,
          reason: "PLAN_CHANGED", note: "Cutting cannot start before the fabric lands." } });
    expect([moved.status, moved.body?.error?.code]).toEqual([201, undefined]);
    const win2 = { start: moved.body.booking.windowStart, end: moved.body.booking.windowEnd };
    expect(win2.start).toBe("2026-10-05");

    const bare = await publish(w, { expectedScheduleVersion: 2 });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe("PPC_PUBLISH_REPLAN_REASON_REQUIRED");

    const res = await publish(w, { expectedScheduleVersion: 2, reason: "Fabric lands on the 4th; cutting moves with it." });
    expect(res.status).toBe(201);
    const second = res.body.publication;
    expect(second).toMatchObject({ publicationVersionNo: 2, state: "AWAITING", scheduleVersionNo: 2,
      plannedStart: win2.start, plannedEnd: win2.end, replanReason: "Fabric lands on the 4th; cutting moves with it." });
    expect(second.changes).toEqual([{ fromStart: w.win.start, fromEnd: w.win.end, toStart: win2.start, toEnd: win2.end }]);

    /* The refused version is kept, exactly as Cutting left it. */
    const old = await PpcStagePublication.findById(first.publicationId).lean();
    expect(old).toMatchObject({ state: "SUPERSEDED", isCurrent: false, plannedStart: w.win.start });
    expect(old.response.state).toBe("REFUSED");
    expect(String(old.supersededByVersionId)).toBe(second.publicationId);

    /* PPC reads the new version as awaiting, with the old one in history. */
    const stage = await cutStage(w);
    expect(stage.handoff).toMatchObject({ state: "AWAITING_CUTTING", publicationVersionNo: 2 });
    expect(stage.publicationHistory.map((p) => [p.publicationVersionNo, p.state]))
      .toEqual([[2, "AWAITING"], [1, "SUPERSEDED"]]);
    /* And Cutting can no longer answer the superseded one. */
    const stale = await answer(w, first.publicationId, "accept");
    expect(stale.status).toBe(409);
    expect((await cuttingTargets(w, `workOrderId=${w.wo._id}`)).body.targets.map((t) => t.publicationVersionNo)).toEqual([2]);
  });

  test("another company's cutting user cannot see or answer this target", async () => {
    const w = await world("AnsIso");
    const other = await world("AnsIsoB");
    const { publicationId } = (await publish(w)).body.publication;

    const seen = await cuttingTargets(w, `workOrderId=${w.wo._id}`, other.cutting);
    expect(seen.body.targets).toEqual([]);
    const res = await answer(w, publicationId, "accept", {}, other.cutting);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(w.lineRef);
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");
  });
});

/* ══ WHO OWNS WHAT ════════════════════════════════════════════════════════ */

describe("ownership boundaries hold", () => {
  test("a PPC planner cannot answer for Cutting, and a Cutting user cannot move PPC's dates", async () => {
    const w = await world("Owner");
    const { publicationId } = (await publish(w)).body.publication;

    /* PPC's seat, on Cutting's door: PPC is not the Cutting department. */
    const asPpc = await call(`${CUT}/stage-targets/${publicationId}/accept`,
      { token: w.planner.token, method: "POST", body: {} });
    expect(asPpc.status).toBe(403);
    expect((await PpcStagePublication.findById(publicationId).lean()).state).toBe("AWAITING");

    /* Cutting's seat, on PPC's doors: no schedule, no publish, no plan. */
    for (const [path, body] of [
      [`${PPC}/planning-files/${w.pf}/stage-schedule`, { expectedRevision: 1, stages: [{ stageId: w.r.ids.cut, plannedStart: "2026-11-01", plannedEnd: "2026-11-02" }], reason: "Cutting moving PPC's dates." }],
      [`${PPC}/planning-files/${w.pf}/stage-schedule/publish`, { stageId: w.r.ids.cut, expectedScheduleVersion: 1 }],
    ]) {
      const res = await call(path, { token: w.cutting.token, company: w.co._id, method: "POST", body, key: nextKey() });
      expect(res.status).toBeGreaterThanOrEqual(403);
    }
    const stage = await cutStage(w);
    expect([stage.plannedStart, stage.plannedEnd]).toEqual([w.win.start, w.win.end]);
  });

  test("publishing and answering write no booking, no Production release and no cut record", async () => {
    const w = await world("NoSideEffects");
    const before = await snapshotOutside();
    const { publicationId } = (await publish(w)).body.publication;
    await answer(w, publicationId, "accept");

    expect(await PpcCapacityBooking.countDocuments({})).toBe(0);
    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
    const wo = await WorkOrder.findById(w.wo._id).lean();
    expect(wo.cuttingProgress?.completed || 0).toBe(0);
    expect(wo.cuttingStatus === "completed").toBe(false);
    expect(wo.status).toBe("in_progress");
    expect(await snapshotOutside()).toEqual(before);
  });
});

/** Every collection except PPC's own publication record and command ledger. */
async function snapshotOutside() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (["ppc_stage_publications", "ppc_planning_commands"].includes(name) || name.startsWith("system.")) continue;
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex");
  }
  return out;
}
