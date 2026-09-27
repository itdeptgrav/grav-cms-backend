"use strict";

/**
 * Language-only accounting planner for the Jev -> Qwen cascade.
 *
 * The planner can describe a read; it cannot perform one. It receives only the
 * user's words, bounded user-only conversation context and the names of tools
 * GRAV has already authorised. GRAV validates the plan, re-authorises the
 * selected tool, resolves names against real company records and performs all
 * calculations deterministically.
 */

const { chatJson } = require("../../ollamaClient");
const { VOUCHER_TYPES, PARTY_REPORTS, FINANCIAL_METRICS, interpretArguments } = require("./qwenArgumentInterpreter");
const { reviewRoute } = require("./qwenRouteReviewer");

const STATUS = Object.freeze({ OK: "ok", FAILED: "failed", INVALID: "invalid" });
const CONTROL = new Set(["clarify", "unsupported"]);
const MAX_TEXT = 200;

function schemaFor(offered) {
  return {
    type: "object",
    properties: {
      tool: { type: "string", enum: [...offered] },
      ledger: {
        type: ["object", "null"],
        properties: {
          mode: { type: "string", enum: ["single", "group", "all"] },
          name: { type: ["string", "null"], maxLength: MAX_TEXT },
          group: { type: ["string", "null"], maxLength: MAX_TEXT },
          balanceSide: { type: "string", enum: ["any", "dr", "cr"] },
          ranking: { type: "string", enum: ["none", "largest", "smallest"] },
          limit: { type: "integer", minimum: 1, maximum: 15 },
        },
        required: ["mode", "name", "group", "balanceSide", "ranking", "limit"],
        additionalProperties: false,
      },
      vouchers: {
        type: ["object", "null"],
        properties: {
          voucherType: { type: "string", enum: [...VOUCHER_TYPES] },
          partyName: { type: ["string", "null"], maxLength: MAX_TEXT },
          from: { type: ["string", "null"] },
          to: { type: ["string", "null"] },
          ranking: { type: "string", enum: ["none", "recent", "largest"] },
          limit: { type: "integer", minimum: 1, maximum: 15 },
          view: { type: "string", enum: ["summary", "details"] },
        },
        required: ["voucherType", "partyName", "from", "to", "ranking", "limit", "view"],
        additionalProperties: false,
      },
      partyReport: {
        type: ["object", "null"],
        properties: {
          report: { type: "string", enum: [...PARTY_REPORTS] },
          asOf: { type: ["string", "null"] },
          search: { type: ["string", "null"], maxLength: MAX_TEXT },
          ranking: { type: "string", enum: ["none", "largest", "smallest"] },
          limit: { type: "integer", minimum: 1, maximum: 15 },
        },
        required: ["report", "asOf", "search", "ranking", "limit"],
        additionalProperties: false,
      },
      financial: {
        type: ["object", "null"],
        properties: {
          metric: { type: "string", enum: [...FINANCIAL_METRICS] },
        },
        required: ["metric"],
        additionalProperties: false,
      },
      reportQuery: {
        type: ["object", "null"],
        properties: require("../accountingReportQuery").parameters.properties,
        required: require("../accountingReportQuery").parameters.required,
        additionalProperties: false,
      },
      clarification: { type: ["string", "null"], maxLength: 300 },
    },
    required: ["tool", "ledger", "vouchers", "partyReport", "financial", "reportQuery", "clarification"],
    additionalProperties: false,
  };
}

const text = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT) : "";

function validIsoDate(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function validatePlan(raw, offered) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !offered.includes(raw.tool)) return null;
  if (CONTROL.has(raw.tool)) {
    const clarification = raw.tool === "clarify" ? text(raw.clarification) : null;
    if (raw.tool === "clarify" && !clarification) return null;
    return { tool: raw.tool, arguments: null, clarification };
  }
  if (raw.tool === "acc_ledger_balance") {
    const ledger = raw.ledger;
    if (!ledger || !["single", "group", "all"].includes(ledger.mode)) return null;
    const name = text(ledger.name);
    const group = text(ledger.group);
    if (ledger.mode === "single" && !name) return null;
    if (ledger.mode === "group" && !group) return null;
    if (ledger.mode === "all" && !["dr", "cr"].includes(ledger.balanceSide)) return null;
    if (!["any", "dr", "cr"].includes(ledger.balanceSide)) return null;
    if (!["none", "largest", "smallest"].includes(ledger.ranking)) return null;
    if (!Number.isInteger(ledger.limit) || ledger.limit < 1 || ledger.limit > 15) return null;
    return {
      tool: raw.tool,
      arguments: {
        ledgerMode: ledger.mode,
        ledgerName: ledger.mode === "single" ? name : ledger.mode === "group" ? group : null,
        groupName: ledger.mode === "group" ? group : null,
        balanceSide: ledger.balanceSide,
        ranking: ledger.ranking,
        limit: ledger.limit,
      },
      clarification: null,
    };
  }
  if (raw.tool === "acc_vouchers") {
    const v = raw.vouchers;
    if (!v || !VOUCHER_TYPES.includes(v.voucherType)) return null;
    if (!validIsoDate(v.from) || !validIsoDate(v.to) || ((v.from === null) !== (v.to === null))) return null;
    if (v.from && v.to && v.from > v.to) return null;
    if (!["none", "recent", "largest"].includes(v.ranking)) return null;
    if (!Number.isInteger(v.limit) || v.limit < 1 || v.limit > 15) return null;
    return {
      tool: raw.tool,
      arguments: {
        voucherType: v.voucherType,
        partyName: text(v.partyName) || null,
        from: v.from,
        to: v.to,
        ranking: v.ranking,
        limit: v.limit,
        view: v.view === "details" ? "details" : "summary",
      },
      clarification: null,
    };
  }
  if (raw.tool === "acc_party_reports") {
    const value = raw.partyReport;
    if (!value || !PARTY_REPORTS.includes(value.report) || !validIsoDate(value.asOf)) return null;
    const search = text(value.search);
    if (!["none", "largest", "smallest"].includes(value.ranking)) return null;
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 15) return null;
    return {
      tool: raw.tool,
      arguments: { report: value.report, asOf: value.asOf, search: search || null, ranking: value.ranking, limit: value.limit },
      clarification: null,
    };
  }
  if (raw.tool === "acc_report_query") {
    const value = require("../accountingReportQuery").cleanQuery(raw.reportQuery);
    return value ? { tool: raw.tool, arguments: value, clarification: null } : null;
  }
  if (raw.tool === "acc_financials") {
    const financial = raw.financial;
    if (!financial || !FINANCIAL_METRICS.includes(financial.metric)) return null;
    return { tool: raw.tool, arguments: { metric: financial.metric }, clarification: null };
  }
  if (raw.tool === "acc_company") {
    return { tool: raw.tool, arguments: null, clarification: null };
  }
  return null;
}

async function planAccountingQuestion({ question, candidates, jev, history = [] }, cfg = {}, deps = {}) {
  const started = Date.now();
  const done = (value) => ({ ...value, latencyMs: Date.now() - started });
  const offered = Object.keys(candidates || {});
  if (typeof question !== "string" || !question.trim() || offered.length === 0) {
    return done({ status: STATUS.INVALID, reason: "empty_request" });
  }

  try {
    // Two deliberately small constrained decisions are more reliable on an 8B
    // model than one deeply nested nullable schema. The first chooses only an
    // authorised capability; the second is the closed schema for that one
    // capability. This remains one planner and never exposes records.
    const route = await (deps.reviewRoute || reviewRoute)(
      { question, candidates, jev, history },
      cfg,
      { chatJson: deps.chatJson || chatJson, fetchImpl: deps.fetchImpl },
    );
    if (!route || route.status !== "ok" || !offered.includes(route.choice)) {
      return done({ status: STATUS.INVALID, reason: route && route.reason || "route_failed_validation" });
    }
    if (route.choice === "clarify") {
      return done({
        status: STATUS.OK,
        tool: "clarify",
        arguments: null,
        clarification:
          "Please clarify the accounting meaning you want—for example, a named ledger, an account group such as Sundry Debtors, or debit/credit-balance ledgers.",
        model: route.model || cfg.model || null,
      });
    }
    if (route.choice === "unsupported") {
      return done({ status: STATUS.OK, tool: "unsupported", arguments: null, clarification: null, model: route.model || cfg.model || null });
    }
    if (route.choice === "acc_company") {
      return done({ status: STATUS.OK, tool: route.choice, arguments: null, clarification: null, model: route.model || cfg.model || null });
    }
    const interpreted = await (deps.interpretArguments || interpretArguments)(
      { question, tool: route.choice, history },
      cfg,
      { chatJson: deps.chatJson || chatJson, fetchImpl: deps.fetchImpl },
    );
    if (!interpreted || interpreted.status !== "ok") {
      return done({ status: STATUS.INVALID, reason: interpreted && interpreted.reason || "arguments_failed_validation" });
    }
    return done({
      status: STATUS.OK,
      tool: route.choice,
      arguments: interpreted.arguments,
      clarification: null,
      model: interpreted.model || route.model || cfg.model || null,
    });
  } catch (error) {
    return done({ status: STATUS.FAILED, reason: error && error.code ? error.code : "planning_failed" });
  }
}

module.exports = { planAccountingQuestion, schemaFor, validatePlan, STATUS };
