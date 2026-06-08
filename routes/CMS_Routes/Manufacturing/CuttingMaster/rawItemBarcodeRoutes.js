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


const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit    = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
 

router.use(EmployeeAuthMiddleware);



async function convertQuantity(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;
 
  try {
    // Try direct conversion: fromUnit -> toUnit
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name")
      .lean();
    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === toUnit
      );
      if (direct?.quantity) return quantity * direct.quantity;
    }
 
    // Try reverse conversion: toUnit -> fromUnit, then invert
    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name")
      .lean();
    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === fromUnit
      );
      if (reverse?.quantity) return quantity / reverse.quantity;
    }
 
    console.warn(`[convertQuantity] No conversion path "${fromUnit}" → "${toUnit}". Using raw value.`);
    return quantity;
  } catch (err) {
    console.error("[convertQuantity] error:", err.message);
    return quantity;
  }
}


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

    // Pull variant-level unit conversions so the client can offer unit choices
    let unitConversions = [];
    if (barcode.rawItem && barcode.variantId) {
      const rawItemDoc = await RawItem.findById(barcode.rawItem).select("variants").lean();
      const variant = rawItemDoc?.variants?.find(v => v._id?.toString() === barcode.variantId?.toString());
      if (variant?.unitConversions?.length) {
        unitConversions = variant.unitConversions.filter(uc => uc.toUnit);
      }
    }

    const openSession = (barcode.cuttingSessions || []).find((s) => !s.closedAt) || null;

    return res.json({
      success: true,
      barcode: { ...formatBarcode(barcode), unitConversions },
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

    // Fetch variant-level unit conversions once (used by both resume + new paths)
    let unitConversions = [];
    if (barcode.rawItem && barcode.variantId) {
      const riDoc = await RawItem.findById(barcode.rawItem).select("variants").lean();
      const vDoc = riDoc?.variants?.find(v => v._id?.toString() === barcode.variantId?.toString());
      if (vDoc?.unitConversions?.length) unitConversions = vDoc.unitConversions.filter(uc => uc.toUnit);
    }

    // Resume open session if any
    const existingOpen = (barcode.cuttingSessions || []).find((s) => !s.closedAt);
    if (existingOpen) {
      return res.json({
        success: true,
        resumed: true,
        session: formatSession(existingOpen),
        barcode: { ...formatBarcode(barcode.toObject()), unitConversions },
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
      barcode: { ...formatBarcode(barcode.toObject()), unitConversions },
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


router.post("/close-cutting-session", async (req, res) => {
  try {
    const { barcodeId, sessionId, remainingQty, remainingUnit } = req.body;
 
    if (!mongoose.Types.ObjectId.isValid(barcodeId)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }
    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return res.status(400).json({ success: false, message: "Invalid session id" });
    }
 
    const rawRemaining = parseFloat(remainingQty);
    if (isNaN(rawRemaining) || rawRemaining < 0) {
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

    // Convert remainingQty to barcode's native unit if a different unit was submitted
    const inputUnit = (remainingUnit || "").trim();
    let remaining = rawRemaining;
    if (inputUnit && barcode.unit && inputUnit !== barcode.unit) {
      let converted = false;

      // Variant-level unitConversions checked FIRST — takes priority over global Unit model
      if (barcode.rawItem && barcode.variantId) {
        const rawItemForConv = await RawItem.findById(barcode.rawItem).select("variants").lean();
        const vForConv = rawItemForConv?.variants?.find(
          v => v._id?.toString() === barcode.variantId?.toString()
        );
        const vc = (vForConv?.unitConversions || []).find(uc =>
          (uc.fromUnit === inputUnit && uc.toUnit === barcode.unit) ||
          (uc.toUnit   === inputUnit && uc.fromUnit === barcode.unit)
        );
        if (vc?.quantity) {
          // fromUnit === inputUnit  →  1 inputUnit = quantity barcodeUnit  →  multiply
          // toUnit   === inputUnit  →  1 barcodeUnit = quantity inputUnit  →  divide
          remaining  = vc.fromUnit === inputUnit
            ? rawRemaining * vc.quantity
            : rawRemaining / vc.quantity;
          converted = true;
        }
      }

      // Only hit the global Unit model if the variant had no matching conversion
      if (!converted) {
        remaining = await convertQuantity(rawRemaining, inputUnit, barcode.unit);
      }
    }

    if (remaining > session.startQty) {
      return res.status(400).json({
        success: false,
        message: `Remaining (${remaining.toFixed(4)} ${barcode.unit}) cannot exceed session start qty (${session.startQty} ${barcode.unit})`,
      });
    }
 
    // ── Used quantity in the BARCODE's unit ──
    const usedQuantityInBarcodeUnit = session.startQty - remaining;
 
    // ─────────────────────────────────────────────────────────────────────
    // RawItem stock deduction
    // ─────────────────────────────────────────────────────────────────────
    let stockTxn = null;       // for response payload
    let deductionWarning = null;
 
    if (usedQuantityInBarcodeUnit > 0 && barcode.rawItem) {
      const rawItem = await RawItem.findById(barcode.rawItem);
 
      if (!rawItem) {
        deductionWarning = "Raw item not found — barcode closed but stock not deducted";
        console.warn(`[close-cutting-session] RawItem ${barcode.rawItem} not found for barcode ${barcode._id}`);
      } else {
        const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
        const barcodeUnit = barcode.unit;
 
        // Convert used qty from barcode's unit → raw item's registered unit
        let deductionQty = usedQuantityInBarcodeUnit;
        if (barcodeUnit && rawItemRegisteredUnit && barcodeUnit !== rawItemRegisteredUnit) {
          deductionQty = await convertQuantity(usedQuantityInBarcodeUnit, barcodeUnit, rawItemRegisteredUnit);
        }
 
        // ── Locate matched variant (if barcode has one) ──
        let matchedVariant = null;
        if (barcode.variantId && rawItem.variants?.length) {
          matchedVariant = rawItem.variants.id(barcode.variantId);
        }
        if (!matchedVariant && barcode.variantCombination?.length > 0 && rawItem.variants?.length) {
          matchedVariant = rawItem.variants.find(v =>
            v.combination?.length === barcode.variantCombination.length &&
            v.combination.every((val, idx) => val === barcode.variantCombination[idx])
          );
        }
 
        // ── Snapshot before deduction (for transaction log) ──
        const previousTotalQty = rawItem.quantity || 0;
        let variantPreviousQty = null;
        let variantNewQty = null;
        let transactionType = "CONSUME";
        let variantInfo = "";
 
        if (matchedVariant) {
          variantPreviousQty = matchedVariant.quantity || 0;
          variantNewQty = Math.max(0, variantPreviousQty - deductionQty);
          matchedVariant.quantity = variantNewQty;
 
          transactionType = "VARIANT_REDUCE";
          variantInfo = barcode.variantCombination?.length > 0
            ? barcode.variantCombination.join(" • ")
            : `Variant ID: ${barcode.variantId?.toString().slice(-6)}`;
        } else if (barcode.variantId || barcode.variantCombination?.length > 0) {
          // Barcode says it had a variant but we couldn't find it on the rawItem
          variantInfo = "Variant not found on raw item — deducted from total stock";
          console.warn(`[close-cutting-session] Variant not matched for barcode ${barcode._id}; deducting from top-level qty only`);
        }
 
        // Deduct from top-level RawItem.quantity too (mirrors planning behavior)
        const newTotalQty = Math.max(0, previousTotalQty - deductionQty);
        rawItem.quantity = newTotalQty;
 
        // ── Stock transaction log ──
        const conversionNote = barcodeUnit !== rawItemRegisteredUnit
          ? `, Deducted: ${deductionQty} ${rawItemRegisteredUnit} (from ${usedQuantityInBarcodeUnit} ${barcodeUnit})`
          : "";
 
        const transactionData = {
          type: transactionType,
          quantity: deductionQty,
          previousQuantity: previousTotalQty,
          newQuantity: newTotalQty,
          reason: `Cutting session closed (barcode ${barcode._id.toString().slice(-8)})`,
          notes:
            `Cutting session ${session._id.toString().slice(-8)} closed by cutting master. ` +
            `Pieces scanned: ${session.scannedPieces?.length || 0}` +
            `${conversionNote}` +
            `${variantInfo ? `, ${variantInfo}` : ""}`,
          performedBy: req.user?.id || null,
        };
 
        if (barcode.variantId) {
          transactionData.variantId = barcode.variantId;
        }
        if (barcode.variantCombination?.length > 0) {
          transactionData.variantCombination = barcode.variantCombination;
        }
        if (variantPreviousQty !== null) {
          transactionData.variantPreviousQuantity = variantPreviousQty;
          transactionData.variantNewQuantity = variantNewQty;
        }
 
        rawItem.stockTransactions.push(transactionData);
        await rawItem.save();
 
        stockTxn = {
          rawItemId: rawItem._id,
          rawItemName: rawItem.name,
          variantId: barcode.variantId || null,
          variantCombination: barcode.variantCombination || [],
          usedInBarcodeUnit: usedQuantityInBarcodeUnit,
          barcodeUnit,
          deductedInRegisteredUnit: deductionQty,
          registeredUnit: rawItemRegisteredUnit,
          previousTotalQty,
          newTotalQty,
          variantPreviousQty,
          variantNewQty,
          transactionType,
        };
      }
    }
 
    // ─────────────────────────────────────────────────────────────────────
    // Close the session + update barcode quantity
    // ─────────────────────────────────────────────────────────────────────
    session.endQty = remaining;
    session.closedAt = new Date();
    barcode.quantity = remaining;
    await barcode.save();
 
    return res.json({
      success: true,
      session: formatSession(session),
      newQuantity: barcode.quantity,
      usedQuantity: usedQuantityInBarcodeUnit,
      stockTransaction: stockTxn,
      ...(deductionWarning ? { warning: deductionWarning } : {}),
    });
  } catch (err) {
    console.error("close-cutting-session error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});



module.exports = router;