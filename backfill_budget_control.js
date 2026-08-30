"use strict";
/**
 * backfill_budget_control.js
 *
 * CLASSIFY EXISTING LEDGERS AS BUDGET HEADS, TARGETS, OR NEITHER.
 *
 *   node backfill_budget_control.js            # dry run — reports, writes nothing
 *   node backfill_budget_control.js --apply    # writes
 *   node backfill_budget_control.js --undo     # removes ONLY values this wrote
 *
 * ── WHY THIS IS AN OPTIMISATION, NOT A PRECONDITION ─────────────────────────
 * Nothing depends on it having run. `budgetClassification.budgetControlOf()`
 * derives the same answer on read for any ledger with no stored value, so the
 * system already behaves correctly. This just makes the classification
 * explicit and queryable — which is what lets finance SEE and change it.
 *
 * ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
 * Any ledger carrying `budgetControlSetAt` — that stamp means a human decided,
 * and re-deriving over it would quietly undo finance's ruling. This is also
 * what makes `--undo` safe: it clears only rows this script wrote, identified
 * by having a value and NO stamp.
 *
 * ── AMBIGUOUS ROWS ARE REPORTED, NOT GUESSED AT ─────────────────────────────
 * A ledger whose nature is missing, or whose group and name disagree, still
 * gets a value — the safe one — and is listed at the end for finance to
 * review. Silence about a guess is worse than the guess.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { Acc_Ledger, Acc_Group } = require("./models/Accountant_model/Acc_MasterModels");
const classification = require("./services/budgetClassification.service");

const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(UNDO ? "── UNDO ──" : APPLY ? "── APPLY ──" : "── DRY RUN (nothing will be written) ──");

  if (UNDO) {
    const res = await Acc_Ledger.updateMany(
      /* Only what this script wrote: a value with no human stamp behind it. */
      { budgetControl: { $exists: true }, budgetControlSetAt: { $exists: false } },
      { $unset: { budgetControl: "" } },
    );
    console.log(`cleared ${res.modifiedCount} derived classifications (finance's own were left alone)`);
    await mongoose.disconnect();
    return;
  }

  /* Group nature is the authority, exactly as budgetActuals reads it — a
     ledger's own `nature` can be stale after a reparent. */
  const groups = await Acc_Group.find({}).select("_id nature name").lean();
  const groupNature = new Map(groups.map((g) => [String(g._id), g.nature]));

  const ledgers = await Acc_Ledger.find({})
    .select("_id name groupId groupName nature budgetControl budgetControlSetAt")
    .lean();

  const counts = { expense_budget: 0, revenue_target: 0, not_budgeted: 0 };
  const skipped = [];
  const ambiguous = [];
  const ops = [];

  for (const l of ledgers) {
    if (l.budgetControlSetAt) {
      skipped.push(`${l.name} (finance set: ${l.budgetControl})`);
      continue;
    }
    const shape = {
      name: l.name,
      groupName: l.groupName,
      nature: groupNature.get(String(l.groupId)) || l.nature || null,
    };
    const value = classification.classify(shape);
    counts[value] += 1;
    if (classification.isAmbiguous(shape)) {
      ambiguous.push(`${l.name} — group "${l.groupName}", nature ${shape.nature || "unresolved"} → ${value}`);
    }
    if (l.budgetControl !== value) {
      ops.push({
        updateOne: { filter: { _id: l._id }, update: { $set: { budgetControl: value } } },
      });
    }
  }

  console.log(`\nledgers examined      : ${ledgers.length}`);
  console.log(`  expense_budget      : ${counts.expense_budget}`);
  console.log(`  revenue_target      : ${counts.revenue_target}`);
  console.log(`  not_budgeted        : ${counts.not_budgeted}`);
  console.log(`skipped (finance set) : ${skipped.length}`);
  console.log(`writes needed         : ${ops.length}`);

  if (ambiguous.length) {
    console.log(`\n── ${ambiguous.length} worth finance's review ──`);
    ambiguous.slice(0, 40).forEach((a) => console.log("  ", a));
    if (ambiguous.length > 40) console.log(`   … and ${ambiguous.length - 40} more`);
  }

  if (APPLY && ops.length) {
    const res = await Acc_Ledger.bulkWrite(ops, { ordered: false });
    console.log(`\nwritten: ${res.modifiedCount}`);
  } else if (!APPLY) {
    console.log("\n(dry run — re-run with --apply to write)");
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
