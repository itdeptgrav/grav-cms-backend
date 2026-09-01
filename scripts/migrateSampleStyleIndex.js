// scripts/migrateSampleStyleIndex.js
//
// ONE-SHOT: re-spec the SampleStyle uniqueness index as a PARTIAL index.
//
// Run once after deploying the 31 Aug 2026 house-sample change:
//
//     node -r dotenv/config scripts/migrateSampleStyleIndex.js
//
// ── WHY THIS SCRIPT HAS TO EXIST ──────────────────────────────────────────
// `SampleStyle` declares `{ journeyId, productName, variantKey }` unique. That
// rule means "one style per product per journey" — and an in-house sample has
// no journey, so it stores `journeyId: null`. Mongo indexes null as an ordinary
// value, which means the SECOND house sample ever raised for a given product
// name would be rejected as a duplicate of the first.
//
// The model now declares the same index with
// `partialFilterExpression: { journeyId: { $type: "objectId" } }`, which
// constrains exactly the rows the rule was written for and leaves house
// samples alone. But Mongo will NOT re-spec an index in place: `createIndex`
// with different options on an existing name fails (IndexOptionsConflict, 85)
// rather than replacing it, and Mongoose's autoIndex silently swallows that.
// So the old index has to be dropped explicitly first.
//
// ── SAFETY ────────────────────────────────────────────────────────────────
// Idempotent: re-running it when the partial index is already in place is a
// no-op that reports so. It only ever touches indexes — no document is read,
// written or deleted. Between the drop and the create there is a sub-second
// window with no uniqueness enforcement; that is the same window any index
// rebuild has, and duplicate journey styles are refused by the provisioning
// service's own find-then-create path regardless.
"use strict";

const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const mongoose = require("mongoose");

const TARGET_KEY = { journeyId: 1, productName: 1, variantKey: 1 };
const TARGET_NAME = "journeyId_1_productName_1_variantKey_1";
const TARGET_PARTIAL = { journeyId: { $type: "objectId" } };

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  const col = mongoose.connection.db.collection("samplestyles");

  const before = await col.indexes();
  const existing = before.find((i) => sameKey(i.key, TARGET_KEY));

  if (!existing) {
    console.log("No { journeyId, productName, variantKey } index found — creating the partial one.");
  } else if (existing.partialFilterExpression) {
    console.log("Already partial:", JSON.stringify(existing.partialFilterExpression));
    console.log("Nothing to do.");
    await mongoose.disconnect();
    process.exit(0);
  } else {
    console.log(`Dropping non-partial index "${existing.name}"…`);
    await col.dropIndex(existing.name);
  }

  await col.createIndex(TARGET_KEY, {
    unique: true,
    partialFilterExpression: TARGET_PARTIAL,
    name: TARGET_NAME,
  });
  console.log(`Created partial unique index "${TARGET_NAME}".`);

  const after = (await col.indexes()).find((i) => sameKey(i.key, TARGET_KEY));
  console.log("Now:", JSON.stringify({ name: after.name, unique: after.unique, partial: after.partialFilterExpression }));

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error("[migrateSampleStyleIndex] failed:", err.message);
  process.exit(1);
});
