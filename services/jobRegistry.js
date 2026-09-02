// services/jobRegistry.js
//
// The runnable side of the scheduled-task system.
//
// jobHeartbeats answers "is it running"; this answers "run it now" and "stop
// running it" — from the developer side, with no deploy. A job is runnable
// from the UI ONLY if code registered a handler here: the UI can never submit
// code, a shell command, or an arbitrary name — it can only invoke, by name,
// a function that shipped in a release. That is the whole security model, and
// it is why this file is a registry and not an endpoint parameter.
//
// enable/disable lives on the JobHeartbeat row (`enabled`) and is consulted
// by every cron wrapper through isEnabled() — cached, so a toggle applies
// within 30 seconds without touching the timers themselves.

"use strict";

const JobHeartbeat = require("../models/DevOps/JobHeartbeat");

/** name -> { description, dangerous, run: () => Promise<summaryObject> } */
const RUNNERS = new Map();

/**
 * Register a manually runnable job. Called from code at boot, next to the job
 * it exposes.
 */
function registerRunner(name, description, run, { dangerous = false } = {}) {
  RUNNERS.set(name, { name, description, dangerous, run });
}

function listRunners() {
  return [...RUNNERS.values()].map(({ name, description, dangerous }) => ({
    name,
    description,
    dangerous,
  }));
}

/**
 * Invoke one registered job now. Beats the heartbeat with the duration, so a
 * manual run and a scheduled run look the same in the history — because to
 * the system they are the same.
 */
async function runNow(name) {
  const runner = RUNNERS.get(name);
  if (!runner) throw new Error(`"${name}" is not manually runnable`);
  const { beat } = require("./jobHeartbeats");
  const started = Date.now();
  try {
    const result = await runner.run();
    beat(name, { durationMs: Date.now() - started });
    return { ok: true, durationMs: Date.now() - started, result };
  } catch (err) {
    beat(name, { error: err.message, durationMs: Date.now() - started });
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* enabled/disabled, cached                                            */
/* ------------------------------------------------------------------ */

const TTL_MS = 30 * 1000;
let _enabled = null; // Map(name -> boolean)
let _at = 0;

/**
 * May this job run? Fails OPEN on any error — a monitoring store hiccup must
 * not silently stop production crons, and "kept running during an outage" is
 * the recoverable mistake.
 */
async function isEnabled(name) {
  try {
    if (!_enabled || Date.now() - _at > TTL_MS) {
      const rows = await JobHeartbeat.find({}).select("name enabled").lean();
      _enabled = new Map(rows.map((r) => [r.name, r.enabled !== false]));
      _at = Date.now();
    }
    return _enabled.get(name) !== false;
  } catch {
    return true;
  }
}

function invalidateEnabled() {
  _enabled = null;
  _at = 0;
}

async function setEnabled(name, enabled) {
  const row = await JobHeartbeat.findOneAndUpdate(
    { name },
    { $set: { enabled: Boolean(enabled) } },
    { new: true },
  );
  if (!row) throw new Error(`No job named "${name}"`);
  invalidateEnabled();
  return row;
}

module.exports = { registerRunner, listRunners, runNow, isEnabled, setEnabled, invalidateEnabled };
