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