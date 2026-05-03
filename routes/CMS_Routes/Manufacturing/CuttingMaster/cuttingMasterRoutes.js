// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// GET all manufacturing orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const manufacturingOrders = await CustomerRequest.find({
      status: "quotation_sales_approved",
    })
      .select("requestId customerInfo status requestType measurementId measurementName createdAt")
      .sort({ createdAt: -1 })
      .lean();

    const ordersWithTags = manufacturingOrders.map((order) => ({
      ...order,
      orderType:
        order.requestType === "measurement_conversion"
          ? "measurement_conversion"
          : "customer_bulk_order",
      orderTypeLabel:
        order.requestType === "measurement_conversion"
          ? "Measurement → PO"
          : "Bulk Order",
    }));

    res.json({
      success: true,
      manufacturingOrders: ordersWithTags,
      total: ordersWithTags.length,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// GET /cutting-history-bulk
// Returns bulk-order cutting activity grouped by customer.
// Uses WorkOrder.updatedAt as the cut timestamp proxy (filtered by cuttingProgress.completed > 0).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/cutting-history-bulk", async (req, res) => {
  try {
    const { from, to, q } = req.query;

    const fromDate = from
      ? new Date(`${from}T00:00:00.000`)
      : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = to
      ? new Date(`${to}T23:59:59.999`)
      : new Date();

    const searchQuery = (q || "").trim().toLowerCase();

    // ── Find non-measurement (bulk) customer requests ────────────────────
    const bulkRequests = await CustomerRequest.find({
      requestType: { $ne: "measurement_conversion" },
      status: "quotation_sales_approved",
    })
      .select("_id requestId customerInfo")
      .lean();

    if (bulkRequests.length === 0) {
      return res.json({
        success: true,
        bulkGroups: [],
        stats: { totalCustomers: 0, totalWorkOrders: 0, totalPieces: 0 },
      });
    }

    const bulkRequestMap = new Map();
    bulkRequests.forEach((r) => bulkRequestMap.set(r._id.toString(), r));

    // ── Find their WOs that have had cutting activity in date range ──────
    const bulkWOs = await WorkOrder.find({
      customerRequestId: {
        $in: bulkRequests.map((r) => new mongoose.Types.ObjectId(r._id)),
      },
      "cuttingProgress.completed": { $gt: 0 },
      updatedAt: { $gte: fromDate, $lte: toDate },
    })
      .select(
        "_id workOrderNumber customerRequestId stockItemName variantAttributes " +
          "cuttingProgress cuttingStatus quantity updatedAt"
      )
      .sort({ updatedAt: -1 })
      .lean();

    // ── Group by customer ────────────────────────────────────────────────
    const bulkGroupsMap = new Map();

    for (const wo of bulkWOs) {
      const reqDoc = bulkRequestMap.get(wo.customerRequestId.toString());
      const customerName = reqDoc?.customerInfo?.name || "Unknown Customer";
      const requestRef = reqDoc?.requestId || "—";

      // Search filter
      if (searchQuery) {
        const variantStr = (wo.variantAttributes || [])
          .map((a) => `${a.name}:${a.value}`)
          .join(" ")
          .toLowerCase();
        const hay = [
          wo.workOrderNumber,
          wo.stockItemName,
          customerName,
          requestRef,
          variantStr,
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(searchQuery)) continue;
      }

      const groupKey = `${customerName}::${requestRef}`;

      if (!bulkGroupsMap.has(groupKey)) {
        bulkGroupsMap.set(groupKey, {
          customerName,
          requestRef,
          workOrders: [],
          totalPieces: 0,
        });
      }

      const group = bulkGroupsMap.get(groupKey);
      group.workOrders.push({
        _id: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName,
        variantAttributes: wo.variantAttributes || [],
        qtyCut: wo.cuttingProgress?.completed || 0,
        totalQty: wo.quantity || 0,
        status: wo.cuttingStatus || "pending",
        cutAt: wo.updatedAt,
      });
      group.totalPieces += wo.cuttingProgress?.completed || 0;
    }

    // Sort groups by latest cut activity
    const bulkGroups = [...bulkGroupsMap.values()].sort((a, b) => {
      const aLatest = Math.max(
        ...a.workOrders.map((w) => new Date(w.cutAt).getTime())
      );
      const bLatest = Math.max(
        ...b.workOrders.map((w) => new Date(w.cutAt).getTime())
      );
      return bLatest - aLatest;
    });

    const stats = {
      totalCustomers: bulkGroups.length,
      totalWorkOrders: bulkGroups.reduce((s, g) => s + g.workOrders.length, 0),
      totalPieces: bulkGroups.reduce((s, g) => s + g.totalPieces, 0),
    };

    res.json({ success: true, bulkGroups, stats });
  } catch (error) {
    console.error("cutting-history-bulk error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET specific MO with its work orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-orders/:moId", async (req, res) => {
  try {
    const { moId } = req.params;

    const manufacturingOrder = await CustomerRequest.findById(moId)
      .select("requestId customerInfo requestType measurementId createdAt")
      .lean();

    if (!manufacturingOrder) {
      return res.status(404).json({ success: false, message: "MO not found" });
    }

    const workOrders = await WorkOrder.find({
      customerRequestId: moId,
      status: { $ne: "pending" },
    })
      .select("workOrderNumber stockItemName stockItemId quantity variantAttributes cuttingStatus status createdAt _id")
      .sort({ createdAt: -1 })
      .lean();

    // ── Fetch genderCategory for each WO's stock item ─────────────────────
    const stockItemIds = [...new Set(workOrders.map((wo) => wo.stockItemId?.toString()).filter(Boolean))];
    const stockItems = await StockItem.find({ _id: { $in: stockItemIds } })
      .select("_id genderCategory gender category")
      .lean();

    const stockItemMap = new Map();
    stockItems.forEach((si) => {
      stockItemMap.set(si._id.toString(), si.genderCategory || si.gender || si.category || null);
    });

    // ── Measurement doc for QR status ─────────────────────────────────────
    const measurement =
      manufacturingOrder.requestType === "measurement_conversion"
        ? await Measurement.findOne({ poRequestId: moId }).lean()
        : null;

    // ── Enhance each WO ───────────────────────────────────────────────────
    const enhancedWorkOrders = workOrders.map((wo) => {
      const genderCategory = stockItemMap.get(wo.stockItemId?.toString()) || null;

      let qrGenerationStatus = {
        allGenerated: false,
        someGenerated: false,
        noneGenerated: true,
        generatedCount: 0,
        totalEmployees: 0,
      };

      if (measurement) {
        const employeesForProduct = measurement.employeeMeasurements.filter((emp) =>
          emp.products.some((p) => p.productName === wo.stockItemName)
        );

        const generatedEmployees = employeesForProduct.filter((emp) =>
          emp.products.some((p) => p.productName === wo.stockItemName && p.qrGenerated === true)
        );

        const total = employeesForProduct.length;
        const done = generatedEmployees.length;

        qrGenerationStatus = {
          allGenerated: total > 0 && done === total,
          someGenerated: done > 0 && done < total,
          noneGenerated: done === 0,
          generatedCount: done,
          totalEmployees: total,
        };

        if (qrGenerationStatus.allGenerated) wo.cuttingStatus = "completed";
        else if (qrGenerationStatus.someGenerated) wo.cuttingStatus = "in_progress";
        else wo.cuttingStatus = "pending";
      }

      return {
        ...wo,
        genderCategory,
        qrGenerationStatus,
      };
    });

    res.json({
      success: true,
      manufacturingOrder: {
        ...manufacturingOrder,
        orderType:
          manufacturingOrder.requestType === "measurement_conversion"
            ? "measurement_conversion"
            : "customer_bulk_order",
        orderTypeLabel:
          manufacturingOrder.requestType === "measurement_conversion"
            ? "Measurement → PO"
            : "Bulk Order",
      },
      workOrders: enhancedWorkOrders,
      totalWorkOrders: enhancedWorkOrders.length,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;