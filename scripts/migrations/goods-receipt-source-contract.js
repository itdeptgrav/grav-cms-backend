#!/usr/bin/env node
// scripts/migrations/goods-receipt-source-contract.js
//
// TELL EVERY EXISTING GOODS RECEIPT WHAT IT IS A RECEIPT OF.
//
// A goods receipt used to be able to discharge exactly one thing: a Purchase
// Order. It now discharges either a purchase order or a customer-supplied
// material expectation on a job-work order, and it says which in `sourceType`.
//
// Every receipt written before that field existed IS a purchase receipt — there
// was no other kind — so the field defaults to PURCHASE_ORDER and nothing reads
// wrong without this migration. What this adds is the GENERIC source join, so a
// reader does not have to know which kind it is holding:
//
//   header  sourceType, sourceDocumentId, sourceDocumentNumber
//   line    sourceLineId
//
// on rows that have `purchaseOrderId` / `poItemId` and nothing generic.
//
// ── AND THE TWO INDEXES ─────────────────────────────────────────────────────
// Declared here rather than on the schema, deliberately. See the long note in
// `models/CMS_Models/StorePurchase/GoodsReceipt.js`: mongoose builds schema
// indexes lazily on first use, this collection is written inside the receipt
// transaction, and two more lazy builds were enough to make that transaction
// fail with a VersionError that mentioned nothing about indexes. Index creation
// belongs outside a transaction, which is what an explicit migration is.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//   · It never changes a quantity, a stock figure, a location balance or a PO
//     line. It fills in a join that was always implied and builds two indexes.
//   · It never invents a source for a receipt that names no purchase order.
//     Such a row is reported for a person to look at, because a receipt that
//     cannot say what it discharges is a data problem, not a formatting one.
//   · It never touches a row that already carries the generic join, so it is
//     rerunnable and a second run reports zero.
//   · It writes nothing without `--apply`.
//
//   node -r dotenv/config scripts/migrations/goods-receipt-source-contract.js
//   …--company-id=<id>   scope to one company (optional)
//   …--apply             write, after showing the same report
//   …--indexes-only      build the indexes and backfill nothing
//   …--json=<path>       where to save the full report
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const preflight = require("./lib/indexPreflight");

const str = (v) => String(v ?? "").trim();

/* The two reads these receipts are actually subject to: everything against one
   document, and everything held for one customer. */
const INDEXES = Object.freeze([
  {
    name: "companyId_1_sourceType_1_sourceDocumentId_1_receiptDate_-1",
    key: { companyId: 1, sourceType: 1, sourceDocumentId: 1, receiptDate: -1 },
    options: {},
  },
  {
    name: "companyId_1_customerMaterial.customerId_1_receiptDate_-1",
    key: { companyId: 1, "customerMaterial.customerId": 1, receiptDate: -1 },
    /* Sparse: only customer-material receipts carry a customer, and every
       purchase receipt would otherwise collide on a null. */
    options: { sparse: true },
  },
]);

/** Rows that still carry no generic source join. */
const UNSTAMPED = Object.freeze({
  $or: [{ sourceDocumentId: { $exists: false } }, { sourceDocumentId: null }],
});

async function survey(GoodsReceipt, companyId = null) {
  const scope = companyId ? { companyId } : {};
  const rows = await GoodsReceipt.find({ ...scope, ...UNSTAMPED })
    .select("_id companyId receiptNumber sourceType purchaseOrderId poNumber lines")
    .lean();

  const plan = [];
  /* A receipt that names no purchase order and no generic source cannot say what
     it discharges. Reported, never guessed at. */
    const unexplained = [];
  for (const g of rows) {
    if (!g.purchaseOrderId) {
      unexplained.push({ id: String(g._id), receiptNumber: str(g.receiptNumber) });
      continue;
    }
    const lines = (g.lines || []);
    plan.push({
      id: String(g._id),
      receiptNumber: str(g.receiptNumber),
      sourceDocumentId: String(g.purchaseOrderId),
      sourceDocumentNumber: str(g.poNumber),
      /* Lines whose generic join is missing and whose PO join is present. */
      lineFills: lines
        .map((l, i) => ({ i, id: l._id ? String(l._id) : "", poItemId: l.poItemId ? String(l.poItemId) : "" }))
        .filter((l) => l.poItemId && !lines[l.i].sourceLineId),
    });
  }

  const total = companyId
    ? await GoodsReceipt.countDocuments({ companyId })
    : await GoodsReceipt.estimatedDocumentCount();
  const already = total - rows.length;
  /* ── STRUCTURE, NOT NAME ──────────────────────────────────────────────────
     A name told us nothing: an equivalent index under another name was reported
     missing and would have been built twice, and a same-named index with the
     wrong key or without `sparse` was reported present and silently skipped. */
  const indexRows = await preflight.surveyIndexes(
    GoodsReceipt.db.db, INDEXES.map((i) => ({ ...i, collection: GoodsReceipt.collection.name })),
  );

  return {
    total,
    alreadyStamped: already,
    wouldStamp: plan.length,
    lineFills: plan.reduce((n, p) => n + p.lineFills.length, 0),
    unexplained,
    indexRows,
    indexesMissing: indexRows.filter((r) => r.state === "missing").map((r) => r.name),
    /* Reported separately, because a conflict is not a thing to build — it is a
       thing to look at. */
    indexConflicts: indexRows.filter((r) => r.state === "conflict")
      .map((r) => ({ name: r.name, differences: r.differences })),
    plan,
  };
}

function render(report) {
  const b = report.before;
  const L = [];
  L.push("");
  L.push("GOODS RECEIPT SOURCE CONTRACT");
  L.push(`  Company        ${report.companyId || "ALL companies"}`);
  L.push(`  Mode           ${report.applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  L.push("  WHAT IS THERE");
  L.push(`    Goods receipts in total                ${b.total}`);
  L.push(`    Already carrying the generic join      ${b.alreadyStamped}`);
  L.push("");
  L.push("  WHAT WOULD CHANGE");
  L.push(`    Headers to stamp                       ${b.wouldStamp}`);
  L.push(`    Lines to join                          ${b.lineFills}`);
  L.push(`    Indexes to build                       ${b.indexesMissing.length}`);
  for (const r of b.indexRows || []) L.push(`      ${preflight.renderRow(r)}`);
  L.push("");
  if ((b.indexConflicts || []).length) {
    L.push(`  INDEX CONFLICTS (${b.indexConflicts.length}) — a wanted name holds a different index.`);
    L.push("    Left alone: dropping and recreating an index on a live collection is a");
    L.push("    decision for somebody who can see its size and load.");
    L.push("");
  }
  if (b.unexplained.length) {
    L.push(`  CANNOT BE EXPLAINED (${b.unexplained.length}) — a receipt naming no purchase order`);
    L.push("    Nothing is invented for these. A receipt that cannot say what it discharges");
    L.push("    is a data problem for a person to look at.");
    for (const g of b.unexplained.slice(0, 20)) L.push(`    · ${g.receiptNumber || "(no number)"}  id ${g.id}`);
    L.push("");
  }
  if (report.applied) {
    L.push(`  WRITTEN. ${report.result.headers} header(s), ${report.result.lines} line(s), ${report.result.indexes} index(es).`);
  } else {
    L.push("  Re-run with --apply to write this.");
  }
  L.push("");
  return L.join("\n");
}

async function run({ companyId = null, apply = false, indexesOnly = false, jsonPath = "" } = {}) {
  const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
  const cid = companyId && mongoose.Types.ObjectId.isValid(str(companyId))
    ? new mongoose.Types.ObjectId(str(companyId)) : null;

  const before = await survey(GoodsReceipt, cid);
  const report = {
    at: new Date().toISOString(),
    companyId: cid ? String(cid) : null,
    applied: false, indexesOnly, before, result: null,
  };
  if (!apply) return { ok: true, report, text: render(report) };

  /* Missing ones built; conflicts refused and reported. */
  const indexOutcome = await preflight.buildMissing(GoodsReceipt.db.db, before.indexRows);
  const indexes = indexOutcome.built.length;

  let headers = 0;
  let lines = 0;
  if (!indexesOnly) {
    /* One guarded write per receipt. The filter re-asserts that the row is still
       unstamped, so a row written between the survey and the apply is left
       alone rather than overwritten. */
    for (const p of before.plan) {
      const set = {
        sourceType: "PURCHASE_ORDER",
        sourceDocumentId: new mongoose.Types.ObjectId(p.sourceDocumentId),
        sourceDocumentNumber: p.sourceDocumentNumber,
      };
      for (const lf of p.lineFills) set[`lines.${lf.i}.sourceLineId`] = new mongoose.Types.ObjectId(lf.poItemId);
      const res = await GoodsReceipt.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(p.id), ...UNSTAMPED },
        { $set: set },
      );
      if (res.modifiedCount) { headers += 1; lines += p.lineFills.length; }
    }
  }

  report.applied = true;
  report.result = { headers, lines, indexes, indexesRefused: indexOutcome.refused };
  if (jsonPath !== null) {
    const out = jsonPath
      || path.join(__dirname, `goods-receipt-source-contract-${report.at.replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    report.savedTo = out;
  }
  return { ok: true, report, text: render(report) };
}

/* ── COMMAND LINE ─────────────────────────────────────────────────────────── */

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

async function main() {
  require("dotenv").config({ quiet: true });
  /* ── A DRY RUN MUST BE A READ, AND `connect({autoIndex:false})` IS NOT ENOUGH ──
     Passing `autoIndex: false` to `connect` was believed to be sufficient. It is
     not: mongoose registers a model's declared indexes when the model is
     compiled and builds them on first use of the collection — and a survey that
     counts rows is first use. Running this script against a live database
     therefore CREATED the schema's indexes as a side effect of a dry run, which
     is precisely the thing a dry run promises not to do.

     `mongoose.set("autoIndex", false)` is global and applies before any model is
     touched, which is what actually holds. Set here rather than only in
     `connect` so that a future caller of `run()` from a script that forgot the
     connect option still cannot build an index by reading. */
  mongoose.set("autoIndex", false);

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  /* A dry run must be a read: autoIndex off, so connecting does not build an
     index before a single row is counted. */
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({
      companyId: arg("company-id") || null,
      apply: process.argv.includes("--apply"),
      indexesOnly: process.argv.includes("--indexes-only"),
      jsonPath: arg("json"),
    });
    console.log(out.text);
    if (out.report.savedTo) console.log(`  Report saved to ${out.report.savedTo}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, render, INDEXES, UNSTAMPED };
