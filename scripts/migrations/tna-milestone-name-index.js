#!/usr/bin/env node
/**
 * scripts/migrations/tna-milestone-name-index.js
 *
 * THE ONE INDEX THE MILESTONE LIBRARY NEEDS BUILT ON A LIVE CLUSTER.
 *
 * ── A DRY RUN BY DEFAULT, AND NOT YET APPROVED ────────────────────────────
 * Without `--apply` this connects, reports and writes nothing. `--apply` builds
 * one index. It is additive — no document is read, changed or moved, and no
 * collection is created, renamed or dropped — but an index build on a live
 * cluster is still a live operation, so it waits for a person.
 *
 * ── WHY ONLY ONE ──────────────────────────────────────────────────────────
 * The milestone library shares `merchandising_tna_reason_codes` with the reason
 * codes, because the cluster is at its 500-collection cap. That collection
 * already carries `{companyId, code, kind}` unique, and with `kind: "MILESTONE"`
 * that IS "one milestone per code per company" — so milestone-code uniqueness
 * needed nothing built.
 *
 * What it does not cover is the milestone's NAME. "Fabric in house",
 * "fabric in house", "Fabric-in-house" and "Fabric  in  house" are one
 * milestone, and only a unique index on the normalised form can hold that
 * against two people saving in the same second. Hence:
 *
 *   { companyId: 1, nameKey: 1 }  unique, partial on kind = "MILESTONE"
 *
 * PARTIAL is the load-bearing word. A reason code has no `nameKey`, so without
 * the filter every reason code in the collection is `{companyId, null}` and the
 * second one fails to insert. The filter is what makes this safe to add to a
 * collection that is already in use.
 *
 * `autoIndex` is off in production (`server.js`), so deploying the code does
 * NOT build this. Development and tests build it from the schema declaration.
 *
 *   node -r dotenv/config scripts/migrations/tna-milestone-name-index.js
 *   node -r dotenv/config scripts/migrations/tna-milestone-name-index.js --apply
 */
"use strict";

const mongoose = require("mongoose");

const {
  TNA_CONFIG_COLLECTION, CONFIG_KIND,
} = require("../../models/CMS_Models/Merchandising/TnaConfiguration");
const {
  nameIdentity,
} = require("../../models/CMS_Models/Merchandising/TnaMilestoneDefinition");

const APPLY = process.argv.includes("--apply");
const line = (s = "") => process.stdout.write(`${s}\n`);
const say = (k, v) => line(`   ${String(k).padEnd(46)} ${v}`);

const INDEX_NAME = "tna_milestone_name_unique";
const INDEX_KEY = { companyId: 1, nameKey: 1 };
const INDEX_OPTIONS = Object.freeze({
  unique: true,
  name: INDEX_NAME,
  partialFilterExpression: { kind: CONFIG_KIND.MILESTONE },
});

/** The command, spelled out, so it can be read and run by hand instead. */
const asShellCommand = () => `db.${TNA_CONFIG_COLLECTION}.createIndex(\n`
  + `     ${JSON.stringify(INDEX_KEY)},\n`
  + `     ${JSON.stringify({ ...INDEX_OPTIONS, background: true })}\n`
  + "   )";

/**
 * Would the index build succeed?
 *
 * A unique index refuses to build if the data already violates it, so the
 * collisions are found and NAMED first. Nothing is merged: two milestones whose
 * names mean one thing is a question about somebody's process, and picking a
 * winner would silently fold two control points into one.
 */
async function collisions(db) {
  const rows = await db.collection(TNA_CONFIG_COLLECTION)
    .find({ kind: CONFIG_KIND.MILESTONE }, { projection: { companyId: 1, code: 1, name: 1, nameKey: 1 } })
    .toArray();

  const byKey = new Map();
  for (const r of rows) {
    /* Recomputed rather than trusted: a document written before the hook
       existed may have no `nameKey` at all, and it is the value the index will
       use that matters, not the value on disk. */
    const key = `${r.companyId}::${r.nameKey || nameIdentity(r.name)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  return {
    milestones: rows.length,
    missingKey: rows.filter((r) => !r.nameKey).length,
    clashes: [...byKey.values()].filter((g) => g.length > 1).map((g) => ({
      companyId: String(g[0].companyId),
      nameKey: g[0].nameKey || nameIdentity(g[0].name),
      entries: g.map((r) => ({ code: r.code, name: r.name })),
    })),
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  line();
  line(`T&A milestone name index — ${APPLY ? "APPLY" : "DRY RUN (nothing will be written)"}`);
  say("database", mongoose.connection.name);
  say("collection", TNA_CONFIG_COLLECTION);
  line();

  const existing = await db.collection(TNA_CONFIG_COLLECTION).indexes().catch(() => []);
  const already = existing.find((ix) => ix.name === INDEX_NAME);
  if (already) {
    say("already present", JSON.stringify(already.key));
    say("", "Nothing to do.");
    line();
    await mongoose.disconnect();
    return;
  }

  const found = await collisions(db);
  say("milestone documents", found.milestones);
  say("without a stored nameKey", `${found.missingKey}`
    + (found.missingKey ? " — the index will use the derived value" : ""));
  say("names that would collide", found.clashes.length);
  line();

  if (found.clashes.length) {
    line("   The index CANNOT be built until a person resolves these. Nothing is");
    line("   merged automatically: folding two control points into one makes every");
    line("   report over them wrong in a way nobody can see.");
    line();
    for (const c of found.clashes) {
      line(`      company ${c.companyId} — "${c.nameKey}"`);
      for (const e of c.entries) line(`         ${e.code}  "${e.name}"`);
    }
    line();
    line("   Rename one of each pair, or retire it (isActive: false), then run again.");
    line();
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  line("   The command this would run:");
  line();
  line(`   ${asShellCommand()}`);
  line();

  if (!APPLY) {
    line("   DRY RUN — nothing was written. Re-run with --apply to build it.");
    line("   It is additive: no document is read, changed or moved, and no");
    line("   collection is created, renamed or dropped.");
    line();
    await mongoose.disconnect();
    return;
  }

  await db.collection(TNA_CONFIG_COLLECTION).createIndex(INDEX_KEY, {
    ...INDEX_OPTIONS, background: true,
  });
  say("built", INDEX_NAME);
  line();
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  INDEX_NAME, INDEX_KEY, INDEX_OPTIONS, asShellCommand, collisions,
};
