#!/usr/bin/env node
// scripts/reporting/migrate.js — apply the reporting-mart migrations.
//
//   npm run reporting:migrate            # plan only (dry run, the default)
//   npm run reporting:migrate -- --apply
//
// Connects as REPORTING_ADMIN_URL (the owner). The sync role cannot run this,
// deliberately: a compromised sync should be able to refill the mart, never
// reshape it.
//
// Never prints a connection string.
"use strict";

const pg = require("../../services/reporting/pgClient");
const migrator = require("../../services/reporting/martMigrate.service");

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log("Reporting mart — migrations");
  console.log(`  mode:   ${APPLY ? "APPLY" : "DRY RUN (plan only)"}`);
  console.log(`  target: ${pg.target("admin")}  as ${pg.role("admin")}`);
  console.log("");

  const { applied, skipped, plan } = await migrator.migrate({ dryRun: !APPLY });

  console.log("");
  if (!APPLY) {
    const outstanding = plan.filter((p) => p.action === "apply");
    console.log(
      outstanding.length
        ? `${outstanding.length} migration(s) outstanding. Re-run with --apply.`
        : "Up to date. Nothing to apply.",
    );
    return outstanding.length ? 0 : 0;
  }
  console.log(`Applied ${applied.length}, skipped ${skipped.length}. Up to date.`);
  return 0;
}

main()
  .then(async (code) => {
    await pg.closeAll();
    process.exit(code);
  })
  .catch(async (err) => {
    // Message only — a driver error object can carry the connection string.
    console.error("Failed:", err && err.message ? err.message : String(err));
    await pg.closeAll();
    process.exit(1);
  });
