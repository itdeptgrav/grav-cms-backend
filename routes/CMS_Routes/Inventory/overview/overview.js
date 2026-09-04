// routes/CMS_Routes/Inventory/overview.js
// REPLACE the entire existing file with this

const express = require("express");
const router  = express.Router();
const RawItem  = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor   = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const MRF      = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const RawItemAddRequest = require("../../../../models/CMS_Models/Inventory/Operations/RawItemAddRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const valuation = require("../valuation/inventoryValuationRoutes");

router.use(EmployeeAuthMiddleware);

router.get("/", async (req, res) => {
  try {
    /* The inventory value comes from the ONE valuation engine, not a second
       "quantity × last price" formula. Scoped best-effort to the caller's
       company so the overview and the Inventory-valuation report agree; if a
       company cannot be resolved (a multi-company caller with no selection),
       the figure falls back to the legacy unscoped set rather than 500-ing a
       dashboard. */
    let valuationScope = {};
    try {
      const ctx = await tenantContext.resolveForActor(req.user, {
        requestedCompanyId:
          req.headers["x-store-purchase-company"] || req.query.actingCompanyId,
      });
      if (ctx && ctx.companyId) valuationScope = tenantContext.tenantFilter(ctx);
    } catch {
      valuationScope = {};
    }
    const valuationResult = await valuation
      .summarizeCompany(valuationScope)
      .catch(() => null);
    const inventoryValuation = valuationResult ? valuationResult.summary : null;
    /* Top items by KNOWN value, from the same engine (no separate formula). */
    const topByKnownValue = valuationResult
      ? [...valuationResult.valued]
          .filter((v) => (v.knownValue || 0) > 0)
          .sort((a, b) => (b.knownValue || 0) - (a.knownValue || 0))
          .slice(0, 5)
          .map((v) => ({
            name: v.name,
            quantity: v.replayedOnHand,
            unit: v.unit,
            unitPrice: v.avgCost,
            stockValue: v.knownValue,
            status: v.status,
          }))
      : [];
    const now        = new Date();
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setDate(now.getDate() - 7);
    const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
    const todayEnd   = new Date(now); todayEnd.setHours(23,59,59,999);
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setDate(now.getDate() - 30);

    const [
      rawItemsAgg,
      stockItemsAgg,
      purchaseOrdersAgg,
      activeVendorsCount,
      recentRawItems,
      recentPurchaseOrders,
      criticalRawItems,
      criticalStockItems,
      topVendorsByPO,
      // ── NEW: today's stock-out transactions ──
      todayStockOuts,
      // ── NEW: today's stock-in transactions ──
      todayStockIns,
      // ── NEW: top used raw items from MRF (last 30 days) ──
      topUsedItems,
      // ── NEW: MRF summary stats ──
      mrfStats,
      // ── NEW: product registration request stats ──
      productRequestStats,
    ] = await Promise.all([

      // ── Raw Items aggregation (status counts + quantities only) ─────────────
      RawItem.aggregate([
        {
          $group: {
            _id: null,
            total:        { $sum: 1 },
            inStock:      { $sum: { $cond: [{ $eq: ["$status", "In Stock"]      }, 1, 0] } },
            lowStock:     { $sum: { $cond: [{ $eq: ["$status", "Low Stock"]     }, 1, 0] } },
            outOfStock:   { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"]  }, 1, 0] } },
            totalQuantity:{ $sum: { $ifNull: ["$quantity", 0] } },
          },
        },
      ]),

      // ── Stock Items aggregation ──────────────────────────────────────────────
      StockItem.aggregate([
        {
          $group: {
            _id: null,
            total:        { $sum: 1 },
            inStock:      { $sum: { $cond: [{ $eq: ["$status", "In Stock"]      }, 1, 0] } },
            lowStock:     { $sum: { $cond: [{ $eq: ["$status", "Low Stock"]     }, 1, 0] } },
            outOfStock:   { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"]  }, 1, 0] } },
            totalQuantity:{ $sum: { $ifNull: ["$quantityOnHand", 0] } },
            totalValue:   { $sum: { $ifNull: ["$inventoryValue",  0] } },
          },
        },
      ]),

      // ── Purchase Orders aggregation ──────────────────────────────────────────
      PurchaseOrder.aggregate([
        {
          $group: {
            _id: null,
            total:             { $sum: 1 },
            draft:             { $sum: { $cond: [{ $eq: ["$status", "DRAFT"]             }, 1, 0] } },
            issued:            { $sum: { $cond: [{ $eq: ["$status", "ISSUED"]            }, 1, 0] } },
            partiallyReceived: { $sum: { $cond: [{ $eq: ["$status", "PARTIALLY_RECEIVED"]}, 1, 0] } },
            completed:         { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"]         }, 1, 0] } },
            cancelled:         { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"]         }, 1, 0] } },
            totalValue:  { $sum: { $ifNull: ["$totalAmount", 0] } },
            pendingValue:{
              $sum: {
                $cond: [
                  { $not: { $in: ["$status", ["COMPLETED","CANCELLED"]] } },
                  { $ifNull: ["$totalAmount", 0] },
                  0,
                ],
              },
            },
            totalReceived:{ $sum: { $ifNull: ["$totalReceived", 0] } },
            totalPending: { $sum: { $ifNull: ["$totalPending",  0] } },
          },
        },
      ]),

      // ── Active vendor count ──────────────────────────────────────────────────
      Vendor.countDocuments({ status: "Active" }),

      // ── Recent raw items ─────────────────────────────────────────────────────
      RawItem.find({ createdAt: { $gte: sevenDaysAgo } })
        .select("name sku quantity status createdAt")
        .sort({ createdAt: -1 }).limit(5).lean(),

      // ── Recent POs ───────────────────────────────────────────────────────────
      PurchaseOrder.find({ createdAt: { $gte: sevenDaysAgo } })
        .select("poNumber vendorName totalAmount status createdAt vendor")
        .populate("vendor", "companyName")
        .sort({ createdAt: -1 }).limit(5).lean(),

      // ── Critical raw items ───────────────────────────────────────────────────
      RawItem.find({ $expr: { $lte: ["$quantity", "$minStock"] } })
        .select("name sku quantity minStock status").sort({ quantity: 1 }).limit(5).lean(),

      // ── Critical stock items ─────────────────────────────────────────────────
      StockItem.find({ $expr: { $lte: ["$quantityOnHand", "$minStock"] } })
        .select("name reference quantityOnHand minStock status").sort({ quantityOnHand: 1 }).limit(5).lean(),

      // ── Top 5 vendors by PO value ────────────────────────────────────────────
      PurchaseOrder.aggregate([
        { $match: { status: { $ne: "CANCELLED" } } },
        { $group: { _id: "$vendor", vendorName: { $first: "$vendorName" }, totalValue: { $sum: { $ifNull: ["$totalAmount",0] } }, poCount: { $sum: 1 } } },
        { $sort: { totalValue: -1 } }, { $limit: 5 },
        { $lookup: { from: "vendors", localField: "_id", foreignField: "_id", as: "vendorDoc" } },
        { $project: { _id: 1, vendorName: { $ifNull: [{ $arrayElemAt: ["$vendorDoc.companyName", 0] }, "$vendorName"] }, totalValue: 1, poCount: 1 } },
      ]),

      // ── NEW: Today's STOCK-OUT transactions (MRF issues + reductions) ───────
      RawItem.aggregate([
        { $unwind: "$stockTransactions" },
        {
          $match: {
            "stockTransactions.createdAt": { $gte: todayStart, $lte: todayEnd },
            "stockTransactions.type": { $in: ["REDUCE","VARIANT_REDUCE","CONSUME"] },
          },
        },
        {
          $project: {
            _id: 0,
            itemName: "$name",
            itemSku:  "$sku",
            type:     "$stockTransactions.type",
            qty:      "$stockTransactions.quantity",
            reason:   "$stockTransactions.reason",
            notes:    "$stockTransactions.notes",
            at:       "$stockTransactions.createdAt",
          },
        },
        { $sort: { at: -1 } },
        { $limit: 30 },
      ]),

      // ── NEW: Today's STOCK-IN transactions (PO deliveries + manual adds) ────
      RawItem.aggregate([
        { $unwind: "$stockTransactions" },
        {
          $match: {
            "stockTransactions.createdAt": { $gte: todayStart, $lte: todayEnd },
            "stockTransactions.type": { $in: ["ADD","PURCHASE_ORDER","VARIANT_ADD"] },
          },
        },
        {
          $project: {
            _id: 0,
            itemName:  "$name",
            itemSku:   "$sku",
            type:      "$stockTransactions.type",
            qty:       "$stockTransactions.quantity",
            unitPrice: "$stockTransactions.unitPrice",
            reason:    "$stockTransactions.reason",
            notes:     "$stockTransactions.notes",
            at:        "$stockTransactions.createdAt",
          },
        },
        { $sort: { at: -1 } },
        { $limit: 30 },
      ]),

      // ── NEW: Top used raw items (by consumedQty in MRF items, last 30 days) ─
      MRF.aggregate([
        { $match: { createdAt: { $gte: thirtyDaysAgo }, status: { $in: ["ISSUED","PARTIALLY_ISSUED","COMPLETED","PARTIALLY_RETURNED"] } } },
        { $unwind: "$items" },
        { $match: { "items.itemStatus": { $in: ["ISSUED","PARTIALLY_RETURNED","RETURNED"] } } },
        {
          $group: {
            _id:         "$items.rawItem",
            rawItemName: { $first: "$items.rawItemName" },
            rawItemSku:  { $first: "$items.rawItemSku"  },
            unit:        { $first: "$items.unit"         },
            totalIssued: { $sum: "$items.issuedQty"     },
            totalConsumed:{ $sum: "$items.consumedQty"  },
            mrfCount:    { $sum: 1                       },
          },
        },
        { $sort: { totalIssued: -1 } },
        { $limit: 8 },
      ]),

      // ── NEW: MRF daily summary ───────────────────────────────────────────────
      MRF.aggregate([
        {
          $group: {
            _id: null,
            total:          { $sum: 1 },
            pending:        { $sum: { $cond: [{ $eq: ["$status","PENDING"]          }, 1, 0] } },
            approved:       { $sum: { $cond: [{ $eq: ["$status","APPROVED"]         }, 1, 0] } },
            partiallyIssued:{ $sum: { $cond: [{ $eq: ["$status","PARTIALLY_ISSUED"] }, 1, 0] } },
            issued:         { $sum: { $cond: [{ $eq: ["$status","ISSUED"]           }, 1, 0] } },
            completed:      { $sum: { $cond: [{ $eq: ["$status","COMPLETED"]        }, 1, 0] } },
            rejected:       { $sum: { $cond: [{ $eq: ["$status","REJECTED"]         }, 1, 0] } },
            unfulfilled:    { $sum: { $cond: [{ $eq: ["$status","UNFULFILLED"]      }, 1, 0] } },
            todayCount:     { $sum: { $cond: [{ $gte: ["$createdAt", todayStart]    }, 1, 0] } },

            // What the STORE actually owes. `pending` means the request is
            // still with the requester's Primary Manager/TL — that is not the
            // store's queue, and counting it as store work overstates the
            // backlog. Only TL-approved (or auto-forwarded) requests are the
            // store's to issue.
            awaitingStore: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $in: ["$status", ["APPROVED", "PARTIALLY_ISSUED"]] },
                      { $or: [{ $eq: ["$tlApproved", true] }, { $eq: ["$autoForwarded", true] }] },
                    ],
                  }, 1, 0,
                ],
              },
            },
            // Approved and not yet looked at by anyone in the store.
            notYetReviewed: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$status", "APPROVED"] },
                      { $or: [{ $eq: ["$storeReviewedAt", null] }, { $eq: [{ $type: "$storeReviewedAt" }, "missing"] }] },
                    ],
                  }, 1, 0,
                ],
              },
            },
            // Still sitting with a TL — shown so the store knows what is
            // coming, labelled as somebody else's action.
            awaitingTl: { $sum: { $cond: [{ $eq: ["$status", "PENDING"] }, 1, 0] } },
          },
        },
      ]),

      // ── Product registration requests, split the same way ────────────────
      RawItemAddRequest.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            awaitingTl: { $sum: { $cond: [{ $eq: ["$approvalStatus", "PENDING_TL"] }, 1, 0] } },
            // TL-approved and still unresolved — the store must match it to an
            // existing item or register it as new.
            awaitingStore: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$approvalStatus", "TL_APPROVED"] },
                      { $in: ["$status", ["PENDING", "MATCHED"]] },
                    ],
                  }, 1, 0,
                ],
              },
            },
            todayCount: { $sum: { $cond: [{ $gte: ["$createdAt", todayStart] }, 1, 0] } },
          },
        },
      ]),
    ]);

    // ── Unwrap single-doc aggregations ────────────────────────────────────────
    const r = rawItemsAgg[0]   || { total:0, inStock:0, lowStock:0, outOfStock:0, totalQuantity:0 };
    const s = stockItemsAgg[0] || { total:0, inStock:0, lowStock:0, outOfStock:0, totalQuantity:0, totalValue:0 };
    const p = purchaseOrdersAgg[0] || {
      total:0, draft:0, issued:0, partiallyReceived:0, completed:0, cancelled:0,
      totalValue:0, pendingValue:0, totalReceived:0, totalPending:0,
    };
    const mrfS = mrfStats[0] || {
      total:0, pending:0, approved:0, partiallyIssued:0, issued:0, completed:0,
      rejected:0, unfulfilled:0, todayCount:0,
      awaitingStore:0, notYetReviewed:0, awaitingTl:0,
    };
    const prS = productRequestStats[0] || { total:0, awaitingTl:0, awaitingStore:0, todayCount:0 };
    /* The one honest valuation answer, from the shared engine. `knownValue` is
       what CAN be valued from recorded movements — not a "total". Items that
       cannot be valued reliably are counted, not hidden as ₹0. */
    const iv = inventoryValuation || {
      knownInventoryValue: 0, completeCount: 0, incompleteCount: 0,
      unreconciledCount: 0, excludedCount: 0,
    };

    res.json({
      success: true,
      stats: {
        rawItems: {
          total:          r.total,
          inStock:        r.inStock,
          lowStock:       r.lowStock,
          outOfStock:     r.outOfStock,
          totalQuantity:  r.totalQuantity,
          // Known inventory value from the moving weighted-average engine, plus
          // how many items could NOT be valued reliably. `totalValue` is kept
          // as an alias for existing readers but means the KNOWN value.
          knownInventoryValue: iv.knownInventoryValue,
          totalValue:          iv.knownInventoryValue,
          incompleteItems:     iv.incompleteCount,
          unreconciledItems:   iv.unreconciledCount,
          completeItems:       iv.completeCount,
          itemsWithPrice:      iv.completeCount,
          valuationAvailable:  inventoryValuation != null,
        },
        stockItems: {
          total:         s.total,
          inStock:       s.inStock,
          lowStock:      s.lowStock,
          outOfStock:    s.outOfStock,
          totalQuantity: s.totalQuantity,
          totalValue:    s.totalValue,
        },
        purchaseOrders: {
          total:             p.total,
          draft:             p.draft,
          issued:            p.issued,
          partiallyReceived: p.partiallyReceived,
          completed:         p.completed,
          cancelled:         p.cancelled,
          totalValue:        p.totalValue,
          pendingValue:      p.pendingValue,
          totalReceived:     p.totalReceived,
          totalPending:      p.totalPending,
        },
        vendors: { active: activeVendorsCount },
        mrf: mrfS,
        productRequests: prS,
        // Everything the STORE owes, in one place. Deliberately excludes work
        // that is sitting with a TL — that is somebody else's queue, and
        // counting it here overstates the store's backlog.
        actionRequired: {
          mrfsToIssue: mrfS.awaitingStore || 0,
          mrfsNotYetReviewed: mrfS.notYetReviewed || 0,
          productRequestsToResolve: prS.awaitingStore || 0,
          posToReceive: (p.issued || 0) + (p.partiallyReceived || 0),
          itemsBelowMinimum: (r.lowStock || 0) + (r.outOfStock || 0),
          total:
            (mrfS.awaitingStore || 0) +
            (prS.awaitingStore || 0) +
            (p.issued || 0) + (p.partiallyReceived || 0),
        },
        // Waiting on someone else — shown so the store can see what is coming.
        waitingOnOthers: {
          mrfsAwaitingTl: mrfS.awaitingTl || 0,
          productRequestsAwaitingTl: prS.awaitingTl || 0,
        },
        overall: {
          totalItems:          r.total + s.total,
          // Combined KNOWN inventory value (weighted-average raw stock) + stock
          // items value. Not labelled a "total" downstream when incomplete.
          totalValue:          iv.knownInventoryValue + s.totalValue,
          knownInventoryValue: iv.knownInventoryValue,
          incompleteItems:     iv.incompleteCount,
          totalStockQuantity:  r.totalQuantity + s.totalQuantity,
        },
      },
      recentActivities: {
        rawItems:       recentRawItems,
        purchaseOrders: recentPurchaseOrders,
      },
      criticalItems: {
        rawItems:   criticalRawItems,
        stockItems: criticalStockItems,
      },
      topVendors: topVendorsByPO,
      // ── NEW fields ────────────────────────────────────────────────────────
      todayActivity: {
        stockOuts: todayStockOuts,
        stockIns:  todayStockIns,
      },
      topUsedItems,
      topValueItems: topByKnownValue,
    });

  } catch (error) {
    console.error("Error fetching inventory overview:", error);
    res.status(500).json({ success: false, message: "Server error while fetching inventory overview" });
  }
});

module.exports = router;