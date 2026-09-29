#!/usr/bin/env node
// scripts/reporting/verify-roles.js
//
// PROVE THE METABASE ROLE CANNOT WRITE. Not by reading the grant matrix — by
// ATTEMPTING each forbidden action and requiring it to fail.
//
//   npm run reporting:verify-roles
//
// ── WHY ATTEMPT RATHER THAN INSPECT ─────────────────────────────────────────
// A grant matrix read by eye is exactly how a misconfiguration survives review:
// `GRANT SELECT ON ALL TABLES` looks identical whether or not someone later
// added `ALTER DEFAULT PRIVILEGES … GRANT INSERT`, whether the role inherited
// something through PUBLIC, and whether a new table landed before the revoke
// ran. The only check that cannot be fooled is running the INSERT and being
// refused.
//
// Every attempt runs inside a transaction that is ROLLED BACK regardless, so a
// hole this finds does not also leave a row behind.
//
// Exit codes: 0 all attempts correctly refused   1 something succeeded that
// should not have   2 not configured.
//
// Never prints a connection string or a password.
"use strict";

const { Client } = require("pg");

const pg = require("../../services/reporting/pgClient");
const probes = require("../../services/reporting/readOnlyProbes");

/* The probe list itself lives in services/reporting/readOnlyProbes.js so that
   this script and test/reporting/readonly-role.test.js check the same things.
   Two copies would drift, and the one that drifts is the one that stops
   covering whatever later goes wrong. */

async function main() {
  console.log("Reporting mart — read-only role verification");

  if (!pg.isConfigured("readonly")) {
    console.log(`REFUSED: ${pg.VARIABLES.readonly} is not set.`);
    return 2;
  }
  console.log(`  target: ${pg.target("readonly")}  as ${pg.role("readonly")}`);
  console.log("");

  const client = new Client({ connectionString: process.env.REPORTING_READONLY_URL });
  await client.connect();

  let results = [];
  try {
    const who = await client.query("SELECT current_user, current_database()");
    console.log(`  connected as ${who.rows[0].current_user} to ${who.rows[0].current_database}`);
    console.log("");

    results = await probes.runAll(client);

    /* One probe that needs its own connections rather than a statement: can
       this role open a session on ANY other database in the cluster? The
       maintenance database `postgres` ships with no ACL, so PUBLIC may connect
       unless that is explicitly revoked — which is how this check earned its
       place. */
    const { rows: dbs } = await client.query(
      "SELECT datname FROM pg_database WHERE datname NOT IN ('template0','template1') ORDER BY 1",
    );
    const reachable = [];
    for (const { datname } of dbs) {
      if (datname === who.rows[0].current_database) continue;
      const probe = new Client({
        connectionString: process.env.REPORTING_READONLY_URL.replace(/\/[^/?]+(\?|$)/, `/${datname}$1`),
        connectionTimeoutMillis: 5000,
      });
      try {
        await probe.connect();
        await probe.end();
        reachable.push(datname);
      } catch {
        /* refused — which is the point */
      }
    }
    results.push({
      label: "connect to any other database on this server",
      ok: reachable.length === 0,
      outcome: reachable.length ? `CONNECTED to: ${reachable.join(", ")}` : "refused for every other database",
    });
  } finally {
    await client.end();
  }

  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(46)} ${r.outcome}`);
  }
  console.log("");
  console.log(`${results.length - failures.length}/${results.length} checks passed.`);

  if (failures.length) {
    console.log("");
    console.log("THE METABASE CONNECTION IS NOT READ-ONLY. Do not point Metabase at it.");
    return 1;
  }
  console.log("The Metabase connection can read the approved objects and do nothing else.");
  return 0;
}

main()
  .then(async (code) => { await pg.closeAll(); process.exit(code); })
  .catch(async (err) => {
    console.error("Failed:", err && err.message ? err.message : String(err));
    await pg.closeAll();
    process.exit(1);
  });
