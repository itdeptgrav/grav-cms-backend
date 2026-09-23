"use strict";
/**
 * EXPLOIT-FIRST — revocation that waited seven days for a cookie.
 *
 * The compatibility bridge accepted `role: "hr_manager"` (or `"hr"`, `"ceo"`,
 * `"admin"`) from ANY session that carried it. That claim is minted at login
 * from `AccessDepartment.legacyRole` and lives in the token for seven days, so
 * an ordinary employee whose HR DepartmentRole AND HR access-department grant
 * had both been removed kept opening the workforce directory with the token
 * already in their browser until it expired. Nothing an administrator could do
 * in Access Control reached it.
 *
 * The same token claims are used before and after each revocation below, and
 * the assertion is always the same: the NEXT decision reflects the database.
 * These go through the real guard on a real HTTP request, so what is proven is
 * the answer a client actually receives — not just the resolver's opinion.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
  makeLegacyAccount,
  legacyToken,
  cmsToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const { resolveHrActor, invalidateHrAuthorization, COMPATIBILITY } =
  require("../../services/access/hrAuthorization");

const Employee = require("../../models/Employee");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const HRDepartment = require("../../models/HRDepartment");
const CEODepartment = require("../../models/CEODepartment");

let server, base, hr, sales, ceo, adminDept;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  for (const prefix of ["/api/hr", "/api/employees", "/api/ceo/hr"]) app.use(prefix, hrContract());
  app.use((req, res) => res.json({ reached: true, template: req.hrAuth?.actor?.template || null }));

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
  adminDept = await makeDepartment("platform-admin", "Platform Admin", "/admin");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
});

/** The directory read — the thing the stale token kept buying. */
async function directory(token) {
  const res = await fetch(`${base}/api/employees/all`, { headers: bearer(token) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** An administrator changed something; the contract is told, as in production. */
function administratorChangedAccess() {
  invalidateHrAuthorization("test: access revoked");
}

describe("an ordinary Employee holding an hr_manager claim", () => {
  /** Same claims throughout — this is the token they are already holding. */
  let token, emp;

  beforeEach(async () => {
    await grantHrRole("worker@grav.in", "approver", "Worker");
    emp = await makeEmployee({
      biometricId: "GRW1",
      email: "worker@grav.in",
      accessDepartmentId: hr._id,
    });
    resetAccessCaches();
    token = cmsToken({
      id: String(emp._id),
      email: "worker@grav.in",
      employeeId: "GRW1",
      role: "hr_manager",
    });
  });

  test("DepartmentRole revocation drops them to the grant's read-only level", async () => {
    expect((await directory(token)).body.template).toBe("hr_approver");

    await DepartmentRole.updateOne(
      { departmentSlug: "hr", email: "worker@grav.in" },
      { $set: { isActive: false } },
    );
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(200);
    /* The application grant is still there, so they still open HR — read-only. */
    expect(after.body.template).toBe("hr_viewer");
  });

  test("removing the HR access-department leaves the role in charge", async () => {
    await Employee.updateOne({ _id: emp._id }, { $set: { accessDepartmentId: sales._id } });
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(200);
    expect(after.body.template).toBe("hr_approver");
  });

  test("removing BOTH leaves the still-valid token with NO HR access", async () => {
    /* THE REGRESSION. Both records gone, same token, and the `hr_manager`
       claim used to carry them straight back in. */
    await DepartmentRole.deleteMany({ email: "worker@grav.in" });
    await Employee.updateOne({ _id: emp._id }, { $set: { accessDepartmentId: sales._id } });
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");

    const actor = await resolveHrActor({
      id: String(emp._id), email: "worker@grav.in", employeeId: "GRW1", role: "hr_manager",
    });
    expect(actor.hasHrApplicationAccess).toBe(false);
    expect(actor.template).toBe("employee_self");
    expect(actor.compatibility).toContain(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);
  });

  test("deactivating the employee revokes everything, grants and role included", async () => {
    /* A leaver keeps every field they had — the record is retained for payroll
       and audit — so reading the grant without reading the STATE would let them
       back in with the token in their browser. */
    await Employee.updateOne({ _id: emp._id }, { $set: { isActive: false, status: "inactive" } });
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("the soft delete HR actually performs revokes it too", async () => {
    /* `DELETE /api/employees/:id` sets both flags rather than removing the row. */
    await Employee.updateOne({ _id: emp._id }, { $set: { isActive: false, status: "inactive" } });
    administratorChangedAccess();
    expect((await directory(token)).status).toBe(403);
  });

  test("a hard-deleted employee gets nothing from the claim either", async () => {
    await DepartmentRole.deleteMany({ email: "worker@grav.in" });
    await Employee.deleteOne({ _id: emp._id });
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("the claim buys nothing even while the department has no roles at all", async () => {
    /* The unconfigured state is not a second way in. */
    await DepartmentRole.deleteMany({});
    await Employee.updateOne({ _id: emp._id }, { $set: { accessDepartmentId: sales._id } });
    administratorChangedAccess();

    expect((await directory(token)).status).toBe(403);
  });
});

describe("a legacy HR account — what the bridge is actually for", () => {
  test("works while the legacy row is active, and stops the moment it is not", async () => {
    const row = await makeLegacyAccount("hr", "hradmin@grav.in");
    resetAccessCaches();
    const token = legacyToken("hr", row);

    const before = await directory(token);
    expect(before.status).toBe(200);
    expect(before.body.template).toBe("hr_viewer");

    await HRDepartment.updateOne({ email: "hradmin@grav.in" }, { $set: { isActive: false } });
    administratorChangedAccess();

    const after = await directory(token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("a deleted legacy row fails closed", async () => {
    const row = await makeLegacyAccount("hr", "hradmin2@grav.in");
    resetAccessCaches();
    const token = legacyToken("hr", row);
    expect((await directory(token)).status).toBe(200);

    await HRDepartment.deleteOne({ email: "hradmin2@grav.in" });
    administratorChangedAccess();
    expect((await directory(token)).status).toBe(403);
  });

  test("an Employee identity takes precedence over the bridge, even when a legacy row exists", async () => {
    /* An employee's authority is their own records. The bridge is for accounts
       that cannot have any — it is not a fallback for an employee whose records
       were removed. */
    await makeLegacyAccount("hr", "both@grav.in");
    const emp = await makeEmployee({
      biometricId: "GRBOTH", email: "both@grav.in", accessDepartmentId: sales._id,
    });
    resetAccessCaches();

    const token = cmsToken({
      id: String(emp._id), email: "both@grav.in", employeeId: "GRBOTH",
      role: "hr_manager", userType: "hr",
    });
    const r = await directory(token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });
});

describe("a legacy CEO account", () => {
  test("works while active and stops when deactivated", async () => {
    const row = await makeLegacyAccount("ceo", "chief@grav.in");
    resetAccessCaches();
    const token = legacyToken("ceo", row);

    const before = await directory(token);
    expect(before.status).toBe(200);
    expect(before.body.template).toBe("ceo_projection");

    await CEODepartment.updateOne({ email: "chief@grav.in" }, { $set: { isActive: false } });
    administratorChangedAccess();
    expect((await directory(token)).status).toBe(403);
  });

  test("a ceo claim with no CEO account behind it proves nothing", async () => {
    const token = cmsToken({
      id: "60c0000000000000000000ff", email: "pretend.chief@grav.in", role: "ceo", userType: "ceo",
    });
    expect((await directory(token)).status).toBe(403);
  });

  test("an employee with a real CEO access grant is unaffected by any of this", async () => {
    const emp = await makeEmployee({ biometricId: "GRC9", email: "c9@grav.in", accessDepartmentId: ceo._id });
    resetAccessCaches();
    const token = cmsToken({
      id: String(emp._id), email: "c9@grav.in", employeeId: "GRC9", role: "ceo", userType: "ceo",
    });
    const r = await directory(token);
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("ceo_projection");
  });
});

describe("platform administrators", () => {
  test("deactivating the account revokes management HR on the next request", async () => {
    await makePlatformAdmin("admin@grav.in", adminDept._id);
    resetAccessCaches();
    const token = cmsToken({ email: "admin@grav.in", role: "admin" });

    const before = await directory(token);
    expect(before.status).toBe(200);
    expect(before.body.template).toBe("platform_admin");

    await DeptUser.updateOne({ email: "admin@grav.in" }, { $set: { isActive: false } });
    administratorChangedAccess();

    /* The `admin` claim is still in the token and buys nothing. */
    const after = await directory(token);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("revoking the admin flag drops them out of HR too", async () => {
    await makePlatformAdmin("admin2@grav.in", adminDept._id);
    resetAccessCaches();
    const token = cmsToken({ email: "admin2@grav.in", role: "admin" });
    expect((await directory(token)).body.template).toBe("platform_admin");

    await DeptUser.updateOne({ email: "admin2@grav.in" }, { $set: { isAdmin: false } });
    administratorChangedAccess();

    /* Still an active department account, so the `admin` claim resolves to the
       read-only management projection — not to platform administrator. */
    const after = await directory(token);
    expect(after.body.template).toBe("ceo_projection");
  });

  test("an admin claim with no account at all proves nothing", async () => {
    const token = cmsToken({ email: "nobody@grav.in", role: "admin", isAdmin: true });
    const r = await directory(token);
    expect(r.status).toBe(403);
  });
});

describe("no token claim is evidence on its own", () => {
  test("role, deptSlug and isAdmin together still prove nothing", async () => {
    const token = cmsToken({
      email: "liar@grav.in",
      role: "hr_manager",
      deptSlug: "hr",
      deptId: String(hr._id),
      isAdmin: true,
      userType: "hr",
    });
    const r = await directory(token);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });
});
