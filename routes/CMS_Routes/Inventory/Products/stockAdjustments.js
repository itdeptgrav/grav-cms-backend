// routes/CMS_Routes/Inventory/Products/stockAdjustments.js
//
// Mount in server.js:
//   const stockAdjRoutes = require("./routes/CMS_Routes/Inventory/Products/stockAdjustments");
//   app.use("/api/cms/raw-items/stock-adjustments", stockAdjRoutes);
//
// Provides a global view of all MANUAL credit/debit adjustments across all
// raw items. Excludes automatic transactions like PURCHASE_ORDER deliveries
// and Work Order CONSUMEs (those have their own audit trails).

const express = require("express");
const router = express.Router();
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// Reasons that are treated as automatic (workflow-driven). We hide these
// from the manual adjustments view so users only see informal entries.
const AUTOMATIC_REASONS = [
  "Purchase Order Delivery",
];
const AUTOMATIC_REASON_PREFIXES = [
  "Issued for Work Order:",   // WO consumption
];

const isAutomatic = (tx) => {
  if (tx.purchaseOrderId) return true;        // Always auto if linked to a PO
  if (tx.purchaseOrder && tx.purchaseOrder.trim()) return true;
  const r = (tx.reason || "").trim();
  if (AUTOMATIC_REASONS.includes(r)) return true;
  return AUTOMATIC_REASON_PREFIXES.some(p => r.startsWith(p));
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// Query: page, limit, type ("credit" | "debit" | "all"), search, rawItemId
// Returns paginated manual adjustments + summary stats.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      type = "all",
      search = "",
      rawItemId = ""
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));

    // Filter the raw items themselves first (search + specific item)
    const itemFilter = {};
    if (rawItemId) itemFilter._id = rawItemId;
    if (search) {
      itemFilter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku:  { $regex: search, $options: "i" } }
      ];
    }

    // Pull only what we need
    const rawItems = await RawItem.find(itemFilter)
      .select("name sku unit customUnit stockTransactions variants")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName")
      .lean();

    // Flatten + tag every transaction with its parent item
    let allTx = [];
    for (const item of rawItems) {
      for (const tx of (item.stockTransactions || [])) {
        if (isAutomatic(tx)) continue;

        const isCredit = ["ADD", "VARIANT_ADD", "PURCHASE_ORDER"].includes(tx.type);
        const isDebit  = ["REDUCE", "VARIANT_REDUCE", "CONSUME"].includes(tx.type);

        if (type === "credit" && !isCredit) continue;
        if (type === "debit"  && !isDebit)  continue;

        // Resolve variant combination from variantId if not stored on tx
        let variantCombo = tx.variantCombination || [];
        if ((!variantCombo || variantCombo.length === 0) && tx.variantId) {
          const v = (item.variants || []).find(
            x => x._id?.toString() === tx.variantId.toString()
          );
          if (v) variantCombo = v.combination || [];
        }

        allTx.push({
          _id: tx._id,
          rawItemId: item._id,
          rawItemName: item.name,
          rawItemSku: item.sku,
          unit: item.customUnit || item.unit || "",
          type: tx.type,
          direction: isCredit ? "credit" : "debit",
          quantity: tx.quantity,
          previousQuantity: tx.previousQuantity,
          newQuantity: tx.newQuantity,
          variantId: tx.variantId,
          variantCombination: variantCombo,
          reason: tx.reason || "",
          notes: tx.notes || "",
          supplier: tx.supplier || "",
          supplierId: tx.supplierId || null,
          unitPrice: tx.unitPrice || 0,
          invoiceNumber: tx.invoiceNumber || "",
          performedBy: tx.performedBy || null,
          createdAt: tx.createdAt
        });
      }
    }

    // Newest first
    allTx.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Stats (over the unfiltered-by-pagination set)
    const totalCredits = allTx.filter(t => t.direction === "credit").length;
    const totalDebits  = allTx.filter(t => t.direction === "debit").length;
    const creditQty    = allTx.filter(t => t.direction === "credit").reduce((s, t) => s + (t.quantity || 0), 0);
    const debitQty     = allTx.filter(t => t.direction === "debit").reduce((s, t) => s + (t.quantity || 0), 0);

    // Paginate
    const total = allTx.length;
    const start = (pageNum - 1) * limitNum;
    const paginated = allTx.slice(start, start + limitNum);

    return res.json({
      success: true,
      transactions: paginated,
      pagination: {
        total, page: pageNum, limit: limitNum,
        totalPages: Math.ceil(total / limitNum) || 1
      },
      stats: {
        totalAdjustments: total,
        totalCredits, totalDebits,
        creditQty, debitQty
      }
    });
  } catch (error) {
    console.error("Error listing stock adjustments:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;