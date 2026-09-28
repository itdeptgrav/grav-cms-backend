#!/usr/bin/env node
"use strict";

const hr = require("../../services/hrSemanticMetrics");
const accounting = require("../../services/accountingSemanticCatalogue");
const registry = require("../../services/ai/toolRegistry");
require("../../services/ai/tools/hrTools");
require("../../services/ai/tools/accountingTools");

const catalogues = [hr.CATALOGUE, accounting.CATALOGUE];
const issues = [];
const reports = catalogues.map((catalogue) => {
  const report = catalogue.audit();
  for (const issue of report.issues) issues.push({ catalogue: catalogue.id, ...issue });
  return { catalogue: catalogue.id, ...report };
});

for (const tool of registry._tools.values()) {
  if (!/^(hr|acc)_/.test(tool.name)) continue;
  if (!tool.semantic) {
    issues.push({ type: "tool_without_semantic_metadata", tool: tool.name });
    continue;
  }
  const catalogue = catalogues.find((item) => item.id === tool.semantic.catalogue);
  if (!catalogue) {
    issues.push({ type: "tool_unknown_catalogue", tool: tool.name, catalogue: tool.semantic.catalogue });
    continue;
  }
  for (const domain of tool.semantic.domains) {
    if (!catalogue.domains[domain]) issues.push({ type: "tool_unknown_domain", tool: tool.name, domain });
  }
  for (const subject of tool.semantic.subjects) {
    if (!catalogue.entities[subject]) issues.push({ type: "tool_unknown_subject", tool: tool.name, subject });
  }
}

const result = {
  ok: issues.length === 0,
  catalogues: reports,
  registeredTools: [...registry._tools.values()].filter((tool) => /^(hr|acc)_/.test(tool.name)).length,
  issues,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exitCode = 1;
