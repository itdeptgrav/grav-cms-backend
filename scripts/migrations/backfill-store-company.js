// scripts/migrations/backfill-store-company.js
//
// Give existing Store & Purchase records the company they already belong to.
//
// ── THE SYMPTOM THIS FIXES ──────────────────────────────────────────────────
// The Item Master shows "0 items" against a database holding 259 of them.
// Store reads are tenant-scoped — `tenantContext.tenantFilter` returns
// `{ companyId: <the caller's company> }` — and every one of those 259 rows
// carries `companyId: null`, so the query matches nothing and the screen says
// there is nothing there. The same is true of vendors, units, purchase orders
// and material requests.
//
// There IS a legacy escape hatch in `tenantFilter` — it selects the unowned
// records when `ctx.legacyMode` is set — but nothing sets it: both context
// builders hardcode `legacyMode: false`. So the path is dead, and turning it on
// globally would make every company see every unowned record, which is the
// ambiguity the tenancy work exists to remove. The records need owning, not
// the filter loosening.
//
// ── THE RULE IT REFUSES TO BREAK ────────────────────────────────────────────
// It assigns a company ONLY when the company master holds exactly one. With
// two or more, nothing in the data says which one a 2024 purchase order
// belonged to, and picking the first, the busiest or the operator's current one
// would be inventing ownership for commercial records.
//
// ── AND WHAT IT WILL NOT TOUCH ──────────────────────────────────────────────
// Only models that carry `companyId`, are company-owned by design, and are read
// through tenant-scoped Store routes. Shared masters (operations, machines,
// barcodes) have no `companyId` and are deliberately global — stamping them
// would invent a tenancy their screens do not have. Infrastructure that is
// written only by current code (idempotency records, sequences, memberships)
// is already stamped or empty, and is excluded rather than swept along.
//
//   node scripts/migrations/backfill-store-company.js               # dry run
//   node scripts/migrations/backfill-store-company.js --apply       # writes
//   node scripts/migrations/backfill-store-company.js --only=RawItem
"use strict";

require("dotenv").config({ quiet: true });

const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const ONLY = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1] || "";
const BATCH = 500;

/* ── THE COLLECTIONS THIS MIGRATION OWNS ───────────────────────────────────
 * Deliberately enumerated, never discovered by scanning for a `companyId`
 * field. A model can carry the field and still be the wrong thing to stamp:
 * `SpIdempotencyRecord` has one and is written exclusively by current code, so
 * an unstamped row there would be a bug to investigate, not a gap to fill. */
const TARGETS = Object.freeze([
  { model: "RawItem", file: "models/CMS_Models/Inventory/Products/RawItem", label: "Item master" },
  { model: "Vendor", file: "models/CMS_Models/Inventory/Vendor-Buyer/Vendor", label: "Suppliers" },
  { model: "Unit", file: "models/CMS_Models/Inventory/Configurations/Unit", label: "Units of measure" },
  { model: "Warehouse", file: "models/CMS_Models/Inventory/Configurations/Warehouse", label: "Warehouses" },
  { model: "PurchaseOrder", file: "models/CMS_Models/Inventory/Operations/PurchaseOrder", label: "Purchase orders" },
  { model: "MRF", file: "models/CMS_Models/Inventory/Operations/MRF", label: "Material requests" },
  { model: "StockIssuance", file: "models/CMS_Models/Inventory/Operations/StockIssuance", label: "Stock issues" },
  { model: "MrfChatMessage", file: "models/CMS_Models/Inventory/Operations/MrfChatMessage", label: "Material request chat" },
]);

/* Carried in the report so the reader can see what was considered and passed
   over, rather than inferring it from an absence. */
const EXCLUDED = Object.freeze([
  { model: "StockItem", why: "GLOBAL", note: "No companyId field. Finished goods are not company-scoped in this schema." },
  { model: "Operation", why: "GLOBAL", note: "No companyId field — a shared configuration master." },
  { model: "OperationCode", why: "GLOBAL", note: "No companyId field." },
  { model: "OperationGroup", why: "GLOBAL", note: "No companyId field." },
  { model: "Machine", why: "GLOBAL", note: "No companyId field." },
  { model: "MachineType", why: "GLOBAL", note: "No companyId field." },
  { model: "Barcode", why: "GLOBAL", note: "No companyId field." },
  { model: "StoreSettings", why: "GLOBAL", note: "No companyId field." },
  { model: "RawItemAddRequest", why: "GLOBAL", note: "No companyId field." },
  { model: "Requisition", why: "GLOBAL", note: "No companyId field." },
  { model: "MeasurementSizeConfig", why: "GLOBAL", note: "No companyId field." },
  { model: "Service", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "SupplierOffer", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "ServiceOrder", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "StockLedger", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "StockCount", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "LocationBalance", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "LocationMovement", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "LandedCostAllocation", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "SpActionHistory", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "SpApprovalPolicy", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "SpCompanyMembership", why: "EMPTY", note: "Company-owned, and holds no documents." },
  { model: "SpDocumentSequence", why: "EMPTY", note: "Company-owned, and holds no documents." },
  {
    model: "SpIdempotencyRecord", why: "CURRENT_CODE_ONLY",
    note: "Written only by current tenant-aware code and already stamped. An unstamped row "
      + "here would be a defect to investigate, not a legacy gap to fill.",
  },
]);

/* Only the rows with no owner. An owned record is never re-owned: this filter
   IS the idempotency, and it is also what makes a second run a no-op. */
const UNOWNED = { $or: [{ companyId: null }, { companyId: { $exists: false } }] };

const loadModels = () => {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".js")) { try { require(path.resolve(p)); } catch { /* not a model */ } }
    }
  };
  walk(path.resolve(__dirname, "..", "..", "models"));
};

/**
 * Would stamping this company create a duplicate on any unique index?
 *
 * ── TWO WAYS IT CAN, AND ONLY ONE IS OBVIOUS ───────────────────────────────
 * The obvious one is two unowned rows sharing a key. For a NON-partial index
 * like `{companyId, sku}` that pair cannot exist today — Mongo indexes null as
 * a value, so `{companyId: null, sku: "X"}` twice is already a duplicate and
 * the second insert was rejected years ago.
 *
 * The reachable one is an unowned row colliding with a row THIS COMPANY
 * ALREADY OWNS: somebody registered item "RAW-118" last week, and a legacy row
 * with the same SKU has been sitting unowned since before tenancy existed.
 * Apart they are legal. Stamped, they are one company with one SKU twice, and
 * the write fails halfway through the collection.
 *
 * Both are checked, against the company actually being stamped.
 *
 * ── AND THE PARTIAL FILTER IS PART OF THE QUESTION ─────────────────────────
 * Three of these indexes are partial — `{supplierCode: {$gt: ""}}`,
 * `{gstNormalised: {$gt: ""}}`, `{idempotencyKey: {$type: "string"}}`. A
 * document the filter excludes is not IN the index and cannot collide on it,
 * however its key fields compare. Checking the key alone reports 80 vendor
 * collisions that do not exist and blocks a migration that is perfectly safe.
 */
async function collisionsFor(Model, companyId) {
  const found = [];
  const indexes = await Model.collection.indexes();
  for (const index of indexes.filter((i) => i.unique)) {
    const keys = Object.keys(index.key);
    /* An index without `companyId` is unaffected: stamping changes no field
       it covers, so whatever it permits today it permits afterwards. */
    if (!keys.includes("companyId")) continue;
    const others = keys.filter((k) => k !== "companyId");
    if (!others.length) continue;

    /* ── THE FILTER MUST BE READ AS IT WILL BE, NOT AS IT IS ──────────────
       Vendor's filter is `{companyId: {$type: "objectId"}, supplierCode:
       {$gt: ""}}`. Applied to a row's CURRENT companyId it excludes every
       unowned row — they have none — so each one silently drops out of its
       own collision check and the migration reports "no collisions" over a
       duplicate it is about to create.

       The question is what the index holds AFTER stamping, when every
       candidate carries `companyId`. So the companyId clauses are evaluated
       once against the TARGET company, and the remaining clauses against the
       documents. */
    const partial = index.partialFilterExpression || {};
    const companyClause = partial.companyId;
    const fieldClauses = Object.fromEntries(
      Object.entries(partial).filter(([k]) => k !== "companyId"),
    );

    /* If the company being stamped does not itself satisfy the filter, the
       index will not cover these rows at all and nothing can collide.

       Asked of the database rather than reimplemented: an ObjectId satisfies
       `{$type: "objectId"}`, but the next partial filter somebody writes may
       use an operator this script has never heard of, and a hand-rolled
       evaluator that gets it wrong fails OPEN — reporting no collisions over
       a duplicate. */
    if (companyClause !== undefined) {
      const covers = await mongoose.connection.db
        .aggregate([{ $documents: [{ companyId }] }, { $match: { companyId: companyClause } }])
        .toArray();
      if (!covers.length) continue;
    }

    /* Everything that will share this company on this index once the run
       finishes: the rows being stamped, and the rows already owned. */
    const match = Object.keys(fieldClauses).length
      ? { $and: [{ $or: [UNOWNED, { companyId }] }, fieldClauses] }
      : { $or: [UNOWNED, { companyId }] };
    const group = Object.fromEntries(others.map((k) => [k, `$${k}`]));

    const dupes = await Model.aggregate([
      { $match: match },
      { $group: { _id: group, n: { $sum: 1 }, ids: { $push: "$_id" } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 20 },
    ]);
    if (dupes.length) {
      found.push({
        index: index.name,
        keys,
        partial: Boolean(index.partialFilterExpression),
        groups: dupes.map((d) => ({ key: d._id, count: d.n, sample: d.ids.slice(0, 3).map(String) })),
      });
    }
  }
  return found;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(process.env.MONGODB_URI);
  loadModels();

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const companies = await Acc_Company.find({}).select("companyName").lean();

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — Store & Purchase legacy company backfill`);
  console.log(`Database: ${mongoose.connection.name}`);
  console.log(`Companies: ${companies.length}${companies.length ? ` — ${companies.map((c) => c.companyName).join(", ")}` : ""}\n`);

  /* ── THE REFUSAL THAT MATTERS ─────────────────────────────────────────────
     Checked BEFORE anything is counted, so an ambiguous deployment gets the
     same answer whatever its data looks like. */
  if (companies.length !== 1) {
    console.log(companies.length === 0
      ? "REFUSED: there is no company to assign these records to."
      : `REFUSED: ${companies.length} companies exist. Nothing in the data says which one owns a `
        + "legacy record, and choosing one would be inventing ownership.");
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const companyId = companies[0]._id;
  const targets = ONLY ? TARGETS.filter((t) => t.model === ONLY) : TARGETS;
  if (ONLY && !targets.length) {
    console.log(`REFUSED: "${ONLY}" is not one of this migration's collections.`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const report = [];
  const blocked = [];

  for (const t of targets) {
    const Model = mongoose.model(t.model);
    const total = await Model.countDocuments({});
    const before = await Model.countDocuments(UNOWNED);
    const collisions = await collisionsFor(Model, companyId);
    report.push({ ...t, total, unowned: before, collisions });
    if (collisions.length) blocked.push(t.model);
  }

  console.log("collection            label                    total  unowned  owned  collisions");
  for (const r of report) {
    console.log(
      `${r.model.padEnd(21)} ${r.label.padEnd(24)} ${String(r.total).padStart(5)}`
      + `  ${String(r.unowned).padStart(7)}  ${String(r.total - r.unowned).padStart(5)}`
      + `  ${r.collisions.length ? `BLOCKED (${r.collisions.length})` : "none"}`,
    );
  }

  if (blocked.length) {
    console.log("\nREFUSED: stamping would create duplicates on a tenant-scoped unique index.");
    for (const r of report.filter((x) => x.collisions.length)) {
      for (const c of r.collisions) {
        console.log(`\n  ${r.model} · ${c.index} {${c.keys.join(", ")}}${c.partial ? " [partial]" : ""}`);
        for (const g of c.groups) {
          console.log(`    ${JSON.stringify(g.key)} x${g.count}  e.g. ${g.sample.join(", ")}`);
        }
      }
    }
    console.log("\nResolve the duplicates first. Nothing has been written.");
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  const work = report.reduce((a, r) => a + r.unowned, 0);
  if (!work) {
    console.log("\nNothing to do — every record already carries a company.");
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(`\nDRY RUN — would stamp ${work} records with ${companyId} (${companies[0].companyName}).`);
    console.log("Nothing has been written. Re-run with --apply to write.");
    console.log(`\nExcluded from this migration (${EXCLUDED.length}):`);
    for (const e of EXCLUDED) console.log(`  ${e.model.padEnd(22)} ${e.why.padEnd(18)} ${e.note}`);
    await mongoose.disconnect();
    return;
  }

  /* ── THE MANIFEST IS WRITTEN BEFORE THE UPDATE ────────────────────────────
     Every id this run will touch, recorded first. Written afterwards it would
     be missing exactly the ids of a run that failed halfway — the one case
     anybody needs it for. It is what makes this reversible: the reverse is
     `$unset: {companyId: ""}` over precisely these ids, and nothing else. */
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const manifestPath = path.resolve(__dirname, `store-company-backfill-${stamp}.json`);
  const manifest = {
    migration: "backfill-store-company",
    database: mongoose.connection.name,
    companyId: String(companyId),
    companyName: companies[0].companyName,
    startedAt: new Date().toISOString(),
    collections: {},
  };
  for (const r of report) {
    manifest.collections[r.model] = (await mongoose.model(r.model)
      .find(UNOWNED).select("_id").lean()).map((d) => String(d._id));
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${manifestPath}`);

  let stamped = 0;
  for (const r of report) {
    const ids = manifest.collections[r.model];
    const Model = mongoose.model(r.model);
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH).map((id) => new mongoose.Types.ObjectId(id));
      /* Straight through the driver: these documents are being repaired, not
         edited by the application, and model middleware exists to police
         application edits. The filter repeats UNOWNED so a row somebody
         stamped between the manifest and here is left alone. */
      const res = await Model.collection.updateMany(
        { _id: { $in: slice }, ...UNOWNED },
        { $set: { companyId } },
      );
      stamped += res.modifiedCount;
    }
    const after = await Model.countDocuments(UNOWNED);
    console.log(`  ${r.model.padEnd(21)} unowned ${String(r.unowned).padStart(5)} -> ${String(after).padStart(5)}`);
  }

  console.log(`\nStamped ${stamped} records.`);
  console.log("Re-run without --apply to confirm nothing remains.");
  await mongoose.disconnect();
}

if (require.main === module) {
  /* ── IT MUST ALWAYS LET GO OF THE CONNECTION ──────────────────────────────
     Every `disconnect` above is on a path that succeeded. A throw anywhere —
     a duplicate key the collision check did not anticipate, a dropped network,
     an index build timing out — left the connection open, so the event loop
     never drained and the process HUNG instead of exiting. An operator gets a
     terminal that never returns and no way to tell a slow migration from a
     dead one; a script calling this waits for ever.

     Disconnecting twice is a no-op, so the success paths are left as they are
     and this is the backstop. */
  main()
    .catch((err) => {
      console.error("FAILED:", err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      try { await mongoose.disconnect(); } catch { /* already closed */ }
    });
}

module.exports = { TARGETS, EXCLUDED, UNOWNED, collisionsFor };
