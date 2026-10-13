#!/usr/bin/env node
"use strict";
/**
 * scripts/migrations/store-purchase-company-backfill.js
 *
 * STAMP EVERY UNOWNED STORE & PURCHASE RECORD WITH ITS COMPANY.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 * `tenantContext.tenantFilter` reads through to records with no `companyId`
 * while `STORE_PURCHASE_STRICT_TENANCY` is unset, so such a record is visible
 * to a reader of any company. Every Store reader inherits that, the command
 * palette included. Cross-tenant isolation is therefore a property of the
 * DATA until this has run and the flag is on.
 *
 * ── WHAT IT DOES, AND WHAT IT REFUSES TO DO ──────────────────────────────
 * It sets `companyId` on records that have none, to the canonical company —
 * the `isPrimary` row, the same one `booksCompany` and every other Store
 * write resolves. It does not touch a record that already has one, it never
 * changes a company, and it never deletes.
 *
 * It REFUSES to run when the books hold more than one company unless
 * `--company=<id>` names which one these records belong to, because with two
 * companies "the canonical one" is a guess about ownership, and a wrong guess
 * hands one company's stock to another. That decision is the owner's.
 *
 * ── HOW TO RUN IT ────────────────────────────────────────────────────────
 *   node -r dotenv/config scripts/migrations/store-purchase-company-backfill.js
 *       → DRY RUN. Writes nothing. Prints what it would stamp, per collection.
 *
 *   … --apply                 actually write
 *   … --company=<objectId>    stamp that company instead of the canonical one
 *   … --only=purchase_order,goods_receipt    limit to named collections
 *
 * Then: `scripts/audits/store-tenancy-release-gate.js` must pass before
 * `STORE_PURCHASE_STRICT_TENANCY=1` is set.
 *
 * Re-running is harmless: a stamped record no longer matches.
 */

const mongoose = require("mongoose");

const { collections, unownedFilter } = require("../audits/store-tenancy-release-gate");
const { getCanonicalCompany } = require("../../services/companyContext/canonicalCompany.service");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

async function resolveCompany() {
  const named = arg("company");
  if (named) {
    if (!/^[a-f\d]{24}$/i.test(named)) throw new Error(`--company=${named} is not an id.`);
    return { id: new mongoose.Types.ObjectId(named), source: "named on the command line" };
  }
  const Company = mongoose.models.Acc_Company
    || mongoose.model("Acc_Company", new mongoose.Schema({}, { strict: false }), "acc_companies");
  const count = await Company.estimatedDocumentCount();
  if (count === 0) throw new Error("The books hold no company, so nothing can be stamped.");
  if (count > 1) {
    throw new Error(
      `The books hold ${count} companies. Which one these unowned records belong to is `
      + "an ownership decision, not something this script may guess — a wrong guess hands "
      + "one company's stock to another. Re-run with --company=<objectId>.",
    );
  }
  const canonical = await getCanonicalCompany();
  const id = canonical?._id || canonical?.id || canonical;
  if (!id) throw new Error("The canonical company could not be resolved.");
  return { id, source: "the canonical (isPrimary) company" };
}

async function run({ apply = false } = {}) {
  const only = (arg("only") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const company = await resolveCompany();

  const rows = [];
  for (const entry of collections()) {
    if (only.length && !only.includes(entry.id)) continue;
    /* `withDeleted` because a trashed record is still a record, and strict
       tenancy will scope it the same way. Leaving it unowned would make the
       trash readable across companies. */
    const unowned_ = unownedFilter(entry.model);
    const query = () => entry.model.find(unowned_).setOptions({ withDeleted: true });
    // eslint-disable-next-line no-await-in-loop
    const unowned = await query().countDocuments();
    let stamped = 0;
    if (apply && unowned) {
      // eslint-disable-next-line no-await-in-loop
      const result = await entry.model.updateMany(
        unowned_,
        { $set: { companyId: company.id } },
        { withDeleted: true, timestamps: false, strict: false },
      );
      stamped = result.modifiedCount ?? result.nModified ?? 0;
    }
    rows.push({ id: entry.id, collection: entry.model.collection.name, unowned, stamped });
  }
  rows.sort((a, b) => b.unowned - a.unowned || a.collection.localeCompare(b.collection));
  return { company, apply, rows, unownedTotal: rows.reduce((n, r) => n + r.unowned, 0) };
}

async function main() {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  let out;
  try {
    out = await run({ apply });
  } finally {
    await mongoose.disconnect();
  }
  const line = (s = "") => process.stdout.write(`${s}\n`);
  line();
  line(apply ? "Store & Purchase company backfill — APPLIED" : "Store & Purchase company backfill — DRY RUN (writes nothing)");
  line(`   company: ${out.company.id} (${out.company.source})`);
  line();
  for (const row of out.rows.filter((r) => r.unowned)) {
    line(`   ${String(row.unowned).padStart(8)} unowned${apply ? ` → ${row.stamped} stamped` : ""}   ${row.collection}`);
  }
  line();
  line(`   ${out.unownedTotal} record${out.unownedTotal === 1 ? "" : "s"} with no company.`);
  if (!apply && out.unownedTotal) line("   Re-run with --apply to stamp them.");
  if (apply) line("   Now run scripts/audits/store-tenancy-release-gate.js before setting the flag.");
  line();
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { run, resolveCompany };
