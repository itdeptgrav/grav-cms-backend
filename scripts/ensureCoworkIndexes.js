#!/usr/bin/env node
/**
 * Create the Cowork indexes on a MongoDB database, by hand.
 *
 *   node -r dotenv/config scripts/ensureCoworkIndexes.js
 *
 * The server does this itself on every boot when `COWORK_DB=mongo`; this is
 * for running it BEFORE the first boot, right after `migrateCoworkToMongo.js`,
 * so the first request never lands on an unindexed collection. Safe to re-run.
 */

"use strict";

const { MongoClient } = require("mongodb");
const { ensureIndexes } = require("../services/mongo/indexes");

async function main() {
  const uri = process.env.COWORK_MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set COWORK_MONGODB_URI (or MONGODB_URI) first.");
    process.exit(1);
  }
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.COWORK_MONGODB_DB || "cowork");
    const r = await ensureIndexes(db, { log: (m) => console.log(m) });
    process.exitCode = r.failures.length ? 1 : 0;
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
