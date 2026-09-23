// services/marketing/leads/leadReconciliationScheduler.js
//
// THE HOURLY CHECK AGAINST GOOGLE'S 60-DAY RECORD, AND NOTHING MORE.
//
// ── USEFUL THE MOMENT THERE IS SOMETHING TO CHECK ──────────────────────────
// Registered at boot and idle until a company has an ACTIVE lead-form binding
// (bound, with a known campaign). No configuration switch has to be flipped
// when paused external creation arrives: the first bound form is simply found.
//
// ── SEPARATE FROM THE INTERNAL-PROCESSING SWEEP ────────────────────────────
// `leadRecovery.service` finishes processing GRAV already owes for enquiries it
// already holds; it never contacts Google. This fetches enquiries GRAV does not
// hold. Different failures, different jobs, different switches.
//
// ── BOUNDED, ISOLATED, NEVER FATAL ──────────────────────────────────────────
//   - one cycle at a time in this process, and one run per company across
//     every process (the company lease in `reconcileCompany`);
//   - a bounded number of companies per cycle, bindings per company, pages and
//     new rows per binding;
//   - one company's failure is logged by code and the next company runs;
//   - nothing is thrown out of a cycle, and nothing loops.
"use strict";

const secrets = require("../channels/channelSecrets");
const googleApi = require("../../../constants/marketingGoogleAdsApi");
const reconciliation = require("./leadReconciliation.service");

const str = (v) => String(v ?? "").trim();

const JOB_NAME = "marketing-lead-reconciliation";
const MAX_COMPANIES_PER_CYCLE = 25;

let running = false;

/**
 * One scheduled cycle.
 *
 * @param {object}   [args]
 * @param {Date}     [args.now]
 * @param {object}   [args.env]
 * @param {Function} [args.isEnabled]   the job-registry switch (injectable)
 * @param {Function} [args.reconcile]   the reconciler (injectable; defaults to THE one)
 * @returns {Promise<{skipped?:string, companies:number, succeeded:number, failed:number}>}
 */
async function runCycle({
  now = new Date(),
  env = process.env,
  isEnabled = (name) => require("../../jobRegistry").isEnabled(name),
  reconcile = reconciliation.reconcileCompany,
} = {}) {
  if (running) return { skipped: "already_running", companies: 0, succeeded: 0, failed: 0 };
  running = true;
  try {
    if (!(await isEnabled(JOB_NAME))) return { skipped: "disabled", companies: 0, succeeded: 0, failed: 0 };

    /* ── NO GOOGLE ACCESS CONFIGURED: ASK NOBODY ───────────────────────────
       Checked by variable NAME, before any company is read or any request is
       built. A deployment without a Google connection is not a failure. */
    if (!secrets.presence("google_ads", env).configured) {
      return { skipped: "not_configured", companies: 0, succeeded: 0, failed: 0 };
    }
    if (!googleApi.isSupported(googleApi.resolveVersionSafe(env), now)) {
      return { skipped: "api_version_rejected", companies: 0, succeeded: 0, failed: 0 };
    }

    /* Companies with nothing bound are never visited. */
    const companies = (await reconciliation.companiesWithActiveBindings()).slice(0, MAX_COMPANIES_PER_CYCLE);

    let succeeded = 0;
    let failed = 0;
    for (const companyId of companies) {
      try {
        await reconcile({ companyId, startedBy: "scheduler", now, env });
        succeeded += 1;
      } catch (err) {
        /* By code only: no contact detail, provider message or id reaches a log. */
        failed += 1;
        console.error(`[lead-reconciliation] scheduled company run failed: ${str(err?.code || "error")}`);
      }
    }
    return { companies: companies.length, succeeded, failed };
  } catch (err) {
    console.error(`[lead-reconciliation] scheduled cycle failed: ${str(err?.code || "error")}`);
    return { skipped: "error", companies: 0, succeeded: 0, failed: 0 };
  } finally {
    running = false;
  }
}

module.exports = { runCycle, JOB_NAME, MAX_COMPANIES_PER_CYCLE };
