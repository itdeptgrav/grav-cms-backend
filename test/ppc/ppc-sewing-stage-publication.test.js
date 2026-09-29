// test/ppc/ppc-sewing-stage-publication.test.js
//
// PPC PUBLISHES ONE SEWING TARGET; PRODUCTION ACCEPTS OR REFUSES IT.
//
// The same versioned contract Cutting and Embroidery already use, for the one
// process that occupies a factory line — so a target may exist only when PPC
// has already RESERVED that line, in Capacity, for exactly that window.
//
// ── THE TWO DECISIONS THIS FILE KEEPS APART ─────────────────────────────────
// A capacity booking is PPC reserving a line. Production's answer is a
// different department agreeing to sew the window. A booking is not an
// acceptance, an acceptance is not a booking, and neither is a Production
// release. Every test below that touches one asserts what happened to the
// other.
//
// Pinned:
//   · an applicable, booked line publishes: every field frozen and
//     server-derived, including which booking backed it;
//   · no booking, a released booking, another plan's booking, a booking
//     something has moved under, and a booking whose window, quantity or
//     frozen release disagrees with the plan each block it;
//   · one Sales line is one answer, however many work orders show it;
//   · a Production viewer reads and cannot answer; an editor answers;
//   · PPC, Cutting, Embroidery and an ungranted department cannot answer;
//   · a refusal needs a reason; two answers race to one winner; the same
//     answer replays; a different one is refused;
//   · a refusal leaves the booking ACTIVE and byte-identical; an acceptance
//     writes no release, no work order, no scan and no actual;
//   · replanning the booking needs a successor target and a fresh answer;
//   · a retired plan's target is unanswerable, and a successor supersedes;
//   · cutting targets are invisible and unanswerable on Production's door;
//   · another company's and unlinked work orders reveal nothing.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const fx = require("./planningFixtures");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
const {
  PpcCapacityCalendar, PpcCapacityCalendarVersion,
} = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
const { PpcCapacityLine } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const {
  PpcCapacityBooking, PpcCapacityLineDay,
} = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const ProductionCompletionScanRecord = require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const PROD = "/api/cms/manufacturing/production/sewing-targets";
const CUT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use(PPC, require("../../routes/CMS_Routes/PPC/capacityRoute"));
  app.use(PROD, require("../../routes/CMS_Routes/Manufacturing/Production/sewingTargetRoutes"));
  app.use(CUT, require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcPlanningCommand, PpcStageSchedule, PpcStagePublication,
    PpcCapacityCalendar, PpcCapacityCalendarVersion, PpcCapacityLine, PpcCapacityBooking,
    PpcCapacityLineDay, IeReleaseReceipt]) {
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

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

/** Mon–Sat, one 08:00–17:00 shift with a 60-minute break: 480 net minutes. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 6
  ? { working: true, shifts: [{ shiftKey: "A", start: "08:00", end: "17:00", breakMinutes: 60 }] }
  : { working: false, shifts: [] }));

/* The booked window and the planned sewing window are ONE pair of dates in
   this file, quoted in both places, so a test that changes one and not the
   other is visibly changing one and not the other. */
const WINDOW = Object.freeze({ start: "2026-10-05", end: "2026-10-17" });

const sid = () => `stg_${crypto.randomBytes(9).toString("hex")}`;

/** IE's route: cutting, then sewing, then finishing. Embroidery is not
    applicable here; finishing is required and has no receiving contract yet,
    which is the fact the last test in this file pins. */
function route() {
  const ids = { cut: sid(), emb: sid(), sew: sid(), fin: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
    { stageId: ids.emb, sequence: 2, process: "EMBROIDERY", label: "Chest logo", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
    { stageId: ids.sew, sequence: 3, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [ids.cut] },
    { stageId: ids.fin, sequence: 4, process: "FINISHING", label: "Finishing", applicability: "REQUIRED", predecessorStageIds: [ids.sew] },
  ] };
}

/* Sales' approved statement for the line: no embroidery, no print, no wash. */
const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no embroidery", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no print", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: no wash", evidence },
] });

/**
 * An IE release carrying BOTH the process route PPC schedules against and the
 * engineering figures Capacity computes demand from. The planning fixture's
 * release has the first and not the second; the capacity suite's has the
 * second and not the first. A sewing target needs both at once.
 */
async function engineeredRelease(co, sampleStyleId, { sam = 4.5, target = 60, processRoute, versionNo = 1 } = {}) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const doc = await IeRelease.create({
    companyId: co._id, releaseRef: `IEREL-S${String(n).slice(-9)}`, versionNo,
    ieStyleFileId: new mongoose.Types.ObjectId(), sampleStyleId, state: "ISSUED",
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(), bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"), rows: [],
      garmentSamMinutes: sam, samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: {
        inputs: { plannedOperatorCount: 25, targetEfficiencyPercent: target,
          availableShiftMinutes: 99999, breakMinutes: 0, shiftsPerDay: 9 },
        calculation: { targetPiecesPerDay: 123456 },
        workingTimeSource: { kind: "IE_PLANNING_ASSUMPTION" },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
      },
      capturedAt: new Date("2026-09-01"),
      processRoute: { stages: processRoute },
    },
    issuedBy: new mongoose.Types.ObjectId(), issuedByName: "IE", issuedAt: new Date("2026-09-01"),
  });
  await IeReleaseReceipt.create({
    companyId: co._id, releaseRef: doc.releaseRef, releaseVersionNo: versionNo,
    ieReleaseId: doc._id, ieStyleFileId: doc.ieStyleFileId,
    state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
    idempotencyKey: `ks-${n}`, requestHash: `hs-${n}`,
  });
  return doc;
}

async function makeCalendar(w, { publish = true } = {}) {
  const c = await call(`${PPC}/capacity/calendars`, { token: w.owner.token, company: w.co._id, method: "POST",
    body: { calendarRef: `CAL${Date.now() % 1e6}-${++seq}`, name: "Unit 1", timezone: "Asia/Kolkata" } });
  expect(c.status).toBe(201);
  const calendarId = c.body.calendar.calendarId;
  const v = await call(`${PPC}/capacity/calendars/${calendarId}/versions`, { token: w.owner.token, company: w.co._id,
    method: "POST", body: { validFrom: "2026-01-01", validTo: null, weekPattern: WEEK, exceptions: [] } });
  expect(v.status).toBe(201);
  if (publish) {
    const p = await call(`${PPC}/capacity/calendar-versions/${v.body.version.versionId}/publish`,
      { token: w.owner.token, company: w.co._id, method: "POST", body: { expectedRevision: 1 }, key: key() });
    expect(p.status).toBe(200);
  }
  return { calendarId, versionId: v.body.version.versionId };
}

/**
 * One company, one applicable and PLANNED Sales line with work orders, a
 * published calendar and a sewing line, a dated sewing stage, and — unless
 * asked not to — the ACTIVE capacity booking for exactly that window.
 */
async function world(label, { workOrders = 1, quantity = 400, book = true, operators = 2 } = {}) {
  const co = await fx.company(label);
  const r = route();
  const file = await fx.orderLine(co, {
    lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, quantity, processRequirements: statement(),
  });
  const styleId = file.currentExecutionProjection.sampleStyleId;
  await fx.pack(co, file);
  /* The release first: the minutes record WHICH release was reviewed. */
  const rel = await engineeredRelease(co, styleId, { processRoute: r.stages });
  await fx.minutes(co, file);

  const w = {
    co, file, rel, r, styleId, quantity, lineRef: file.handoverLineRef,
    planner: await fx.actor({ companies: [co], grants: { ppc: "editor" } }),
    approver: await fx.actor({ companies: [co], grants: { ppc: "approver" } }),
    owner: await fx.actor({ companies: [co], grants: { ppc: "owner" } }),
    /* Production's own people. Both grants always exist, so the department
       guard's "no grant has ever been given" branch is never what a test is
       accidentally measuring. */
    pmViewer: await fx.actor({ companies: [co], grants: { "project-manager": "viewer" } }),
    pmEditor: await fx.actor({ companies: [co], grants: { "project-manager": "editor" } }),
  };

  /* The work this target will cover, through the Sales-line ↔ WorkOrder bridge. */
  const item = await StockItem.create({ name: `Tee ${label}`, sku: `SKU-SEW-${++seq}-${Date.now()}`,
    reference: `REF-SEW-${seq}`, category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 9,
    variants: [{ sku: `VS-${seq}-${Date.now()}`, cost: 0, salesPrice: 0, attributes: [{ name: "Size", value: "M" }] }] });
  w.mo = await CustomerRequest.create({ requestId: `CR-SEW-${++seq}-${Date.now()}`,
    customerId: new mongoose.Types.ObjectId(), customerInfo: { name: "Buyer" }, status: "quotation_sales_approved",
    items: [{ stockItemId: item._id, stockItemName: item.name, totalQuantity: quantity }] });
  w.item = item;
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

  /* The plan, through PPC's own routes, all the way to PLANNED — capacity is
     booked against a plan somebody has actually decided on. */
  const created = await call(`${PPC}/order-book/${w.lineRef}/planning-file`,
    { token: w.planner.token, company: co._id, method: "POST", body: {}, key: key() });
  expect(created.status).toBe(201);
  w.planId = created.body.planningFile.planningFileId;
  const started = await call(`${PPC}/planning-files/${w.planId}/planning-started`, { token: w.planner.token,
    company: co._id, method: "POST", body: { expectedRevision: created.body.planningFile.revision }, key: key() });
  expect(started.status).toBe(200);
  const planned = await call(`${PPC}/planning-files/${w.planId}/planned`, { token: w.approver.token,
    company: co._id, method: "POST", body: { expectedRevision: started.body.planningFile.revision }, key: key() });
  expect(planned.status).toBe(200);

  /* The sewing dates. */
  const saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`, { token: w.planner.token,
    company: co._id, method: "POST", key: key(),
    body: { expectedRevision: 0, stages: [{ stageId: r.ids.sew, plannedStart: WINDOW.start, plannedEnd: WINDOW.end }] } });
  expect(saved.status).toBe(200);

  w.calendar = await makeCalendar(w);
  const l = await call(`${PPC}/capacity/lines`, { token: w.owner.token, company: co._id, method: "POST",
    body: { lineRef: `SL${Date.now() % 1e6}-${++seq}`, name: "Sewing line 1", factoryRef: "UNIT-1",
      calendarId: w.calendar.calendarId, operatorCount: operators } });
  expect(l.status).toBe(201);
  w.line = l.body.line;

  if (book) w.booking = (await bookWindow(w)).body.booking;
  return w;
}

/** PPC reserves the sewing line for a window — Capacity's own command. */
async function bookWindow(w, { start = WINDOW.start, end = WINDOW.end, who = w.approver } = {}) {
  const pv = await call(`${PPC}/capacity/preview`, { token: who.token, company: w.co._id, method: "POST",
    body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: start, windowEnd: end } });
  expect(pv.status).toBe(200);
  const booked = await call(`${PPC}/capacity/bookings`, { token: who.token, company: w.co._id, method: "POST",
    key: key(), body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: start, windowEnd: end,
      expected: pv.body.preview.proof } });
  expect(booked.status).toBe(201);
  return booked;
}

const publish = (w, body = {}, { who = w.planner, k = key() } = {}) => call(
  `${PPC}/planning-files/${w.planId}/stage-schedule/publish`,
  { token: who.token, company: w.co._id, method: "POST", key: k,
    body: { stageId: w.r.ids.sew, expectedScheduleVersion: 1, ...body } },
);

const targetsFor = (w, query, who = w.pmEditor) => call(`${PROD}?${query}`,
  { token: who.token, company: w.co._id });

const answer = (w, id, decision, body = {}, who = w.pmEditor) => call(`${PROD}/${id}/${decision}`,
  { token: who.token, company: w.co._id, method: "POST", body });

const bookingRow = (id) => PpcCapacityBooking.findById(id).lean();

/** PPC moves its own reservation — Capacity's replan, proved like a booking. */
async function replanBooking(w, { start, end, who = w.approver, reason }) {
  const pv = await call(`${PPC}/capacity/preview`, { token: who.token, company: w.co._id, method: "POST",
    body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: start, windowEnd: end,
      replanBookingId: w.booking.bookingId } });
  expect(pv.status).toBe(200);
  return call(`${PPC}/capacity/bookings/${w.booking.bookingId}/replan`, { token: who.token, company: w.co._id,
    method: "POST", key: key(),
    body: { expectedRevision: 1, reason, lineId: w.line.lineId, windowStart: start, windowEnd: end,
      expected: pv.body.preview.proof } });
}

/* ══ PUBLISHING NEEDS A RESERVATION ═══════════════════════════════════════ */

describe("a sewing target stands on a capacity booking PPC already made", () => {
  test("an applicable, booked line publishes, and the booking is frozen onto the target", async () => {
    const w = await world("sew-ok");
    const out = await publish(w);
    expect(out.status).toBe(201);
    const p = out.body.publication;

    expect(p.process).toBe("SEWING");
    expect(p.state).toBe("AWAITING");
    expect(p.publicationVersionNo).toBe(1);
    expect(p.scheduleVersionNo).toBe(1);
    expect(p.plannedStart).toBe(WINDOW.start);
    expect(p.plannedEnd).toBe(WINDOW.end);
    expect(p.confirmedQuantity).toBe(w.quantity);
    expect(p.orderLineRef).toBe(w.lineRef);
    expect(p.workOrders.map((x) => x.workOrderId)).toEqual([String(w.wo._id)]);

    /* Which reservation backed it — server-derived, every field. */
    expect(p.capacityBooking).toEqual({
      bookingId: w.booking.bookingId,
      bookingRef: w.booking.bookingRef,
      generation: 1,
      lineId: w.line.lineId,
      lineRef: w.line.lineRef,
      calendarVersionNo: w.booking.calendarVersionNo,
      windowStart: WINDOW.start,
      windowEnd: WINDOW.end,
    });
    /* Published is not accepted, not booked-by-this-act, not released. */
    expect(p.isAcceptedDeadline).toBe(false);
    expect(p.booksCapacity).toBe(false);
    expect(p.releasesProduction).toBe(false);

    /* And publishing created no booking and moved none. */
    const stored = await bookingRow(w.booking.bookingId);
    expect(stored.state).toBe("ACTIVE");
    expect(stored.revision).toBe(1);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("with no booking at all, nothing is published", async () => {
    const w = await world("sew-nobook", { book: false });
    const out = await publish(w);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_NO_CAPACITY_BOOKING");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a released booking is not a reservation", async () => {
    const w = await world("sew-released");
    const rel = await call(`${PPC}/capacity/bookings/${w.booking.bookingId}/release`, { token: w.approver.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: 1, reason: "PLAN_CHANGED", note: "Buyer moved the delivery." } });
    expect(rel.status).toBe(200);
    expect(rel.body.booking.state).toBe("RELEASED");

    const out = await publish(w);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_NO_CAPACITY_BOOKING");
  });

  test("another plan's booking is not this plan's", async () => {
    /* Two lines in one company: only the second is booked. */
    const w = await world("sew-otherplan");
    const other = await world("sew-otherplan-2", { book: true });
    expect(other.booking.bookingId).toBeTruthy();
    const unbooked = await world("sew-otherplan-3", { book: false });
    const out = await publish(unbooked);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_NO_CAPACITY_BOOKING");
    expect(out.body.error.details.planningFileId).toBe(unbooked.planId);
    /* The booked plans' own bookings are untouched by the refusal. */
    expect((await bookingRow(w.booking.bookingId)).state).toBe("ACTIVE");
    expect((await bookingRow(other.booking.bookingId)).state).toBe("ACTIVE");
  });

  test("a booking something has moved under blocks, and says what moved", async () => {
    const w = await world("sew-unhealthy");
    /* The calendar is republished after the reservation was proved. */
    const v = await call(`${PPC}/capacity/calendars/${w.calendar.calendarId}/versions`, { token: w.owner.token,
      company: w.co._id, method: "POST", body: { validFrom: "2026-01-01", weekPattern: WEEK, exceptions: [] } });
    expect(v.status).toBe(201);
    const p = await call(`${PPC}/capacity/calendar-versions/${v.body.version.versionId}/publish`,
      { token: w.owner.token, company: w.co._id, method: "POST", body: { expectedRevision: 1 }, key: key() });
    expect(p.status).toBe(200);

    const out = await publish(w);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_BOOKING_UNHEALTHY");
    expect(out.body.error.details.movements.map((m) => m.key)).toContain("calendar");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the booked window and the planned window must be the same days", async () => {
    const w = await world("sew-window");
    /* PPC moves the reservation — a legitimate Capacity replan — without
       moving the schedule. The two now disagree, and publishing says so. */
    const replanned = await replanBooking(w, { start: "2026-10-06", end: WINDOW.end,
      reason: "The sewing line frees up a day later than planned." });
    expect(replanned.status).toBe(201);

    const out = await publish(w);
    expect(out.status).toBe(409);
    expect(out.body.error.code).toBe("PPC_PUBLISH_BOOKING_MISMATCH");
    expect(out.body.error.details.fact).toBe("windowStart");
    expect(out.body.error.details.booked).toBe("2026-10-06");
    expect(out.body.error.details.planned).toBe(WINDOW.start);
  });

  test("a booking whose frozen quantity or release disagrees with the plan blocks", async () => {
    /* A reservation can only be MADE from the plan's own figures, so a
       divergent one is seeded directly — the shape a stale generation would
       leave behind — after the real one is released so it can be ACTIVE. */
    for (const [fact, patch] of [
      ["confirmedQuantity", { "basis.confirmedQuantity": 999 }],
      ["ieReleaseVersionNo", { "basis.ieReleaseVersionNo": 7 }],
      ["orderLineRef", { orderLineRef: "LN-ffffffffffff" }],
    ]) {
      const w = await world(`sew-basis-${fact}`);
      const real = await bookingRow(w.booking.bookingId);
      await PpcCapacityBooking.updateOne({ _id: real._id }, { $set: { state: "RELEASED" } });
      const seeded = { ...real, ...patch };
      delete seeded._id;
      for (const [path, value] of Object.entries(patch)) {
        if (path.startsWith("basis.")) seeded.basis = { ...real.basis, [path.slice(6)]: value };
      }
      seeded.bookingRef = `${real.bookingRef}-X`;
      await PpcCapacityBooking.create({ ...seeded, state: "ACTIVE" });

      const out = await publish(w);
      expect(out.status).toBe(409);
      expect(out.body.error.code).toBe("PPC_PUBLISH_BOOKING_MISMATCH");
      expect(out.body.error.details.fact).toBe(fact);
      expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
    }
  });
});

/* ══ PRODUCTION'S OWN DOOR ════════════════════════════════════════════════ */

describe("Production reads and answers its own targets", () => {
  test("one Sales line is one answer, however many work orders show it", async () => {
    const w = await world("sew-grain", { workOrders: 3 });
    const out = await publish(w);
    expect(out.status).toBe(201);
    const id = out.body.publication.publicationId;

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.targets).toHaveLength(1);
    expect(seen.body.targets[0].publicationId).toBe(id);
    expect(seen.body.targets[0].scheduleVersionNo).toBe(1);
    expect(seen.body.targets[0].quantity).toBe(w.quantity);
    /* The same one target appears under every work order of the line. */
    expect(Object.keys(seen.body.byWorkOrder).sort())
      .toEqual(w.wos.map((x) => String(x._id)).sort());
    for (const row of Object.values(seen.body.byWorkOrder)) expect(row.publicationId).toBe(id);
    /* And the receiver's own payload carries the reservation. */
    expect(seen.body.targets[0].capacityBooking.bookingRef).toBe(w.booking.bookingRef);
    expect(seen.body.targets[0].capacityBooking.lineRef).toBe(w.line.lineRef);

    /* Answering on one work order settles the line. */
    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.state).toBe("ACCEPTED");
    const after = await targetsFor(w, `workOrderId=${w.wos[2]._id}`);
    expect(after.body.byWorkOrder[String(w.wos[2]._id)].state).toBe("ACCEPTED");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id, state: "AWAITING" })).toBe(0);
  });

  test("a viewer reads and cannot answer; an editor answers", async () => {
    const w = await world("sew-roles");
    const id = (await publish(w)).body.publication.publicationId;

    const read = await targetsFor(w, `moId=${w.mo._id}`, w.pmViewer);
    expect(read.status).toBe(200);
    expect(read.body.targets).toHaveLength(1);
    expect(read.body.access).toEqual({ canRespond: false });

    const refusedRead = await answer(w, id, "accept", {}, w.pmViewer);
    expect(refusedRead.status).toBe(403);
    expect(refusedRead.body.code).toBe("INSUFFICIENT_DEPARTMENT_ROLE");

    const editorRead = await targetsFor(w, `moId=${w.mo._id}`, w.pmEditor);
    expect(editorRead.body.access).toEqual({ canRespond: true });
    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.response.state).toBe("ACCEPTED");
    /* The responder is the session, and nothing else. */
    expect(said.body.target.response.byName).toBe(w.pmEditor.name);
  });

  test("PPC, Cutting, Embroidery and an ungranted department open no door here", async () => {
    const w = await world("sew-strangers");
    const id = (await publish(w)).body.publication.publicationId;

    const outsiders = {
      ppc: w.planner,
      cutting: await fx.actor({ companies: [w.co], grants: { cutting_master: "editor" } }),
      embroidery: await fx.actor({ companies: [w.co], grants: { embroidery: "editor" } }),
      none: await fx.actor({ companies: [w.co] }),
    };
    for (const [who, person] of Object.entries(outsiders)) {
      const read = await targetsFor(w, `moId=${w.mo._id}`, person);
      expect([who, read.status]).toEqual([who, 403]);
      for (const decision of ["accept", "refuse"]) {
        const tried = await answer(w, id, decision, { reason: "We would rather not." }, person);
        expect([who, decision, tried.status]).toEqual([who, decision, 403]);
      }
    }
    /* PPC published it and still cannot answer it: it stays AWAITING. */
    const still = await PpcStagePublication.findById(id).lean();
    expect(still.state).toBe("AWAITING");
    expect(still.response?.state).toBeUndefined();
  });

  test("a refusal needs a reason, and carries it back to PPC", async () => {
    const w = await world("sew-refuse");
    const id = (await publish(w)).body.publication.publicationId;

    for (const reason of [undefined, "", "   ", "no", "aaaaaaaaaaaa"]) {
      const tried = await answer(w, id, "refuse", reason === undefined ? {} : { reason });
      expect(tried.status).toBe(400);
      expect(tried.body.error.code).toBe("SEWING_TARGET_REFUSAL_REASON_REQUIRED");
    }
    const said = await answer(w, id, "refuse", { reason: "Line 1 is on another order until the 20th." });
    expect(said.status).toBe(200);
    expect(said.body.target.state).toBe("REFUSED");
    expect(said.body.target.response.reason).toBe("Line 1 is on another order until the 20th.");

    /* PPC sees the refusal on its own schedule, with the booking beside it. */
    const seen = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id });
    const sew = seen.body.stages.find((s) => s.process === "SEWING");
    expect(sew.handoff.state).toBe("REFUSED");
    expect(sew.handoff.message).toContain("Line 1 is on another order");
    expect(sew.handoff.booking.bookingRef).toBe(w.booking.bookingRef);
  });

  test("two answers race to one winner; the same answer replays; a different one is refused", async () => {
    const w = await world("sew-race");
    const id = (await publish(w)).body.publication.publicationId;
    const second = await fx.actor({ companies: [w.co], grants: { "project-manager": "editor" } });

    const [a, b] = await Promise.all([
      answer(w, id, "accept"),
      answer(w, id, "refuse", { reason: "The line is committed elsewhere." }, second),
    ]);
    const wins = [a, b].filter((r) => r.status === 200);
    const loses = [a, b].filter((r) => r.status !== 200);
    expect(wins).toHaveLength(1);
    expect(loses).toHaveLength(1);
    expect(loses[0].body.error.code).toBe("SEWING_TARGET_ALREADY_ANSWERED");

    const settled = await PpcStagePublication.findById(id).lean();
    const winner = settled.state === "ACCEPTED" ? w.pmEditor : second;
    const decision = settled.state === "ACCEPTED" ? "accept" : "refuse";

    /* The winner saying the same thing again is that answer again. */
    const again = await answer(w, id, decision, { reason: "The line is committed elsewhere." }, winner);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.target.state).toBe(settled.state);

    /* Anybody changing it is refused, and the stored answer is untouched. */
    const flip = await answer(w, id, decision === "accept" ? "refuse" : "accept",
      { reason: "On reflection we cannot." }, winner);
    expect(flip.status).toBe(409);
    expect(flip.body.error.code).toBe("SEWING_TARGET_ALREADY_ANSWERED");
    const unchanged = await PpcStagePublication.findById(id).lean();
    expect(unchanged.state).toBe(settled.state);
    expect(String(unchanged.response.at)).toBe(String(settled.response.at));
  });
});

/* ══ THE BOOKING IS NOT THE ANSWER, AND THE ANSWER IS NOT A RELEASE ═══════ */

describe("booking and acceptance stay separate decisions", () => {
  test("a refusal leaves the reservation ACTIVE and byte-identical", async () => {
    const w = await world("sew-refuse-booking");
    const before = await bookingRow(w.booking.bookingId);
    const id = (await publish(w)).body.publication.publicationId;

    const said = await answer(w, id, "refuse", { reason: "The line is down for service that week." });
    expect(said.status).toBe(200);

    const after = await bookingRow(w.booking.bookingId);
    expect(after.state).toBe("ACTIVE");
    expect(after.revision).toBe(before.revision);
    expect(after.releasedAt).toBeNull();
    expect(after.supersededByBookingId).toBeNull();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    /* The refused target and the live reservation coexist until PPC decides. */
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);
  });

  test("an acceptance moves no booking and writes no release, work order, scan or actual", async () => {
    const w = await world("sew-accept-nothing");
    const before = await bookingRow(w.booking.bookingId);
    const lineDaysBefore = await PpcCapacityLineDay.find({ companyId: w.co._id }).sort({ date: 1 }).lean();
    const woBefore = await WorkOrder.find({ "salesLineLink.companyId": w.co._id }).sort({ _id: 1 }).lean();

    const id = (await publish(w)).body.publication.publicationId;
    const said = await answer(w, id, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.isAcceptedDeadline).toBe(true);
    expect(said.body.target.capacityHeld).toBe(true);
    expect(said.body.target.capacityBooking.standing).toBe("ACTIVE");
    expect(said.body.target.booksCapacity).toBe(false);
    expect(said.body.target.releasesProduction).toBe(false);

    expect(JSON.stringify(await bookingRow(w.booking.bookingId))).toBe(JSON.stringify(before));
    expect(await PpcCapacityLineDay.find({ companyId: w.co._id }).sort({ date: 1 }).lean())
      .toEqual(lineDaysBefore);
    expect(await WorkOrder.find({ "salesLineLink.companyId": w.co._id }).sort({ _id: 1 }).lean())
      .toEqual(woBefore);
    expect(await CustomerRequest.countDocuments({ _id: w.mo._id })).toBe(1);
    expect(await ProductionCompletionScanRecord.countDocuments({})).toBe(0);

    /* An ACCEPTED target without an active matching booking is impossible:
       the acceptance names the reservation, and the reservation is still it. */
    const stored = await PpcStagePublication.findById(id).lean();
    expect(String(stored.capacityBooking.bookingId)).toBe(w.booking.bookingId);
    const live = await PpcCapacityBooking.findOne({ _id: stored.capacityBooking.bookingId, state: "ACTIVE" }).lean();
    expect(live.windowStart).toBe(stored.plannedStart);
    expect(live.windowEnd).toBe(stored.plannedEnd);
  });

  test("a target whose line PPC has released cannot be accepted, only refused", async () => {
    /* PPC may release a reservation after publishing — that is PPC's
       decision. What must not follow is Production committing to a window no
       line is held for. */
    const w = await world("sew-released-after");
    const first = (await publish(w)).body.publication;
    expect(first.state).toBe("AWAITING");

    const released = await call(`${PPC}/capacity/bookings/${w.booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: key(),
        body: { expectedRevision: 1, reason: "PLAN_CHANGED", note: "The order moved out a month." } });
    expect(released.status).toBe(200);

    /* The target says so, rather than offering a commitment nothing backs. */
    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets[0].capacityHeld).toBe(false);
    expect(seen.body.targets[0].capacityBooking.standing).toBe("RELEASED");

    const tried = await answer(w, first.publicationId, "accept");
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("SEWING_TARGET_BOOKING_INACTIVE");
    expect((await PpcStagePublication.findById(first.publicationId).lean()).state).toBe("AWAITING");

    /* Refusing still works, and still moves no booking. */
    const before = await bookingRow(w.booking.bookingId);
    const said = await answer(w, first.publicationId, "refuse",
      { reason: "There is no line held for this window any more." });
    expect(said.status).toBe(200);
    expect(said.body.target.state).toBe("REFUSED");
    expect(JSON.stringify(await bookingRow(w.booking.bookingId))).toBe(JSON.stringify(before));

    /* So no accepted sewing target exists without a live reservation. */
    const accepted = await PpcStagePublication.find({ companyId: w.co._id, process: "SEWING", state: "ACCEPTED" }).lean();
    expect(accepted).toEqual([]);
  });

  test("a replanned booking needs a successor target and a fresh answer", async () => {
    const w = await world("sew-replan");
    const first = (await publish(w)).body.publication;
    expect((await answer(w, first.publicationId, "accept")).status).toBe(200);

    /* PPC moves the line by a day, in Capacity and then in the schedule. */
    const moved = await replanBooking(w, { start: "2026-10-06", end: "2026-10-19",
      reason: "The sewing line frees up a day later than planned." });
    expect(moved.status).toBe(201);
    const saved = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`, { token: w.planner.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: 1, reason: "The sewing line frees up a day later than planned.",
        stages: [{ stageId: w.r.ids.sew, plannedStart: "2026-10-06", plannedEnd: "2026-10-19" }] } });
    expect(saved.status).toBe(200);
    expect(saved.body.schedule.versionNo).toBe(2);

    /* The old acceptance is not carried forward. */
    const next = await publish(w, { expectedScheduleVersion: 2, reason: "The sewing line freed up a day later." });
    expect(next.status).toBe(201);
    const p = next.body.publication;
    expect(p.publicationVersionNo).toBe(2);
    expect(p.state).toBe("AWAITING");
    expect(p.capacityBooking.bookingRef).toBe(moved.body.booking.bookingRef);
    expect(p.capacityBooking.generation).toBe(2);
    expect(p.changes).toEqual([{ fromStart: WINDOW.start, fromEnd: WINDOW.end,
      toStart: "2026-10-06", toEnd: "2026-10-19" }]);

    /* The version it replaced keeps its own dates and its own answer. */
    const old = await PpcStagePublication.findById(first.publicationId).lean();
    expect(old.state).toBe("SUPERSEDED");
    expect(old.isCurrent).toBe(false);
    expect(old.plannedStart).toBe(WINDOW.start);
    expect(old.response.state).toBe("ACCEPTED");
    expect(String(old.supersededByVersionId)).toBe(p.publicationId);

    /* Production is asked again, and answering the OLD one changes nothing:
       the same manager repeating their own answer replays the superseded
       record — it does not accept the new window — and anyone else is told
       to answer the version PPC actually published. */
    const replay = await answer(w, first.publicationId, "accept");
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.target.state).toBe("SUPERSEDED");
    expect(replay.body.target.plannedStart).toBe(WINDOW.start);
    const somebodyElse = await fx.actor({ companies: [w.co], grants: { "project-manager": "editor" } });
    const stale = await answer(w, first.publicationId, "accept", {}, somebodyElse);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("SEWING_TARGET_ALREADY_ANSWERED");
    expect((await PpcStagePublication.findById(p.publicationId).lean()).state).toBe("AWAITING");

    /* Only the successor can be accepted, and it is a fresh decision. */
    const fresh = await answer(w, p.publicationId, "accept");
    expect(fresh.status).toBe(200);
    expect(fresh.body.target.state).toBe("ACCEPTED");
    expect(fresh.body.target.plannedStart).toBe("2026-10-06");
  });

  test("a retired plan's target is non-actionable and reads as superseded", async () => {
    const w = await world("sew-retired");
    const id = (await publish(w)).body.publication.publicationId;

    const plan = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id });
    const cancelled = await call(`${PPC}/planning-files/${w.planId}/cancel`, { token: w.approver.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: (await PpcPlanningFile.findById(w.planId).lean()).revision,
        reason: "ORDER_CANCELLED_UPSTREAM", note: "The buyer withdrew this order line entirely." } });
    expect([plan.status, cancelled.status]).toEqual([200, 200]);

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets).toEqual([]);
    const tried = await answer(w, id, "accept");
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("SEWING_TARGET_PLAN_RETIRED");
    expect((await PpcStagePublication.findById(id).lean()).state).toBe("AWAITING");
  });
});

/* ══ AN ACCEPTANCE IS NOT A DEADLINE WITHOUT A LINE ═══════════════════════ */

describe("when the frozen reservation stops being held", () => {
  /** PPC's own schedule row for the sewing stage. */
  const sewingRow = async (w) => {
    const seen = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id });
    expect(seen.status).toBe(200);
    return seen.body.stages.find((s) => s.process === "SEWING");
  };

  /** An accepted target, and the standing of its booking after `after`. */
  async function acceptedThen(label, after) {
    const w = await world(label);
    const p = (await publish(w)).body.publication;
    const said = await answer(w, p.publicationId, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.isAcceptedDeadline).toBe(true);
    await after(w);
    return { w, publicationId: p.publicationId, acceptedAt: said.body.target.response.at };
  }

  test("released after acceptance: the answer is history, the deadline is not current", async () => {
    const { w, publicationId, acceptedAt } = await acceptedThen("sew-rel-after", async (x) => {
      const rel = await call(`${PPC}/capacity/bookings/${x.booking.bookingId}/release`,
        { token: x.approver.token, company: x.co._id, method: "POST", key: key(),
          body: { expectedRevision: 1, reason: "ORDER_CANCELLED", note: "The buyer pulled the order." } });
      expect(rel.status).toBe(200);
    });

    /* The stored response is untouched — this is evidence, not a cache. */
    const stored = await PpcStagePublication.findById(publicationId).lean();
    expect(stored.state).toBe("ACCEPTED");
    expect(stored.response.state).toBe("ACCEPTED");
    expect(stored.response.by.name).toBe(w.pmEditor.name);
    expect(stored.response.at).toBeTruthy();

    /* Production's door: the acceptance is still visible, with who and when,
       and it is no longer claimed as a current accepted deadline. */
    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    const t = seen.body.targets[0];
    expect(t.state).toBe("ACCEPTED");
    expect(t.response).toMatchObject({ state: "ACCEPTED", byName: w.pmEditor.name });
    expect(t.response.at).toBe(acceptedAt);
    expect(t.isAcceptedDeadline).toBe(false);
    expect(t.capacityHeld).toBe(false);
    expect(t.capacityBooking.standing).toBe("RELEASED");
    /* And it still names the reservation it was published against. */
    expect(t.capacityBooking.bookingRef).toBe(w.booking.bookingRef);

    /* PPC's own schedule: its own state, so nothing switching on
       ACCEPTED_DEADLINE can pick this up by mistake. */
    const row = await sewingRow(w);
    expect(row.handoff.state).toBe("ACCEPTED_CAPACITY_NOT_HELD");
    expect(row.handoff.state).not.toBe("ACCEPTED_DEADLINE");
    expect(row.handoff.capacityStanding).toBe("RELEASED");
    expect(row.handoff.capacityHeld).toBe(false);
    expect(row.handoff.message).toMatch(/released that reservation/);
    expect(row.handoff.message).toMatch(/stands as history/);
    expect(row.handoff.message).not.toMatch(/moved that reservation/);
  });

  test("superseded by a replan: the wording says moved, and accepting is refused", async () => {
    /* First, while it is still AWAITING: PPC replans the line, and Production
       cannot accept a window whose reservation has moved. */
    const w = await world("sew-sup-awaiting");
    const p = (await publish(w)).body.publication;
    const moved = await replanBooking(w, { start: "2026-10-06", end: "2026-10-19",
      reason: "The sewing line frees up a day later than planned." });
    expect(moved.status).toBe(201);

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets[0].capacityBooking.standing).toBe("SUPERSEDED");
    expect(seen.body.targets[0].capacityHeld).toBe(false);
    /* It still shows ITS OWN frozen reservation, not the new one. */
    expect(seen.body.targets[0].capacityBooking.bookingRef).toBe(w.booking.bookingRef);
    expect(seen.body.targets[0].capacityBooking.bookingRef).not.toBe(moved.body.booking.bookingRef);

    const tried = await answer(w, p.publicationId, "accept");
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("SEWING_TARGET_BOOKING_INACTIVE");
    expect((await PpcStagePublication.findById(p.publicationId).lean()).state).toBe("AWAITING");

    const row = await sewingRow(w);
    expect(row.handoff.state).toBe("AWAITING_SEWING");
    expect(row.handoff.capacityStanding).toBe("SUPERSEDED");

    /* And second, one that was accepted before the replan: non-actionable,
       with the moved wording rather than the released wording. */
    const other = await acceptedThen("sew-sup-accepted", async (x) => {
      expect((await replanBooking(x, { start: "2026-10-06", end: "2026-10-19",
        reason: "The sewing line frees up a day later than planned." })).status).toBe(201);
    });
    const after = await targetsFor(other.w, `moId=${other.w.mo._id}`);
    expect(after.body.targets[0].isAcceptedDeadline).toBe(false);
    expect(after.body.targets[0].capacityBooking.standing).toBe("SUPERSEDED");
    const otherRow = await sewingRow(other.w);
    expect(otherRow.handoff.state).toBe("ACCEPTED_CAPACITY_NOT_HELD");
    expect(otherRow.handoff.message).toMatch(/moved that reservation by replanning it/);
    expect(otherRow.handoff.message).not.toMatch(/released that reservation/);
    /* Somebody else cannot turn the historical acceptance into a live one. */
    const stranger = await fx.actor({ companies: [other.w.co], grants: { "project-manager": "editor" } });
    const again = await answer(other.w, other.publicationId, "accept", {}, stranger);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("SEWING_TARGET_ALREADY_ANSWERED");
  });

  test("a reservation that cannot be found is said to be missing, not released", async () => {
    const { w, publicationId } = await acceptedThen("sew-missing", async (x) => {
      /* The record is gone — not released, not superseded. The model refuses
         deletion through mongoose on purpose, so this reaches past it to
         produce the shape a reader must still describe honestly. */
      await mongoose.connection.collection("ppc_capacity_bookings")
        .deleteOne({ _id: new mongoose.Types.ObjectId(x.booking.bookingId) });
    });

    const t = (await targetsFor(w, `moId=${w.mo._id}`)).body.targets[0];
    expect(t.capacityBooking.standing).toBe("MISSING");
    expect(t.capacityHeld).toBe(false);
    expect(t.isAcceptedDeadline).toBe(false);
    /* Still accepted, still attributable. */
    expect(t.response.state).toBe("ACCEPTED");

    const row = await sewingRow(w);
    expect(row.handoff.state).toBe("ACCEPTED_CAPACITY_NOT_HELD");
    expect(row.handoff.capacityStanding).toBe("MISSING");
    expect(row.handoff.message).toMatch(/can no longer be found/);
    for (const wrong of [/released that reservation/, /moved that reservation/]) {
      expect(row.handoff.message).not.toMatch(wrong);
    }
    expect((await PpcStagePublication.findById(publicationId).lean()).response.state).toBe("ACCEPTED");
  });

  test("a refused target keeps its refusal, and states the standing separately", async () => {
    const w = await world("sew-refused-standing");
    const p = (await publish(w)).body.publication;
    const said = await answer(w, p.publicationId, "refuse",
      { reason: "Line 1 is committed to another order until the 20th." });
    expect(said.status).toBe(200);
    const rel = await call(`${PPC}/capacity/bookings/${w.booking.bookingId}/release`,
      { token: w.approver.token, company: w.co._id, method: "POST", key: key(),
        body: { expectedRevision: 1, reason: "PLAN_CHANGED", note: "Production cannot take this window." } });
    expect(rel.status).toBe(200);

    const t = (await targetsFor(w, `moId=${w.mo._id}`)).body.targets[0];
    expect(t.state).toBe("REFUSED");
    expect(t.response.reason).toBe("Line 1 is committed to another order until the 20th.");
    expect(t.capacityBooking.standing).toBe("RELEASED");
    expect(t.capacityHeld).toBe(false);
    /* A refusal was never a deadline, so nothing about it changes. */
    expect(t.isAcceptedDeadline).toBe(false);
    const row = await sewingRow(w);
    expect(row.handoff.state).toBe("REFUSED");
    expect(row.handoff.message).toMatch(/Line 1 is committed/);
  });

  test("a held reservation is unchanged: acceptance is still a current deadline", async () => {
    const w = await world("sew-still-held");
    const p = (await publish(w)).body.publication;
    const said = await answer(w, p.publicationId, "accept");
    expect(said.status).toBe(200);
    expect(said.body.target.isAcceptedDeadline).toBe(true);
    expect(said.body.target.capacityHeld).toBe(true);
    expect(said.body.target.capacityBooking.standing).toBe("ACTIVE");

    const t = (await targetsFor(w, `moId=${w.mo._id}`)).body.targets[0];
    expect(t.isAcceptedDeadline).toBe(true);
    expect(t.capacityHeld).toBe(true);
    const row = await sewingRow(w);
    expect(row.handoff.state).toBe("ACCEPTED_DEADLINE");
    expect(row.handoff.capacityHeld).toBe(true);
    expect(row.handoff.booking.bookingRef).toBe(w.booking.bookingRef);
  });
});

/* ══ WHAT THIS DOOR MUST NOT SHOW ═════════════════════════════════════════ */

describe("nothing but this company's live sewing targets", () => {
  test("a cutting target is invisible here and unanswerable here", async () => {
    const w = await world("sew-notcutting");
    /* The cutting stage is DATED BY A RESERVATION — it cannot be typed — and
       that reservation writes its own schedule version on top of the sewing
       dates this world already saved. */
    await fx.reserveCutting(w.co, { planningFileId: w.planId, actor: w.planner, from: "2026-09-28" });
    const cutTarget = await publish(w, { stageId: w.r.ids.cut, expectedScheduleVersion: 2 });
    expect(cutTarget.status).toBe(201);
    expect(cutTarget.body.publication.process).toBe("CUTTING");
    /* Cutting books no line, so it carries no reservation. */
    expect(cutTarget.body.publication.capacityBooking).toBeNull();

    const seen = await targetsFor(w, `moId=${w.mo._id}`);
    expect(seen.body.targets).toEqual([]);
    for (const decision of ["accept", "refuse"]) {
      const tried = await answer(w, cutTarget.body.publication.publicationId, decision,
        { reason: "This is not ours to answer." });
      expect(tried.status).toBe(404);
      expect(tried.body.error.code).toBe("SEWING_TARGET_NOT_FOUND");
    }
    expect((await PpcStagePublication.findById(cutTarget.body.publication.publicationId).lean()).state)
      .toBe("AWAITING");
  });

  test("finishing is dated, unpublishable, and has no door of its own yet", async () => {
    /* The receiver list is three processes long, and the schedule says so
       rather than publishing a stage to nobody. Finishing and packing are the
       next slices; printing and washing have no department app at all. */
    const w = await world("sew-finishing");
    const dated = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`, { token: w.planner.token,
      company: w.co._id, method: "POST", key: key(),
      body: { expectedRevision: 1, stages: [
        { stageId: w.r.ids.sew, plannedStart: WINDOW.start, plannedEnd: WINDOW.end },
        { stageId: w.r.ids.fin, plannedStart: "2026-10-20", plannedEnd: "2026-10-22" }] } });
    expect(dated.status).toBe(200);

    const tried = await publish(w, { stageId: w.r.ids.fin, expectedScheduleVersion: 2 });
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("PPC_PUBLISH_STAGE_NOT_PUBLISHABLE");
    expect(tried.body.error.details.reason).toBe("NO_RECEIVER");
    expect(tried.body.error.details.process).toBe("FINISHING");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);

    /* And PPC's own schedule says so plainly, for finishing only. */
    const seen = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: w.planner.token, company: w.co._id });
    const fin = seen.body.stages.find((s) => s.process === "FINISHING");
    expect(fin.handoff).toMatchObject({ state: "NOT_CONNECTED", reason: "NO_RECEIVER" });
    const sew = seen.body.stages.find((s) => s.process === "SEWING");
    expect(sew.handoff.state).toBe("CAPACITY_BOOKED");
    expect(sew.handoff.booking.bookingRef).toBe(w.booking.bookingRef);
  });

  test("another company's target, and an unlinked work order, reveal nothing", async () => {
    const mine = await world("sew-mine");
    const theirs = await world("sew-theirs");
    const id = (await publish(theirs)).body.publication.publicationId;
    expect((await publish(mine)).status).toBe(201);

    /* My Production, holding my own grant, asking for their work. */
    const peek = await call(`${PROD}?moId=${theirs.mo._id}`,
      { token: mine.pmEditor.token, company: mine.co._id });
    expect(peek.status).toBe(200);
    expect(peek.body.targets).toEqual([]);
    expect(peek.body.byWorkOrder).toEqual({});
    const tried = await answer(mine, id, "accept");
    expect(tried.status).toBe(404);
    expect(tried.body.error.code).toBe("SEWING_TARGET_NOT_FOUND");

    /* A historical work order with no Sales-line link is nobody's. */
    const orphan = await WorkOrder.create({ customerRequestId: mine.mo._id, stockItemId: mine.item._id,
      stockItemName: mine.item.name, quantity: 10, status: "in_progress" });
    const asked = await call(`${PROD}?workOrderId=${orphan._id}`,
      { token: mine.pmEditor.token, company: mine.co._id });
    expect(asked.status).toBe(200);
    expect(asked.body.byWorkOrder).toEqual({});
    /* And it is not swept in by the manufacturing order it sits under. */
    const byMo = await call(`${PROD}?moId=${mine.mo._id}`,
      { token: mine.pmEditor.token, company: mine.co._id });
    expect(Object.keys(byMo.body.byWorkOrder)).toEqual([String(mine.wo._id)]);
  });
});
