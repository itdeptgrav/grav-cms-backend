// scripts/dropLegacyStyleIndex.js
//
// One-time: drop the old unique { journeyId, productName } on samplestyles.
//
// It was replaced by { journeyId, productName, variantKey } when a product
// gained the ability to be developed as several variants at once. Mongo never
// drops a superseded index by itself, so until this runs the old one still
// refuses the second variant of a product — with a duplicate-key error that
// points at productName and says nothing about variants.
//
//   node scripts/dropLegacyStyleIndex.js
//
// Idempotent: says so and exits 0 if the index is already gone.
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");

const LEGACY = { journeyId: 1, productName: 1 };
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection("samplestyles");
  const indexes = await col.indexes();

  const legacy = indexes.find((i) => sameKey(i.key, LEGACY) && i.unique);
  if (!legacy) {
    console.log("Nothing to do — the legacy unique { journeyId, productName } is not present.");
  } else {
    await col.dropIndex(legacy.name);
    console.log(`Dropped ${legacy.name}.`);
  }

  // Ensure the replacement exists, so a fresh database and a migrated one end
  // up identical rather than relying on autoIndex having run.
  await col.createIndex({ journeyId: 1, productName: 1, variantKey: 1 }, { unique: true });
  console.log("Ensured unique { journeyId, productName, variantKey }.");

  console.log((await col.indexes()).map((i) => `  ${i.name}${i.unique ? " UNIQUE" : ""}`).join("\n"));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
