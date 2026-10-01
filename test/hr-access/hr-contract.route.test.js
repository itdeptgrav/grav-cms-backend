"use strict";
/**
 * THE CONTRACT, THROUGH A REAL REQUEST.
 *
 * An express app with the REAL guard (Middlewear/hrContract) on the five HR
 * prefixes and a handler that does nothing but report it was reached. Real
 * signed cookies, real access records, real declarations.
 *
 * The handler is a stub ON PURPOSE. The guard runs before any router, so what
 * these tests prove — 401 / 403 / permitted, per declared endpoint — is
 * independent of what the twenty HR routers do afterwards; and mounting
 * Attendance_section (8,800 lines) to assert a 403 would be testing the wrong
 * thing slowly. That the declared paths are the real paths is what
 * route-coverage.test.js proves, against the routers themselves.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
  cmsToken,
  appToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");

let server, base;
let hr, sales, ceo, adminDept;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  for (const prefix of ["/api/ceo/hr", "/api/hr", "/hr", "/api/employees", "/api/employee"]) {
    app.use(prefix, hrContract());
  }
  /* Reached only when the contract permitted the request. Echoes what the guard
     decided so the tests can assert on the capability set as well as the code. */
  app.use((req, res) =>
    res.json({
      reached: true,
      template: req.hrAuth?.actor?.template || null,
      capabilities: [...(req.hrAuth?.capabilities || [])],
      scope: req.hrAuth?.declaration?.scope,
      exclude: req.hrAuth?.exclude || "",
    }),
  );

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
  /* At least one HR role must exist or the resolver takes the documented
     "nobody has configured HR yet" compatibility path and treats grants as
     owner. Every test below is about ENFORCEMENT, so roles are configured. */
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
});

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? bearer(token) : {}),
    },
    /* fetch refuses a body on GET/HEAD, and several of these tables pass one
       uniformly across both verbs. */
    ...(body && !["GET", "HEAD"].includes(method) ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

/** An HR account holding `role` in the HR department. */
async function hrUser(role, email = `${role}@grav.in`, bio = `GR${role.toUpperCase()}`) {
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: bio, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email, employeeId: bio, role: "hr_manager", name: role });
}

describe("1 — no session", () => {
  test("an unauthenticated HR request is 401, not 403", async () => {
    const r = await call("GET", "/api/hr/leaves");
    expect(r.status).toBe(401);
    expect(r.body.code).toBe("HR_UNAUTHENTICATED");
  });

  test("every kind of HR endpoint answers 401 without a session", async () => {
    for (const [method, path] of [
      ["GET", "/api/employees/all"],
      ["GET", "/hr/attendance/daily"],
      ["GET", "/api/hr/payroll/items"],
      ["POST", "/api/hr/documents"],
      ["GET", "/api/hr/password-management/users"],
      ["GET", "/api/ceo/hr/employees"],
    ]) {
      const r = await call(method, path);
      expect({ path, status: r.status }).toEqual({ path, status: 401 });
    }
  });
});

describe("2 — an authenticated employee with no HR grant", () => {
  test("is refused with HR_NO_APPLICATION_ACCESS, not let in", async () => {
    const emp = await makeEmployee({ biometricId: "GRS1", email: "sam@grav.in", accessDepartmentId: sales._id });
    const token = cmsToken({ id: String(emp._id), email: "sam@grav.in", employeeId: "GRS1", role: "sales" });

    for (const [method, path] of [
      ["GET", "/api/employees/all"],
      ["GET", "/api/hr/leaves"],
      ["GET", "/hr/attendance/daily"],
      ["GET", "/api/hr/payslip/GR0001"],
    ]) {
      const r = await call(method, path, { token });
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path, status: 403, code: "HR_NO_APPLICATION_ACCESS",
      });
    }
  });

  test("a token whose role string was invented grants nothing", async () => {
    const emp = await makeEmployee({ biometricId: "GRX1", email: "mallory@grav.in", accessDepartmentId: sales._id });
    /* Genuinely invented strings — not case variants of a real one. The legacy
       map normalises case deliberately, because the claim is minted from
       AccessDepartment.legacyRole and "HR_MANAGER" is the same grant shouted;
       "hr_superuser" is a different word and grants nothing. */
    for (const role of ["hr_superuser", "payroll_admin", "hr-manager", "hradmin", "owner", "root"]) {
      resetAccessCaches();
      const token = cmsToken({ id: String(emp._id), email: "mallory@grav.in", employeeId: "GRX1", role });
      const r = await call("GET", "/api/employees/all", { token });
      expect({ role, status: r.status }).toEqual({ role, status: 403 });
    }
  });
});

describe("3 — HR viewer", () => {
  test("may use permitted reads", async () => {
    const token = await hrUser("viewer");
    for (const path of ["/api/employees/all", "/api/hr/leaves", "/hr/attendance/daily", "/api/hr/departments"]) {
      const r = await call("GET", path, { token });
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }
  });

  test("may NOT write, and may not read compensation or private identity", async () => {
    const token = await hrUser("viewer");
    for (const [method, path] of [
      ["POST", "/api/employees"],
      ["PUT", "/api/employees/60c0000000000000000000aa"],
      ["PUT", "/hr/attendance/day-override"],
      ["PATCH", "/api/hr/leaves/60c0000000000000000000aa/approve"],
      ["POST", "/api/hr/documents"],
      ["GET", "/api/hr/payslip/GR0001"],
      ["GET", "/api/hr/payroll/items"],
      ["GET", "/api/employees/60c0000000000000000000aa"],
    ]) {
      const r = await call(method, path, { token, body: {} });
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path, status: 403, code: "HR_MISSING_CAPABILITY",
      });
    }
  });
});

describe("4/5 — editor, approver, owner", () => {
  test("an editor may attempt the writes it owns and not the ones it does not", async () => {
    const token = await hrUser("editor");

    for (const [method, path] of [
      ["POST", "/api/employees"],
      ["PUT", "/hr/attendance/day-override"],
      ["PATCH", "/api/hr/leaves/60c0000000000000000000aa/approve"],
      ["POST", "/api/hr/documents"],
      ["GET", "/api/employees/60c0000000000000000000aa"],
    ]) {
      const r = await call(method, path, { token, body: {} });
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }

    for (const [method, path] of [
      ["PATCH", "/api/hr/payroll/mark-paid"],
      ["PATCH", "/api/hr/documents/60c0000000000000000000aa/release"],
      ["POST", "/hr/attendance/sync-period"],
      ["PUT", "/api/hr/leaves/config"],
      ["GET", "/api/hr/password-management/users"],
    ]) {
      const r = await call(method, path, { token, body: {} });
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path, status: 403, code: "HR_MISSING_CAPABILITY",
      });
    }
  });

  test("an approver approves payroll but cannot reopen it", async () => {
    const token = await hrUser("approver");
    expect((await call("PATCH", "/api/hr/payroll/mark-paid", { token, body: {} })).status).toBe(200);
    expect((await call("PATCH", "/api/hr/payroll/run/revert-to-draft", { token, body: {} })).status).toBe(403);
    expect((await call("DELETE", "/api/hr/payroll/run", { token })).status).toBe(403);
  });

  test("an owner reopens payroll and administers credentials", async () => {
    const token = await hrUser("owner");
    expect((await call("PATCH", "/api/hr/payroll/run/revert-to-draft", { token, body: {} })).status).toBe(200);
    expect((await call("GET", "/api/hr/password-management/users", { token })).status).toBe(200);
    expect((await call("POST", "/api/hr/password-management/bulk-reset", { token, body: {} })).status).toBe(200);
  });

  test("a platform administrator reaches HR — the documented compatibility exception", async () => {
    await makePlatformAdmin("admin@grav.in", adminDept._id);
    resetAccessCaches();
    const token = cmsToken({ email: "admin@grav.in", role: "sales" });
    const r = await call("GET", "/api/hr/payslip/GR0001", { token });
    expect(r.status).toBe(200);
    expect(r.body.template).toBe("platform_admin");
  });
});

describe("6/7 — organisation assignment versus application access", () => {
  test("being filed under HR on the org chart grants nothing", async () => {
    const emp = await makeEmployee({
      biometricId: "GRORG",
      email: "org@grav.in",
      department: "HR",
      designation: "HR Executive",
      jobTitle: "HR Manager",
      accessDepartmentId: sales._id,
    });
    const token = cmsToken({ id: String(emp._id), email: "org@grav.in", employeeId: "GRORG", role: "sales" });
    const r = await call("GET", "/api/employees/all", { token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_NO_APPLICATION_ACCESS");
  });

  test("an HR grant held as an ADDITIONAL department works", async () => {
    await grantHrRole("mia@grav.in", "editor", "Mia");
    const emp = await makeEmployee({
      biometricId: "GRM1",
      email: "mia@grav.in",
      accessDepartmentId: sales._id,
      additionalDepartmentIds: [hr._id],
    });
    resetAccessCaches();
    /* Signed in to Sales. The HR grant still counts. */
    const token = cmsToken({ id: String(emp._id), email: "mia@grav.in", employeeId: "GRM1", role: "sales" });
    const r = await call("GET", "/api/employees/all", { token });
    expect(r.status).toBe(200);
  });
});

describe("9 — employee self-service is record-scoped", () => {
  test("an employee cannot select another employee's payslip", async () => {
    const me = await makeEmployee({ biometricId: "GRME", email: "me@grav.in", accessDepartmentId: sales._id });
    const other = await makeEmployee({ biometricId: "GROTHER", email: "other@grav.in", accessDepartmentId: sales._id });
    const token = appToken({ id: String(me._id), email: "me@grav.in" });

    expect((await call("GET", `/api/employee/payslip/${me._id}`, { token })).status).toBe(200);

    const denied = await call("GET", `/api/employee/payslip/${other._id}`, { token });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("HR_OUT_OF_SCOPE");
  });

  test("self-service reaches no HR administration endpoint", async () => {
    const me = await makeEmployee({ biometricId: "GRME2", email: "me2@grav.in", accessDepartmentId: sales._id });
    const token = appToken({ id: String(me._id), email: "me2@grav.in" });

    for (const path of ["/api/employees/all", "/api/hr/payroll/items", "/hr/attendance/daily"]) {
      const r = await call("GET", path, { token });
      expect({ path, status: r.status, code: r.body.code }).toEqual({
        path, status: 403, code: "HR_NO_APPLICATION_ACCESS",
      });
    }
  });

  test("an employee changes their OWN password without an HR capability or an approver", async () => {
    const me = await makeEmployee({ biometricId: "GRME3", email: "me3@grav.in", accessDepartmentId: sales._id });
    const token = appToken({ id: String(me._id), email: "me3@grav.in" });
    expect((await call("PUT", "/api/employee/change-password", { token, body: {} })).status).toBe(200);

    /* And the CMS-side self-service equivalent, which server.js exempts from
       the approval queue for the same reason. */
    const cms = cmsToken({ id: String(me._id), email: "me3@grav.in", employeeId: "GRME3", role: "sales" });
    expect((await call("PUT", "/api/hr/change-password", { token: cms, body: {} })).status).toBe(200);
    expect((await call("GET", "/api/hr/profile", { token: cms })).status).toBe(200);
  });
});

describe("12-16 — the capability separations, end to end", () => {
  test("compensation endpoints require the compensation capability", async () => {
    const editor = await hrUser("editor");     // has people.read.private, not compensation
    const approver = await hrUser("approver"); // has compensation.read

    for (const path of [
      "/api/hr/payslip/GR0001",
      "/api/hr/payslip/GR0001/history",
      "/api/hr/payslip/GR0001/pdf",
      "/api/hr/payroll/items",
      "/api/hr/payroll/preview",
      "/api/employees/config/salary",
      "/api/employees/import-export/export",
    ]) {
      const denied = await call("GET", path, { token: editor });
      expect({ path, status: denied.status }).toEqual({ path, status: 403 });
      expect(denied.body.requiredCapability).toBeTruthy();

      const allowed = await call("GET", path, { token: approver });
      expect({ path, status: allowed.status }).toEqual({ path, status: 200 });
    }
  });

  test("attendance correction and attendance close need different people", async () => {
    const editor = await hrUser("editor");
    const approver = await hrUser("approver");

    expect((await call("PUT", "/hr/attendance/day-override", { token: editor, body: {} })).status).toBe(200);
    expect((await call("POST", "/hr/attendance/sync-period", { token: editor, body: {} })).status).toBe(403);
    expect((await call("POST", "/hr/attendance/sync-period", { token: approver, body: {} })).status).toBe(200);
  });

  test("document issue and document release need different people", async () => {
    const editor = await hrUser("editor");
    const approver = await hrUser("approver");
    const id = "60c0000000000000000000aa";

    expect((await call("POST", "/api/hr/documents", { token: editor, body: {} })).status).toBe(200);
    expect((await call("PATCH", `/api/hr/documents/${id}/release`, { token: editor, body: {} })).status).toBe(403);
    expect((await call("PATCH", `/api/hr/documents/${id}/release`, { token: approver, body: {} })).status).toBe(200);
  });

  test("credential administration needs its own capability", async () => {
    const approver = await hrUser("approver");
    const owner = await hrUser("owner");

    expect((await call("PATCH", "/api/hr/password-management/change-password/employee/abc", { token: approver, body: {} })).status).toBe(403);
    expect((await call("PATCH", "/api/hr/password-management/change-password/employee/abc", { token: owner, body: {} })).status).toBe(200);
  });
});

describe("17 — a denial discloses nothing", () => {
  test("the body is identical for a record that exists and one that does not", async () => {
    const editor = await hrUser("editor"); // no compensation.read
    const real = await makeEmployee({ biometricId: "GRREAL", email: "real@grav.in", accessDepartmentId: sales._id });

    const forReal = await call("GET", `/api/hr/payslip/${real._id}`, { token: editor });
    const forGhost = await call("GET", "/api/hr/payslip/60c0000000000000000000ff", { token: editor });

    expect(forReal.status).toBe(forGhost.status);
    expect(forReal.body).toEqual(forGhost.body);
    expect(JSON.stringify(forReal.body)).not.toMatch(/GRREAL|real@grav\.in/);
  });

  test("a refusal never says whether the route exists either", async () => {
    const emp = await makeEmployee({ biometricId: "GRS9", email: "s9@grav.in", accessDepartmentId: sales._id });
    const token = cmsToken({ id: String(emp._id), email: "s9@grav.in", employeeId: "GRS9", role: "sales" });

    const real = await call("GET", "/api/hr/leaves", { token });
    const invented = await call("GET", "/api/hr/definitely-not-a-route", { token });
    expect(real.status).toBe(403);
    expect(invented.status).toBe(403);
    expect(invented.body.message).toBe("You do not have permission to perform this action.");
  });
});

describe("18 — the CEO projection", () => {
  test("reads the projection and is refused everything that writes or is protected", async () => {
    const emp = await makeEmployee({ biometricId: "GRC1", email: "cyra@grav.in", accessDepartmentId: ceo._id });
    const token = cmsToken({ id: String(emp._id), email: "cyra@grav.in", employeeId: "GRC1", role: "ceo" });

    for (const path of [
      "/api/ceo/hr/employees",
      "/api/ceo/hr/departments",
      "/api/ceo/hr/attendance/daily",
      "/api/ceo/hr/attendance/muster-roll",
      "/api/hr/overview/dashboard",
    ]) {
      const r = await call("GET", path, { token });
      expect({ path, status: r.status }).toEqual({ path, status: 200 });
    }

    /* The only non-GET under /api/ceo/hr. */
    expect((await call("POST", "/api/ceo/hr/attendance/sync", { token, body: { date: "2026-09-01" } })).status).toBe(403);

    for (const [method, path] of [
      ["GET", "/api/hr/payslip/GR0001"],
      ["GET", "/api/employees/60c0000000000000000000aa"],
      ["POST", "/api/employees"],
      ["PUT", "/hr/attendance/day-override"],
      ["PATCH", "/api/hr/payroll/mark-paid"],
      ["GET", "/api/hr/password-management/users"],
    ]) {
      const r = await call(method, path, { token, body: {} });
      expect({ path, status: r.status }).toEqual({ path, status: 403 });
    }
  });

  test("the projection the CEO does reach excludes protected fields at the query", async () => {
    const emp = await makeEmployee({ biometricId: "GRC2", email: "cyra2@grav.in", accessDepartmentId: ceo._id });
    const token = cmsToken({ id: String(emp._id), email: "cyra2@grav.in", employeeId: "GRC2", role: "ceo" });

    const r = await call("GET", "/api/ceo/hr/employees", { token });
    expect(r.status).toBe(200);
    for (const field of ["salary", "bankDetails", "password", "temporaryPassword"]) {
      expect(r.body.exclude).toContain(`-${field}`);
    }
    /* The statutory identifiers live inside `documents`, and a directory reader
       loses that whole sub-document — so the parent exclusion is what covers
       them. Naming the child as well would make MongoDB refuse the projection
       outright ("Path collision at documents") and take the route down. */
    expect(r.body.exclude).toContain("-documents");
    expect(r.body.exclude).not.toContain("-documents.aadharNumber");
  });
});

describe("scope the server cannot prove is refused", () => {
  test("asking for a company or factory is denied rather than answered across all of them", async () => {
    const token = await hrUser("owner");
    for (const key of ["companyId", "factoryId", "legalEntityId", "establishmentId"]) {
      const r = await call("GET", `/api/employees/all?${key}=acme-2`, { token });
      expect({ key, status: r.status, code: r.body.code }).toEqual({
        key, status: 403, code: "HR_SCOPE_NOT_PROVABLE",
      });
    }
    expect((await call("GET", "/api/employees/all", { token })).status).toBe(200);
  });
});

describe("an undeclared HR route is refused", () => {
  test("the guard fails closed", async () => {
    const token = await hrUser("owner");
    const r = await call("GET", "/api/hr/some-future-unguarded-route", { token });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_ROUTE_NOT_DECLARED");
  });
});
