"use strict";

const {
  compileSemanticCatalogue,
  semanticToolCandidates,
} = require("../../services/ai/semanticCatalogue");
const hr = require("../../services/hrSemanticMetrics");
const accounting = require("../../services/accountingSemanticCatalogue");

const tool = (name, catalogue, domains, options = {}) => ({
  name,
  semantic: { catalogue, domains, subjects: options.subjects || [] },
  modelSelectable: options.modelSelectable !== false,
  matches: options.matches || (() => false),
});

describe("CMS semantic catalogue compiler", () => {
  test("the HR and Accounting catalogues compile without ambiguous metric aliases", () => {
    expect(hr.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 10, entityCount: 5, metricCount: 62,
    }));
    expect(accounting.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 6, entityCount: 4,
    }));
  });

  test("every declared HR metric alias resolves back to its owner", () => {
    for (const metric of Object.values(hr.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(hr.CATALOGUE.resolveMetric(`Arpita ${term}`)).toMatchObject({ id: metric.id });
      }
    }
  });

  test("the standard employee identity contract cannot silently lose fields", () => {
    const required = [
      "employee.full_name",
      "employee.title",
      "employee.nickname",
      "employee.work_email",
      "employee.personal_email",
      "employee.primary_manager",
      "employee.secondary_manager",
      "employee.department",
      "employee.designation",
      "employee.job_title",
      "employee.work_location",
      "employee.shift",
      "employee.needs_to_operate",
    ];
    expect(required.filter((id) => !hr.metric(id))).toEqual([]);
  });

  test.each([
    ["Arpita's attendance", ["attendance"]],
    ["designations inside Accounts department", ["organisation"]],
    ["candidate interview status", ["recruitment"]],
    ["who edited Arpita's profile", ["people", "audit"]],
    ["salary and attendance", ["attendance", "payroll"]],
  ])("detects business domains from %s", (message, expected) => {
    expect(hr.CATALOGUE.detectDomains(message)).toEqual(expect.arrayContaining(expected));
  });

  test("explicit HR domains exclude unrelated model tools", () => {
    const tools = [
      tool("hr_attendance", "hr", ["attendance"]),
      tool("hr_organisation", "hr", ["organisation"]),
      tool("hr_payroll", "hr", ["payroll"]),
      tool("hr_scalar", "hr", ["people", "payroll"], { modelSelectable: false }),
      tool("acc_ledger", "accounting", ["ledger"]),
    ];
    expect(semanticToolCandidates(tools, "Arpita's attendance").map((item) => item.name))
      .toEqual(["hr_attendance"]);
    expect(semanticToolCandidates(tools, "designations inside Accounts department").map((item) => item.name))
      .toEqual(["hr_organisation"]);
  });

  test("cross-app ambiguity preserves candidates from every matching catalogue", () => {
    const tools = [
      tool("hr_payroll", "hr", ["payroll"]),
      tool("acc_ledger", "accounting", ["ledger"]),
      tool("acc_vouchers", "accounting", ["vouchers"]),
    ];
    expect(semanticToolCandidates(tools, "salary payable balance").map((item) => item.name).sort())
      .toEqual(["acc_ledger", "hr_payroll"]);
  });

  test("the compiler reports alias collisions instead of silently choosing one", () => {
    const invalid = compileSemanticCatalogue({
      id: "collision-test",
      domains: [{ id: "test", label: "test", aliases: [] }],
      entities: [{ id: "thing", label: "thing", aliases: [] }],
      metrics: [
        { id: "a", label: "Alpha", aliases: ["same"], domain: "test", entity: "thing" },
        { id: "b", label: "Beta", aliases: ["same"], domain: "test", entity: "thing" },
      ],
    });
    expect(invalid.audit()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ type: "ambiguous_metric_alias", term: "same" })],
    });
    expect(invalid.resolveMetric("same")).toBeNull();
  });
});
