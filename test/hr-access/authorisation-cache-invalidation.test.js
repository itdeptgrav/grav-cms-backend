"use strict";
/**
 * EXPLOIT-FIRST — a revoked capability that keeps working.
 *
 * The resolved-actor cache holds a decision for thirty seconds, keyed on the
 * COMPOSITE `id|employeeId|email|role`. The only invalidation was
 * `invalidateHrActor(user)`, which needs those exact claims — so an
 * administrator revoking a role, demoting an owner, removing an application
 * grant or deactivating an account had no way to reach the entry. The person
 * they had just stopped went on approving, reopening payroll and reading
 * compensation for the rest of the window, and nothing anywhere said why.
 *
 * Every test below performs the real mutation and then asserts the decision on
 * the VERY NEXT resolve.
 */

const express = require("express");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
} = require("./helpers");

const { resolveHrActor, invalidateHrAuthorization } =
  require("../../services/access/hrAuthorization");
const { CAPABILITIES } = require("../../services/access/hrCapabilities");
const deptRoles = require("../../services/departmentRoles");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const DeptUser = require("../../models/Access/DeptUser");
const Employee = require("../../models/Employee");

let hr, sales, adminDept;

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  adminDept = await makeDepartment("platform-admin", "Platform Admin", "/admin");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
});

/** Resolve, so the decision is in the cache — the state the bug needed. */
async function warm(user) {
  return resolveHrActor(user);
}

describe("role grants take effect on the next request", () => {
  test("a new grant is honoured immediately", async () => {
    const emp = await makeEmployee({ biometricId: "GRNEW", email: "new@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "new@grav.in", employeeId: "GRNEW", role: "hr_manager" };

    const before = await warm(user);
    expect(before.template).toBe("hr_viewer");

    await deptRoles.setRole({ departmentSlug: "hr", email: "new@grav.in", role: "approver", actor: {} });

    const after = await resolveHrActor(user);
    expect(after.template).toBe("hr_approver");
    expect(after.capabilities.has(CAPABILITIES.COMPENSATION_READ)).toBe(true);
  });

  test("a revocation stops them immediately", async () => {
    await grantHrRole("leaver@grav.in", "owner", "Leaver");
    const emp = await makeEmployee({ biometricId: "GRLEAVE", email: "leaver@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "leaver@grav.in", employeeId: "GRLEAVE", role: "hr_manager" };
    resetAccessCaches();

    const before = await warm(user);
    expect(before.capabilities.has(CAPABILITIES.PAYROLL_REOPEN)).toBe(true);

    await deptRoles.setRole({ departmentSlug: "hr", email: "leaver@grav.in", role: null, actor: {} });

    const after = await resolveHrActor(user);
    expect(after.template).toBe("hr_viewer");
    expect(after.capabilities.has(CAPABILITIES.PAYROLL_REOPEN)).toBe(false);
    expect(after.capabilities.has(CAPABILITIES.SECURITY_CREDENTIALS_MANAGE)).toBe(false);
  });

  test("a demotion takes effect immediately", async () => {
    await grantHrRole("demoted@grav.in", "approver", "Demoted");
    const emp = await makeEmployee({ biometricId: "GRDEM", email: "demoted@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "demoted@grav.in", employeeId: "GRDEM", role: "hr_manager" };
    resetAccessCaches();

    expect((await warm(user)).capabilities.has(CAPABILITIES.PAYROLL_APPROVE)).toBe(true);

    await deptRoles.setRole({ departmentSlug: "hr", email: "demoted@grav.in", role: "viewer", actor: {} });

    const after = await resolveHrActor(user);
    expect(after.template).toBe("hr_viewer");
    expect(after.capabilities.has(CAPABILITIES.PAYROLL_APPROVE)).toBe(false);
  });

  test("the INCUMBENT OWNER demoted by a new owner is also refreshed", async () => {
    /* The one that is easy to miss: granting owner to somebody else silently
       demotes the incumbent to approver with an updateMany. The person whose
       capabilities changed is not the person who made the request, so a
       "clear the caller's entry" invalidation would never have reached them. */
    await grantHrRole("incumbent@grav.in", "owner", "Incumbent");
    const emp = await makeEmployee({ biometricId: "GRINC", email: "incumbent@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "incumbent@grav.in", employeeId: "GRINC", role: "hr_manager" };
    resetAccessCaches();

    expect((await warm(user)).template).toBe("hr_owner");

    await deptRoles.setRole({ departmentSlug: "hr", email: "successor@grav.in", role: "owner", actor: {} });

    const after = await resolveHrActor(user);
    expect(after.template).toBe("hr_approver");
    expect(after.capabilities.has(CAPABILITIES.PAYROLL_REOPEN)).toBe(false);
  });

  test("granting the FIRST HR role flips the unconfigured state on the next request", async () => {
    /* `hrRolesConfigured` is cached separately; a grant has to drop that too or
       the department stays "unconfigured" for the window. */
    await DepartmentRole.deleteMany({});
    resetAccessCaches();
    const emp = await makeEmployee({ biometricId: "GRF", email: "first@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "first@grav.in", employeeId: "GRF", role: "hr_manager" };

    const before = await warm(user);
    expect(before.compatibility).toContain("HR_ROLES_UNCONFIGURED");

    await deptRoles.setRole({ departmentSlug: "hr", email: "first@grav.in", role: "editor", actor: {} });

    const after = await resolveHrActor(user);
    expect(after.template).toBe("hr_editor");
    expect(after.compatibility).not.toContain("HR_ROLES_UNCONFIGURED");
  });

  test("an email migration moves the grant and the decision together", async () => {
    await grantHrRole("old.address@grav.in", "approver", "Mover");
    const emp = await makeEmployee({ biometricId: "GRMOVE", email: "old.address@grav.in", accessDepartmentId: hr._id });
    const asOld = { id: String(emp._id), email: "old.address@grav.in", employeeId: "GRMOVE", role: "hr_manager" };
    resetAccessCaches();

    expect((await warm(asOld)).template).toBe("hr_approver");

    await deptRoles.followEmailChange("old.address@grav.in", "new.address@grav.in");
    await Employee.updateOne({ _id: emp._id }, { $set: { email: "new.address@grav.in" } });

    /* The same person keeps their role — that is what following the change is
       FOR — and they keep it on their first request under either claim, rather
       than being refused until the cache expires. */
    expect((await resolveHrActor(asOld)).template).toBe("hr_approver");
    const asNew = { id: String(emp._id), email: "new.address@grav.in", employeeId: "GRMOVE", role: "hr_manager" };
    expect((await resolveHrActor(asNew)).template).toBe("hr_approver");

    /* And the grant genuinely MOVED: a different account presenting the old
       address, with no employee record behind it, gets nothing from it. */
    const impostor = await resolveHrActor({ email: "old.address@grav.in", role: "hr_manager" });
    /* Nothing at all: the grant moved, and the `hr_manager` claim on its own is
       not a way back in — it needs an active legacy account behind it and there
       is none. */
    expect(impostor.template).toBe("employee_self");
    expect(impostor.hasHrApplicationAccess).toBe(false);
    expect(impostor.capabilities.has(CAPABILITIES.PAYROLL_APPROVE)).toBe(false);
  });
});

describe("access-department and account mutations take effect on the next request", () => {
  test("removing the application grant refuses them immediately", async () => {
    const emp = await makeEmployee({ biometricId: "GRREM", email: "rem@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "rem@grav.in", employeeId: "GRREM", role: "sales" };

    expect((await warm(user)).hasHrApplicationAccess).toBe(true);

    await Employee.updateOne({ _id: emp._id }, { $set: { accessDepartmentId: sales._id } });
    invalidateHrAuthorization("employee.revoke");

    const after = await resolveHrActor(user);
    expect(after.hasHrApplicationAccess).toBe(false);
    expect(after.template).toBe("employee_self");
  });

  test("removing an ADDITIONAL grant refuses them immediately", async () => {
    const emp = await makeEmployee({
      biometricId: "GRADD",
      email: "add@grav.in",
      accessDepartmentId: sales._id,
      additionalDepartmentIds: [hr._id],
    });
    const user = { id: String(emp._id), email: "add@grav.in", employeeId: "GRADD", role: "sales" };
    expect((await warm(user)).hasHrApplicationAccess).toBe(true);

    await Employee.updateOne({ _id: emp._id }, { $set: { additionalDepartmentIds: [] } });
    invalidateHrAuthorization("employee.extra-departments");

    expect((await resolveHrActor(user)).hasHrApplicationAccess).toBe(false);
  });

  test("revoking platform administrator takes effect immediately", async () => {
    await makePlatformAdmin("admin@grav.in", adminDept._id);
    resetAccessCaches();
    const user = { email: "admin@grav.in", role: "sales" };

    expect((await warm(user)).template).toBe("platform_admin");

    await DeptUser.updateOne({ email: "admin@grav.in" }, { $set: { isAdmin: false } });
    invalidateHrAuthorization("user.update");

    expect((await resolveHrActor(user)).template).toBe("employee_self");
  });

  test("deactivating the account takes effect immediately", async () => {
    await makePlatformAdmin("admin2@grav.in", adminDept._id);
    resetAccessCaches();
    const user = { email: "admin2@grav.in", role: "sales" };
    expect((await warm(user)).template).toBe("platform_admin");

    await DeptUser.updateOne({ email: "admin2@grav.in" }, { $set: { isActive: false } });
    invalidateHrAuthorization("user.update");

    expect((await resolveHrActor(user)).template).toBe("employee_self");
  });

  test("WITHOUT the invalidation the stale decision would stand — the bug, demonstrated", async () => {
    /* The control. Same mutation, no invalidation: the cache answers with the
       revoked capability, which is exactly what happened before this pass. */
    await grantHrRole("stale@grav.in", "owner", "Stale");
    const emp = await makeEmployee({ biometricId: "GRSTALE", email: "stale@grav.in", accessDepartmentId: hr._id });
    const user = { id: String(emp._id), email: "stale@grav.in", employeeId: "GRSTALE", role: "hr_manager" };
    resetAccessCaches();

    expect((await warm(user)).template).toBe("hr_owner");

    await DepartmentRole.updateOne({ email: "stale@grav.in", departmentSlug: "hr" }, { $set: { isActive: false } });

    /* No invalidation → still owner. */
    expect((await resolveHrActor(user)).template).toBe("hr_owner");

    /* With it → viewer, on the next call. */
    invalidateHrAuthorization("test");
    expect((await resolveHrActor(user)).template).toBe("hr_viewer");
  });
});

describe("the mutations that must invalidate are wired", () => {
  test("Access Control's authorisation actions all clear the cache", async () => {
    /* Hooked in `audit()` rather than at eleven call sites, so no early-return
       path can skip it. This asserts the list has not lost an entry. */
    const fs = require("fs");
    const src = fs.readFileSync(require("path").join(__dirname, "../../routes/Admin/accessAdmin.js"), "utf8");
    const block = src.slice(src.indexOf("const AUTHORISATION_ACTIONS"), src.indexOf("function audit("));

    for (const action of [
      "department-role",
      "employee.assign",
      "employee.revoke",
      "employee.extra-departments",
      "employee.bulk-assign",
      "employee.set-email",
      "user.create",
      "user.update",
      "department-login.remove",
      "department.deactivate",
      "department.delete",
    ]) {
      expect({ action, wired: block.includes(`"${action}"`) }).toEqual({ action, wired: true });
    }
    expect(src).toContain("invalidateHrAuthorization");
  });

  test("a role change through the service clears it too", async () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/departmentRoles.js"), "utf8",
    );
    expect(src).toContain("dropHrAuthorizationCache");
    /* Grant/change, revoke, the accounting revoke and the email migration. */
    expect(src.match(/dropHrAuthorizationCache\(/g).length).toBeGreaterThanOrEqual(4);
  });

  test("invalidation never throws, whatever it is handed", () => {
    expect(() => invalidateHrAuthorization()).not.toThrow();
    expect(() => invalidateHrAuthorization("reason")).not.toThrow();
    expect(() => invalidateHrAuthorization(null)).not.toThrow();
  });
});
