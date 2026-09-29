"use strict";
/**
 * THE RESOLVER: application access, capabilities and scope, from records.
 *
 * These are the unit-level proofs behind the contract. Everything is built from
 * real access records in the in-memory database — AccessDepartment grants,
 * DepartmentRole rows, DeptUser administrators, Employee assignments — because
 * the claim under test is precisely that authority comes from those and not
 * from the token.
 */

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
  makeLegacyAccount,
} = require("./helpers");

const {
  resolveHrActor,
  authorizeHr,
  DECISIONS,
  COMPATIBILITY,
} = require("../../services/access/hrAuthorization");
const { CAPABILITIES } = require("../../services/access/hrCapabilities");

let hr, sales, ceo, admin;

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
  admin = await makeDepartment("platform-admin", "Platform Admin", "/admin");
});

/* Every test that wants capability enforcement rather than the unconfigured
   compatibility path needs at least one HR role to exist. */
async function configureHrRoles() {
  await grantHrRole("someone.else@grav.in", "viewer", "Anyone");
  resetAccessCaches();
}

describe("authentication is not authorisation", () => {
  test("no session at all resolves to an unauthenticated actor", async () => {
    const actor = await resolveHrActor(null);
    expect(actor.authenticated).toBe(false);
    expect(actor.hasHrApplicationAccess).toBe(false);
    expect([...actor.capabilities]).toEqual([]);
  });

  test("a valid session with no HR grant gets NO HR application access", async () => {
    await configureHrRoles();
    const emp = await makeEmployee({ biometricId: "GRS1", email: "sam@grav.in", accessDepartmentId: sales._id });

    const actor = await resolveHrActor({ id: String(emp._id), email: "sam@grav.in", employeeId: "GRS1", role: "sales" });
    expect(actor.authenticated).toBe(true);
    expect(actor.hasHrApplicationAccess).toBe(false);
    expect(actor.template).toBe("employee_self");

    const decision = await authorizeHr({
      user: { id: String(emp._id), email: "sam@grav.in", role: "sales" },
      capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.decision).toBe(DECISIONS.NO_APPLICATION_ACCESS);
    expect(decision.status).toBe(403);
  });
});

describe("organisation assignment is not application access", () => {
  test("an employee filed under HR on the org chart, with a Sales grant, is refused", async () => {
    await configureHrRoles();
    /* `department` / `departmentId` are the HR ORGANISATION assignment. This is
       the shape the plan's design rule #2 forbids from granting anything, and
       the one a "they work in HR, surely they can open HR" implementation would
       let through. */
    const HrOrgDepartment = require("../../models/HR_Models/Departments");
    const orgHr = await HrOrgDepartment.create({ name: "HR", code: "HR" }).catch(() => null);

    const emp = await makeEmployee({
      biometricId: "GRORG1",
      email: "orgonly@grav.in",
      department: "HR",
      departmentId: orgHr ? orgHr._id : undefined,
      designation: "HR Executive",
      jobTitle: "HR Manager",
      accessDepartmentId: sales._id,
    });

    const actor = await resolveHrActor({ id: String(emp._id), email: "orgonly@grav.in", employeeId: "GRORG1", role: "sales" });
    expect(actor.hasHrApplicationAccess).toBe(false);
    expect(actor.capabilities.has(CAPABILITIES.HR_ACCESS)).toBe(false);
  });

  test("an HR grant held as an ADDITIONAL department does grant access", async () => {
    await configureHrRoles();
    const emp = await makeEmployee({
      biometricId: "GRM1",
      email: "mia@grav.in",
      accessDepartmentId: sales._id,
      additionalDepartmentIds: [hr._id],
    });

    /* Signed in to Sales — the role claim says so — and still an HR user. */
    const actor = await resolveHrActor({ id: String(emp._id), email: "mia@grav.in", employeeId: "GRM1", role: "sales" });
    expect(actor.hasHrApplicationAccess).toBe(true);
    expect(actor.via).toBe("hr-access-department");
  });
});

describe("token role strings", () => {
  test("an arbitrary role string grants nothing", async () => {
    await configureHrRoles();
    for (const role of ["hr_superuser", "payroll_admin", "HR_MANAGER_ADMIN", "owner", "root", ""]) {
      resetAccessCaches();
      const actor = await resolveHrActor({ id: undefined, email: `x-${role}@nowhere.test`, role });
      expect(actor.hasHrApplicationAccess).toBe(false);
      expect(actor.capabilities.has(CAPABILITIES.HR_ACCESS)).toBe(false);
    }
  });

  test("the legacy `hr_manager` claim proves APPLICATION ACCESS and nothing more", async () => {
    await configureHrRoles();
    /* The bridge is for accounts that CANNOT hold grant records, and it
       re-proves the row every time — so the row has to exist and be active. */
    const row = await makeLegacyAccount("hr", "legacy.hr@grav.in");
    resetAccessCaches();
    /* The claims a real HRDepartment sign-in produces: the legacy row's own id
       as the subject, and `userType: "hr"` naming the collection that
       authenticated it. */
    const actor = await resolveHrActor({
      id: String(row._id), email: "legacy.hr@grav.in", role: "hr_manager", userType: "hr",
    });

    expect(actor.hasHrApplicationAccess).toBe(true);
    expect(actor.via).toBe("legacy-role");
    expect(actor.compatibility).toContain(COMPATIBILITY.LEGACY_ROLE_TOKEN);

    /* Read-only: HR roles ARE configured, so an account with no role row of its
       own gets the viewer set — the same outcome the existing write guard
       produces today when it answers NO_DEPARTMENT_ROLE. */
    expect(actor.template).toBe("hr_viewer");
    expect(actor.capabilities.has(CAPABILITIES.PEOPLE_WRITE)).toBe(false);
    expect(actor.capabilities.has(CAPABILITIES.COMPENSATION_READ)).toBe(false);
  });

  test("with NO HR roles configured anywhere, a grant is READ-ONLY — never promoted to owner", async () => {
    /* THE FAIL-OPEN THIS REPLACED.
     *
     * An HR grant with no role row used to resolve to the OWNER template
     * whenever the department had no DepartmentRole rows — which handed
     * payroll reopen, HR configuration, confidential cases and credential
     * administration to anybody holding the application grant, while the
     * contract reported that capability enforcement was active. It was a
     * fail-open wearing a compatibility note.
     *
     * An application grant now says which app may be opened and nothing more.
     * Bootstrapping the first owner is a platform-administrator action through
     * CEO -> Access Control, not a request-time promotion. */
    resetAccessCaches();
    const emp = await makeEmployee({ biometricId: "GRHR9", email: "first.hr@grav.in", accessDepartmentId: hr._id });
    const actor = await resolveHrActor({ id: String(emp._id), email: "first.hr@grav.in", employeeId: "GRHR9", role: "hr_manager" });

    expect(actor.template).toBe("hr_viewer");
    expect(actor.hasHrApplicationAccess).toBe(true);
    /* The state is still reported — it just no longer grants anything. */
    expect(actor.compatibility).toContain(COMPATIBILITY.HR_ROLES_UNCONFIGURED);

    for (const denied of [
      CAPABILITIES.PEOPLE_WRITE,
      CAPABILITIES.EMPLOYMENT_CHANGE,
      CAPABILITIES.COMPENSATION_READ,
      CAPABILITIES.COMPENSATION_WRITE,
      CAPABILITIES.PAYROLL_PREPARE,
      CAPABILITIES.PAYROLL_APPROVE,
      CAPABILITIES.PAYROLL_REOPEN,
      CAPABILITIES.ATTENDANCE_CORRECT,
      CAPABILITIES.ATTENDANCE_CLOSE,
      CAPABILITIES.CASES_MANAGE,
      CAPABILITIES.SECURITY_CREDENTIALS_MANAGE,
      CAPABILITIES.HR_CONFIGURATION_MANAGE,
    ]) {
      expect({ denied, held: actor.capabilities.has(denied) }).toEqual({ denied, held: false });
    }
  });

  test("the legacy hr_manager claim is read-only too, configured or not", async () => {
    const row = await makeLegacyAccount("hr", "legacy.only@grav.in");
    const claims = {
      id: String(row._id), email: "legacy.only@grav.in", role: "hr_manager", userType: "hr",
    };
    resetAccessCaches();
    const bare = await resolveHrActor(claims);
    expect(bare.template).toBe("hr_viewer");
    expect(bare.capabilities.has(CAPABILITIES.SECURITY_CREDENTIALS_MANAGE)).toBe(false);

    await configureHrRoles();
    const configured = await resolveHrActor(claims);
    expect(configured.template).toBe("hr_viewer");
  });

  test("the same claim with NO legacy account behind it proves nothing", async () => {
    /* The bridge used to accept the claim from any session that carried it,
       which made it a way to survive revocation. */
    await configureHrRoles();
    const actor = await resolveHrActor({
      id: "60c0000000000000000000ff", email: "nobody@grav.in", role: "hr_manager", userType: "hr",
    });
    expect(actor.hasHrApplicationAccess).toBe(false);
    expect(actor.template).toBe("employee_self");
    expect(actor.compatibility).toContain(COMPATIBILITY.LEGACY_CLAIM_NOT_PROVEN);
  });
});

describe("role grants decide capabilities", () => {
  const cases = [
    ["viewer", "hr_viewer"],
    ["editor", "hr_editor"],
    ["approver", "hr_approver"],
    ["owner", "hr_owner"],
  ];

  test.each(cases)("an HR %s grant resolves to the %s template", async (role, template) => {
    await configureHrRoles();
    await grantHrRole("person@grav.in", role);
    resetAccessCaches();
    const emp = await makeEmployee({ biometricId: "GRR1", email: "person@grav.in", accessDepartmentId: hr._id });

    const actor = await resolveHrActor({ id: String(emp._id), email: "person@grav.in", employeeId: "GRR1", role: "hr_manager" });
    expect(actor.template).toBe(template);
    expect(actor.via).toBe("hr-department-role");
  });

  test("a viewer may read the directory and may not write", async () => {
    await grantHrRole("viewer@grav.in", "viewer");
    resetAccessCaches();
    const user = { email: "viewer@grav.in", role: "hr_manager" };

    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY] }))
      .resolves.toMatchObject({ allowed: true });

    const denied = await authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_WRITE] });
    expect(denied.allowed).toBe(false);
    expect(denied.decision).toBe(DECISIONS.MISSING_CAPABILITY);
    expect(denied.capability).toBe(CAPABILITIES.PEOPLE_WRITE);
  });

  test("payroll prepare, approve and reopen separate an approver from an owner", async () => {
    await grantHrRole("approver@grav.in", "approver");
    await grantHrRole("owner@grav.in", "owner");
    resetAccessCaches();

    const approver = { email: "approver@grav.in", role: "hr_manager" };
    const owner = { email: "owner@grav.in", role: "hr_manager" };

    await expect(authorizeHr({ user: approver, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PAYROLL_APPROVE] }))
      .resolves.toMatchObject({ allowed: true });

    const reopen = await authorizeHr({ user: approver, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PAYROLL_REOPEN] });
    expect(reopen.allowed).toBe(false);
    expect(reopen.capability).toBe(CAPABILITIES.PAYROLL_REOPEN);

    await expect(authorizeHr({ user: owner, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PAYROLL_REOPEN] }))
      .resolves.toMatchObject({ allowed: true });
  });

  test("an editor may correct a day and may not close a period", async () => {
    await grantHrRole("editor@grav.in", "editor");
    resetAccessCaches();
    const user = { email: "editor@grav.in", role: "hr_manager" };

    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.ATTENDANCE_CORRECT] }))
      .resolves.toMatchObject({ allowed: true });
    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.ATTENDANCE_CLOSE] }))
      .resolves.toMatchObject({ allowed: false, decision: DECISIONS.MISSING_CAPABILITY });
  });

  test("an editor may issue a document and may not release one", async () => {
    await grantHrRole("editor@grav.in", "editor");
    resetAccessCaches();
    const user = { email: "editor@grav.in", role: "hr_manager" };

    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.DOCUMENTS_ISSUE] }))
      .resolves.toMatchObject({ allowed: true });
    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.DOCUMENTS_RELEASE] }))
      .resolves.toMatchObject({ allowed: false });
  });

  test("only an owner administers other people's credentials", async () => {
    for (const [email, role] of [["v@grav.in", "viewer"], ["e@grav.in", "editor"], ["a@grav.in", "approver"], ["o@grav.in", "owner"]]) {
      await grantHrRole(email, role);
    }
    resetAccessCaches();

    for (const email of ["v@grav.in", "e@grav.in", "a@grav.in"]) {
      const r = await authorizeHr({
        user: { email, role: "hr_manager" },
        capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.SECURITY_CREDENTIALS_MANAGE],
      });
      expect(r.allowed).toBe(false);
    }
    await expect(
      authorizeHr({
        user: { email: "o@grav.in", role: "hr_manager" },
        capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.SECURITY_CREDENTIALS_MANAGE],
      }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe("management and administrators", () => {
  test("the CEO gets a read-only projection and no compensation", async () => {
    await configureHrRoles();
    const emp = await makeEmployee({ biometricId: "GRC1", email: "cyra@grav.in", accessDepartmentId: ceo._id });
    const user = { id: String(emp._id), email: "cyra@grav.in", employeeId: "GRC1", role: "ceo" };

    const actor = await resolveHrActor(user);
    expect(actor.template).toBe("ceo_projection");

    await expect(authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.ANALYTICS_WORKFORCE] }))
      .resolves.toMatchObject({ allowed: true });

    for (const denied of [
      CAPABILITIES.COMPENSATION_READ,
      CAPABILITIES.PEOPLE_READ_PRIVATE,
      CAPABILITIES.PEOPLE_READ_IDENTIFIERS,
      CAPABILITIES.PEOPLE_READ_MEDICAL,
      CAPABILITIES.CASES_MANAGE,
      CAPABILITIES.PEOPLE_WRITE,
      CAPABILITIES.ATTENDANCE_CLOSE,
    ]) {
      const r = await authorizeHr({ user, capabilities: [CAPABILITIES.HR_ACCESS, denied] });
      expect(r.allowed).toBe(false);
      expect(r.decision).toBe(DECISIONS.MISSING_CAPABILITY);
    }
  });

  test("a platform administrator is re-read from the database, not trusted from the token", async () => {
    await configureHrRoles();
    await makePlatformAdmin("admin@grav.in", admin._id);
    resetAccessCaches();

    /* Signed in as Sales, `isAdmin` NOT claimed in the token. */
    const real = await resolveHrActor({ email: "admin@grav.in", role: "sales" });
    expect(real.template).toBe("platform_admin");
    expect(real.compatibility).toContain(COMPATIBILITY.PLATFORM_ADMIN_FULL_HR);

    /* And the reverse: a token that CLAIMS isAdmin for an address with no
       administrator record gets nothing from the claim. */
    resetAccessCaches();
    const liar = await resolveHrActor({ email: "not-an-admin@grav.in", role: "sales", isAdmin: true });
    expect(liar.template).toBe("employee_self");
    expect(liar.hasHrApplicationAccess).toBe(false);
  });
});

describe("record scope", () => {
  test("an explicit company or factory scope is REFUSED, never silently ignored", async () => {
    await grantHrRole("owner@grav.in", "owner");
    resetAccessCaches();
    const user = { email: "owner@grav.in", role: "hr_manager" };

    for (const key of ["companyId", "legalEntityId", "establishmentId", "factoryId"]) {
      const r = await authorizeHr({
        user,
        capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY],
        req: { query: { [key]: "acme-2" }, params: {}, body: {} },
      });
      expect(r.allowed).toBe(false);
      expect(r.decision).toBe(DECISIONS.SCOPE_NOT_PROVABLE);
    }

    /* Without one, the same request is permitted — and carries the named
       compatibility condition saying the HR scope is global until Chunk 2. */
    const ok = await authorizeHr({
      user,
      capabilities: [CAPABILITIES.HR_ACCESS, CAPABILITIES.PEOPLE_READ_DIRECTORY],
      req: { query: {}, params: {}, body: {} },
    });
    expect(ok.allowed).toBe(true);
    expect(ok.actor.compatibility).toContain(COMPATIBILITY.LEGACY_GLOBAL_HR_SCOPE);
  });

  test("self scope refuses a request that names another employee", async () => {
    const me = await makeEmployee({ biometricId: "GRSELF", email: "me@grav.in", accessDepartmentId: sales._id });
    const user = { id: String(me._id), email: "me@grav.in", employeeId: "GRSELF" };

    const mine = await authorizeHr({
      user, capabilities: [], scope: "self", selfParams: ["employeeId"],
      req: { params: { employeeId: String(me._id) }, query: {}, body: {} },
    });
    expect(mine.allowed).toBe(true);

    const theirs = await authorizeHr({
      user, capabilities: [], scope: "self", selfParams: ["employeeId"],
      req: { params: { employeeId: "60c0000000000000000000ff" }, query: {}, body: {} },
    });
    expect(theirs.allowed).toBe(false);
    expect(theirs.decision).toBe(DECISIONS.OUT_OF_SCOPE);
  });

  test("self scope accepts the biometric id as well as the record id", async () => {
    const me = await makeEmployee({ biometricId: "GR0067", email: "me@grav.in", accessDepartmentId: sales._id });
    const user = { id: String(me._id), email: "me@grav.in", employeeId: "GR0067" };

    const r = await authorizeHr({
      user, capabilities: [], scope: "self", selfParams: ["employeeId"],
      req: { params: { employeeId: "GR0067" }, query: {}, body: {} },
    });
    expect(r.allowed).toBe(true);
  });
});

describe("denials disclose nothing about the record", () => {
  test("the message is identical whether or not the employee exists", async () => {
    await configureHrRoles();
    const other = await makeEmployee({ biometricId: "GRREAL", email: "real@grav.in", accessDepartmentId: sales._id });
    const me = await makeEmployee({ biometricId: "GRME", email: "me@grav.in", accessDepartmentId: sales._id });
    const user = { id: String(me._id), email: "me@grav.in", employeeId: "GRME" };

    const forReal = await authorizeHr({
      user, capabilities: [], scope: "self", selfParams: ["employeeId"],
      req: { params: { employeeId: String(other._id) }, query: {}, body: {} },
    });
    const forFictional = await authorizeHr({
      user, capabilities: [], scope: "self", selfParams: ["employeeId"],
      req: { params: { employeeId: "60c0000000000000000000ff" }, query: {}, body: {} },
    });

    expect(forReal.decision).toBe(forFictional.decision);
    expect(forReal.message).toBe(forFictional.message);
    expect(forReal.status).toBe(forFictional.status);
    expect(forReal.message).not.toMatch(/GRREAL|exist|found|employee/i);
  });
});
