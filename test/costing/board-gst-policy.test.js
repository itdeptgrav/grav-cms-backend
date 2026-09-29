// test/costing/board-gst-policy.test.js
//
// THE FOURTH POLICY ON THE BOARD LIFECYCLE: INPUT GST TREATMENT.
//
// ── THE SHORTEST CONTRACT, AND STILL ITS OWN ────────────────────────────────
// One field, two values. It is still a per-key contract rather than folded in,
// because "is the payload non-empty" would pass a `gst` sub-document carrying
// somebody else's field — and because the two answers move money in opposite
// directions on every purchased line in the company.
//
// ── AND IT IS NOT CUSTOMS DUTY ──────────────────────────────────────────────
// Costing reports duty and non-recoverable tax under one family because both
// are tax that stays with the company. They are different charges on different
// events: this policy answers the second, and `DUTY_POLICY` — which still has
// no record at all — answers the first. The readiness contract keeps them
// apart as two named facts, and this suite asserts that.
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
const gstPolicy = require("../../services/centralCosting/gstPolicy.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_gst" });
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
  const email = `gst${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "G", lastName: `T${n}`, email, biometricId: `GT${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "G" });
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

const draft = (me, co, gst = { inputGstTreatment: "RECOVERABLE" }, over = {}) =>
  call("/GST_TAX_POLICY/drafts", {
    method: "POST", token: me.token, company: co._id,
    body: { gst, rationale: "Reviewed at the July board.", ...over },
  });

const approveAt = async (me, co, from, gst) => {
  const made = await draft(me, co, gst);
  if (made.status !== 201) return made;
  return call(`/GST_TAX_POLICY/drafts/${made.body.version._id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom: from },
  });
};

/* ═══ 1 · NOTHING BY DEFAULT ══════════════════════════════════════════════ */

describe("a company starts with no GST decision", () => {
  test("no policy is seeded, and missing is never implicitly recoverable", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await call("/GST_TAX_POLICY", { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
    expect(r.body.effectiveId).toBeNull();

    /* ── THE ONE ASSUMPTION THAT WOULD BE INVISIBLE ────────────────────
       Recoverable is the common answer, so it is the one somebody would be
       tempted to default. It under-costs every non-recoverable purchase. */
    const resolved = await gstPolicy.resolveFor({ companyId: co._id }, {});
    expect(resolved.state).toBe(gstPolicy.STATE.POLICY_MISSING);
    expect(resolved.inputGstTreatment).toBeNull();
    expect(gstPolicy.overlayFor(resolved).inputGstTreatment).toBeUndefined();
    expect(resolved.missing[0].owner.department).toBe("Board");
  });
});

/* ═══ 2 · ACCESS AND COMPANY ISOLATION ════════════════════════════════════ */

describe("Board access", () => {
  test("no Board grant is refused, not shown an empty list", async () => {
    const co = await company("NoGrant");
    const me = await actor({ companies: [co], grants: { sales: "owner", store: "owner" } });
    const r = await call("/GST_TAX_POLICY", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("a platform administrator is not on the Board", async () => {
    const co = await company("AdminOnly");
    const me = await actor({ companies: [co], isAdmin: true });
    expect((await call("/GST_TAX_POLICY", { token: me.token, company: co._id }))
      .body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("an editor may draft and may not approve", async () => {
    const co = await company("Ranks");
    const editor = await actor({ companies: [co], grants: { board: "editor" } });
    const made = await draft(editor, co);
    expect(made.status).toBe(201);
    const r = await call(`/GST_TAX_POLICY/drafts/${made.body.version._id}/approve`, {
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
    expect((await call("/GST_TAX_POLICY", { token: mine.token, company: a._id })).body.versions).toEqual([]);
    const reach = await call(`/GST_TAX_POLICY/drafts/${made.body.version._id}`, {
      method: "PUT", token: mine.token, company: a._id, body: { revision: 1, rationale: "x" },
    });
    expect(reach.status).toBe(404);
    expect(await boardPolicy.resolveEffective(a._id, "GST_TAX_POLICY", new Date())).toBeNull();
  });
});

/* ═══ 3 · THE CONTRACT ════════════════════════════════════════════════════ */

describe("exactly one valid value before approval", () => {
  test("both treatments are approvable", async () => {
    for (const t of ["RECOVERABLE", "NON_RECOVERABLE"]) {
      const co = await company(`T-${t}`);
      const me = await actor({ companies: [co], grants: { board: "approver" } });
      const r = await approveAt(me, co, "2026-01-01", { inputGstTreatment: t });
      expect(r.status).toBe(200);
      expect(r.body.version.gst.inputGstTreatment).toBe(t);

      const resolved = await gstPolicy.resolveFor({ companyId: co._id }, {});
      expect(resolved.state).toBe(gstPolicy.STATE.APPLIED);
      expect(gstPolicy.overlayFor(resolved).inputGstTreatment).toBe(t);
    }
  });

  test("an empty treatment cannot be approved", async () => {
    const co = await company("Empty");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const r = await approveAt(me, co, "2026-07-01", {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["inputGstTreatment"]);
  });

  test("`NONE` is refused — it is the absence of an opinion, not a third one", async () => {
    /* A supply that genuinely carries no GST says so on its own quotation
       (`priceBasis: NON_TAXABLE`); the company never states it. */
    const co = await company("None");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await draft(me, co, { inputGstTreatment: "NONE" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("VALUE_NOT_ALLOWED");
    expect(r.body.error.details.allowed).toEqual(["RECOVERABLE", "NON_RECOVERABLE"]);
  });

  test("a value from another tax vocabulary is refused", async () => {
    const co = await company("Wrong");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    for (const bad of ["EXEMPT", "ZERO_RATED", "IN_OVERHEAD", "true"]) {
      expect((await draft(me, co, { inputGstTreatment: bad })).status).toBe(400);
    }
  });
});

/* ═══ 4 · LIFECYCLE ═══════════════════════════════════════════════════════ */

describe("the lifecycle", () => {
  test("a draft can be edited and says what is open", async () => {
    const co = await company("Editing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await draft(me, co, {});
    expect(made.body.version.policyKey).toBe("GST_TAX_POLICY");

    const list = await call("/GST_TAX_POLICY", { token: me.token, company: co._id });
    expect(list.body.gaps[made.body.version._id].map((g) => g.field)).toEqual(["inputGstTreatment"]);

    const edited = await call(`/GST_TAX_POLICY/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, gst: { inputGstTreatment: "NON_RECOVERABLE" } },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.gaps).toEqual([]);
  });

  test("approval records who and when, and the version stops being editable", async () => {
    const co = await company("Approve");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);
    const ok = await call(`/GST_TAX_POLICY/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version.approvedByActorName).toMatch(/^Board /);
    expect(ok.body.version.approvedAt).toBeTruthy();

    const edit = await call(`/GST_TAX_POLICY/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, gst: { inputGstTreatment: "NON_RECOVERABLE" } },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
    expect((await BoardPolicy.findById(made.body.version._id).lean()).gst.inputGstTreatment)
      .toBe("RECOVERABLE");
  });

  test("a future-dated policy affects nothing before its date", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2030-01-01");
    expect(await boardPolicy.resolveEffective(co._id, "GST_TAX_POLICY", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "GST_TAX_POLICY", new Date("2030-06-01"))).toBeTruthy();
  });

  test("a later policy supersedes the earlier one, which is not touched", async () => {
    const co = await company("Supersede");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const first = await approveAt(me, co, "2026-01-01", { inputGstTreatment: "NON_RECOVERABLE" });
    const second = await approveAt(me, co, "2026-07-01", { inputGstTreatment: "RECOVERABLE" });

    expect((await boardPolicy.resolveEffective(co._id, "GST_TAX_POLICY", new Date("2026-03-15")))
      .gst.inputGstTreatment).toBe("NON_RECOVERABLE");
    expect((await boardPolicy.resolveEffective(co._id, "GST_TAX_POLICY", new Date("2026-09-15")))
      .gst.inputGstTreatment).toBe("RECOVERABLE");

    const stored = await BoardPolicy.findById(first.body.version._id).lean();
    expect(stored.gst.inputGstTreatment).toBe("NON_RECOVERABLE");
    expect(stored.updatedAt.getTime()).toBe(new Date(first.body.version.updatedAt).getTime());

    const list = await call("/GST_TAX_POLICY", { token: me.token, company: co._id });
    const byId = Object.fromEntries(list.body.versions.map((v) => [String(v._id), v.lifecycle]));
    expect(byId[String(second.body.version._id)]).toBe("EFFECTIVE");
    expect(byId[String(first.body.version._id)]).toBe("SUPERSEDED");
  });

  test("two approved policies cannot take effect on the same date", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    expect((await approveAt(me, co, "2026-07-01")).status).toBe(200);
    const clash = await approveAt(me, co, "2026-07-01", { inputGstTreatment: "NON_RECOVERABLE" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
  });

  test("the four readiness states are reported apart, and carry no treatment", async () => {
    const S = boardPolicy.POLICY_STATE;
    const none = await company("StNone");
    expect((await boardPolicy.resolveState(none._id, "GST_TAX_POLICY")).state).toBe(S.NONE);

    const dr = await company("StDraft");
    const me = await actor({ companies: [dr], grants: { board: "approver" } });
    await draft(me, dr);
    expect((await boardPolicy.resolveState(dr._id, "GST_TAX_POLICY")).state).toBe(S.DRAFT_ONLY);

    const eff = await company("StEffective");
    const me2 = await actor({ companies: [eff], grants: { board: "approver" } });
    await approveAt(me2, eff, "2020-01-01");
    const st = await boardPolicy.resolveState(eff._id, "GST_TAX_POLICY");
    expect(st.state).toBe(S.EFFECTIVE);
    /* What a DEPARTMENT reads: presence and dates, never the treatment. */
    expect(JSON.stringify({ ...st, effective: undefined }))
      .not.toMatch(/RECOVERABLE|NON_RECOVERABLE/);
  });
});

/* ═══ 5 · THE OTHER THREE POLICIES, AND CUSTOMS DUTY ══════════════════════ */

describe("adding a fourth policy changed nothing about the first three", () => {
  test("each key is its own record with its own payload", async () => {
    const co = await company("AllFour");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2026-01-01");
    await call("/OVERHEAD/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: { overhead: { ratePercent: "12", basis: "DIRECT_PLUS_FIXED" } },
    });

    const g = await call("/GST_TAX_POLICY", { token: me.token, company: co._id });
    expect(g.body.versions).toHaveLength(1);
    expect(g.body.versions[0].policyKey).toBe("GST_TAX_POLICY");
    expect(await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "GST_TAX_POLICY", new Date())).toBeTruthy();
  });

  test("a body carrying another policy's payload writes none of it", async () => {
    const co = await company("CrossPayload");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await call("/GST_TAX_POLICY/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: {
        gst: { inputGstTreatment: "RECOVERABLE" },
        overhead: { ratePercent: "99" },
        labour: { employerBurdenPercent: "99" },
      },
    });
    const doc = await BoardPolicy.findById(made.body.version._id).lean();
    expect(doc.gst.inputGstTreatment).toBe("RECOVERABLE");
    expect(doc.overhead?.ratePercent).toBeUndefined();
    expect(doc.labour?.employerBurdenPercent).toBeUndefined();
  });

  test("each policy keeps its own completeness rule", () => {
    expect(boardPolicy.gstGaps({}).map((g) => g.field)).toEqual(["inputGstTreatment"]);
    expect(boardPolicy.gstGaps({ inputGstTreatment: "RECOVERABLE" })).toEqual([]);
    expect(boardPolicy.overheadGaps({}).length).toBe(2);
    expect(boardPolicy.labourGaps({}).length).toBe(3);
    expect(boardPolicy.financingGaps({}).length).toBe(4);
    /* A complete GST payload is not a complete anything else. */
    expect(boardPolicy.overheadGaps({ inputGstTreatment: "RECOVERABLE" }).length).toBe(2);
  });

  test("customs duty is NOT this policy — it is its own, on its own record", () => {
    /* ── THE CONFUSION THIS GUARDS AGAINST ─────────────────────────────
       Costing reports duty and non-recoverable input tax under one `duty`
       family because both are tax that stays with the company. They are
       different taxes on different events under different classifications,
       and merging them into one Board policy would make neither answerable.

       Duty has its own record now. What this test still guards is that they
       are TWO — the half that mattered all along. */
    const { BOARD_POLICIES } = require("../../services/centralCosting/sourceApps");
    const gst = BOARD_POLICIES.find((p) => p.key === "GST_TAX_POLICY");
    const duty = BOARD_POLICIES.find((p) => p.key === "DUTY_POLICY");
    expect(gst.boardPolicyKey).toBe("GST_TAX_POLICY");
    expect(duty.boardPolicyKey).toBe("DUTY_POLICY");
    /* Two keys, never one. */
    expect(duty.boardPolicyKey).not.toBe(gst.boardPolicyKey);
    expect(duty.policyField).toBeNull();
    const KEYS = require("../../models/CMS_Models/Board/BoardPolicy").POLICY_KEYS;
    expect(KEYS).toContain("DUTY_POLICY");
    expect(KEYS).toContain("GST_TAX_POLICY");

    /* And the readiness contract names them as two separate facts. */
    const readiness = require("../../services/centralCosting/inputReadiness");
    const facts = readiness.FAMILY_BY_KEY.duty.facts.map((f) => f.key);
    expect(facts).toContain("INPUT_GST_TREATMENT");
    expect(facts).toContain("CUSTOMS_CLASSIFICATION");
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
    expect(r.body.error.details.allowed)
      .toEqual(["FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY", "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY"]);
  });
});
