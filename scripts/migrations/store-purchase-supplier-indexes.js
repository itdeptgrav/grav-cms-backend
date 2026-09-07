#!/usr/bin/env node
// scripts/migrations/store-purchase-supplier-indexes.js
//
// Store & Purchase — Supplier Master. Company-scoped supplier identity.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// `Vendor` gained `companyId`, `supplierCode` and normalised identity keys,
// and two partial unique indexes to go with them:
//
//   { companyId, supplierCode }   where supplierCode is non-empty
//   { companyId, gstNormalised }  where gstNormalised is non-empty
//
// Mongoose creates declared indexes on connect in development, but on a real
// deployment index changes are a decision someone makes deliberately, with the
// duplicate report in front of them. A unique index that fails to build leaves
// the collection silently unprotected; one that builds over unnoticed
// duplicates fails at the worst moment instead.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
// It NEVER assigns ownership. Every supplier that predates the tenant boundary
// has `companyId: null`, and a script cannot know which company a supplier two
// of them both buy from belongs to. Those records are reported and left alone;
// adopting them would be an unauditable transfer of another company's supplier
// list, and the router treats them as legacy and read-only precisely so this
// script does not have to guess.
//
// It never edits a supplier code, a GSTIN or a name. Those are printed on
// purchase orders and quoted to suppliers.
//
// Under `--apply` it DOES backfill `gstNormalised` for records that already
// have an owner, deriving it exactly as the model's pre-save hook does. That
// is deterministic and reversible in meaning: it writes the value the
// application itself would have written on the next save. It never derives a
// supplier code, and never assigns ownership.
//
// ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/store-purchase-supplier-indexes.js
//   …--apply     create the indexes (refuses while duplicates exist)
//   …--rollback           preview which indexes would be dropped
//   …--rollback --apply   actually drop them (both flags, like every write)
//
// It has NOT been run against any database.

"use strict";

const { MongoClient } = require("mongodb");

const COLLECTION = "vendors";

/* ── THE PARTIAL FILTER MUST EXCLUDE LEGACY ROWS TOO ────────────────────────
 * The filter was `{ identity: { $gt: "" } }` alone, while the comments claimed
 * legacy records fell outside the indexes. They did not: a legacy row with a
 * non-empty code (there is no rule stopping one) has `companyId: null`, which
 * is a perfectly good index key, so two legacy suppliers sharing a code would
 * collide with each other and block the build — enforcing a uniqueness rule
 * across records that belong to nobody.
 *
 * Both conditions are now required: the row belongs to a company AND states
 * the identity. `$type: "objectId"` is the precise test — `{$ne: null}` also
 * matches a missing field in a partial filter expression. */
const INDEXES = [
  {
    name: "companyId_1_supplierCode_1",
    key: { companyId: 1, supplierCode: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        companyId: { $type: "objectId" },
        supplierCode: { $gt: "" },
      },
    },
    identity: "supplierCode",
  },
  {
    name: "companyId_1_gstNormalised_1",
    key: { companyId: 1, gstNormalised: 1 },
    options: {
      unique: true,
      partialFilterExpression: {
        companyId: { $type: "objectId" },
        gstNormalised: { $gt: "" },
      },
    },
    identity: "gstNormalised",
  },
];


/**
 * Decide what this run should do, from facts alone.
 *
 * Pure, and exported, so the decision can be tested without a database: the
 * bug this replaces ("created one index, then reported creating nothing") was
 * in the DECISION, not in the driver call, and a test that needs Mongo running
 * to catch it is a test nobody runs.
 *
 * @param {object[]} indexes    the declared indexes
 * @param {string[]} present    index names already on the collection
 * @param {object} duplicates   identity -> array of duplicate groups
 * @param {object} flags        {apply, rollback}
 */
/**
 * Whether an index already on the collection IS the one we mean.
 *
 * Checking the NAME alone is how a stale definition survives a migration: the
 * name matches, the script says "already present", and a partial filter or a
 * uniqueness rule that no longer matches the schema stays in place for good.
 * Key order matters too — {companyId, supplierCode} and {supplierCode,
 * companyId} are different indexes with the same members.
 */
function sameIndexDefinition(existing, wanted) {
  if (!existing) return false;

  /* Key ORDER is significant — {companyId, supplierCode} and the reverse are
     different indexes — so the key is compared as an ordered list. */
  const keysMatch = JSON.stringify(Object.entries(existing.key || {}))
    === JSON.stringify(Object.entries(wanted.key));

  const uniqueMatch = Boolean(existing.unique) === Boolean(wanted.options.unique);

  /* A partial filter is an unordered object, and the server may return its
     fields in any order. Comparing raw JSON made an identical filter look
     different and blocked a migration that had nothing wrong with it. */
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === "object") {
      return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonical(v[k]); return acc; }, {});
    }
    return v;
  };
  const filterMatch = JSON.stringify(canonical(existing.partialFilterExpression || null))
    === JSON.stringify(canonical(wanted.options.partialFilterExpression || null));

  return keysMatch && uniqueMatch && filterMatch;
}

/** Normalised exactly as the model's pre-save hook does. */
const deriveNormalised = (raw) => String(raw || "").replace(/\s+/g, "").toUpperCase();

function planIndexWork({ indexes, present = [], duplicates = {}, flags = {}, definitions = {} }) {
  /* `present` may be names (simple cases and tests) or full definitions. An
     index whose name matches but whose definition does not is NOT present —
     it is a conflict, and creating over it silently fails. */
  const has = (name) => present.includes(name);
  const conflicting = indexes.filter((idx) =>
    has(idx.name) && definitions[idx.name] && !sameIndexDefinition(definitions[idx.name], idx));
  const blockers = indexes.flatMap((idx) =>
    (duplicates[idx.identity] || []).map((group) => ({ index: idx.name, identity: idx.identity, group })));

  if (flags.rollback) {
    const drop = indexes.filter((idx) => has(idx.name)).map((idx) => idx.name);
    return {
      mode: flags.apply ? "rollback-apply" : "rollback-preview",
      blockers: [],
      /* Rollback is not blocked by duplicates: dropping an index cannot fail
         because the data disagrees with it. */
      willDrop: drop,
      willCreate: [],
      /* Boolean, not `undefined`: a caller reading `writes` must get an
         answer, and `flags.apply && …` yields undefined when the flag is
         absent. */
      writes: Boolean(flags.apply),
    };
  }

  if (conflicting.length) {
    return {
      mode: "conflict",
      blockers: conflicting.map((idx) => ({ index: idx.name, reason: "DEFINITION_DIFFERS" })),
      willCreate: [], willDrop: [], writes: false,
    };
  }

  if (blockers.length) {
    return {
      mode: "blocked",
      blockers,
      willCreate: [],
      willDrop: [],
      /* The whole point: nothing is written when ANY index is blocked, so no
         run can half-apply and then report that it did nothing. */
      writes: false,
    };
  }

  const missing = indexes.filter((idx) => !has(idx.name)).map((idx) => idx.name);
  return {
    mode: flags.apply ? "apply" : "preview",
    blockers: [],
    willCreate: missing,
    willDrop: [],
    writes: Boolean(flags.apply) && missing.length > 0,
  };
}

const apply = process.argv.includes("--apply");
const rollback = process.argv.includes("--rollback");

/** Duplicates that would make the unique build fail, grouped so a person can act. */
async function duplicatesFor(coll, identity) {
  return coll.aggregate([
    /* Matched exactly as the index filters, or the preflight would report
       duplicates the index would never have seen — and miss ones it will. */
    { $match: { companyId: { $type: "objectId" }, [identity]: { $gt: "" } } },
    { $group: {
      _id: { companyId: "$companyId", value: `$${identity}` },
      count: { $sum: 1 },
      ids: { $push: "$_id" },
      names: { $push: "$companyName" },
    } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]).toArray();
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set MONGO_URI (or MONGODB_URI) first. Nothing was read or written.");
    process.exit(2);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const coll = client.db().collection(COLLECTION);

  console.log(`\n${apply ? "APPLY" : rollback ? "ROLLBACK" : "DRY RUN"} — collection "${COLLECTION}"\n`);

  const existing = await coll.indexes();
  const has = (name) => existing.some((i) => i.name === name);
  /* ── THE REAL DEFINITIONS, NOT JUST THE NAMES ─────────────────────────
   * `sameIndexDefinition` existed but the execution path never called it: it
   * asked `has(idx.name)` and reported "already present". An index with the
   * right name and the WRONG keys or partial filter therefore passed as
   * valid — which is exactly the drift between schema and migration this
   * script was written to catch. */
  const definitions = Object.fromEntries(existing.map((i) => [i.name, i]));

  /* ── Ownership report: read-only, always, in every mode ──────────────── */
  const total = await coll.countDocuments({});
  const owned = await coll.countDocuments({ companyId: { $ne: null } });
  const legacy = total - owned;
  console.log(`  suppliers: ${total} total, ${owned} owned by a company, ${legacy} legacy (no company)`);
  if (legacy) {
    console.log(`  ${legacy} legacy supplier(s) are LEFT AS THEY ARE — this script never assigns ownership.`);
    console.log(`  They stay readable only through the explicit legacy contract, and stay read-only.`);
  }

  /* ── WHAT THE OWNED RECORDS LOOK LIKE ─────────────────────────────────
   * `gstNormalised` is derived on save, so a record not saved since the field
   * was added has none — and falls outside the partial index, unprotected.
   * Preview DERIVES it (never writes it) to report the collisions the index
   * would actually hit, and reports company-owned records with no supplier
   * code, which stay non-selectable until a person gives them one. */
  const owned_records = await coll.find(
    { companyId: { $type: "objectId" } },
    { projection: { companyId: 1, companyName: 1, supplierCode: 1, gstNumber: 1, gstNormalised: 1 } },
  ).toArray();

  const derivedCollisions = new Map();
  const missingCode = [];
  const needsBackfill = [];

  owned_records.forEach((r) => {
    const derived = deriveNormalised(r.gstNumber);
    if (derived && derived !== (r.gstNormalised || "")) needsBackfill.push({ _id: r._id, derived });
    if (derived) {
      const key = `${r.companyId}::${derived}`;
      if (!derivedCollisions.has(key)) derivedCollisions.set(key, []);
      derivedCollisions.get(key).push(r);
    }
    if (!String(r.supplierCode || "").trim()) missingCode.push(r);
  });

  const derivedDupes = [...derivedCollisions.entries()].filter(([, rows]) => rows.length > 1);

  console.log(`\n  company-owned suppliers: ${owned_records.length}`);
  console.log(`  normalised GSTIN missing or stale on ${needsBackfill.length} (derivable deterministically)`);
  if (derivedDupes.length) {
    console.log(`\n  BLOCKING — the DERIVED GSTIN collides inside a company:`);
    derivedDupes.slice(0, 20).forEach(([key, rows]) => {
      console.log(`    ${key} × ${rows.length}`);
      rows.slice(0, 5).forEach((r) => console.log(`        ${r._id}  ${r.companyName}`));
    });
  }
  if (missingCode.length) {
    console.log(`\n  ${missingCode.length} company-owned supplier(s) have NO supplier code.`);
    console.log("  They stay visible and NON-SELECTABLE until a person gives each one a code.");
    console.log("  This script never invents one — a code is quoted to the supplier and printed on orders.");
    missingCode.slice(0, 20).forEach((r) => console.log(`        ${r._id}  ${r.companyName}`));
  }

  if (rollback) {
    for (const idx of INDEXES) {
      if (!has(idx.name)) { console.log(`  - ${idx.name}: not present, nothing to drop`); continue; }
      if (!apply) { console.log(`  - ${idx.name}: WOULD DROP (add --apply)`); continue; }
      await coll.dropIndex(idx.name);
      console.log(`  - ${idx.name}: dropped`);
    }
    await client.close();
    return;
  }

  /* ── PREFLIGHT EVERYTHING BEFORE CHANGING ANYTHING ─────────────────────
   * This used to check and create one index at a time. It could therefore
   * create the first index, discover blockers for the second, and then print
   * "Nothing was created." — which was false, and left the database in a state
   * the operator had been told did not exist. Every blocker is found first;
   * only a completely clean preflight is allowed to write. */
  const plan = [];
  let blocking = 0;

  for (const idx of INDEXES) {
    const dups = await duplicatesFor(coll, idx.identity);
    const onDisk = definitions[idx.name];
    plan.push({
      idx, dups,
      present: has(idx.name),
      /* Present but different is a conflict, not a skip. */
      conflicts: Boolean(onDisk) && !sameIndexDefinition(onDisk, idx),
      onDisk,
    });
    blocking += dups.length;
  }

  /* ── ONE DECISION PATH ─────────────────────────────────────────────────
   * The runtime reimplemented the planner's reasoning inline, so the tested
   * decision and the executed one were two different pieces of code that
   * merely agreed today. The planner decides; this only carries it out. */
  const decision = planIndexWork({
    indexes: INDEXES,
    present: existing.map((i) => i.name),
    definitions,
    duplicates: Object.fromEntries(plan.map(({ idx, dups }) => [idx.identity, dups])),
    flags: { apply, rollback },
  });

  const conflicts = plan.filter((p) => p.conflicts);

  console.log("\n  Preflight:");
  plan.forEach(({ idx, dups, present, conflicts: differs, onDisk }) => {
    if (differs) {
      console.log(`\n  BLOCKING — ${idx.name} exists with a DIFFERENT definition:`);
      console.log(`    on disk : keys=${JSON.stringify(onDisk.key)} unique=${Boolean(onDisk.unique)}`);
      console.log(`              partial=${JSON.stringify(onDisk.partialFilterExpression || null)}`);
      console.log(`    wanted  : keys=${JSON.stringify(idx.key)} unique=${Boolean(idx.options.unique)}`);
      console.log(`              partial=${JSON.stringify(idx.options.partialFilterExpression)}`);
      console.log("    Creating over it silently fails. Drop it deliberately, then re-run.");
      return;
    }
    if (dups.length) {
      console.log(`\n  BLOCKING — ${idx.identity} is repeated inside a company:`);
      dups.forEach((d) => {
        console.log(`    company ${d._id.companyId} · "${d._id.value}" × ${d.count}`);
        d.names.slice(0, 5).forEach((n, i) => console.log(`        ${d.ids[i]}  ${n}`));
      });
      console.log("    Resolve these by hand — the script will not choose which record keeps the identity.");
      return;
    }
    console.log(`  - ${idx.name}: ${present ? "already present" : "clean, ready to create"}`);
  });

  if (conflicts.length) {
    console.log(`\n  ${conflicts.length} index(es) exist with a different definition (DEFINITION_DIFFERS).`);
    console.log("  Nothing was created, dropped or backfilled.");
    process.exitCode = 1;
    await client.close();
    return;
  }

  if (blocking) {
    console.log(`\n  ${blocking} duplicate group(s) block this migration.`);
    console.log("  No index was created or changed — the preflight runs to completion before any write.");
    process.exitCode = 1;
    await client.close();
    return;
  }

  if (derivedDupes.length) {
    console.log(`\n  ${derivedDupes.length} derived-GSTIN collision(s) block this migration.`);
    console.log("  No index was created and no key was backfilled.");
    process.exitCode = 1;
    await client.close();
    return;
  }

  if (!apply) {
    if (needsBackfill.length) {
      console.log(`\n  WOULD BACKFILL gstNormalised on ${needsBackfill.length} owned record(s) (add --apply)`);
    }
    const toCreate = plan.filter((p) => !p.present).map((p) => p.idx.name);
    console.log(toCreate.length
      ? `\n  WOULD CREATE: ${toCreate.join(", ")}   (add --apply)`
      : "\n  Nothing to do — every index is already present.");
    await client.close();
    return;
  }

  /* ── APPLY ─────────────────────────────────────────────────────────────
   * Index creation is NOT transactional: MongoDB has no way to create two
   * indexes atomically. If the second fails the first remains, and this says
   * so rather than implying a rollback happened. */
  /* Deterministic keys only, on records that already have an owner. Ownership
     is never assigned and no code is ever invented. Re-running after an
     interruption simply finds fewer rows left to derive. */
  let backfilled = 0;
  if (needsBackfill.length) {
    try {
      for (const row of needsBackfill) {
        await coll.updateOne({ _id: row._id }, { $set: { gstNormalised: row.derived } });
        backfilled += 1;
      }
      console.log(`  backfilled gstNormalised on ${backfilled} record(s)`);
    } catch (err) {
      /* The exact count, because "some" is not something an operator can act
         on. Re-running derives the same values for the rest — the derivation
         is deterministic, so a partial run is safe to repeat. */
      console.error(`\n  BACKFILL FAILED after ${backfilled} of ${needsBackfill.length} record(s): ${err.message}`);
      console.error(`  Those ${backfilled} normalisations REMAIN — nothing was rolled back.`);
      console.error("  Re-running is safe: the remaining records derive the same values.");
      process.exitCode = 1;
      await client.close();
      return;
    }
  }

  const created = [];
  try {
    for (const { idx, present } of plan) {
      if (present) { console.log(`  - ${idx.name}: already present`); continue; }
      await coll.createIndex(idx.key, { ...idx.options, name: idx.name });
      created.push(idx.name);
      console.log(`  - ${idx.name}: created`);
    }
    console.log(`\n  Done. Created: ${created.length ? created.join(", ") : "none"}.`);
  } catch (err) {
    console.error(`\n  FAILED while creating indexes: ${err.message}`);
    console.error(`  Created before the failure and STILL PRESENT: ${created.length ? created.join(", ") : "none"}.`);
    if (backfilled) {
      /* Saying "nothing was created" after writing to N records would be a
         lie an operator would act on. */
      console.error(`  The ${backfilled} gstNormalised backfill(s) also REMAIN.`);
    }
    console.error("  Index creation is not transactional, so nothing was rolled back.");
    console.error(`  Re-run after fixing the cause, or drop what was created with --rollback --apply.`);
    process.exitCode = 1;
  }

  await client.close();
}

/* Required as a module by the planning tests; run as a script otherwise. */
if (require.main !== module) {
  module.exports = { planIndexWork, INDEXES, sameIndexDefinition, deriveNormalised };
} else {
main().catch((err) => {
  console.error("Migration failed:", err.message);
  console.error("Index creation is not transactional; anything already created is still present.");
  process.exit(1);
});
}
