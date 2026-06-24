// routes/CMS_Routes/Manufacturing/CuttingMaster/bulkCuttingRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Employee = require("../../../../models/Employee");
const CuttingMasterRecord = require("../../../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingMasterRecord");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// GET work order details for bulk cutting
// ─────────────────────────────────────────────────────────────────────────────
router.get("/work-orders/:woId/bulk-cutting", async (req, res) => {
  try {
    const { woId } = req.params;

    const workOrder = await WorkOrder.findById(woId)
      .select("workOrderNumber stockItemName stockItemReference quantity variantAttributes cuttingStatus cuttingProgress stockItemId")
      .lean();

    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    let panelCount = 1;
    if (workOrder.stockItemId) {
      const stockItem = await StockItem.findById(workOrder.stockItemId).select("numberOfPanels").lean();
      panelCount = stockItem?.numberOfPanels || 1;
    }

    if (!workOrder.cuttingProgress) {
      workOrder.cuttingProgress = { completed: 0, remaining: workOrder.quantity || 0 };
    }

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        panelCount,
        cuttingProgress: workOrder.cuttingProgress || { completed: 0, remaining: workOrder.quantity || 0 }
      }
    });
  } catch (error) {
    console.error("Error fetching work order for bulk cutting:", error);
    res.status(500).json({ success: false, message: "Server error while fetching work order" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST: Update cutting progress
// ─────────────────────────────────────────────────────────────────────────────
router.post("/work-orders/:woId/update-cutting", async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityCut, action = "add" } = req.body;

    const workOrder = await WorkOrder.findById(woId);
    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    if (!workOrder.cuttingProgress) {
      workOrder.cuttingProgress = { completed: 0, remaining: workOrder.quantity || 0 };
    }

    let newCompleted;
    switch (action) {
      case "add":
        newCompleted = Math.min(workOrder.cuttingProgress.completed + quantityCut, workOrder.quantity);
        break;
      case "subtract":
        newCompleted = Math.max(workOrder.cuttingProgress.completed - quantityCut, 0);
        break;
      case "set":
        newCompleted = Math.min(Math.max(quantityCut, 0), workOrder.quantity);
        break;
      default:
        newCompleted = workOrder.cuttingProgress.completed;
    }

    workOrder.cuttingProgress.completed = newCompleted;
    workOrder.cuttingProgress.remaining = Math.max(0, workOrder.quantity - newCompleted);

    if (newCompleted >= workOrder.quantity) workOrder.cuttingStatus = "completed";
    else if (newCompleted > 0) workOrder.cuttingStatus = "in_progress";
    else workOrder.cuttingStatus = "pending";

    await workOrder.save();

    res.json({
      success: true,
      message: `Cutting progress updated: ${newCompleted}/${workOrder.quantity} units completed`,
      workOrder: {
        workOrderNumber: workOrder.workOrderNumber,
        cuttingStatus: workOrder.cuttingStatus,
        cuttingProgress: workOrder.cuttingProgress,
        totalQuantity: workOrder.quantity
      }
    });
  } catch (error) {
    console.error("Error updating cutting progress:", error);
    res.status(500).json({ success: false, message: "Server error while updating cutting progress" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST: Generate barcodes for bulk cutting
// ─────────────────────────────────────────────────────────────────────────────
router.post("/work-orders/:woId/generate-bulk-barcodes", async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityToGenerate } = req.body;

    const workOrder = await WorkOrder.findById(woId).populate("stockItemId", "numberOfPanels").lean();
    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    const panelCount = workOrder.stockItemId?.numberOfPanels || 1;
    const completed = workOrder.cuttingProgress?.completed || 0;
    const startFromUnit = completed + 1;

    if (quantityToGenerate <= 0) {
      return res.status(400).json({ success: false, message: "Quantity must be at least 1" });
    }
    if (quantityToGenerate > (workOrder.quantity - completed)) {
      return res.status(400).json({ success: false, message: `Cannot generate more than ${workOrder.quantity - completed} units` });
    }

    const barcodes = [];
    let woNumber = workOrder.workOrderNumber || "";
    if (!woNumber.startsWith("WO-")) woNumber = `WO-${woNumber}`;

    for (let i = 0; i < quantityToGenerate; i++) {
      const unitNumber = startFromUnit + i;
      for (let panel = 1; panel <= panelCount; panel++) {
        const barcodeId = `${woNumber}-${unitNumber.toString().padStart(3, "0")}`;
        barcodes.push({ id: barcodeId, baseId: barcodeId, unitNumber, panelNumber: panel, totalPanels: panelCount, sequence: barcodes.length + 1 });
      }
    }

    res.json({
      success: true,
      message: `Generated ${barcodes.length} barcodes for ${quantityToGenerate} units`,
      barcodes,
      barcodeInfo: {
        totalBarcodes: barcodes.length,
        panelsPerUnit: panelCount,
        startUnit: startFromUnit,
        endUnit: startFromUnit + quantityToGenerate - 1,
        barcodeFormat: `${woNumber}-[Unit3]`
      }
    });
  } catch (error) {
    console.error("Error generating bulk barcodes:", error);
    res.status(500).json({ success: false, message: "Server error while generating barcodes" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET: Search employees (for cutting master selection)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/employees/search", async (req, res) => {
  try {
    const { q = "" } = req.query;
    if (!q.trim()) return res.json({ success: true, employees: [] });

    const regex = { $regex: q.trim(), $options: "i" };

    const employees = await Employee.find({
      isActive: true,
      $or: [
        { firstName: regex },
        { lastName: regex },
        { biometricId: regex },
        { identityId: regex }
      ]
    })
      .select("firstName middleName lastName biometricId department designation")
      .limit(12)
      .lean();

    const formatted = employees.map(e => ({
      _id: e._id,
      name: [e.firstName, e.middleName, e.lastName].filter(Boolean).join(" ").trim(),
      biometricId: e.biometricId || "",
      department:  e.department || "",
      designation: e.designation || ""
    }));

    res.json({ success: true, employees: formatted });
  } catch (error) {
    console.error("Error searching employees:", error);
    res.status(500).json({ success: false, message: "Server error while searching employees" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST: Save cutting master daily record (upsert per employee per day)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/cutting-master-records", async (req, res) => {
  try {
    const {
      employeeId, employeeName, biometricId, department, designation,
      woId, woNumber, stockItemName, variants,
      quantityCut, startUnit, endUnit
    } = req.body;

    if (!employeeId || !employeeName) {
      return res.status(400).json({ success: false, message: "Employee info is required" });
    }

    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    const entry = {
      woId:          woId || null,
      woNumber:      woNumber || "",
      stockItemName: stockItemName || "",
      variants:      variants || "",
      quantityCut:   quantityCut || 0,
      startUnit:     startUnit || 0,
      endUnit:       endUnit || 0,
      timestamp:     new Date()
    };

    // Find existing doc for this employee + today
    let record = await CuttingMasterRecord.findOne({ employeeId, date: today });

    if (!record) {
      // First cut of the day for this employee
      record = new CuttingMasterRecord({
        employeeId,
        employeeName: employeeName.trim(),
        biometricId:  biometricId || "",
        department:   department  || "",
        designation:  designation || "",
        date:         today,
        entries:      [],
        totalUnitsCut: 0
      });
    }

    record.entries.push(entry);
    record.totalUnitsCut += (quantityCut || 0);
    await record.save();

    res.status(201).json({
      success: true,
      message: `Cutting record saved for ${employeeName}`,
      record: {
        _id:          record._id,
        employeeName: record.employeeName,
        date:         record.date,
        totalUnitsCut: record.totalUnitsCut,
        entriesCount: record.entries.length
      }
    });
  } catch (error) {
    console.error("Error saving cutting master record:", error);
    if (error.code === 11000) {
      // Duplicate key — race condition, retry with findOne + push
      try {
        const today = new Date().toISOString().slice(0, 10);
        const { employeeId, employeeName, woId, woNumber, stockItemName, variants, quantityCut, startUnit, endUnit } = req.body;
        const record = await CuttingMasterRecord.findOne({ employeeId, date: today });
        if (record) {
          record.entries.push({ woId, woNumber: woNumber || "", stockItemName: stockItemName || "", variants: variants || "", quantityCut: quantityCut || 0, startUnit: startUnit || 0, endUnit: endUnit || 0, timestamp: new Date() });
          record.totalUnitsCut += (quantityCut || 0);
          await record.save();
          return res.status(201).json({ success: true, message: "Cutting record saved (retry)", record });
        }
      } catch (retryErr) {
        console.error("Retry failed:", retryErr);
      }
    }
    res.status(500).json({ success: false, message: "Server error while saving cutting record" });
  }
});

module.exports = router;