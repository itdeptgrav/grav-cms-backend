"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  typesafeJevConfig,
  validateEndpoint,
  systemOne,
} = require("./typesafeJev.client");

test("TypeSafe Jev is opt-in and shadowed by default", () => {
  assert.deepEqual(typesafeJevConfig({ TYPESAFE_API_KEY: "secret" }), {
    enabled: false,
    mode: "shadow",
    apiKey: "secret",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    timeoutMs: 1800,
    minConfidence: 0.65,
  });
  assert.equal(typesafeJevConfig({ TYPESAFE_JEV_ACTIONABLES_ENABLED: "TRUE" }).enabled, true);
  assert.equal(typesafeJevConfig({ TYPESAFE_JEV_ACTIONABLES_MODE: "active" }).mode, "active");
  assert.equal(typesafeJevConfig({ TYPESAFE_JEV_ACTIONABLES_MODE: "anything" }).mode, "shadow");
});

test("client refuses non-HTTPS endpoints so the API key cannot be sent in clear text", () => {
  assert.throws(() => validateEndpoint("http://api.typesafe.ai/v1/systemone"), /HTTPS/);
  assert.throws(() => validateEndpoint("not a url"), /valid URL/);
});

test("client sends the official bearer request and model", async () => {
  let observed;
  const result = await systemOne({ state: { x: 1 }, questions: { ok: { type: "noul" } } }, {
    config: {
      apiKey: "private-key",
      endpoint: "https://api.typesafe.ai/v1/systemone",
      model: "jev-latest",
      timeoutMs: 1000,
    },
    fetchImpl: async (url, init) => {
      observed = { url, init };
      return { ok: true, json: async () => ({ model: "jev-1.13", answers: {}, usage: {} }) };
    },
  });
  assert.equal(observed.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(observed.init.headers.Authorization, "Bearer private-key");
  assert.equal(JSON.parse(observed.init.body).model, "jev-latest");
  assert.equal(result.model, "jev-1.13");
});

test("client fails closed when credentials are missing or the API rejects the call", async () => {
  await assert.rejects(systemOne({}, { config: { apiKey: "" } }), /not configured/);
  await assert.rejects(systemOne({}, {
    config: { apiKey: "x", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", timeoutMs: 1000 },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  }), /HTTP 401/);
});
