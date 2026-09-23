// test/ppc/ppc-cutting-capacity-booking.test.js
//
// A CUTTING DATE IS A RESERVATION, NOT A NUMBER SOMEBODY TYPED.
//
// The preview calculates; this reserves. Between the two there is a door the
// whole design rests on: the command carries the plan, the resource and a
// PROOF of the window that was read, and NOTHING ELSE. Every minute, every
// day, every crew figure is recomputed here from IE's approved standard and
// Cutting's published roster, and if any of them moved since the preview was
// read the hashes differ and nothing is booked.
//
// ── THE FIVE WAYS CAPACITY GETS OVERSOLD, AND WHAT STOPS EACH ───────────────
//   1. A client sends its own minutes. The body names three fields; every
//      other one is refused BY NAME rather than ignored.
//   2. A planner books a window they read an hour ago. The proof is
//      recomputed and compared.
//   3. Two planners take the last hour at the same time. One conditional
//      `$inc` per resource-day matches; the other transaction rolls back
//      whole.
//   4. A retry after a timeout books twice. The idempotency ledger returns
//      the first answer.
//   5. A date is typed straight onto the stage. The schedule refuses every
//      CUTTING stage by name, and the publication refuses dates no active
//      reservation backs.
//
// Pinned besides:
//   · the schedule version is WRITTEN FROM the booking, and says so;
//   · release gives the minutes back and keeps the record;
//   · replan supersedes in one transaction, returning before it takes;
//   · a moved source or a republished roster refuses and books nothing;
//   · Cutting's refusal does not release capacity, and its acceptance is a
//     current deadline only while capacity is still held;
//   · a publication frozen before reservations existed is named, not
//     retroactively invalidated;
//   · nothing here writes an actual, a cut record or a Production release;
//   · another company's plan, resource and booking are not found;
//   · Sewing, Embroidery and Packing stages are still PPC's own to date.
"use strict";
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
const { CuttingCapacityBooking, CuttingResourceDay } = require("../../models/CMS_Models/PPC/CuttingCapacityBooking");
const { CuttingResource } = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingResource");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const CUT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use(`${CUT}/resources`, require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingResourceRoutes"));
  app.use(CUT, require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcPlanningCommand, PpcStageSchedule, PpcStagePublication,
    CuttingResource, CuttingCapacityBooking, CuttingResourceDay]) {
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

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
const FROM = "2026-10-05";                           // a Monday
const QUANTITY = 500;

/** A Cutting session in one company. */
async function cutter(co, { role = "editor", name = "Cut" } = {}) {
  const n = ++seq;
  const email = `bkc${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `C${n}`, email,
    biometricId: `BKC${n}${Date.now()}`, isActive: true, gender: "Other", department: "Cutting" });
  await DeptUser.create({ name, email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  const DepartmentRole = require("../../models/Access/DepartmentRole");
  await DepartmentRole.create({ departmentSlug: "cutting-master", email, name, role, isActive: true,
    departmentId: new mongoose.Types.ObjectId() });
  return { emp, email, name: `${name} C${n}`,
    token: jwt.sign({ id: String(emp._id), email, name: `${name} C${n}`, role: "cutting_master",
      deptSlug: "cutting-master", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" }) };
}

/* Mon–Fri, 09:00–17:00 with a 60-minute break: 420 net minutes a day. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 5
  ? { working: true, shifts: [{ shiftKey: "A", start: "09:00", end: "17:00", breakMinutes: 60 }] }
  : { working: false, shifts: [] }));

const RESOURCE = (over = {}) => ({
  resourceRef: `CUT-${++seq}-${Date.now()}`,
  name: "Table 1", siteRef: "UNIT-1", resourceType: "STRAIGHT_KNIFE",
  timezone: "Asia/Kolkata", isActive: true,
  effectiveFrom: "2026-01-01", effectiveTo: null,
  weekPattern: WEEK, exceptions: [],
  crew: [{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }],
  operationalEfficiencyPercent: 75,
  ...over,
});

const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
] });

const route = (standard) => {
  const ids = { cut: sid(), sew: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED",
      predecessorStageIds: [], technicalStandard: standard },
    { stageId: ids.sew, sequence: 2, process: "SEWING", label: "Sewing", applicability: "REQUIRED",
      predecessorStageIds: [ids.cut] },
  ] };
};

/**
 * One company, one plan frozen to IE's standard, Cutting's people — and the
 * commands a planner actually issues.
 */
async function world(label, { standard = fx.cuttingStandard(), quantity = QUANTITY, workOrder = false } = {}) {
  const co = await fx.company(label);
  const r = route(standard);
  const styleId = new mongoose.Types.ObjectId();
  const rel = await fx.release(co, styleId, { processRoute: r.stages });
  const file = await fx.orderLine(co, {
    lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(), quantity,
  });
  await fx.pack(co, file);
  await fx.minutes(co, file);

  const planner = await fx.actor({ companies: [co], grants: { ppc: "editor" } });
  const approver = await fx.actor({ companies: [co], grants: { ppc: "approver" } });
  const created = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: fx.nextKey() });
  expect(created.status).toBe(201);

  const w = { co, file, r, styleId, rel: rel.release, planner, approver, quantity,
    planId: created.body.planningFile.planningFileId, lineRef: file.handoverLineRef };
  w.editor = await cutter(co, { role: "editor" });

  w.publishResource = async (over = {}) => {
    const body = RESOURCE(over);
    const saved = await call(`${CUT}/resources`, { token: w.editor.token, company: co._id, method: "POST", body });
    expect([body.resourceRef, saved.status]).toEqual([body.resourceRef, 201]);
    const live = await call(`${CUT}/resources/${body.resourceRef}/publish`,
      { token: w.editor.token, company: co._id, method: "POST", body: {} });
    expect(live.status).toBe(200);
    return live.body.resource;
  };

  w.preview = (from = FROM, who = w.planner) => call(
    `${PPC}/planning-files/${w.planId}/cutting-capacity?from=${from}`,
    { token: who.token, company: co._id },
  );
  /** The option a planner would take: the resource they chose, as read. */
  w.option = async (resourceRef, from = FROM) => {
    const res = await w.preview(from);
    expect(res.status).toBe(200);
    const o = (res.body.preview.options || []).find((x) => x.resourceRef === resourceRef);
    expect(o).toBeTruthy();
    return o;
  };
  w.book = (option, { from = FROM, who = w.approver, key = fx.nextKey(), body } = {}) => call(
    `${PPC}/planning-files/${w.planId}/cutting-capacity/book?from=${from}`,
    { token: who.token, company: co._id, method: "POST", key,
      body: body || { resourceRef: option.resourceRef, proof: option.proof } },
  );
  /** Preview and reserve in one go — the happy path, used everywhere below. */
  w.reserve = async ({ from = FROM, resourceRef = null } = {}) => {
    const res = await w.preview(from);
    const o = resourceRef
      ? res.body.preview.options.find((x) => x.resourceRef === resourceRef)
      : res.body.preview.options[0];
    expect(o).toBeTruthy();
    const out = await w.book(o, { from });
    expect([out.status, out.body?.error?.code]).toEqual([201, undefined]);
    return out.body;
  };
  w.schedule = (who = w.planner) => call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
    { token: who.token, company: co._id });
  w.cutStage = async () => (await w.schedule()).body.stages.find((s) => s.process === "CUTTING");
  w.bookings = (who = w.planner) => call(`${PPC}/planning-files/${w.planId}/cutting-bookings`,
    { token: who.token, company: co._id });
  w.publish = (body = {}, { key = fx.nextKey() } = {}) => call(
    `${PPC}/planning-files/${w.planId}/stage-schedule/publish`,
    { token: w.planner.token, company: co._id, method: "POST", key,
      body: { stageId: r.ids.cut, expectedScheduleVersion: 1, ...body } },
  );

  if (workOrder) {
    const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-B-${++seq}`, reference: `REF-B-${seq}`,
      category: "Garment", createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 5,
      variants: [{ sku: `VB-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
    w.mo = await CustomerRequest.create({ requestId: `CR-B-${++seq}`, customerId: new mongoose.Types.ObjectId(),
      customerInfo: { name: "Buyer" }, status: "quotation_sales_approved",
      items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
    w.wo = await WorkOrder.create({
      customerRequestId: w.mo._id, stockItemId: item._id, stockItemName: item.name, quantity,
      status: "in_progress",
      salesLineLink: { companyId: co._id, customerRequestId: w.mo._id, lineRef: file.handoverLineRef,
        basis: "sales_line", linkedAt: new Date() },
    });
    w.cutting = await cutter(co, { role: "editor", name: "Queue" });
    w.targets = (who = w.cutting) => call(`${CUT}/stage-targets?workOrderId=${w.wo._id}`, { token: who.token });
    w.answer = (id, decision, body = {}, who = w.cutting) => call(`${CUT}/stage-targets/${id}/${decision}`,
      { token: who.token, method: "POST", body });
  }
  return w;
}

/** The ledger row for one resource-day, or null. */
const ledger = (co, resourceRef, date) => CuttingResourceDay.findOne({
  companyId: co._id, resourceRef, date,
}).lean();

/* ══ 1 · THE EXACT PREVIEW, AND ONLY THAT ═════════════════════════════════ */

describe("a booking takes the previewed window, and nothing the client sent", () => {
  test("the reservation freezes the arithmetic, the ledger holds the minutes, and the schedule follows", async () => {
    const w = await world("bk-ok");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);

    /* 420 net × 3 crew × 75% = 945 a day; the work is 445 minutes. */
    expect([option.days[0].capacityMinutes, option.days[0].usedMinutes]).toEqual([945, 445]);
    expect(await CuttingResourceDay.countDocuments({})).toBe(0);

    const res = await w.book(option);
    expect(res.status).toBe(201);
    const b = res.body.booking;

    expect(b).toMatchObject({
      state: "ACTIVE", generation: 1,
      orderLineRef: w.lineRef, planningFileId: w.planId, stageId: w.r.ids.cut,
      confirmedQuantity: w.quantity, workloadMinutes: 445, timeBasis: "LABOUR_MINUTES",
      windowStart: FROM, windowEnd: FROM, reservedMinutes: 445,
      headcount: 3, usableCrew: 3,
    });
    expect(b.resource).toMatchObject({
      resourceId: resource.resourceId, resourceRef: resource.resourceRef, versionNo: 1, siteRef: "UNIT-1",
    });
    expect(b.ieRelease).toMatchObject({ releaseId: String(w.rel._id), versionNo: 1 });
    /* Exactly one efficiency is applied, and the other is recorded as the
       one deliberately not applied twice. */
    expect(b.efficiency).toMatchObject({
      appliedPercent: 75, appliedFrom: "CUTTING_OPERATIONAL", appliedOnce: true,
      informationalOnly: { source: "IE_STANDARD", percent: 80 },
    });
    expect(b.allocations).toEqual([{ date: FROM, availableMinutes: 945, reservedMinutes: 445 }]);
    expect(b.standardFingerprint).toMatch(/^[0-9a-f]{16,}$/);

    /* THE LEDGER: one row, holding exactly those minutes. */
    const row = await ledger(w.co, resource.resourceRef, FROM);
    expect(row).toMatchObject({ reservedMinutes: 445, availableMinutes: 945, resourceVersionNo: 1 });

    /* AND THE SCHEDULE IS WRITTEN FROM IT — version 1, authored by the
       reservation, naming the resource. */
    const stage = await w.cutStage();
    expect([stage.plannedStart, stage.plannedEnd]).toEqual([FROM, FROM]);
    const sched = await PpcStageSchedule.findOne({ planningFileId: new mongoose.Types.ObjectId(w.planId) }).lean();
    expect(sched.versionNo).toBe(1);
    expect(sched.history[0].reason).toContain(b.bookingRef);
    expect(sched.history[0].reason).toContain("Table 1");
  });

  test("every capacity figure a client sends is refused by name", async () => {
    const w = await world("bk-fields");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);

    for (const extra of [
      { windowStart: "2026-10-05" }, { windowEnd: "2026-10-09" }, { reservedMinutes: 10 },
      { workloadMinutes: 10 }, { allocations: [] }, { usableCrew: 9 }, { capacityMinutes: 9999 },
      { operationalEfficiencyPercent: 100 }, { plannedStart: FROM }, { resourceVersionNo: 2 },
    ]) {
      const res = await w.book(option, {
        body: { resourceRef: option.resourceRef, proof: option.proof, ...extra },
      });
      const field = Object.keys(extra)[0];
      expect([field, res.status, res.body.error.code]).toEqual([field, 400, "FIELD_NOT_ACCEPTED"]);
      /* Named, not ignored: the planner is told which field, and why the
         server owns it. */
      expect(res.body.error.details.field).toBe(field);
      expect(res.body.error.details.fieldErrors[0].message).toContain(field);
    }
    expect(await CuttingCapacityBooking.countDocuments({})).toBe(0);
    expect(await CuttingResourceDay.countDocuments({})).toBe(0);
  });

  test("a proof from a window that has moved is refused, and nothing is reserved", async () => {
    const w = await world("bk-stale");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);

    /* Cutting re-rosters the same table and publishes a new version. */
    expect((await call(`${CUT}/resources`, { token: w.editor.token, company: w.co._id, method: "POST",
      body: RESOURCE({ resourceRef: resource.resourceRef, operationalEfficiencyPercent: 70 }) })).status).toBe(201);
    const republished = await call(`${CUT}/resources/${resource.resourceRef}/publish`,
      { token: w.editor.token, company: w.co._id, method: "POST", body: {} });
    expect(republished.status).toBe(200);

    const res = await w.book(option);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_CUTTING_BOOKING_STALE");
    expect(res.body.error.message).toMatch(/Nothing was booked — preview again\./);
    expect(await CuttingCapacityBooking.countDocuments({})).toBe(0);
    expect(await CuttingResourceDay.countDocuments({})).toBe(0);

    /* Previewing again and booking THAT works. */
    const again = await w.reserve();
    expect(again.booking.resource.versionNo).toBe(2);
  });

  test("a booking with no proof at all says so, and a plan that already holds one is named", async () => {
    const w = await world("bk-noproof");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);

    const bare = await w.book(option, { body: { resourceRef: option.resourceRef } });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe("PPC_CUTTING_BOOKING_PROOF_REQUIRED");

    const first = await w.reserve();
    const second = await w.book(await w.option(resource.resourceRef));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("PPC_CUTTING_BOOKING_NOT_BOOKABLE");
    expect(second.body.error.message).toContain(first.booking.bookingRef);
    expect(await CuttingCapacityBooking.countDocuments({})).toBe(1);
  });
});

/* ══ 2 · THE LEDGER UNDER PRESSURE ════════════════════════════════════════ */

describe("the last free minutes go to exactly one plan", () => {
  test("two planners booking the same resource at the same instant: one wins, one is told why", async () => {
    /* One company, two plans, one table. Each plan needs 445 minutes and the
       day offers 945 — so the FIRST fits and the SECOND cannot, and the two
       commands are issued together. */
    const a = await world("bk-race-a", { quantity: 1000 });
    const resource = await a.publishResource();

    /* A second plan in the same company, on its own Sales line. */
    const b = await (async () => {
      const file = await fx.orderLine(a.co, {
        lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: a.styleId,
        processRequirements: statement(), quantity: 1000,
      });
      await fx.pack(a.co, file);
      await fx.minutes(a.co, file);
      const made = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
        { token: a.planner.token, company: a.co._id, method: "POST", body: {}, key: fx.nextKey() });
      expect(made.status).toBe(201);
      return { planId: made.body.planningFile.planningFileId, lineRef: file.handoverLineRef };
    })();

    const previewOf = async (planId) => {
      const res = await call(`${PPC}/planning-files/${planId}/cutting-capacity?from=${FROM}`,
        { token: a.planner.token, company: a.co._id });
      expect(res.status).toBe(200);
      return res.body.preview.options.find((o) => o.resourceRef === resource.resourceRef);
    };
    const bookOn = (planId, option) => call(
      `${PPC}/planning-files/${planId}/cutting-capacity/book?from=${FROM}`,
      { token: a.approver.token, company: a.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: option.resourceRef, proof: option.proof } });

    /* 45 + 1000 × 0.8 = 845 minutes each; the day offers 945. */
    const [oa, ob] = await Promise.all([previewOf(a.planId), previewOf(b.planId)]);
    expect([oa.days[0].usedMinutes, ob.days[0].usedMinutes]).toEqual([845, 845]);

    const [ra, rb] = await Promise.all([bookOn(a.planId, oa), bookOn(b.planId, ob)]);
    const codes = [ra, rb].map((r) => r.status).sort();
    expect(codes).toEqual([201, 409]);

    const loser = ra.status === 409 ? ra : rb;
    /* Either the ledger refused the minutes or the window moved underneath.
       Both are refusals that reserved nothing; neither is a silent overbook. */
    expect(["PPC_CUTTING_CAPACITY_OVERBOOKED", "PPC_CUTTING_BOOKING_STALE"])
      .toContain(loser.body.error.code);

    /* ONE booking, and the day is not oversold. */
    expect(await CuttingCapacityBooking.countDocuments({ state: "ACTIVE" })).toBe(1);
    const row = await ledger(a.co, resource.resourceRef, FROM);
    expect(row.reservedMinutes).toBe(845);
    expect(row.reservedMinutes).toBeLessThanOrEqual(row.availableMinutes);
  });

  test("a second plan takes the rest of the day, and a third is refused the minutes that are gone", async () => {
    const a = await world("bk-part", { quantity: 500 });          // 445 minutes
    const resource = await a.publishResource();
    await a.reserve();                                            // 445 of 945

    const plan = async (quantity) => {
      const file = await fx.orderLine(a.co, {
        lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: a.styleId,
        processRequirements: statement(), quantity,
      });
      await fx.pack(a.co, file);
      await fx.minutes(a.co, file);
      const made = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
        { token: a.planner.token, company: a.co._id, method: "POST", body: {}, key: fx.nextKey() });
      expect(made.status).toBe(201);
      return made.body.planningFile.planningFileId;
    };
    const optionOn = async (planId) => {
      const res = await call(`${PPC}/planning-files/${planId}/cutting-capacity?from=${FROM}`,
        { token: a.planner.token, company: a.co._id });
      return res.body.preview.options.find((o) => o.resourceRef === resource.resourceRef);
    };

    /* The second plan sees what is LEFT, not what the table offers. */
    const second = await plan(500);
    const o2 = await optionOn(second);
    expect(o2.days[0]).toMatchObject({
      grossCapacityMinutes: 945, reservedByOthersMinutes: 445, capacityMinutes: 500, usedMinutes: 445,
    });
    const r2 = await call(`${PPC}/planning-files/${second}/cutting-capacity/book?from=${FROM}`,
      { token: a.approver.token, company: a.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: o2.resourceRef, proof: o2.proof } });
    expect([r2.status, r2.body?.error?.code]).toEqual([201, undefined]);

    /* 890 of 945 are gone. A third plan needing 445 cannot start on the 5th,
       so its window moves to the next working day — nothing is oversold. */
    const row = await ledger(a.co, resource.resourceRef, FROM);
    expect(row.reservedMinutes).toBe(890);

    const third = await plan(500);
    const o3 = await optionOn(third);
    expect(o3.days[0]).toMatchObject({ reservedByOthersMinutes: 890, capacityMinutes: 55 });
    expect(o3.earliestFinish).toBe("2026-10-06");
    const r3 = await call(`${PPC}/planning-files/${third}/cutting-capacity/book?from=${FROM}`,
      { token: a.approver.token, company: a.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: o3.resourceRef, proof: o3.proof } });
    expect([r3.status, r3.body?.error?.code]).toEqual([201, undefined]);

    const after = await ledger(a.co, resource.resourceRef, FROM);
    expect(after.reservedMinutes).toBe(945);
    expect(after.reservedMinutes).toBeLessThanOrEqual(after.availableMinutes);
  });

  test("a retried booking returns the first answer, and reserves the minutes once", async () => {
    const w = await world("bk-retry");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);
    const key = fx.nextKey();

    const first = await w.book(option, { key });
    const again = await w.book(option, { key });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(again.body.replayed).toBe(true);
    expect(again.body.booking.bookingId).toBe(first.body.booking.bookingId);

    expect(await CuttingCapacityBooking.countDocuments({})).toBe(1);
    expect((await ledger(w.co, resource.resourceRef, FROM)).reservedMinutes).toBe(445);
  });
});

/* ══ 3 · GIVING IT BACK, AND MOVING IT ════════════════════════════════════ */

describe("a reservation is released or replaced, never edited", () => {
  test("release returns the minutes, keeps the record and leaves the dates where they are", async () => {
    const w = await world("bk-release");
    const resource = await w.publishResource();
    const { booking } = await w.reserve();

    const bare = await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(), body: {} });
    expect(bare.status).toBe(400);
    expect(bare.body.error.code).toBe("PPC_CUTTING_BOOKING_REASON_INVALID");

    const res = await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "ORDER_CANCELLED", note: "The buyer withdrew this colourway." } });
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ state: "RELEASED", releaseReason: "ORDER_CANCELLED" });

    /* The minutes are back. */
    expect((await ledger(w.co, resource.resourceRef, FROM)).reservedMinutes).toBe(0);
    /* The record is kept, and the dates it produced are untouched: giving up
       capacity is not un-planning. */
    expect(await CuttingCapacityBooking.countDocuments({})).toBe(1);
    const stage = await w.cutStage();
    expect([stage.plannedStart, stage.plannedEnd]).toEqual([FROM, FROM]);

    /* Releasing twice is not a second release. */
    const twice = await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "OTHER", note: "Trying it a second time." } });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe("PPC_CUTTING_BOOKING_CLOSED");
    expect((await ledger(w.co, resource.resourceRef, FROM)).reservedMinutes).toBe(0);
  });

  test("replan supersedes the old reservation and writes a new schedule version from the new one", async () => {
    const w = await world("bk-replan");
    const resource = await w.publishResource();
    const { booking } = await w.reserve();

    /* A fresh preview from a later date — the plan's OWN held minutes are not
       competition for itself, so the successor is proved against the ledger
       without them. */
    const res = await call(`${PPC}/planning-files/${w.planId}/cutting-capacity?from=2026-10-07`,
      { token: w.planner.token, company: w.co._id });
    const option = res.body.preview.options.find((o) => o.resourceRef === resource.resourceRef);
    expect(option.days[0].reservedByOthersMinutes).toBe(0);

    const moved = await call(`${PPC}/cutting-bookings/${booking.bookingId}/replan?from=2026-10-07`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: option.resourceRef, proof: option.proof,
          reason: "PLAN_CHANGED", note: "Fabric now lands on the 6th." } });
    expect([moved.status, moved.body?.error?.code]).toEqual([201, undefined]);
    expect(moved.body.booking).toMatchObject({
      state: "ACTIVE", generation: 2, windowStart: "2026-10-07", windowEnd: "2026-10-07",
      supersedesBookingRef: booking.bookingRef,
    });
    expect(moved.body.supersededBookingRef).toBe(booking.bookingRef);

    /* The old one stepped down and gave its minutes back, in the same
       transaction that took the new ones. */
    const old = await CuttingCapacityBooking.findById(booking.bookingId).lean();
    expect(old.state).toBe("SUPERSEDED");
    expect(String(old.supersededByBookingId)).toBe(moved.body.booking.bookingId);
    expect((await ledger(w.co, resource.resourceRef, FROM)).reservedMinutes).toBe(0);
    expect((await ledger(w.co, resource.resourceRef, "2026-10-07")).reservedMinutes).toBe(445);

    /* One ACTIVE booking, and the schedule now reads the new window. */
    expect(await CuttingCapacityBooking.countDocuments({ state: "ACTIVE" })).toBe(1);
    const stage = await w.cutStage();
    expect([stage.plannedStart, stage.plannedEnd]).toEqual(["2026-10-07", "2026-10-07"]);
    const sched = await PpcStageSchedule.findOne({ planningFileId: new mongoose.Types.ObjectId(w.planId) }).lean();
    expect(sched.versionNo).toBe(2);

    /* Every reservation this stage has had is readable, newest first. */
    const all = await w.bookings();
    expect(all.body.bookings.map((b) => [b.generation, b.state])).toEqual([[2, "ACTIVE"], [1, "SUPERSEDED"]]);
    expect(all.body.active.bookingId).toBe(moved.body.booking.bookingId);
  });

  test("a moved source refuses the booking, and a republished roster refuses it", async () => {
    /* SALES MOVES. */
    const a = await world("bk-source");
    const resourceA = await a.publishResource();
    const optionA = await a.option(resourceA.resourceRef);
    const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    await ExecutionFile.collection.updateOne({ _id: a.file._id },
      { $set: { "currentExecutionProjection.totalQuantity": a.quantity + 250 } });
    const movedSource = await a.book(optionA);
    expect(movedSource.status).toBe(409);
    expect(movedSource.body.error.code).toBe("PPC_CUTTING_BOOKING_STALE");
    expect(await CuttingResourceDay.countDocuments({})).toBe(0);

    /* CUTTING MOVES — the same table, republished with a shorter shift. */
    const b = await world("bk-roster");
    const resourceB = await b.publishResource();
    const optionB = await b.option(resourceB.resourceRef);
    const edited = await call(`${CUT}/resources`,
      { token: b.editor.token, company: b.co._id, method: "POST",
        body: RESOURCE({ resourceRef: resourceB.resourceRef, operationalEfficiencyPercent: 60 }) });
    expect(edited.status).toBe(201);
    expect((await call(`${CUT}/resources/${resourceB.resourceRef}/publish`,
      { token: b.editor.token, company: b.co._id, method: "POST", body: {} })).status).toBe(200);

    const movedRoster = await b.book(optionB);
    expect(movedRoster.status).toBe(409);
    expect(movedRoster.body.error.code).toBe("PPC_CUTTING_BOOKING_STALE");
    expect(await CuttingCapacityBooking.countDocuments({ companyId: b.co._id })).toBe(0);
  });
});

/* ══ 4 · WHAT THE RESERVATION MEANS DOWNSTREAM ════════════════════════════ */

describe("a cutting target stands on a reservation, and says when it stops", () => {
  test("dates with no reservation behind them cannot be published", async () => {
    const w = await world("bk-nopub", { workOrder: true });
    await w.publishResource();
    const { booking } = await w.reserve();

    /* Give the capacity up, then try to publish the dates it produced. */
    expect((await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "CAPACITY_CONFLICT", note: "The table is needed for a rush order." } })).status).toBe(200);

    const res = await w.publish();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_PUBLISH_NO_CUTTING_BOOKING");
    expect(await PpcStagePublication.countDocuments({})).toBe(0);
  });

  test("a refusal keeps the capacity; an acceptance is a current deadline only while it is held", async () => {
    const w = await world("bk-answer", { workOrder: true });
    const resource = await w.publishResource();
    const { booking } = await w.reserve();
    const published = (await w.publish()).body.publication;
    expect(published.cuttingBooking).toMatchObject({
      bookingId: booking.bookingId, bookingRef: booking.bookingRef, generation: 1,
      resourceRef: resource.resourceRef, reservedMinutes: 445, windowStart: FROM, windowEnd: FROM,
    });

    /* CUTTING REFUSES. The reservation is PPC's and stays exactly as it was:
       a refusal is an answer about a date, not a decision about a table. */
    const refused = await w.answer(published.publicationId, "refuse",
      { reason: "The spreading table is down for a blade change that week." });
    expect(refused.status).toBe(200);
    expect((await ledger(w.co, resource.resourceRef, FROM)).reservedMinutes).toBe(445);
    expect((await CuttingCapacityBooking.findById(booking.bookingId).lean()).state).toBe("ACTIVE");

    /* A SECOND PLAN, ACCEPTED. */
    const w2 = await world("bk-answer-ok", { workOrder: true });
    const r2 = await w2.publishResource();
    const b2 = (await w2.reserve()).booking;
    const p2 = (await w2.publish()).body.publication;
    expect((await w2.answer(p2.publicationId, "accept")).status).toBe(200);

    const held = (await w2.targets()).body.targets[0];
    expect(held).toMatchObject({ isAcceptedDeadline: true, cuttingCapacity: "HELD", cuttingCapacityHeld: true });

    /* The capacity goes. The ANSWER is untouched — Cutting said what it said —
       but it is no longer a deadline anybody may rely on. */
    expect((await call(`${PPC}/cutting-bookings/${b2.bookingId}/release`,
      { token: w2.approver.token, company: w2.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "RESOURCE_CHANGED", note: "That table is being re-rostered." } })).status).toBe(200);

    const after = (await w2.targets()).body.targets[0];
    expect(after).toMatchObject({ cuttingCapacity: "RELEASED", cuttingCapacityHeld: false, isAcceptedDeadline: false });
    expect(after.response.state).toBe("ACCEPTED");
    expect((await ledger(w2.co, r2.resourceRef, FROM)).reservedMinutes).toBe(0);
  });

  test("a publication frozen before reservations existed is named, not retroactively invalidated", async () => {
    const w = await world("bk-legacy", { workOrder: true });
    await w.publishResource();
    await w.reserve();
    const published = (await w.publish()).body.publication;
    expect((await w.answer(published.publicationId, "accept")).status).toBe(200);

    /* A historical record: accepted, with no booking identity on it at all —
       exactly the shape every publication had before this slice. */
    await PpcStagePublication.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(published.publicationId) },
      { $unset: { cuttingBooking: "", cuttingBookingId: "" } },
    );

    const t = (await w.targets()).body.targets[0];
    expect(t.cuttingCapacity).toBe("LEGACY_CAPACITY_UNVERIFIED");
    expect(t.cuttingCapacityHeld).toBe(false);
    /* The acceptance it carries is NOT withdrawn: this plan was agreed under
       the rules of its time, and reading it differently now would rewrite
       history rather than describe it. */
    expect(t.isAcceptedDeadline).toBe(true);
  });

  test("nothing here writes an actual, a cut record, a sewing booking or a Production release", async () => {
    const w = await world("bk-boundary", { workOrder: true });
    await w.publishResource();
    const { booking } = await w.reserve();
    const published = (await w.publish()).body.publication;
    expect((await w.answer(published.publicationId, "accept")).status).toBe(200);
    expect((await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "OTHER", note: "Checking that nothing downstream moved." } })).status).toBe(200);

    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
    expect(await PpcCapacityBooking.countDocuments({})).toBe(0);
    const wo = await WorkOrder.findById(w.wo._id).lean();
    expect(wo.status).toBe("in_progress");
    expect(wo.productionRelease || null).toBeNull();
    /* And no quantity was recorded anywhere by any of it. */
    expect(await CuttingCapacityBooking.countDocuments({ quantityCut: { $exists: true } })).toBe(0);
  });
});

/* ══ 5 · BOUNDARIES ═══════════════════════════════════════════════════════ */

describe("a reservation belongs to one company, and cutting alone is reserved", () => {
  test("another company's plan, resource and booking are not found, and leak nothing", async () => {
    const a = await world("bk-iso-a");
    const resourceA = await a.publishResource();
    const optionA = await a.option(resourceA.resourceRef);
    const b = await world("bk-iso-b");
    await b.publishResource();

    /* B cannot preview or book A's plan. */
    const peek = await call(`${PPC}/planning-files/${a.planId}/cutting-capacity?from=${FROM}`,
      { token: b.planner.token, company: b.co._id });
    expect(peek.status).toBe(404);
    expect(JSON.stringify(peek.body)).not.toContain(a.lineRef);

    const stolen = await call(`${PPC}/planning-files/${a.planId}/cutting-capacity/book?from=${FROM}`,
      { token: b.approver.token, company: b.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: optionA.resourceRef, proof: optionA.proof } });
    expect(stolen.status).toBe(404);
    expect(JSON.stringify(stolen.body)).not.toContain(a.lineRef);

    /* B cannot book A's TABLE for B's own plan either: it is not in B's
       published projection, so it simply does not exist for B. */
    const foreignTable = await call(`${PPC}/planning-files/${b.planId}/cutting-capacity/book?from=${FROM}`,
      { token: b.approver.token, company: b.co._id, method: "POST", key: fx.nextKey(),
        body: { resourceRef: optionA.resourceRef, proof: optionA.proof } });
    expect(foreignTable.status).toBe(404);
    expect(foreignTable.body.error.code).toBe("PPC_CUTTING_RESOURCE_NOT_FOUND");

    /* And B cannot release A's booking. */
    const { booking } = await a.reserve();
    const release = await call(`${PPC}/cutting-bookings/${booking.bookingId}/release`,
      { token: b.approver.token, company: b.co._id, method: "POST", key: fx.nextKey(),
        body: { reason: "OTHER", note: "Reaching into another company." } });
    expect(release.status).toBe(404);
    expect(release.body.error.code).toBe("PPC_CUTTING_BOOKING_NOT_FOUND");
    expect((await CuttingCapacityBooking.findById(booking.bookingId).lean()).state).toBe("ACTIVE");
  });

  test("a planner may read a preview but not reserve; reserving is the approver's", async () => {
    const w = await world("bk-grant");
    const resource = await w.publishResource();
    const option = await w.option(resource.resourceRef);

    const res = await w.book(option, { who: w.planner });
    expect(res.status).toBe(403);
    expect(await CuttingCapacityBooking.countDocuments({})).toBe(0);
  });

  test("Sewing is still PPC's own to date, and only Cutting is refused by name", async () => {
    const w = await world("bk-sewing");
    await w.publishResource();
    await w.reserve();

    /* The sewing stage takes typed dates exactly as it always did. */
    const saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { expectedRevision: 1, reason: "Sewing follows the cut.",
          stages: [{ stageId: w.r.ids.sew, plannedStart: "2026-10-08", plannedEnd: "2026-10-12" }] } });
    expect([saved.status, saved.body?.error?.code]).toEqual([200, undefined]);
    const sew = saved.body.stages.find((s) => s.process === "SEWING");
    expect([sew.plannedStart, sew.plannedEnd]).toEqual(["2026-10-08", "2026-10-12"]);

    /* The cutting stage in the very same statement is not. */
    const typed = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
        body: { expectedRevision: 2, reason: "Trying to type a cutting date.",
          stages: [
            { stageId: w.r.ids.sew, plannedStart: "2026-10-09", plannedEnd: "2026-10-13" },
            { stageId: w.r.ids.cut, plannedStart: "2026-10-01", plannedEnd: "2026-10-02" },
          ] } });
    expect(typed.status).toBe(409);
    expect(typed.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    /* Whole-statement: the sewing dates in it did not move either. */
    const stillSew = (await w.schedule()).body.stages.find((s) => s.process === "SEWING");
    expect([stillSew.plannedStart, stillSew.plannedEnd]).toEqual(["2026-10-08", "2026-10-12"]);
    const stillCut = await w.cutStage();
    expect([stillCut.plannedStart, stillCut.plannedEnd]).toEqual([FROM, FROM]);
  });
});
