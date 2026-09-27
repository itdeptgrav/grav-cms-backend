#!/usr/bin/env node
// scripts/reporting/roles.js — create/refresh the two mart roles.
//
//   npm run reporting:roles -- --apply
//
// Runs migrations/reporting/roles/R__roles.sql as the owner, binding both
// passwords at run time from the environment:
//
//   REPORTING_SYNC_PASSWORD      for reporting_sync
//   REPORTING_READONLY_PASSWORD  for metabase_reader
//
// **No password is written to any file.** They are bound as query parameters
// through `format('%L')` so a password containing a quote cannot break out of
// the statement, and neither value is ever printed or logged.
"use strict";

const fs = require("fs");
const path = require("path");

const pg = require("../../services/reporting/pgClient");

const APPLY = process.argv.includes("--apply");
const SQL_PATH = path.join(__dirname, "..", "..", "migrations", "reporting", "roles", "R__roles.sql");

async function main() {
  console.log("Reporting mart — roles");
  console.log(`  mode:   ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(`  target: ${pg.target("admin")}  as ${pg.role("admin")}`);

  const syncPassword = process.env.REPORTING_SYNC_PASSWORD;
  const readerPassword = process.env.REPORTING_READONLY_PASSWORD;
  const missing = [
    !syncPassword && "REPORTING_SYNC_PASSWORD",
    !readerPassword && "REPORTING_READONLY_PASSWORD",
  ].filter(Boolean);
  if (missing.length) {
    console.log(`REFUSED: ${missing.join(" and ")} not set.`);
    return 2;
  }

  const raw = fs.readFileSync(SQL_PATH, "utf8");
  const dbName = (await pg.query("admin", "SELECT current_database() AS db")).rows[0].db;

  /* psql's :'var' syntax is a psql feature, not a server one, so the file is
     rendered here. Every substitution goes through `quote_literal` /
     `quote_ident` on the server via format(), so a password or database name
     containing a quote cannot break out of the statement. */
  const { rows } = await pg.query(
    "admin",
    "SELECT quote_literal($1) AS sync_pw, quote_literal($2) AS reader_pw, quote_ident($3) AS db_ident",
    [syncPassword, readerPassword, dbName],
  );
  const sql = raw
    .replace(/\\set ON_ERROR_STOP on\s*/g, "")
    .replace(/:'sync_password'/g, rows[0].sync_pw)
    .replace(/:'reader_password'/g, rows[0].reader_pw)
    .replace(/:"db_name"/g, rows[0].db_ident);

  console.log(`  database: ${dbName}`);
  console.log("");

  if (!APPLY) {
    console.log("Dry run. Re-run with --apply to create/refresh reporting_sync and metabase_reader.");
    return 0;
  }

  await pg.query("admin", sql);

  const { rows: after } = await pg.query(
    "admin",
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname IN ('reporting_sync','metabase_reader') ORDER BY rolname`,
  );
  for (const r of after) {
    console.log(
      `  ${r.rolname.padEnd(16)} superuser=${r.rolsuper} createdb=${r.rolcreatedb} createrole=${r.rolcreaterole}`,
    );
  }
  console.log("");
  console.log("Applied. Prove it with: npm run reporting:verify-roles");
  return 0;
}

main()
  .then(async (code) => { await pg.closeAll(); process.exit(code); })
  .catch(async (err) => {
    console.error("Failed:", err && err.message ? err.message : String(err));
    await pg.closeAll();
    process.exit(1);
  });
