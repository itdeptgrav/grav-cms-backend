// test/ppc/ppc-stage-schedule.test.js
//
// PPC'S MULTI-STAGE SCHEDULE — planned start/finish per stage of the IE route
// frozen in a planning file's own release, as PPC-internal planning targets.
//
// Pinned:
//   · only the route's REQUIRED stages appear; a NOT_APPLICABLE stage is
//     listed as such and cannot be dated; an UNKNOWN route blocks scheduling;
//   · save/reload round-trips; each save is a version; moving a set date is a
//     replan that needs a reason and keeps the old dates in history;
//   · a stage cannot start before its predecessor's planned finish;
//   · two same-name lines of one style keep separate schedules;
//   · another company can neither read nor write it;
//   · a retried save (same key) is one version, not two;
//   · Cutting and Embroidery say "handoff not connected", and saving writes
//     nothing outside PPC's own schedule — no booking, no other app's record.
//
// These tests pin the schedule's MECHANICS on a line whose route is proven
// applicable. Sales publishes no line-level special-process statement yet
// (see services/ppc/lineProcessRequirements.js), so the statement is supplied
// here, per line, in the shape PPC accepts. What happens WITHOUT it — the real
// state today — is pinned in ppc-line-route-applicability.test.js.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* lineRef → the Sales statement this test stands in for. */
const mockStated = new Map();
jest.mock("../../services/ppc/lineProcessRequirements", () => {
  const actual = jest.requireActual("../../services/ppc/lineProcessRequirements");
  return { ...actual, readStatement: (v) => mockStated.get(v.handoverLineRef) || actual.readStatement(v) };
});
const stateLine = (lineRef, { embroidery = "REQUIRED" } = {}) => mockStated.set(lineRef, {
  state: "STATED", processes: { EMBROIDERY: embroidery, PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED" },
});

const crypto = require("crypto");
const mongoose = require("mongoose");

const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { NO_WORKORDER_LINK } = require("../../services/ppc/stageSchedule.service");
const {
  server, nextKey, readyWorld, company, orderLine, pack, minutes, release, actor,
} = require("./planningFixtures");

const api = server();
const ppc = (...a) => api.call(...a);

beforeAll(async () => {
  await api.start();
  await PpcPlanningFile.syncIndexes();
  await PpcPlanningCommand.syncIndexes();
  await PpcStageSchedule.syncIndexes();
});
afterAll(async () => { await api.stop(); });

/* ── An IE route as IE freezes it into a release ──────────────────────────── */
const id = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
function route({ embroidery = "REQUIRED" } = {}) {
  const cut = id(); const emb = id(); const sew = id(); const fin = id();
  const embRequired = embroidery === "REQUIRED";
  return {
    ids: { cut, emb, sew, fin },
    stages: [
      { stageId: cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD },
      { stageId: emb, sequence: 2, process: "EMBROIDERY", label: "Chest embroidery", applicability: embroidery, predecessorStageIds: embRequired ? [cut] : [] },
      { stageId: sew, sequence: 3, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [embRequired ? emb : cut] },
      { stageId: fin, sequence: 4, process: "FINISHING", label: "Finishing", applicability: "REQUIRED", predecessorStageIds: [sew] },
      /* IE's explicit answer for the other buyer-specific processes. */
      { stageId: id(), sequence: 5, process: "PRINTING", label: "Printing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
      { stageId: id(), sequence: 6, process: "WASHING", label: "Washing", applicability: "NOT_APPLICABLE", predecessorStageIds: [] },
    ],
  };
}

const createPlan = (w, lineRef = w.lineRef) => ppc(`/order-book/${lineRef}/planning-file`,
  { method: "POST", token: w.planner.token, company: w.co._id, body: {}, key: nextKey() });
const getSchedule = (w, pf, who = w.planner) => ppc(`/planning-files/${pf}/stage-schedule`,
  { token: who.token, company: w.co._id });
const saveSchedule = (w, pf, body, { who = w.planner, key = nextKey() } = {}) => ppc(`/planning-files/${pf}/stage-schedule`,
  { method: "POST", token: who.token, company: w.co._id, body, key });

async function world(label, opts = {}) {
  const r = route(opts);
  const w = await readyWorld(label, { processRoute: r.stages });
  stateLine(w.lineRef, { embroidery: opts.embroidery === "NOT_APPLICABLE" ? "NOT_REQUIRED" : "REQUIRED" });
  const c = await createPlan(w);
  expect(c.status).toBe(201);
  return { ...w, r, pf: c.body.planningFile.planningFileId };
}

/** Every collection outside PPC's schedule and command ledger, hashed. */
async function outsideSchedule() {
  const out = {};
  for (const { name } of await mongoose.connection.db.listCollections().toArray()) {
    if (["ppc_stage_schedules", "ppc_planning_commands"].includes(name) || name.startsWith("system.")) continue;
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex");
  }
  return out;
}

/**
 * A plan a planner may actually type.
 *
 * CUTTING is deliberately absent. A cutting window is written from a capacity
 * reservation on a Cutting-owned resource, never typed — the save path
 * refuses it by name, which the suite proves below. Every other stage is
 * still PPC's own to date.
 */
const PLAN = (ids) => [
  { stageId: ids.emb, plannedStart: "2026-10-04", plannedEnd: "2026-10-06" },
  { stageId: ids.sew, plannedStart: "2026-10-07", plannedEnd: "2026-10-14" },
  { stageId: ids.fin, plannedStart: "2026-10-15", plannedEnd: "2026-10-16" },
];

describe("only the stages the frozen IE route requires", () => {
  test("embroidery required: four stages, in route order, none dated yet", async () => {
    const w = await world("SchedReq");
    const res = await getSchedule(w, w.pf);
    expect(res.status).toBe(200);
    expect(res.body.route.state).toBe("DECLARED");
    expect(res.body.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING", "FINISHING"]);
    expect(res.body.stages.every((s) => s.plannedStart === null && s.plannedEnd === null)).toBe(true);
    expect(res.body.notApplicable.map((s) => s.process)).toEqual(["PRINTING", "WASHING"]);
    expect(res.body.applicability.state).toBe("PROVEN");
    expect(res.body.editable).toBe(true);
    expect(res.body.schedule).toBeNull();
  });

  test("embroidery NOT_APPLICABLE: omitted from the schedule, listed as such, and cannot be dated", async () => {
    const w = await world("SchedNA", { embroidery: "NOT_APPLICABLE" });
    const res = await getSchedule(w, w.pf);
    expect(res.body.stages.map((s) => s.process)).toEqual(["CUTTING", "SEWING", "FINISHING"]);
    expect(res.body.notApplicable[0]).toEqual({ stageId: w.r.ids.emb, process: "EMBROIDERY", label: "Chest embroidery" });
    expect(res.body.notApplicable.map((s) => s.process)).toEqual(["EMBROIDERY", "PRINTING", "WASHING"]);
    const bad = await saveSchedule(w, w.pf, { expectedRevision: 0,
      stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-04", plannedEnd: "2026-10-06" }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("PPC_STAGE_NOT_IN_ROUTE");
  });

  test("a release with no approved route is a blocker: nothing listed, nothing saveable", async () => {
    const w = await readyWorld("SchedUnknown"); // no processRoute
    const pf = (await createPlan(w)).body.planningFile.planningFileId;
    const res = await getSchedule(w, pf);
    expect(res.body.route.state).toBe("UNKNOWN");
    expect(res.body.stages).toEqual([]);
    expect(res.body.editable).toBe(false);
    const save = await saveSchedule(w, pf, { expectedRevision: 0,
      stages: [{ stageId: id(), plannedStart: "2026-10-01", plannedEnd: "2026-10-02" }] });
    expect(save.status).toBe(409);
    expect(save.body.error.code).toBe("PPC_ROUTE_STAGE_UNKNOWN");
    expect(await PpcStageSchedule.countDocuments({ planningFileId: pf })).toBe(0);
  });
});

describe("a cutting window is reserved, never typed", () => {
  test("a typed cutting date is refused by name, and nothing is saved", async () => {
    const w = await world("SchedCutTyped");
    const tried = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: [
      { stageId: w.r.ids.cut, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" },
    ] });
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    expect(tried.body.error.details).toMatchObject({ stageId: w.r.ids.cut, process: "CUTTING" });
    expect(tried.body.message).toMatch(/Preview Cutting capacity and reserve it/);
    expect(await PpcStageSchedule.countDocuments({ planningFileId: w.pf })).toBe(0);
  });

  test("a cutting date smuggled in beside legitimate stages takes the whole save down", async () => {
    /* Whole-statement refusal: a save that dated embroidery and sewing and
       quietly also cutting must not half-apply. */
    const w = await world("SchedCutMixed");
    const tried = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: [
      ...PLAN(w.r.ids),
      { stageId: w.r.ids.cut, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" },
    ] });
    expect(tried.status).toBe(409);
    expect(tried.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    expect(await PpcStageSchedule.countDocuments({ planningFileId: w.pf })).toBe(0);

    /* And the same save without cutting is accepted, so the refusal is about
       cutting and not about the request. */
    const ok = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    expect(ok.status).toBe(200);
  });

  test("every other stage is still PPC's own to date", async () => {
    const w = await world("SchedNonCutting");
    const ok = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    expect(ok.status).toBe(200);
    const read = await getSchedule(w, w.pf);
    const dated = read.body.stages.filter((s) => s.plannedStart);
    expect(dated.map((s) => s.process)).toEqual(["EMBROIDERY", "SEWING", "FINISHING"]);
    expect(read.body.stages.find((s) => s.process === "CUTTING").plannedStart).toBeNull();
  });
});

describe("save, reload and replan — nothing overwritten silently", () => {
  test("a save round-trips on reload as version 1", async () => {
    const w = await world("SchedSave");
    const saved = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    expect(saved.status).toBe(200);
    expect(saved.body.schedule).toMatchObject({ versionNo: 1, revision: 1 });
    const again = await getSchedule(w, w.pf);
    /* Cutting is still a row — it is a required stage — and it is undated,
       because a cutting window comes from a capacity reservation and this
       save could not have set one. */
    expect(again.body.stages.map((s) => [s.process, s.plannedStart, s.plannedEnd, s.setInVersion])).toEqual([
      ["CUTTING", null, null, null], ["EMBROIDERY", "2026-10-04", "2026-10-06", 1],
      ["SEWING", "2026-10-07", "2026-10-14", 1], ["FINISHING", "2026-10-15", "2026-10-16", 1],
    ]);
    expect(again.body.history).toHaveLength(1);
    expect(again.body.history[0]).toMatchObject({ versionNo: 1, kind: "PLANNED" });
  });

  test("a replan needs a reason, and keeps the old dates beside the new", async () => {
    const w = await world("SchedReplan");
    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    const moved = [{ stageId: w.r.ids.fin, plannedStart: "2026-10-16", plannedEnd: "2026-10-17" }];

    const noReason = await saveSchedule(w, w.pf, { expectedRevision: 1, stages: moved });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("PPC_STAGE_REPLAN_REASON_REQUIRED");
    expect(noReason.body.error.message).toBe("Moving a planned date is a replan: say why the dates are moving.");
    expect((await getSchedule(w, w.pf)).body.schedule.versionNo).toBe(1);

    const ok = await saveSchedule(w, w.pf, { expectedRevision: 1, stages: moved,
      reason: "Finishing unit closed on the 15th for a maintenance day." });
    expect(ok.status).toBe(200);
    const h = (await getSchedule(w, w.pf)).body.history;
    expect(h.map((x) => [x.versionNo, x.kind])).toEqual([[2, "REPLANNED"], [1, "PLANNED"]]);
    expect(h[0].reason).toBe("Finishing unit closed on the 15th for a maintenance day.");
    expect(h[0].changes).toEqual([{
      stageId: w.r.ids.fin, process: "FINISHING", label: "Finishing",
      fromStart: "2026-10-15", fromEnd: "2026-10-16", toStart: "2026-10-16", toEnd: "2026-10-17",
    }]);
    expect(h[1].changes).toHaveLength(3); // version 1 is kept, untouched
  });

  test("a save against an old revision is refused; an unchanged save is refused", async () => {
    const w = await world("SchedStale");
    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    const stale = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("PPC_STAGE_SCHEDULE_STALE");
    const same = await saveSchedule(w, w.pf, { expectedRevision: 1, stages: PLAN(w.r.ids) });
    expect(same.body.error.code).toBe("PPC_STAGE_SCHEDULE_UNCHANGED");
  });

  test("a stage cannot start before its predecessor finishes — move them together", async () => {
    const w = await world("SchedPred");
    /* Embroidery and sewing: both PPC's own to date, so the rule is proved
       on stages a planner can actually type. */
    const clash = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: [
      { stageId: w.r.ids.emb, plannedStart: "2026-10-04", plannedEnd: "2026-10-08" },
      { stageId: w.r.ids.sew, plannedStart: "2026-10-07", plannedEnd: "2026-10-14" },
    ] });
    expect(clash.status).toBe(400);
    expect(clash.body.error.code).toBe("PPC_STAGE_PREDECESSOR_CONFLICT");

    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    /* Moving embroidery later alone would leave sewing starting too early. */
    const alone = await saveSchedule(w, w.pf, { expectedRevision: 1, reason: "Fabric arrives two days late.",
      stages: [{ stageId: w.r.ids.emb, plannedStart: "2026-10-06", plannedEnd: "2026-10-09" }] });
    expect(alone.body.error.code).toBe("PPC_STAGE_PREDECESSOR_CONFLICT");
    const together = await saveSchedule(w, w.pf, { expectedRevision: 1, reason: "Fabric arrives two days late.", stages: [
      { stageId: w.r.ids.emb, plannedStart: "2026-10-06", plannedEnd: "2026-10-08" },
      { stageId: w.r.ids.sew, plannedStart: "2026-10-09", plannedEnd: "2026-10-16" },
      { stageId: w.r.ids.fin, plannedStart: "2026-10-17", plannedEnd: "2026-10-18" },
    ] });
    expect(together.status).toBe(200);
    expect(together.body.history[0].changes).toHaveLength(3);
  });

  test("a retried save with the same key is one version, not two", async () => {
    const w = await world("SchedRetry");
    const key = nextKey();
    const a = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) }, { key });
    const b = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) }, { key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    const doc = await PpcStageSchedule.findOne({ planningFileId: w.pf }).lean();
    expect(doc.versionNo).toBe(1);
    expect(doc.history).toHaveLength(1);
  });
});

describe("two same-name lines of one style keep separate schedules", () => {
  test("same product, same style, same route — two line identities, two schedules", async () => {
    const co = await company("SchedTwin");
    const r = route();
    const styleId = new mongoose.Types.ObjectId();
    await release(co, styleId, { processRoute: r.stages });
    const lines = [];
    for (const n of [1, 2]) {
      const file = await orderLine(co, { lineRef: `L-TWIN-${n}-${Date.now()}`, sampleStyleId: styleId });
      stateLine(file.handoverLineRef);
      await pack(co, file);
      await minutes(co, file);
      lines.push(file);
    }
    expect(lines[0].currentExecutionProjection.productName).toBe(lines[1].currentExecutionProjection.productName);
    const w = { co, planner: await actor({ companies: [co], grants: { ppc: "editor" } }) };
    const pf1 = (await createPlan(w, lines[0].handoverLineRef)).body.planningFile.planningFileId;
    const pf2 = (await createPlan(w, lines[1].handoverLineRef)).body.planningFile.planningFileId;
    expect(pf1).not.toBe(pf2);

    await saveSchedule(w, pf1, { expectedRevision: 0, stages: PLAN(r.ids) });
    const s1 = await getSchedule(w, pf1);
    const s2 = await getSchedule(w, pf2);
    expect(s1.body.planningFile.orderLineRef).toBe(lines[0].handoverLineRef);
    expect(s2.body.planningFile.orderLineRef).toBe(lines[1].handoverLineRef);
    /* By process, not by position: stages[0] is CUTTING, which this save
       could not date — a cutting window comes from a reservation. */
    expect(s1.body.stages.find((s) => s.process === "EMBROIDERY").plannedStart).toBe("2026-10-04");
    expect(s2.body.stages.every((s) => s.plannedStart === null)).toBe(true);
    expect(s2.body.schedule).toBeNull();
  });
});

describe("company isolation and permissions", () => {
  test("another company's PPC user can neither read nor write it", async () => {
    const w = await world("SchedIso");
    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    const other = await company("SchedIsoOther");
    const stranger = await actor({ companies: [other], grants: { ppc: "approver" } });
    const read = await ppc(`/planning-files/${w.pf}/stage-schedule`, { token: stranger.token, company: other._id });
    expect(read.status).toBe(404);
    const write = await ppc(`/planning-files/${w.pf}/stage-schedule`, { method: "POST", token: stranger.token,
      company: other._id, body: { expectedRevision: 1, stages: PLAN(w.r.ids), reason: "Trying to move another company's plan." }, key: nextKey() });
    expect(write.status).toBe(404);
    expect((await PpcStageSchedule.findOne({ planningFileId: w.pf }).lean()).versionNo).toBe(1);
  });

  test("a viewer reads the schedule but cannot save it", async () => {
    const w = await world("SchedViewer");
    expect((await getSchedule(w, w.pf, w.viewer)).status).toBe(200);
    const res = await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) }, { who: w.viewer });
    expect(res.status).toBe(403);
  });

  test("a withdrawn (cancelled) plan's schedule is a record and cannot change", async () => {
    const w = await world("SchedClosed");
    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    const plan = await PpcPlanningFile.findById(w.pf).lean();
    await ppc(`/planning-files/${w.pf}/cancel`, { method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: plan.revision, reason: "OPENED_IN_ERROR" }, key: nextKey() });
    const res = await saveSchedule(w, w.pf, { expectedRevision: 1, reason: "Moving a withdrawn plan's dates.",
      stages: [{ stageId: w.r.ids.fin, plannedStart: "2026-10-20", plannedEnd: "2026-10-21" }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PPC_STAGE_SCHEDULE_CLOSED");
    const read = await getSchedule(w, w.pf);
    expect(read.body.editable).toBe(false);
    expect(read.body.stages.find((s) => s.process === "EMBROIDERY").plannedStart).toBe("2026-10-04");
  });
});

describe("handoffs are honestly not connected, and nothing outside PPC moves", () => {
  test("Cutting and Embroidery say not connected; sewing reads its (absent) booking", async () => {
    const w = await world("SchedHandoff");
    const res = await getSchedule(w, w.pf);
    const by = Object.fromEntries(res.body.stages.map((s) => [s.process, s.handoff]));
    expect(by.CUTTING).toEqual({ state: "NOT_CONNECTED", reason: "WORKORDER_NOT_LINKED", message: NO_WORKORDER_LINK });
    expect(by.EMBROIDERY).toEqual({ state: "NOT_CONNECTED", reason: "WORKORDER_NOT_LINKED", message: NO_WORKORDER_LINK });
    expect(by.SEWING.state).toBe("NO_BOOKING");
    expect(by.FINISHING.state).toBe("NOT_CONNECTED");
    expect(res.body).toMatchObject({ planningTargetsOnly: true, publishedToOtherApps: false, booksCapacity: false, releasesProduction: false });
  });

  test("saving and replanning write only PPC's schedule — no booking, no WorkOrder, no other app's record", async () => {
    const w = await world("SchedNoCross");
    const before = await outsideSchedule();
    await saveSchedule(w, w.pf, { expectedRevision: 0, stages: PLAN(w.r.ids) });
    await saveSchedule(w, w.pf, { expectedRevision: 1, reason: "Sewing line needed one more day.",
      stages: [{ stageId: w.r.ids.sew, plannedStart: "2026-10-07", plannedEnd: "2026-10-14" },
        { stageId: w.r.ids.fin, plannedStart: "2026-10-16", plannedEnd: "2026-10-17" }] });
    expect(await outsideSchedule()).toEqual(before);
  });
});
