// routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes.js
const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// GET employee measurements for a specific work order
router.get("/work-orders/:woId/employee-measurements", async (req, res) => {
  try {
    const { woId } = req.params;

    // Get work order details WITH ALL FIELDS
    const workOrder = await WorkOrder.findById(woId)
      .select('workOrderNumber stockItemName stockItemReference quantity variantAttributes customerRequestId stockItemId _id')
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }

    console.log("Fetched work order:", {
      id: workOrder._id,
      workOrderNumber: workOrder.workOrderNumber,
      hasWorkOrderNumber: !!workOrder.workOrderNumber
    });

    // Get panel count
    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select('numberOfPanels')
      .lean();
    
    const panelCount = stockItem?.numberOfPanels || 1;

    // Find measurement by poRequestId
    const measurement = await Measurement.findOne({
      poRequestId: workOrder.customerRequestId
    }).lean();

    if (!measurement) {
      return res.status(404).json({
        success: false,
        message: "No measurement data found"
      });
    }

    // Get all employee measurements for this product
    const employeeMeasurements = [];
    
    measurement.employeeMeasurements.forEach(emp => {
      emp.products.forEach(product => {
        if (product.productName === workOrder.stockItemName) {
          employeeMeasurements.push({
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN,
            gender: emp.gender,
            quantity: product.quantity || 1,
            measurements: product.measurements || [],
            qrGenerated: product.qrGenerated || false
          });
        }
      });
    });

    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber, // THIS MIGHT BE EMPTY
        workOrderId: workOrder._id.toString(), // ADD THIS
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity,
        panelCount: panelCount,
        variantAttributes: workOrder.variantAttributes || []
      },
      measurement: {
        _id: measurement._id,
        name: measurement.name
      },
      employeeMeasurements: employeeMeasurements,
      totalEmployees: employeeMeasurements.length
    });

  } catch (error) {
    console.error("Error fetching employee measurements:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching employee measurements"
    });
  }
});

// POST: Update QR generated status
router.post("/employee-measurements/:measurementId/update-status", async (req, res) => {
  try {
    const { measurementId } = req.params;
    const { employeeId, productName } = req.body;

    const measurement = await Measurement.findOne({
      _id: measurementId,
      "employeeMeasurements.employeeId": employeeId
    });

    if (!measurement) {
      return res.status(404).json({
        success: false,
        message: "Measurement not found"
      });
    }

    // Find and update the product
    let updated = false;
    measurement.employeeMeasurements.forEach(emp => {
      if (emp.employeeId.toString() === employeeId) {
        emp.products.forEach(product => {
          if (product.productName === productName) {
            product.qrGenerated = true;
            updated = true;
          }
        });
      }
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Product not found for this employee"
      });
    }

    await measurement.save();

    res.json({
      success: true,
      message: "Status updated successfully"
    });

  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating status"
    });
  }
});

module.exports = router;