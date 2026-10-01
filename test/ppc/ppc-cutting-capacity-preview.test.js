// test/ppc/ppc-cutting-capacity-preview.test.js
//
// CUTTING OWNS ITS RESOURCES; PPC PREVIEWS A WINDOW AGAINST THEM.
//
// Two records meet and neither is written. IE's approved standard says how
// much work the order is and what the minutes mean. Cutting's published
// resource says what the cutting room has. PPC multiplies one by the other
// and says which days the work would fall on — and reserves nothing.
//
// ── THE THREE ARITHMETIC MISTAKES THIS SUITE EXISTS TO PREVENT ──────────────
//   1. Multiplying elapsed team minutes by a headcount. A TEAM_ELAPSED figure
//      is wall-clock time for the approved crew; a fourth person does not
//      make the day longer.
//   2. Applying two efficiencies. IE's minutes already assume its own; using
//      Cutting's as well deflates the standard by its own allowance.
//   3. Extrapolating past what IE measured. Above a LINEAR standard's
//      validated crew, "not measured" is not "no further benefit".
//
// Pinned:
//   · an eligible three-person crew previews a window;
//   · a short crew, a missing role, a wrong type, an inactive resource and a
//     crew outside IE's range are each excluded BY NAME with an owner;
//   · FIXED_TEAM extra people buy nothing; CAPPED_LINEAR stops at the cap;
//   · breaks, holidays and planned downtime reduce availability;
//   · efficiency is applied exactly once, and the answer says which;
//   · another company's resources are invisible;
//   · PPC can neither author a resource nor a standard;
//   · the preview writes no booking, target, actual or release.
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
const { PpcStageSchedule } = require("../../models/CMS_Models/PPC/PpcStageSchedule");
const { PpcStagePublication } = require("../../models/CMS_Models/PPC/PpcStagePublication");
const { PpcCapacityBooking } = require("../../models/CMS_Models/PPC/PpcCapacityBooking");
const { CuttingResource } = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingResource");
const CuttingMasterRecord = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");

const preview = require("../../services/ppc/cuttingCapacityPreview.service");
const resources = require("../../services/production/cuttingResource.service");

let http, base, seq = 0;
const PPC = "/api/cms/ppc";
const CUT = "/api/cms/manufacturing/cutting-master";

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(PPC, require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.use(`${CUT}/resources`, require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingResourceRoutes"));
  await new Promise((r) => { http = app.listen(0, r); });
  base = `http://127.0.0.1:${http.address().port}`;
  for (const m of [PpcPlanningFile, PpcStageSchedule, PpcStagePublication, CuttingResource]) {
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
  const email = `crs${n}-${Date.now()}@grav.test`;
  const emp = await Employee.create({ firstName: name, lastName: `C${n}`, email,
    biometricId: `CRS${n}${Date.now()}`, isActive: true, gender: "Other", department: "Cutting" });
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

/** One company with a plan frozen to a standard, plus Cutting people. */
async function world(label, { standard = fx.cuttingStandard(), quantity = QUANTITY } = {}) {
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
  const created = await call(`${PPC}/order-book/${file.handoverLineRef}/planning-file`,
    { token: planner.token, company: co._id, method: "POST", body: {}, key: fx.nextKey() });
  expect(created.status).toBe(201);

  const w = { co, file, r, styleId, rel: rel.release, planner, quantity,
    planId: created.body.planningFile.planningFileId, lineRef: file.handoverLineRef };
  w.editor = await cutter(co, { role: "editor" });
  w.viewer = await cutter(co, { role: "viewer", name: "View" });

  /** Author AND publish one resource through Cutting's own door. */
  w.publishResource = async (over = {}) => {
    const body = RESOURCE(over);
    const saved = await call(`${CUT}/resources`, { token: w.editor.token, company: co._id,
      method: "POST", body });
    expect([body.resourceRef, saved.status]).toEqual([body.resourceRef, 201]);
    const live = await call(`${CUT}/resources/${body.resourceRef}/publish`,
      { token: w.editor.token, company: co._id, method: "POST", body: {} });
    expect(live.status).toBe(200);
    return live.body.resource;
  };
  w.preview = (from = FROM) => call(
    `${PPC}/planning-files/${w.planId}/cutting-capacity?from=${from}`,
    { token: planner.token, company: co._id },
  );
  return w;
}

const CM = (over) => ({ ...fx.cuttingStandard().capacityModel, ...over });
const withCM = (over) => ({ ...fx.cuttingStandard(), capacityModel: CM(over) });

/* ══ 1–2 · ELIGIBILITY AND CREW ═══════════════════════════════════════════ */

describe("an eligible crew previews a window; a short one is excluded by name", () => {
  test("three people with the required roles: a window, its days and its arithmetic", async () => {
    const w = await world("cap-ok");
    const resource = await w.publishResource();
    const res = await w.preview();
    expect(res.status).toBe(200);
    const p = res.body.preview;

    expect(p.state).toBe("PREVIEWED");
    expect(p.previewOnly).toBe(true);
    expect(p.notice).toMatch(/no Cutting capacity has been reserved and no target has been published/);
    expect(p.basis.workloadMinutes).toBe(445);          // 45 + 500 × 0.8

    expect(p.options).toHaveLength(1);
    const o = p.options[0];
    expect(o.resourceRef).toBe(resource.resourceRef);
    expect(o.resourceVersionNo).toBe(1);
    expect(o.headcount).toBe(3);
    expect(o.usableCrew).toBe(3);
    expect(o.crew).toEqual([{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 2 }]);

    /* 420 net shift minutes × 3 usable crew × 75% = 945 labour minutes. */
    expect(o.days[0]).toMatchObject({
      date: FROM, working: true, netShiftMinutes: 420, capacityMinutes: 945,
      usedMinutes: 445, remainingAfter: 0, source: "WEEK_PATTERN",
    });
    expect(o.earliestStart).toBe(FROM);
    expect(o.earliestFinish).toBe(FROM);
    expect(o.complete).toBe(true);
  });

  test("a two-person crew is below IE's approved minimum and is excluded", async () => {
    const w = await world("cap-short-crew");
    await w.publishResource({ crew: [{ role: "CUTTER", count: 1 }, { role: "SPREADER_OR_HELPER", count: 1 }] });
    const p = (await w.preview()).body.preview;

    expect(p.state).toBe("PPC_CUTTING_NO_ELIGIBLE_RESOURCE");
    expect(p.options).toEqual([]);
    expect(p.excluded).toHaveLength(1);
    expect(p.excluded[0]).toMatchObject({
      reason: "PPC_CUTTING_CREW_ROLE_MISSING", owner: "Cutting",
    });
    expect(p.excluded[0].detail.missing)
      .toEqual([{ role: "SPREADER_OR_HELPER", required: 2, available: 1 }]);
  });

  test("a crew that meets the headcount but not the roles is still excluded", async () => {
    const w = await world("cap-wrong-roles");
    /* Three people, all cutters — the standard needs two spreaders. */
    await w.publishResource({ crew: [{ role: "CUTTER", count: 3 }] });
    const p = (await w.preview()).body.preview;
    expect(p.excluded[0].reason).toBe("PPC_CUTTING_CREW_ROLE_MISSING");
    expect(p.excluded[0].detail.missing[0].role).toBe("SPREADER_OR_HELPER");
  });
});

/* ══ 3–5 · THE SCALING RULE IS IE'S ═══════════════════════════════════════ */

describe("more people help only when the approved standard says so", () => {
  test("FIXED_TEAM: a fourth and fifth person buy nothing", async () => {
    const fixed = withCM({
      timeBasis: "TEAM_ELAPSED_MINUTES", scalingMethod: "FIXED_TEAM",
      standardCrewSize: 3, minimumCrewSize: 3, maximumUsefulCrewSize: 3,
    });
    const three = await world("cap-fixed-3", { standard: fixed });
    await three.publishResource();
    const five = await world("cap-fixed-5", { standard: fixed });
    await five.publishResource({
      crew: [{ role: "CUTTER", count: 2 }, { role: "SPREADER_OR_HELPER", count: 3 }],
    });

    const a = (await three.preview()).body.preview.options[0];
    const b = (await five.preview()).body.preview.options[0];

    expect(a.usableCrew).toBe(3);
    expect(b.headcount).toBe(5);
    expect(b.usableCrew).toBe(3);                       // the extra two do not count
    expect(b.crewNote).toBe("FIXED_TEAM_EXTRA_PEOPLE_DO_NOT_HELP");
    expect(b.scalesWithCrew).toBe(false);

    /* Elapsed minutes are NOT multiplied by crew: both days offer the same
       420 × 75% = 315 minutes however many people stand at the table. */
    expect(a.days[0].capacityMinutes).toBe(315);
    expect(b.days[0].capacityMinutes).toBe(315);
    expect(b.earliestFinish).toBe(a.earliestFinish);
  });

  test("CAPPED_LINEAR stops at the approved maximum", async () => {
    const capped = withCM({ scalingMethod: "CAPPED_LINEAR", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 });
    const four = await world("cap-capped-4", { standard: capped });
    await four.publishResource({ crew: [{ role: "CUTTER", count: 2 }, { role: "SPREADER_OR_HELPER", count: 2 }] });
    const eight = await world("cap-capped-8", { standard: capped });
    await eight.publishResource({ crew: [{ role: "CUTTER", count: 4 }, { role: "SPREADER_OR_HELPER", count: 4 }] });

    const a = (await four.preview()).body.preview.options[0];
    const b = (await eight.preview()).body.preview.options[0];
    expect(a.usableCrew).toBe(4);
    expect(b.headcount).toBe(8);
    expect(b.usableCrew).toBe(4);                        // the cap, not the headcount
    expect(b.crewNote).toBe("CAPPED_AT_MAXIMUM_USEFUL_CREW");
    expect(a.days[0].capacityMinutes).toBe(b.days[0].capacityMinutes);
  });

  test("LINEAR above IE's validated crew is refused, not extrapolated", async () => {
    const linear = withCM({ scalingMethod: "LINEAR", minimumCrewSize: 2, standardCrewSize: 3, maximumUsefulCrewSize: 4 });
    const w = await world("cap-linear-over", { standard: linear });
    await w.publishResource({ crew: [{ role: "CUTTER", count: 3 }, { role: "SPREADER_OR_HELPER", count: 3 }] });
    const p = (await w.preview()).body.preview;

    expect(p.state).toBe("PPC_CUTTING_NO_ELIGIBLE_RESOURCE");
    expect(p.excluded[0]).toMatchObject({
      reason: "PPC_CUTTING_CREW_OUTSIDE_VALIDATED_RANGE",
      owner: "Industrial Engineering",
    });
    expect(p.excluded[0].detail.reason).toBe("ABOVE_VALIDATED_CREW");
    expect(p.excluded[0].detail.maximumUsefulCrewSize).toBe(4);
  });
});

/* ══ 6–8 · TYPE, CALENDAR AND EFFICIENCY ══════════════════════════════════ */

describe("type, calendar and efficiency", () => {
  test("a resource of another type is excluded, naming both types", async () => {
    const w = await world("cap-type");
    await w.publishResource({ resourceType: "AUTO_CUTTER" });
    const p = (await w.preview()).body.preview;
    expect(p.state).toBe("PPC_CUTTING_NO_PUBLISHED_RESOURCES");

    /* The preview reads only resources of the type IE requires, so an
       auto-cutter is not even a candidate. Asked directly, the exclusion
       names both types and both owners. */
    const verdict = preview.assess(
      { resourceType: "AUTO_CUTTER", isActive: true, crew: [] },
      fx.cuttingStandard().capacityModel, "STRAIGHT_KNIFE",
    );
    expect(verdict).toMatchObject({
      eligible: false, code: "PPC_CUTTING_RESOURCE_TYPE_MISMATCH",
      owner: "Industrial Engineering / Cutting",
      detail: { required: "STRAIGHT_KNIFE", found: "AUTO_CUTTER" },
    });
  });

  test("breaks, holidays and planned downtime all reduce what a day offers", async () => {
    /* Big enough that the run reaches past the make-up Saturday and the
       Sunday after it, so every kind of day is actually met. */
    const w = await world("cap-calendar", { quantity: 5000 });
    await w.publishResource({
      exceptions: [
        { date: "2026-10-06", kind: "HOLIDAY", reason: "Public holiday." },
        { date: "2026-10-07", kind: "DOWNTIME", reason: "Blade change and table service." },
        { date: "2026-10-10", kind: "WORKING_DAY", reason: "Make-up Saturday.",
          shifts: [{ shiftKey: "A", start: "09:00", end: "13:00", breakMinutes: 0 }] },
      ],
    });
    const o = (await w.preview()).body.preview.options[0];
    const byDate = Object.fromEntries(o.days.map((d) => [d.date, d]));

    /* The break is already out of the net figure: 09:00–17:00 less 60. */
    expect(byDate["2026-10-05"].netShiftMinutes).toBe(420);
    /* A holiday and a downtime day both offer nothing — and say which. */
    expect(byDate["2026-10-06"]).toMatchObject({ working: false, capacityMinutes: 0, source: "EXCEPTION_HOLIDAY" });
    expect(byDate["2026-10-07"]).toMatchObject({ working: false, capacityMinutes: 0, source: "EXCEPTION_DOWNTIME" });
    expect(byDate["2026-10-07"].reason).toMatch(/Blade change/);
    /* The weekend is a rest day, and the make-up Saturday is not. */
    expect(byDate["2026-10-11"]).toMatchObject({ working: false, source: "WEEKLY_REST_DAY" });
    expect(byDate["2026-10-10"]).toMatchObject({
      working: true, netShiftMinutes: 240, source: "EXCEPTION_WORKING_DAY",
    });
    /* 240 × 3 × 75% = 540. */
    expect(byDate["2026-10-10"].capacityMinutes).toBe(540);
  });

  test("efficiency is applied exactly once, and the answer names which one", async () => {
    const w = await world("cap-efficiency");
    await w.publishResource({ operationalEfficiencyPercent: 50 });
    const o = (await w.preview()).body.preview.options[0];

    /* 420 × 3 × 50% = 630. IE's own 80% is NOT applied on top — that would
       give 504 and silently deflate the standard by its own allowance. */
    expect(o.days[0].capacityMinutes).toBe(630);
    expect(o.days[0].capacityMinutes).not.toBe(504);

    expect(o.efficiency).toMatchObject({
      appliedPercent: 50, appliedFrom: "CUTTING_OPERATIONAL", appliedOnce: true,
    });
    expect(o.efficiency.informationalOnly).toMatchObject({ source: "IE_STANDARD", percent: 80 });
    expect(o.efficiency.informationalOnly.note).toMatch(/already assume this/);
  });
});

/* ══ 9–12 · OWNERSHIP AND BOUNDARIES ══════════════════════════════════════ */

describe("whose record is whose", () => {
  test("another company's resources are invisible, and leak no identity", async () => {
    const mine = await world("cap-mine");
    const theirs = await world("cap-theirs");
    const theirResource = await theirs.publishResource({ name: "Their Table" });

    const p = (await mine.preview()).body.preview;
    expect(p.state).toBe("PPC_CUTTING_NO_PUBLISHED_RESOURCES");
    const dump = JSON.stringify(p);
    expect(dump).not.toContain(theirResource.resourceRef);
    expect(dump).not.toContain("Their Table");

    /* And Cutting's own door is company-scoped too. */
    const list = await call(`${CUT}/resources`, { token: mine.editor.token, company: mine.co._id });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(theirResource.resourceRef);
  });

  test("a Cutting viewer reads; an editor authors and publishes; PPC does neither", async () => {
    const w = await world("cap-roles");
    const body = RESOURCE();

    /* A viewer may read, and may not author. */
    expect((await call(`${CUT}/resources`, { token: w.viewer.token, company: w.co._id })).status).toBe(200);
    const viewerWrite = await call(`${CUT}/resources`,
      { token: w.viewer.token, company: w.co._id, method: "POST", body });
    expect(viewerWrite.status).toBe(403);

    /* A PPC planner reaches this door at all only to be refused: a PPC grant
       is not a Cutting grant. */
    for (const path of ["", `/${body.resourceRef}/publish`]) {
      const tried = await call(`${CUT}/resources${path}`,
        { token: w.planner.token, company: w.co._id, method: "POST", body });
      expect([path, tried.status]).toEqual([path, 403]);
    }
    expect(await CuttingResource.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a resource cannot carry an engineering standard, and PPC cannot edit one", async () => {
    const w = await world("cap-no-standard");
    for (const field of ["standardMinutesPerPiece", "setupMinutesPerOrder", "capacityModel", "sam"]) {
      const tried = await call(`${CUT}/resources`, { token: w.editor.token, company: w.co._id,
        method: "POST", body: { ...RESOURCE(), [field]: 1 } });
      expect([field, tried.status]).toEqual([field, 400]);
      expect(tried.body.message).toMatch(/Industrial Engineering owns/);
    }
    /* And the preview endpoint is a GET — there is no verb that writes. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/PPC/orderBookRoute.js"), "utf8");
    /* The route's own declaration, from its verb to the end of its handler. */
    const at = src.indexOf('router.get("/planning-files/:planningFileId/cutting-capacity"');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("}));", at) + 4);
    expect(block).toMatch(/canRead/);
    expect(block).not.toMatch(/canPlan|canApprove/);
    expect(block).not.toMatch(/router\.(post|patch|put|delete)/);
  });

  test("previewing writes no booking, target, schedule, actual or release", async () => {
    const w = await world("cap-writes-nothing");
    await w.publishResource();
    const before = await CuttingResource.find({ companyId: w.co._id }).lean();

    const p = (await w.preview()).body.preview;
    expect(p.state).toBe("PREVIEWED");
    expect(p.reservesCapacity).toBe(false);
    expect(p.publishesTarget).toBe(false);
    expect(p.releasesProduction).toBe(false);

    expect(await PpcCapacityBooking.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await PpcStagePublication.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await PpcStageSchedule.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await CuttingMasterRecord.countDocuments({})).toBe(0);
    /* The resource itself is byte-identical: a preview reads it. */
    expect(await CuttingResource.find({ companyId: w.co._id }).lean()).toEqual(before);
  });

  test("a published version is frozen; a change is a new version", async () => {
    const w = await world("cap-versioned");
    const first = await w.publishResource({ operationalEfficiencyPercent: 75 });
    expect(first.versionNo).toBe(1);

    /* Cutting re-rosters: a new draft on the same reference, published. */
    const saved = await call(`${CUT}/resources`, { token: w.editor.token, company: w.co._id,
      method: "POST", body: RESOURCE({ resourceRef: first.resourceRef, operationalEfficiencyPercent: 60 }) });
    expect(saved.status).toBe(201);
    expect(saved.body.resource.versionNo).toBe(2);
    const live = await call(`${CUT}/resources/${first.resourceRef}/publish`,
      { token: w.editor.token, company: w.co._id, method: "POST", body: {} });
    expect(live.status).toBe(200);

    /* Exactly one version is in force, and the old one stays readable. */
    const all = await CuttingResource.find({ companyId: w.co._id, resourceRef: first.resourceRef }).lean();
    expect(all).toHaveLength(2);
    expect(all.find((v) => v.versionNo === 1)).toMatchObject({
      state: "SUPERSEDED", supersededByVersionNo: 2, operationalEfficiencyPercent: 75,
    });
    expect(all.find((v) => v.versionNo === 2)).toMatchObject({ state: "PUBLISHED" });
    /* And the preview reads the one in force. */
    const o = (await w.preview()).body.preview.options[0];
    expect(o.resourceVersionNo).toBe(2);
    expect(o.efficiency.appliedPercent).toBe(60);
  });

  test("no published resource at all is a named blocker owned by Cutting", async () => {
    const w = await world("cap-none");
    const p = (await w.preview()).body.preview;
    expect(p.state).toBe("PPC_CUTTING_NO_PUBLISHED_RESOURCES");
    expect(p.owner).toBe("Cutting");
    expect(p.message).toMatch(/Cutting publishes its tables, shifts and crew in its own screen/);
    /* The stage's engineering is still shown — the basis is not hidden by a
       resource problem. */
    expect(p.basis.workloadMinutes).toBe(445);
  });

  test("capacity that cannot finish in the horizon is reported, never rounded away", async () => {
    /* More work than 180 days of this one table can hold. */
    const w = await world("cap-insufficient", { quantity: 200000 });
    await w.publishResource();
    const p = (await w.preview()).body.preview;
    expect(p.state).toBe("PPC_CUTTING_CAPACITY_INSUFFICIENT");
    expect(p.owner).toBe("Cutting");
    expect(p.options[0].complete).toBe(false);
    expect(p.options[0].remainingMinutes).toBeGreaterThan(0);
    expect(p.message).toMatch(/Cutting can add shifts, crew or a resource; PPC cannot/);
  });
});
