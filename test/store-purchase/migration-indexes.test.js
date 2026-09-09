// test/store-purchase/migration-indexes.test.js
//
// Store & Purchase — Chunk 1. The index migration, proved before it is run.
//
// A migration that changes a unique index is exactly the kind of script that
// must be reviewable and rehearsed, because the failure mode is a collection
// that will not accept writes. These run it against a real (in-memory)
// database so the plan and the conflict detection are checked, not just read.
"use strict";

const mongoose = require("mongoose");
const { detectConflicts, plan, LEGACY_PO_INDEX } = require("../../scripts/migrations/store-purchase-chunk1-indexes");

const db = () => mongoose.connection.db;

/* Each test starts from a stated index state. `afterEach` clears documents
   but not indexes, so a test that needs a PRE-migration database has to say
   so — otherwise it inherits the compound unique index an earlier test
   created and cannot insert the duplicates it exists to detect. */
async function dropAllButId(collection) {
  const existing = await db().collection(collection).indexes().catch(() => []);
  for (const idx of existing) {
    if (idx.name !== "_id_") await db().collection(collection).dropIndex(idx.name).catch(() => {});
  }
}
/* Documents too: the shared afterEach clears collections MONGOOSE knows
   about, and this file talks to the driver directly, so `purchaseorders` is
   never registered and never cleared. Without this, one test's duplicates
   leak into the next and the findings describe the wrong data. */
beforeEach(async () => {
  await dropAllButId("purchaseorders");
  await db().collection("purchaseorders").deleteMany({});
  await db().collection("sp_company_memberships").deleteMany({}).catch(() => {});
});

test("the plan drops the legacy global index when it exists, and not otherwise", async () => {
  await db().collection("purchaseorders").createIndex({ poNumber: 1 }, { unique: true, name: LEGACY_PO_INDEX });
  const withLegacy = await plan(db());
  expect(withLegacy.some((s) => s.action === "DROP_INDEX" && s.name === LEGACY_PO_INDEX)).toBe(true);

  await db().collection("purchaseorders").dropIndex(LEGACY_PO_INDEX);
  const without = await plan(db());
  expect(without.some((s) => s.action === "DROP_INDEX")).toBe(false);
});

test("the plan creates every index Chunk 1 depends on, and is idempotent", async () => {
  const first = await plan(db());
  const names = first.filter((s) => s.action === "CREATE_INDEX").map((s) => s.name);
  expect(names).toEqual(expect.arrayContaining([
    "companyId_1_poNumber_1", "sp_sequence_key", "sp_idempotency_key", "sp_history_entity",
  ]));

  for (const step of first.filter((s) => s.action === "CREATE_INDEX")) {
    await db().collection(step.collection).createIndex(step.keys, step.options);
  }
  /* Re-planning after applying must find nothing left to do — which is what
     makes a half-finished run safe to repeat. */
  const second = await plan(db());
  expect(second.filter((s) => s.action === "CREATE_INDEX")).toEqual([]);
});

test("duplicate (company, number) pairs are reported as BLOCKING before anything is touched", async () => {
  const companyId = new mongoose.Types.ObjectId();
  await db().collection("purchaseorders").insertMany([
    { companyId, poNumber: "PO/2026-27/0001" },
    { companyId, poNumber: "PO/2026-27/0001" },
  ]);
  const findings = await detectConflicts(db());
  const blocking = findings.find((f) => f.severity === "BLOCKING");
  expect(blocking).toBeTruthy();
  expect(blocking.rows[0].count).toBe(2);
});

test("legacy unowned orders are REPORTED, never assigned a company", async () => {
  await db().collection("purchaseorders").insertMany([
    { poNumber: "PO25080001" },                       // no companyId at all
    { poNumber: "PO25080002", companyId: null },
  ]);
  const findings = await detectConflicts(db());
  const info = findings.find((f) => f.severity === "INFORMATIONAL");
  expect(info.what).toMatch(/carry no company/);
  expect(info.detail).toMatch(/does NOT assign ownership/);

  /* And nothing was changed by looking. */
  const stillUnowned = await db().collection("purchaseorders").countDocuments({
    $or: [{ companyId: { $exists: false } }, { companyId: null }],
  });
  expect(stillUnowned).toBe(2);
});

test("two companies sharing a number is NOT a conflict — that is the point of the change", async () => {
  await db().collection("purchaseorders").insertMany([
    { companyId: new mongoose.Types.ObjectId(), poNumber: "PO/2026-27/0001" },
    { companyId: new mongoose.Types.ObjectId(), poNumber: "PO/2026-27/0001" },
  ]);
  const findings = await detectConflicts(db());
  expect(findings.some((f) => f.severity === "BLOCKING")).toBe(false);
});
