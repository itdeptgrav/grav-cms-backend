// test/setup.js
//
// Spins up an isolated in-memory MongoDB for each test file, connects mongoose
// to it, clears all collections between tests, and tears down after. No live
// database, no network, no fixtures to clean up.
"use strict";

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

let mongod;

/**
 * A test file that needs no database sets `process.env.TEST_WITHOUT_MONGO = "1"`
 * at the TOP of the file, before any require.
 *
 * Module bodies run before any `beforeAll` callback does, so the flag is
 * visible here by the time this hook fires. It exists for the static analysis
 * suites — the HR route-coverage test walks routers and compares them with a
 * declaration registry and never touches a collection — where spinning up
 * mongod is 10-20 seconds of nothing, and, when the file also runs a heavy
 * child process, a source of start-up timeouts that look like real failures.
 */
const skipMongo = () => process.env.TEST_WITHOUT_MONGO === "1";

beforeAll(async () => {
  if (skipMongo()) return;
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongod.getUri(), { dbName: "crm_test" });
});

afterEach(async () => {
  if (skipMongo()) return;
  const { collections } = mongoose.connection;
  for (const key of Object.keys(collections)) {
    await collections[key].deleteMany({});
  }
});

afterAll(async () => {
  if (skipMongo()) return;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});
