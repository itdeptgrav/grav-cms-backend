// routes/CMS_Routes/Manufacturing/CuttingMaster/bulkCuttingRoutes.js - FIXED VERSION

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// GET work order details for bulk cutting - FIXED PANEL COUNT
router.get("/work-orders/:woId/bulk-cutting", async (req, res) => {
  try {
    const { woId } = req.params;

    // Get work order details
    const workOrder = await WorkOrder.findById(woId)
      .select('workOrderNumber stockItemName stockItemReference quantity variantAttributes cuttingStatus cuttingProgress stockItemId')
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }

    // Get panel count from stock item - FIXED
    let panelCount = 1; // Default
    if (workOrder.stockItemId) {
      const stockItem = await StockItem.findById(workOrder.stockItemId)
        .select('numberOfPanels')
        .lean();
      
      panelCount = stockItem?.numberOfPanels || 1;
    }

    // Initialize cutting progress if not exists
    if (!workOrder.cuttingProgress) {
      workOrder.cuttingProgress = {
        completed: 0,
        remaining: workOrder.quantity || 0
      };
    }

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        panelCount: panelCount, // FIXED: Proper panel count
        cuttingProgress: workOrder.cuttingProgress || {
          completed: 0,
          remaining: workOrder.quantity || 0
        }
      }
    });

  } catch (error) {
    console.error("Error fetching work order for bulk cutting:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order"
    });
  }
});

// POST: Update cutting progress
router.post("/work-orders/:woId/update-cutting", async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityCut, action = "add" } = req.body;

    const workOrder = await WorkOrder.findById(woId);
    
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }

    // Initialize cutting progress if not exists
    if (!workOrder.cuttingProgress) {
      workOrder.cuttingProgress = {
        completed: 0,
        remaining: workOrder.quantity || 0
      };
    }

    // Update cutting progress based on action
    let newCompleted;
    switch (action) {
      case "add":
        newCompleted = Math.min(
          workOrder.cuttingProgress.completed + quantityCut,
          workOrder.quantity
        );
        break;
      case "subtract":
        newCompleted = Math.max(
          workOrder.cuttingProgress.completed - quantityCut,
          0
        );
        break;
      case "set":
        newCompleted = Math.min(Math.max(quantityCut, 0), workOrder.quantity);
        break;
      default:
        newCompleted = workOrder.cuttingProgress.completed;
    }

    workOrder.cuttingProgress.completed = newCompleted;
    workOrder.cuttingProgress.remaining = Math.max(0, workOrder.quantity - newCompleted);

    // Update cutting status based on progress
    if (newCompleted >= workOrder.quantity) {
      workOrder.cuttingStatus = "completed";
    } else if (newCompleted > 0) {
      workOrder.cuttingStatus = "in_progress";
    } else {
      workOrder.cuttingStatus = "pending";
    }

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
    res.status(500).json({
      success: false,
      message: "Server error while updating cutting progress"
    });
  }
});

// POST: Generate barcodes for bulk cutting - FIXED
router.post("/work-orders/:woId/generate-bulk-barcodes", async (req, res) => {
  try {
    const { woId } = req.params;
    const { quantityToGenerate } = req.body;

    // Get work order with stock item
    const workOrder = await WorkOrder.findById(woId)
      .populate('stockItemId', 'numberOfPanels')
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found"
      });
    }

    // Get panel count - FIXED
    const panelCount = workOrder.stockItemId?.numberOfPanels || 1;
    const completed = workOrder.cuttingProgress?.completed || 0;
    const startFromUnit = completed + 1;
    
    console.log(`Panel count: ${panelCount}, Start unit: ${startFromUnit}`);

    // Validate quantity
    if (quantityToGenerate <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1"
      });
    }

    if (quantityToGenerate > (workOrder.quantity - completed)) {
      return res.status(400).json({
        success: false,
        message: `Cannot generate more than ${workOrder.quantity - completed} units`
      });
    }

    // Generate barcodes - FIXED LOGIC
    const barcodes = [];
    let woNumber = workOrder.workOrderNumber || "";
    
    // Ensure WO number has prefix
    if (!woNumber.startsWith('WO-')) {
      woNumber = `WO-${woNumber}`;
    }

    // Generate for each unit and each panel
    for (let i = 0; i < quantityToGenerate; i++) {
      const unitNumber = startFromUnit + i;
      
      for (let panel = 1; panel <= panelCount; panel++) {
        const barcodeId = `${woNumber}-${unitNumber.toString().padStart(3, '0')}`;
        
        barcodes.push({
          id: barcodeId,
          baseId: barcodeId,
          unitNumber: unitNumber,
          panelNumber: panel,
          totalPanels: panelCount,
          sequence: barcodes.length + 1
        });
      }
    }

    console.log(`Generated ${barcodes.length} barcodes for ${quantityToGenerate} units × ${panelCount} panels`);

    res.json({
      success: true,
      message: `Generated ${barcodes.length} barcodes for ${quantityToGenerate} units`,
      barcodes: barcodes,
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
    res.status(500).json({
      success: false,
      message: "Server error while generating barcodes"
    });
  }
});

module.exports = router;