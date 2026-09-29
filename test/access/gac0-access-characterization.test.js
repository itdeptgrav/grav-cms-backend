// test/access/gac0-access-characterization.test.js
//
// GAC-0 — CHARACTERIZATION ONLY. THESE TESTS PIN WHAT THE CODE DOES TODAY.
//
// Several assertions below describe behaviour the single-organisation decision
// (docs/decisions/single-organisation-access-control.md) calls unsafe: a JWT
// `isAdmin` claim acting as an operational bypass, a revoked PPC company grant leaving its company
// membership behind, an intern check that fails open. They are pinned so that
// the chunk which changes each one (GAC-1 … GAC-10, or a security hotfix) has
// to flip an explicit assertion rather than change it silently. SEC-0 flipped
// one: the published legacy signing secret is now rejected (test A3). A failing test
// here after such a chunk is expected; update the assertion and its comment in
// the same change. The audit is docs/audits/single-organisation-access-gac0-2026-09-25.md.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
/* Set before config/jwt.js loads: the legacy-secret test depends on a real
   current secret that differs from both hard-coded historical ones. */
process.env.JWT_SECRET = "gac0-characterization-secret";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");

const departmentRoles = require("../../services/departmentRoles");
const { requireDepartmentRole, getRole, getEffectiveRole } = departmentRoles;
const { resolveCompanyForActor, MEMBERSHIP_SOURCES } = require("../../services/companyContext/companyMembership.service");
const { change, roleForCompany } = require("../../services/companyContext/companyAccess.service");
const { authenticateCmsSession } = require("../../services/cmsSession");
const { resolveAccountingAccess } = require("../../services/access/accountingAccess");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");

let n = 0;

beforeAll(async () => {
  await DepartmentRole.syncIndexes();
  await SpCompanyMembership.syncIndexes();
});
afterEach(() => jest.restoreAllMocks());

/* ── helpers ──────────────────────────────────────────────────────────── */

const company = () => Acc_Company.create({
  companyName: `GAC0 Co ${++n}`, booksFromDate: new Date("2026-04-01"),
});

async function employee(extra = {}) {
  const i = ++n;
  return Employee.create({
    firstName: "Gac", lastName: `Zero${i}`, email: `gac0.${i}@grav.test`, biometricId: `GZ${i}`,
    isActive: true, gender: "Other", department: "Tech", ...extra,
  });
}

const failWith = (code, message, details) => Object.assign(new Error(message), { code, details });
const resolve = (user, requestedCompanyId = null) => resolveCompanyForActor(user, {
  requestedCompanyId, domainLabel: "GAC0", fail: failWith,
});

const admin = () => ({ _id: new mongoose.Types.ObjectId(), name: "Administrator", email: "admin@grav.test" });
const ppcGrant = (companyId, email, role) => change({
  companyId, departmentSlug: "ppc", email, role, reason: "GAC-0 characterization", actor: admin(),
});

/** Run an Express-style middleware once and report what it did. */
function runMiddleware(mw, req) {
  return new Promise((resolveRun) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(body) { resolveRun({ nextCalled: false, status: this.statusCode, body }); return this; },
    };
    Promise.resolve(mw(req, res, () => resolveRun({ nextCalled: true, status: null, body: null })))
      .catch((err) => resolveRun({ nextCalled: false, status: "threw", body: err }));
  });
}

/* ══ (a) PLATFORM-ADMINISTRATOR OPERATIONAL BYPASSES ═══════════════════ */

describe("platform administrator bypasses (current behaviour)", () => {
  test("GAC-AR1: requireDepartmentRole REFUSES a JWT isAdmin claim with no DeptUser behind it", async () => {
    // GAC-0 pinned the opposite (the claim alone admitted). GAC-AR1 made the
    // administrator the database-verified DeptUser record, so the claim alone
    // is now an ordinary caller with no role.
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    const out = await runMiddleware(requireDepartmentRole("sales", "approver"), {
      user: { email: "nobody-in-the-database@grav.test", isAdmin: true },
    });
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(403);
    expect(await DeptUser.countDocuments({})).toBe(0);
  });

  test("the same caller without the claim is refused — the claim alone is the difference", async () => {
    await DepartmentRole.create({ departmentSlug: "sales", email: "someone@grav.test", role: "owner" });
    const out = await runMiddleware(requireDepartmentRole("sales", "approver"), {
      user: { email: "nobody-in-the-database@grav.test", isAdmin: false },
    });
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body.code).toBe("NO_DEPARTMENT_ROLE");
  });

  test("SEC-0: cmsSession now REJECTS a token signed with a published legacy secret", async () => {
    // GAC-0 originally pinned the opposite: config/jwt.js LEGACY_SECRETS made
    // this forged token verify, carrying its isAdmin claim. SEC-0 (25 Sep 2026)
    // removed every published secret from every CMS verifier, so the same
    // forgery is now an unauthenticated request. The literal below is the
    // published value being proven dead, not a secret in use.
    const forged = jwt.sign(
      { id: "000000000000000000000000", email: "forged@example.test", isAdmin: true },
      "grav_clothing_secret_key", { expiresIn: "5m" },
    );
    const req = { headers: { authorization: `Bearer ${forged}` }, cookies: {} };
    const out = await runMiddleware(authenticateCmsSession, req);
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(401);
    expect(req.user).toBeUndefined();
  });

  test("a token role string of ceo/admin opens accounting data to the assistant with no database record", async () => {
    expect(await resolveAccountingAccess({ role: "ceo", email: "ghost@grav.test" })).toEqual({ allowed: true, via: "ceo" });
    expect(await resolveAccountingAccess({ role: "superadmin" })).toEqual({ allowed: true, via: "admin" });
    expect(await resolveAccountingAccess({ role: "hr_manager", email: "ghost@grav.test" })).toEqual({ allowed: false, via: null });
  });
});

/* ══ (b) GLOBAL DEPARTMENT ROLE × COMPANY MEMBERSHIP ═════════════════════ */

describe("a global department role combined with company membership", () => {
  test("one global merchandiser role is effective in every company the person is a member of", async () => {
    const [a, b] = await Promise.all([company(), company()]);
    const emp = await employee();
    await DepartmentRole.create({ departmentSlug: "merchandiser", email: emp.email, role: "approver" });
    await SpCompanyMembership.create({ companyId: a._id, email: emp.email, employeeRef: emp._id });
    await SpCompanyMembership.create({ companyId: b._id, email: emp.email, employeeRef: emp._id });

    const user = { id: String(emp._id), email: emp.email };
    // The role question has no company input at all…
    expect(await getEffectiveRole("merchandiser", { user })).toBe("approver");
    // …and the company question accepts either company on request.
    expect(String((await resolve(user, a._id)).companyId)).toBe(String(a._id));
    expect(String((await resolve(user, b._id)).companyId)).toBe(String(b._id));
    await expect(resolve(user)).rejects.toMatchObject({ code: "COMPANY_SELECTION_REQUIRED" });
  });

  test("getRole ignores companyGrants for every slug, including ppc", async () => {
    const co = await company();
    await DepartmentRole.create({
      departmentSlug: "merchandiser", email: "scoped@grav.test", role: "viewer", isActive: false,
      companyGrants: [{ companyId: co._id, role: "owner", isActive: true, reason: "x" }],
    });
    expect(await getRole("merchandiser", "scoped@grav.test")).toBeNull();
  });
});

/* ══ (c) PPC companyGrants[] OVERRIDING OR REVIVING LEGACY ROLES ═════════ */

describe("PPC companyGrants[] and the legacy global role", () => {
  test("a revoked scoped grant blocks PPC's resolver but getRole('ppc') still returns the legacy role", async () => {
    const co = await company();
    const emp = await employee();
    await SpCompanyMembership.create({ companyId: co._id, email: emp.email, employeeRef: emp._id });
    await DepartmentRole.create({
      departmentSlug: "ppc", email: emp.email, role: "approver", isActive: true,
      companyGrants: [{ companyId: co._id, role: "approver", isActive: false, reason: "revoked" }],
    });
    expect(await roleForCompany({ companyId: co._id, email: emp.email, actorId: emp._id })).toBeNull();
    expect(await getRole("ppc", emp.email)).toBe("approver");
  });

  test("granting PPC creates a company membership, and revoking PPC leaves that membership active", async () => {
    const co = await company();
    const emp = await employee();
    await ppcGrant(co._id, emp.email, "editor");
    expect(await SpCompanyMembership.countDocuments({ companyId: co._id, email: emp.email, isActive: true })).toBe(1);

    await ppcGrant(co._id, emp.email, null);
    expect(await roleForCompany({ companyId: co._id, email: emp.email, actorId: emp._id })).toBeNull();
    // The membership outlives the grant, so every OTHER domain still resolves
    // this person into the company.
    expect(await SpCompanyMembership.countDocuments({ companyId: co._id, email: emp.email, isActive: true })).toBe(1);
    const ctx = await resolve({ id: String(emp._id), email: emp.email });
    expect(ctx.membershipSource).toBe(MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD);
    expect(String(ctx.companyId)).toBe(String(co._id));
  });

  test("the membership a PPC grant creates makes an existing global Sales role company-effective", async () => {
    const co = await company();
    const emp = await employee();
    // The 409 guard is only consulted when the membership did not already
    // exist, and only looks at DepartmentRole — pre-existing membership skips it.
    await SpCompanyMembership.create({ companyId: co._id, email: emp.email, employeeRef: emp._id, isActive: false });
    await DepartmentRole.create({ departmentSlug: "sales", email: emp.email, role: "approver" });
    await expect(ppcGrant(co._id, emp.email, "viewer")).rejects.toMatchObject({ code: "LEGACY_ROLES_REQUIRE_REVIEW" });

    await SpCompanyMembership.updateOne({ email: emp.email }, { $set: { isActive: true } });
    await ppcGrant(co._id, emp.email, "viewer");
    const ctx = await resolve({ id: String(emp._id), email: emp.email });
    expect(String(ctx.companyId)).toBe(String(co._id));
    expect(await getEffectiveRole("sales", { user: { id: String(emp._id), email: emp.email } })).toBe("approver");
  });

  test("the first PPC grant anywhere ends the single-company fallback for every other user", async () => {
    const co = await company();
    const bystander = { id: String(new mongoose.Types.ObjectId()), email: "bystander@grav.test" };
    expect((await resolve(bystander)).membershipSource).toBe(MEMBERSHIP_SOURCES.SINGLE_COMPANY_DEPLOYMENT);

    const emp = await employee();
    await ppcGrant(co._id, emp.email, "viewer");
    await expect(resolve(bystander)).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
  });
});

/* ══ (f) ACCOUNTING'S SEPARATE IDENTITY AND ROLE AUTHORITY ═══════════════ */

describe("Accounting keeps its own role store", () => {
  async function accUser(role, { isActive = true } = {}) {
    const org = await Acc_Organization.create({ name: `GAC0 Org ${++n}`, tallyCompanyIds: [] });
    const user = new Acc_User({ organizationId: org._id, name: `Acc ${n}`, email: `acc${n}@grav.test`, role, isActive });
    await user.setPassword("a-long-enough-password");
    await user.save();
    return user;
  }

  test("getRole('accountant') reads Acc_User and ignores a DepartmentRole row for the same slug", async () => {
    const user = await accUser("approver");
    await DepartmentRole.create({ departmentSlug: "accountant", email: user.email, role: "owner" });
    expect(await getRole("accountant", user.email)).toBe("approver");
  });

  test("an inactive Acc_User has no accounting role even beside an active DepartmentRole row", async () => {
    const user = await accUser("owner", { isActive: false });
    await DepartmentRole.create({ departmentSlug: "accountant", email: user.email, role: "owner" });
    expect(await getRole("accountant", user.email)).toBeNull();
  });
});

/* ══ (g) DATABASE LOOKUP FAILURE BEHAVIOUR ═══════════════════════════════ */

describe("database lookup failure", () => {
  const boom = () => { throw new Error("simulated database outage"); };

  test("requireDepartmentRole fails closed with 500", async () => {
    jest.spyOn(DepartmentRole, "find").mockImplementation(boom);
    const out = await runMiddleware(requireDepartmentRole("sales"), { user: { email: "x@grav.test" } });
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(500);
  });

  test("GAC-AR1: an admin claim no longer skips the lookup — an outage fails closed for it too", async () => {
    // GAC-0 pinned that the claim passed before any lookup. It is now checked
    // against the database first, so a claim without a record falls through to
    // the (failing) role lookup and is refused like everybody else.
    jest.spyOn(DepartmentRole, "find").mockImplementation(boom);
    const out = await runMiddleware(requireDepartmentRole("sales"), { user: { email: "x@grav.test", isAdmin: true } });
    expect(out.nextCalled).toBe(false);
    expect(out.status).toBe(500);
  });

  test("roleForCompany propagates the error rather than answering null", async () => {
    jest.spyOn(DepartmentRole, "findOne").mockImplementation(boom);
    await expect(roleForCompany({
      companyId: new mongoose.Types.ObjectId(), email: "x@grav.test",
    })).rejects.toThrow(/simulated database outage/);
  });

  test("getEffectiveRole swallows a failed Employee alias lookup and answers from the token email only", async () => {
    const emp = await employee();
    await DepartmentRole.create({ departmentSlug: "hr", email: emp.email, role: "approver" });
    await DepartmentRole.create({ departmentSlug: "hr", email: "token-address@grav.test", role: "viewer" });
    const req = { user: { id: String(emp._id), email: "token-address@grav.test" } };
    expect(await getEffectiveRole("hr", req)).toBe("approver");

    jest.spyOn(Employee, "findOne").mockImplementation(boom);
    expect(await getEffectiveRole("hr", req)).toBe("viewer");
  });

  test("the mobile app's intern lock-out FAILS OPEN when the employee lookup throws", async () => {
    const intern = await employee({ employmentType: "intern" });
    const token = jwt.sign({ id: String(intern._id), email: intern.email }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const req = () => ({ headers: { authorization: `Bearer ${token}` }, cookies: {} });

    const refused = await runMiddleware(AllEmployeeAppMiddleware, req());
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("INTERN_NO_APP_ACCESS");

    AllEmployeeAppMiddleware.invalidateAppAccess(String(intern._id));
    jest.spyOn(Employee, "findById").mockImplementation(boom);
    const admitted = await runMiddleware(AllEmployeeAppMiddleware, req());
    expect(admitted.nextCalled).toBe(true);
  });

  test("the mobile app admits a token whose employee record no longer exists", async () => {
    const id = String(new mongoose.Types.ObjectId());
    const token = jwt.sign({ id, email: "deleted@grav.test" }, process.env.JWT_SECRET, { expiresIn: "5m" });
    const out = await runMiddleware(AllEmployeeAppMiddleware, { headers: { authorization: `Bearer ${token}` }, cookies: {} });
    expect(out.nextCalled).toBe(true);
  });
});
