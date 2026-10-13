#!/usr/bin/env node
"use strict";
/**
 * scripts/audits/store-tenancy-release-gate.js
 *
 * THE RELEASE GATE FOR STORE SEARCH. IT FAILS UNTIL STRICT TENANCY CAN BE
 * TURNED ON.
 *
 * ── WHAT IS ACTUALLY WRONG TODAY ──────────────────────────────────────────
 * `tenantContext.tenantFilter` is, while `STORE_PURCHASE_STRICT_TENANCY` is
 * unset:
 *
 *     { $or: [ { companyId: ctx.companyId },
 *              { companyId: { $exists: false } },
 *              { companyId: null } ] }
 *
 * The last two clauses are a TEMPORARY read-through for records written
 * before company stamping. Every Store reader inherits them, the command
 * palette included — so a record with no `companyId` is visible to a reader
 * of ANY company. That is not a palette defect and the palette cannot fix it:
 * the palette is correct precisely because it reuses the same scope as every
 * other Store read. But it means cross-tenant isolation is a PROPERTY OF THE
 * DATA, not of the code, and today the data does not have it.
 *
 * So Store search is not production-ready on a multi-company database until
 * this gate passes. On a single-company database the read-through is
 * harmless, because there is no other tenant to leak to — and this says which
 * situation the database is actually in rather than assuming.
 *
 * ── WHAT IT CHECKS ────────────────────────────────────────────────────────
 *   1  how many companies exist at all (one company ⇒ no leak is possible);
 *   2  for every Store & Purchase collection that HAS a `companyId` field,
 *      how many live records are missing it;
 *   3  the two inventory collections the palette reads which are not in the
 *      universal contract (raw items, location balances) — the biggest
 *      collections, and the ones behind "stock of X" and "where is X kept";
 *   4  whether `STORE_PURCHASE_STRICT_TENANCY` is on.
 *
 * It WRITES NOTHING. The backfill is
 * `scripts/migrations/store-purchase-company-backfill.js`, which is a dry run
 * unless given `--apply`.
 *
 *   node -r dotenv/config scripts/audits/store-tenancy-release-gate.js
 *   node -r dotenv/config scripts/audits/store-tenancy-release-gate.js --json
 */

const mongoose = require("mongoose");

const { ENTITY_SPECS } = require("../../services/storePurchaseUniversalContract");

/* The collections the palette reads that the universal contract does not
   list. Both are read by the inventory capabilities, and `rawitems` is the
   one behind every "stock of X". */
const EXTRA = [
  ["inventory_item", require("../../models/CMS_Models/Inventory/Products/RawItem")],
  ["location_balance", require("../../models/CMS_Models/Inventory/Operations/LocationBalance")],
];

/** Records with no company: absent or null. */
const UNOWNED = { $or: [{ companyId: { $exists: false } }, { companyId: null }] };

/**
 * The same question, asked in a way the model can answer.
 *
 * An empty string is also "no company", but only where the field is a string:
 * `{ companyId: "" }` against an ObjectId path is a cast error, which would
 * take the gate down rather than report a number.
 */
function unownedFilter(model) {
  const path = model?.schema?.path("companyId");
  if (path?.instance === "String") {
    return { $or: [...UNOWNED.$or, { companyId: "" }] };
  }
  return UNOWNED;
}

function collections() {
  const rows = [];
  for (const spec of ENTITY_SPECS) {
    if (!spec.model?.schema?.path("companyId")) continue;
    rows.push({ id: spec.id, label: spec.label, model: spec.model });
  }
  for (const [id, model] of EXTRA) {
    if (rows.some((r) => r.model.collection.name === model.collection.name)) continue;
    rows.push({ id, label: id.replace(/_/g, " "), model });
  }
  return rows;
}

async function measure() {
  const Company = mongoose.models.Acc_Company
    || mongoose.model("Acc_Company", new mongoose.Schema({}, { strict: false }), "acc_companies");
  const companyCount = await Company.estimatedDocumentCount();

  const rows = [];
  for (const entry of collections()) {
    /* `withDeleted` so a trashed raw item is counted too: the trash is still
       a record, and strict tenancy will scope it the same way. */
    const query = entry.model.find(unownedFilter(entry.model)).setOptions({ withDeleted: true });
    /* eslint-disable no-await-in-loop */
    const unowned = await query.countDocuments();
    const total = await entry.model.find({}).setOptions({ withDeleted: true }).countDocuments();
    /* eslint-enable no-await-in-loop */
    rows.push({
      id: entry.id, collection: entry.model.collection.name, total, unowned,
    });
  }
  rows.sort((a, b) => b.unowned - a.unowned || a.collection.localeCompare(b.collection));

  const unownedTotal = rows.reduce((n, r) => n + r.unowned, 0);
  const strict = process.env.STORE_PURCHASE_STRICT_TENANCY === "1";
  return {
    companyCount,
    strict,
    collections: rows.length,
    unownedTotal,
    /* ── THE GATE ─────────────────────────────────────────────────────
       Isolation holds when no record is unowned AND the flag is on. A
       single-company database cannot leak between tenants whatever the
       flag says, so it is reported separately rather than counted as a
       pass: it is a reason the risk is nil TODAY, not a reason the gate
       has been met. */
    isolated: unownedTotal === 0 && strict,
    singleCompany: companyCount <= 1,
    rows,
  };
}

async function main() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";
  await mongoose.connect(uri);
  let out;
  try {
    out = await measure();
  } finally {
    await mongoose.disconnect();
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  } else {
    const line = (s = "") => process.stdout.write(`${s}\n`);
    const say = (k, v) => line(`   ${String(k).padEnd(46)} ${v}`);
    line();
    line("Store & Purchase tenancy — release gate");
    say("companies in the books", out.companyCount);
    say("collections checked", out.collections);
    say("records with no companyId", out.unownedTotal);
    say("STORE_PURCHASE_STRICT_TENANCY", out.strict ? "on" : "OFF");
    line();
    for (const row of out.rows.filter((r) => r.unowned)) {
      line(`   ${String(row.unowned).padStart(8)} of ${String(row.total).padEnd(8)} unowned   ${row.collection}`);
    }
    line();
    if (out.isolated) {
      line("   PASSED: every Store & Purchase record is owned and strict tenancy is on.");
    } else {
      line("   BLOCKED: Store search is NOT production-ready on a multi-company database.");
      if (out.unownedTotal) {
        line("   Backfill first:  node -r dotenv/config scripts/migrations/store-purchase-company-backfill.js");
        line("   then re-run, then set STORE_PURCHASE_STRICT_TENANCY=1.");
      } else if (!out.strict) {
        line("   Every record is owned. Set STORE_PURCHASE_STRICT_TENANCY=1 and re-run.");
      }
      if (out.singleCompany) {
        line();
        line("   Note: this database holds one company, so nothing can leak between");
        line("   tenants today. That is a fact about the DATA, not about the code,");
        line("   and it stops being true the moment a second company is created.");
      }
    }
    line();
  }
  process.exitCode = out.isolated ? 0 : 1;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { measure, collections, UNOWNED, unownedFilter, EXTRA };
