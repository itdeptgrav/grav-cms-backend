#!/usr/bin/env node
// scripts/migrations/accounting-organization-company-repair.js
//
// ASSIGN UNOWNED ACCOUNTING COMPANIES TO AN ORGANISATION.
//
// ─── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// `Acc_Organization.tallyCompanyIds` is the canonical ownership record: the
// company-scope guard refuses anything not on it, and (since the list endpoint
// was scoped) the company picker offers nothing else. An organisation with an
// empty array therefore has a working login and no books at all — the picker is
// empty and every company-scoped request would be refused.
//
// That is the state a local development database lands in when companies were
// created before ownership existed, or when `sync-legacy`'s auto-attach never
// ran. This repairs it.
//
//   node -r dotenv/config scripts/migrations/accounting-organization-company-repair.js \
//     --organization=<orgId>
//
//   node -r dotenv/config scripts/migrations/accounting-organization-company-repair.js \
//     --organization=<orgId> --expect-db=<name> --apply
//
// DRY RUN IS THE DEFAULT. Without `--apply` it reads, reports exactly what it
// would assign, and writes nothing.
//
// ─── THE WRITE GOES THROUGH THE SERVICE ──────────────────────────────────────
// `attachCompaniesToOrganization` in
// services/accountantCompanyOwnership.service.js is the only thing here that
// touches the array. It is all-or-nothing in one `$addToSet … $each`, it
// refuses a company another organisation already holds, and it is idempotent
// for companies this organisation already owns. Writing the array directly from
// a script would be a second ownership path, and the second path is the one
// that does not get the next fix.
//
// ─── WHY SO MANY REFUSALS ────────────────────────────────────────────────────
// This assigns BOOKS to a TENANT. Getting it wrong does not throw — it silently
// hands one organisation's ledgers, invoices and GST filings to another, and
// the only symptom is that the wrong people can read them. So it declines in
// every case where the right answer is not obvious:
//
//   • NODE_ENV=production                    — never runs there
//   • a production-looking database name     — same
//   • `--apply` without `--expect-db`        — the development database is on
//     the same Atlas cluster family as production, so "not localhost" proves
//     nothing. Naming the database you believe you are writing to is the only
//     check that actually distinguishes them, and it costs one flag.
//   • the organisation does not exist        — nothing to repair
//   • more than one organisation exists      — then "the unowned companies"
//     does not identify an owner. Which tenant gets which books is a business
//     question; answering it by rule is exactly the silent transfer above.
//   • a target company is owned elsewhere    — refused by the service, and
//     reported by name here before it is attempted
//
// It never prints the connection string or any credential.
//
// ─── IDEMPOTENT ──────────────────────────────────────────────────────────────
// Re-running after a successful apply finds nothing unowned, reports "nothing
// to do" and exits 0. Re-running with an explicit `--companies` list that is
// already owned by this organisation is a no-op for the same reason.

"use strict";

const mongoose = require("mongoose");

const {
  attachCompaniesToOrganization,
  findOwnershipConflicts,
  OWNERSHIP_INDEX_NAME,
} = require("../../services/accountantCompanyOwnership.service");

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

/** A database name that must never be written to by this script. */
const PRODUCTION_DB_NAMES = /^(prod|production|live|grav[_-]?prod)$/i;

function flag(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : null;
}

const APPLY = process.argv.includes("--apply");
const ORGANIZATION_ID = flag("organization");
const EXPECT_DB = flag("expect-db");
const COMPANIES = flag("companies");

/** Host and database only — never the credentials or the full URI. */
function describeTarget(uri) {
  try {
    const withoutCreds = String(uri).replace(/\/\/[^@]*@/, "//");
    const u = new URL(withoutCreds);
    const db = (u.pathname || "").replace(/^\//, "") || "(driver default)";
    return `${u.protocol}//${u.host}/${db}`;
  } catch {
    return "(unparseable connection target)";
  }
}

function usage() {
  console.log("Assign unowned Accounting companies to an organisation.");
  console.log("");
  console.log("  --organization=<id>   REQUIRED. The Acc_Organization to assign to.");
  console.log("  --companies=<a,b,c>   Optional. Defaults to every ACTIVE company");
  console.log("                        that no organisation currently owns.");
  console.log("  --expect-db=<name>    The database you believe you are writing to.");
  console.log("                        REQUIRED with --apply.");
  console.log("  --apply               Write. Without it this is a dry run.");
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";

  console.log("Accounting organisation → company ownership repair");
  console.log(`  mode:   ${APPLY ? "APPLY (will write)" : "DRY RUN (reads only)"}`);
  console.log(`  target: ${describeTarget(uri)}`);
  console.log("");

  // ── Refusals that need no database ──────────────────────────────────────
  if (process.env.NODE_ENV === "production") {
    console.log("REFUSED: NODE_ENV=production. Ownership is not repaired by script in production.");
    return 2;
  }

  if (!ORGANIZATION_ID) {
    console.log("REFUSED: --organization=<id> is required.");
    console.log("");
    usage();
    return 2;
  }
  if (!OBJECT_ID_RE.test(ORGANIZATION_ID)) {
    console.log(`REFUSED: "${ORGANIZATION_ID}" is not a valid organisation id.`);
    return 2;
  }
  if (APPLY && !EXPECT_DB) {
    console.log("REFUSED: --apply requires --expect-db=<name>.");
    console.log("");
    console.log("  The development database sits on the same kind of hosted cluster as");
    console.log("  production, so the connection target alone does not tell them apart.");
    console.log("  Name the database you believe you are writing to and this will check it.");
    return 2;
  }

  await mongoose.connect(uri, { autoIndex: false });

  try {
    const dbName = mongoose.connection.name;
    console.log(`Connected to database: ${dbName}`);

    if (PRODUCTION_DB_NAMES.test(dbName)) {
      console.log(`REFUSED: "${dbName}" is a production database name.`);
      return 2;
    }
    if (EXPECT_DB && EXPECT_DB !== dbName) {
      console.log(`REFUSED: connected to "${dbName}" but --expect-db said "${EXPECT_DB}".`);
      console.log("  One of the two is wrong, and this script is not the place to find out which.");
      return 2;
    }
    console.log("");

    const orgs = mongoose.connection.db.collection("acc_organizations");
    const companiesColl = mongoose.connection.db.collection("acc_companies");

    // ── One organisation only ─────────────────────────────────────────────
    const orgCount = await orgs.countDocuments({});
    const allOrgs = await orgs.find({}).project({ name: 1, tallyCompanyIds: 1 }).toArray();

    if (orgCount === 0) {
      console.log("REFUSED: this database has no organisations at all.");
      return 2;
    }
    if (orgCount > 1) {
      console.log(`REFUSED: ${orgCount} organisations exist in this database:`);
      for (const o of allOrgs) {
        console.log(`    ${o._id}  ${o.name}  (owns ${(o.tallyCompanyIds || []).length})`);
      }
      console.log("");
      console.log("  \"The unowned companies\" does not identify an owner when there is more");
      console.log("  than one candidate. Assign them explicitly with --companies, against a");
      console.log("  database where the answer is not in doubt.");
      return 2;
    }

    // ── The organisation ──────────────────────────────────────────────────
    const organization = allOrgs[0];
    if (String(organization._id) !== ORGANIZATION_ID) {
      console.log(`REFUSED: no organisation ${ORGANIZATION_ID} in this database.`);
      console.log(`  The only organisation here is ${organization._id} (${organization.name}).`);
      return 2;
    }

    const owned = (organization.tallyCompanyIds || []).map(String);
    console.log(`Organisation: ${organization._id}`);
    console.log(`  name:            ${organization.name}`);
    console.log(`  owns already:    ${owned.length === 0 ? "(none)" : owned.length}`);
    for (const id of owned) {
      const c = await companiesColl.findOne({ _id: new mongoose.Types.ObjectId(id) });
      console.log(`    ${id}  ${c ? c.companyName : "<< no such company >>"}`);
    }
    console.log("");

    // ── Existing conflicts anywhere in the database ───────────────────────
    const conflicts = await findOwnershipConflicts();
    if (conflicts.length > 0) {
      console.log(`REFUSED: ${conflicts.length} company/companies are already held by more than one organisation.`);
      for (const c of conflicts) {
        console.log(`    company ${c.companyId} claimed by ${c.organizationIds.join(", ")}`);
      }
      console.log("");
      console.log("  Run scripts/migrations/accounting-company-ownership-index.js first.");
      return 2;
    }

    const indexPresent = (await orgs.indexes()).some((i) => i.name === OWNERSHIP_INDEX_NAME);
    console.log(
      `Ownership index "${OWNERSHIP_INDEX_NAME}": ${indexPresent ? "present" : "ABSENT"}` +
        (indexPresent ? "" : " — the service's pre-check still applies; the index is what holds under a race."),
    );
    console.log("");

    // ── The companies to assign ───────────────────────────────────────────
    const allCompanies = await companiesColl.find({}).toArray();
    const ownedAnywhere = new Set(
      allOrgs.flatMap((o) => (o.tallyCompanyIds || []).map(String)),
    );

    let targets;
    if (COMPANIES) {
      const asked = COMPANIES.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = asked.filter((id) => !OBJECT_ID_RE.test(id));
      if (bad.length) {
        console.log(`REFUSED: not valid company ids: ${bad.join(", ")}`);
        return 2;
      }
      const known = new Set(allCompanies.map((c) => String(c._id)));
      const missing = asked.filter((id) => !known.has(id));
      if (missing.length) {
        console.log(`REFUSED: no such company in this database: ${missing.join(", ")}`);
        return 2;
      }
      targets = asked;
    } else {
      targets = allCompanies
        .filter((c) => c.isActive !== false && !ownedAnywhere.has(String(c._id)))
        .map((c) => String(c._id));
    }

    const byId = new Map(allCompanies.map((c) => [String(c._id), c]));
    const foreign = targets.filter(
      (id) => ownedAnywhere.has(id) && !owned.includes(id),
    );
    if (foreign.length) {
      console.log("REFUSED: these companies already belong to another organisation:");
      for (const id of foreign) {
        console.log(`    ${id}  ${byId.get(id)?.companyName || ""}`);
      }
      return 2;
    }

    const toAttach = targets.filter((id) => !owned.includes(id));
    const already = targets.filter((id) => owned.includes(id));

    console.log(`Companies in this database: ${allCompanies.length}`);
    for (const c of allCompanies) {
      const id = String(c._id);
      const state = owned.includes(id)
        ? "already this organisation's"
        : ownedAnywhere.has(id)
          ? "another organisation's"
          : "unassigned";
      const mark = toAttach.includes(id) ? "→ WILL ASSIGN" : "  ";
      console.log(
        `  ${mark}  ${id}  ${String(c.companyName).padEnd(26)} isActive=${c.isActive !== false}  ${state}`,
      );
    }
    console.log("");

    if (already.length) {
      console.log(`${already.length} of the requested companies are already assigned — no-ops.`);
    }

    if (toAttach.length === 0) {
      console.log("Nothing to do. This organisation already owns everything it was asked to.");
      return 0;
    }

    console.log(`Will assign ${toAttach.length} company/companies to ${organization.name} (${organization._id}):`);
    for (const id of toAttach) console.log(`    ${id}  ${byId.get(id)?.companyName || ""}`);
    console.log("");

    // ── Apply ─────────────────────────────────────────────────────────────
    if (!APPLY) {
      console.log("Dry run complete. Nothing was written.");
      console.log(`Re-run with --expect-db=${dbName} --apply to assign them.`);
      return 0;
    }

    const result = await attachCompaniesToOrganization({
      organizationId: ORGANIZATION_ID,
      companyIds: toAttach,
    });

    if (!result.ok) {
      console.log(`FAILED: ${result.code} — ${result.message}`);
      if (result.companyId) console.log(`  company: ${result.companyId}`);
      return 1;
    }

    console.log(`Attached:         ${result.attached.length}`);
    for (const id of result.attached) console.log(`    ${id}  ${byId.get(id)?.companyName || ""}`);
    if (result.alreadyAttached.length) {
      console.log(`Already attached: ${result.alreadyAttached.length}`);
    }
    console.log("");

    // ── Verify what was actually stored ───────────────────────────────────
    const after = await orgs.findOne({ _id: organization._id }, { projection: { tallyCompanyIds: 1, name: 1 } });
    const storedIds = (after.tallyCompanyIds || []).map(String);
    const duplicates = storedIds.filter((id, i) => storedIds.indexOf(id) !== i);

    console.log(`${after.name} now owns ${storedIds.length}:`);
    for (const id of storedIds) console.log(`    ${id}  ${byId.get(id)?.companyName || ""}`);

    const missing = toAttach.filter((id) => !storedIds.includes(id));
    if (missing.length) {
      console.log(`INCOMPLETE: ${missing.length} company/companies were not stored: ${missing.join(", ")}`);
      return 1;
    }
    if (duplicates.length) {
      console.log(`WARNING: duplicate entries in tallyCompanyIds: ${[...new Set(duplicates)].join(", ")}`);
      return 1;
    }

    const stillConflicted = await findOwnershipConflicts();
    if (stillConflicted.length) {
      console.log(`WARNING: the write introduced ${stillConflicted.length} ownership conflict(s).`);
      return 1;
    }

    console.log("");
    console.log("Verified: every requested company is stored exactly once, and no company");
    console.log("is held by two organisations.");
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
