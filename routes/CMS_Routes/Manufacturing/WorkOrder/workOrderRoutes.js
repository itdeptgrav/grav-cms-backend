// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Employee = require("../../../../models/Employee");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const mongoose = require("mongoose");

const PDFDocument = require("pdfkit");
const streamBuffers = require("stream-buffers");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Convert `quantity` from `fromUnit` → `toUnit` using Unit collection.
// ─────────────────────────────────────────────────────────────────────────────
async function convertQuantity(quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return quantity;
  if (!quantity || isNaN(quantity)) return quantity;

  try {
    const fromDoc = await Unit.findOne({ name: fromUnit })
      .populate("conversions.toUnit", "name")
      .lean();

    if (fromDoc) {
      const direct = (fromDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === toUnit
      );
      if (direct?.quantity) {
        return quantity * direct.quantity;
      }
    }

    const toDoc = await Unit.findOne({ name: toUnit })
      .populate("conversions.toUnit", "name")
      .lean();

    if (toDoc) {
      const reverse = (toDoc.conversions || []).find(
        c => (c.toUnit?.name || c.toUnit) === fromUnit
      );
      if (reverse?.quantity) {
        return quantity / reverse.quantity;
      }
    }

    console.warn(
      `[convertQuantity] No path "${fromUnit}"→"${toUnit}". Returning original ${quantity}.`
    );
    return quantity;
  } catch (err) {
    console.error("[convertQuantity]", err.message);
    return quantity;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const _parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2], 10),
        operationNumber: parts[3] ? parseInt(parts[3], 10) : null,
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
};

const _deriveOpNumber = (machineId, workOrder) => {
  if (!machineId || !workOrder?.operations) return null;
  const mStr = machineId.toString();
  for (let i = 0; i < workOrder.operations.length; i++) {
    const op = workOrder.operations[i];
    if (op.assignedMachine && op.assignedMachine.toString() === mStr) return i + 1;
    if (op.additionalMachines?.some(
      (am) => am.assignedMachine && am.assignedMachine.toString() === mStr
    )) return i + 1;
  }
  return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/piece-history
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/piece-history", async (req, res) => {
  try {
    const { id } = req.params;
    const unitNumber = parseInt(req.query.unitNumber, 10);

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    }
    if (isNaN(unitNumber) || unitNumber < 1) {
      return res.status(400).json({ success: false, message: "unitNumber query param is required (integer ≥ 1)" });
    }

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity operations stockItemName")
      .lean();

    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }
    if (unitNumber > workOrder.quantity) {
      return res.status(400).json({
        success: false,
        message: `Unit number ${unitNumber} exceeds work order quantity (${workOrder.quantity})`,
      });
    }

    const woShortId = workOrder._id.toString().slice(-8);

    const allTrackingDocs = await ProductionTracking.find({})
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const matchingScans = [];
    const operatorIdsSet = new Set();

    for (const doc of allTrackingDocs) {
      const scanDate = doc.date;
      for (const machine of doc.machines || []) {
        const machineId = machine.machineId?._id?.toString();
        const machineName = machine.machineId?.name || "Unknown";
        for (const operator of machine.operators || []) {
          const opId = operator.operatorIdentityId;
          if (opId) operatorIdsSet.add(opId);
          for (const scan of operator.barcodeScans || []) {
            const parsed = _parseBarcode(scan.barcodeId);
            if (!parsed.success) continue;
            if (parsed.workOrderShortId !== woShortId) continue;
            if (parsed.unitNumber !== unitNumber) continue;
            matchingScans.push({
              machineId, machineName, operatorId: opId, operatorName: null,
              signInTime: operator.signInTime, signOutTime: operator.signOutTime,
              scanTime: scan.timeStamp, barcodeId: scan.barcodeId,
              operationNumber: parsed.operationNumber, scanDate,
            });
          }
        }
      }
    }

    const employees = await Employee.find({ identityId: { $in: [...operatorIdsSet] } })
      .select("identityId firstName lastName").lean();

    const employeeMap = new Map(
      employees.map((e) => [e.identityId, `${e.firstName || ""} ${e.lastName || ""}`.trim()])
    );
    matchingScans.forEach((scan) => {
      scan.operatorName = employeeMap.get(scan.operatorId) || scan.operatorId || "Unknown";
    });

    const enrichedScans = matchingScans.map((scan) => {
      if (scan.operationNumber) return scan;
      const derived = _deriveOpNumber(scan.machineId, workOrder);
      return { ...scan, operationNumber: derived };
    });

    const opMap = new Map();
    for (const scan of enrichedScans) {
      const key = scan.operationNumber ?? 0;
      if (!opMap.has(key)) opMap.set(key, new Map());
      const oprMap = opMap.get(key);
      const oprKey = scan.operatorId;
      if (!oprMap.has(oprKey)) {
        oprMap.set(oprKey, {
          operatorId: scan.operatorId, operatorName: scan.operatorName,
          scans: [], signInTime: scan.signInTime, signOutTime: scan.signOutTime,
        });
      }
      oprMap.get(oprKey).scans.push(scan.scanTime);
    }

    const totalOps = workOrder.operations?.length || 0;

    const buildOperators = (oprMap) =>
      [...oprMap.values()].map((e) => {
        const sorted = e.scans.filter(Boolean).map((t) => new Date(t)).sort((a, b) => a - b);
        const firstScan = sorted[0] || null;
        const lastScan  = sorted[sorted.length - 1] || null;
        const durationMs = e.signInTime && e.signOutTime
          ? new Date(e.signOutTime) - new Date(e.signInTime)
          : firstScan && lastScan && lastScan - firstScan > 0
            ? lastScan - firstScan : 0;
        const dateSet = new Set(sorted.map((t) => t.toISOString().split("T")[0]));
        return {
          operatorId: e.operatorId, operatorName: e.operatorName,
          firstScanTime: firstScan, lastScanTime: lastScan,
          durationMs, scansCount: e.scans.length, dates: [...dateSet],
        };
      }).sort((a, b) => new Date(a.firstScanTime) - new Date(b.firstScanTime));

    const operations = [];
    if (totalOps > 0) {
      for (let i = 0; i < workOrder.operations.length; i++) {
        const opNum = i + 1;
        const woOp  = workOrder.operations[i];
        const oprMap = opMap.get(opNum);
        operations.push({
          operationNumber: opNum,
          operationType: woOp.operationType || `Operation ${opNum}`,
          assignedMachineName: woOp.assignedMachineName || null,
          operators: oprMap ? buildOperators(oprMap) : [],
        });
      }
    } else {
      for (const [opNum, oprMap] of opMap) {
        if (opNum === 0) continue;
        operations.push({
          operationNumber: opNum, operationType: `Operation ${opNum}`,
          assignedMachineName: null, operators: buildOperators(oprMap),
        });
      }
    }

    if (opMap.has(0)) {
      operations.push({
        operationNumber: null, operationType: "Unknown Operation",
        assignedMachineName: null, operators: buildOperators(opMap.get(0)),
      });
    }

    return res.json({
      success: true, unitNumber,
      workOrderId: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
      stockItemName: workOrder.stockItemName,
      totalScansFound: matchingScans.length, operations,
    });
  } catch (error) {
    console.error("Error fetching piece history:", error);
    res.status(500).json({ success: false, message: "Server error while fetching piece history", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /machine-status
// ─────────────────────────────────────────────────────────────────────────────
router.get("/machine-status", async (req, res) => {
  try {
    const allMachines = await Machine.find({}).lean();

    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow    = new Date(Date.now() + istOffset);
    const todayDate = new Date(istNow.toISOString().split("T")[0]);
    todayDate.setHours(0, 0, 0, 0);

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type").lean();

    const activeTodayMap = new Map();
    if (todayTracking) {
      for (const m of todayTracking.machines || []) {
        const mId = m.machineId?._id?.toString();
        if (!mId) continue;
        const isActive = (m.operationTracking || []).some(op => op.currentOperatorIdentityId);
        activeTodayMap.set(mId, isActive);
      }
    }

    const activeWOs = await WorkOrder.find({
      status: { $in: ["in_progress", "scheduled", "ready_to_start"] },
    }).select("workOrderNumber stockItemName status quantity operations timeline productionCompletion").lean();

    const woByMachineMap = new Map();
    for (const wo of activeWOs) {
      for (const op of wo.operations || []) {
        if (op.assignedMachine) {
          const mId = op.assignedMachine.toString();
          if (!woByMachineMap.has(mId)) woByMachineMap.set(mId, { wo, op });
        }
        for (const am of op.additionalMachines || []) {
          if (am.assignedMachine) {
            const mId = am.assignedMachine.toString();
            if (!woByMachineMap.has(mId)) woByMachineMap.set(mId, { wo, op });
          }
        }
      }
    }

    const machines = allMachines.map(machine => {
      const mId        = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woEntry    = woByMachineMap.get(mId);

      let status = "free";
      if (machine.status === "Under Maintenance" || machine.status === "maintenance") status = "maintenance";
      else if (machine.status === "Offline" || machine.status === "offline") status = "offline";
      else if (woEntry || isActiveNow) status = "busy";

      let currentWorkOrder = null;
      if (woEntry) {
        const wo  = woEntry.wo;
        const pct = wo.quantity > 0
          ? Math.round(((wo.productionCompletion?.overallCompletedQuantity || 0) / wo.quantity) * 100) : 0;
        const totalSecs  = wo.timeline?.totalPlannedSeconds || 0;
        const remainSecs = Math.max(0, totalSecs * ((100 - pct) / 100));
        currentWorkOrder = {
          _id: wo._id, workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName, status: wo.status, quantity: wo.quantity,
          completionPercentage: pct, totalPlannedSeconds: totalSecs,
          remainingSeconds: remainSecs,
          estimatedFreeAt: remainSecs > 0 ? new Date(Date.now() + remainSecs * 1000) : null,
        };
      }

      return {
        _id: machine._id, name: machine.name, serialNumber: machine.serialNumber,
        type: machine.type, model: machine.model || null, location: machine.location || null,
        status, currentWorkOrder, isActiveToday: isActiveNow,
        freeFromDate: status === "free" ? (machine.updatedAt || null) : null,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
      };
    });

    res.json({
      success: true, machines,
      summary: {
        total: machines.length,
        free: machines.filter(m => m.status === "free").length,
        busy: machines.filter(m => m.status === "busy").length,
        maintenance: machines.filter(m => m.status === "maintenance").length,
        offline: machines.filter(m => m.status === "offline").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machine status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id  — single work order (optimised)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    }

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber status priority quantity stockItemName stockItemReference variantAttributes specialInstructions createdAt estimatedCost rawMaterials operations planningNotes")
      .populate("plannedBy", "name").lean();

    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const panelCount = await getPanelCount(workOrder.stockItemId);

    const optimizedRawMaterials = (workOrder.rawMaterials || []).map((rm) => ({
      name: rm.name, sku: rm.sku, unit: rm.unit, unitCost: rm.unitCost, totalCost: rm.totalCost,
      quantityRequired: rm.quantityRequired, quantityAllocated: rm.quantityAllocated || 0,
      quantityIssued: rm.quantityIssued || 0, allocationStatus: rm.allocationStatus || "not_allocated",
      rawItemVariantId: rm.rawItemVariantId, rawItemVariantCombination: rm.rawItemVariantCombination || [],
      variantName: rm.rawItemVariantCombination?.join(" • ") ||
        (rm.rawItemVariantId ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}` : "Default"),
    }));

    const optimizedOperations = (workOrder.operations || []).map((op) => ({
      _id: op._id, operationType: op.operationType, machineType: op.machineType,
      status: op.status || "pending", notes: op.notes || "",
      estimatedTimeSeconds: op.estimatedTimeSeconds || 0,
      plannedTimeSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
      maxAllowedSeconds: op.maxAllowedSeconds || (op.estimatedTimeSeconds ? Math.ceil(op.estimatedTimeSeconds / 0.7) : 0),
      assignedMachine: op.assignedMachine, assignedMachineName: op.assignedMachineName,
      assignedMachineSerial: op.assignedMachineSerial,
      additionalMachines: (op.additionalMachines || []).map((am) => ({
        assignedMachine: am.assignedMachine, assignedMachineName: am.assignedMachineName,
        assignedMachineSerial: am.assignedMachineSerial, notes: am.notes || "",
      })),
    }));

    const totalPlannedSeconds = optimizedOperations.reduce((s, op) => s + (op.plannedTimeSeconds || 0), 0);
    const rawMaterialStats = {
      total: optimizedRawMaterials.length,
      fullyAllocated: optimizedRawMaterials.filter(rm => ["fully_allocated", "issued"].includes(rm.allocationStatus)).length,
      partiallyAllocated: optimizedRawMaterials.filter(rm => rm.allocationStatus === "partially_allocated").length,
      notAllocated: optimizedRawMaterials.filter(rm => rm.allocationStatus === "not_allocated").length,
      variantSpecific: optimizedRawMaterials.filter(rm => rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0).length,
    };

    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, status: workOrder.status,
        priority: workOrder.priority, quantity: workOrder.quantity,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        variantAttributes: workOrder.variantAttributes || [], specialInstructions: workOrder.specialInstructions || [],
        estimatedCost: workOrder.estimatedCost || 0, createdAt: workOrder.createdAt,
        plannedBy: workOrder.plannedBy?.name || null,
        panelCount,
        totalBarcodes: panelCount > 0
          ? workOrder.quantity * panelCount
          : workOrder.quantity * optimizedOperations.length,
        totalPlannedSeconds,
        needsPlanning: optimizedRawMaterials.some(rm => rm.allocationStatus === "not_allocated") ||
          optimizedOperations.some(op => !op.assignedMachine),
        rawMaterialStats,
        rawMaterials: optimizedRawMaterials,
        operations: optimizedOperations,
      },
    });
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({ success: false, message: "Server error while fetching work order" });
  }
});

async function getPanelCount(stockItemId) {
  try {
    if (!stockItemId) return 0;
    const stockItem = await StockItem.findById(stockItemId).select("numberOfPanels").lean();
    return stockItem?.numberOfPanels || 0;
  } catch { return 0; }
}

router.get("/stock-items/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .select("name reference numberOfPanels operations variants images").lean();
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    res.json({ success: true, stockItem });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching stock item" });
  }
});

router.get("/:id/panel-count", async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.id)
      .populate("stockItemId", "name reference numberOfPanels").lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });
    const stockItem = await StockItem.findById(workOrder.stockItemId).select("numberOfPanels").lean();
    res.json({
      success: true, panelCount: stockItem?.numberOfPanels || 0,
      workOrder: { workOrderNumber: workOrder.workOrderNumber, quantity: workOrder.quantity, stockItemName: workOrder.stockItemName },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching panel count" });
  }
});

router.get("/:id/with-panels", async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.id)
      .populate("stockItemId", "name reference numberOfPanels")
      .populate("customerRequestId", "customerInfo requestId").lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });
    const stockItem = await StockItem.findById(workOrder.stockItemId);
    res.json({ success: true, workOrder: { ...workOrder, numberOfPanels: stockItem?.numberOfPanels || 1 } });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching work order" });
  }
});

router.get("/:id/with-details", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid work order ID" });
    }
    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels operations variants")
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .populate("rawMaterials.rawItemId", "name sku quantity").lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });
    res.json({ success: true, workOrder, stockItem: workOrder.stockItemId, numberOfPanels: workOrder.stockItemId?.numberOfPanels || 1 });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching work order details" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/planning
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/planning", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference operations rawItems")
      .populate({
        path: "customerRequestId",
        select: "customerInfo deliveryDeadline",
        populate: { path: "customerId", select: "shippingAddress billingAddress" },
      }).lean();

    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    let customerWithAddress = null;
    if (workOrder.customerRequestId?.customerId) {
      const Customer = require("../../../../models/Customer_Models/Customer");
      customerWithAddress = await Customer.findById(workOrder.customerRequestId.customerId)
        .select("shippingAddress billingAddress phone email").lean();
    }

    const customerInfo = {
      ...workOrder.customerRequestId?.customerInfo,
      address:
        customerWithAddress?.shippingAddress?.fullAddress ||
        customerWithAddress?.billingAddress?.fullAddress ||
        workOrder.customerRequestId?.customerInfo?.address ||
        "Address not available",
    };

    const stockItem = await StockItem.findById(workOrder.stockItemId).lean();

    let maxProducibleQuantity = workOrder.quantity;

    const rawMaterialsWithStock = await Promise.all(
      workOrder.rawMaterials.map(async (rm) => {
        if (!rm.rawItemId) return rm;

        const rawItem = await RawItem.findById(rm.rawItemId).lean();
        if (!rawItem) return rm;

        const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
        const requiredPerUnitBom = rm.quantityRequired / workOrder.quantity;
        const requiredPerUnit =
          rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
            ? await convertQuantity(requiredPerUnitBom, rm.unit, rawItemRegisteredUnit)
            : requiredPerUnitBom;

        let maxUnitsFromThisMaterial = 0;
        let currentStock = 0;
        let status = "insufficient";

        if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
          let variant = null;
          if (rm.rawItemVariantId && rawItem.variants) {
            variant = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
          } else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants) {
            variant = rawItem.variants.find(v => {
              if (!v.combination || v.combination.length !== rm.rawItemVariantCombination.length) return false;
              return v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx]);
            });
          }
          if (variant) {
            currentStock = variant.quantity || 0;
            maxUnitsFromThisMaterial = requiredPerUnit > 0 ? Math.floor(currentStock / requiredPerUnit) : 0;
          }
        } else {
          currentStock = rawItem.quantity || 0;
          maxUnitsFromThisMaterial = requiredPerUnit > 0 ? Math.floor(currentStock / requiredPerUnit) : 0;
        }

        maxProducibleQuantity = Math.min(maxProducibleQuantity, maxUnitsFromThisMaterial);

        if (maxUnitsFromThisMaterial >= workOrder.quantity) status = "sufficient";
        else if (maxUnitsFromThisMaterial > 0) status = "partial";
        else status = "insufficient";

        return {
          ...rm,
          currentStock,
          requiredPerUnit,
          requiredPerUnitBom,
          maxUnitsFromThisMaterial,
          status,
          rawItemRegisteredUnit,
          variantName: rm.rawItemVariantCombination?.join(" • ") ||
            (rm.rawItemVariantId ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}` : "Default"),
        };
      })
    );

    const operationsWithMachines = await Promise.all(
      workOrder.operations.map(async (op) => {
        const availableMachines = await Machine.find({ type: op.machineType, status: "Operational" }).lean();
        const maxAllowedSeconds = op.estimatedTimeSeconds ? Math.ceil(op.estimatedTimeSeconds / 0.7) : 0;
        return {
          ...op,
          availableMachines: availableMachines || [],
          maxAllowedSeconds,
          plannedTimeSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
        };
      })
    );

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        operations: operationsWithMachines,
        rawMaterials: rawMaterialsWithStock,
        maxProducibleQuantity: Math.max(1, maxProducibleQuantity),
        stockItemOperations: stockItem?.operations || [],
        customerRequestId: workOrder.customerRequestId
          ? { ...workOrder.customerRequestId, customerInfo, deliveryDeadline: workOrder.customerRequestId.deliveryDeadline }
          : null,
      },
    });
  } catch (error) {
    console.error("Error fetching work order for planning:", error);
    res.status(500).json({ success: false, message: "Server error while fetching work order details" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/allocate-raw-materials
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/allocate-raw-materials", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, splitRemaining = false, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    if (quantity <= 0) return res.status(400).json({ success: false, message: "Quantity must be at least 1" });
    if (quantity > workOrder.quantity) return res.status(400).json({ success: false, message: "Quantity cannot exceed original work order quantity" });

    if (!workOrder.originalQuantity) workOrder.originalQuantity = workOrder.quantity;

    const remainingQuantity = workOrder.quantity - quantity;
    let newWorkOrder = null;

    let canProduceQuantity = workOrder.quantity;

    for (const rm of workOrder.rawMaterials) {
      if (!rm.rawItemId) continue;
      const rawItem = await RawItem.findById(rm.rawItemId);
      if (!rawItem) continue;

      const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
      const requiredPerUnitBom    = workOrder.quantity > 0 ? rm.quantityRequired / workOrder.quantity : 0;
      const requiredPerUnit       =
        rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
          ? await convertQuantity(requiredPerUnitBom, rm.unit, rawItemRegisteredUnit)
          : requiredPerUnitBom;

      if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
        let variantStock = 0;
        if (rm.rawItemVariantId && rawItem.variants) {
          const v = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
          if (v) variantStock = v.quantity || 0;
        } else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants) {
          const v = rawItem.variants.find(v => {
            if (!v.combination || v.combination.length !== rm.rawItemVariantCombination.length) return false;
            return v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx]);
          });
          if (v) variantStock = v.quantity || 0;
        }
        canProduceQuantity = Math.min(
          canProduceQuantity,
          requiredPerUnit > 0 ? Math.floor(variantStock / requiredPerUnit) : 0
        );
      } else {
        canProduceQuantity = Math.min(
          canProduceQuantity,
          requiredPerUnit > 0 ? Math.floor(rawItem.quantity / requiredPerUnit) : 0
        );
      }
    }

    if (quantity > canProduceQuantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot produce ${quantity} units. Maximum producible is ${canProduceQuantity} units with current stock.`,
      });
    }

    if (splitRemaining && remainingQuantity > 0) {
      const newRawMaterials = [];
      for (const rm of workOrder.rawMaterials) {
        const requiredPerUnit   = workOrder.quantity > 0 ? rm.quantityRequired / workOrder.quantity : 0;
        const quantityRequired  = requiredPerUnit * remainingQuantity;
        newRawMaterials.push({
          rawItemId: rm.rawItemId, name: rm.name, sku: rm.sku,
          rawItemVariantId: rm.rawItemVariantId,
          rawItemVariantCombination: rm.rawItemVariantCombination || [],
          quantityRequired, quantityAllocated: 0, quantityIssued: 0,
          unit: rm.unit,
          unitCost: rm.unitCost || 0, totalCost: (rm.unitCost || 0) * quantityRequired,
          allocationStatus: "not_allocated", notes: rm.notes || "",
        });
      }

      newWorkOrder = new WorkOrder({
        customerRequestId: workOrder.customerRequestId, stockItemId: workOrder.stockItemId,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        variantId: workOrder.variantId, variantAttributes: workOrder.variantAttributes,
        quantity: remainingQuantity, originalQuantity: remainingQuantity,
        customerId: workOrder.customerId, customerName: workOrder.customerName,
        priority: workOrder.priority, status: "pending",
        operations: workOrder.operations.map(op => ({
          operationType: op.operationType, machineType: op.machineType,
          assignedMachine: null, assignedMachineName: null, assignedMachineSerial: null,
          additionalMachines: [], estimatedTimeSeconds: op.estimatedTimeSeconds,
          plannedTimeSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds,
          maxAllowedSeconds: op.maxAllowedSeconds, status: "pending", notes: op.notes || "",
        })),
        rawMaterials: newRawMaterials,
        timeline: { totalEstimatedSeconds: (workOrder.timeline?.totalEstimatedSeconds || 0) * (remainingQuantity / workOrder.quantity) },
        specialInstructions: workOrder.specialInstructions, createdBy: workOrder.createdBy,
        isSplitOrder: true, parentWorkOrderId: workOrder._id,
        splitReason: "Split due to raw material allocation",
      });
      await newWorkOrder.save();
    }

    workOrder.quantity = quantity;

    for (const rm of workOrder.rawMaterials) {
      const rawItem = await RawItem.findById(rm.rawItemId);

      const requiredPerUnitBom = workOrder.originalQuantity > 0 ? rm.quantityRequired / workOrder.originalQuantity : 0;
      rm.quantityRequired      = isNaN(requiredPerUnitBom * quantity) ? 0 : requiredPerUnitBom * quantity;

      if (!rawItem) { rm.quantityAllocated = 0; rm.allocationStatus = "not_allocated"; continue; }

      const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;

      let availableStock = 0;
      if (rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0) {
        if (rm.rawItemVariantId && rawItem.variants) {
          const v = rawItem.variants.find(v => v._id.toString() === rm.rawItemVariantId.toString());
          if (v) availableStock = v.quantity || 0;
        } else if (rm.rawItemVariantCombination?.length > 0 && rawItem.variants) {
          const v = rawItem.variants.find(v => {
            if (!v.combination || v.combination.length !== rm.rawItemVariantCombination.length) return false;
            return v.combination.every((val, idx) => val === rm.rawItemVariantCombination[idx]);
          });
          if (v) availableStock = v.quantity || 0;
        }
      } else {
        availableStock = rawItem.quantity || 0;
      }

      const availableInBomUnit =
        rm.unit && rawItemRegisteredUnit && rm.unit !== rawItemRegisteredUnit
          ? await convertQuantity(availableStock, rawItemRegisteredUnit, rm.unit)
          : availableStock;

      const maxAllocatable    = Math.min(rm.quantityRequired, availableInBomUnit);
      rm.quantityAllocated    = isNaN(maxAllocatable) ? 0 : maxAllocatable;

      if (rm.quantityAllocated >= rm.quantityRequired) rm.allocationStatus = "fully_allocated";
      else if (rm.quantityAllocated > 0)               rm.allocationStatus = "partially_allocated";
      else                                              rm.allocationStatus = "not_allocated";
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    workOrder.status        = quantity < workOrder.originalQuantity ? "partial_allocation" : "planned";
    await workOrder.save();

    res.json({
      success: true,
      message: `Raw materials allocated successfully for ${quantity} units`,
      workOrder: { _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, quantity: workOrder.quantity },
      newWorkOrder: newWorkOrder ? { _id: newWorkOrder._id, workOrderNumber: newWorkOrder.workOrderNumber, quantity: newWorkOrder.quantity } : null,
      remainingQuantity, splitCreated: !!newWorkOrder,
    });
  } catch (error) {
    console.error("Error allocating raw materials:", error);
    res.status(500).json({ success: false, message: "Server error while allocating raw materials", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /:id/plan-operations
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id/plan-operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { operations, totalPlannedSeconds, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    for (const opUpdate of operations) {
      const operation = workOrder.operations.id(opUpdate._id);
      if (!operation) continue;

      if (opUpdate.assignedMachine) {
        const machine = await Machine.findById(opUpdate.assignedMachine);
        if (machine) {
          operation.assignedMachine      = opUpdate.assignedMachine;
          operation.assignedMachineName  = machine.name;
          operation.assignedMachineSerial = machine.serialNumber;
        }
      }

      if (opUpdate.additionalMachines && Array.isArray(opUpdate.additionalMachines)) {
        operation.additionalMachines = opUpdate.additionalMachines.map(am => ({
          assignedMachine: am.assignedMachine, assignedMachineName: am.assignedMachineName,
          assignedMachineSerial: am.assignedMachineSerial, notes: am.notes || "",
        }));
      }

      if (opUpdate.plannedTimeSeconds && operation.estimatedTimeSeconds > 0) {
        const maxAllowed = Math.ceil(operation.estimatedTimeSeconds / 0.7);
        operation.plannedTimeSeconds = Math.min(opUpdate.plannedTimeSeconds, maxAllowed);
      }

      if (opUpdate.notes) operation.notes = opUpdate.notes;
      operation.status = "scheduled";
    }

    if (totalPlannedSeconds) {
      const totalEstimated = workOrder.operations.reduce((t, op) => t + (op.estimatedTimeSeconds || 0), 0);
      const maxAllowed     = Math.ceil(totalEstimated / 0.7);
      const actualPlanned  = Math.min(totalPlannedSeconds, maxAllowed);
      const ratio          = actualPlanned / totalEstimated;
      workOrder.operations.forEach(op => {
        if (op.estimatedTimeSeconds > 0) op.plannedTimeSeconds = Math.ceil(op.estimatedTimeSeconds * ratio);
      });
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();

    res.json({ success: true, message: "Operations planned successfully", workOrder });
  } catch (error) {
    console.error("Error planning operations:", error);
    res.status(500).json({ success: false, message: "Server error while planning operations" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/complete-planning
// NOTE: Unassigned operations are removed by the frontend before calling this.
//       We do NOT block here if some ops lack machine assignment, since the
//       user is allowed to skip/remove operations intentionally.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/complete-planning", async (req, res) => {
  try {
    const { id } = req.params;
    const { planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    // Only block if raw materials are completely unallocated
    const insufficientAllocations = workOrder.rawMaterials.filter(rm => rm.allocationStatus === "not_allocated");
    if (insufficientAllocations.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some raw materials are not allocated at all",
        insufficientAllocations,
      });
    }

    // ── REMOVED: block on unassigned operations ──
    // Previously this would reject if any operation lacked a machine.
    // Now the frontend removes unassigned ops before reaching this endpoint.

    const stockTransactions = [];

    for (const rawMaterial of workOrder.rawMaterials) {
      if (!rawMaterial.rawItemId || rawMaterial.quantityAllocated <= 0) continue;

      const rawItem = await RawItem.findById(rawMaterial.rawItemId);
      if (!rawItem) continue;

      const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;

      let deductionQty = rawMaterial.quantityAllocated;
      if (rawMaterial.unit && rawItemRegisteredUnit && rawMaterial.unit !== rawItemRegisteredUnit) {
        deductionQty = await convertQuantity(
          rawMaterial.quantityAllocated,
          rawMaterial.unit,
          rawItemRegisteredUnit
        );
        console.log(
          `[complete-planning] "${rawItem.name}": ` +
          `${rawMaterial.quantityAllocated} ${rawMaterial.unit} → ${deductionQty} ${rawItemRegisteredUnit}`
        );
      }

      let previousQuantity        = rawItem.quantity;
      let newQuantity             = previousQuantity;
      let transactionType         = "CONSUME";
      let variantInfo             = "";
      let variantPreviousQuantity = null;
      let variantNewQuantity      = null;

      if (rawMaterial.rawItemVariantId || rawMaterial.rawItemVariantCombination?.length > 0) {
        let variant = null;
        if (rawMaterial.rawItemVariantId && rawItem.variants) {
          variant = rawItem.variants.id(rawMaterial.rawItemVariantId);
        } else if (rawMaterial.rawItemVariantCombination?.length > 0 && rawItem.variants) {
          variant = rawItem.variants.find(v => {
            if (!v.combination || v.combination.length !== rawMaterial.rawItemVariantCombination.length) return false;
            return v.combination.every((val, idx) => val === rawMaterial.rawItemVariantCombination[idx]);
          });
        }

        if (variant) {
          variantPreviousQuantity = variant.quantity;
          variantNewQuantity      = Math.max(0, variantPreviousQuantity - deductionQty);
          variant.quantity        = variantNewQuantity;

          previousQuantity = rawItem.quantity;
          newQuantity      = Math.max(0, rawItem.quantity - deductionQty);
          rawItem.quantity = newQuantity;

          transactionType = "VARIANT_REDUCE";
          variantInfo = rawMaterial.rawItemVariantCombination?.join(" • ") ||
            `Variant ID: ${rawMaterial.rawItemVariantId?.toString().slice(-6)}`;
        } else {
          previousQuantity = rawItem.quantity;
          newQuantity      = Math.max(0, previousQuantity - deductionQty);
          rawItem.quantity = newQuantity;
          variantInfo      = "Variant not found, used total stock";
        }
      } else {
        previousQuantity = rawItem.quantity;
        newQuantity      = Math.max(0, previousQuantity - deductionQty);
        rawItem.quantity = newQuantity;
      }

      rawMaterial.quantityIssued    = rawMaterial.quantityAllocated;
      rawMaterial.allocationStatus  = "issued";

      const conversionNote = rawMaterial.unit !== rawItemRegisteredUnit
        ? `, Deducted: ${deductionQty} ${rawItemRegisteredUnit} (from ${rawMaterial.quantityAllocated} ${rawMaterial.unit})`
        : "";

      const transactionData = {
        type: transactionType,
        quantity: deductionQty,
        previousQuantity,
        newQuantity,
        reason: `Issued for Work Order: ${workOrder.workOrderNumber}`,
        notes: `Work Order: ${workOrder.workOrderNumber}, Product: ${workOrder.stockItemName}, ` +
          `Quantity: ${workOrder.quantity} units${conversionNote}${variantInfo ? `, ${variantInfo}` : ""}`,
        performedBy: req.user.id,
      };

      if (rawMaterial.rawItemVariantId)               transactionData.variantId          = rawMaterial.rawItemVariantId;
      if (rawMaterial.rawItemVariantCombination?.length > 0) transactionData.variantCombination = rawMaterial.rawItemVariantCombination;
      if (variantPreviousQuantity !== null) {
        transactionData.variantPreviousQuantity = variantPreviousQuantity;
        transactionData.variantNewQuantity      = variantNewQuantity;
      }

      rawItem.stockTransactions.push(transactionData);
      await rawItem.save();

      stockTransactions.push({
        rawItemId: rawItem._id, name: rawItem.name, sku: rawItem.sku,
        variantId: rawMaterial.rawItemVariantId,
        variantCombination: rawMaterial.rawItemVariantCombination,
        quantityIssued: deductionQty,
        quantityIssuedBomUnit: rawMaterial.quantityAllocated,
        bomUnit: rawMaterial.unit,
        registeredUnit: rawItemRegisteredUnit,
        transactionType,
      });
    }

    workOrder.status       = "scheduled";
    workOrder.plannedBy    = req.user.id;
    workOrder.plannedAt    = new Date();
    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();

    res.json({ success: true, message: "Planning completed successfully", workOrder, stockTransactions });
  } catch (error) {
    console.error("Error completing planning:", error);
    res.status(500).json({ success: false, message: "Server error while completing planning" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /machines/:machineType
// ─────────────────────────────────────────────────────────────────────────────
router.get("/machines/:machineType", async (req, res) => {
  try {
    const machines = await Machine.find({ type: req.params.machineType, status: "Operational" }).lean();
    res.json({ success: true, machines });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching machines" });
  }
});

router.post("/machines", async (req, res) => {
  try {
    const machine = new Machine({ ...req.body, createdBy: req.user.id });
    await machine.save();
    res.json({ success: true, message: "Machine created successfully", machine });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while creating machine" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /:id/start-production
// ─────────────────────────────────────────────────────────────────────────────
router.post("/:id/start-production", async (req, res) => {
  try {
    const { id } = req.params;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const canStart =
      (workOrder.status === "scheduled" || workOrder.status === "ready_to_start") &&
      !workOrder.rawMaterials?.some(rm => rm.allocationStatus !== "issued") &&
      !workOrder.operations?.some(op => !op.assignedMachine);

    if (!canStart) {
      return res.status(400).json({
        success: false,
        message: "Work order cannot start production. Check raw material allocation and machine assignments.",
      });
    }

    workOrder.status                   = "in_progress";
    workOrder.timeline.actualStartDate = new Date();
    workOrder.operations.forEach(op => { op.status = "pending"; });
    await workOrder.save();

    res.json({
      success: true, message: "Production started successfully",
      workOrder: { _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber, status: workOrder.status, startedAt: workOrder.timeline.actualStartDate },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while starting production" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stock item operations / add / remove / reorder
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id/stock-item-operations", async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.id).populate("stockItemId", "operations").lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });
    const stockItem = await StockItem.findById(workOrder.stockItemId).select("operations").lean();
    res.json({ success: true, operations: stockItem?.operations || [] });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while fetching stock item operations" });
  }
});

router.post("/:id/operations", async (req, res) => {
  try {
    const { operationType, machineType, estimatedTimeSeconds } = req.body;
    const workOrder = await WorkOrder.findById(req.params.id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    workOrder.operations.push({
      operationType, machineType,
      estimatedTimeSeconds: estimatedTimeSeconds || 0,
      plannedTimeSeconds: estimatedTimeSeconds || 0,
      maxAllowedSeconds: estimatedTimeSeconds ? Math.ceil(estimatedTimeSeconds / 0.7) : 0,
      status: "pending", assignedMachine: null, assignedMachineName: null,
      assignedMachineSerial: null, additionalMachines: [], notes: "",
    });
    await workOrder.save();
    const addedOp = workOrder.operations[workOrder.operations.length - 1];
    res.json({ success: true, message: "Operation added successfully", operation: addedOp });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while adding operation" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /:id/operations/batch  — remove multiple operations in ONE save
// Body: { operationIds: ["id1", "id2", ...] }
// This avoids Mongoose VersionError that occurs when parallel single-deletes
// all try to save the same document concurrently.
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id/operations/batch", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationIds } = req.body;

    if (!Array.isArray(operationIds) || operationIds.length === 0) {
      return res.status(400).json({ success: false, message: "operationIds array is required" });
    }

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const idSet = new Set(operationIds.map(String));
    const before = workOrder.operations.length;
    workOrder.operations = workOrder.operations.filter(op => !idSet.has(op._id.toString()));
    const removed = before - workOrder.operations.length;

    await workOrder.save();
    res.json({ success: true, message: `${removed} operation(s) removed successfully`, removed });
  } catch (error) {
    console.error("Error batch-deleting operations:", error);
    res.status(500).json({ success: false, message: "Server error while removing operations", error: error.message });
  }
});

router.delete("/:id/operations/:operationId", async (req, res) => {
  try {
    const { id, operationId } = req.params;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const idx = workOrder.operations.findIndex(op => op._id.toString() === operationId);
    if (idx === -1) return res.status(404).json({ success: false, message: "Operation not found" });

    workOrder.operations.splice(idx, 1);
    await workOrder.save();
    res.json({ success: true, message: "Operation removed successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while removing operation" });
  }
});

router.put("/:id/operations/reorder", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationIds } = req.body;
    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const opsMap = {};
    workOrder.operations.forEach(op => { opsMap[op._id.toString()] = op; });

    const reordered = operationIds.map(opId => opsMap[opId]).filter(Boolean);
    workOrder.operations.forEach(op => {
      if (!operationIds.includes(op._id.toString())) reordered.push(op);
    });

    workOrder.operations = reordered;
    await workOrder.save();
    res.json({ success: true, message: "Operations reordered successfully" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Server error while reordering operations" });
  }
});

module.exports = router;