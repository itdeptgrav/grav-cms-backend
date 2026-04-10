// routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes.js
const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
// Add this import at the top
const EmployeeMpc = require("../../../../models/Customer_Models/Employee_Mpc");

const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

router.get("/work-orders/:woId/employee-measurements", async (req, res) => {
  try {
    const { woId } = req.params;

    const workOrder = await WorkOrder.findById(woId)
      .select("workOrderNumber stockItemName stockItemReference quantity variantAttributes customerRequestId stockItemId _id")
      .lean();

    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("numberOfPanels genderCategory gender category")
      .lean();

    const panelCount = stockItem?.numberOfPanels || 1;
    const genderCategory =
      stockItem?.genderCategory ||
      stockItem?.gender ||
      stockItem?.category ||
      null;

    const measurement = await Measurement.findOne({
      poRequestId: workOrder.customerRequestId,
    }).lean();

    if (!measurement) {
      return res.status(404).json({ success: false, message: "No measurement data found" });
    }

    const progressDocs = await EmployeeProductionProgress.find({
      workOrderId: workOrder._id,
    })
      .select("employeeId employeeName employeeUIN gender unitStart unitEnd totalUnits completedUnits completionPercentage assignedBarcodeIds isDispatched")
      .lean();

    const progressByEmployee = new Map();
    for (const doc of progressDocs) {
      progressByEmployee.set(doc.employeeId.toString(), doc);
    }

    // ── Fetch dept/designation from EmployeeMpc ───────────────────────────
    const employeeIds = (measurement.employeeMeasurements || [])
      .map((e) => e.employeeId)
      .filter(Boolean);

    const mpcDocs = await EmployeeMpc.find({ _id: { $in: employeeIds } })
      .select("_id department designation")
      .lean();

    const mpcById = new Map();
    for (const doc of mpcDocs) {
      mpcById.set(doc._id.toString(), doc);
    }
    // ─────────────────────────────────────────────────────────────────────

    const employeeMeasurements = [];

    for (const emp of measurement.employeeMeasurements || []) {
      const empIdStr = emp.employeeId?.toString();
      const progress = progressByEmployee.get(empIdStr);

      if (!progress) continue;

      const productEntry = (emp.products || []).find((p) => {
        const pIdStr = p.productId?.toString();
        return (
          pIdStr === workOrder.stockItemId?.toString() ||
          p.productName === workOrder.stockItemName
        );
      });

      employeeMeasurements.push({
        employeeId:   empIdStr,
        employeeName: emp.employeeName,
        employeeUIN:  emp.employeeUIN,
        gender:       emp.gender,
        department:   mpcById.get(empIdStr)?.department || "",
        designation:  mpcById.get(empIdStr)?.designation || "",
        quantity:     progress.totalUnits,
        unitStart:    progress.unitStart,
        unitEnd:      progress.unitEnd,
        measurements: productEntry?.measurements || [],
        qrGenerated:  productEntry?.qrGenerated || false,
        completedUnits:       progress.completedUnits || 0,
        completionPercentage: progress.completionPercentage || 0,
        isDispatched:         progress.isDispatched || false,
      });
    }

    const genderOrder = { M: 0, Male: 0, m: 0, F: 1, Female: 1, f: 1 };
    employeeMeasurements.sort((a, b) => {
      const ga = genderOrder[a.gender] ?? 2;
      const gb = genderOrder[b.gender] ?? 2;
      return ga - gb;
    });

    res.json({
      success: true,
      workOrder: {
        _id:                workOrder._id,
        workOrderNumber:    workOrder.workOrderNumber,
        workOrderId:        workOrder._id.toString(),
        stockItemName:      workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity:           workOrder.quantity,
        panelCount,
        genderCategory,
        variantAttributes: workOrder.variantAttributes || [],
      },
      measurement: {
        _id:  measurement._id,
        name: measurement.name,
      },
      employeeMeasurements,
      totalEmployees: employeeMeasurements.length,
    });
  } catch (error) {
    console.error("Error fetching employee measurements:", error);
    res.status(500).json({ success: false, message: "Server error while fetching employee measurements" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST: Update QR generated status
// ─────────────────────────────────────────────────────────────────────────────
router.post("/employee-measurements/:measurementId/update-status", async (req, res) => {
  try {
    const { measurementId } = req.params;
    const { employeeId, productName } = req.body;

    const measurement = await Measurement.findOne({
      _id: measurementId,
      "employeeMeasurements.employeeId": employeeId,
    });

    if (!measurement) {
      return res.status(404).json({ success: false, message: "Measurement not found" });
    }

    let updated = false;
    measurement.employeeMeasurements.forEach((emp) => {
      if (emp.employeeId.toString() === employeeId) {
        emp.products.forEach((product) => {
          if (product.productName === productName) {
            product.qrGenerated = true;
            updated = true;
          }
        });
      }
    });

    if (!updated) {
      return res.status(404).json({ success: false, message: "Product not found for this employee" });
    }

    await measurement.save();
    res.json({ success: true, message: "Status updated successfully" });
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({ success: false, message: "Server error while updating status" });
  }
});

module.exports = router;