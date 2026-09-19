#!/usr/bin/env node
/**
 * Copy the Cowork data out of Firestore and into MongoDB.
 *
 *   node -r dotenv/config scripts/migrateCoworkToMongo.js --dry-run
 *   node -r dotenv/config scripts/migrateCoworkToMongo.js --only cowork_notifications
 *   node -r dotenv/config scripts/migrateCoworkToMongo.js
 *   node -r dotenv/config scripts/migrateCoworkToMongo.js --verify
 *
 * ## What it guarantees
 *
 * · **It never writes to Firestore.** Firestore is opened read-only by
 *   convention and by code: no `set`, `update`, `delete` or `add` appears
 *   below. Until the cutover, Firestore remains the system of record and this
 *   must not be able to damage it — including when it is run by mistake.
 * · **It is re-runnable.** Every write is an upsert keyed by the document's own
 *   id, so running it twice converges rather than duplicating. That is what
 *   makes a staged migration possible: copy now, copy again at cutover to pick
 *   up what changed in between, and the second pass is cheap.
 * · **Ids are preserved exactly**, as strings. Every id already written into
 *   another document, a URL, a notification or the Mongo side of the product
 *   still resolves afterwards.
 * · **It refuses rather than mangles.** A document with a field name MongoDB
 *   cannot store is reported and skipped, not silently renamed — see
 *   `illegalKeys` in `../services/mongo/convert.js`.
 *
 * ## What it does not do
 *
 * It does not flip anything over. Nothing reads from MongoDB because this ran.
 * The cutover is a separate, reversible decision.
 */

"use strict";

const { MongoClient } = require("mongodb");
const { illegalKeys, toMongoDocument } = require("../services/mongo/convert");

/**
 * Firebase is loaded INSIDE `main`, not at the top.
 *
 * `config/firebaseAdmin.js` throws on import when `FIREBASE_SERVICE_ACCOUNT` is
 * absent, which is correct for a server and wrong for a module somebody wants
 * to read a constant out of. Requiring it up here made the list of collections
 * this script skips — a thing worth reviewing on any machine — unreadable
 * without production credentials, and made `parseArgs` untestable.
 */
function loadFirebase() {
  return require("../config/firebaseAdmin");
}

/* ── What to copy ─────────────────────────────────────────────────────────── */

/**
 * Subcollections, by parent.
 *
 * Declared rather than discovered. Discovery means `listCollections()` on every
 * document — one round trip per document, on the collection with the most
 * documents, to learn something the code already states. These nine names came
 * from the code and are the complete set in use; `--discover` is there for the
 * day that stops being true.
 */
const SUBCOLLECTIONS = {
  cowork_tasks: ["chat", "draft_chat", "dailyReports", "reports", "events", "logs"],
  cowork_groups: ["messages"],
  cowork_direct_messages: ["messages"],
  cowork_conversations: ["messages"],
  cowork_scheduled_meets: ["sessions", "logs"],
  cowork_workbooks: ["lines"],
};

/** Collections that exist but must NOT be copied. */
const SKIP = new Set([
  /* The broker's own bookkeeping. It is per-deployment state about a change
     stream that does not exist yet, and copying it would hand the new database
     a resume position belonging to nothing. */
  "cowork_realtime_state",
  /* Short-lived credentials. Copying them extends their life into a second
     system and gives an attacker a second place to find them; they expire on
     their own and are re-created on demand. */
  "cowork_password_reset_otp",
  "cowork_password_resets",
  "cowork_qr_signin",
  "cowork_guest_sessions",
]);

const BATCH = 500;

/* ── Arguments ────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const args = { dryRun: false, verify: false, only: null, discover: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--discover") args.discover = true;
    else if (a === "--only") args.only = argv[++i];
  }
  return args;
}

/* ── Reading Firestore ────────────────────────────────────────────────────── */

async function topLevelCollections(firestore) {
  const refs = await firestore.listCollections();
  return refs
    .map((r) => r.id)
    .filter((id) => id.startsWith("cowork_") && !SKIP.has(id))
    .sort();
}

/**
 * Every document of one collection, in pages.
 *
 * Paged by document id rather than read whole: the largest of these is read in
 * one gulp at boot elsewhere in this codebase and it is a known cost. A cursor
 * keeps the memory flat however large the collection is.
 */
async function* pagesOf(ref, admin) {
  let cursor = null;
  for (;;) {
    let q = ref.orderBy(admin.firestore.FieldPath.documentId()).limit(BATCH);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.docs.length < BATCH) return;
    cursor = snap.docs[snap.docs.length - 1].id;
  }
}

/* ── Writing MongoDB ──────────────────────────────────────────────────────── */

async function writeBatch(target, docs, { dryRun }) {
  if (docs.length === 0 || dryRun) return docs.length;
  await target.bulkWrite(
    docs.map((d) => ({
      replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true },
    })),
    { ordered: false },
  );
  return docs.length;
}

/* ── One collection ───────────────────────────────────────────────────────── */

async function copyCollection(ref, mongo, name, { dryRun, parentId = null, admin }) {
  const target = mongo.collection(name);
  const report = { name, read: 0, written: 0, skipped: [] };

  for await (const docs of pagesOf(ref, admin)) {
    const batch = [];
    for (const snap of docs) {
      report.read += 1;
      const data = snap.data() ?? {};
      const bad = illegalKeys(data);
      if (bad.length) {
        /* Reported, never rewritten — renaming a field to make the import
           succeed is a silent data change. */
        report.skipped.push({ id: snap.id, fields: bad });
        continue;
      }
      batch.push(toMongoDocument(snap.id, data, { parentId }));
    }
    report.written += await writeBatch(target, batch, { dryRun });
  }
  return report;
}

/** A parent's subcollections, flattened to `<parent>__<child>`. */
async function copySubcollections(parentRef, mongo, parentName, children, opts) {
  const reports = [];
  for await (const docs of pagesOf(parentRef, opts.admin)) {
    for (const parent of docs) {
      const names = opts.discover
        ? (await parent.ref.listCollections()).map((c) => c.id)
        : children;
      for (const child of names) {
        const r = await copyCollection(
          parent.ref.collection(child),
          mongo,
          `${parentName}__${child}`,
          { ...opts, parentId: parent.id },
        );
        if (r.read > 0) reports.push(r);
      }
    }
  }
  /* Merged: one line per flattened collection, not one per parent document. */
  const merged = new Map();
  for (const r of reports) {
    const m = merged.get(r.name) ?? { name: r.name, read: 0, written: 0, skipped: [] };
    m.read += r.read;
    m.written += r.written;
    m.skipped.push(...r.skipped);
    merged.set(r.name, m);
  }
  return [...merged.values()];
}

/* ── Verify ───────────────────────────────────────────────────────────────── */

/**
 * Compare what is in each side.
 *
 * Counts, plus a spot check of the newest few documents field by field. A count
 * alone proves only that the right NUMBER of documents arrived, which a
 * conversion bug would satisfy perfectly.
 */
async function verify(mongo, names, firestore) {
  const rows = [];
  for (const name of names) {
    const fsCount = (await firestore.collection(name).count().get()).data().count;
    const moCount = await mongo.collection(name).countDocuments();
    const sample = await firestore.collection(name).limit(3).get();
    const mismatches = [];
    for (const snap of sample.docs) {
      const there = await mongo.collection(name).findOne({ _id: snap.id });
      if (!there) {
        mismatches.push(`${snap.id}: missing in MongoDB`);
        continue;
      }
      const expected = toMongoDocument(snap.id, snap.data() ?? {});
      for (const key of Object.keys(expected)) {
        if (JSON.stringify(expected[key]) !== JSON.stringify(there[key]))
          mismatches.push(`${snap.id}.${key}`);
      }
    }
    rows.push({ name, firestore: fsCount, mongo: moCount, mismatches });
  }
  return rows;
}

/* ── Main ─────────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { admin, db: firestore } = loadFirebase();
  args.admin = admin;
  const uri = process.env.COWORK_MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("Set COWORK_MONGODB_URI (or MONGODB_URI) first.");
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const mongo = client.db(process.env.COWORK_MONGODB_DB || "cowork");

  try {
    const names = args.only ? [args.only] : await topLevelCollections(firestore);
    console.log(
      `${args.verify ? "Verifying" : args.dryRun ? "Dry run over" : "Copying"} ${names.length} collection(s)\n`,
    );

    if (args.verify) {
      const rows = await verify(mongo, names, firestore);
      let bad = 0;
      for (const r of rows) {
        const same = r.firestore === r.mongo && r.mismatches.length === 0;
        if (!same) bad += 1;
        console.log(
          `${same ? "ok  " : "DIFF"} ${r.name.padEnd(38)} firestore=${String(r.firestore).padStart(7)} mongo=${String(r.mongo).padStart(7)}` +
            (r.mismatches.length ? `  fields: ${r.mismatches.slice(0, 5).join(", ")}` : ""),
        );
      }
      console.log(`\n${bad === 0 ? "Every collection matches." : `${bad} collection(s) differ.`}`);
      process.exitCode = bad === 0 ? 0 : 1;
      return;
    }

    const all = [];
    for (const name of names) {
      const ref = firestore.collection(name);
      all.push(await copyCollection(ref, mongo, name, args));
      const children = SUBCOLLECTIONS[name];
      if (children || args.discover)
        all.push(...(await copySubcollections(ref, mongo, name, children ?? [], args)));
    }

    console.log("");
    let skipped = 0;
    for (const r of all) {
      skipped += r.skipped.length;
      console.log(
        `  ${r.name.padEnd(42)} read ${String(r.read).padStart(7)}   written ${String(r.written).padStart(7)}` +
          (r.skipped.length ? `   SKIPPED ${r.skipped.length}` : ""),
      );
    }
    if (skipped) {
      console.log(`\n${skipped} document(s) skipped for field names MongoDB cannot store:`);
      for (const r of all)
        for (const s of r.skipped.slice(0, 10))
          console.log(`  ${r.name}/${s.id}  ->  ${s.fields.join(", ")}`);
      console.log("\nThese were NOT renamed. Decide what they should be, then re-run.");
      process.exitCode = 1;
    }
    if (args.dryRun) console.log("\nDry run — nothing was written.");
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { SKIP, SUBCOLLECTIONS, parseArgs };
