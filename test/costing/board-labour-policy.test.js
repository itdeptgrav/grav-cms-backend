// test/costing/board-labour-policy.test.js
//
// THE THIRD POLICY ON THE BOARD LIFECYCLE: LABOUR METHODOLOGY.
//
// ── WHAT MAKES THIS ONE DIFFERENT ───────────────────────────────────────────
// Financing asks four questions and overhead two, and both are "is it filled
// in". Labour asks three, and the first is an EITHER-OR: productive minutes or
// an efficiency, never both and never neither. That rule has always lived in
// `labourCost.productiveBasis()` at calculation time; it is now also an
// approval-time check, so a Board never approves a methodology the engine will
// then refuse.
//
// The second difference: a valid Board decision can still leave a costing
// incomplete. `IN_OPERATION_RATE` names a source nobody has built and
// `IN_OVERHEAD` names a policy that may not be in force — and reporting the
// family as answered because an enum has a value in it is precisely the
// failure this whole lane exists to correct.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const boardPolicy = require("../../services/board/boardPolicy.service");
const labourPolicy = require("../../services/centralCosting/labourPolicy.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_labour" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/board/policies`;
  await BoardPolicy.init();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});


/* ── A GRANT IS A DEPARTMENT AND A ROLE ──────────────────────────────────────
   Access Control writes both, and `services/board/boardAccess.js` requires
   both: a role row with nobody holding the department is a row, not a person —
   which is how "only employees with HR records hold Board" is enforced in the
   guard rather than only on the screen that writes the row.

   These fixtures used to write the role alone. Created on demand rather than in
   `beforeAll` because `test/setup.js` empties every collection after each
   test. */
const deptRow = (slug) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, key: slug, name: slug, dashboardPath: `/${slug}` } },
  { upsert: true, new: true },
).lean();

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `lb${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "L", lastName: `B${n}`, email, biometricId: `LB${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
  }
  const held = [];
  for (const [departmentSlug, role] of Object.entries(grants)) {
    const dept = await deptRow(departmentSlug);
    held.push(dept._id);
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: dept._id,
    });
  }
  if (held.length) {
    await Employee.updateOne({ _id: emp._id }, { $set: { additionalDepartmentIds: held } });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Board ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const METHODOLOGY = Object.freeze({
  labourEfficiencyPercent: "80",
  employerBurdenPercent: "18",
  machineBurdenTreatment: "IN_OVERHEAD",
});

const draft = (me, co, labour = METHODOLOGY, over = {}) => call("/LABOUR_METHODOLOGY/drafts", {
  method: "POST", token: me.token, company: co._id,
  body: { labour, rationale: "Reviewed at the July board.", ...over },
});

const approveAt = async (me, co, from, labour = METHODOLOGY) => {
  const made = await draft(me, co, labour);
  if (made.status !== 201) return made;
  return call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom: from },
  });
};

/* ═══ 1 · NOTHING BY DEFAULT ══════════════════════════════════════════════ */

describe("a company starts with no labour decision", () => {
  test("no policy is seeded, and the absence is reported as absence", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
    expect(r.body.effectiveId).toBeNull();

    /* ── AND THE CALCULATION SIDE AGREES ───────────────────────────────
       Not "the operator costs their take-home pay", which is what an unset
       employer burden would silently mean. */
    const resolved = await labourPolicy.resolveFor({ companyId: co._id }, {});
    expect(resolved.state).toBe(labourPolicy.STATE.POLICY_MISSING);
    expect(resolved.missing[0].owner.department).toBe("Board");
    expect(labourPolicy.overlayFor(resolved)).toEqual({
      productiveMinutesPerMonth: undefined, labourEfficiencyPercent: undefined,
      employerBurdenPercent: undefined, machineBurdenTreatment: undefined,
    });
  });
});

/* ═══ 2 · ACCESS AND COMPANY ISOLATION ════════════════════════════════════ */

describe("Board access", () => {
  test("no Board grant is refused, not shown an empty list", async () => {
    const co = await company("NoGrant");
    const me = await actor({ companies: [co], grants: { sales: "owner", store: "owner" } });
    const r = await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("a platform administrator is not on the Board", async () => {
    const co = await company("AdminOnly");
    const me = await actor({ companies: [co], isAdmin: true });
    expect((await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id })).body.error.details.reason)
      .toBe("NO_BOARD_GRANT");
  });

  test("an editor may draft and may not approve", async () => {
    const co = await company("Ranks");
    const editor = await actor({ companies: [co], grants: { board: "editor" } });
    const made = await draft(editor, co);
    expect(made.status).toBe(201);
    const r = await call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: editor.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(r.status).toBe(403);
  });

  test("every read, draft and approval is company-scoped", async () => {
    const a = await company("Alpha");
    const b = await company("Beta");
    const mine = await actor({ companies: [a], grants: { board: "owner" } });
    const theirs = await actor({ companies: [b], grants: { board: "owner" } });

    const made = await draft(theirs, b);
    expect((await call("/LABOUR_METHODOLOGY", { token: mine.token, company: a._id })).body.versions).toEqual([]);
    const reach = await call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}`, {
      method: "PUT", token: mine.token, company: a._id, body: { revision: 1, rationale: "x" },
    });
    expect(reach.status).toBe(404);
    expect(await boardPolicy.resolveEffective(a._id, "LABOUR_METHODOLOGY", new Date())).toBeNull();
  });
});

/* ═══ 3 · THE PRODUCTIVE BASIS IS ONE ANSWER ══════════════════════════════ */

describe("productive time: exactly one basis", () => {
  test("stated minutes are accepted", async () => {
    const co = await company("Minutes");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-01-01", {
      productiveMinutesPerMonth: 9000, employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(r.status).toBe(200);
    expect(r.body.version.labour.productiveMinutesPerMonth).toBe(9000);
    expect(r.body.version.labour.labourEfficiencyPercent).toBeUndefined();
  });

  test("an efficiency is accepted, and is not a denominator", async () => {
    const co = await company("Efficiency");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-01-01");
    expect(r.status).toBe(200);
    expect(r.body.version.labour.labourEfficiencyPercent).toBe("80");
    /* The policy stores the DECISION. What the arithmetic divides by is
       resolved by labourCost, and frozen on the version — see the costing
       suite; the two must never be conflated. */
    expect(r.body.version.labour.productiveMinutesPerMonth).toBeUndefined();
  });

  test("BOTH is refused at the write, before anybody presses approve", async () => {
    /* ── TWO ANSWERS TO ONE QUESTION ───────────────────────────────────
       9,000 minutes and 80% of 12,480 (9,984) are different numbers, and
       silently preferring either buries the disagreement inside every labour
       rate the company quotes. */
    const co = await company("Both");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await draft(me, co, {
      productiveMinutesPerMonth: 9000, labourEfficiencyPercent: "80",
      employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("PRODUCTIVE_BASIS_AMBIGUOUS");
  });

  test("NEITHER is refused at approval", async () => {
    const co = await company("Neither");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-07-01", {
      employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["productiveMinutesPerMonth"]);
    expect(r.body.error.details.gaps[0].message).toMatch(/either the minutes, or an efficiency/);
  });

  test("an efficiency above 100 is refused; minutes must be positive", async () => {
    const co = await company("Bounds");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await draft(me, co, { ...METHODOLOGY, labourEfficiencyPercent: "140" })).status).toBe(400);
    const bad = await draft(me, co, {
      productiveMinutesPerMonth: 0, employerBurdenPercent: "18", machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe("PRODUCTIVE_MINUTES_INVALID");
  });
});

/* ═══ 4 · EMPLOYER BURDEN ═════════════════════════════════════════════════ */

describe("employer burden", () => {
  test("zero is a valid explicit decision", async () => {
    const co = await company("ZeroBurden");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-01-01", { ...METHODOLOGY, employerBurdenPercent: "0" });
    expect(r.status).toBe(200);
    expect(r.body.version.labour.employerBurdenPercent).toBe("0");

    const resolved = await labourPolicy.resolveFor({ companyId: co._id }, {});
    expect(resolved.state).toBe(labourPolicy.STATE.APPLIED);
    expect(labourPolicy.overlayFor(resolved).employerBurdenPercent).toBe("0");
  });

  test("missing is not zero", async () => {
    const co = await company("NoBurden");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-07-01", {
      labourEfficiencyPercent: "80", machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["employerBurdenPercent"]);
    expect(r.body.error.details.gaps[0].message).toMatch(/only their take-home pay/);
  });

  test("above 100% is real; the existing upper bound is preserved", async () => {
    const co = await company("HighBurden");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await draft(me, co, { ...METHODOLOGY, employerBurdenPercent: "140" })).status).toBe(201);
    const over = await draft(me, co, { ...METHODOLOGY, employerBurdenPercent: "1400" });
    expect(over.status).toBe(400);
    expect(over.body.error.details.field).toBe("employerBurdenPercent");
  });
});

/* ═══ 5 · MACHINE BURDEN, AND WHAT IT DEPENDS ON ══════════════════════════ */

describe("machine burden: three answers, two dependencies", () => {
  const resolvedWith = (treatment) => labourPolicy.methodologyOf({
    _id: "x", labour: { ...METHODOLOGY, machineBurdenTreatment: treatment, machineExclusionReason: "r" },
  });

  test("all three are approvable", async () => {
    const co = await company("AllThree");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    for (const t of ["IN_OVERHEAD", "IN_OPERATION_RATE"]) {
      expect((await draft(me, co, { ...METHODOLOGY, machineBurdenTreatment: t })).status).toBe(201);
    }
    expect((await draft(me, co, {
      ...METHODOLOGY, machineBurdenTreatment: "NOT_COSTED", machineExclusionReason: "Fully depreciated plant.",
    })).status).toBe(201);
  });

  test("an exclusion must say why; the other two need no reason", async () => {
    const co = await company("Exclusion");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, machineBurdenTreatment: "NOT_COSTED" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["machineExclusionReason"]);

    const ok = await approveAt(me, co, "2026-08-01", {
      ...METHODOLOGY, machineBurdenTreatment: "NOT_COSTED", machineExclusionReason: "Fully depreciated plant.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version.labour.machineExclusionReason).toMatch(/depreciated/);
  });

  test("IN_OPERATION_RATE is valid and still blocked on a source nobody has built", () => {
    /* ── AN ENUM IS NOT A SOURCE ───────────────────────────────────────
       The Board may approve it. Nothing in this system records a machine
       hourly rate, so costing reports the missing source — and the fix is a
       Production master, not a policy edit. */
    const deps = labourPolicy.dependenciesOf(resolvedWith("IN_OPERATION_RATE"), { overheadInForce: true });
    expect(deps.map((d) => d.code)).toEqual([labourPolicy.CODES.MACHINE_SOURCE_MISSING]);
    expect(deps[0].owner.department).toBe("Not yet assigned");
    expect(deps[0].message).toMatch(/Production master, not a policy edit/);
  });

  test("IN_OVERHEAD depends on an overhead policy being in force", () => {
    const without = labourPolicy.dependenciesOf(resolvedWith("IN_OVERHEAD"), { overheadInForce: false });
    expect(without.map((d) => d.code)).toEqual([labourPolicy.CODES.OVERHEAD_DEPENDENCY_MISSING]);
    expect(without[0].owner.department).toBe("Board");
    expect(without[0].message).toMatch(/charged nowhere/);

    /* And with one, it is answered. */
    expect(labourPolicy.dependenciesOf(resolvedWith("IN_OVERHEAD"), { overheadInForce: true })).toEqual([]);
  });

  test("NOT_COSTED depends on nothing — it is the decision that it is carried nowhere", () => {
    expect(labourPolicy.dependenciesOf(resolvedWith("NOT_COSTED"), { overheadInForce: false })).toEqual([]);
  });

  test("the three failures are kept apart, not collapsed", () => {
    /* A missing policy, a missing machine source and a missing overhead
       dependency are fixed by three different people. */
    const codes = new Set([
      labourPolicy.CODES.POLICY_MISSING,
      labourPolicy.CODES.MACHINE_SOURCE_MISSING,
      labourPolicy.CODES.OVERHEAD_DEPENDENCY_MISSING,
      labourPolicy.CODES.SAM_MISSING,
      labourPolicy.CODES.SALARY_BASIS_MISSING,
    ]);
    expect(codes.size).toBe(5);
  });
});

/* ═══ 6 · LIFECYCLE ═══════════════════════════════════════════════════════ */

describe("the lifecycle", () => {
  test("a draft can be edited and says what is still open", async () => {
    const co = await company("Editing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await draft(me, co, {});
    expect(made.body.version.policyKey).toBe("LABOUR_METHODOLOGY");

    const list = await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id });
    expect(list.body.gaps[made.body.version._id].map((g) => g.field).sort())
      .toEqual(["employerBurdenPercent", "machineBurdenTreatment", "productiveMinutesPerMonth"]);

    const edited = await call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, labour: METHODOLOGY },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.gaps).toEqual([]);
  });

  test("approval records who and when, and the version stops being editable", async () => {
    const co = await company("Approve");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);
    const ok = await call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version.approvedByActorName).toMatch(/^Board /);

    const edit = await call(`/LABOUR_METHODOLOGY/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, labour: { employerBurdenPercent: "30" } },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
    expect((await BoardPolicy.findById(made.body.version._id).lean()).labour.employerBurdenPercent).toBe("18");
  });

  test("a future-dated policy affects nothing before its date", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2030-01-01");
    expect(await boardPolicy.resolveEffective(co._id, "LABOUR_METHODOLOGY", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "LABOUR_METHODOLOGY", new Date("2030-06-01"))).toBeTruthy();
  });

  test("a later policy supersedes the earlier one, which is not touched", async () => {
    const co = await company("Supersede");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const first = await approveAt(me, co, "2026-01-01", { ...METHODOLOGY, labourEfficiencyPercent: "65" });
    const second = await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, labourEfficiencyPercent: "80" });

    expect((await boardPolicy.resolveEffective(co._id, "LABOUR_METHODOLOGY", new Date("2026-03-15")))
      .labour.labourEfficiencyPercent).toBe("65");
    expect((await boardPolicy.resolveEffective(co._id, "LABOUR_METHODOLOGY", new Date("2026-09-15")))
      .labour.labourEfficiencyPercent).toBe("80");

    const stored = await BoardPolicy.findById(first.body.version._id).lean();
    expect(stored.labour.labourEfficiencyPercent).toBe("65");
    expect(stored.updatedAt.getTime()).toBe(new Date(first.body.version.updatedAt).getTime());

    const list = await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id });
    const byId = Object.fromEntries(list.body.versions.map((v) => [String(v._id), v.lifecycle]));
    expect(byId[String(second.body.version._id)]).toBe("EFFECTIVE");
    expect(byId[String(first.body.version._id)]).toBe("SUPERSEDED");
  });

  test("two approved policies cannot take effect on the same date", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    expect((await approveAt(me, co, "2026-07-01")).status).toBe(200);
    const clash = await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, labourEfficiencyPercent: "70" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
  });

  test("the four readiness states are reported apart", async () => {
    const S = boardPolicy.POLICY_STATE;
    const none = await company("StNone");
    expect((await boardPolicy.resolveState(none._id, "LABOUR_METHODOLOGY")).state).toBe(S.NONE);

    const dr = await company("StDraft");
    const me = await actor({ companies: [dr], grants: { board: "approver" } });
    await draft(me, dr);
    expect((await boardPolicy.resolveState(dr._id, "LABOUR_METHODOLOGY")).state).toBe(S.DRAFT_ONLY);

    const fut = await company("StFuture");
    const me2 = await actor({ companies: [fut], grants: { board: "approver" } });
    await approveAt(me2, fut, "2031-01-01");
    expect((await boardPolicy.resolveState(fut._id, "LABOUR_METHODOLOGY")).state).toBe(S.FUTURE_ONLY);

    const eff = await company("StEffective");
    const me3 = await actor({ companies: [eff], grants: { board: "approver" } });
    await approveAt(me3, eff, "2020-01-01");
    const st = await boardPolicy.resolveState(eff._id, "LABOUR_METHODOLOGY");
    expect(st.state).toBe(S.EFFECTIVE);
    /* And it carries no methodology — this is what a DEPARTMENT reads. */
    expect(JSON.stringify({ ...st, effective: undefined }))
      .not.toMatch(/labourEfficiency|employerBurden|IN_OVERHEAD/);
  });
});

/* ═══ 7 · THE OTHER TWO POLICIES ARE UNCHANGED ════════════════════════════ */

describe("adding a third policy changed nothing about the first two", () => {
  test("each key is its own record with its own payload", async () => {
    const co = await company("AllPolicies");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2026-01-01");
    await call("/OVERHEAD/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: { overhead: { ratePercent: "12", basis: "DIRECT_PLUS_FIXED" } },
    });

    const lb = await call("/LABOUR_METHODOLOGY", { token: me.token, company: co._id });
    expect(lb.body.versions).toHaveLength(1);
    expect(lb.body.versions[0].policyKey).toBe("LABOUR_METHODOLOGY");
    const oh = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(oh.body.versions[0].policyKey).toBe("OVERHEAD");
    expect(await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "LABOUR_METHODOLOGY", new Date())).toBeTruthy();
  });

  test("a body carrying another policy's payload writes none of it", async () => {
    const co = await company("CrossPayload");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await call("/LABOUR_METHODOLOGY/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: { labour: METHODOLOGY, overhead: { ratePercent: "99" }, financing: { annualRatePercent: "99" } },
    });
    const doc = await BoardPolicy.findById(made.body.version._id).lean();
    expect(doc.labour.employerBurdenPercent).toBe("18");
    expect(doc.overhead?.ratePercent).toBeUndefined();
    expect(doc.financing?.annualRatePercent).toBeUndefined();
  });

  test("each policy keeps its own completeness rule", () => {
    /* Three contracts, three shapes. A shared "payload is non-empty" check
       would approve a labour methodology with both bases and an overhead rate
       with no basis. */
    expect(boardPolicy.labourGaps({}).map((g) => g.field).sort())
      .toEqual(["employerBurdenPercent", "machineBurdenTreatment", "productiveMinutesPerMonth"]);
    expect(boardPolicy.overheadGaps({}).map((g) => g.field).sort()).toEqual(["basis", "ratePercent"]);
    expect(boardPolicy.financingGaps({}).length).toBe(4);
    /* And a complete labour payload is not a complete anything else. */
    expect(boardPolicy.overheadGaps(METHODOLOGY).length).toBe(2);
  });

  test("only implemented policy keys are accepted", async () => {
    const co = await company("Keys");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
        /* ── EVERY REAL KEY IS MIGRATED NOW ───────────────────────────────
       This used to name the next unbuilt policy, and each migration moved it
       along — overhead, labour, GST, development charges, contingency, margin,
       and finally customs duty. There is no unbuilt one left, so the example
       is a key that does not exist and never will. The rule under test is
       unchanged: an unknown key is refused BY NAME, and the refusal says which
       keys the company actually keeps. */
    const r = await call("/MOONLIGHT_POLICY", { token: me.token, company: co._id });
    expect(r.status).toBe(400);
    expect(r.body.error.details.allowed).toEqual(["FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY", "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY"]);
  });
});
