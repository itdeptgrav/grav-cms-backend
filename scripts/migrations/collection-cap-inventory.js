#!/usr/bin/env node
/**
 * scripts/migrations/collection-cap-inventory.js
 *
 * WHAT THE CLUSTER'S 500 COLLECTIONS ARE BEING SPENT ON.
 *
 * ── THIS SCRIPT READS. IT DOES NOT DROP, RENAME OR CREATE ANYTHING ────────
 * It exists so a decision about the collection cap is taken against real
 * numbers rather than a guess, and so the candidates for removal are NAMED
 * before anybody is asked to approve removing one. Every drop or rename is a
 * separate, explicit act by a person.
 *
 * It answers three questions:
 *
 *   1  how close to the cap this database is;
 *   2  which collections no model in this repository declares — an orphan is a
 *      collection the code has forgotten, and the only safe candidate for
 *      removal is one that is BOTH orphaned AND empty;
 *   3  whether an existing configuration collection could host a new kind of
 *      record instead, so no slot is needed at all.
 *
 *   node -r dotenv/config scripts/migrations/collection-cap-inventory.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const line = (s = "") => process.stdout.write(`${s}\n`);
const say = (k, v) => line(`   ${String(k).padEnd(52)} ${v}`);

/** Every `collection: "…"` a model in this repository declares. */
function declaredCollections(root = path.join(__dirname, "..", "..", "models")) {
  const found = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith(".js")) continue;
      const src = fs.readFileSync(full, "utf8");
      for (const m of src.matchAll(/collection:\s*"([a-zA-Z0-9_.-]+)"/g)) {
        found.set(m[1], path.relative(path.join(__dirname, "..", ".."), full));
      }
    }
  };
  walk(root);
  return found;
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  const db = mongoose.connection.db;

  line();
  line("Collection inventory (reads only — nothing is dropped, renamed or created)");
  say("database", mongoose.connection.name);

  const collections = await db.listCollections().toArray();
  const declared = declaredCollections();

  say("collections in THIS database", collections.length);
  say("collections a model declares", declared.size);
  line();
  line("   The 500 cap is per CLUSTER, across every database, so this number is a");
  line("   floor and not the total. `db.adminCommand({listDatabases:1})` and the");
  line("   Atlas metrics page are where the cluster-wide figure comes from.");
  line();

  /* ── Orphans: a collection no model names ───────────────────────────── */
  const orphans = [];
  for (const c of collections) {
    if (declared.has(c.name)) continue;
    if (c.name.startsWith("system.")) continue;
    const count = await db.collection(c.name).estimatedDocumentCount();
    const indexes = await db.collection(c.name).indexes().catch(() => []);
    orphans.push({ name: c.name, count, indexes: indexes.length, type: c.type });
  }
  orphans.sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));

  const empty = orphans.filter((o) => o.count === 0);
  line(`── no model in this repository declares these (${orphans.length})`);
  for (const o of orphans) {
    line(`      ${o.count === 0 ? "EMPTY   " : String(o.count).padStart(8)} `
      + `${o.name}${o.type && o.type !== "collection" ? ` [${o.type}]` : ""}`);
  }
  line();
  line(`   Of those, ${empty.length} hold no documents. An EMPTY ORPHAN is the only`);
  line("   defensible candidate for removal, and even then: a collection may be");
  line("   empty today and written by a code path nobody has run this month, and a");
  line("   view or a collection another service owns can look orphaned from here.");
  line("   Nothing is removed by this script. Each candidate needs a person to");
  line("   confirm what wrote it and that nothing will again.");
  line();

  /* ── Could an existing configuration collection host more? ──────────── */
  const CANDIDATE = "merchandising_tna_reason_codes";
  if (collections.some((c) => c.name === CANDIDATE)) {
    const coll = db.collection(CANDIDATE);
    const total = await coll.estimatedDocumentCount();
    const kinds = await coll.distinct("kind").catch(() => []);
    const indexes = await coll.indexes().catch(() => []);
    line(`── ${CANDIDATE} — the option that needs no slot at all`);
    say("documents", total);
    say("kinds present", kinds.join(", ") || "(none)");
    for (const ix of indexes) {
      say(`  index ${ix.name}`, `${JSON.stringify(ix.key)}${ix.unique ? " UNIQUE" : ""}`
        + `${ix.partialFilterExpression ? ` partial ${JSON.stringify(ix.partialFilterExpression)}` : ""}`);
    }
    line();
    line("   Its unique index already includes `kind`, so a second kind of record");
    line("   cannot collide with a reason code of the same code. That is what makes");
    line("   hosting milestone definitions here possible without weakening it.");
    line();
  }

  await mongoose.disconnect();
  line("   Nothing was written.");
  line();
}

if (require.main === module) {
  main().catch(async (err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}

module.exports = { declaredCollections };
