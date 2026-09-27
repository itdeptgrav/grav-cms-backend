// test/access/gac-ar1-app-access.test.js
//
// GAC-AR1 — the canonical application-access resolver, and the surfaces cut
// over to it: session verify, the launcher list, department switching, the
// shared role guard, PPC entry and the single-organisation company context.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "gac-ar1-test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const CEODepartment = require("../../models/CEODepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const { resolveAppAccess, listAccessibleApps, DENIAL, SOURCE } = require("../../services/access/appAccess.service");
const { requireDepartmentRole } = require("../../services/departmentRoles");
const { resolveCompanyForActor, listMembershipCompanies, MEMBERSHIP_SOURCES } = require("../../services/companyContext/companyMembership.service");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  app.use("/api/cms/ppc", require("../../routes/CMS_Routes/PPC/orderBookRoute"));
  app.get("/probe/sales", EmployeeAuthMiddleware, requireDepartmentRole("sales", "viewer"), (req, res) => res.json({ ok: true, role: req.departmentRole }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (p, { method = "GET", token, body, headers = {} } = {}) => fetch(`${base}${p}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function seed() {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
}
const dept = (slug) => AccessDepartment.findOne({ slug });
const activeAppSlugs = async () => (await AccessDepartment.find({ isActive: true, slug: { $ne: "platform-admin" } }).lean()).map((d) => d.slug).sort();

async function deptUser({ slug = "ceo", isAdmin = false, isActive = true } = {}) {
  const d = await dept(slug);
  const user = await DeptUser.create({
    name: `AR1 ${++n}`, email: `ar1.${n}@grav.test`, passwordHash: "x", departmentId: d._id, isAdmin, isActive,
  });
  const token = (claims = {}) => jwt.sign(
    { v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug, email: user.email,
      name: user.name, role: d.legacyRole || d.slug, isAdmin, tv: user.tokenVersion || 0, ...claims },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );
  return { user, dept: d, token, actor: { id: user._id, email: user.email, subject: "dept_user", tv: user.tokenVersion || 0 } };
}

const primaryCompany = () => Acc_Company.create({ companyName: "GRAV CLOTHING PVT LTD", booksFromDate: new Date("2026-04-01"), isPrimary: true });
const demoCompany = () => Acc_Company.create({ companyName: `IE Demo ${++n}`, booksFromDate: new Date("2026-04-01") });
const failWith = (code, message) => Object.assign(new Error(message), { code });

/* ══ The resolver ════════════════════════════════════════════════════════ */

describe("resolveAppAccess", () => {
  test("a database-verified administrator is owner in every active application, from platform_admin", async () => {
    await seed();
    const { actor } = await deptUser({ isAdmin: true });
    for (const slug of await activeAppSlugs()) {
      const a = await resolveAppAccess(actor, slug);
      expect({ slug, allowed: a.allowed, role: a.role, source: a.source }).toEqual({ slug, allowed: true, role: "owner", source: SOURCE.PLATFORM_ADMIN });
    }
    const out = await listAccessibleApps(actor);
    expect(out.isPlatformAdmin).toBe(true);
    expect(out.apps.map((x) => x.department.slug).sort()).toEqual(await activeAppSlugs());
  });

  test("an isAdmin claim without an administrator record is ordinary: no grant, no access", async () => {
    await seed();
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    const { actor } = await deptUser({ isAdmin: false });
    const a = await resolveAppAccess({ ...actor, isAdmin: true }, "sales");
    expect(a).toMatchObject({ allowed: false, denialCode: DENIAL.NO_APP_GRANT });
  });

  test("an ordinary user with a role is allowed at that role; without one is denied", async () => {
    await seed();
    const { user, actor } = await deptUser();
    await DepartmentRole.create({ departmentSlug: "sales", email: user.email, role: "editor" });
    await DepartmentRole.create({ departmentSlug: "hr", email: "someone@grav.test", role: "owner" });
    expect(await resolveAppAccess(actor, "sales")).toMatchObject({ allowed: true, role: "editor", source: SOURCE.APP_ROLE });
    expect(await resolveAppAccess(actor, "hr")).toMatchObject({ allowed: false, denialCode: DENIAL.NO_APP_GRANT });
  });

  test("revocation and deactivation deny on the next resolution; a stale tokenVersion is SESSION_REVOKED", async () => {
    await seed();
    const { user, actor } = await deptUser({ isAdmin: true });
    await DeptUser.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    expect(await resolveAppAccess(actor, "sales")).toMatchObject({ allowed: false, denialCode: DENIAL.SESSION_REVOKED });
    await DeptUser.updateOne({ _id: user._id }, { $set: { isActive: false } });
    expect(await resolveAppAccess({ ...actor, tv: 1 }, "sales")).toMatchObject({ allowed: false, denialCode: DENIAL.IDENTITY_INACTIVE });

    const ord = await deptUser();
    await DepartmentRole.create({ departmentSlug: "sales", email: ord.user.email, role: "viewer" });
    expect((await resolveAppAccess(ord.actor, "sales")).allowed).toBe(true);
    await DepartmentRole.updateOne({ email: ord.user.email }, { $set: { isActive: false } });
    expect(await resolveAppAccess(ord.actor, "sales")).toMatchObject({ allowed: false, denialCode: DENIAL.NO_APP_GRANT });
  });

  test("a database outage fails closed with ACCESS_CHECK_UNAVAILABLE", async () => {
    await seed();
    const { actor } = await deptUser({ isAdmin: true });
    jest.spyOn(DeptUser, "findById").mockImplementation(() => { throw new Error("simulated outage"); });
    expect(await resolveAppAccess(actor, "sales")).toMatchObject({ allowed: false, denialCode: DENIAL.ACCESS_CHECK_UNAVAILABLE });
    expect(await listAccessibleApps(actor)).toMatchObject({ ok: false, denialCode: DENIAL.ACCESS_CHECK_UNAVAILABLE, apps: [] });
  });

  test("duplicate active employee records for one address are AMBIGUOUS_IDENTITY", async () => {
    await seed();
    const mk = (i) => Employee.create({ firstName: "Dup", lastName: String(i), email: "dup@grav.test", biometricId: `DUP${i}${++n}`, isActive: true, gender: "Other", department: "Tech" });
    const a = await mk(1); await mk(2);
    await DepartmentRole.create({ departmentSlug: "sales", email: "dup@grav.test", role: "owner" });
    expect(await resolveAppAccess({ id: a._id, email: "dup@grav.test", subject: "employee" }, "sales"))
      .toMatchObject({ allowed: false, denialCode: DENIAL.AMBIGUOUS_IDENTITY });
  });

  test("Accounting reads Acc_User through the adapter, not DepartmentRole", async () => {
    await seed();
    const { user, actor } = await deptUser();
    const org = await Acc_Organization.create({ name: `AR1 Org ${++n}`, tallyCompanyIds: [] });
    const acc = new Acc_User({ organizationId: org._id, name: "Acc", email: user.email, role: "approver" });
    await acc.setPassword("a-long-enough-password"); await acc.save();
    await DepartmentRole.create({ departmentSlug: "accountant", email: user.email, role: "owner" });
    expect(await resolveAppAccess(actor, "accountant")).toMatchObject({ allowed: true, role: "approver", source: SOURCE.ACCOUNTING_ROLE });
    await Acc_User.updateOne({ _id: acc._id }, { $set: { isActive: false } });
    expect(await resolveAppAccess(actor, "accountant")).toMatchObject({ allowed: false, denialCode: DENIAL.NO_APP_GRANT });
  });

  test("PPC opens from the application role alone — no membership, companyGrants tombstones ignored", async () => {
    await seed();
    const { user, actor } = await deptUser();
    const co = await demoCompany();
    await DepartmentRole.create({
      departmentSlug: "ppc", email: user.email, role: "approver", isActive: true,
      companyGrants: [{ companyId: co._id, role: "approver", isActive: false, reason: "tombstone" }],
    });
    expect(await SpCompanyMembership.countDocuments({ email: user.email })).toBe(0);
    expect(await resolveAppAccess(actor, "ppc")).toMatchObject({ allowed: true, role: "approver", source: SOURCE.APP_ROLE });
  });

  test("an assignment in a department with no roles at all keeps legacy entry (named bridge)", async () => {
    await seed();
    // A custom department, as printing/washing/trimming/ironing are in the live catalogue.
    await AccessDepartment.create({ key: "printing", slug: "printing", name: "Printing", dashboardPath: "/printing/dashboard", isActive: true });
    const { actor } = await deptUser({ slug: "printing" });
    expect(await DepartmentRole.countDocuments({ departmentSlug: "printing" })).toBe(0);
    expect(await resolveAppAccess(actor, "printing")).toMatchObject({ allowed: true, role: "editor", source: SOURCE.LEGACY_DEPARTMENT_ASSIGNMENT });
    // …but not in a department with roles configured.
    const other = await deptUser({ slug: "sales" });
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    expect(await resolveAppAccess(other.actor, "sales")).toMatchObject({ allowed: false, denialCode: DENIAL.NO_APP_GRANT });
  });
});

/* ══ Canonical GRAV company context ══════════════════════════════════════ */

describe("single-organisation company context", () => {
  const resolve = (user, requestedCompanyId) => resolveCompanyForActor(user, { requestedCompanyId, domainLabel: "AR1", fail: failWith });

  test("an authenticated user with NO membership resolves to the GRAV primary profile", async () => {
    const grav = await primaryCompany();
    await demoCompany();
    const user = { id: String(new mongoose.Types.ObjectId()), email: "no-membership@grav.test" };
    const ctx = await resolve(user);
    expect(String(ctx.companyId)).toBe(String(grav._id));
    expect(ctx.membershipSource).toBe(MEMBERSHIP_SOURCES.CANONICAL_GRAV_ORGANISATION);
    expect((await listMembershipCompanies(user)).companies).toEqual([{ companyId: String(grav._id), displayName: "GRAV CLOTHING PVT LTD" }]);
  });

  test("a demo company id — even one the user is a member of — is refused, the GRAV id accepted", async () => {
    const grav = await primaryCompany();
    const demo = await demoCompany();
    const user = { id: String(new mongoose.Types.ObjectId()), email: "member@grav.test" };
    await SpCompanyMembership.create({ companyId: demo._id, email: user.email });
    await expect(resolve(user, demo._id)).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    expect(String((await resolve(user, grav._id)).companyId)).toBe(String(grav._id));
  });

  test("a company lookup failure is an outage (503 code), never a fallback", async () => {
    await primaryCompany();
    jest.spyOn(Acc_Company, "find").mockImplementation(() => { throw new Error("simulated outage"); });
    await expect(resolve({ id: String(new mongoose.Types.ObjectId()), email: "x@grav.test" }))
      .rejects.toMatchObject({ code: "COMPANY_CONTEXT_UNAVAILABLE" });
  });

  test("two primary rows are refused as ambiguous, not resolved arbitrarily", async () => {
    await primaryCompany(); await primaryCompany();
    await expect(resolve({ id: String(new mongoose.Types.ObjectId()), email: "x@grav.test" }))
      .rejects.toMatchObject({ code: "COMPANY_CONTEXT_UNAVAILABLE" });
  });
});

/* ══ Launcher, switching, guards and PPC entry agree ═════════════════════ */

describe("launcher, switch and API guards are projections of the resolver", () => {
  test("a migrated CEO with a broken modern hash receives the modern administrator session after legacy credential verification", async () => {
    await seed();
    const ceo = await dept("ceo");
    const id = new mongoose.Types.ObjectId();
    await DeptUser.create({
      _id: id,
      name: "Migrated CEO",
      email: `migrated.ceo.${++n}@grav.test`,
      passwordHash: "not-a-usable-bcrypt-hash",
      departmentId: ceo._id,
      isAdmin: true,
      isActive: true,
    });
    await CEODepartment.create({
      _id: id,
      name: "Migrated CEO",
      email: `migrated.ceo.${n}@grav.test`,
      password: "legacy-password",
      employeeId: `AR1CEO${n}`,
      role: "ceo",
      isActive: true,
    });

    const login = await call("/api/auth/login", {
      method: "POST",
      body: { email: `migrated.ceo.${n}@grav.test`, password: "legacy-password" },
    });
    expect(login).toMatchObject({ status: 200, body: { success: true, user: { isAdmin: true } } });

    const verify = await call("/api/auth/verify", { method: "POST", token: login.body.token });
    expect(verify.status).toBe(200);
    expect(verify.body.user.isAdmin).toBe(true);
    expect(verify.body.departments.map((d) => d.slug).sort()).toEqual(await activeAppSlugs());
  });

  test("an accounting-only user's Accounting tile switches successfully instead of falling into DeptUser Unauthorized", async () => {
    await seed();
    const accounting = await dept("accountant");
    const org = await Acc_Organization.create({ name: `AR1 Org ${++n}`, tallyCompanyIds: [] });
    const acc = new Acc_User({
      organizationId: org._id,
      name: "Accounting only",
      email: `accounting.only.${++n}@grav.test`,
      role: "owner",
    });
    await acc.setPassword("a-long-enough-password");
    await acc.save();
    const session = jwt.sign({
      v: 2,
      id: String(acc._id),
      deptId: String(accounting._id),
      deptSlug: "accountant",
      email: acc.email,
      name: acc.name,
      role: "accountant",
      subject: "accountant",
      tv: acc.tokenVersion || 0,
    }, process.env.JWT_SECRET, { expiresIn: "10m" });

    const sw = await call("/api/auth/switch-department", {
      method: "POST",
      token: session,
      body: { slug: "accountant" },
    });
    expect(sw.status).toBe(200);
    expect(sw.body).toMatchObject({ success: true, accountantRole: "owner" });
    expect(sw.body.accountantToken).toEqual(expect.any(String));

    const verify = await call("/api/auth/verify", { method: "POST", token: sw.body.token });
    expect(verify).toMatchObject({
      status: 200,
      body: { success: true, user: { subject: "accountant", deptSlug: "accountant" } },
    });
  });

  test("a fresh administrator session lists every active application and can switch into each", async () => {
    await seed();
    await primaryCompany();
    const { token } = await deptUser({ isAdmin: true });
    const verify = await call("/api/auth/verify", { method: "POST", token: token() });
    expect(verify.status).toBe(200);
    expect(verify.body.departments.map((d) => d.slug).sort()).toEqual(await activeAppSlugs());
    for (const slug of await activeAppSlugs()) {
      const sw = await call("/api/auth/switch-department", { method: "POST", token: token(), body: { slug } });
      expect({ slug, status: sw.status }).toEqual({ slug, status: 200 });
      const after = await call("/api/auth/verify", { method: "POST", token: sw.body.token });
      expect({ slug, deptSlug: after.body.user.deptSlug, deptRole: after.body.user.deptRole }).toEqual({ slug, deptSlug: slug, deptRole: "owner" });
    }
  });

  test("the administrator reaches the PPC order book with no membership and no company grant", async () => {
    await seed();
    await primaryCompany();
    const { user, token } = await deptUser({ isAdmin: true });
    expect(await SpCompanyMembership.countDocuments({ email: user.email })).toBe(0);
    const sw = await call("/api/auth/switch-department", { method: "POST", token: token(), body: { slug: "ppc" } });
    const book = await call("/api/cms/ppc/order-book?view=all", { token: sw.body.token });
    expect(book.status).toBe(200);
  });

  test("an ordinary user sees only granted apps; tile, switch and API agree", async () => {
    await seed();
    await primaryCompany();
    await DepartmentRole.create({ departmentSlug: "hr", email: "someone@grav.test", role: "owner" });
    const { user, token } = await deptUser({ slug: "sales" });
    await DepartmentRole.create({ departmentSlug: "sales", email: user.email, role: "viewer" });
    const verify = await call("/api/auth/verify", { method: "POST", token: token() });
    expect(verify.body.departments.map((d) => d.slug)).toEqual(["sales"]);
    expect((await call("/probe/sales", { token: token() })).status).toBe(200);
    const sw = await call("/api/auth/switch-department", { method: "POST", token: token(), body: { slug: "hr" } });
    expect(sw.body?.department?.slug).not.toBe("hr");
  });

  test("revoking the grant removes the tile and the API access on the next request", async () => {
    await seed();
    await primaryCompany();
    const { user, token } = await deptUser({ slug: "sales" });
    await DepartmentRole.create({ departmentSlug: "sales", email: user.email, role: "viewer" });
    await DepartmentRole.create({ departmentSlug: "sales", email: "other-owner@grav.test", role: "owner" });
    expect((await call("/probe/sales", { token: token() })).status).toBe(200);
    await DepartmentRole.updateOne({ email: user.email }, { $set: { isActive: false } });
    const verify = await call("/api/auth/verify", { method: "POST", token: token() });
    expect((verify.body.departments || []).map((d) => d.slug)).not.toContain("sales");
    expect((await call("/probe/sales", { token: token() })).status).toBe(403);
  });

  test("deactivation and tokenVersion revocation end the session with a sign-in-again code", async () => {
    await seed();
    const { user, token } = await deptUser({ isAdmin: true });
    await DeptUser.updateOne({ _id: user._id }, { $inc: { tokenVersion: 1 } });
    const v = await call("/api/auth/verify", { method: "POST", token: token() });
    expect(v).toMatchObject({ status: 401, body: { code: "SESSION_REVOKED" } });
    const sw = await call("/api/auth/switch-department", { method: "POST", token: token(), body: { slug: "sales" } });
    expect(sw).toMatchObject({ status: 401, body: { code: "SESSION_REVOKED" } });
  });

  test("a token signed with a retired secret gets SESSION_INVALID, 'sign in again'", async () => {
    const stale = jwt.sign({ v: 2, id: "x", deptId: "y" }, "some-retired-secret");
    const v = await call("/api/auth/verify", { method: "POST", token: stale });
    expect(v).toMatchObject({ status: 401, body: { code: "SESSION_INVALID" } });
    expect(v.body.message).toMatch(/sign in again/i);
  });

  test("the shared role guard admits a database-verified administrator as owner, and refuses a forged claim", async () => {
    await seed();
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    const admin = await deptUser({ isAdmin: true });
    const res = await call("/probe/sales", { token: admin.token() });
    expect(res).toMatchObject({ status: 200, body: { role: "owner" } });
    const forged = await deptUser({ isAdmin: false });
    expect((await call("/probe/sales", { token: forged.token({ isAdmin: true }) })).status).toBe(403);
  });

  test("a landing read carries no membership-required refusal", async () => {
    await seed();
    await primaryCompany();
    await demoCompany();
    const { user, token } = await deptUser({ slug: "ppc" });
    await DepartmentRole.create({ departmentSlug: "ppc", email: user.email, role: "viewer" });
    const book = await call("/api/cms/ppc/order-book?view=all", { token: token() });
    expect(book.status).toBe(200);
    expect(JSON.stringify(book.body)).not.toMatch(/TENANT_MEMBERSHIP_UNPROVEN|COMPANY_SELECTION_REQUIRED/);
  });
});
