#!/usr/bin/env node
// scripts/migrations/store-purchase-chunk1-indexes.js
//
// Store & Purchase — Chunk 1 index migration.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Numbering is now per company, so two companies each legitimately hold
// `PO/2026-27/0001`. The legacy GLOBAL unique index `poNumber_1` rejects the
// second one — meaning a multi-company deployment cannot raise its second
// company's first order. Mongoose creates missing indexes but never drops
// one, so the schema change alone does not fix it.
//
// ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/store-purchase-chunk1-indexes.js
//   …--apply     actually make the changes
//   …--rollback  restore the global unique index (only if data permits)
//
// It NEVER assigns company ownership to a legacy record. Unowned documents are
// reported and left exactly as they are; adopting them is a separate,
// authorised decision that this chunk does not make.

"use strict";

const { MongoClient } = require("mongodb");

const LEGACY_PO_INDEX = "poNumber_1";
const COMPOUND_PO_INDEX = { companyId: 1, poNumber: 1 };

/** Every index Chunk 1 relies on, so a fresh deployment can be brought up. */
const REQUIRED_INDEXES = [
  { collection: "purchaseorders", keys: { companyId: 1, poNumber: 1 }, options: { unique: true, name: "companyId_1_poNumber_1" } },
  { collection: "purchaseorders", keys: { companyId: 1, status: 1, createdAt: -1 }, options: { name: "companyId_1_status_1_createdAt_-1" } },
  { collection: "sp_company_memberships", keys: { companyId: 1, email: 1 }, options: { unique: true, sparse: true, name: "companyId_1_email_1" } },
  { collection: "sp_company_memberships", keys: { companyId: 1, employeeRef: 1 }, options: { unique: true, sparse: true, name: "companyId_1_employeeRef_1" } },
  { collection: "sp_document_sequences", keys: { companyId: 1, documentType: 1, fiscalYear: 1, siteId: 1 }, options: { unique: true, name: "sp_sequence_key" } },
  { collection: "sp_idempotency_records", keys: { companyId: 1, actorId: 1, operation: 1, key: 1 }, options: { unique: true, name: "sp_idempotency_key" } },
  { collection: "sp_idempotency_records", keys: { createdAt: 1 }, options: { expireAfterSeconds: 30 * 24 * 60 * 60, name: "sp_idempotency_ttl" } },
  { collection: "sp_action_history", keys: { companyId: 1, entityType: 1, entityId: 1, at: -1 }, options: { name: "sp_history_entity" } },
  { collection: "sp_action_history", keys: { companyId: 1, at: -1 }, options: { name: "sp_history_recent" } },
  { collection: "sp_approval_policies", keys: { companyId: 1, documentType: 1, isActive: 1 }, options: { name: "sp_policy_lookup" } },
];

/**
 * Refuse to change an index while the data would violate it.
 *
 * Creating a unique index over duplicate data fails loudly anyway, but the
 * failure names one document. This names all of them, before anything is
 * touched, so the decision can be made with the whole picture.
 */
async function detectConflicts(db) {
  const findings = [];

  /* Duplicate (companyId, poNumber) — what the new unique index forbids.
     `companyId: null` groups every legacy order together, which is correct:
     they must remain unique among themselves. */
  const dupes = await db.collection("purchaseorders").aggregate([
    { $group: { _id: { companyId: "$companyId", poNumber: "$poNumber" }, count: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 200 },
  ]).toArray();
  if (dupes.length) {
    findings.push({
      severity: "BLOCKING",
      what: "Duplicate (companyId, poNumber) pairs",
      detail: "The compound unique index cannot be created until these are resolved by a human.",
      rows: dupes.map((d) => ({ companyId: d._id.companyId, poNumber: d._id.poNumber, count: d.count, ids: d.ids.slice(0, 5) })),
    });
  }

  /* Legacy-global orders. REPORTED, never assigned. */
  const unowned = await db.collection("purchaseorders").countDocuments({
    $or: [{ companyId: { $exists: false } }, { companyId: null }],
  });
  if (unowned) {
    findings.push({
      severity: "INFORMATIONAL",
      what: `${unowned} purchase order(s) carry no company`,
      detail: "These are legacy-global records. This migration does NOT assign ownership — adopting them is a separate, authorised decision.",
    });
  }

  /* Memberships that would collide under the unique membership indexes. */
  const memberDupes = await db.collection("sp_company_memberships").aggregate([
    { $group: { _id: { companyId: "$companyId", email: "$email" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 }, "_id.email": { $ne: null } } },
    { $limit: 50 },
  ]).toArray().catch(() => []);
  if (memberDupes.length) {
    findings.push({
      severity: "BLOCKING",
      what: "Duplicate memberships for one person in one company",
      rows: memberDupes,
    });
  }

  return findings;
}

async function currentIndexes(db, collection) {
  try {
    return await db.collection(collection).indexes();
  } catch {
    return []; // collection does not exist yet
  }
}

async function plan(db) {
  const steps = [];

  const poIndexes = await currentIndexes(db, "purchaseorders");
  if (poIndexes.some((i) => i.name === LEGACY_PO_INDEX)) {
    steps.push({
      action: "DROP_INDEX",
      collection: "purchaseorders",
      name: LEGACY_PO_INDEX,
      why: "A global unique PO number blocks per-company numbering: two companies legitimately both hold PO/2026-27/0001.",
    });
  }

  for (const req of REQUIRED_INDEXES) {
    const existing = await currentIndexes(db, req.collection);
    if (!existing.some((i) => i.name === req.options.name)) {
      steps.push({ action: "CREATE_INDEX", collection: req.collection, name: req.options.name, keys: req.keys, options: req.options });
    }
  }

  return steps;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://localhost:27017/grav_clothing";

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db();
    console.log(`Database: ${db.databaseName}`);
    console.log(apply ? "MODE: APPLY" : rollback ? "MODE: ROLLBACK" : "MODE: DRY RUN (nothing will change)");
    console.log("");

    const findings = await detectConflicts(db);
    for (const f of findings) {
      console.log(`[${f.severity}] ${f.what}`);
      if (f.detail) console.log(`    ${f.detail}`);
      for (const row of (f.rows || []).slice(0, 20)) console.log(`    ${JSON.stringify(row)}`);
    }
    const blocking = findings.filter((f) => f.severity === "BLOCKING");
    console.log("");

    if (rollback) {
      /* Structurally possible only while no two companies share a number. */
      const wouldCollide = await db.collection("purchaseorders").aggregate([
        { $group: { _id: "$poNumber", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }, { $limit: 1 },
      ]).toArray();
      if (wouldCollide.length) {
        console.log("ROLLBACK REFUSED: purchase orders now share numbers across companies, which the global unique index forbids.");
        console.log("Rolling back would require deciding which of those orders to renumber — a business decision, not a script's.");
        process.exit(1);
      }
      console.log(apply ? "Recreating the global unique index…" : "Would recreate the global unique index poNumber_1.");
      if (apply) await db.collection("purchaseorders").createIndex({ poNumber: 1 }, { unique: true, name: LEGACY_PO_INDEX });
      console.log("Done.");
      return;
    }

    const steps = await plan(db);
    if (!steps.length) {
      console.log("Nothing to do — every index is already as Chunk 1 expects.");
      return;
    }

    for (const step of steps) {
      console.log(`${apply ? "APPLYING" : "WOULD APPLY"}: ${step.action} ${step.collection}.${step.name}`);
      if (step.why) console.log(`    ${step.why}`);
    }

    if (!apply) {
      console.log("\nDry run only. Re-run with --apply to make these changes.");
      return;
    }

    if (blocking.length) {
      console.log("\nREFUSED: blocking findings above must be resolved first.");
      process.exit(1);
    }

    for (const step of steps) {
      if (step.action === "DROP_INDEX") {
        await db.collection(step.collection).dropIndex(step.name);
      } else {
        /* Idempotent: creating an index that already exists with the same
           spec is a no-op, so a half-finished run can simply be re-run. */
        await db.collection(step.collection).createIndex(step.keys, step.options);
      }
      console.log(`  done: ${step.name}`);
    }
    console.log("\nMigration complete.");
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((err) => { console.error("Migration failed:", err); process.exit(1); });
}

module.exports = { detectConflicts, plan, REQUIRED_INDEXES, LEGACY_PO_INDEX, COMPOUND_PO_INDEX };
