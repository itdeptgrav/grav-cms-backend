#!/usr/bin/env node
// scripts/migrations/label-identity-state.js
//
// MAKE THE EXISTING LABEL ESTATE SAY WHAT IT IS.
//
// `identityState` arrived with count-and-label. Every label printed before it
// has no such field, and every one of them IS real stock — they were minted for
// material the company already held, or from a receipt that was already
// recorded. So every reader treats an ABSENT state as usable
// (services/storePurchase/labelIdentity.js), and nothing is broken without this
// script.
//
// ── SO WHY RUN IT ───────────────────────────────────────────────────────────
// Because "absent means activated" is a rule living in code rather than in the
// data, and a rule like that is one careless `find({ identityState: "ACTIVATED" })`
// away from making the entire historical estate disappear from the locator, the
// put-away queue and every scan. Stamping the rows makes the data
// self-describing, so a future query that forgets the absent case is merely
// redundant rather than catastrophic.
//
// ── WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────────
// Any label that already carries a state. A label reserved inside an open
// count is RESERVED and must stay RESERVED — stamping it ACTIVATED would turn
// a half-finished count into live stock, which is the exact failure the field
// exists to prevent. The filter is `identityState` missing or null, and nothing
// else.
//
//   node -r dotenv/config scripts/migrations/label-identity-state.js
//   …--apply   stamp them
"use strict";

const mongoose = require("mongoose");

async function survey(db) {
  const barcodes = db.collection("barcodes");
  const absent = { $or: [{ identityState: { $exists: false } }, { identityState: null }] };
  const [total, untyped, byState] = await Promise.all([
    barcodes.countDocuments({}),
    barcodes.countDocuments(absent),
    barcodes.aggregate([
      { $match: { identityState: { $exists: true, $ne: null } } },
      { $group: { _id: "$identityState", n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
  ]);
  return { total, untyped, byState, absent };
}

function render({ total, untyped, byState }, applied, stamped = 0) {
  const L = [""];
  L.push("LABEL IDENTITY STATE — BACKFILL");
  L.push(`  Mode           ${applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push(`  Labels         ${total}`);
  L.push(`  No state yet   ${untyped}  → ACTIVATED (they are stock, and always were)`);
  for (const r of byState) L.push(`  ${String(r._id).padEnd(14)} ${r.n}  left alone`);
  L.push("");
  L.push(applied
    ? `  STAMPED ${stamped}. Nothing that already carried a state was touched.`
    : `  ${untyped} to stamp. Re-run with --apply.`);
  L.push("");
  return L.join("\n");
}

async function run({ apply = false } = {}) {
  const db = mongoose.connection.db;
  const s = await survey(db);
  if (!apply) return { ok: true, ...s, applied: false, stamped: 0, text: render(s, false) };
  const res = await db.collection("barcodes").updateMany(
    s.absent,
    { $set: { identityState: "ACTIVATED" } },
  );
  const stamped = res.modifiedCount || 0;
  return { ok: true, ...s, applied: true, stamped, text: render(s, true, stamped) };
}

async function main() {
  require("dotenv").config({ quiet: true });
  mongoose.set("autoIndex", false);
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({ apply: process.argv.includes("--apply") });
    console.log(out.text);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, render };
