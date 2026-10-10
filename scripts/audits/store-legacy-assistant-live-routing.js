#!/usr/bin/env node
"use strict";

require("dotenv").config();
require("../../services/ai/gravAssistant");
const { getTool } = require("../../services/ai/toolRegistry");
const { planToolQuestion, STATUS } = require("../../services/ai/qwenToolPlanner");
const { reconcileArgs } = require("../../services/storeCollectionContext");

const noFilters = (args) => [args.filterMetric, args.filterMetric2, args.filterMetric3]
  .every((value) => !value || value === "__none__");
const onlyFilter = (args, metric) => args.filterMetric === metric
  && [args.filterMetric2, args.filterMetric3].every((value) => !value || value === "__none__");

const CASES = Object.freeze([
  {
    entity: "purchase_order",
    question: "list PO number, vendor name and total amount for ordered purchase orders",
    check: (args) => args.operation === "list"
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("store.purchase_order.poNumber")
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("store.purchase_order.vendorName")
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("store.purchase_order.grandTotal")
      && args.filterMetric === "store.purchase_order.status" && args.filterValue === "Ordered"
      && onlyFilter(args, "store.purchase_order.status"),
  },
  {
    entity: "worker_work_order",
    question: "how many worker work orders are issued?",
    check: (args) => args.operation === "count"
      && args.filterMetric === "store.worker_work_order.status" && args.filterValue === "Issued"
      && onlyFilter(args, "store.worker_work_order.status"),
  },
  {
    entity: "order_request",
    question: "group order requests by status",
    check: (args) => args.operation === "group_count" && args.metric === "store.order_request.status" && noFilters(args),
  },
  {
    entity: "manufacturing_work_order",
    question: "list manufacturing work order number and stock item name created in September 2026",
    check: (args) => args.operation === "list"
      && [args.metric, args.outputMetric2].includes("store.manufacturing_work_order.workOrderNumber")
      && [args.metric, args.outputMetric2].includes("store.manufacturing_work_order.stockItemName")
      && args.dateMetric === "store.manufacturing_work_order.createdAt"
      && args.from === "2026-09-01" && args.to === "2026-09-30" && noFilters(args),
  },
  {
    entity: "stock_item_bom",
    question: "list stock item name and gender category",
    check: (args) => args.operation === "list"
      && [args.metric, args.outputMetric2].includes("store.stock_item_bom.name")
      && [args.metric, args.outputMetric2].includes("store.stock_item_bom.genderCategory") && noFilters(args),
  },
  {
    entity: "stock_issuance",
    question: "how many stock issuances were recorded in September 2026?",
    check: (args) => args.operation === "count"
      && args.dateMetric === "store.stock_issuance.createdAt"
      && args.from === "2026-09-01" && args.to === "2026-09-30" && noFilters(args),
  },
]);

async function main() {
  const results = [];
  for (const item of CASES) {
    const expectedTool = `store_legacy_collection_${item.entity}_query`;
    const candidates = [expectedTool, "store_metric"].map(getTool).filter(Boolean);
    const plan = await planToolQuestion({ question: item.question, tools: candidates, history: [] });
    const effective = plan.tool === expectedTool ? reconcileArgs(item.entity, plan.arguments, item.question) : plan.arguments;
    const ok = plan.status === STATUS.OK && plan.tool === expectedTool && item.check(effective || {});
    results.push({ question: item.question, expectedTool, ok, plan: { status: plan.status, tool: plan.tool, arguments: plan.arguments, effectiveArguments: effective } });
  }
  const ok = results.every((item) => item.ok);
  process.stdout.write(`${JSON.stringify({
    ok,
    endpoint: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    cases: results.length,
    results,
  }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
