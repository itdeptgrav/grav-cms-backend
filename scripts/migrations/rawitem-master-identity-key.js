#!/usr/bin/env node
// scripts/migrations/rawitem-master-identity-key.js
//
// GIVE EVERY COMPANY-OWNED RAW ITEM ITS MASTER IDENTITY KEY.
//
// `masterIdentityKey` is what makes duplicate detection work: the name, the
// shelf, the unit and the classification, normalised so that "Poly mesh 135",
// "poly-mesh 135" and "POLY  MESH  135" are recognised as one material rather
// than three. It cannot be the SKU — `RAW-FAB-POLMES-417` ends in a random
// three-digit tail, so the same yarn registered twice a minute apart gets two
// codes and a uniqueness check passes on both.
//
// Items created since the field exists carry it. Everything older does not, and
// for those the duplicate check falls back to an exact case-insensitive name —
// which finds the ordinary duplicate and honestly misses one that differs only
// in punctuation. This closes that gap.
//
// ── IT COMPUTES NOTHING OF ITS OWN ──────────────────────────────────────────
// The key comes from `identityKey` in `services/inventory/rawItemCreation.service`
// — the very function creation uses. A migration with its own normalisation
// would be a second opinion about what "the same material" means, and the two
// would disagree exactly where it matters: a backfilled item and a newly
// created one would be given different keys for identical materials, so the
// check would pass on the duplicate it exists to catch.
//
// ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
//   · It never touches a LEGACY-GLOBAL item — one with no `companyId`, or a
//     null one. Those belong to nobody. The key is only meaningful inside a
//     company (two companies may legitimately hold the same material), so a key
//     written on an unowned row would be a claim this script cannot support.
//     They are counted and reported, never written.
//   · It never merges, renames, deletes or deduplicates anything. Where two
//     items in one company resolve to the same key it writes the key on BOTH
//     and REPORTS the collision. Merging two catalogue rows means deciding
//     which stock, which suppliers and which history survive, and that is a
//     person's decision with consequences a script cannot see.
//   · It never overwrites a key that already matches what the function says it
//     should be, and it never skips one that does not — an item whose name was
//     edited after the key was written is CORRECTED, which is the whole point
//     of being rerunnable.
//   · It writes nothing without `--apply`.
//
// ── RERUNNABLE ──────────────────────────────────────────────────────────────
// Idempotent by construction: it recomputes the key every run and writes only
// where the stored value differs. A second run reports zero changes. A run
// after somebody renames an item reports exactly that one.
//
//   node -r dotenv/config scripts/migrations/rawitem-master-identity-key.js
//   …--company-id=<id>   scope to one company (optional)
//   …--apply             write, after showing the same report
//   …--json=<path>       where to save the full report
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

/* ── THE ONE NORMALISATION ───────────────────────────────────────────────────
   Imported, not reimplemented. See the header. */
const {
  identityKey, hasComparableName,
} = require("../../services/inventory/rawItemCreation.service");

const str = (v) => String(v ?? "").trim();

/* ── WHOSE ROWS THIS SCRIPT MAY TOUCH ────────────────────────────────────────
   Company-owned only. A legacy-global row — `companyId` absent or null — is
   read, counted and left exactly as it is. */
const OWNED = Object.freeze({ companyId: { $exists: true, $ne: null } });
const UNOWNED = Object.freeze({
  $or: [{ companyId: { $exists: false } }, { companyId: null }],
});

/* ── WHY THIS IS AN `$and`, NOT TWO KEYS ─────────────────────────────────────
   Written `{ companyId: cid, ...OWNED }` the second `companyId` REPLACES the
   first: object spread keeps the last value, so `--company-id` silently
   disappeared and every company's items matched. "Is this company's" and
   "belongs to a company at all" are two separate facts, so they are separate
   clauses where neither can overwrite the other. */
const scopeFor = (base, companyId) => (companyId
  ? { $and: [{ companyId }, base] }
  : { ...base });

/**
 * What is there, and what would change.
 *
 * Counted from the database once, so the dry run and the apply cannot disagree
 * about what they saw. The plan carries the item's id, its computed key and the
 * key it currently holds, so the report says WHY each row is in it.
 */
async function survey(RawItem, companyId = null) {
  const items = await RawItem.find(scopeFor(OWNED, companyId))
    .select("_id companyId name sku category customCategory unit customUnit usedAs masterIdentityKey")
    .lean();

  const plan = [];      // rows whose stored key differs from the computed one
  const unchanged = []; // rows already correct
  const unkeyable = []; // rows the function cannot key — a nameless item
  /* companyId → key → [rows], so a collision is reported per company. Two
     companies holding the same material is ordinary, not a collision. */
  const byCompany = new Map();

  for (const it of items) {
    const key = identityKey(it);
    const row = {
      id: String(it._id),
      companyId: String(it.companyId),
      name: str(it.name),
      sku: str(it.sku),
      was: str(it.masterIdentityKey),
      key,
    };

    /* ── AN ITEM WITH NO NAME HAS NO IDENTITY TO COMPARE ─────────────────
       Left alone and reported. The key also carries the shelf and the unit, so
       a nameless item still produces a non-empty string — and writing it would
       make every nameless "Fabric / Metre" row in the company a duplicate of
       every other, which is a collision the catalogue does not have.

       Asked through the creation service's own predicate — the one
       `findDuplicate` uses — so this script still restates no normalisation. */
    if (!hasComparableName(it)) { unkeyable.push(row); continue; }

    if (!byCompany.has(row.companyId)) byCompany.set(row.companyId, new Map());
    const keys = byCompany.get(row.companyId);
    if (!keys.has(key)) keys.set(key, []);
    keys.get(key).push(row);

    if (row.was === key) unchanged.push(row); else plan.push(row);
  }

  /* ── COLLISIONS ───────────────────────────────────────────────────────────
     Two or more rows in ONE company resolving to one key. Reported, never
     resolved: which of them keeps its stock, its supplier aliases and its
     history is a decision with consequences this script cannot see. */
  const collisions = [];
  for (const [cid, keys] of byCompany) {
    for (const [key, rows] of keys) {
      if (rows.length > 1) {
        collisions.push({
          companyId: cid,
          key,
          count: rows.length,
          items: rows.map((r) => ({ id: r.id, name: r.name, sku: r.sku })),
        });
      }
    }
  }
  collisions.sort((a, b) => b.count - a.count);

  const unowned = await RawItem.countDocuments(scopeFor(UNOWNED, companyId));

  return {
    owned: items.length,
    unowned,
    wouldWrite: plan.length,
    alreadyCorrect: unchanged.length,
    unkeyable: unkeyable.length,
    companies: byCompany.size,
    collisions,
    collidingItems: collisions.reduce((n, c) => n + c.count, 0),
    plan,
    unkeyableItems: unkeyable,
  };
}

function render(report) {
  const b = report.before;
  const L = [];
  L.push("");
  L.push("RAW ITEM MASTER IDENTITY KEY");
  L.push(`  Company        ${report.companyId || "ALL companies"}`);
  L.push(`  Mode           ${report.applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  L.push("  WHAT IS THERE");
  L.push(`    Company-owned raw items                ${b.owned}`);
  L.push(`    Companies represented                  ${b.companies}`);
  L.push(`    Legacy-global (left untouched)          ${b.unowned}`);
  L.push("");
  L.push("  WHAT WOULD CHANGE");
  L.push(`    Keys to write or correct               ${b.wouldWrite}`);
  L.push(`    Already correct                        ${b.alreadyCorrect}`);
  L.push(`    Cannot be keyed (no name)              ${b.unkeyable}`);
  L.push("");
  if (b.collisions.length) {
    L.push(`  COLLISIONS (${b.collisions.length}) — ${b.collidingItems} item(s) in ${b.collisions.length} group(s)`);
    L.push("    Each group is one company holding the same material under more than one");
    L.push("    row. NOTHING is merged or removed: the key is written on every row and");
    L.push("    the group is listed here for a person to decide.");
    for (const c of b.collisions.slice(0, 40)) {
      L.push(`    · company ${c.companyId}  ${c.count} rows  key "${c.key}"`);
      for (const it of c.items) L.push(`        ${it.name}  [${it.sku}]`);
    }
    if (b.collisions.length > 40) {
      L.push(`    … and ${b.collisions.length - 40} more group(s) (full list in the JSON report)`);
    }
  } else {
    L.push("  COLLISIONS");
    L.push("    None. No company holds one material under two rows.");
  }
  L.push("");
  if (b.unkeyableItems.length) {
    L.push(`  CANNOT BE KEYED (${b.unkeyableItems.length}) — an item with no name`);
    for (const it of b.unkeyableItems.slice(0, 20)) L.push(`    · [${it.sku || "no code"}]  id ${it.id}`);
    L.push("");
  }
  if (report.applied) {
    L.push(`  WRITTEN. ${report.result.modifiedCount} key(s) set or corrected.`);
    if (report.result.failed) L.push(`  ${report.result.failed} write(s) failed — see the JSON report.`);
  } else {
    L.push("  Re-run with --apply to write these keys.");
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

  /* One guarded write per planned row. The filter re-asserts both the value
     this run READ and that the row is still company-owned, so a key somebody
     changed between the survey and the apply is not overwritten, and a row that
     lost its company in between is not written at all. */
  const ops = before.plan.map((p) => ({
    updateOne: {
      filter: {
        _id: new mongoose.Types.ObjectId(p.id),
        companyId: { $exists: true, $ne: null },
        /* `$in` rather than equality: an absent field and an empty string are
           both "no key yet" and must both match. */
        ...(p.was ? { masterIdentityKey: p.was } : { masterIdentityKey: { $in: [null, "", undefined] } }),
      },
      update: { $set: { masterIdentityKey: p.key } },
    },
  }));
  const res = ops.length
    ? await RawItem.bulkWrite(ops, { ordered: false })
    : { modifiedCount: 0, matchedCount: 0 };
  report.applied = true;
  report.result = {
    modifiedCount: res.modifiedCount || 0,
    /* A planned row the filter no longer matched. Not an error — somebody
       edited it while this ran — but it is reported rather than assumed away,
       and a rerun picks it up. */
    failed: Math.max(0, ops.length - (res.matchedCount ?? res.modifiedCount ?? 0)),
  };

  if (jsonPath !== null) {
    const out = jsonPath
      || path.join(__dirname, `rawitem-master-identity-key-${report.at.replace(/[:.]/g, "-")}.json`);
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

  /* ── A DRY RUN MUST BE A READ, AND `connect({autoIndex:false})` IS NOT ENOUGH ──
     Passing `autoIndex: false` to `connect` was believed to be sufficient. It is
     not: mongoose registers a model's declared indexes when the model is
     compiled and builds them on first use of the collection — and a survey that
     counts rows is first use. Running this script against a live database
     therefore CREATED the schema's indexes as a side effect of a dry run, which
     is precisely the thing a dry run promises not to do.

     `mongoose.set("autoIndex", false)` is global and applies before any model is
     touched, which is what actually holds. Set here rather than only in
     `connect` so that a future caller of `run()` from a script that forgot the
     connect option still cannot build an index by reading. */
  mongoose.set("autoIndex", false);

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

module.exports = { run, survey, render, OWNED, UNOWNED };
