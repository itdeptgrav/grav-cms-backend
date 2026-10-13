#!/usr/bin/env node
"use strict";

require("dotenv").config();
const mongoose = require("mongoose");
const { ENTITY_SPECS, RECORDS, NONE, queryCollection } = require("../../services/storeCollectionContext");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured; refusing to guess a database.");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 20000 });
  try {
    const results = [];
    for (const entity of ENTITY_SPECS) {
      const data = await queryCollection({
        entity: entity.id,
        message: `are there any ${entity.label} records`,
        args: {
          operation: "exists", metric: RECORDS, outputMetric2: NONE, outputMetric3: NONE,
          filterMetric: NONE, filterOperator: NONE, filterValue: "",
          filterMetric2: NONE, filterOperator2: NONE, filterValue2: "",
          filterMetric3: NONE, filterOperator3: NONE, filterValue3: "",
          dateMetric: NONE,
        },
      });
      results.push({ entity: entity.id, ok: data.ok, count: data.count ?? null, reason: data.ok ? null : data.reason });
    }
    const failed = results.filter((item) => !item.ok);
    const report = {
      ok: failed.length === 0,
      databaseConnected: true,
      collectionPathsChecked: results.length,
      collectionPathsPassed: results.length - failed.length,
      collectionPathsWithRecords: results.filter((item) => item.ok && item.count > 0).length,
      failed,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
