// scripts/rnd/reconcile-pattern-revisions.js
//
// RECOVER THE PATTERN REVISION FOR ONE STYLE, FROM WHAT IS ALREADY STORED.
//
//   node -r dotenv/config scripts/rnd/reconcile-pattern-revisions.js <styleId> [--apply]
//
// ── WHY THIS IS NOT A BACKFILL ──────────────────────────────────────────────
// It takes one style id and does nothing without it. A job that walked every
// company writing revisions nobody asked for would be the same fault as the one
// it repairs, in the other direction: this system's problem is records that
// exist without a decision behind them.
//
// ── WHAT IT REPAIRS ─────────────────────────────────────────────────────────
// A flat pattern used to enter the system only by being attached to a garment
// bundle, which parsed it, stored it and drew it — and created no pattern
// revision, because nothing connected the two. Pattern & Fit reads revisions, so
// those styles report that no pattern has been imported while the 2D viewer
// beside them draws its pieces.
//
// It re-parses nothing and re-uploads nothing: the bytes in the store are the
// bytes that were imported. It never writes to an approved publication. It is
// idempotent — a second run finds the revision the first one made.
//
// DRY RUN BY DEFAULT. Pass `--apply` to write.
"use strict";

const mongoose = require("mongoose");

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const styleId = process.argv[2];
const apply = process.argv.includes("--apply");

async function main() {
  if (!styleId || !mongoose.Types.ObjectId.isValid(styleId)) {
    console.error("Give one style id:\n"
      + "  node -r dotenv/config scripts/rnd/reconcile-pattern-revisions.js <styleId> [--apply]");
    process.exitCode = 2;
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error("MONGODB_URI is not set."); process.exitCode = 2; return; }
  await mongoose.connect(uri);

  const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
  const { GarmentModelPublication, ASSET_KIND } = require("../../models/CMS_Models/RnD/GarmentModel");
  const { PatternRevision } = require("../../models/CMS_Models/RnD/PatternRevision");
  const patterns = require("../../services/rnd/patternRevision.service");

  const style = await SampleStyle.findById(styleId).lean();
  if (!style) { console.error(`No style ${styleId}.`); process.exitCode = 1; await mongoose.disconnect(); return; }

  /* The company is read off the style's own publications rather than passed in:
     a reconciliation that could be pointed at the wrong tenant is a
     reconciliation that can write one company's pattern into another's. */
  const pubs = await GarmentModelPublication.find({ styleId: style._id }).sort({ createdAt: 1 }).lean();
  const carriers = pubs.filter((p) => (p.patternSet?.pieces || []).length > 0);
  const companies = [...new Set(carriers.map((p) => String(p.companyId)))];

  console.log(`Style      ${style.styleCode || style._id} — ${style.productName || ""}`);
  console.log(`Publications ${pubs.length}, of which ${carriers.length} carry a parsed pattern`);
  for (const p of carriers) {
    const asset = (p.assets || []).find((a) => a.kind === ASSET_KIND.PATTERN);
    console.log(`  ${p.publicationRef}  ${String(p.state).padEnd(10)} `
      + `pieces=${(p.patternSet.pieces || []).length} `
      + `file=${asset?.name || p.patternSet.fileName || "?"} `
      + `sha=${String(asset?.sha256 || p.patternSet.sha256 || "").slice(0, 12)}`);
  }
  const existing = await PatternRevision.countDocuments({ styleId: style._id });
  console.log(`Pattern revisions now: ${existing}`);

  if (!carriers.length) {
    console.log("\nNothing to recover. Import the DXF instead.");
    await mongoose.disconnect();
    return;
  }
  if (companies.length !== 1) {
    console.error(`\nRefusing: those publications span ${companies.length} companies.`);
    process.exitCode = 1;
    await mongoose.disconnect();
    return;
  }
  if (!apply) {
    console.log("\nDry run. Pass --apply to create the revision.");
    await mongoose.disconnect();
    return;
  }

  const out = await patterns.reconcileFromPublications(
    { companyId: new mongoose.Types.ObjectId(companies[0]) },
    { styleId: String(style._id), actor: { id: "script", name: "Pattern reconciliation", email: "" } },
  );
  console.log("\nReconciled:");
  for (const r of out.reconciled) {
    console.log(`  ${r.publicationRef}  →  ${r.revisionRef} (revision ${r.revisionNumber})`
      + `  ${r.created ? "created" : "already existed"}`
      + `  ${r.linked ? "bundle linked" : "approved — left untouched"}`);
  }
  console.log(`\nRevisions on this style now: ${out.revisions.length}`);
  for (const r of out.revisions) {
    console.log(`  ${r.revisionRef}  revision ${r.revisionNumber}  ${r.state}  `
      + `pieces=${r.pieceCount ?? "?"}`);
  }
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Failed:", err?.message || err);
  process.exitCode = 1;
  await mongoose.disconnect().catch(() => {});
});
