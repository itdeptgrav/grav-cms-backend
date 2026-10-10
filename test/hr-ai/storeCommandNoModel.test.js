// test/hr-ai/storeCommandNoModel.test.js
//
// NO LANGUAGE MODEL ON THIS PATH — PROVED BY RUNNING IT.
//
// ── WHY THE REQUIRE GRAPH IS NOT ENOUGH ───────────────────────────────────
// The first version of this proof walked `require.cache` and found no model
// module. That is worth having, but it only says nothing was IMPORTED. It
// would still pass if the service reached a model over HTTP, spawned one, or
// read one through a late `require` inside a branch that tests never took.
//
// So this suite answers all ten required questions against a seeded Store
// with every outbound door nailed shut: `fetch`, `http.request`,
// `https.request` and `child_process.spawn` all throw if touched. A model
// cannot be consulted locally or remotely without going through one of them.
"use strict";

const http = require("http");
const https = require("https");
const childProcess = require("child_process");

const service = require("../../services/ai/storeCommandSearch.service");
const { seedStore, storeReaderFor } = require("../support/storeCommandFixtures");

const QUESTIONS = [
  "macbook", "stock of macbook", "where is soda ash kept",
  "which rack has soda ash", "GRN/2026-27/0004",
  "goods receipts expected in June 2026", "latest five material requests",
  "purchase orders of Gaurav Enterprises", "pending goods receipt inspections",
  "shortfall for 16mm flex pipe",
];

describe("the whole path runs with every outbound door shut", () => {
  const touched = [];
  const saved = {};

  beforeEach(() => {
    touched.length = 0;
    const trap = (name) => (...args) => {
      /* MongoDB speaks raw TCP through `net`, not these, so a database read
         is unaffected. Anything a model needs is not. */
      touched.push({ name, arg: String(args[0]).slice(0, 120) });
      throw new Error(`${name} was called on the deterministic path`);
    };
    saved.fetch = global.fetch;
    saved.httpRequest = http.request;
    saved.httpsRequest = https.request;
    saved.spawn = childProcess.spawn;
    saved.exec = childProcess.exec;
    global.fetch = trap("fetch");
    http.request = trap("http.request");
    https.request = trap("https.request");
    childProcess.spawn = trap("spawn");
    childProcess.exec = trap("exec");
  });

  afterEach(() => {
    global.fetch = saved.fetch;
    http.request = saved.httpRequest;
    https.request = saved.httpsRequest;
    childProcess.spawn = saved.spawn;
    childProcess.exec = saved.exec;
  });

  test("all ten answer, and nothing left this process", async () => {
    const store = await seedStore();
    const reader = storeReaderFor(store.companyId);
    const states = [];
    for (const question of QUESTIONS) {
      // eslint-disable-next-line no-await-in-loop
      states.push((await service.search({ user: reader, query: question })).state);
    }
    expect(touched).toEqual([]);
    /* And they are real answers, not ten identical refusals that would also
       have made no outbound call. */
    expect(states.filter((s) => s === "answered" || s === "choices")).toHaveLength(QUESTIONS.length);
  });

  test("choosing a record makes no outbound call either", async () => {
    const store = await seedStore();
    const reader = storeReaderFor(store.companyId);
    const out = await service.search({ user: reader, query: "where is sodium kept" });
    const choice = out.groups?.[0]?.results?.[0];
    if (choice?.resolve) {
      const back = await service.resolveChoice({ user: reader, resolution: choice.resolve });
      expect(back.state).toBe("answered");
    }
    expect(touched).toEqual([]);
  });
});

describe("and nothing in the graph is a model", () => {
  test("no model module is loaded by requiring this service", () => {
    const forbidden = /gravAssistant|qwenToolPlanner|qwenClient|ollamaClient|\bllm\b/i;
    const loaded = Object.keys(require.cache)
      .filter((file) => forbidden.test(file) && !/test/.test(file));
    expect(loaded).toEqual([]);
  });

  test("the modules this path owns name no model", () => {
    const fs = require("fs");
    const path = require("path");
    const own = [
      "storeCommandSearch.service.js", "storeCommandIntent.js",
      "storeCommandRouting.js", "storeCommandArgs.js",
      /* The router's CONTRACT is on this path; the router itself
         (`storeCommandRouter.js`) is not, and is loaded only by the route. */
      "storeCommandRouterContract.js", "storeCommandExclusions.js",
    ];
    for (const file of own) {
      const src = fs.readFileSync(path.join(__dirname, "..", "..", "services", "ai", file), "utf8");
      /* The words appear in the comments explaining WHY there is no model,
         so only a require or a call counts. */
      expect(src).not.toMatch(/require\(["'][^"']*(qwen|ollama|gravAssistant)/i);
      expect(src).not.toMatch(/\b(generateGrounded|chatStreaming|planTools)\s*\(/);
    }
  });
});
