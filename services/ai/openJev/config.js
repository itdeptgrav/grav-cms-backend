"use strict";
/**
 * services/ai/openJev/config.js — the Open-Jev routing pilot's switches.
 *
 * DISABLED BY DEFAULT. With the flag unset the central assistant never loads a
 * model client, never builds a candidate list and never logs a routing event —
 * the existing Ollama tool-selection round and regex fallback run exactly as
 * before. See docs/decisions/open-jev-cms-pilot.md.
 *
 *   GRAV_OPEN_JEV_PILOT_ENABLED   "true" to enable (anything else = off)
 *   GRAV_OPEN_JEV_URL             default http://127.0.0.1:8791/v1/systemone
 *   GRAV_OPEN_JEV_TIMEOUT_MS      default 1500 — past it, the baseline answers
 *   GRAV_OPEN_JEV_MIN_PROB        default 0.80 — top intent must reach this
 *   GRAV_OPEN_JEV_MIN_MARGIN      default 0.30 — and beat the runner-up by this
 *   GRAV_OPEN_JEV_STALE_MINUTES   default 90   — attendance sync older than this
 *                                                is reported as possibly stale
 *
 * The two thresholds were fixed BEFORE any model output existed and have not
 * been tuned; changing them after seeing held-out results would invalidate the
 * held-out comparison.
 */

const DEFAULTS = Object.freeze({
  url: "http://127.0.0.1:8791/v1/systemone",
  timeoutMs: 1500,
  minProbability: 0.8,
  minMargin: 0.3,
  staleMinutes: 90,
});

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function openJevConfig(env = process.env) {
  return {
    enabled: String(env.GRAV_OPEN_JEV_PILOT_ENABLED || "").trim().toLowerCase() === "true",
    url: (env.GRAV_OPEN_JEV_URL || DEFAULTS.url).trim(),
    timeoutMs: num(env.GRAV_OPEN_JEV_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 50, max: 30000 }),
    minProbability: num(env.GRAV_OPEN_JEV_MIN_PROB, DEFAULTS.minProbability, { min: 0, max: 1 }),
    minMargin: num(env.GRAV_OPEN_JEV_MIN_MARGIN, DEFAULTS.minMargin, { min: 0, max: 1 }),
    staleMinutes: num(env.GRAV_OPEN_JEV_STALE_MINUTES, DEFAULTS.staleMinutes, { min: 1, max: 24 * 60 }),
  };
}

module.exports = { openJevConfig, DEFAULTS };
