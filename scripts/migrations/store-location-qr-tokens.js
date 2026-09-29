// scripts/migrations/store-location-qr-tokens.js
//
// The physical store (25 Sep 2026): every warehouse location gets a `kind`
// (default AREA), a `qrToken` (LOC-XXXXXXXX) and empty layout/capacity
// blocks; warehouses that never had `structureVersion` or `floorPlan` get
// the defaults on disk so the version-0 guards match them.
//
// Stock is NOT touched. Every item the company holds starts as UNALLOCATED
// (no LocationBalance rows are written); the invariant located + unallocated
// = on hand is true by construction because located is zero.
//
//   node scripts/migrations/store-location-qr-tokens.js            # dry run
//   node scripts/migrations/store-location-qr-tokens.js --apply    # write
//
// Idempotent: locations that already carry a token or a kind are left alone.
"use strict";
require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const S = require("../../services/storePurchase/storeLocations.service");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const warehouses = await Warehouse.find({}).lean();
  let tokens = 0, kinds = 0, versions = 0, plans = 0;
  for (const w of warehouses) {
    const $set = {};
    const arrayFilters = [];
    (w.locations || []).forEach((l, i) => {
      if (!l.qrToken) { $set[`locations.$[t${i}].qrToken`] = S.mintQrToken(); arrayFilters.push({ [`t${i}._id`]: l._id }); tokens++; }
      if (!l.kind) { $set[`locations.$[k${i}].kind`] = l.type === "RACK_BIN" ? "BIN" : "AREA"; arrayFilters.push({ [`k${i}._id`]: l._id }); kinds++; }
    });
    if (w.structureVersion === undefined) { $set.structureVersion = 0; versions++; }
    if (!w.floorPlan) { $set.floorPlan = { widthCm: 0, depthCm: 0, heightCm: 300, gridCm: 25, walls: [], fixtures: [], notes: "", layoutVersion: 0 }; plans++; }
    if (!Object.keys($set).length) continue;
    console.log(`${APPLY ? "updating" : "would update"} ${w.name} (${w.shortName}): ${Object.keys($set).length} fields`);
    if (APPLY) await Warehouse.updateOne({ _id: w._id }, { $set }, { arrayFilters });
  }
  console.log(`${APPLY ? "done" : "dry run"}: ${warehouses.length} warehouses, ${tokens} tokens, ${kinds} kinds, ${versions} structure versions, ${plans} floor plans`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
