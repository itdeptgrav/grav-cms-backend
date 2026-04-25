const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const ProductionCompletionScanRecord = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionCompletionScanRecord");

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

    const now = new Date();
    const dateBucket = getISTMidnight(now);

    const scanEntries = validBarcodes.map((bc) => ({
      barcodeId: bc,
      scannedAt: now,
      scannedBy: scannedBy || "",
    }));

    await ProductionCompletionScanRecord.findOneAndUpdate(
      { date: dateBucket },
      { $push: { scans: { $each: scanEntries } }, $setOnInsert: { date: dateBucket } },
      { upsert: true, new: true }
    );

    return res.json({
      success: true,
      message: `${validBarcodes.length} scan${validBarcodes.length !== 1 ? "s" : ""} recorded`,
      totalScansSaved: validBarcodes.length,
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
        });
      }
      entry.products.get(productKey).totalUnits += unitSet.size;
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

module.exports = router;