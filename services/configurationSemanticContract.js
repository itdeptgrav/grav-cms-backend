"use strict";

const MeasurementCategory = require("../models/CMS_Models/Configurations/MeasurementCategory");
const MeasurementTemplate = require("../models/CMS_Models/Configurations/MeasurementTemplate");
const RequestsSettings = require("../models/CMS_Models/Configurations/RequestsSettings");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const CONFIGURATION_CATALOGUE_ID = "configurations";
const definition = (id, label, aliases, valueType, path, query, domain, entity) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), valueType, path, query, domain, entity,
  temporal: "current", source: "cms_configuration",
});

const DEFINITIONS = Object.freeze([
  definition("config.measurement_categories", "Measurement categories", ["measurement category list", "measurement categories"], "list", null, "category_list", "measurement_configuration", "measurement_category"),
  definition("config.measurement_category_name", "Measurement category name", ["category name"], "text", "name", "category", "measurement_configuration", "measurement_category"),
  definition("config.measurement_category_fields", "Measurement category fields", ["measurement fields", "fields in measurement category", "category fields"], "list", "fields", "category", "measurement_configuration", "measurement_category"),
  definition("config.measurement_category_products", "Assigned product categories", ["assigned product categories", "product categories using measurement category"], "list", "productCategories", "category", "measurement_configuration", "measurement_category"),
  definition("config.measurement_category_created_at", "Measurement category created at", ["category created at", "measurement category creation date"], "date_time", "createdAt", "category", "measurement_configuration", "measurement_category"),
  definition("config.measurement_category_updated_at", "Measurement category updated at", ["category updated at", "measurement category last updated"], "date_time", "updatedAt", "category", "measurement_configuration", "measurement_category"),
  definition("config.measurement_templates", "Measurement templates", ["measurement template list", "measurement templates"], "list", null, "template_list", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_name", "Measurement template name", ["template name"], "text", "name", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_category", "Measurement template category", ["template category"], "text", "categoryName", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_gender", "Measurement template gender", ["template gender", "measurement template audience"], "text", "gender", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_values", "Measurement template values", ["template measurements", "template values", "standard measurements"], "field_values", "values", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_notes", "Measurement template notes", ["template notes"], "text", "notes", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_active", "Measurement template active status", ["is template active", "template active status"], "boolean", "isActive", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_created_at", "Measurement template created at", ["template created at", "template creation date"], "date_time", "createdAt", "template", "measurement_configuration", "measurement_template"),
  definition("config.measurement_template_updated_at", "Measurement template updated at", ["template updated at", "template last updated"], "date_time", "updatedAt", "template", "measurement_configuration", "measurement_template"),
  definition("config.mrf_budget_enabled", "MRF budget involvement", ["mrf budget enabled", "mrf finance involvement", "is finance involved in mrf", "mrf budget setting"], "boolean", "mrfBudgetEnabled", "requests", "request_configuration", "requests_settings"),
  definition("config.mrf_budget_note", "MRF budget setting note", ["mrf budget note", "mrf finance note"], "text", "note", "requests", "request_configuration", "requests_settings"),
  definition("config.mrf_budget_updated_by", "MRF budget setting updated by", ["who changed mrf budget", "mrf budget updated by"], "text", "updatedByName", "requests", "request_configuration", "requests_settings"),
  definition("config.mrf_budget_updated_at", "MRF budget setting updated at", ["when was mrf budget changed", "mrf budget updated at"], "date_time", "updatedAt", "requests", "request_configuration", "requests_settings"),
  definition("config.mrf_settings_created_at", "MRF settings created at", ["when were mrf settings created", "mrf settings creation date"], "date_time", "createdAt", "requests", "request_configuration", "requests_settings"),
]);

const exposed = (rows) => rows.map(([id, label, valueType, path]) => ({ id, label, valueType, path }));
const commonExcluded = {
  _id: "Internal record identifier; exact recorded name is the conversational identity.",
  __v: "Database concurrency metadata.",
  createdBy: "Internal actor identifier; not needed for a safe read answer.",
};

const CATEGORY_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "configurations.measurement_category",
  sourceModels: ["models/CMS_Models/Configurations/MeasurementCategory.js"],
  schemaPaths: mongooseSchemaPaths(MeasurementCategory.schema),
  exposed: exposed([
    ["config.measurement_category_name", "Measurement category name", "text", "name"],
    ["config.measurement_category_fields", "Measurement category fields", "list", "fields"],
    ["config.measurement_category_products", "Assigned product categories", "list", "productCategories"],
    ["config.measurement_category_created_at", "Measurement category created at", "date_time", "createdAt"],
    ["config.measurement_category_updated_at", "Measurement category updated at", "date_time", "updatedAt"],
  ]),
  excluded: commonExcluded,
});

const TEMPLATE_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "configurations.measurement_template",
  sourceModels: ["models/CMS_Models/Configurations/MeasurementTemplate.js"],
  schemaPaths: mongooseSchemaPaths(MeasurementTemplate.schema),
  exposed: exposed([
    ["config.measurement_template_name", "Measurement template name", "text", "name"],
    ["config.measurement_template_category", "Measurement template category", "text", "categoryName"],
    ["config.measurement_template_gender", "Measurement template gender", "text", "gender"],
    ["config.measurement_template_values", "Measurement field name", "text", "values.fieldName"],
    ["config.measurement_template_values", "Measurement field value", "text", "values.value"],
    ["config.measurement_template_notes", "Measurement template notes", "text", "notes"],
    ["config.measurement_template_active", "Measurement template active status", "boolean", "isActive"],
    ["config.measurement_template_created_at", "Measurement template created at", "date_time", "createdAt"],
    ["config.measurement_template_updated_at", "Measurement template updated at", "date_time", "updatedAt"],
  ]),
  excluded: {
    ...commonExcluded,
    category: "Internal category reference; the recorded category name is exposed separately.",
  },
});

const REQUESTS_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "configurations.requests_settings",
  sourceModels: ["models/CMS_Models/Configurations/RequestsSettings.js"],
  schemaPaths: mongooseSchemaPaths(RequestsSettings.schema),
  exposed: exposed([
    ["config.mrf_budget_enabled", "MRF budget involvement", "boolean", "mrfBudgetEnabled"],
    ["config.mrf_budget_note", "MRF budget setting note", "text", "note"],
    ["config.mrf_budget_updated_by", "MRF budget setting updated by", "text", "updatedByName"],
    ["config.mrf_budget_updated_at", "MRF budget setting updated at", "date_time", "updatedAt"],
    ["config.mrf_settings_created_at", "MRF settings created at", "date_time", "createdAt"],
  ]),
  excluded: {
    _id: "Internal singleton identifier.",
    __v: "Database concurrency metadata.",
    key: "Internal singleton key; it carries no additional business answer.",
    updatedByRef: "Internal actor identifier; the safe display name is exposed separately.",
  },
});

const CATALOGUE = compileSemanticCatalogue({
  id: CONFIGURATION_CATALOGUE_ID,
  domains: [
    { id: "measurement_configuration", label: "measurement configuration", aliases: ["measurement categories", "measurement templates"] },
    { id: "request_configuration", label: "request configuration", aliases: ["mrf setting", "mrf budget"] },
  ],
  entities: [
    { id: "measurement_category", label: "measurement category", aliases: ["category"] },
    { id: "measurement_template", label: "measurement template", aliases: ["template"] },
    { id: "requests_settings", label: "request settings", aliases: ["mrf settings"] },
  ],
  metrics: DEFINITIONS,
});

module.exports = {
  CONFIGURATION_CATALOGUE_ID, CATALOGUE, DEFINITIONS,
  CATEGORY_FIELD_CONTRACT, TEMPLATE_FIELD_CONTRACT, REQUESTS_FIELD_CONTRACT,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (text) => CATALOGUE.resolveMetric(text),
};
