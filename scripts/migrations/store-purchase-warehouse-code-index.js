// scripts/migrations/store-purchase-warehouse-code-index.js
//
// Store & Purchase — Chunk B3. Replace the global warehouse-code index with a
// company-scoped one.
//
// ── WHY THIS IS NEEDED ──────────────────────────────────────────────────────
// The original Warehouse schema declared `shortName` unique with no company in
// the key, so the index `shortName_1` is unique ACROSS EVERY COMPANY. Mongoose
// builds missing indexes but never removes one, so declaring the new
// company-scoped index does not retire the old one: until it is dropped, the
// second company to want a warehouse called "MAIN" still cannot have one.
//
// ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
//   · It never runs on its own. Nothing here executes without --apply.
//   · It never assigns a company to a legacy warehouse. Deciding who owns an
//     unscoped record is a business question, not a migration's to guess.
//   · It refuses to drop anything while dropping would let a genuine
//     duplicate through. The collision report comes first, every time.
//
// ── USAGE ───────────────────────────────────────────────────────────────────
//   node scripts/migrations/store-purchase-warehouse-code-index.js
//       preview: report indexes and collisions, change nothing
//   …--apply
//       drop the global index and create the scoped one, if it is safe
//   …--rollback
//       recreate the global unique index (see the rollback notes it prints)
//
// The planning logic is exported so it can be tested without a database.
"use strict";

const COLLECTION = "warehouses";
const LEGACY_INDEX = "shortName_1";
const SCOPED_INDEX = "warehouse_code_per_company";

/* ══════════════════════════════════════════════════════════════════════════
 * WHAT "THE SCOPED INDEX IS PRESENT" HAS TO MEAN
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The exact definition the application depends on.
 *
 * ── WHY THE WHOLE DEFINITION IS COMPARED ────────────────────────────────────
 * Verification used to check a NAME and a `unique` flag. A name is a label
 * somebody chose: an index called `warehouse_code_per_company` that is unique
 * on `{shortName: 1}` alone, or on `{shortName: 1, companyId: 1}` in the wrong
 * order, or without the partial filter, passes that check completely — and the
 * global index is then dropped on the strength of it, leaving the collection
 * with protection that is not the protection anybody believes is there.
 *
 * Every part of the definition is load-bearing:
 *   · KEY ORDER — `{companyId, shortName}` and `{shortName, companyId}` are
 *     different indexes; a prefix query on companyId only uses the first.
 *   · UNIQUE — without it there is no constraint at all, only a lookup.
 *   · PARTIAL FILTER — without it, every legacy warehouse with no companyId
 *     collides with every other one, and the index cannot even be built.
 *   · NAME — what the drop and rollback steps address.
 */
const REQUIRED_SCOPED_INDEX = Object.freeze({
  name: SCOPED_INDEX,
  key: Object.freeze({ companyId: 1, shortName: 1 }),
  unique: true,
  partialFilterExpression: Object.freeze({ companyId: { $type: "objectId" } }),
});

/** Deep equality for the small, JSON-shaped values an index definition holds. */
function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  /* Key ORDER is compared, not just membership: it is what distinguishes one
     compound index from another. */
  return ka.every((k, i) => kb[i] === k && sameValue(a[k], b[k]));
}

/**
 * Does this index, as the server reports it, match what is required?
 *
 * The single comparison both the planner and the executor use, so a plan can
 * never say "safe" on one rule while the apply step checks another.
 *
 * @param {object|null|undefined} actual  an entry from `collection.indexes()`
 * @returns {{present: boolean, matches: boolean, differences: string[]}}
 */
function compareScopedIndex(actual) {
  if (!actual) return { present: false, matches: false, differences: ["it does not exist"] };

  const differences = [];
  if (!sameValue(actual.key, REQUIRED_SCOPED_INDEX.key)) {
    differences.push(
      `key is ${JSON.stringify(actual.key)}, required ${JSON.stringify(REQUIRED_SCOPED_INDEX.key)}` +
      (sameValue(
        Object.fromEntries(Object.keys(actual.key || {}).sort().map((k) => [k, actual.key[k]])),
        Object.fromEntries(Object.keys(REQUIRED_SCOPED_INDEX.key).sort().map((k) => [k, REQUIRED_SCOPED_INDEX.key[k]])),
      ) ? " (same fields, different order)" : ""),
    );
  }
  if (actual.unique !== true) differences.push("it is not unique");
  if (!sameValue(actual.partialFilterExpression, REQUIRED_SCOPED_INDEX.partialFilterExpression)) {
    differences.push(
      `partialFilterExpression is ${JSON.stringify(actual.partialFilterExpression ?? null)}, ` +
      `required ${JSON.stringify(REQUIRED_SCOPED_INDEX.partialFilterExpression)}`,
    );
  }
  if (actual.name !== REQUIRED_SCOPED_INDEX.name) {
    differences.push(`name is "${actual.name}", required "${REQUIRED_SCOPED_INDEX.name}"`);
  }
  return { present: true, matches: differences.length === 0, differences };
}

/* ══════════════════════════════════════════════════════════════════════════
 * PLANNING — pure, and tested without connecting to anything
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Which warehouse codes would collide under the NEW scoped rule.
 *
 * The new key is {companyId, shortName}, so a collision is two records sharing
 * BOTH. Records with no companyId are legacy-global: they are reported
 * separately and are deliberately not treated as colliding with anything,
 * because the partial index excludes them.
 *
 * @param {Array<{_id, companyId, shortName}>} rows
 * @returns {{collisions: Array, legacy: Array, scoped: number}}
 */
function findCollisions(rows) {
  const groups = new Map();
  const legacy = [];
  for (const r of rows || []) {
    const code = String(r.shortName ?? "").toUpperCase();
    if (!r.companyId) { legacy.push({ _id: r._id, shortName: code }); continue; }
    const key = `${String(r.companyId)}::${code}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r._id);
  }
  const collisions = [];
  for (const [key, ids] of groups) {
    if (ids.length > 1) {
      const [companyId, shortName] = key.split("::");
      collisions.push({ companyId, shortName, count: ids.length, ids });
    }
  }
  return { collisions, legacy, scoped: groups.size };
}

/**
 * What the migration would do, given what is on the collection.
 *
 * @returns {{safe, steps: Array, blockers: Array, notes: Array}}
 */
function planMigration({ indexes = [], rows = [] } = {}) {
  const names = indexes.map((i) => i.name);
  const { collisions, legacy } = findCollisions(rows);

  const steps = [];
  const blockers = [];
  const notes = [];

  if (collisions.length) {
    blockers.push(
      `${collisions.length} company/code pair${collisions.length === 1 ? "" : "s"} already duplicated. ` +
      "The scoped unique index cannot be created until each is resolved by hand.",
    );
  }

  /* ── ORDER MATTERS ──────────────────────────────────────────────────────
     Dropping the global index first leaves the collection with NO uniqueness
     on the code at all — and if creating the replacement then fails, it stays
     that way. The scoped index is created and verified first, so the drop
     only ever removes redundant protection. */
  const existingScoped = indexes.find((i) => i.name === SCOPED_INDEX);
  const scoped = compareScopedIndex(existingScoped);

  if (!scoped.present) {
    steps.push({ action: "CREATE", index: SCOPED_INDEX, definition: REQUIRED_SCOPED_INDEX });
  } else if (!scoped.matches) {
    /* ── AN INDEX UNDER THE RIGHT NAME IS NOT THE RIGHT INDEX ────────────
       It is NOT silently recreated. Dropping and rebuilding a unique index
       on live data can fail halfway and leave the collection unprotected,
       and whatever is there was put there by somebody — deciding it is
       wrong is a person's call, not this script's. */
    blockers.push(
      `${SCOPED_INDEX} exists but does not match the definition the application requires: ` +
      `${scoped.differences.join("; ")}. Resolve it by hand; this migration will not drop or rebuild it.`,
    );
    steps.push({ action: "DEFINITION_DIFFERS", index: SCOPED_INDEX, differences: scoped.differences });
  } else {
    notes.push(`${SCOPED_INDEX} already exists and matches the required definition.`);
  }

  steps.push({
    action: "VERIFY", index: SCOPED_INDEX,
    reason: "Re-read the complete definition from the server before removing the old one.",
  });

  if (names.includes(LEGACY_INDEX)) {
    if (blockers.length) {
      /* No DROP is even PLANNED while anything is unresolved. A step that is
         listed and then skipped still reads, in a log, as something that was
         going to happen. */
      notes.push(`${LEGACY_INDEX} will NOT be dropped while the blockers above stand.`);
    } else {
      steps.push({ action: "DROP", index: LEGACY_INDEX, reason: "Global uniqueness prevents two companies using the same code." });
    }
  } else {
    notes.push(`${LEGACY_INDEX} is not present — nothing to drop.`);
  }

  if (legacy.length) {
    notes.push(
      `${legacy.length} warehouse${legacy.length === 1 ? "" : "s"} have no companyId. They stay legacy-global and ` +
      "read-only; this migration does NOT assign them to a company.",
    );
  }

  return { safe: blockers.length === 0, steps, blockers, notes, collisions, legacy, scoped };
}

/** What to do if the scoped index has to be undone. */
const ROLLBACK_NOTES = [
  `Recreating ${LEGACY_INDEX} restores GLOBAL uniqueness, so it fails if two companies have since`,
  "used the same code. Resolve those first, or leave the scoped index in place —",
  "the application only requires the scoped one.",
];

module.exports = {
  findCollisions, planMigration, compareScopedIndex,
  COLLECTION, LEGACY_INDEX, SCOPED_INDEX, REQUIRED_SCOPED_INDEX, ROLLBACK_NOTES,
};

/* ══════════════════════════════════════════════════════════════════════════
 * EXECUTION — only when run directly, and only with --apply
 * ═════════════════════════════════════════════════════════════════════════ */

if (require.main === module) {
  const apply = process.argv.includes("--apply");
  const rollback = process.argv.includes("--rollback");

  (async () => {
    const mongoose = require("mongoose");
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
      console.error("Set MONGO_URI. This script never guesses a database.");
      process.exit(1);
    }
    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    const col = db.collection(COLLECTION);

    const indexes = await col.indexes();
    const rows = await col.find({}, { projection: { _id: 1, companyId: 1, shortName: 1 } }).toArray();
    const plan = planMigration({ indexes, rows });

    console.log(`\n${apply ? "APPLY" : rollback ? "ROLLBACK" : "PREVIEW"} — collection "${COLLECTION}"\n`);
    console.log(`Indexes present: ${indexes.map((i) => i.name).join(", ")}`);
    console.log(`Warehouses: ${rows.length} (${plan.legacy.length} legacy-global)\n`);

    if (plan.collisions.length) {
      console.log("COLLISIONS — these block the scoped unique index:");
      for (const c of plan.collisions) {
        console.log(`  company ${c.companyId} code ${c.shortName}: ${c.count} records — ${c.ids.join(", ")}`);
      }
      console.log("");
    }
    for (const n of plan.notes) console.log(`  note: ${n}`);
    for (const b of plan.blockers) console.log(`  BLOCKED: ${b}`);

    if (rollback) {
      console.log("\nRollback guidance:");
      for (const line of ROLLBACK_NOTES) console.log(`  ${line}`);
      if (!apply) console.log("\n  Add --apply --rollback to recreate the global index.");
      else {
        await col.createIndex({ shortName: 1 }, { unique: true, name: LEGACY_INDEX });
        console.log(`\n  Recreated ${LEGACY_INDEX}.`);
      }
      await mongoose.disconnect();
      return;
    }

    console.log("\nPlanned steps:");
    for (const s of plan.steps) console.log(`  ${s.action} ${s.index}`);
    if (!plan.steps.length) console.log("  (nothing to do)");

    if (!apply) {
      console.log("\nPreview only. Add --apply to make these changes.");
      await mongoose.disconnect();
      return;
    }
    if (!plan.safe) {
      console.log("\nRefusing to apply. Resolve the blockers above first.");
      await mongoose.disconnect();
      process.exit(2);
    }

    for (const step of plan.steps) {
      if (step.action === "CREATE") {
        await col.createIndex(
          { companyId: 1, shortName: 1 },
          {
            unique: true, name: SCOPED_INDEX,
            partialFilterExpression: { companyId: { $type: "objectId" } },
          },
        );
        console.log(`  created ${SCOPED_INDEX}`);
      } else if (step.action === "VERIFY") {
        /* Read the COMPLETE definition back from the server and compare it
           with the same function the plan used. Creating an index and
           assuming it took — or checking only its name — is how the drop
           below ends up removing the only real protection. */
        const present = (await col.indexes()).find((i) => i.name === SCOPED_INDEX);
        const check = compareScopedIndex(present);
        if (!check.matches) {
          console.log(`\n  ${SCOPED_INDEX} does not match the required definition: ${check.differences.join("; ")}.`);
          console.log(`  Refusing to drop ${LEGACY_INDEX}. Nothing further was changed.`);
          await mongoose.disconnect();
          process.exit(3);
        }
        console.log(`  verified ${SCOPED_INDEX} (key order, unique, partial filter, name)`);
      } else if (step.action === "DROP") {
        await col.dropIndex(step.index);
        console.log(`  dropped ${step.index}`);
      }
    }
    console.log("\nDone. Legacy-global warehouses were not modified.");
    await mongoose.disconnect();
  })().catch((err) => { console.error(err); process.exit(1); });
}
