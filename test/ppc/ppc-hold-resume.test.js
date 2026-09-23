// test/ppc/ppc-hold-resume.test.js
//
// RESUMING PLANNING AFTER A HOLD — PPC's own decision, explained and recorded.
//
// The facts pinned:
//   · resuming needs a meaningful "what changed" note, and the SERVER refuses
//     without one — a client that skips its dialog cannot skip this;
//   · a refused resume changes nothing: the file stays ON_HOLD at its revision;
//   · the trail keeps the whole hold: what it was placed for (reason AND note),
//     and, on removal, the resolved hold plus the resolution;
//   · resuming restores exactly the state the hold was placed from;
//   · and it changes nothing outside PPC's planning file — no Store or
//     Merchandising status, no order, no capacity, no Production record.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const crypto = require("crypto");

const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcPlanningCommand } = require("../../models/CMS_Models/PPC/PpcPlanningCommand");
const { resolutionProblem } = require("../../services/ppc/planningFile.service");
const { server, nextKey, readyWorld } = require("./planningFixtures");

const api = server();
const ppc = (...a) => api.call(...a);

beforeAll(async () => {
  await api.start();
  await PpcPlanningFile.syncIndexes();
  await PpcPlanningCommand.syncIndexes();
});
afterAll(async () => { await api.stop(); });

const RESOLUTION = "Mill confirmed the fabric lot ships on the 3rd; planning can continue.";

const createPlan = (w) => ppc(`/order-book/${w.lineRef}/planning-file`,
  { method: "POST", token: w.planner.token, company: w.co._id, body: {}, key: nextKey() });
const command = (w, id, verb, body, who = w.approver) => ppc(`/planning-files/${id}/${verb}`,
  { method: "POST", token: who.token, company: w.co._id, body, key: nextKey() });
const history = (w, id) => ppc(`/planning-files/${id}/history?limit=50`,
  { token: w.approver.token, company: w.co._id });

/** A file walked to `to` ("PLANNING" or "PLANNED"), then held. */
async function held(w, { to = "PLANNING", reason = "AWAITING_MATERIAL", note = "Fabric lot not confirmed by the mill." } = {}) {
  const c = await createPlan(w);
  expect(c.status).toBe(201);
  const id = c.body.planningFile.planningFileId;
  let f = (await command(w, id, "planning-started", { expectedRevision: 1 }, w.planner)).body.planningFile;
  if (to === "PLANNED") f = (await command(w, id, "planned", { expectedRevision: f.revision })).body.planningFile;
  const h = await command(w, id, "hold", { expectedRevision: f.revision, reason, note });
  expect(h.status).toBe(200);
  expect(h.body.planningFile.state).toBe("ON_HOLD");
  return h.body.planningFile;
}

/** Every collection other than PPC's own planning file and command log. */
async function worldOutsidePlanning() {
  const out = {};
  const cols = await mongoose.connection.db.listCollections().toArray();
  for (const { name } of cols) {
    if (["ppc_planning_files", "ppc_planning_commands"].includes(name) || name.startsWith("system.")) continue;
    const docs = await mongoose.connection.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = crypto.createHash("sha256").update(JSON.stringify(docs)).digest("hex");
  }
  return out;
}

describe("resuming needs a meaningful resolution, enforced by the server", () => {
  test("the rule itself: blank, short and filler notes are not explanations", () => {
    expect(resolutionProblem("")).toMatch(/Say what changed/);
    expect(resolutionProblem("   ")).toMatch(/Say what changed/);
    expect(resolutionProblem("ok fine")).toMatch(/at least 10 characters/);
    expect(resolutionProblem("..............")).toMatch(/in words/);
    expect(resolutionProblem("aaaaaaaaaaaaaaa")).toMatch(/in words/);
    expect(resolutionProblem(RESOLUTION)).toBeNull();
  });

  test("a resume without a note, or with a filler one, is refused — and changes nothing", async () => {
    const w = await readyWorld("ResumeRequired");
    const f = await held(w);
    for (const body of [{}, { note: "" }, { note: "   " }, { note: "done" }, { note: ".........." }]) {
      const res = await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, ...body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("PPC_HOLD_RESOLUTION_REQUIRED");
    }
    const doc = await PpcPlanningFile.findById(f.planningFileId).lean();
    expect(doc.state).toBe("ON_HOLD");
    expect(doc.revision).toBe(f.revision);
    expect(doc.holdReason).toBe("AWAITING_MATERIAL");
    expect(doc.holdNote).toBe("Fabric lot not confirmed by the mill.");
    expect(doc.history.some((e) => e.type === "HOLD_REMOVED")).toBe(false);
  });

  test("a planner still cannot resume — only an approver decides", async () => {
    const w = await readyWorld("ResumeApprover");
    const f = await held(w);
    const res = await command(w, f.planningFileId, "hold/remove",
      { expectedRevision: f.revision, note: RESOLUTION }, w.planner);
    expect(res.status).toBe(403);
  });
});

describe("resuming restores exactly the state the hold was placed from", () => {
  test("held from PLANNING → PLANNING", async () => {
    const w = await readyWorld("ResumePlanning");
    const f = await held(w, { to: "PLANNING" });
    const res = await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, note: RESOLUTION });
    expect(res.status).toBe(200);
    expect(res.body.planningFile.state).toBe("PLANNING");
    expect(res.body.planningFile.holdReason).toBeNull();
    expect(res.body.planningFile.stateBeforeHold).toBeNull();
  });

  test("held from PLANNED → PLANNED, with the approved plan untouched", async () => {
    const w = await readyWorld("ResumePlanned");
    const f = await held(w, { to: "PLANNED" });
    const before = await PpcPlanningFile.findById(f.planningFileId).lean();
    const res = await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, note: RESOLUTION });
    expect(res.status).toBe(200);
    expect(res.body.planningFile.state).toBe("PLANNED");
    const after = await PpcPlanningFile.findById(f.planningFileId).lean();
    expect(after.planning).toEqual(before.planning);
    expect(after.sourceBasis).toEqual(before.sourceBasis);
    expect(after.plannedAt).toEqual(before.plannedAt);
  });
});

describe("the hold's whole story is kept in the history", () => {
  test("placed: reason and note; removed: the resolution and the resolved hold", async () => {
    const w = await readyWorld("ResumeHistory");
    const f = await held(w, { reason: "AWAITING_MATERIAL", note: "Fabric lot not confirmed by the mill." });
    await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, note: `  ${RESOLUTION}  ` });

    const h = await history(w, f.planningFileId);
    expect(h.status).toBe(200);
    const placed = h.body.events.find((e) => e.type === "HOLD_PLACED");
    const removed = h.body.events.find((e) => e.type === "HOLD_REMOVED");

    expect(placed.hold).toMatchObject({ reason: "AWAITING_MATERIAL", note: "Fabric lot not confirmed by the mill.", stateBeforeHold: "PLANNING" });

    expect(removed.reason).toBe(RESOLUTION); // the resolution, trimmed
    expect(removed.fromState).toBe("ON_HOLD");
    expect(removed.toState).toBe("PLANNING");
    expect(removed.hold).toMatchObject({
      reason: "AWAITING_MATERIAL",
      note: "Fabric lot not confirmed by the mill.",
      stateBeforeHold: "PLANNING",
    });
    expect(removed.hold.heldAt).toEqual(expect.any(String));
    expect(removed.hold.heldByName).toBeTruthy();
    expect(removed.actorName).toBeTruthy();
  });

  test("a second hold and resume keeps the first one's record too", async () => {
    const w = await readyWorld("ResumeTwice");
    const f = await held(w, { reason: "AWAITING_BUYER", note: "Buyer to confirm colourway split." });
    const r1 = await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, note: "Buyer confirmed the split by email." });
    const h2 = await command(w, f.planningFileId, "hold",
      { expectedRevision: r1.body.planningFile.revision, reason: "AWAITING_MATERIAL", note: "Trims delayed at port." });
    await command(w, f.planningFileId, "hold/remove",
      { expectedRevision: h2.body.planningFile.revision, note: "Trims cleared customs this morning." });
    const events = (await history(w, f.planningFileId)).body.events.filter((e) => e.type === "HOLD_REMOVED");
    expect(events.map((e) => e.hold.note).sort()).toEqual(["Buyer to confirm colourway split.", "Trims delayed at port."]);
    expect(events.map((e) => e.reason).sort()).toEqual(["Buyer confirmed the split by email.", "Trims cleared customs this morning."]);
  });
});

describe("resuming changes nothing outside PPC's planning file", () => {
  test("no Store, Merchandising, order, capacity or Production record moves", async () => {
    const w = await readyWorld("ResumeNoCrossApp");
    const f = await held(w);
    const before = await worldOutsidePlanning();
    const res = await command(w, f.planningFileId, "hold/remove", { expectedRevision: f.revision, note: RESOLUTION });
    expect(res.status).toBe(200);
    const after = await worldOutsidePlanning();
    expect(after).toEqual(before);
    /* And the reply says so on its face. */
    expect(res.body.planningFile.booksCapacity).toBe(false);
    expect(res.body.planningFile.releasesProduction).toBe(false);
  });
});
