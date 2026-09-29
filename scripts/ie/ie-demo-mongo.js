#!/usr/bin/env node
"use strict";
/*
 * scripts/ie/ie-demo-mongo.js
 *
 * A LOCAL REPLICA SET FOR THE IE DEMO, STARTED BY THIS SCRIPT.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The demo needs a database that is provably not the team's. This checkout has
 * none: `MONGODB_URI` names a managed Atlas cluster and there is no local
 * mongod. Asking somebody to install and configure one — with a replica set,
 * because release issuance is written in a transaction — is a paragraph of
 * setup before anyone can look at a screen.
 *
 * `mongodb-memory-server` is already a dependency; the Jest suite uses it for
 * exactly this. So it is used directly: one command, a real replica set, a URI
 * that is local by construction.
 *
 * ── IT NEVER READS `MONGODB_URI` ────────────────────────────────────────────
 * Not to validate it, not to fall back to it, not to copy a database name out
 * of it. A launcher that read the variable could, on some path through its own
 * logic, end up pointing at what the variable names. The safest way not to
 * connect to Atlas is to have no code that could.
 *
 * ── AND IT PROVES TRANSACTIONS BEFORE SAYING IT IS READY ────────────────────
 * Opening a session proves nothing — a standalone mongod will hand you one and
 * refuse the write. So the probe WRITES inside a transaction and aborts it,
 * which is the same thing `unitOfWork.service` does, for the same reason.
 *
 * Usage:
 *   node scripts/ie/ie-demo-mongo.js
 *
 * It prints the URI and then stays up. Stop it with Ctrl-C; the data goes with
 * it, which is the point.
 *
 * This file is new and development-only. It changes no application behaviour.
 */

const { MongoMemoryReplSet } = require("mongodb-memory-server");
const { MongoClient } = require("mongodb");

/** The demo's own database. Named, never derived from anything. */
const DB_NAME = "grav_ie_demo";

/** Hosts this launcher must never produce. Checked on its OWN output. */
const isLocal = (uri) => {
  const s = String(uri || "").toLowerCase();
  if (s.startsWith("mongodb+srv://") || s.includes("mongodb.net")) return false;
  return s.includes("://127.0.0.1") || s.includes("://localhost") || s.includes("://[::1]");
};

/**
 * A real write inside a transaction, then abort.
 *
 * The write is what a standalone refuses; opening the session is not. The
 * abort leaves nothing behind, so the probe cannot be mistaken later for demo
 * data.
 */
async function proveTransactions(uri) {
  const client = new MongoClient(uri);
  await client.connect();
  const session = client.startSession();
  try {
    session.startTransaction();
    await client.db(DB_NAME).collection("ie_demo_transaction_probe")
      .insertOne({ probedAt: new Date() }, { session });
    await session.abortTransaction();
    return true;
  } catch (err) {
    throw new Error(
      `The replica set did not accept a transactional write: ${err.message}`,
    );
  } finally {
    await session.endSession();
    await client.close();
  }
}

async function main() {
  process.stdout.write("Starting an isolated replica set for the IE demo…\n");

  const replset = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger", name: "iedemo" },
  });

  /* `getUri(DB_NAME)` puts the database in the right place — BEFORE the
     `?replicaSet=` query string. Appending it by hand produces
     `…/?replicaSet=iedemo/grav_ie_demo`, which is a URI the driver accepts and
     then cannot resolve, so it fails as a 30-second server-selection timeout
     rather than as a parse error.

     Naming the database explicitly also keeps anything downstream from falling
     through to Mongoose's `test` default — precisely the default that made the
     house seeding convention look safe while pointing at Atlas. */
  const uri = replset.getUri(DB_NAME);

  if (!isLocal(uri)) {
    await replset.stop();
    throw new Error(`Refusing to continue: the started server is not local (${uri}).`);
  }

  await proveTransactions(uri);

  process.stdout.write(
    "\n"
    + "  IE demo replica set is up.\n\n"
    + `  MONGODB_URI=${uri}\n\n`
    + "  Transactions: proved by a write-and-abort probe.\n"
    + "  This database is in-memory and isolated. Stopping this process discards it.\n\n"
    + "  Seed it with:\n"
    + `    MONGODB_URI='${uri}' IE_DEMO_SEED=1 IE_DEMO_PASSWORD='<choose one>' \\\n`
    + "      node scripts/ie/seed-ie-demo.js --apply\n\n"
    + "  Run the backend against it with:\n"
    + `    MONGODB_URI='${uri}' npm start\n\n`
    + "  Ctrl-C to stop.\n\n",
  );

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`\nStopping the IE demo replica set (${signal})…\n`);
    try {
      await replset.stop();
      process.stdout.write("Stopped. The demo database is gone.\n");
    } catch (err) {
      process.stdout.write(`Stop failed: ${err.message}\n`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  /* Hold the process open. Nothing polls and nothing wakes up; the signal
     handlers are the only way out. */
  await new Promise(() => {});
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(1);
  });
}

module.exports = { DB_NAME, isLocal, proveTransactions };
