#!/usr/bin/env node
// scripts/migrations/order-bom-development-import-backfill.js
//
// IMPORT THE DEVELOPMENT SELECTION INTO ORDERS THAT WERE ACCEPTED BEFORE THE
// IMPORT EXISTED.
//
// Acceptance now copies the approved development revision into the order's own
// BOM draft. Orders accepted before that opened with an empty Materials &
// Trims tab reading "Nothing selected yet" and a button asking the merchandiser
// to retype a selection the company had already approved. This brings those
// orders up to the same state, using the SAME service the acceptance path
// uses — so there is one import and not a second one that can drift.
//
// ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────
//   · It never approves anything. What lands is a DRAFT, because a sample
//     selection is not a factory instruction — the whole reason the boundary
//     exists.
//   · It never touches a development revision, a development file, or a Store
//     catalogue item. The revision is read; nothing is written back.
//   · It never re-imports. The service is idempotent on the file's own stamp,
//     so an order that already has the selection is reported and skipped.
//   · It never touches an order whose family already has a draft somebody is
//     working in — the service leaves that alone, and the report says so.
//   · It never crosses a company boundary.
//
// ── DRY RUN BY DEFAULT ───────────────────────────────────────────────────────
//   node -r dotenv/config scripts/migrations/order-bom-development-import-backfill.js
//   …--company-id=<id>   scope to one company (optional)
//   …--file-id=<id>      scope to one execution file (optional)
//   …--apply             actually import, after showing the same report
"use strict";

require("dotenv/config");

const mongoose = require("mongoose");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const adoption = require("../../services/merchandising/developmentAdoption.service");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};
const APPLY = process.argv.includes("--apply");
const COMPANY_ID = arg("company-id");
const FILE_ID = arg("file-id");

/* The backfill has no person behind it. An order accepted before the import
   existed was not imported BY anybody, and naming a merchandiser who did not
   do it would be a false attribution in an audit trail. `importedBy` stays
   empty and the screen says "System, on acceptance". */
const ACTOR = null;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set.");
  await mongoose.connect(uri);
  console.log(`Connected to ${uri.replace(/\/\/[^@]*@/, "//***@")}`);
  console.log(APPLY ? "MODE: APPLY" : "MODE: DRY RUN (nothing will be written)");

  const query = {
    "developmentReference.developmentFileId": { $ne: null },
    lifecycleStatus: { $nin: ["CANCELLED"] },
  };
  if (COMPANY_ID) query.companyId = new mongoose.Types.ObjectId(COMPANY_ID);
  if (FILE_ID) query._id = new mongoose.Types.ObjectId(FILE_ID);

  const files = await ExecutionFile.find(query)
    .select("fileNumber companyId developmentReference").lean();
  console.log(`${files.length} accepted order(s) linked to a development job.`);

  const report = { imported: [], alreadyImported: [], skipped: [], refused: [] };

  for (const file of files) {
    const ctx = { companyId: file.companyId, role: { canRead: true, canWriteSelection: true } };
    const label = `${file.fileNumber} (${file.developmentReference?.developmentNumber || "—"})`;

    if (file.developmentReference?.importedRevisionNo) {
      report.alreadyImported.push(label);
      continue;
    }

    let shown;
    try {
      shown = await adoption.preview(ctx, { fileId: String(file._id) });
    } catch (e) {
      report.refused.push(`${label}: ${e.message}`);
      continue;
    }
    if (!shown.available) {
      report.refused.push(`${label}: ${shown.sentence}`);
      continue;
    }

    const plan = `${label}: ${shown.materialTrimRows.length} material(s) and trims, `
      + `${shown.packagingRows.length} packaging, from revision ${shown.bomRevisionNo}`;

    if (!APPLY) { report.imported.push(`${plan} — would import`); continue; }

    const out = await adoption.adopt(ctx, { fileId: String(file._id), actor: ACTOR });
    if (out.replayed) { report.alreadyImported.push(label); continue; }
    report.imported.push(`${plan} — imported ${out.adopted}`);
    for (const s of out.skipped || []) {
      report.skipped.push(`${label}: ${s.family}${s.rowRef ? ` row ${s.rowRef}` : ""} — ${s.reason}`);
    }
  }

  const say = (title, rows) => {
    console.log(`\n── ${title} (${rows.length}) ──`);
    for (const r of rows) console.log(`  ${r}`);
  };
  say(APPLY ? "Imported" : "Would import", report.imported);
  say("Already imported — left alone", report.alreadyImported);
  say("Left alone by the service", report.skipped);
  say("No approved development revision", report.refused);

  if (!APPLY) {
    console.log("\nDRY RUN. Nothing was written. Re-run with --apply to import.");
  }
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
