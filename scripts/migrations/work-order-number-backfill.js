#!/usr/bin/env node
//
// scripts/migrations/work-order-number-backfill.js
//
// Chunk 4A.2. Deployment PRE-CHECK and backfill for `workOrderNumber`.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Until Chunk 4A.2 no work-order creation path assigned `workOrderNumber`,
// while the schema declared it unique. The model now assigns
// `WO-<full ObjectId>` to every NEW record, but existing rows are untouched by
// design — renaming live records is a migration, not an invariant.
//
// This script reports what is actually in the database and, only when told to,
// gives numberless records a canonical one.
//
// ── IT DOES NOT RUN BY DEFAULT ──────────────────────────────────────────────
//   node scripts/migrations/work-order-number-backfill.js            # report only
//   node scripts/migrations/work-order-number-backfill.js --apply    # writes
//
// Without --apply it opens a connection, reads, prints and exits. It has never
// been run against any database as part of this chunk.
//
// ── ORDER OF OPERATIONS AT DEPLOY TIME ──────────────────────────────────────
//   1. Back up the workorders collection. A backfill that assigns identity is
//      not reversible from the data alone once other records reference it.
//   2. Run this WITHOUT --apply. Read the report.
//   3. Resolve any duplicate non-empty numbers BY HAND. The script refuses to
//      touch them: two records that already claim the same identity is a
//      business question, not a mechanical one.
//   4. Run WITH --apply. Re-run until it reports zero remaining; it is
//      restartable and idempotent — it only ever selects records that still
//      have no usable number, and each gets a value derived from its own _id.
//   5. Only once the report is clean, ensure the unique index (step 5 is NOT
//      performed by this script; see `--report-index` output for whether the
//      index exists and whether a previous build failed).
//
// ── WHAT THIS SCRIPT DOES AND DOES NOT GUARANTEE ────────────────────────────
//
// There are TWO separate protections here, and neither is the other:
//
//   1. PRE-FLIGHT COLLISION DETECTION. Before any write, every canonical target
//      is checked against numbers other documents ALREADY hold. Any conflict
//      refuses the whole apply. This catches conflicts that exist at the moment
//      the report runs.
//
//   2. PER-CANDIDATE CONCURRENCY GUARD. Each conditional update re-asserts that
//      THAT DOCUMENT is still numberless, so a value assigned by another writer
//      between the read and the write is preserved rather than overwritten.
//
// NEITHER CLOSES THE CROSS-DOCUMENT TARGET RACE.
//
// Guard (2) proves only that the candidate is still numberless. It says nothing
// about whether some OTHER document acquired the candidate's target string
// after the pre-flight report. Without a unique constraint on
// `workOrderNumber`, two documents can end up holding the same number and both
// writes succeed. This script does NOT install that index — doing so is its own
// deployment decision with its own compatibility review, and the index cannot
// be built at all while duplicate values exist.
//
// SO: all-or-nothing target uniqueness across concurrent writers requires ONE
// of the following, and this script provides neither:
//
//   (a) an enforced compatible unique index on `workOrderNumber`, built before
//       apply; or
//   (b) A DEPLOYMENT WINDOW IN WHICH ALL WORKORDER WRITERS ARE STOPPED OR
//       QUIESCED for the duration of the run.
//
// Because the index is absent, (b) is REQUIRED when applying today. Run this
// with work-order creation and editing quiesced. A post-run re-report will
// DETECT a duplicate introduced by a concurrent writer — that is detection and
// rollback guidance, not atomic prevention.
//
// ── ROLLBACK ────────────────────────────────────────────────────────────────
// Restore the collection from the step-1 backup. The assigned numbers are
// deterministic (`WO-<_id>`), so a partial run can also be undone selectively
// with `$unset` on exactly the ids this script logs — it prints every id it
// writes when --apply is used.
"use strict";

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const BATCH = 500;

/** Must match the model's rule exactly. */
const canonicalNumber = (id) => `WO-${String(id)}`;

/**
 * ONE definition of a usable number, used by every query in this script:
 * it must be a string whose trimmed value is non-empty. Missing, null, empty
 * and whitespace-only are all "numberless".
 *
 * Expressed as a $expr so the duplicate report and the backfill selector cannot
 * drift apart — the earlier version had a $regex list here and a different
 * $nin list in the duplicate aggregation, which meant whitespace-only records
 * were counted as duplicate business identities AND blocked their own backfill.
 */
const USABLE_NUMBER = {
  $and: [
    { $eq: [{ $type: "$workOrderNumber" }, "string"] },
    { $gt: [{ $strLenCP: { $trim: { input: "$workOrderNumber" } } }, 0] },
  ],
};

/** The selector for records that have no usable number. */
const NUMBERLESS = { $expr: { $not: USABLE_NUMBER } };

async function report(coll) {
  const total = await coll.countDocuments({});
  const numberless = await coll.countDocuments(NUMBERLESS);

  /* Duplicates among REAL identities only. A whitespace-only value is not a
     business identity, so several of them are not a duplicate — they are
     several numberless records, counted above and backfilled below. */
  const duplicates = await coll.aggregate([
    { $match: { $expr: USABLE_NUMBER } },
    { $group: { _id: "$workOrderNumber", n: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 50 },
  ]).toArray();

  /* Would any canonical target collide with a number some OTHER record already
     owns? Checked even when the unique index is absent — the index is what
     would CATCH such a collision, and the whole reason this script exists is
     that it may not be there. */
  const targets = await coll.find(NUMBERLESS).project({ _id: 1 }).toArray();
  const conflicts = [];
  for (let i = 0; i < targets.length; i += 500) {
    const slice = targets.slice(i, i + 500);
    const wanted = new Map(slice.map((d) => [canonicalNumber(d._id), d._id]));
    const owned = await coll
      .find({ workOrderNumber: { $in: [...wanted.keys()] } })
      .project({ _id: 1, workOrderNumber: 1 })
      .toArray();
    for (const o of owned) {
      const claimant = wanted.get(o.workOrderNumber);
      if (String(o._id) !== String(claimant)) {
        conflicts.push({ target: o.workOrderNumber, owner: o._id, claimant });
      }
    }
  }

  const indexes = await coll.indexes();
  const unique = indexes.find((i) => i.key && i.key.workOrderNumber === 1 && i.unique);

  console.log("─ workOrderNumber pre-check ─────────────────────────────────");
  console.log(`  work orders total            : ${total}`);
  console.log(`  missing / null / blank number: ${numberless}`);
  console.log(`  duplicate real numbers       : ${duplicates.length}${duplicates.length === 50 ? "+ (capped)" : ""}`);
  console.log(`  canonical target conflicts   : ${conflicts.length}`);
  console.log(`  unique index present         : ${unique ? `yes (${unique.name}, sparse=${!!unique.sparse})` : "NO"}`);

  if (!unique && numberless > 1) {
    // The likeliest explanation for a missing index on a collection whose
    // schema declares one.
    console.log("  NOTE: the schema declares this index but the collection does not");
    console.log("        have it. A build almost certainly FAILED on the duplicate");
    console.log("        nulls counted above, which is why creation never broke in");
    console.log("        production. Do not force the build before backfilling.");
  }

  for (const d of duplicates) {
    console.log(`  DUPLICATE "${d._id}" x${d.n}: ${d.ids.slice(0, 5).map(String).join(", ")}${d.ids.length > 5 ? " …" : ""}`);
  }
  if (duplicates.length) {
    console.log("  Resolve duplicates by hand before applying. This script will not");
    console.log("  rename an existing non-empty number under any flag.");
  }
  for (const c of conflicts) {
    console.log(`  CONFLICT target "${c.target}" is already owned by ${c.owner}; claimed by ${c.claimant}`);
  }
  if (conflicts.length) {
    console.log("  A canonical target is already in use by a different document.");
    console.log("  Apply is refused entirely — before any write — until this is resolved.");
  }
  return {
    total, numberless,
    duplicates: duplicates.length,
    conflicts: conflicts.length,
    unique: Boolean(unique),
  };
}

async function apply(coll, { batchSize = BATCH } = {}) {
  /*
   * Per-record conditional updates, not a bulkWrite.
   *
   * The first version logged every candidate in a batch as "wrote", but a
   * conditional update matches zero documents when another writer numbered the
   * record between the read and the write. Logging those as written produced a
   * rollback list containing ids this migration never touched — and a rollback
   * that $unsets those would destroy a number somebody else assigned.
   *
   * An administrative backfill is not a hot path. Correctness and a
   * trustworthy rollback list are worth more than bulk throughput here.
   *
   * ONE PASS, VIA A STABLE `_id` CURSOR.
   *
   * The batch query used to re-select "the first BATCH numberless records"
   * every time. A record that FAILED stayed numberless, so it reappeared in
   * the next query and was examined, logged and counted again — `examined` and
   * `failed` were wrong for any batch that mixed a success with a failure, and
   * a failing record could be retried for as long as its batch-mates kept
   * succeeding. Paging on `_id > lastId` advances past every candidate exactly
   * once, whatever its outcome, so within one invocation the three outcome
   * sets are disjoint and cover every examined id. A LATER invocation starts
   * again from the beginning and will retry anything still numberless, which
   * is what keeps the script restartable.
   */
  const written = [];
  const skipped = [];
  const failed = [];
  let examined = 0;
  let lastId = null;

  for (;;) {
    const cursorFilter = lastId
      ? { $and: [NUMBERLESS, { _id: { $gt: lastId } }] }
      : NUMBERLESS;

    const batch = await coll
      .find(cursorFilter)
      .sort({ _id: 1 })
      .project({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (!batch.length) break;

    for (const d of batch) {
      examined++;
      // Advance the cursor BEFORE the write, so this id is never revisited in
      // this invocation regardless of what happens to it.
      lastId = d._id;

      const target = canonicalNumber(d._id);
      try {
        const res = await coll.updateOne(
          {
            _id: d._id,
            // Still numberless: a concurrent writer that numbered it wins.
            ...NUMBERLESS,
          },
          { $set: { workOrderNumber: target } },
        );

        if (res.modifiedCount === 1) {
          written.push({ id: d._id, number: target });
          console.log(`  wrote   ${d._id} -> ${target}`);
        } else {
          skipped.push(d._id);
          console.log(`  skipped ${d._id} (numbered concurrently — NOT written)`);
        }
      } catch (err) {
        failed.push({ id: d._id, error: err.message });
        console.log(`  FAILED  ${d._id}: ${err.message}`);
      }
    }
  }

  console.log("─ apply summary ────────────────────────────────────────────");
  console.log(`  examined                    : ${examined}`);
  console.log(`  written                     : ${written.length}`);
  console.log(`  skipped (concurrent)        : ${skipped.length}`);
  console.log(`  failed                      : ${failed.length}`);
  console.log("");
  console.log("  ROLLBACK applies to the WRITTEN ids only. Skipped and failed ids");
  console.log("  were not modified by this run and must never be unset:");
  for (const w of written) console.log(`    rollback ${w.id}`);
  if (skipped.length) console.log(`  DO NOT ROLL BACK (skipped): ${skipped.map(String).join(", ")}`);
  if (failed.length) console.log(`  DO NOT ROLL BACK (failed):  ${failed.map((f) => String(f.id)).join(", ")}`);

  return { examined, written, skipped, failed };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const coll = mongoose.connection.collection("workorders");
  try {
    const summary = await report(coll);

    if (!APPLY) {
      console.log("\nDRY RUN. Nothing was written. Re-run with --apply to backfill.");
      return;
    }
    if (summary.duplicates > 0) {
      console.error("\nRefusing to apply: resolve the duplicate numbers listed above first.");
      process.exitCode = 1;
      return;
    }
    if (summary.conflicts > 0) {
      // Refused BEFORE the first write, so a conflicted run leaves the
      // collection exactly as it found it.
      console.error("\nRefusing to apply: a canonical target is already owned by another document.");
      process.exitCode = 1;
      return;
    }
    console.log("");
    console.log("  QUIESCED-WRITER WINDOW REQUIRED: there is no unique index on");
    console.log("  workOrderNumber, so nothing prevents a concurrent writer from");
    console.log("  claiming a target between the pre-flight check and a write.");
    console.log("  Stop or quiesce all WorkOrder writers for the duration of this run.");
    console.log("");

    await apply(coll);
    /* Re-reported afterwards so a duplicate introduced by a concurrent writer
       is DETECTED. Detection and rollback guidance — not prevention. */
    await report(coll);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { canonicalNumber, NUMBERLESS, USABLE_NUMBER, report, apply };
