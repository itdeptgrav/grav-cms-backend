"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { reviewRoute, schemaFor, STATUS } = require("../../services/ai/openJev/qwenRouteReviewer");

const candidates = {
  acc_ledger_balance: "Balance of a specific ledger.",
  clarify: "Required details are missing.",
  unsupported: "Not a supported accounting read.",
};

test("the Qwen reviewer is constrained to exactly the offered route names", () => {
  assert.deepEqual(schemaFor(Object.keys(candidates)).properties.choice.enum, Object.keys(candidates));
  assert.equal(schemaFor(Object.keys(candidates)).additionalProperties, false);
});

test("the reviewer routes the current turn alone and keeps prior user text out of complete requests", async () => {
  const sent = [];
  const result = await reviewRoute(
    {
      question: "balance of Example Textiles",
      candidates,
      jev: { status: "ok", probabilities: { acc_ledger_balance: 0.5, clarify: 0.4, unsupported: 0.1 } },
      history: [
        { role: "user", content: "we were discussing Example Textiles" },
        { role: "assistant", content: "Private balance 999" },
      ],
    },
    { url: "http://qwen.test", model: "qwen-test", timeoutMs: 1000 },
    { chatJson: async (request) => { sent.push(request); return { data: { choice: "acc_ledger_balance" }, model: "qwen-test" }; } },
  );
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.choice, "acc_ledger_balance");
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].prompt);
  assert.deepEqual(Object.keys(body).sort(), ["candidates", "currentQuestion", "jev", "previousUserMessages"]);
  assert.equal(body.currentQuestion, "balance of Example Textiles");
  assert.deepEqual(body.previousUserMessages, []);
  assert.ok(!JSON.stringify(body).includes("Private balance 999"));
  assert.ok(!/mongodb|connection|string|amount|currency|record/i.test(JSON.stringify(body)));
  assert.match(sent[0].system, /current question is authoritative/i);
  assert.match(sent[0].system, /only a new date.*elliptical modification/i);
  assert.match(sent[0].system, /total debit.*MUST use acc_report_query/i);
  assert.match(sent[0].system, /Never silently change turnover into closing balance/i);
  assert.equal(sent[0].temperature, 0);
  assert.equal(sent[0].model, "qwen-test");
});

test("history is supplied only after a current-only route asks for clarification", async () => {
  const sent = [];
  const result = await reviewRoute({
    question: "what about that one?",
    candidates,
    jev: {},
    history: [{ role: "user", content: "balance of Example Textiles" }],
  }, {}, {
    chatJson: async (request) => {
      sent.push(JSON.parse(request.prompt));
      return { data: { choice: sent.length === 1 ? "clarify" : "acc_ledger_balance" }, model: "qwen-test" };
    },
  });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.choice, "acc_ledger_balance");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].previousUserMessages, []);
  assert.deepEqual(sent[1].previousUserMessages, ["balance of Example Textiles"]);
});

test("a date-only follow-up retains the last capability GRAV actually executed", async () => {
  const calls = [];
  const result = await reviewRoute({
    question: "1st July 2026?",
    candidates: { ...candidates, acc_vouchers: "Read vouchers by date." },
    jev: {},
    history: [
      { role: "user", content: "show vouchers" },
      { role: "assistant", content: "A prose answer that is never parsed.", toolsUsed: ["acc_vouchers"] },
    ],
  }, {}, {
    chatJson: async (request) => {
      calls.push(request);
      return { data: { choice: "clarify" }, model: "qwen-test" };
    },
  });
  assert.equal(result.status, STATUS.OK);
  assert.equal(result.choice, "acc_vouchers");
  assert.equal(calls.length, 0);
});

test("an unoffered or failed Qwen answer is never accepted", async () => {
  const invalid = await reviewRoute(
    { question: "x", candidates, jev: {} }, {},
    { chatJson: async () => ({ data: { choice: "admin_delete" }, model: "x" }) },
  );
  assert.equal(invalid.status, STATUS.INVALID);

  const failed = await reviewRoute(
    { question: "x", candidates, jev: {} }, {},
    { chatJson: async () => { const error = new Error("down"); error.code = "OLLAMA_UNAVAILABLE"; throw error; } },
  );
  assert.equal(failed.status, STATUS.FAILED);
  assert.equal(failed.reason, "OLLAMA_UNAVAILABLE");
});
