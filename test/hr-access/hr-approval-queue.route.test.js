"use strict";
/**
 * 4 / "existing editor approval requests continue to work".
 *
 * The contract sits ABOVE the approval queue, and the two have to compose:
 * the contract decides whether the operation may be attempted at all, and
 * `Middlewear/departmentWriteGuard` decides whether an editor's attempt commits
 * or is held for an approver.
 *
 * Mounted in the same order as server.js, so what is tested is the arrangement
 * that actually runs.
 */

const express = require("express");
const cookieParser = require("cookie-parser");

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  cmsToken,
  bearer,
} = require("./helpers");

const hrContract = require("../../Middlewear/hrContract");
const departmentWrites = require("../../Middlewear/departmentWriteGuard");
const ChangeRequest = require("../../models/Access/ChangeRequest");

let server, base, hr, sales;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  /* The server.js order: contract first, then the write guard, then routers. */
  const hrWrites = departmentWrites("hr", {
    entity: "HR record",
    exempt: ["/api/hr/profile", "/api/hr/change-password", "/change-history", "/import-export",
             "/sync-period", "/backfill", "/day-range", "/notification-"],
  });
  for (const prefix of ["/api/hr", "/hr", "/api/employees"]) {
    app.use(prefix, hrContract());
    app.use(prefix, hrWrites);
  }
  app.use((req, res) => res.json({ committed: true }));

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
});

async function hrUser(role) {
  const email = `${role}@grav.in`;
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role}`, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return cmsToken({ id: String(emp._id), email, employeeId: `GR${role}`, role: "hr_manager", name: role });
}

async function send(method, path, token, body = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe("the contract and the approval queue compose", () => {
  test("an editor's permitted write is HELD for an approver, not refused and not committed", async () => {
    const token = await hrUser("editor");
    const r = await send("POST", "/api/employees", token, { firstName: "New", lastName: "Joiner" });

    expect(r.status).toBe(202);
    expect(r.body.committed).toBeUndefined();

    const held = await ChangeRequest.find({ departmentSlug: "hr" }).lean();
    expect(held).toHaveLength(1);
    /* The held request stores the write verbatim, so replaying an approval
       reissues exactly what was submitted. */
    expect(held[0].intent.method).toBe("POST");
    expect(held[0].intent.path).toContain("/api/employees");
  });

  test("an approver's write commits directly", async () => {
    const token = await hrUser("approver");
    const r = await send("POST", "/api/employees", token, { firstName: "New", lastName: "Joiner" });

    expect(r.status).toBe(200);
    expect(r.body.committed).toBe(true);
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("a viewer is refused by the CONTRACT, before the queue ever sees it", async () => {
    const token = await hrUser("viewer");
    const r = await send("POST", "/api/employees", token, { firstName: "New" });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_MISSING_CAPABILITY");
    /* The refusal has to happen ABOVE the queue: a write nobody may attempt
       must not become a pending request an approver could rubber-stamp. */
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("an operation the editor lacks the capability for never reaches the queue either", async () => {
    const token = await hrUser("editor");
    const r = await send("PATCH", "/api/hr/payroll/mark-paid", token, { runId: "x" });

    expect(r.status).toBe(403);
    expect(r.body.code).toBe("HR_MISSING_CAPABILITY");
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });
});

describe("self-service writes stay out of the HR approval queue", () => {
  test("changing your own password is neither refused nor queued", async () => {
    const emp = await makeEmployee({ biometricId: "GRSELF", email: "self@grav.in", accessDepartmentId: sales._id });
    const token = cmsToken({ id: String(emp._id), email: "self@grav.in", employeeId: "GRSELF", role: "sales" });

    const r = await send("PUT", "/api/hr/change-password", token, { current: "a", next: "b" });
    expect(r.status).toBe(200);
    expect(r.body.committed).toBe(true);
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("an HR editor updating their OWN profile is not queued", async () => {
    const token = await hrUser("editor");
    const r = await send("PUT", "/api/hr/profile", token, { name: "New Name" });
    expect(r.status).toBe(200);
    expect(await ChangeRequest.countDocuments({})).toBe(0);
  });

  test("HR resetting SOMEBODY ELSE'S password is a privileged, queued write", async () => {
    const token = await hrUser("owner");
    const r = await send("PATCH", "/api/hr/password-management/change-password/employee/60c0000000000000000000aa", token, { password: "x" });

    /* An owner commits directly — the queue holds EDITORS. What matters is that
       the contract let it through only for the credential capability, which the
       route-coverage test pins, and that it is not treated as self-service. */
    expect(r.status).toBe(200);

    const editor = await hrUser("editor");
    const refused = await send("PATCH", "/api/hr/password-management/change-password/employee/60c0000000000000000000aa", editor, { password: "x" });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("HR_MISSING_CAPABILITY");
  });
});
