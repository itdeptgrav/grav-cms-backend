// services/marketing/mauticHealth.service.js
//
// THREE SEPARATE QUESTIONS, THREE SEPARATE ANSWERS.
//
// ── WHY IT IS NOT ONE BOOLEAN ──────────────────────────────────────────────
// "Is Mautic up" is four different problems wearing one word, and each needs a
// different person:
//
//   configuration  a secret is missing or malformed          → whoever deploys
//   reachability   nothing answered on the network           → whoever operates
//   authentication Mautic answered and refused GRAV          → whoever admins Mautic
//   api            Mautic answered, authenticated, and the
//                  integration user lacks a permission       → whoever admins Mautic
//
// Collapsing them into `{healthy:false}` sends every one of those people to
// look at the same dashboard and find nothing. So each is reported by name,
// with the check that established it.
//
// ── AND UNKNOWN IS NOT ZERO ────────────────────────────────────────────────
// Every count in this report is `null` when it could not be read, never `0`.
// The product plan says it twice — "Never report a failed or unavailable
// Mautic read as zero" and "Mautic downtime renders unavailable states rather
// than false zeroes" — and a health endpoint is the one place most likely to
// break the rule, because a dashboard wants a number and `0` fits.
//
// ── THE DATABASE IS CHECKED THROUGH MAUTIC, NOT AROUND IT ──────────────────
// GRAV holds no MariaDB credential and has no network route to it (see
// `deploy/mautic/docker-compose.yml` — the database is on a network with no
// published port). So the database's health is inferred from a Mautic API read
// that cannot succeed without it, and this report says that is what it is. A
// direct connection would have been a better signal and a worse boundary, and
// ADR-004 settles which of those wins.
"use strict";

const { MauticClient, readConfig } = require("./mauticClient");

const str = (v) => String(v ?? "").trim();

const UNKNOWN = Object.freeze({ state: "unknown", detail: "", checkedAt: null });

/**
 * @param {object} opts.client  an injected client (the double, in tests)
 * @returns {Promise<{healthy:boolean, checks:object, version:string|null, segmentCount:number|null}>}
 */
async function check({ client = null, env = process.env } = {}) {
  const startedAt = new Date();
  const report = {
    healthy: false,
    checkedAt: startedAt.toISOString(),
    baseUrl: readConfig(env).baseUrl || null,
    checks: {
      configuration: { ...UNKNOWN },
      reachability: { ...UNKNOWN },
      authentication: { ...UNKNOWN },
      api: { ...UNKNOWN },
      database: { ...UNKNOWN },
      /* Chunk 3B. Whether the REGISTERED acquisition automation is actually
         enforced in Mautic, which no other check would notice. */
      acquisitionScope: { ...UNKNOWN },
    },
    /* null, never 0 — see the header. */
    segmentCount: null,
    durationMs: null,
  };

  const finish = () => {
    report.durationMs = Date.now() - startedAt.getTime();
    /* `not_configured` is a legitimate state for acquisition scope and does not
       fail health; `unknown` means a check never ran, which does. Anything
       that actively failed fails. */
    report.healthy = Object.values(report.checks)
      .every((c) => c.state === "ok" || c.state === "not_configured");
    return report;
  };

  const stamp = (name, state, detail = "") => {
    report.checks[name] = { state, detail: str(detail), checkedAt: new Date().toISOString() };
  };

  /* ── 1. CONFIGURATION ──────────────────────────────────────────────────── */
  const config = readConfig(env);
  if (!config.configured) {
    stamp("configuration", "failed", config.problems.join(" "));
    /* Everything after this is genuinely unknown, not failing. Reporting the
       later checks as failures would send somebody to look at Mautic when the
       fix is an environment variable here. */
    return finish();
  }
  stamp("configuration", "ok", `${config.mode} auth against ${config.baseUrl}`);

  const mautic = client || new MauticClient({ env });

  /* ── 2 & 3. REACHABILITY AND AUTHENTICATION ────────────────────────────
     One call establishes both, and its failure mode says which one broke:
     a transport error never reached Mautic; a 401 means it answered. */
  let segments;
  try {
    segments = await mautic.listSegments();
    stamp("reachability", "ok", "Mautic answered.");
    stamp("authentication", "ok", "GRAV's credentials were accepted.");
  } catch (err) {
    const code = str(err?.code);
    if (code === "MAUTIC_AUTH_FAILED") {
      stamp("reachability", "ok", "Mautic answered.");
      stamp("authentication", "failed", err.message);
    } else {
      stamp("reachability", "failed", err.message || "Mautic could not be reached.");
      stamp("authentication", "unknown", "Not checked — Mautic did not answer.");
    }
    stamp("api", "unknown", "Not checked.");
    stamp("database", "unknown", "Not checked — it is only visible through a successful Mautic read.");
    return finish();
  }

  /* ── 4. THE API SURFACE THIS INTEGRATION USES ──────────────────────────
     A segment list proves the integration user can read segments. If the
     least-privilege role was cut too far, this is where it shows. */
  report.segmentCount = segments.length;
  stamp("api", "ok", `${segments.length} segment${segments.length === 1 ? "" : "s"} readable.`);

  /* ── 5. MAUTIC'S DATABASE, INFERRED ────────────────────────────────────
     A segment list is served from MariaDB. It answering means the database
     answered. This is a weaker signal than a direct connection and the detail
     says so, rather than claiming a check that did not happen. */
  stamp("database", "ok", "Inferred: Mautic served a database-backed read. GRAV holds no direct database access by design.");

  /* ── 6. IS THE CONFIGURED ACQUISITION SCOPE ACTUALLY ENFORCED? ───────────
     A configured scope that Mautic does not enforce used to read as healthy.
     It is the most dangerous state the integration has: acceptance believes it
     can stop acquisition for one person, and the segment nobody guarded will
     enrol them again on the next rebuild.

     Reported as its own check so `healthy` is false while that is true. An
     UNCONFIGURED scope is reported separately and does NOT fail health: an
     instance with no acquisition automation registered is a legitimate state
     before Chunk 3 is switched on, and the acceptance path refuses loudly
     rather than guessing. */
  try {
    /* Required here rather than at the top of the file: the registration
       service reads holds and audit rows, which this module otherwise has no
       business loading, and the cycle would be real if it did. */
    const registration = require("./acquisitionRegistration.service");
    const scope = await registration.inspect({ client: mautic, env });
    report.acquisitionScope = scope;
    if (!scope.configured) {
      stamp("acquisitionScope", "not_configured", scope.reason);
    } else if (!scope.ready) {
      stamp("acquisitionScope", "failed", scope.reason);
    } else {
      const drift = scope.unregisteredAutomation;
      stamp("acquisitionScope", "ok",
        `${scope.scope.segments.length} segment(s) and ${scope.scope.campaigns.length} campaign(s) registered and enforced. `
        + `${drift.segments.length} segment(s) and ${drift.campaigns.length} campaign(s) in this instance are unregistered — GRAV makes no guarantee about those.`);
    }
  } catch (err) {
    stamp("acquisitionScope", "failed", str(err?.message));
  }

  return finish();
}

/**
 * The webhook side of health, which no outbound call can answer.
 *
 * A secret that is set is not a webhook that works, and this deliberately
 * reports "configured" rather than "ok": the only proof a webhook is wired up
 * is a delivery that arrived, so `lastEventAt` is what an operator should
 * actually read.
 */
async function webhookState({ companyId, env = process.env } = {}) {
  const secretSet = Boolean(str(env.MAUTIC_WEBHOOK_SECRET));
  const out = {
    secret: secretSet ? "configured" : "missing",
    companyConfigured: Boolean(str(env.MARKETING_COMPANY_ID)),
    lastEventAt: null,
    eventCount: null,
  };
  if (!companyId) return out;

  try {
    const { MarketingIntentEvent } = require("../../models/CMS_Models/Marketing/MarketingEvent");
    const [latest, count] = await Promise.all([
      MarketingIntentEvent.findOne({ companyId }).sort({ receivedAt: -1 }).select("receivedAt").lean(),
      MarketingIntentEvent.countDocuments({ companyId }),
    ]);
    out.lastEventAt = latest?.receivedAt ? latest.receivedAt.toISOString() : null;
    out.eventCount = count;
  } catch (err) {
    /* Left null. A ledger read that failed is not a ledger with nothing in
       it, and the two must not share a rendering. */
    console.error("[mautic] webhook state could not be read:", str(err?.message));
  }
  return out;
}

module.exports = { check, webhookState };
