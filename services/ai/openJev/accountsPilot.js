"use strict";
/**
 * services/ai/openJev/accountsPilot.js — the Accounts routing pilots.
 *
 * WHAT MAKES THIS MODE DIFFERENT. The HR pilot returns `null` whenever Jev is
 * unsure, and the existing Ollama round plus regex fallback answer instead.
 * That is right for production and useless for measurement: every question Jev
 * fumbles is quietly rescued, and the numbers we would publish would be the
 * fallback's. So in `jev_only_accounts` there is no rescue. A supported
 * accounting question is routed by Jev or it is not answered, and the user is
 * told which happened.
 *
 * ORDER OF AUTHORITY, which the tests pin:
 *
 *   1. GRAV decides what may be offered — `accountsCandidates` reads the tool
 *      registry's own permission checks for this user. Before any model runs.
 *   2. Jev picks one of the offered names. It is given the question and the
 *      tools' safe descriptions. It is given no ledger, no voucher, no balance,
 *      no internal id, no database handle and no way to execute anything.
 *   3. GRAV checks the pick is one it offered, RE-AUTHORISES independently of
 *      anything Jev returned, and then runs its own permission-gated read.
 *   4. GRAV writes the answer from what it read. No second model.
 *
 * The probability is recorded for evaluation. It is never shown to the user,
 * never treated as a fact, and never used to grant access: a 0.99 on a tool the
 * user was not offered is still refused at step 3.
 *
 * `jev_qwen_accounts` preserves that authority order. It changes only step 2:
 * a confident Jev decision stays on the fast path; otherwise a constrained
 * Qwen reviewer may choose one of the same already-offered names. It receives
 * no accounting records and GRAV still performs step 3 itself.
 */

const { chooseIntent, STATUS } = require("./openJevClient");
const { accountsCandidates, CLARIFY, UNSUPPORTED } = require("./accountsCandidates");
const { answerLedgerBalance, OUTCOME } = require("./ledgerAnswer");
const { answerVouchers } = require("./voucherAnswer");
const { answerPartyReport } = require("./partyReportAnswer");

const INSTRUCTIONS =
  "Classify the employee's question to a company accounting assistant. " +
  "Choose the single tool that would answer it, or clarify, or unsupported.";

/** What the diagnostics panel calls each ending. */
const RESULT = Object.freeze({
  ANSWERED: "answered",
  CLARIFIED: "clarified",
  UNSUPPORTED: "unsupported",
  FAILED: "failed",
});

/**
 * The message shown when Jev will not commit.
 *
 * Deliberately names Jev. In this mode the user is a developer or an evaluator,
 * and "I could not answer" would hide which component gave up.
 */
const NO_ROUTE_REPLY =
  "Jev could not confidently route this question. (Accounts pilot: no fallback model is used in this mode.)";

const CASCADE_NO_ROUTE_REPLY =
  "I could not confidently determine which accounting information you want. Please rephrase the question or name the account, voucher or report.";

const FAILED_REPLY =
  "Jev routed this question, but the accounting read did not complete. " +
  "(Accounts pilot: no fallback model is used in this mode.)";

const UNSUPPORTED_REPLY =
  "I cannot execute that request with the currently connected read-only accounting capabilities.";

/**
 * Run one question through the pilot.
 *
 * @param {object} input
 * @param {object} input.user
 * @param {string} input.message
 * @param {object} cfg                    openJevConfig()
 * @param {object} deps                   seams for tests and the evaluator:
 *   { fetchImpl, listTools, lookupLedger, companyProfile, financials, companyInfo,
 *     reauthorise, now, timeZone }
 * @returns {Promise<null | {reply, model, toolsUsed, diagnostics}>}
 */
async function runAccountsPilot({ user, message, history = [] }, cfg, deps = {}) {
  const startedAt = Date.now();
  const now = deps.now ? deps.now() : new Date();

  const { candidates, toolNames, offered } = accountsCandidates(user, deps);

  // Nothing accounting-related is available to this person. The pilot does not
  // cover them at all, so the ordinary assistant runs — this is not a fallback
  // for a supported question, it is a user the pilot has no opinion about.
  if (toolNames.length === 0) return null;

  const route = await chooseIntent(
    { question: message, intents: candidates, instructions: INSTRUCTIONS },
    cfg,
    deps.fetchImpl,
  );
  const jevLatencyMs = route.latencyMs;

  const cascade = cfg && cfg.mode === "jev_qwen_accounts";
  const diagnostics = {
    mode: cascade ? "jev_qwen_accounts" : "jev_only_accounts",
    candidatesOffered: offered,
    executableCandidates: toolNames,
    chosenTool: null,
    probability: null,
    margin: null,
    jevStatus: route.status,
    jevReason: route.reason || null,
    jevLatencyMs,
    accountingReadLatencyMs: null,
    totalLatencyMs: null,
    result: null,
    resultReason: null,
    provenance: route.provenance || null,
    routeDecider: null,
    qwenInvoked: false,
    qwenStatus: null,
    qwenReason: null,
    qwenChoice: null,
    qwenLatencyMs: null,
    qwenModel: null,
    qwenArgumentsInvoked: false,
    qwenArgumentsStatus: null,
    qwenArgumentsReason: null,
    qwenArgumentsLatencyMs: null,
    qwenArgumentsModel: null,
    qwenPlanInvoked: false,
    qwenPlanStatus: null,
    qwenPlanReason: null,
    qwenPlanLatencyMs: null,
    qwenPlanModel: null,
  };

  const finish = (result, reply, reason = null, extra = {}) => {
    diagnostics.result = result;
    diagnostics.resultReason = reason;
    diagnostics.totalLatencyMs = Date.now() - startedAt;
    return {
      reply,
      model: cascade ? "open-jev-qwen-accounts" : "open-jev-accounts-pilot",
      toolsUsed: diagnostics.chosenTool ? [diagnostics.chosenTool] : [],
      diagnostics,
      ...extra,
    };
  };

  let chosen = null;
  let plannedArguments = null;
  let plannedClarification = null;
  let jevAccepted = false;
  if (route.status === STATUS.OK) {
    const ranked = Object.entries(route.probabilities || {}).sort((a, b) => b[1] - a[1]);
    if (ranked.length) {
      const probability = ranked[0][1];
      const margin = probability - (ranked[1] ? ranked[1][1] : 0);
      diagnostics.probability = probability;
      diagnostics.margin = margin;
      chosen = ranked[0][0];
      if (!offered.includes(chosen)) {
        return finish(RESULT.FAILED, cascade ? CASCADE_NO_ROUTE_REPLY : NO_ROUTE_REPLY, "chose_unoffered_candidate");
      }
      jevAccepted = probability >= cfg.minProbability && margin >= cfg.minMargin;
    }
  }

  // A confident executable decision stays on Jev's fast path. `clarify` and
  // `unsupported` are control labels rather than completed reads; in hybrid
  // mode Qwen gets one chance to correct either before the request ends.
  if (jevAccepted && !(cascade && (chosen === CLARIFY || chosen === UNSUPPORTED))) {
    diagnostics.routeDecider = "jev";
  } else if (cascade) {
    // Keep the old injected reviewer seam for existing evaluators. Production
    // uses the universal typed planner: constrained Qwen stages may correct the
    // route and provide validated arguments, but cannot read or execute anything.
    if (typeof deps.reviewRoute === "function" && typeof deps.planAccountingQuestion !== "function") {
      diagnostics.qwenInvoked = true;
      const reviewed = await deps.reviewRoute(
        { question: message, candidates, jev: route, history },
        cfg.qwen || {},
        { chatJson: deps.qwenChatJson, fetchImpl: deps.qwenFetchImpl },
      );
      diagnostics.qwenStatus = reviewed.status;
      diagnostics.qwenReason = reviewed.reason || null;
      diagnostics.qwenChoice = reviewed.choice || null;
      diagnostics.qwenLatencyMs = reviewed.latencyMs;
      diagnostics.qwenModel = reviewed.model || null;
      if (reviewed.status !== "ok" || !offered.includes(reviewed.choice)) {
        return finish(RESULT.FAILED, CASCADE_NO_ROUTE_REPLY, reviewed.reason || "qwen_review_failed");
      }
      chosen = reviewed.choice;
      diagnostics.routeDecider = "qwen_review";
    } else {
      const planner = deps.planAccountingQuestion || require("./qwenAccountingPlanner").planAccountingQuestion;
      diagnostics.qwenInvoked = true;
      diagnostics.qwenPlanInvoked = true;
      const plan = await planner(
        { question: message, candidates, jev: route, history },
        cfg.qwen || {},
        { chatJson: deps.qwenChatJson, fetchImpl: deps.qwenFetchImpl },
      );
      diagnostics.qwenPlanStatus = plan.status;
      diagnostics.qwenPlanReason = plan.reason || null;
      diagnostics.qwenPlanLatencyMs = plan.latencyMs;
      diagnostics.qwenPlanModel = plan.model || null;
      diagnostics.qwenStatus = plan.status;
      diagnostics.qwenReason = plan.reason || null;
      diagnostics.qwenChoice = plan.tool || null;
      diagnostics.qwenLatencyMs = plan.latencyMs;
      diagnostics.qwenModel = plan.model || null;
      if (plan.status !== "ok" || !offered.includes(plan.tool)) {
        return finish(RESULT.FAILED, CASCADE_NO_ROUTE_REPLY, plan.reason || "qwen_plan_failed");
      }
      chosen = plan.tool;
      plannedArguments = plan.arguments || null;
      plannedClarification = plan.clarification || null;
      diagnostics.routeDecider = "qwen_plan";
    }
  } else {
    const reason = route.status === STATUS.OK ? "below_threshold" : route.status;
    return finish(RESULT.FAILED, NO_ROUTE_REPLY, reason);
  }

  diagnostics.chosenTool = chosen;

  if (chosen === UNSUPPORTED) {
    return finish(RESULT.UNSUPPORTED, UNSUPPORTED_REPLY, `${diagnostics.routeDecider}_unsupported`);
  }
  if (chosen === CLARIFY) {
    return finish(
      RESULT.CLARIFIED,
      plannedClarification || "Which account or figure would you like? Tell me the ledger or party name as it appears in the books.",
      `${diagnostics.routeDecider}_clarify`,
    );
  }

  // Step 3: re-authorise, independently of anything the model returned.
  const stillAllowed = await reauthorise(user, chosen, deps);
  if (!stillAllowed) return finish(RESULT.FAILED, NO_ROUTE_REPLY, "reauthorisation_denied");

  // Financials is a catalogue of individually addressable facts. Jev selects
  // the authorised capability; the constrained language stage selects only a
  // closed metric id. This prevents a specific request such as "expenses"
  // from falling through to the old all-in-one summary.
  if (cascade && chosen === "acc_financials" && !plannedArguments) {
    diagnostics.qwenArgumentsInvoked = true;
    const interpreter = deps.interpretArguments
      || require("./qwenArgumentInterpreter").interpretArguments;
    const interpreted = await interpreter(
      { question: message, tool: chosen, history },
      cfg.qwen || {},
      { chatJson: deps.qwenChatJson, fetchImpl: deps.qwenFetchImpl },
    );
    diagnostics.qwenArgumentsStatus = interpreted && interpreted.status;
    diagnostics.qwenArgumentsReason = interpreted && interpreted.reason || null;
    diagnostics.qwenArgumentsLatencyMs = interpreted && interpreted.latencyMs;
    diagnostics.qwenArgumentsModel = interpreted && interpreted.model || null;
    if (!interpreted || interpreted.status !== "ok") {
      return finish(RESULT.FAILED, CASCADE_NO_ROUTE_REPLY, interpreted && interpreted.reason || "financial_metric_failed_validation");
    }
    plannedArguments = interpreted.arguments;
  }

  const readStarted = Date.now();
  let outcome;
  try {
    outcome = await executeAccountingTool({ tool: chosen, message, resolvedArguments: plannedArguments, now, user, deps });
  } catch {
    outcome = { outcome: OUTCOME.FAILED, reason: "executor_threw" };
  }
  diagnostics.accountingReadLatencyMs = Date.now() - readStarted;

  // The first read deliberately uses the user's exact words. If its safe
  // deterministic parser cannot resolve those words, the hybrid mode gets ONE
  // language-only retry: Qwen emits typed arguments for the already-selected
  // tool, GRAV validates them, re-authorises, and the same read runs again.
  // No record or candidate ledger is exposed to Qwen, and a second ambiguous
  // result remains a clarification rather than becoming a guess.
  if (cascade && outcome.outcome === OUTCOME.CLARIFY && !plannedArguments) {
    diagnostics.qwenArgumentsInvoked = true;
    let interpreted;
    if (typeof deps.interpretArguments === "function") {
      interpreted = await deps.interpretArguments(
        { question: message, tool: chosen, history },
        cfg.qwen || {},
        { chatJson: deps.qwenChatJson, fetchImpl: deps.qwenFetchImpl },
      );
    } else {
      const planner = deps.planAccountingQuestion || require("./qwenAccountingPlanner").planAccountingQuestion;
      diagnostics.qwenPlanInvoked = true;
      const plan = await planner(
        { question: message, candidates, jev: route, history },
        cfg.qwen || {},
        { chatJson: deps.qwenChatJson, fetchImpl: deps.qwenFetchImpl },
      );
      diagnostics.qwenPlanStatus = plan.status;
      diagnostics.qwenPlanReason = plan.reason || null;
      diagnostics.qwenPlanLatencyMs = plan.latencyMs;
      diagnostics.qwenPlanModel = plan.model || null;
      if (plan.status === "ok" && plan.tool === CLARIFY) {
        return finish(RESULT.CLARIFIED, plan.clarification, "qwen_plan_clarify");
      }
      interpreted = {
        status: plan.status,
        reason: plan.reason,
        arguments: plan.arguments,
        tool: plan.tool,
        latencyMs: plan.latencyMs,
        model: plan.model,
      };
    }
    diagnostics.qwenArgumentsStatus = interpreted.status;
    diagnostics.qwenArgumentsReason = interpreted.reason || null;
    diagnostics.qwenArgumentsLatencyMs = interpreted.latencyMs;
    diagnostics.qwenArgumentsModel = interpreted.model || null;
    if (interpreted.status === "ok") {
      const retryTool = interpreted.tool && offered.includes(interpreted.tool) ? interpreted.tool : chosen;
      if (retryTool === CLARIFY || retryTool === UNSUPPORTED) {
        return finish(RESULT.CLARIFIED, outcome.reply, "qwen_plan_control_without_clarification");
      }
      if (!(await reauthorise(user, retryTool, deps))) {
        return finish(RESULT.FAILED, CASCADE_NO_ROUTE_REPLY, "reauthorisation_denied_before_retry");
      }
      const retryStarted = Date.now();
      try {
        outcome = await executeAccountingTool({
          tool: retryTool,
          message,
          resolvedArguments: interpreted.arguments,
          now,
          user,
          deps,
        });
      } catch {
        outcome = { outcome: OUTCOME.FAILED, reason: "interpreted_executor_threw" };
      }
      diagnostics.accountingReadLatencyMs += Date.now() - retryStarted;
      chosen = retryTool;
      plannedArguments = interpreted.arguments || null;
      diagnostics.chosenTool = retryTool;
    }
  }

  if (outcome.outcome === OUTCOME.ANSWERED) {
    return finish(RESULT.ANSWERED, outcome.reply, null, {
      evidence: outcome.evidence || null,
      contextState: { tool: chosen, arguments: plannedArguments || null },
    });
  }
  if (outcome.outcome === OUTCOME.CLARIFY) {
    return finish(RESULT.CLARIFIED, outcome.reply, outcome.reason);
  }
  if (outcome.outcome === OUTCOME.UNSUPPORTED) {
    return finish(RESULT.UNSUPPORTED, UNSUPPORTED_REPLY, outcome.reason);
  }
  return finish(RESULT.FAILED, FAILED_REPLY, outcome.reason || "executor_failed");
}

/**
 * Re-run the tool's OWN permission check, from the registry.
 *
 * Not a copy of the rule and not a cached answer from step 1: the registry is
 * asked again, so a permission that changed mid-request is honoured and a bug
 * in the candidate builder cannot open a tool on its own.
 */
async function reauthorise(user, toolName, deps = {}) {
  if (typeof deps.reauthorise === "function") return deps.reauthorise(user, toolName);
  try {
    const { getTool } = require("../toolRegistry");
    const tool = getTool(toolName);
    return Boolean(tool && tool.permission(user) === true);
  } catch {
    return false;
  }
}

/**
 * GRAV's own read, for the tool Jev named.
 *
 * Each branch calls the EXISTING accounting context builder — the same one the
 * ordinary assistant uses — and writes the answer itself.
 */
async function executeAccountingTool({ tool, message, resolvedArguments, now, user, deps }) {
  const ctx = () => require("../../accountingContext");

  if (tool === "acc_ledger_balance") {
    const baseLookup = deps.lookupLedger || ctx().buildLedgerLookup;
    let groundedArguments = resolvedArguments;
    let exactNamedLedger = null;
    // A small local model can occasionally emit an all-ledger plan even when
    // the current turn contains one exact master-ledger name. Ground the raw
    // words before allowing that expansion. This is entity validation against
    // the books, not a phrase rule and not a model choosing a record.
    if (resolvedArguments && ["all", "group"].includes(resolvedArguments.ledgerMode)) {
      const grounded = await baseLookup({ query: message, hint: message });
      if (grounded && grounded.found === true && grounded.fuzzy !== true
          && (grounded.exactNamedMatch === true || grounded.uniqueNamedMatch === true)
          && Number(grounded.totalMatched || (grounded.matches || []).length) === 1
          && Array.isArray(grounded.matches) && grounded.matches.length === 1) {
        exactNamedLedger = grounded;
        groundedArguments = {
          ...resolvedArguments,
          ledgerMode: "single",
          ledgerName: grounded.matches[0].name,
          groupName: null,
          balanceSide: "any",
          ranking: "none",
          limit: 1,
        };
      }
    }
    const lookupLedger = exactNamedLedger
      ? async () => exactNamedLedger
      : groundedArguments && groundedArguments.ledgerMode === "all"
      ? async () => (deps.lookupLedgerRanking || ctx().buildLedgerRanking)({
          balanceSide: groundedArguments.balanceSide,
          ranking: groundedArguments.ranking,
          limit: groundedArguments.limit,
        })
      : baseLookup;
    return answerLedgerBalance({
      message,
      resolvedArguments: groundedArguments,
      lookupLedger,
      companyProfile: deps.companyProfile || ctx().buildCompanyInfo,
      now,
      timeZone: deps.timeZone || "Asia/Kolkata",
    });
  }

  if (tool === "acc_vouchers") {
    const context = ctx();
    return answerVouchers({
      message,
      resolvedArguments,
      // The EXISTING service does the counting, totalling and ranking. This
      // pilot adds no accounting calculation of its own.
      buildVouchers: deps.buildVouchers || context.buildVouchers,
      // A party filter is first resolved inside the same company. Only one
      // exact recorded name may reach the voucher query; ambiguity remains a
      // question to the user rather than a model guess.
      resolveLedger: deps.lookupLedger || context.buildLedgerLookup,
      // The accounting module's own alias table, so "invoice" means here what
      // it means there.
      aliases: deps.voucherAliases || context.VOUCHER_ALIASES,
      now,
    });
  }

  if (tool === "acc_party_reports") {
    return answerPartyReport({
      resolvedArguments,
      buildPartyReport: deps.buildPartyReport || ctx().buildPartyReport,
      now,
    });
  }

  if (tool === "acc_report_query") {
    const result = await (deps.runAccountingReport || require("../accountingReportQuery").runAccountingReport)({
      user,
      query: resolvedArguments,
      runPreview: deps.runReportPreview,
    });
    if (!result || !result.ok) {
      return { outcome: OUTCOME.FAILED, reason: result && result.reason || "report_query_failed" };
    }
    return {
      outcome: OUTCOME.ANSWERED,
      reply: result.reply,
      evidence: { schema: "grav.acc.report-query.evidence/1", effectiveAt: now.toISOString() },
    };
  }

  if (tool === "acc_company") {
    const profile = await (deps.companyProfile || ctx().buildCompanyInfo)();
    if (!profile || profile.available === false) {
      return { outcome: OUTCOME.FAILED, reason: "company_unavailable" };
    }
    const parts = [
      profile.name ? `Legal name: ${profile.name}` : null,
      profile.gstin ? `GSTIN: ${profile.gstin}` : null,
      profile.pan ? `PAN: ${profile.pan}` : null,
      profile.financialYear ? `Financial year: ${profile.financialYear}` : null,
      profile.baseCurrency ? `Base currency: ${profile.baseCurrency}` : null,
    ].filter(Boolean);
    if (parts.length === 0) return { outcome: OUTCOME.FAILED, reason: "company_empty" };
    return {
      outcome: OUTCOME.ANSWERED,
      reply: `${parts.join(". ")}.`,
      evidence: { schema: "grav.acc.company.evidence/1", effectiveAt: now.toISOString() },
    };
  }

  if (tool === "acc_financials") {
    const financials = await (deps.financials || ctx().buildFinancials)();
    if (!financials || financials.available === false) {
      return { outcome: OUTCOME.FAILED, reason: "financials_unavailable" };
    }
    return answerFinancialMetric({ financials, metric: resolvedArguments && resolvedArguments.metric, now });
  }

  // Offered but not executable is a bug in the candidate builder, not a user
  // error — say unsupported rather than inventing an answer.
  return { outcome: OUTCOME.UNSUPPORTED, reason: "no_executor" };
}

const formatMoney = (value, currency) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);

function answerFinancialMetric({ financials, metric = "summary", now }) {
  const pnl = financials && financials.profitAndLoss || {};
  const balanceSheet = financials && financials.balanceSheet || {};
  const currency = financials && financials.baseCurrency || "INR";
  const fy = financials && financials.financialYear || "current financial year";
  const definitions = {
    revenue: ["Total revenue", pnl.totalRevenue, "money"],
    expenses: ["Total expenses", pnl.totalExpenses, "money"],
    direct_revenue: ["Direct revenue", pnl.directRevenue, "money"],
    direct_expenses: ["Direct expenses (cost of goods sold)", pnl.directExpenses, "money"],
    gross_profit: ["Gross profit", pnl.grossProfit, "money"],
    gross_profit_margin: ["Gross profit margin", pnl.grossProfitMargin, "percent"],
    net_profit: [Number(pnl.netProfit) < 0 ? "Net loss" : "Net profit", Math.abs(Number(pnl.netProfit)), "money"],
    net_profit_margin: ["Net profit margin", pnl.netProfitMargin, "percent"],
    assets: ["Total assets", balanceSheet.totalAssets, "money"],
    liabilities: ["Total liabilities", balanceSheet.totalLiabilities, "money"],
    equity: ["Total equity", balanceSheet.equity, "money"],
  };
  if (!metric || metric === "summary") {
    const readable = typeof financials.readable === "string" ? financials.readable.trim() : "";
    if (!readable) return { outcome: OUTCOME.FAILED, reason: "financials_no_summary" };
    return {
      outcome: OUTCOME.ANSWERED,
      reply: `${readable} (as at ${now.toISOString()})`,
      evidence: { schema: "grav.acc.financials.evidence/2", metric: "summary", effectiveAt: now.toISOString() },
    };
  }
  const selected = definitions[metric];
  if (!selected || !Number.isFinite(Number(selected[1]))) {
    return { outcome: OUTCOME.FAILED, reason: "financial_metric_unavailable" };
  }
  const value = selected[2] === "percent"
    ? `${Number(selected[1]).toLocaleString("en-IN", { maximumFractionDigits: 2 })}%`
    : formatMoney(selected[1], currency);
  return {
    outcome: OUTCOME.ANSWERED,
    reply: `${selected[0]} for FY ${fy}: ${value}.`,
    evidence: {
      schema: "grav.acc.financials.evidence/2",
      metric,
      value: Number(selected[1]),
      currency: selected[2] === "money" ? currency : null,
      financialYear: fy,
      effectiveAt: now.toISOString(),
    },
  };
}

module.exports = {
  runAccountsPilot,
  executeAccountingTool,
  answerFinancialMetric,
  reauthorise,
  RESULT,
  INSTRUCTIONS,
  NO_ROUTE_REPLY,
  UNSUPPORTED_REPLY,
  FAILED_REPLY,
};
