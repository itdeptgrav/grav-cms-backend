#!/usr/bin/env node
// scripts/migrations/store-purchase-mrf-number-index.js
//
// Store & Purchase — Chunk 1B. Retiring the global material-request number.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Material requests are now numbered per company, atomically, through
// SpDocumentSequence — so two companies each legitimately hold
// `MRF/2026-27/0001`. The legacy GLOBAL unique index `mrfNumber_1` rejects the
// second one, which means a multi-company deployment cannot accept its second
// company's first request. Mongoose creates indexes it declares but NEVER
// drops one it stopped declaring, so removing `unique: true` from the schema
// does not remove the index from a running deployment. It has to be dropped
// deliberately, which is what this script is for.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It never renumbers an existing request. Numbers already issued are on paper,
// in emails and in people's heads; changing one to fit a new scheme would be a
// worse problem than the one being fixed. Old numbers keep their old shape
// (`MRF-2609-0004`) and new ones take the sequence shape
// (`MRF/2026-27/0001`) — they coexist, and nothing reads meaning from the
// format.
//
// It never assigns company ownership to a legacy request. Unowned documents
// are reported and left alone; adopting them is a separate, authorised
// decision this migration does not make.
//
// ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/store-purchase-mrf-number-index.js
//   …--apply     actually make the changes
//   …--rollback  restore the global unique index (only if the data permits)
//
// It has not been run against any real database.

"use strict";

const { MongoClient } = require("mongodb");

const COLLECTION = "mrves";          // Mongoose pluralises "MRF" to this
const LEGACY_INDEX = "mrfNumber_1";
const COMPOUND_INDEX = { companyId: 1, mrfNumber: 1 };
const COMPOUND_NAME = "companyId_1_mrfNumber_1";

/**
 * Refuse to change an index while the data would violate it.
 *
 * Creating a unique index over duplicate data fails anyway, but that failure
 * names one document. This names all of them, before anything is touched, so
 * the decision is made with the whole picture.
 */
async function detectConflicts(db) {
  const findings = [];

  /* Duplicate (companyId, mrfNumber) — exactly what the new index forbids.
     `companyId: null` groups every legacy request together, which is right:
     they must stay unique among themselves. */
  const dupes = await db.collection(COLLECTION).aggregate([
    {
      $group: {
        _id: { companyId: "$companyId", mrfNumber: "$mrfNumber" },
        count: { $sum: 1 },
        ids: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $limit: 200 },
  ]).toArray();

  if (dupes.length) {
    findings.push({
      severity: "BLOCKING",
      what: "Duplicate (companyId, mrfNumber) pairs",
      detail:
        "The compound unique index cannot be created until a human decides what each " +
        "duplicate should be. This script will not renumber anything itself.",
      rows: dupes.map((d) => ({
        companyId: d._id.companyId,
        mrfNumber: d._id.mrfNumber,
        count: d.count,
        ids: d.ids.slice(0, 5),
      })),
    });
  }

  /* Requests with no number at all would violate `required` and cannot be
     indexed meaningfully. Worth knowing about before, not during. */
  const numberless = await db.collection(COLLECTION).countDocuments({
    $or: [{ mrfNumber: { $exists: false } }, { mrfNumber: null }, { mrfNumber: "" }],
  });
  if (numberless) {
    findings.push({
      severity: "BLOCKING",
      what: "Requests with no number",
      detail: `${numberless} document(s) carry no mrfNumber. Give them one before indexing.`,
      rows: [],
    });
  }

  /* Legacy-global requests. REPORTED, never adopted. */
  const legacy = await db.collection(COLLECTION).countDocuments({
    $or: [{ companyId: { $exists: false } }, { companyId: null }],
  });
  if (legacy) {
    findings.push({
      severity: "INFORMATIONAL",
      what: "Requests with no company",
      detail:
        `${legacy} request(s) predate the tenant boundary. They stay unowned and ` +
        `read-only. The compound index treats them as one group, so they remain ` +
        `unique among themselves.`,
      rows: [],
    });
  }

  return findings;
}

async function currentIndexes(db) {
  try {
    return await db.collection(COLLECTION).indexes();
  } catch {
    return [];                                  // collection does not exist yet
  }
}

async function plan(db, { rollback }) {
  const have = await currentIndexes(db);
  const byName = new Map(have.map((i) => [i.name, i]));
  const steps = [];

  if (rollback) {
    if (byName.has(COMPOUND_NAME)) {
      steps.push({ action: "dropIndex", name: COMPOUND_NAME });
    }
    if (!byName.has(LEGACY_INDEX)) {
      steps.push({
        action: "createIndex", name: LEGACY_INDEX,
        keys: { mrfNumber: 1 }, options: { unique: true, name: LEGACY_INDEX },
      });
    }
    return steps;
  }

  if (!byName.has(COMPOUND_NAME)) {
    steps.push({
      action: "createIndex", name: COMPOUND_NAME,
      keys: COMPOUND_INDEX, options: { unique: true, name: COMPOUND_NAME },
    });
  }
  /* Dropped only AFTER the replacement exists, so no window passes without
     some uniqueness guarantee on the number. */
  if (byName.has(LEGACY_INDEX)) {
    steps.push({ action: "dropIndex", name: LEGACY_INDEX });
  }
  return steps;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set MONGO_URI (or MONGODB_URI) first. Nothing was done.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  try {
    console.log(`\nMaterial-request numbering — ${apply ? "APPLY" : "DRY RUN"}${rollback ? " (rollback)" : ""}`);
    console.log(`Collection: ${COLLECTION}\n`);

    const findings = await detectConflicts(db);
    for (const f of findings) {
      console.log(`[${f.severity}] ${f.what}`);
      console.log(`  ${f.detail}`);
      for (const row of f.rows) console.log(`  · ${JSON.stringify(row)}`);
      console.log("");
    }

    const blocking = findings.filter((f) => f.severity === "BLOCKING");
    const steps = await plan(db, { rollback });

    if (!steps.length) {
      console.log("Nothing to change — the indexes are already as intended.\n");
      return;
    }

    console.log("Planned:");
    for (const s of steps) console.log(`  ${s.action} ${s.name}`);
    console.log("");

    if (blocking.length) {
      console.log("REFUSED: resolve the blocking findings above first. Nothing was changed.\n");
      process.exitCode = 2;
      return;
    }

    if (!apply) {
      console.log("Dry run — nothing was changed. Re-run with --apply to make it so.\n");
      return;
    }

    for (const s of steps) {
      if (s.action === "createIndex") {
        await db.collection(COLLECTION).createIndex(s.keys, s.options);
        console.log(`  created ${s.name}`);
      } else {
        await db.collection(COLLECTION).dropIndex(s.name);
        console.log(`  dropped ${s.name}`);
      }
    }
    console.log("\nDone.\n");
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { detectConflicts, plan, COLLECTION, LEGACY_INDEX, COMPOUND_NAME };
