#!/usr/bin/env node
// scripts/migrations/machine-maintenance-storage.js
//
// The one step that sets up Maintenance's storage on a database.
//
//   1. the unique `maintenanceTag_code_unique` index on `machines`
//      (one barcode code is on at most one machine);
//   2. the `maintenance_orders` collection and its indexes — the unique order
//      number and idempotency key among them (no two orders share a number; a
//      retried "create" lands once);
//   3. missing indexes on the first version's `machine_maintenance_records`
//      WHERE THAT COLLECTION ALREADY EXISTS. It is never created: orders
//      replaced it, so a database that never had it never needs it.
//
// Dry run by default — reads and reports, writes nothing:
//
//   node -r dotenv/config scripts/migrations/machine-maintenance-storage.js
//   node -r dotenv/config scripts/migrations/machine-maintenance-storage.js --apply
//
// ── THE COLLECTION CAP ──────────────────────────────────────────────────────
// The Atlas cluster is at its 500-collection cap (3 Oct 2026). Creating the
// orders collection fails there until ONE slot is freed, and freeing one is the
// owner's decision — this script never drops or renames anything. It reports
// the count, and on a refusal says so plainly; the tag index (on an existing
// collection) is applied either way. A local server has no cap.
//
// Never touches a Store label, barcode or product collection, and never writes
// a machine or an order. Safe to run again: everything is create-if-missing.
"use strict";

const mongoose = require("mongoose");

async function clusterCollectionCount(client) {
  try {
    const { databases } = await client.db().admin().listDatabases();
    let total = 0;
    for (const d of databases) {
      if (d.name === "local") continue;
      total += (await client.db(d.name).listCollections({}, { nameOnly: true }).toArray()).length;
    }
    return total;
  } catch {
    return null; // not permitted to list databases — reported as unknown
  }
}

/* Only Atlas's shared tiers cap the collection count; a local or self-hosted
   server has no such limit, so the cap is mentioned only for an Atlas host. */
function isAtlasHost(connection) {
  return (connection.getClient().options?.hosts || []).some((h) => /\.mongodb\.net$/i.test(String(h.host || h)));
}

const describe = (name, state) => `${name}: ${state.exists ? "exists" : "missing"}` +
  (state.exists && state.missingIndexes.length ? `; indexes missing: ${state.missingIndexes.join(", ")}` : "");

async function run({ apply }) {
  /* Required here, after mongoose has connected with autoIndex off, so loading
     the models builds nothing on its own. */
  const storage = require("../../services/maintenance/maintenanceStorage");
  const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
  const { TAG_INDEX, tagIndexSpec } = require("../../models/CMS_Models/Inventory/Configurations/machineMaintenanceTag.schema");

  const db = mongoose.connection.db;
  const lines = [];
  const say = (s) => lines.push(s);

  const tagIndexPresent = (await Machine.collection.indexes()).some((i) => i.name === TAG_INDEX.options.name);
  const orders = await storage.inspectOrderStorage(db);
  const legacy = await storage.inspectLegacyStorage(db);
  const count = await clusterCollectionCount(mongoose.connection.getClient());
  const capped = isAtlasHost(mongoose.connection);

  say(`  Mode           ${apply ? "APPLY" : "dry run (nothing is written; pass --apply)"}`);
  say(`  Collections    ${count === null ? "unknown" : `${count} on this server${capped ? " (Atlas cap 500)" : " (no collection cap)"}`}`);
  say(`  Tag index      machines.${TAG_INDEX.options.name}: ${tagIndexPresent ? "present" : "missing"}`);
  say(`  Orders         ${describe(storage.ORDERS_COLLECTION, orders)}`);
  say(`  V1 reports     ${legacy.exists ? describe(storage.LEGACY_COLLECTION, legacy) : `${storage.LEGACY_COLLECTION}: not on this database (never created; not needed)`}`);

  if (!apply) {
    if (!orders.exists && capped && count !== null && count >= 500) {
      say("");
      say("  The orders collection cannot be created until a collection slot is freed.");
    }
    return { text: lines.join("\n"), ok: true };
  }

  say("");
  if (!tagIndexPresent) {
    await Machine.collection.createIndex(...tagIndexSpec());
    say(`  ✔ created machines.${TAG_INDEX.options.name}`);
  }
  if (legacy.exists) {
    const out = await storage.ensureLegacyIndexes({ db });
    for (const name of out.createdIndexes) say(`  ✔ created index ${storage.LEGACY_COLLECTION}.${name}`);
  }
  try {
    const out = await storage.ensureOrderStorage({ create: true, db });
    if (out.createdCollection) say(`  ✔ created collection ${storage.ORDERS_COLLECTION}`);
    for (const name of out.createdIndexes) say(`  ✔ created index ${storage.ORDERS_COLLECTION}.${name}`);
    if (!out.createdCollection && !out.createdIndexes.length) say(`  · ${storage.ORDERS_COLLECTION} was already complete`);
    say("");
    say("  Maintenance orders can now be recorded.");
    return { text: lines.join("\n"), ok: true };
  } catch (err) {
    const full = /already using \d+ collections of \d+|too many collections/i.test(String(err?.message));
    say(full
      ? `  ✖ ${storage.ORDERS_COLLECTION} was NOT created: the cluster is at its collection cap. Free one slot, then run this again.`
      : `  ✖ ${storage.ORDERS_COLLECTION} was NOT created: ${err.message}`);
    return { text: lines.join("\n"), ok: false };
  }
}

async function main() {
  require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
  require("dotenv").config({ quiet: true });
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({ apply: process.argv.includes("--apply") });
    console.log(out.text);
    if (!out.ok) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run };
