// routes/CMS_Routes/Inventory/overview.js

const express = require("express");
const router = express.Router();
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ✅ GET inventory overview — optimized with aggregation pipelines
router.get("/", async (req, res) => {
  try {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // ── Run EVERYTHING in parallel ─────────────────────────────────────────
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
    ] = await Promise.all([
      // ── Raw Items aggregation (single DB call replaces find + JS filtering)
      RawItem.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            inStock: { $sum: { $cond: [{ $eq: ["$status", "In Stock"] }, 1, 0] } },
            lowStock: { $sum: { $cond: [{ $eq: ["$status", "Low Stock"] }, 1, 0] } },
            outOfStock: { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"] }, 1, 0] } },
            totalQuantity: { $sum: { $ifNull: ["$quantity", 0] } },
            totalValue: {
              $sum: {
                $multiply: [
                  { $ifNull: ["$quantity", 0] },
                  { $ifNull: ["$sellingPrice", 0] },
                ],
              },
            },
          },
        },
      ]),

      // ── Stock Items aggregation
      StockItem.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            inStock: { $sum: { $cond: [{ $eq: ["$status", "In Stock"] }, 1, 0] } },
            lowStock: { $sum: { $cond: [{ $eq: ["$status", "Low Stock"] }, 1, 0] } },
            outOfStock: { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"] }, 1, 0] } },
            totalQuantity: { $sum: { $ifNull: ["$quantityOnHand", 0] } },
            totalValue: { $sum: { $ifNull: ["$inventoryValue", 0] } },
          },
        },
      ]),

      // ── Purchase Orders aggregation
      PurchaseOrder.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            draft: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
            issued: { $sum: { $cond: [{ $eq: ["$status", "ISSUED"] }, 1, 0] } },
            partiallyReceived: { $sum: { $cond: [{ $eq: ["$status", "PARTIALLY_RECEIVED"] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
            totalValue: { $sum: { $ifNull: ["$totalAmount", 0] } },
            pendingValue: {
              $sum: {
                $cond: [
                  { $not: { $in: ["$status", ["COMPLETED", "CANCELLED"]] } },
                  { $ifNull: ["$totalAmount", 0] },
                  0,
                ],
              },
            },
            totalReceived: { $sum: { $ifNull: ["$totalReceived", 0] } },
            totalPending: { $sum: { $ifNull: ["$totalPending", 0] } },
          },
        },
      ]),

      // ── Active vendor count
      Vendor.countDocuments({ status: "Active" }),

      // ── Recent raw items (last 7 days)
      RawItem.find({ createdAt: { $gte: sevenDaysAgo } })
        .select("name sku quantity status createdAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),

      // ── Recent POs (last 7 days)
      PurchaseOrder.find({ createdAt: { $gte: sevenDaysAgo } })
        .select("poNumber vendorName totalAmount status createdAt vendor")
        .populate("vendor", "companyName")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),

      // ── Critical raw items (at or below min stock)
      RawItem.find({
        $expr: { $lte: ["$quantity", "$minStock"] },
      })
        .select("name sku quantity minStock status")
        .sort({ quantity: 1 })
        .limit(5)
        .lean(),

      // ── Critical stock items
      StockItem.find({
        $expr: { $lte: ["$quantityOnHand", "$minStock"] },
      })
        .select("name reference quantityOnHand minStock status")
        .sort({ quantityOnHand: 1 })
        .limit(5)
        .lean(),

      // ── Top 5 vendors by total PO value
      PurchaseOrder.aggregate([
        { $match: { status: { $ne: "CANCELLED" } } },
        {
          $group: {
            _id: "$vendor",
            vendorName: { $first: "$vendorName" },
            totalValue: { $sum: { $ifNull: ["$totalAmount", 0] } },
            poCount: { $sum: 1 },
          },
        },
        { $sort: { totalValue: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "vendors",
            localField: "_id",
            foreignField: "_id",
            as: "vendorDoc",
          },
        },
        {
          $project: {
            _id: 1,
            vendorName: {
              $ifNull: [{ $arrayElemAt: ["$vendorDoc.companyName", 0] }, "$vendorName"],
            },
            totalValue: 1,
            poCount: 1,
          },
        },
      ]),
    ]);

    // ── Unwrap aggregation results (they return arrays) ────────────────────
    const r = rawItemsAgg[0] || { total: 0, inStock: 0, lowStock: 0, outOfStock: 0, totalQuantity: 0, totalValue: 0 };
    const s = stockItemsAgg[0] || { total: 0, inStock: 0, lowStock: 0, outOfStock: 0, totalQuantity: 0, totalValue: 0 };
    const p = purchaseOrdersAgg[0] || {
      total: 0, draft: 0, issued: 0, partiallyReceived: 0, completed: 0, cancelled: 0,
      totalValue: 0, pendingValue: 0, totalReceived: 0, totalPending: 0,
    };

    res.json({
      success: true,
      stats: {
        rawItems: {
          total: r.total,
          inStock: r.inStock,
          lowStock: r.lowStock,
          outOfStock: r.outOfStock,
          totalQuantity: r.totalQuantity,
          totalValue: r.totalValue,
        },
        stockItems: {
          total: s.total,
          inStock: s.inStock,
          lowStock: s.lowStock,
          outOfStock: s.outOfStock,
          totalQuantity: s.totalQuantity,
          totalValue: s.totalValue,
        },
        purchaseOrders: {
          total: p.total,
          draft: p.draft,
          issued: p.issued,
          partiallyReceived: p.partiallyReceived,
          completed: p.completed,
          cancelled: p.cancelled,
          totalValue: p.totalValue,
          pendingValue: p.pendingValue,
          totalReceived: p.totalReceived,
          totalPending: p.totalPending,
        },
        vendors: {
          active: activeVendorsCount,
        },
        overall: {
          totalItems: r.total + s.total,
          totalValue: r.totalValue + s.totalValue,
          totalStockQuantity: r.totalQuantity + s.totalQuantity,
        },
      },
      recentActivities: {
        rawItems: recentRawItems,
        purchaseOrders: recentPurchaseOrders,
      },
      criticalItems: {
        rawItems: criticalRawItems,
        stockItems: criticalStockItems,
      },
      topVendors: topVendorsByPO,
    });
  } catch (error) {
    console.error("Error fetching inventory overview:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching inventory overview",
    });
  }
});

module.exports = router;



// Ok let's move to next work ok means at the time of delivery /GRN interface ok...



// ->  first of all the ui need to make nermal because the box are showing too much large size ok... so make them short as need ok...



// -> and the most important thing is, basically here there is an feature need to introduce that is generate barcode ok... so that there is an barcode will be an feature for generate barcode where  each barcode will have an UID ok which also need to store in the database ok..



// -> So the interface will be like once he enter the Delivered qty , then against that qty, he will goona now generate barcode/barcodes for that specific raw-item-variant ok ..



// So basically just thing that there is an GRN happen for cotton-fabric-black ok of around 780 metre ok..



// So as you know 780 metre's means if we consider in fabric roll/packet, then definitely we can say so many packets are goona delivered right..? so basically at the time of generating the barcode(click on generate barcode then it will ask for set Quantity and then set unit where all the registered units will be goona showcase ok, but bydefault suggest the units which are the conversion unit of that corresponding raw-item defined unit ok(conversion unit means both viceversa ok means don't consider the parent or child like thing ok, conversion means you just thing that corresponding raw-item defined unit which is associated with other units in any form ok these need to suggest ok))...


// So ask the user for set quantity, set unit type ok that's it ok... then upon click on generate, automatically an document will be goona generate ok and in the frontend side that mondodb  document id need to print in the QR code ok.. that's it. and in the database/schema, keep the record of the raw item document id, corresponding attribute-variant name , corresponding po id(if available ok, so keep it optional ok) ok that's it ok.. if you thing to keep some other slight info then also you can but it shouldn't affect storage ok so don't keep extra ordianry ok...
// -> and also basically in the raw-item list page, keep an button for generate barcode in the header/top so that
// -> and 2nd thing is , basically create one more section in the inventory ok which is basilcly for generating the qr code ok.
// So the interface will ask for the 
// So let's do that ok  



