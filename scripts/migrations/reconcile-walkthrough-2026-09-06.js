// scripts/migrations/reconcile-walkthrough-2026-09-06.js
//
// THE COSTING WALKTHROUGH'S ORPHAN SCANS, AND ONLY THOSE.
//
// ── WHAT WENT WRONG ─────────────────────────────────────────────────────────
// Work order WO-4b1902bd was created before its product had any operations.
// Six completion barcodes were scanned against it and accepted: the endpoint
// reported "6 scans saved" and the order stayed at 0/6, because a work order
// with no route has nothing for a completion scan to complete. The scan
// records are real rows describing progress that never happened.
//
// The routes now refuse this (see productionCompletionRoutes), so no more can
// be written. These six already exist, and until they are cleared the same
// barcodes cannot be re-scanned once the routing is configured — the
// duplicate check would refuse them as already recorded.
//
// ── WHAT THIS TOUCHES, AND WHAT IT REFUSES TO ───────────────────────────────
// Exactly six barcode strings, on exactly one work order, in the production
// completion scan records and nowhere else. It does not touch cutting
// progress, employee production progress, QC, any other work order, or any
// other scan — and it verifies the work order really is unrouted before
// removing anything, because if somebody has since configured the route these
// scans may be legitimate and are left alone.
//
// ── AND IT VOIDS RATHER THAN DELETES WHERE IT CAN ───────────────────────────
// A removed row cannot be asked about later. Each scan is copied into a
// `voidedScans` audit array on its own record with the reason and the date,
// and only then removed from `scans` so the barcode can be used again.
//
// Dry run by default; `--apply` is required to write.
//
//   node scripts/migrations/reconcile-walkthrough-2026-09-06.js
//   node scripts/migrations/reconcile-walkthrough-2026-09-06.js --apply

require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

/* Named literally. Nothing here is derived from a pattern that could widen. */
const WORK_ORDER_ID = "6a9d3aeb1e6ac07e4b1902bd";
const BARCODES = Object.freeze([
  "WO-4b1902bd-001", "WO-4b1902bd-002", "WO-4b1902bd-003",
  "WO-4b1902bd-004", "WO-4b1902bd-005", "WO-4b1902bd-006",
]);
const REASON = "Orphan scan: work order had no operation route, so the scan could not advance it. "
  + "Recorded during the 6 Sep 2026 costing walkthrough.";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }
  await mongoose.connect(uri);

  const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
  const ScanRecord = require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");

  /* ── 1. THE WORK ORDER MUST STILL BE UNROUTED ───────────────────────
     If somebody has configured its operations since, these scans may be
     against a real route and are not this script's business. */
  const wo = await WorkOrder.findById(WORK_ORDER_ID).select("workOrderNumber operations quantity").lean();
  if (!wo) {
    console.error(`Work order ${WORK_ORDER_ID} was not found. Nothing was changed.`);
    process.exit(1);
  }
  if ((wo.operations || []).length) {
    console.error(
      `Work order ${wo.workOrderNumber || WORK_ORDER_ID} now has ${wo.operations.length} operations. `
      + "Its scans may be legitimate. Nothing was changed.",
    );
    process.exit(1);
  }

  /* ── 2. ONLY THE SIX, AND ONLY ON THIS ORDER ────────────────────────
     Matched by exact barcode string. The short id inside each one is checked
     against the work order as well, so a barcode that happens to be listed
     but belongs elsewhere is left alone. */
  const shortId = String(WORK_ORDER_ID).slice(-8);
  const wrongOrder = BARCODES.filter((bc) => !bc.startsWith(`WO-${shortId}-`));
  if (wrongOrder.length) {
    console.error(`These barcodes do not belong to ${WORK_ORDER_ID}: ${wrongOrder.join(", ")}. Nothing was changed.`);
    process.exit(1);
  }

  const records = await ScanRecord.find({ "scans.barcodeId": { $in: [...BARCODES] } }).lean();
  const found = [];
  for (const r of records) {
    for (const s of r.scans || []) {
      if (BARCODES.includes(s.barcodeId)) {
        found.push({ recordId: String(r._id), barcodeId: s.barcodeId, scannedAt: s.scannedAt, scannedBy: s.scannedBy || "" });
      }
    }
  }

  console.log(`Work order ${wo.workOrderNumber || WORK_ORDER_ID}: ${(wo.operations || []).length} operations, quantity ${wo.quantity}.`);
  console.log(`Found ${found.length} of the ${BARCODES.length} named scans, across ${records.length} scan record(s):`);
  for (const f of found) console.log(`  ${f.barcodeId}  scanned ${f.scannedAt} by ${f.scannedBy || "—"}  (record ${f.recordId})`);
  const missing = BARCODES.filter((bc) => !found.some((f) => f.barcodeId === bc));
  if (missing.length) console.log(`Not present (nothing to do): ${missing.join(", ")}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — would void and remove ${found.length} scan(s). Re-run with --apply to write.`);
    await mongoose.disconnect();
    return;
  }

  /* ── 3. VOID, THEN REMOVE ───────────────────────────────────────────
     The audit copy is written first. A row removed with no record of having
     existed cannot be asked about later. */
  let voided = 0;
  for (const r of records) {
    const mine = (r.scans || []).filter((s) => BARCODES.includes(s.barcodeId));
    if (!mine.length) continue;
    await ScanRecord.updateOne(
      { _id: r._id },
      {
        $push: {
          voidedScans: {
            $each: mine.map((s) => ({
              barcodeId: s.barcodeId,
              scannedAt: s.scannedAt,
              scannedBy: s.scannedBy || "",
              voidedAt: new Date(),
              reason: REASON,
            })),
          },
        },
      },
    );
    await ScanRecord.updateOne(
      { _id: r._id },
      { $pull: { scans: { barcodeId: { $in: [...BARCODES] } } } },
    );
    voided += mine.length;
  }

  console.log(`\nVoided and removed ${voided} scan(s). Nothing else was touched.`);
  console.log("Cutting progress, other work orders and all other production logs are unchanged.");
  console.log(`The six barcodes can be scanned again once ${wo.workOrderNumber || "the work order"} has an operation route.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
