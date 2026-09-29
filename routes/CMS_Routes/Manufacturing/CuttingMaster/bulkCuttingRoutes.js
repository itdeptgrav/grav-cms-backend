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

/* Cutting only, this company's work only — see cuttingAccess.js. Reading needs
   viewer, recording needs editor (once Cutting grants exist). */
const cutting = require("./cuttingAccess");
const canRead = [cutting.cuttingDepartment("viewer"), cutting.cuttingCompany];
const canRecord = [cutting.cuttingDepartment("editor"), cutting.cuttingCompany];

// ─────────────────────────────────────────────────────────────────────────────
// GET work order details for bulk cutting
// ─────────────────────────────────────────────────────────────────────────────
router.get("/work-orders/:woId/bulk-cutting", ...canRead, async (req, res) => {
  try {
    const { woId } = req.params;

    const workOrder = await cutting.loadScopedWorkOrder(req, res, woId, (q) => q
      .select("workOrderNumber stockItemName stockItemReference quantity variantAttributes cuttingStatus cuttingProgress stockItemId salesLineLink")
      .lean());
    if (!workOrder) return undefined;
    delete workOrder.salesLineLink;

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
        /* "linked" to this company's Sales line, or "unlinked" (historical). */
        companyProof: req.cutting.proof,
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
router.post("/work-orders/:woId/update-cutting", ...canRecord, async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityCut, action = "add" } = req.body;

    const workOrder = await cutting.loadScopedWorkOrder(req, res, woId);
    if (!workOrder) return undefined;

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
router.post("/work-orders/:woId/generate-bulk-barcodes", ...canRecord, async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityToGenerate } = req.body;

    const workOrder = await cutting.loadScopedWorkOrder(req, res, woId,
      (q) => q.populate("stockItemId", "numberOfPanels").lean());
    if (!workOrder) return undefined;

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
router.get("/employees/search", cutting.cuttingDepartment("viewer"), async (req, res) => {
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
/*
 * "Who cut these units?" — the cutting station names the worker, and the
 * record is built from records, not from the body:
 *   · the worker is an existing, active employee, and their name, biometric
 *     id, department and designation are read from THEIR employee record —
 *     a name typed into the body is never stored;
 *   · the WorkOrder is one this company's Cutting may work on, and its number,
 *     item and size are read from it;
 *   · the person who recorded it is the signed-in session.
 * The body may carry only the worker's id, the WorkOrder id, and the cut:
 * quantity and unit range. Anything else it sends is ignored, as before.
 */
router.post("/cutting-master-records", ...canRecord, async (req, res) => {
  try {
    const { employeeId, woId, quantityCut, startUnit, endUnit } = req.body || {};

    if (!cutting.isId(employeeId)) {
      return res.status(400).json({ success: false, message: "Choose who cut these units." });
    }
    if (!cutting.isId(woId)) {
      return res.status(400).json({ success: false, message: "A cutting record needs the work order it was cut for." });
    }
    const worker = await Employee.findOne({ _id: employeeId, isActive: { $ne: false } })
      .select("firstName middleName lastName biometricId department designation")
      .lean();
    if (!worker) {
      return res.status(400).json({ success: false, message: "That employee is not an active employee." });
    }
    const workOrder = await cutting.loadScopedWorkOrder(req, res, woId,
      (q) => q.select("workOrderNumber stockItemName variantAttributes salesLineLink").lean());
    if (!workOrder) return undefined;

    const workerName = [worker.firstName, worker.middleName, worker.lastName].filter(Boolean).join(" ").trim();
    const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const qty = Number(quantityCut) || 0;

    const entry = {
      woId:          workOrder._id,
      woNumber:      workOrder.workOrderNumber || "",
      stockItemName: workOrder.stockItemName || "",
      variants:      (workOrder.variantAttributes || []).map((a) => a.value).filter(Boolean).join(" · "),
      quantityCut:   qty,
      startUnit:     Number(startUnit) || 0,
      endUnit:       Number(endUnit) || 0,
      timestamp:     new Date(),
      recordedBy:    { id: req.user.id, name: req.user.name || "" },
      companyProof:  req.cutting.proof,
    };

    const snapshot = {
      employeeName: workerName,
      biometricId:  worker.biometricId || "",
      department:   worker.department || "",
      designation:  worker.designation || "",
    };

    const append = async () => {
      let record = await CuttingMasterRecord.findOne({ employeeId: worker._id, date: today });
      if (!record) {
        // First cut of the day for this employee
        record = new CuttingMasterRecord({ employeeId: worker._id, ...snapshot, date: today, entries: [], totalUnitsCut: 0 });
      }
      record.entries.push(entry);
      record.totalUnitsCut += qty;
      await record.save();
      return record;
    };

    let record;
    try {
      record = await append();
    } catch (error) {
      if (error.code !== 11000) throw error;
      // Duplicate key — another save made today's record first; add to it.
      record = await append();
    }

    res.status(201).json({
      success: true,
      message: `Cutting record saved for ${record.employeeName}`,
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
    res.status(500).json({ success: false, message: "Server error while saving cutting record" });
  }
});

module.exports = router;