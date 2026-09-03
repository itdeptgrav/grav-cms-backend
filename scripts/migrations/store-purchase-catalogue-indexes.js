#!/usr/bin/env node
// scripts/migrations/store-purchase-catalogue-indexes.js
//
// Store & Purchase — Chunk 1B. Retiring the global catalogue uniqueness.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Item codes and unit names are company data. Two companies may each stock an
// item coded `RAW-FAB-CTN-001`, and each may define a unit called "roll" —
// meaning 40 metres in one set of books and 25 in the other. The legacy GLOBAL
// unique indexes `sku_1` on rawitems and `name_1` on units reject the second
// of each, so a multi-company deployment cannot create its second company's
// first item or its first unit.
//
// Mongoose creates the indexes it declares but NEVER drops one it has stopped
// declaring. Removing `unique: true` from the schemas therefore changes
// nothing on a running deployment: the old index is still there, still
// enforcing global uniqueness. It has to be retired deliberately.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It never renames an item or a unit. A code is printed on purchase orders,
// quoted in emails and written on shelf labels; changing one to fit a new
// index would be a worse problem than the one being fixed.
//
// It never assigns company ownership. Items and units that predate the tenant
// boundary carry no `companyId`; they are reported and left exactly as they
// are. Adopting them into whichever company happened to run this would be a
// silent, unauditable transfer of another company's catalogue.
//
// ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/store-purchase-catalogue-indexes.js
//   …--apply     actually make the changes
//   …--rollback  restore the global unique indexes (only if the data permits)
//
// It has NOT been run against any database.

"use strict";

const { MongoClient } = require("mongodb");

const TARGETS = [
  {
    collection: "rawitems",
    field: "sku",
    legacyIndex: "sku_1",
    compoundName: "companyId_1_sku_1",
    compoundKeys: { companyId: 1, sku: 1 },
    label: "item code",
  },
  {
    collection: "units",
    field: "name",
    legacyIndex: "name_1",
    compoundName: "companyId_1_name_1",
    compoundKeys: { companyId: 1, name: 1 },
    label: "unit name",
  },
];

/**
 * Refuse to change an index while the data would violate it.
 *
 * Creating a unique index over duplicate data fails anyway, but that failure
 * names one document. This names all of them, before anything is touched, so
 * the decision is made with the whole picture.
 */
async function detectConflicts(db) {
  const findings = [];

  for (const t of TARGETS) {
    const dupes = await db.collection(t.collection).aggregate([
      {
        $group: {
          _id: { companyId: "$companyId", value: `$${t.field}` },
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
        what: `Duplicate (companyId, ${t.field}) pairs in ${t.collection}`,
        detail: `The compound unique index cannot be created until a human decides `
              + `what each duplicate ${t.label} should be. This script renames nothing.`,
        rows: dupes.map((d) => ({
          companyId: d._id.companyId, [t.field]: d._id.value, count: d.count,
          ids: d.ids.slice(0, 5),
        })),
      });
    }

    const blank = await db.collection(t.collection).countDocuments({
      $or: [{ [t.field]: { $exists: false } }, { [t.field]: null }, { [t.field]: "" }],
    });
    if (blank) {
      findings.push({
        severity: "BLOCKING",
        what: `${t.collection} records with no ${t.field}`,
        detail: `${blank} document(s) carry no ${t.label}. Give them one before indexing.`,
        rows: [],
      });
    }

    /* Legacy-global records. REPORTED, never adopted. */
    const legacy = await db.collection(t.collection).countDocuments({
      $or: [{ companyId: { $exists: false } }, { companyId: null }],
    });
    if (legacy) {
      findings.push({
        severity: "INFORMATIONAL",
        what: `${t.collection} records with no company`,
        detail: `${legacy} record(s) predate the tenant boundary. They stay unowned and `
              + `read-only. The compound index treats them as one group, so they remain `
              + `unique among themselves.`,
        rows: [],
      });
    }
  }

  return findings;
}

async function currentIndexes(db, collection) {
  try {
    return await db.collection(collection).indexes();
  } catch {
    return [];                              // the collection does not exist yet
  }
}

async function plan(db, { rollback }) {
  const steps = [];
  for (const t of TARGETS) {
    const have = await currentIndexes(db, t.collection);
    const byName = new Map(have.map((i) => [i.name, i]));

    if (rollback) {
      if (byName.has(t.compoundName)) {
        steps.push({ collection: t.collection, action: "dropIndex", name: t.compoundName });
      }
      if (!byName.has(t.legacyIndex)) {
        steps.push({
          collection: t.collection, action: "createIndex", name: t.legacyIndex,
          keys: { [t.field]: 1 }, options: { unique: true, name: t.legacyIndex },
        });
      }
      continue;
    }

    if (!byName.has(t.compoundName)) {
      steps.push({
        collection: t.collection, action: "createIndex", name: t.compoundName,
        keys: t.compoundKeys, options: { unique: true, name: t.compoundName },
      });
    }
    /* Dropped only AFTER the replacement exists, so no window passes with no
       uniqueness guarantee on the code at all. */
    if (byName.has(t.legacyIndex)) {
      steps.push({ collection: t.collection, action: "dropIndex", name: t.legacyIndex });
    }
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
    console.log(`\nCatalogue uniqueness — ${apply ? "APPLY" : "DRY RUN"}${rollback ? " (rollback)" : ""}`);
    console.log(`Collections: ${TARGETS.map((t) => t.collection).join(", ")}\n`);

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
    for (const s of steps) console.log(`  ${s.collection}: ${s.action} ${s.name}`);
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
        await db.collection(s.collection).createIndex(s.keys, s.options);
        console.log(`  ${s.collection}: created ${s.name}`);
      } else {
        await db.collection(s.collection).dropIndex(s.name);
        console.log(`  ${s.collection}: dropped ${s.name}`);
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

module.exports = { detectConflicts, plan, TARGETS };
