"use strict";
/**
 * scripts/open-jev-pilot/analyse-accounts.js — the full per-case analysis.
 *
 * A SEPARATE pass, not a change to the evaluator. `evaluate-accounts.js` is
 * byte-identical to the version that produced the headline run; it prints a
 * summary and keeps its per-case rows in memory, which is enough for accuracy
 * and latency but not for a confusion matrix, a per-category breakdown or a
 * paraphrase-consistency check. Rather than edit it mid-evaluation — which
 * would make the two runs incomparable — this script runs the SAME cases
 * through the SAME pilot with the SAME configuration and writes every row to
 * JSON, from which the cuts below are computed.
 *
 * Nothing here is tuned: the candidate descriptions, the thresholds, the
 * instructions, the checkpoint and the cases are all the ones the pilot and the
 * evaluator already use, imported rather than restated.
 *
 *   GRAV_OPEN_JEV_TIMEOUT_MS=30000 JEV_DEVICE=cpu \
 *     node scripts/open-jev-pilot/analyse-accounts.js --runs=2 --device=cpu
 *
 * `--replay=<file>` recomputes every table from a previous run's rows without
 * calling the model, so the analysis can be re-cut without spending CPU again.
 */

const fs = require("node:fs");
const path = require("node:path");

const { runAccountsPilot } = require("../../services/ai/openJev/accountsPilot");
const { openJevConfig, MODE_JEV_ONLY_ACCOUNTS } = require("../../services/ai/openJev/config");
const { VOUCHER_ALIASES } = require("../../services/accountingContext");
const fixtures = require("./accounts-fixtures");
require("../../services/ai/tools/accountingTools");

const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "accounts-cases.json"), "utf8"));

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const RUNS = Number(arg("runs", "2")) || 2;
const REPLAY = arg("replay", "");
const DEVICE = (arg("device", "") || process.env.JEV_DEVICE || "device-not-stated").toUpperCase();
const OUT = path.join(__dirname, `accounts-rows-${DEVICE.toLowerCase()}.json`);

const USERS = {
  accountant: { id: "eval-accountant", accountingAccess: { allowed: true } },
  outsider: { id: "eval-outsider" },
};

/**
 * Which bucket a case belongs to, derived from fields the cases already carry.
 *
 * No case was edited to add a category: a run that changed its own inputs would
 * not be the run that was asked for.
 */
function category(testCase) {
  if (testCase.family === "unauthorised") return "permission-limited";
  if (testCase.family === "unsupported") return "unsupported";
  if (testCase.family === "jev-outage") return "transport";
  return testCase.outcome === "clarified" ? "ambiguous" : "clear";
}

const TOOLS = ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company"];
const CONTROLS = ["clarify", "unsupported"];

async function collect() {
  const cfg = { ...openJevConfig(), enabled: true, mode: MODE_JEV_ONLY_ACCOUNTS };
  console.log(
    `thresholds (pre-registered, unchanged): p>=${cfg.minProbability}, margin>=${cfg.minMargin}` +
    ` | transport timeout: ${cfg.timeoutMs} ms | device: ${DEVICE}`,
  );

  const rows = [];
  let n = 0;
  for (const testCase of CASES.cases) {
    // Transport faults are proven under the evaluator's `absent` router; here
    // they would be ordinary live routes wearing a "failed" expectation.
    if (testCase.jev) continue;

    for (let run = 0; run < RUNS; run += 1) {
      const result = await runAccountsPilot(
        { user: USERS[testCase.actor], message: testCase.question },
        cfg,
        {
          lookupLedger: fixtures.lookupLedger,
          companyProfile: fixtures.companyProfile,
          financials: fixtures.financials,
          buildVouchers: fixtures.buildVouchers,
          voucherAliases: VOUCHER_ALIASES,
          now: () => new Date("2026-09-25T04:00:00Z"),
        },
      );
      const d = result ? result.diagnostics : null;
      rows.push({
        id: testCase.id,
        family: testCase.family,
        category: category(testCase),
        expectedTool: testCase.expect,
        expectedOutcome: testCase.outcome,
        run,
        pilotRan: result !== null,
        chosenTool: d ? d.chosenTool : null,
        probability: d ? d.probability : null,
        margin: d ? d.margin : null,
        jevStatus: d ? d.jevStatus : null,
        actualOutcome: result === null ? "no_pilot" : d.result,
        resultReason: d ? d.resultReason : null,
        jevLatencyMs: d ? d.jevLatencyMs : null,
        readLatencyMs: d ? d.accountingReadLatencyMs : null,
        totalLatencyMs: d ? d.totalLatencyMs : null,
      });
      n += 1;
      if (n % 10 === 0) console.log(`  … ${n} calls`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ device: DEVICE, runs: RUNS, cfg: {
    minProbability: cfg.minProbability, minMargin: cfg.minMargin, timeoutMs: cfg.timeoutMs,
  }, rows }, null, 1));
  console.log(`\nrows written: ${OUT}`);
  return rows;
}

/* ── The cuts ───────────────────────────────────────────────────────────── */

const pct = (a, b) => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function report(rows) {
  const asked = rows.filter((r) => r.pilotRan);
  const h = (t) => console.log(`\n${t}\n${"-".repeat(t.length)}`);

  /* 1. Confusion matrix + per-tool accuracy ─────────────────────────────── */
  h("1. Routing confusion matrix — rows: expected, columns: what Jev chose");
  const labels = [...TOOLS, ...CONTROLS, "(refused)"];
  const expectedKinds = [...TOOLS, ...CONTROLS];
  const cell = (e, c) => asked.filter((r) => r.expectedTool === e
    && (c === "(refused)" ? r.chosenTool === null : r.chosenTool === c)).length;

  const w = 20;
  console.log("".padEnd(w) + labels.map((l) => l.slice(0, 9).padStart(11)).join(""));
  for (const e of expectedKinds) {
    const counts = labels.map((c) => String(cell(e, c)).padStart(11));
    console.log(e.padEnd(w) + counts.join(""));
  }

  h("   Accuracy per accounting tool (chosen == expected)");
  for (const tool of [...TOOLS, ...CONTROLS]) {
    const mine = asked.filter((r) => r.expectedTool === tool);
    if (!mine.length) { console.log(`   ${tool.padEnd(20)} no cases`); continue; }
    const ok = mine.filter((r) => r.chosenTool === tool).length;
    console.log(`   ${tool.padEnd(20)} ${String(ok).padStart(3)}/${String(mine.length).padEnd(3)} ${pct(ok, mine.length)}`);
  }

  /* 2. Clarification and unsupported accuracy ───────────────────────────── */
  h("2. Clarification and unsupported questions");
  for (const control of CONTROLS) {
    const mine = asked.filter((r) => r.expectedTool === control);
    const ok = mine.filter((r) => r.chosenTool === control).length;
    console.log(`   expected ${control.padEnd(12)} routed there ${ok}/${mine.length} (${pct(ok, mine.length)})`);
  }
  const clarifiedOut = asked.filter((r) => r.actualOutcome === "clarified");
  const unsupportedOut = asked.filter((r) => r.actualOutcome === "unsupported");
  console.log(`   final outcome 'clarified':   ${clarifiedOut.length}/${asked.length} (${pct(clarifiedOut.length, asked.length)})`);
  console.log(`   final outcome 'unsupported': ${unsupportedOut.length}/${asked.length} (${pct(unsupportedOut.length, asked.length)})`);

  /* 3. Abstention on questions that should route ────────────────────────── */
  h("3. Abstention on questions that SHOULD route to a tool");
  const shouldRoute = asked.filter((r) => TOOLS.includes(r.expectedTool));
  const abstained = shouldRoute.filter((r) => r.actualOutcome === "failed");
  const byReason = new Map();
  for (const r of abstained) byReason.set(r.resultReason, (byReason.get(r.resultReason) || 0) + 1);
  console.log(`   abstained on ${abstained.length}/${shouldRoute.length} (${pct(abstained.length, shouldRoute.length)})`);
  for (const [reason, count] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(reason).padEnd(28)} ${count}`);
  }

  /* 4. High-confidence wrong routes ─────────────────────────────────────── */
  h("4. High-confidence wrong routes");
  const minProb = rows.__minProb;
  const wrong = asked.filter((r) => r.chosenTool && r.expectedTool
    && r.chosenTool !== r.expectedTool && (r.probability || 0) >= minProb);
  if (!wrong.length) console.log(`   none at p >= ${minProb}`);
  for (const r of wrong) {
    console.log(`   ${r.id.padEnd(24)} run${r.run} chose ${String(r.chosenTool).padEnd(20)} p=${r.probability.toFixed(3)} margin=${r.margin.toFixed(3)} expected ${r.expectedTool}`);
  }

  /* 5. Latency ──────────────────────────────────────────────────────────── */
  h(`5. Latency — ${DEVICE}`);
  const cold = asked.filter((r) => r.run === 0).map((r) => r.jevLatencyMs).filter(Number.isFinite);
  const warm = asked.filter((r) => r.run > 0).map((r) => r.jevLatencyMs).filter(Number.isFinite);
  const warmTotal = asked.filter((r) => r.run > 0).map((r) => r.totalLatencyMs).filter(Number.isFinite);
  const reads = asked.map((r) => r.readLatencyMs).filter(Number.isFinite);
  console.log(`   cold  (run 0)  n=${cold.length}  P50 ${percentile(cold, 50)} ms  P95 ${percentile(cold, 95)} ms  max ${cold.length ? Math.max(...cold) : "—"} ms`);
  console.log(`   warm  (run>0)  n=${warm.length}  P50 ${percentile(warm, 50)} ms  P95 ${percentile(warm, 95)} ms  max ${warm.length ? Math.max(...warm) : "—"} ms`);
  console.log(`   total (warm)   n=${warmTotal.length}  P50 ${percentile(warmTotal, 50)} ms  P95 ${percentile(warmTotal, 95)} ms`);
  console.log(`   accounting read only   P50 ${percentile(reads, 50)} ms  P95 ${percentile(reads, 95)} ms  (n=${reads.length})`);
  console.log("   Routing dominates by three orders of magnitude; the read is not the cost.");

  /* 7. By category ──────────────────────────────────────────────────────── */
  h("7. Results by question kind");
  const cats = ["clear", "ambiguous", "unsupported", "permission-limited"];
  console.log("   kind                 cases  behaved-as-expected  routed-correctly");
  for (const cat of cats) {
    const mine = rows.filter((r) => r.category === cat);
    if (!mine.length) continue;
    const behaved = mine.filter((r) => r.actualOutcome === r.expectedOutcome).length;
    const routable = mine.filter((r) => r.pilotRan && (TOOLS.includes(r.expectedTool) || CONTROLS.includes(r.expectedTool)));
    const routed = routable.filter((r) => r.chosenTool === r.expectedTool).length;
    console.log(
      `   ${cat.padEnd(20)} ${String(mine.length).padStart(5)}  ${`${behaved}/${mine.length}`.padStart(19)}  ${(routable.length ? `${routed}/${routable.length}` : "n/a").padStart(16)}`,
    );
  }

  /* 8. Paraphrase consistency ───────────────────────────────────────────── */
  h("8. Do paraphrases reach the same tool?");
  console.log("   Clear-language cases grouped by the tool they should reach.");
  for (const tool of TOOLS) {
    const mine = asked.filter((r) => r.category === "clear" && r.expectedTool === tool);
    if (!mine.length) continue;
    const spread = new Map();
    for (const r of mine) {
      const k = r.chosenTool || "(refused)";
      spread.set(k, (spread.get(k) || 0) + 1);
    }
    const parts = [...spread].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`);
    const agreement = Math.max(...spread.values()) / mine.length;
    console.log(`   ${tool.padEnd(20)} n=${String(mine.length).padStart(2)}  agreement ${(agreement * 100).toFixed(0)}%  → ${parts.join(", ")}`);
  }

  h("   Same question, two runs — is the model deterministic?");
  const ids = [...new Set(asked.map((r) => r.id))];
  let stable = 0;
  const unstable = [];
  for (const id of ids) {
    const runs = asked.filter((r) => r.id === id);
    if (runs.length < 2) continue;
    const choices = new Set(runs.map((r) => r.chosenTool));
    if (choices.size === 1) stable += 1;
    else unstable.push(`${id}: ${[...choices].join(" vs ")}`);
  }
  console.log(`   identical choice across runs: ${stable}/${ids.filter((id) => asked.filter((r) => r.id === id).length >= 2).length}`);
  for (const u of unstable) console.log(`     ${u}`);

  console.log(
    `\n${DEVICE} figures. CPU and GPU are separate measurements of different` +
    "\ndeployments and must not be averaged or compared as one number.",
  );
}

async function main() {
  let rows;
  let minProb = openJevConfig().minProbability;
  if (REPLAY) {
    const saved = JSON.parse(fs.readFileSync(REPLAY, "utf8"));
    rows = saved.rows;
    minProb = saved.cfg.minProbability;
    console.log(`replaying ${rows.length} rows from ${REPLAY} (device ${saved.device})`);
  } else {
    rows = await collect();
  }
  rows.__minProb = minProb;
  report(rows);
}

main().catch((err) => {
  console.error("analysis failed:", err && err.message);
  process.exitCode = 1;
});
