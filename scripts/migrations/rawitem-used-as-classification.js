#!/usr/bin/env node
// scripts/migrations/rawitem-used-as-classification.js
//
// CLASSIFY THE EXISTING ITEM MASTER BY "USED AS", FROM ITS STORE CATEGORY.
//
// `usedAs` is a new Store-owned field, so every item created before it defaults
// to NOT_CLASSIFIED — and an unclassified item is kept OUT of every Merchandising
// BOM picker. This backfills the OBVIOUS cases from each item's current Store
// category (Zippers → Trim, MCB board → Electrical item, Polybag → Sample
// packaging, …) so the pickers have something to show, and LEAVES everything
// ambiguous — a generic "Accessories", a bare "cable", a lone "pipe" — as
// NOT_CLASSIFIED for a person to decide. A wrong classification nobody notices
// becomes a wrong picker result, so the script guesses nothing.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
//   · It never overwrites a `usedAs` a person has already set — it only touches
//     items still at NOT_CLASSIFIED (or with the field absent).
//   · It never renames an item, edits a code, or moves a record between
//     companies. It only sets one classification field.
//   · It never crosses a company boundary: with --company-id it scopes to one
//     company; without, it classifies each item in place, company by company,
//     and reports the distribution.
//
// ── DRY RUN BY DEFAULT ───────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/rawitem-used-as-classification.js
//   …--company-id=<id>   scope to one company (optional)
//   …--apply             actually write, after showing the same report
//   …--json=<path>       where to save the full report (default: beside this file)
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const {
  USED_AS, USED_AS_VALUES, USED_AS_LABELS, DEFAULT_USED_AS,
  SECTION_USED_AS, classifyByCategory,
} = require("../../models/CMS_Models/Inventory/Products/usedAs");

const str = (v) => String(v ?? "").trim();

/* Items this script may classify: those nobody has classified yet. It never
   touches an item that already carries a real classification. */
const UNCLASSIFIED = Object.freeze({
  $or: [{ usedAs: DEFAULT_USED_AS }, { usedAs: { $exists: false } }, { usedAs: null }],
});

/**
 * WHAT IS THERE, AND WHAT WOULD CHANGE — counted from the database once, so the
 * dry run and the apply cannot disagree about what they saw.
 */
async function survey(RawItem, companyId = null) {
  const scope = companyId ? { companyId } : {};
  const items = await RawItem.find({ ...scope, ...UNCLASSIFIED })
    .select("_id name sku category customCategory usedAs")
    .lean();

  /* The projected classification of each currently-unclassified item. */
  const plan = [];          // items that WOULD be classified
  const leftUnclassified = []; // items that stay NOT_CLASSIFIED, for review
  for (const it of items) {
    const to = classifyByCategory(it.category, it.customCategory);
    if (to && to !== DEFAULT_USED_AS) {
      plan.push({ id: String(it._id), name: str(it.name), sku: str(it.sku), category: str(it.customCategory) || str(it.category), to });
    } else {
      leftUnclassified.push({ id: String(it._id), name: str(it.name), sku: str(it.sku), category: str(it.customCategory) || str(it.category) });
    }
  }

  /* The PROJECTED distribution across every item in scope — the already-
     classified ones as they are, plus the plan above applied. This is the
     "count under every Used as value" the report must show. */
  const projected = Object.fromEntries(USED_AS_VALUES.map((v) => [v, 0]));
  const already = await RawItem.aggregate([
    ...(companyId ? [{ $match: { companyId } }] : []),
    { $group: { _id: { $ifNull: ["$usedAs", DEFAULT_USED_AS] }, n: { $sum: 1 } } },
  ]);
  for (const row of already) {
    const key = USED_AS_VALUES.includes(row._id) ? row._id : DEFAULT_USED_AS;
    projected[key] += row.n;
  }
  /* Move the planned items out of NOT_CLASSIFIED into their new class. */
  for (const p of plan) { projected[DEFAULT_USED_AS] -= 1; projected[p.to] += 1; }

  /* How many items would become visible in each Merchandising tab, projected. */
  const tabVisible = {
    materialsAndTrims: SECTION_USED_AS.MATERIALS.reduce((n, v) => n + (projected[v] || 0), 0),
    samplePackaging: SECTION_USED_AS.PACKAGING.reduce((n, v) => n + (projected[v] || 0), 0),
  };

  const total = companyId ? await RawItem.countDocuments({ companyId }) : await RawItem.estimatedDocumentCount();

  return {
    total,
    consideredUnclassified: items.length,
    wouldClassify: plan.length,
    stayUnclassified: leftUnclassified.length,
    projected,
    tabVisible,
    plan,
    leftUnclassified,
  };
}

function render(report) {
  const b = report.before;
  const L = [];
  L.push("");
  L.push("RAW ITEM \"USED AS\" CLASSIFICATION");
  L.push(`  Company        ${report.companyId || "ALL companies"}`);
  L.push(`  Mode           ${report.applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  L.push("  WHAT IS THERE");
  L.push(`    Raw items in total                     ${b.total}`);
  L.push(`    Currently unclassified                 ${b.consideredUnclassified}`);
  L.push(`    Would be classified from category      ${b.wouldClassify}`);
  L.push(`    Left "Not classified" for review       ${b.stayUnclassified}`);
  L.push("");
  L.push("  COUNT UNDER EVERY \"USED AS\" VALUE (projected)");
  for (const v of USED_AS_VALUES) {
    L.push(`    ${(USED_AS_LABELS[v] + " ".repeat(24)).slice(0, 24)} ${b.projected[v]}`);
  }
  L.push("");
  L.push("  WOULD BECOME VISIBLE IN EACH MERCHANDISING TAB (projected)");
  L.push(`    Materials & Trims                      ${b.tabVisible.materialsAndTrims}`);
  L.push(`    Sample Packaging                       ${b.tabVisible.samplePackaging}`);
  L.push("");
  L.push(`  ITEMS LEFT UNCLASSIFIED (${b.leftUnclassified.length}) — for a person to review`);
  for (const it of b.leftUnclassified.slice(0, 60)) {
    L.push(`    · ${it.name}  [${it.sku}]  category: ${it.category || "(none)"}`);
  }
  if (b.leftUnclassified.length > 60) {
    L.push(`    … and ${b.leftUnclassified.length - 60} more (full list in the JSON report)`);
  }
  L.push("");
  if (report.applied) {
    L.push(`  WRITTEN. ${report.result.modifiedCount} item(s) classified.`);
  } else {
    L.push("  Re-run with --apply to write these classifications.");
  }
  L.push("");
  return L.join("\n");
}

async function run({ companyId = null, apply = false, jsonPath = "" } = {}) {
  const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
  const cid = companyId && mongoose.Types.ObjectId.isValid(str(companyId))
    ? new mongoose.Types.ObjectId(str(companyId)) : null;

  const before = await survey(RawItem, cid);
  const report = {
    at: new Date().toISOString(),
    companyId: cid ? String(cid) : null,
    applied: false,
    before,
    result: null,
  };

  if (!apply) return { ok: true, report, text: render(report) };

  /* One guarded write per planned item: the filter re-asserts the item is
     STILL unclassified, so a value a person set between the dry run and the
     apply is never overwritten. */
  const ops = before.plan.map((p) => ({
    updateOne: {
      filter: { _id: new mongoose.Types.ObjectId(p.id), ...UNCLASSIFIED },
      update: { $set: { usedAs: p.to } },
    },
  }));
  const result = ops.length ? await RawItem.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };
  report.applied = true;
  report.result = { modifiedCount: result.modifiedCount || 0 };

  if (jsonPath !== null) {
    const out = jsonPath || path.join(__dirname, `rawitem-used-as-${report.at.replace(/[:.]/g, "-")}.json`);
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
  const companyId = arg("company-id") || null;
  const apply = process.argv.includes("--apply");

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  /* A dry run must be a read: autoIndex off, so connecting does not build an
     index (a write) before a single row is counted. */
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({ companyId, apply, jsonPath: arg("json") });
    console.log(out.text);
    if (out.report.savedTo) console.log(`  Report saved to ${out.report.savedTo}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, render, UNCLASSIFIED };
