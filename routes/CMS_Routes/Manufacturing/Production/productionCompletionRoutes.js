const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const ProductionCompletionScanRecord = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");
/* Work orders carry no stored number (the model assigns one only to new
   records), so a screen printing the field raw shows a blank — which is what
   the Project Manager's production tab did. See
   services/manufacturing/workOrderNumber.js. */
const { displayWorkOrderNumber } = require("../../../../services/manufacturing/workOrderNumber");

// ── Helpers ──────────────────────────────────────────────────────────────────
const parseBarcode = (barcodeId) => {
  if (!barcodeId || typeof barcodeId !== "string") return { success: false };
  const parts = barcodeId.trim().split("-");
  if (parts.length >= 3 && parts[0] === "WO") {
    const unit = parseInt(parts[2]);
    if (!isNaN(unit) && unit > 0) {
      return { success: true, woShortId: parts[1], unitNumber: unit };
    }
  }
  return { success: false };
};

const getISTMidnight = (dateStr) => {
  const d = dateStr ? new Date(dateStr) : new Date();
  const istMs = d.getTime() + 5.5 * 60 * 60 * 1000;
  const istDate = new Date(istMs);
  istDate.setUTCHours(0, 0, 0, 0);
  return new Date(istDate.getTime() - 5.5 * 60 * 60 * 1000);
};

// ── POST /fetch-order ────────────────────────────────────────────────────────
// Look up WO + MO info for a single barcode (for preview / validation only)
router.post("/fetch-order", async (req, res) => {
  try {
    const { barcodeId } = req.body;
    if (!barcodeId) {
      return res.status(400).json({ success: false, message: "barcodeId is required" });
    }

    const parsed = parseBarcode(barcodeId);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: "Invalid barcode format" });
    }

    const allWOs = await WorkOrder.find({}).lean();
    const wo = allWOs.find((w) => w._id.toString().slice(-8) === parsed.woShortId);

    if (!wo) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    if (parsed.unitNumber > wo.quantity) {
      return res.status(400).json({
        success: false,
        message: `Unit ${parsed.unitNumber} exceeds WO quantity (${wo.quantity})`,
      });
    }

    const cr = wo.customerRequestId
      ? await CustomerRequest.findById(wo.customerRequestId).lean()
      : null;

    return res.json({
      success: true,
      barcodeId: barcodeId.trim(),
      unitNumber: parsed.unitNumber,
      workOrder: {
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        quantity: wo.quantity,
        stockItemName: wo.stockItemName,
        status: wo.status,
      },
      manufacturingOrder: cr
        ? {
          _id: cr._id,
          moNumber: `MO-${cr.requestId}`,
          customerName: cr.customerInfo?.name,
          requestType: cr.requestType,
        }
        : null,
      isMeasurement: cr?.requestType === "measurement_conversion",
    });
  } catch (err) {
    console.error("fetch-order error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── POST /mark-done ──────────────────────────────────────────────────────────
// Pure scan logging. No WO or EmployeeProductionProgress updates — those
// happen at packaging time (authoritative completion point).
// ── DRY-RUN preview — checks without saving ─────────────────────────────────
// Returns breakdown: total / valid / invalid / alreadyRecorded today / newToSave
// ── DRY-RUN preview — checks format + WO existence + today's duplicates ──────
router.post("/preview", async (req, res) => {
  try {
    const { barcodes } = req.body;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success: false, message: "barcodes array is required" });
    }
    const uniqueBarcodes = [...new Set(barcodes.map((b) => b?.trim()).filter(Boolean))];

    // ── Step 1: format check ──────────────────────────────────────────────────
    const invalidFormat   = [];
    const formatPassed    = []; // { bc, woShortId, unitNumber }
    for (const bc of uniqueBarcodes) {
      const parsed = parseBarcode(bc);
      if (!parsed.success) invalidFormat.push(bc);
      else formatPassed.push({ bc, woShortId: parsed.woShortId, unitNumber: parsed.unitNumber });
    }

    // ── Step 2: WO existence check (batch) ───────────────────────────────────
    // woShortId = last 8 chars of WO _id — fetch all WOs once and build a map
    const uniqueShortIds = [...new Set(formatPassed.map((f) => f.woShortId))];
    const allWOs = uniqueShortIds.length
      ? await WorkOrder.find({}).select("_id workOrderNumber quantity").lean()
      : [];
    const woByShortId = new Map(allWOs.map((w) => [w._id.toString().slice(-8), w]));

    const invalidOrder   = []; // valid format but WO not found or unit exceeds qty
    const invalidOrderDetails = []; // { bc, reason }
    const orderPassed    = []; // barcodes that passed both checks

    for (const { bc, woShortId, unitNumber } of formatPassed) {
      const wo = woByShortId.get(woShortId);
      if (!wo) {
        invalidOrder.push(bc);
        invalidOrderDetails.push({ bc, reason: "Work order not found" });
        continue;
      }
      if (unitNumber > wo.quantity) {
        invalidOrder.push(bc);
        invalidOrderDetails.push({ bc, reason: `Unit ${unitNumber} exceeds WO quantity (${wo.quantity})` });
        continue;
      }
      orderPassed.push(bc);
    }

    // ── Step 3: already-recorded-today check ─────────────────────────────────
    const dateBucket  = getISTMidnight(new Date());
    const todayRecord = await ProductionCompletionScanRecord.findOne({ date: dateBucket })
      .select("scans.barcodeId").lean();
    const todaySet = new Set((todayRecord?.scans || []).map((s) => s.barcodeId));

    const alreadyRecordedBarcodes = orderPassed.filter((bc) =>  todaySet.has(bc));
    const newToSaveBarcodes       = orderPassed.filter((bc) => !todaySet.has(bc));

    // Combined invalid list for the frontend
    const allInvalidBarcodes = [
      ...invalidFormat.map((bc) => ({ bc, reason: "Invalid barcode format" })),
      ...invalidOrderDetails,
    ];

    return res.json({
      success:               true,
      total:                 uniqueBarcodes.length,
      validCount:            orderPassed.length,
      invalidCount:          allInvalidBarcodes.length,
      invalidBarcodes:       allInvalidBarcodes,   // [{bc, reason}]
      invalidFormatCount:    invalidFormat.length,
      invalidOrderCount:     invalidOrder.length,
      alreadyRecordedCount:  alreadyRecordedBarcodes.length,
      alreadyRecordedBarcodes,
      newToSaveCount:        newToSaveBarcodes.length,
      newToSaveBarcodes,
    });
  } catch (err) {
    console.error("preview error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

router.post("/mark-done", async (req, res) => {
  try {
    const { barcodes, scannedBy } = req.body;
    if (!Array.isArray(barcodes) || barcodes.length === 0) {
      return res.status(400).json({ success: false, message: "barcodes array is required" });
    }

    const uniqueBarcodes = [...new Set(barcodes.map((b) => b?.trim()).filter(Boolean))];

    // Validate format and collect invalid ones for response
    const invalidBarcodes = [];
    const validBarcodes = [];
    for (const bc of uniqueBarcodes) {
      const parsed = parseBarcode(bc);
      if (!parsed.success) invalidBarcodes.push(bc);
      else validBarcodes.push(bc);
    }

    if (validBarcodes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid barcodes in request",
        invalidBarcodes,
      });
    }


    // ── Reject barcodes already recorded on any previous day/session ──
    const validSet = new Set(validBarcodes);
    const dupDocs = await ProductionCompletionScanRecord.find(
      { "scans.barcodeId": { $in: validBarcodes } }
    ).select("scans.barcodeId").lean();
    const alreadySet = new Set();
    for (const d of dupDocs)
      for (const s of d.scans || [])
        if (validSet.has(s.barcodeId)) alreadySet.add(s.barcodeId);

    const alreadyScannedBarcodes = [...alreadySet];
    const newBarcodes = validBarcodes.filter((bc) => !alreadySet.has(bc));

    const now = new Date();
    const dateBucket = getISTMidnight(now);

    if (newBarcodes.length > 0) {
      const scanEntries = newBarcodes.map((bc) => ({
        barcodeId: bc,
        scannedAt: now,
        scannedBy: scannedBy || "",
      }));
      await ProductionCompletionScanRecord.findOneAndUpdate(
        { date: dateBucket },
        { $push: { scans: { $each: scanEntries } }, $setOnInsert: { date: dateBucket } },
        { upsert: true, new: true }
      );
    }

    return res.json({
      success: true,
      message: newBarcodes.length > 0
        ? `${newBarcodes.length} scan${newBarcodes.length !== 1 ? "s" : ""} recorded${alreadyScannedBarcodes.length ? `, ${alreadyScannedBarcodes.length} skipped (already scanned earlier)` : ""}`
        : `All ${alreadyScannedBarcodes.length} barcode${alreadyScannedBarcodes.length !== 1 ? "s were" : " was"} already scanned earlier — nothing new recorded`,
      totalScansSaved: newBarcodes.length,
      alreadyScannedBarcodes,
      invalidBarcodes,
    });

  } catch (err) {
    console.error("mark-done error:", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ── GET /overview ── grouped by MO → products within each MO ─────────────────
router.get("/overview", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? getISTMidnight(startDate) : getISTMidnight(new Date());
    let end;
    if (endDate) {
      end = getISTMidnight(endDate);
      end.setDate(end.getDate() + 1);
    } else {
      end = new Date(start);
      end.setDate(end.getDate() + 1);
    }

    const docs = await ProductionCompletionScanRecord.find({
      date: { $gte: start, $lt: end },
    }).lean();

    const allScans = docs.flatMap((d) => d.scans || []);

    // Group scans by WO short id, deduplicating units
    const unitsByShortId = new Map();
    for (const s of allScans) {
      const p = parseBarcode(s.barcodeId);
      if (!p.success) continue;
      if (!unitsByShortId.has(p.woShortId)) unitsByShortId.set(p.woShortId, new Set());
      unitsByShortId.get(p.woShortId).add(p.unitNumber);
    }

    if (unitsByShortId.size === 0) {
      return res.json({
        success: true,
        dateRange: { start, end: new Date(end.getTime() - 1) },
        totalScans: allScans.length,
        totalUnitsCompleted: 0,
        manufacturingOrders: [],
      });
    }

    const allWOs = await WorkOrder.find({})
      .select("_id workOrderNumber customerRequestId stockItemId stockItemName variantAttributes")
      .lean();
    const woByShortId = new Map();
    for (const wo of allWOs) {
      woByShortId.set(wo._id.toString().slice(-8), wo);
    }

    const moAgg = new Map();
    const stockItemIdsToLoad = new Set();
    const moIdsToLoad = new Set();

    for (const [shortId, unitSet] of unitsByShortId) {
      const wo = woByShortId.get(shortId);
      if (!wo) continue;

      const moId = wo.customerRequestId?.toString() || "__no_mo__";
      const sid = wo.stockItemId?.toString() || null;
      if (sid) stockItemIdsToLoad.add(sid);
      if (moId !== "__no_mo__") moIdsToLoad.add(moId);

      if (!moAgg.has(moId)) {
        moAgg.set(moId, { moId, products: new Map(), totalUnits: 0 });
      }

      const entry = moAgg.get(moId);
      entry.totalUnits += unitSet.size;

      const variantSig = (wo.variantAttributes || [])
        .map((v) => `${v.name}:${v.value}`)
        .join("|");
      const productKey = `${sid || "_"}_${variantSig}`;

      if (!entry.products.has(productKey)) {
        entry.products.set(productKey, {
          stockItemId: sid,
          stockItemName: wo.stockItemName || "—",
          variantAttributes: wo.variantAttributes || [],
          totalUnits: 0,
          unitBarcodes: [],
        });
      }
      const prodEntry = entry.products.get(productKey);
      prodEntry.totalUnits += unitSet.size;
      for (const u of [...unitSet].sort((a, b) => a - b))
        prodEntry.unitBarcodes.push(`WO-${shortId}-${String(u).padStart(3, "0")}`);
    }

    const stockItems = await StockItem.find({
      _id: { $in: [...stockItemIdsToLoad].map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("name genderCategory category reference images variants")
      .lean();
    const stockMap = new Map(stockItems.map((si) => [si._id.toString(), si]));

    const mos = await CustomerRequest.find({
      _id: { $in: [...moIdsToLoad].map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("requestId customerInfo requestType status")
      .lean();
    const moMap = new Map(mos.map((m) => [m._id.toString(), m]));

    const manufacturingOrders = [...moAgg.values()]
      .map((entry) => {
        const mo = entry.moId !== "__no_mo__" ? moMap.get(entry.moId) : null;

        const products = [...entry.products.values()]
          .map((p) => {
            const si = p.stockItemId ? stockMap.get(p.stockItemId) : null;

            let image = null;
            if (si) {
              if (si.images && si.images.length > 0) {
                image = si.images[0];
              } else if (si.variants && si.variants.length > 0) {
                const vWithImg = si.variants.find((v) => v.images && v.images.length > 0);
                if (vWithImg) image = vWithImg.images[0];
              }
            }

            return {
              stockItemId: p.stockItemId,
              name: si?.name || p.stockItemName || "—",
              genderCategory: si?.genderCategory || "",
              category: si?.category || "",
              reference: si?.reference || "",
              image,
              variantAttributes: p.variantAttributes,
              totalUnits: p.totalUnits,
              unitBarcodes: p.unitBarcodes || [],
            };
          })
          .sort((a, b) => b.totalUnits - a.totalUnits);

        return {
          moId: entry.moId,
          moNumber: mo ? `MO-${mo.requestId}` : "Unlinked",
          customerName: mo?.customerInfo?.name || "—",
          requestType: mo?.requestType || null,
          totalUnits: entry.totalUnits,
          products,
        };
      })
      .sort((a, b) => b.totalUnits - a.totalUnits);

    return res.json({
      success: true,
      dateRange: { start, end: new Date(end.getTime() - 1) },
      totalScans: allScans.length,
      totalUnitsCompleted: manufacturingOrders.reduce((s, m) => s + m.totalUnits, 0),
      manufacturingOrders,
    });
  } catch (err) {
    console.error("overview error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /logs ────────────────────────────────────────────────────────────────
router.get("/logs", async (req, res) => {
  try {
    const { date } = req.query;
    const dateBucket = date ? getISTMidnight(date) : getISTMidnight(new Date());

    const doc = await ProductionCompletionScanRecord.findOne({ date: dateBucket }).lean();
    return res.json({
      success: true,
      date: dateBucket,
      totalScans: doc?.scans?.length || 0,
      scans: doc?.scans || [],
    });
  } catch (err) {
    console.error("logs error:", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /manufacturing-orders/:moId ── daily production performance for one MO ──
// For the Project Manager's per-MO "Production" tab: day-wise completed-unit
// trend, per-WO completion, and a scanned-by contributor breakdown, all scoped
// to just this MO's work orders (matched via the WO short-id embedded in every
// barcode, same technique /overview already uses for the global view).
router.get("/manufacturing-orders/:moId", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }
    const days = Math.min(parseInt(req.query.days, 10) || 30, 180);

    const workOrders = await WorkOrder.find({
      customerRequestId: moId,
      status: { $ne: "pending" },
    })
      .select("workOrderNumber stockItemName quantity")
      .lean();

    if (!workOrders.length) {
      return res.json({
        success: true,
        workOrders: [],
        totals: { total: 0, done: 0, pending: 0, percent: 0 },
        trend: [],
        contributors: [],
        days,
      });
    }

    const shortIdToWo = new Map(workOrders.map((wo) => [wo._id.toString().slice(-8), wo]));

    const cutoff = getISTMidnight(new Date());
    cutoff.setDate(cutoff.getDate() - (days - 1));

    const docs = await ProductionCompletionScanRecord.find({ date: { $gte: cutoff } })
      .select("date scans")
      .lean();

    const woUnits = new Map(); // workOrderId string -> Set(unit numbers)
    const contributorMap = new Map(); // scannedBy string -> count
    const trend = [];

    for (const doc of docs) {
      let dayCount = 0;
      for (const scan of doc.scans || []) {
        const parsed = parseBarcode(scan.barcodeId);
        if (!parsed.success) continue;
        const wo = shortIdToWo.get(parsed.woShortId);
        if (!wo) continue; // scan belongs to a different MO

        dayCount++;

        const woKey = wo._id.toString();
        if (!woUnits.has(woKey)) woUnits.set(woKey, new Set());
        woUnits.get(woKey).add(parsed.unitNumber);

        const who = scan.scannedBy?.trim() || "Unrecorded";
        contributorMap.set(who, (contributorMap.get(who) || 0) + 1);
      }
      if (dayCount > 0) trend.push({ date: doc.date, completedUnits: dayCount });
    }
    trend.sort((a, b) => new Date(a.date) - new Date(b.date));

    const workOrderRows = workOrders.map((wo) => {
      const units = woUnits.get(wo._id.toString()) || new Set();
      const total = wo.quantity || 0;
      const done = units.size;
      return {
        workOrderId: wo._id,
        workOrderNumber: displayWorkOrderNumber(wo),
        productName: wo.stockItemName || "—",
        total,
        done,
        pending: Math.max(0, total - done),
        percent: total ? Math.round((done / total) * 100) : 0,
      };
    });

    const contributors = [...contributorMap.entries()]
      .map(([name, scans]) => ({ name, scans }))
      .sort((a, b) => b.scans - a.scans);

    const totalUnits = workOrderRows.reduce((s, w) => s + w.total, 0);
    const totalDone = workOrderRows.reduce((s, w) => s + w.done, 0);

    res.json({
      success: true,
      workOrders: workOrderRows,
      totals: {
        total: totalUnits,
        done: totalDone,
        pending: Math.max(0, totalUnits - totalDone),
        percent: totalUnits ? Math.round((totalDone / totalUnits) * 100) : 0,
      },
      trend,
      contributors,
      days,
    });
  } catch (err) {
    console.error("[Production Completion MO overview]", err);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ── GET /ping ────────────────────────────────────────────────────────────────
// A reachability probe for the Production Record page (6 Sep 2026). That page
// keeps scans on the device while the network is away and offers "Sync" only
// once THIS server answers — `navigator.onLine` knows whether the machine has
// a network, not whether the API is reachable through it. Unauthenticated and
// tiny on purpose: it answers one question and carries nothing.
router.get("/ping", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ success: true, serverTime: new Date().toISOString() });
});

// ─── GET /orders, GET /orders/:moId ───────────────────────────────────────────
//
// THE SUPERVISOR'S BOOK OF ORDERS, MO FIRST (explicit request, 6 Sep 2026:
// "showcase order section where the mo are gonna showcase and upon click on
// any mo then the corresponding wo will gonna showcase so here the completion
// details we can get to see ki how much production completion happened...
// exactly as like happened in the qc dashboard"). Same shape as QC's
// /orders → /orders/:moId (qcRoutes.js): one card per Manufacturing Order
// (== CustomerRequest, `WorkOrder.customerRequestId` is the FK) rolling up
// every work order under it; opening one lists that MO's own work orders.
//
// What is COUNTED is different from QC's. QC counts inspection outcomes; this
// counts the production-completion scan ledger — the very same
// ProductionCompletionScanRecord the barcode scanner on this dashboard writes
// to — so a supervisor reads back exactly what has been scanned as finished,
// not a separately-tracked number. Three figures per work order, one garment
// in exactly one of the first two:
//   COMPLETED  distinct unit numbers scanned (any day, ever) within 1..quantity
//   REMAINING  ordered quantity minus completed
//   TODAY      units whose FIRST scan landed in today's IST bucket
// A unit number beyond the ordered quantity (a re-issued or over-produced work
// order) is reported separately as `extra` and never inflates the percentage.
//
// A work order with no `customerRequestId` collects under a synthetic
// "unassigned" card — the same convention /overview and QC's book already use.

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Mirrors qcRoutes.js resolveProductImage — duplicated locally, matching how
// this file already keeps its own copy of parseBarcode rather than sharing.
const resolveProductImage = (wo, siMap) => {
  if (!wo) return null;
  const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
  if (!si) return null;
  if (wo.variantAttributes?.length && si.variants?.length) {
    const match = si.variants.find((v) =>
      (v.attributes || []).length > 0 &&
      (v.attributes || []).every((va) =>
        wo.variantAttributes.some(
          (woAttr) =>
            woAttr.name?.toLowerCase() === va.name?.toLowerCase() &&
            String(woAttr.value).toLowerCase() === String(va.value).toLowerCase(),
        ),
      ),
    );
    if (match?.images?.[0]) return match.images[0];
  }
  const anyVariantImage = (si.variants || []).find((v) => v.images?.[0]);
  return si.images?.[0] || anyVariantImage?.images?.[0] || null;
};

/** Every scan ever recorded, indexed work-order short id → unit number →
 *  { at, by } of its FIRST scan. One read of the ledger per request; the
 *  ledger is one document per day, so this stays small. */
async function loadScanIndex() {
  const docs = await ProductionCompletionScanRecord.find({}).select("date scans").lean();
  const byShortId = new Map();
  for (const doc of docs) {
    for (const s of doc.scans || []) {
      const p = parseBarcode(s.barcodeId);
      if (!p.success) continue;
      if (!byShortId.has(p.woShortId)) byShortId.set(p.woShortId, new Map());
      const units = byShortId.get(p.woShortId);
      const at = s.scannedAt ? new Date(s.scannedAt) : (doc.date ? new Date(doc.date) : null);
      const prev = units.get(p.unitNumber);
      if (!prev || (at && prev.at && at < prev.at)) units.set(p.unitNumber, { at, by: s.scannedBy || "" });
    }
  }
  return byShortId;
}

const istDayKey = (d) => new Date(d.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

/** Every non-cancelled work order matching `extraQuery`, with its production
 *  figures attached. `withDetail: true` adds the photo, gender, reference and
 *  the unit-number lists — worth the StockItem batch only where a card shows
 *  them (the per-MO list), not the MO rollup. */
async function computeWorkOrderProduction(extraQuery = {}, { withDetail = false } = {}) {
  const workOrders = await WorkOrder.find({ status: { $ne: "cancelled" }, ...extraQuery })
    .select("workOrderNumber quantity stockItemName stockItemReference stockItemId variantAttributes customerName status createdAt customerRequestId assignedDeadline")
    .sort({ createdAt: -1 })
    .lean();
  if (!workOrders.length) return [];

  let siMap = new Map();
  if (withDetail) {
    const stockItemIds = [...new Set(workOrders.map((wo) => wo.stockItemId?.toString()).filter(Boolean))];
    const stockItems = stockItemIds.length
      ? await StockItem.find({ _id: { $in: stockItemIds } })
        .select("images genderCategory variants.images variants.attributes").lean()
      : [];
    siMap = new Map(stockItems.map((si) => [si._id.toString(), si]));
  }

  const index = await loadScanIndex();
  const todayStart = getISTMidnight(new Date());
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  return workOrders.map((wo) => {
    const shortId = wo._id.toString().slice(-8);
    const units = index.get(shortId) || new Map();
    const total = wo.quantity || 0;

    let completed = 0, extra = 0, today = 0, lastScanAt = null, lastScannedBy = "";
    const doneUnits = [];
    for (const [unit, meta] of units) {
      if (unit > total) { extra++; continue; }
      completed++;
      doneUnits.push(unit);
      if (meta.at && meta.at >= todayStart && meta.at < todayEnd) today++;
      if (meta.at && (!lastScanAt || meta.at > lastScanAt)) { lastScanAt = meta.at; lastScannedBy = meta.by; }
    }
    const remaining = Math.max(0, total - completed);
    const percent = total ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    const state = total > 0 && completed >= total ? "completed" : completed > 0 ? "in_progress" : "not_started";

    const row = {
      workOrderId: String(wo._id),
      workOrderNumber: displayWorkOrderNumber(wo),
      shortId,
      customerRequestId: wo.customerRequestId ? String(wo.customerRequestId) : null,
      productName: wo.stockItemName || "—",
      customerName: wo.customerName || "—",
      status: wo.status,
      assignedDeadline: wo.assignedDeadline || null,
      total,
      completed,
      remaining,
      today,
      extra,
      percent,
      state,
      lastScanAt,
    };
    if (withDetail) {
      doneUnits.sort((a, b) => a - b);
      const doneSet = new Set(doneUnits);
      const pendingUnits = [];
      for (let u = 1; u <= total; u++) if (!doneSet.has(u)) pendingUnits.push(u);
      Object.assign(row, {
        stockItemReference: wo.stockItemReference || null,
        variantAttributes: wo.variantAttributes || [],
        productImage: resolveProductImage(wo, siMap),
        genderCategory: (wo.stockItemId && siMap.get(wo.stockItemId.toString())?.genderCategory) || null,
        createdAt: wo.createdAt || null,
        lastScannedBy,
        doneUnits,
        pendingUnits,
        // Day-by-day, for this work order alone: when its units were first
        // scanned. The MO page sums these into its own trend.
        byDay: [...units.entries()]
          .filter(([unit, meta]) => unit <= total && meta.at)
          .reduce((acc, [, meta]) => {
            const key = istDayKey(meta.at);
            acc[key] = (acc[key] || 0) + 1;
            return acc;
          }, {}),
        contributors: [...units.entries()]
          .filter(([unit]) => unit <= total)
          .reduce((acc, [, meta]) => {
            const who = (meta.by || "").trim() || "Unrecorded";
            acc[who] = (acc[who] || 0) + 1;
            return acc;
          }, {}),
      });
    }
    return row;
  });
}

const ZERO_FIGURES = { total: 0, completed: 0, remaining: 0, today: 0, extra: 0 };

const moHeader = (mo, key) => ({
  manufacturingOrderId: key,
  requestId: mo?.requestId || (key === "unassigned" ? "Unassigned" : `MO-${key.slice(-6)}`),
  customerName: mo?.customerInfo?.name || "—",
  customerEmail: mo?.customerInfo?.email || null,
  requestType: mo?.requestType || null,
  measurementName: mo?.measurementName || null,
  status: mo?.status || null,
  createdAt: mo?.createdAt || null,
  // The same choice the register makes: the delivery deadline, else the estimate.
  deadline: mo?.customerInfo?.deliveryDeadline || mo?.deliveryDeadline || mo?.estimatedCompletion || null,
});

const MO_FIELDS = "requestId customerInfo requestType measurementName status createdAt deliveryDeadline estimatedCompletion";

// GET /orders — one card per Manufacturing Order, production completion rolled
// up across every work order under it.
router.get("/orders", EmployeeAuthMiddleware, async (_req, res) => {
  try {
    const perWo = await computeWorkOrderProduction();
    if (!perWo.length) return res.json({ success: true, manufacturingOrders: [] });

    const moIds = [...new Set(perWo.map((o) => o.customerRequestId).filter(Boolean))];
    const mos = await CustomerRequest.find({ _id: { $in: moIds } }).select(MO_FIELDS).lean();
    const moMap = new Map(mos.map((m) => [String(m._id), m]));

    const rollups = new Map();
    for (const o of perWo) {
      const key = o.customerRequestId || "unassigned";
      if (!rollups.has(key)) {
        rollups.set(key, {
          ...ZERO_FIGURES,
          workOrdersCount: 0, completedWorkOrders: 0, inProgressWorkOrders: 0, notStartedWorkOrders: 0,
          lastScanAt: null,
        });
      }
      const r = rollups.get(key);
      r.workOrdersCount++;
      for (const f of Object.keys(ZERO_FIGURES)) r[f] += o[f];
      if (o.state === "completed") r.completedWorkOrders++;
      else if (o.state === "in_progress") r.inProgressWorkOrders++;
      else r.notStartedWorkOrders++;
      if (o.lastScanAt && (!r.lastScanAt || o.lastScanAt > r.lastScanAt)) r.lastScanAt = o.lastScanAt;
    }

    const manufacturingOrders = [...rollups.entries()].map(([key, r]) => {
      const mo = key === "unassigned" ? null : moMap.get(key);
      return {
        ...moHeader(mo, key),
        ...r,
        percent: r.total ? Math.min(100, Math.round((r.completed / r.total) * 100)) : 0,
      };
    }).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    res.json({ success: true, manufacturingOrders });
  } catch (err) {
    console.error("[Production orders] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// GET /orders/:moId — the work orders under one Manufacturing Order, each with
// its own figures and unit lists, plus the MO's day-by-day trend and who
// scanned. `moId` is "unassigned" for the synthetic card, else a
// CustomerRequest _id.
router.get("/orders/:moId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { moId } = req.params;
    const isUnassigned = moId === "unassigned";
    if (!isUnassigned && !mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "That is not a valid order id." });
    }

    const [orders, mo] = await Promise.all([
      computeWorkOrderProduction(
        isUnassigned
          ? { $or: [{ customerRequestId: null }, { customerRequestId: { $exists: false } }] }
          : { customerRequestId: moId },
        { withDetail: true },
      ),
      isUnassigned ? null : CustomerRequest.findById(moId).select(MO_FIELDS).lean(),
    ]);

    if (!isUnassigned && !mo) {
      return res.status(404).json({ success: false, message: "That manufacturing order no longer exists." });
    }

    const totals = { ...ZERO_FIGURES, workOrdersCount: orders.length, completedWorkOrders: 0, inProgressWorkOrders: 0, notStartedWorkOrders: 0 };
    const byDay = {};
    const contributors = {};
    for (const o of orders) {
      for (const f of Object.keys(ZERO_FIGURES)) totals[f] += o[f];
      if (o.state === "completed") totals.completedWorkOrders++;
      else if (o.state === "in_progress") totals.inProgressWorkOrders++;
      else totals.notStartedWorkOrders++;
      for (const [day, n] of Object.entries(o.byDay || {})) byDay[day] = (byDay[day] || 0) + n;
      for (const [who, n] of Object.entries(o.contributors || {})) contributors[who] = (contributors[who] || 0) + n;
    }
    totals.percent = totals.total ? Math.min(100, Math.round((totals.completed / totals.total) * 100)) : 0;

    res.json({
      success: true,
      manufacturingOrder: moHeader(mo, isUnassigned ? "unassigned" : String(mo._id)),
      totals,
      orders: orders.map(({ byDay: _b, contributors: _c, ...rest }) => rest),
      trend: Object.entries(byDay).map(([date, completedUnits]) => ({ date, completedUnits }))
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
      contributors: Object.entries(contributors).map(([name, units]) => ({ name, units }))
        .sort((a, b) => b.units - a.units),
    });
  } catch (err) {
    console.error("[Production orders detail] error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});


module.exports = router;