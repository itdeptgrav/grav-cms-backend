// routes/CMS_Routes/Inventory/Operations/barcodes.js
//
// Mount in server.js:
//   const barcodeRoutes = require("./routes/CMS_Routes/Inventory/Operations/barcodes");
//   app.use("/api/cms/inventory/barcodes", barcodeRoutes);

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// GET /suggested-units/:rawItemId
//
// Returns the units to suggest for printing.
// Logic: take the raw item's registered unit, then find every Unit that has
// a CONVERSION relationship with it — in EITHER direction. We don't care
// about parent/child; if there's any conversion link, it's a suggestion.
//
// Response: {
//   success, registeredUnit, suggestedUnits: [{_id, name}], allUnits: [...]
// }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suggested-units/:rawItemId", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.rawItemId)
      .select("name unit customUnit")
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const registeredUnitName = rawItem.customUnit || rawItem.unit || "";

    // Always include all active units so the user can pick anything
    const allUnits = await Unit.find({ status: "Active" })
      .select("_id name conversions")
      .populate("conversions.toUnit", "_id name")
      .lean();

    const suggestedIds = new Set();

    // Find the registered Unit document
    const registeredUnitDoc = allUnits.find(u => u.name === registeredUnitName);

    if (registeredUnitDoc) {
      // ALWAYS suggest the registered unit itself first
      suggestedIds.add(registeredUnitDoc._id.toString());

      // 1. Forward direction: any unit registeredUnit converts TO
      (registeredUnitDoc.conversions || []).forEach(c => {
        if (c.toUnit?._id) suggestedIds.add(c.toUnit._id.toString());
      });

      // 2. Reverse direction: any unit that converts TO registeredUnit
      allUnits.forEach(u => {
        const hasReverse = (u.conversions || []).some(
          c => c.toUnit?._id?.toString() === registeredUnitDoc._id.toString()
        );
        if (hasReverse) suggestedIds.add(u._id.toString());
      });
    }

    const suggestedUnits = allUnits
      .filter(u => suggestedIds.has(u._id.toString()))
      .map(u => ({ _id: u._id, name: u.name }));

    const allUnitsList = allUnits.map(u => ({ _id: u._id, name: u.name }));

    return res.json({
      success: true,
      registeredUnit: registeredUnitName,
      suggestedUnits,
      allUnits: allUnitsList
    });
  } catch (error) {
    console.error("Error fetching suggested units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /
// Body: { rawItemId, variantId?, quantity, unitId | unitName,
//         purchaseOrderId?, purchaseOrderItemId? }
// Creates one Barcode document. The returned _id is what gets QR-encoded.
//
// Two callers, two ways of naming the unit. Product Marking picks a Unit from a
// dropdown and sends `unitId`; goods-receipt only ever knows the unit as the
// string already on the PO line, so `unitName` is accepted as well. Exactly one
// is required.
//
// When `purchaseOrderItemId` is supplied the vendor and the purchase price are
// read off the PO line here rather than taken from the request. A price is a
// financial fact about a delivery and the client has no business asserting it.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      rawItemId, variantId, quantity, unitId, unitName,
      purchaseOrderId, purchaseOrderItemId
    } = req.body;

    if (!rawItemId || !mongoose.Types.ObjectId.isValid(rawItemId)) {
      return res.status(400).json({ success: false, message: "Valid rawItemId is required" });
    }
    if (!quantity || parseFloat(quantity) <= 0) {
      return res.status(400).json({ success: false, message: "Quantity must be > 0" });
    }
    if (!unitId && !unitName) {
      return res.status(400).json({ success: false, message: "A unit is required" });
    }
    if (unitId && !mongoose.Types.ObjectId.isValid(unitId)) {
      return res.status(400).json({ success: false, message: "Valid unit is required" });
    }

    const [rawItem, unit] = await Promise.all([
      RawItem.findById(rawItemId).select("name sku variants unit customUnit").lean(),
      unitId ? Unit.findById(unitId).select("name").lean() : Promise.resolve(null)
    ]);

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });
    if (unitId && !unit) return res.status(404).json({ success: false, message: "Unit not found" });

    // A name is taken as given — the PO line it came from is the authority on
    // what unit the goods were bought in, and it may legitimately be a unit
    // that was never registered in the Unit collection.
    const resolvedUnitName = unit ? unit.name : String(unitName).trim();
    if (!resolvedUnitName) {
      return res.status(400).json({ success: false, message: "A unit is required" });
    }

    // Resolve variant info if specified
    let variantCombination = [];
    let variantSku = "";
    let resolvedVariantId = null;

    if (variantId && mongoose.Types.ObjectId.isValid(variantId)) {
      const variant = (rawItem.variants || []).find(
        v => v._id.toString() === variantId.toString()
      );
      if (!variant) {
        return res.status(404).json({ success: false, message: "Variant not found on raw item" });
      }
      resolvedVariantId = variant._id;
      variantCombination = variant.combination || [];
      variantSku = variant.sku || "";
    }

    // Optional PO, and with it the provenance of this lot.
    let resolvedPoId = null;
    let poNumber = "";
    let resolvedPoItemId = null;
    let vendorId = null;
    let vendorName = "";
    let unitPrice = null;

    if (purchaseOrderId && mongoose.Types.ObjectId.isValid(purchaseOrderId)) {
      const po = await PurchaseOrder.findById(purchaseOrderId)
        .select("poNumber vendor vendorName items")
        .populate("vendor", "companyName")
        .lean();
      if (po) {
        resolvedPoId = po._id;
        poNumber = po.poNumber || "";
        vendorId = po.vendor?._id || po.vendor || null;
        vendorName = po.vendor?.companyName || po.vendorName || "";

        // The price belongs to a line, not to the order. Match the requested
        // line when one was given; otherwise fall back to the line for this
        // raw item and variant, which is unambiguous in the ordinary case
        // where a PO lists each item once.
        const items = po.items || [];
        const line =
          (purchaseOrderItemId &&
            mongoose.Types.ObjectId.isValid(purchaseOrderItemId) &&
            items.find((i) => String(i._id) === String(purchaseOrderItemId))) ||
          items.find(
            (i) =>
              String(i.rawItem) === String(rawItem._id) &&
              String(i.variantId || "") === String(resolvedVariantId || "")
          ) ||
          null;

        if (line) {
          resolvedPoItemId = line._id;
          unitPrice = Number.isFinite(Number(line.unitPrice))
            ? Number(line.unitPrice)
            : null;
        }
      }
    }

    const barcode = await Barcode.create({
      rawItem: rawItem._id,
      rawItemName: rawItem.name,
      rawItemSku: rawItem.sku,
      variantId: resolvedVariantId,
      variantCombination,
      variantSku,
      quantity: parseFloat(quantity),
      unit: resolvedUnitName,
      purchaseOrder: resolvedPoId,
      purchaseOrderNumber: poNumber,
      purchaseOrderItemId: resolvedPoItemId,
      vendor: vendorId,
      vendorName,
      unitPrice,
      generatedBy: req.user?.id || req.user?._id || null
    });

    return res.json({ success: true, barcode });
  } catch (error) {
    console.error("Error creating barcode:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id   — lookup a single barcode (this is what a scan resolves to)
//
// Returns everything the Item Info screen shows, so a scan is one request:
// the label's own facts, the raw item and variant behind it, and the purchase
// it arrived on. Dates come from two different places on purpose — `orderDate`
// is when it was bought, the barcode's own `createdAt` is when it was received
// and labelled, and a delivery can be weeks after an order.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid barcode id" });
    }
    const barcode = await Barcode.findById(req.params.id)
      .populate("rawItem", "name sku unit customUnit category quantity minStock status variants")
      .populate("purchaseOrder", "poNumber orderDate expectedDeliveryDate status")
      .populate("vendor", "companyName contactPerson phone email gstNumber")
      .populate("generatedBy", "name email")
      .lean();

    if (!barcode) return res.status(404).json({ success: false, message: "Barcode not found" });

    // Attach the variant's own record. It lives inside the raw item's variants
    // array, so it cannot be populated — resolve it here rather than making
    // every caller re-implement the lookup.
    if (barcode.variantId && barcode.rawItem?.variants) {
      barcode.variant =
        barcode.rawItem.variants.find(
          (v) => String(v._id) === String(barcode.variantId)
        ) || null;
    } else {
      barcode.variant = null;
    }
    // The full variants array is only needed to find that one entry; sending
    // it back would be the largest thing in the response and is never read.
    if (barcode.rawItem) delete barcode.rawItem.variants;

    return res.json({ success: true, barcode });
  } catch (error) {
    console.error("Error fetching barcode:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /  — list barcodes (with optional filters)
// Query: rawItemId, variantId, purchaseOrderId, page, limit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { rawItemId, variantId, purchaseOrderId, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (rawItemId && mongoose.Types.ObjectId.isValid(rawItemId)) filter.rawItem = rawItemId;
    if (variantId && mongoose.Types.ObjectId.isValid(variantId)) filter.variantId = variantId;
    if (purchaseOrderId && mongoose.Types.ObjectId.isValid(purchaseOrderId)) filter.purchaseOrder = purchaseOrderId;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [barcodes, total] = await Promise.all([
      Barcode.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate("generatedBy", "name")
        .lean(),
      Barcode.countDocuments(filter)
    ]);

    return res.json({
      success: true,
      barcodes,
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) }
    });
  } catch (error) {
    console.error("Error listing barcodes:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;