// services/manufacturing/sewingCompletion.js
//
// THE SEWING-DONE LEDGER HAS ONE WRITER, AND SINCE 15 OCT 2026 IT IS QC.
//
// `productioncompletionscanrecords` — one document per IST day, a `scans`
// array of `{barcodeId, scannedAt, scannedBy}` — is what the supervisor's
// Overview, the Orders register, the CEO production tab and the PPC ledger
// all read as "this garment is sewn". Until now it was written by the
// supervisor's own Sewing Completion page: the floor finished a piece, and
// somebody walked it past a second scanner to say so.
//
// That second scan was a duplicate of a scan QC was already making. The line
// ends at the in-line checkpoint — the FIRST QC stage — and a piece that
// passes there is, by definition, sewn. So (owner, 15 Oct 2026) the Sewing
// Completion page is gone and a pass at the first checkpoint writes this
// ledger instead:
//
//   · stages configured  → a `passed` verdict at the stage with the LOWEST
//                          serial among active stages records completion;
//                          a pass at end-line or finishing does not (the
//                          piece was already recorded when it cleared
//                          in-line, and a second row would be a duplicate the
//                          dedup below refuses anyway).
//   · no stages at all   → the factory has one QC check, so every pass is
//                          the first pass, and it records completion.
//
// A defect or reject never records: the piece goes back to the line. When it
// is re-inspected and passes, that pass records it — once.
//
// WHAT DID NOT CHANGE. The ledger's shape, its dedup rule (a barcode is
// recorded once, ever, across every day) and every validation the old page
// did (format, work order exists, unit within quantity, optional route
// check) are all here, moved out of the route so the QC path and the
// legacy `POST /mark-done` route (kept for anything still calling it) share
// one implementation instead of drifting.

const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionCompletionScanRecord = require("../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
const { displayWorkOrderNumber } = require("./workOrderNumber");
const qcStages = require("../qcStages");

/* A piece barcode is `WO-<8 or 24 hex>-<unit>`. Same pattern as the
   production-completion route: found in the text, hex lowered. */
const PIECE_RE = /WO-([0-9A-Fa-f]{8,24})-(\d{1,6})/;
const parseBarcode = (barcodeId) => {
  if (!barcodeId || typeof barcodeId !== "string") return { success: false };
  const m = PIECE_RE.exec(barcodeId.trim());
  if (!m) return { success: false };
  const unit = parseInt(m[2], 10);
  if (!Number.isFinite(unit) || unit <= 0) return { success: false };
  return { success: true, woShortId: m[1].toLowerCase(), unitNumber: unit, canonical: `WO-${m[1].toLowerCase()}-${m[2]}` };
};
const canonicalOf = (bc) => { const p = parseBarcode(bc); return p.success ? p.canonical : String(bc || "").trim(); };

/* `PRODUCTION_SCAN_REQUIRE_ROUTE=1` refuses pieces of an order with no
   operation route (see the route file's note of 13 Oct 2026). Off by default. */
const REQUIRE_ROUTE = process.env.PRODUCTION_SCAN_REQUIRE_ROUTE === "1";

const indexWorkOrdersByBarcodeIdentity = (workOrders = []) => {
  const index = new Map();
  for (const wo of workOrders) {
    const id = wo?._id?.toString();
    if (!id) continue;
    index.set(id, wo);
    index.set(id.slice(-8), wo);
  }
  return index;
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const getISTMidnight = (dateStr) => {
  const d = dateStr ? new Date(dateStr) : new Date();
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/* A client-supplied instant is trusted only inside the last 30 days and not
   in the future; anything else falls back to `now`. */
const boundedInstant = (raw, now) => {
  if (!raw) return now;
  const t = new Date(raw);
  if (Number.isNaN(t.getTime())) return now;
  const age = now.getTime() - t.getTime();
  if (age < -60_000 || age > THIRTY_DAYS_MS) return now;
  return t;
};

/**
 * Record a batch of piece barcodes as sewn.
 *
 * @param {object} args
 * @param {string[]} args.barcodes     raw barcode strings (any case, any surrounding text)
 * @param {string}   [args.scannedBy]  who recorded it (free text; the QC inspector's name)
 * @param {object|function} [args.scannedAt]  barcode → instant, or (barcode) => instant
 * @param {Date}     [args.now]
 * @returns the same buckets `/mark-done` has always returned
 */
async function recordSewingCompletion({ barcodes, scannedBy = "", scannedAt = null, now = new Date() } = {}) {
  const uniqueBarcodes = [...new Set((Array.isArray(barcodes) ? barcodes : []).map(canonicalOf).filter(Boolean))];

  const invalidBarcodes = [];
  let validBarcodes = [];
  for (const bc of uniqueBarcodes) {
    if (parseBarcode(bc).success) validBarcodes.push(bc);
    else invalidBarcodes.push(bc);
  }

  const unroutedBarcodes = [];
  const notInOrderBarcodes = [];
  const beyondQuantityBarcodes = [];

  if (validBarcodes.length) {
    const orders = await WorkOrder.find({}).select("_id workOrderNumber quantity operations").lean();
    const byShortId = indexWorkOrdersByBarcodeIdentity(orders);
    const keep = [];
    for (const bc of validBarcodes) {
      const p = parseBarcode(bc);
      const wo = byShortId.get(p.woShortId);
      if (!wo) { notInOrderBarcodes.push(bc); continue; }
      if (wo.quantity != null && p.unitNumber > wo.quantity) { beyondQuantityBarcodes.push(bc); continue; }
      if (!(wo.operations || []).length && REQUIRE_ROUTE) { unroutedBarcodes.push({ barcode: bc, workOrderNumber: displayWorkOrderNumber(wo) }); continue; }
      keep.push(bc);
    }
    validBarcodes = keep;
  }

  if (!validBarcodes.length) {
    return {
      totalScansSaved: 0, savedBarcodes: [], alreadyScannedBarcodes: [],
      invalidBarcodes, unroutedBarcodes, notInOrderBarcodes, beyondQuantityBarcodes,
    };
  }

  // Recorded once, ever: a barcode already in any day's record is skipped.
  const validSet = new Set(validBarcodes);
  const dupDocs = await ProductionCompletionScanRecord.find({ "scans.barcodeId": { $in: validBarcodes } })
    .select("scans.barcodeId").lean();
  const alreadySet = new Set();
  for (const d of dupDocs) for (const s of d.scans || []) if (validSet.has(s.barcodeId)) alreadySet.add(s.barcodeId);

  const alreadyScannedBarcodes = [...alreadySet];
  const newBarcodes = validBarcodes.filter((bc) => !alreadySet.has(bc));

  if (newBarcodes.length) {
    const timeFor = (bc) => {
      const raw = typeof scannedAt === "function" ? scannedAt(bc) : scannedAt && scannedAt[bc];
      return boundedInstant(raw, now);
    };
    /* Bucketed by the day the scan HAPPENED (in IST), not the day it was
       saved — an offline QC verdict synced the next morning belongs to the
       shift that made the piece. */
    const byDay = new Map();
    for (const bc of newBarcodes) {
      const at = timeFor(bc);
      const key = getISTMidnight(at).getTime();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ barcodeId: bc, scannedAt: at, scannedBy: scannedBy || "" });
    }
    for (const [dayMs, scanEntries] of byDay) {
      const dateBucket = new Date(dayMs);
      await ProductionCompletionScanRecord.findOneAndUpdate(
        { date: dateBucket },
        { $push: { scans: { $each: scanEntries } }, $setOnInsert: { date: dateBucket } },
        { upsert: true, new: true },
      );
    }
  }

  return {
    totalScansSaved: newBarcodes.length, savedBarcodes: newBarcodes, alreadyScannedBarcodes,
    invalidBarcodes, unroutedBarcodes, notInOrderBarcodes, beyondQuantityBarcodes,
  };
}

/**
 * Is a pass at `stage` the pass that completes sewing?
 *
 * `stage` is the stage object `qcStages.evaluateScan` returned (null when no
 * stages are configured); `stages` is the active list in line order. The
 * first checkpoint is the one with the lowest serial — the in-line check at
 * the end of the sewing line.
 */
function isCompletingStage(stage, stages = []) {
  const active = (stages || []).filter((s) => s && s.isActive !== false);
  if (!active.length) return true;              // single-check factory: every pass is the first pass
  if (!stage) return false;                     // stages exist but this verdict has none (should not happen past the guard)
  const first = active.reduce((a, b) => ((b.serial ?? Infinity) < (a.serial ?? Infinity) ? b : a));
  return String(first._id) === String(stage._id);
}

/**
 * Called after a QC `passed` verdict is written. Records sewing completion
 * when the verdict was at the first checkpoint; otherwise a no-op.
 *
 * Never throws: a failure here is logged and returned as `{ error }`, because
 * the QC verdict itself is already saved and must not be reported as failed.
 *
 * @returns {{ attempted: boolean, recorded: boolean, alreadyRecorded: boolean, skippedReason?: string, error?: string }}
 */
async function completeFromQcPass({ barcodeId, status, stage, stages, inspectorName = "", at = new Date() } = {}) {
  try {
    if (status !== "passed") return { attempted: false, recorded: false, alreadyRecorded: false, skippedReason: "not-a-pass" };
    const active = Array.isArray(stages) ? stages : await qcStages.listStages();
    if (!isCompletingStage(stage, active)) {
      return { attempted: false, recorded: false, alreadyRecorded: false, skippedReason: "not-first-stage" };
    }
    const out = await recordSewingCompletion({
      barcodes: [barcodeId],
      scannedBy: inspectorName,
      scannedAt: () => at,
    });
    const canonical = canonicalOf(barcodeId);
    const recorded = out.savedBarcodes.includes(canonical);
    const alreadyRecorded = out.alreadyScannedBarcodes.includes(canonical);
    let skippedReason;
    if (!recorded && !alreadyRecorded) {
      if (out.invalidBarcodes.length) skippedReason = "invalid-barcode";
      else if (out.notInOrderBarcodes.length) skippedReason = "no-work-order";
      else if (out.beyondQuantityBarcodes.length) skippedReason = "beyond-quantity";
      else if (out.unroutedBarcodes.length) skippedReason = "unrouted";
    }
    return { attempted: true, recorded, alreadyRecorded, ...(skippedReason ? { skippedReason } : {}) };
  } catch (err) {
    console.error("[sewingCompletion] QC pass could not be recorded as sewn:", barcodeId, err);
    return { attempted: true, recorded: false, alreadyRecorded: false, error: err.message };
  }
}

module.exports = {
  parseBarcode,
  canonicalOf,
  getISTMidnight,
  indexWorkOrdersByBarcodeIdentity,
  recordSewingCompletion,
  isCompletingStage,
  completeFromQcPass,
  REQUIRE_ROUTE,
};
