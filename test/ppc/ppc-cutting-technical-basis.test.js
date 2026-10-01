// test/ppc/ppc-cutting-technical-basis.test.js
//
// IE STATES HOW MUCH CUTTING WORK A PIECE IS; PPC MULTIPLIES IT BY THE ORDER.
//
// The first slice of resource-based planning, and deliberately the smallest:
// a typed technical standard, authored and approved in Industrial Engineering,
// frozen into the release, and projected read-only into PPC as a workload.
//
// ── THE ONE CALCULATION ─────────────────────────────────────────────────────
//     workloadMinutes = setupMinutesPerOrder + quantity × standardMinutesPerPiece
//
// Both minute figures are IE's. The quantity is Sales'. PPC contributes the
// multiplication and nothing else — and this suite asserts that at every turn,
// because a planning system that can quietly supply its own engineering figure
// is one nobody can audit.
//
// ── WHAT IS NOT IN THIS SLICE ───────────────────────────────────────────────
// No tables, knives, operators, shifts, calendars, bookings or availability.
// A workload is how much work there is, not how much of it fits in a day.
//
// Pinned:
//   · IE authors and approves a valid cutting standard, and it is frozen in v1;
//   · editing the draft afterwards changes neither v1 nor a plan frozen to it;
//   · PPC calculates the workload from the confirmed quantity;
//   · missing, malformed, zero and negative standards block cutting dates AND
//     cutting publication, by name;
//   · the garment SAM cannot stand in for a cutting SAM;
//   · another company's release is unreadable here;
//   · PPC cannot author, edit, override or approve a standard;
//   · NOT_APPLICABLE cutting needs no standard and reports none missing.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");

const fx = require("./planningFixtures");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const { PpcPlanningFile } = require("../../models/CMS_Models/PPC/PpcPlanningFile");
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");

const routes = require("../../services/industrialEngineering/ieProcessRoute.service");
const releasePublication = require("../../services/industrialEngineering/releasePublication.service");
const basis = require("../../services/ppc/cuttingTechnicalBasis.service");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcStageSchedule, PpcStagePublication]) await m.syncIndexes();
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
const QUANTITY = 500;

/* IE's approved standard as a RELEASE carries it: 0.8 min a piece, 45 min to
   set the order up, with the server-recorded `declaredAt`/`declaredByName`. */
const STANDARD = () => fx.cuttingStandard();

/* The same standard as a PERSON sends it, through IE's route. Deliberately a
   different shape: who stated it and when are the server's to record, and the
   route refuses them from a client — which the last test in this file pins. */
const CLIENT_STANDARD = (over = {}) => {
  const { declaredAt, declaredByName, resourceLabel, ...rest } = fx.cuttingStandard();
  return { ...rest, ...over };
};

const evidence = { kind: "BUYER_PO", buyerApprovalRef: "q1", documentRef: "grav/po/1", poNumber: "PO-1" };
const statement = () => ({ statedAt: new Date(), processes: [
  { process: "EMBROIDERY", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "PRINTING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
  { process: "WASHING", requirement: "NOT_REQUIRED", buyerSpecification: "PO: none", evidence },
] });

/** A route whose cutting stage carries `standard` (or none), plus sewing. */
function route({ standard = STANDARD(), cutting = "REQUIRED" } = {}) {
  const ids = { cut: sid(), sew: sid() };
  return { ids, stages: [
    { stageId: ids.cut, sequence: 1, process: "CUTTING", label: "Cutting", applicability: cutting,
      predecessorStageIds: [], ...(standard ? { technicalStandard: standard } : {}) },
    { stageId: ids.sew, sequence: 2, process: "SEWING", label: "Sewing", applicability: "REQUIRED",
      predecessorStageIds: cutting === "REQUIRED" ? [ids.cut] : [] },
  ] };
}

/** One company, one confirmed line, one plan frozen to a release. */
async function world(label, { standard = STANDARD(), cutting = "REQUIRED", quantity = QUANTITY } = {}) {
  const co = await fx.company(label);
  const r = route({ standard, cutting });
  const styleId = new mongoose.Types.ObjectId();
  const rel = await fx.release(co, styleId, { processRoute: r.stages });
  const file = await fx.orderLine(co, {
    lineRef: `LN-${crypto.randomBytes(6).toString("hex")}`, sampleStyleId: styleId,
    processRequirements: statement(), quantity,
  });
  await fx.pack(co, file);
  await fx.minutes(co, file);

  const planner = await fx.actor({ companies: [co], grants: { ppc: "editor" } });
  const created = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: fx.nextKey() });
  expect(created.status).toBe(201);

  const w = {
    co, file, r, styleId, quantity, planner, rel: rel.release,
    planId: created.body.planningFile.planningFileId, lineRef: file.handoverLineRef,
  };
  w.schedule = () => call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
    { token: planner.token, company: co._id });
  w.setDates = (stageId, expectedRevision = 0, extra = {}) =>
    call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
      { token: planner.token, company: co._id, method: "POST", key: fx.nextKey(),
        body: { expectedRevision, stages: [{ stageId, plannedStart: "2026-10-05", plannedEnd: "2026-10-07" }], ...extra } });
  w.publish = (stageId, expectedScheduleVersion = 1) =>
    call(`${PPC}/planning-files/${w.planId}/stage-schedule/publish`,
      { token: planner.token, company: co._id, method: "POST", key: fx.nextKey(),
        body: { stageId, expectedScheduleVersion } });
  return w;
}

const cutStage = async (w) => (await w.schedule()).body.stages.find((s) => s.process === "CUTTING");

/* ══ 1–3 · IE AUTHORS IT, THE RELEASE FREEZES IT ══════════════════════════ */

describe("IE authors and approves the standard; the release freezes it", () => {
  test("a valid standard is shaped, stored and published with its units intact", () => {
    const shaped = routes.shapeRoute([{
      process: "CUTTING", applicability: "REQUIRED", label: "Cutting",
      technicalStandard: {
        kind: "CUTTING_SAM",
        standardMinutesPerPiece: 0.8, standardUnit: "MINUTES_PER_PIECE",
        setupMinutesPerOrder: 45, setupUnit: "MINUTES_PER_ORDER",
        resourceType: "STRAIGHT_KNIFE",
        basis: "24-ply lay, 1.6m marker, cotton jersey.",
        source: { method: "TIME_STUDY", reference: "TS-2026-014" },
        capacityModel: {
          timeBasis: "LABOUR_MINUTES", standardCrewSize: 3, minimumCrewSize: 2,
          maximumUsefulCrewSize: 4, scalingMethod: "CAPPED_LINEAR",
          standardEfficiencyPercent: 80,
          requiredRoles: [{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }],
        },
      },
    }], { existingIds: new Set(), actor: { name: "Ravi (IE)" } });

    const std = shaped[0].technicalStandard;
    expect(std).toMatchObject({
      kind: "CUTTING_SAM",
      standardMinutesPerPiece: 0.8, standardUnit: "MINUTES_PER_PIECE",
      setupMinutesPerOrder: 45, setupUnit: "MINUTES_PER_ORDER",
      resourceType: "STRAIGHT_KNIFE",
      basis: "24-ply lay, 1.6m marker, cotton jersey.",
      source: { method: "TIME_STUDY", reference: "TS-2026-014" },
    });
    /* And what those minutes assume about people, stored as declared. */
    expect(std.capacityModel).toEqual({
      timeBasis: "LABOUR_MINUTES", standardCrewSize: 3, minimumCrewSize: 2,
      maximumUsefulCrewSize: 4, scalingMethod: "CAPPED_LINEAR", standardEfficiencyPercent: 80,
      requiredRoles: [{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }],
    });
    /* Server-recorded, not client-supplied. */
    expect(std.declaredByName).toBe("Ravi (IE)");
    expect(std.declaredAt).toBeInstanceOf(Date);
  });

  test("the exact standard is frozen in release v1 and published read-only", async () => {
    const w = await world("cut-frozen");
    const published = await releasePublication.publishReleaseProcessRoute(
      { companyId: String(w.co._id) }, String(w.rel._id));
    expect(published.versionNo).toBe(1);
    const cut = published.stages.find((s) => s.process === "CUTTING");
    expect(cut.technicalStandard).toMatchObject({
      kind: "CUTTING_SAM", standardMinutesPerPiece: 0.8, setupMinutesPerOrder: 45,
      standardUnit: "MINUTES_PER_PIECE", setupUnit: "MINUTES_PER_ORDER",
      resourceType: "STRAIGHT_KNIFE",
    });
    /* And the sewing stage carries none — this slice states cutting's work. */
    expect(published.stages.find((s) => s.process === "SEWING").technicalStandard).toBeNull();
  });

  test("a later release with a different standard does not move a plan frozen to v1", async () => {
    const w = await world("cut-v2");
    const before = await cutStage(w);
    expect(before.technicalBasis.workloadMinutes).toBe(445);   // 45 + 500 × 0.8

    /* IE re-measures and issues v2 of the same style: twice the minutes. */
    const v2 = await fx.release(w.co, w.styleId, {
      versionNo: 2,
      processRoute: route({ standard: { ...STANDARD(), standardMinutesPerPiece: 1.6 } }).stages,
    });
    expect(String(v2.release._id)).not.toBe(String(w.rel._id));

    /* The plan is frozen to v1 and keeps v1's figures. A newer release is
       never read for a plan that did not freeze it. */
    const after = await cutStage(w);
    expect(after.technicalBasis.workloadMinutes).toBe(445);
    expect(after.technicalBasis.standard.standardMinutesPerPiece).toBe(0.8);
    expect(after.technicalBasis.ieReleaseVersionNo).toBe(1);
    expect(String(after.technicalBasis.ieReleaseId)).toBe(String(w.rel._id));
  });
});

/* ══ 4 · PPC CALCULATES THE WORKLOAD ══════════════════════════════════════ */

describe("PPC multiplies IE's standard by Sales' quantity", () => {
  test("the workload, its inputs and their provenance are all projected", async () => {
    const w = await world("cut-workload");
    const cut = await cutStage(w);
    const b = cut.technicalBasis;

    expect(b.state).toBe("SCHEDULABLE");
    expect(b.schedulable).toBe(true);
    expect(b.blocker).toBeNull();
    expect(b.quantity).toBe(QUANTITY);
    expect(b.standard.standardMinutesPerPiece).toBe(0.8);
    expect(b.standard.setupMinutesPerOrder).toBe(45);
    expect(b.workloadMinutes).toBe(45 + (500 * 0.8));
    expect(b.workloadFormula).toBe("setupMinutesPerOrder + quantity × standardMinutesPerPiece");
    /* The resource TYPE, and its assumptions, so a planner can judge it. */
    expect(b.standard.resourceType).toBe("STRAIGHT_KNIFE");
    expect(b.standard.basis).toMatch(/24-ply/);
    expect(b.standard.source).toEqual({ method: "TIME_STUDY", reference: "TS-2026-014" });
    /* And whose it is. */
    expect(b.ownedBy).toBe("INDUSTRIAL_ENGINEERING");
    expect(b.editableByPpc).toBe(false);
    expect(b.booksCapacity).toBe(false);
    expect(b.ieReleaseVersionNo).toBe(1);
  });

  test("a different confirmed quantity gives a different workload, from the same standard", async () => {
    const small = await world("cut-qty-small", { quantity: 100 });
    const large = await world("cut-qty-large", { quantity: 2000 });
    expect((await cutStage(small)).technicalBasis.workloadMinutes).toBe(45 + (100 * 0.8));
    expect((await cutStage(large)).technicalBasis.workloadMinutes).toBe(45 + (2000 * 0.8));
  });

  test("a schedulable stage is ready for a capacity reservation, not for typing", async () => {
    const w = await world("cut-schedulable");
    /* The basis is complete, so the standard is no longer what stops this
       stage. Its dates still come from a reservation — typing is refused
       whatever the standard says. */
    expect((await cutStage(w)).technicalBasis.state).toBe("SCHEDULABLE");
    const typed = await w.setDates(w.r.ids.cut);
    expect(typed.status).toBe(409);
    expect(typed.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    /* What a schedulable basis DOES unlock — a bookable preview and a
       publication that stands on the booking — is pinned end to end in
       test/ppc/ppc-cutting-capacity-booking.test.js. */
  });
});

/* ══ 5–6 · WHAT BLOCKS, AND WHAT MAY NOT SUBSTITUTE ═══════════════════════ */

describe("a stage whose work is not stated cannot be dated", () => {
  const cases = [
    ["missing", null, "PPC_CUTTING_STANDARD_MISSING"],
    ["zero minutes", { ...STANDARD(), standardMinutesPerPiece: 0 }, "PPC_CUTTING_STANDARD_UNREADABLE"],
    ["negative minutes", { ...STANDARD(), standardMinutesPerPiece: -0.5 }, "PPC_CUTTING_STANDARD_UNREADABLE"],
    ["negative setup", { ...STANDARD(), setupMinutesPerOrder: -10 }, "PPC_CUTTING_STANDARD_UNREADABLE"],
    ["unknown kind", { ...STANDARD(), kind: "SEWING_SAM" }, "PPC_CUTTING_STANDARD_UNREADABLE"],
    ["unknown unit", { ...STANDARD(), standardUnit: "SECONDS_PER_PIECE" }, "PPC_CUTTING_STANDARD_UNREADABLE"],
    ["no resource type", { ...STANDARD(), resourceType: "" }, "PPC_CUTTING_STANDARD_UNREADABLE"],
  ];

  test.each(cases)("%s: the stage stays visible, and says what IE must publish", async (name, standard, code) => {
    const w = await world(`cut-bad-${name.replace(/\s+/g, "-")}`, { standard });

    /* The stage is STILL THERE — a planner must see what is blocked. */
    const cut = await cutStage(w);
    expect(cut).toBeTruthy();
    expect(cut.process).toBe("CUTTING");
    expect(cut.technicalBasis.state).toBe(code);
    expect(cut.technicalBasis.blocker).toBe(code);
    expect(cut.technicalBasis.schedulable).toBe(false);
    expect(cut.technicalBasis.workloadMinutes).toBeNull();
    /* And it says whose job it is to fix. */
    expect(cut.technicalBasis.message).toMatch(/Industrial Engineering|cannot be read/);
    expect(cut.technicalBasis.message).toMatch(/Planning cannot/);

    /* Nothing can be scheduled for it, and nothing is saved. The refusal a
       planner meets first is that cutting is never typed — which is true
       whatever the standard says. That the STANDARD itself also stops a
       capacity reservation is pinned in the booking suite, where the
       reservation is the act being refused. */
    const dated = await w.setDates(w.r.ids.cut);
    expect(dated.status).toBe(409);
    expect(dated.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    expect(await PpcStageSchedule.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("publication is refused while the standard is unreadable", async () => {
    /* A cutting stage with no readable standard cannot be published, whether
       or not it ever had dates. (Publication standing on the RESERVATION its
       dates came from is pinned in the booking suite.) */
    const w = await world("cut-publish-block");
    await IeRelease.collection.updateOne({ _id: w.rel._id },
      { $unset: { "source.processRoute.stages.0.technicalStandard": "" } });

    const out = await w.publish(w.r.ids.cut);
    expect(out.status).toBe(409);
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("the garment SAM is not a cutting SAM, and cannot stand in for one", async () => {
    const w = await world("cut-garment-sam", { standard: null });
    /* The release carries a garment SAM — 4.5 minutes, from the fixture — and
       it is sewing's whole-garment figure, not cutting's. */
    const rel = await IeRelease.findById(w.rel._id).lean();
    expect(rel.source.garmentSamMinutes).toBe(4.5);

    const b = (await cutStage(w)).technicalBasis;
    expect(b.state).toBe("PPC_CUTTING_STANDARD_MISSING");
    expect(b.workloadMinutes).toBeNull();
    /* Nothing anywhere in the answer took the garment figure. */
    expect(JSON.stringify(b)).not.toContain("4.5");
  });

  test("a sewing stage's presence does not satisfy cutting", async () => {
    const w = await world("cut-sewing-present", { standard: null });
    const stages = (await w.schedule()).body.stages;
    expect(stages.find((s) => s.process === "SEWING")).toBeTruthy();
    expect((await cutStage(w)).technicalBasis.blocker).toBe("PPC_CUTTING_STANDARD_MISSING");
  });
});

/* ══ 7–9 · BOUNDARIES ═════════════════════════════════════════════════════ */

describe("ownership and scope", () => {
  test("another company's release cannot be read for its standard", async () => {
    const mine = await world("cut-mine");
    const theirs = await world("cut-theirs");
    const seen = await releasePublication.publishReleaseProcessRoute(
      { companyId: String(mine.co._id) }, String(theirs.rel._id));
    expect(seen).toBeNull();

    /* And my own plan's basis mentions nothing of theirs. */
    const dump = JSON.stringify((await cutStage(mine)).technicalBasis);
    expect(dump).not.toContain(String(theirs.rel._id));
    expect(dump).not.toContain(theirs.rel.releaseRef);
  });

  test("PPC cannot submit, edit or override a technical standard", async () => {
    const w = await world("cut-ppc-cannot");
    /* Every shape a planner might reach for, on PPC's own schedule door. */
    for (const extra of [
      { technicalStandard: STANDARD() },
      { standardMinutesPerPiece: 0.1 },
      { workloadMinutes: 10 },
      { setupMinutesPerOrder: 0 },
    ]) {
      const res = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
        { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
          body: { expectedRevision: 0,
            stages: [{ stageId: w.r.ids.cut, plannedStart: "2026-10-05", plannedEnd: "2026-10-07" }],
            ...extra } });
      expect([Object.keys(extra)[0], res.status]).toEqual([Object.keys(extra)[0], 400]);
    }
    /* The release's standard is untouched by every one of those attempts. */
    const rel = await IeRelease.findById(w.rel._id).lean();
    expect(rel.source.processRoute.stages[0].technicalStandard.standardMinutesPerPiece).toBe(0.8);
    /* There is no PPC route that writes one. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/PPC/orderBookRoute.js"), "utf8");
    expect(src).not.toMatch(/technicalStandard/);
  });

  test("a NOT_APPLICABLE cutting stage needs no standard and reports none missing", async () => {
    const w = await world("cut-na", { standard: null, cutting: "NOT_APPLICABLE" });
    const body = (await w.schedule()).body;

    /* It is not a required stage, so it is not in the schedulable list… */
    expect(body.stages.find((s) => s.process === "CUTTING")).toBeUndefined();
    /* …and nothing is reported as a missing standard. */
    expect(JSON.stringify(body)).not.toContain("PPC_CUTTING_STANDARD_MISSING");

    /* Asked directly, the basis says the stage does not apply — which is not
       the same answer as "IE has not published one". */
    const direct = basis.cuttingBasis({
      stage: { stageId: w.r.ids.cut, process: "CUTTING", applicability: "NOT_APPLICABLE" },
      release: { releaseId: String(w.rel._id), versionNo: 1 },
      quantity: QUANTITY,
    });
    expect(direct.state).toBe("NOT_APPLICABLE");
    expect(direct.blocker).toBeNull();
    expect(basis.blocksScheduling(direct)).toBe(false);

    /* And sewing still plans normally. */
    expect((await w.setDates(w.r.ids.sew)).status).toBe(200);
  });

  test("IE refuses a standard on a stage that may not carry one", () => {
    /* Not applicable: there is no work to state. */
    expect(() => routes.shapeRoute([{
      process: "CUTTING", applicability: "NOT_APPLICABLE", technicalStandard: CLIENT_STANDARD(),
    }], { existingIds: new Set() })).toThrow(/NOT_APPLICABLE carries no technical standard/);

    /* And a process this contract states no standard kind for. */
    expect(() => routes.shapeRoute([{
      process: "SEWING", applicability: "REQUIRED", technicalStandard: CLIENT_STANDARD(),
    }], { existingIds: new Set() })).toThrow(/carries no technical standard/);

    /* A garment or sewing SAM smuggled onto the standard is refused by name. */
    for (const [field, pattern] of [
      ["garmentSamMinutes", /garment SAM/],
      ["sewingSamMinutes", /sewing SAM/],
      ["sam", /untyped SAM/],
      ["workloadMinutes", /workload, which Planning calculates/],
      ["operatorCount", /headcount, which Cutting owns/],
      ["machineId", /specific machine/],
    ]) {
      expect(() => routes.shapeRoute([{
        process: "CUTTING", applicability: "REQUIRED",
        technicalStandard: CLIENT_STANDARD({ [field]: 1 }),
      }], { existingIds: new Set() })).toThrow(pattern);
    }

    /* And who stated it, and when, are the server's — not a client's. */
    for (const field of ["declaredAt", "declaredByName"]) {
      expect(() => routes.shapeRoute([{
        process: "CUTTING", applicability: "REQUIRED",
        technicalStandard: CLIENT_STANDARD({ [field]: "x" }),
      }], { existingIds: new Set() })).toThrow(/the server records that/);
    }
  });
});

/* ══ CREW AND SCALING SEMANTICS ═══════════════════════════════════════════ */

const CM = (over = {}) => ({ ...fx.cuttingStandard().capacityModel, ...over });
const withCM = (over) => ({ ...STANDARD(), capacityModel: CM(over) });

describe("what a minute means, and whether more people help", () => {
  test("a three-person LABOUR_MINUTES standard is frozen and projected as labour content", async () => {
    const w = await world("crew-labour", { standard: withCM({
      timeBasis: "LABOUR_MINUTES", scalingMethod: "CAPPED_LINEAR",
      standardCrewSize: 3, minimumCrewSize: 2, maximumUsefulCrewSize: 4,
    }) });
    const b = (await cutStage(w)).technicalBasis;

    expect(b.state).toBe("SCHEDULABLE");
    expect(b.workloadTimeBasis).toBe("LABOUR_MINUTES");
    expect(b.standard.capacityModel).toMatchObject({
      timeBasis: "LABOUR_MINUTES", standardCrewSize: 3, minimumCrewSize: 2,
      maximumUsefulCrewSize: 4, scalingMethod: "CAPPED_LINEAR",
      standardEfficiencyPercent: 80, scalesWithCrew: true,
    });
    expect(b.standard.capacityModel.requiredRoles)
      .toEqual([{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }]);
    /* The sentence that stops it being misread. */
    expect(b.standard.capacityModel.meaning).toMatch(/Labour content/);
    expect(b.standard.capacityModel.meaning).toMatch(/available person-minutes/);
    /* The workload is still the same arithmetic, now with its basis named. */
    expect(b.workloadMinutes).toBe(445);
    /* And it is explicitly not a date. */
    expect(b.schedulesResources).toBe(false);
    expect(b.resourcePlanningNote).toMatch(/crew, machine or table, shift minutes and availability/);
  });

  test("a three-person FIXED_TEAM standard reads as elapsed time, not labour", async () => {
    const w = await world("crew-fixed", { standard: withCM({
      timeBasis: "TEAM_ELAPSED_MINUTES", scalingMethod: "FIXED_TEAM",
      standardCrewSize: 3, minimumCrewSize: 3, maximumUsefulCrewSize: 3,
    }) });
    const b = (await cutStage(w)).technicalBasis;

    expect(b.workloadTimeBasis).toBe("TEAM_ELAPSED_MINUTES");
    expect(b.standard.capacityModel.scalesWithCrew).toBe(false);
    expect(b.standard.capacityModel.meaning)
      .toMatch(/Elapsed time for the approved crew of 3/);
    expect(b.standard.capacityModel.meaning).toMatch(/must NOT be multiplied or divided by headcount/);

    /* The same 445 minutes mean something entirely different from the labour
       case above — which is the whole reason the basis is declared. */
    const labour = await world("crew-fixed-vs-labour");
    expect((await cutStage(labour)).technicalBasis.workloadMinutes).toBe(b.workloadMinutes);
    expect((await cutStage(labour)).technicalBasis.workloadTimeBasis).toBe("LABOUR_MINUTES");
  });

  test("under FIXED_TEAM, adding people buys nothing", () => {
    const cm = CM({ scalingMethod: "FIXED_TEAM", standardCrewSize: 3, minimumCrewSize: 3, maximumUsefulCrewSize: 3 });
    /* The approved crew is usable; a fourth and a tenth person are not. */
    expect(basis.effectiveCrew(cm, 3)).toMatchObject({ usable: 3, scales: false });
    for (const n of [4, 6, 10]) {
      expect(basis.effectiveCrew(cm, n)).toMatchObject({
        usable: 3, reason: "FIXED_TEAM_EXTRA_PEOPLE_DO_NOT_HELP", scales: false,
      });
    }
    /* And below the crew it was measured on, the standard does not apply —
       it is not a slower version of itself. */
    expect(basis.effectiveCrew(cm, 2)).toMatchObject({ usable: null, reason: "BELOW_MINIMUM_CREW" });
  });

  test("CAPPED_LINEAR scales to its cap and no further; LINEAR claims nothing beyond it", () => {
    const capped = CM({ scalingMethod: "CAPPED_LINEAR", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 });
    expect(basis.effectiveCrew(capped, 2)).toMatchObject({ usable: 2, reason: "WITHIN_VALIDATED_RANGE" });
    expect(basis.effectiveCrew(capped, 4)).toMatchObject({ usable: 4, reason: "WITHIN_VALIDATED_RANGE" });
    for (const n of [5, 9]) {
      expect(basis.effectiveCrew(capped, n)).toMatchObject({
        usable: 4, reason: "CAPPED_AT_MAXIMUM_USEFUL_CREW", maximumUsefulCrewSize: 4,
      });
    }

    /* LINEAR above its validated maximum returns NO number: IE measured to
       four and said nothing about five, and "not measured" is not "no
       further benefit". */
    const linear = CM({ scalingMethod: "LINEAR", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 });
    expect(basis.effectiveCrew(linear, 4)).toMatchObject({ usable: 4 });
    expect(basis.effectiveCrew(linear, 5)).toMatchObject({
      usable: null, reason: "ABOVE_VALIDATED_CREW", maximumUsefulCrewSize: 4,
    });
  });
});

describe("capacity semantics that cannot be trusted are not planned from", () => {
  const broken = [
    ["no capacity model", { ...STANDARD(), capacityModel: undefined }, "capacityModel"],
    ["unknown time basis", withCM({ timeBasis: "HOURS" }), "capacityModel.timeBasis"],
    ["unknown scaling method", withCM({ scalingMethod: "ELASTIC" }), "capacityModel.scalingMethod"],
    ["minimum above standard", withCM({ minimumCrewSize: 4, standardCrewSize: 3, maximumUsefulCrewSize: 4 }), "capacityModel.crewRange"],
    ["maximum below standard", withCM({ minimumCrewSize: 1, standardCrewSize: 3, maximumUsefulCrewSize: 2 }), "capacityModel.crewRange"],
    ["fixed team with a range", withCM({ scalingMethod: "FIXED_TEAM", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 }), "capacityModel.scalingMethod"],
    ["fractional crew", withCM({ standardCrewSize: 2.5 }), "capacityModel.standardCrewSize"],
    ["zero efficiency", withCM({ standardEfficiencyPercent: 0 }), "capacityModel.standardEfficiencyPercent"],
    ["absurd efficiency", withCM({ standardEfficiencyPercent: 4000 }), "capacityModel.standardEfficiencyPercent"],
    ["no roles", withCM({ requiredRoles: [] }), "capacityModel.requiredRoles"],
    ["unknown role", withCM({ requiredRoles: [{ role: "PILOT", count: 1 }] }), "capacityModel.requiredRoles"],
    ["zero-count role", withCM({ requiredRoles: [{ role: "CUTTER", count: 0 }] }), "capacityModel.requiredRoles"],
    ["roles exceed the crew", withCM({ standardCrewSize: 3, requiredRoles: [{ role: "CUTTER", count: 3 }, { role: "BUNDLER", count: 2 }] }), "capacityModel.requiredRoles"],
  ];

  test.each(broken)("%s blocks scheduling and publication", async (name, standard, field) => {
    const w = await world(`crew-bad-${name.replace(/\s+/g, "-")}`, { standard });
    const cut = await cutStage(w);

    expect(cut.technicalBasis.state).toBe("PPC_CUTTING_STANDARD_UNREADABLE");
    expect(cut.technicalBasis.detail).toEqual({ field });
    expect(cut.technicalBasis.workloadMinutes).toBeNull();

    /* Nothing can be scheduled for it. Cutting is never typed — which is the
       refusal a planner meets first — and the unreadable standard also stops
       a capacity reservation, which the booking suite pins. */
    const dated = await w.setDates(w.r.ids.cut);
    expect(dated.status).toBe(409);
    expect(dated.body.error.code).toBe("PPC_CUTTING_DATES_NOT_TYPED");
    expect(await PpcStageSchedule.countDocuments({ companyId: w.co._id })).toBe(0);

    /* And nothing can be published: this plan has no schedule at all,
       because neither a typed date nor a reservation could produce one. */
    const out = await w.publish(w.r.ids.cut);
    expect(out.status).toBe(409);
    expect(out.body.error.details.reason).toBe("NOT_SCHEDULED");
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("IE refuses the same contradictions at authoring, by name", () => {
    /* Every problem is named, and they are collected rather than reported one
       at a time — so the refusal is read off the field errors, which is what
       an editor shows beside the field. */
    const refusalFor = (capacityModel) => {
      try {
        routes.shapeRoute([{
          process: "CUTTING", applicability: "REQUIRED",
          technicalStandard: { ...CLIENT_STANDARD(), capacityModel },
        }], { existingIds: new Set() });
      } catch (err) {
        return (err.details?.fieldErrors || []).map((f) => `${f.field}: ${f.message}`).join(" | ")
          || err.message;
      }
      throw new Error("That capacity model should have been refused.");
    };

    /* The range must contain its own standard. */
    expect(refusalFor(CM({ minimumCrewSize: 4, standardCrewSize: 3 })))
      .toMatch(/minimum crew cannot exceed the standard crew/);
    expect(refusalFor(CM({ standardCrewSize: 3, maximumUsefulCrewSize: 2 })))
      .toMatch(/maximum useful crew cannot be below the standard crew/);
    /* A fixed team has no range — a range would later read as permission. */
    expect(refusalFor(CM({ scalingMethod: "FIXED_TEAM", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 })))
      .toMatch(/FIXED_TEAM standard is for one exact crew/);
    /* And a cap equal to the floor is a fixed team in the wrong word. */
    expect(refusalFor(CM({ scalingMethod: "CAPPED_LINEAR", minimumCrewSize: 3, standardCrewSize: 3, maximumUsefulCrewSize: 3 })))
      .toMatch(/should say so/);
    /* Roles must fit the crew they describe. */
    expect(refusalFor(CM({ standardCrewSize: 3, requiredRoles: [{ role: "CUTTER", count: 4 }] })))
      .toMatch(/add up to 4 people but the standard crew is 3/);
    /* Unknown vocabulary, and figures that are not whole people. */
    expect(refusalFor(CM({ timeBasis: "HOURS" }))).toMatch(/Say what a minute here is/);
    expect(refusalFor(CM({ scalingMethod: "ELASTIC" }))).toMatch(/Say whether more people help/);
    expect(refusalFor(CM({ standardCrewSize: 2.5 }))).toMatch(/whole number of people/);
    expect(refusalFor(CM({ standardEfficiencyPercent: 0 }))).toMatch(/efficiency this figure already assumes/);
    expect(refusalFor(CM({ requiredRoles: [{ role: "PILOT", count: 1 }] }))).toMatch(/Choose a role/);
    /* A missing model is refused outright — there is no default meaning. */
    expect(refusalFor(undefined)).toMatch(/Say what these minutes assume about people/);
  });

  test("a second clock for setup is refused: every figure shares one basis", () => {
    expect(() => routes.shapeRoute([{
      process: "CUTTING", applicability: "REQUIRED",
      technicalStandard: { ...CLIENT_STANDARD(), capacityModel: CM({ setupTimeBasis: "LABOUR_MINUTES" }) },
    }], { existingIds: new Set() })).toThrow(/second time basis for setup/);

    /* And the projection states the one basis for the whole workload. */
    const b = basis.cuttingBasis({
      stage: { stageId: "s", process: "CUTTING", applicability: "REQUIRED",
        technicalStandard: withCM({ timeBasis: "TEAM_ELAPSED_MINUTES", scalingMethod: "FIXED_TEAM", minimumCrewSize: 3, standardCrewSize: 3, maximumUsefulCrewSize: 3 }) },
      release: { releaseId: "r", versionNo: 1 }, quantity: 500,
    });
    expect(b.workloadTimeBasis).toBe("TEAM_ELAPSED_MINUTES");
    expect(b.standard.setupUnit).toBe("MINUTES_PER_ORDER");
  });

  test("PPC cannot submit or override any crew or scaling field", async () => {
    const w = await world("crew-ppc-cannot");
    for (const extra of [
      { capacityModel: CM({ standardCrewSize: 9 }) },
      { standardCrewSize: 9 },
      { scalingMethod: "LINEAR" },
      { maximumUsefulCrewSize: 99 },
      { standardEfficiencyPercent: 150 },
      { requiredRoles: [{ role: "CUTTER", count: 9 }] },
    ]) {
      const res = await call(`${PPC}/planning-files/${w.planId}/stage-schedule`,
        { token: w.planner.token, company: w.co._id, method: "POST", key: fx.nextKey(),
          body: { expectedRevision: 0,
            stages: [{ stageId: w.r.ids.cut, plannedStart: "2026-10-05", plannedEnd: "2026-10-07" }],
            ...extra } });
      expect([Object.keys(extra)[0], res.status]).toEqual([Object.keys(extra)[0], 400]);
    }
    /* The release's crew assumptions are untouched by every attempt. */
    const rel = await IeRelease.findById(w.rel._id).lean();
    expect(rel.source.processRoute.stages[0].technicalStandard.capacityModel)
      .toMatchObject({ standardCrewSize: 3, scalingMethod: "CAPPED_LINEAR", standardEfficiencyPercent: 80 });
  });

  test("release v1 keeps its crew assumptions when IE issues a different v2", async () => {
    const w = await world("crew-v1-kept");
    expect((await cutStage(w)).technicalBasis.standard.capacityModel)
      .toMatchObject({ standardCrewSize: 3, scalingMethod: "CAPPED_LINEAR", timeBasis: "LABOUR_MINUTES" });

    /* IE re-measures on a fixed team of five. */
    await fx.release(w.co, w.styleId, {
      versionNo: 2,
      processRoute: route({ standard: withCM({
        timeBasis: "TEAM_ELAPSED_MINUTES", scalingMethod: "FIXED_TEAM",
        standardCrewSize: 5, minimumCrewSize: 5, maximumUsefulCrewSize: 5,
      }) }).stages,
    });

    const after = (await cutStage(w)).technicalBasis;
    expect(after.standard.capacityModel).toMatchObject({
      standardCrewSize: 3, scalingMethod: "CAPPED_LINEAR", timeBasis: "LABOUR_MINUTES",
    });
    expect(after.ieReleaseVersionNo).toBe(1);
  });
});
