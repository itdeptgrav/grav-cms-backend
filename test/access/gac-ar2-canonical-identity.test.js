// test/access/gac-ar2-canonical-identity.test.js
//
// GAC-AR2 — one person, one login.
//
// /login, /resolve, /verify, /switch-department and /logout all go through the
// canonical identity service (services/access/canonicalIdentity.service.js) and
// the canonical application-access resolver. Includes the mandatory live
// regression: an accounting-only owner ("RISHEE RAY") who saw one Accounting
// tile and got "Unauthorized" opening it.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.JWT_SECRET = "gac-ar2-test-secret";

const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const { authenticateLogin, CODES } = require("../../services/access/canonicalIdentity.service");
const { authenticateCmsSession } = require("../../services/cmsSession");
const migration = require("../../scripts/migrations/gac-ar2-canonical-admin");

const PASSWORD = "Correct-Horse-Battery-9";
let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api/auth", require("../../routes/auth/deptAuth"));
  app.get("/probe/session", authenticateCmsSession, (req, res) => res.json({ id: req.user.id, isAdmin: req.user.isAdmin }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

/** A tiny browser: carries cookies between requests, optionally a Bearer. */
function browser() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  return {
    jar,
    async call(p, { method = "POST", body, bearer, noCookies = false } = {}) {
      const headers = { "Content-Type": "application/json" };
      if (!noCookies && jar.size) headers.Cookie = cookieHeader();
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const r = await fetch(`${base}${p}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of r.headers.getSetCookie?.() || []) {
        const [pair, ...attrs] = c.split(";");
        const [name, ...rest] = pair.split("=");
        const value = rest.join("=");
        const cleared = !value || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a.trim()));
        if (cleared) jar.delete(name.trim()); else jar.set(name.trim(), value);
      }
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
}

async function seed() {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
}
const dept = (slug) => AccessDepartment.findOne({ slug });
const activeAppSlugs = async () => (await AccessDepartment.find({ isActive: true, slug: { $ne: "platform-admin" } }).lean()).map((d) => d.slug).sort();

async function deptUser({ email = `ar2.${++n}@grav.test`, slug = "ceo", isAdmin = false, password = PASSWORD, isActive = true } = {}) {
  const d = await dept(slug);
  const u = new DeptUser({ name: `AR2 ${n}`, email, departmentId: d._id, isAdmin, isActive, passwordHash: "x" });
  await u.setPassword(password);
  await u.save();
  return u;
}

async function accUser({ email = `acc.${++n}@grav.test`, role = "owner", name = "RISHEE RAY", org = null, password = PASSWORD } = {}) {
  const o = org || await Acc_Organization.create({ name: `AR2 Org ${++n}`, tallyCompanyIds: [] });
  const a = new Acc_User({ organizationId: o._id, name, email, role });
  await a.setPassword(password);
  await a.save();
  return a;
}

const login = (b, email, password = PASSWORD, extra = {}) => b.call("/api/auth/login", { body: { email, password, ...extra } });

/* ══ The mandatory regression: "RISHEE RAY", one Accounting tile, Unauthorized ══ */

describe("accounting-only owner (the live screenshot)", () => {
  test("signs in, sees Accounting, opens it and verifies — no Unauthorized", async () => {
    await seed();
    const acc = await accUser({ email: "rishee.ray@grav.test" });
    const b = browser();
    const res = await login(b, acc.email);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: "accountant", identityId: String(acc._id) });
    expect(res.body.departments.map((d) => d.slug)).toEqual(["accountant"]);
    expect(res.body.user.isAdmin).toBe(false);
    expect(res.body.accountantToken).toBeTruthy();

    // Opening the only tile: the launcher's switch, then the app's verify.
    const sw = await b.call("/api/auth/switch-department", { body: { slug: "accountant" } });
    expect(sw.status).toBe(200);
    const v = await b.call("/api/auth/verify");
    expect(v.status).toBe(200);
    expect(v.body.user).toMatchObject({ deptSlug: "accountant", isAdmin: false, subject: "accountant" });
    expect(v.body.departments.map((d) => d.slug)).toEqual(["accountant"]);
  });

  test("an Accounting owner cannot open another app without a grant, and is not an administrator", async () => {
    await seed();
    const acc = await accUser();
    const b = browser();
    await login(b, acc.email);
    expect((await b.call("/api/auth/switch-department", { body: { slug: "sales" } })).status).toBe(403);
    expect((await b.call("/api/auth/switch-department", { body: { slug: "ceo" } })).status).toBe(403);
    const probe = await b.call("/probe/session", { method: "GET" });
    expect(probe.body.isAdmin).toBe(false);
  });

  test("…but a real grant for another app is honoured through the resolver", async () => {
    await seed();
    const acc = await accUser();
    await DepartmentRole.create({ departmentSlug: "sales", email: acc.email, role: "viewer" });
    const b = browser();
    const res = await login(b, acc.email);
    expect(res.body.departments.map((d) => d.slug).sort()).toEqual(["accountant", "sales"]);
    expect((await b.call("/api/auth/switch-department", { body: { slug: "sales" } })).status).toBe(200);
    expect((await b.call("/api/auth/verify")).body.user.deptSlug).toBe("sales");
  });
});

/* ══ Canonical identity: administrators are never downgraded ══════════════ */

describe("canonical identity", () => {
  test("a migrated admin with a broken modern hash never receives a legacy non-admin session", async () => {
    await seed();
    const admin = await deptUser({ email: "legacy.admin@grav.test", isAdmin: true, password: "some-other-unknown-password" });
    // The legacy CEO row that IS this identity (same _id, same email) holds the working password.
    await mongoose.connection.collection("ceodepartments").insertOne({
      _id: admin._id, email: admin.email, password: await bcrypt.hash(PASSWORD, 4), role: "ceo", isActive: true,
    });
    const b = browser();
    const res = await login(b, admin.email);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ subject: "dept_user", identityId: String(admin._id) });
    expect(res.body.user.isAdmin).toBe(true);
    expect(res.body.departments.map((d) => d.slug).sort()).toEqual(await activeAppSlugs());
    const claims = jwt.decode(res.body.token);
    expect(claims.subject).toBe("dept_user");
    expect(claims.tv).toBe(admin.tokenVersion || 0);
  });

  test("a legacy row that is NOT provably the same identity opens nothing — no fallthrough", async () => {
    await seed();
    const admin = await deptUser({ email: "not.same@grav.test", isAdmin: true, password: "unknown-modern-password" });
    await mongoose.connection.collection("ceodepartments").insertOne({
      _id: new mongoose.Types.ObjectId(), email: admin.email, password: await bcrypt.hash(PASSWORD, 4), role: "ceo", isActive: true,
    });
    const res = await login(browser(), admin.email);
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined(); // indistinguishable from "no such account"
  });

  test("a DeptUser with an Employee and an Acc_User of the same address signs in as the DeptUser", async () => {
    await seed();
    const email = `linked.${++n}@grav.test`;
    await Employee.create({ firstName: "L", lastName: "P", email, biometricId: `LP${n}`, isActive: true, gender: "Other", department: "Tech", password: "employee-password-1" });
    await accUser({ email, role: "owner" });
    const du = await deptUser({ email, isAdmin: true });
    const res = await login(browser(), email);
    expect(res.body).toMatchObject({ subject: "dept_user", identityId: String(du._id) });
    // The employee's credential does not unlock the canonical DeptUser.
    expect((await login(browser(), email, "employee-password-1")).status).toBe(401);
  });

  test.each(["dept_user", "employee", "accountant"])("/resolve and /login name the same %s identity", async (kind) => {
    await seed();
    let email;
    if (kind === "dept_user") ({ email } = await deptUser({ isAdmin: true }));
    if (kind === "employee") {
      email = `emp.${++n}@grav.test`;
      await Employee.create({ firstName: "E", lastName: "P", email, biometricId: `EP${n}`, isActive: true, gender: "Other", department: "Tech", accessDepartmentId: (await dept("sales"))._id, password: PASSWORD }); // the model hashes on save
      await DepartmentRole.create({ departmentSlug: "sales", email, role: "editor" });
    }
    if (kind === "accountant") ({ email } = await accUser());
    const r = await browser().call("/api/auth/resolve", { body: { email, password: PASSWORD } });
    const l = await login(browser(), email);
    expect(r.status).toBe(200);
    expect(l.status).toBe(200);
    expect({ subject: r.body.subject, id: r.body.identityId, apps: r.body.departments.map((d) => d.slug).sort() })
      .toEqual({ subject: l.body.subject, id: l.body.identityId, apps: l.body.departments.map((d) => d.slug).sort() });
    expect(r.body.subject).toBe(kind);
  });

  test("ambiguous duplicates fail closed: two active employees, or Acc_Users in two organisations", async () => {
    await seed();
    const email = `dup.${++n}@grav.test`;
    for (const i of [1, 2]) {
      await Employee.create({ firstName: "D", lastName: String(i), email, biometricId: `DUP${i}${n}`, isActive: true, gender: "Other", department: "Tech", password: PASSWORD }); // the model hashes on save
    }
    const e = await login(browser(), email);
    expect(e).toMatchObject({ status: 409, body: { code: CODES.AMBIGUOUS_IDENTITY } });
    expect((await login(browser(), email, "wrong-password-xx")).status).toBe(401); // nothing disclosed without the password

    const accEmail = `dupacc.${++n}@grav.test`;
    await accUser({ email: accEmail });
    await accUser({ email: accEmail });
    expect(await login(browser(), accEmail)).toMatchObject({ status: 409, body: { code: CODES.AMBIGUOUS_IDENTITY } });
  });

  test("a database failure during identity lookup grants nothing and sets no cookie", async () => {
    await seed();
    const u = await deptUser({ isAdmin: true });
    jest.spyOn(DeptUser, "findOne").mockImplementation(() => { throw new Error("simulated outage"); });
    const b = browser();
    const res = await login(b, u.email);
    expect(res).toMatchObject({ status: 503, body: { code: CODES.LOOKUP_FAILED } });
    expect(b.jar.size).toBe(0);
    expect((await authenticateLogin(u.email, PASSWORD)).ok).toBe(false);
  });
});

/* ══ Administrator, revocation and session consistency ═══════════════════ */

describe("sessions", () => {
  test("a database-verified administrator gets every active app, as Owner, from login", async () => {
    await seed();
    const u = await deptUser({ isAdmin: true });
    const b = browser();
    const res = await login(b, u.email);
    expect(res.body.departments.map((d) => d.slug).sort()).toEqual(await activeAppSlugs());
    expect(res.body.redirectTo).toBe("/onboarding");
    for (const slug of ["accountant", "ppc", "hr"]) {
      expect((await b.call("/api/auth/switch-department", { body: { slug } })).status).toBe(200);
      expect((await b.call("/api/auth/verify")).body.user.deptRole).toBe("owner");
    }
  });

  test("a stale token version is rejected by verify and by switch (DeptUser and accounting-only)", async () => {
    await seed();
    const u = await deptUser({ isAdmin: true });
    const b = browser();
    const { body } = await login(b, u.email);
    await DeptUser.updateOne({ _id: u._id }, { $inc: { tokenVersion: 1 } });
    expect(await b.call("/api/auth/verify", { bearer: body.token, noCookies: true })).toMatchObject({ status: 401, body: { code: "SESSION_REVOKED" } });
    expect((await b.call("/api/auth/switch-department", { bearer: body.token, noCookies: true, body: { slug: "hr" } })).status).toBe(401);

    const acc = await accUser();
    const a = browser();
    const accLogin = await login(a, acc.email);
    await Acc_User.updateOne({ _id: acc._id }, { $inc: { tokenVersion: 1 } });
    expect((await a.call("/api/auth/verify", { bearer: accLogin.body.token, noCookies: true })).status).toBe(401);
    expect((await a.call("/api/auth/switch-department", { bearer: accLogin.body.token, noCookies: true, body: { slug: "accountant" } })).status).toBe(401);
  });

  test("a stale local Bearer cannot outvote a newer cookie; verify hands back the cookie's token", async () => {
    await seed();
    await DepartmentRole.create({ departmentSlug: "hr", email: "someone@grav.test", role: "owner" });
    const u = await deptUser({ isAdmin: true });
    const b = browser();
    const first = await login(b, u.email);
    // An administrator's old token, then admin removed and a fresh session issued.
    await DeptUser.updateOne({ _id: u._id }, { $set: { isAdmin: false } });
    const second = await login(b, u.email); // cookie jar now holds the NEW token
    const v = await b.call("/api/auth/verify", { bearer: first.body.token });
    expect(v.status).toBe(200);
    expect(v.body.sessionToken).toBe(second.body.token);
    expect(v.body.user.isAdmin).toBe(false);
    // The shared reader behind admin/role-management routes also prefers the cookie.
    const probe = await b.call("/probe/session", { method: "GET", bearer: first.body.token });
    expect(probe.body.isAdmin).toBe(false);
  });

  test("logout clears the CMS and Accounting cookies and ends the session server-side", async () => {
    await seed();
    const acc = await accUser();
    const b = browser();
    const res = await login(b, acc.email);
    expect(b.jar.has("auth_token")).toBe(true);
    expect(b.jar.has("accountant_token")).toBe(true);
    await b.call("/api/auth/logout", { bearer: res.body.token });
    expect(b.jar.has("auth_token")).toBe(false);
    expect(b.jar.has("accountant_token")).toBe(false);
    // The old token, replayed from local storage, no longer works.
    expect((await b.call("/api/auth/verify", { bearer: res.body.token, noCookies: true })).status).toBe(401);
  });

  test("every new session is labelled with its subject and current token version", async () => {
    await seed();
    const u = await deptUser();
    await DepartmentRole.create({ departmentSlug: "ceo", email: u.email, role: "viewer" });
    const b = browser();
    const res = await login(b, u.email);
    const tv = (await DeptUser.findById(u._id).lean()).tokenVersion || 0; // setPassword bumps it
    expect(jwt.decode(res.body.token)).toMatchObject({ subject: "dept_user", tv });
    const sw = await b.call("/api/auth/switch-department", { body: { slug: "ceo" } });
    expect(jwt.decode(sw.body.token)).toMatchObject({ subject: "dept_user", tv });
  });
});

/* ══ The administrator migration ═════════════════════════════════════════ */

describe("gac-ar2-canonical-admin migration", () => {
  const models = () => ({ DeptUser, AccessDepartment, Acc_User });

  async function world() {
    await seed();
    const ceo = await deptUser({ email: "ceo@grav.in", isAdmin: true });
    const ray = await accUser({ email: "ray@grav.in", role: "owner" });
    return { ceo, ray };
  }
  const snapshot = async () => ({
    users: await DeptUser.find({}).lean(),
    acc: await Acc_User.find({}).lean(),
  });

  test("the dry run plans the migration and writes nothing; twice gives the same plan", async () => {
    await world();
    const before = await snapshot();
    const p1 = migration.publicView(await migration.planMigration(models()));
    const p2 = migration.publicView(await migration.planMigration(models()));
    expect(p1).toEqual(p2);
    expect(p1.actions).toEqual(["CREATE_CANONICAL_DEPT_USER_REUSING_ACC_USER_BCRYPT", "MARK_DUPLICATE_TRANSITIONAL"]);
    expect(p1.blockers).toEqual([]);
    expect(p1.counts).toMatchObject({ activeAdminsBefore: 1, activeAdminsAfter: 2, recordsToDelete: 0, targetAccountingOwner: 1 });
    expect(JSON.stringify(p1)).not.toMatch(/\$2[aby]\$/); // no hash in the report
    expect(await snapshot()).toEqual(before);
  });

  test("apply makes ray the canonical admin with the SAME credential; a second run plans nothing", async () => {
    const { ray } = await world();
    await migration.applyMigration(models(), await migration.planMigration(models()));
    const canonical = await DeptUser.findOne({ email: "ray@grav.in" }).lean();
    expect(canonical).toMatchObject({ isAdmin: true, isActive: true });
    expect(String(canonical.departmentId)).toBe(String((await dept("ceo"))._id));
    expect(canonical.passwordHash).toBe((await Acc_User.findById(ray._id).lean()).passwordHash);
    expect((await Acc_User.findById(ray._id).lean()).role).toBe("owner");
    const dup = await DeptUser.findOne({ email: "ceo@grav.in" }).lean();
    expect(dup).toMatchObject({ isActive: true, isAdmin: true, identityTransition: { supersededByEmail: "ray@grav.in", eligibleForDeactivation: false } });
    expect((await migration.planMigration(models())).actions).toEqual([]);

    // And the SAME password now opens the full administrator session.
    const res = await login(browser(), "ray@grav.in");
    expect(res.body).toMatchObject({ subject: "dept_user", identityId: String(canonical._id) });
    expect(res.body.user.isAdmin).toBe(true);
    expect(res.body.departments.map((d) => d.slug).sort()).toEqual(await activeAppSlugs());
  });

  test("last-admin protection: the duplicate cannot be deactivated until ray is verified AND another admin remains", async () => {
    await world();
    let d = await migration.planDeactivation(models());
    expect(d.blockers).toContain("DUPLICATE_NOT_MARKED_TRANSITIONAL");

    await migration.applyMigration(models(), await migration.planMigration(models()));
    d = await migration.planDeactivation(models());
    expect(d.blockers).toContain("CANONICAL_NOT_VERIFIED_BY_SIGN_IN");
    await expect(migration.applyDeactivation(models(), d)).rejects.toThrow(/Refusing/);

    await login(browser(), "ray@grav.in"); // a verified sign-in
    await DeptUser.updateOne({ email: "ray@grav.in" }, { $set: { isAdmin: false } }); // …but ray lost admin
    d = await migration.planDeactivation(models());
    expect(d.blockers).toEqual(expect.arrayContaining(["CANONICAL_NOT_ACTIVE_ADMIN", "LAST_ACTIVE_ADMINISTRATOR"]));

    await DeptUser.updateOne({ email: "ray@grav.in" }, { $set: { isAdmin: true } });
    d = await migration.planDeactivation(models());
    expect(d.blockers).toEqual([]);
    await migration.applyDeactivation(models(), d);
    const dup = await DeptUser.findOne({ email: "ceo@grav.in" }).lean();
    expect(dup.isActive).toBe(false);
    expect(await DeptUser.countDocuments({ isAdmin: true, isActive: true })).toBe(1);
    expect(await DeptUser.countDocuments({ email: "ceo@grav.in" })).toBe(1); // never deleted
  });
});
