#!/usr/bin/env node
// scripts/migrations/rawitem-company-ownership.js
//
// GIVE THE LEGACY ITEM MASTER THE COMPANY IT ALREADY BELONGS TO.
//
// ── THE SYMPTOM ─────────────────────────────────────────────────────────────
// Merchandising's material picker offers three fabrics against a catalogue
// holding hundreds. It is not a paging bug and not a query that is too narrow:
// the rows are there and they carry `companyId: null`. Every tenant-scoped
// read — Store's own `tenantFilter`, and Merchandising's catalogue keyhole —
// asks for `{ companyId: <the caller's company> }`, and an unowned row matches
// no company at all.
//
// ── AND WHY THE FIX IS NOT "ALSO SHOW THE UNOWNED ONES" ─────────────────────
// Because a record that belongs to nobody would then belong to everybody. In a
// deployment with more than one company, widening the filter shows each of
// them the other's fabrics, their codes and their variants — and worse, lets a
// development BOM store a reference to an item this company cannot prove it
// owns. The records need owning. The filter is right.
//
// ── WHY THIS IS NOT `backfill-store-company.js` ─────────────────────────────
// That one assigns ownership only when the company master holds EXACTLY ONE
// company, because with two or more nothing in the data says which one a 2024
// record belonged to. That refusal is correct and stays. This script is the
// other half of it: the case where a HUMAN knows the answer and says so, out
// loud, naming both the id and the company's own name. The script's job is
// then to make that assertion checkable, to show its work before touching
// anything, and to refuse if the result would be inconsistent.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//   · It never touches a row that already has a companyId — not the target's,
//     and above all not another company's. The filter cannot select one.
//   · It never renames an item or edits a code. A code is printed on purchase
//     orders and shelf labels.
//   · It never writes if assigning would create a duplicate code inside the
//     target company, because `{ companyId, sku }` is UNIQUE. A partial write
//     against a unique index is the worst outcome available here: half the
//     catalogue moves, the rest fails, and nobody can tell which half.
//   · It never guesses the company. Both the id and the name must be given,
//     and the name must match what the company master holds.
//
// ── DRY RUN BY DEFAULT ──────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/rawitem-company-ownership.js \
//     --company-id=<id> --company-name="<exact name>"
//   …--apply   write, after the same checks pass again
//   …--json=<path>  where to save the report (default: beside this file)
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

/* ── THE SELECTOR, WRITTEN ONCE ────────────────────────────────────────────
   The same shape Store's own legacy filter uses. `{ companyId: null }` alone
   would match a missing field too, but spelling both out is what makes the
   intent readable in a report somebody audits a year from now — and it is
   the exact filter the write uses, not a paraphrase of it. */
const UNOWNED = Object.freeze({
  $or: [{ companyId: { $exists: false } }, { companyId: null }],
});

const str = (v) => String(v ?? "").trim();
/* Whitespace is collapsed before comparing because a name pasted from a
   screen carries whatever spacing the screen had. Case is NOT folded: the
   operator is being asked to assert which company this is, and an assertion
   typed in the wrong case is one that was not read carefully. */
const canon = (v) => str(v).replace(/\s+/g, " ");

/**
 * WHAT IS THERE, BEFORE ANYTHING IS TOUCHED.
 *
 * Every number the report prints is counted here, from the database, in one
 * place — so the dry run and the apply cannot disagree about what they saw.
 */
async function survey(RawItem, companyId) {
  const [unowned, ownedByTarget, ownedByOthers, total] = await Promise.all([
    RawItem.countDocuments(UNOWNED),
    RawItem.countDocuments({ companyId }),
    RawItem.countDocuments({ companyId: { $nin: [null], $exists: true, $ne: companyId } }),
    RawItem.estimatedDocumentCount(),
  ]);

  /* ── WHERE ASSIGNING WOULD BREAK ───────────────────────────────────────
     `{ companyId: 1, sku: 1 }` is unique. Two ways this write could violate
     it, and they are different problems with different fixes:

       · an unowned item whose code the target company ALREADY uses — one of
         the two has to be renamed or retired, and only a human knows which;
       · two unowned items sharing a code, which collide with each other the
         moment they land in the same company, and which are probably one
         item entered twice.

     Both are reported by code, with the ids, so the operator can go and
     look rather than being told a number. */
  const unownedSkus = await RawItem.find(UNOWNED).select("_id sku name").lean();

  const byCode = new Map();
  for (const item of unownedSkus) {
    const code = str(item.sku);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ id: String(item._id), name: str(item.name) });
  }

  const duplicatesWithinUnowned = [...byCode.entries()]
    .filter(([code, rows]) => code && rows.length > 1)
    .map(([sku, rows]) => ({ sku, rows }));

  const codes = [...byCode.keys()].filter(Boolean);
  const existing = codes.length
    ? await RawItem.find({ companyId, sku: { $in: codes } }).select("_id sku name").lean()
    : [];
  const collidesWithTarget = existing.map((held) => ({
    sku: str(held.sku),
    heldBy: { id: String(held._id), name: str(held.name) },
    unowned: byCode.get(str(held.sku)) || [],
  }));

  /* An item with no code at all cannot collide — the unique index ignores
     nothing, but an empty string is a value and two of them DO collide, so
     they are counted here rather than quietly passed over. */
  const withoutCode = unownedSkus.filter((i) => !str(i.sku))
    .map((i) => ({ id: String(i._id), name: str(i.name) }));

  return {
    total,
    unowned,
    ownedByTarget,
    ownedByOthers,
    collidesWithTarget,
    duplicatesWithinUnowned,
    withoutCode,
    /* What the write would actually change — the same filter, counted. */
    wouldUpdate: unowned,
    safe: collidesWithTarget.length === 0
      && duplicatesWithinUnowned.length === 0
      && withoutCode.length < 2,
  };
}

/**
 * THE ASSERTION THE OPERATOR IS MAKING, CHECKED AGAINST THE RECORD.
 *
 * The id says which row; the name says which company the operator BELIEVES
 * that row is. Requiring both turns a typo in a 24-character hex string from
 * a silent transfer of somebody's catalogue into a refusal.
 */
async function confirmCompany(Company, { companyId, companyName }) {
  if (!mongoose.Types.ObjectId.isValid(str(companyId))) {
    return { ok: false, reason: `"${str(companyId)}" is not a company id.` };
  }
  const company = await Company.findById(str(companyId)).select("companyName").lean();
  if (!company) {
    return { ok: false, reason: `No company has the id ${str(companyId)}.` };
  }
  const held = canon(company.companyName);
  const claimed = canon(companyName);
  if (!claimed) {
    return { ok: false, reason: `Name the company as well as its id. That id holds "${held}".` };
  }
  if (held !== claimed) {
    return {
      ok: false,
      reason: `That id is "${held}", not "${claimed}". Nothing was changed.`,
      held,
    };
  }
  return { ok: true, companyId: company._id, companyName: held };
}

function render(report) {
  const L = [];
  L.push("");
  L.push("RAW ITEM COMPANY OWNERSHIP");
  L.push(`  Company        ${report.companyName}`);
  L.push(`  Company id     ${report.companyId}`);
  L.push(`  Mode           ${report.applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  L.push("  WHAT IS THERE");
  L.push(`    Raw items in total                     ${report.before.total}`);
  L.push(`    Unowned (no companyId)                 ${report.before.unowned}`);
  L.push(`    Already owned by this company          ${report.before.ownedByTarget}`);
  L.push(`    Owned by other companies (untouched)   ${report.before.ownedByOthers}`);
  L.push("");
  L.push("  WHAT WOULD CHANGE");
  L.push(`    Items that would be assigned           ${report.before.wouldUpdate}`);
  L.push("");
  L.push("  WHAT WOULD BREAK");
  L.push(`    Codes this company already uses        ${report.before.collidesWithTarget.length}`);
  L.push(`    Codes duplicated among the unowned     ${report.before.duplicatesWithinUnowned.length}`);
  L.push(`    Unowned items with no code at all      ${report.before.withoutCode.length}`);

  for (const c of report.before.collidesWithTarget.slice(0, 25)) {
    L.push(`      · ${c.sku} — held by "${c.heldBy.name}", and by `
      + c.unowned.map((u) => `"${u.name}"`).join(", "));
  }
  if (report.before.collidesWithTarget.length > 25) {
    L.push(`      … and ${report.before.collidesWithTarget.length - 25} more (full list in the JSON report)`);
  }
  for (const d of report.before.duplicatesWithinUnowned.slice(0, 25)) {
    L.push(`      · ${d.sku} — ${d.rows.length} unowned items share this code: `
      + d.rows.map((r) => `"${r.name}"`).join(", "));
  }
  if (report.before.duplicatesWithinUnowned.length > 25) {
    L.push(`      … and ${report.before.duplicatesWithinUnowned.length - 25} more (full list in the JSON report)`);
  }

  L.push("");
  if (!report.before.safe) {
    L.push("  REFUSED. Assigning these would break the unique company+code index.");
    L.push("  Nothing was written. Resolve the codes above, then run this again.");
  } else if (report.applied) {
    L.push(`  WRITTEN. ${report.result.modifiedCount} item(s) now belong to ${report.companyName}.`);
    L.push(`    Unowned remaining                      ${report.after.unowned}`);
    L.push(`    Owned by this company                  ${report.after.ownedByTarget}`);
    L.push(`    Owned by other companies               ${report.after.ownedByOthers}`);
  } else {
    L.push("  SAFE TO APPLY. Re-run with --apply to write.");
  }
  L.push("");
  return L.join("\n");
}

async function run({ companyId, companyName, apply = false, jsonPath = "" } = {}) {
  const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");

  const confirmed = await confirmCompany(Acc_Company, { companyId, companyName });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };

  const before = await survey(RawItem, confirmed.companyId);
  const report = {
    at: new Date().toISOString(),
    companyId: String(confirmed.companyId),
    companyName: confirmed.companyName,
    applied: false,
    before,
    after: null,
    result: null,
  };

  /* ── THE REFUSAL IS BEFORE THE WRITE, NOT AN ERROR FROM IT ─────────────
     Mongo would reject the colliding document itself — but `updateMany`
     against a unique index stops where it fails, having already written
     everything before it. Half a migrated catalogue is harder to reason
     about than none of one. */
  if (!before.safe) return { ok: false, refused: true, report, text: render(report) };
  if (!apply) return { ok: true, report, text: render(report) };

  /* The one write. Same filter as the survey, so what was counted is what
     moves; and a filter that CANNOT match an owned row, whoever owns it. */
  const result = await RawItem.updateMany(UNOWNED, { $set: { companyId: confirmed.companyId } });
  report.applied = true;
  report.result = { matchedCount: result.matchedCount, modifiedCount: result.modifiedCount };
  report.after = await survey(RawItem, confirmed.companyId);

  if (jsonPath !== null) {
    const out = jsonPath || path.join(__dirname,
      `rawitem-company-ownership-${report.at.replace(/[:.]/g, "-")}.json`);
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
  const companyId = arg("company-id");
  const companyName = arg("company-name");
  const apply = process.argv.includes("--apply");

  if (!companyId || !companyName) {
    console.error("Both --company-id and --company-name are required.\n"
      + '  node -r dotenv/config scripts/migrations/rawitem-company-ownership.js \\\n'
      + '    --company-id=<id> --company-name="<exact name>" [--apply]');
    process.exitCode = 2;
    return;
  }

  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  /* ── A DRY RUN MUST BE A READ ──────────────────────────────────────────
     Mongoose builds every index a required model declares as soon as it
     connects, and an index build is a write. Left on, the "dry run" would
     alter the production collection before it had counted a single row. */
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({ companyId, companyName, apply, jsonPath: arg("json") });
    if (!out.ok) {
      console.error(out.text || `REFUSED: ${out.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(out.text);
    if (out.report.savedTo) console.log(`  Report saved to ${out.report.savedTo}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, confirmCompany, render, UNOWNED };
