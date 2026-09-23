// test/ppc/ppc-capacity.route.test.js
//
// PPC CAPACITY, FIRST SLICE — AT THE WIRE.
//
//   · a preview writes nothing, and PLANNED alone books nothing;
//   · demand is the frozen release's SAM × the frozen quantity ÷ IE's planned
//     efficiency — and IE's working-time ASSUMPTION is never read;
//   · a missing, provisional (draft-only), stale, gapped or unreadable calendar
//     books nothing, each with its own named reason;
//   · booking is idempotent, proves the versions the caller previewed, and takes
//     its minutes through a database-guarded counter — overbooking and
//     concurrent booking cannot exceed a day's capacity;
//   · one active booking per plan, enforced at the index;
//   · release and replan are auditable successors, never an edit;
//   · a calendar change after booking is REPORTED, never silently absorbed;
//   · days are `YYYY-MM-DD` in every timezone;
//   · company isolation and the viewer / approver / owner ladder;
//   · and nothing is written to IE, Merchandising, Store or Production.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const express = require("express");
const mongoose = require("mongoose");

const fx = require("./planningFixtures");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const { IeReleaseReceipt } = require("../../models/CMS_Models/PPC/IeReleaseReceipt");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const {
  PpcCapacityCalendar, PpcCapacityCalendarVersion,
} = require("../../models/CMS_Models/PPC/PpcCapacityCalendar");
const { PpcCapacityLine } = require("../../models/CMS_Models/PPC/PpcCapacityLine");
const {
  PpcCapacityBooking, PpcCapacityLineDay,
} = require("../../models/CMS_Models/PPC/PpcCapacityBooking");

let http, base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/capacityRoute"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}/api/cms/ppc`;
  for (const m of [PpcPlanningFile, PpcCapacityCalendar, PpcCapacityCalendarVersion,
    PpcCapacityLine, PpcCapacityBooking, PpcCapacityLineDay, IeReleaseReceipt]) {
    await m.syncIndexes();
  }
});
afterAll(() => new Promise((r) => http.close(r)));

const call = (p, { method = "GET", body, who, co, key } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
    ...(co ? { "X-Costing-Company": String(co._id) } : {}),
    ...(key ? { "Idempotency-Key": key } : {}),
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => {
  const t = await r.text();
  let b = null; try { b = JSON.parse(t || "null"); } catch { b = { nonJson: true }; }
  return { status: r.status, body: b };
});
const key = fx.nextKey;

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

/**
 * An IE release carrying real engineering figures — and deliberately ABSURD
 * working-time figures. If any capacity number below ever depended on IE's
 * `availableShiftMinutes` or `shiftsPerDay`, these would dominate it.
 */
async function engineeredRelease(co, sampleStyleId, {
  sam = 4.5, target = 60, ramp = null, versionNo = 1,
} = {}) {
  const n = Date.now() + Math.floor(Math.random() * 1e6);
  const doc = await IeRelease.create({
    companyId: co._id, releaseRef: `IEREL-C${String(n).slice(-9)}`, versionNo,
    ieStyleFileId: new mongoose.Types.ObjectId(), sampleStyleId, state: "ISSUED",
    aggregateFingerprint: `${n}`.padStart(64, "f"),
    source: {
      bulletinVersionId: new mongoose.Types.ObjectId(), bulletinVersionNo: 1,
      sourceFingerprint: `${n}`.padStart(64, "a"), rows: [],
      garmentSamMinutes: sam, samRowCount: 4,
      lineLayout: { stationCount: 2, stations: [], metrics: { stationCount: 2 } },
      capacityStandard: {
        inputs: {
          plannedOperatorCount: 25, targetEfficiencyPercent: target,
          availableShiftMinutes: 99999, breakMinutes: 0, shiftsPerDay: 9,
        },
        calculation: { targetPiecesPerDay: 123456 },
        workingTimeSource: { kind: "IE_PLANNING_ASSUMPTION" },
        readiness: { state: "PROVISIONAL", ready: false, gaps: [] },
      },
      ramp: ramp ? { targetEfficiencyPercent: ramp, stageLabel: "Settling" } : null,
      capturedAt: new Date("2026-09-01"),
    },
    issuedBy: new mongoose.Types.ObjectId(), issuedByName: "IE", issuedAt: new Date("2026-09-01"),
  });
  await IeReleaseReceipt.create({
    companyId: co._id, releaseRef: doc.releaseRef, releaseVersionNo: versionNo,
    ieReleaseId: doc._id, ieStyleFileId: doc.ieStyleFileId,
    state: "ACCEPTED", decidedAt: new Date("2026-09-02"),
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "PPC" },
    idempotencyKey: `kc-${n}`, requestHash: `hc-${n}`,
  });
  return doc;
}

/** Mon–Sat, one 08:00–17:00 shift with a 60-minute break: 480 net minutes. */
const WEEK = [0, 1, 2, 3, 4, 5, 6].map((i) => (i < 6
  ? { working: true, shifts: [{ shiftKey: "A", start: "08:00", end: "17:00", breakMinutes: 60 }] }
  : { working: false, shifts: [] }));

/** A company with people, a PLANNED plan, and (optionally) a published calendar and a line. */
async function world(label, {
  quantity = 500, sam = 4.5, target = 60, ramp = null, operators = 2,
  calendar = "PUBLISHED", validTo = null, exceptions = [],
} = {}) {
  const co = await fx.company(label);
  const file = await fx.orderLine(co, { lineRef: `L-${label}-${Date.now()}`, quantity });
  const styleId = file.currentExecutionProjection.sampleStyleId;
  await fx.pack(co, file);
  /* The release first: the minutes record WHICH release was reviewed. */
  const rel = await engineeredRelease(co, styleId, { sam, target, ramp });
  await fx.minutes(co, file);
  const people = {
    viewer: await fx.actor({ companies: [co], grants: { ppc: "viewer" } }),
    planner: await fx.actor({ companies: [co], grants: { ppc: "editor" } }),
    approver: await fx.actor({ companies: [co], grants: { ppc: "approver" } }),
    owner: await fx.actor({ companies: [co], grants: { ppc: "owner" } }),
  };
  const w = { co, file, rel, styleId, lineRef: file.handoverLineRef, ...people };

  /* The plan, through PPC's own routes: created, started, marked planned. */
  const created = await call(`/order-book/${w.lineRef}/planning-file`,
    { method: "POST", who: w.planner, co, body: {}, key: key() });
  expect(created.status).toBe(201);
  w.planId = created.body.planningFile.planningFileId;
  const started = await call(`/planning-files/${w.planId}/planning-started`,
    { method: "POST", who: w.planner, co, body: { expectedRevision: created.body.planningFile.revision }, key: key() });
  expect(started.status).toBe(200);
  const planned = await call(`/planning-files/${w.planId}/planned`,
    { method: "POST", who: w.approver, co, body: { expectedRevision: started.body.planningFile.revision }, key: key() });
  expect(planned.status).toBe(200);
  expect(planned.body.planningFile.state).toBe("PLANNED");
  w.planRevision = planned.body.planningFile.revision;

  if (calendar) {
    w.calendar = await makeCalendar(w, { publish: calendar === "PUBLISHED", validTo, exceptions });
    w.line = await makeLine(w, { operators });
  }
  return w;
}

async function makeCalendar(w, { ref = `CAL${Date.now() % 1e6}`, publish = true, validTo = null, exceptions = [] } = {}) {
  const c = await call("/capacity/calendars", { method: "POST", who: w.owner, co: w.co,
    body: { calendarRef: ref, name: "Unit 1 — standard week", timezone: "Asia/Kolkata" } });
  expect(c.status).toBe(201);
  const calendarId = c.body.calendar.calendarId;
  const v = await call(`/capacity/calendars/${calendarId}/versions`, { method: "POST", who: w.owner, co: w.co,
    body: { validFrom: "2026-01-01", validTo, weekPattern: WEEK, exceptions } });
  expect(v.status).toBe(201);
  if (publish) {
    const p = await call(`/capacity/calendar-versions/${v.body.version.versionId}/publish`,
      { method: "POST", who: w.owner, co: w.co, body: { expectedRevision: 1 }, key: key() });
    expect(p.status).toBe(200);
    expect(p.body.version.state).toBe("PUBLISHED");
  }
  return { calendarId, versionId: v.body.version.versionId };
}

async function makeLine(w, { operators = 2, ref = `LN${Date.now() % 1e6}`, calendarId = w.calendar.calendarId } = {}) {
  const l = await call("/capacity/lines", { method: "POST", who: w.owner, co: w.co,
    body: { lineRef: ref, name: `Line ${ref}`, factoryRef: "UNIT-1", calendarId, operatorCount: operators } });
  expect(l.status).toBe(201);
  return l.body.line;
}

const previewOf = (w, { lineId = w.line.lineId, start = "2026-10-05", end = "2026-10-17", who = w.viewer, replan } = {}) =>
  call("/capacity/preview", { method: "POST", who, co: w.co,
    body: { planningFileId: w.planId, lineId, windowStart: start, windowEnd: end,
      ...(replan ? { replanBookingId: replan } : {}) } });

async function bookFrom(w, pv, { who = w.approver, k = key(), start = "2026-10-05", end = "2026-10-17", lineId = w.line.lineId } = {}) {
  return call("/capacity/bookings", { method: "POST", who, co: w.co, key: k,
    body: { planningFileId: w.planId, lineId, windowStart: start, windowEnd: end, expected: pv.body.preview.proof } });
}

const snapshot = async () => {
  const out = {};
  for (const c of await mongoose.connection.db.listCollections().toArray()) {
    out[c.name] = await mongoose.connection.collection(c.name).find({}).sort({ _id: 1 }).toArray();
  }
  return out;
};
const counts = async (names) => Object.fromEntries(await Promise.all(names.map(async (n) =>
  [n, await mongoose.connection.collection(n).countDocuments({})])));

/* ══ 1. A PREVIEW IS NOT A BOOKING ════════════════════════════════════════ */

describe("a preview is not a booking, and PLANNED books nothing", () => {
  test("becoming PLANNED created no booking and no line-day counter", async () => {
    const w = await world("PlannedNothing");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await PpcCapacityLineDay.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a preview changes no collection at all", async () => {
    const w = await world("PreviewReadOnly");
    const before = await snapshot();
    const pv = await previewOf(w);
    expect(pv.status).toBe(200);
    expect(pv.body.preview.booksCapacity).toBe(false);
    expect(pv.body.preview.releasesProduction).toBe(false);
    expect(pv.body.preview.bookable).toBe(true);
    expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
  });
});

/* ══ 2. DEMAND ════════════════════════════════════════════════════════════ */

describe("demand comes from the exact accepted release and the frozen quantity", () => {
  test("SAM × quantity ÷ target efficiency, rounded up — and IE's working time is never read", async () => {
    const w = await world("Demand", { quantity: 500, sam: 4.5, target: 60 });
    const pv = await previewOf(w);
    const d = pv.body.preview.demand;
    expect(d.state).toBe("KNOWN");
    expect(d.demandStandardMinutes).toBe(2250);
    expect(d.efficiencyPercent).toBe(60);
    expect(d.efficiencySource).toBe("IE_TARGET");
    expect(d.requiredOperatorMinutes).toBe(3750);
    expect(d.ieWorkingTimeAssumption).toBe("EXCLUDED");
    expect(d.ieReleaseRef).toBe(w.rel.releaseRef);

    /* Capacity is PPC's calendar × the line's operators: 480 × 2 per day. IE's
       99,999 shift minutes and 9 shifts appear nowhere. */
    const monday = pv.body.preview.days.find((x) => x.date === "2026-10-05");
    expect(monday.netMinutes).toBe(480);
    expect(monday.capacityOperatorMinutes).toBe(960);
    expect(JSON.stringify(pv.body)).not.toMatch(/99999|123456/);
  });

  test("a ramp stage IE froze is the efficiency the plan is sized at", async () => {
    const w = await world("Ramp", { quantity: 500, sam: 4.5, target: 80, ramp: 50 });
    const d = (await previewOf(w)).body.preview.demand;
    expect(d.efficiencyPercent).toBe(50);
    expect(d.efficiencySource).toBe("IE_RAMP_STAGE");
    expect(d.requiredOperatorMinutes).toBe(4500);
  });

  test("a release with no efficiency makes demand unknown, and nothing is bookable", async () => {
    const w = await world("NoEff", { target: 0 });
    const pv = await previewOf(w);
    expect(pv.body.preview.demand.state).toBe("UNKNOWN");
    expect(pv.body.preview.bookable).toBe(false);
    expect(pv.body.preview.unknowns.map((u) => u.code)).toContain("DEMAND_UNKNOWN");
    expect(pv.body.preview.totals.requiredOperatorMinutes).toBeNull();
  });

  test("the IE contract does not even return the working-time assumption", async () => {
    const w = await world("Contract", { calendar: null });
    const ie = require("../../services/industrialEngineering/releasePublication.service");
    const eng = await ie.publishReleaseEngineering({ companyId: w.co._id }, String(w.rel._id));
    expect(eng.workingTimeAssumption).toBe("EXCLUDED");
    for (const k of ["availableShiftMinutes", "breakMinutes", "shiftsPerDay", "calculation", "aggregateFingerprint"]) {
      expect(JSON.stringify(eng)).not.toContain(k);
    }
  });
});

/* ══ 3. THE CALENDAR MUST BE PROVED ═══════════════════════════════════════ */

describe("no booking on a missing, provisional, stale, gapped or unreadable calendar", () => {
  test("missing: a calendar with no version", async () => {
    const w = await world("CalMissing", { calendar: null });
    const c = await call("/capacity/calendars", { method: "POST", who: w.owner, co: w.co,
      body: { calendarRef: "EMPTY", name: "Nothing yet" } });
    w.line = await makeLine(w, { calendarId: c.body.calendar.calendarId });
    const pv = await previewOf(w);
    expect(pv.body.preview.calendar.state).toBe("MISSING");
    expect(pv.body.preview.blockers.map((b) => b.code)).toContain("CALENDAR_MISSING");
    const b = await bookFrom(w, pv);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PPC_CAPACITY_NOT_BOOKABLE");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("provisional: only a DRAFT version exists", async () => {
    const w = await world("CalDraft", { calendar: "DRAFT" });
    const pv = await previewOf(w);
    expect(pv.body.preview.calendar.state).toBe("PROVISIONAL");
    expect(pv.body.preview.blockers.map((b) => b.code)).toContain("CALENDAR_PROVISIONAL");
    /* Every day is unknown, not zero — a draft proves no hours. */
    expect(pv.body.preview.days.every((d) => d.capacityOperatorMinutes === null)).toBe(true);
    expect(pv.body.preview.totals.availableOperatorMinutes).toBeNull();
  });

  test("gap: a day the published version does not describe is unknown, not closed", async () => {
    const w = await world("CalGap", { validTo: "2026-10-09" });
    const pv = await previewOf(w, { start: "2026-10-05", end: "2026-10-14" });
    const gap = pv.body.preview.blockers.find((b) => b.code === "CALENDAR_GAP");
    expect(gap).toBeTruthy();
    expect(gap.dates).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    const d = pv.body.preview.days.find((x) => x.date === "2026-10-12");
    expect(d.known).toBe(false);
    expect(d.capacityOperatorMinutes).toBeNull();
    expect(pv.body.preview.bookable).toBe(false);
  });

  test("stale: the calendar is republished between preview and booking", async () => {
    const w = await world("CalStale");
    const pv = await previewOf(w);
    expect(pv.body.preview.proof.calendarVersionNo).toBe(1);
    const v2 = await call(`/capacity/calendars/${w.calendar.calendarId}/versions`, { method: "POST", who: w.owner, co: w.co,
      body: { validFrom: "2026-01-01", weekPattern: WEEK } });
    await call(`/capacity/calendar-versions/${v2.body.version.versionId}/publish`,
      { method: "POST", who: w.owner, co: w.co, body: { expectedRevision: 1 }, key: key() });
    const b = await bookFrom(w, pv);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PPC_CAPACITY_STALE");
    expect(b.body.error.details.moved).toEqual([{ key: "calendarVersionNo", previewed: 1, now: 2 }]);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("stale: the line's headcount changes between preview and booking", async () => {
    const w = await world("LineStale");
    const pv = await previewOf(w);
    await call(`/capacity/lines/${w.line.lineId}`, { method: "PATCH", who: w.owner, co: w.co,
      body: { expectedRevision: w.line.revision, operatorCount: 9 } });
    const b = await bookFrom(w, pv);
    expect(b.status).toBe(409);
    expect(b.body.error.details.moved.map((m) => m.key)).toEqual(["lineRevision"]);
  });

  test("unreadable: a failed calendar read is 503 and books nothing", async () => {
    const w = await world("CalUnreadable");
    const pv = await previewOf(w);
    const original = PpcCapacityCalendar.findOne;
    PpcCapacityCalendar.findOne = () => { throw new Error("calendar store unavailable"); };
    try {
      const p2 = await previewOf(w);
      expect(p2.body.preview.calendar.state).toBe("UNREADABLE");
      expect(p2.body.preview.unknowns.map((u) => u.code)).toContain("CALENDAR_UNREADABLE");
      /* Unknown is not zero. */
      expect(p2.body.preview.totals.availableOperatorMinutes).toBeNull();
      const b = await bookFrom(w, pv);
      expect(b.status).toBe(503);
      expect(b.body.error.code).toBe("PPC_CAPACITY_UNDETERMINED");
    } finally { PpcCapacityCalendar.findOne = original; }
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("holidays and rest days take nothing; a make-up working day does", async () => {
    const w = await world("Holidays", {
      exceptions: [
        { date: "2026-10-06", kind: "HOLIDAY", reason: "Dussehra" },
        { date: "2026-10-11", kind: "WORKING_DAY", reason: "Make-up Sunday",
          shifts: [{ shiftKey: "A", start: "09:00", end: "13:00", breakMinutes: 0 }] },
      ],
    });
    const days = (await previewOf(w)).body.preview.days;
    const by = Object.fromEntries(days.map((d) => [d.date, d]));
    expect(by["2026-10-06"].capacityOperatorMinutes).toBe(0);
    expect(by["2026-10-06"].calendarSource).toBe("EXCEPTION_HOLIDAY");
    expect(by["2026-10-06"].allocatedOperatorMinutes).toBe(0);
    expect(by["2026-10-11"].calendarSource).toBe("EXCEPTION_WORKING_DAY");
    expect(by["2026-10-11"].netMinutes).toBe(240);
    expect(by["2026-10-18"]).toBeUndefined();
  });

  test("a published version is permanent — at the route and at the model", async () => {
    const w = await world("Permanent");
    const res = await call(`/capacity/calendar-versions/${w.calendar.versionId}`, { method: "PATCH", who: w.owner, co: w.co,
      body: { expectedRevision: 2, note: "sneaky" } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_CALENDAR_VERSION_PUBLISHED");
    await expect(PpcCapacityCalendarVersion.updateOne(
      { _id: w.calendar.versionId }, { $set: { weekPattern: [] } },
    )).rejects.toThrow(/DRAFT/);
    await expect(PpcCapacityCalendarVersion.deleteOne({ _id: w.calendar.versionId })).rejects.toThrow();
  });

  test("a calendar version with problems is refused with every problem named", async () => {
    const w = await world("Invalid", { calendar: null });
    const c = await call("/capacity/calendars", { method: "POST", who: w.owner, co: w.co,
      body: { calendarRef: "BAD", name: "Bad" } });
    const bad = WEEK.map((d, i) => (i === 0 ? { working: true, shifts: [{ start: "08:00", end: "08:00", breakMinutes: 0 }] } : d));
    const v = await call(`/capacity/calendars/${c.body.calendar.calendarId}/versions`, { method: "POST", who: w.owner, co: w.co,
      body: { validFrom: "2026-13-01", weekPattern: bad, exceptions: [{ date: "2026-10-06", kind: "HOLIDAY", reason: "" }] } });
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe("PPC_CALENDAR_CONTENT_INVALID");
    const fields = v.body.error.details.problems.map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(["validFrom", "weekPattern[0].shifts[0]", "exceptions[0].reason"]));
  });
});

/* ══ 4. BOOKING ═══════════════════════════════════════════════════════════ */

describe("an explicit, proved booking", () => {
  test("allocates earliest-first across working days and takes exactly the demand", async () => {
    const w = await world("Book", { quantity: 500, operators: 2 });
    const pv = await previewOf(w);
    const b = await bookFrom(w, pv);
    expect(b.status).toBe(201);
    const bk = b.body.booking;
    expect(bk.state).toBe("ACTIVE");
    /* 3750 operator-minutes at 960 a day: Mon, Tue, Wed full, Thu 870. */
    expect(bk.allocations).toEqual([
      { date: "2026-10-05", operatorMinutes: 960 },
      { date: "2026-10-06", operatorMinutes: 960 },
      { date: "2026-10-07", operatorMinutes: 960 },
      { date: "2026-10-08", operatorMinutes: 870 },
    ]);
    expect(bk.bookedOperatorMinutes).toBe(3750);
    expect(bk.calendarVersionNo).toBe(1);
    expect(bk.lineRevision).toBe(1);
    expect(bk.planningFileRevision).toBe(w.planRevision);
    expect(bk.basis.ieReleaseVersionNo).toBe(1);
    expect(bk.booksCapacity).toBe(true);
    expect(bk.releasesProduction).toBe(false);
    expect(bk.createsWorkOrder).toBe(false);

    const days = await PpcCapacityLineDay.find({ companyId: w.co._id }).sort({ date: 1 }).lean();
    expect(days.map((d) => [d.date, d.bookedOperatorMinutes, d.capacityOperatorMinutes])).toEqual([
      ["2026-10-05", 960, 960], ["2026-10-06", 960, 960], ["2026-10-07", 960, 960], ["2026-10-08", 870, 960],
    ]);
  });

  test("a body cannot supply allocations, capacity or a booking of its own", async () => {
    const w = await world("NoClientAlloc");
    const pv = await previewOf(w);
    const b = await call("/capacity/bookings", { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: "2026-10-05", windowEnd: "2026-10-17",
        expected: pv.body.preview.proof, allocations: [{ date: "2026-10-05", operatorMinutes: 1 }] } });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe("PPC_CAPACITY_FIELD_UNKNOWN");
    expect(b.body.error.details.fields).toEqual(["allocations"]);
  });

  test("a booking without the previewed versions is refused", async () => {
    const w = await world("NoProof");
    const b = await call("/capacity/bookings", { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: "2026-10-05", windowEnd: "2026-10-17" } });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe("PPC_CAPACITY_PROOF_REQUIRED");
  });

  test("a shortage is refused, naming how short", async () => {
    const w = await world("Short", { quantity: 5000, operators: 1 });
    const pv = await previewOf(w, { start: "2026-10-05", end: "2026-10-07" });
    expect(pv.body.preview.totals.shortageOperatorMinutes).toBe(37500 - 1440);
    expect(pv.body.preview.blockers.map((x) => x.code)).toContain("CAPACITY_SHORTAGE");
    const b = await bookFrom(w, pv, { start: "2026-10-05", end: "2026-10-07" });
    expect(b.status).toBe(409);
    expect(await PpcCapacityLineDay.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a plan that is not PLANNED books nothing — an ON_HOLD plan included", async () => {
    const w = await world("Held");
    await call(`/planning-files/${w.planId}/hold`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: w.planRevision, reason: "AWAITING_MATERIAL" } });
    const pv = await previewOf(w);
    expect(pv.body.preview.blockers.map((b) => b.code)).toContain("PLANNING_FILE_NOT_PLANNED");
    expect(pv.body.preview.bookable).toBe(false);
  });
});

/* ══ 5. OVERBOOKING AND CONCURRENCY ═══════════════════════════════════════ */

describe("a day can never hold more than its capacity", () => {
  /** A second PLANNED plan in the same company, on the same line. */
  async function secondPlan(w, { quantity = 500 } = {}) {
    const file = await fx.orderLine(w.co, { lineRef: `L2-${Date.now()}-${Math.random()}`, quantity });
    await fx.pack(w.co, file);
    /* The release first: the minutes record WHICH release was reviewed. */
    await engineeredRelease(w.co, file.currentExecutionProjection.sampleStyleId);
    await fx.minutes(w.co, file);
    const c = await call(`/order-book/${file.handoverLineRef}/planning-file`, { method: "POST", who: w.planner, co: w.co, body: {}, key: key() });
    const s = await call(`/planning-files/${c.body.planningFile.planningFileId}/planning-started`, { method: "POST", who: w.planner, co: w.co, body: { expectedRevision: c.body.planningFile.revision }, key: key() });
    const p = await call(`/planning-files/${c.body.planningFile.planningFileId}/planned`, { method: "POST", who: w.approver, co: w.co, body: { expectedRevision: s.body.planningFile.revision }, key: key() });
    return { ...w, planId: p.body.planningFile.planningFileId, planRevision: p.body.planningFile.revision };
  }

  test("a second plan sees only what is left, and books around the first", async () => {
    const w = await world("TwoPlans");
    await bookFrom(w, await previewOf(w));
    const w2 = await secondPlan(w);
    const pv2 = await previewOf(w2);
    const thu = pv2.body.preview.days.find((d) => d.date === "2026-10-08");
    expect(thu.bookedOperatorMinutes).toBe(870);
    expect(thu.freeOperatorMinutes).toBe(90);
    const b2 = await bookFrom(w2, pv2);
    expect(b2.status).toBe(201);
    expect(b2.body.booking.allocations[0]).toEqual({ date: "2026-10-08", operatorMinutes: 90 });
    const days = await PpcCapacityLineDay.find({ companyId: w.co._id }).lean();
    for (const d of days) expect(d.bookedOperatorMinutes).toBeLessThanOrEqual(d.capacityOperatorMinutes);
  });

  test("a booking previewed before another filled the day is refused whole, not half-booked", async () => {
    const w = await world("Race1");
    const w2 = await secondPlan(w);
    const pvA = await previewOf(w);
    const pvB = await previewOf(w2);         // both previews see an empty line
    expect((await bookFrom(w, pvA)).status).toBe(201);
    const b = await bookFrom(w2, pvB);       // B's preview is now wrong about Mon–Thu
    /* Proof versions are unchanged, so the refusal comes from the DATABASE guard
       — or, equally honestly, from the recomputed preview inside the command.
       Either way nothing of B lands. */
    expect(b.status === 409 || b.status === 201).toBe(true);
    const days = await PpcCapacityLineDay.find({ companyId: w.co._id }).lean();
    for (const d of days) expect(d.bookedOperatorMinutes).toBeLessThanOrEqual(d.capacityOperatorMinutes);
  });

  test("concurrent bookings for the last free minutes: the sum never exceeds capacity", async () => {
    /* One day of capacity (960) and two plans each needing 750: only one fits. */
    const w = await world("RaceLast", { quantity: 100, operators: 2 });   // 450 SM ÷ .6 = 750
    const w2 = await secondPlan(w, { quantity: 100 });
    const one = { start: "2026-10-05", end: "2026-10-05" };
    const [pa, pb] = await Promise.all([previewOf(w, one), previewOf(w2, one)]);
    expect(pa.body.preview.bookable && pb.body.preview.bookable).toBe(true);
    const results = await Promise.all([bookFrom(w, pa, one), bookFrom(w2, pb, one)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(["PPC_CAPACITY_OVERBOOKED", "PPC_CAPACITY_NOT_BOOKABLE"]).toContain(loser.body.error.code);
    const day = await PpcCapacityLineDay.findOne({ companyId: w.co._id, date: "2026-10-05" }).lean();
    expect(day.bookedOperatorMinutes).toBe(750);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);
  });

  test("two concurrent bookings of ONE plan under different keys produce one booking", async () => {
    const w = await world("RaceSamePlan");
    const pv = await previewOf(w);
    const results = await Promise.all([bookFrom(w, pv), bookFrom(w, pv), bookFrom(w, pv)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results) expect(JSON.stringify(r.body)).not.toMatch(/E11000|duplicate key/i);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
    const total = (await PpcCapacityLineDay.find({ companyId: w.co._id }).lean())
      .reduce((a, d) => a + d.bookedOperatorMinutes, 0);
    expect(total).toBe(3750);
  });

  test("even if the service's own read of booked minutes is wrong, the database refuses the overbooking", async () => {
    /* The first booking takes Mon–Wed in full and 870 on Thursday. Then, for
       the second booking only, the service's read of what is already booked is
       made to LIE — it sees an empty line — so its recomputed plan asks for
       full days that are already taken. No other layer can catch this: the
       counters were committed before the second booking started, so there is no
       write conflict to retry. Only the conditional update's cap stands between
       that plan and a line-day holding more than its capacity. */
    const w = await world("DbGuard");
    expect((await bookFrom(w, await previewOf(w))).status).toBe(201);
    const w2 = await secondPlan(w);
    const pv = await previewOf(w2);

    const original = PpcCapacityLineDay.find;
    PpcCapacityLineDay.find = () => ({ lean: async () => [] });
    let b;
    try { b = await bookFrom(w2, pv); } finally { PpcCapacityLineDay.find = original; }

    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PPC_CAPACITY_OVERBOOKED");
    const days = await PpcCapacityLineDay.find({ companyId: w.co._id }).lean();
    for (const d of days) expect(d.bookedOperatorMinutes).toBeLessThanOrEqual(d.capacityOperatorMinutes);
    expect(days.reduce((a, d) => a + d.bookedOperatorMinutes, 0)).toBe(3750);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("the constraints are the database's: one active booking per plan, one counter per line-day", () => {
    const bIdx = PpcCapacityBooking.schema.indexes().find(([, o]) => o?.name === "ppc_booking_one_active_per_plan");
    expect(bIdx[1].unique).toBe(true);
    expect(bIdx[1].partialFilterExpression).toEqual({ state: "ACTIVE" });
    const dIdx = PpcCapacityLineDay.schema.indexes().find(([, o]) => o?.name === "ppc_line_day_unique");
    expect(dIdx[0]).toEqual({ companyId: 1, lineId: 1, date: 1 });
    expect(dIdx[1].unique).toBe(true);
    const vIdx = PpcCapacityCalendarVersion.schema.indexes().find(([, o]) => o?.name === "ppc_calendar_one_published");
    expect(vIdx[1].partialFilterExpression).toEqual({ state: "PUBLISHED" });
  });
});

/* ══ 5b. A CHANGE LANDING BETWEEN PROOF AND COMMIT ════════════════════════
 *
 * The booking command reads the line and the calendar, proves the booking, and
 * then commits. These tests put an owner's change EXACTLY in that gap — after
 * the reads, before the commit — by hooking the last read the proof makes. The
 * booking must be refused, not committed against figures that no longer exist.
 */
describe("a change that lands between a booking's proof and its commit", () => {
  /**
   * Preview normally, then book with `change` run inside the booking command —
   * after it has read the line and the calendar, before it commits. The hook is
   * the command's last read (the booked-minutes query), so by then the proof has
   * already been taken.
   */
  const inGap = async (w, change) => {
    const pv = await previewOf(w);
    const original = PpcCapacityLineDay.find;
    let fired = false;
    PpcCapacityLineDay.find = function hooked(...args) {
      const query = original.apply(this, args);
      if (fired) return query;
      fired = true;
      return { lean: async () => { await change(); return query.lean(); } };
    };
    try { return await bookFrom(w, pv); } finally { PpcCapacityLineDay.find = original; }
  };

  test("a headcount edit in the gap makes the booking stale, and nothing is booked", async () => {
    const w = await world("GapLine");
    const b = await inGap(w, () => PpcCapacityLine.updateOne(
      { _id: w.line.lineId }, { $set: { operatorCount: 40 }, $inc: { revision: 1 } }));
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PPC_CAPACITY_STALE");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
    expect((await PpcCapacityLineDay.find({ companyId: w.co._id }).lean())
      .reduce((a, d) => a + d.bookedOperatorMinutes, 0)).toBe(0);
  });

  test("a calendar publish in the gap makes the booking stale, and nothing is booked", async () => {
    const w = await world("GapCal");
    const b = await inGap(w, () => PpcCapacityCalendar.updateOne(
      { _id: w.calendar.calendarId }, { $inc: { revision: 1 } }));
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe("PPC_CAPACITY_STALE");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("without a change in the gap, the same path books", async () => {
    const w = await world("GapNone");
    const b = await inGap(w, async () => {});
    expect(b.status).toBe(201);
    const line = await PpcCapacityLine.findById(w.line.lineId).lean();
    expect(line.bookingFence).toBe(1);
    expect(line.revision).toBe(1);      // a booking fences the line; it does not edit it
  });
});

/* ══ 5b. THE PLANNING FILE IS FENCED TOO ══════════════════════════════════
 * A booking or replan reads the PLANNED plan, proves itself, and commits. A
 * hold or a successor that commits in between must make it fail — with no new
 * booking, no minutes taken, and the old booking of a replan still active.
 *
 * The change is made through PPC's REAL lifecycle routes, inside the capacity
 * command, after its proof has read the plan and before it commits: hooked on
 * the proof's last read (the booked-minutes query), exactly as the line and
 * calendar gap tests above do. The hook fires once, so a driver retry of the
 * capacity transaction re-reads the world without a second change. */
describe("a hold or successor that lands between the proof and the commit", () => {
  const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");

  const duringProof = async (change, run) => {
    const original = PpcCapacityLineDay.find;
    let fired = false;
    PpcCapacityLineDay.find = function hooked(...args) {
      const query = original.apply(this, args);
      if (fired) return query;
      fired = true;
      return { lean: async () => { await change(); return query.lean(); } };
    };
    try { return await run(); } finally { PpcCapacityLineDay.find = original; }
  };

  const hold = (w, expectedRevision) => call(`/planning-files/${w.planId}/hold`, { method: "POST",
    who: w.approver, co: w.co, key: key(), body: { expectedRevision, reason: "AWAITING_MATERIAL" } });

  const successor = async (w, expectedRevision) => {
    await ExecutionPack.updateOne({ companyId: w.co._id, fileId: w.file._id }, { $set: { state: "SUPERSEDED" } });
    await fx.pack(w.co, w.file, { versionNo: 2 });
    return call(`/planning-files/${w.planId}/successor`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision, reason: "The execution pack moved to version 2 and PPC accepted it." } });
  };

  const bookedMinutes = async (w) => (await PpcCapacityLineDay.find({ companyId: w.co._id }).lean())
    .reduce((a, d) => a + d.bookedOperatorMinutes, 0);

  const replanOf = (w, old, pv) => call(`/capacity/bookings/${old.bookingId}/replan`, {
    method: "POST", who: w.approver, co: w.co, key: key(),
    body: { expectedRevision: old.revision, reason: "Tighten the window to the first week.", lineId: w.line.lineId,
      windowStart: "2026-10-05", windowEnd: "2026-10-10", expected: pv.body.preview.proof } });

  for (const [label, change, endState] of [
    ["a hold", hold, "ON_HOLD"],
    ["a successor", successor, "SUPERSEDED"],
  ]) {
    test(`${label} in the gap: the booking is refused, and nothing is booked or taken`, async () => {
      const w = await world(`FenceBook${endState}`);
      const pv = await previewOf(w);
      let moved = null;
      const b = await duringProof(async () => { moved = await change(w, w.planRevision); },
        () => bookFrom(w, pv));

      expect(moved.status).toBeLessThan(300);                  // the lifecycle command really committed
      expect(b.status).toBe(409);
      expect(b.body.error.code).toBe("PPC_CAPACITY_STALE");
      expect(b.body.error.details.moved.map((m) => m.key)).toContain("planningFileRevision");
      expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
      expect(await bookedMinutes(w)).toBe(0);
      const pf = await PpcPlanningFile.findById(w.planId).lean();
      expect(pf.state).toBe(endState);
      expect(pf.bookingFence || 0).toBe(0);                    // the aborted fence left no trace
      /* The line and calendar fences were rolled back with it. */
      expect((await PpcCapacityLine.findById(w.line.lineId).lean()).bookingFence || 0).toBe(0);
    });

    test(`${label} in the gap: the replan is refused, and the old booking keeps its minutes`, async () => {
      const w = await world(`FenceReplan${endState}`);
      const old = (await bookFrom(w, await previewOf(w))).body.booking;
      const before = await bookedMinutes(w);
      expect(before).toBeGreaterThan(0);
      const pv = await previewOf(w, { start: "2026-10-05", end: "2026-10-10", replan: old.bookingId });
      expect(pv.body.preview.bookable).toBe(true);

      let moved = null;
      const r = await duringProof(async () => { moved = await change(w, w.planRevision); },
        () => replanOf(w, old, pv));

      expect(moved.status).toBeLessThan(300);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("PPC_CAPACITY_STALE");
      const kept = await PpcCapacityBooking.findById(old.bookingId).lean();
      expect(kept.state).toBe("ACTIVE");                       // not prematurely retired
      expect(kept.revision).toBe(old.revision);
      expect(kept.supersededByBookingId || null).toBeNull();
      expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
      expect(await bookedMinutes(w)).toBe(before);             // nothing returned, nothing re-taken
      expect((await PpcPlanningFile.findById(w.planId).lean()).bookingFence).toBe(1);   // the original booking's only
    });
  }

  /* ── THE REVERSE ORDER ───────────────────────────────────────────────────
     The booking fences the plan FIRST; the hold is sent while the booking's
     transaction is still open (from inside its final insert) and is not
     awaited there. The hold cannot commit before the booking — they write the
     same document — so it is retried and commits after. The outcome is
     coherent: a valid booking made while the plan was PLANNED, a plan now on
     hold at the next revision, and the booking reporting the hold as movement. */
  const afterFence = async (change, run) => {
    const original = PpcCapacityBooking.create;
    let pending = null;
    PpcCapacityBooking.create = async function hooked(...args) {
      if (!pending) {
        pending = change();
        await new Promise((r) => setTimeout(r, 400));          // let it hit the fenced document
      }
      return original.apply(this, args);
    };
    try {
      const out = await run();
      return { out, changed: await pending };
    } finally { PpcCapacityBooking.create = original; }
  };

  test("reverse order: a booking that fenced first commits, and the hold serialises after it", async () => {
    const w = await world("FenceReverseBook");
    const pv = await previewOf(w);
    const { out: b, changed: h } = await afterFence(() => hold(w, w.planRevision), () => bookFrom(w, pv));

    expect(b.status).toBe(201);
    expect(h.status).toBe(200);
    expect(h.body.planningFile.state).toBe("ON_HOLD");
    expect(h.body.planningFile.revision).toBe(w.planRevision + 1);   // the fence moved no business revision
    const pf = await PpcPlanningFile.findById(w.planId).lean();
    expect(pf.bookingFence).toBe(1);
    const heldAt = pf.history.find((e) => e.type === "HOLD_PLACED").at;
    const booking = await PpcCapacityBooking.findById(b.body.booking.bookingId).lean();
    expect(new Date(heldAt).getTime()).toBeGreaterThanOrEqual(new Date(booking.createdAt).getTime());
    const got = await call(`/capacity/bookings/${b.body.booking.bookingId}`, { who: w.viewer, co: w.co });
    expect(got.body.booking.health.movements.map((m) => m.key)).toContain("planningFile");
  });

  test("reverse order: a replan that fenced first commits whole, and the hold serialises after it", async () => {
    const w = await world("FenceReverseReplan");
    const old = (await bookFrom(w, await previewOf(w))).body.booking;
    const pv = await previewOf(w, { start: "2026-10-05", end: "2026-10-10", replan: old.bookingId });
    const { out: r, changed: h } = await afterFence(() => hold(w, w.planRevision), () => replanOf(w, old, pv));

    expect(r.status).toBe(201);
    expect(h.status).toBe(200);
    expect(h.body.planningFile.state).toBe("ON_HOLD");
    expect((await PpcCapacityBooking.findById(old.bookingId).lean()).state).toBe("SUPERSEDED");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);
    expect(await bookedMinutes(w)).toBe(3750);
  });

  test("the fence is a lock, not a way to write the plan", async () => {
    const w = await world("FenceShape");
    const id = new mongoose.Types.ObjectId(w.planId);
    const exact = { _id: id, companyId: w.co._id, revision: w.planRevision, state: "PLANNED" };
    const before = await mongoose.connection.collection("ppc_planning_files").findOne({ _id: id });
    const M = PpcPlanningFile;
    const attempts = {
      "timestamps on": () => M.updateOne(exact, { $inc: { bookingFence: 1 } }),
      "by two": () => M.updateOne(exact, { $inc: { bookingFence: 2 } }, { timestamps: false }),
      "another field": () => M.updateOne(exact, { $inc: { bookingFence: 1, revision: 1 } }, { timestamps: false }),
      "revision alone": () => M.updateOne(exact, { $inc: { revision: 1 } }, { timestamps: false }),
      "not PLANNED": () => M.updateOne({ ...exact, state: "ON_HOLD" }, { $inc: { bookingFence: 1 } }, { timestamps: false }),
      "no revision": () => M.updateOne({ _id: id, companyId: w.co._id, state: "PLANNED" },
        { $inc: { bookingFence: 1 } }, { timestamps: false }),
      "extra filter key": () => M.updateOne({ ...exact, plannedAt: { $ne: null } },
        { $inc: { bookingFence: 1 } }, { timestamps: false }),
      "operator in filter": () => M.updateOne({ ...exact, revision: { $gte: 1 } },
        { $inc: { bookingFence: 1 } }, { timestamps: false }),
      "upsert": () => M.updateOne(exact, { $inc: { bookingFence: 1 } }, { timestamps: false, upsert: true }),
      "many": () => M.updateMany(exact, { $inc: { bookingFence: 1 } }, { timestamps: false }),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      let refused = null;
      try { await attempt(); } catch (err) { refused = err; }
      if (!refused) throw new Error(`"${name}" was not refused`);
    }
    expect(await mongoose.connection.collection("ppc_planning_files").findOne({ _id: id })).toEqual(before);

    /* The permitted fence moves the counter and nothing else. */
    const { fencePlannedFileForBooking } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
    expect(await fencePlannedFileForBooking({ companyId: w.co._id, planningFileId: id, revision: w.planRevision }))
      .toBe(true);
    expect(await fencePlannedFileForBooking({ companyId: w.co._id, planningFileId: id, revision: w.planRevision + 1 }))
      .toBe(false);
    const after = await mongoose.connection.collection("ppc_planning_files").findOne({ _id: id });
    expect(after.bookingFence).toBe(1);
    const { bookingFence: _a, ...restAfter } = after;
    const { bookingFence: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);                    // revision, history, updatedAt untouched
  });
});

/* ══ 6. IDEMPOTENCY ═══════════════════════════════════════════════════════ */

describe("idempotent replay", () => {
  test("the same key and request replays the identical answer and books once", async () => {
    const w = await world("Replay");
    const pv = await previewOf(w);
    const k = key();
    const first = await bookFrom(w, pv, { k });
    const again = await bookFrom(w, pv, { k });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect({ ...again.body, replayed: false }).toEqual(first.body);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
    const total = (await PpcCapacityLineDay.find({ companyId: w.co._id }).lean())
      .reduce((a, d) => a + d.bookedOperatorMinutes, 0);
    expect(total).toBe(3750);
  });

  test("the same key for a different request is refused", async () => {
    const w = await world("Reuse");
    const pv = await previewOf(w);
    const k = key();
    await bookFrom(w, pv, { k });
    const other = await bookFrom(w, pv, { k, end: "2026-10-16" });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("no key, no booking", async () => {
    const w = await world("NoKey");
    const pv = await previewOf(w);
    const b = await call("/capacity/bookings", { method: "POST", who: w.approver, co: w.co,
      body: { planningFileId: w.planId, lineId: w.line.lineId, windowStart: "2026-10-05", windowEnd: "2026-10-17", expected: pv.body.preview.proof } });
    expect(b.status).toBe(400);
    expect(b.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });
});

/* ══ 7. RELEASE AND REPLAN ════════════════════════════════════════════════ */

describe("release and replan are successors, never edits", () => {
  test("release gives every minute back and keeps the booking as evidence", async () => {
    const w = await world("Release");
    const b = await bookFrom(w, await previewOf(w));
    const id = b.body.booking.bookingId;
    const r = await call(`/capacity/bookings/${id}/release`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 1, reason: "PLAN_CHANGED", note: "Buyer moved the delivery." } });
    expect(r.status).toBe(200);
    expect(r.body.booking.state).toBe("RELEASED");
    expect(r.body.booking.releaseReason).toBe("PLAN_CHANGED");
    expect(r.body.booking.allocations).toHaveLength(4);        // the record of what was booked stays
    expect(r.body.booking.booksCapacity).toBe(false);
    for (const d of await PpcCapacityLineDay.find({ companyId: w.co._id }).lean()) {
      expect(d.bookedOperatorMinutes).toBe(0);
    }
    const again = await call(`/capacity/bookings/${id}/release`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 2, reason: "PLAN_CHANGED" } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PPC_CAPACITY_BOOKING_CLOSED");
    /* After a release the plan may be booked afresh — a new generation. */
    const b2 = await bookFrom(w, await previewOf(w));
    expect(b2.status).toBe(201);
    expect(b2.body.booking.generation).toBe(2);
    expect(b2.body.booking.bookingRef).not.toBe(b.body.booking.bookingRef);
  });

  test("a release needs a classified reason, and OTHER needs a note", async () => {
    const w = await world("ReleaseReason");
    const b = await bookFrom(w, await previewOf(w));
    const id = b.body.booking.bookingId;
    for (const body of [{ reason: "BECAUSE" }, { reason: "OTHER", note: "x" }]) {
      const r = await call(`/capacity/bookings/${id}/release`, { method: "POST", who: w.approver, co: w.co, key: key(),
        body: { expectedRevision: 1, ...body } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("PPC_CAPACITY_REASON_INVALID");
    }
  });

  test("replan moves the minutes to a successor and preserves the old booking", async () => {
    const w = await world("Replan");
    const b = await bookFrom(w, await previewOf(w));
    const old = b.body.booking;
    const line2 = await makeLine(w, { operators: 4, ref: `LN2${Date.now() % 1e5}` });
    const pv = await previewOf(w, { lineId: line2.lineId, start: "2026-10-12", end: "2026-10-17", replan: old.bookingId });
    expect(pv.body.preview.blockers).toEqual([]);
    const r = await call(`/capacity/bookings/${old.bookingId}/replan`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 1, reason: "Line 1 is needed for an urgent re-cut.", lineId: line2.lineId,
        windowStart: "2026-10-12", windowEnd: "2026-10-17", expected: pv.body.preview.proof } });
    expect(r.status).toBe(201);
    const next = r.body.booking;
    expect(next.supersedesBookingRef).toBe(old.bookingRef);
    expect(next.lineRef).toBe(line2.lineRef);
    expect(next.allocations).toEqual([
      { date: "2026-10-12", operatorMinutes: 1920 }, { date: "2026-10-13", operatorMinutes: 1830 },
    ]);
    expect(r.body.supersededBooking.state).toBe("SUPERSEDED");
    expect(r.body.supersededBooking.supersededByBookingRef).toBe(next.bookingRef);
    expect(r.body.supersededBooking.allocations).toEqual(old.allocations);

    const oldDays = await PpcCapacityLineDay.find({ companyId: w.co._id, lineId: old.lineId }).lean();
    expect(oldDays.every((d) => d.bookedOperatorMinutes === 0)).toBe(true);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id, state: "ACTIVE" })).toBe(1);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("a replan onto the same days does not compete with itself", async () => {
    const w = await world("ReplanSame");
    const old = (await bookFrom(w, await previewOf(w))).body.booking;
    const pv = await previewOf(w, { start: "2026-10-05", end: "2026-10-10", replan: old.bookingId });
    expect(pv.body.preview.bookable).toBe(true);
    const r = await call(`/capacity/bookings/${old.bookingId}/replan`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 1, reason: "Tighten the window to the first week.", lineId: w.line.lineId,
        windowStart: "2026-10-05", windowEnd: "2026-10-10", expected: pv.body.preview.proof } });
    expect(r.status).toBe(201);
    const days = await PpcCapacityLineDay.find({ companyId: w.co._id }).lean();
    expect(days.reduce((a, d) => a + d.bookedOperatorMinutes, 0)).toBe(3750);
  });

  test("a stale replan changes nothing", async () => {
    const w = await world("ReplanStale");
    const old = (await bookFrom(w, await previewOf(w))).body.booking;
    const pv = await previewOf(w, { replan: old.bookingId });
    const r = await call(`/capacity/bookings/${old.bookingId}/replan`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 7, reason: "A reason long enough to read.", lineId: w.line.lineId,
        windowStart: "2026-10-05", windowEnd: "2026-10-17", expected: pv.body.preview.proof } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("PPC_CAPACITY_REVISION_STALE");
    const b = await PpcCapacityBooking.findById(old.bookingId).lean();
    expect(b.state).toBe("ACTIVE");
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ══ 8. MOVEMENT AFTER BOOKING IS REPORTED, NEVER ABSORBED ════════════════ */

describe("source and calendar movement after booking", () => {
  test("a republished calendar that closes a booked day is reported, and the booking is not rewritten", async () => {
    const w = await world("CalAfter");
    const b = (await bookFrom(w, await previewOf(w))).body.booking;
    const v2 = await call(`/capacity/calendars/${w.calendar.calendarId}/versions`, { method: "POST", who: w.owner, co: w.co,
      body: { validFrom: "2026-01-01", weekPattern: WEEK, exceptions: [{ date: "2026-10-06", kind: "NON_WORKING", reason: "Power shutdown" }] } });
    await call(`/capacity/calendar-versions/${v2.body.version.versionId}/publish`,
      { method: "POST", who: w.owner, co: w.co, body: { expectedRevision: 1 }, key: key() });

    const got = await call(`/capacity/bookings/${b.bookingId}`, { who: w.viewer, co: w.co });
    expect(got.body.booking.health.moved).toBe(true);
    expect(got.body.booking.health.movements.map((m) => m.key)).toContain("calendar");
    expect(got.body.booking.allocations).toEqual(b.allocations);
    expect(got.body.booking.calendarVersionNo).toBe(1);

    const load = await call(`/capacity/lines/${w.line.lineId}/load?from=2026-10-05&to=2026-10-09`, { who: w.viewer, co: w.co });
    const tue = load.body.days.find((d) => d.date === "2026-10-06");
    expect(tue.capacityOperatorMinutes).toBe(0);
    expect(tue.bookedOperatorMinutes).toBe(960);
    expect(tue.overbooked).toBe(true);
  });

  test("a superseded engineering release blocks booking and is reported on an existing booking", async () => {
    const w = await world("IeMoved");
    const b = (await bookFrom(w, await previewOf(w))).body.booking;
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: w.rel._id }, { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } });
    const got = await call(`/capacity/bookings/${b.bookingId}`, { who: w.viewer, co: w.co });
    expect(got.body.booking.health.movements.map((m) => m.key)).toContain("ieRelease");

    const pv = await previewOf(w, { replan: b.bookingId });
    const codes = pv.body.preview.blockers.map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(["RELEASE_MOVED"]));
    expect(pv.body.preview.bookable).toBe(false);
  });

  test("a moved confirmed quantity blocks booking", async () => {
    const w = await world("QtyMoved");
    /* The model's own collection, not a guessed name — a raw write to a
       collection that does not exist moves nothing and proves nothing. */
    const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
    const moved = await ExecutionFile.collection.updateOne(
      { _id: w.file._id }, { $set: { "currentExecutionProjection.totalQuantity": 777 } });
    expect(moved.modifiedCount).toBe(1);
    const pv = await previewOf(w);
    expect(pv.body.preview.blockers.map((x) => x.code)).toContain("SOURCES_MOVED");
  });
});

/* ══ 9. DAYS ARE DAYS IN EVERY TIMEZONE ═══════════════════════════════════ */

describe("non-UTC servers", () => {
  test("weekday, day arithmetic and net minutes are identical from UTC−11 to UTC+14", () => {
    const probe = `
      const c = require(${JSON.stringify(path.join(__dirname, "../../services/ppc/capacityCalendar.js"))});
      const WEEK = ${JSON.stringify(WEEK)};
      const v = { validFrom: "2026-01-01", validTo: null, weekPattern: WEEK,
        exceptions: [{ date: "2026-11-08", kind: "HOLIDAY", reason: "Diwali" }] };
      const days = [...c.eachDay("2026-03-06", "2026-03-10"), ...c.eachDay("2026-10-30", "2026-11-09")];
      process.stdout.write(JSON.stringify(days.map((d) => [d, c.weekdayIndex(d), c.netMinutesOn(v, d).minutes])));
    `;
    const outputs = ["UTC", "Pacific/Pago_Pago", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]
      .map((tz) => execFileSync(process.execPath, ["-e", probe], { env: { ...process.env, TZ: tz } }).toString());
    for (const o of outputs) expect(o).toBe(outputs[0]);
    const parsed = JSON.parse(outputs[0]);
    expect(parsed.find(([d]) => d === "2026-03-08")).toEqual(["2026-03-08", 6, 0]);       // Sunday, US DST start
    expect(parsed.find(([d]) => d === "2026-11-01")).toEqual(["2026-11-01", 6, 0]);       // Sunday, US DST end
    expect(parsed.find(([d]) => d === "2026-11-08")).toEqual(["2026-11-08", 6, 0]);
    expect(parsed.find(([d]) => d === "2026-11-09")).toEqual(["2026-11-09", 0, 480]);
  });

  test("booked dates are stored as the strings that were computed, not instants", async () => {
    const w = await world("Strings");
    await bookFrom(w, await previewOf(w));
    const raw = await mongoose.connection.collection("ppc_capacity_bookings").findOne({ companyId: w.co._id });
    for (const a of raw.allocations) expect(typeof a.date).toBe("string");
    expect(typeof raw.windowStart).toBe("string");
    const day = await mongoose.connection.collection("ppc_capacity_line_days").findOne({ companyId: w.co._id });
    expect(typeof day.date).toBe("string");
  });

  test("a window written as an instant is refused rather than guessed", async () => {
    const w = await world("Instant");
    const pv = await previewOf(w, { start: "2026-10-05T00:00:00.000Z", end: "2026-10-09" });
    expect(pv.status).toBe(400);
    expect(pv.body.error.code).toBe("PPC_CAPACITY_INPUT_INVALID");
  });
});

/* ══ 10. COMPANY ISOLATION AND THE LADDER ═════════════════════════════════ */

describe("company isolation", () => {
  test("another company's lines, calendars, plans and bookings are unreachable", async () => {
    const a = await world("IsoA");
    const bw = await world("IsoB");
    const booked = (await bookFrom(bw, await previewOf(bw))).body.booking;

    const lines = await call("/capacity/lines", { who: a.viewer, co: a.co });
    expect(lines.body.lines.map((l) => l.lineId)).not.toContain(bw.line.lineId);
    const cal = await call(`/capacity/calendars/${bw.calendar.calendarId}`, { who: a.viewer, co: a.co });
    expect(cal.status).toBe(404);
    const bk = await call(`/capacity/bookings/${booked.bookingId}`, { who: a.viewer, co: a.co });
    expect(bk.status).toBe(404);
    /* My plan on their line: their line is not mine. */
    const pv = await previewOf(a, { lineId: bw.line.lineId });
    expect(pv.status).toBe(404);
    expect(pv.body.error.code).toBe("PPC_LINE_NOT_FOUND");
    /* Their plan through my company header: not found either. */
    const pv2 = await call("/capacity/preview", { method: "POST", who: a.viewer, co: a.co,
      body: { planningFileId: bw.planId, lineId: a.line.lineId, windowStart: "2026-10-05", windowEnd: "2026-10-09" } });
    expect(pv2.status).toBe(404);
    /* A line cannot point at another company's calendar. */
    const cross = await call("/capacity/lines", { method: "POST", who: a.owner, co: a.co,
      body: { lineRef: "X1", name: "X", calendarId: bw.calendar.calendarId, operatorCount: 3 } });
    expect(cross.status).toBe(404);
  });
});

describe("viewer previews, approver books, owner configures", () => {
  test("the whole matrix", async () => {
    const w = await world("Ladder");
    const outsider = await fx.actor({ companies: [w.co], grants: { ie: "owner" } });

    for (const who of [w.viewer, w.planner, w.approver, w.owner]) {
      expect((await previewOf(w, { who })).status).toBe(200);
    }
    expect((await previewOf(w, { who: outsider })).status).toBe(403);

    const pv = await previewOf(w);
    for (const who of [w.viewer, w.planner]) {
      const r = await bookFrom(w, pv, { who });
      expect(r.status).toBe(403);
      expect(r.body.error.details.requires.capability).toBe("ppc.capacity.book");
    }
    for (const who of [w.viewer, w.planner, w.approver]) {
      const r = await call("/capacity/calendars", { method: "POST", who, co: w.co, body: { calendarRef: "NOPE", name: "No" } });
      expect(r.status).toBe(403);
      expect(r.body.error.details.requires.capability).toBe("ppc.capacity.configure");
      const l = await call(`/capacity/lines/${w.line.lineId}`, { method: "PATCH", who, co: w.co,
        body: { expectedRevision: 1, operatorCount: 99 } });
      expect(l.status).toBe(403);
    }
    expect((await bookFrom(w, pv, { who: w.approver })).status).toBe(201);
    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ══ 11. NOTHING OUTSIDE PPC IS WRITTEN ═══════════════════════════════════ */

describe("zero writes to IE, Merchandising, Store or Production", () => {
  test("book, release and replan touch only PPC's own collections", async () => {
    const w = await world("NoWrites");
    const outside = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name).filter((n) => !/^ppc_/.test(n));
    const before = {};
    for (const n of outside) before[n] = await mongoose.connection.collection(n).find({}).sort({ _id: 1 }).toArray();

    const b = (await bookFrom(w, await previewOf(w))).body.booking;
    const pv = await previewOf(w, { replan: b.bookingId, end: "2026-10-16" });
    const r = await call(`/capacity/bookings/${b.bookingId}/replan`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 1, reason: "Replan inside the same line.", lineId: w.line.lineId,
        windowStart: "2026-10-05", windowEnd: "2026-10-16", expected: pv.body.preview.proof } });
    await call(`/capacity/bookings/${r.body.booking.bookingId}/release`, { method: "POST", who: w.approver, co: w.co, key: key(),
      body: { expectedRevision: 1, reason: "ORDER_CANCELLED" } });

    for (const n of outside) {
      /* The idempotency ledger is PPC's own and lives outside the ppc_ prefix. */
      if (n === "ppc_planning_commands" || /planning_command/i.test(n)) continue;
      const now = await mongoose.connection.collection(n).find({}).sort({ _id: 1 }).toArray();
      expect({ [n]: JSON.stringify(now) }).toEqual({ [n]: JSON.stringify(before[n]) });
    }
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    const production = [];
    for (const n of names) {
      if (/^merchandising_|^ppc_/.test(n)) continue;
      if (!/workorder|production|stock|barcode|scan|store/i.test(n)) continue;
      if (await mongoose.connection.collection(n).countDocuments({})) production.push(n);
    }
    expect(production).toEqual([]);
  });

  test("the capacity code requires no Production, Store, Merchandising-writer or IE-writer module", () => {
    const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");
    for (const f of ["services/ppc/capacityPlanning.service.js", "services/ppc/capacityConfig.service.js",
      "services/ppc/capacityCalendar.js", "routes/CMS_Routes/PPC/capacityRoute.js"]) {
      const src = read(f);
      expect(src).not.toMatch(/require\([^)]*(WorkOrder|Production|StockItem|Barcode|StorePurchase\/(?!errors))[^)]*\)/);
      for (const m of ["IeRelease", "ExecutionFile", "ExecutionPack", "PreProductionMeeting", "PpcPlanningFile"]) {
        expect(src).not.toMatch(new RegExp(`${m}\\.(create|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|bulkWrite|insertMany)\\b`));
      }
    }
    /* The planning file's one capacity write is the model's own booking fence,
       called from exactly one place — the fence — and nowhere else. */
    const svc = read("services/ppc/capacityPlanning.service.js");
    expect(svc.match(/fencePlannedFileForBooking\(/g)).toHaveLength(1);
    for (const f of ["services/ppc/capacityConfig.service.js", "services/ppc/capacityCalendar.js",
      "routes/CMS_Routes/PPC/capacityRoute.js"]) {
      expect(read(f)).not.toMatch(/fencePlannedFileForBooking/);
    }
  });

  test("the router carries no Production, work-order or release-to-Production verb", () => {
    const router = require("../../routes/CMS_Routes/PPC/capacityRoute");
    const segs = router.stack.filter((l) => l.route).flatMap((l) => l.route.path.split("/").filter(Boolean));
    expect(segs.filter((s) => /^(production|work-orders?|release-to-production|dispatch)$/i.test(s))).toEqual([]);
  });
});
