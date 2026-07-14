// routes/CMS_Routes/Store/storeRoutes.js
//
// All store-department APIs in one file. Mount in server.js:
//
//   const storeRoutes = require("./routes/CMS_Routes/Store/storeRoutes");
//   app.use("/api/cms/store", storeRoutes);
//
// Endpoints (all under /api/cms/store):
//   GET    /order-requests                         — list POs visible to store
//   GET    /order-requests/:id                     — get a single PO
//   GET    /order-requests/:id/work-orders         — list WOs for a PO
//   GET    /work-orders/:woId/raw-item-requirement — per-WO raw item vs stock
//   PATCH  /work-orders/:woId/approve              — single store approval
//   POST   /work-orders/approve-batch              — bulk store approval
//   PATCH  /work-orders/:woId/unapprove            — undo (in case of mistake)

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem        = require("../../../models/CMS_Models/Inventory/Products/RawItem");
const StockIssuance  = require("../../../models/CMS_Models/Inventory/Operations/StockIssuance");

router.use(EmployeeAuthMiddleware);

// ── PM approval gate (backend env only) ────────────────────────────────
const PM_APPROVAL_FOR_MRF =
  String(process.env.PM_APPROVAL_FOR_MRF || "false").toLowerCase() === "true";

// Statuses where WOs have been created and the PO becomes visible to store
const STORE_VISIBLE_STATUSES = [
  "quotation_sales_approved",
  "in_progress",
  "completed",
];

// ═══════════════════════════════════════════════════════════════════════════
// LIST POs visible to store
//   GET /api/cms/store/order-requests
//   Optional query: status=pending_verification | all_verified | all
// ═══════════════════════════════════════════════════════════════════════════
router.get("/order-requests", async (req, res) => {
  try {
    const { status } = req.query;

    const requests = await CustomerRequest.find({
      status: { $in: STORE_VISIBLE_STATUSES },
    })
      .select("requestId customerInfo status priority requestType createdAt updatedAt items pmApproved pmApprovedAt pmRejected pmRejectionNote")
      .sort({ createdAt: -1 })
      .lean();

    const requestIds = requests.map((r) => r._id);

    // ── Aggregate WO verification counts per PO ──
    const woStats = await WorkOrder.aggregate([
      { $match: { customerRequestId: { $in: requestIds } } },
      {
        $group: {
          _id: "$customerRequestId",
          totalWOs: { $sum: 1 },
          verifiedWOs: {
            $sum: { $cond: [{ $eq: ["$storeDepartmentVerified", true] }, 1, 0] },
          },
          totalQty: { $sum: "$quantity" },
        },
      },
    ]);

    const statsMap = new Map(woStats.map((s) => [s._id.toString(), s]));

    // ── Enrich + filter ──
    let enriched = requests.map((r) => {
      const s = statsMap.get(r._id.toString()) || { totalWOs: 0, verifiedWOs: 0, totalQty: 0 };
      const isFullyVerified = s.totalWOs > 0 && s.verifiedWOs === s.totalWOs;
      return {
        _id: r._id,
        requestId: r.requestId,
        customerName: r.customerInfo?.name || "—",
        organizationName: r.customerInfo?.organizationName || "",
        status: r.status,
        priority: r.priority,
        requestType: r.requestType,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        itemsCount: r.items?.length || 0,
        totalWOs: s.totalWOs,
        verifiedWOs: s.verifiedWOs,
        pendingWOs: s.totalWOs - s.verifiedWOs,
        totalQty: s.totalQty,
        verificationProgress:
          s.totalWOs > 0 ? Math.round((s.verifiedWOs / s.totalWOs) * 100) : 0,
        isFullyVerified,
        pmApproved: !!r.pmApproved,
        pmRejected: !!r.pmRejected,
        pmRejectionNote: r.pmRejectionNote || "",
      };
    });

    // Only show POs that actually have WOs
    enriched = enriched.filter((r) => r.totalWOs > 0);

    if (status === "pending_verification") {
      enriched = enriched.filter((r) => !r.isFullyVerified);
    } else if (status === "all_verified") {
      enriched = enriched.filter((r) => r.isFullyVerified);
    }

    return res.json({ success: true, requests: enriched });
  } catch (err) {
    console.error("Store list POs error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET a single PO for the detail page
//   GET /api/cms/store/order-requests/:id
// ═══════════════════════════════════════════════════════════════════════════
router.get("/order-requests/:id", async (req, res) => {
  try {
    const request = await CustomerRequest.findById(req.params.id).lean();
    if (!request) {
      return res.status(404).json({ success: false, message: "Customer request not found" });
    }
    return res.json({ success: true, request });
  } catch (err) {
    console.error("Store get PO error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LIST WOs for a PO (with gender from StockItem)
//   GET /api/cms/store/order-requests/:id/work-orders
// ═══════════════════════════════════════════════════════════════════════════
router.get("/order-requests/:id/work-orders", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrders = await WorkOrder.find({ customerRequestId: id })
      .sort({ createdAt: 1 })
      .lean();

    // ── Bulk-fetch StockItem genderCategory for all referenced stock items ──
    const stockItemIds = [
      ...new Set(workOrders.map((wo) => wo.stockItemId?.toString()).filter(Boolean)),
    ];
    const stockItems = await StockItem.find({
      _id: { $in: stockItemIds.map((id) => new mongoose.Types.ObjectId(id)) },
    })
      .select("_id genderCategory images variants._id variants.images")
      .lean();

    const stockItemMap = new Map(stockItems.map((s) => [s._id.toString(), s]));

    const enriched = workOrders.map((wo) => {
      const si = stockItemMap.get(wo.stockItemId?.toString())
      // Variant-matched image first, then any variant with image, then product-level
      const productImage = (() => {
        if (si?.variants?.length) {
          const matched = si.variants.find(v => v._id?.toString() === wo.variantId?.toString())
          if (matched?.images?.[0]) return matched.images[0]
          const anyWithImg = si.variants.find(v => v.images?.length > 0)
          if (anyWithImg?.images?.[0]) return anyWithImg.images[0]
        }
        return si?.images?.[0] || null
      })()
      return {
        ...wo,
        genderCategory: si?.genderCategory || "",
        productImage,
      }
    });

    return res.json({ success: true, workOrders: enriched });
  } catch (err) {
    console.error("Store list WOs error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PER-WO RAW ITEM REQUIREMENT vs available stock
//   GET /api/cms/store/work-orders/:woId/raw-item-requirement
//
// Reads the WO's rawMaterials[] array directly (already has quantityRequired
// computed at WO creation time), then looks up live RawItem stock to compare.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/work-orders/:woId/raw-item-requirement", async (req, res) => {
  try {
    const { woId } = req.params;

    const wo = await WorkOrder.findById(woId).lean();
    if (!wo) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    // Gender (for header display)
    let genderCategory = "";
    if (wo.stockItemId) {
      const si = await StockItem.findById(wo.stockItemId).select("genderCategory").lean();
      genderCategory = si?.genderCategory || "";
    }

    const rawMaterials = Array.isArray(wo.rawMaterials) ? wo.rawMaterials : [];

    if (rawMaterials.length === 0) {
      return res.json({
        success: true,
        workOrder: {
          _id: wo._id,
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          stockItemReference: wo.stockItemReference,
          variantAttributes: wo.variantAttributes,
          quantity: wo.quantity,
          genderCategory,
          storeDepartmentVerified: wo.storeDepartmentVerified || false,
        },
        rawItems: [],
        grand: { totalRawItems: 0, totalRequired: 0, totalAvailable: 0, shortfallCount: 0, totalCost: 0 },
      });
    }

    // Fetch RawItem docs to get live stock
    const uniqueRawItemIds = [
      ...new Set(rawMaterials.map((r) => r.rawItemId?.toString()).filter(Boolean)),
    ];
    const rawItemDocs = uniqueRawItemIds.length
      ? await RawItem.find({
          _id: { $in: uniqueRawItemIds.map((id) => new mongoose.Types.ObjectId(id)) },
        }).lean()
      : [];
    const rawItemMap = new Map(rawItemDocs.map((r) => [r._id.toString(), r]));

    // Build comparison rows
    let totalRequired = 0;
    let totalAvailable = 0;
    let shortfallCount = 0;
    let totalCost = 0;

    const rawItems = rawMaterials.map((rm) => {
      const required = rm.quantityRequired || 0;
      const rawItemIdStr = rm.rawItemId?.toString() || "";
      const variantIdStr = rm.rawItemVariantId?.toString() || "";
      const doc = rawItemMap.get(rawItemIdStr);

      let available = null;
      let minStock = 0;

      if (doc) {
        if (variantIdStr && Array.isArray(doc.variants)) {
          const v = doc.variants.find((vv) => vv._id?.toString() === variantIdStr);
          if (v) {
            available = v.quantity || 0;
            minStock = v.minStock ?? doc.minStock ?? 0;
          }
        }
        if (available === null) {
          available = doc.quantity || 0;
          minStock = doc.minStock || 0;
        }
      }

      const shortfall = available !== null ? Math.max(0, required - available) : null;

      let status = "unknown";
      if (available !== null) {
        if (available <= 0) status = "out_of_stock";
        else if (shortfall > 0) status = "shortage";
        else if (available - required <= minStock) status = "low";
        else status = "ok";
      }

      totalRequired += required;
      if (available !== null) totalAvailable += available;
      if (shortfall && shortfall > 0) shortfallCount++;
      totalCost += rm.totalCost || 0;

      return {
        rawItemId: rawItemIdStr,
        rawItemVariantId: variantIdStr || null,
        rawItemName: rm.name,
        rawItemSku: rm.sku || "",
        variantCombination: rm.rawItemVariantCombination || [],
        unit: rm.unit,
        quantityRequired: required,
        quantityAllocated: rm.quantityAllocated || 0,
        quantityIssued: rm.quantityIssued || 0,
        unitCost: rm.unitCost || 0,
        totalCost: rm.totalCost || 0,
        available,
        shortfall,
        minStock,
        status,
        allocationStatus: rm.allocationStatus || "not_allocated",
      };
    });

    // Sort: shortages first
    const statusRank = { out_of_stock: 0, shortage: 1, low: 2, ok: 3, unknown: 4 };
    rawItems.sort((a, b) => {
      const r = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (r !== 0) return r;
      return (a.rawItemName || "").localeCompare(b.rawItemName || "");
    });

    return res.json({
      success: true,
      workOrder: {
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        stockItemName: wo.stockItemName,
        stockItemReference: wo.stockItemReference,
        variantAttributes: wo.variantAttributes,
        quantity: wo.quantity,
        genderCategory,
        storeDepartmentVerified: wo.storeDepartmentVerified || false,
        storeDepartmentVerifiedAt: wo.storeDepartmentVerifiedAt || null,
      },
      rawItems,
      grand: {
        totalRawItems: rawItems.length,
        totalRequired,
        totalAvailable,
        shortfallCount,
        totalCost,
      },
    });
  } catch (err) {
    console.error("Store per-WO raw-item error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SINGLE WO STORE APPROVAL
//   PATCH /api/cms/store/work-orders/:woId/approve
//   Body (optional): { notes: "..." }
// ═══════════════════════════════════════════════════════════════════════════
router.patch("/work-orders/:woId/approve", async (req, res) => {
  try {
    const { woId } = req.params;
    const { notes } = req.body || {};

    const wo = await WorkOrder.findById(woId);
    if (!wo) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    if (wo.storeDepartmentVerified) {
      return res.json({
        success: true,
        message: "Work order is already verified by store",
        workOrder: wo,
      });
    }

    wo.storeDepartmentVerified = true;
    wo.storeDepartmentVerifiedAt = new Date();
    wo.storeDepartmentVerifiedBy = req.user?.id || null;
    if (notes) wo.storeDepartmentNotes = notes;

    await wo.save();

    return res.json({
      success: true,
      message: "Work order approved by store",
      workOrder: wo,
    });
  } catch (err) {
    console.error("Store single approve error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BULK WO STORE APPROVAL
//   POST /api/cms/store/work-orders/approve-batch
//   Body: { workOrderIds: [...], notes?: "..." }
// ═══════════════════════════════════════════════════════════════════════════
router.post("/work-orders/approve-batch", async (req, res) => {
  try {
    const { workOrderIds, notes } = req.body || {};

    if (!Array.isArray(workOrderIds) || workOrderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "workOrderIds array is required",
      });
    }

    const update = {
      $set: {
        storeDepartmentVerified: true,
        storeDepartmentVerifiedAt: new Date(),
        storeDepartmentVerifiedBy: req.user?.id || null,
      },
    };
    if (notes) update.$set.storeDepartmentNotes = notes;

    // Only approve those not already verified — avoids overwriting timestamps
    const result = await WorkOrder.updateMany(
      { _id: { $in: workOrderIds }, storeDepartmentVerified: { $ne: true } },
      update
    );

    return res.json({
      success: true,
      message: `${result.modifiedCount} work order${
        result.modifiedCount !== 1 ? "s" : ""
      } approved by store`,
      modifiedCount: result.modifiedCount,
      alreadyVerified: workOrderIds.length - result.modifiedCount,
    });
  } catch (err) {
    console.error("Store bulk approve error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// UNDO STORE APPROVAL  (in case of mistake)
//   PATCH /api/cms/store/work-orders/:woId/unapprove
// ═══════════════════════════════════════════════════════════════════════════
router.patch("/work-orders/:woId/unapprove", async (req, res) => {
  try {
    const { woId } = req.params;
    const wo = await WorkOrder.findById(woId);
    if (!wo) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    wo.storeDepartmentVerified = false;
    wo.storeDepartmentVerifiedAt = null;
    wo.storeDepartmentVerifiedBy = null;
    wo.storeDepartmentNotes = "";

    await wo.save();

    return res.json({
      success: true,
      message: "Store approval removed",
      workOrder: wo,
    });
  } catch (err) {
    console.error("Store unapprove error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});



router.get("/order-requests/:id/raw-item-requirement", async (req, res) => {
  try {
    const { id } = req.params;
 
    // ── Fetch all WOs for this PO ─────────────────────────────────────────
    const workOrders = await WorkOrder.find({ customerRequestId: id })
      .sort({ createdAt: 1 })
      .lean();
 
    if (workOrders.length === 0) {
      return res.json({
        success: true,
        perWorkOrder: [],
        totals: [],
        grand: {
          totalRawItems: 0,
          totalRequired: 0,
          totalAvailable: 0,
          shortfallCount: 0,
          totalCost: 0,
        },
      });
    }
 
    // ── Get gender categories from StockItems ─────────────────────────────
    const stockItemIds = [
      ...new Set(workOrders.map((w) => w.stockItemId?.toString()).filter(Boolean)),
    ];
    const stockItems = await StockItem.find({
      _id: { $in: stockItemIds.map((sid) => new mongoose.Types.ObjectId(sid)) },
    })
      .select("_id genderCategory")
      .lean();
    const genderMap = new Map(stockItems.map((s) => [s._id.toString(), s.genderCategory || ""]));
 
    // ── Aggregate raw materials across all WOs by (rawItemId + variantId) ──
    const totalsMap = new Map();
    const perWorkOrder = [];
 
    for (const wo of workOrders) {
      const rawMaterials = Array.isArray(wo.rawMaterials) ? wo.rawMaterials : [];
      const woRawItems = [];
 
      for (const rm of rawMaterials) {
        const rawItemIdStr = rm.rawItemId?.toString() || "";
        const variantIdStr = rm.rawItemVariantId?.toString() || "";
        const key = `${rawItemIdStr}|${variantIdStr}`;
        const required = rm.quantityRequired || 0;
        const cost = rm.totalCost || 0;
 
        // Per-WO entry
        woRawItems.push({
          rawItemId: rawItemIdStr,
          rawItemVariantId: variantIdStr || null,
          rawItemName: rm.name,
          rawItemSku: rm.sku || "",
          variantCombination: rm.rawItemVariantCombination || [],
          unit: rm.unit,
          quantityRequired: required,
          unitCost: rm.unitCost || 0,
          totalCost: cost,
        });
 
        // Global aggregation
        if (!totalsMap.has(key)) {
          totalsMap.set(key, {
            rawItemId: rawItemIdStr,
            variantId: variantIdStr || null,
            rawItemName: rm.name,
            rawItemSku: rm.sku || "",
            variantCombination: rm.rawItemVariantCombination || [],
            unit: rm.unit,
            quantityRequired: 0,
            totalCost: 0,
            unitCost: rm.unitCost || 0,
            contributingWOs: [],
          });
        }
        const totalEntry = totalsMap.get(key);
        totalEntry.quantityRequired += required;
        totalEntry.totalCost += cost;
        totalEntry.contributingWOs.push({
          workOrderId: wo._id.toString(),
          workOrderNumber: wo.workOrderNumber || wo._id.toString().slice(-8),
          productName: wo.stockItemName || "—",
          quantityNeeded: required,
        });
      }
 
      perWorkOrder.push({
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber || wo._id.toString().slice(-8),
        productName: wo.stockItemName,
        stockItemReference: wo.stockItemReference,
        variantAttributes: wo.variantAttributes || [],
        quantity: wo.quantity || 0,
        genderCategory: genderMap.get(wo.stockItemId?.toString()) || "",
        storeDepartmentVerified: wo.storeDepartmentVerified || false,
        rawItems: woRawItems,
        rawItemCount: woRawItems.length,
        totalRequiredQty: woRawItems.reduce((s, r) => s + r.quantityRequired, 0),
      });
    }
 
    // ── FALLBACK: WOs carry no rawMaterials → build BOM from StockItem variants ──
    if (totalsMap.size === 0) {
      const fullStockItems = stockItemIds.length
        ? await StockItem.find({
            _id: { $in: stockItemIds.map((sid) => new mongoose.Types.ObjectId(sid)) },
          }).select("name variants").lean()
        : [];
      const fullSiMap = new Map(fullStockItems.map((s) => [s._id.toString(), s]));

      const matchVariant = (wo, siVariants) => {
        if (!siVariants?.length) return null;
        if (wo.variantId) {
          const byId = siVariants.find((v) => v._id?.toString() === wo.variantId?.toString());
          if (byId) return byId;
        }
        if (wo.variantAttributes?.length) {
          const byAttrs = siVariants.find((v) =>
            wo.variantAttributes.every((wa) =>
              v.attributes?.some((va) => va.name === wa.name && va.value === wa.value)
            )
          );
          if (byAttrs) return byAttrs;
        }
        return siVariants[0];
      };

      for (let wIdx = 0; wIdx < workOrders.length; wIdx++) {
        const wo = workOrders[wIdx];
        const si = fullSiMap.get(wo.stockItemId?.toString());
        if (!si) continue;
        const variant = matchVariant(wo, si.variants || []);
        if (!variant) continue;
        const woQty = wo.quantity || 0;
        const woRawItems = [];

        for (const ri of (variant.rawItems || [])) {
          if (!ri.rawItemId) continue;
          const rawItemIdStr = ri.rawItemId.toString();
          const variantIdStr = ri.variantId?.toString() || "";
          const key = `${rawItemIdStr}|${variantIdStr}`;
          const required = (ri.quantity || 0) * woQty;
          const unitCost = ri.unitCost || ri.cost || 0;
          const cost = required * unitCost;

          woRawItems.push({
            rawItemId: rawItemIdStr, rawItemVariantId: variantIdStr || null,
            rawItemName: ri.rawItemName || "", rawItemSku: ri.rawItemSku || "",
            variantCombination: ri.variantCombination || [],
            unit: ri.unit || ri.baseUnit || "",
            quantityRequired: required, unitCost, totalCost: cost,
          });

          if (!totalsMap.has(key)) {
            totalsMap.set(key, {
              rawItemId: rawItemIdStr, variantId: variantIdStr || null,
              rawItemName: ri.rawItemName || "", rawItemSku: ri.rawItemSku || "",
              variantCombination: ri.variantCombination || [],
              unit: ri.unit || ri.baseUnit || "",
              quantityRequired: 0, totalCost: 0, unitCost, contributingWOs: [],
            });
          }
          const te = totalsMap.get(key);
          te.quantityRequired += required;
          te.totalCost += cost;
          te.contributingWOs.push({
            workOrderId: wo._id.toString(),
            workOrderNumber: wo.workOrderNumber || wo._id.toString().slice(-8),
            productName: wo.stockItemName || "—",
            quantityNeeded: required,
          });
        }

        perWorkOrder[wIdx].rawItems = woRawItems;
        perWorkOrder[wIdx].rawItemCount = woRawItems.length;
        perWorkOrder[wIdx].totalRequiredQty = woRawItems.reduce((s, r) => s + r.quantityRequired, 0);
      }
    }

    // ── Live stock lookup for each unique raw-item ─────────────────────────
    const uniqueRawItemIds = [
      ...new Set([...totalsMap.values()].map((t) => t.rawItemId).filter(Boolean)),
    ];
    const rawItemDocs = uniqueRawItemIds.length
      ? await RawItem.find({
          _id: { $in: uniqueRawItemIds.map((rid) => new mongoose.Types.ObjectId(rid)) },
        }).lean()
      : [];
    const rawItemMap = new Map(rawItemDocs.map((r) => [r._id.toString(), r]));
 
    // ── Build totals[] with availability comparison ─────────────────────────
    const totals = [];
    let totalRequired = 0;
    let totalAvailable = 0;
    let shortfallCount = 0;
    let totalCost = 0;
 
    for (const t of totalsMap.values()) {
      const doc = rawItemMap.get(t.rawItemId);
      let available = null;
      let minStock = 0;
 
      if (doc) {
        if (t.variantId && Array.isArray(doc.variants)) {
          const v = doc.variants.find((vv) => vv._id?.toString() === t.variantId);
          if (v) {
            available = v.quantity || 0;
            minStock = v.minStock ?? doc.minStock ?? 0;
          }
        }
        if (available === null) {
          available = doc.quantity || 0;
          minStock = doc.minStock || 0;
        }
      }
 
      const shortfall = available !== null ? Math.max(0, t.quantityRequired - available) : null;
 
      let status = "unknown";
      if (available !== null) {
        if (available <= 0) status = "out_of_stock";
        else if (shortfall > 0) status = "shortage";
        else if (available - t.quantityRequired <= minStock) status = "low";
        else status = "ok";
      }
 
      totalRequired += t.quantityRequired;
      if (available !== null) totalAvailable += available;
      if (shortfall && shortfall > 0) shortfallCount++;
      totalCost += t.totalCost;
 
      totals.push({
        ...t,
        available,
        shortfall,
        minStock,
        status,
      });
    }
 
    // Shortages first
    const statusRank = { out_of_stock: 0, shortage: 1, low: 2, ok: 3, unknown: 4 };
    totals.sort((a, b) => {
      const r = (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9);
      if (r !== 0) return r;
      return (a.rawItemName || "").localeCompare(b.rawItemName || "");
    });
 
    return res.json({
      success: true,
      perWorkOrder,
      totals,
      grand: {
        totalRawItems: totals.length,
        totalWorkOrders: workOrders.length,
        totalRequired,
        totalAvailable,
        shortfallCount,
        totalCost,
      },
    });
  } catch (err) {
    console.error("Store order-level raw-item error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ISSUANCE SUMMARY — BOM vs issued comparison for the Raw-Item Issuance tab
//   GET /api/cms/store/order-requests/:id/issuance-summary
// ═══════════════════════════════════════════════════════════════════════════
router.get("/order-requests/:id/issuance-summary", async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Aggregate BOM from all WOs
    // 1. Build BOM directly from CustomerRequest × StockItem
    //    (avoids inheriting any N×multiplier bug from WO creation)
    const request = await CustomerRequest.findById(id).select("items").lean();
    if (!request) return res.status(404).json({ success: false, message: "Order not found" });

    const siIds      = [...new Set((request.items || []).map(i => i.stockItemId?.toString()).filter(Boolean))];
    const stockItems = siIds.length
      ? await StockItem.find({ _id: { $in: siIds } }).select("name variants").lean()
      : [];
    const siMap = new Map(stockItems.map(s => [s._id.toString(), s]));

    const matchVariant = (crAttrs, siVariants) => {
      if (!crAttrs?.length) return siVariants?.[0] || null;
      return siVariants?.find(v =>
        crAttrs.every(ca => v.attributes?.some(va => va.name === ca.name && va.value === ca.value))
      ) || siVariants?.[0] || null;
    };

    const bomMap = {};
    for (const crItem of (request.items || [])) {
      const si = siMap.get(crItem.stockItemId?.toString());
      if (!si) continue;
      for (const crVariant of (crItem.variants || [])) {
        const orderedQty = crVariant.quantity || 0;
        if (!orderedQty) continue;
        const siVariant = matchVariant(crVariant.attributes || [], si.variants || []);
        if (!siVariant) continue;
        for (const ri of (siVariant.rawItems || [])) {
          if (!ri.rawItemId) continue;
          const riId = ri.rawItemId.toString();
          const rvId = ri.variantId?.toString() || "none";
          const key  = `${riId}|${rvId}`;
          if (!bomMap[key]) {
            bomMap[key] = {
              rawItemId: riId, variantId: rvId !== "none" ? rvId : null,
              rawItemName: ri.rawItemName || "", rawItemSku: ri.rawItemSku || "",
              variantCombination: ri.variantCombination || [],
              unit: ri.unit || ri.baseUnit || "",
              nativeUnit: "", unitConversions: [],
              totalRequired: 0, totalIssued: 0, issuanceHistory: [],
            };
          }
          bomMap[key].totalRequired += (ri.quantity || 0) * orderedQty;
        }
      }
    }

    if (!Object.keys(bomMap).length)
      return res.json({ success: true, items: [], summary: { totalItems: 0, notIssued: 0, partial: 0, met: 0, overIssued: 0 }, issuanceCount: 0 });

    // 2. Enrich with unitConversions + nativeUnit from RawItem docs
    const uniqueRawIds = [...new Set(Object.values(bomMap).map(b => b.rawItemId).filter(Boolean))];
    const rawDocs      = await RawItem.find({ _id: { $in: uniqueRawIds } })
      .select("unit customUnit variants._id variants.unitConversions")
      .lean();
    const rawDocMap    = new Map(rawDocs.map(r => [r._id.toString(), r]));

    for (const b of Object.values(bomMap)) {
      const doc = rawDocMap.get(b.rawItemId);
      if (!doc) continue;
      b.nativeUnit = doc.customUnit || doc.unit || "";
      if (b.variantId) {
        const v = (doc.variants || []).find(vv => vv._id?.toString() === b.variantId);
        if (v) b.unitConversions = v.unitConversions || [];
      }
    }

    // 3. Aggregate issued qty from StockIssuance (convert nativeQty → BOM unit)
    const issuances = await StockIssuance.find({ manufacturingOrder: id })
      .populate("performedBy", "name").lean();

    for (const iso of issuances) {
      for (const itm of (iso.items || [])) {
        const riId = itm.rawItem?.toString() || "";
        const rvId = itm.variantId?.toString() || "";
        const key  = `${riId}|${rvId}`;
        if (!bomMap[key]) continue;

        const b          = bomMap[key];
        const nativeUnit = b.nativeUnit || b.unit;
        const bomUnit    = b.unit;
        const nativeQty  = itm.nativeQty || 0;
        // credit = return → subtract from issued
        const signedQty  = iso.direction === "debit" ? nativeQty : -nativeQty;

        let inBomUnit;
        if (!nativeUnit || nativeUnit === bomUnit) {
          inBomUnit = signedQty;
        } else {
          const conv = (b.unitConversions || []).find(uc =>
            (uc.fromUnit === nativeUnit && uc.toUnit === bomUnit) ||
            (uc.fromUnit === bomUnit    && uc.toUnit === nativeUnit)
          );
          if (conv?.quantity) {
            inBomUnit = conv.fromUnit === nativeUnit
              ? signedQty * conv.quantity
              : signedQty / conv.quantity;
          } else {
            inBomUnit = signedQty;
          }
        }

        b.totalIssued += inBomUnit;
        b.issuanceHistory.push({
          direction: iso.direction, date: iso.createdAt,
          performedBy: iso.performedBy?.name || "System",
          reason: iso.reason || "",
          issuedQty: itm.issuedQty, issuedUnit: itm.issuedUnit,
          nativeQty: itm.nativeQty, nativeUnit: itm.nativeUnit,
          convertedBomQty: inBomUnit,
        });
      }
    }

    // 4. Build result array
    const items = Object.values(bomMap).map(b => {
      const issued = b.totalIssued;
      const diff   = b.totalRequired - issued;
      const pct    = b.totalRequired > 0 ? (issued / b.totalRequired) * 100 : (issued > 0 ? 999 : 0);

      const status = issued <= 0           ? "not_issued"
                   : diff > 0.001          ? "partial"
                   : diff < -0.001         ? "over_issued"
                   :                         "met";

      return {
        rawItemId: b.rawItemId, variantId: b.variantId,
        rawItemName: b.rawItemName, rawItemSku: b.rawItemSku,
        variantCombination: b.variantCombination,
        unit: b.unit, totalRequired: b.totalRequired,
        totalIssued: issued,
        remaining: Math.max(0, diff),
        excess:    Math.max(0, -diff),
        pct, status,
        issuanceHistory: b.issuanceHistory,
      };
    });

    const rank = { over_issued: 0, partial: 1, not_issued: 2, met: 3 };
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));

    return res.json({
      success: true, items,
      summary: {
        totalItems:  items.length,
        notIssued:   items.filter(i => i.status === "not_issued").length,
        partial:     items.filter(i => i.status === "partial").length,
        met:         items.filter(i => i.status === "met").length,
        overIssued:  items.filter(i => i.status === "over_issued").length,
      },
      issuanceCount: issuances.length,
    });
  } catch (err) {
    console.error("issuance-summary error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;