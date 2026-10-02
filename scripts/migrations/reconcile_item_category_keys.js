"use strict";
/**
 * reconcile_item_category_keys.js
 *
 * Backfills `categoryKey` on existing item-category mappings and reports any
 * that cannot be reconciled automatically.
 *
 * ── WHY THIS CANNOT JUST PICK ONE ──────────────────────────────────────────
 * Before `categoryKey`, "Fabric" and "fabric" could exist as two rows. If they
 * point at the SAME head, collapsing them changes nothing and is safe. If they
 * point at DIFFERENT heads, one of them is about to stop being used — and
 * choosing which by row order would charge real spend to a head nobody picked,
 * silently. Those are reported and left alone for a human.
 *
 * Also drops the superseded `{companyId, category}` unique index, which
 * constrains the display label rather than the identity.
 *
 *   node reconcile_item_category_keys.js            # dry run (default)
 *   node reconcile_item_category_keys.js --apply
 */
require("dotenv").config();
const mongoose = require("mongoose");
const CategoryBudget = require("./models/Accountant_model/Acc_ItemCategoryBudget");
const { categoryKeyOf } = require("./services/itemBudgetHead.service");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
  const coll = mongoose.connection.db.collection("acc_itemcategorybudgets");

  console.log(APPLY ? "\n── APPLY ──\n" : "\n── DRY RUN (nothing will be written) ──\n");

  const rows = await coll.find({}).toArray();
  console.log(`mappings examined : ${rows.length}`);
  if (!rows.length) {
    console.log("nothing to reconcile.\n");
    await mongoose.disconnect();
    return;
  }

  /* Group by what the identity WILL be. */
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.companyId}::${r.categoryKey || categoryKeyOf(r.category)}`;
    (groups.get(k) || groups.set(k, []).get(k)).push(r);
  }

  let needKey = 0, collapsible = 0, blocked = [];
  for (const [, list] of groups) {
    if (list.length === 1) {
      if (!list[0].categoryKey) needKey += 1;
      continue;
    }
    const heads = new Set(list.map((r) => String(r.budgetLedgerId || "none")));
    if (heads.size === 1) collapsible += list.length - 1;
    else blocked.push(list);
  }

  console.log(`  need a categoryKey : ${needKey}`);
  console.log(`  duplicate rows that AGREE (safe to collapse) : ${collapsible}`);
  console.log(`  duplicate rows that DISAGREE (need a human)  : ${blocked.length} group(s)`);

  if (blocked.length) {
    console.log("\n── NOT RECONCILED — pick one head for each, then re-run ──");
    for (const list of blocked) {
      console.log(`   category "${list[0].category}" (key "${categoryKeyOf(list[0].category)}")`);
      for (const r of list) {
        console.log(`      "${r.category}" → ${r.budgetLedgerName || "(no head)"}  [_id ${r._id}]`);
      }
    }
  }

  if (!APPLY) {
    console.log("\n(dry run — re-run with --apply to write)\n");
    await mongoose.disconnect();
    return;
  }

  let written = 0, removed = 0;
  for (const [, list] of groups) {
    const heads = new Set(list.map((r) => String(r.budgetLedgerId || "none")));
    if (list.length > 1 && heads.size > 1) continue; // blocked: leave exactly as found

    /* Keep the most recently decided row; it is the one whose head is current. */
    const keep = [...list].sort(
      (a, b) => new Date(b.setAt || b.updatedAt || 0) - new Date(a.setAt || a.updatedAt || 0),
    )[0];
    const k = categoryKeyOf(keep.category);
    if (keep.categoryKey !== k) {
      await coll.updateOne({ _id: keep._id }, { $set: { categoryKey: k } });
      written += 1;
    }
    for (const r of list) {
      if (String(r._id) === String(keep._id)) continue;
      await coll.deleteOne({ _id: r._id });
      removed += 1;
    }
  }

  /* The old index constrained the display label. Two rows can no longer share
     a key, so they cannot share a meaningful spelling either — and keeping it
     would refuse a legitimate re-spelling of an existing category. */
  try {
    await coll.dropIndex("companyId_1_category_1");
    console.log("\ndropped superseded index companyId_1_category_1");
  } catch (e) {
    if (e.codeName !== "IndexNotFound") console.log(`\ncould not drop old index: ${e.message}`);
  }

  console.log(`\nkeys written: ${written}, duplicate rows removed: ${removed}`);
  if (blocked.length) {
    console.log(`${blocked.length} conflicting group(s) left untouched — resolve and re-run.`);
  }
  console.log();
  await mongoose.disconnect();
})();
