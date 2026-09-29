"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  interpretArguments,
  schemaForTool,
  validateArguments,
  userContext,
  STATUS,
} = require("../../services/ai/openJev/qwenArgumentInterpreter");

test("argument schemas are route-specific and closed", () => {
  assert.deepEqual(Object.keys(schemaForTool("acc_financials").properties), ["metric"]);
  assert.equal(schemaForTool("acc_financials").additionalProperties, false);
  assert.deepEqual(Object.keys(schemaForTool("acc_ledger_balance").properties),
    ["ledgerMode", "ledgerName", "groupName", "balanceSide", "ranking", "limit"]);
  assert.equal(schemaForTool("acc_ledger_balance").additionalProperties, false);
  assert.deepEqual(
    Object.keys(schemaForTool("acc_vouchers").properties),
    ["voucherType", "partyName", "from", "to", "ranking", "limit", "view"],
  );
  assert.deepEqual(
    Object.keys(schemaForTool("acc_party_reports").properties),
    ["report", "asOf", "search", "ranking", "limit"],
  );
  assert.equal(schemaForTool("acc_party_reports").additionalProperties, false);
  assert.deepEqual(
    Object.keys(schemaForTool("acc_report_query").properties),
    ["rowFields", "measures", "filters", "sort", "limit"],
  );
  assert.equal(schemaForTool("acc_report_query").additionalProperties, false);
  assert.equal(schemaForTool("acc_company"), null);
});

test("Qwen sees user language and bounded user-only context, never accounting records", async () => {
  let sent = null;
  const result = await interpretArguments(
    {
      question: "show his cb",
      tool: "acc_ledger_balance",
      history: [
        { role: "user", content: "tell me about Debidutt Mangilall" },
        { role: "assistant", content: "Secret balance ₹18,99,243 and ledger id 507f1f77bcf86cd799439011" },
      ],
    },
    { url: "http://qwen.test", model: "qwen-test", timeoutMs: 1000 },
    {
      chatJson: async (request) => {
        sent = request;
        return { data: {
          ledgerMode: "single", ledgerName: "Debidutt Mangilall", groupName: null, balanceSide: "any", ranking: "none", limit: 1,
        }, model: "qwen-test" };
      },
    },
  );
  assert.equal(result.status, STATUS.OK);
  assert.deepEqual(result.arguments, {
    ledgerMode: "single", ledgerName: "Debidutt Mangilall", groupName: null, balanceSide: "any", ranking: "none", limit: 1,
  });
  const prompt = JSON.parse(sent.prompt);
  assert.deepEqual(prompt.previousUserMessages, ["tell me about Debidutt Mangilall"]);
  assert.ok(!JSON.stringify(prompt).includes("18,99,243"));
  assert.ok(!JSON.stringify(prompt).includes("507f1f77bcf86cd799439011"));
  assert.equal(sent.temperature, 0);
});

test("ledger arguments are trimmed and voucher arguments are strictly validated", () => {
  assert.deepEqual(validateArguments("acc_financials", { metric: "expenses" }), { metric: "expenses" });
  assert.deepEqual(validateArguments("acc_financials", { metric: "gross_profit" }), { metric: "gross_profit" });
  assert.equal(validateArguments("acc_financials", { metric: "ebitda" }), null);
  assert.deepEqual(validateArguments("acc_ledger_balance", { ledgerName: "  MAYFAIR   Lagoon " }), {
    ledgerName: "MAYFAIR Lagoon",
  });
  assert.deepEqual(validateArguments("acc_ledger_balance", {
    ledgerMode: "group", ledgerName: null, groupName: " Sundry   Debtors ", balanceSide: "any", ranking: "largest", limit: 5,
  }), {
    ledgerMode: "group", ledgerName: "Sundry Debtors", groupName: "Sundry Debtors", balanceSide: "any", ranking: "largest", limit: 5,
  });
  assert.deepEqual(validateArguments("acc_ledger_balance", {
    ledgerMode: "all", ledgerName: null, groupName: null, balanceSide: "cr", ranking: "largest", limit: 5,
  }), {
    ledgerMode: "all", ledgerName: null, groupName: null, balanceSide: "cr", ranking: "largest", limit: 5,
  });
  assert.equal(validateArguments("acc_ledger_balance", { ledgerName: " " }), null);
  assert.deepEqual(validateArguments("acc_vouchers", {
    voucherType: "payment", partyName: null, from: "2026-04-01", to: "2026-06-30", ranking: "largest", limit: 5,
  }), {
    voucherType: "payment", partyName: null, from: "2026-04-01", to: "2026-06-30", ranking: "largest", limit: 5, view: "summary",
  });
  assert.deepEqual(validateArguments("acc_vouchers", {
    voucherType: "all", partyName: " Debidutt   Mangilall ", from: null, to: null, ranking: "recent", limit: 5,
  }), {
    voucherType: "all", partyName: "Debidutt Mangilall", from: null, to: null, ranking: "recent", limit: 5, view: "summary",
  });
  assert.equal(validateArguments("acc_vouchers", {
    voucherType: "payment", from: "2026-02-30", to: "2026-06-30", ranking: "largest", limit: 5,
  }), null);
  assert.equal(validateArguments("acc_vouchers", {
    voucherType: "delete", from: null, to: null, ranking: "none", limit: 3,
  }), null);
  assert.deepEqual(validateArguments("acc_party_reports", {
    report: "supplier_ageing", asOf: "2026-09-30", search: " Debidutt   Mangilall ", ranking: "largest", limit: 5,
  }), {
    report: "supplier_ageing", asOf: "2026-09-30", search: "Debidutt Mangilall", ranking: "largest", limit: 5,
  });
  assert.equal(validateArguments("acc_party_reports", {
    report: "gst_return", asOf: null, search: null, ranking: "none", limit: 5,
  }), null);
  assert.deepEqual(validateArguments("acc_report_query", {
    rowFields: ["ledger.name"],
    measures: [{ field: "amount.debit", calculation: "total" }],
    filters: [{ field: "date.voucher", operation: "between", value: ["2026-04-01", "2026-09-30"] }],
    sort: [{ field: "amount.debit", direction: "desc" }],
    limit: 5,
  }), {
    rowFields: ["ledger.name"],
    measures: [{ field: "amount.debit", calculation: "total" }],
    filters: [{ field: "date.voucher", operation: "between", value: ["2026-04-01", "2026-09-30"] }],
    sort: [{ field: "amount.debit", direction: "desc" }],
    limit: 5,
  });
  assert.equal(validateArguments("acc_report_query", {
    rowFields: ["raw.sql"], measures: [], filters: [], sort: [], limit: 5,
  }), null);
  assert.equal(validateArguments("acc_party_reports", {
    report: "customer_ageing", asOf: "2026-02-30", search: null, ranking: "none", limit: 5,
  }), null);
  assert.deepEqual(validateArguments("acc_party_reports", {
    report: "customer_outstanding", asOf: "null", search: "none", ranking: "largest", limit: 5,
  }), {
    report: "customer_outstanding", asOf: null, search: null, ranking: "largest", limit: 5,
  });
  assert.equal(validateArguments("acc_party_reports", {
    report: "customer_outstanding", asOf: "latest", search: null, ranking: "largest", limit: 5,
  }), null);
});

test("financial language selects one closed metric rather than the bundled summary", async () => {
  let sent;
  const result = await interpretArguments(
    { question: "expenses for this yr", tool: "acc_financials" },
    { model: "qwen-test" },
    { chatJson: async (request) => {
      sent = request;
      return { data: { metric: "expenses" }, model: "qwen-test" };
    } },
  );
  assert.equal(result.status, STATUS.OK);
  assert.deepEqual(result.arguments, { metric: "expenses" });
  assert.deepEqual(sent.schema.properties.metric.enum, [
    "summary", "revenue", "expenses", "direct_revenue", "direct_expenses", "gross_profit",
    "gross_profit_margin", "net_profit", "net_profit_margin", "assets", "liabilities", "equity",
  ]);
  assert.match(sent.system, /select exactly the requested metric/i);
});

test("an explicit natural-language date overrides a model that drops the voucher date", async () => {
  const result = await interpretArguments({
    question: "any vouchers on date 4 June 2026",
    tool: "acc_vouchers",
  }, {}, {
    chatJson: async () => ({
      data: { voucherType: "all", partyName: null, from: null, to: null, ranking: "none", limit: 10, view: "summary" },
      model: "qwen-test",
    }),
  });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.arguments.from, "2026-06-04");
  assert.equal(result.arguments.to, "2026-06-04");
});

test("a date-only follow-up inherits the prior executed voucher filters without another model call", async () => {
  let calls = 0;
  const result = await interpretArguments({
    question: "1st July 2026?",
    tool: "acc_vouchers",
    history: [{
      role: "assistant",
      content: "Prior grounded answer.",
      contextState: {
        tool: "acc_vouchers",
        arguments: { voucherType: "all", partyName: null, from: "2026-06-04", to: "2026-06-04", ranking: "none", limit: 10, view: "summary" },
      },
    }],
  }, {}, { chatJson: async () => { calls += 1; throw new Error("must not run"); } });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.arguments.voucherType, "all");
  assert.equal(result.arguments.ranking, "none");
  assert.equal(result.arguments.from, "2026-07-01");
  assert.equal(result.arguments.to, "2026-07-01");
  assert.equal(calls, 0);
});

test("a contextual voucher follow-up can request detailed rows through the typed output mode", async () => {
  const result = await interpretArguments({
    question: "show me details",
    tool: "acc_vouchers",
    history: [{
      role: "assistant",
      content: "Three vouchers matched.",
      contextState: {
        tool: "acc_vouchers",
        arguments: { voucherType: "all", partyName: null, from: "2026-06-04", to: "2026-06-04", ranking: "none", limit: 10, view: "summary" },
      },
    }],
  }, {}, {
    chatJson: async () => ({ data: {
      voucherType: "all", partyName: null, from: "2026-06-04", to: "2026-06-04", ranking: "none", limit: 10, view: "details",
    }, model: "qwen-test" }),
  });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.arguments.view, "details");
  assert.equal(result.arguments.from, "2026-06-04");
});

test("invalid, unsupported and failed interpretations fail closed", async () => {
  const unsupported = await interpretArguments({ question: "company name", tool: "acc_company" });
  assert.equal(unsupported.status, STATUS.NOT_APPLICABLE);

  const invalid = await interpretArguments(
    { question: "vouchers", tool: "acc_vouchers" }, {},
    { chatJson: async () => ({ data: { voucherType: "admin_delete", from: null, to: null, ranking: "none", limit: 3 } }) },
  );
  assert.equal(invalid.status, STATUS.INVALID);

  const failed = await interpretArguments(
    { question: "balance", tool: "acc_ledger_balance" }, {},
    { chatJson: async () => { const error = new Error("down"); error.code = "OLLAMA_UNAVAILABLE"; throw error; } },
  );
  assert.equal(failed.status, STATUS.FAILED);
  assert.equal(failed.reason, "OLLAMA_UNAVAILABLE");
});

test("only the last two earlier user messages are retained", () => {
  assert.deepEqual(userContext([
    { role: "user", content: "one" },
    { role: "assistant", content: "ignore" },
    { role: "user", content: "two" },
    { role: "user", content: "three" },
  ]), ["two", "three"]);
});

test("party-report instructions distinguish balances from ageing and keep relative dates out of ISO fields", async () => {
  let sent;
  await interpretArguments(
    { question: "top five latest customer receivables", tool: "acc_party_reports" },
    { model: "qwen-test" },
    { chatJson: async (request) => {
      sent = request;
      return { data: { report: "customer_outstanding", asOf: null, search: null, ranking: "largest", limit: 5 } };
    } },
  );
  assert.match(sent.system, /Select an ageing report ONLY/);
  assert.match(sent.system, /current\/latest\/today also means null/);
  assert.match(sent.system, /Plain receivables, payables/);
});

test("general report instructions preserve turnover rather than changing it into closing balance", async () => {
  let sent;
  const result = await interpretArguments(
    { question: "top five ledgers by total debit", tool: "acc_report_query" },
    { model: "qwen-test" },
    { chatJson: async (request) => {
      sent = request;
      return { data: {
        rowFields: ["ledger.name"],
        measures: [{ field: "amount.debit", calculation: "total" }],
        filters: [],
        sort: [{ field: "amount.debit", direction: "desc" }],
        limit: 5,
      } };
    } },
  );
  assert.equal(result.status, STATUS.OK);
  assert.match(sent.system, /Total debit\/credit means posted-line turnover/i);
  assert.deepEqual(result.arguments, {
    rowFields: ["ledger.name"],
    measures: [{ field: "amount.debit", calculation: "total" }],
    filters: [],
    sort: [{ field: "amount.debit", direction: "desc" }],
    limit: 5,
  });
});
