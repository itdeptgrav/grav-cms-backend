#!/usr/bin/env node
// scripts/migrations/receiving-session-indexes.js
//
// THE INDEXES COUNT-AND-LABEL NEEDS, BUILT WHERE INDEXES BELONG.
//
// Two of them are not performance. They are the concurrency guarantee:
//
//   goodsreceiptsessions  one OPEN count per purchase-order line
//   barcodes              one identity per (count, sequence position)
//
// A receiving count allocates its label numbers with an atomic `$inc` on the
// session, so two terminals counting one delivery are handed disjoint blocks.
// These indexes are what make that true regardless of how a future caller
// allocates: the database refuses the duplicate rather than producing two
// stickers under one number, or two independent counts of one pallet each
// starting at 1.
//
// ── WHY NOT ON THE SCHEMAS ──────────────────────────────────────────────────
// Because `barcodes` is written INSIDE the goods-receipt transaction, and
// mongoose builds a schema's indexes lazily on first use of the collection. A
// build that lands inside the transaction takes collection locks the
// transaction then cannot acquire within mongod's 5ms lock timeout; the driver
// treats the timeout as transient and retries, and the retry re-saves a
// document whose `__v` the first attempt already bumped — failing with a
// VersionError that mentions neither indexes nor transactions. Diagnosed twice
// already (GoodsReceipt, then barcodes) and written up on
// `Barcode.companyId`. Index creation belongs outside a transaction.
//
// ── IT CREATES NOTHING BUT INDEXES ──────────────────────────────────────────
// No document is read, written or counted, and it defaults to a dry run.
//
//   node -r dotenv/config scripts/migrations/receiving-session-indexes.js
//   …--apply   build the ones that are missing
"use strict";

const mongoose = require("mongoose");

const preflight = require("./lib/indexPreflight");

const INDEXES = Object.freeze([
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_poItemId_1",
    key: { companyId: 1, poItemId: 1 },
    /* UNIQUE and partial on OPEN. A line may hold many finished counts in its
       history — a part receipt today, another next week — but never two open
       at once, because two open counts would be two label counters for one
       pallet, each starting at 1. */
    /* Restricted to rows that HAVE a purchase-order line (1 Oct 2026): a
       customer-material count carries none, and null would otherwise be one
       shared key for every open customer-material count. */
    options: { unique: true, partialFilterExpression: { status: "OPEN", poItemId: { $type: "objectId" } } },
    why: "one open count per purchase-order line — the single label counter",
  },
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_customerMaterialId_1_customerLineRef_1",
    key: { companyId: 1, customerMaterialId: 1, customerLineRef: 1 },
    options: { unique: true, partialFilterExpression: { status: "OPEN", customerMaterialId: { $type: "objectId" } } },
    why: "one open count per customer-material document line (1 Oct 2026)",
  },
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_customerMaterialId_1_status_1",
    key: { companyId: 1, customerMaterialId: 1, status: 1 },
    why: "every open count on one customer-material document — the customer-owned receive screen's read",
  },
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_materialLineId_1",
    key: { companyId: 1, materialLineId: 1 },
    options: { unique: true, partialFilterExpression: { status: "OPEN", materialLineId: { $type: "objectId" } } },
    why: "one open count per material-request line (7 Oct 2026)",
  },
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_materialRequestId_1_status_1",
    key: { companyId: 1, materialRequestId: 1, status: 1 },
    why: "every open count on one material request — its receive screen's read",
  },
  {
    collection: "goodsreceiptsessions",
    name: "companyId_1_purchaseOrderId_1_status_1",
    key: { companyId: 1, purchaseOrderId: 1, status: 1 },
    why: "every open count on one order — what the receiving screen reads on load",
  },
  {
    collection: "barcodes",
    name: "companyId_1_receivingSessionId_1_sessionSequence_1",
    key: { companyId: 1, receivingSessionId: 1, sessionSequence: 1 },
    /* UNIQUE, and partial so it constrains only labels reserved inside a count.
       The entire existing register carries no session and must not collide on
       null. This is the backstop behind the atomic `$inc`: a duplicate insert
       is refused by the database, so two stickers can never carry one number. */
    options: { unique: true, partialFilterExpression: { receivingSessionId: { $type: "objectId" } } },
    why: "one identity per (count, position) — two terminals cannot share a sequence",
  },
  {
    collection: "barcodes",
    name: "receivingSessionId_1_sessionSequence_1",
    key: { receivingSessionId: 1, sessionSequence: 1 },
    why: "this count's labels in the order they were reserved",
  },
]);

async function survey() {
  return preflight.surveyIndexes(mongoose.connection.db, INDEXES);
}

function render(rows, applied, outcome = null) {
  const L = [""];
  L.push("RECEIVING SESSION (COUNT & LABEL) INDEXES");
  L.push(`  Mode           ${applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  for (const r of rows) {
    L.push(preflight.renderRow(r));
    L.push(`            ${r.why}`);
  }
  L.push("");
  const missing = rows.filter((r) => r.state === "missing").length;
  const conflicts = rows.filter((r) => r.state === "conflict").length;
  L.push(applied
    ? `  BUILT ${outcome ? outcome.built.length : missing} index(es). `
      + "Documents were neither read nor written."
    : `  ${missing} to build. Re-run with --apply. Nothing else is touched.`);
  if (conflicts) {
    L.push(`  ${conflicts} CONFLICT(S) left alone — a name is taken by a different index. `
      + "Decide what happens to those by hand.");
  }
  L.push("");
  return L.join("\n");
}

async function run({ apply = false } = {}) {
  const rows = await survey();
  if (!apply) return { ok: true, rows, applied: false, text: render(rows, false) };
  const outcome = await preflight.buildMissing(mongoose.connection.db, rows);
  return {
    ok: outcome.refused.length === 0,
    rows, applied: true, ...outcome, text: render(rows, true, outcome),
  };
}

async function main() {
  require("dotenv").config({ quiet: true });
  mongoose.set("autoIndex", false);
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({ apply: process.argv.includes("--apply") });
    console.log(out.text);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, render, INDEXES };
