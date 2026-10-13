"use strict";

const MeasurementCategory = require("../../models/CMS_Models/Configurations/MeasurementCategory");
const MeasurementTemplate = require("../../models/CMS_Models/Configurations/MeasurementTemplate");
const RequestsSettings = require("../../models/CMS_Models/Configurations/RequestsSettings");
const contract = require("../../services/configurationSemanticContract");
const { loadConfigurations } = require("../../services/configurationAssistantContext");
const { claimConfigurationMetric, renderConfigurationMetric } = require("../../services/ai/tools/configurationTools");
const registry = require("../../services/ai/toolRegistry");

describe("Configuration assistant contract", () => {
  beforeEach(async () => {
    await Promise.all([
      MeasurementCategory.deleteMany({}),
      MeasurementTemplate.deleteMany({}),
      RequestsSettings.deleteMany({}),
    ]);
  });

  test("catalogue and all three source-field contracts audit cleanly", () => {
    expect(contract.CATALOGUE.audit()).toEqual(expect.objectContaining({
      ok: true, domainCount: 2, entityCount: 3, metricCount: 20,
    }));
    expect(contract.CATEGORY_FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 8, exposedFieldCount: 5, excludedFieldCount: 3,
    }));
    expect(contract.TEMPLATE_FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 13, exposedFieldCount: 9, excludedFieldCount: 4,
    }));
    expect(contract.REQUESTS_FIELD_CONTRACT.audit()).toEqual(expect.objectContaining({
      ok: true, schemaFieldCount: 9, exposedFieldCount: 5, excludedFieldCount: 4,
    }));
  });

  test("exact category and template questions resolve to their requested field", async () => {
    const category = await MeasurementCategory.create({
      name: "Formal Shirt", fields: ["Chest", "Sleeve"], productCategories: ["Shirts"],
    });
    await MeasurementTemplate.create({
      name: "Men's Formal Shirt 40", category: category._id, categoryName: category.name,
      gender: "Male", values: [{ fieldName: "Chest", value: "40" }], notes: "Standard fit",
    });

    await expect(claimConfigurationMetric({ message: "fields in Formal Shirt measurement category" }))
      .resolves.toEqual({ metric: "config.measurement_category_fields" });
    await expect(claimConfigurationMetric({ message: "template values for Men's Formal Shirt 40" }))
      .resolves.toEqual({ metric: "config.measurement_template_values" });

    const loaded = await loadConfigurations();
    const definition = contract.metric("config.measurement_template_values");
    const reply = renderConfigurationMetric({
      data: { definition, value: { found: true, record: loaded.templates[0] } },
    });
    expect(reply).toContain("Chest: 40");
    expect(reply).not.toContain(String(category._id));
  });

  test("request setting is deterministic and absence is not replaced with a default", async () => {
    const definition = contract.metric("config.mrf_budget_enabled");
    let loaded = await loadConfigurations();
    expect(renderConfigurationMetric({ data: { definition, value: loaded.requests } }))
      .toMatch(/not present/i);

    await RequestsSettings.create({ key: "requests", mrfBudgetEnabled: false, note: "Temporary pause" });
    loaded = await loadConfigurations();
    expect(renderConfigurationMetric({ data: { definition, value: loaded.requests } }))
      .toBe("MRF budget involvement is disabled.");
  });

  test("tool is catalogue-only and requires a signed-in actor", () => {
    const tool = registry.getTool("config_metric");
    expect(tool.modelSelectable).toBe(false);
    expect(tool.permission({ id: "employee-1" })).toBe(true);
    expect(tool.permission({})).toBe(false);
  });
});
