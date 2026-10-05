"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

// Registration tests do not need the dashboard builders. Mock them before
// loading hrTools so Jest never traverses the attendance route's ESM-only
// device dependency.
jest.mock("../../services/hrOverviewContext", () => ({ buildHrOverviewContext: jest.fn() }));
jest.mock("../../services/dailyAttendanceContext", () => ({ buildDailyAttendanceContext: jest.fn() }));
jest.mock("../../services/hrLeaveContext", () => ({ buildLeaveContext: jest.fn() }));
jest.mock("../../services/hrEmployeeContext", () => ({
  buildEmployeeLookup: jest.fn(),
  resolveEmployeeByQuery: jest.fn(async (query) =>
    /designations inside accounts/i.test(String(query || ""))
      ? null
      : { _id: "employee-1", firstName: "Arpita", lastName: "Das" }),
  resolveSelfEmployee: jest.fn(),
  fullName: jest.fn((e) => e && e.employeeName),
  istDateStr: jest.fn(() => "2026-09-27"),
  istNow: jest.fn(() => new Date("2026-09-27T00:00:00.000Z")),
}));
jest.mock("../../services/hrExtraContext", () => ({
  buildDirectoryContext: jest.fn(),
  buildDepartmentsContext: jest.fn(async () => ({
    count: 1,
    departments: [{
      name: "ACCOUNTS",
      designations: [{ name: "ACCOUNTANT", active: true }, { name: "ACCOUNTS MANAGER", active: true }],
    }],
  })),
  buildOvertimeContext: jest.fn(),
  buildHolidaysContext: jest.fn(),
  buildPoliciesContext: jest.fn(),
  buildPayrollContext: jest.fn(),
  buildSalaryContext: jest.fn(),
}));

const { CAPABILITIES } = require("../../services/access/hrCapabilities");
const registry = require("../../services/ai/toolRegistry");
registry._clear();
require("../../services/ai/tools/hrTools");

function loadTools(capabilities) {
  const user = { hrActor: { hasHrApplicationAccess: true, capabilities: new Set(capabilities) } };
  return { registry, user, names: registry.authorizedTools(user).map((t) => t.name) };
}

describe("complete HR assistant read catalogue", () => {
  test("registers each underlying HR record domain with a closed argument schema", () => {
    const { registry } = loadTools(Object.values(CAPABILITIES));
    const expected = [
      "hr_attendance_records",
      "hr_attendance_exclusions",
      "hr_leave_records",
      "hr_recruitment",
      "hr_documents",
      "hr_payroll_records",
      "hr_payroll_runs",
      "hr_performance",
      "hr_audit",
    ];
    for (const name of expected) {
      const tool = registry.getTool(name);
      expect(tool).toBeTruthy();
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).not.toBe(true);
      expect(typeof tool.provideContext).toBe("function");
    }
  });

  test("a viewer receives ordinary read domains but never detailed payroll", () => {
    const viewer = [
      CAPABILITIES.HR_ACCESS,
      CAPABILITIES.PEOPLE_READ_DIRECTORY,
      CAPABILITIES.ATTENDANCE_READ,
      CAPABILITIES.LEAVE_READ,
      CAPABILITIES.RECRUITMENT_READ,
      CAPABILITIES.DOCUMENTS_READ,
      CAPABILITIES.SKILLS_READ,
      CAPABILITIES.ANALYTICS_WORKFORCE,
      CAPABILITIES.AUDIT_READ,
    ];
    const { names } = loadTools(viewer);
    expect(names).toEqual(expect.arrayContaining([
      "hr_attendance_records", "hr_attendance_exclusions", "hr_leave_records", "hr_recruitment",
      "hr_documents", "hr_performance", "hr_audit",
    ]));
    expect(names).not.toContain("hr_payroll_records");
    expect(names).not.toContain("hr_payroll_runs");
    expect(names).not.toContain("hr_salary");
  });

  test("detailed payroll needs both payroll and compensation reads", () => {
    const base = [CAPABILITIES.HR_ACCESS, CAPABILITIES.PAYROLL_READ];
    expect(loadTools(base).names).not.toContain("hr_payroll_records");
    expect(loadTools([...base, CAPABILITIES.COMPENSATION_READ]).names).toEqual(expect.arrayContaining(["hr_payroll_records", "hr_payroll_runs"]));
  });

  test("an unresolved or non-HR actor receives no HR tools", () => {
    expect(registry.authorizedTools({ hrActor: { hasHrApplicationAccess: false, capabilities: new Set(Object.values(CAPABILITIES)) } }))
      .toEqual([]);
  });

  test("language-model evidence strips credentials and storage links recursively", () => {
    const { _stripAssistantSecrets } = require("../../services/hrComprehensiveContext");
    expect(_stripAssistantSecrets({
      employee: "A",
      bankDetails: { bankName: "Bank", accountNumber: "123", ifscCode: "IFSC" },
      document: { fileName: "letter.pdf", url: "https://secret", publicId: "p" },
      nested: [{ token: "secret", value: 7 }],
    })).toEqual({
      employee: "A",
      bankDetails: { bankName: "Bank" },
      document: { fileName: "letter.pdf" },
      nested: [{ value: 7 }],
    });
  });

  test("day-level payroll refuses a broad or underspecified read", async () => {
    const { buildPayrollRecordsContext } = require("../../services/hrComprehensiveContext");
    await expect(buildPayrollRecordsContext({ recordType: "items", includeDayBreakdown: true }))
      .resolves.toMatchObject({ found: false });
    await expect(buildPayrollRecordsContext({ recordType: "runs", employeeName: "Priya", month: 6, year: 2026, includeDayBreakdown: true }))
      .resolves.toMatchObject({ found: false });
  });
});

describe("exact employee-field answers", () => {
  test("renders an authorised primary manager without a third model pass", () => {
    const { _renderEmployeeFieldAnswer } = require("../../services/ai/tools/hrTools");
    expect(_renderEmployeeFieldAnswer({
      args: { requestedField: "primaryManager" },
      data: {
        fullRecord: {
          found: true,
          employee: "Arpita Das",
          record: { primaryManager: { managerName: "Trinayan Doley" } },
        },
      },
    })).toBe("Arpita Das's primary manager is Trinayan Doley.");
  });

  test("joins parent-name components from the authorised record", () => {
    const { _renderEmployeeFieldAnswer } = require("../../services/ai/tools/hrTools");
    expect(_renderEmployeeFieldAnswer({
      args: { requestedField: "fatherName" },
      data: {
        fullRecord: {
          found: true,
          employee: "Arpita Das",
          record: { fatherFirstName: "Amit", fatherMiddleName: "Kumar", fatherLastName: "Das" },
        },
      },
    })).toBe("Arpita Das's father is Amit Kumar Das.");
  });

  test("keeps broad record requests on the grounded answer path", () => {
    const { _renderEmployeeFieldAnswer } = require("../../services/ai/tools/hrTools");
    expect(_renderEmployeeFieldAnswer({
      args: { requestedField: "fullRecord" },
      data: { fullRecord: { found: true, employee: "Arpita Das", record: {} } },
    })).toBeNull();
  });

  test("claims a named person's attendance and renders the authorised summary deterministically", async () => {
    const tool = registry.getTool("hr_employee");
    await expect(tool.claim({ message: "arpita's attendance", history: [] })).resolves.toEqual({
      employeeName: "arpita's attendance",
      requestedField: "attendanceSummary",
    });
    expect(tool.renderAnswer({
      args: { requestedField: "attendanceSummary" },
      data: {
        employee: {
          found: true,
          profile: { name: "ARPITA PRIYADARSHINI DAS" },
          last30DayAttendance: {
            from: "2026-08-29", to: "2026-09-27", daysRecorded: 20,
            present: 17, absent: 1, leave: 1, halfDay: 1, late: 2,
            missedPunch: 0, weeklyOff: 8,
          },
        },
      },
    })).toBe("ARPITA PRIYADARSHINI DAS's attendance from 2026-08-29 to 2026-09-27: 20 recorded days — 17 present, 1 absent, 1 on leave, 1 half-day, 2 late, 0 missed-punch and 8 weekly-off/holiday.");
  });
});

describe("canonical HR semantic metrics", () => {
  test("separates configured gross salary from posted payroll gross", () => {
    const { metric } = require("../../services/hrSemanticMetrics");
    expect(metric("compensation.configured_gross_monthly")).toMatchObject({
      source: "employee_master",
      path: "salary.gross",
      temporal: "current",
    });
    expect(metric("payroll.gross_earnings")).toMatchObject({
      source: "posted_payroll_item",
      path: "earnings.gross",
      temporal: "month_required",
    });
  });

  test("formats the authoritative configured amount deterministically", () => {
    const { metric, renderMetricAnswer } = require("../../services/hrSemanticMetrics");
    expect(renderMetricAnswer({
      definition: metric("compensation.configured_gross_monthly"),
      employee: "ARPITA PRIYADARSHINI DAS",
      source: { salary: { gross: 21363 } },
    })).toBe("ARPITA PRIYADARSHINI DAS's configured gross monthly salary is ₹21,363.");
  });

  test("uses catalogue grain metadata when the same measure has a payroll period", () => {
    const { metricForRequest } = require("../../services/hrSemanticMetrics");
    expect(metricForRequest("compensation.configured_gross_monthly", { month: 8, year: 2026 }))
      .toMatchObject({ id: "payroll.gross_earnings", source: "posted_payroll_item", temporal: "month_required" });
    expect(metricForRequest("compensation.configured_gross_monthly", {}))
      .toMatchObject({ id: "compensation.configured_gross_monthly", source: "employee_master", temporal: "current" });
  });

  test("catalogue aliases separate the person from standard HR terminology", () => {
    const { ALIASES, metric, metricFromText, stripMetricTerms, metricGlossary } = require("../../services/hrSemanticMetrics");
    const ctc = metric("compensation.configured_employer_cost_monthly");
    expect(ctc.aliases).toEqual(expect.arrayContaining(["ctc", "cost to company"]));
    expect(stripMetricTerms("arpita ctc", ctc)).toBe("arpita");
    expect(metricGlossary()).toContain("CTC/cost to company");
    expect(metricFromText("what is Arpita's email?")).toMatchObject({ id: "employee.work_email" });
    expect(metricFromText("Arpita personal email")).toMatchObject({ id: "employee.personal_email" });
    expect(metricFromText("what is Umung's full name?")).toMatchObject({ id: "employee.full_name" });
    for (const [metricId, aliases] of Object.entries(ALIASES)) {
      for (const alias of aliases) {
        expect(metricFromText(`Arpita ${alias}`)).toMatchObject({ id: metricId });
      }
    }
  });

  test("the exact catalogue claim overrides neither employee identity nor field", async () => {
    const tool = registry.getTool("hr_person_metric");
    await expect(tool.claim({ message: "what is Arpita's email?", history: [] })).resolves.toEqual({
      employeeName: "what is Arpita's ?",
      metric: "employee.work_email",
    });
    await expect(tool.claim({ message: "CTC of Arpita", history: [] })).resolves.toEqual({
      employeeName: "of Arpita",
      metric: "compensation.configured_employer_cost_monthly",
    });
    await expect(tool.claim({ message: "what is Umung's full name?", history: [] })).resolves.toEqual({
      employeeName: "what is Umung's ?",
      metric: "employee.full_name",
    });
  });

  test("renders a split employee name as one deterministic value", () => {
    const { metric, renderMetricAnswer } = require("../../services/hrSemanticMetrics");
    expect(renderMetricAnswer({
      definition: metric("employee.full_name"),
      employee: "UMANG ARORA",
      source: { firstName: "UMANG", middleName: "KUMAR", lastName: "ARORA" },
    })).toBe("UMANG ARORA's full name is UMANG KUMAR ARORA.");
  });

  test("catalogue comparisons preserve the employee, metric and expected value", async () => {
    const tool = registry.getTool("hr_person_metric");
    await expect(tool.claim({
      message: "is Arpita's secondary manager Sakib?",
      history: [],
    })).resolves.toEqual({
      employeeName: "Arpita",
      metric: "employee.secondary_manager",
      expectedValue: "Sakib",
    });
  });

  test("renders yes/no comparisons from authorised values without Qwen", () => {
    const { metric, renderMetricComparisonAnswer } = require("../../services/hrSemanticMetrics");
    expect(renderMetricComparisonAnswer({
      definition: metric("employee.secondary_manager"),
      employee: "ARPITA PRIYADARSHINI DAS",
      source: { secondaryManager: { managerName: "SHAIK SAKIB" } },
      expectedValue: "Sakib",
    })).toBe("Yes. ARPITA PRIYADARSHINI DAS's secondary manager is SHAIK SAKIB.");
    expect(renderMetricComparisonAnswer({
      definition: metric("employee.religion"),
      employee: "ARPITA PRIYADARSHINI DAS",
      source: { religion: "HINDU" },
      expectedValue: "Christian",
    })).toBe("No. ARPITA PRIYADARSHINI DAS's religion is HINDU.");
    expect(renderMetricComparisonAnswer({
      definition: metric("compensation.configured_gross_monthly"),
      employee: "ARPITA PRIYADARSHINI DAS",
      source: { salary: { gross: 21363 } },
      expectedValue: "₹21,363",
    })).toBe("Yes. ARPITA PRIYADARSHINI DAS's configured gross monthly salary is ₹21,363.");
  });

  test("every catalogue alias supports the same possessive comparison grammar", () => {
    const { ALIASES, metric, parseMetricComparison } = require("../../services/hrSemanticMetrics");
    for (const [metricId, aliases] of Object.entries(ALIASES)) {
      for (const alias of aliases) {
        expect(parseMetricComparison(`is Arpita's ${alias} expected?`, metric(metricId)))
          .toEqual({ employeeName: "Arpita", expectedValue: "expected" });
      }
    }
  });

  test("an organisation department is never claimed as an employee scalar subject", async () => {
    const tool = registry.getTool("hr_person_metric");
    await expect(tool.claim({
      message: "designations inside accounts department?",
      history: [],
    })).resolves.toBeNull();
  });

  test("a known department-designation query is claimed and rendered without Qwen", async () => {
    const tool = registry.getTool("hr_departments");
    await expect(tool.claim({
      message: "designations inside accounts department?",
      history: [],
    })).resolves.toEqual({ department: "ACCOUNTS" });
    expect(tool.renderAnswer({
      args: { department: "ACCOUNTS" },
      data: {
        departments: {
          departments: [{
            name: "ACCOUNTS",
            designations: [{ name: "ACCOUNTANT", active: true }, { name: "ACCOUNTS MANAGER", active: true }],
          }],
        },
      },
    })).toBe("The ACCOUNTS department has these designations: ACCOUNTANT, ACCOUNTS MANAGER.");
  });

  test("registers one closed scalar metric tool with temporal metadata", () => {
    const tool = registry.getTool("hr_person_metric");
    expect(tool).toBeTruthy();
    expect(tool.modelSelectable).toBe(false);
    expect(tool.parameters.required).toEqual(["employeeName", "metric"]);
    expect(tool.parameters.properties.metric.enum).toEqual(expect.arrayContaining([
      "employee.primary_manager",
      "compensation.configured_gross_monthly",
      "payroll.gross_earnings",
    ]));
  });

  test("Qwen cannot select scalar employee enums that the catalogue owns", () => {
    const employee = registry.getTool("hr_employee");
    expect(employee.parameters.properties.requestedField.enum).toEqual(["fullRecord", "attendanceSummary"]);
    expect(employee.parameters.properties.requestedField.enum).not.toContain("employmentType");
  });
});
