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

/* Hour and day of an instant, IN IST, as plain numbers/strings.
 *
 * Derived from the offset rather than from the process timezone, for the same
 * reason getISTMidnight above is: this backend runs on a host set to UTC, so
 * `new Date(x).getHours()` would bucket a 10am shift hour as 04:30 and the
 * "output by hour" chart would show the factory working through the night. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istHourOf = (instant) =>
  new Date(new Date(instant).getTime() + IST_OFFSET_MS).getUTCHours();
const istDayKeyOf = (instant) =>
  new Date(new Date(instant).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/* Who recorded a scan.
 *
 * scannedBy is free text supplied by the Production Record page, so it arrives
 * as "", "  ", or a real name depending on what was typed. Everything unnamed
 * collapses into ONE bucket rather than several near-identical blanks — an
 * "Unattributed" row a supervisor can see and act on is more useful than a
 * chart with four empty legend entries. */
const SUPERVISOR_UNATTRIBUTED = "Unattributed";
const supervisorNameOf = (raw) => {
  const name = String(raw || "").trim();
  return name || SUPERVISOR_UNATTRIBUTED;
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
    const { barcodes, scannedBy, scannedAt } = req.body;
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

    /* WHEN each garment was actually scanned, where the device knows.
     *
     * Every barcode in a batch used to be stamped with one `now` taken at save
     * time, so an operator who scanned forty pieces across the afternoon and
     * pressed Save at 18:00 produced forty scans dated 18:00. That is fine for
     * a daily total and wrong for anything hour-shaped — and the Overview page
     * now draws an hourly curve off this field.
     *
     * The record page's offline queue has carried a real per-scan `at` on the
     * device since it was written (components/production-supervisor/scanQueue.js);
     * it simply never left the browser. `scannedAt` is that map, barcode -> ms.
     *
     * Optional and per-barcode: an older page, or a barcode typed in by hand
     * with no queue entry, still falls back to save time. Bounds-checked
     * because this is a client-supplied timestamp — anything not inside the
     * last 30 days, or in the future, is a clock the server should not trust.
     */
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const timeFor = (barcode) => {
      const raw = scannedAt && scannedAt[barcode];
      if (!raw) return now;
      const t = new Date(raw);
      if (Number.isNaN(t.getTime())) return now;
      const age = now.getTime() - t.getTime();
      if (age < -60_000 || age > THIRTY_DAYS_MS) return now;
      return t;
    };

    if (newBarcodes.length > 0) {
      const scanEntries = newBarcodes.map((bc) => ({
        barcodeId: bc,
        scannedAt: timeFor(bc),
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

    /* Group scans by WO short id, deduplicating units — and KEEP WHO AND WHEN.
     *
     * This used to be a Set of unit numbers, which answered "how many" and
     * nothing else. The timestamp and the name of the person who recorded the
     * scan were already on every row in the database and were dropped here, one
     * line into the handler, so the page above could not show an hourly curve
     * or say who had booked the work (11 Sep 2026 request: "hour wise report,
     * graph... and also the production supervisor name and all, in order to
     * keep the record properly").
     *
     * EARLIEST scan wins where a unit somehow appears twice. A garment is
     * finished once; if a duplicate ever slips past the mark-done dedup, the
     * first sighting is the completion and the second is a mistake — counting
     * the later one would quietly move output into the wrong hour. */
    const unitsByShortId = new Map(); // shortId -> Map<unitNumber, {at, by}>
    for (const s of allScans) {
      const p = parseBarcode(s.barcodeId);
      if (!p.success) continue;
      if (!unitsByShortId.has(p.woShortId)) unitsByShortId.set(p.woShortId, new Map());
      const units = unitsByShortId.get(p.woShortId);
      const at = s.scannedAt ? new Date(s.scannedAt) : null;
      const prior = units.get(p.unitNumber);
      if (!prior || (at && prior.at && at < prior.at) || (at && !prior.at)) {
        units.set(p.unitNumber, { at, by: supervisorNameOf(s.scannedBy) });
      }
    }

    if (unitsByShortId.size === 0) {
      // Same shape as the populated response, not a shorter one. A page that
      // has to write `data.byHour ?? []` in six places eventually forgets in
      // the seventh, and an empty day is the commonest response this endpoint
      // gives — every morning before the first scan.
      return res.json({
        success: true,
        dateRange: { start, end: new Date(end.getTime() - 1) },
        totalScans: allScans.length,
        totalUnitsCompleted: 0,
        manufacturingOrders: [],
        byHour: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          label: `${String(hour).padStart(2, "0")}:00`,
          units: 0,
        })),
        byDay: [],
        bySupervisor: [],
        rows: [],
        peakHour: null,
        unitsWithoutTime: 0,
        avgUnitsPerActiveDay: 0,
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

    /* Cross-cutting breakdowns, accumulated in the SAME pass that builds the
     * MO tree so the whole range is walked once rather than three times. */
    const byHourMap = new Map();       // 0..23 -> units
    const byDayMap = new Map();        // YYYY-MM-DD -> units
    const bySupervisorMap = new Map(); // name -> {units, firstAt, lastAt, orders:Set}
    let unattributedTime = 0;          // units whose scan carried no timestamp

    for (const [shortId, unitMap] of unitsByShortId) {
      const wo = woByShortId.get(shortId);
      if (!wo) continue;

      const moId = wo.customerRequestId?.toString() || "__no_mo__";
      const sid = wo.stockItemId?.toString() || null;
      if (sid) stockItemIdsToLoad.add(sid);
      if (moId !== "__no_mo__") moIdsToLoad.add(moId);

      if (!moAgg.has(moId)) {
        moAgg.set(moId, {
          moId,
          products: new Map(),
          totalUnits: 0,
          firstAt: null,
          lastAt: null,
          supervisors: new Set(),
        });
      }

      const entry = moAgg.get(moId);
      entry.totalUnits += unitMap.size;

      // Attribution, per MO and across the whole range, from the same rows.
      for (const [, meta] of unitMap) {
        if (meta.at) {
          const hr = istHourOf(meta.at);
          byHourMap.set(hr, (byHourMap.get(hr) || 0) + 1);
          const day = istDayKeyOf(meta.at);
          byDayMap.set(day, (byDayMap.get(day) || 0) + 1);
          if (!entry.firstAt || meta.at < entry.firstAt) entry.firstAt = meta.at;
          if (!entry.lastAt || meta.at > entry.lastAt) entry.lastAt = meta.at;
        } else {
          unattributedTime++;
        }
        entry.supervisors.add(meta.by);
        if (!bySupervisorMap.has(meta.by)) {
          bySupervisorMap.set(meta.by, {
            name: meta.by,
            units: 0,
            firstAt: null,
            lastAt: null,
            orders: new Set(),
          });
        }
        const sup = bySupervisorMap.get(meta.by);
        sup.units++;
        sup.orders.add(moId);
        if (meta.at) {
          if (!sup.firstAt || meta.at < sup.firstAt) sup.firstAt = meta.at;
          if (!sup.lastAt || meta.at > sup.lastAt) sup.lastAt = meta.at;
        }
      }

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
      prodEntry.totalUnits += unitMap.size;
      for (const u of [...unitMap.keys()].sort((a, b) => a - b))
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
          // Added 11 Sep 2026 — who booked this customer's work and when.
          firstAt: entry.firstAt,
          lastAt: entry.lastAt,
          supervisors: [...entry.supervisors].sort(),
          productCount: products.length,
        };
      })
      .sort((a, b) => b.totalUnits - a.totalUnits);

    /* ── Hour of the working day ──────────────────────────────────────────
     * All 24 emitted, not just the ones with output. A chart drawn from only
     * the hours that produced something silently rescales its axis every
     * refresh, and "nothing came off the line between 13:00 and 14:00" — the
     * lunch break, or a line that stopped — is exactly the gap a supervisor is
     * looking for. A missing bar says it; an absent hour hides it. */
    const byHour = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: `${String(hour).padStart(2, "0")}:00`,
      units: byHourMap.get(hour) || 0,
    }));

    const byDay = [...byDayMap.entries()]
      .map(([date, units]) => ({ date, units }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const bySupervisor = [...bySupervisorMap.values()]
      .map((v) => ({
        name: v.name,
        units: v.units,
        orders: v.orders.size,
        firstAt: v.firstAt,
        lastAt: v.lastAt,
      }))
      .sort((a, b) => b.units - a.units);

    // Flattened per-product rows, so the page can hand a spreadsheet or a PDF
    // table straight to a file without re-walking the nested MO tree in the
    // browser and getting the totals subtly different from these ones.
    const rows = [];
    for (const mo of manufacturingOrders) {
      for (const p of mo.products) {
        rows.push({
          moNumber: mo.moNumber,
          customerName: mo.customerName,
          requestType: mo.requestType,
          product: p.name,
          reference: p.reference,
          category: p.category,
          genderCategory: p.genderCategory,
          variant: (p.variantAttributes || []).map((v) => `${v.name}: ${v.value}`).join(", "),
          units: p.totalUnits,
          supervisors: mo.supervisors.join(", "),
          firstAt: mo.firstAt,
          lastAt: mo.lastAt,
        });
      }
    }

    const totalUnitsCompleted = manufacturingOrders.reduce((s, m) => s + m.totalUnits, 0);

    return res.json({
      success: true,
      dateRange: { start, end: new Date(end.getTime() - 1) },
      totalScans: allScans.length,
      totalUnitsCompleted,
      manufacturingOrders,

      // ── Added 11 Sep 2026 ──────────────────────────────────────────────
      // Additive only: everything above is byte-for-byte what this endpoint
      // returned before, so anything already reading it is unaffected.
      byHour,
      byDay,
      bySupervisor,
      rows,
      peakHour: byHour.reduce((best, h) => (h.units > best.units ? h : best), byHour[0]),
      // Units whose scan row carried no timestamp — they count in the totals
      // but cannot appear in the hourly curve. Reported so the two never look
      // like they disagree.
      unitsWithoutTime: unattributedTime,
      // Averaged over the days that actually produced, not over the calendar
      // range: a Sunday in the range is not a bad day, it is not a day.
      avgUnitsPerActiveDay: byDay.length
        ? Math.round((totalUnitsCompleted / byDay.length) * 10) / 10
        : 0,
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