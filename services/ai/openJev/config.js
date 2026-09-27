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
 *                                 (max raised 25 Sep 2026 from 30 s to 5 min:
 *                                  a CPU container needs ~21 s per routing call
 *                                  and the old ceiling gave 1.4x headroom, which
 *                                  was not enough — see below)
 *   GRAV_OPEN_JEV_MIN_PROB        default 0.80 — top intent must reach this
 *   GRAV_OPEN_JEV_MIN_MARGIN      default 0.30 — and beat the runner-up by this
 *   GRAV_OPEN_JEV_STALE_MINUTES   default 90   — attendance sync older than this
 *                                                is reported as possibly stale
 *   GRAV_OPEN_JEV_MODE            default ""   — "jev_only_accounts" runs the
 *                                                Accounts pilot described in
 *                                                docs/decisions/open-jev-accounts-pilot.md
 *                                              — "jev_qwen_accounts" keeps
 *                                                confident Jev routes fast and
 *                                                asks a constrained Qwen review
 *                                                only when Jev is uncertain
 *   GRAV_OPEN_JEV_QWEN_URL        default http://127.0.0.1:11434
 *   GRAV_OPEN_JEV_QWEN_MODEL      default qwen3:8b
 *   GRAV_OPEN_JEV_QWEN_TIMEOUT_MS default 15000
 *
 * THE MODE IS NOT A SECOND SWITCH FOR PRODUCTION. In `jev_only_accounts` the
 * assistant answers its supported accounting questions with NO regex routing
 * and NO Gemini/Ollama round — if Jev cannot route confidently the user is told
 * so, rather than being quietly handed to another path. That is the point: a
 * silent fallback hides exactly the performance we are trying to measure. It is
 * therefore a development-and-evaluation mode, and unset (the default) leaves
 * every existing path byte-for-byte as it was.
 *
 * `jev_qwen_accounts` is also an evaluation mode. Qwen receives no accounting
 * data and cannot execute a tool; it may only select one of GRAV's already
 * authorised candidates. GRAV re-authorises that selection before its own
 * deterministic read. See docs/decisions/open-jev-qwen-accounts-cascade.md.
 *
 * The two thresholds were fixed BEFORE any model output existed and have not
 * been tuned; changing them after seeing held-out results would invalidate the
 * held-out comparison.
 */

/** Explicit modes. Anything else is "off". */
const MODE_JEV_ONLY_ACCOUNTS = "jev_only_accounts";
const MODE_JEV_QWEN_ACCOUNTS = "jev_qwen_accounts";

const DEFAULTS = Object.freeze({
  url: "http://127.0.0.1:8791/v1/systemone",
  timeoutMs: 1500,
  minProbability: 0.8,
  minMargin: 0.3,
  staleMinutes: 90,
  qwenUrl: "http://127.0.0.1:11434",
  qwenModel: "qwen3:8b",
  qwenTimeoutMs: 15000,
});

function num(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function openJevConfig(env = process.env) {
  return {
    enabled: String(env.GRAV_OPEN_JEV_PILOT_ENABLED || "").trim().toLowerCase() === "true",
    url: (env.GRAV_OPEN_JEV_URL || DEFAULTS.url).trim(),
    // The TRANSPORT bound, and not one of the two decision thresholds.
    //
    // The ceiling was 30 s, which is fine for a GPU and unusable on CPU. A CPU
    // routing call over six candidates measured ~21 s, leaving 1.4x headroom;
    // the moment one call crossed 30 s the client aborted, and because the
    // server does NOT cancel work on abort, the orphaned computation stayed on
    // the CPU and every later call queued behind it. Two evaluation runs were
    // lost to that cascade before it was understood. Raised to 5 minutes so a
    // slow deployment degrades into slowness rather than into a pile-up.
    //
    // `minProbability` and `minMargin` below are the pre-registered decision
    // thresholds and are NOT touched by this.
    timeoutMs: num(env.GRAV_OPEN_JEV_TIMEOUT_MS, DEFAULTS.timeoutMs, { min: 50, max: 300000 }),
    minProbability: num(env.GRAV_OPEN_JEV_MIN_PROB, DEFAULTS.minProbability, { min: 0, max: 1 }),
    minMargin: num(env.GRAV_OPEN_JEV_MIN_MARGIN, DEFAULTS.minMargin, { min: 0, max: 1 }),
    staleMinutes: num(env.GRAV_OPEN_JEV_STALE_MINUTES, DEFAULTS.staleMinutes, { min: 1, max: 24 * 60 }),
    mode: normaliseMode(env.GRAV_OPEN_JEV_MODE),
    qwen: {
      url: (env.GRAV_OPEN_JEV_QWEN_URL || env.OLLAMA_BASE_URL || DEFAULTS.qwenUrl).trim(),
      model: (env.GRAV_OPEN_JEV_QWEN_MODEL || env.OLLAMA_MODEL || DEFAULTS.qwenModel).trim(),
      timeoutMs: num(env.GRAV_OPEN_JEV_QWEN_TIMEOUT_MS, DEFAULTS.qwenTimeoutMs, { min: 100, max: 120000 }),
    },
  };
}

/**
 * An unrecognised mode is "off", never "some other mode".
 *
 * A typo in an environment variable must not silently select a different
 * behaviour, and must never turn a production deployment into a pilot.
 */
function normaliseMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  return [MODE_JEV_ONLY_ACCOUNTS, MODE_JEV_QWEN_ACCOUNTS].includes(value) ? value : "";
}

/**
 * Is the Accounts pilot running?
 *
 * Both switches, deliberately: the mode alone does nothing unless the pilot as
 * a whole is enabled, so a stale `GRAV_OPEN_JEV_MODE` left in an environment
 * file cannot bring the pilot up on its own.
 */
function isJevOnlyAccounts(cfg) {
  return Boolean(cfg && cfg.enabled && cfg.mode === MODE_JEV_ONLY_ACCOUNTS);
}

function isJevQwenAccounts(cfg) {
  return Boolean(cfg && cfg.enabled && cfg.mode === MODE_JEV_QWEN_ACCOUNTS);
}

module.exports = {
  openJevConfig,
  DEFAULTS,
  MODE_JEV_ONLY_ACCOUNTS,
  MODE_JEV_QWEN_ACCOUNTS,
  isJevOnlyAccounts,
  isJevQwenAccounts,
};
