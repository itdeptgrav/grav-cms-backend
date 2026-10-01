#!/usr/bin/env node
//
// scripts/migrations/marketing-outbox-company-scoped-index.js
//
// REPLACE THE GLOBAL OUTCOME-EVENT UNIQUE INDEX WITH A COMPANY-SCOPED ONE.
//
//   node -r dotenv/config scripts/migrations/marketing-outbox-company-scoped-index.js
//   node -r dotenv/config scripts/migrations/marketing-outbox-company-scoped-index.js --apply
//
// Without `--apply` it inspects and reports, changing nothing. That is the
// default on purpose: dropping a unique index is the kind of thing that should
// be read before it is run.
//
// ── WHY A MIGRATION AND NOT JUST A SCHEMA EDIT ─────────────────────────────
// `sales_marketing_outcome_outbox` carried `correlationId_1_kind_1` as a UNIQUE
// index, which made an announcement's identity global rather than company
// owned. `handoverRef` is minted per company, so two companies can produce the
// same correlation identity — and the second company's announcement would then
// be refused by the first company's row, while the code that handles that
// refusal read the first company's event back and treated it as the second's.
// One missing key, a suppressed announcement and a cross-tenant read.
//
// Changing the Mongoose declaration adds the new index. It does NOT remove the
// old one: mongoose creates indexes it is told about and never drops indexes it
// no longer knows about, so the global constraint stays in force until
// something like this removes it.
//
// ── AND IT REFUSES TO DROP BLIND ───────────────────────────────────────────
// Before dropping, it looks for rows that the OLD index permitted and the NEW
// one would too — the reverse would be the dangerous direction, but the
// genuinely interesting question is whether any (companyId, correlationId,
// kind) triple is already duplicated, because the new unique index cannot be
// built if one is. It reports those and stops rather than leaving the
// collection with neither constraint.
"use strict";

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

/* Only the Sales outcome outbox is migrated here. Its Marketing-side sibling
   carries the same global index and is NOT touched: that collection belongs to
   a different chunk's contract, and changing it as a side effect of this one is
   how an unrelated regression gets introduced. It is named at the end so the
   operator sees it rather than discovering it later. */
const TARGET = {
  collection: "sales_marketing_outcome_outbox",
  obsolete: "correlationId_1_kind_1",
  wanted: { companyId: 1, correlationId: 1, kind: 1 },
  wantedName: "companyId_1_correlationId_1_kind_1",
};

const SIBLING = { collection: "marketing_outbox_events", obsolete: "correlationId_1_kind_1" };

const say = (state, message) => console.log(`  [${String(state).padEnd(9)}] ${message}`);

async function duplicateTriples(coll) {
  return coll.aggregate([
    { $group: { _id: { companyId: "$companyId", correlationId: "$correlationId", kind: "$kind" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 20 },
  ]).toArray();
}

(async () => {
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("  MONGODB_URI is not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  console.log(`\n${APPLY ? "Applying" : "Inspecting"} the company-scoped outcome-event index\n`);

  const names = (await db.listCollections().toArray()).map((c) => c.name);
  if (!names.includes(TARGET.collection)) {
    say("skip", `${TARGET.collection} does not exist yet — the schema will create the correct index on first write.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const coll = db.collection(TARGET.collection);
  const before = await coll.indexes();
  const total = await coll.countDocuments();
  say("state", `${TARGET.collection}: ${total} document(s)`);
  for (const i of before) {
    say("index", `${i.name} keys=${JSON.stringify(i.key)} unique=${Boolean(i.unique)}`);
  }

  const hasObsolete = before.some((i) => i.name === TARGET.obsolete);
  const hasWanted = before.some((i) => i.name === TARGET.wantedName);

  /* ── THE ONLY THING THAT CAN MAKE THE NEW INDEX IMPOSSIBLE ─────────────── */
  const dupes = await duplicateTriples(coll);
  if (dupes.length) {
    say("BLOCKED", `${dupes.length} duplicated (companyId, correlationId, kind) triple(s) exist. The company-scoped unique index cannot be built until a person resolves them:`);
    for (const d of dupes) {
      console.log(`      companyId=${d._id.companyId} correlationId=${d._id.correlationId} kind=${d._id.kind} count=${d.n}`);
    }
    say("stopped", "Nothing was changed. The old global index is still in force.");
    await mongoose.disconnect();
    process.exit(1);
  }
  say("ok", "No duplicated (companyId, correlationId, kind) triples — the company-scoped unique index can be built.");

  if (!APPLY) {
    say("dry run", `Would ${hasWanted ? "keep" : "create"} ${TARGET.wantedName}${hasObsolete ? `, then drop ${TARGET.obsolete}` : ""}. Re-run with --apply.`);
    say("note", `${SIBLING.collection} still carries ${SIBLING.obsolete}. That collection belongs to another contract and is deliberately not touched here.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  /* ── CREATE FIRST, DROP SECOND ──────────────────────────────────────────
     In that order, always. Dropping first would leave a window in which neither
     constraint held, and a concurrent writer could insert exactly the duplicate
     the new index is about to forbid. */
  if (hasWanted) {
    say("exists", `${TARGET.wantedName} is already in place.`);
  } else {
    await coll.createIndex(TARGET.wanted, { unique: true, name: TARGET.wantedName });
    say("created", `${TARGET.wantedName} (unique)`);
  }

  if (hasObsolete) {
    await coll.dropIndex(TARGET.obsolete);
    say("dropped", `${TARGET.obsolete} — the global constraint is gone.`);
  } else {
    say("absent", `${TARGET.obsolete} was not present; nothing to drop.`);
  }

  const after = await coll.indexes();
  console.log("");
  for (const i of after) {
    say("index", `${i.name} keys=${JSON.stringify(i.key)} unique=${Boolean(i.unique)}`);
  }
  say("DONE", "Announcement identity is company-scoped.");
  say("note", `${SIBLING.collection} still carries ${SIBLING.obsolete}. Not touched by this migration.`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error(`\n  ABORTED: ${err?.message || err}`);
  try { await mongoose.disconnect(); } catch { /* nothing to close */ }
  process.exit(1);
});
