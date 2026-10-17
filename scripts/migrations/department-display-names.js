#!/usr/bin/env node
/**
 * scripts/migrations/department-display-names.js
 *
 * ONE SPELLING FOR EVERY APP: DEPARTMENT NAMES, NOT JOB TITLES.
 *
 * The tiles on onboarding and in the switcher read `access_departments.name`.
 * Rows seeded long ago carry the job of the person who used to log in
 * ("Cutting Master", "Production Supervisor", "merchandiser") rather than the
 * department they belong to. This renames those rows, and only those.
 *
 * ── A DRY RUN BY DEFAULT ──────────────────────────────────────────────────
 * Without `--apply` this connects, prints what it would change and writes
 * nothing. `--apply` sets `name` on the matching rows and nothing else — slug,
 * key, roles, logins and every reference stay exactly as they are.
 *
 * ── AN ADMINISTRATOR'S OWN NAME WINS ──────────────────────────────────────
 * A row is renamed only while its name is still one of the old spellings listed
 * below. Anything an administrator has typed since is left alone, so running it
 * twice — or after somebody renames a department in Access Control — is a no-op.
 *
 * The seed (services/ensureAccessDepartments.js) carries the new names, so a
 * fresh database starts with them; this is for databases seeded before.
 *
 *   node -r dotenv/config scripts/migrations/department-display-names.js           # report
 *   node -r dotenv/config scripts/migrations/department-display-names.js --apply   # rename
 */

"use strict";

const mongoose = require("mongoose");

/** key → [the old spellings it may still carry, the department's name]. */
const RENAMES = [
  ["project_manager", ["Project Manager", "Production Manager"], "Production Management"],
  ["merchandiser", ["merchandiser", "Merchandiser"], "Merchandising"],
  ["merchantising_bom", ["merchandiser", "Merchandiser"], "Merchandising BOM"],
  ["mpc", ["MPC Measurement"], "Measurement"],
  ["cutting", ["Cutting Master"], "Cutting"],
  ["prod_supervisor", ["Production Supervisor"], "Production"],
  ["developer", ["Developer"], "IT"],
  ["co_workspace", ["co-workspace", "Co-workspace"], "Cowork"],
];

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  const col = mongoose.connection.collection("access_departments");

  let changed = 0;
  for (const [key, from, to] of RENAMES) {
    const row = await col.findOne({ key }, { projection: { name: 1 } });
    if (!row) {
      console.log(`  ${key}: no such department — skipped`);
      continue;
    }
    if (!from.includes(row.name)) {
      console.log(`  ${key}: "${row.name}" — ${row.name === to ? "already done" : "named by an administrator, left alone"}`);
      continue;
    }
    console.log(`  ${key}: "${row.name}" → "${to}"${apply ? "" : "  (dry run)"}`);
    if (apply) {
      const res = await col.updateOne({ _id: row._id, name: row.name }, { $set: { name: to } });
      changed += res.modifiedCount;
    }
  }
  console.log(apply ? `${changed} department(s) renamed.` : "Dry run — nothing written. Re-run with --apply.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
