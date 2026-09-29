"use strict";
/**
 * test/hr-ai/openJevAccountsPilot.test.js — the Jev-only Accounts pilot.
 *
 * Two kinds of test here, and the first kind matters more.
 *
 * STRUCTURAL PROOFS. Four claims are made about what Jev cannot do: reach
 * MongoDB, execute a tool it was not offered, widen an accounting permission,
 * or write. Those are not claims to be argued from the design — they are
 * properties of the code, and each is pinned below by construction rather than
 * by inspection. The model is given a question and a set of names; every path
 * from a name to data goes through GRAV's own permission check, and the tests
 * drive the real code with a hostile model to show it.
 *
 * BEHAVIOUR. The mode is off unless switched on, a supported question is never
 * quietly handed to another model, a fuzzy name is asked about rather than
 * guessed at, and a genuine zero survives.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  openJevConfig,
  isJevOnlyAccounts,
  isJevQwenAccounts,
  MODE_JEV_ONLY_ACCOUNTS,
  MODE_JEV_QWEN_ACCOUNTS,
} = require("../../services/ai/openJev/config");
const { accountsCandidates, EXECUTABLE, CLARIFY, UNSUPPORTED } = require("../../services/ai/openJev/accountsCandidates");
const { answerLedgerBalance, OUTCOME } = require("../../services/ai/openJev/ledgerAnswer");
const { runAccountsPilot, executeAccountingTool, answerFinancialMetric, RESULT, NO_ROUTE_REPLY } = require("../../services/ai/openJev/accountsPilot");
const { maySeePilotDiagnostics } = require("../../services/ai/openJev/diagnosticsVisibility");

/**
 * Register the REAL accounting tools, so the pilot's re-authorisation runs the
 * production permission rule rather than a stand-in. Importing this module is
 * what registers them; it opens no connection, and every read below is injected.
 */
require("../../services/ai/tools/accountingTools");

const ROOT = path.join(__dirname, "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CFG = Object.freeze({
  enabled: true,
  mode: MODE_JEV_ONLY_ACCOUNTS,
  url: "http://127.0.0.1:8791/v1/systemone",
  timeoutMs: 1500,
  minProbability: 0.8,
  minMargin: 0.3,
  staleMinutes: 90,
});
const CASCADE_CFG = Object.freeze({
  ...CFG,
  mode: MODE_JEV_QWEN_ACCOUNTS,
  qwen: { url: "http://127.0.0.1:11434", model: "qwen-test", timeoutMs: 5000 },
});

const ACCOUNTANT = { id: "u1", accountingAccess: { allowed: true } };
const OUTSIDER = { id: "u2" };

/** The registry's own shape, with the real accounting permission rule. */
const accAuthorised = (user) => Boolean(user && user.accountingAccess && user.accountingAccess.allowed === true);
const TOOLS = [
  { name: "acc_ledger_balance", description: "Balance of a specific LEDGER/ACCOUNT.", permission: accAuthorised },
  { name: "acc_financials", description: "Company FINANCIAL SUMMARY.", permission: accAuthorised },
  { name: "acc_company", description: "The company's registration / tax profile.", permission: accAuthorised },
  { name: "acc_vouchers", description: "Vouchers / TRANSACTIONS.", permission: accAuthorised },
  { name: "acc_party_reports", description: "Customer receivable and supplier payable reports.", permission: accAuthorised },
  { name: "acc_report_query", description: "General semantic accounting report.", permission: accAuthorised },
  { name: "hr_employee", description: "One employee's record.", permission: () => true },
];
const listTools = (user) => TOOLS.filter((t) => t.permission(user) === true);

/**
 * A model that answers however the test tells it to.
 *
 * It builds a VALID response for whatever candidates GRAV actually offered on
 * that request — every offered name present, summing to one — because the
 * client rejects anything else outright. Tests that want an invalid answer ask
 * for one explicitly with `body` or `rawProbabilities`.
 */
function jevReturning(weights, { status = 200, body, rawChoice, rawProbabilities } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const sentBody = JSON.parse(init.body);
    calls.push({ url, init, sentBody });

    // The client sends { state:{question}, questions:{ route:{ criteria } } }.
    const offered = Object.keys(sentBody.questions.route.criteria);
    const probabilities = rawProbabilities || fill(offered, weights);
    const choice = rawChoice || argmax(probabilities);

    const payload = body ?? { answers: { route: { type: "choice", choice, probabilities } } };
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { fetchImpl, calls };
}

/** Spread the asked-for weights over the offered names, summing to one. */
function fill(offered, weights) {
  const out = {};
  let given = 0;
  for (const name of offered) {
    const w = Number(weights[name]);
    out[name] = Number.isFinite(w) ? w : 0;
    given += out[name];
  }
  const rest = offered.filter((n) => !Number.isFinite(Number(weights[n])));
  const spare = Math.max(0, 1 - given);
  for (const name of rest) out[name] = rest.length ? spare / rest.length : 0;
  // Nudge the top one so rounding cannot break the sum check.
  const top = argmax(out);
  out[top] += 1 - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

function argmax(probabilities) {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
}

const LEDGER = (over = {}) => ({
  found: true,
  fuzzy: false,
  totalMatched: 1,
  matches: [{ name: "Ariel Fabrics", group: "Sundry Debtors", balance: 1234567.89, drCr: "Dr" }],
  ...over,
});

function deps(extra = {}) {
  return {
    listTools,
    lookupLedger: async () => LEDGER(),
    companyProfile: async () => ({ available: true, baseCurrency: "INR", name: "Test Co" }),
    now: () => new Date("2026-09-25T03:50:00Z"),
    ...extra,
  };
}

/* ── The mode is off unless asked for ───────────────────────────────────── */

test("the pilot mode is off by default, and a typo does not turn it on", () => {
  assert.equal(openJevConfig({}).mode, "");
  assert.equal(isJevOnlyAccounts(openJevConfig({})), false);
  // The pilot flag alone is not the mode, and the mode alone is not the pilot.
  assert.equal(isJevOnlyAccounts(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "true" })), false);
  assert.equal(isJevOnlyAccounts(openJevConfig({ GRAV_OPEN_JEV_MODE: MODE_JEV_ONLY_ACCOUNTS })), false);
  assert.equal(
    isJevOnlyAccounts(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "true", GRAV_OPEN_JEV_MODE: "jev_only_acounts" })),
    false, "a misspelled mode is off, never some other mode",
  );
  assert.equal(
    isJevOnlyAccounts(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "true", GRAV_OPEN_JEV_MODE: " JEV_ONLY_ACCOUNTS " })),
    true,
  );
  assert.equal(
    isJevQwenAccounts(openJevConfig({ GRAV_OPEN_JEV_PILOT_ENABLED: "true", GRAV_OPEN_JEV_MODE: " JEV_QWEN_ACCOUNTS " })),
    true,
  );
  assert.equal(isJevOnlyAccounts(openJevConfig({
    GRAV_OPEN_JEV_PILOT_ENABLED: "true", GRAV_OPEN_JEV_MODE: MODE_JEV_QWEN_ACCOUNTS,
  })), false, "cascade mode never changes the measurement-only mode");
});

test("production behaviour outside the mode is untouched", () => {
  // The Accounts branch is reached only through isJevOnlyAccounts, and returns
  // before the HR offer is built. With the mode off, pilot.js runs exactly the
  // code it ran before.
  const pilot = read("services/ai/openJev/pilot.js");
  assert.match(pilot, /if \(isJevOnlyAccounts\(cfg\) \|\| isJevQwenAccounts\(cfg\)\) \{/);
  const branch = pilot.slice(pilot.indexOf("if (isJevOnlyAccounts(cfg) || isJevQwenAccounts(cfg)) {"));
  assert.ok(branch.indexOf("const offer = await offerFor(user);") > 0,
    "the HR path still follows, for when the mode is off");
});

/* ── The optional Jev → Qwen cascade ───────────────────────────────────── */

test("a confident Jev route stays on the fast path and never calls Qwen", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  let reviews = 0;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "balance of Ariel Fabrics" },
    CASCADE_CFG,
    deps({ fetchImpl, reviewRoute: async () => { reviews += 1; throw new Error("must not run"); } }),
  );
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.equal(result.diagnostics.routeDecider, "jev");
  assert.equal(result.diagnostics.qwenInvoked, false);
  assert.equal(reviews, 0);
});

test("a confident Jev clarification still gets one Qwen context review", async () => {
  const { fetchImpl } = jevReturning({ clarify: 0.95, acc_ledger_balance: 0.03, unsupported: 0.02 });
  let reviews = 0;
  const result = await runAccountsPilot(
    {
      user: ACCOUNTANT,
      message: "and what about that account now?",
      history: [{ role: "user", content: "balance of Ariel Fabrics" }],
    },
    CASCADE_CFG,
    deps({
      fetchImpl,
      reviewRoute: async () => {
        reviews += 1;
        return { status: "ok", choice: "acc_ledger_balance", latencyMs: 4, model: "qwen-test" };
      },
      interpretArguments: async () => ({
        status: "ok",
        arguments: { ledgerName: "Ariel Fabrics" },
        latencyMs: 3,
        model: "qwen-test",
      }),
    }),
  );
  assert.equal(reviews, 1);
  assert.equal(result.diagnostics.routeDecider, "qwen_review");
  assert.equal(result.diagnostics.chosenTool, "acc_ledger_balance");
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
});

test("a confident Jev unsupported decision is corrected by the typed Qwen planner", async () => {
  const { fetchImpl } = jevReturning({ unsupported: 0.96, acc_ledger_balance: 0.02, clarify: 0.02 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "top five biggest debtors" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      planAccountingQuestion: async () => ({
        status: "ok",
        tool: "acc_ledger_balance",
        arguments: {
          ledgerMode: "group", ledgerName: "Sundry Debtors", groupName: "Sundry Debtors", balanceSide: "any",
          ranking: "largest", limit: 5,
        },
        latencyMs: 7,
        model: "qwen-test",
      }),
      lookupLedger: async () => ({
        found: true, fuzzy: false, totalMatched: 2,
        matches: [
          { name: "Alpha", group: "Sundry Debtors", balance: 500, drCr: "Dr" },
          { name: "Beta", group: "Sundry Debtors", balance: 300, drCr: "Dr" },
        ],
      }),
    }),
  );
  assert.equal(result.diagnostics.routeDecider, "qwen_plan");
  assert.equal(result.diagnostics.chosenTool, "acc_ledger_balance");
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.match(result.reply, /Largest 2 Sundry Debtors ledgers/);
  assert.match(result.reply, /1\. Alpha/);
});

test("a typed all-ledger plan ranks only the requested debit or credit side", async () => {
  const { fetchImpl } = jevReturning({ unsupported: 0.96, acc_ledger_balance: 0.02, clarify: 0.02 });
  let received;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "top five ledgers with credit balance" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      planAccountingQuestion: async () => ({
        status: "ok", tool: "acc_ledger_balance", latencyMs: 5,
        arguments: {
          ledgerMode: "all", ledgerName: null, groupName: null, balanceSide: "cr", ranking: "largest", limit: 5,
        },
      }),
      lookupLedgerRanking: async (args) => {
        received = args;
        return {
          found: true, fuzzy: false, totalMatched: 2,
          matches: [
            { name: "Creditor A", group: "Sundry Creditors", balance: 900, drCr: "Cr" },
            { name: "Creditor B", group: "Sundry Creditors", balance: 700, drCr: "Cr" },
          ],
        };
      },
    }),
  );
  assert.deepEqual(received, { balanceSide: "cr", ranking: "largest", limit: 5 });
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.match(result.reply, /Largest 2 credit-balance ledgers/);
});

test("a structurally incomplete ledger balance is never stated as reliable", async () => {
  const result = await answerLedgerBalance({
    message: "balance of Salary Payable",
    resolvedArguments: {
      ledgerMode: "single", ledgerName: "Salary Payable", groupName: null,
      balanceSide: "any", ranking: "none", limit: 1,
    },
    lookupLedger: async () => LEDGER({
      matches: [{
        name: "Salary Payable", group: "Provisions", balance: 2821068, drCr: "Dr",
        reconciliation: {
          status: "source_incomplete", storedSigned: -37822, calculatedSigned: 2821068,
          reason: "missing_normal_credit",
        },
      }],
    }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date("2026-09-27T07:00:00Z"),
  });
  assert.equal(result.outcome, OUTCOME.CLARIFY);
  assert.equal(result.reason, "ledger_balance_unreconciled");
  assert.match(result.reply, /missing opening|normal-side/i);
  assert.doesNotMatch(result.reply, /28,21,068|37,822/);
});

test("a stale ledger cache does not suppress a complete posted-voucher balance", async () => {
  const result = await answerLedgerBalance({
    message: "cb of debidutt mangilal",
    resolvedArguments: {
      ledgerMode: "single", ledgerName: "Debidutt Mangilal", groupName: null,
      balanceSide: "any", ranking: "none", limit: 1,
    },
    lookupLedger: async () => LEDGER({
      uniqueNamedMatch: true,
      matches: [{
        name: "Debidutt Mangilall", group: "Sundry Creditors", balance: 1899243, drCr: "Cr",
        reconciliation: { status: "cache_stale", storedSigned: 1233275, calculatedSigned: -1899243 },
      }],
    }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date("2026-09-27T07:00:00Z"),
  });
  assert.equal(result.outcome, OUTCOME.ANSWERED);
  assert.match(result.reply, /^Debidutt Mangilall \(Sundry Creditors\): ₹18,99,243\.00 Cr/);
});

test("an over-broad model plan is narrowed when the current words uniquely ground one ledger", async () => {
  let rankingReads = 0;
  const exact = LEDGER({
    uniqueNamedMatch: true,
    matches: [{ name: "Debidutt Mangilall", group: "Sundry Creditors", balance: 1899243, drCr: "Cr" }],
  });
  const result = await executeAccountingTool({
    tool: "acc_ledger_balance",
    message: "cb of debidutt mangilal",
    resolvedArguments: {
      ledgerMode: "all", ledgerName: null, groupName: null,
      balanceSide: "dr", ranking: "largest", limit: 5,
    },
    now: new Date("2026-09-27T07:00:00Z"),
    user: ACCOUNTANT,
    deps: {
      lookupLedger: async () => exact,
      lookupLedgerRanking: async () => { rankingReads += 1; return exact; },
      companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    },
  });
  assert.equal(result.outcome, OUTCOME.ANSWERED);
  assert.equal(rankingReads, 0);
  assert.match(result.reply, /^Debidutt Mangilall \(Sundry Creditors\): ₹18,99,243\.00 Cr/);
  assert.doesNotMatch(result.reply, /Largest/);
});

test("a financial metric answer contains only the requested accounting figure", () => {
  const financials = {
    available: true,
    baseCurrency: "INR",
    financialYear: "2026-27",
    profitAndLoss: {
      totalRevenue: 6538193,
      totalExpenses: 614204,
      directRevenue: 6400000,
      directExpenses: 500000,
      grossProfit: 5900000,
      grossProfitMargin: 92.19,
      netProfit: 5923989,
      netProfitMargin: 90.61,
    },
    balanceSheet: { totalAssets: 21567511, totalLiabilities: 4301502, equity: 0 },
    readable: "full summary must not leak into a metric answer",
  };
  const result = answerFinancialMetric({
    financials,
    metric: "expenses",
    now: new Date("2026-09-27T08:40:16.909Z"),
  });
  assert.equal(result.outcome, OUTCOME.ANSWERED);
  assert.equal(result.reply, "Total expenses for FY 2026-27: ₹6,14,204.00.");
  assert.doesNotMatch(result.reply, /revenue|profit|assets|liabilities/i);
  assert.deepEqual(result.evidence.metric, "expenses");
  assert.deepEqual(result.evidence.value, 614204);
});

test("a confident financial route still selects a closed metric before reading", async () => {
  const { fetchImpl } = jevReturning({ acc_financials: 0.95, clarify: 0.03, unsupported: 0.02 });
  let interpreted = 0;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "expenses for this yr" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      interpretArguments: async ({ tool }) => {
        interpreted += 1;
        assert.equal(tool, "acc_financials");
        return { status: "ok", arguments: { metric: "expenses" }, latencyMs: 2, model: "qwen-test" };
      },
      financials: async () => ({
        available: true,
        baseCurrency: "INR",
        financialYear: "2026-27",
        profitAndLoss: { totalExpenses: 614204 },
        balanceSheet: {},
      }),
    }),
  );
  assert.equal(interpreted, 1);
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.equal(result.reply, "Total expenses for FY 2026-27: ₹6,14,204.00.");
});

test("a closing-balance ranking refuses any unreconciled member", async () => {
  const result = await answerLedgerBalance({
    message: "top debit balances",
    resolvedArguments: {
      ledgerMode: "all", ledgerName: null, groupName: null,
      balanceSide: "dr", ranking: "largest", limit: 5,
    },
    lookupLedger: async () => LEDGER({
      totalMatched: 2,
      matches: [
        { name: "Safe", balance: 100, drCr: "Dr", reconciliation: { status: "reconciled" } },
        { name: "Incomplete", balance: 90, drCr: "Dr", reconciliation: { status: "source_incomplete" } },
      ],
    }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date("2026-09-27T07:00:00Z"),
  });
  assert.equal(result.outcome, OUTCOME.CLARIFY);
  assert.equal(result.reason, "ledger_ranking_unreconciled");
  assert.match(result.reply, /will not rank incomplete figures/i);
});

test("Qwen resolves language arguments only after the deterministic read asks for clarification", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  const reads = [];
  let interpreted = null;
  const result = await runAccountsPilot(
    {
      user: ACCOUNTANT,
      message: "tell me cb of debidutt mangilal",
      history: [{ role: "user", content: "we were discussing Debidutt Mangilall" }],
    },
    CASCADE_CFG,
    deps({
      fetchImpl,
      lookupLedger: async ({ query }) => {
        reads.push(query);
        return query === "Debidutt Mangilall"
          ? LEDGER({ matches: [{ name: "Debidutt Mangilall", group: "Sundry Creditors", balance: 1899243, drCr: "Cr" }] })
          : { found: false };
      },
      interpretArguments: async (input) => {
        interpreted = input;
        return { status: "ok", arguments: { ledgerName: "Debidutt Mangilall" }, latencyMs: 9, model: "qwen-test" };
      },
    }),
  );
  assert.deepEqual(reads, ["tell me cb of debidutt mangilal", "Debidutt Mangilall"]);
  assert.equal(interpreted.tool, "acc_ledger_balance");
  assert.equal(interpreted.history.length, 1);
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.equal(result.diagnostics.routeDecider, "jev");
  assert.equal(result.diagnostics.qwenArgumentsInvoked, true);
  assert.equal(result.diagnostics.qwenArgumentsStatus, "ok");
  assert.match(result.reply, /Debidutt Mangilall/);
  assert.match(result.reply, /₹18,99,243\.00 Cr/);
});

test("an invalid Qwen argument response cannot turn a clarification into a guessed read", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  let reads = 0;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "show his balance" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      lookupLedger: async () => { reads += 1; return { found: false }; },
      interpretArguments: async () => ({ status: "invalid", reason: "arguments_failed_validation", latencyMs: 2 }),
    }),
  );
  assert.equal(reads, 1);
  assert.equal(result.diagnostics.result, RESULT.CLARIFIED);
  assert.equal(result.diagnostics.qwenArgumentsStatus, "invalid");
  assert.match(result.reply, /exact ledger name/i);
});

test("permission is checked again before a Qwen-normalised retry", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  let permissionChecks = 0;
  let reads = 0;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "show his balance" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      reauthorise: async () => { permissionChecks += 1; return permissionChecks === 1; },
      lookupLedger: async () => { reads += 1; return { found: false }; },
      interpretArguments: async () => ({ status: "ok", arguments: { ledgerName: "Ariel Fabrics" }, latencyMs: 2 }),
    }),
  );
  assert.equal(permissionChecks, 2);
  assert.equal(reads, 1);
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(result.diagnostics.resultReason, "reauthorisation_denied_before_retry");
});

test("Qwen reviews only an uncertain Jev route and GRAV still executes the read", async () => {
  const { fetchImpl } = jevReturning({ acc_financials: 0.45, acc_vouchers: 0.40, clarify: 0.15 });
  let reviewed = null;
  let read = false;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "top five biggest vouchers" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      reviewRoute: async (input) => {
        reviewed = input;
        return { status: "ok", choice: "acc_vouchers", latencyMs: 12, model: "qwen-test" };
      },
      buildVouchers: async () => {
        read = true;
        return { filterType: "all", summary: [{ type: "sales", count: 1, total: 10 }], recent: [], largest: [] };
      },
      voucherAliases: require("../../services/accountingContext").VOUCHER_ALIASES,
    }),
  );
  assert.equal(read, true);
  assert.equal(result.diagnostics.result, RESULT.ANSWERED);
  assert.equal(result.diagnostics.routeDecider, "qwen_review");
  assert.equal(result.diagnostics.qwenInvoked, true);
  assert.equal(result.diagnostics.qwenChoice, "acc_vouchers");
  assert.equal(reviewed.question, "top five biggest vouchers");
  assert.deepEqual(Object.keys(reviewed.candidates),
    ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company", "acc_party_reports", "acc_report_query", "clarify", "unsupported"]);
});

test("an invalid Qwen choice reads nothing and cannot escape the offered list", async () => {
  const { fetchImpl } = jevReturning({ acc_financials: 0.45, clarify: 0.40, unsupported: 0.15 });
  let read = false;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "do something" },
    CASCADE_CFG,
    deps({
      fetchImpl,
      reviewRoute: async () => ({ status: "ok", choice: "admin_delete_everything", latencyMs: 1 }),
      financials: async () => { read = true; return {}; },
    }),
  );
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(read, false);
});

test("pure Jev mode still refuses low confidence without calling Qwen", async () => {
  const { fetchImpl } = jevReturning({ acc_financials: 0.45, acc_vouchers: 0.40, clarify: 0.15 });
  let reviews = 0;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "accounts question" }, CFG,
    deps({ fetchImpl, reviewRoute: async () => { reviews += 1; return { status: "ok", choice: "acc_financials" }; } }),
  );
  assert.equal(result.diagnostics.resultReason, "below_threshold");
  assert.match(result.reply, /no fallback model/i);
  assert.equal(reviews, 0);
});

/* ── PROOF 1: Jev cannot reach MongoDB ──────────────────────────────────── */

test("the model is sent the question and safe descriptions, and nothing else", async () => {
  const { fetchImpl, calls } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  await runAccountsPilot(
    { user: ACCOUNTANT, message: "What is the balance of Ariel Fabrics?" },
    CFG,
    deps({ fetchImpl }),
  );

  assert.equal(calls.length, 1);
  const wire = JSON.stringify(calls[0].sentBody);

  // The question itself goes, verbatim — that is the point, and its words are
  // the user's own. Nothing from the RECORDS goes: the read has not happened
  // yet when the model is called, which is what this pins.
  assert.ok(wire.includes("What is the balance of Ariel Fabrics?"));
  for (const leaked of ["Sundry Debtors", "1234567", "Test Co", "u1", "INR", "Dr"]) {
    assert.ok(!wire.includes(leaked), `"${leaked}" comes from the records and must not be sent`);
  }
  // Nor any way to go and get it.
  for (const handle of ["mongodb://", "mongodb+srv", "collection", "acc_ledgers",
                        "aggregate", "$match", "find(", "_id", "token", "Authorization"]) {
    assert.ok(!wire.toLowerCase().includes(handle.toLowerCase()),
      `"${handle}" must not be sent to the model`);
  }
});

test("no module on the model's path can reach the database", () => {
  // The client, the router and the candidate builder are the only code the
  // model's answer flows through before GRAV's own permission check. None of
  // them requires a database, a model, or the accounting context.
  for (const file of ["services/ai/openJev/openJevClient.js",
                      "services/ai/openJev/accountsCandidates.js"]) {
    const src = read(file).toLowerCase();
    for (const name of ["mongodb", "mongoose", "accountingcontext", "col(", "ollama", "gemini"]) {
      assert.ok(!src.includes(name), `${file} must not touch ${name}`);
    }
  }
});

/* ── PROOF 2: Jev cannot execute a tool it was not offered ──────────────── */

test("a tool GRAV never offered is refused, whatever its probability", async () => {
  let readAttempted = false;
  // A hostile model: it names `hr_employee`, which this user IS authorised for
  // and which IS registered — it is simply not an accounting tool, so the
  // Accounts pilot never offered it.
  const { fetchImpl } = jevReturning({}, {
    rawChoice: "hr_employee",
    rawProbabilities: { hr_employee: 0.99, clarify: 0.01 },
  });

  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "is Priya in today" },
    CFG,
    deps({ fetchImpl, lookupLedger: async () => { readAttempted = true; return LEDGER(); } }),
  );

  assert.equal(result.diagnostics.candidatesOffered.includes("hr_employee"), false);
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(result.reply, NO_ROUTE_REPLY);
  assert.equal(readAttempted, false, "nothing was read");
  // Refused at the FIRST of two independent gates: the client validates the
  // choice against the candidates GRAV sent, before the pilot's own check ever
  // sees it. Both exist on purpose.
  assert.equal(result.diagnostics.jevStatus, "invalid");
});

test("an invented tool name is refused", async () => {
  const { fetchImpl } = jevReturning({}, {
    rawChoice: "acc_delete_everything",
    rawProbabilities: { acc_delete_everything: 0.99, clarify: 0.01 },
  });
  const result = await runAccountsPilot({ user: ACCOUNTANT, message: "x" }, CFG, deps({ fetchImpl }));
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(result.toolsUsed.length, 0);
});

test("the pilot's own offered-name check is a real second gate", async () => {
  // Proved independently of the client, by handing the pilot a route the client
  // would never have passed. If the client's validation were ever loosened,
  // this is what still refuses it.
  const { runAccountsPilot: run } = require("../../services/ai/openJev/accountsPilot");
  const src = read("services/ai/openJev/accountsPilot.js");
  assert.match(src, /if \(!offered\.includes\(chosen\)\) \{/);
  assert.match(src, /chose_unoffered_candidate/);
  assert.equal(typeof run, "function");
});

/* ── PROOF 3: Jev cannot widen an accounting permission ─────────────────── */

test("a user with no accounting access is offered no accounting candidate", () => {
  const { candidates, toolNames, offered } = accountsCandidates(OUTSIDER, { listTools });
  assert.deepEqual(toolNames, []);
  assert.deepEqual(offered, [CLARIFY, UNSUPPORTED]);
  for (const name of Object.keys(candidates)) {
    assert.ok(!name.startsWith("acc_"), `${name} must not be offered`);
  }
});

test("an unauthorised user is never routed into a read, at any probability", async () => {
  let readAttempted = false;
  const { fetchImpl, calls } = jevReturning({ acc_ledger_balance: 1 });
  const result = await runAccountsPilot(
    { user: OUTSIDER, message: "What is the balance of Ariel Fabrics?" },
    CFG,
    deps({ fetchImpl, lookupLedger: async () => { readAttempted = true; return LEDGER(); } }),
  );

  // The pilot does not cover this user at all: it returns null and the ordinary
  // assistant handles them, exactly as before the pilot existed.
  assert.equal(result, null);
  assert.equal(calls.length, 0, "the model is not even asked");
  assert.equal(readAttempted, false);
});

test("permission is checked AGAIN after the model answers", async () => {
  // Step 1 offered the tool; between then and the read, the permission goes
  // away. The re-check is what catches it, and it asks the registry rather than
  // trusting the candidate list.
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  let readAttempted = false;
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "balance of Ariel Fabrics" },
    CFG,
    deps({
      fetchImpl,
      reauthorise: async () => false,
      lookupLedger: async () => { readAttempted = true; return LEDGER(); },
    }),
  );
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(result.diagnostics.resultReason, "reauthorisation_denied");
  assert.equal(readAttempted, false);
});

test("the re-check consults the tool's own permission, not a copy of the rule", () => {
  const src = read("services/ai/openJev/accountsPilot.js");
  assert.match(src, /const \{ getTool \} = require\("\.\.\/toolRegistry"\)/);
  assert.match(src, /tool\.permission\(user\) === true/);
  // A throwing permission check is a denial.
  assert.match(src, /} catch \{\s*return false;/);
});

/* ── PROOF 4: Jev cannot write ──────────────────────────────────────────── */

test("every executor path is a read, and a write request is refused by routing", async () => {
  const src = read("services/ai/openJev/accountsPilot.js");
  // The only accounting calls are context BUILDERS, all read-only.
  const calls = [...src.matchAll(/ctx\(\)\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(calls)].sort(),
    ["buildCompanyInfo", "buildFinancials", "buildLedgerLookup", "buildLedgerRanking", "buildPartyReport"]);
  for (const verb of ["insert", "update", "delete", "save(", "create(", "findOneAnd",
                      "bulkWrite", "$set", "deleteMany", "updateOne"]) {
    assert.ok(!src.toLowerCase().includes(verb.toLowerCase()), `${verb} must not appear`);
  }

  // And a user asking for a write gets routed to unsupported, not to a read.
  const { fetchImpl } = jevReturning({ unsupported: 0.97, clarify: 0.02, acc_ledger_balance: 0.01 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "create a journal entry for 500" }, CFG, deps({ fetchImpl }),
  );
  assert.equal(result.diagnostics.result, RESULT.UNSUPPORTED);
});

/* ── No silent fallback ─────────────────────────────────────────────────── */

test("Jev unreachable, slow or invalid all say so, and answer nothing", async () => {
  const cases = [
    ["unreachable", { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }],
    ["non-2xx", jevReturning({}, { status: 503 })],
    ["invalid body", jevReturning({}, { body: { nonsense: true } })],
  ];
  for (const [label, seam] of cases) {
    const result = await runAccountsPilot(
      { user: ACCOUNTANT, message: "balance of Ariel Fabrics" },
      CFG,
      deps({ fetchImpl: seam.fetchImpl }),
    );
    assert.equal(result.diagnostics.result, RESULT.FAILED, label);
    assert.equal(result.reply, NO_ROUTE_REPLY, label);
    assert.match(result.reply, /Jev could not confidently route this question/, label);
  }
});

test("a low-confidence route is refused rather than rescued", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.5, acc_financials: 0.45, clarify: 0.05 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "balance" }, CFG, deps({ fetchImpl }),
  );
  assert.equal(result.diagnostics.result, RESULT.FAILED);
  assert.equal(result.diagnostics.resultReason, "below_threshold");
  // The probability and margin are still recorded — that is the measurement.
  assert.equal(result.diagnostics.probability, 0.5);
  assert.ok(Math.abs(result.diagnostics.margin - 0.05) < 1e-9);
});

test("the pilot's own modules contain no regex router and no second model", () => {
  for (const file of ["services/ai/openJev/accountsPilot.js",
                      "services/ai/openJev/ledgerAnswer.js",
                      "services/ai/openJev/accountsCandidates.js"]) {
    const src = read(file);
    for (const forbidden of ["ollamaClient", "chatWithTools", "relevantTools",
                             "gemini", "GoogleGenerativeAI", "@google/genai"]) {
      assert.ok(!src.includes(forbidden), `${file} must not use ${forbidden}`);
    }
  }
});

/* ── The ledger answer ──────────────────────────────────────────────────── */

const { cleanLedger, preferExactLedgerName } = require("../../services/accountingContext");

test("ledger command abbreviations are removed without weakening the party name", () => {
  for (const phrase of [
    "blnce of Mayfair Lagoon",
    "Mayfair Lagoon blnc",
    "bal Mayfair Lagoon",
    "balnce of Mayfair Lagoon",
    "cb of Mayfair Lagoon",
    "C.B. of Mayfair Lagoon",
    "closing balance of Mayfair Lagoon",
  ]) {
    assert.equal(cleanLedger(phrase).toLowerCase(), "mayfair lagoon", phrase);
  }
});

test("an exact normalized ledger name wins over broader name matches", () => {
  const candidates = [
    { name: "MAYFAIR OASIS RESORT AND CONVENTION" },
    { name: "MAYFAIR Lagoon" },
    { name: "Mayfair Lagoon Annex" },
  ];
  assert.deepEqual(preferExactLedgerName("mayfair lagoon", candidates), [candidates[1]]);
  assert.deepEqual(
    preferExactLedgerName("A and B Traders", [{ name: "A & B Traders" }, { name: "A & B Traders Unit 2" }]),
    [{ name: "A & B Traders" }],
  );
});

test("an answer carries the matched name, amount, currency, Dr/Cr and time", async () => {
  const r = await answerLedgerBalance({
    message: "ariel fabrics balance",
    lookupLedger: async () => LEDGER(),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date("2026-09-25T03:50:00Z"),
  });
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.match(r.reply, /Ariel Fabrics/, "the EXACT matched ledger name");
  assert.match(r.reply, /₹12,34,567\.89/, "the exact amount, Indian-grouped");
  assert.match(r.reply, /\bDr\b/);
  assert.match(r.reply, /as at 25 Sept 2026, 09:20 IST/);
  assert.equal(r.evidence.currency, "INR");
  assert.equal(r.evidence.basis, "posted vouchers");
});

test("the original question goes to the resolver unchanged", async () => {
  let seen = null;
  await answerLedgerBalance({
    message: "  Ariel Fabrics ka balance kitna hai  ",
    lookupLedger: async (args) => { seen = args; return LEDGER(); },
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date(),
  });
  // Both fields, as the existing tool passes them: the resolver does its own
  // mishearing repair and proper-noun extraction, and a paraphrase of ours
  // would only lose signal.
  assert.equal(seen.query, "  Ariel Fabrics ka balance kitna hai  ");
  assert.equal(seen.hint, "  Ariel Fabrics ka balance kitna hai  ");
});

test("a genuine zero is an answer, not a missing account", async () => {
  const r = await answerLedgerBalance({
    message: "petty cash unit 2",
    lookupLedger: async () => LEDGER({ matches: [{ name: "Petty Cash Unit 2", group: "Cash-in-Hand", balance: 0, drCr: "Cr" }] }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date("2026-09-25T03:50:00Z"),
  });
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.match(r.reply, /₹0\.00 Cr/);
  assert.equal(r.evidence.amount, 0);
});

test("a fuzzy match is asked about, never answered from", async () => {
  const r = await answerLedgerBalance({
    message: "Ariel Fabrcs balnce",
    lookupLedger: async () => LEDGER({
      fuzzy: true, totalMatched: 2,
      matches: [{ name: "Ariel Fabrics", group: "Sundry Debtors", balance: 10 },
                { name: "Ariel Fabrications", group: "Sundry Debtors", balance: 20 }],
    }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date(),
  });
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "ledger_fuzzy");
  // Both candidates are named; neither is chosen.
  assert.match(r.reply, /Ariel Fabrics \(Sundry Debtors\)/);
  assert.match(r.reply, /Ariel Fabrications/);
  assert.ok(!/₹/.test(r.reply), "no balance is stated for a guess");
});

test("a group, or several matches, is asked about rather than summed", async () => {
  const r = await answerLedgerBalance({
    message: "sundry debtors balance",
    lookupLedger: async () => LEDGER({
      totalMatched: 12,
      matches: [{ name: "A Ltd", group: "Sundry Debtors", balance: 3 },
                { name: "B Ltd", group: "Sundry Debtors", balance: 2 }],
    }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date(),
  });
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "ledger_ambiguous");
  assert.match(r.reply, /matched 12 accounts/);
});

test("an unknown ledger asks for the exact name", async () => {
  const r = await answerLedgerBalance({
    message: "balance of Thornfield Mills",
    lookupLedger: async () => ({ found: false, query: "Thornfield Mills" }),
    companyProfile: async () => ({ available: true, baseCurrency: "INR" }),
    now: new Date(),
  });
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "ledger_not_found");
  assert.match(r.reply, /exact ledger name/);
});

test("a figure is never reported without its unit", async () => {
  for (const profile of [{ available: false }, { available: true, baseCurrency: null }, null]) {
    const r = await answerLedgerBalance({
      message: "x", lookupLedger: async () => LEDGER(),
      companyProfile: async () => profile, now: new Date(),
    });
    assert.equal(r.outcome, OUTCOME.FAILED);
    assert.equal(r.reason, "currency_unknown");
  }
});

test("a non-INR company is not reported in rupees", async () => {
  const r = await answerLedgerBalance({
    message: "x",
    lookupLedger: async () => LEDGER({ matches: [{ name: "Acme Inc", group: "Sundry Debtors", balance: 1000, drCr: "Dr" }] }),
    companyProfile: async () => ({ available: true, baseCurrency: "USD" }),
    now: new Date(),
  });
  assert.match(r.reply, /1,000\.00 USD Dr/);
  assert.ok(!r.reply.includes("₹"));
});

/* ── Diagnostics ────────────────────────────────────────────────────────── */

test("the diagnostics carry everything the panel is specified to show", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "balance of Ariel Fabrics" }, CFG, deps({ fetchImpl }),
  );
  const d = result.diagnostics;

  assert.deepEqual(d.candidatesOffered,
    ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company", "acc_party_reports", "acc_report_query", CLARIFY, UNSUPPORTED]);
  assert.equal(d.chosenTool, "acc_ledger_balance");
  assert.equal(d.probability, 0.95);
  assert.ok(Math.abs(d.margin - 0.92) < 1e-9);
  assert.equal(typeof d.jevLatencyMs, "number");
  assert.equal(typeof d.accountingReadLatencyMs, "number");
  assert.equal(typeof d.totalLatencyMs, "number");
  assert.equal(d.result, RESULT.ANSWERED);
  // Every ending the panel distinguishes.
  assert.deepEqual(Object.values(RESULT).sort(),
    ["answered", "clarified", "failed", "unsupported"]);
});

test("diagnostics carry no accounting data and no question", async () => {
  const { fetchImpl } = jevReturning({ acc_ledger_balance: 0.95, clarify: 0.03, unsupported: 0.02 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "balance of Ariel Fabrics" }, CFG, deps({ fetchImpl }),
  );
  const wire = JSON.stringify(result.diagnostics);
  for (const leaked of ["Ariel Fabrics", "Sundry Debtors", "1234567", "balance of"]) {
    assert.ok(!wire.includes(leaked), `"${leaked}" must not be in diagnostics`);
  }
});

test("ordinary users never receive the diagnostics in production", () => {
  assert.equal(maySeePilotDiagnostics({ isAdmin: false }, { NODE_ENV: "production" }), false);
  assert.equal(maySeePilotDiagnostics({ isAdmin: true }, { NODE_ENV: "production" }), true);
  assert.equal(maySeePilotDiagnostics({ isAdmin: false }, { NODE_ENV: "development" }), true);
  const route = read("routes/ai/assistant.js");
  assert.match(route, /pilotDiagnostics && maySeePilotDiagnostics\(user\)/);
});

/* ── The evaluation set ─────────────────────────────────────────────────── */

test("the evaluation set covers every family the pilot is judged on", () => {
  const set = JSON.parse(read("scripts/open-jev-pilot/accounts-cases.json"));
  const families = new Set(set.cases.map((c) => c.family));
  for (const required of ["natural-english", "hinglish", "abbreviation", "misspelling",
                          "ambiguous-ledger", "unknown-ledger", "group-vs-ledger",
                          "unauthorised", "zero-balance", "dr-cr", "jev-outage"]) {
    assert.ok(families.has(required), `the set must cover ${required}`);
  }
  assert.ok(set.cases.length >= 30);
});

test("no real business name, identifier or amount is stored in the fixtures", () => {
  const raw = read("scripts/open-jev-pilot/accounts-cases.json");
  // A GSTIN, a PAN, or a long digit run would each be a real-world identifier.
  assert.ok(!/\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z\d]\b/.test(raw), "no GSTIN");
  assert.ok(!/\b[A-Z]{5}\d{4}[A-Z]\b/.test(raw), "no PAN");
  assert.ok(!/\b\d[\d,]{5,}\b/.test(raw), "no amount-shaped figure");
  const set = JSON.parse(raw);
  assert.match(set.note, /invented/);
});

test("every case names a family, an expectation and an outcome", () => {
  const set = JSON.parse(read("scripts/open-jev-pilot/accounts-cases.json"));
  const outcomes = new Set(["answered", "clarified", "unsupported", "failed", "no_pilot"]);
  for (const c of set.cases) {
    assert.ok(c.id && c.question && c.family, `${c.id}: incomplete`);
    assert.ok(outcomes.has(c.outcome), `${c.id}: unknown outcome ${c.outcome}`);
    assert.ok(set.actors[c.actor], `${c.id}: unknown actor`);
  }
});

/* ── The candidate list is derived, not duplicated ──────────────────────── */

test("candidates come from the registry, with no second description list", () => {
  const src = read("services/ai/openJev/accountsCandidates.js");
  assert.match(src, /const \{ authorizedTools \} = require\("\.\.\/toolRegistry"\)/);
  // EXECUTABLE holds NAMES only — no descriptions, no permissions, no matchers.
  assert.deepEqual([...EXECUTABLE],
    ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company", "acc_party_reports", "acc_report_query"]);
  const block = src.slice(src.indexOf("const EXECUTABLE"), src.indexOf("const MAX_DESCRIPTION"));
  assert.ok(!/description|permission|matches/.test(block.replace(/\/\*[\s\S]*?\*\//g, "")));
});

test("a description that starts to look like data is trimmed", () => {
  const { candidates } = accountsCandidates(ACCOUNTANT, {
    listTools: () => [{
      name: "acc_company", permission: accAuthorised,
      description: "The company profile. For example GSTIN 29ABCDE1234F1Z5 and balance 1,23,45,678.",
    }],
  });
  assert.equal(candidates.acc_company, "The company profile.");
});

/* ── The voucher executor ───────────────────────────────────────────────── */

const { answerVouchers, resolveRange, resolveListRequest } = require("../../services/ai/openJev/voucherAnswer");
const { VOUCHER_ALIASES } = require("../../services/accountingContext");

const VOUCHERS = (over = {}) => ({
  filterType: "sales",
  summary: [{ type: "Sales", count: 4, total: 480000 }],
  recent: [{ type: "Sales", number: "S-1004", date: "2026-06-28", amount: 150000, party: "Ariel Fabrics" }],
  largest: [{ type: "Sales", number: "S-1002", date: "2026-05-11", amount: 210000, party: "Ariel Fabrics" }],
  readable: "…",
  ...over,
});

const vouchers = (over, message = "how many sales") =>
  answerVouchers({
    message,
    buildVouchers: typeof over === "function" ? over : async () => VOUCHERS(over),
    aliases: VOUCHER_ALIASES,
    now: new Date("2026-09-25T04:00:00Z"),
  });

test("read-only accounting capabilities are offered dynamically from the registry", () => {
  const { toolNames, offered } = accountsCandidates(ACCOUNTANT, { listTools });
  assert.deepEqual(toolNames, ["acc_ledger_balance", "acc_financials", "acc_vouchers", "acc_company", "acc_party_reports", "acc_report_query"]);
  // Stable order, so two evaluation runs of the same model are comparable.
  assert.deepEqual(offered, [...toolNames, CLARIFY, UNSUPPORTED]);
  assert.deepEqual([...EXECUTABLE], toolNames);
});

test("a voucher question is counted and totalled by the EXISTING service", async () => {
  let asked = null;
  const r = await vouchers(async (args) => { asked = args; return VOUCHERS(); });
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  // The message goes in whole: `normVoucherType` inside the service maps it,
  // exactly as it does for the ordinary assistant.
  assert.equal(asked.voucherType, "how many sales");
  assert.match(r.reply, /4 sales vouchers/);
  assert.match(r.reply, /₹4,80,000/);
  assert.equal(r.evidence.schema, "grav.acc.vouchers.evidence/1");
  assert.equal(r.evidence.voucherCount, 4);
  assert.equal(r.evidence.basis, "posted vouchers");
});

test("the pilot performs no accounting arithmetic of its own", () => {
  const src = read("services/ai/openJev/voucherAnswer.js");
  // Totals come from the service's own per-type rows; the only arithmetic is
  // adding those rows up for a headline, which is not a second calculation of
  // the underlying figures.
  assert.match(src, /result\.summary\.reduce/);
  for (const forbidden of ["col(", "aggregate", "$group", "$match", "grandTotal",
                           "ledgerEntries", "mongodb", "mongoose"]) {
    assert.ok(!src.includes(forbidden), `${forbidden} must not appear`);
  }
});

test("an explicit written-out date range is passed through", async () => {
  let asked = null;
  const r = await vouchers(
    async (args) => { asked = args; return VOUCHERS(); },
    "sales from 2026-04-01 to 2026-06-30",
  );
  assert.equal(asked.from, "2026-04-01");
  assert.equal(asked.to, "2026-06-30");
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.match(r.reply, /between 2026-04-01 and 2026-06-30/);
  assert.equal(r.evidence.from, "2026-04-01");
});

test("a single written-out date is that day", async () => {
  let asked = null;
  await vouchers(async (args) => { asked = args; return VOUCHERS(); }, "vouchers on 2026-04-01");
  assert.equal(asked.from, "2026-04-01");
  assert.equal(asked.to, "2026-04-01");
});

test("a full natural-language calendar date is deterministic and does not depend on model extraction", async () => {
  const calls = [];
  const result = await require("../../services/ai/openJev/voucherAnswer").answerVouchers({
    message: "any vouchers on date 4 June 2026",
    resolvedArguments: { voucherType: "all", partyName: null, from: null, to: null, ranking: "none", limit: 10 },
    buildVouchers: async (args) => { calls.push(args); return { summary: [], recent: [], largest: [], filterType: "all" }; },
    resolveLedger: async () => ({ found: false, matches: [] }),
    aliases: {},
    now: new Date("2026-09-27T00:00:00Z"),
  });
  assert.equal(result.outcome, "answered");
  assert.deepEqual(calls[0], { voucherType: undefined, partyName: null, from: "2026-06-04", to: "2026-06-04" });
  assert.match(result.reply, /2026-06-04/);
});

test("typed voucher detail mode lists the matching rows without phrase-specific execution rules", async () => {
  const result = await require("../../services/ai/openJev/voucherAnswer").answerVouchers({
    message: "expand the result",
    resolvedArguments: {
      voucherType: "all", partyName: null, from: "2026-06-04", to: "2026-06-04", ranking: "none", limit: 10, view: "details",
    },
    buildVouchers: async () => ({
      filterType: "all", filterParty: null,
      summary: [{ type: "payment", count: 2, total: 1510 }, { type: "purchase", count: 1, total: 5658 }],
      recent: [
        { type: "payment", number: "P-2", date: "2026-06-04", amount: 700 },
        { type: "payment", number: "P-1", date: "2026-06-04", amount: 810 },
        { type: "purchase", number: "B-1", date: "2026-06-04", amount: 5658 },
      ],
      largest: [],
    }),
    resolveLedger: async () => ({ found: false, matches: [] }), aliases: {}, now: new Date("2026-09-27T00:00:00Z"),
  });
  assert.equal(result.outcome, "answered");
  assert.match(result.reply, /Details:/);
  assert.match(result.reply, /payment P-2/);
  assert.match(result.reply, /purchase B-1/);
});

test("a vague period is asked about, never guessed", async () => {
  // Each needs a boundary neither this pilot nor the service defines: whose
  // month, whose quarter, calendar or financial year.
  for (const phrase of ["sales last month", "purchases this quarter", "payments this year",
                        "sales in the last 30 days", "receipts so far", "sales Q1",
                        "sales April 2026", "vouchers today", "payments yesterday"]) {
    let asked = null;
    const r = await vouchers(async (args) => { asked = args; return VOUCHERS(); }, phrase);
    assert.equal(r.outcome, OUTCOME.CLARIFY, phrase);
    assert.equal(r.reason, "date_range_ambiguous", phrase);
    assert.equal(asked, null, `${phrase}: nothing was read`);
    assert.match(r.reply, /2026-04-01 to 2026-06-30/, "it says what WOULD be accepted");
  }
});

test("a date that does not exist is a question, not an all-time answer", async () => {
  // Silently dropping "2026-02-30" and answering for all time would report a
  // number the user never asked for.
  for (const phrase of ["sales on 2026-02-30", "sales on 2026-13-01", "sales on 2026-4-1"]) {
    const r = await vouchers(undefined, phrase);
    assert.equal(r.outcome, OUTCOME.CLARIFY, phrase);
    assert.equal(r.reason, "date_range_ambiguous", phrase);
  }
});

test("no date at all is not ambiguous — it means all of them", async () => {
  let asked = null;
  const r = await vouchers(async (args) => { asked = args; return VOUCHERS(); }, "how many sales vouchers");
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.equal(asked.from, undefined);
  assert.equal(asked.to, undefined);
  assert.ok(!/between|on 20/.test(r.reply));
});

test("'recent' asks for a ranking, not a period", async () => {
  // `buildVouchers` returns the most recent entries with no date filter, so
  // there is no boundary to guess. Treating these as vague dates turned an
  // ordinary question with an exact answer into a clarification.
  for (const phrase of ["recent payments", "latest sales"]) {
    assert.equal(resolveRange(phrase).kind, "none", phrase);
  }
  const r = await vouchers(undefined, "recent sales");
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.match(r.reply, /Most recent: Sales S-1004 on 2026-06-28/);
});

test("'biggest' shows the largest, not the most recent", async () => {
  const r = await vouchers(undefined, "biggest sales invoice");
  assert.match(r.reply, /Largest: Sales S-1002/);
  assert.ok(!/Most recent/.test(r.reply));
});

test("'top five latest' means five newest vouchers, not three largest vouchers", async () => {
  const recent = Array.from({ length: 6 }, (_, i) => ({
    type: "Sales", number: `R-${i + 1}`, date: `2026-06-${String(28 - i).padStart(2, "0")}`, amount: 1000 + i,
  }));
  const largest = Array.from({ length: 6 }, (_, i) => ({
    type: "Sales", number: `L-${i + 1}`, date: "2026-05-01", amount: 9000 - i,
  }));
  const r = await vouchers({ recent, largest }, "top five vouchers latest");
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.match(r.reply, /Most recent:/);
  for (let i = 1; i <= 5; i++) assert.match(r.reply, new RegExp(`R-${i}\\b`));
  assert.doesNotMatch(r.reply, /R-6\b|Largest:|L-1\b/);
});

test("a typed party transaction request resolves one company ledger and filters the voucher read", async () => {
  let asked = null;
  const r = await answerVouchers({
    message: "last five transactions of debidutt mangilal",
    resolvedArguments: {
      voucherType: "all", partyName: "debidutt mangilal", from: null, to: null, ranking: "recent", limit: 5,
    },
    resolveLedger: async ({ query }) => {
      assert.equal(query, "debidutt mangilal");
      return { found: true, matches: [{ name: "Debidutt Mangilall", group: "Sundry Creditors" }] };
    },
    buildVouchers: async (args) => {
      asked = args;
      return VOUCHERS({ filterType: "all", filterParty: args.partyName });
    },
    aliases: VOUCHER_ALIASES,
    now: new Date("2026-09-25T04:00:00Z"),
  });
  assert.equal(r.outcome, OUTCOME.ANSWERED);
  assert.equal(asked.partyName, "Debidutt Mangilall");
  assert.equal(asked.voucherType, undefined);
  assert.match(r.reply, /5|Most recent/);
  assert.match(r.reply, /for Debidutt Mangilall/);
  assert.equal(r.evidence.filterParty, "Debidutt Mangilall");
});

test("an ambiguous party transaction request asks before reading vouchers", async () => {
  let read = false;
  const r = await answerVouchers({
    message: "latest transactions for Mayfair",
    resolvedArguments: {
      voucherType: "all", partyName: "Mayfair", from: null, to: null, ranking: "recent", limit: 5,
    },
    resolveLedger: async () => ({
      found: true,
      matches: [{ name: "MAYFAIR Lagoon" }, { name: "Mayfair Garden" }],
    }),
    buildVouchers: async () => { read = true; return VOUCHERS(); },
    aliases: VOUCHER_ALIASES,
    now: new Date("2026-09-25T04:00:00Z"),
  });
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "party_ambiguous");
  assert.equal(read, false);
  assert.match(r.reply, /MAYFAIR Lagoon/);
});

test("ranked voucher count and ordering are resolved independently", () => {
  assert.deepEqual(resolveListRequest("latest five vouchers"), { kind: "recent", limit: 5 });
  assert.deepEqual(resolveListRequest("largest five invoices"), { kind: "largest", limit: 5 });
  assert.deepEqual(resolveListRequest("top 10 vouchers by amount"), { kind: "largest", limit: 10 });
  assert.deepEqual(resolveListRequest("top 200 latest vouchers"), { kind: "recent", limit: 15 });
  assert.deepEqual(resolveListRequest("how many vouchers"), { kind: "none", limit: 0 });
});

test("conflicting voucher rankings are clarified before accounting is read", async () => {
  let read = false;
  const r = await vouchers(async () => { read = true; return VOUCHERS(); }, "latest five largest vouchers");
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "voucher_ranking_ambiguous");
  assert.equal(read, false);
  assert.match(r.reply, /newest vouchers, or the largest vouchers by amount/);
});

test("two voucher types in one question is asked about, not silently narrowed", async () => {
  // `normVoucherType` returns whichever appears first in its table, so this
  // would quietly become a sales-only answer.
  assert.equal(require("../../services/accountingContext").normVoucherType("sales and purchase totals"), "sales");
  let asked = null;
  const r = await vouchers(async (args) => { asked = args; return VOUCHERS(); }, "sales and purchase totals");
  assert.equal(r.outcome, OUTCOME.CLARIFY);
  assert.equal(r.reason, "voucher_type_ambiguous");
  assert.match(r.reply, /sales, purchase/);
  assert.equal(asked, null, "nothing was read");
});

test("a genuine zero is reported as none found, with the filter stated", async () => {
  const r = await vouchers({ summary: [], recent: [], largest: [], filterType: "payment" });
  assert.equal(r.outcome, OUTCOME.ANSWERED, "'there were none' is an answer");
  assert.match(r.reply, /No payment vouchers were recorded\./);
  assert.equal(r.evidence.voucherCount, 0);
  assert.equal(r.evidence.total, 0);
});

test("a zero within a range names the range", async () => {
  const r = await vouchers(
    { summary: [], recent: [], largest: [], filterType: "all" },
    "vouchers from 2026-04-01 to 2026-06-30",
  );
  assert.match(r.reply, /No vouchers were recorded between 2026-04-01 and 2026-06-30\./);
});

test("a failed or malformed voucher read is a failure, not an empty answer", async () => {
  const thrown = await vouchers(async () => { throw new Error("db"); });
  assert.equal(thrown.outcome, OUTCOME.FAILED);
  assert.equal(thrown.reason, "voucher_read_failed");
  // A body without the summary array would otherwise read as "no vouchers".
  const malformed = await vouchers(async () => ({ filterType: "all" }));
  assert.equal(malformed.outcome, OUTCOME.FAILED);
  assert.equal(malformed.reason, "voucher_read_invalid");
});

test("a voucher question is routed and read only for an authorised user", async () => {
  // The same gates as every other tool: offered from the registry, re-checked
  // after the model answers.
  const { fetchImpl } = jevReturning({ acc_vouchers: 0.95 });
  let readAttempted = false;
  const allowed = await runAccountsPilot(
    { user: ACCOUNTANT, message: "how many sales vouchers" }, CFG,
    deps({ fetchImpl, buildVouchers: async () => { readAttempted = true; return VOUCHERS(); },
           voucherAliases: VOUCHER_ALIASES }),
  );
  assert.equal(allowed.diagnostics.chosenTool, "acc_vouchers");
  assert.equal(allowed.diagnostics.result, RESULT.ANSWERED);
  assert.equal(readAttempted, true);

  readAttempted = false;
  const denied = await runAccountsPilot(
    { user: ACCOUNTANT, message: "how many sales vouchers" }, CFG,
    deps({ fetchImpl, reauthorise: async () => false,
           buildVouchers: async () => { readAttempted = true; return VOUCHERS(); } }),
  );
  assert.equal(denied.diagnostics.result, RESULT.FAILED);
  assert.equal(denied.diagnostics.resultReason, "reauthorisation_denied");
  assert.equal(readAttempted, false);

  // And an unauthorised user is never offered it at all.
  assert.equal(accountsCandidates(OUTSIDER, { listTools }).toolNames.includes("acc_vouchers"), false);
});

test("the voucher path writes nothing", () => {
  const src = read("services/ai/openJev/voucherAnswer.js");
  for (const verb of ["insert", "update", "delete", "save(", "create(", "findOneAnd",
                      "bulkWrite", "$set", "deleteMany", "updateOne", "drop("]) {
    assert.ok(!src.toLowerCase().includes(verb.toLowerCase()), `${verb} must not appear`);
  }
  // The only call out is the existing read service, handed in.
  assert.match(src, /await buildVouchers\(\{/);
});

test("voucher diagnostics and evidence carry no party name or question", async () => {
  const { fetchImpl } = jevReturning({ acc_vouchers: 0.95 });
  const result = await runAccountsPilot(
    { user: ACCOUNTANT, message: "how many sales for Ariel Fabrics" }, CFG,
    deps({ fetchImpl, buildVouchers: async () => VOUCHERS(), voucherAliases: VOUCHER_ALIASES }),
  );
  const wire = JSON.stringify(result.diagnostics);
  for (const leaked of ["Ariel Fabrics", "S-1004", "480000", "how many sales"]) {
    assert.ok(!wire.includes(leaked), `"${leaked}" must not be in diagnostics`);
  }
  // The evidence packet names types and totals, never a counterparty.
  assert.ok(!JSON.stringify(result.evidence || {}).includes("Ariel Fabrics"));
});
