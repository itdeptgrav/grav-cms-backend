// scripts/migrations/backfill-sales-company.js
//
// Give existing Account, Lead and Contact records the company they already
// belong to.
//
// ── WHY, AND IN WHAT ORDER ──────────────────────────────────────────────────
// Chunk 3B1 added `companyId` to the Sales customer source. Records created
// before it have none, and an unowned record is usable only where ownership
// cannot be ambiguous — a proven single-company deployment. The moment a
// second company exists they stop resolving, everywhere.
//
// The ownership hierarchy is
//
//     Company → Account / Lead → Contact → SalesJourney → Enquiry
//
// so the backfill order for a strict deployment is:
//
//     1. this script            (Account, Lead, Contact)
//     2. backfill-enquiry-company.js
//        …and the journeys it depends on
//
// Running it the other way leaves a scoped Journey pointing at an unowned
// Account, which reads as a missing customer rather than as a migration that
// has not finished.
//
// ── THE RULE IT REFUSES TO BREAK ────────────────────────────────────────────
// It assigns a company ONLY when the company master holds exactly one. With
// two or more there is nothing in the data that says which one an old customer
// belonged to, and choosing the first, the busiest or the operator's current
// one would be inventing ownership for confidential commercial records.
//
// ── IT HAS NOT BEEN RUN ─────────────────────────────────────────────────────
// Dry run by default; `--apply` is required to write. Idempotent: already-owned
// records are excluded by the filter, so a second run changes nothing.
//
//   node scripts/migrations/backfill-sales-company.js            # dry run
//   node scripts/migrations/backfill-sales-company.js --apply    # writes
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

/* Absent OR null — both shapes exist, because the field was added to
   collections that already had documents. */
const UNOWNED = { $or: [{ companyId: null }, { companyId: { $exists: false } }] };

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const models = {
    Account: require("../../models/CMS_Models/Sales/Account"),
    Lead: require("../../models/CMS_Models/Sales/Lead"),
    Contact: require("../../models/CMS_Models/Sales/Contact"),
  };
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const { withOwnershipMigration } = require("../../models/CMS_Models/Sales/companyOwnership");

  const companies = await Acc_Company.find({}).select("_id companyName").limit(5).lean();

  /* Counted per model, because "how much is left" is a different question for
     each and a single total hides a model that was missed. */
  const counts = {};
  for (const [name, Model] of Object.entries(models)) {
    counts[name] = {
      unowned: await Model.countDocuments(UNOWNED),
      total: await Model.countDocuments({}),
    };
    console.log(`${name}: ${counts[name].unowned} unowned of ${counts[name].total}`);
  }
  console.log(`Companies configured: ${companies.length}`);

  const work = Object.values(counts).reduce((n, c) => n + c.unowned, 0);
  if (work === 0) {
    console.log("Nothing to do — every record already carries a company.");
    return;
  }

  if (companies.length !== 1) {
    /* ── AN UNSAFE APPLY MUST FAIL, NOT MERELY DECLINE ──────────────────
       A dry run reporting "cannot proceed" is information. An `--apply` that
       prints a refusal and exits 0 tells a deploy script the migration
       succeeded, and the next step runs against half-migrated data. */
    if (APPLY) process.exitCode = 1;
    console.log(
      companies.length === 0
        ? "REFUSING: no company is configured, so there is nothing to assign."
        : `REFUSING: ${companies.length} companies exist, and nothing in the data says which one these ` +
          "customers belong to. Assign them deliberately, or leave them unowned — every consumer fails " +
          "closed on an unowned record in a multi-company deployment, which is the safe outcome.",
    );
    console.log(companies.map((c) => `  · ${c.companyName} (${c._id})`).join("\n"));
    return;
  }

  const company = companies[0];
  console.log(`Single-company deployment: ${company.companyName} (${company._id}).`);

  if (!APPLY) {
    console.log(`DRY RUN — would stamp ${work} records. Re-run with --apply to write.`);
    return;
  }

  /* ── THE ONLY WRITE THAT MAY TOUCH OWNERSHIP ──────────────────────────────
     The three models refuse ownership writes outright (sealCompanyOwnership),
     which is what makes an ordinary PATCH unable to move a record between
     companies. This migration is the deliberate exception, and it says so:
     `withOwnershipMigration` takes a callback, so the permission covers
     exactly these updates and nothing that runs before or after them. There
     is no flag, header or environment variable that opens the same door. */
  await withOwnershipMigration(async () => {
    for (const [name, Model] of Object.entries(models)) {
      if (!counts[name].unowned) continue;
      const res = await Model.updateMany(UNOWNED, {
        $set: {
          companyId: company._id,
          companyOwnership: {
            /* Recorded as what it is: a migration's inference from the
               deployment having one company, not a membership anybody proved. */
            source: "BACKFILL_SINGLE_COMPANY_DEPLOYMENT",
            resolvedAt: new Date(),
            proven: false,
          },
        },
      });
      console.log(`${name}: stamped ${res.modifiedCount}.`);
    }
  });
  console.log("Next: backfill journeys and enquiries — see backfill-enquiry-company.js.");
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
