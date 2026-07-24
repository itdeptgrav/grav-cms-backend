// routes/CMS_Routes/Inventory/overview.js
// REPLACE the entire existing file with this

const express = require("express");
const router  = express.Router();
const RawItem  = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor   = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const MRF      = require("../../../../models/CMS_Models/Inventory/Operations/MRF");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

router.get("/", async (req, res) => {
  try {
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
      // ── NEW: correct value — qty × last purchase price from stockTransactions ──
      rawItemsForValue,
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
            todayCount:     { $sum: { $cond: [{ $gte: ["$createdAt", todayStart]    }, 1, 0] } },
          },
        },
      ]),

      // ── NEW: correct inventory value — qty × last unitPrice per item ─────────
      // We pull only items that are In Stock / Low Stock (have qty > 0)
      RawItem.aggregate([
        { $match: { quantity: { $gt: 0 } } },
        {
          $project: {
            name:     1,
            quantity: 1,
            status:   1,
            // Last purchase unitPrice from stockTransactions
            lastUnitPrice: {
              $let: {
                vars: {
                  purchaseTxns: {
                    $filter: {
                      input: { $ifNull: ["$stockTransactions", []] },
                      as:    "tx",
                      cond:  {
                        $and: [
                          { $in:  ["$$tx.type", ["ADD","PURCHASE_ORDER","VARIANT_ADD"]] },
                          { $gt:  ["$$tx.unitPrice", 0] },
                        ],
                      },
                    },
                  },
                },
                in: {
                  $ifNull: [
                    { $arrayElemAt: [{ $slice: ["$$purchaseTxns", -1] }, 0] },
                    null,
                  ],
                },
              },
            },
          },
        },
        {
          $project: {
            name:     1,
            quantity: 1,
            status:   1,
            unitPrice: { $ifNull: ["$lastUnitPrice.unitPrice", 0] },
            stockValue: {
              $multiply: [
                { $ifNull: ["$quantity", 0] },
                { $ifNull: ["$lastUnitPrice.unitPrice", 0] },
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            totalStockValue: { $sum: "$stockValue" },
            itemsWithPrice:  { $sum: { $cond: [{ $gt: ["$unitPrice", 0] }, 1, 0] } },
            // Top 5 by stock value
            items: {
              $push: {
                name:       "$name",
                quantity:   "$quantity",
                unitPrice:  "$unitPrice",
                stockValue: "$stockValue",
                status:     "$status",
              },
            },
          },
        },
        {
          $project: {
            totalStockValue: 1,
            itemsWithPrice:  1,
            topByValue: {
              $slice: [
                { $sortArray: { input: "$items", sortBy: { stockValue: -1 } } },
                5
              ],
            },
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
    const mrfS = mrfStats[0] || { total:0, pending:0, approved:0, partiallyIssued:0, issued:0, completed:0, rejected:0, todayCount:0 };
    const valData = rawItemsForValue[0] || { totalStockValue:0, itemsWithPrice:0, topByValue:[] };

    res.json({
      success: true,
      stats: {
        rawItems: {
          total:          r.total,
          inStock:        r.inStock,
          lowStock:       r.lowStock,
          outOfStock:     r.outOfStock,
          totalQuantity:  r.totalQuantity,
          // Correct value: qty × last purchase price (only in-stock items)
          totalValue:     valData.totalStockValue,
          itemsWithPrice: valData.itemsWithPrice,
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
        overall: {
          totalItems:          r.total + s.total,
          // Combined: raw stock value (purchase-price based) + stock items value
          totalValue:          valData.totalStockValue + s.totalValue,
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
      topValueItems: valData.topByValue,
    });

  } catch (error) {
    console.error("Error fetching inventory overview:", error);
    res.status(500).json({ success: false, message: "Server error while fetching inventory overview" });
  }
});

module.exports = router;