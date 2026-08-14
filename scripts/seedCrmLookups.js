// scripts/seedCrmLookups.js
//
// Idempotent projection of constants/crm.js into the CRMLookup collection, so
// the frontend can fetch controlled option lists without importing backend
// code. Safe to run any number of times in any environment — it upserts by
// (category, code) and marks anything no longer in the constants inactive.
//
//   node -r dotenv/config scripts/seedCrmLookups.js
//
"use strict";

const mongoose = require("mongoose");
const CrmLookup = require("../models/CMS_Models/Sales/CrmLookup");
const { LOOKUP_CATEGORIES } = require("../constants/crm");

async function seedCrmLookups() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  const alreadyConnected = mongoose.connection.readyState === 1;
  if (!alreadyConnected) await mongoose.connect(uri);

  let upserts = 0;
  const seenByCategory = {};

  for (const [category, values] of Object.entries(LOOKUP_CATEGORIES)) {
    seenByCategory[category] = [];
    let sortOrder = 0;
    for (const v of values) {
      seenByCategory[category].push(v.code);
      const { code, label, ...meta } = v;
      await CrmLookup.updateOne(
        { category, code },
        { $set: { label, meta, sortOrder: sortOrder++, isActive: true } },
        { upsert: true },
      );
      upserts += 1;
    }
  }

  // Retire codes that are no longer in the constants (kept, not deleted).
  let retired = 0;
  for (const [category, codes] of Object.entries(seenByCategory)) {
    const r = await CrmLookup.updateMany(
      { category, code: { $nin: codes }, isActive: true },
      { $set: { isActive: false } },
    );
    retired += r.modifiedCount || 0;
  }

  console.log(`[seedCrmLookups] upserted ${upserts} lookup values across ${Object.keys(LOOKUP_CATEGORIES).length} categories; retired ${retired}.`);
  if (!alreadyConnected) await mongoose.disconnect();
  return { upserts, retired };
}

// Run directly (node scripts/seedCrmLookups.js) but also export for reuse.
if (require.main === module) {
  seedCrmLookups()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[seedCrmLookups] failed:", err);
      process.exit(1);
    });
}

module.exports = seedCrmLookups;
