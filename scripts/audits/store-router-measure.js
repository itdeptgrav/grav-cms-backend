#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/store-router-measure.js — does the router earn its place?
 *
 * Step 7 of docs/tasks/store-command-complete-then-8b-router.md: run a corpus
 * of questions through
 *
 *   the grammar alone            does it place the question?
 *   the grammar + the router     does it place it, and CORRECTLY?
 *
 * and report the placement rate, the wrong-route rate and the router's
 * latency. A route is wrong when it answers with a sentence the corpus does
 * not list for that question — including answering a question whose honest
 * answer is a refusal.
 *
 * ── WHAT IT DOES NOT DO ───────────────────────────────────────────────────
 * The plan also asks what today's 32b assistant answers. That needs the
 * assistant's model (qwen3:32b over the RunPod tunnel) and runs the assistant
 * against a database; neither is done here. This measures the half that can
 * be measured without a rented GPU.
 *
 * ── NO LIVE DATA ──────────────────────────────────────────────────────────
 * Runs on a throwaway in-memory replica set seeded by
 * test/support/storeCommandFixtures.js, with the tool modules registered in
 * the server's order (gravAssistant.js) — not gravAssistant itself, which
 * would load the model client. Nothing reads or writes Atlas.
 *
 *   node scripts/audits/store-router-measure.js
 *        [--corpus scripts/audits/store-router-corpus.provisional.json]
 *        [--model qwen3:8b] [--url http://127.0.0.1:11434] [--timeout 5000] [--why]
 */

process.env.NODE_ENV = process.env.NODE_ENV || "test";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const ROOT = path.join(__dirname, "..", "..");
const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
};

/* The order of services/ai/gravAssistant.js — the order the server registers
   capabilities in, which once decided routing ties. */
const SERVER_ORDER = [
  "hrTools", "accountingTools", "salesTools",
  "storePurchaseTools", "storePurchaseUniversalTools", "storePurchaseCollectionTools",
  "inventoryTools", "plannerTools", "configurationTools",
  "storeTools", "storeCollectionTools", "storeRequestDeskTools", "storeOperationalTools",
];

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : "—");
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

async function main() {
  const corpusPath = path.resolve(arg("corpus", path.join(__dirname, "store-router-corpus.provisional.json")));
  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));

  const { MongoMemoryReplSet } = require("mongodb-memory-server"); // eslint-disable-line global-require
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(replSet.getUri(), { dbName: "store_router_measure" });
  try {
    for (const name of SERVER_ORDER) require(path.join(ROOT, "services/ai/tools", name)); // eslint-disable-line global-require, import/no-dynamic-require
    const service = require(path.join(ROOT, "services/ai/storeCommandSearch.service")); // eslint-disable-line global-require, import/no-dynamic-require
    const { routerFromEnv } = require(path.join(ROOT, "services/ai/storeCommandRouter")); // eslint-disable-line global-require, import/no-dynamic-require
    const { seedStore, storeReaderFor } = require(path.join(ROOT, "test/support/storeCommandFixtures")); // eslint-disable-line global-require, import/no-dynamic-require

    const store = await seedStore();
    const reader = storeReaderFor(store.companyId);
    const model = arg("model", "qwen3:8b");
    const base = routerFromEnv({
      STORE_COMMAND_ROUTER: "qwen",
      STORE_COMMAND_ROUTER_MODEL: model,
      STORE_COMMAND_ROUTER_URL: arg("url", "http://127.0.0.1:11434"),
      STORE_COMMAND_ROUTER_TIMEOUT_MS: arg("timeout", "5000"),
    });

    const rows = [];
    for (const item of corpus.questions) {
      let call = null;
      const router = async (input) => {
        const started = Date.now();
        try {
          const choice = await base(input);
          call = { ms: Date.now() - started, choice };
          return choice;
        } catch (error) {
          call = { ms: Date.now() - started, error: error.code || error.message };
          throw error;
        }
      };
      // eslint-disable-next-line no-await-in-loop
      const grammar = await service.search({ user: reader, query: item.q });
      // eslint-disable-next-line no-await-in-loop
      const routed = await service.search({ user: reader, query: item.q, router });
      const placed = (out) => ["answered", "choices"].includes(out.state);
      const sentence = routed.routed?.sentence || null;
      const expected = item.expect;
      let verdict;
      if (placed(grammar)) verdict = "grammar";
      else if (!call) verdict = "not consulted";
      else if (call.error) verdict = `router failed (${call.error})`;
      else if (!placed(routed)) verdict = expected === null ? "refused, rightly" : "refused";
      else if (expected === null) verdict = "WRONG ROUTE (should refuse)";
      else verdict = expected.includes(sentence) ? "routed, right" : "WRONG ROUTE";
      rows.push({ item, grammar: grammar.state, routed: routed.state, sentence, call, verdict });
    }

    const width = Math.max(...rows.map((row) => row.item.q.length)) + 2;
    process.stdout.write(`\nStore router — ${model}, corpus ${path.relative(ROOT, corpusPath)} (${rows.length} questions)\n`);
    if (/provisional/i.test(corpusPath)) process.stdout.write("   PROVISIONAL corpus, written by hand — not real questions.\n");
    process.stdout.write("\n");
    for (const row of rows) {
      const ms = row.call ? `${String(row.call.ms).padStart(5)} ms` : "        ";
      process.stdout.write(`   ${row.item.q.padEnd(width)} ${ms}  ${row.verdict}${row.sentence ? `  → "${row.sentence}"` : ""}\n`);
      /* --why: what the model chose, for every route that did not answer. */
      if (process.argv.includes("--why") && row.call?.choice && !row.sentence) {
        process.stdout.write(`   ${" ".repeat(width + 10)}model chose ${JSON.stringify(row.call.choice)}\n`);
      }
    }

    const byGrammar = rows.filter((row) => row.verdict === "grammar").length;
    const unplaced = rows.filter((row) => row.verdict !== "grammar");
    const shouldRoute = unplaced.filter((row) => row.item.expect !== null);
    const shouldRefuse = unplaced.filter((row) => row.item.expect === null);
    const right = unplaced.filter((row) => row.verdict === "routed, right").length;
    const wrong = unplaced.filter((row) => row.verdict.startsWith("WRONG")).length;
    const answeredByRouter = unplaced.filter((row) => row.routed === "answered" || row.routed === "choices").length;
    const failed = unplaced.filter((row) => row.verdict.startsWith("router failed")).length;
    const latencies = rows.filter((row) => row.call && !row.call.error).map((row) => row.call.ms);

    process.stdout.write(`
   placed by the grammar alone            ${byGrammar} of ${rows.length}  (${pct(byGrammar, rows.length)})
   left for the router                    ${unplaced.length}  (${shouldRoute.length} have a right route, ${shouldRefuse.length} should be refused)
   routed and right                       ${right} of ${shouldRoute.length}  (${pct(right, shouldRoute.length)})
   wrong routes                           ${wrong} of ${answeredByRouter} routed answers  (${pct(wrong, answeredByRouter)})
   refusals kept as refusals              ${shouldRefuse.filter((row) => row.verdict === "refused, rightly").length} of ${shouldRefuse.length}
   router calls that failed or timed out  ${failed}
   router latency                         p50 ${quantile(latencies, 0.5) ?? "—"} ms, p95 ${quantile(latencies, 0.95) ?? "—"} ms, max ${latencies.length ? Math.max(...latencies) : "—"} ms
   placed overall (grammar + router)      ${byGrammar + right} of ${rows.length - shouldRefuse.length} answerable  (${pct(byGrammar + right, rows.length - shouldRefuse.length)})

   Not measured here: what today's 32b assistant answers (needs the RunPod tunnel).
\n`);
  } finally {
    await mongoose.disconnect();
    await replSet.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
