#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/store-collection-coverage.js — is any Store data missed?
 *
 * Counts COLLECTIONS, not concepts. Every collection is classified as one of:
 *
 *   catalogued                          an ENTITY_SPEC of the universal contract reads it
 *   served by the legacy store family   a `store` field contract names its model
 *   deliberately excluded               storeCommandExclusions.EXCLUDED_COLLECTIONS, with a reason
 *   another application                 its model lives under another application's directory,
 *                                       or (no model) its owner is declared with evidence
 *   orphaned                            no model, and no running code names it
 *   UNCLASSIFIED                        none of the above — FAILS
 *
 * The gate is the last line. A Store model that search does not read and no
 * exclusion explains, a model put somewhere no owner is declared for, or a
 * model-less collection that running code still names without a declared
 * owner — each fails the build. That is what makes "no Store data is missed"
 * a property the repository holds rather than a sentence in a handoff.
 *
 *   node scripts/audits/store-collection-coverage.js          every collection a model writes (no database)
 *   node scripts/audits/store-collection-coverage.js --live   also every collection in MONGODB_URI, read-only
 *
 * --live only LISTS collections and reads estimated counts. It writes nothing.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const RUNTIME_DIRS = ["routes", "services", "models", "utils", "config", "middleware", "Middlewear", "controllers"];

function walk(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, keep);
    return keep(entry.name) ? [full] : [];
  });
}

/**
 * Which model files write which collections.
 *
 * Loaded BEFORE anything else requires a model, so that a model a file
 * registers without exporting can still be attributed by what appeared while
 * it loaded. A model that is exported is attributed to the file that exports
 * it, which is right even when another file happened to load it first.
 */
function modelCollections() {
  // eslint-disable-next-line global-require
  const mongoose = require("mongoose");
  const isModel = (value) => typeof value === "function" && value.collection?.name && value.schema;
  const files = walk(path.join(ROOT, "models"), (name) => name.endsWith(".js") && !name.includes(".test."));
  const byCollection = new Map();
  const add = (collection, file) => {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    if (!byCollection.has(collection)) byCollection.set(collection, new Set());
    byCollection.get(collection).add(rel);
  };
  const failures = [];
  for (const file of files) {
    const before = new Set(mongoose.modelNames());
    let exported;
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      exported = require(file);
    } catch (error) {
      failures.push({ file: path.relative(ROOT, file), error: String(error?.message || error).slice(0, 160) });
      continue;
    }
    const own = isModel(exported) ? [exported]
      : (exported && typeof exported === "object" ? Object.values(exported).filter(isModel) : []);
    for (const model of own) add(model.collection.name, file);
    for (const name of mongoose.modelNames()) {
      if (before.has(name)) continue;
      const model = mongoose.model(name);
      if (!byCollection.has(model.collection.name)) add(model.collection.name, file);
    }
  }
  return { byCollection, failures, files: files.length };
}

/** Collections that running code names in a string literal. */
function namedByRunningCode(names) {
  const files = [
    ...RUNTIME_DIRS.flatMap((dir) => walk(path.join(ROOT, dir), (name) => /\.(js|mjs)$/.test(name) && !/\.test\./.test(name))),
    path.join(ROOT, "server.js"),
  ];
  const sources = files.map((file) => fs.readFileSync(file, "utf8"));
  const named = new Set();
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const literal = new RegExp(`["'\`]${escaped}["'\`]`);
    if (sources.some((src) => literal.test(src))) named.add(name);
  }
  return named;
}

/**
 * Classify every collection a model writes and, when given, every live one.
 *
 * @param {Map<string, number>} [live]  collection → estimated rows
 */
function audit({ live = null } = {}) {
  const { byCollection, failures, files } = modelCollections();
  // eslint-disable-next-line global-require
  const own = require("../../services/ai/storeCollectionOwnership");
  // eslint-disable-next-line global-require
  const { EXCLUDED_COLLECTIONS } = require("../../services/ai/storeCommandExclusions");
  const catalogued = own.cataloguedCollections();
  const legacy = own.legacyCollections();

  const names = new Set([...byCollection.keys(), ...(live ? live.keys() : [])]);
  const unmodelled = [...names].filter((name) => !byCollection.has(name));
  const named = namedByRunningCode(unmodelled);

  const rows = [...names].sort().map((name) => ({
    name,
    rows: live ? (live.get(name) ?? null) : null,
    present: live ? live.has(name) : null,
    modelFiles: [...(byCollection.get(name) || [])].sort(),
    ...own.classifyCollection({
      name,
      modelFiles: [...(byCollection.get(name) || [])],
      namedByCode: named.has(name),
      catalogued,
      legacy,
    }),
  }));

  /* ── A DECLARATION THAT NO LONGER DESCRIBES ANYTHING IS ALSO A GAP ─────
     An exclusion for a collection no model writes and the database does not
     hold, or an owner declared for a collection that now HAS a model, would
     sit in the source looking authoritative while saying nothing true. */
  const stale = [];
  for (const [name, entry] of Object.entries(EXCLUDED_COLLECTIONS)) {
    /* An exclusion for a model-less collection can only be checked against
       the database that holds it. */
    if (entry.unmodelled && !live) continue;
    if (!byCollection.has(name) && !(live && live.has(name))) {
      stale.push(`exclusion for "${name}": no model writes it${live ? " and the database does not hold it" : ""}`);
    }
  }
  for (const name of Object.keys(own.UNMODELLED)) {
    if (byCollection.has(name)) stale.push(`declared owner for "${name}": it has a model now (${[...byCollection.get(name)].join(", ")})`);
  }
  return { rows, failures, stale, files, live: Boolean(live) };
}

async function readLive() {
  // eslint-disable-next-line global-require
  require("dotenv").config({ path: path.join(ROOT, ".env"), quiet: true });
  // eslint-disable-next-line global-require
  const mongoose = require("mongoose");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured; refusing to guess a database.");
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 20000 });
  try {
    const db = mongoose.connection.db;
    const live = new Map();
    for (const { name } of await db.listCollections({}, { nameOnly: true }).toArray()) {
      if (name.startsWith("system.")) continue;
      // eslint-disable-next-line no-await-in-loop
      live.set(name, await db.collection(name).estimatedDocumentCount());
    }
    return live;
  } finally {
    await mongoose.disconnect();
  }
}

function report({ rows, failures, stale, files, live }) {
  const by = (category) => rows.filter((row) => row.category === category);
  const { CATEGORY, STORE } = require("../../services/ai/storeCollectionOwnership"); // eslint-disable-line global-require
  const count = (list) => String(list.length).padStart(5);
  const rowsOf = (row) => (live ? `${String(row.rows ?? "—").padStart(7)}  ` : "");

  console.log(`\nStore collection coverage — ${live ? "live database + models" : "every collection a model writes"}`);
  console.log(`   model files loaded                       ${String(files).padStart(5)}${failures.length ? `   (${failures.length} failed to load)` : ""}`);
  console.log(`   collections                              ${count(rows)}\n`);

  /* Every collection a Store model writes, and every collection Store
     search reads whoever owns it. */
  const store = rows.filter((row) => row.application === STORE || [
    CATEGORY.CATALOGUED, CATEGORY.LEGACY, CATEGORY.EXCLUDED,
  ].includes(row.category) || (row.category === CATEGORY.UNCLASSIFIED && row.application === STORE));
  console.log("   STORE SEARCH — every collection a Store model writes or Store search reads");
  for (const row of store) {
    const what = row.category === CATEGORY.EXCLUDED ? "excluded"
      : row.category === CATEGORY.CATALOGUED ? `catalogued: ${row.detail}`
        : row.category === CATEGORY.LEGACY ? `legacy store: ${row.detail}` : row.category;
    const owner = row.application && row.application !== STORE ? `  (${row.application}'s)` : "";
    console.log(`     ${rowsOf(row)}${row.name.padEnd(46)} ${what}${owner}`);
  }

  console.log("\n   summary");
  for (const category of Object.values(CATEGORY)) {
    console.log(`     ${category.padEnd(38)} ${count(by(category))}`);
  }

  const others = new Map();
  for (const row of by(CATEGORY.OTHER).filter((r) => r.application !== STORE)) others.set(row.application, (others.get(row.application) || 0) + 1);
  console.log("\n   another application, by owner");
  for (const [owner, n] of [...others].sort((a, b) => b[1] - a[1])) console.log(`     ${owner.padEnd(38)} ${String(n).padStart(5)}`);

  const orphaned = by(CATEGORY.ORPHANED);
  if (orphaned.length) {
    console.log("\n   orphaned — no model, no running code names it");
    for (const row of orphaned) console.log(`     ${rowsOf(row)}${row.name}`);
  }

  if (failures.length) {
    console.log("\n   MODEL FILES THAT FAILED TO LOAD");
    for (const f of failures) console.log(`     ${f.file}: ${f.error}`);
  }
  if (stale.length) {
    console.log("\n   STALE DECLARATIONS");
    for (const line of stale) console.log(`     ${line}`);
  }
  const unclassified = by(CATEGORY.UNCLASSIFIED);
  if (unclassified.length) {
    console.log("\n   UNCLASSIFIED");
    for (const row of unclassified) console.log(`     ${rowsOf(row)}${row.name.padEnd(34)} ${row.detail}`);
  }
  const ok = !unclassified.length && !stale.length && !failures.length;
  console.log(ok
    ? "\n   Every collection is classified. No Store collection is unread without a reason.\n"
    : `\n   FAILED: ${unclassified.length} unclassified, ${stale.length} stale, ${failures.length} unloadable.\n`);
  return ok;
}

async function main() {
  const live = process.argv.includes("--live") ? await readLive() : null;
  const ok = report(audit({ live }));
  process.exit(ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { audit, modelCollections, namedByRunningCode };
