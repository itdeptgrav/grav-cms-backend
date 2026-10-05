// test/store-purchase/migration-index-preflight.test.js
//
// "IS THIS INDEX ALREADY THERE?" — AND THE COST OF ANSWERING BY NAME.
//
// Every index migration in this repo used to decide with
// `existing.some(i => i.name === spec.name)`. A name is not an index, and that
// comparison was wrong in both directions:
//
//   · An equivalent index under a DIFFERENT name read as MISSING. `--apply`
//     built a duplicate, and the collection paid for two identical indexes on
//     every write for the rest of its life.
//
//   · The SAME name holding a different index read as PRESENT. `--apply`
//     skipped it, and everybody believed a constraint was being enforced that
//     was not there. For a unique index that is the belief under which
//     duplicates accumulate silently.
//
// So this suite is about structure: key pattern INCLUDING field order, unique,
// partialFilterExpression, sparse, TTL. It runs against a real in-memory
// database wherever a real index is what is being described, because index
// metadata is exactly the thing that is easy to get wrong in a mock.
//
// It also guards the mechanism that once created indexes in production during a
// DRY RUN: every migration must set the GLOBAL `autoIndex: false` before it
// connects. See the note at the end.
"use strict";

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const preflight = require("../../scripts/migrations/lib/indexPreflight");

const db = () => mongoose.connection.db;
const COLL = "preflight_probe";

async function resetProbe() {
  const existing = await db().collection(COLL).indexes().catch(() => []);
  for (const i of existing) {
    if (i.name !== "_id_") await db().collection(COLL).dropIndex(i.name).catch(() => {});
  }
}
beforeEach(resetProbe);

/** What the server actually reports, which is what a migration must compare. */
const liveIndexes = () => db().collection(COLL).indexes();

/* ══ THE SAME INDEX UNDER ANOTHER NAME IS NOT MISSING ═════════════════════ */

test("an equivalent index under a different name counts as PRESENT, and is not rebuilt", async () => {
  /* Built the way Mongoose or a hand-run script would have: same key, same
     options, a generated name. */
  await db().collection(COLL).createIndex({ companyId: 1, documentRef: 1 });

  const spec = {
    collection: COLL,
    name: "a_name_nobody_used",
    key: { companyId: 1, documentRef: 1 },
  };
  const verdict = preflight.classify(spec, await liveIndexes());

  expect(verdict.state).toBe("present");
  expect(verdict.renamed).toBe(true);
  expect(verdict.matchedName).toBe("companyId_1_documentRef_1");

  /* And an apply builds nothing, so the collection does not end up carrying the
     same index twice. */
  const before = (await liveIndexes()).length;
  const rows = await preflight.surveyIndexes(db(), [spec]);
  const outcome = await preflight.buildMissing(db(), rows);
  expect(outcome.built).toEqual([]);
  expect((await liveIndexes()).length).toBe(before);
});

/* ══ THE SAME NAME OVER A DIFFERENT INDEX IS A CONFLICT ══════════════════ */

test("a matching name with a different KEY ORDER is a conflict, not a match", async () => {
  /* `{a,b}` and `{b,a}` are different indexes serving different queries. */
  await db().collection(COLL).createIndex({ documentRef: 1, companyId: 1 }, { name: "wanted" });

  const verdict = preflight.classify(
    { collection: COLL, name: "wanted", key: { companyId: 1, documentRef: 1 } },
    await liveIndexes(),
  );
  expect(verdict.state).toBe("conflict");
  expect(verdict.differences.map((d) => d.property)).toContain("key");
});

test("a matching name that is NOT unique is a conflict — the constraint is the point", async () => {
  await db().collection(COLL).createIndex({ idempotencyKey: 1 }, { name: "one_per_key" });

  const verdict = preflight.classify(
    {
      collection: COLL, name: "one_per_key",
      key: { idempotencyKey: 1 }, options: { unique: true },
    },
    await liveIndexes(),
  );
  expect(verdict.state).toBe("conflict");
  expect(verdict.differences).toEqual([{ property: "unique", wanted: true, found: false }]);

  /* ── AND IT IS NOT BUILT OVER ──────────────────────────────────────────
     Dropping and recreating an index on a live collection is a decision for
     somebody who can see its size and load. The migration reports and refuses. */
  const rows = await preflight.surveyIndexes(db(), [{
    collection: COLL, name: "one_per_key",
    key: { idempotencyKey: 1 }, options: { unique: true },
  }]);
  const outcome = await preflight.buildMissing(db(), rows);
  expect(outcome.built).toEqual([]);
  expect(outcome.refused).toHaveLength(1);
  expect(outcome.refused[0].name).toBe("one_per_key");

  /* The index that was there is untouched, and still not unique. */
  const live = (await liveIndexes()).find((i) => i.name === "one_per_key");
  expect(live.unique).toBeUndefined();
});

test("a different partial filter under the same name is a conflict", async () => {
  await db().collection(COLL).createIndex(
    { printKey: 1 },
    { name: "one_print", unique: true, partialFilterExpression: { printKey: { $type: "string" } } },
  );

  const verdict = preflight.classify(
    {
      collection: COLL, name: "one_print", key: { printKey: 1 },
      options: {
        unique: true,
        partialFilterExpression: { printKey: { $type: "string", $gt: "" } },
      },
    },
    await liveIndexes(),
  );
  expect(verdict.state).toBe("conflict");
  expect(verdict.differences.map((d) => d.property)).toContain("partialFilterExpression");
});

test("the same partial filter written in another key order is the SAME index", async () => {
  await db().collection(COLL).createIndex(
    { printKey: 1 },
    {
      name: "one_print", unique: true,
      partialFilterExpression: { printKey: { $gt: "", $type: "string" } },
    },
  );
  const verdict = preflight.classify(
    {
      collection: COLL, name: "one_print", key: { printKey: 1 },
      options: {
        unique: true,
        partialFilterExpression: { printKey: { $type: "string", $gt: "" } },
      },
    },
    await liveIndexes(),
  );
  expect(verdict.state).toBe("present");
});

test("absent and false are the same thing for unique, sparse and partial", () => {
  expect(preflight.sameStructure(
    { key: { a: 1 }, options: { unique: false, sparse: false } },
    { key: { a: 1 } },
  )).toBe(true);
  expect(preflight.sameStructure(
    { key: { a: 1 }, options: { sparse: true } },
    { key: { a: 1 } },
  )).toBe(false);
});

test("a TTL difference is a conflict — a wrong TTL deletes documents", async () => {
  await db().collection(COLL).createIndex({ at: 1 }, { name: "ttl", expireAfterSeconds: 60 });
  const verdict = preflight.classify(
    { collection: COLL, name: "ttl", key: { at: 1 }, options: { expireAfterSeconds: 3600 } },
    await liveIndexes(),
  );
  expect(verdict.state).toBe("conflict");
  expect(verdict.differences.map((d) => d.property)).toContain("expireAfterSeconds");
});

test("a collection that does not exist reports every index as missing, and reading does not create it", async () => {
  const absent = `never_written_${Date.now()}`;
  const rows = await preflight.surveyIndexes(db(), [
    { collection: absent, name: "x", key: { a: 1 } },
  ]);
  expect(rows[0].state).toBe("missing");

  const names = (await db().listCollections().toArray()).map((c) => c.name);
  expect(names).not.toContain(absent);
});

/* ══ THE MIGRATIONS THEMSELVES USE IT ════════════════════════════════════ */

test("the ownership migration surveys by structure and stays a dry run by default", async () => {
  const migration = require("../../scripts/migrations/customer-material-ownership-indexes");

  /* One of its own specs, built under a different name, must read as present. */
  const spec = migration.INDEXES.find((i) => i.collection === "customer_material_lots");
  await db().collection(spec.collection).createIndex(spec.key, { name: "renamed_by_hand" });

  const out = await migration.run({});
  const row = out.rows.find((r) => r.name === spec.name);
  expect(out.applied).toBe(false);
  expect(row.state).toBe("present");
  expect(row.matchedName).toBe("renamed_by_hand");
  expect(out.text).toMatch(/DRY RUN/);
  expect(out.text).toMatch(/equivalent, nothing to build/);

  /* A dry run wrote nothing: still exactly the one index plus _id_. */
  const live = await db().collection(spec.collection).indexes();
  expect(live.map((i) => i.name).sort()).toEqual(["_id_", "renamed_by_hand"]);

  await db().collection(spec.collection).dropIndex("renamed_by_hand");
});

test("the ownership migration declares the unique first-print and one-return-per-key indexes", () => {
  const { INDEXES } = require("../../scripts/migrations/customer-material-ownership-indexes");

  const printKey = INDEXES.find((i) => i.name === "companyId_1_customerMaterial.printKey_1");
  expect(printKey.options.unique).toBe(true);
  /* Partial: every purchase and product label carries no print key and must not
     collide with the others on an empty string. */
  expect(printKey.options.partialFilterExpression).toBeTruthy();

  const oneReturn = INDEXES.find((i) => i.collection === "customer_material_returns"
    && i.name === "companyId_1_idempotencyKey_1");
  expect(oneReturn.options.unique).toBe(true);
});

/* ══ RETIRING AN INDEX THE FEATURE ITSELF GOT WRONG ══════════════════════ */

// `--retire` is the one mode of that script that DROPS something, so the two
// things worth holding are that it drops nothing unless asked, and that when
// asked it drops only what is named.

test("a stale index is reported but not dropped unless --retire is given", async () => {
  const migration = require("../../scripts/migrations/customer-material-ownership-indexes");
  const spec = migration.RETIRED[0];
  const col = db().collection(spec.collection);

  /* Rebuild the wrong index exactly as the deployed database carries it. */
  await col.createIndex(
    { companyId: 1, developmentFileId: 1, revisionNo: 1 },
    { unique: true, name: spec.name, partialFilterExpression: { developmentFileId: { $type: "objectId" } } },
  );

  const dry = await migration.run({});
  expect(dry.retired.find((r) => r.name === spec.name).present).toBe(true);
  expect(dry.text).toMatch(/STALE/);
  expect(dry.text).toMatch(/--retire/);
  /* Reported, and still there. */
  expect((await col.indexes()).map((i) => i.name)).toContain(spec.name);

  const done = await migration.run({ retire: true });
  expect(done.text).toMatch(/RETIRED \(dropped\)/);
  expect((await col.indexes()).map((i) => i.name)).not.toContain(spec.name);
});

test("--retire drops only the named indexes, never a neighbour", async () => {
  const migration = require("../../scripts/migrations/customer-material-ownership-indexes");
  const spec = migration.RETIRED[0];
  const col = db().collection(spec.collection);

  await col.createIndex({ companyId: 1, developmentFileId: 1, revisionNo: 1 }, { name: spec.name });
  /* A bystander on the same collection, of the same shape family. */
  await col.createIndex({ companyId: 1, developmentFileId: 1 }, { name: "someone_elses_read" });

  await migration.run({ retire: true });

  const left = (await col.indexes()).map((i) => i.name);
  expect(left).not.toContain(spec.name);
  expect(left).toContain("someone_elses_read");
  await col.dropIndex("someone_elses_read");
});

/* ══ THE DRY RUN THAT CREATED INDEXES IN PRODUCTION ══════════════════════ */

// This guard is not about a function's return value; it is about a line of
// source, and deliberately so.
//
// WHAT HAPPENED. A migration connected with `connect(uri, { autoIndex: false })`
// and ran a survey — a read. It created indexes anyway. Mongoose registers a
// model's declared indexes when the MODEL is compiled, and `require`ing anything
// that pulls a model in is enough; the connection option does not retract the
// registrations that already exist. Only the GLOBAL setting suppresses them, and
// only if it is set before the connection is opened.
//
// There is no assertion available after the fact that distinguishes "this script
// will not build an index" from "this script did not happen to build one this
// time" — by the time a test could look, the indexes would exist. So the guard
// is on the text: the global setter must be present, and it must come before the
// connect call.

describe("every index-touching migration disables automatic index creation before connecting", () => {
  const MIGRATIONS = [
    "customer-material-ownership-indexes.js",
    "goods-receipt-source-contract.js",
    "rawitem-master-identity-key.js",
  ];

  for (const file of MIGRATIONS) {
    test(`${file} sets the global autoIndex:false before it connects`, () => {
      const src = fs.readFileSync(
        path.join(__dirname, "../../scripts/migrations", file), "utf8",
      );

      const setter = src.indexOf('mongoose.set("autoIndex", false)');
      const connect = src.indexOf("mongoose.connect(");

      expect(setter).toBeGreaterThan(-1);
      expect(connect).toBeGreaterThan(-1);
      /* ORDER IS THE WHOLE POINT. Setting it after the connection is open is
         exactly as useless as not setting it at all. */
      expect(setter).toBeLessThan(connect);

      /* The connect option stays as well — belt and braces, and it is what a
         reader expects to see on the call itself. */
      expect(src).toMatch(/mongoose\.connect\([^)]*autoIndex:\s*false/s);
    });
  }
});

test("no customer-material model declares an index of its own", () => {
  /* The other half of the same defect. These collections are written INSIDE
     transactions, and Mongoose builds a schema's indexes lazily on the
     collection's first use — which lands the build inside the transaction, takes
     the collection lock, hits the 5 ms transaction lock timeout, and surfaces as
     a retried `VersionError` that says nothing about indexes. It cost a long
     bisect on `goodsreceipts` and then the same again on `barcodes`.
     Their indexes belong to the migration. */
  const {
    CustomerMaterialReturn,
  } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialReturn");
  expect(CustomerMaterialReturn.schema.indexes()).toEqual([]);
});
