#!/usr/bin/env node
// scripts/reporting/sync.js — refresh the Accounting reporting mart from MongoDB.
//
//   npm run reporting:sync -- --full
//   npm run reporting:sync -- --full --company=<id>,<id>
//
// `--full` is required and is currently the only mode. Incremental sync,
// schedulers, change streams and deletion tombstones are a LATER slice
// (docs/decisions/accounting-metabase-self-service-reporting.md §8, slice 5);
// demanding the flag now means the command does not silently change meaning
// when they arrive.
//
// Exit codes:  0 every company reconciled   1 at least one failed   2 refused
//
// Never prints a connection string, a password, or any source document.
"use strict";

const mongoose = require("mongoose");

const pg = require("../../services/reporting/pgClient");
const sync = require("../../services/reporting/martSync.service");

const FULL = process.argv.includes("--full");
const companyArg = process.argv.find((a) => a.startsWith("--company="));
const COMPANY_IDS = companyArg
  ? companyArg.slice("--company=".length).split(",").map((s) => s.trim()).filter(Boolean)
  : null;

/** host/database only, never the credentials. */
function describeMongo(uri) {
  try {
    const u = new URL(String(uri).replace(/\/\/[^@]*@/, "//"));
    return `${u.host}/${(u.pathname || "").replace(/^\//, "") || "(default)"}`;
  } catch {
    return "(unparseable)";
  }
}

async function main() {
  console.log("Accounting reporting mart — full sync");

  if (!FULL) {
    console.log("");
    console.log("REFUSED: --full is required.");
    console.log("  This step is full-refresh only. Incremental sync and deletion handling");
    console.log("  are a later slice, and the flag is what keeps this command's meaning");
    console.log("  stable when they arrive.");
    console.log("");
    console.log("  npm run reporting:sync -- --full");
    return 2;
  }

  for (const kind of ["sync"]) {
    if (!pg.isConfigured(kind)) {
      console.log(`REFUSED: ${pg.VARIABLES[kind]} is not set.`);
      return 2;
    }
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.log("REFUSED: MONGODB_URI is not set.");
    return 2;
  }

  console.log(`  source: ${describeMongo(uri)}`);
  console.log(`  mart:   ${pg.target("sync")}  as ${pg.role("sync")}`);
  if (COMPANY_IDS) console.log(`  scope:  ${COMPANY_IDS.length} named company/companies`);
  console.log("");

  await mongoose.connect(uri, { autoIndex: false });

  try {
    const result = await sync.fullSync({ companyIds: COMPANY_IDS });

    console.log("");
    console.log("─".repeat(72));
    let failed = 0;
    for (const r of result.results) {
      const s = r.sourceCounts || {};
      const m = r.martCounts || {};
      console.log(
        `${r.status === "succeeded" ? "OK    " : "FAILED"}  ${r.companyName}`,
      );
      console.log(
        `        source  groups=${s.groups} ledgers=${s.ledgers} vouchers=${s.vouchers} lines=${s.voucherLines}`,
      );
      if (r.status === "succeeded") {
        console.log(
          `        mart    groups=${m.groups} ledgers=${m.ledgers} vouchers=${m.vouchers} lines=${m.voucherLines}`,
        );
        for (const w of r.reconciliation?.warnings || []) {
          console.log(`        WARNING ${w.warning} (${w.count})`);
        }
      } else {
        failed += 1;
        console.log(`        reason  ${r.failureReason}`);
        for (const c of r.reconciliation?.checks || []) {
          if (!c.ok) console.log(`        check   ${c.check}: ${JSON.stringify(c).slice(0, 400)}`);
        }
      }
    }
    console.log("─".repeat(72));
    console.log(
      failed
        ? `${failed} of ${result.results.length} company/companies FAILED and were rolled back. ` +
            "Their previous data is still current."
        : `All ${result.results.length} company/companies reconciled and committed.`,
    );
    return failed ? 1 : 0;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then(async (code) => { await pg.closeAll(); process.exit(code); })
  .catch(async (err) => {
    console.error("Failed:", err && err.message ? err.message : String(err));
    if (err && err.code) console.error("  code:", err.code);
    if (err && err.missing) console.error("  companies without an owner:", err.missing.join(", "));
    if (err && err.ambiguous) console.error("  ambiguous ownership:", JSON.stringify(err.ambiguous));
    await pg.closeAll();
    process.exit(1);
  });
