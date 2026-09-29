#!/usr/bin/env node
// scripts/migrations/accounting-company-ownership-index.js
//
// READINESS CHECK AND MIGRATION for decision D2 — one Accounting company has
// exactly one `Acc_Organization` owner.
//
// The invariant is enforced by a unique multikey index on
// `acc_organizations.tallyCompanyIds`. `autoIndex` is off in production
// (server.js:782), so production gets the index from here.
//
//   node -r dotenv/config scripts/migrations/accounting-company-ownership-index.js
//   node -r dotenv/config scripts/migrations/accounting-company-ownership-index.js --apply
//
// DRY RUN IS THE DEFAULT. Without `--apply` this reads and reports; it creates
// nothing and changes nothing.
//
// ─── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It will not pick an owner. If two organisations both list a company, which
// one is right is a question about the business — who has been invoicing under
// that company — and answering it by rule (lowest id, oldest document, longest
// array) would silently transfer real books between tenants. It reports the
// conflict and stops.
//
// It also refuses to build the index while any conflict exists, rather than
// letting MongoDB fail the build halfway and leave the operator guessing.
//
// It never prints the connection string or any credential.

"use strict";

const mongoose = require("mongoose");

const {
  OWNERSHIP_INDEX_NAME,
  OWNERSHIP_INDEX_SPEC,
  OWNERSHIP_INDEX_OPTIONS,
  findOwnershipConflicts,
} = require("../../services/accountantCompanyOwnership.service");

const APPLY = process.argv.includes("--apply");

/** Host and database only — never the credentials or the full URI. */
function describeTarget(uri) {
  try {
    const withoutCreds = String(uri).replace(/\/\/[^@]*@/, "//");
    const u = new URL(withoutCreds);
    const db = (u.pathname || "").replace(/^\//, "") || "(default)";
    return `${u.protocol}//${u.host}/${db}`;
  } catch {
    return "(unparseable connection target)";
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";

  console.log("Accounting company-ownership index — decision D2");
  console.log(`  mode:   ${APPLY ? "APPLY (will create the index)" : "DRY RUN (reads only)"}`);
  console.log(`  target: ${describeTarget(uri)}`);
  console.log("");

  await mongoose.connect(uri, { autoIndex: false });

  try {
    const collection = mongoose.connection.db.collection("acc_organizations");

    // ── 1. Current state ────────────────────────────────────────────────────
    const organizations = await collection.countDocuments({});
    const owning = await collection.countDocuments({
      tallyCompanyIds: { $type: "objectId" },
    });
    console.log(`Organizations: ${organizations} (${owning} own at least one company)`);

    const existing = (await collection.indexes()).find((i) => i.name === OWNERSHIP_INDEX_NAME);
    console.log(
      existing
        ? `Index "${OWNERSHIP_INDEX_NAME}": present (unique=${!!existing.unique})`
        : `Index "${OWNERSHIP_INDEX_NAME}": absent`,
    );
    console.log("");

    // ── 2. Conflicts ────────────────────────────────────────────────────────
    const conflicts = await findOwnershipConflicts();

    if (conflicts.length > 0) {
      console.log(`CONFLICTS: ${conflicts.length} company/companies are held by more than one organization.`);
      console.log("");
      for (const c of conflicts) {
        console.log(`  company ${c.companyId}`);
        for (const orgId of c.organizationIds) console.log(`    claimed by organization ${orgId}`);
      }
      console.log("");
      console.log("Not resolving these. Which organization should keep a company is a");
      console.log("business question — deciding it by rule would move real books between");
      console.log("tenants. Remove the company from the organizations that should not");
      console.log("hold it, then run this again.");
      console.log("");
      console.log(APPLY ? "REFUSING to create the index while conflicts exist." : "Dry run complete.");
      return 1;
    }

    console.log("CONFLICTS: none. Every owned company belongs to exactly one organization.");
    console.log("");

    // ── 3. Apply ────────────────────────────────────────────────────────────
    if (!APPLY) {
      console.log(
        existing
          ? "Dry run complete. The index already exists; --apply would verify it."
          : "Dry run complete. Re-run with --apply to create the index.",
      );
      return 0;
    }

    if (existing) {
      const matches =
        existing.unique === true &&
        JSON.stringify(existing.key) === JSON.stringify(OWNERSHIP_INDEX_SPEC) &&
        JSON.stringify(existing.partialFilterExpression) ===
          JSON.stringify(OWNERSHIP_INDEX_OPTIONS.partialFilterExpression);

      if (matches) {
        console.log(`Index "${OWNERSHIP_INDEX_NAME}" already matches the expected definition. Nothing to do.`);
        return 0;
      }
      console.log(`Index "${OWNERSHIP_INDEX_NAME}" exists but does NOT match the expected definition:`);
      console.log(`  found:    ${JSON.stringify({ key: existing.key, unique: existing.unique, partialFilterExpression: existing.partialFilterExpression })}`);
      console.log(`  expected: ${JSON.stringify({ key: OWNERSHIP_INDEX_SPEC, unique: true, partialFilterExpression: OWNERSHIP_INDEX_OPTIONS.partialFilterExpression })}`);
      console.log("Drop it deliberately and re-run. Not dropping it here — an index this");
      console.log("script did not create is one somebody else may be relying on.");
      return 1;
    }

    console.log(`Creating index "${OWNERSHIP_INDEX_NAME}"...`);
    await collection.createIndex(OWNERSHIP_INDEX_SPEC, OWNERSHIP_INDEX_OPTIONS);

    const created = (await collection.indexes()).find((i) => i.name === OWNERSHIP_INDEX_NAME);
    if (!created) {
      console.log("Index creation reported success but the index is not present. Investigate.");
      return 1;
    }
    console.log("Created and verified.");
    return 0;
  } finally {
    await mongoose.disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Message only — a stack or a driver error object can carry the URI.
    console.error("Failed:", err && err.message ? err.message : String(err));
    process.exit(1);
  });
