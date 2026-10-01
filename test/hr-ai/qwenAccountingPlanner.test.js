"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  planAccountingQuestion,
  schemaFor,
  validatePlan,
  STATUS,
} = require("../../services/ai/openJev/qwenAccountingPlanner");

const OFFERED = ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company", "acc_party_reports", "acc_report_query", "clarify", "unsupported"];

test("planner schema is closed and limited to authorised choices", () => {
  const schema = schemaFor(OFFERED);
  assert.deepEqual(schema.properties.tool.enum, OFFERED);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.ledger.additionalProperties, false);
  assert.equal(schema.properties.vouchers.additionalProperties, false);
  assert.equal(schema.properties.partyReport.additionalProperties, false);
  assert.equal(schema.properties.financial.additionalProperties, false);
  assert.equal(schema.properties.reportQuery.additionalProperties, false);
});

test("validates one exact financial metric", () => {
  assert.deepEqual(validatePlan({
    tool: "acc_financials",
    ledger: null,
    vouchers: null,
    partyReport: null,
    financial: { metric: "expenses" },
    reportQuery: null,
    clarification: null,
  }, OFFERED), {
    tool: "acc_financials",
    arguments: { metric: "expenses" },
    clarification: null,
  });
  assert.equal(validatePlan({ tool: "acc_financials", financial: { metric: "ebitda" } }, OFFERED), null);
});

test("planner delegates an authorised financial route to its closed metric interpreter", async () => {
  let interpreted;
  const result = await planAccountingQuestion({
    question: "expenses for this yr",
    candidates: Object.fromEntries(OFFERED.map((name) => [name, name])),
    jev: { status: "ok", probabilities: { acc_financials: 0.9 } },
  }, { model: "qwen-test" }, {
    reviewRoute: async () => ({ status: "ok", choice: "acc_financials", model: "qwen-test" }),
    interpretArguments: async (input) => {
      interpreted = input;
      return { status: "ok", arguments: { metric: "expenses" }, model: "qwen-test" };
    },
  });
  assert.equal(interpreted.tool, "acc_financials");
  assert.deepEqual(result.arguments, { metric: "expenses" });
});

test("validates a ranked supplier ageing report plan", () => {
  assert.deepEqual(validatePlan({
    tool: "acc_party_reports",
    ledger: null,
    vouchers: null,
    partyReport: { report: "supplier_ageing", asOf: "2026-09-30", search: null, ranking: "largest", limit: 5 },
    clarification: null,
  }, OFFERED), {
    tool: "acc_party_reports",
    arguments: { report: "supplier_ageing", asOf: "2026-09-30", search: null, ranking: "largest", limit: 5 },
    clarification: null,
  });
});

test("validates a ranked ledger group plan", () => {
  assert.deepEqual(validatePlan({
    tool: "acc_ledger_balance",
    ledger: { mode: "group", name: null, group: "Sundry Debtors", balanceSide: "any", ranking: "largest", limit: 5 },
    vouchers: null,
    clarification: null,
  }, OFFERED), {
    tool: "acc_ledger_balance",
    arguments: {
      ledgerMode: "group",
      ledgerName: "Sundry Debtors",
      groupName: "Sundry Debtors",
      balanceSide: "any",
      ranking: "largest",
      limit: 5,
    },
    clarification: null,
  });
});

test("clarification must be precise and an unoffered tool is refused", () => {
  assert.equal(validatePlan({ tool: "clarify", ledger: null, vouchers: null, clarification: "" }, OFFERED), null);
  assert.deepEqual(validatePlan({
    tool: "clarify", ledger: null, vouchers: null,
    clarification: "By DR, do you mean debit-balance ledgers or Sundry Debtors?",
  }, OFFERED), {
    tool: "clarify", arguments: null,
    clarification: "By DR, do you mean debit-balance ledgers or Sundry Debtors?",
  });
  assert.equal(validatePlan({ tool: "admin_delete", ledger: null, vouchers: null, clarification: null }, OFFERED), null);
});

test("Qwen sees only user language and returns a validated typed plan", async () => {
  let routed;
  let interpreted;
  const result = await planAccountingQuestion({
    question: "top five biggest debtors",
    history: [
      { role: "assistant", content: "Secret balance and record id" },
      { role: "user", content: "show our receivables" },
    ],
    candidates: Object.fromEntries(OFFERED.map((name) => [name, name])),
    jev: { status: "ok", probabilities: { unsupported: 0.9 } },
  }, { model: "qwen-test" }, {
    reviewRoute: async (input) => {
      routed = input;
      return { status: "ok", choice: "acc_ledger_balance", model: "qwen-test" };
    },
    interpretArguments: async (input) => {
      interpreted = input;
      return {
        status: "ok", model: "qwen-test",
        arguments: {
          ledgerMode: "group", ledgerName: "Sundry Debtors", groupName: "Sundry Debtors", balanceSide: "any", ranking: "largest", limit: 5,
        },
      };
    },
  });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.tool, "acc_ledger_balance");
  assert.equal(result.arguments.groupName, "Sundry Debtors");
  assert.equal(result.arguments.limit, 5);
  assert.equal(routed.question, "top five biggest debtors");
  assert.equal(interpreted.tool, "acc_ledger_balance");
});
