// test/access/gac2-corrections.test.js
//
// GAC-2 CORRECTION — one test group per defect found in review (25 Sep 2026).
//
//   1. Live bypasses of the canonical write (Accounting team routes, invites,
//      bootstrap, sync-legacy auto-owner, admin hard delete, fixture writers).
//   2. An Accounting role row created for a DeptUser/Employee must not be an
//      identity or a login — by explicit semantics, not an unknown password.
//   3. The access audit is append-only, not merely inserted.
//   4. Idempotency is enforced by storage across applications.
//   5. An automatically demoted Accounting Owner's sessions end.
//   6. Stale authorization cannot survive a failed or remote cache clear.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const { Acc_User, Acc_Organization, Acc_Invite } = require("../../models/Accountant_model/Acc_OrgModels");
const Acc_Department = require("../../models/Accountant_model/Acc_Department");
const {
  AccessGrantEvent, AccessGrantHead, HEAD_ID, verifyChain,
} = require("../../models/Access/AccessGrantEvent");
const requirePlatformAdmin = require("../../Middlewear/requirePlatformAdmin");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const { invalidate } = require("../../services/memo");
const { resolveAppAccess } = require("../../services/access/appAccess.service");
const { classify, findCandidates } = require("../../services/access/canonicalIdentity.service");
const { changeAppAccess } = require("../../services/access/accessGrantAdmin.service");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const grantRevision = require("../../services/access/grantRevision");

let server, base, n = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", requirePlatformAdmin, require("../../routes/Admin/accessAdmin"));
  app.use("/api/accountant/team", require("../../routes/Accountant_Routes/Acc_team"));
  app.use("/api/accountant/auth", require("../../routes/Accountant_Routes/Acc_auth"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await DepartmentRole.syncIndexes();
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (p, { method = "PUT", token, cookies = {}, body, headers = {} } = {}) => fetch(`${base}${p}`, {
  method,
  headers: {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(Object.keys(cookies).length ? { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
    ...headers,
  },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

async function seed() {
  await ensureAccessDepartments(mongoose.connection);
  invalidate("access-departments:active");
}

async function deptUser({ email = `corr.${++n}@grav.test`, isAdmin = false } = {}) {
  const d = await AccessDepartment.findOne({ slug: "ceo" });
  const user = await DeptUser.create({ name: `Corr ${n}`, email, passwordHash: "x", departmentId: d._id, isAdmin, isActive: true });
  const token = () => jwt.sign(
    { v: 2, id: String(user._id), deptId: String(d._id), deptSlug: d.slug, email: user.email, name: user.name,
      isAdmin, subject: "dept_user", tv: user.tokenVersion || 0 },
    process.env.JWT_SECRET, { expiresIn: "10m" },
  );
  return { user, token, actor: { id: user._id, email: user.email, name: user.name, subject: "dept_user", tv: user.tokenVersion || 0 } };
}

async function employee({ email = `emp.${++n}@grav.test`, accessDepartmentId } = {}) {
  return Employee.create({
    firstName: "Emp", lastName: String(n), email, biometricId: `GC${n}`, isActive: true, gender: "Other",
    department: "Tech", ...(accessDepartmentId ? { accessDepartmentId } : {}),
  });
}

const org = () => Acc_Organization.create({ name: "GRAV Clothing" });

/** An accounting-only person: their Acc_User row IS their identity and login. */
async function accountingOnly(o, { role = "editor", email = `acc.${++n}@grav.test`, password = "Correct-Horse-9" } = {}) {
  const u = new Acc_User({ organizationId: o._id, name: `Acc ${n}`, email, role, isActive: true });
  await u.setPassword(password);
  await u.save();
  return u;
}

const key = () => `corr-${++n}-${Date.now()}`;
const REASON = "Quarter-end close needs another pair of hands";
const grant = (token, email, application, role, extra = {}) =>
  call("/api/admin/app-access", { token, body: { email, application, role, reason: REASON, idempotencyKey: key(), ...extra } });

/* ══ 1 · every live bypass is routed or retired ═══════════════════════════ */

describe("1 · the Accounting team screen goes through the canonical write", () => {
  async function teamSetup() {
    await seed();
    const o = await org();
    const owner = await accountingOnly(o, { role: "owner" });
    const member = await accountingOnly(o, { role: "viewer" });
    return { o, owner, member, cookies: { accountant_token: signOrgToken(owner) } };
  }

  test("a role change without a reason is refused and changes nothing", async () => {
    const { member, cookies } = await teamSetup();
    const res = await call(`/api/accountant/team/${member._id}`, { method: "PATCH", cookies, body: { role: "editor" } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
    expect((await Acc_User.findById(member._id).lean()).role).toBe("viewer");
    expect(await AccessGrantEvent.countDocuments()).toBe(0);
  });

  test("a role change with a reason lands through changeAppAccess: audit event, session version bumped", async () => {
    const { member, cookies } = await teamSetup();
    const k = key();
    const res = await call(`/api/accountant/team/${member._id}`, {
      method: "PATCH", cookies, body: { role: "editor", reason: REASON, idempotencyKey: k },
    });
    expect(res.status).toBe(200);
    expect(res.body.effective).toMatchObject({ allowed: true, role: "editor" });
    const row = await Acc_User.findById(member._id).lean();
    expect(row.role).toBe("editor");
    expect(row.tokenVersion).toBe((member.tokenVersion || 0) + 1);
    expect(await AccessGrantEvent.findById(k).lean()).toMatchObject({ application: "accountant", via: "accountant-team:patch" });
  });

  test("a name-only edit is not an access change and needs no reason", async () => {
    const { member, cookies } = await teamSetup();
    const res = await call(`/api/accountant/team/${member._id}`, { method: "PATCH", cookies, body: { name: "Renamed Person" } });
    expect(res.status).toBe(200);
    expect((await Acc_User.findById(member._id).lean()).name).toBe("Renamed Person");
    expect(await AccessGrantEvent.countDocuments()).toBe(0);
  });

  test("deactivate is a canonical revoke; activate a canonical re-grant (person with a GRAV login)", async () => {
    const { o, cookies } = await teamSetup();
    const person = await deptUser();
    const member = await Acc_User.create({ organizationId: o._id, email: person.user.email, name: "Role only", role: "viewer", loginMode: "none" });
    const off = await call(`/api/accountant/team/${member._id}/deactivate`, { method: "POST", cookies, body: { reason: REASON, idempotencyKey: key() } });
    expect(off.status).toBe(200);
    expect(off.body.effective.allowed).toBe(false);
    let row = await Acc_User.findById(member._id).lean();
    expect(row.isActive).toBe(false);
    expect(row.tokenVersion).toBe((member.tokenVersion || 0) + 1);

    const noReason = await call(`/api/accountant/team/${member._id}/activate`, { method: "POST", cookies, body: {} });
    expect(noReason.status).toBe(400);

    const on = await call(`/api/accountant/team/${member._id}/activate`, { method: "POST", cookies, body: { reason: REASON, idempotencyKey: key() } });
    expect(on.status).toBe(200);
    row = await Acc_User.findById(member._id).lean();
    expect(row).toMatchObject({ isActive: true, role: "viewer" });
    expect(await AccessGrantEvent.countDocuments({ application: "accountant" })).toBe(2);
  });

  test("an accounting-only person's deactivation is a revoke; reactivating their LOGIN is identity administration, refused here", async () => {
    const { member, cookies } = await teamSetup();
    expect((await call(`/api/accountant/team/${member._id}/deactivate`, { method: "POST", cookies, body: { reason: REASON, idempotencyKey: key() } })).status).toBe(200);
    const on = await call(`/api/accountant/team/${member._id}/activate`, { method: "POST", cookies, body: { reason: REASON, idempotencyKey: key() } });
    expect(on).toMatchObject({ status: 409, body: { code: "IDENTITY_INACTIVE" } });
    expect((await Acc_User.findById(member._id).lean()).isActive).toBe(false);
  });

  test("the Accounting owner cannot be deactivated through the team screen (canonical rule)", async () => {
    const { owner, cookies } = await teamSetup();
    // Self-change is refused for a non-administrator before any rule runs.
    const res = await call(`/api/accountant/team/${owner._id}/deactivate`, { method: "POST", cookies, body: { reason: REASON, idempotencyKey: key() } });
    expect([403, 409]).toContain(res.status);
    expect((await Acc_User.findById(owner._id).lean()).isActive).toBe(true);
  });

  test("hard delete, invites, invite acceptance and bootstrap are retired (410) and write nothing", async () => {
    const { member, cookies } = await teamSetup();
    const del = await call(`/api/accountant/team/${member._id}`, { method: "DELETE", cookies });
    expect(del).toMatchObject({ status: 410, body: { code: "ACCOUNTING_DELETE_RETIRED" } });
    expect(await Acc_User.exists({ _id: member._id })).toBeTruthy();

    const inv = await call("/api/accountant/team/invites", { method: "POST", cookies, body: { name: "X", email: "x@grav.test", role: "viewer" } });
    expect(inv.status).toBe(410);
    expect(await Acc_Invite.countDocuments()).toBe(0);

    const accept = await call("/api/accountant/auth/accept-invite", { method: "POST", body: { token: "t", password: "longenough1" } });
    expect(accept.status).toBe(410);
    const boot = await call("/api/accountant/auth/bootstrap", { method: "POST", body: { organizationName: "X", ownerName: "Y", email: "y@grav.test", password: "longenough1" } });
    expect(boot.status).toBe(410);
    expect(await Acc_User.countDocuments({ email: { $in: ["x@grav.test", "y@grav.test"] } })).toBe(0);
  });

  test("the admin hard delete of an Accounting user is retired (410) and the row is kept", async () => {
    await seed();
    const o = await org();
    const admin = await deptUser({ isAdmin: true });
    const person = await accountingOnly(o);
    const res = await call(`/api/admin/accountant-users/${encodeURIComponent(person.email)}`, { method: "DELETE", token: admin.token() });
    expect(res.status).toBe(410);
    expect(await Acc_User.exists({ _id: person._id })).toBeTruthy();
  });
});

describe("1 · sync-legacy no longer creates an Accounting Owner", () => {
  test("a legacy Accounting account with no Acc_User is refused; nothing is created", async () => {
    const dept = await Acc_Department.create({
      email: `legacy${++n}@grav.test`, password: "dept-password", name: "Legacy", employeeId: `L${n}`, phone: "9999999999", role: "admin",
    });
    const token = jwt.sign({ id: String(dept._id), role: "admin", email: dept.email, name: dept.name }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await call("/api/accountant/auth/sync-legacy", { method: "POST", cookies: { auth_token: token }, body: {} });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNTING_GRANT_REQUIRED");
    expect(await Acc_User.countDocuments()).toBe(0);
    expect(await Acc_Organization.countDocuments()).toBe(0);
  });
});

describe("1 · the fixture writers refuse outside tests", () => {
  test("departmentRoles.setRole and companyAccess.change refuse in production; Accounting refuses always", async () => {
    const { setRole } = require("../../services/departmentRoles");
    const { change } = require("../../services/companyContext/companyAccess.service");
    await expect(setRole({ departmentSlug: "accountant", email: "a@grav.test", role: "viewer" }))
      .rejects.toMatchObject({ code: "DIRECT_ROLE_WRITE_RETIRED" });
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(setRole({ departmentSlug: "sales", email: "a@grav.test", role: "viewer" }))
        .rejects.toMatchObject({ code: "DIRECT_ROLE_WRITE_RETIRED" });
      await expect(change({ companyId: new mongoose.Types.ObjectId(), departmentSlug: "ppc", email: "a@grav.test", role: "viewer", reason: "r" }))
        .rejects.toMatchObject({ code: "COMPANY_SCOPED_ACCESS_RETIRED" });
    } finally {
      process.env.NODE_ENV = was;
    }
    expect(await DepartmentRole.countDocuments()).toBe(0);
  });
});

/* ══ 2 · role-only Accounting rows are not identities or logins ═══════════ */

describe("2 · an Accounting grant to a GRAV login creates role storage, not an identity", () => {
  test("the row is loginMode none with no password hash; the person stays their DeptUser", async () => {
    await seed();
    await org();
    const admin = await deptUser({ isAdmin: true });
    const person = await deptUser();
    const res = await grant(admin.token(), person.user.email, "accountant", "editor");
    expect(res.status).toBe(200);
    expect(res.body.effective).toMatchObject({ allowed: true, role: "editor" });

    const row = await Acc_User.findOne({ email: person.user.email }).lean();
    expect(row.loginMode).toBe("none");
    expect(row.passwordHash).toBeUndefined();

    expect((await classify(person.user.email)).kind).toBe("dept_user");
    const c = await findCandidates(person.user.email);
    expect(c.accUsers).toHaveLength(0);
    expect(c.accRoleRows).toHaveLength(1);
  });

  test("an Employee target likewise, and the row never becomes ambiguous with the Employee", async () => {
    await seed();
    await org();
    const admin = await deptUser({ isAdmin: true });
    const emp = await employee();
    expect((await grant(admin.token(), emp.email, "accountant", "viewer")).status).toBe(200);
    expect((await classify(emp.email)).kind).toBe("employee");
    // Even with the Employee gone, the role row does not turn into a login.
    await Employee.updateOne({ _id: emp._id }, { $set: { isActive: false } });
    expect((await classify(emp.email)).kind).not.toBe("accountant");
  });

  test("every password path refuses a role-only row by its semantics", async () => {
    await seed();
    const o = await org();
    const person = await deptUser();
    const row = await Acc_User.create({ organizationId: o._id, email: person.user.email, name: "R", role: "approver", loginMode: "none" });
    expect(await row.checkPassword("")).toBe(false);
    expect(await row.checkPassword("anything at all")).toBe(false);
    await expect(row.setPassword("a-new-password")).rejects.toMatchObject({ code: "ROLE_ONLY_RECORD" });

    const login = await call("/api/accountant/auth/login", { method: "POST", body: { email: person.user.email, password: "anything at all" } });
    expect(login.status).toBe(401);

    // An accounting-subject session can never stand on it.
    const asAccountant = await resolveAppAccess({ id: row._id, email: row.email, subject: "accountant", tv: 0 }, "accountant");
    expect(asAccountant).toMatchObject({ allowed: false, denialCode: "IDENTITY_NOT_FOUND" });
  });

  test("an OLD Accounting row with a real password is still refused at the books login when the person has a GRAV login", async () => {
    await seed();
    const o = await org();
    const person = await deptUser();
    const legacyRow = new Acc_User({ organizationId: o._id, email: person.user.email, name: "Old", role: "editor", isActive: true });
    await legacyRow.setPassword("Known-Password-1");
    await legacyRow.save();
    const res = await call("/api/accountant/auth/login", { method: "POST", body: { email: person.user.email, password: "Known-Password-1" } });
    expect(res.status).toBe(401);
  });

  test("the dry-run migration finds OLD role rows with a password and, applied (in-memory), makes them role-only", async () => {
    await seed();
    const o = await org();
    const person = await deptUser();
    const old = new Acc_User({ organizationId: o._id, email: person.user.email, name: "Old", role: "viewer", isActive: true });
    await old.setPassword("Random-Unknown-9");
    await old.save();
    await accountingOnly(o); // must be left alone
    const { plan, apply } = require("../../scripts/migrations/gac2-accounting-role-only");
    const p1 = await plan();
    expect(p1.counts).toMatchObject({ candidates: 1, accountingOnly: 1, ambiguous: 0 });
    expect(await apply(p1.candidateIds)).toEqual({ modified: 1 });
    const row = await Acc_User.findById(old._id).lean();
    expect(row).toMatchObject({ loginMode: "none", role: "viewer", isActive: true });
    expect(row.passwordHash).toBeUndefined();
    expect((await plan()).counts.candidates).toBe(0); // idempotent
  });

  test("control: an accounting-only person still signs in to the books with their own password", async () => {
    await seed();
    const o = await org();
    const acc = await accountingOnly(o, { password: "Own-Password-22" });
    const res = await call("/api/accountant/auth/login", { method: "POST", body: { email: acc.email, password: "Own-Password-22" } });
    expect(res.status).toBe(200);
  });
});

/* ══ 3 · the audit is append-only ═════════════════════════════════════════ */

describe("3 · access audit events cannot be changed or removed", () => {
  async function oneEvent() {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const person = await deptUser();
    const res = await grant(admin.token(), person.user.email, "sales", "viewer");
    expect(res.status).toBe(200);
    return res.body.auditId;
  }

  test("every Mongoose mutation path is refused", async () => {
    const id = await oneEvent();
    const attempts = [
      () => AccessGrantEvent.updateOne({ _id: id }, { $set: { reason: "rewritten" } }),
      () => AccessGrantEvent.updateMany({}, { $set: { reason: "rewritten" } }),
      () => AccessGrantEvent.findOneAndUpdate({ _id: id }, { $set: { reason: "rewritten" } }),
      () => AccessGrantEvent.replaceOne({ _id: id }, { reason: "gone" }),
      () => AccessGrantEvent.findOneAndReplace({ _id: id }, { reason: "gone" }),
      () => AccessGrantEvent.deleteOne({ _id: id }),
      () => AccessGrantEvent.deleteMany({}),
      () => AccessGrantEvent.findOneAndDelete({ _id: id }),
      () => AccessGrantEvent.bulkWrite([{ deleteOne: { filter: { _id: id } } }]),
      async () => { const d = await AccessGrantEvent.findById(id); d.reason = "rewritten"; await d.save(); },
      async () => { const d = await AccessGrantEvent.findById(id); await d.deleteOne(); },
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toMatchObject({ code: "ACCESS_AUDIT_IMMUTABLE" });
    }
    expect((await AccessGrantEvent.findById(id).lean()).reason).toBe(REASON);
    expect(await verifyChain()).toMatchObject({ ok: true, events: 1 });
  });

  test("a raw driver edit or delete — the path middleware cannot see — breaks the hash chain", async () => {
    const id = await oneEvent();
    await oneEvent();
    expect((await verifyChain()).ok).toBe(true);
    await AccessGrantEvent.collection.updateOne({ _id: id }, { $set: { reason: "quietly rewritten" } });
    expect(await verifyChain()).toMatchObject({ ok: false, brokenAt: 1 });
  });

  test("a raw delete of an event is detected", async () => {
    await oneEvent();
    const id2 = await oneEvent();
    await AccessGrantEvent.collection.deleteOne({ _id: id2 });
    expect((await verifyChain()).ok).toBe(false);
  });

  test("no production code deletes from or updates the audit collection", () => {
    const { execSync } = require("child_process");
    const hits = execSync(
      "git grep --untracked -nE \"access_grant_events|AccessGrantEvent\\.(update|delete|findOneAnd|replace|bulkWrite)\" -- routes services Middlewear scripts server.js 'verify*.js' ':!services/access/accessGrantAdmin.service.js' || true",
      { cwd: require("path").join(__dirname, "../.."), encoding: "utf8" },
    ).trim();
    expect(hits).toBe("");
  });
});

/* ══ 4 · idempotency is enforced by storage, across applications ══════════ */

describe("4 · one idempotency key, one event — whichever application", () => {
  test("two simultaneous requests with one key for DIFFERENT applications: one mutation, one event", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const person = await deptUser();
    const k = key();
    const body = (application) => ({ email: person.user.email, application, role: "editor", reason: REASON, idempotencyKey: k });
    const [a, b] = await Promise.all([
      call("/api/admin/app-access", { token: admin.token(), body: body("sales") }),
      call("/api/admin/app-access", { token: admin.token(), body: body("hr") }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect([a, b].find((r) => r.status === 409).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(await AccessGrantEvent.countDocuments({ _id: k })).toBe(1);
    expect(await DepartmentRole.countDocuments({ email: person.user.email, isActive: true })).toBe(1);
  });

  test("the key is the event's _id, so the database itself refuses a second event", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const person = await deptUser();
    const res = await grant(admin.token(), person.user.email, "sales", "viewer");
    const dup = { ...(await AccessGrantEvent.findById(res.body.auditId).lean()), seq: 999 };
    await expect(AccessGrantEvent.collection.insertOne(dup)).rejects.toMatchObject({ code: 11000 });
  });
});

/* ══ 5 · a demoted Accounting Owner's sessions end ════════════════════════ */

describe("5 · automatic Owner demotion revokes the old Owner's Accounting sessions", () => {
  test("tokenVersion increments and the old accountant token is refused", async () => {
    await seed();
    const o = await org();
    const oldOwner = await accountingOnly(o, { role: "owner" });
    const oldToken = signOrgToken(oldOwner);
    expect((await call("/api/accountant/team", { method: "GET", cookies: { accountant_token: oldToken } })).status).toBe(200);

    const admin = await deptUser({ isAdmin: true });
    const successor = await deptUser();
    const res = await grant(admin.token(), successor.user.email, "accountant", "owner");
    expect(res.status).toBe(200);
    expect(res.body.after.sideEffects).toEqual([expect.objectContaining({ email: oldOwner.email, from: "owner", to: "approver", sessionsEnded: true })]);

    const row = await Acc_User.findById(oldOwner._id).lean();
    expect(row.role).toBe("approver");
    expect(row.tokenVersion).toBe((oldOwner.tokenVersion || 0) + 1);
    const stale = await call("/api/accountant/team", { method: "GET", cookies: { accountant_token: oldToken } });
    expect(stale.status).toBe(401);
  });
});

/* ══ 6 · stale authority cannot survive a failed or remote cache clear ════ */

describe("6 · caches check the shared grant revision on every hit", () => {
  test("QC: with the local clear failing, the next check still sees the new role", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const inspector = await deptUser();
    await DepartmentRole.create({ departmentSlug: "qc", email: "qc.owner@grav.test", role: "owner" });
    await DepartmentRole.create({ departmentSlug: "qc", email: inspector.user.email, role: "viewer" });
    const qcViewer = require("../../services/qcViewer");
    qcViewer.invalidateViewer();
    const req = { user: { id: String(inspector.user._id), email: inspector.user.email } };
    expect((await qcViewer.resolveViewer(req)).role).toBe("viewer");

    // Control: a change the cache is not told about, with no revision bump,
    // is served stale — so the cache is real and the next assertion means something.
    await DepartmentRole.collection.updateOne({ departmentSlug: "qc", email: inspector.user.email }, { $set: { role: "editor" } });
    expect((await qcViewer.resolveViewer(req)).role).toBe("viewer");
    await DepartmentRole.collection.updateOne({ departmentSlug: "qc", email: inspector.user.email }, { $set: { role: "viewer" } });

    // The canonical write, as another process would see it: the local clear fails.
    jest.spyOn(qcViewer, "invalidateViewer").mockImplementation(() => { throw new Error("clear failed"); });
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await grant(admin.token(), inspector.user.email, "qc", "approver");
    expect(res.status).toBe(200);
    expect((await qcViewer.resolveViewer(req)).role).toBe("approver");
  });

  test("HR: with the local clear failing, a revoke is seen on the next resolve", async () => {
    await seed();
    const hr = await AccessDepartment.findOne({ slug: "hr" });
    const admin = await deptUser({ isAdmin: true });
    await DepartmentRole.create({ departmentSlug: "hr", email: "hr.owner@grav.test", role: "owner" });
    const emp = await employee({ accessDepartmentId: hr._id });
    await DepartmentRole.create({ departmentSlug: "hr", email: emp.email, role: "approver" });
    const hrAuth = require("../../services/access/hrAuthorization");
    hrAuth.invalidateHrAuthorization("test start");
    const user = { id: String(emp._id), email: emp.email, employeeId: emp.biometricId, role: "hr_manager" };
    expect((await hrAuth.resolveHrActor(user)).departmentRole).toBe("approver");

    jest.spyOn(hrAuth, "invalidateHrAuthorization").mockImplementation(() => { throw new Error("clear failed"); });
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await grant(admin.token(), emp.email, "hr", null);
    expect(res.status).toBe(200);
    expect((await hrAuth.resolveHrActor(user)).departmentRole).toBeNull();
  });

  test("the administrator write advances the revision in the same transaction as the save", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const other = await deptUser();
    const before = await grantRevision.currentGrantRevision();
    const res = await call(`/api/admin/users/${other.user._id}`, { method: "PATCH", token: admin.token(), body: { isAdmin: true } });
    expect(res.status).toBe(200);
    expect(await grantRevision.currentGrantRevision()).toBe(before + 1);
    expect((await DeptUser.findById(other.user._id).lean()).isAdmin).toBe(true); // the change itself persisted
    expect(await DepartmentRole.countDocuments({ email: other.user.email })).toBe(0); // no grant rows
  });

  test("the administrator write lands even when its transaction is retried", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const other = await deptUser({ isAdmin: true });
    // mongoose's own driver copy, so the driver recognises the error class.
    const { MongoError } = require(require.resolve("mongodb", { paths: [require.resolve("mongoose")] }));
    const real = grantRevision.bumpGrantRevision;
    let first = true;
    jest.spyOn(grantRevision, "bumpGrantRevision").mockImplementation(async (session) => {
      if (first) {
        first = false;
        const e = new MongoError("simulated write conflict");
        e.addErrorLabel("TransientTransactionError");
        throw e;
      }
      return real(session);
    });
    const res = await call(`/api/admin/users/${other.user._id}`, { method: "PATCH", token: admin.token(), body: { isActive: false } });
    expect(res.status).toBe(200);
    expect(first).toBe(false); // the retry really happened
    const after = await DeptUser.findById(other.user._id).lean();
    expect(after.isActive).toBe(false);
    expect(after.tokenVersion).toBe((other.user.tokenVersion || 0) + 1);
  });

  test("an unreadable revision is a cache MISS, never a hit", async () => {
    jest.spyOn(AccessGrantHead, "findById").mockImplementation(() => { throw new Error("db down"); });
    expect(await grantRevision.cacheEntryIsCurrent({ revision: 0 })).toBe(false);
    expect(await grantRevision.revisionForNewEntry()).toBeNull();
  });

  test("a grant transaction advances the shared revision (every process's next check misses)", async () => {
    await seed();
    const admin = await deptUser({ isAdmin: true });
    const person = await deptUser();
    const before = await grantRevision.currentGrantRevision();
    await grant(admin.token(), person.user.email, "sales", "viewer");
    expect(await grantRevision.currentGrantRevision()).toBe(before + 1);
    expect((await AccessGrantHead.findById(HEAD_ID).lean()).seq).toBe(1);
  });
});
