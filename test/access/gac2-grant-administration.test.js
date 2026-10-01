// test/access/gac2-grant-administration.test.js
//
// GAC-2 — the one write path for application access:
//   canonical person + application + role-or-revoke + reason + idempotency key.
//
// Exercised over HTTP through the canonical route (PUT /api/admin/app-access),
// the compatibility adapters (department-roles, accountant-role,
// department-team) and the retired company-access write; the service directly
// where a failure has to be injected.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "gac2-test-secret";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const { AccessGrantEvent } = require("../../models/Access/AccessGrantEvent");
const ChangeLog = require("../../models/Access/ChangeLog");
const Employee = require("../../models/Employee");
const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const { resolveAppAccess } = require("../../services/access/appAccess.service");
const grants = require("../../services/access/accessGrantAdmin.service");
const requirePlatformAdmin = require("../../Middlewear/requirePlatformAdmin");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", requirePlatformAdmin, require("../../routes/Admin/accessAdmin"));
  app.use("/api/department-team", require("../../routes/Access/departmentTeam"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await DepartmentRole.syncIndexes();
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (p, { method = "PUT", token, body, headers = {} } = {}) => fetch(`${base}${p}`, {
  method,
  headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function seed() {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
}
const dept = (slug) => AccessDepartment.findOne({ slug });

async function deptUser({ email = `gac2.${++n}@grav.test`, slug = "ceo", isAdmin = false, isActive = true } = {}) {
  const d = await dept(slug);
  const user = await DeptUser.create({ name: `GAC2 ${n}`, email, passwordHash: "x", departmentId: d._id, isAdmin, isActive });
  const token = (claims = {}) => jwt.sign(
    { v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug, email: user.email,
      name: user.name, isAdmin, subject: "dept_user", tv: user.tokenVersion || 0, ...claims },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );
  return { user, token, actor: { id: user._id, email: user.email, subject: "dept_user", tv: user.tokenVersion || 0 } };
}

const key = () => `gac2-${++n}-${Date.now()}`;
const REASON = "Covering the sales desk while the lead is away";
const change = (token, body, headers) => call("/api/admin/app-access", { token, body, headers });
const grantBody = (email, application, role, extra = {}) => ({ email, application, role, reason: REASON, idempotencyKey: key(), ...extra });
/* GAC-2 correction: counts the append-only audit events (the record of
   authority). `departmentSlug` in a filter is the application. */
const audits = ({ departmentSlug, ...rest } = {}) =>
  AccessGrantEvent.countDocuments({ ...(departmentSlug ? { application: departmentSlug } : {}), ...rest });
const targetActor = (u) => ({ id: u._id, email: u.email, subject: "dept_user", tv: u.tokenVersion || 0 });

/* ══ Round trips ═════════════════════════════════════════════════════════ */

describe("round trips through the canonical write", () => {
  test("Viewer, Editor, Approver and Owner each land, re-read through the resolver", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    for (const role of ["viewer", "editor", "approver", "owner"]) {
      const res = await change(admin.token(), grantBody(user.email, "sales", role));
      expect(res.status).toBe(200);
      expect(res.body.effective).toMatchObject({ allowed: true, role, source: "app_role" });
      expect(await resolveAppAccess(targetActor(user), "sales")).toMatchObject({ allowed: true, role });
    }
    expect(await audits({ departmentSlug: "sales" })).toBe(4);
  });

  test("a role change records before and after, and the audit carries everything required", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    await DepartmentRole.create({ departmentSlug: "hr", email: "hr-owner@grav.test", role: "owner" });
    await change(admin.token(), grantBody(user.email, "hr", "viewer"));
    const body = grantBody(user.email, "hr", "approver");
    const res = await change(admin.token(), body);
    expect(res.body).toMatchObject({ before: { role: "viewer" }, after: { role: "approver" }, changed: true, replayed: false });
    /* GAC-2 correction: the audit is the append-only AccessGrantEvent, whose
       _id is the idempotency key. */
    expect(res.body.auditId).toBe(body.idempotencyKey);
    const ev = await AccessGrantEvent.findById(res.body.auditId).lean();
    expect(ev).toMatchObject({
      application: "hr",
      actor: { email: admin.user.email, authority: "platform_admin" },
      target: { email: user.email, subject: "dept_user" },
      before: { role: "viewer" },
      after: { role: "approver" },
      reason: REASON,
      changed: true,
    });
    expect(ev.occurredAt).toBeInstanceOf(Date);
    expect(ev.hash).toMatch(/^[0-9a-f]{64}$/);
    // The History screen still gets its display copy.
    expect(await ChangeLog.countDocuments({ entity: "access-grant", "after.auditEventId": body.idempotencyKey })).toBe(1);
  });

  test("revoke is visible to the resolver immediately", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    await change(admin.token(), grantBody(user.email, "sales", "editor"));
    const res = await change(admin.token(), grantBody(user.email, "sales", null));
    expect(res.status).toBe(200);
    expect(res.body.effective).toMatchObject({ allowed: false, denialCode: "NO_APP_GRANT" });
    expect(await resolveAppAccess(targetActor(user), "sales")).toMatchObject({ allowed: false });
  });

  test("Accounting goes through its Acc_User adapter — never a DepartmentRole duplicate", async () => {
    await seed();
    await Acc_Organization.create({ name: "GRAV Books", tallyCompanyIds: [] });
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const res = await change(admin.token(), grantBody(user.email, "accountant", "approver"));
    expect(res.status).toBe(200);
    expect(res.body.effective).toMatchObject({ allowed: true, role: "approver", source: "accounting_role" });
    expect(await Acc_User.countDocuments({ email: user.email, role: "approver", isActive: true })).toBe(1);
    expect(await DepartmentRole.countDocuments({ departmentSlug: "accountant" })).toBe(0);

    const revoked = await call("/api/admin/accountant-role", { token: admin.token(), body: { email: user.email, role: null, reason: REASON, idempotencyKey: key() } });
    expect(revoked.status).toBe(200);
    expect(await resolveAppAccess(targetActor(user), "accountant")).toMatchObject({ allowed: false });
    expect(await DepartmentRole.countDocuments({ departmentSlug: "accountant" })).toBe(0);
    // The canonical identity is still the DeptUser — no duplicate was made.
    expect((await require("../../services/access/canonicalIdentity.service").classify(user.email)).kind).toBe("dept_user");
  });

  test("the compatibility adapter for department roles uses the same write (PPC included)", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const res = await call("/api/admin/department-roles/ppc", { token: admin.token(), body: { email: user.email, role: "viewer", reason: REASON, idempotencyKey: key() } });
    expect(res.status).toBe(200);
    expect(res.body.effective).toMatchObject({ allowed: true, role: "viewer" });
    const row = await DepartmentRole.findOne({ departmentSlug: "ppc", email: user.email }).lean();
    expect(row.companyGrants || []).toEqual([]);
    expect(await audits({ departmentSlug: "ppc" })).toBe(1);
  });
});

/* ══ Input the browser may not decide ════════════════════════════════════ */

describe("validation and forged input", () => {
  test.each([
    [undefined, "REASON_REQUIRED"], ["", "REASON_REQUIRED"], ["test", "REASON_NOT_MEANINGFUL"],
    ["because", "REASON_NOT_MEANINGFUL"], ["1234567890", "REASON_NOT_MEANINGFUL"],
  ])("reason %p is refused (%s) and nothing is written", async (reason, code) => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const res = await change(admin.token(), { email: user.email, application: "sales", role: "viewer", reason, idempotencyKey: key() });
    expect(res).toMatchObject({ status: 400, body: { code } });
    expect(await DepartmentRole.countDocuments({ email: user.email })).toBe(0);
    expect(await audits()).toBe(0);
  });

  test.each([
    ["companyId", "COMPANY_SCOPE_NOT_ACCEPTED"], ["companyGrants", "COMPANY_SCOPE_NOT_ACCEPTED"],
    ["isAdmin", "FIELD_NOT_ACCEPTED"], ["capabilities", "FIELD_NOT_ACCEPTED"],
    ["currentRole", "FIELD_NOT_ACCEPTED"], ["previousRole", "FIELD_NOT_ACCEPTED"], ["password", "FIELD_NOT_ACCEPTED"],
  ])("a forged %s field is refused (%s)", async (field, code) => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const res = await change(admin.token(), grantBody(user.email, "sales", "viewer", { [field]: field === "isAdmin" ? true : "x" }));
    expect(res).toMatchObject({ status: 400, body: { code } });
    expect(await DepartmentRole.countDocuments({ email: user.email })).toBe(0);
    expect((await DeptUser.findById(user._id).lean()).isAdmin).toBe(false);
  });

  test("a company header is refused", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const res = await change(admin.token(), grantBody(user.email, "sales", "viewer"), { "X-Costing-Company": String(new mongoose.Types.ObjectId()) });
    expect(res).toMatchObject({ status: 400, body: { code: "COMPANY_SCOPE_NOT_ACCEPTED" } });
  });

  test("the company-scoped write is retired (410)", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const res = await call("/api/admin/company-access", { token: admin.token(), body: { companyId: "x", departmentSlug: "ppc", email: "a@b.c", role: "viewer", reason: REASON } });
    expect(res).toMatchObject({ status: 410, body: { code: "COMPANY_SCOPED_ACCESS_RETIRED" } });
  });

  test("missing, inactive and ambiguous targets are refused; nothing is created", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    expect((await change(admin.token(), grantBody("nobody@grav.test", "sales", "viewer"))).body.code).toBe("IDENTITY_NOT_FOUND");
    const inactive = await deptUser({ isActive: false });
    expect((await change(admin.token(), grantBody(inactive.user.email, "sales", "viewer"))).body.code).toBe("IDENTITY_INACTIVE");
    const dup = `dup.${++n}@grav.test`;
    for (const i of [1, 2]) await Employee.create({ firstName: "D", lastName: String(i), email: dup, biometricId: `G2D${i}${n}`, isActive: true, gender: "Other", department: "Tech" });
    expect((await change(admin.token(), grantBody(dup, "sales", "viewer"))).body.code).toBe("AMBIGUOUS_IDENTITY");
    expect(await DepartmentRole.countDocuments({ departmentSlug: "sales" })).toBe(0);
    expect(await DeptUser.countDocuments({ email: "nobody@grav.test" })).toBe(0);
    expect(await audits()).toBe(0);
  });
});

/* ══ Authority ═══════════════════════════════════════════════════════════ */

describe("who may change access", () => {
  test("a forged isAdmin claim is refused at the admin route; a database-verified administrator is admitted", async () => {
    await seed();
    const pretender = await deptUser();
    const { user } = await deptUser();
    expect((await change(pretender.token({ isAdmin: true }), grantBody(user.email, "sales", "viewer"))).status).toBe(403);
    const admin = await deptUser({ isAdmin: true });
    expect((await change(admin.token(), grantBody(user.email, "sales", "viewer"))).status).toBe(200);
  });

  test("an application Owner may manage that app (department-team adapter), not another, and not themselves", async () => {
    await seed();
    const owner = await deptUser({ slug: "hr" });
    await DepartmentRole.create({ departmentSlug: "hr", email: owner.user.email, role: "owner" });
    const { user } = await deptUser();
    const ok = await call("/api/department-team/hr", { token: owner.token(), body: { email: user.email, role: "editor", reason: REASON, idempotencyKey: key() } });
    expect(ok.status).toBe(200);
    expect(ok.body.effective).toMatchObject({ allowed: true, role: "editor" });

    const other = await call("/api/department-team/sales", { token: owner.token(), body: { email: user.email, role: "editor", reason: REASON, idempotencyKey: key() } });
    expect(other).toMatchObject({ status: 403, body: { code: "NOT_APPLICATION_OWNER" } });

    await DepartmentRole.create({ departmentSlug: "hr", email: "second-owner@grav.test", role: "approver" });
    const self = await call("/api/department-team/hr", { token: owner.token(), body: { email: owner.user.email, role: "viewer", reason: REASON, idempotencyKey: key() } });
    expect(self).toMatchObject({ status: 403, body: { code: "SELF_CHANGE" } });
  });

  test("authority is decided before the body: a non-Owner learns nothing from a bad body or an unknown app", async () => {
    await seed();
    const { user, token } = await deptUser({ slug: "hr" });
    const bad = await call("/api/department-team/hr", { token: token(), body: { email: user.email, role: "emperor", companyId: "x" } });
    expect(bad).toMatchObject({ status: 403, body: { code: "NOT_APPLICATION_OWNER" } });
    const ghost = await call("/api/department-team/no-such-app", { token: token(), body: { email: user.email, role: "editor", reason: REASON, idempotencyKey: key() } });
    expect(ghost.status).toBe(403);
    /* A verified administrator is told the truth about the app. */
    const admin = await deptUser({ isAdmin: true });
    const known = await change(admin.token(), grantBody(user.email, "no-such-app", "editor"));
    expect(known).toMatchObject({ status: 404, body: { code: "APP_NOT_FOUND" } });
    expect(await audits()).toBe(0);
  });

  test("an application grant never sets isAdmin, and changing isAdmin creates no grant rows", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    await change(admin.token(), grantBody(user.email, "sales", "owner"));
    expect((await DeptUser.findById(user._id).lean()).isAdmin).toBe(false);
    const before = await DepartmentRole.countDocuments({});
    const res = await call(`/api/admin/users/${user._id}`, { method: "PATCH", token: admin.token(), body: { isAdmin: true } });
    expect(res.status).toBe(200);
    expect(await DepartmentRole.countDocuments({})).toBe(before);
  });

  test("the last active administrator cannot be removed", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const res = await call(`/api/admin/users/${admin.user._id}`, { method: "PATCH", token: admin.token(), body: { isAdmin: false } });
    expect(res.status).toBe(400);
    expect((await DeptUser.findById(admin.user._id).lean()).isAdmin).toBe(true);
  });
});

/* ══ Owners, idempotency, concurrency ════════════════════════════════════ */

describe("owners, retries and races", () => {
  test("the last active application Owner cannot be revoked or demoted", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    await change(admin.token(), grantBody(user.email, "qc", "owner"));
    for (const role of [null, "approver"]) {
      const res = await change(admin.token(), grantBody(user.email, "qc", role));
      expect(res).toMatchObject({ status: 409, body: { code: "LAST_APPLICATION_OWNER" } });
    }
    expect(await resolveAppAccess(targetActor(user), "qc")).toMatchObject({ role: "owner" });
  });

  test("granting Owner demotes the incumbent (recorded), so the old Owner may then be changed", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const a = await deptUser();
    const b = await deptUser();
    await change(admin.token(), grantBody(a.user.email, "sales", "owner"));
    const res = await change(admin.token(), grantBody(b.user.email, "sales", "owner"));
    expect(res.body.after.sideEffects).toEqual([{ email: a.user.email, from: "owner", to: "approver" }]);
    expect(await DepartmentRole.countDocuments({ departmentSlug: "sales", role: "owner", isActive: true })).toBe(1);
  });

  test("a retried request with the same key returns the original result: one mutation, one audit", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const body = grantBody(user.email, "sales", "editor");
    const first = await change(admin.token(), body);
    const writtenAt = (await DepartmentRole.findOne({ email: user.email }).lean()).updatedAt;
    const second = await change(admin.token(), body);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ replayed: true, auditId: first.body.auditId, after: { role: "editor" } });
    expect(await audits()).toBe(1);
    expect((await DepartmentRole.findOne({ email: user.email }).lean()).updatedAt).toEqual(writtenAt);

    const reused = await change(admin.token(), { ...body, role: "owner" });
    expect(reused).toMatchObject({ status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await audits()).toBe(1);
  });

  test("concurrent retries of one request produce exactly one mutation and one audit", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const body = grantBody(user.email, "sales", "approver");
    const results = await Promise.all([1, 2, 3].map(() => change(admin.token(), body)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.filter((r) => !r.body.replayed)).toHaveLength(1);
    expect(await audits()).toBe(1);
  });

  test("concurrent conflicting Owner grants serialise: exactly one Owner survives", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const people = await Promise.all([1, 2, 3].map(() => deptUser()));
    const results = await Promise.all(people.map((p) => change(admin.token(), grantBody(p.user.email, "marketing", "owner"))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await DepartmentRole.countDocuments({ departmentSlug: "marketing", role: "owner", isActive: true })).toBe(1);
    expect(await audits({ departmentSlug: "marketing" })).toBe(3);
  });
});

/* ══ Caches and failure ══════════════════════════════════════════════════ */

describe("caches and failure", () => {
  test("a mutation drops the HR and QC caches, and the next resolver read reflects it", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    const hr = jest.spyOn(require("../../services/access/hrAuthorization"), "invalidateHrAuthorization");
    const qc = jest.spyOn(require("../../services/qcViewer"), "invalidateViewer");
    await change(admin.token(), grantBody(user.email, "qc", "viewer"));
    expect(hr).toHaveBeenCalled();
    expect(qc).toHaveBeenCalledWith(user.email);
    expect(await resolveAppAccess(targetActor(user), "qc")).toMatchObject({ allowed: true, role: "viewer" });
  });

  test("a database failure mid-write fails closed: no mutation, no audit", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    jest.spyOn(ChangeLog, "create").mockImplementation(() => { throw new Error("simulated outage"); });
    const res = await change(admin.token(), grantBody(user.email, "sales", "editor"));
    expect(res).toMatchObject({ status: 503, body: { code: "ACCESS_GRANT_UNAVAILABLE" } });
    expect(await DepartmentRole.countDocuments({ email: user.email })).toBe(0);
    jest.restoreAllMocks();
    expect(await audits()).toBe(0);
  });

  test("a lookup failure before the write fails closed", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const { user } = await deptUser();
    jest.spyOn(AccessDepartment, "findOne").mockImplementation(() => { throw new Error("simulated outage"); });
    await expect(grants.changeAppAccess({ actor: admin.actor, body: grantBody(user.email, "sales", "editor") }))
      .rejects.toMatchObject({ status: 503, code: "ACCESS_GRANT_UNAVAILABLE" });
    jest.restoreAllMocks();
    expect(await DepartmentRole.countDocuments({ email: user.email })).toBe(0);
    expect(await audits()).toBe(0);
  });
});
