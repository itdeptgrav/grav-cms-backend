"use strict";

const {
  compileSemanticCatalogue,
  semanticToolCandidates,
} = require("../../services/ai/semanticCatalogue");
const hr = require("../../services/hrSemanticMetrics");
const accounting = require("../../services/accountingSemanticCatalogue");
const sales = require("../../services/salesCustomerContract");
const storePurchase = require("../../services/storeSupplierContract");
const inventory = require("../../services/inventoryItemContract");
const planner = require("../../services/plannerSemanticContract");
const { detectApplications, CATALOGUED, PENDING } = require("../../services/ai/cmsApplicationManifest");

const tool = (name, catalogue, domains, options = {}) => ({
  name,
  semantic: { catalogue, domains, subjects: options.subjects || [] },
  modelSelectable: options.modelSelectable !== false,
  matches: options.matches || (() => false),
});

describe("CMS semantic catalogue compiler", () => {
  test("the HR and Accounting catalogues compile without ambiguous metric aliases", () => {
    expect(hr.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 10, entityCount: 5, metricCount: 65,
    }));
    expect(accounting.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 6, entityCount: 4, metricCount: 12,
    }));
    expect(sales.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 1, entityCount: 1, metricCount: 29,
    }));
    expect(sales.FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 69, exposedFieldCount: 35, excludedFieldCount: 34,
    }));
    expect(storePurchase.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 1, entityCount: 1, metricCount: 28,
    }));
    expect(storePurchase.FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 63, exposedFieldCount: 32, excludedFieldCount: 31,
    }));
    /* 24 since `item.stock_shortfall` — the gap between quantity on hand and
       minimum stock, read as a concept of its own so "shortfall for X" is
       answered from the record rather than estimated elsewhere. It adds no
       schema field, which is why the field counts below are unchanged. */
    expect(inventory.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 1, entityCount: 1, metricCount: 24,
    }));
    expect(inventory.FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 95, exposedFieldCount: 38, excludedFieldCount: 57,
    }));
    expect(planner.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 2, entityCount: 2, metricCount: 20,
    }));
    expect(planner.GOAL_FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 15, exposedFieldCount: 10, excludedFieldCount: 5,
    }));
    expect(planner.TASK_FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 13, exposedFieldCount: 8, excludedFieldCount: 5,
    }));
  });

  test("every declared Accounting financial metric alias resolves back to its owner", () => {
    for (const metric of Object.values(accounting.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(accounting.CATALOGUE.resolveMetric(`${term} for this year`)).toMatchObject({ id: metric.id });
      }
    }
  });

  test("every declared Sales customer metric alias resolves back to its owner", () => {
    for (const metric of Object.values(sales.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(sales.CATALOGUE.resolveMetric(`Acme ${term}`)).toMatchObject({ id: metric.id });
      }
    }
  });

  test("every declared Store supplier metric alias resolves back to its owner", () => {
    for (const metric of Object.values(storePurchase.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(storePurchase.CATALOGUE.resolveMetric(`Acme ${term}`)).toMatchObject({ id: metric.id });
      }
    }
  });

  test("every declared Inventory item metric alias resolves back to its owner", () => {
    for (const metric of Object.values(inventory.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(inventory.CATALOGUE.resolveMetric(`Cotton ${term}`)).toMatchObject({ id: metric.id });
      }
    }
  });

  test("every declared Planner metric alias resolves back to its owner", () => {
    for (const metric of Object.values(planner.CATALOGUE.metrics)) {
      for (const term of [metric.label, ...(metric.aliases || [])]) {
        expect(planner.CATALOGUE.resolveMetric(term)).toMatchObject({ id: metric.id });
      }
    }
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

  test("a matching capability wins inside an already detected business domain", () => {
    compileSemanticCatalogue({
      id: "candidate-preference-test",
      domains: [{ id: "purchase_order", label: "purchase order", aliases: ["purchase orders"] }],
    });
    const tools = [
      tool("purchase_order_record", "candidate-preference-test", ["purchase_order"], {
        matches: (text) => /purchase orders?/i.test(text),
      }),
      tool("purchase_order_collection", "candidate-preference-test", ["purchase_order"], {
        matches: (text) => /purchase orders?/i.test(text),
      }),
      tool("receiving_register", "candidate-preference-test", ["purchase_order", "goods_receipt"], {
        matches: (text) => /receiving|grn|arrival/i.test(text),
      }),
    ];
    expect(semanticToolCandidates(tools, "how many purchase orders are partially received?").map((item) => item.name))
      .toEqual(["purchase_order_record", "purchase_order_collection"]);
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

  test.each([
    ["show current inventory stock", "inventory", PENDING],
    ["which purchase orders are pending", "store_purchase", CATALOGUED],
    ["show the production planning capacity", "ppc", PENDING],
    ["show the standard operating procedure library", "sop", PENDING],
  ])("business areas are detectable at their declared runtime boundary: %s", (message, application, status) => {
    expect(detectApplications(message, { status }).map((item) => item.id)).toContain(application);
  });
});
