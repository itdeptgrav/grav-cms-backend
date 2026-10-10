"use strict";

const MeasurementCategory = require("../models/CMS_Models/Configurations/MeasurementCategory");
const MeasurementTemplate = require("../models/CMS_Models/Configurations/MeasurementTemplate");
const RequestsSettings = require("../models/CMS_Models/Configurations/RequestsSettings");
const { normalize, includesTerm } = require("./ai/semanticCatalogue");

async function loadConfigurations() {
  const [categories, templates, requests] = await Promise.all([
    MeasurementCategory.find({}).select("name fields productCategories createdAt updatedAt").sort({ name: 1 }).lean(),
    MeasurementTemplate.find({}).select("name categoryName gender values notes isActive createdAt updatedAt").sort({ name: 1 }).lean(),
    RequestsSettings.findOne({ key: "requests" })
      .select("mrfBudgetEnabled note updatedByName createdAt updatedAt").lean(),
  ]);
  return {
    categories,
    templates,
    requests: requests ? {
      found: true,
      mrfBudgetEnabled: requests.mrfBudgetEnabled !== false,
      note: requests.note || "",
      updatedByName: requests.updatedByName || "",
      createdAt: requests.createdAt || null,
      updatedAt: requests.updatedAt || null,
    } : { found: false },
  };
}

function resolveNamed(rows, message) {
  const matches = (rows || []).filter((row) => includesTerm(message, row.name));
  if (matches.length === 1) return { found: true, record: matches[0] };
  if (matches.length > 1) return { ambiguous: true, matches };
  const wanted = normalize(message);
  const exact = (rows || []).filter((row) => normalize(row.name) === wanted);
  return exact.length === 1 ? { found: true, record: exact[0] } : { found: false };
}

module.exports = { loadConfigurations, resolveNamed };
