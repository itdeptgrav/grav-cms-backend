// scripts/repair/development-number-scope.js
//
// THE GLOBAL INDEX THAT MADE THE SECOND COMPANY'S FIRST FILE IMPOSSIBLE.
//
// `developmentNumber` was declared globally unique while the number is
// allocated PER COMPANY — every company's first file of a year is
// `MDV-<year>-0001`. So company A opened `MDV-2026-0001`, and company B's
// first development request of that year collided on the index, failed to
// create a file, and the intake reported the delivery as a concurrent
// duplicate. The Sales request stayed ISSUED with nothing behind it and
// nobody was told.
//
// The schema now declares `{companyId, developmentNumber}` instead. A
// database that has been running carries BOTH: Mongoose creates the new
// compound index on boot, but it never drops an index it no longer declares.
// Until the old `developmentNumber_1` is dropped, the bug is still live.
//
//   node scripts/repair/development-number-scope.js
//   node scripts/repair/development-number-scope.js --apply
//
// ── DRY RUN UNLESS TOLD OTHERWISE ──────────────────────────────────────────
// It reports what it would do and writes nothing. This is deliberately not
// done on boot: dropping an index is a schema change on live data, it is not
// reversible in the time it takes to notice, and an application that quietly
// re-shapes its own indexes at startup is one nobody can reason about during
// an incident.
//
// ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────
//   · drop the old index while duplicate numbers WITHIN a company exist. That
//     would let the new index fail to build and leave the collection with no
//     uniqueness at all. Those rows are listed for a person instead;
//   · renumber anything. A development number is immutable and is quoted in
//     audit rows, execution files and handover versions — rewriting one here
//     would orphan every reference to it;
//   · touch any other index.
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");

const OLD_INDEX = "developmentNumber_1";
const NEW_INDEX = "one_number_per_company";

const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  const apply = has("apply");
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

  const coll = DevelopmentFile.collection;
  const indexes = await coll.indexes();
  const byName = new Map(indexes.map((i) => [i.name, i]));

  const report = {
    mode: apply ? "APPLIED" : "DRY RUN",
    oldIndexPresent: byName.has(OLD_INDEX),
    newIndexPresent: byName.has(NEW_INDEX),
    duplicatesWithinACompany: [],
    dropped: false,
    created: false,
  };

  /* ── WOULD THE NEW INDEX BUILD? ─────────────────────────────────────────
     Asked BEFORE anything is dropped. A company holding the same number
     twice is a real data fault that a person has to resolve, and finding it
     after the old index is gone means finding it with no uniqueness left. */
  const dupes = await coll.aggregate([
    { $group: { _id: { companyId: "$companyId", developmentNumber: "$developmentNumber" }, n: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 50 },
  ]).toArray();
  report.duplicatesWithinACompany = dupes.map((d) => ({
    companyId: String(d._id.companyId),
    developmentNumber: d._id.developmentNumber,
    count: d.n,
    fileIds: d.ids.map(String),
  }));

  if (report.duplicatesWithinACompany.length) {
    console.log(JSON.stringify(report, null, 2));
    console.log("\nNothing was changed. Resolve the duplicate numbers above first — "
      + "the new index cannot build while they exist, and dropping the old one now "
      + "would leave this collection with no uniqueness on the number at all.");
    await mongoose.disconnect();
    return;
  }

  if (apply) {
    /* Create first, drop second. In that order there is no window in which
       the collection is unprotected. */
    if (!report.newIndexPresent) {
      await coll.createIndex({ companyId: 1, developmentNumber: 1 }, { unique: true, name: NEW_INDEX });
      report.created = true;
    }
    if (report.oldIndexPresent) {
      await coll.dropIndex(OLD_INDEX);
      report.dropped = true;
    }
  }

  console.log(JSON.stringify(report, null, 2));
  if (!apply && report.oldIndexPresent) {
    console.log("\nNothing was written. Re-run with --apply to create "
      + `${NEW_INDEX} and drop ${OLD_INDEX}.`);
  }
  if (!report.oldIndexPresent && !apply) {
    console.log("\nThe old global index is already gone. Nothing to do.");
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
