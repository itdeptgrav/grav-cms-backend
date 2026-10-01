"use strict";
/**
 * scripts/open-jev-pilot/evaluate-accounts.js — run the Accounts evaluation set.
 *
 *   node scripts/open-jev-pilot/evaluate-accounts.js --router=oracle
 *   node scripts/open-jev-pilot/evaluate-accounts.js --router=live
 *   node scripts/open-jev-pilot/evaluate-accounts.js --router=absent
 *
 * THREE ROUTERS, AND ONLY ONE OF THEM MEASURES JEV.
 *
 *   live    the real Open-Jev endpoint. The only mode whose routing numbers
 *           mean anything. Needs a host serving the 2B checkpoint.
 *   oracle  a stand-in that returns each case's expected tool at probability 1.
 *           It measures GRAV's HALF — the permission gates, the resolver's
 *           clarify-versus-answer decision, the deterministic sentence — with
 *           routing held perfect. It says NOTHING about Jev.
 *   absent  no endpoint at all, to show the outage behaviour: every supported
 *           question is refused with a message, and nothing falls back.
 *
 * The script refuses to print routing accuracy, P50 or P95 for anything but
 * `live`. An oracle's latency is the latency of a function call, and printing
 * it beside a heading that says "routing time" is how a number that measures
 * nothing ends up in a report.
 *
 * Everything runs against `accounts-fixtures.js`. No database is opened, no
 * real ledger is read, and nothing here logs a question or an amount.
 */

const path = require("node:path");
const fs = require("node:fs");

const { runAccountsPilot } = require("../../services/ai/openJev/accountsPilot");
const { openJevConfig, MODE_JEV_ONLY_ACCOUNTS } = require("../../services/ai/openJev/config");
const fixtures = require("./accounts-fixtures");
require("../../services/ai/tools/accountingTools"); // registers the real tools

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "accounts-cases.json"), "utf8"),
);

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const ROUTER = arg("router", "oracle");
const RUNS = Number(arg("runs", "1")) || 1;

/**
 * Which deployment produced these numbers.
 *
 * Printed on every routing table because a CPU P95 and a GPU P95 are different
 * measurements of different deployments, and a figure without its device
 * attached is a figure that will eventually be quoted as the other one.
 */
const DEVICE_LABEL = (arg("device", "") || process.env.JEV_DEVICE || "device-not-stated").toUpperCase();

const USERS = {
  accountant: { id: "eval-accountant", accountingAccess: { allowed: true } },
  outsider: { id: "eval-outsider" },
};

/** A router that always names the case's expected tool. Measures GRAV, not Jev. */
function oracleFetch(expected) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const offered = Object.keys(body.questions.route.criteria);
    const choice = offered.includes(expected) ? expected : "unsupported";
    const probabilities = {};
    for (const name of offered) probabilities[name] = 0;
    probabilities[choice] = 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ answers: { route: { type: "choice", choice, probabilities } } }),
    };
  };
}

const absentFetch = async () => {
  const err = new Error("ECONNREFUSED");
  err.code = "ECONNREFUSED";
  throw err;
};

/**
 * The faults an outage case asks for.
 *
 * A case carrying a `jev` field is testing the TRANSPORT, not the model's
 * judgement, so the fault is injected whatever router is selected — except
 * `live`, where a real endpoint is answering and a fault cannot honestly be
 * simulated on top of it.
 */
function faultFetch(kind) {
  if (kind === "unreachable") return absentFetch;
  if (kind === "timeout") {
    return async () => new Promise((_, reject) => {
      // Longer than any configured timeout; the client's AbortController fires.
      setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 60_000);
    });
  }
  if (kind === "invalid") {
    return async () => ({ ok: true, status: 200, json: async () => ({ nonsense: true }) });
  }
  if (kind === "low_confidence") {
    return async (url, init) => {
      const offered = Object.keys(JSON.parse(init.body).questions.route.criteria);
      const probabilities = {};
      // Spread evenly: nothing reaches the pre-registered threshold.
      for (const name of offered) probabilities[name] = 1 / offered.length;
      return {
        ok: true, status: 200,
        json: async () => ({ answers: { route: { type: "choice", choice: offered[0], probabilities } } }),
      };
    };
  }
  if (kind === "unoffered") {
    return async () => ({
      ok: true, status: 200,
      json: async () => ({
        answers: { route: { type: "choice", choice: "acc_vouchers", probabilities: { acc_vouchers: 1 } } },
      }),
    });
  }
  return null;
}

function routerFor(testCase) {
  if (ROUTER === "live") return undefined; // the client's own global fetch
  const fault = testCase.jev ? faultFetch(testCase.jev) : null;
  if (fault) return fault;
  if (ROUTER === "absent") return absentFetch;
  return oracleFetch(testCase.expect);
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

async function main() {
  const cfg = { ...openJevConfig(), enabled: true, mode: MODE_JEV_ONLY_ACCOUNTS };
  const skipped = [];
  // The timeout fault waits far longer than this, so the client aborts. Kept
  // short so the evaluation does not sit for a minute proving one case.
  if (ROUTER !== "live") cfg.timeoutMs = Math.min(cfg.timeoutMs, 300);

  // The TRANSPORT timeout is not one of the decision thresholds. A CPU forward
  // pass over six candidates takes far longer than the 1500 ms default, so a
  // CPU run left at the default would time out on every call and report an
  // outage as though it were a model result. Raise it with
  // GRAV_OPEN_JEV_TIMEOUT_MS for a CPU run and say so in the write-up.
  //
  // `minProbability` and `minMargin` are the pre-registered thresholds and are
  // NOT adjusted here, by this script or by any flag it accepts. Changing them
  // after seeing held-out results would invalidate the comparison.
  console.log(
    `\nthresholds (pre-registered, unchanged): p>=${cfg.minProbability}, margin>=${cfg.minMargin}` +
    ` | transport timeout: ${cfg.timeoutMs} ms`,
  );
  const rows = [];

  for (const testCase of CASES.cases) {
    // Outage cases test the TRANSPORT, and a fault cannot honestly be simulated
    // on top of an endpoint that is actually answering. They are proven in
    // `--router=absent`; here they would just be ordinary live routes wearing a
    // "failed" expectation.
    if (ROUTER === "live" && testCase.jev) {
      skipped.push(testCase.id);
      continue;
    }
    const user = USERS[testCase.actor];
    for (let run = 0; run < RUNS; run += 1) {
      const result = await runAccountsPilot(
        { user, message: testCase.question },
        cfg,
        {
          fetchImpl: routerFor(testCase),
          lookupLedger: fixtures.lookupLedger,
          buildVouchers: fixtures.buildVouchers,
          voucherAliases: require("../../services/accountingContext").VOUCHER_ALIASES,
          companyProfile: fixtures.companyProfile,
          financials: fixtures.financials,
          now: () => new Date("2026-09-25T04:00:00Z"),
        },
      );

      const actual = result === null ? "no_pilot" : result.diagnostics.result;
      rows.push({
        id: testCase.id,
        family: testCase.family,
        expectedOutcome: testCase.outcome,
        actualOutcome: actual,
        expectedTool: testCase.expect,
        chosenTool: result ? result.diagnostics.chosenTool : null,
        // Only ever the first run of a case counts as "warmed"; the rest are
        // discarded by the caller if they want a cold number.
        run,
        jevLatencyMs: result ? result.diagnostics.jevLatencyMs : null,
        readLatencyMs: result ? result.diagnostics.accountingReadLatencyMs : null,
        totalLatencyMs: result ? result.diagnostics.totalLatencyMs : null,
        probability: result ? result.diagnostics.probability : null,
        margin: result ? result.diagnostics.margin : null,
        reason: result ? result.diagnostics.resultReason : null,
      });
    }
  }

  if (skipped.length) {
    console.log(
      `\nSkipped ${skipped.length} transport-fault cases (proven under --router=absent): ` +
      skipped.join(", "),
    );
  }
  report(rows);
}

function report(rows) {
  const warmed = rows.filter((r) => r.run > 0 || RUNS === 1);
  const matched = warmed.filter((r) => r.actualOutcome === r.expectedOutcome);

  console.log(`\nOpen-Jev Accounts pilot — router: ${ROUTER}, runs per case: ${RUNS}`);
  console.log("=".repeat(72));

  const byFamily = new Map();
  for (const r of warmed) {
    if (!byFamily.has(r.family)) byFamily.set(r.family, { total: 0, ok: 0 });
    const f = byFamily.get(r.family);
    f.total += 1;
    if (r.actualOutcome === r.expectedOutcome) f.ok += 1;
  }

  console.log("\nOutcome agreement with the expected behaviour, by family:");
  for (const [family, f] of [...byFamily].sort()) {
    const flag = f.ok === f.total ? " " : "!";
    console.log(`  ${flag} ${family.padEnd(18)} ${f.ok}/${f.total}`);
  }

  // In `absent` the model is deliberately dead, and the expected column is
  // written for a router that answers. Every supported question SHOULD end in
  // `failed` — that is the no-fallback property being demonstrated, not a
  // regression, and the table must not be read as one.
  if (ROUTER === "absent") {
    const supported = warmed.filter((r) => r.expectedOutcome !== "no_pilot");
    const refused = supported.filter((r) => r.actualOutcome === "failed");
    const rescued = supported.filter(
      (r) => r.actualOutcome === "answered" || r.actualOutcome === "clarified",
    );
    console.log(
      `\nNO-FALLBACK CHECK: with no model reachable, ${refused.length}/${supported.length} ` +
      "supported questions were refused with a message.",
    );
    console.log(
      rescued.length === 0
        ? "  None were answered by another path. This is the property the mode exists to have."
        : `  ${rescued.length} were answered anyway — something fell back. That is a defect.`,
    );
    console.log("  (The family table above compares against a WORKING router, so it reads as failures.)");
    return;
  }

  const failures = warmed.filter((r) => r.actualOutcome !== r.expectedOutcome);
  if (failures.length) {
    console.log("\nCases that did not behave as expected:");
    for (const r of failures) {
      console.log(`  ${r.id.padEnd(24)} expected ${r.expectedOutcome}, got ${r.actualOutcome} (${r.reason || "-"})`);
    }
  }

  console.log(`\nOverall: ${matched.length}/${warmed.length} cases behaved as expected.`);

  const rate = (n) => `${n}/${warmed.length} (${((n / warmed.length) * 100).toFixed(1)}%)`;
  console.log(`Clarification rate: ${rate(warmed.filter((r) => r.actualOutcome === "clarified").length)}`);
  console.log(`Unsupported rate:   ${rate(warmed.filter((r) => r.actualOutcome === "unsupported").length)}`);
  console.log(`Failed rate:        ${rate(warmed.filter((r) => r.actualOutcome === "failed").length)}`);

  if (ROUTER !== "live") {
    console.log(
      "\nROUTING METRICS WITHHELD. This run used the `" + ROUTER + "` router, which is not " +
      "Open-Jev.\nRouting accuracy, P50/P95 routing time and high-confidence wrong routes are\n" +
      "properties of the model and can only be measured with --router=live against a\n" +
      "host serving the published 2B checkpoint. What this run does measure is GRAV's\n" +
      "half: permission gates, clarify-versus-answer, and the deterministic answer.",
    );
    return;
  }

  // Live only, and warmed only: the first call per case pays for the connection.
  const warm = rows.filter((r) => r.run > 0);
  const source = warm.length ? warm : rows;
  const jev = source.map((r) => r.jevLatencyMs).filter((n) => typeof n === "number");
  const total = source.map((r) => r.totalLatencyMs).filter((n) => typeof n === "number");
  // The pre-registered threshold, read from config — never a literal here, so
  // it cannot drift from the one the pilot actually applied.
  const cfgProb = openJevConfig().minProbability;
  const wrongHighConfidence = source.filter(
    (r) => r.chosenTool && r.expectedTool && r.chosenTool !== r.expectedTool && (r.probability || 0) >= cfgProb,
  );

  // Routing accuracy, per tool: of the cases whose expected route is this tool,
  // how many did Jev actually send there? Reported per tool because an average
  // hides a tool that is never chosen behind three that always are.
  const routable = source.filter((r) => r.expectedTool && r.expectedTool.startsWith("acc_"));
  const byTool = new Map();
  for (const r of routable) {
    if (!byTool.has(r.expectedTool)) byTool.set(r.expectedTool, { total: 0, ok: 0 });
    const t = byTool.get(r.expectedTool);
    t.total += 1;
    if (r.chosenTool === r.expectedTool) t.ok += 1;
  }

  // The first run of each case pays for the connection and any lazy load.
  const cold = rows.filter((r) => r.run === 0).map((r) => r.jevLatencyMs).filter((n) => typeof n === "number");

  console.log(`\nRouting — Open-Jev ${DEVICE_LABEL}`);
  console.log("-".repeat(52));
  console.log("  Routing accuracy by tool:");
  for (const [tool, t] of [...byTool].sort()) {
    console.log(`    ${tool.padEnd(20)} ${t.ok}/${t.total}`);
  }
  const allOk = [...byTool.values()].reduce((a, t) => a + t.ok, 0);
  const allTotal = [...byTool.values()].reduce((a, t) => a + t.total, 0);
  console.log(`    ${"overall".padEnd(20)} ${allOk}/${allTotal}`);

  console.log(`\n  Cold start (first call per case): P50 ${percentile(cold, 50)} ms, max ${Math.max(...cold)} ms`);
  if (!warm.length) {
    console.log("  WARMED FIGURES UNAVAILABLE: run with --runs=2 or more, or every");
    console.log("  call is a cold one and the percentiles below are cold-start times.");
  }
  console.log(`  P50 routing   ${percentile(jev, 50)} ms`);
  console.log(`  P95 routing   ${percentile(jev, 95)} ms`);
  console.log(`  P50 total     ${percentile(total, 50)} ms`);
  console.log(`  P95 total     ${percentile(total, 95)} ms`);

  console.log(`\n  High-confidence wrong routes (p >= ${cfgProb}): ${wrongHighConfidence.length}`);
  for (const r of wrongHighConfidence) {
    console.log(`    ${r.id}: chose ${r.chosenTool} at p=${r.probability.toFixed(3)}, expected ${r.expectedTool}`);
  }
  if (wrongHighConfidence.length === 0) console.log("    none");

  console.log(
    `\n  ${DEVICE_LABEL} figures. CPU and GPU results are separate measurements and` +
    "\n  must not be averaged or compared as one number: a CPU container proves the" +
    "\n  integration, a GPU host measures the latency a deployment would see.",
  );
}

main().catch((err) => {
  console.error("evaluation failed:", err && err.message);
  process.exitCode = 1;
});
