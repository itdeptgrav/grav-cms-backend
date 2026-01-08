// routes/CMS_Routes/Inventory/overview.js

const express = require("express");
const router = express.Router();
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// ✅ GET inventory overview statistics
router.get("/", async (req, res) => {
  try {
    // Get all counts and statistics in parallel for better performance
    const [
      rawItemsCount,
      stockItemsCount,
      purchaseOrdersCount,
      vendorsCount,
      rawItems,
      stockItems,
      purchaseOrders
    ] = await Promise.all([
      RawItem.countDocuments(),
      StockItem.countDocuments(),
      PurchaseOrder.countDocuments(),
      Vendor.countDocuments({ status: "Active" }),
      RawItem.find({}).select("quantity minStock maxStock status sellingPrice"),
      StockItem.find({}).select("quantityOnHand minStock maxStock status salesPrice inventoryValue"),
      PurchaseOrder.find({}).select("totalAmount status totalReceived totalPending")
    ]);

    // Raw Items Statistics
    const rawItemsOutOfStock = rawItems.filter(item => item.status === "Out of Stock").length;
    const rawItemsLowStock = rawItems.filter(item => item.status === "Low Stock").length;
    const rawItemsInStock = rawItems.filter(item => item.status === "In Stock").length;
    
    const rawItemsTotalQuantity = rawItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
    const rawItemsTotalValue = rawItems.reduce((sum, item) => 
      sum + ((item.quantity || 0) * (item.sellingPrice || 0)), 0);

    // Stock Items Statistics
    const stockItemsOutOfStock = stockItems.filter(item => item.status === "Out of Stock").length;
    const stockItemsLowStock = stockItems.filter(item => item.status === "Low Stock").length;
    const stockItemsInStock = stockItems.filter(item => item.status === "In Stock").length;
    
    const stockItemsTotalQuantity = stockItems.reduce((sum, item) => sum + (item.quantityOnHand || 0), 0);
    const stockItemsTotalValue = stockItems.reduce((sum, item) => sum + (item.inventoryValue || 0), 0);

    // Purchase Orders Statistics
    const poDraft = purchaseOrders.filter(po => po.status === "DRAFT").length;
    const poIssued = purchaseOrders.filter(po => po.status === "ISSUED").length;
    const poPartiallyReceived = purchaseOrders.filter(po => po.status === "PARTIALLY_RECEIVED").length;
    const poCompleted = purchaseOrders.filter(po => po.status === "COMPLETED").length;
    const poCancelled = purchaseOrders.filter(po => po.status === "CANCELLED").length;
    
    const poTotalValue = purchaseOrders.reduce((sum, po) => sum + (po.totalAmount || 0), 0);
    const poPendingValue = purchaseOrders
      .filter(po => po.status !== "COMPLETED" && po.status !== "CANCELLED")
      .reduce((sum, po) => sum + (po.totalAmount || 0), 0);
    
    const poTotalReceived = purchaseOrders.reduce((sum, po) => sum + (po.totalReceived || 0), 0);
    const poTotalPending = purchaseOrders.reduce((sum, po) => sum + (po.totalPending || 0), 0);

    // Vendor Statistics
    const activeVendors = vendorsCount;
    
    // Recent Activities (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    
    const [recentRawItems, recentPurchaseOrders] = await Promise.all([
      RawItem.find({
        createdAt: { $gte: sevenDaysAgo }
      })
      .select("name sku quantity status createdAt")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean(),
      
      PurchaseOrder.find({
        createdAt: { $gte: sevenDaysAgo }
      })
      .select("poNumber vendorName totalAmount status createdAt")
      .populate("vendor", "companyName")
      .sort({ createdAt: -1 })
      .limit(5)
      .lean()
    ]);

    // Critical Items (items below minimum stock)
    const criticalRawItems = await RawItem.find({
      $expr: { $lte: ["$quantity", "$minStock"] },
      quantity: { $gt: 0 }
    })
    .select("name sku quantity minStock status")
    .sort({ quantity: 1 })
    .limit(5)
    .lean();

    const criticalStockItems = await StockItem.find({
      $expr: { $lte: ["$quantityOnHand", "$minStock"] },
      quantityOnHand: { $gt: 0 }
    })
    .select("name reference quantityOnHand minStock status")
    .sort({ quantityOnHand: 1 })
    .limit(5)
    .lean();

    // Monthly purchase order value (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const monthlyPOData = await PurchaseOrder.aggregate([
      {
        $match: {
          createdAt: { $gte: sixMonthsAgo },
          status: { $in: ["ISSUED", "PARTIALLY_RECEIVED", "COMPLETED"] }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: "$createdAt" },
            month: { $month: "$createdAt" }
          },
          totalAmount: { $sum: "$totalAmount" },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { "_id.year": 1, "_id.month": 1 }
      },
      {
        $limit: 6
      }
    ]);

    // Format monthly data
    const monthlyData = monthlyPOData.map(item => ({
      month: `${item._id.year}-${item._id.month.toString().padStart(2, '0')}`,
      amount: item.totalAmount,
      count: item.count
    }));

    res.json({
      success: true,
      stats: {
        // Raw Items
        rawItems: {
          total: rawItemsCount,
          outOfStock: rawItemsOutOfStock,
          lowStock: rawItemsLowStock,
          inStock: rawItemsInStock,
          totalQuantity: rawItemsTotalQuantity,
          totalValue: rawItemsTotalValue
        },
        
        // Stock Items
        stockItems: {
          total: stockItemsCount,
          outOfStock: stockItemsOutOfStock,
          lowStock: stockItemsLowStock,
          inStock: stockItemsInStock,
          totalQuantity: stockItemsTotalQuantity,
          totalValue: stockItemsTotalValue
        },
        
        // Purchase Orders
        purchaseOrders: {
          total: purchaseOrdersCount,
          draft: poDraft,
          issued: poIssued,
          partiallyReceived: poPartiallyReceived,
          completed: poCompleted,
          cancelled: poCancelled,
          totalValue: poTotalValue,
          pendingValue: poPendingValue,
          totalReceived: poTotalReceived,
          totalPending: poTotalPending
        },
        
        // Vendors
        vendors: {
          active: activeVendors
        },
        
        // Overall Inventory
        overall: {
          totalItems: rawItemsCount + stockItemsCount,
          totalValue: rawItemsTotalValue + stockItemsTotalValue,
          totalStockQuantity: rawItemsTotalQuantity + stockItemsTotalQuantity
        }
      },
      
      // Recent Activities
      recentActivities: {
        rawItems: recentRawItems,
        purchaseOrders: recentPurchaseOrders
      },
      
      // Critical Items
      criticalItems: {
        rawItems: criticalRawItems,
        stockItems: criticalStockItems
      },
      
      // Charts Data
      charts: {
        monthlyPurchases: monthlyData
      }
    });

  } catch (error) {
    console.error("Error fetching inventory overview:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching inventory overview"
    });
  }
});

module.exports = router;