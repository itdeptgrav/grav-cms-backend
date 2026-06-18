// routes/CMS_Routes/Inventory/Products/stockAdjustments.js
// Mount: app.use("/api/cms/inventory/stock-adjustments", stockAdjRoutes);

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const RawItem         = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem       = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Unit            = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const StockIssuance   = require("../../../../models/CMS_Models/Inventory/Operations/StockIssuance");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ── Unit conversion helpers ───────────────────────────────────────────────
async function convertViaUnitModel(qty, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit || !qty) return qty;
  try {
    const fromDoc = await Unit.findOne({ name: fromUnit }).populate("conversions.toUnit", "name").lean();
    if (fromDoc) {
      const d = (fromDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === toUnit);
      if (d?.quantity) return qty * d.quantity;
    }
    const toDoc = await Unit.findOne({ name: toUnit }).populate("conversions.toUnit", "name").lean();
    if (toDoc) {
      const r = (toDoc.conversions || []).find(c => (c.toUnit?.name || c.toUnit) === fromUnit);
      if (r?.quantity) return qty / r.quantity;
    }
    return qty;
  } catch { return qty; }
}

async function toNative(issuedQty, issuedUnit, nativeUnit, unitConversions = []) {
  if (!issuedUnit || issuedUnit === nativeUnit) return issuedQty;
  const conv = unitConversions.find(uc =>
    (uc.fromUnit === nativeUnit && uc.toUnit === issuedUnit) ||
    (uc.fromUnit === issuedUnit && uc.toUnit === nativeUnit)
  );
  if (conv?.quantity) {
    return conv.fromUnit === nativeUnit
      ? issuedQty / conv.quantity
      : issuedQty * conv.quantity;
  }
  return await convertViaUnitModel(issuedQty, issuedUnit, nativeUnit);
}

const AUTOMATIC_REASONS  = ["Purchase Order Delivery"];
const AUTOMATIC_PREFIXES = ["Issued for Work Order:"];
const isAutomatic = (tx) => {
  if (tx.purchaseOrderId || (tx.purchaseOrder || "").trim()) return true;
  const r = (tx.reason || "").trim();
  if (AUTOMATIC_REASONS.includes(r)) return true;
  return AUTOMATIC_PREFIXES.some(p => r.startsWith(p));
};

// ═════════════════════════════════════════════════════════════════════════════
// GET /raw-items  — search raw items for the drawer
// ═════════════════════════════════════════════════════════════════════════════
router.get("/raw-items", async (req, res) => {
  try {
    const { search = "", limit = 8 } = req.query;
    const filter = search
      ? { $or: [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }] }
      : {};
    const items = await RawItem.find(filter).select("name sku unit customUnit quantity variants").limit(Number(limit)).lean();
    return res.json({
      success: true,
      items: items.map(item => ({
        _id: item._id, name: item.name, sku: item.sku,
        nativeUnit: item.customUnit || item.unit || "",
        quantity: item.quantity || 0,
        variants: (item.variants || []).map(v => ({
          _id: v._id, combination: v.combination || [], quantity: v.quantity || 0,
          sku: v.sku || "", unitConversions: v.unitConversions || [],
        })),
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /manufacturing-orders  — latest MOs for the drawer dropdown
// ═════════════════════════════════════════════════════════════════════════════
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const { search = "", limit = 6 } = req.query;
    const filter = { status: { $in: ["in_progress", "approved", "planning", "production", "quotation_sales_approved"] } };
    if (search) {
      filter.$or = [
        { requestId: { $regex: search, $options: "i" } },
        { "customerInfo.name": { $regex: search, $options: "i" } },
      ];
    }
    const mos = await CustomerRequest.find(filter)
      .select("_id requestId customerInfo.name status items createdAt")
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();
    return res.json({
      success: true,
      manufacturingOrders: mos.map(mo => ({
        _id: mo._id,
        moNumber: mo.requestId || mo._id.toString().slice(-8).toUpperCase(),
        customerName: mo.customerInfo?.name || "—",
        status: mo.status || "",
        itemCount: (mo.items || []).length,
        createdAt: mo.createdAt,
      })),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /manufacturing-orders/:moId/bom-items
// Returns BOM raw materials for the MO, with already-issued quantities
// ═════════════════════════════════════════════════════════════════════════════
router.get("/manufacturing-orders/:moId/bom-items", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId))
      return res.status(400).json({ success: false, message: "Invalid MO id" });

    // 1. Fetch the CustomerRequest
    const request = await CustomerRequest.findById(moId).select("items").lean();
    if (!request) return res.status(404).json({ success: false, message: "MO not found" });

    // 2. Map stockItemId → totalQuantity ordered
    const stockItemQtyMap = {};
    for (const item of (request.items || [])) {
      if (!item.stockItemId) continue;
      const k = item.stockItemId.toString();
      stockItemQtyMap[k] = (stockItemQtyMap[k] || 0) + (item.totalQuantity || 0);
    }
    const stockItemIds = Object.keys(stockItemQtyMap);
    if (!stockItemIds.length) return res.json({ success: true, bomItems: [] });

    // 3. Fetch StockItems with their variants.rawItems
    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("name reference variants")
      .lean();

    // 4. Already-issued quantities for this MO from StockIssuance
    // 4. Fetch issuances — conversion-aware alreadyIssued is computed after enrichment
    const issuances = await StockIssuance.find({ manufacturingOrder: moId }).lean();

    // 5. Aggregate BOM: match each CR variant → StockItem variant → rawItems
    //    This avoids the bug of summing across ALL variants (N×multiplier)
    const stockItemMap2 = new Map(stockItems.map(s => [s._id.toString(), s]));

    // Match CR variant attributes to the correct StockItem variant
    const matchSiVariant = (crAttrs, siVariants) => {
      if (!crAttrs?.length) return siVariants?.[0] || null;
      return siVariants?.find(v =>
        crAttrs.every(ca => v.attributes?.some(va => va.name === ca.name && va.value === ca.value))
      ) || siVariants?.[0] || null;
    };

    const bomMap = {};
    for (const crItem of (request.items || [])) {
      const si = stockItemMap2.get(crItem.stockItemId?.toString());
      if (!si) continue;

      for (const crVariant of (crItem.variants || [])) {
        const orderedQty = crVariant.quantity || 0;
        if (!orderedQty) continue;

        // Find the specific StockItem variant matching what was ordered
        const siVariant = matchSiVariant(crVariant.attributes || [], si.variants || []);
        if (!siVariant) continue;

        for (const ri of (siVariant.rawItems || [])) {
          if (!ri.rawItemId) continue;
          const riId = ri.rawItemId.toString();
          const rvId = ri.variantId?.toString() || "none";
          const key  = `${riId}|${rvId}`;
          if (!bomMap[key]) {
            bomMap[key] = {
              rawItemId:          ri.rawItemId,
              rawItemName:        ri.rawItemName  || "",
              rawItemSku:         ri.rawItemSku   || "",
              variantId:          ri.variantId    || null,
              variantCombination: ri.variantCombination || [],
              unit:               ri.unit     || ri.baseUnit || "",
              baseUnit:           ri.baseUnit || ri.unit     || "",
              totalRequired: 0,
              alreadyIssued: 0,
              products: [],
              unitConversions: [],
            };
          }
          bomMap[key].totalRequired += (ri.quantity || 0) * orderedQty;
          if (!bomMap[key].products.includes(si.name)) bomMap[key].products.push(si.name);
        }
      }
    }

    // 6. Enrich with variant unitConversions in one batch query
    const uniqueRawItemIds = [...new Set(Object.values(bomMap).map(b => b.rawItemId?.toString()).filter(Boolean))];
    if (uniqueRawItemIds.length) {
      const rawItemDocs = await RawItem.find({ _id: { $in: uniqueRawItemIds } })
        .select("quantity variants._id variants.unitConversions variants.quantity")
        .lean();
      const convMap = {};
      for (const ri of rawItemDocs) {
        for (const v of (ri.variants || [])) {
          convMap[`${ri._id}-${v._id}`] = { unitConversions: v.unitConversions || [], currentStock: v.quantity ?? null };
        }
        convMap[`${ri._id}-`] = { unitConversions: [], currentStock: ri.quantity ?? null };
      }
      for (const key of Object.keys(bomMap)) {
        const b    = bomMap[key];
        const cKey = `${b.rawItemId}-${b.variantId || ""}`;
        const data = convMap[cKey] || {};
        b.unitConversions = data.unitConversions || [];
        b.currentStock    = data.currentStock    ?? null;
      }
    }

    // Convert nativeQty (raw item's native unit) → BOM unit before summing
    for (const iso of issuances) {
      for (const itm of (iso.items || [])) {
        const k = `${itm.rawItem?.toString()}|${itm.variantId?.toString() || "none"}`;
        if (!bomMap[k]) continue;
        const b          = bomMap[k];
        const nativeUnit = b.baseUnit || b.unit;
        const bomUnit    = b.unit;
        const nativeQty  = itm.nativeQty || 0;
        if (!nativeQty) continue;

        if (!nativeUnit || nativeUnit === bomUnit) {
          b.alreadyIssued += nativeQty;
        } else {
          const conv = (b.unitConversions || []).find(uc =>
            (uc.fromUnit === nativeUnit && uc.toUnit === bomUnit) ||
            (uc.fromUnit === bomUnit    && uc.toUnit === nativeUnit)
          );
          if (conv?.quantity) {
            // "1 fromUnit = quantity toUnit"
            b.alreadyIssued += conv.fromUnit === nativeUnit
              ? nativeQty * conv.quantity   // e.g. 0.181 Pkt × 320 = 57.92 Pcs
              : nativeQty / conv.quantity;  // reverse
          } else {
            b.alreadyIssued += nativeQty;  // no conversion found — fallback
          }
        }
      }
    }

    const bomItems = Object.values(bomMap)
      .map(b => ({ ...b, remaining: Math.max(0, b.totalRequired - b.alreadyIssued) }))
      .sort((a, b) => b.totalRequired - a.totalRequired);

    return res.json({ success: true, bomItems });
  } catch (err) {
    console.error("bom-items error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /issue  — multi-item issuance with optional MO reference
// ═════════════════════════════════════════════════════════════════════════════
router.post("/issue", async (req, res) => {
  try {
    const { direction, manufacturingOrderId, moNumber, customerName, items: incomingItems = [], reason = "", notes = "" } = req.body;
    if (!["debit", "credit"].includes(direction))
      return res.status(400).json({ success: false, message: "direction must be debit or credit" });
    if (!incomingItems.length)
      return res.status(400).json({ success: false, message: "No items provided" });

    const issuanceItems = [];
    const stockUpdates  = [];

    for (const incoming of incomingItems) {
      const { rawItemId, variantId, issuedQty, issuedUnit, notes: itemNotes = "" } = incoming;
      if (!mongoose.Types.ObjectId.isValid(rawItemId))
        return res.status(400).json({ success: false, message: `Invalid rawItemId: ${rawItemId}` });
      const qty = parseFloat(issuedQty);
      if (isNaN(qty) || qty <= 0)
        return res.status(400).json({ success: false, message: `Invalid quantity for item ${rawItemId}` });

      const rawItem = await RawItem.findById(rawItemId);
      if (!rawItem) return res.status(404).json({ success: false, message: `Raw item ${rawItemId} not found` });

      const nativeUnit = rawItem.customUnit || rawItem.unit || "";
      let variant = null;
      let unitConversions = [];
      if (variantId && mongoose.Types.ObjectId.isValid(variantId)) {
        variant = rawItem.variants.id(variantId);
        if (variant) unitConversions = variant.unitConversions || [];
      }

      const nativeQty    = await toNative(qty, issuedUnit || nativeUnit, nativeUnit, unitConversions);
      const prevTotal    = rawItem.quantity || 0;
      let variantPrevQty = null, variantNewQty = null;

      if (direction === "debit") {
        rawItem.quantity = Math.max(0, prevTotal - nativeQty);
        if (variant) { variantPrevQty = variant.quantity || 0; variantNewQty = Math.max(0, variantPrevQty - nativeQty); variant.quantity = variantNewQty; }
      } else {
        rawItem.quantity = prevTotal + nativeQty;
        if (variant) { variantPrevQty = variant.quantity || 0; variantNewQty = variantPrevQty + nativeQty; variant.quantity = variantNewQty; }
      }

      const txType = direction === "debit"
        ? (variant ? "VARIANT_REDUCE" : "REDUCE")
        : (variant ? "VARIANT_ADD"    : "ADD");

      const tx = {
        type: txType, quantity: nativeQty,
        previousQuantity: prevTotal, newQuantity: rawItem.quantity,
        reason: reason || (direction === "debit" ? "Stock Debit" : "Stock Credit"),
        notes: [itemNotes, moNumber ? `MO: ${moNumber}` : "",
          issuedUnit !== nativeUnit ? `Issued as ${qty} ${issuedUnit} → ${nativeQty.toFixed(4)} ${nativeUnit}` : ""
        ].filter(Boolean).join(" | "),
        performedBy: req.user?.id || null,
      };
      if (variant) { tx.variantId = variant._id; tx.variantCombination = variant.combination || []; }
      if (variantPrevQty !== null) { tx.variantPreviousQuantity = variantPrevQty; tx.variantNewQuantity = variantNewQty; }

      rawItem.stockTransactions.push(tx);
      await rawItem.save();

      issuanceItems.push({
        rawItem: rawItem._id, rawItemName: rawItem.name, rawItemSku: rawItem.sku,
        variantId: variant?._id || null, variantCombination: variant?.combination || [],
        issuedQty: qty, issuedUnit: issuedUnit || nativeUnit, nativeQty, nativeUnit,
        notes: itemNotes,
      });
      stockUpdates.push({
        rawItemId: rawItem._id, rawItemName: rawItem.name,
        prevQty: prevTotal, newQty: rawItem.quantity, nativeUnit,
        issuedQty: qty, issuedUnit: issuedUnit || nativeUnit, nativeQty,
      });
    }

    const issuance = await StockIssuance.create({
      direction,
      manufacturingOrder: manufacturingOrderId && mongoose.Types.ObjectId.isValid(manufacturingOrderId) ? manufacturingOrderId : null,
      moNumber:     moNumber     || "",
      customerName: customerName || "",
      items: issuanceItems, reason, notes,
      performedBy: req.user?.id || null,
    });

    return res.json({ success: true, issuance, stockUpdates });
  } catch (err) {
    console.error("issue error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /by-mo  — issuance records paginated
// ═════════════════════════════════════════════════════════════════════════════
router.get("/by-mo", async (req, res) => {
  try {
    const { page = 1, limit = 20, direction = "all", search = "" } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
    const filter   = {};
    if (direction !== "all") filter.direction = direction;
    if (search) filter.$or = [
      { moNumber:     { $regex: search, $options: "i" } },
      { customerName: { $regex: search, $options: "i" } },
      { reason:       { $regex: search, $options: "i" } },
    ];
    const total   = await StockIssuance.countDocuments(filter);
    const records = await StockIssuance.find(filter)
      .sort({ createdAt: -1 }).skip((pageNum - 1) * limitNum).limit(limitNum)
      .populate("performedBy", "name").lean();
    return res.json({ success: true, issuances: records, pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 } });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /  — all manual stock adjustments
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const { page = 1, limit = 20, type = "all", search = "", rawItemId = "" } = req.query;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit)));
    const itemFilter = {};
    if (rawItemId) itemFilter._id = rawItemId;
    if (search) itemFilter.$or = [{ name: { $regex: search, $options: "i" } }, { sku: { $regex: search, $options: "i" } }];

    const rawItems = await RawItem.find(itemFilter)
      .select("name sku unit customUnit stockTransactions variants")
      .populate("stockTransactions.performedBy", "name email")
      .lean();

    let allTx = [];
    for (const item of rawItems) {
      for (const tx of (item.stockTransactions || [])) {
        if (isAutomatic(tx)) continue;
        const isCredit = ["ADD", "VARIANT_ADD", "PURCHASE_ORDER"].includes(tx.type);
        const isDebit  = ["REDUCE", "VARIANT_REDUCE", "CONSUME"].includes(tx.type);
        if (type === "credit" && !isCredit) continue;
        if (type === "debit"  && !isDebit)  continue;
        let variantCombo = tx.variantCombination || [];
        if (!variantCombo.length && tx.variantId) {
          const v = (item.variants || []).find(x => x._id?.toString() === tx.variantId.toString());
          if (v) variantCombo = v.combination || [];
        }
        allTx.push({
          _id: tx._id, rawItemId: item._id, rawItemName: item.name, rawItemSku: item.sku,
          unit: item.customUnit || item.unit || "",
          type: tx.type, direction: isCredit ? "credit" : "debit",
          quantity: tx.quantity, previousQuantity: tx.previousQuantity, newQuantity: tx.newQuantity,
          variantId: tx.variantId, variantCombination: variantCombo,
          reason: tx.reason || "", notes: tx.notes || "",
          performedBy: tx.performedBy || null, createdAt: tx.createdAt,
        });
      }
    }

    allTx.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const totalCredits = allTx.filter(t => t.direction === "credit").length;
    const totalDebits  = allTx.filter(t => t.direction === "debit").length;
    const creditQty    = allTx.filter(t => t.direction === "credit").reduce((s, t) => s + (t.quantity || 0), 0);
    const debitQty     = allTx.filter(t => t.direction === "debit").reduce((s, t) => s + (t.quantity || 0), 0);
    const total        = allTx.length;
    return res.json({
      success: true, transactions: allTx.slice((pageNum - 1) * limitNum, pageNum * limitNum),
      pagination: { total, page: pageNum, limit: limitNum, totalPages: Math.ceil(total / limitNum) || 1 },
      stats: { totalAdjustments: total, totalCredits, totalDebits, creditQty, debitQty },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;