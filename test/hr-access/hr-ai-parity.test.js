"use strict";
/**
 * 19 — THE ASSISTANT'S HR TOOLS ANSWER TO THE SAME CONTRACT AS THE ROUTES.
 *
 * The assistant is a view onto HR data, not a way around its permissions. For
 * one actor, the tool that returns a kind of data must be offered exactly when
 * the endpoint that returns the same kind of data would be permitted.
 *
 * The regression this pins is concrete: before the contract, every HR tool was
 * gated on one boolean — "can this account open HR" — so a CEO refused
 * compensation at `/api/hr/payslip/:id` could ask the assistant for the same
 * salary and get it.
 */

/* Same reason as manager-scope.route.test.js: the HR tools reach the push
   transport through their context builders, and `expo-server-sdk` is ESM-only,
   which Jest's CommonJS loader refuses. Nothing here sends a notification. */
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() { return false; }
    chunkPushNotifications() { return []; }
    sendPushNotificationsAsync() { return Promise.resolve([]); }
  },
}));

const {
  resetAccessCaches,
  makeDepartment,
  makeEmployee,
  grantHrRole,
  makePlatformAdmin,
} = require("./helpers");

require("../../services/ai/tools/hrTools"); // registering is the side effect
const { authorizedTools, getTool } = require("../../services/ai/toolRegistry");
const { resolveHrActor, authorizeHr } = require("../../services/access/hrAuthorization");
const { findDeclaration } = require("../../services/access/hrRouteContract");

let hr, sales, ceo, adminDept;

beforeEach(async () => {
  resetAccessCaches();
  hr = await makeDepartment("hr", "HR", "/hr/dashboard");
  sales = await makeDepartment("sales", "Sales", "/sales/dashboard");
  ceo = await makeDepartment("ceo", "CEO", "/ceo/dashboard");
  adminDept = await makeDepartment("platform-admin", "Platform Admin", "/admin");
  await grantHrRole("configured@grav.in", "viewer", "Someone");
  resetAccessCaches();
});

/** What the assistant would attach for this account. */
async function toolsFor(user) {
  const actor = await resolveHrActor(user);
  const withActor = { ...user, hrActor: actor };
  return { actor, names: authorizedTools(withActor).map((t) => t.name).sort() };
}

/** Would the equivalent HTTP endpoint be permitted for this account? */
async function routeAllowed(user, method, path) {
  const declaration = findDeclaration(method, path);
  expect(declaration).toBeTruthy();
  const r = await authorizeHr({
    user,
    capabilities: declaration.capabilities,
    scope: declaration.scope,
    selfParams: declaration.selfParams,
    req: { params: {}, query: {}, body: {}, hrParams: {} },
  });
  return r.allowed;
}

/* tool name → the endpoint that returns the same class of data */
const TOOL_TO_ROUTE = {
  hr_overview: ["GET", "/api/hr/overview/dashboard"],
  hr_daily_attendance: ["GET", "/hr/attendance/daily"],
  hr_overtime: ["GET", "/hr/attendance/daily"],
  hr_leave: ["GET", "/api/hr/leaves"],
  hr_holidays: ["GET", "/api/hr/leaves/holidays"],
  hr_directory: ["GET", "/api/employees/all"],
  hr_departments: ["GET", "/api/hr/departments"],
  hr_employee: ["GET", "/api/employees/all"],
  hr_policies: ["GET", "/api/hr/policy"],
  hr_payroll: ["GET", "/api/hr/payroll/items"],
  hr_salary: ["GET", "/api/hr/payslip/GR0001"],
};

async function hrUser(role) {
  const email = `${role}@grav.in`;
  await grantHrRole(email, role, role);
  const emp = await makeEmployee({ biometricId: `GR${role}`, email, accessDepartmentId: hr._id });
  resetAccessCaches();
  return { id: String(emp._id), email, employeeId: `GR${role}`, role: "hr_manager" };
}

describe("tool and route agree, actor by actor", () => {
  test.each(["viewer", "editor", "approver", "owner"])(
    "an HR %s is offered exactly the tools whose endpoints they may reach",
    async (role) => {
      const user = await hrUser(role);
      const { names } = await toolsFor(user);

      for (const [tool, [method, path]] of Object.entries(TOOL_TO_ROUTE)) {
        const allowedByRoute = await routeAllowed(user, method, path);
        expect({ role, tool, offered: names.includes(tool) }).toEqual({
          role, tool, offered: allowedByRoute,
        });
      }
    },
  );

  test("a Sales-only employee is offered no HR tool at all", async () => {
    const emp = await makeEmployee({ biometricId: "GRS1", email: "sam@grav.in", accessDepartmentId: sales._id });
    const { names } = await toolsFor({ id: String(emp._id), email: "sam@grav.in", employeeId: "GRS1", role: "sales" });
    expect(names.filter((n) => n.startsWith("hr_"))).toEqual([]);
  });
});

describe("the specific hole this closes", () => {
  test("the CEO gets workforce tools and NOT the salary or payroll ones", async () => {
    const emp = await makeEmployee({ biometricId: "GRC1", email: "cyra@grav.in", accessDepartmentId: ceo._id });
    const user = { id: String(emp._id), email: "cyra@grav.in", employeeId: "GRC1", role: "ceo" };
    const { names } = await toolsFor(user);

    expect(names).toContain("hr_overview");
    expect(names).toContain("hr_daily_attendance");
    expect(names).toContain("hr_directory");

    expect(names).not.toContain("hr_salary");
    expect(names).not.toContain("hr_payroll");

    /* And the route says the same thing, which is the parity being claimed. */
    expect(await routeAllowed(user, "GET", "/api/hr/payslip/GR0001")).toBe(false);
    expect(await routeAllowed(user, "GET", "/api/hr/overview/dashboard")).toBe(true);
  });

  test("an HR editor cannot ask the assistant for a salary either", async () => {
    const user = await hrUser("editor");
    const { names } = await toolsFor(user);
    expect(names).not.toContain("hr_salary");
    expect(names).not.toContain("hr_payroll");
    expect(names).toContain("hr_directory");
  });

  test("an approver may, because the endpoint would let them", async () => {
    const user = await hrUser("approver");
    const { names } = await toolsFor(user);
    expect(names).toContain("hr_salary");
    expect(await routeAllowed(user, "GET", "/api/hr/payslip/GR0001")).toBe(true);
  });
});

describe("the tool's own re-check fails closed", () => {
  test("an account with no resolved actor is offered nothing and refused on execute", async () => {
    /* gravAssistant re-checks `tool.permission(user)` before RUNNING a tool the
       model asked for. With no actor attached — a resolver failure — that check
       must refuse rather than default open. */
    for (const name of Object.keys(TOOL_TO_ROUTE)) {
      const tool = getTool(name);
      expect(tool).toBeTruthy();
      expect(tool.permission({})).toBe(false);
      expect(tool.permission({ hrActor: undefined })).toBe(false);
      expect(tool.permission({ hrAccess: { allowed: true, via: "hr" } })).toBe(false);
    }
  });

  test("a platform administrator keeps the tools they have today", async () => {
    await makePlatformAdmin("admin@grav.in", adminDept._id);
    resetAccessCaches();
    const { names } = await toolsFor({ email: "admin@grav.in", role: "sales" });
    expect(names).toContain("hr_salary");
    expect(names).toContain("hr_overview");
  });
});
