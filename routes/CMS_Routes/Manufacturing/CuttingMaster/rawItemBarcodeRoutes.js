// routes/CMS_Routes/Manufacturing/CuttingMaster/rawItemBarcodeRoutes.js

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Barcode  = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem  = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit     = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");

router.use(EmployeeAuthMiddleware);

// ── Unit conversion helper ────────────────────────────────────────────────
async function convertQuantity(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === toUnit);
      if (direct?.quantity) return quantity * direct.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === fromUnit);
      if (reverse?.quantity) return quantity / reverse.quantity;
    }
    console.warn(`[convertQuantity] No conversion path "${fromUnit}" → "${toUnit}". Using raw value.`);
    return quantity;
  } catch (err) {
    console.error("[convertQuantity] error:", err.message);
    return quantity;
  }
}

// ── Response shape helpers ────────────────────────────────────────────────
const formatSession = (s) => {
  if (!s) return null;
  return {
    _id: s._id,
    startQty: s.startQty,
    endQty: s.endQty,
    scannedPieces: s.scannedPieces || [],
    scannedCount: (s.scannedPieces || []).length,
    startedAt: s.startedAt,
    closedAt: s.closedAt,
    isOpen: !s.closedAt,
  };
};

const formatBarcode = (b) => ({
  _id: b._id,
  rawItemId:   b.rawItem || null,
  rawItemName: b.rawItemName || "—",
  rawItemSku:  b.rawItemSku  || "",
  variant: b.variantId
    ? { _id: b.variantId, combination: b.variantCombination || [], sku: b.variantSku || "" }
    : null,
  quantity:      b.quantity || 0,
  unitName:      b.unit || "",
  purchaseOrder: b.purchaseOrder
    ? { _id: b.purchaseOrder._id || b.purchaseOrder, poNumber: b.purchaseOrder.poNumber, vendorName: b.purchaseOrder.vendorName, status: b.purchaseOrder.status }
    : null,
});

// ═════════════════════════════════════════════════════════════════════════
// GET /:barcodeId
// ═════════════════════════════════════════════════════════════════════════
router.get("/:barcodeId", async (req, res) => {
  try {
    const { barcodeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(barcodeId))
      return res.status(400).json({ success: false, message: "Invalid barcode id" });

    const barcode = await Barcode.findById(barcodeId).populate("purchaseOrder", "poNumber vendorName status").lean();
    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });

    let unitConversions = [];
    if (barcode.rawItem && barcode.variantId) {
      const riDoc   = await RawItem.findById(barcode.rawItem).select("variants").lean();
      const variant = riDoc?.variants?.find(v => v._id?.toString() === barcode.variantId?.toString());
      if (variant?.unitConversions?.length) unitConversions = variant.unitConversions.filter(uc => uc.toUnit);
    }

    const openSession = (barcode.cuttingSessions || []).find(s => !s.closedAt) || null;
    return res.json({ success: true, barcode: { ...formatBarcode(barcode), unitConversions }, openSession: formatSession(openSession) });
  } catch (err) {
    console.error("raw-item-barcode lookup error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /start-cutting-session
// ═════════════════════════════════════════════════════════════════════════
router.post("/start-cutting-session", async (req, res) => {
  try {
    const { barcodeId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(barcodeId))
      return res.status(400).json({ success: false, message: "Invalid barcode id" });

    const barcode = await Barcode.findById(barcodeId).populate("purchaseOrder", "poNumber vendorName status");
    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });

    let unitConversions = [];
    if (barcode.rawItem && barcode.variantId) {
      const riDoc = await RawItem.findById(barcode.rawItem).select("variants").lean();
      const vDoc  = riDoc?.variants?.find(v => v._id?.toString() === barcode.variantId?.toString());
      if (vDoc?.unitConversions?.length) unitConversions = vDoc.unitConversions.filter(uc => uc.toUnit);
    }

    const existingOpen = (barcode.cuttingSessions || []).find(s => !s.closedAt);
    if (existingOpen) {
      return res.json({ success: true, resumed: true, session: formatSession(existingOpen), barcode: { ...formatBarcode(barcode.toObject()), unitConversions } });
    }

    if ((barcode.quantity || 0) <= 0)
      return res.status(400).json({ success: false, message: "No quantity remaining on this fabric roll" });

    barcode.cuttingSessions.push({ startQty: barcode.quantity, endQty: null, scannedPieces: [], startedAt: new Date(), closedAt: null });
    await barcode.save();

    const newSession = barcode.cuttingSessions[barcode.cuttingSessions.length - 1];
    return res.json({ success: true, resumed: false, session: formatSession(newSession), barcode: { ...formatBarcode(barcode.toObject()), unitConversions } });
  } catch (err) {
    console.error("start-cutting-session error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /add-piece-scan
// ═════════════════════════════════════════════════════════════════════════
router.post("/add-piece-scan", async (req, res) => {
  try {
    const { barcodeId, sessionId, pieceBarcodeId } = req.body;
    if (!mongoose.Types.ObjectId.isValid(barcodeId)) return res.status(400).json({ success: false, message: "Invalid barcode id" });
    if (!mongoose.Types.ObjectId.isValid(sessionId)) return res.status(400).json({ success: false, message: "Invalid session id" });
    const piece = (pieceBarcodeId || "").trim();
    if (!piece) return res.status(400).json({ success: false, message: "Piece barcode is empty" });

    const barcode = await Barcode.findById(barcodeId);
    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });
    const session = barcode.cuttingSessions.id(sessionId);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    if (session.closedAt) return res.status(400).json({ success: false, message: "Session is already closed" });

    let duplicate = false;
    if (session.scannedPieces.includes(piece)) {
      duplicate = true;
    } else {
      session.scannedPieces.push(piece);
      await barcode.save();
    }
    return res.json({ success: true, duplicate, scannedCount: session.scannedPieces.length });
  } catch (err) {
    console.error("add-piece-scan error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════
// POST /close-cutting-session
//
// Changes vs original:
//  1. Accepts optional `scannedPieces` array — batch-adds them to the
//     session so the frontend never needs to call add-piece-scan in a loop.
//  2. Does NOT deduct from RawItem stock — only updates barcode.quantity.
// ═════════════════════════════════════════════════════════════════════════
router.post("/close-cutting-session", async (req, res) => {
  try {
    const { barcodeId, sessionId, remainingQty, remainingUnit, scannedPieces: incomingPieces } = req.body;

    if (!mongoose.Types.ObjectId.isValid(barcodeId))
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    if (!mongoose.Types.ObjectId.isValid(sessionId))
      return res.status(400).json({ success: false, message: "Invalid session id" });

    const rawRemaining = parseFloat(remainingQty);
    if (isNaN(rawRemaining) || rawRemaining < 0)
      return res.status(400).json({ success: false, message: "Remaining quantity must be a non-negative number" });

    const barcode = await Barcode.findById(barcodeId);
    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });

    const session = barcode.cuttingSessions.id(sessionId);
    if (!session) return res.status(404).json({ success: false, message: "Session not found" });
    if (session.closedAt) return res.status(400).json({ success: false, message: "Session is already closed" });

    // ── Batch-add scanned pieces (de-duped) ──────────────────────────────
    if (Array.isArray(incomingPieces) && incomingPieces.length > 0) {
      const existing = new Set(session.scannedPieces);
      for (const piece of incomingPieces) {
        const p = (piece || "").trim();
        if (p && !existing.has(p)) { session.scannedPieces.push(p); existing.add(p); }
      }
    }

    // ── Convert remainingQty to barcode's native unit if needed ──────────
    const inputUnit = (remainingUnit || "").trim();
    let remaining = rawRemaining;

    if (inputUnit && barcode.unit && inputUnit !== barcode.unit) {
      let converted = false;

      if (barcode.rawItem && barcode.variantId) {
        const riDoc = await RawItem.findById(barcode.rawItem).select("variants").lean();
        const vDoc  = riDoc?.variants?.find(v => v._id?.toString() === barcode.variantId?.toString());
        const vc    = (vDoc?.unitConversions || []).find(uc =>
          (uc.fromUnit === inputUnit && uc.toUnit === barcode.unit) ||
          (uc.toUnit   === inputUnit && uc.fromUnit === barcode.unit)
        );
        if (vc?.quantity) {
          remaining = vc.fromUnit === inputUnit ? rawRemaining * vc.quantity : rawRemaining / vc.quantity;
          converted = true;
        }
      }
      if (!converted) {
        remaining = await convertQuantity(rawRemaining, inputUnit, barcode.unit);
      }
    }

    

    const usedQuantity = session.startQty - remaining;

    // ── Close session + update barcode qty only (no RawItem deduction) ───
    session.endQty   = remaining;
    session.closedAt = new Date();
    barcode.quantity = remaining;          // update barcode qty only
    await barcode.save();

    return res.json({
      success: true,
      session:      formatSession(session),
      newQuantity:  barcode.quantity,
      usedQuantity,
    });
  } catch (err) {
    console.error("close-cutting-session error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;