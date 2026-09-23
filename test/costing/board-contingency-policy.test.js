// test/costing/board-contingency-policy.test.js
//
// THE SIXTH POLICY ON THE BOARD LIFECYCLE: STANDARD CONTINGENCY.
//
// ── THE FIRST ONE WHERE "NO" IS AN ANSWER ───────────────────────────────────
// Every other policy in this lane resolves to "in force" or "not decided".
// This one has a third state, and it is the whole reason it needed migrating:
//
//   APPLIED        a rate on a stated subtotal, charged by the engine.
//   DECIDED_NONE   the Board considered it and decided the company adds none.
//                  Nothing is charged, and the version records who decided
//                  that, when, and why.
//   POLICY_MISSING nobody has decided.
//
// Under `CostingPolicy.contingencyRatePercent` the last two were one record:
// an absent rate produced no line and said nothing, so a company that had
// deliberately chosen to carry no contingency was indistinguishable from one
// where the question had never been asked — in the costing and in the frozen
// version afterwards.
//
// ── AND A LATENT BREAKAGE THIS CLOSES ───────────────────────────────────────
// The engine synthesises contingency as a `MISC` line, and four of the eleven
// bases INCLUDE `MISC`. A costing charged on one of those is refused entirely
// with `CIRCULAR_PERCENT_BASIS` — not the line, the whole costing. The retired
// writer accepted all eleven, so it was discoverable only by raising a costing
// and having it fail. This contract refuses them by name, at the one moment
// somebody can still choose differently.
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
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const boardPolicy = require("../../services/board/boardPolicy.service");
const contingencyPolicy = require("../../services/centralCosting/contingencyPolicy.service");
const { BASES } = require("../../services/centralCosting/engine");

let server, base, rs, seq = 0;

const KEY = "CONTINGENCY_POLICY";

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_contingency" });
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
  const email = `cg${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `G${n}`, email, biometricId: `CG${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
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

const APPLY = { mode: "APPLY", ratePercent: "2", basis: "PRIME" };
const NONE = { mode: "NONE" };

const startDraft = (me, co, body = {}) =>
  call(`/${KEY}/drafts`, { method: "POST", token: me.token, company: co._id, body });

const approveDraft = (me, co, id, effectiveFrom) =>
  call(`/${KEY}/drafts/${id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom },
  });

/** Draft → approve, the whole act. */
async function publish(me, co, contingency, { effectiveFrom = "2026-04-01", rationale = "Board minute." } = {}) {
  const started = await startDraft(me, co, { contingency, rationale });
  if (started.status !== 201) return started;
  return approveDraft(me, co, started.body.version._id, effectiveFrom);
}

const read = (me, co) => call(`/${KEY}`, { token: me.token, company: co._id });
const effective = (res) =>
  (res.body.versions || []).find((v) => String(v._id) === String(res.body.effectiveId)) || null;

/* ═══ 1 · NOTHING BY DEFAULT, AND SILENCE IS NOT A DECISION ═══════════════ */

describe("a company starts with no contingency decision", () => {
  test("nothing is seeded, and no rate is invented", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await read(me, co);
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
  });

  test("with no policy the resolver says so, and does not report a decision of none", async () => {
    /* ── THE DISTINCTION THE WHOLE MIGRATION TURNS ON ─────────────────
       "Nobody has decided" and "the Board decided none" produce the same
       costing — no contingency line — and must not produce the same RECORD. */
    const co = await company("Undecided");
    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("POLICY_MISSING");
    expect(resolved.mode).toBeNull();
    expect(resolved.missing[0].owner.department).toBe("Board");
    expect(resolved.missing[0].message).toMatch(/not the same as the company having decided not to/);
    /* And the overlay fills neither name, so the engine synthesises no line. */
    expect(contingencyPolicy.overlayFor(resolved)).toEqual({
      contingencyRatePercent: undefined, contingencyBasis: undefined,
    });
  });
});

/* ═══ 2 · TWO DECISIONS, AND A THIRD ANSWER INSIDE ONE OF THEM ════════════ */

describe("the decision the Board actually makes", () => {
  test("applying a contingency fills the two names the engine reads", async () => {
    const co = await company("Applying");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, APPLY)).status).toBe(200);

    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("APPLIED");
    expect(contingencyPolicy.overlayFor(resolved)).toEqual({
      contingencyRatePercent: "2", contingencyBasis: "PRIME",
    });
  });

  test("deciding NONE is a policy in force that charges nothing", async () => {
    const co = await company("DecidedNone");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, NONE, { rationale: "Risk is carried in the margin band." })).status).toBe(200);

    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("DECIDED_NONE");
    expect(resolved.mode).toBe("NONE");
    /* An ANSWER: nothing is outstanding. */
    expect(resolved.missing).toEqual([]);
    /* ── AND IT OVERLAYS NOTHING, NOT A ZERO ──────────────────────────
       A "0" would put a contingency line on every costing of a company that
       does not have contingency, and the two decisions would stop being
       tellable apart in exactly the record that must keep them apart. */
    expect(contingencyPolicy.overlayFor(resolved)).toEqual({
      contingencyRatePercent: undefined, contingencyBasis: undefined,
    });
  });

  test("an explicit 0% is a third answer, and is NOT the same record as NONE", async () => {
    const co = await company("ExplicitZero");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, { mode: "APPLY", ratePercent: "0", basis: "PRIME" })).status).toBe(200);

    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("APPLIED");
    /* The engine gets a rate, so it synthesises a real line at nil — which a
       later Board can raise without changing the shape of the cost sheet. */
    expect(contingencyPolicy.overlayFor(resolved)).toEqual({
      contingencyRatePercent: "0", contingencyBasis: "PRIME",
    });
    expect(resolved.state).not.toBe("DECIDED_NONE");
  });

  test("switching to NONE clears the rate rather than storing one it does not apply", async () => {
    const co = await company("Switching");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, { contingency: APPLY, rationale: "First thought." });
    const changed = await call(`/${KEY}/drafts/${started.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: started.body.version.revision, contingency: { mode: "NONE" } },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.version.contingency.mode).toBe("NONE");
    expect(changed.body.version.contingency.ratePercent).toBeFalsy();
    expect(changed.body.version.contingency.basis).toBeFalsy();
  });
});

/* ═══ 3 · WHAT CANNOT BE APPROVED ═════════════════════════════════════════ */

describe("what a contingency decision must state", () => {
  test("a draft with no mode has made no decision, and cannot be approved", async () => {
    const co = await company("NoMode");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps[0].field).toBe("mode");
  });

  test("a decision NOT to apply one cannot be approved without its reason", async () => {
    /* The only place on this lifecycle where the rationale is completeness:
       a nil contingency with no reason reads exactly like an oversight. */
    const co = await company("NoneNoReason");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, NONE, { rationale: "" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps[0].field).toBe("rationale");
    expect(r.body.error.details.gaps[0].message).toMatch(/indistinguishable from nobody having considered it/);
  });

  test("applying one needs both a rate and something to charge it on", async () => {
    const co = await company("HalfARule");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, { mode: "APPLY" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.gaps.map((g) => g.field).sort()).toEqual(["basis", "ratePercent"]);
  });
});

/* ═══ 4 · THE BASIS THAT WOULD MAKE EVERY COSTING UNCALCULABLE ════════════ */

describe("a basis a costing could actually be charged on", () => {
  test("the four bases containing the contingency line itself are refused by name", async () => {
    const co = await company("Circular");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    for (const basis of ["DIRECT", "DIRECT_PLUS_FIXED", "SUBTOTAL_BEFORE_OVERHEAD", "SUBTOTAL_BEFORE_FINANCING"]) {
      const r = await startDraft(me, co, { contingency: { mode: "APPLY", ratePercent: "2", basis } });
      expect([basis, r.status]).toEqual([basis, 400]);
      expect(r.body.error.details.reason).toBe("CONTINGENCY_BASIS_CIRCULAR");
      expect(r.body.error.message).toMatch(/already includes the contingency line itself/);
    }
  });

  test("and those four are exactly the ones the engine says include MISC", async () => {
    /* Derived, not listed: a basis added to the engine is classified by the
       same rule that made these four unusable. */
    const circular = Object.entries(BASES)
      .filter(([, cats]) => cats.includes("MISC")).map(([k]) => k).sort();
    expect(circular).toEqual(
      ["DIRECT", "DIRECT_PLUS_FIXED", "SUBTOTAL_BEFORE_FINANCING", "SUBTOTAL_BEFORE_OVERHEAD"],
    );
    expect(boardPolicy.CONTINGENCY_BASES.some((b) => circular.includes(b))).toBe(false);
  });

  test("a basis nothing knows is refused as unknown, not as circular", async () => {
    const co = await company("Unknown");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await startDraft(me, co, { contingency: { mode: "APPLY", ratePercent: "2", basis: "MOONLIGHT" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("BASIS_UNKNOWN");
  });

  test("the vocabulary endpoint offers only what the server will accept", async () => {
    const co = await company("Vocabulary");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await call("/vocabulary", { token: me.token, company: co._id });
    expect(r.body.contingencyModes).toEqual(["APPLY", "NONE"]);
    expect(r.body.contingencyBases).toEqual(
      ["MATERIALS", "OPERATIONS", "SERVICES", "PACKAGING", "PRIME", "CONVERSION", "FIXED"],
    );
  });
});

/* ═══ 5 · THE LIFECYCLE, ON THIS KEY ══════════════════════════════════════ */

describe("draft, approval and effective dating", () => {
  test("an approved decision cannot be edited; a change is a new version", async () => {
    const co = await company("Immutable");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, { contingency: APPLY, rationale: "First." });
    await approveDraft(me, co, started.body.version._id, "2026-04-01");
    const r = await call(`/${KEY}/drafts/${started.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, contingency: { mode: "APPLY", ratePercent: "9", basis: "PRIME" } },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
  });

  test("a future decision does not apply before its date, and does after", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, APPLY, { effectiveFrom: "2026-04-01" });
    await publish(me, co, { mode: "APPLY", ratePercent: "3", basis: "PRIME" }, { effectiveFrom: "2026-10-01" });

    const before = await contingencyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-09-30") });
    expect(before.ratePercent).toBe("2");
    const after = await contingencyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-10-01") });
    expect(after.ratePercent).toBe("3");
  });

  test("two approvals cannot share an effective date", async () => {
    const co = await company("SameDate");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, APPLY, { effectiveFrom: "2026-04-01" })).status).toBe(200);
    const clash = await publish(me, co, NONE, { effectiveFrom: "2026-04-01", rationale: "Changed our minds." });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
  });

  test("a later decision supersedes an earlier one by date, and NONE can supersede APPLY", async () => {
    const co = await company("Superseding");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, APPLY, { effectiveFrom: "2026-04-01" });
    await publish(me, co, NONE, { effectiveFrom: "2026-07-01", rationale: "Absorbed into the margin band." });

    const q1 = await contingencyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-05-01") });
    expect(q1.state).toBe("APPLIED");
    const q3 = await contingencyPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-08-01") });
    expect(q3.state).toBe("DECIDED_NONE");

    /* Both versions stay readable exactly as approved. */
    const hist = await read(me, co);
    expect(hist.body.versions.filter((v) => v.status === "BOARD_APPROVED")).toHaveLength(2);
  });
});

/* ═══ 6 · COPYING IS NOT APPROVING ════════════════════════════════════════ */

describe("the migration door", () => {
  const withLegacy = async (co, contingencyBasis, contingencyRatePercent) =>
    CostingPolicy.create({
      companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP", revision: 1,
      contingencyBasis, contingencyRatePercent,
    });

  test("a legacy rate is offered for copying, as an APPLY decision", async () => {
    const co = await company("Legacy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, "PRIME", "1.5");

    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.status).toBe(200);
    expect(offered.body.available).toBe(true);
    /* Always APPLY: the retired shape had no way to express a decision NOT to
       add one, so it can only ever have meant "we add this much". */
    expect(offered.body.contingency).toEqual({ mode: "APPLY", ratePercent: "1.5", basis: "PRIME" });
  });

  test("a seeded draft is still a draft, and records that it was copied", async () => {
    const co = await company("Seeded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, "PRIME", "1.5");

    const started = await startDraft(me, co, { seedFrom: "LEGACY_COSTING_POLICY", rationale: "Ratifying." });
    expect(started.status).toBe(201);
    expect(started.body.version.status).toBe("DRAFT");
    expect(started.body.version.seededFrom).toBe("LEGACY_COSTING_POLICY");
    expect(started.body.version.contingency.ratePercent).toBe("1.5");
    /* Nothing is in force until somebody approves it. */
    expect((await contingencyPolicy.resolveFor({ companyId: co._id })).state).toBe("POLICY_MISSING");

    expect((await approveDraft(me, co, started.body.version._id, "2026-04-01")).status).toBe(200);
    expect((await contingencyPolicy.resolveFor({ companyId: co._id })).ratePercent).toBe("1.5");
  });

  test("an unchargeable legacy basis is dropped and named, not carried into a refusal", async () => {
    /* ── THE COMPANIES MOST IN NEED OF THIS FIX ───────────────────────
       A company storing SUBTOTAL_BEFORE_OVERHEAD has had every costing
       refused. Carrying that basis into the seed would refuse the draft too
       and leave it with no way to fix anything. */
    const co = await company("BadBasis");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, "SUBTOTAL_BEFORE_OVERHEAD", "1.5");

    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.body.available).toBe(true);
    expect(offered.body.contingency).toEqual({ mode: "APPLY", ratePercent: "1.5" });
    expect(offered.body.basisDropped).toBe("SUBTOTAL_BEFORE_OVERHEAD");

    const started = await startDraft(me, co, { seedFrom: "LEGACY_COSTING_POLICY" });
    expect(started.status).toBe(201);
    /* And the draft opens with an explicit gap asking which subtotal. */
    const hist = await read(me, co);
    expect(hist.body.gaps[String(started.body.version._id)].map((g) => g.field)).toContain("basis");
  });

  test("a company with nothing to copy is told so", async () => {
    const co = await company("NothingToCopy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.body.available).toBe(false);
    expect(offered.body.contingency).toBeNull();
  });
});

/* ═══ 7 · WHAT A VERSION FREEZES ══════════════════════════════════════════ */

describe("frozen provenance", () => {
  test("a NONE decision freezes its reason, because that IS the evidence", async () => {
    const co = await company("FreezingNone");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, NONE, { rationale: "Risk is carried in the margin band." });

    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    const frozen = contingencyPolicy.freeze({ resolved, scenarios: [] });
    expect(frozen).toMatchObject({ state: "DECIDED_NONE", mode: "NONE", policyKey: KEY });
    expect(frozen.rationale).toBe("Risk is carried in the margin band.");
    expect(frozen.policyApprovedByName).toBeTruthy();
    expect(frozen.policyEffectiveFrom).toBeTruthy();
    /* No rate, no basis, and no fabricated scenario rows. */
    expect(frozen.ratePercent).toBeNull();
    expect(frozen.scenarios).toEqual([]);
  });

  test("an APPLIED decision freezes the rule and the per-scenario working", async () => {
    const co = await company("FreezingApply");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, APPLY);

    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    const calculated = {
      scenarios: [
        { key: "q100", lines: [{ lineKey: "policy:contingency", basisAmountMinor: 1000000, totalMinor: 20000 }] },
        { key: "q500", lines: [{ lineKey: "policy:contingency", basisAmountMinor: 5000000, totalMinor: 100000 }] },
      ],
    };
    const frozen = contingencyPolicy.freeze({
      resolved, scenarios: contingencyPolicy.workingsFrom(calculated, resolved),
    });
    expect(frozen).toMatchObject({ state: "APPLIED", mode: "APPLY", ratePercent: "2", basis: "PRIME" });
    expect(frozen.scenarios).toEqual([
      { scenarioKey: "q100", basisAmountMinor: 1000000, contingencyMinor: 20000 },
      { scenarioKey: "q500", basisAmountMinor: 5000000, contingencyMinor: 100000 },
    ]);
  });

  test("there is no working behind a decision not to charge anything", async () => {
    const co = await company("NoWorking");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, NONE, { rationale: "None." });
    const resolved = await contingencyPolicy.resolveFor({ companyId: co._id });
    const calculated = { scenarios: [{ key: "q100", lines: [] }] };
    expect(contingencyPolicy.workingsFrom(calculated, resolved)).toEqual([]);
  });
});

/* ═══ 8 · THE BOUNDARY ════════════════════════════════════════════════════ */

describe("who may decide this", () => {
  test("an administrator with no Board grant reaches nothing", async () => {
    const co = await company("AdminOnly");
    const admin = await actor({ companies: [co], isAdmin: true });
    const r = await read(admin, co);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("another company's decision is not this company's", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await actor({ companies: [mine], grants: { board: "owner" } });
    const them = await actor({ companies: [theirs], grants: { board: "owner" } });
    await publish(them, theirs, APPLY);

    expect(effective(await read(me, mine))).toBeNull();
    expect((await contingencyPolicy.resolveFor({ companyId: mine._id })).state).toBe("POLICY_MISSING");
  });
});

/* ═══ 9 · THE OTHER FIVE POLICIES ARE UNCHANGED ═══════════════════════════ */

test("adding a sixth policy changed nothing about the first five", async () => {
  const co = await company("Keys");
  const me = await actor({ companies: [co], grants: { board: "owner" } });
  const r = await call("/vocabulary", { token: me.token, company: co._id });
  expect(r.body.policyKeys).toEqual([
    "FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY",
    "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY",
  ]);
  /* Each still answers on its own terms. */
  for (const key of r.body.policyKeys) {
    expect((await call(`/${key}`, { token: me.token, company: co._id })).status).toBe(200);
  }
});
