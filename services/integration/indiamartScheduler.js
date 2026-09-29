// services/integration/indiamartScheduler.js
//
// THE SCHEDULED INDIAMART CYCLE: PULL ONE WINDOW, ROUTE BUYER ENQUIRIES TO
// SALES, RETRY WHAT HAS NOT ARRIVED.
//
// ── THE NORMAL WAY ENQUIRIES ARRIVE ────────────────────────────────────────
// Registered at boot, every 6 minutes. An administrator's Check now runs the
// same two steps; it is an extra check, not the operating method.
//
// ── RATE, LOCK AND CURSOR ARE NOT HERE ─────────────────────────────────────
// They live in the source's state row (indiamartSync.service): one call in 5
// minutes, 15 after a 429, one check at a time across every process, and a
// cursor that moves only when a window is fully saved. A cycle that finds the
// fence closed does not call IndiaMART; it still routes and delivers.
//
// ── DOWNTIME ───────────────────────────────────────────────────────────────
// Nothing to replay: the cursor stayed where the last full window ended, so
// the next cycles catch up 7 days at a time. A range that aged out of
// IndiaMART's 365 days is recorded as a gap, and a request older than Sales'
// 30-day handover window is held for review rather than sent late.
//
// ── NEVER FATAL, NEVER A CALL WITHOUT A KEY ────────────────────────────────
// No key for the Marketing company: nothing is read, nothing is written,
// nothing is called. Errors are logged by code only.
"use strict";

const mongoose = require("mongoose");

const sync = require("../marketing/leads/indiamartSync.service");
const routing = require("./indiamartSalesRouting.service");
const { MarketingLeadSourceState } = require("../../models/CMS_Models/Marketing/MarketingLeadSourceState");
const I = require("../../constants/marketingIndiamart");

const str = (v) => String(v ?? "").trim();

let running = false;

/* The pull's answer, as one word for the heartbeat. Always one of
   I.SCHEDULED_CYCLE_OUTCOME_CODES, each labelled in the status vocabulary. */
function pullWord(pull = {}) {
  if (pull.outcome === "completed" || pull.outcome === "failed") return pull.outcome;
  if (pull.refused === "LEAD_SOURCE_CHECK_TOO_SOON") return "waiting_rate_limit";
  if (pull.refused === "LEAD_SOURCE_CHECK_IN_PROGRESS") return "another_check_running";
  return "error";
}

/**
 * Pull (when the fence allows) and route, for one company. Used by the
 * scheduler and by Check now.
 */
async function cycleFor({ companyId, env = process.env, now = Date.now, transport, startedBy = "scheduler" } = {}) {
  const company = new mongoose.Types.ObjectId(String(companyId));
  let pull;
  try {
    const out = await sync.check({ companyId: company, env, now, transport, startedBy });
    pull = { outcome: out.outcome, check: out };
  } catch (err) {
    const code = str(err?.code);
    /* An administrator is told plainly (409 / 429); the scheduler moves on
       to routing, which never needs a call. */
    if (startedBy === "manual") throw err;
    if (code === "LEAD_SOURCE_CHECK_TOO_SOON" || code === "LEAD_SOURCE_CHECK_IN_PROGRESS") {
      pull = { refused: code, nextAllowedAt: err?.details?.nextAllowedAt || null };
    } else {
      console.error(`[indiamart] scheduled pull failed: ${code || "error"}`);
      pull = { error: code || "error" };
    }
  }

  let routed = null;
  try {
    routed = await routing.routeCompany({ companyId: company, now });
  } catch (err) {
    console.error(`[indiamart] routing pass failed: ${str(err?.code || err?.name || "error")}`);
    routed = { error: str(err?.code || "error") };
  }
  return { pull, routed };
}

/**
 * One scheduled cycle.
 *
 * @returns {Promise<{skipped?:string, pull?:object, routed?:object}>}
 */
async function runCycle({
  now = Date.now,
  env = process.env,
  transport,
  isEnabled = (name) => require("../jobRegistry").isEnabled(name),
} = {}) {
  if (running) return { skipped: "already_running" };
  running = true;
  try {
    if (!(await isEnabled(I.SCHEDULE.JOB_NAME))) return { skipped: "disabled" };
    const companyId = str(env.MARKETING_COMPANY_ID);
    /* Checked before anything is read: no key, no work. */
    if (!sync.keyFor(companyId, env)) return { skipped: "not_configured" };

    const out = await cycleFor({ companyId, env, now, transport, startedBy: "scheduler" });
    try {
      await MarketingLeadSourceState.updateOne(
        { companyId: new mongoose.Types.ObjectId(companyId), source: I.SOURCE },
        { $set: { lastScheduledCycleAt: new Date(now()), lastScheduledCycleOutcome: pullWord(out.pull) } },
        /* Created if absent: a cycle that failed before the pull ever wrote
           the row must still be reported, not silently lost. */
        { upsert: true },
      );
    } catch (_) {
      /* The heartbeat is a report, not the work. */
    }
    return out;
  } catch (err) {
    console.error(`[indiamart] scheduled cycle failed: ${str(err?.code || err?.name || "error")}`);
    return { skipped: "error" };
  } finally {
    running = false;
  }
}

module.exports = { runCycle, cycleFor, pullWord, JOB_NAME: I.SCHEDULE.JOB_NAME };
