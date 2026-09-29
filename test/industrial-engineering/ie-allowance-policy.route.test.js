// test/industrial-engineering/ie-allowance-policy.route.test.js
//
// IE CHUNK 4B — THE COMPANY ALLOWANCE POLICY, AT THE WIRE.
//
// An allowance policy raises or lowers every standard time in the factory, so
// the claims worth holding are the ones that stop it being changed quietly:
//
//   · a company holds ONE draft, and the database is what says so;
//   · the person who publishes is never the person who wrote it — and an owner
//     or platform administrator gets no exemption, because maker-checker is
//     about who somebody IS, not what their grant permits;
//   · a published policy is frozen for ever: a newer decision is a NEW record
//     with its own effective date, and the old one stays as the reason last
//     season's figure was what it was;
//   · the policy applicable to a date is the published one with the latest
//     effective date not after it — never "the newest policy", and never a
//     silent fallback when there is none;
//   · a category keeps its id through renaming and reordering;
//   · and totals are summed by the server, bounded, and deterministic.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const IeAllowancePolicy = require("../../models/CMS_Models/IndustrialEngineering/IeAllowancePolicy");

const {
  calculateStandardTime, totalAllowancePercentOf,
} = require("../../services/industrialEngineering/standardTimeCalculation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  /* The one-draft and one-published-date rules are claims about INDEXES. */
  await IeAllowancePolicy.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ap${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `P${n}`, email, biometricId: `AP${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `IE Person ${n}`, role: "employee", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const approverIn = (...cos) => actor({ companies: cos, grants: { ie: "approver" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

const CATEGORIES = [
  { code: "PERSONAL", name: "Personal allowance", percent: 5 },
  { code: "FATIGUE", name: "Fatigue allowance", percent: 8 },
  { code: "DELAY", name: "Unavoidable delay", percent: 2.5 },
];

const draft = (a, co, body) => call("/allowance-policies", { method: "POST", token: a.token, company: co._id, body });
const patch = (a, co, policyId, body) => call(`/allowance-policies/${policyId}`, {
  method: "PATCH", token: a.token, company: co._id, body,
});
const publish = (a, co, policyId, expectedRevision) => call(`/allowance-policies/${policyId}/publish`, {
  method: "POST", token: a.token, company: co._id, body: { expectedRevision },
});

/** A published policy, made properly: an editor writes it, an approver publishes. */
async function published(co, { name = "Standard sewing allowance", effectiveFrom, categories = CATEGORIES } = {}) {
  const maker = await editorIn(co);
  const checker = await approverIn(co);
  const created = await draft(maker, co, { name, effectiveFrom, categories });
  expect(created.status).toBe(201);
  const out = await publish(checker, co, created.body.policy.policyId, created.body.policy.revision);
  expect(out.status).toBe(200);
  return { policy: out.body.policy, maker, checker };
}

/* ══ 1. DRAFTING ══════════════════════════════════════════════════════════ */

describe("drafting a policy", () => {
  test("an editor drafts one, and the server sums it", async () => {
    const co = await company("Draft");
    const a = await editorIn(co);
    const res = await draft(a, co, {
      name: "  Standard   sewing allowance ", effectiveFrom: "2026-09-01", categories: CATEGORIES,
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const p = res.body.policy;
    expect(p).toMatchObject({
      name: "Standard sewing allowance",
      effectiveFrom: "2026-09-01",
      status: "DRAFT",
      revision: 1,
      editable: true,
      totalAllowancePercent: 15.5,
      categoryCount: 3,
    });
    expect(p.categories.map((c) => c.sequence)).toEqual([1, 2, 3]);
    expect(p.categories.every((c) => /^cat_[0-9a-f]{18}$/.test(c.categoryId))).toBe(true);
    expect(p.history.map((e) => e.type)).toEqual(["ALLOWANCE_POLICY_CREATED"]);
    expect(p.createdByName).toMatch(/^IE Person /);
  });

  test("a company holds one draft, and the database says so", async () => {
    const co = await company("OneDraft");
    const a = await editorIn(co);
    const first = await draft(a, co, { name: "First", effectiveFrom: "2026-09-01", categories: [] });
    expect(first.status).toBe(201);

    const second = await draft(a, co, { name: "Second", effectiveFrom: "2026-10-01", categories: [] });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("IE_ALLOWANCE_POLICY_DRAFT_EXISTS");
    expect(second.body.error.details.policyId).toBe(first.body.policy.policyId);
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(1);

    const indexes = await IeAllowancePolicy.collection.indexes();
    expect(indexes.find((i) => i.name === "ie_allowance_policy_one_draft_per_company"))
      .toMatchObject({ unique: true, partialFilterExpression: { status: "DRAFT" } });
  });

  test("four simultaneous drafts produce one", async () => {
    const co = await company("RaceDraft");
    const a = await editorIn(co);
    const send = () => draft(a, co, { name: "Race", effectiveFrom: "2026-09-01", categories: [] });
    const results = await Promise.all([send(), send(), send(), send()]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const loser of results.filter((r) => r.status !== 201)) {
      expect(loser.status).toBe(409);
      expect(loser.body.error.code).toBe("IE_ALLOWANCE_POLICY_DRAFT_EXISTS");
    }
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("a category keeps its id through renaming and reordering", async () => {
    const co = await company("StableCategories");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });
    const [personal, fatigue, delay] = created.body.policy.categories;

    const edited = await patch(a, co, created.body.policy.policyId, {
      expectedRevision: 1,
      categories: [
        { categoryId: delay.categoryId, code: "DELAY", name: "Unavoidable delay", percent: 3 },
        { categoryId: personal.categoryId, code: "PERSONAL", name: "Personal needs", percent: 5 },
        { categoryId: fatigue.categoryId, code: "FATIGUE", name: "Fatigue allowance", percent: 8 },
        { code: "SPECIAL", name: "Special allowance", percent: 1 },
      ],
    });

    expect(edited.status).toBe(200);
    expect(edited.body.updated).toBe(true);
    const cats = edited.body.policy.categories;
    expect(cats.map((c) => c.categoryId).slice(0, 3))
      .toEqual([delay.categoryId, personal.categoryId, fatigue.categoryId]);
    expect(cats.map((c) => c.sequence)).toEqual([1, 2, 3, 4]);
    expect(cats[1].name).toBe("Personal needs");
    expect(cats[3].categoryId).not.toBe(personal.categoryId);
    expect(edited.body.policy.totalAllowancePercent).toBe(17);
    expect(edited.body.policy.revision).toBe(2);

    const unknown = await patch(a, co, created.body.policy.policyId, {
      expectedRevision: 2,
      categories: [{ categoryId: "cat_deadbeefdeadbeefde", code: "X", name: "X", percent: 1 }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("IE_ALLOWANCE_CATEGORY_INVALID");
    expect(unknown.body.error.details.fieldErrors[0].field).toBe("categories.0.categoryId");
  });

  test("categories are validated, and a duplicate code is its own refusal", async () => {
    const co = await company("CategoryRules");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: [] });
    const id = created.body.policy.policyId;

    const bad = [
      [[{ code: "P", name: "P", percent: -1 }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.percent"],
      [[{ code: "P", name: "P", percent: 101 }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.percent"],
      [[{ code: "P", name: "P", percent: "5" }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.percent"],
      [[{ code: "", name: "P", percent: 5 }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.code"],
      [[{ code: "-BAD", name: "P", percent: 5 }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.code"],
      [[{ code: "P", name: "", percent: 5 }], "IE_ALLOWANCE_CATEGORY_INVALID", "categories.0.name"],
    ];
    for (const [categories, code, field] of bad) {
      const res = await patch(a, co, id, { expectedRevision: 1, categories });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
      expect(res.body.error.details.field).toBe(field);
    }

    /* Two categories sharing a code make a frozen snapshot unreadable. */
    const dup = await patch(a, co, id, {
      expectedRevision: 1,
      categories: [
        { code: "personal", name: "Personal", percent: 5 },
        { code: "PERSONAL", name: "Personal again", percent: 3 },
      ],
    });
    expect(dup.status).toBe(400);
    expect(dup.body.error.code).toBe("IE_ALLOWANCE_CATEGORY_CODE_DUPLICATE");
    expect(dup.body.error.details.code).toBe("PERSONAL");

    const over = await patch(a, co, id, {
      expectedRevision: 1,
      categories: [{ code: "A", name: "A", percent: 60 }, { code: "B", name: "B", percent: 45 }],
    });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("IE_ALLOWANCE_TOTAL_OUT_OF_RANGE");
    expect(over.body.error.details.totalAllowancePercent).toBe(105);

    /* Nothing was half-written by any of that. */
    const stored = await IeAllowancePolicy.findById(id).lean();
    expect(stored.revision).toBe(1);
    expect(stored.categories).toEqual([]);
    expect(stored.totalAllowancePercent).toBe(0);
  });

  test("the total is deterministic, and an empty policy is a deliberate 0%", async () => {
    expect(totalAllowancePercentOf([{ percent: 5 }, { percent: 8 }, { percent: 2.5 }])).toBe(15.5);
    expect(totalAllowancePercentOf([...CATEGORIES])).toBe(15.5);
    expect(totalAllowancePercentOf([])).toBe(0);

    const co = await company("ZeroPolicy");
    const { policy } = await published(co, { effectiveFrom: "2026-09-01", categories: [] });
    expect(policy.totalAllowancePercent).toBe(0);
    expect(policy.categories).toEqual([]);
    /* A published 0% policy IS a policy: standard time equals normal time. */
    expect(calculateStandardTime({ normalTimeSeconds: 60, totalAllowancePercent: 0 }))
      .toMatchObject({ standardTimeSeconds: 60, standardTimeMinutes: 1, calculationComplete: true });
  });

  test("a save that changes nothing changes nothing", async () => {
    const co = await company("PolicyNoOp");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });
    const before = await IeAllowancePolicy.findById(created.body.policy.policyId).lean();

    const res = await patch(a, co, created.body.policy.policyId, {
      expectedRevision: 1,
      name: "  P  ",
      effectiveFrom: "2026-09-01",
      categories: created.body.policy.categories.map((c) => ({
        categoryId: c.categoryId, code: c.code, name: c.name, percent: c.percent, note: c.note,
      })),
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    const after = await IeAllowancePolicy.findById(created.body.policy.policyId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("a stale edit conflicts, and a published policy refuses edits by name", async () => {
    const co = await company("PolicyConflicts");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: [] });
    const id = created.body.policy.policyId;
    await patch(a, co, id, { expectedRevision: 1, name: "P2" });

    const stale = await patch(a, co, id, { expectedRevision: 1, name: "P3" });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_ALLOWANCE_POLICY_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: 1, actual: 2 });

    const checker = await approverIn(co);
    expect((await publish(checker, co, id, 2)).status).toBe(200);

    const frozen = await patch(a, co, id, { expectedRevision: 3, name: "P4" });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED");
    expect((await IeAllowancePolicy.findById(id).lean()).name).toBe("P2");
  });

  test("server-owned and unknown fields are refused", async () => {
    const co = await company("PolicyFields");
    const a = await editorIn(co);
    for (const body of [
      { name: "P", effectiveFrom: "2026-09-01", status: "PUBLISHED" },
      { name: "P", effectiveFrom: "2026-09-01", revision: 4 },
      { name: "P", effectiveFrom: "2026-09-01", totalAllowancePercent: 10 },
      { name: "P", effectiveFrom: "2026-09-01", publishedBy: String(new mongoose.Types.ObjectId()) },
      { name: "P", effectiveFrom: "2026-09-01", wageRate: 500 },
      { name: "P", effectiveFrom: "2026-09-01", costingAllowance: 5 },
      { name: "P", effectiveFrom: "2026-09-01", colour: "blue" },
      { name: "P", effectiveFrom: "2026-09-01", categories: [{ code: "A", name: "A", percent: 1, sequence: 3 }] },
    ]) {
      const res = await draft(a, co, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(0);
  });
});

/* ══ 1b. OMITTED CATEGORIES ARE NOT AN EMPTY POLICY ═══════════════════════
 *
 * `categories: []` is a company deciding that no allowances apply. A MISSING
 * `categories` is a request that did not send them. Treating the two alike let
 * a payload that lost its categories become a published 0% policy, which
 * silently shortens every standard time calculated against it. */

describe("a 0% policy has to be said, not inferred", () => {
  test("creating without categories is refused, and creates nothing", async () => {
    const co = await company("CategoriesRequired");
    const a = await editorIn(co);
    const res = await draft(a, co, { name: "No categories", effectiveFrom: "2026-09-01" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_ALLOWANCE_CATEGORY_INVALID");
    expect(res.body.error.details.field).toBe("categories");
    expect(res.body.error.details.fieldErrors[0]).toMatchObject({ field: "categories", code: "REQUIRED" });
    expect(res.body.message).toMatch(/empty list/i);
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(0);

    /* Null and non-arrays are refused too — an array is what the field is. */
    for (const categories of [null, "PERSONAL", 5, { code: "P" }]) {
      const bad = await draft(a, co, { name: "Bad", effectiveFrom: "2026-09-01", categories });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("IE_ALLOWANCE_CATEGORY_INVALID");
      expect(bad.body.error.details.fieldErrors[0].code).toBe("NOT_A_LIST");
    }
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("creating with an explicit empty list is a deliberate 0% policy", async () => {
    const co = await company("DeliberateZero");
    const a = await editorIn(co);
    const res = await draft(a, co, { name: "No allowances", effectiveFrom: "2026-09-01", categories: [] });

    expect(res.status).toBe(201);
    expect(res.body.policy).toMatchObject({ totalAllowancePercent: 0, categoryCount: 0 });
    expect(res.body.policy.categories).toEqual([]);
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("a PATCH that omits categories preserves them", async () => {
    const co = await company("PatchPreserves");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });

    const res = await patch(a, co, created.body.policy.policyId, { expectedRevision: 1, name: "Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.policy.name).toBe("Renamed");
    expect(res.body.policy.categories.map((c) => c.code)).toEqual(["PERSONAL", "FATIGUE", "DELAY"]);
    expect(res.body.policy.totalAllowancePercent).toBe(15.5);
    /* And the ids came through untouched. */
    expect(res.body.policy.categories.map((c) => c.categoryId))
      .toEqual(created.body.policy.categories.map((c) => c.categoryId));
  });

  test("a PATCH that sends an empty list clears the draft to 0%", async () => {
    const co = await company("PatchClears");
    const a = await editorIn(co);
    const created = await draft(a, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });

    const res = await patch(a, co, created.body.policy.policyId, { expectedRevision: 1, categories: [] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.policy.categories).toEqual([]);
    expect(res.body.policy.totalAllowancePercent).toBe(0);
    expect((await IeAllowancePolicy.findById(created.body.policy.policyId).lean()).totalAllowancePercent).toBe(0);
  });
});

/* ══ 2. PUBLISHING IS THE MAKER-CHECKER STEP ══════════════════════════════ */

describe("publishing", () => {
  test("the creator cannot publish their own policy — owner or admin included", async () => {
    const co = await company("MakerChecker");
    const maker = await actor({ companies: [co], grants: { ie: "owner" } });
    const created = await draft(maker, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });
    const id = created.body.policy.policyId;

    const own = await publish(maker, co, id, 1);
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("IE_ALLOWANCE_POLICY_MAKER_CHECKER");
    expect(own.body.error.details.reason).toBe("PUBLISHER_IS_CREATOR");

    /* A platform administrator is refused on identical terms: the rule is about
       who they are, not what their grant permits. */
    const adminCo = await company("AdminMaker");
    const admin = await actor({ companies: [adminCo], grants: {}, isAdmin: true });
    const adminDraft = await draft(admin, adminCo, { name: "P", effectiveFrom: "2026-09-01", categories: [] });
    expect(adminDraft.status).toBe(201);
    const adminSelfPublish = await publish(admin, adminCo, adminDraft.body.policy.policyId, 1);
    expect(adminSelfPublish.status).toBe(403);
    expect(adminSelfPublish.body.error.code).toBe("IE_ALLOWANCE_POLICY_MAKER_CHECKER");

    expect((await IeAllowancePolicy.findById(id).lean()).status).toBe("DRAFT");
  });

  test("the last editor cannot publish it either", async () => {
    const co = await company("LastEditor");
    const maker = await editorIn(co);
    const second = await approverIn(co);
    const created = await draft(maker, co, { name: "P", effectiveFrom: "2026-09-01", categories: CATEGORIES });
    const id = created.body.policy.policyId;

    /* The approver edits it — and by doing so becomes the person who may not
       publish it. */
    expect((await patch(second, co, id, { expectedRevision: 1, name: "P edited" })).status).toBe(200);
    const own = await publish(second, co, id, 2);
    expect(own.status).toBe(403);
    expect(own.body.error.details.reason).toBe("PUBLISHER_IS_LAST_EDITOR");

    const third = await approverIn(co);
    const ok = await publish(third, co, id, 2);
    expect(ok.status).toBe(200);
    expect(ok.body.published).toBe(true);
    expect(ok.body.policy).toMatchObject({ status: "PUBLISHED", editable: false, revision: 3 });
    expect(ok.body.policy.publishedByName).toMatch(/^IE Person /);
    expect(ok.body.policy.history.map((e) => e.type))
      .toEqual(["ALLOWANCE_POLICY_PUBLISHED", "ALLOWANCE_POLICY_EDITED", "ALLOWANCE_POLICY_CREATED"]);
  });

  test("an editor may not publish and a viewer may not draft", async () => {
    const co = await company("PolicyRoles");
    const maker = await editorIn(co);
    const created = await draft(maker, co, { name: "P", effectiveFrom: "2026-09-01", categories: [] });

    const otherEditor = await editorIn(co);
    const refused = await publish(otherEditor, co, created.body.policy.policyId, 1);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    expect(refused.body.error.details.requires).toEqual({ department: "ie", minimumRole: "approver" });

    const viewer = await viewerIn(co);
    expect((await draft(viewer, co, { name: "V", effectiveFrom: "2026-10-01", categories: [] })).status).toBe(403);
    expect((await patch(viewer, co, created.body.policy.policyId, { expectedRevision: 1, name: "V" })).status).toBe(403);
    /* A viewer reads. */
    expect((await call("/allowance-policies", { token: viewer.token, company: co._id })).status).toBe(200);
    expect((await call(`/allowance-policies/${created.body.policy.policyId}`, { token: viewer.token, company: co._id })).status).toBe(200);
  });

  test("publishing twice, and publishing a stale revision, are refused", async () => {
    const co = await company("PublishTwice");
    const { policy, checker } = await published(co, { effectiveFrom: "2026-09-01" });
    const again = await publish(checker, co, policy.policyId, policy.revision);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED");

    const co2 = await company("PublishStale");
    const maker = await editorIn(co2);
    const created = await draft(maker, co2, { name: "P", effectiveFrom: "2026-09-01", categories: [] });
    await patch(maker, co2, created.body.policy.policyId, { expectedRevision: 1, name: "P2" });
    const approver = await approverIn(co2);
    const stale = await publish(approver, co2, created.body.policy.policyId, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_ALLOWANCE_POLICY_REVISION_CONFLICT");
    expect((await IeAllowancePolicy.findById(created.body.policy.policyId).lean()).status).toBe("DRAFT");
  });

  test("two published policies cannot share an effective date", async () => {
    const co = await company("DateTaken");
    await published(co, { effectiveFrom: "2026-09-01" });

    const maker = await editorIn(co);
    const created = await draft(maker, co, { name: "Second", effectiveFrom: "2026-09-01", categories: [] });
    const checker = await approverIn(co);
    const refused = await publish(checker, co, created.body.policy.policyId, 1);

    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_ALLOWANCE_POLICY_EFFECTIVE_DATE_TAKEN");
    expect(refused.body.error.details.effectiveFrom).toBe("2026-09-01");
    expect((await IeAllowancePolicy.findById(created.body.policy.policyId).lean()).status).toBe("DRAFT");
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id, status: "PUBLISHED" })).toBe(1);
  });

  test("publishing a newer policy leaves the older one exactly as it was", async () => {
    const co = await company("History");
    const first = await published(co, { name: "2026 H1", effectiveFrom: "2026-01-01", categories: [{ code: "PERSONAL", name: "Personal", percent: 5 }] });
    const before = await IeAllowancePolicy.findById(first.policy.policyId).lean();
    const second = await published(co, { name: "2026 H2", effectiveFrom: "2026-07-01", categories: [{ code: "PERSONAL", name: "Personal", percent: 9 }] });

    const after = await IeAllowancePolicy.findById(first.policy.policyId).lean();
    expect(after.totalAllowancePercent).toBe(5);
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(second.policy.totalAllowancePercent).toBe(9);
    expect(await IeAllowancePolicy.countDocuments({ companyId: co._id, status: "PUBLISHED" })).toBe(2);
  });
});

/* ══ 3. WHICH POLICY APPLIES ══════════════════════════════════════════════ */

describe("the effective policy for a date", () => {
  async function threePolicies() {
    const co = await company("Effective");
    const jan = await published(co, { name: "January", effectiveFrom: "2026-01-01", categories: [{ code: "P", name: "P", percent: 5 }] });
    const jun = await published(co, { name: "June", effectiveFrom: "2026-06-01", categories: [{ code: "P", name: "P", percent: 10 }] });
    const sep = await published(co, { name: "September", effectiveFrom: "2026-09-01", categories: [{ code: "P", name: "P", percent: 15 }] });
    return { co, jan, jun, sep };
  }
  const effective = (a, co, at) => call(`/allowance-policies/effective?at=${at}`, { token: a.token, company: co._id });

  test("the latest effective date not after the asked-for day — never the newest", async () => {
    const { co, jan, jun, sep } = await threePolicies();
    const a = await viewerIn(co);

    for (const [at, expected] of [
      ["2026-01-01", jan], ["2026-05-31", jan],
      ["2026-06-01", jun], ["2026-07-15", jun], ["2026-08-31", jun],
      ["2026-09-01", sep], ["2027-04-01", sep],
    ]) {
      const res = await effective(a, co, at);
      expect(res.status).toBe(200);
      expect(res.body.requestedDate).toBe(at);
      expect(res.body.policy.policyId).toBe(expected.policy.policyId);
      expect(res.body.policy.status).toBe("PUBLISHED");
    }
    /* Mid-July resolves to JUNE, not to the newest policy. */
    expect((await effective(a, co, "2026-07-15")).body.policy.name).toBe("June");
  });

  test("a date before any policy is an explicit refusal, not a fallback", async () => {
    const { co } = await threePolicies();
    const a = await viewerIn(co);
    const res = await effective(a, co, "2025-12-31");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_ALLOWANCE_POLICY_NOT_EFFECTIVE");
    expect(res.body.error.details.requestedDate).toBe("2025-12-31");
    expect(res.body.message).toMatch(/2025-12-31/);
  });

  test("a draft is never effective", async () => {
    const co = await company("DraftNotEffective");
    const maker = await editorIn(co);
    await draft(maker, co, { name: "Unpublished", effectiveFrom: "2026-01-01", categories: [{ code: "P", name: "P", percent: 5 }] });
    const a = await viewerIn(co);
    const res = await effective(a, co, "2026-09-01");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_ALLOWANCE_POLICY_NOT_EFFECTIVE");
  });

  test("a missing or malformed date is refused by name", async () => {
    const { co } = await threePolicies();
    const a = await viewerIn(co);
    for (const at of ["", "not-a-date"]) {
      const res = await effective(a, co, at);
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("effectiveFrom");
    }
  });
});

/* ══ 4. COMPANY ISOLATION ═════════════════════════════════════════════════ */

describe("whose policy it is", () => {
  test("a foreign policy is indistinguishable from one that never existed", async () => {
    const theirs = await company("TheirPolicies");
    const theirPolicy = await published(theirs, { name: "Their allowance", effectiveFrom: "2026-01-01" });

    const mine = await company("MyPolicies");
    const a = await editorIn(mine);
    const approver = await approverIn(mine);

    const foreign = await call(`/allowance-policies/${theirPolicy.policy.policyId}`, { token: a.token, company: mine._id });
    const invented = await call(`/allowance-policies/${new mongoose.Types.ObjectId()}`, { token: a.token, company: mine._id });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(invented.body);
    expect(foreign.body.error.code).toBe("IE_ALLOWANCE_POLICY_NOT_FOUND");
    expect(JSON.stringify(foreign.body)).not.toMatch(/Their allowance|PERSONAL|2026-01-01/);

    const foreignPatch = await patch(a, mine, theirPolicy.policy.policyId, { expectedRevision: 3, name: "Mine now" });
    expect(foreignPatch.status).toBe(404);
    const foreignPublish = await publish(approver, mine, theirPolicy.policy.policyId, 3);
    expect(foreignPublish.status).toBe(404);

    /* Their list and their effective policy are not mine. */
    const list = await call("/allowance-policies", { token: a.token, company: mine._id });
    expect(list.body.policies).toEqual([]);
    const eff = await call("/allowance-policies/effective?at=2026-09-01", { token: a.token, company: mine._id });
    expect(eff.status).toBe(409);
    /* And theirs is untouched. */
    expect((await IeAllowancePolicy.findById(theirPolicy.policy.policyId).lean()).name).toBe("Their allowance");
  });

  test("the list is this company's, newest effective date first, and bounded", async () => {
    const co = await company("Listing");
    await published(co, { name: "January", effectiveFrom: "2026-01-01" });
    await published(co, { name: "June", effectiveFrom: "2026-06-01" });
    const maker = await editorIn(co);
    await draft(maker, co, { name: "Next", effectiveFrom: "2026-12-01", categories: [] });

    const a = await viewerIn(co);
    const all = await call("/allowance-policies", { token: a.token, company: co._id });
    expect(all.body.policies.map((p) => p.name)).toEqual(["Next", "June", "January"]);
    expect(all.body.sort).toBe("effectiveFrom:desc,_id:desc");

    const onlyPublished = await call("/allowance-policies?status=PUBLISHED", { token: a.token, company: co._id });
    expect(onlyPublished.body.policies.map((p) => p.name)).toEqual(["June", "January"]);

    const page = await call("/allowance-policies?limit=2", { token: a.token, company: co._id });
    expect(page.body.policies).toHaveLength(2);
    expect(page.body.hasMore).toBe(true);
    const next = await call(`/allowance-policies?limit=2&cursor=${encodeURIComponent(page.body.nextCursor)}`, {
      token: a.token, company: co._id,
    });
    expect(next.body.policies.map((p) => p.name)).toEqual(["January"]);
    expect(next.body.hasMore).toBe(false);
  });

  test("an unauthenticated caller and one without IE access reach nothing", async () => {
    const co = await company("PolicyAuth");
    const anon = await call("/allowance-policies", { company: co._id });
    expect(anon.status).toBeGreaterThanOrEqual(400);
    const outsider = await actor({ companies: [co], grants: { sales: "owner" } });
    expect((await call("/allowance-policies", { token: outsider.token, company: co._id })).status).toBe(403);
  });
});
