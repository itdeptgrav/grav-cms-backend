// scripts/migrations/backfill-enquiry-company.js
//
// Give existing Sales enquiries the company they already belong to.
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// Chunk 3A added `Enquiry.companyId`, stamped from the creating actor's
// server-owned membership. Every enquiry created before that has none, and an
// unowned enquiry is usable by costing ONLY where ownership cannot be
// ambiguous — which is to say, only while the deployment has one company. The
// moment a second company exists, every legacy enquiry stops resolving.
//
// This settles them, once, for the deployments where the answer is not a
// guess.
//
// ── THE RULE IT REFUSES TO BREAK ────────────────────────────────────────────
// It assigns a company ONLY when the company master holds exactly one. With
// two or more companies there is no evidence in the data saying which one an
// old enquiry belonged to — `CRMAccount` and `SalesJourney` carry no company
// either — and picking the first, or the busiest, or the one the operator
// happens to be looking at would be inventing ownership for confidential
// commercial records. In that case it reports what it found and changes
// nothing, and the enquiries stay unowned until somebody decides deliberately.
//
// ── IT HAS NOT BEEN RUN ─────────────────────────────────────────────────────
// Not against production, not against staging. It is reviewable, it defaults
// to a DRY RUN, and it needs `--apply` to write anything.
//
//   node scripts/migrations/backfill-enquiry-company.js              # dry run
//   node scripts/migrations/backfill-enquiry-company.js --apply      # writes
//
// Requires MONGODB_URI in the environment, as every other script here does.
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
  const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

  /* Unowned means the field is absent OR null — both shapes exist, because the
     field was added to a collection that already had documents. */
  const unownedFilter = { $or: [{ companyId: null }, { companyId: { $exists: false } }] };

  const [companies, unowned, total] = await Promise.all([
    Acc_Company.find({}).select("_id companyName").limit(5).lean(),
    Enquiry.countDocuments(unownedFilter),
    Enquiry.countDocuments({}),
  ]);

  console.log(`Enquiries: ${total} total, ${unowned} unowned.`);
  console.log(`Companies configured: ${companies.length}`);

  if (unowned === 0) {
    console.log("Nothing to do — every enquiry already carries a company.");
    return;
  }

  if (companies.length !== 1) {
    /* The whole point of the script's caution. */
    console.log(
      companies.length === 0
        ? "REFUSING: no company is configured, so there is nothing to assign."
        : `REFUSING: ${companies.length} companies exist, and nothing in the data says which one these ` +
          "enquiries belong to. Assign them deliberately, or leave them unowned — costing fails closed on " +
          "an unowned enquiry in a multi-company deployment, which is the safe outcome.",
    );
    console.log(companies.map((c) => `  · ${c.companyName} (${c._id})`).join("\n"));
    return;
  }

  const company = companies[0];
  console.log(`Single-company deployment: ${company.companyName} (${company._id}).`);

  if (!APPLY) {
    console.log(`DRY RUN — would set companyId on ${unowned} enquiries. Re-run with --apply to write.`);
    const sample = await Enquiry.find(unownedFilter).select("enquiryId title").limit(5).lean();
    console.log(sample.map((e) => `  · ${e.enquiryId} ${e.title || ""}`).join("\n"));
    return;
  }

  const res = await Enquiry.updateMany(unownedFilter, {
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
  console.log(`Applied: ${res.modifiedCount} enquiries now belong to ${company.companyName}.`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
