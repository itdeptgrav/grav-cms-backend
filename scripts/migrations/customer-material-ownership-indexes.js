#!/usr/bin/env node
// scripts/migrations/customer-material-ownership-indexes.js
//
// THE INDEXES CUSTOMER-OWNED MATERIAL NEEDS, BUILT WHERE INDEXES BELONG.
//
// Three collections gained ownership fields when customer material became
// operational, and each has one read that has to be fast:
//
//   customer_material_lots  what is held for this customer / order / line
//   stockissuances          what was issued out of this lot
//   barcodes                this lot's labels, and whose company printed them
//
// ── WHY NOT ON THE SCHEMAS ──────────────────────────────────────────────────
// Because two of those collections are written INSIDE a transaction, and mongoose
// builds a schema's indexes lazily on first use. A build that lands inside the
// transaction takes collection locks, the transaction cannot acquire its own
// within mongod's 5ms lock timeout, the driver treats the timeout as transient and
// retries — and the retry re-saves a mongoose document whose `__v` the first
// attempt already bumped, failing with a VersionError that mentions nothing about
// indexes.
//
// That is not a theory. It was diagnosed on `GoodsReceipt` in the previous phase
// (one added index passed, two failed, reverting restored it) and reproduced here
// on `barcodes`: the purchase goods-receipt suite went from 22/22 to failing its
// multi-line receipt. Index creation belongs outside a transaction, which is what
// an explicit migration is.
//
// ── IT CREATES NOTHING BUT INDEXES ──────────────────────────────────────────
// No document is read, written or counted. It is safe to run against a live
// database at any time — and it still defaults to a dry run, because a script
// that writes by default is a script somebody runs by accident.
//
//   node -r dotenv/config scripts/migrations/customer-material-ownership-indexes.js
//   …--apply   build the ones that are missing
//   …--retire  drop the named indexes this feature built and got wrong (see RETIRED)
"use strict";

const mongoose = require("mongoose");

const preflight = require("./lib/indexPreflight");

const INDEXES = Object.freeze([
  {
    collection: "customer_material_lots",
    name: "companyId_1_customerId_1_orderRef_1_orderLineRef_1_status_1",
    key: { companyId: 1, customerId: 1, orderRef: 1, orderLineRef: 1, status: 1 },
    why: "what is held for this customer, order and permanent sales line",
  },
  {
    collection: "stockissuances",
    name: "companyId_1_ownership_1_items.customerMaterialLotId_1",
    key: { companyId: 1, ownership: 1, "items.customerMaterialLotId": 1 },
    options: { sparse: true },
    why: "everything issued out of one ownership lot",
  },
  {
    collection: "stockissuances",
    name: "companyId_1_ownership_1_manufacturingOrder_1",
    key: { companyId: 1, ownership: 1, manufacturingOrder: 1 },
    why: "customer material issued to one production order",
  },
  {
    collection: "barcodes",
    name: "companyId_1_createdAt_-1",
    key: { companyId: 1, createdAt: -1 },
    why: "a company's own labels, and the scope a cross-company scan is refused by",
  },
  {
    collection: "barcodes",
    name: "customerMaterial.lotId_1",
    key: { "customerMaterial.lotId": 1 },
    options: { sparse: true },
    why: "this lot's labels, for a reprint",
  },
  {
    collection: "barcodes",
    name: "companyId_1_customerMaterial.printKey_1",
    key: { companyId: 1, "customerMaterial.printKey": 1 },
    /* UNIQUE, and partial so it constrains only labels that carry a print key —
       every purchase and product label has none and must not collide on "".
       Until this is built the service's own lookup is the guard, which holds for
       the real case (an operator pressing Print again) but not for two truly
       simultaneous presses of the same key. */
    options: {
      unique: true,
      partialFilterExpression: { "customerMaterial.printKey": { $type: "string", $gt: "" } },
    },
    why: "first-print idempotency: one label per print key, per company",
  },
  {
    collection: "barcodes",
    name: "companyId_1_printBatchKey_1_printBatchSeq_1",
    key: { companyId: 1, printBatchKey: 1, printBatchSeq: 1 },
    /* The company-owned counterpart of the key above. A print run of five rolls
       is five labels at positions 1..5 under one key; a retry re-inserts the
       same five triples and the database refuses them, so a second press of
       Print cannot mint a second set of identities for the same rolls.

       Partial for the same reason: every label printed before this carries no
       batch key and must not collide on "". */
    options: {
      unique: true,
      partialFilterExpression: { printBatchKey: { $type: "string", $gt: "" } },
    },
    why: "print-run idempotency: one label per (batch key, position), per company",
  },
  {
    collection: "merchandising_customer_material_expectations",
    name: "one_expectation_per_request_line",
    key: { companyId: 1, sourceMrfLineId: 1 },
    /* ── THE IDEMPOTENCY THAT MAKES ROUTING SAFE TO RETRY ─────────────────
       An approved customer-supplied request line produces exactly one
       expectation. Approvals are delivered more than once and callers repeat
       timed-out requests; without this, two attempts that overlap both pass
       their own read-then-write and the delivery arrives against two claims.

       The service reads first, which handles the ordinary repeat. This handles
       the two that land in the same millisecond — and it is the only thing that
       can. Partial, because every expectation Merchandising composed directly
       carries no source line and `null` would collide across all of them. */
    options: {
      unique: true,
      partialFilterExpression: { sourceMrfLineId: { $type: "objectId" } },
    },
    why: "one customer-material expectation per approved request line, per company",
  },
  {
    collection: "merchandising_customer_material_expectations",
    name: "one_revision_per_document",
    key: { companyId: 1, documentRef: 1, revisionNo: 1 },
    /* A revision number belongs to a DOCUMENT, not to the work it is for. An
       execution file has one expectation revised 1..n; a development may have
       several, because each approved customer-supplied request line produces its
       own, each opening at revision 1. Keyed on the development — as this first
       was — the second sample for one development collided with the first. */
    options: { unique: true },
    why: "one revision number per customer-material document, per company",
  },
  {
    collection: "customer_material_lots",
    name: "companyId_1_documentRef_1_status_1",
    key: { companyId: 1, documentRef: 1, status: 1 },
    why: "every lot of one stable document, across its revisions",
  },
  {
    collection: "customer_material_returns",
    name: "companyId_1_idempotencyKey_1",
    key: { companyId: 1, idempotencyKey: 1 },
    options: {
      unique: true,
      partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } },
    },
    why: "one return per operation key — what recovery identifies the operation by",
  },
  {
    collection: "customer_material_returns",
    name: "companyId_1_documentRef_1_effectiveAt_-1",
    key: { companyId: 1, documentRef: 1, effectiveAt: -1 },
    why: "a document's returns, newest by the date they actually left",
  },
]);

/* ── INDEXES THIS FEATURE CREATED AND GOT WRONG ──────────────────────────────
   Not "indexes somebody else might not need". An entry belongs here only when it
   was built by this feature, is now known to be incorrect, and leaving it in
   place breaks the feature — which is a narrower thing than a tidy-up and the
   only case where this script will drop anything at all.

   It still does not drop on `--apply`. It reports, and drops only under the
   explicit `--retire`, because every other mode of this script promises in
   writing that it touches nothing it did not build. */
const RETIRED = Object.freeze([
  {
    collection: "merchandising_customer_material_expectations",
    name: "one_revision_per_development",
    why: "keyed revisions on the development, so a second expectation for one "
       + "development collided with the first — a legitimate case. Replaced by "
       + "one_revision_per_document.",
  },
]);

/** Which retired indexes are actually present. Reads index metadata only. */
async function surveyRetired(db) {
  const out = [];
  for (const spec of RETIRED) {
    let present = false;
    try {
      const existing = await db.collection(spec.collection).indexes();
      present = existing.some((i) => i.name === spec.name);
    } catch { present = false; /* no collection yet: nothing to retire */ }
    out.push({ ...spec, present });
  }
  return out;
}

async function survey() {
  /* ── STRUCTURE, NOT NAME ──────────────────────────────────────────────────
     This used to ask `existing.some(i => i.name === spec.name)`. An index under
     a different name was reported missing and built a second time; an index with
     the right name but the wrong key or missing uniqueness was reported present
     and skipped. See `lib/indexPreflight.js` for why both directions matter. */
  return preflight.surveyIndexes(mongoose.connection.db, INDEXES);
}

function render(rows, applied, outcome = null, retired = null) {
  const L = [""];
  L.push("CUSTOMER-MATERIAL OWNERSHIP INDEXES");
  L.push(`  Mode           ${applied ? "APPLIED" : "DRY RUN — nothing written"}`);
  L.push("");
  for (const r of rows) {
    L.push(preflight.renderRow(r));
    L.push(`            ${r.why}`);
  }
  L.push("");
  const missing = rows.filter((r) => r.state === "missing").length;
  const conflicts = rows.filter((r) => r.state === "conflict").length;
  L.push(applied
    ? `  BUILT ${outcome ? outcome.built.length : missing} index(es). `
      + "Documents were neither read nor written."
    : `  ${missing} to build. Re-run with --apply. Nothing else is touched.`);
  if (conflicts) {
    L.push(`  ${conflicts} CONFLICT(S) left alone — a name is taken by a different index. `
      + "Decide what happens to those by hand.");
  }
  const stale = (retired || []).filter((r) => r.present);
  if (stale.length) {
    L.push("");
    L.push(retired.dropped
      ? "  RETIRED (dropped):"
      : "  STALE — built by this feature, now incorrect. Re-run with --retire to drop:");
    for (const r of stale) {
      L.push(`    ${r.collection}.${r.name}`);
      L.push(`            ${r.why}`);
    }
  }
  L.push("");
  return L.join("\n");
}

async function run({ apply = false, retire = false } = {}) {
  const rows = await survey();
  const retired = await surveyRetired(mongoose.connection.db);
  if (retire) {
    /* Named one at a time, and only the names above — never a pattern, never
       "everything that is not in INDEXES". */
    for (const r of retired.filter((x) => x.present)) {
      await mongoose.connection.db.collection(r.collection).dropIndex(r.name);
    }
    retired.dropped = true;
  }
  if (!apply) {
    return { ok: true, rows, retired, applied: false, text: render(rows, false, null, retired) };
  }
  /* Builds what is missing and REFUSES a conflict rather than dropping and
     recreating it — replacing a live index is a decision for somebody who can
     see the collection's size and load. */
  const outcome = await preflight.buildMissing(mongoose.connection.db, rows);
  return {
    ok: outcome.refused.length === 0,
    rows, retired, applied: true, ...outcome, text: render(rows, true, outcome, retired),
  };
}

async function main() {
  require("dotenv").config({ quiet: true });
  /* Global, and set before any model is touched — `connect({autoIndex:false})`
     alone does not hold, which is how a dry run once created indexes it had just
     promised not to. */
  mongoose.set("autoIndex", false);
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri, { autoIndex: false });
  console.log(`  Database       ${mongoose.connection.name}`);
  try {
    const out = await run({
      apply: process.argv.includes("--apply"),
      retire: process.argv.includes("--retire"),
    });
    console.log(out.text);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { run, survey, surveyRetired, render, INDEXES, RETIRED };
