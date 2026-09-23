#!/usr/bin/env node
//
// scripts/marketing/mautic-register-acquisition.js
//
// THE SUPPORTED WAY TO REGISTER ACQUISITION AUTOMATION.
//
//   node -r dotenv/config scripts/marketing/mautic-register-acquisition.js
//   node -r dotenv/config scripts/marketing/mautic-register-acquisition.js --check
//
// ── WHY A SCRIPT AND NOT JUST TWO ENVIRONMENT VARIABLES ────────────────────
// Because editing `MAUTIC_ACQUISITION_SEGMENTS` and
// `MAUTIC_ACQUISITION_CAMPAIGNS` declares an intention and changes nothing in
// Mautic. The thing that actually stops a held person re-entering acquisition is
// a `grav_acquisition_hold != 1` filter on each registered segment, and until
// something installs it the configured scope is unenforced — while every GRAV
// read would have said the hold was applied.
//
// So registration is an operation with a completion condition, and this script
// is it. It:
//
//   1. resolves every configured segment and campaign against the instance;
//   2. installs the exclusion on every acquisition segment that lacks it;
//   3. reads every filter back;
//   4. verifies acquisition campaigns draw only from registered segments;
//   5. reconciles existing applied holds against the newly registered scope;
//   6. and only then prints READY.
//
// `--check` runs the read-only inspection instead, which is the same thing the
// Marketing health endpoint reports.
//
// ── WHAT IT CANNOT PROMISE ─────────────────────────────────────────────────
// It cannot stop somebody creating a campaign in Mautic's own interface and
// never registering it. Mautic offers no veto an outside application could use.
// Unregistered automation is configuration drift, and this script LISTS it so a
// person can decide, rather than letting it pass for covered.
"use strict";

const mongoose = require("mongoose");

const registration = require("../../services/marketing/acquisitionRegistration.service");
const acquisitionHold = require("../../services/marketing/acquisitionHold.service");

const str = (v) => String(v ?? "").trim();
const CHECK_ONLY = process.argv.includes("--check");

function say(label, state, detail = "") {
  const pad = `[${state}]`.padEnd(9);
  console.log(`  ${pad} ${label}${detail ? ` — ${detail}` : ""}`);
}

(async () => {
  const declared = acquisitionHold.declaredScope(process.env);
  console.log(`\n${CHECK_ONLY ? "Checking" : "Registering"} GRAV acquisition scope`);
  console.log(`  segments   ${declared.segments.join(", ") || "(none declared)"}`);
  console.log(`  campaigns  ${declared.campaigns.join(", ") || "(none declared)"}\n`);

  if (CHECK_ONLY) {
    const report = await registration.inspect({});
    say("configured", report.configured ? "yes" : "no");
    if (report.unguardedSegments?.length) {
      say("unguarded segments", "FAIL", report.unguardedSegments.join(", "));
    }
    for (const c of report.unguardedCampaignSources || []) {
      say(`campaign ${c.campaignId}`, "FAIL", `draws from unregistered segment(s) ${c.sources.join(", ")}`);
    }
    const drift = report.unregisteredAutomation || { segments: [], campaigns: [] };
    say("unregistered automation", drift.segments.length || drift.campaigns.length ? "DRIFT" : "none",
      `${drift.segments.length} segment(s), ${drift.campaigns.length} campaign(s) GRAV makes no guarantee about`);
    say("acquisition scope", report.ready ? "READY" : "NOT READY", report.reason);
    process.exit(report.ready ? 0 : 1);
  }

  /* The hold reconciliation reads and writes GRAV's own records, so this half
     needs the database. `--check` does not. */
  const uri = str(process.env.MONGODB_URI);
  if (!uri) {
    console.error("  MONGODB_URI is not set, and reconciling existing holds against the new scope needs it.");
    console.error("  Run with --check to inspect Mautic only.");
    process.exit(1);
  }
  const companyId = str(process.env.MARKETING_COMPANY_ID);
  if (!companyId) {
    console.error("  MARKETING_COMPANY_ID is not set. One Mautic instance serves one GRAV organisation (ADR-004),");
    console.error("  and reconciling its holds needs to know which.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const report = await registration.register({
    companyId: new mongoose.Types.ObjectId(companyId),
    /* Resuming a truncated reconciliation, when a previous run said to. */
    holdCursor: str(process.env.MAUTIC_ACQUISITION_HOLD_CURSOR) || null,
  });

  if (report.scope) {
    say("resolved", "ok",
      `${report.scope.segments.length} segment(s): ${report.scope.segments.map((s) => `${s.id}/${s.alias}`).join(", ") || "none"}`);
    say("resolved", "ok",
      `${report.scope.campaigns.length} campaign(s): ${report.scope.campaigns.map((c) => `${c.id}/${c.alias}`).join(", ") || "none"}`);
  }
  if (report.guardedSegments.length) {
    say("exclusion filter", "ok", `verified on segment(s) ${report.guardedSegments.join(", ")}`);
  }
  if (report.exclusionsAdded.length) {
    say("exclusion filter", "added", `installed on segment(s) ${report.exclusionsAdded.join(", ")}`);
  }
  if (report.campaignsVerified.length) {
    say("campaign sources", "ok", `campaign(s) ${report.campaignsVerified.join(", ")} draw only from registered segments`);
  }
  const rec = report.holdsReconciled;
  const recState = rec.failed ? "FAIL" : (rec.complete ? "ok" : "INCOMPLETE");
  say("existing holds", recState,
    `${rec.examined} examined, ${rec.corrected} corrected against the new scope, ${rec.alreadyClean} already clean, ${rec.failed} failed`
    + (rec.complete ? "" : " — NOT every applied hold was checked"));

  const drift = report.unregisteredAutomation;
  say("unregistered automation", drift.segments.length || drift.campaigns.length ? "DRIFT" : "none",
    `${drift.segments.length} segment(s), ${drift.campaigns.length} campaign(s) nobody registered. `
    + "GRAV guarantees registered acquisition automation only.");

  for (const p of report.problems) say("problem", "FAIL", `${p.code}: ${p.message}`);

  /* ── READY IS PRINTED ONLY WHEN EVERYTHING WAS CHECKED ──────────────────
     Both conditions, deliberately. A report with `ready` true and `complete`
     false should be impossible, and if one ever appears this line refuses it
     rather than printing the word an operator would act on. */
  const sayReady = report.ready && report.complete;
  say("acquisition scope", sayReady ? "READY" : "NOT READY",
    sayReady ? "" : "Nothing above may be treated as registered.");
  if (report.continuation?.holdCursor) {
    console.log(`
  The applied-hold reconciliation did not finish. Continue it with:

    MAUTIC_ACQUISITION_HOLD_CURSOR=${report.continuation.holdCursor} \
      node -r dotenv/config scripts/marketing/mautic-register-acquisition.js
`);
  }

  await mongoose.disconnect();
  process.exit(sayReady ? 0 : 1);
})().catch(async (err) => {
  console.error(`\n  ABORTED: ${err?.message || err}`);
  try { await mongoose.disconnect(); } catch { /* nothing to close */ }
  process.exit(1);
});
