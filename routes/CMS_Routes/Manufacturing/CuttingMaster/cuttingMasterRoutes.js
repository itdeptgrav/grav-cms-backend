const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// GET all manufacturing orders (MO) for cutting master
router.get("/manufacturing-orders", async (req, res) => {
  try {
    // Get manufacturing orders (CustomerRequests with status 'quotation_sales_approved')
    const manufacturingOrders = await CustomerRequest.find({
      status: "quotation_sales_approved"
    })
      .select('requestId customerInfo status requestType measurementId measurementName createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Add order type tag
    const ordersWithTags = manufacturingOrders.map(order => ({
      ...order,
      orderType: order.requestType === "measurement_conversion" ? "measurement_conversion" : "customer_bulk_order",
      orderTypeLabel: order.requestType === "measurement_conversion" ? "Measurement → PO" : "Bulk Order"
    }));

    res.json({
      success: true,
      manufacturingOrders: ordersWithTags,
      total: ordersWithTags.length
    });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingMasterRoutes.js
// Update the GET specific MO route:

// GET specific MO with its work orders
router.get("/manufacturing-orders/:moId", async (req, res) => {
  try {
    const { moId } = req.params;

    // Get MO details
    const manufacturingOrder = await CustomerRequest.findById(moId)
      .select('requestId customerInfo requestType measurementId createdAt')
      .lean();

    if (!manufacturingOrder) {
      return res.status(404).json({ success: false, message: "MO not found" });
    }

    // Get work orders for this MO
    const workOrders = await WorkOrder.find({
      customerRequestId: moId,
      status: { $ne: "pending" }
    })
      .select('workOrderNumber stockItemName quantity variantAttributes cuttingStatus status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Get measurement data to check QR generation status for each work order
    const Measurement = require("../../../../models/Customer_Models/Measurement");
    const measurement = await Measurement.findOne({
      poRequestId: moId
    }).lean();

    // Enhance work orders with QR generation status
    const enhancedWorkOrders = await Promise.all(workOrders.map(async (wo) => {
      let qrGenerationStatus = {
        allGenerated: false,
        someGenerated: false,
        noneGenerated: true,
        generatedCount: 0,
        totalEmployees: 0
      };

      // Only check for measurement conversion orders
      if (manufacturingOrder.requestType === "measurement_conversion" && measurement) {
        // Count employees with QR generated for this product
        const employeesForProduct = measurement.employeeMeasurements.filter(emp =>
          emp.products.some(product => product.productName === wo.stockItemName)
        );

        const generatedEmployees = employeesForProduct.filter(emp =>
          emp.products.some(product => 
            product.productName === wo.stockItemName && product.qrGenerated === true
          )
        );

        qrGenerationStatus = {
          allGenerated: generatedEmployees.length === employeesForProduct.length && employeesForProduct.length > 0,
          someGenerated: generatedEmployees.length > 0 && generatedEmployees.length < employeesForProduct.length,
          noneGenerated: generatedEmployees.length === 0,
          generatedCount: generatedEmployees.length,
          totalEmployees: employeesForProduct.length
        };

        // Update cutting status based on QR generation
        if (qrGenerationStatus.allGenerated) {
          wo.cuttingStatus = "completed";
        } else if (qrGenerationStatus.someGenerated) {
          wo.cuttingStatus = "in_progress";
        } else {
          wo.cuttingStatus = "pending";
        }
      }

      return {
        ...wo,
        qrGenerationStatus // Include the status object for debugging
      };
    }));

    res.json({
      success: true,
      manufacturingOrder: {
        ...manufacturingOrder,
        orderType: manufacturingOrder.requestType === "measurement_conversion" ? "measurement_conversion" : "customer_bulk_order",
        orderTypeLabel: manufacturingOrder.requestType === "measurement_conversion" ? "Measurement → PO" : "Bulk Order"
      },
      workOrders: enhancedWorkOrders,
      totalWorkOrders: enhancedWorkOrders.length
    });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;

