// routes/CMS_Routes/Manufacturing/CuttingMaster/rawItemBarcodeRoutes.js
//
// Mount as:
//   const rawItemBarcodeRoutes = require("./routes/CMS_Routes/Manufacturing/CuttingMaster/rawItemBarcodeRoutes");
//   app.use("/api/cms/manufacturing/cutting-master/raw-item-barcode", rawItemBarcodeRoutes);
//
// Endpoints:
//   GET  /:barcodeId                  → lookup barcode, includes any open session
//   POST /start-cutting-session       → begin a new session (or resume open one)
//   POST /add-piece-scan              → append a piece barcode to the open session
//   POST /close-cutting-session       → close session with remaining qty,
//                                        update parent barcode.quantity

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");

router.use(EmployeeAuthMiddleware);


// ── helper: serialize a session sub-doc to a clean response shape ───────────
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


// ── helper: shape the barcode for client responses ──────────────────────────
const formatBarcode = (b) => ({
  _id: b._id,
  rawItemId:   b.rawItem || null,
  rawItemName: b.rawItemName || "—",
  rawItemSku:  b.rawItemSku  || "",
  variant: b.variantId
    ? {
        _id: b.variantId,
        combination: b.variantCombination || [],
        sku: b.variantSku || "",
      }
    : null,
  quantity: b.quantity || 0,
  unitName: b.unit || "",
  purchaseOrder: b.purchaseOrder
    ? {
        _id: b.purchaseOrder._id || b.purchaseOrder,
        poNumber: b.purchaseOrder.poNumber,
        vendorName: b.purchaseOrder.vendorName,
        status: b.purchaseOrder.status,
      }
    : null,
});


// ═════════════════════════════════════════════════════════════════════════════
// GET /:barcodeId
// ═════════════════════════════════════════════════════════════════════════════
router.get("/:barcodeId", async (req, res) => {
  try {
    const { barcodeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(barcodeId)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }

    const barcode = await Barcode.findById(barcodeId)
      .populate("purchaseOrder", "poNumber vendorName status")
      .lean();

    if (!barcode) {
      return res.status(404).json({ success: false, message: "Barcode not found" });
    }

    const openSession =
      (barcode.cuttingSessions || []).find((s) => !s.closedAt) || null;

    return res.json({
      success: true,
      barcode: formatBarcode(barcode),
      openSession: formatSession(openSession),
    });
  } catch (err) {
    console.error("raw-item-barcode lookup error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /start-cutting-session
// Body: { barcodeId }
// If an open session exists, returns it (resumed: true) instead of starting
// a new one.  Otherwise pushes a new session entry with startQty = current
// barcode.quantity and returns it.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/start-cutting-session", async (req, res) => {
  try {
    const { barcodeId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(barcodeId)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }

    const barcode = await Barcode.findById(barcodeId).populate(
      "purchaseOrder",
      "poNumber vendorName status"
    );
    if (!barcode) {
      return res.status(404).json({ success: false, message: "Barcode not found" });
    }

    // Resume open session if any
    const existingOpen = (barcode.cuttingSessions || []).find((s) => !s.closedAt);
    if (existingOpen) {
      return res.json({
        success: true,
        resumed: true,
        session: formatSession(existingOpen),
        barcode: formatBarcode(barcode.toObject()),
      });
    }

    if ((barcode.quantity || 0) <= 0) {
      return res.status(400).json({
        success: false,
        message: "No quantity remaining on this fabric roll",
      });
    }

    barcode.cuttingSessions.push({
      startQty: barcode.quantity,
      endQty: null,
      scannedPieces: [],
      startedAt: new Date(),
      closedAt: null,
    });

    await barcode.save();

    const newSession =
      barcode.cuttingSessions[barcode.cuttingSessions.length - 1];

    return res.json({
      success: true,
      resumed: false,
      session: formatSession(newSession),
      barcode: formatBarcode(barcode.toObject()),
    });
  } catch (err) {
    console.error("start-cutting-session error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /add-piece-scan
// Body: { barcodeId, sessionId, pieceBarcodeId }
// Appends pieceBarcodeId to the session's scannedPieces (de-duped).
// ═════════════════════════════════════════════════════════════════════════════
router.post("/add-piece-scan", async (req, res) => {
  try {
    const { barcodeId, sessionId, pieceBarcodeId } = req.body;

    if (!mongoose.Types.ObjectId.isValid(barcodeId)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }
    const piece = (pieceBarcodeId || "").trim();
    if (!piece) {
      return res.status(400).json({ success: false, message: "Piece barcode is empty" });
    }

    const barcode = await Barcode.findById(barcodeId);
    if (!barcode) {
      return res.status(404).json({ success: false, message: "Barcode not found" });
    }

    const session = barcode.cuttingSessions.id(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    if (session.closedAt) {
      return res.status(400).json({ success: false, message: "Session is already closed" });
    }

    let duplicate = false;
    if (session.scannedPieces.includes(piece)) {
      duplicate = true;
    } else {
      session.scannedPieces.push(piece);
      await barcode.save();
    }

    return res.json({
      success: true,
      duplicate,
      scannedCount: session.scannedPieces.length,
    });
  } catch (err) {
    console.error("add-piece-scan error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// POST /close-cutting-session
// Body: { barcodeId, sessionId, remainingQty }
// Sets endQty + closedAt on the session AND updates parent barcode.quantity
// to the remaining value so the next session picks up from there.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/close-cutting-session", async (req, res) => {
  try {
    const { barcodeId, sessionId, remainingQty } = req.body;

    if (!mongoose.Types.ObjectId.isValid(barcodeId)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }

    const remaining = parseFloat(remainingQty);
    if (isNaN(remaining) || remaining < 0) {
      return res.status(400).json({
        success: false,
        message: "Remaining quantity must be a non-negative number",
      });
    }

    const barcode = await Barcode.findById(barcodeId);
    if (!barcode) {
      return res.status(404).json({ success: false, message: "Barcode not found" });
    }

    const session = barcode.cuttingSessions.id(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, message: "Session not found" });
    }
    if (session.closedAt) {
      return res.status(400).json({ success: false, message: "Session is already closed" });
    }

    if (remaining > session.startQty) {
      return res.status(400).json({
        success: false,
        message: `Remaining (${remaining}) cannot exceed session start qty (${session.startQty})`,
      });
    }

    session.endQty = remaining;
    session.closedAt = new Date();
    barcode.quantity = remaining;

    await barcode.save();

    return res.json({
      success: true,
      session: formatSession(session),
      newQuantity: barcode.quantity,
      usedQuantity: session.startQty - remaining,
    });
  } catch (err) {
    console.error("close-cutting-session error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});


module.exports = router;