// test/ppc/ppc-line-route-applicability.test.js
//
// DOES THE FROZEN IE ROUTE APPLY TO THIS EXACT SALES LINE?
//
// The chain proved: company → permanent line → the execution pack the plan
// froze → the Sales handover version that pack names → the IE release the
// plan froze (its version and style) → the line's stated special processes
// against the route. Pinned:
//
//   · today's real state: Sales states no special processes on the approved
//     handover, so EVERY line is blocked with LINE_REQUIREMENT_NOT_STATED —
//     read shows no stages, save is refused, nothing is written;
//   · two lines of one style with different embroidery / wash needs: the one
//     matching the route is proven, the other is a named mismatch;
//   · a route that never mentions a process adds no stage for it: a line that
//     needs it is a mismatch, a line that doesn't is consistent;
//   · historical UNKNOWN routes, missing / contradictory / superseded /
//     cancelled Sales versions and a style or release-version disagreement
//     are each a named blocker;
//   · an unreadable source is UNREADABLE, never "missing" and never "proven";
//   · an existing schedule and its history stay readable once blocked;
//   · a later IE release does not move a plan off the release it froze;
//   · another company's records are never evidence, and never echoed.
"use strict";

/* IE's approved cutting standard. A required CUTTING stage carries one, or it
   cannot be dated — see test/ppc/ppc-cutting-technical-basis.test.js. */
const CUT_STD = require("./planningFixtures").cuttingStandard();
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* lineRef → a Sales statement in the shape PPC accepts. A line absent from the
   map gets the real reader's answer: NOT_STATED. */
const mockStated = new Map();
jest.mock("../../services/ppc/lineProcessRequirements", () => {
  const actual = jest.requireActual("../../services/ppc/lineProcessRequirements");
  return { ...actual, readStatement: (v) => mockStated.get(v.handoverLineRef) || actual.readStatement(v) };
});

const crypto = require("crypto");
const mongoose = require("mongoose");

const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const { compareProcesses } = require("../../services/ppc/lineRouteApplicability.service");
const {
  server, nextKey, readyWorld, company, orderLine, pack, minutes, release, actor, SalesHandoverVersion,
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

/* ── Routes and statements ─────────────────────────────────────────────── */
const id = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
function route({ EMBROIDERY = "REQUIRED", PRINTING = "NOT_APPLICABLE", WASHING = "NOT_APPLICABLE" } = {}) {
  const ids = { cut: id(), emb: id(), sew: id(), wash: id(), prn: id() };
  const stages = [{ stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: "REQUIRED", predecessorStageIds: [], technicalStandard: CUT_STD }];
  let prev = ids.cut;
  const add = (key, process, label, applicability, seq) => {
    if (applicability === null) return; // the route never mentions it
    stages.push({ stageId: ids[key], sequence: seq, process, label, applicability,
      predecessorStageIds: applicability === "REQUIRED" ? [prev] : [] });
    if (applicability === "REQUIRED") prev = ids[key];
  };
  add("emb", "EMBROIDERY", "Chest embroidery", EMBROIDERY, 2);
  add("prn", "PRINTING", "Printing", PRINTING, 3);
  stages.push({ stageId: ids.sew, sequence: 4, process: "SEWING", label: "Sewing", applicability: "REQUIRED", predecessorStageIds: [prev] });
  prev = ids.sew;
  add("wash", "WASHING", "Enzyme wash", WASHING, 5);
  return { ids, stages };
}
const state = (lineRef, processes) => mockStated.set(lineRef, {
  state: "STATED", processes: { EMBROIDERY: "NOT_REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED", ...processes },
});

const createPlan = (w, lineRef = w.lineRef) => ppc(`/order-book/${lineRef}/planning-file`,
  { method: "POST", token: w.planner.token, company: w.co._id, body: {}, key: nextKey() });
const getSchedule = (w, pf) => ppc(`/planning-files/${pf}/stage-schedule`, { token: w.planner.token, company: w.co._id });
const saveSchedule = (w, pf, body) => ppc(`/planning-files/${pf}/stage-schedule`,
  { method: "POST", token: w.planner.token, company: w.co._id, body, key: nextKey() });
/* SEWING, not cutting: a cutting window comes from a capacity reservation and
   cannot be typed at all (see ppc-cutting-capacity-booking.test.js). What this
   suite is about is whether a line's applicability lets it be dated, and any
   REQUIRED stage answers that. */
const firstDates = (ids) => ({ expectedRevision: 0, stages: [{ stageId: ids.sew, plannedStart: "2026-10-01", plannedEnd: "2026-10-03" }] });

/** A ready line with a planning file. `statement` null leaves Sales silent. */
async function world(label, { routeOpts = {}, statement = { EMBROIDERY: "REQUIRED" }, processRoute } = {}) {
  const r = route(routeOpts);
  const w = await readyWorld(label, { processRoute: processRoute === undefined ? r.stages : processRoute });
  if (statement) state(w.lineRef, statement);
  const c = await createPlan(w);
  expect(c.status).toBe(201);
  const plan = await PpcPlanningFile.findById(c.body.planningFile.planningFileId).lean();
  return { ...w, r, pf: String(plan._id), plan };
}

/** A read that refuses, and a save that refuses and writes nothing. */
async function expectBlocked(w, reason, { code = "PPC_LINE_ROUTE_UNPROVEN", status = 409 } = {}) {
  const read = await getSchedule(w, w.pf);
  expect(read.status).toBe(200);
  expect(read.body.applicability.state).toBe(status === 503 ? "UNREADABLE" : "BLOCKED");
  expect(read.body.applicability.reason).toBe(reason);
  expect(read.body.editable).toBe(false);
  const before = await PpcStageSchedule.findOne({ planningFileId: w.pf }).lean();
  if (!before) expect(read.body.stages).toEqual([]);
  const save = await saveSchedule(w, w.pf, before
    ? { expectedRevision: before.revision, reason: "Checking a blocked line cannot be replanned.",
      stages: [{ stageId: before.stages[0].stageId, plannedStart: "2026-11-01", plannedEnd: "2026-11-02" }] }
    : firstDates(w.r.ids));
  expect(save.status).toBe(status);
  expect(save.body.error.code).toBe(code);
  if (code.startsWith("PPC_LINE_ROUTE")) expect(save.body.error.details.reason).toBe(reason);
  const after = await PpcStageSchedule.findOne({ planningFileId: w.pf }).lean();
  expect(after?.revision ?? null).toBe(before?.revision ?? null);
  return read.body;
}

const setPack = (w, set) => ExecutionPack.collection.updateOne({ _id: w.pack._id }, { $set: set });
const setHandover = (w, set) => SalesHandoverVersion.collection.updateOne({ _id: w.file.currentHandoverVersionId }, { $set: set });

/* ══ TODAY: SALES STATES NO SPECIAL PROCESSES ═════════════════════════════ */

describe("today's real source: the approved Sales handover states no special processes", () => {
  test("every line is blocked by name, owned by Sales; no style route is shown as the line's stages", async () => {
    const w = await world("ApNotStated", { statement: null });
    const body = await expectBlocked(w, "LINE_REQUIREMENT_NOT_STATED");
    expect(body.applicability).toMatchObject({ kind: "MISSING", owner: "Sales" });
    expect(body.applicability.message).toMatch(/does not state whether it needs embroidery, printing or washing/);
    expect(body.applicability.processes.map((p) => [p.process, p.line, p.route])).toEqual([
      ["EMBROIDERY", "NOT_STATED", "REQUIRED"], ["PRINTING", "NOT_STATED", "NOT_APPLICABLE"], ["WASHING", "NOT_STATED", "NOT_APPLICABLE"],
    ]);
    expect(body.notApplicable).toEqual([]);
    /* The exact chain it was checked against. */
    expect(body.applicability.evidence).toMatchObject({
      companyId: String(w.co._id), orderLineRef: w.lineRef,
      requirementVersion: { versionId: String(w.file.currentHandoverVersionId), versionNo: 1, handoverLineRef: w.lineRef, publicationState: "CURRENT" },
      ieRelease: { releaseId: String(w.rel._id), versionNo: 1, sampleStyleId: String(w.styleId) },
      routeState: "DECLARED",
    });
  });
});

/* ══ TWO LINES OF ONE STYLE ═══════════════════════════════════════════════ */

describe("two confirmed lines of one style, one style route", () => {
  async function twins(label, routeOpts, needs) {
    const co = await company(label);
    const r = route(routeOpts);
    const styleId = new mongoose.Types.ObjectId();
    await release(co, styleId, { processRoute: r.stages });
    const planner = await actor({ companies: [co], grants: { ppc: "editor" } });
    const out = [];
    for (const [n, stated] of needs.entries()) {
      const file = await orderLine(co, { lineRef: `L-${label}-${n}-${Date.now()}`, sampleStyleId: styleId });
      await pack(co, file);
      await minutes(co, file);
      state(file.handoverLineRef, stated);
      const w = { co, planner, r, lineRef: file.handoverLineRef };
      const c = await createPlan(w);
      expect(c.status).toBe(201);
      out.push({ ...w, pf: c.body.planningFile.planningFileId });
    }
    return out;
  }

  test("embroidery: the line that needs it is proven; the plain line is a named mismatch", async () => {
    const [a, b] = await twins("ApTwinEmb", { EMBROIDERY: "REQUIRED" }, [{ EMBROIDERY: "REQUIRED" }, { EMBROIDERY: "NOT_REQUIRED" }]);
    const ra = await getSchedule(a, a.pf);
    expect(ra.body.applicability.state).toBe("PROVEN");
    expect(ra.body.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING"]);
    expect((await saveSchedule(a, a.pf, firstDates(a.r.ids))).status).toBe(200);

    const body = await expectBlocked(b, "REQUIREMENT_ROUTE_MISMATCH");
    expect(body.applicability).toMatchObject({ kind: "CONTRADICTORY", owner: "Industrial Engineering" });
    expect(body.applicability.processes.find((p) => p.process === "EMBROIDERY"))
      .toEqual({ process: "EMBROIDERY", line: "NOT_REQUIRED", route: "REQUIRED", verdict: "MISMATCH" });
  });

  test("washing: a line needing a wash the route marks NOT_APPLICABLE is a mismatch; the unwashed line is proven", async () => {
    const [washed, plain] = await twins("ApTwinWash", { WASHING: "NOT_APPLICABLE" }, [{ EMBROIDERY: "REQUIRED", WASHING: "REQUIRED" }, { EMBROIDERY: "REQUIRED" }]);
    const body = await expectBlocked(washed, "REQUIREMENT_ROUTE_MISMATCH");
    expect(body.applicability.processes.find((p) => p.process === "WASHING"))
      .toMatchObject({ line: "REQUIRED", route: "NOT_APPLICABLE", verdict: "MISMATCH" });
    expect((await getSchedule(plain, plain.pf)).body.applicability.state).toBe("PROVEN");
  });
});

/* ══ SILENCE IS NOT AN ANSWER ═════════════════════════════════════════════ */

describe("a route that never mentions a process adds no stage for it — and is never read as NOT_APPLICABLE", () => {
  test("the line needs printing the route never mentions: a mismatch owned by IE", async () => {
    const w = await world("ApOmitNeed", { routeOpts: { PRINTING: null }, statement: { EMBROIDERY: "REQUIRED", PRINTING: "REQUIRED" } });
    const body = await expectBlocked(w, "REQUIREMENT_ROUTE_MISMATCH");
    expect(body.applicability.owner).toBe("Industrial Engineering");
    expect(body.applicability.processes.find((p) => p.process === "PRINTING"))
      .toEqual({ process: "PRINTING", line: "REQUIRED", route: "NOT_DECLARED", verdict: "MISMATCH" });
  });

  test("the line needs no printing and the route never mentions it: consistent, nothing to schedule", async () => {
    const w = await world("ApOmitFine", { routeOpts: { PRINTING: null }, statement: { EMBROIDERY: "REQUIRED" } });
    const res = await getSchedule(w, w.pf);
    expect(res.body.applicability.state).toBe("PROVEN");
    expect(res.body.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING"]);
    expect(res.body.notApplicable.map((s) => s.process)).toEqual(["WASHING"]); // printing not invented
  });

  test("the comparison, directly: every combination", () => {
    const stages = route({ EMBROIDERY: "REQUIRED", PRINTING: "NOT_APPLICABLE", WASHING: null }).stages;
    const v = (processes) => Object.fromEntries(compareProcesses({ processes }, stages).map((p) => [p.process, p.verdict]));
    expect(v({ EMBROIDERY: "REQUIRED", PRINTING: "NOT_REQUIRED", WASHING: "NOT_REQUIRED" }))
      .toEqual({ EMBROIDERY: "MATCH", PRINTING: "MATCH", WASHING: "MATCH" });
    expect(v({ EMBROIDERY: "NOT_REQUIRED", PRINTING: "REQUIRED", WASHING: "REQUIRED" }))
      .toEqual({ EMBROIDERY: "MISMATCH", PRINTING: "MISMATCH", WASHING: "MISMATCH" });
    expect(v({ EMBROIDERY: "yes", PRINTING: undefined }))
      .toEqual({ EMBROIDERY: "UNPROVEN", PRINTING: "UNPROVEN", WASHING: "UNPROVEN" });
  });
});

/* ══ HISTORICAL, MISSING, CONTRADICTORY ═══════════════════════════════════ */

describe("each broken link is its own named blocker", () => {
  test("historical release with no declared route: UNKNOWN, owned by IE; nothing fabricated", async () => {
    const w = await world("ApUnknown", { processRoute: null, statement: { EMBROIDERY: "REQUIRED" } });
    const body = await expectBlocked(w, "ROUTE_UNKNOWN", { code: "PPC_ROUTE_STAGE_UNKNOWN" });
    expect(body.route.state).toBe("UNKNOWN");
    expect(body.applicability).toMatchObject({ kind: "UNKNOWN", owner: "Industrial Engineering" });
  });

  test("the frozen pack names no Sales handover version: missing", async () => {
    const w = await world("ApNoVersion");
    await setPack(w, { "contents.salesHandover.versionId": null });
    const body = await expectBlocked(w, "REQUIREMENT_VERSION_MISSING");
    expect(body.applicability.owner).toBe("Merchandising");
  });

  test("the named handover version is another line's: contradictory", async () => {
    const w = await world("ApOtherLine");
    await setHandover(w, { handoverLineRef: "LN-000000000000", "executionProjection.orderLineRef": "LN-000000000000" });
    await expectBlocked(w, "REQUIREMENT_LINE_MISMATCH");
  });

  test("Sales approved a different style than the release was engineered for", async () => {
    const w = await world("ApStyle");
    await setHandover(w, { "executionProjection.sampleStyleId": new mongoose.Types.ObjectId() });
    await expectBlocked(w, "STYLE_MISMATCH");
  });

  test("an older handover version that names no style cannot be matched to the release", async () => {
    const w = await world("ApNoStyle");
    await setHandover(w, { "executionProjection.sampleStyleId": null });
    await expectBlocked(w, "STYLE_UNPROVEN");
  });

  test("Sales cancelled the handover version the plan was built from", async () => {
    const w = await world("ApCancelled");
    await setHandover(w, { "publication.state": "CANCELLED" });
    await expectBlocked(w, "REQUIREMENT_WITHDRAWN");
  });

});

/* ══ UNREADABLE IS NOT MISSING ════════════════════════════════════════════ */

describe("a failed read", () => {
  test("the Sales handover cannot be read: UNREADABLE, 503 on save, nothing written", async () => {
    const w = await world("ApUnreadable");
    const spy = jest.spyOn(SalesHandoverVersion, "findOne").mockImplementation(() => { throw new Error("socket closed"); });
    try {
      const body = await expectBlocked(w, "SOURCE_UNREADABLE", { code: "PPC_LINE_ROUTE_UNREADABLE", status: 503 });
      expect(body.applicability.kind).toBe("UNREADABLE");
    } finally {
      spy.mockRestore();
    }
    expect((await getSchedule(w, w.pf)).body.applicability.state).toBe("PROVEN");
  });
});

/* ══ HISTORY STAYS READABLE; NOTHING RESTAMPED ════════════════════════════ */

describe("versions are preserved", () => {
  test("Sales issues a newer handover version: the saved schedule and its history stay readable, but no replan", async () => {
    const w = await world("ApSuperseded");
    expect((await saveSchedule(w, w.pf, firstDates(w.r.ids))).status).toBe(200);
    await setHandover(w, { "publication.state": "SUPERSEDED" });
    const body = await expectBlocked(w, "REQUIREMENT_SUPERSEDED");
    expect(body.applicability.owner).toBe("PPC");
    expect(body.stages.find((x) => x.process === "SEWING"))
      .toMatchObject({ plannedStart: "2026-10-01", plannedEnd: "2026-10-03" });
    expect(body.history).toHaveLength(1);
    expect(body.schedule).toMatchObject({ versionNo: 1, revision: 1 });
  });

  test("IE issues v2 for the style: the plan stays on the v1 route it froze", async () => {
    const w = await world("ApNewRelease");
    await release(w.co, w.styleId, { versionNo: 2, releaseRef: w.rel.releaseRef, processRoute: route({ EMBROIDERY: "NOT_APPLICABLE" }).stages });
    const res = await getSchedule(w, w.pf);
    expect(res.body.route).toMatchObject({ releaseRef: w.rel.releaseRef, versionNo: 1 });
    expect(res.body.applicability.state).toBe("PROVEN");
    expect(res.body.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING"]);
  });
});

/* ══ COMPANY BOUNDARY ═════════════════════════════════════════════════════ */

describe("another company's records are never evidence", () => {
  test("a pack naming another company's handover version reads as missing, and nothing of it is echoed", async () => {
    const w = await world("ApIsoA");
    const other = await company("ApIsoB");
    const foreign = await orderLine(other, { lineRef: w.lineRef, sampleStyleId: w.styleId });
    state(w.lineRef, {}); // even a statement for that lineRef cannot help
    await setPack(w, { "contents.salesHandover.versionId": foreign.currentHandoverVersionId });
    const body = await expectBlocked(w, "REQUIREMENT_VERSION_MISSING");
    expect(body.applicability.evidence.requirementVersion).toBeNull();
    expect(JSON.stringify(body)).not.toContain(String(foreign.currentHandoverVersionId));
    expect(JSON.stringify(body)).not.toContain(String(other._id));
  });

  test("another company cannot read the applicability of this plan at all", async () => {
    const w = await world("ApIsoRead");
    const other = await company("ApIsoReadB");
    const stranger = await actor({ companies: [other], grants: { ppc: "approver" } });
    const res = await ppc(`/planning-files/${w.pf}/stage-schedule`, { token: stranger.token, company: other._id });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(w.lineRef);
  });
});
