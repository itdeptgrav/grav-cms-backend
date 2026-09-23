// test/marketing/marketing-access.route.test.js
//
// MARKETING PERMISSIONS, END TO END, WITH THE REAL GUARD.
//
// ── NOTHING IS MOCKED HERE ─────────────────────────────────────────────────
// Every other Marketing suite replaces the guard with a header so it can test
// its own domain. This one does the opposite: real signed tokens, real
// Employee / DeptUser / DepartmentRole records, and every
// Marketing router mounted in the order server.js mounts them.
//
// ── WHAT THIS PINS ─────────────────────────────────────────────────────────
//   Viewer reads and cannot write; Editor, Approver and Owner write; only an
//   administrator or the CEO decides or changes settings. An Owner is not an
//   administrator.
//   Granting, changing and revoking a role or the Marketing department takes
//   effect on the SAME token's very next request.
//   Access is never granted on an email match alone: the role must be on the
//   employee's own record's address; the configured Marketing company is used for all, and a
//   shared department account holds no Marketing role.
//   Another company's data is invisible, and nobody approves their own work.
//   Every non-GET Marketing route refuses a Viewer before its handler runs, and
//   every decision and setting route refuses an Owner.
"use strict";

/* Employee records encrypt salary fields on save; a throwaway key, as the other
   route suites that create employees do. */
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
const express = require("express");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const CEODepartment = require("../../models/CEODepartment");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { MarketingContentPlanItem } = require("../../models/CMS_Models/Marketing/MarketingContentPlanItem");
const { MarketingCampaignDraft } = require("../../models/CMS_Models/Marketing/MarketingCampaignDraft");
const { signToken, verifyToken, buildTokenPayload } = require("../../routes/auth/deptAuth");
const departmentRoles = require("../../services/departmentRoles");
const memo = require("../../services/memo");
const access = require("../../services/marketing/marketingAccess");

/* Server order — see server.js. */
const ROUTERS = [
  "googleLeadWebhook", "access", "marketingHandovers", "dataHealth", "trackingIntegrations",
  "contentInventory", "advertisingChannels", "campaignDrafts", "leadRecovery", "enquiries", "leadSources",
  "campaignCapabilities", "marketingOverview", "campaignIntelligence", "campaignPerformance",
  "advertisingAssets", "campaignDeployment", "contentPlan", "creativeMedia",
];
const routerOf = (name) => require(`../../routes/CMS_Routes/Marketing/${name}`);

const MKT_ID = new mongoose.Types.ObjectId();
const CEO_ID = new mongoose.Types.ObjectId();
const SALES_ID = new mongoose.Types.ObjectId();

let A; let B;
let server; let base;
let authBase;
let seq = 0;
const ENV_KEYS = ["MARKETING_CHANNEL_ID_SECRET", "MARKETING_COMPANY_ID"];
const saved = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const app = express();
  /* As server.js: the global JSON parser, stashing the exact bytes. */
  app.use(express.json({ limit: "50mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  for (const name of ROUTERS) app.use("/api/cms/marketing", routerOf(name));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/marketing`;
  authBase = `http://127.0.0.1:${server.address().port}/api/auth`;
});
afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  process.env.MARKETING_CHANNEL_ID_SECRET = "a-deployment-secret-long-enough";
  await AccessDepartment.create([
    { _id: MKT_ID, key: "marketing", slug: "marketing", name: "Marketing", dashboardPath: "/marketing", legacyRole: "marketing", legacyUserType: "marketing", isActive: true },
    { _id: CEO_ID, key: "ceo", slug: "ceo", name: "Executive Office", dashboardPath: "/ceo/dashboard", legacyRole: "ceo", legacyUserType: "ceo", isActive: true },
    { _id: SALES_ID, key: "sales", slug: "sales", name: "Sales", dashboardPath: "/sales/dashboard", legacyRole: "sales", legacyUserType: "sales", isActive: true },
  ]);
  /* Sign-in caches the active departments for 30 s; these tests rebuild them. */
  memo.invalidate("access-departments:active");
  A = (await Acc_Company.create({ companyName: "GRAV Clothing", booksFromDate: new Date("2026-04-01") }))._id;
  B = (await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") }))._id;
  process.env.MARKETING_COMPANY_ID = String(A);
});

/* ═══ PEOPLE ══════════════════════════════════════════════════════════════ */

/** An employee, signed in to Marketing, with whatever grant, role and company. */
async function employee({
  grants = [MKT_ID], role = null, companies = [A], roleEmail = null, tokenEmail = null,
  signedInto = MKT_ID, claims = {},
} = {}) {
  const n = ++seq;
  const email = `m${n}@grav.test`;
  const [primary, ...more] = grants;
  const emp = await Employee.create({
    firstName: "Emp", lastName: `N${n}`, email, biometricId: `MK${n}`,
    isActive: true, gender: "Other", department: "",
    accessDepartmentId: primary || null, additionalDepartmentIds: more,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co, email, employeeRef: emp._id, personName: `Emp N${n}` });
  }
  if (role) await departmentRoles.setRole({ departmentSlug: "marketing", email: roleEmail || email, name: "Emp", role });
  const dept = [MKT_ID, CEO_ID, SALES_ID].find((id) => String(id) === String(signedInto));
  const slug = String(dept) === String(CEO_ID) ? "ceo" : String(dept) === String(SALES_ID) ? "sales" : "marketing";
  const token = signToken({
    v: 2, id: String(emp._id), role: slug, userType: slug, deptId: String(dept), deptSlug: slug,
    employeeId: emp.biometricId, name: `Emp N${n}`, email: tokenEmail || email, isAdmin: false,
    subject: "employee", tv: 0, ...claims,
  });
  return { emp, email, token };
}

/** A platform administrator or a CEO department account. */
async function account({ isAdmin = false, departmentId = SALES_ID, companies = [A] } = {}) {
  const n = ++seq;
  const email = `a${n}@grav.test`;
  const user = await DeptUser.create({
    name: `Acct ${n}`, email, passwordHash: "x", isAdmin, isActive: true, departmentId,
  });
  /* Linked to the account itself, as the membership screen links one. */
  for (const co of companies) await SpCompanyMembership.create({ companyId: co, email, employeeRef: user._id, personName: `Acct ${n}` });
  const dept = await AccessDepartment.findById(departmentId);
  return { user, email, token: signToken(buildTokenPayload(user, dept)) };
}

const admin = (o) => account({ isAdmin: true, ...o });
const ceo = (o) => account({ departmentId: CEO_ID, ...o });

/* ═══ HTTP ════════════════════════════════════════════════════════════════ */

async function call(method, p, { who, body } = {}) {
  if (method === "GET" || method === "HEAD") body = undefined;
  const headers = {};
  if (who) headers.authorization = `Bearer ${who.token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: res.status, body: json, text };
}
const get = (p, who) => call("GET", p, { who });
const post = (p, who, body = {}) => call("POST", p, { who, body });
const accessOf = async (who) => (await get("/access", who)).body.access;

const ITEM = Object.freeze({ title: "Winter teaser", contentType: "email", channel: "email", brief: "Tease it." });
const newItem = (who, over = {}) => post("/content-plan/items", who, { idempotencyKey: `key-${Date.now()}-${++seq}`, ...ITEM, ...over });

/* The guard's own refusal codes — and only those. Domain errors may also
   begin with MARKETING_, so a prefix test would confuse the two. */
const GUARD_CODES = new Set([
  "MARKETING_ACTION_FORBIDDEN", "MARKETING_SESSION_EXPIRED", "MARKETING_SESSION_INVALID",
  ...Object.keys(access.REFUSALS).map((k) => `MARKETING_${k}`),
]);

/* Refused by the Marketing guard itself, before any handler ran. */
const guardRefused = (res, code) => {
  expect([res.status, res.body?.code]).toEqual([code === "MARKETING_ACTION_FORBIDDEN" ? 403 : res.status, code]);
};
const passedGuard = (res) => {
  expect(GUARD_CODES.has(String(res.body?.code || ""))).toBe(false);
  expect(res.status).not.toBe(401);
};

/* ═══ 1. WHAT EACH ROLE MAY DO ════════════════════════════════════════════ */

describe("one permission model", () => {
  test("legacy CEO login verifies and opens Marketing without a DeptUser record", async () => {
    const n = ++seq;
    const email = `legacy-ceo-${n}@grav.test`;
    const legacy = await CEODepartment.create({
      name: "Legacy CEO", email, password: "legacy-ceo-password", employeeId: `LEGCEO${n}`,
    });
    await SpCompanyMembership.create({
      companyId: A, email, employeeRef: legacy._id, personName: "Legacy CEO",
    });

    const signedIn = await fetch(`${authBase}/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "legacy-ceo-password", slug: "ceo" }),
    });
    const login = await signedIn.json();
    expect(signedIn.status).toBe(200);
    expect(login.token).toBeTruthy();
    expect(verifyToken(login.token).subject).toBe("legacy_department");

    const verifyWith = async (token) => {
      const response = await fetch(`${authBase}/verify`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      });
      return { status: response.status, body: await response.json() };
    };
    const verified = await verifyWith(login.token);
    expect([verified.status, verified.body.user?.deptSlug]).toEqual([200, "ceo"]);
    expect(verified.body.departments?.some((d) => d.slug === "ceo")).toBe(true);

    const who = { token: login.token };
    const marketing = await get("/access", who);
    expect([marketing.status, marketing.body.access?.kind]).toEqual([200, "ceo"]);
    expect((await get("/content-plan/items", who)).status).toBe(200);

    // A session issued by the previous login code has no subject marker.
    const olderToken = signToken({
      v: 2, id: String(legacy._id), role: "ceo", userType: "ceo",
      deptId: String(CEO_ID), deptSlug: "ceo", email, isAdmin: false, tv: 0,
    });
    expect((await verifyWith(olderToken)).status).toBe(200);
    expect((await get("/access", { token: olderToken })).body.access?.kind).toBe("ceo");

    await CEODepartment.updateOne({ _id: legacy._id }, { $set: { isActive: false } });
    expect((await verifyWith(login.token)).status).toBe(401);
    expect((await get("/access", who)).status).toBe(401);
  });

  test("legacy CEO remains identifiable before the department migration, but not when disabled", async () => {
    const n = ++seq;
    const email = `pre-migration-ceo-${n}@grav.test`;
    const legacy = await CEODepartment.create({
      name: "Pre-migration CEO", email, password: "legacy-ceo-password", employeeId: `PRECEO${n}`,
    });
    await AccessDepartment.deleteOne({ _id: CEO_ID });

    const signedIn = await fetch(`${authBase}/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "legacy-ceo-password", slug: "ceo" }),
    });
    const login = await signedIn.json();
    expect(signedIn.status).toBe(200);
    const headers = { authorization: `Bearer ${login.token}` };
    const verified = await fetch(`${authBase}/verify`, { method: "POST", headers });
    const view = await verified.json();
    expect([verified.status, view.user?.deptSlug]).toEqual([200, "ceo"]);
    expect((await get("/access", { token: login.token })).body.access?.kind).toBe("ceo");

    await AccessDepartment.create({
      _id: CEO_ID, key: "ceo", slug: "ceo", name: "Executive Office",
      dashboardPath: "/ceo/dashboard", legacyRole: "ceo", legacyUserType: "ceo", isActive: false,
    });
    expect((await fetch(`${authBase}/verify`, { method: "POST", headers })).status).toBe(401);
    expect((await get("/access", { token: login.token })).status).toBe(401);
    await CEODepartment.deleteOne({ _id: legacy._id });
  });

  test("1. the access answer for every kind of caller", async () => {
    const expected = {
      viewer: { read: true, write: false, decide: false, administer: false },
      editor: { read: true, write: true, decide: false, administer: false },
      approver: { read: true, write: true, decide: false, administer: false },
      owner: { read: true, write: true, decide: false, administer: false },
    };
    for (const [role, can] of Object.entries(expected)) {
      const a = await accessOf(await employee({ role }));
      expect([role, a.allowed, a.kind, a.role, a.can]).toEqual([role, true, "member", role, can]);
    }
    for (const [label, who] of [["admin", await admin()], ["ceo", await ceo()]]) {
      const a = await accessOf(who);
      expect([label, a.allowed, a.can]).toEqual([label, true, { read: true, write: true, decide: true, administer: true }]);
    }
    const owner = await accessOf(await employee({ role: "owner" }));
    expect(owner.roleLabel).toBe("Owner");
    expect(owner.policy.approverAndOwner).toMatch(/do not add approval or settings rights/);
    expect(owner.policy.decisions).toMatch(/administrator or the CEO/);
  });

  test("2. direct API: Viewer reads and cannot write; Editor writes; nothing is written on refusal", async () => {
    const viewer = await employee({ role: "viewer" });
    const editor = await employee({ role: "editor" });

    expect((await get("/content-plan/items", viewer)).status).toBe(200);
    expect((await get("/campaign-drafts", viewer)).status).toBe(200);

    const refused = await newItem(viewer);
    guardRefused(refused, "MARKETING_ACTION_FORBIDDEN");
    expect(refused.body.act).toBe("write");
    expect(refused.body.message).toMatch(/view-only access/);
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);

    const plan = await post("/campaign-drafts", viewer, { name: "x" });
    guardRefused(plan, "MARKETING_ACTION_FORBIDDEN");
    expect(await MarketingCampaignDraft.countDocuments({})).toBe(0);

    const created = await newItem(editor);
    expect(created.status).toBe(201);
    /* It was written to the configured Marketing company. */
    expect(String((await MarketingContentPlanItem.findOne({}).lean()).companyId)).toBe(String(A));
  });

  test("3. Approver and Owner write but cannot decide or change settings; admin and CEO can", async () => {
    for (const role of ["editor", "approver", "owner"]) {
      const who = await employee({ role });
      const decision = await post("/campaign-drafts/any-id/decision", who, { decision: "approve" });
      guardRefused(decision, "MARKETING_ACTION_FORBIDDEN");
      expect([role, decision.body.act]).toEqual([role, "decide"]);
      const setting = await call("PUT", "/integrations/tracking", { who, body: {} });
      guardRefused(setting, "MARKETING_ACTION_FORBIDDEN");
      expect(setting.body.act).toBe("administer");
      const operator = await post("/handovers/deliver-pending", who);
      guardRefused(operator, "MARKETING_ACTION_FORBIDDEN");
    }
    for (const who of [await admin(), await ceo()]) {
      passedGuard(await post("/campaign-drafts/any-id/decision", who, { decision: "approve" }));
      passedGuard(await call("PUT", "/integrations/tracking", { who, body: {} }));
    }
  });

  test("4. an Approver cannot approve a content item either — the service refuses as well as the guard's floor", async () => {
    const author = await employee({ role: "editor" });
    const approver = await employee({ role: "approver" });
    const item = (await newItem(author, { ownerRef: "self", planned: { date: "2026-10-20", timeZone: "Asia/Kolkata" } })).body.item;
    const submitted = (await post(`/content-plan/items/${item.itemRef}/actions`, author, { expectedRevision: 1, action: "submit" })).body.item;
    const refused = await post(`/content-plan/items/${item.itemRef}/actions`, approver, { expectedRevision: submitted.revision, action: "approve" });
    expect([refused.status, refused.body.error.code]).toEqual([403, "CONTENT_PLAN_DECISION_FORBIDDEN"]);
    const viewerActions = (await get(`/content-plan/items/${item.itemRef}`, approver)).body.item.viewerActions;
    expect(viewerActions.approve).toEqual(expect.objectContaining({ allowed: false, reason: "approver_only" }));

    const ok = await post(`/content-plan/items/${item.itemRef}/actions`, await admin(), { expectedRevision: submitted.revision, action: "approve" });
    expect(ok.status).toBe(200);
  });

  test("5. nobody approves their own submission — administrator included; the CEO may approve it", async () => {
    const a = await admin();
    const item = (await newItem(a, { ownerRef: "self", planned: { date: "2026-10-20", timeZone: "Asia/Kolkata" } })).body.item;
    const submitted = (await post(`/content-plan/items/${item.itemRef}/actions`, a, { expectedRevision: 1, action: "submit" })).body.item;
    const self = await post(`/content-plan/items/${item.itemRef}/actions`, a, { expectedRevision: submitted.revision, action: "approve" });
    expect([self.status, self.body.error.code]).toEqual([403, "CONTENT_PLAN_DECISION_FORBIDDEN"]);
    expect(self.body.error.message).toMatch(/somebody else/);
    const byCeo = await post(`/content-plan/items/${item.itemRef}/actions`, await ceo(), { expectedRevision: submitted.revision, action: "approve" });
    expect(byCeo.status).toBe(200);
  });
});

/* ═══ 2. GRANT, CHANGE, REVOKE — ON THE SAME TOKEN ════════════════════════ */

describe("grants and roles take effect on the next request", () => {
  test("6. no role → refused with the reason; granted → reads; raised → writes; revoked → refused at once", async () => {
    const person = await employee({ role: null });

    let a = await accessOf(person);
    expect([a.allowed, a.reason]).toEqual([false, "MARKETING_NO_MARKETING_ROLE"]);
    expect(a.message).toMatch(/no Marketing role yet/);
    guardRefused(await get("/content-plan/items", person), "MARKETING_NO_MARKETING_ROLE");

    await departmentRoles.setRole({ departmentSlug: "marketing", email: person.email, role: "viewer" });
    expect((await get("/content-plan/items", person)).status).toBe(200);
    guardRefused(await newItem(person), "MARKETING_ACTION_FORBIDDEN");

    await departmentRoles.setRole({ departmentSlug: "marketing", email: person.email, role: "editor" });
    expect((await newItem(person)).status).toBe(201);

    await departmentRoles.setRole({ departmentSlug: "marketing", email: person.email, role: null });
    guardRefused(await get("/content-plan/items", person), "MARKETING_NO_MARKETING_ROLE");
    a = await accessOf(person);
    expect(a.allowed).toBe(false);
  });

  test("7. removing the Marketing department revokes an issued session, even with the role still set", async () => {
    const person = await employee({ grants: [SALES_ID, MKT_ID], role: "editor" });
    expect((await get("/content-plan/items", person)).status).toBe(200);
    await Employee.updateOne({ _id: person.emp._id }, { $set: { additionalDepartmentIds: [] } });
    guardRefused(await get("/content-plan/items", person), "MARKETING_NO_MARKETING_GRANT");
    expect((await accessOf(person)).message).toMatch(/not one of your departments/);
  });

  test("8. a deactivated employee, a demoted admin and a bumped token version are all refused", async () => {
    const person = await employee({ role: "owner" });
    await Employee.updateOne({ _id: person.emp._id }, { $set: { isActive: false } });
    expect((await get("/content-plan/items", person)).status).toBe(401);

    const a = await admin();
    expect((await get("/content-plan/items", a)).status).toBe(200);
    await DeptUser.updateOne({ _id: a.user._id }, { $set: { isAdmin: false } });
    guardRefused(await get("/content-plan/items", a), "MARKETING_NOT_AN_EMPLOYEE");

    const b = await admin();
    await DeptUser.updateOne({ _id: b.user._id }, { $set: { tokenVersion: 5 } });
    const stale = await get("/content-plan/items", b);
    expect([stale.status, stale.body.code]).toEqual([401, "MARKETING_SESSION_STALE"]);
  });

  test("9. a token's claims grant nothing: an employee token claiming admin is still a Viewer", async () => {
    const forged = await employee({ role: "viewer", claims: { isAdmin: true, role: "admin" } });
    guardRefused(await newItem(forged), "MARKETING_ACTION_FORBIDDEN");
    expect((await accessOf(forged)).kind).toBe("member");

    /* A session opened in another department reaches Marketing only through
       the person's own Marketing grant and role. */
    const salesSession = await employee({ grants: [SALES_ID, MKT_ID], role: "editor", signedInto: SALES_ID });
    expect((await newItem(salesSession)).status).toBe(201);
    const salesOnly = await employee({ grants: [SALES_ID], role: "editor", signedInto: SALES_ID });
    guardRefused(await get("/content-plan/items", salesOnly), "MARKETING_NO_MARKETING_GRANT");
  });
});

/* ═══ 3. NEVER ON AN EMAIL ALONE ══════════════════════════════════════════ */

describe("identity is verified, not matched by address", () => {
  test("10. a role on the token's address but not the employee's own address is no role", async () => {
    const person = await employee({ role: "owner", roleEmail: "somebody-else@grav.test", tokenEmail: "somebody-else@grav.test" });
    guardRefused(await get("/content-plan/items", person), "MARKETING_NO_MARKETING_ROLE");
  });

  test("11. an employee needs no individual company membership in the temporary setup", async () => {
    const person = await employee({ role: "editor", companies: [] });
    expect((await get("/content-plan/items", person)).status).toBe(200);
    expect((await newItem(person)).status).toBe(201);
    expect(String((await MarketingContentPlanItem.findOne({}).lean()).companyId)).toBe(String(A));
  });

  test("12. a shared department account holds no Marketing role, even with a role row on its address", async () => {
    const shared = await account({ departmentId: MKT_ID });
    await departmentRoles.setRole({ departmentSlug: "marketing", email: shared.email, role: "owner" });
    guardRefused(await get("/content-plan/items", shared), "MARKETING_NOT_AN_EMPLOYEE");
  });

  test("13. an old-style token that merely says 'marketing' is refused", async () => {
    const legacy = { token: signToken({ id: String(new mongoose.Types.ObjectId()), role: "marketing", userType: "marketing", email: "x@grav.test" }) };
    guardRefused(await get("/content-plan/items", legacy), "MARKETING_NOT_AN_EMPLOYEE");
    expect((await get("/content-plan/items", null)).status).toBe(401);
    expect((await get("/content-plan/items", { token: "not-a-token" })).status).toBe(401);
  });
});

/* ═══ 4. COMPANIES ════════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("14. employee, administrator and CEO use the configured company, not their memberships", async () => {
    const mine = await employee({ role: "editor", companies: [] });
    const otherMembership = await employee({ role: "owner", companies: [B] });
    const administrator = await admin({ companies: [] });
    const executive = await ceo({ companies: [B] });
    const item = (await newItem(mine)).body.item;

    for (const who of [mine, otherMembership, administrator, executive]) {
      expect((await get(`/content-plan/items/${item.itemRef}`, who)).status).toBe(200);
    }
    expect(String((await MarketingContentPlanItem.findOne({ itemRef: item.itemRef }).lean()).companyId)).toBe(String(A));
  });

  test("15. multiple memberships cannot redirect Marketing away from the configured company", async () => {
    const both = await employee({ role: "editor", companies: [A, B] });
    expect((await get("/content-plan/items", both)).status).toBe(200);
    expect((await newItem(both)).status).toBe(201);
    expect(String((await MarketingContentPlanItem.findOne({}).lean()).companyId)).toBe(String(A));
  });

  test("15b. an item in another company is invisible while Marketing is configured for this one", async () => {
    const author = await employee({ role: "editor", companies: [] });
    process.env.MARKETING_COMPANY_ID = String(B);
    const foreign = (await newItem(author)).body.item;
    expect(String((await MarketingContentPlanItem.findOne({ itemRef: foreign.itemRef }).lean()).companyId)).toBe(String(B));

    process.env.MARKETING_COMPANY_ID = String(A);
    expect((await get("/content-plan/items", author)).body.items).toEqual([]);
    expect((await get(`/content-plan/items/${foreign.itemRef}`, author)).status).toBe(404);
    const change = await call("PATCH", `/content-plan/items/${foreign.itemRef}`, {
      who: author, body: { expectedRevision: 1, title: "Wrong company" },
    });
    expect(change.status).toBe(404);
    expect((await MarketingContentPlanItem.findOne({ itemRef: foreign.itemRef }).lean()).title).toBe(ITEM.title);
  });

  test("15a. missing, invalid and nonexistent configured companies refuse everyone without writing", async () => {
    const member = await employee({ role: "editor", companies: [] });
    const executive = await ceo({ companies: [] });
    for (const id of [undefined, "not-a-company-id", String(new mongoose.Types.ObjectId())]) {
      if (id === undefined) delete process.env.MARKETING_COMPANY_ID;
      else process.env.MARKETING_COMPANY_ID = id;
      for (const who of [member, executive]) {
        const res = await get("/content-plan/items", who);
        expect([res.status, res.body.code]).toEqual([503, "MARKETING_COMPANY_NOT_CONFIGURED"]);
      }
    }
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
  });
});

/* ═══ 5. EVERY ROUTE ══════════════════════════════════════════════════════ */

describe("every authenticated Marketing route is classified and enforced", () => {
  const UNAUTHENTICATED = new Set(["POST /google-leads/:deliveryToken", "POST /events", "GET /access"]);
  const concrete = (p) => p.replace(/:[A-Za-z]+/g, "x1");
  const routes = () => ROUTERS.flatMap((name) => routerOf(name).stack.filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route.path, name }))))
    .filter((r) => !UNAUTHENTICATED.has(`${r.method} ${r.path}`));

  test("16. no non-GET route is treated as a read, except the declared read-only preview", () => {
    const reads = routes().filter((r) => r.method !== "GET" && access.actFor(r.method, concrete(r.path)) === "read")
      .map((r) => `${r.method} ${r.path}`);
    expect(reads).toEqual(["POST /handovers/preview"]);
    /* Every decision and setting that a route checks for itself is named in
       the central table too. */
    const elevated = routes().filter((r) => ["decide", "administer"].includes(access.actFor(r.method, concrete(r.path))))
      .map((r) => `${r.method} ${r.path}`).sort();
    expect(elevated).toEqual([
      "GET /intelligence/usage",
      "POST /advertising-accounts/:channel",
      "POST /advertising-accounts/:channel/revoke",
      "POST /advertising-accounts/:channel/verify",
      "POST /advertising-assets/:assetId/review",
      "POST /campaign-drafts/:campaignDraftId/decision",
      "POST /campaign-drafts/:campaignDraftId/deployment/:channel/create-paused",
      "POST /campaign-drafts/:campaignDraftId/deployment/:channel/reconcile",
      "POST /campaign-drafts/:campaignDraftId/performance/refresh",
      "POST /handovers/acquisition-holds/retry",
      "POST /handovers/deliver-pending",
      "POST /lead-forms/recovery/run",
      "POST /lead-sources/indiamart/check",
      "PUT /integrations/tracking",
    ]);
  });

  test("17. a Viewer is refused on every write route, and an Owner on every decision and setting, before any handler runs", async () => {
    const viewer = await employee({ role: "viewer" });
    const owner = await employee({ role: "owner" });
    const nobody = await employee({ role: null });
    for (const r of routes()) {
      const p = concrete(r.path);
      const act = access.actFor(r.method, p);
      if (act !== "read") {
        const res = await call(r.method, p, { who: viewer, body: {} });
        expect([`${r.method} ${r.path}`, res.status, res.body?.code]).toEqual([`${r.method} ${r.path}`, 403, "MARKETING_ACTION_FORBIDDEN"]);
      }
      if (act === "decide" || act === "administer") {
        const res = await call(r.method, p, { who: owner, body: {} });
        expect([`${r.method} ${r.path}`, res.status, res.body?.code]).toEqual([`${r.method} ${r.path}`, 403, "MARKETING_ACTION_FORBIDDEN"]);
      }
      /* And somebody with no role at all is refused everything, reads too. */
      const none = await call(r.method, p, { who: nobody, body: r.method === "GET" ? undefined : {} });
      expect([`${r.method} ${r.path}`, none.status, none.body?.code]).toEqual([`${r.method} ${r.path}`, 403, "MARKETING_NO_MARKETING_ROLE"]);
    }
    expect(await MarketingContentPlanItem.countDocuments({})).toBe(0);
    expect(await MarketingCampaignDraft.countDocuments({})).toBe(0);
  });

  test("18. the unauthenticated lead-form webhook is reached in server order, not refused by the Marketing guard", async () => {
    /* It must also ANSWER: with the app's global JSON parser in front, it
       used to wait for a body that had already been read, and never reply. */
    const res = await post("/google-leads/not-a-real-token", null, { lead_id: "1", google_key: "x" });
    expect(GUARD_CODES.has(String(res.body?.code || ""))).toBe(false);
    expect(res.status).not.toBe(401);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    /* And server.js mounts it — and /access — before any guarded router. */
    const server = fs.readFileSync(path.join(__dirname, "..", "..", "server.js"), "utf8");
    const mounts = [...server.matchAll(/app\.use\("\/api\/cms\/marketing", require\("\.\/routes\/CMS_Routes\/Marketing\/(\w+)"\)\)/g)].map((m) => m[1]);
    expect(mounts.slice(0, 2)).toEqual(["googleLeadWebhook", "access"]);
  });
});

/* ═══ 6. WHAT A SCREEN IS TOLD ════════════════════════════════════════════ */

describe("the server's own per-item answers agree with the role", () => {
  test("19. a Viewer is told 'no' by every per-item action the server publishes, in plain words", async () => {
    const editor = await employee({ role: "editor" });
    const viewer = await employee({ role: "viewer" });
    const item = (await newItem(editor)).body.item;

    const list = (await get("/content-plan/items", viewer)).body;
    expect(list.permissions.canCreate).toBe(false);
    const detail = (await get(`/content-plan/items/${item.itemRef}`, viewer)).body.item;
    expect(detail.viewerActions.edit.allowed).toBe(false);
    for (const code of ["start", "submit", "cancel"]) {
      expect([code, detail.viewerActions[code].allowed, detail.viewerActions[code].reason]).toEqual([code, false, "marketing_only"]);
    }
    const words = list.vocabulary.actionRefusals.find((r) => r.code === "marketing_only").label;
    expect(words).toMatch(/Editor role or higher/);

    /* And the Editor who owns it is told 'yes'. */
    const mine = (await get(`/content-plan/items/${item.itemRef}`, editor)).body.item;
    expect(mine.viewerActions.edit.allowed).toBe(true);
    expect((await get("/content-plan/items", editor)).body.permissions.canCreate).toBe(true);

    /* The media library says the same. */
    const media = (await get("/creative-media", viewer)).body;
    expect(media.vocabulary.withdrawRefusals.find((r) => r.code === "marketing_only").label).toMatch(/Editor role or higher/);
  });
});
