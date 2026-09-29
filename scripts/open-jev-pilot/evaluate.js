#!/usr/bin/env node
"use strict";
/**
 * Offline evaluation harness for the Open-Jev routing pilot.
 *
 *   node scripts/open-jev-pilot/evaluate.js                  # offline only
 *   node scripts/open-jev-pilot/evaluate.js --live-open-jev  # + a real Open-Jev server
 *   node scripts/open-jev-pilot/evaluate.js --live-ollama    # + the real Ollama tool round
 *   ... --out tmp/open-jev-pilot/result.json
 *
 * No database: GRAV's reads go through caller-scoped fixture ports
 * (fixtures.js). No simulated model: a live router that cannot be reached is
 * reported as BLOCKED with the reason, and gets no numbers.
 *
 * What is compared on the SAME held-out cases (heldout-cases.json):
 *
 *   Intent routers, then GRAV's pilot step (executeRoutedIntent):
 *     oracle         the labelled intent — isolates GRAV's own step
 *     deterministic  fixed keyword rules below, frozen before the first run
 *     open-jev       live only (--live-open-jev)
 *
 *   Existing tool selection (the current assistant's baseline):
 *     regex          toolRegistry.relevantTools — the fallback, measured live
 *     ollama         live only (--live-ollama): chatWithTools with the exact
 *                    production tool-selection prompt and authorised tools
 *
 * The existing path's END-TO-END answer needs the Ollama answer model; when it
 * is not installed, that end-to-end comparison is reported as blocked.
 */

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");

require("../../services/ai/tools/hrTools");
require("../../services/ai/tools/accountingTools");
const { relevantTools, authorizedToolDefs } = require("../../services/ai/toolRegistry");
const { offerFor, executeRoutedIntent } = require("../../services/ai/openJev/pilot");
const { routeIntent } = require("../../services/ai/openJev/intentRouter");
const { analyseQuestion, osaDistance, OUTCOME } = require("../../services/ai/openJev/attendanceToday");
const { openJevConfig } = require("../../services/ai/openJev/config");
const { NOW, ACTORS, fixturePorts } = require("./fixtures");

const args = new Set(process.argv.slice(2));
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : path.join("tmp", "open-jev-pilot", `result-${Date.now()}.json`);
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, "heldout-cases.json"), "utf8"));

const FACTUAL = new Set([OUTCOME.CHECKED_IN, OUTCOME.NO_CHECKIN, OUTCOME.NO_ENTRY, OUTCOME.NO_SYNC]);

// ── The deterministic comparator (frozen before the first evaluation run) ────
const CUE_RE =
  /\b(present|here|in|checked|check|checkin|come|came|arrived|reached|aaya|aayi|office|punched|clocked|absent)\b/i;
const LEAVE_RE = /\b(leave|off|holiday|vacation|sick)\b/i;
function deterministicIntent(message) {
  const q = analyseQuestion(message);
  const lower = String(message).toLowerCase();
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  const cue = CUE_RE.test(lower) || tokens.some((t) => t.length >= 5 && osaDistance(t, "present") <= 1);
  const named = q.nameTokens.length > 0 || q.bioIds.length > 0;
  if (tokens.length <= 2 && named !== cue) return "unclear";
  if (q.day === "other" || q.self || q.group) return "other";
  if (named && LEAVE_RE.test(lower)) return "leave_today";
  if (named && cue) return "attendance_today";
  return "other";
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return Number(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)].toFixed(3));
}
const rate = (n, d) => (d ? Number((n / d).toFixed(4)) : null);

function effectiveIntent(expected, offer) {
  if (expected === "attendance_today" && !offer.attendanceToday) return "other";
  if (expected === "leave_today" && !offer.leaveToday) return "other";
  return expected;
}

async function gravStep({ user, c, intent, offer }) {
  const ports = fixturePorts({ companyId: user.companyId, scenario: c.scenario });
  const t0 = process.hrtime.bigint();
  let r;
  if (!offer.attendanceToday || intent !== "attendance_today") r = { outcome: OUTCOME.DEFER, reason: "not_routed" };
  else r = await executeRoutedIntent({ user, message: c.message, intent, ports, now: NOW, staleMinutes: 90 });
  return { r, ms: ms(t0), reads: ports.reads };
}

function scoreOutcome(c, r, reads) {
  const e = c.expect;
  const staleOk = e.stale === undefined || Boolean(r.evidence && r.evidence.day.stale) === e.stale;
  const correct = r.outcome === e.outcome && staleOk;
  const wrongFact = FACTUAL.has(r.outcome) && !correct;
  const leaked = (e.mustNotRead || []).filter((id) => reads.attendance.includes(id));
  return { correct, wrongFact, leaked };
}

// ── Live probes (never simulated) ────────────────────────────────────────────
async function probeOpenJev(cfg) {
  if (!args.has("--live-open-jev")) return { live: false, blocked: "not requested (pass --live-open-jev)" };
  const offer = { attendanceToday: true, leaveToday: true };
  const r = await routeIntent({ message: "Is Rishee present today?", offer }, cfg);
  if (r.status === "unavailable" || r.status === "timeout" || r.status === "invalid") {
    return { live: false, blocked: `Open-Jev at ${cfg.url}: ${r.status} (${r.reason || "no detail"})` };
  }
  return { live: true };
}

async function probeOllama() {
  if (!args.has("--live-ollama")) return { live: false, blocked: "not requested (pass --live-ollama)" };
  const base = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const model = process.env.OLLAMA_MODEL || "qwen3:8b";
  try {
    const res = await fetch(`${base}/api/tags`);
    const tags = await res.json();
    const names = (tags.models || []).map((m) => m.name);
    if (!names.includes(model)) {
      return { live: false, blocked: `Ollama reachable at ${base} but model "${model}" is not installed (installed: ${names.join(", ") || "none"})` };
    }
    return { live: true, model };
  } catch (err) {
    return { live: false, blocked: `Ollama unreachable at ${base}: ${err.message}` };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const cfg = openJevConfig({ ...process.env, GRAV_OPEN_JEV_PILOT_ENABLED: "true" });
  const openJev = await probeOpenJev(cfg);
  const ollama = await probeOllama();

  const intentRouters = {
    oracle: async (c, offer) => ({ intent: effectiveIntent(c.expect.intent, offer), abstained: false }),
    // A router chooses only among the intents offered to this user.
    deterministic: async (c, offer) => {
      const raw = deterministicIntent(c.message);
      const intent = effectiveIntent(raw, offer);
      return { intent, abstained: intent === "unclear" };
    },
  };
  if (openJev.live) {
    intentRouters["open-jev"] = async (c, offer) => {
      const r = await routeIntent({ message: c.message, offer }, cfg);
      return {
        intent: r.accepted ? r.intent : r.intent || null,
        routed: r.accepted ? r.intent : null,
        abstained: !r.accepted,
        status: r.status,
        probability: r.probability ?? null,
        margin: r.margin ?? null,
      };
    };
  }

  const rows = [];
  const agg = {};
  for (const name of Object.keys(intentRouters)) {
    agg[name] = { n: 0, intentCorrect: 0, abstained: 0, falseAttendanceRoute: 0, e2eCorrect: 0, wrongFact: 0, refusalViolations: 0, leaks: 0, routeMs: [], e2eMs: [] };
  }
  const toolAgg = { regex: { scored: 0, correct: 0, toolsAttached: 0, ms: [], directoryOnlyAttendance: 0 } };
  if (ollama.live) toolAgg.ollama = { scored: 0, correct: 0, toolsAttached: 0, ms: [], errors: 0 };

  for (const c of CASES.cases) {
    const user = ACTORS[c.actor]();
    const offer = await offerFor(user);
    const expIntent = effectiveIntent(c.expect.intent, offer);
    const unauthorised = !offer.attendanceToday;
    const row = { id: c.id, actor: c.actor, message: c.message, expectedIntent: expIntent, expectedOutcome: c.expect.outcome, routers: {}, tools: {} };

    for (const [name, fn] of Object.entries(intentRouters)) {
      const a = agg[name];
      const t0 = process.hrtime.bigint();
      const d = await fn(c, offer);
      const routeMs = ms(t0);
      const routed = d.routed !== undefined ? d.routed : d.abstained ? null : d.intent;
      const g = await gravStep({ user, c, intent: routed, offer });
      const s = scoreOutcome(c, g.r, g.reads);
      a.n += 1;
      if (d.intent === expIntent) a.intentCorrect += 1;
      if (d.abstained) a.abstained += 1;
      if (routed === "attendance_today" && expIntent !== "attendance_today") a.falseAttendanceRoute += 1;
      if (s.correct) a.e2eCorrect += 1;
      if (s.wrongFact) a.wrongFact += 1;
      if (unauthorised && g.r.outcome !== OUTCOME.DEFER) a.refusalViolations += 1;
      a.leaks += s.leaked.length;
      a.routeMs.push(routeMs);
      a.e2eMs.push(routeMs + g.ms);
      row.routers[name] = { intent: d.intent, routed, status: d.status, probability: d.probability, outcome: g.r.outcome, correct: s.correct, reply: g.r.reply || null };
    }

    // Existing tool selection.
    const expTools = c.expect.baselineTools;
    const authorised = new Set(authorizedToolDefs(user).map((t) => t.function.name));
    const effTools = Array.isArray(expTools) ? expTools.filter((t) => authorised.has(t)) : null;
    const scoreTools = (selected) => (effTools === null ? null : effTools.length ? selected.some((t) => effTools.includes(t)) : selected.length === 0);

    {
      const t0 = process.hrtime.bigint();
      const selected = relevantTools(user, c.message).map((t) => t.name);
      const took = ms(t0);
      const ok = scoreTools(selected);
      const ta = toolAgg.regex;
      ta.ms.push(took);
      ta.toolsAttached += selected.length;
      if (ok !== null) { ta.scored += 1; if (ok) ta.correct += 1; }
      if (c.actor === "directory_only_A" && selected.includes("hr_employee")) ta.directoryOnlyAttendance += 1;
      row.tools.regex = { selected, correct: ok };
    }
    if (ollama.live) {
      const { chatWithTools } = require("../../services/ollamaClient");
      const { toolSelectionSystemPrompt } = require("../../services/ai/gravAssistant");
      const tools = authorizedToolDefs(user);
      const ta = toolAgg.ollama;
      let selected = [];
      const t0 = process.hrtime.bigint();
      try {
        if (tools.length) {
          const dec = await chatWithTools({ system: toolSelectionSystemPrompt(), messages: [{ role: "user", content: c.message }], tools });
          selected = dec.toolCalls.map((tc) => (tc.function || {}).name).filter(Boolean);
        }
      } catch (err) {
        ta.errors += 1;
        selected = [`error:${err.code || err.message}`];
      }
      const took = ms(t0);
      const ok = scoreTools(selected);
      ta.ms.push(took);
      ta.toolsAttached += selected.length;
      if (ok !== null) { ta.scored += 1; if (ok) ta.correct += 1; }
      row.tools.ollama = { selected, correct: ok, ms: took };
    }
    rows.push(row);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    cases: CASES.cases.length,
    thresholds: { minProbability: cfg.minProbability, minMargin: cfg.minMargin },
    live: { openJev, ollama, ollamaEndToEnd: ollama.live ? "not implemented in harness" : `blocked: ${ollama.blocked}` },
    intentRouters: Object.fromEntries(
      Object.entries(agg).map(([k, a]) => [
        k,
        {
          n: a.n,
          intentAccuracy: rate(a.intentCorrect, a.n),
          abstentionRate: rate(a.abstained, a.n),
          falseAttendanceRoutes: a.falseAttendanceRoute,
          endToEndOutcomeAccuracy: rate(a.e2eCorrect, a.n),
          wrongFactualAnswers: a.wrongFact,
          refusalViolations: a.refusalViolations,
          attendanceReadLeaks: a.leaks,
          routeLatencyMs: { p50: pct(a.routeMs, 50), p95: pct(a.routeMs, 95), max: pct(a.routeMs, 100) },
          endToEndLatencyMsFixturePorts: { p50: pct(a.e2eMs, 50), p95: pct(a.e2eMs, 95), max: pct(a.e2eMs, 100) },
          marginalModelCost: k === "open-jev" ? "requires a provisioned CUDA host; not measured" : "none (no model call)",
        },
      ]),
    ),
    toolSelection: Object.fromEntries(
      Object.entries(toolAgg).map(([k, t]) => [
        k,
        {
          scored: t.scored,
          accuracy: rate(t.correct, t.scored),
          meanToolsAttached: rate(t.toolsAttached, CASES.cases.length),
          latencyMs: { p50: pct(t.ms, 50), p95: pct(t.ms, 95), max: pct(t.ms, 100) },
          ...(t.directoryOnlyAttendance !== undefined ? { directoryOnlyActorGotHrEmployee: t.directoryOnlyAttendance } : {}),
          ...(t.errors !== undefined ? { errors: t.errors } : {}),
        },
      ]),
    ),
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  const misses = rows.flatMap((r) =>
    Object.entries(r.routers)
      .filter(([, v]) => !v.correct)
      .map(([k, v]) => `${k.padEnd(13)} ${r.id.padEnd(9)} expected ${r.expectedIntent}/${r.expectedOutcome} got ${v.intent}/${v.outcome}`),
  );
  console.log(`\nEnd-to-end misses (${misses.length}):\n${misses.join("\n")}`);
  const toolMisses = rows.filter((r) => r.tools.regex.correct === false).map((r) => `regex ${r.id.padEnd(9)} selected [${r.tools.regex.selected.join(", ")}]`);
  console.log(`\nRegex tool-selection misses (${toolMisses.length}):\n${toolMisses.join("\n")}`);
  console.log(`\nWrote ${OUT}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
