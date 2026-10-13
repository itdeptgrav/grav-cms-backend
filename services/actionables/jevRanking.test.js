"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rankActionableSummary } = require("./jevRanking");

const summary = {
  apps: [],
  totals: { pending: 760 },
  top: [
    { slug: "developer", key: "alerts-open", appName: "Developer", label: "New system alerts", count: 754, tone: "urgent", href: "/developer/alerts" },
    { slug: "store", key: "po-late", appName: "Store", label: "Purchase orders past delivery", count: 4, tone: "urgent", href: "/store" },
    { slug: "sales", key: "customer-requests", appName: "Sales", label: "Customers awaiting response", count: 2, tone: "attention", href: "/sales" },
  ],
};

const response = {
  model: "jev-1.13",
  answers: {
    priority_0: { type: "score", score: 1.1, confidence: 0.92, legend: {}, probabilities: {} },
    priority_1: { type: "score", score: 2.4, confidence: 0.91, legend: {}, probabilities: {} },
    priority_2: { type: "score", score: 3.7, confidence: 0.88, legend: {}, probabilities: {} },
  },
  usage: { input_tokens: 420, output_tokens: 15 },
};

const config = {
  enabled: true,
  mode: "active",
  apiKey: "test-only",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-latest",
  timeoutMs: 1000,
  minConfidence: 0.65,
};

test("active mode reorders queues while preserving totals and every item", async () => {
  const out = await rankActionableSummary(summary, { config, systemOneImpl: async () => response });
  assert.deepEqual(out.top.map((x) => `${x.slug}:${x.key}`), [
    "sales:customer-requests",
    "store:po-late",
    "developer:alerts-open",
  ]);
  assert.equal(out.totals, summary.totals);
  assert.equal(out.ranking.status, "ok");
  assert.equal(out.ranking.usage.inputTokens, 420);
  assert.deepEqual(out.top[0].jev, { priorityScore: 3.7, confidence: 0.88 });
});

test("shadow mode records the proposed order without changing the dashboard", async () => {
  const out = await rankActionableSummary(summary, {
    config: { ...config, mode: "shadow" },
    systemOneImpl: async () => response,
  });
  assert.deepEqual(out.top, summary.top);
  assert.deepEqual(out.ranking.proposedOrder, [
    "sales:customer-requests",
    "store:po-late",
    "developer:alerts-open",
  ]);
});

test("low-confidence and unavailable decisions retain the deterministic order", async () => {
  const uncertain = structuredClone(response);
  for (const answer of Object.values(uncertain.answers)) answer.confidence = 0.2;
  const low = await rankActionableSummary(summary, { config, systemOneImpl: async () => uncertain });
  assert.deepEqual(low.top.map((x) => x.key), summary.top.map((x) => x.key));
  assert.equal(low.ranking.confident, 0);

  const failed = await rankActionableSummary(summary, {
    config,
    systemOneImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(failed.top, summary.top);
  assert.equal(failed.ranking.status, "unavailable");
});

test("integration remains disabled without explicit configuration", async () => {
  const out = await rankActionableSummary(summary, {
    config: { ...config, enabled: false },
    systemOneImpl: async () => { throw new Error("must not run"); },
  });
  assert.equal(out.ranking.status, "disabled");
  assert.deepEqual(out.top, summary.top);
});
