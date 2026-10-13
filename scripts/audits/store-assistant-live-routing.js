#!/usr/bin/env node
"use strict";

require("dotenv").config();
require("../../services/ai/gravAssistant");
const { getTool } = require("../../services/ai/toolRegistry");
const { planToolQuestion, STATUS } = require("../../services/ai/qwenToolPlanner");
const { reconcileArgs: reconcileCollection } = require("../../services/storePurchaseCollectionContext");
const { reconcileReceiveArgs } = require("../../services/receiveWorkspaceAssistantContext");

function effectiveArguments(tool, question, args) {
  if (tool === "store_receive_query") return reconcileReceiveArgs(question, args);
  const match = /^store_collection_(.+)_query$/.exec(tool || "");
  return match ? reconcileCollection(match[1], args, question) : args;
}

const CASES = Object.freeze([
  {
    question: "give me top five latest requests",
    tools: ["store_request_desk_query", "acc_report_query", "store_collection_spend_request_query"],
    expectedTools: ["store_request_desk_query"],
    check: (args) => args.operation === "list" && args.type === "all"
      && args.stage === "all" && args.sort === "newest" && args.limit === 5,
  },
  {
    question: "any grn expected in june 2026",
    tools: ["store_receive_query", "store_record_goods_receipt_field", "store_collection_goods_receipt_query"],
    expectedTools: ["store_receive_query"],
    check: (args) => args.operation === "exists" && args.stage === "expected"
      && args.dateBasis === "expected_date" && args.from === "2026-06-01" && args.to === "2026-06-30",
  },
  {
    question: "list goods receipts recorded in september 2026",
    tools: ["store_receive_query", "store_record_goods_receipt_field", "store_collection_goods_receipt_query"],
    expectedTools: ["store_receive_query", "store_collection_goods_receipt_query"],
    check: (args, tool) => tool === "store_receive_query"
      ? args.operation === "list" && ["recorded", "all"].includes(args.stage)
        && args.dateBasis === "receipt_date" && args.from === "2026-09-01" && args.to === "2026-09-30"
      : args.operation === "list"
        && (args.metric === "__records__" || args.metric === "sp.goods_receipt.status")
        && (args.filterMetric === "__none__"
          || (args.filterMetric === "sp.goods_receipt.status" && args.filterValue === "RECORDED"))
        && args.dateMetric === "sp.goods_receipt.receiptdate" && args.from === "2026-09-01" && args.to === "2026-09-30",
  },
  {
    question: "how many purchase orders are partially received?",
    tools: ["store_record_purchase_order_field", "store_collection_purchase_order_query", "store_receive_query"],
    expectedTools: ["store_collection_purchase_order_query"],
    check: (args) => args.operation === "count" && args.filterOperator === "equals"
      && String(args.filterValue || "").toLowerCase().includes("partially"),
  },
  {
    question: "group goods receipts by source type",
    tools: ["store_record_goods_receipt_field", "store_collection_goods_receipt_query", "store_receive_query"],
    expectedTools: ["store_collection_goods_receipt_query"],
    check: (args) => args.operation === "group_count" && String(args.metric || "").includes("source"),
  },
  {
    question: "list PO number, vendor name and total amount for partially received purchase orders from vendor Acme Textiles",
    tools: ["store_record_purchase_order_field", "store_collection_purchase_order_query", "store_receive_query"],
    expectedTools: ["store_collection_purchase_order_query"],
    check: (args) => args.operation === "list"
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("sp.purchase_order.ponumber")
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("sp.purchase_order.vendorname")
      && [args.metric, args.outputMetric2, args.outputMetric3].includes("sp.purchase_order.totalamount")
      && args.filterMetric === "sp.purchase_order.status" && args.filterValue === "PARTIALLY_RECEIVED"
      && args.filterMetric2 === "sp.purchase_order.vendorname"
      && ["Acme Textiles", "__resolve_from_authorised_records__"].includes(args.filterValue2),
  },
]);

async function main() {
  const results = [];
  let failed = false;
  for (const item of CASES) {
    const tools = item.tools.map(getTool).filter(Boolean);
    const plan = await planToolQuestion({ question: item.question, tools, history: [] });
    const effective = effectiveArguments(plan.tool, item.question, plan.arguments || {});
    const ok = plan.status === STATUS.OK && item.expectedTools.includes(plan.tool) && item.check(effective, plan.tool);
    if (!ok) failed = true;
    results.push({ question: item.question, ok, expectedTools: item.expectedTools, plan: {
      status: plan.status, tool: plan.tool || null, arguments: plan.arguments || null,
      effectiveArguments: effective, reason: plan.reason || null,
      rejectedArguments: plan.rejectedArguments || null,
    } });
  }
  process.stdout.write(`${JSON.stringify({
    ok: !failed,
    endpoint: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL || "qwen3:8b",
    results,
  }, null, 2)}\n`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
