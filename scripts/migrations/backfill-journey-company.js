// scripts/migrations/backfill-journey-company.js
//
// Give existing sales journeys the company they already belong to.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// The ownership hierarchy the other two backfills work down is
//
//     Company → Account / Lead → Contact → SalesJourney → Enquiry
//
// and `SalesJourney` is the one step nothing stamped. backfill-sales-company
// handles Account/Lead/Contact; backfill-enquiry-company handles Enquiry; the
// journey between them was left unowned.
//
// That is not a cosmetic hole. `ownershipProofFor` proves a sample style
// through its PARENT, and for a journey-type style the journey is the first
// parent it asks — so an unowned journey means every R&D and costing surface
// that resolves a style fails closed. The operation-route picker returning
// nothing for a style whose journey plainly exists is this, and only this.
//
// ── THE RULE IT REFUSES TO BREAK ────────────────────────────────────────────
// Same rule as its two siblings, deliberately: a company is assigned ONLY when
// the company master holds exactly one. With two or more there is nothing in
// the data saying which one an old journey belonged to, and picking the first
// or the operator's current one would be inventing ownership for confidential
// commercial records.
//
// Dry run by default; `--apply` is required to write. Idempotent: already-owned
// journeys are excluded by the filter, so a second run changes nothing.
//
//   node scripts/migrations/backfill-journey-company.js            # dry run
//   node scripts/migrations/backfill-journey-company.js --apply    # writes
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

  /* Unowned means absent OR null — both shapes exist, because the field was
     added to a collection that already had documents. */
  const unownedFilter = { $or: [{ companyId: null }, { companyId: { $exists: false } }] };

  const [companies, unowned, total] = await Promise.all([
    Acc_Company.find({}).select("_id companyName").limit(5).lean(),
    SalesJourney.countDocuments(unownedFilter),
    SalesJourney.countDocuments({}),
  ]);

  console.log(`Sales journeys: ${total} total, ${unowned} unowned.`);
  console.log(`Companies configured: ${companies.length}`);

  if (unowned === 0) {
    console.log("Nothing to do — every journey already carries a company.");
    return;
  }

  if (companies.length !== 1) {
    console.log(
      companies.length === 0
        ? "REFUSING: no company is configured, so there is nothing to assign."
        : `REFUSING: ${companies.length} companies exist, and nothing in the data says which one these `
          + "journeys belong to. Assign them deliberately, or leave them unowned — every surface that "
          + "resolves a style fails closed on an unowned journey, which is the safe outcome.",
    );
    console.log(companies.map((c) => `  · ${c.companyName} (${c._id})`).join("\n"));
    return;
  }

  const company = companies[0];
  console.log(`Single-company deployment: ${company.companyName} (${company._id}).`);

  if (!APPLY) {
    console.log(`DRY RUN — would set companyId on ${unowned} journeys. Re-run with --apply to write.`);
    const sample = await SalesJourney.find(unownedFilter).select("journeyId name").limit(8).lean();
    console.log(sample.map((j) => `  · ${j.journeyId} ${j.name || ""}`).join("\n"));
    return;
  }

  const res = await SalesJourney.updateMany(unownedFilter, {
    $set: {
      companyId: company._id,
      /* Recorded as what it is: a migration's inference from the deployment
         having one company, not a membership somebody proved at the time. */
      companyOwnership: {
        source: "BACKFILL_SINGLE_COMPANY_DEPLOYMENT",
        resolvedAt: new Date(),
        proven: false,
      },
    },
  });
  console.log(`Applied: ${res.modifiedCount} journeys now belong to ${company.companyName}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
