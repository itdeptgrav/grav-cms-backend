"use strict";
/**
 * WHICH ROUTES ARE "THE EMPLOYEE SECTION".
 *
 * (14 Oct 2026, owner: no role tiers in the employee section) On a declaration
 * marked `employeeSection` every HR user acts with the whole employee
 * capability set (Middlewear/hrContract.js) and the department write guard
 * lets every write but a DELETE through (Middlewear/departmentWriteGuard.js).
 * The mark therefore decides who may read and write pay — so the set of marked
 * routes is pinned here, both by example and exhaustively, and a route that
 * drifts into or out of it fails this file.
 */

/* Static: reads the declaration registry only. */
process.env.TEST_WITHOUT_MONGO = "1";

const {
  DECLARATIONS,
  findDeclaration,
  isEmployeeSection,
} = require("../../services/access/hrRouteContract");

const ID = "60c0000000000000000000aa";

describe("isEmployeeSection marks exactly the employee routes", () => {
  test.each([
    ["GET", "/api/employees/all"],
    ["GET", `/api/employees/${ID}`],
    ["GET", `/api/employees/${ID}/details`],
    ["POST", "/api/employees"],
    ["PUT", `/api/employees/${ID}`],
    ["PATCH", "/api/employees/bulk-update"],
    ["DELETE", `/api/employees/${ID}`],
    ["GET", "/api/employees/import-export/export"],
    ["POST", "/api/employees/import-export/import/confirm"],
    ["GET", "/api/employees/config/salary"],
    ["POST", `/hr/face-registration/upload/${ID}`],
    ["GET", `/hr/face-registration/status/${ID}`],
    ["POST", `/hr/face-enroll/invite/${ID}`],
    ["POST", `/hr/face-enroll/invite/${ID}/revoke`],
  ])("%s %s is in the employee section", (method, path) => {
    const d = findDeclaration(method, path);
    expect(d).toBeTruthy();
    expect({ method, path, section: d.employeeSection === true, byRule: isEmployeeSection(d) })
      .toEqual({ method, path, section: true, byRule: true });
  });

  test.each([
    /* The company-wide salary RULES and the payroll preview belong to payroll. */
    ["PUT", "/api/employees/config/salary"],
    ["POST", "/api/employees/config/salary/preview"],
    /* Payroll, payslips, attendance, leaves, documents, settings. */
    ["GET", "/api/hr/payslip/GR0001"],
    ["GET", "/api/hr/payroll/items"],
    ["PUT", "/hr/attendance/day-override"],
    ["GET", "/hr/attendance/daily"],
    ["GET", "/api/hr/leaves"],
    ["POST", "/api/hr/documents"],
    ["PUT", "/api/hr/leaves/config"],
    /* The CEO projection's own employee list and the employee app. */
    ["GET", "/api/ceo/hr/employees"],
    ["GET", "/api/employee/salary"],
  ])("%s %s is NOT in the employee section", (method, path) => {
    const d = findDeclaration(method, path);
    expect(d).toBeTruthy();
    expect({ method, path, section: d.employeeSection === true, byRule: isEmployeeSection(d) })
      .toEqual({ method, path, section: false, byRule: false });
  });

  test("every marked declaration is an hr-scope employee, face-registration or face-invite route — and nothing else is marked", () => {
    const EXCLUDED = new Set(["PUT /api/employees/config/salary", "POST /api/employees/config/salary/preview"]);
    const inFamily = (p) =>
      p === "/api/employees" ||
      p.startsWith("/api/employees/") ||
      p.startsWith("/hr/face-registration/") ||
      p.startsWith("/hr/face-enroll/invite/");

    const wrong = [];
    for (const d of DECLARATIONS) {
      const expected = d.scope === "hr" && inFamily(d.path) && !EXCLUDED.has(`${d.method} ${d.path}`);
      if (Boolean(d.employeeSection) !== expected) wrong.push(`${d.method} ${d.path} (scope ${d.scope})`);
    }
    expect(wrong).toEqual([]);
    /* And the section is not empty — a rename that silently unmarked it all
       would otherwise pass the line above. */
    expect(DECLARATIONS.filter((d) => d.employeeSection).length).toBeGreaterThan(20);
  });

  test("a self-scoped or manager-scoped route is never marked, whatever its path", () => {
    const marked = DECLARATIONS.filter((d) => d.employeeSection);
    for (const d of marked) {
      expect({ path: d.path, scope: d.scope }).toEqual({ path: d.path, scope: "hr" });
    }
  });
});
