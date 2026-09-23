// scripts/migrations/marketing-campaign-draft-utm-index.js
//
// REPLACE THE STATE-SCOPED UTM INDEX WITH A PERMANENT ONE.
//
// ── WHY A MONGOOSE DECLARATION CHANGE IS NOT ENOUGH ────────────────────────
// Mongoose creates indexes it does not find and does NOT reconcile one whose
// options changed. An existing database that already built
//
//   { companyId: 1, utmCampaign: 1 }
//   partialFilterExpression: { utmCampaign: …, state: { $in: [live states] } }
//
// keeps that index for ever. Worse, it keeps it SILENTLY: the new declaration has
// the same keys, so `ensureIndexes` either skips it or fails with an options
// conflict depending on the driver version, and in neither case does the old
// constraint stop being enforced.
//
// The consequence is the exact bug the new index exists to prevent. The old
// partial filter excludes cancelled and rejected plans, so the database still
// permits reusing a cancelled plan's campaign identity — and the application
// believes it does not. Code that trusts a constraint the database is not
// enforcing is worse than code with no constraint, because nobody checks.
//
// So the old index is dropped explicitly and the new one, which carries its own
// name, is built. Naming the new one differently is deliberate: the two cannot be
// confused in `getIndexes()` output, and a half-finished migration is visible
// rather than ambiguous.
//
// ── AND THE DATA IS CHECKED BEFORE THE CONSTRAINT TIGHTENS ─────────────────
// A unique index cannot be built over data that already violates it. Under the
// old rule a cancelled plan and a live plan could legitimately share an identity,
// so an existing database may hold exactly the rows the new index refuses. This
// reports them and stops rather than building nothing and exiting zero — the
// failure mode of a migration that "succeeded" without applying is an application
// trusting a constraint that is not there.
//
//   node -r dotenv/config scripts/migrations/marketing-campaign-draft-utm-index.js
//   node -r dotenv/config scripts/migrations/marketing-campaign-draft-utm-index.js --apply
//
// Without `--apply` it reports and changes nothing.
"use strict";

const mongoose = require("mongoose");

const OLD_NAME = "companyId_1_utmCampaign_1";
const NEW_NAME = "companyId_1_utmCampaign_1_permanent";
const COLLECTION = "marketing_campaign_drafts";

const apply = process.argv.includes("--apply");
const line = (s = "") => process.stdout.write(`${s}\n`);

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const col = db.collection(COLLECTION);

  const exists = await db.listCollections({ name: COLLECTION }).hasNext();
  if (!exists) {
    line(`${COLLECTION} does not exist yet. Nothing to migrate; the new index will be built on first use.`);
    return;
  }

  const indexes = await col.indexes();
  line("Current indexes on the campaign-plan collection:");
  for (const ix of indexes) {
    line(`  ${ix.name}  keys=${JSON.stringify(ix.key)}  unique=${Boolean(ix.unique)}  partial=${JSON.stringify(ix.partialFilterExpression || null)}`);
  }

  const old = indexes.find((ix) => ix.name === OLD_NAME);
  const current = indexes.find((ix) => ix.name === NEW_NAME);

  if (current && !old) {
    line("\nAlready migrated: the permanent index is present and the state-scoped one is gone.");
    return;
  }

  /* ── THE VIOLATIONS THE OLD RULE ALLOWED ─────────────────────────────────
     Grouped by company and identity. Any group of more than one is a pair the new
     index cannot coexist with, and each needs a human decision: which plan keeps
     the identity. This migration will not choose, because choosing wrong merges
     two campaigns' analytics, which is the thing being prevented. */
  const clashes = await col.aggregate([
    { $match: { utmCampaign: { $type: "string", $gt: "" } } },
    { $group: { _id: { companyId: "$companyId", utmCampaign: "$utmCampaign" }, count: { $sum: 1 }, refs: { $push: { ref: "$draftRef", state: "$state" } } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();

  if (clashes.length) {
    line(`\nBLOCKED: ${clashes.length} campaign identit${clashes.length === 1 ? "y is" : "ies are"} held by more than one plan.`);
    line("The old index permitted this for cancelled and rejected plans. Each needs a human");
    line("decision about which plan keeps the identity; this migration will not choose, because");
    line("choosing wrong is what merges two campaigns' analytics.\n");
    for (const c of clashes) {
      line(`  company ${c._id.companyId} · "${c._id.utmCampaign}"`);
      for (const r of c.refs) line(`      ${r.ref} (${r.state})`);
    }
    process.exitCode = 1;
    return;
  }

  line("\nNo identity is held by more than one plan. The permanent index can be built.");

  if (!apply) {
    line("\nDry run. Re-run with --apply to:");
    if (old) line(`  - drop ${OLD_NAME}`);
    if (!current) line(`  - create ${NEW_NAME} (unique, partial on a non-empty identity)`);
    return;
  }

  /* New index FIRST, so there is never a window with no uniqueness constraint at
     all. The two can coexist: the new one is strictly stricter, so anything the
     old one permitted and the new one does not has already been ruled out above. */
  if (!current) {
    await col.createIndex(
      { companyId: 1, utmCampaign: 1 },
      {
        name: NEW_NAME,
        unique: true,
        partialFilterExpression: { utmCampaign: { $type: "string", $gt: "" } },
      },
    );
    line(`created ${NEW_NAME}`);
  }

  if (old) {
    await col.dropIndex(OLD_NAME);
    line(`dropped ${OLD_NAME}`);
  }

  const after = await col.indexes();
  const ok = after.some((ix) => ix.name === NEW_NAME) && !after.some((ix) => ix.name === OLD_NAME);
  line(ok
    ? "\nMigrated. A cancelled or rejected plan now keeps its campaign identity permanently."
    : "\nINCOMPLETE: re-run and check the index list above.");
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error("migration failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
