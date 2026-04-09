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
const mongoose = require("mongoose");

const PDFDocument = require("pdfkit");
const streamBuffers = require("stream-buffers");

router.use(EmployeeAuthMiddleware);


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

// Which operation number (1-based) is this machine assigned to in the WO?
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

// ─── ROUTE ────────────────────────────────────────────────────────────────────
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

    // ── 1. Load the work order ────────────────────────────────────────────────
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

    // Derive the WO short ID (last 8 chars of _id) used in barcodes
    const woShortId = workOrder._id.toString().slice(-8);

    // ── 2. Fetch ALL ProductionTracking docs that have any scan for this WO ───
    // We search across all dates (not just today) to get historical data too.
    const allTrackingDocs = await ProductionTracking.find({})
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    // ── 3. Walk every scan, filter to this WO + this unit number ─────────────
    // Collect: [ { machineId, machineName, operatorId, operatorName, signInTime, signOutTime, scanTime, date } ]
    // ── 3. Walk every scan, filter to this WO + this unit number ─────────────
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
              machineId,
              machineName,
              operatorId: opId,
              operatorName: null, // will assign real name later
              signInTime: operator.signInTime,
              signOutTime: operator.signOutTime,
              scanTime: scan.timeStamp,
              barcodeId: scan.barcodeId,
              operationNumber: parsed.operationNumber,
              scanDate,
            });
          }
        }
      }
    }

    // Fetch employee names using identityId
    const employees = await Employee.find({
      identityId: { $in: [...operatorIdsSet] },
    })
      .select("identityId firstName lastName")
      .lean();

    const employeeMap = new Map(
      employees.map((e) => [
        e.identityId,
        `${e.firstName || ""} ${e.lastName || ""}`.trim(),
      ])
    );

    // Attach real employee name
    matchingScans.forEach((scan) => {
      scan.operatorName =
        employeeMap.get(scan.operatorId) || scan.operatorId || "Unknown";
    });

    // ── 4. Enrich each scan with operationNumber derived from machine assignment ──
    const enrichedScans = matchingScans.map((scan) => {
      if (scan.operationNumber) return scan;
      const derived = _deriveOpNumber(scan.machineId, workOrder);
      return { ...scan, operationNumber: derived };
    });

    // ── 5. Build per-operation operator list ──────────────────────────────────
    // Key: operationNumber → Map of operatorId → { name, scans[], signIn, signOut }
    const opMap = new Map(); // opNum -> Map<operatorId -> data>

    for (const scan of enrichedScans) {
      const opNum = scan.operationNumber; // may be null if machine not assigned
      const key = opNum ?? 0; // bucket unknown-op scans in 0

      if (!opMap.has(key)) opMap.set(key, new Map());
      const oprMap = opMap.get(key);

      const oprKey = scan.operatorId;
      if (!oprMap.has(oprKey)) {
        oprMap.set(oprKey, {
          operatorId: scan.operatorId,
          operatorName: scan.operatorName,
          scans: [],
          signInTime: scan.signInTime,
          signOutTime: scan.signOutTime,
        });
      }
      oprMap.get(oprKey).scans.push(scan.scanTime);
    }

    // ── 6. Shape final operations array — match order to WO.operations ────────
    const totalOps = workOrder.operations?.length || 0;

    const buildOperators = (oprMap) =>
      [...oprMap.values()].map((e) => {
        const sorted = e.scans
          .filter(Boolean)
          .map((t) => new Date(t))
          .sort((a, b) => a - b);

        const firstScan = sorted[0] || null;
        const lastScan = sorted[sorted.length - 1] || null;
        const durationMs =
          e.signInTime && e.signOutTime
            ? new Date(e.signOutTime) - new Date(e.signInTime)
            : firstScan && lastScan && lastScan - firstScan > 0
              ? lastScan - firstScan
              : 0;

        const dateSet = new Set(
          sorted.map((t) => t.toISOString().split("T")[0])
        );

        return {
          operatorId: e.operatorId,
          operatorName: e.operatorName,
          firstScanTime: firstScan,
          lastScanTime: lastScan,
          durationMs,
          scansCount: e.scans.length,
          dates: [...dateSet],
        };
      }).sort(
        (a, b) => new Date(a.firstScanTime) - new Date(b.firstScanTime)
      );

    const operations = [];

    if (totalOps > 0) {
      for (let i = 0; i < workOrder.operations.length; i++) {
        const opNum = i + 1;
        const woOp = workOrder.operations[i];
        const oprMap = opMap.get(opNum);

        operations.push({
          operationNumber: opNum,
          operationType: woOp.operationType || `Operation ${opNum}`,
          assignedMachineName: woOp.assignedMachineName || null,
          operators: oprMap ? buildOperators(oprMap) : [],
        });
      }
    } else {
      // WO has no defined operations — still show what we have
      for (const [opNum, oprMap] of opMap) {
        if (opNum === 0) continue; // show unknowns at the end
        operations.push({
          operationNumber: opNum,
          operationType: `Operation ${opNum}`,
          assignedMachineName: null,
          operators: buildOperators(oprMap),
        });
      }
    }

    // Append "Unknown Operation" bucket if any scans couldn't be mapped
    if (opMap.has(0)) {
      operations.push({
        operationNumber: null,
        operationType: "Unknown Operation",
        assignedMachineName: null,
        operators: buildOperators(opMap.get(0)),
      });
    }

    // ── 7. Respond ────────────────────────────────────────────────────────────
    return res.json({
      success: true,
      unitNumber,
      workOrderId: workOrder._id,
      workOrderNumber: workOrder.workOrderNumber,
      stockItemName: workOrder.stockItemName,
      totalScansFound: matchingScans.length,
      operations,
    });

  } catch (error) {
    console.error("Error fetching piece history:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching piece history",
      error: error.message,
    });
  }
});
// ─── END OF ROUTE ─────────────────────────────────────────────────────────────



router.get("/machine-status", async (req, res) => {
  try {
    // 1. ALL machines — no status filter, no type filter
    const allMachines = await Machine.find({}).lean();

    // 2. Today's IST date
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + istOffset);
    const todayDate = new Date(istNow.toISOString().split("T")[0]);
    todayDate.setHours(0, 0, 0, 0);

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    // Map: machineId -> { isActiveToday }
    const activeTodayMap = new Map();
    if (todayTracking) {
      for (const m of todayTracking.machines || []) {
        const mId = m.machineId?._id?.toString();
        if (!mId) continue;
        const isActive = (m.operationTracking || []).some(op => op.currentOperatorIdentityId);
        activeTodayMap.set(mId, isActive);
      }
    }

    // 3. Active WorkOrders with machine assignments
    const activeWOs = await WorkOrder.find({
      status: { $in: ["in_progress", "scheduled", "ready_to_start"] },
    })
      .select("workOrderNumber stockItemName status quantity operations timeline productionCompletion")
      .lean();

    // Map: machineId -> { workOrder, operation }
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

    // 4. Build response
    const machines = allMachines.map(machine => {
      const mId = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woEntry = woByMachineMap.get(mId);

      let status = "free";
      // Respect machine's own status field first
      if (machine.status === "Under Maintenance" || machine.status === "maintenance") {
        status = "maintenance";
      } else if (machine.status === "Offline" || machine.status === "offline") {
        status = "offline";
      } else if (woEntry) {
        status = "busy";
      } else if (isActiveNow) {
        status = "busy";
      }

      let currentWorkOrder = null;
      if (woEntry) {
        const wo = woEntry.wo;
        const pct = wo.quantity > 0
          ? Math.round(((wo.productionCompletion?.overallCompletedQuantity || 0) / wo.quantity) * 100)
          : 0;
        const totalSecs = wo.timeline?.totalPlannedSeconds || 0;
        const remainSecs = Math.max(0, totalSecs * ((100 - pct) / 100));
        const estimatedFreeAt = remainSecs > 0 ? new Date(Date.now() + remainSecs * 1000) : null;

        currentWorkOrder = {
          _id: wo._id,
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          status: wo.status,
          quantity: wo.quantity,
          completionPercentage: pct,
          totalPlannedSeconds: totalSecs,
          remainingSeconds: remainSecs,
          estimatedFreeAt,
        };
      }

      return {
        _id: machine._id,
        name: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        model: machine.model || null,
        location: machine.location || null,
        status,                    // "free" | "busy" | "maintenance" | "offline"
        currentWorkOrder,
        isActiveToday: isActiveNow,
        freeFromDate: status === "free" ? (machine.updatedAt || null) : null,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
      };
    });

    res.json({
      success: true,
      machines,
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

// GET single work order details - OPTIMIZED FOR FRONTEND USAGE
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID",
      });
    }

    // OPTIMIZED: Select only needed fields, minimal population
    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber status priority quantity stockItemName stockItemReference variantAttributes specialInstructions createdAt estimatedCost rawMaterials operations planningNotes",
      )
      .populate("plannedBy", "name") // ONLY name, not email
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // OPTIMIZED: Get panel count if needed (frontend fetches separately)
    const panelCount = await getPanelCount(workOrder.stockItemId);

    // OPTIMIZED: Transform raw materials - remove unused data
    const optimizedRawMaterials = (workOrder.rawMaterials || []).map((rm) => ({
      name: rm.name,
      sku: rm.sku,
      unit: rm.unit,
      unitCost: rm.unitCost,
      totalCost: rm.totalCost,
      quantityRequired: rm.quantityRequired,
      quantityAllocated: rm.quantityAllocated || 0,
      quantityIssued: rm.quantityIssued || 0,
      allocationStatus: rm.allocationStatus || "not_allocated",
      rawItemVariantId: rm.rawItemVariantId,
      rawItemVariantCombination: rm.rawItemVariantCombination || [],
      variantName:
        rm.rawItemVariantCombination?.join(" • ") ||
        (rm.rawItemVariantId
          ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}`
          : "Default"),
    }));

    // OPTIMIZED: Transform operations - remove unused fields
    const optimizedOperations = (workOrder.operations || []).map(
      (op, index) => ({
        _id: op._id,
        operationType: op.operationType,
        machineType: op.machineType,
        status: op.status || "pending",
        notes: op.notes || "",
        estimatedTimeSeconds: op.estimatedTimeSeconds || 0,
        plannedTimeSeconds:
          op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
        maxAllowedSeconds:
          op.maxAllowedSeconds ||
          (op.estimatedTimeSeconds
            ? Math.ceil(op.estimatedTimeSeconds / 0.7)
            : 0),
        assignedMachine: op.assignedMachine,
        assignedMachineName: op.assignedMachineName,
        assignedMachineSerial: op.assignedMachineSerial,
        additionalMachines: (op.additionalMachines || []).map((am) => ({
          assignedMachine: am.assignedMachine,
          assignedMachineName: am.assignedMachineName,
          assignedMachineSerial: am.assignedMachineSerial,
          notes: am.notes || "",
        })),
      }),
    );

    // OPTIMIZED: Calculate timeline totals
    const totalPlannedSeconds = optimizedOperations.reduce(
      (sum, op) => sum + (op.plannedTimeSeconds || 0),
      0,
    );

    // OPTIMIZED: Calculate material status counts
    const rawMaterialStats = {
      total: optimizedRawMaterials.length,
      fullyAllocated: optimizedRawMaterials.filter(
        (rm) =>
          rm.allocationStatus === "fully_allocated" ||
          rm.allocationStatus === "issued",
      ).length,
      partiallyAllocated: optimizedRawMaterials.filter(
        (rm) => rm.allocationStatus === "partially_allocated",
      ).length,
      notAllocated: optimizedRawMaterials.filter(
        (rm) => rm.allocationStatus === "not_allocated",
      ).length,
      variantSpecific: optimizedRawMaterials.filter(
        (rm) => rm.rawItemVariantId || rm.rawItemVariantCombination?.length > 0,
      ).length,
    };

    // OPTIMIZED: Calculate operation status
    const needsPlanning =
      optimizedRawMaterials.some(
        (rm) => rm.allocationStatus === "not_allocated",
      ) || optimizedOperations.some((op) => !op.assignedMachine);

    // OPTIMIZED: Minimal response
    const response = {
      success: true,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        priority: workOrder.priority,
        quantity: workOrder.quantity,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        variantAttributes: workOrder.variantAttributes || [],
        specialInstructions: workOrder.specialInstructions || [],
        estimatedCost: workOrder.estimatedCost || 0,
        createdAt: workOrder.createdAt,
        plannedBy: workOrder.plannedBy?.name || null,

        // Calculated fields for frontend
        panelCount: panelCount,
        totalBarcodes:
          panelCount > 0
            ? workOrder.quantity * panelCount
            : workOrder.quantity * optimizedOperations.length,
        totalPlannedSeconds: totalPlannedSeconds,
        needsPlanning: needsPlanning,
        rawMaterialStats: rawMaterialStats,

        // Core data arrays
        rawMaterials: optimizedRawMaterials,
        operations: optimizedOperations,
      },
    };

    res.json(response);
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order",
    });
  }
});

// Helper function for panel count
async function getPanelCount(stockItemId) {
  try {
    if (!stockItemId) return 0;
    const stockItem = await StockItem.findById(stockItemId)
      .select("numberOfPanels")
      .lean();
    return stockItem?.numberOfPanels || 0;
  } catch (error) {
    console.error("Error fetching panel count:", error);
    return 0;
  }
}

// Add this route to get stock item details with panel info
router.get("/stock-items/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const stockItem = await StockItem.findById(id)
      .select("name reference numberOfPanels operations variants images")
      .lean();

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found",
      });
    }

    res.json({
      success: true,
      stockItem,
    });
  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching stock item",
    });
  }
});

// In workOrderRoutes.js - Add this endpoint

// GET panel count for a work order
router.get("/:id/panel-count", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get stock item to get panel count
    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("numberOfPanels")
      .lean();
    const panelCount = stockItem?.numberOfPanels || 0;

    res.json({
      success: true,
      panelCount: panelCount,
      workOrder: {
        workOrderNumber: workOrder.workOrderNumber,
        quantity: workOrder.quantity,
        stockItemName: workOrder.stockItemName,
      },
    });
  } catch (error) {
    console.error("Error fetching panel count:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching panel count",
    });
  }
});

// GET work order with panel information
router.get("/:id/with-panels", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference numberOfPanels")
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get panel count from stock item
    const stockItem = await StockItem.findById(workOrder.stockItemId);
    const numberOfPanels = stockItem?.numberOfPanels || 1; // Default to 1 if not specified

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        numberOfPanels: numberOfPanels,
      },
    });
  } catch (error) {
    console.error("Error fetching work order with panels:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order",
    });
  }
});

// Add this to your workOrderRoutes.js file (backend)

// GET work order details with stock item including panels
router.get("/:id/with-details", async (req, res) => {
  try {
    const { id } = req.params;

    // Check if id is valid
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID",
      });
    }

    const workOrder = await WorkOrder.findById(id)
      .populate(
        "stockItemId",
        "name reference numberOfPanels operations variants",
      ) // Add numberOfPanels
      .populate("customerRequestId", "customerInfo requestId")
      .populate("createdBy", "name email")
      .populate("plannedBy", "name email")
      .populate("rawMaterials.rawItemId", "name sku quantity") // Populate raw materials
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    res.json({
      success: true,
      workOrder,
      stockItem: workOrder.stockItemId, // Already populated
      numberOfPanels: workOrder.stockItemId?.numberOfPanels || 1,
    });
  } catch (error) {
    console.error("Error fetching work order with details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order details",
    });
  }
});

// GET work order details for planning - MODIFIED FOR VARIANT-WISE
router.get("/:id/planning", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .populate("stockItemId", "name reference operations rawItems")
      .populate({
        path: "customerRequestId",
        select: "customerInfo deliveryDeadline",
        populate: {
          path: "customerId",
          select: "shippingAddress billingAddress",
        },
      })
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Get customer info with address
    let customerWithAddress = null;
    if (workOrder.customerRequestId?.customerId) {
      // If customerId is populated, get the customer details
      const Customer = require("../../../../models/Customer_Models/Customer");
      customerWithAddress = await Customer.findById(
        workOrder.customerRequestId.customerId,
      )
        .select("shippingAddress billingAddress phone email")
        .lean();
    }

    // Format customer info with address
    const customerInfo = {
      ...workOrder.customerRequestId?.customerInfo,
      address:
        customerWithAddress?.shippingAddress?.fullAddress ||
        customerWithAddress?.billingAddress?.fullAddress ||
        workOrder.customerRequestId?.customerInfo?.address ||
        "Address not available",
    };

    // Get stock item for operations reference
    const stockItem = await StockItem.findById(workOrder.stockItemId).lean();

    // Calculate maximum producible quantity based on raw material availability - MODIFIED FOR VARIANT-WISE
    let maxProducibleQuantity = workOrder.quantity;
    const rawMaterialsWithStock = await Promise.all(
      workOrder.rawMaterials.map(async (rm) => {
        if (rm.rawItemId) {
          const rawItem = await RawItem.findById(rm.rawItemId).lean();
          const requiredPerUnit = rm.quantityRequired / workOrder.quantity;
          let maxUnitsFromThisMaterial = 0;
          let currentStock = 0;
          let status = "insufficient";

          // Check variant-specific stock if specified
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            if (rm.rawItemVariantId && rawItem?.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                currentStock = variant.quantity || 0;
                maxUnitsFromThisMaterial = Math.floor(
                  currentStock / requiredPerUnit,
                );
              }
            } else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem?.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                currentStock = variant.quantity || 0;
                maxUnitsFromThisMaterial = Math.floor(
                  currentStock / requiredPerUnit,
                );
              }
            }
          } else {
            // No variant specified, use total stock
            currentStock = rawItem?.quantity || 0;
            maxUnitsFromThisMaterial = Math.floor(
              currentStock / requiredPerUnit,
            );
          }

          // Update max producible quantity
          maxProducibleQuantity = Math.min(
            maxProducibleQuantity,
            maxUnitsFromThisMaterial,
          );

          // Determine status
          if (maxUnitsFromThisMaterial >= workOrder.quantity) {
            status = "sufficient";
          } else if (maxUnitsFromThisMaterial > 0) {
            status = "partial";
          } else {
            status = "insufficient";
          }

          return {
            ...rm,
            currentStock: currentStock,
            requiredPerUnit: requiredPerUnit,
            maxUnitsFromThisMaterial: maxUnitsFromThisMaterial,
            status: status,
            // Add variant info for frontend display
            variantName:
              rm.rawItemVariantCombination?.join(" • ") ||
              (rm.rawItemVariantId
                ? `Variant #${rm.rawItemVariantId.toString().slice(-6)}`
                : "Default"),
          };
        }
        return rm;
      }),
    );

    // Get available machines for each operation type
    const operationsWithMachines = await Promise.all(
      workOrder.operations.map(async (op) => {
        const availableMachines = await Machine.find({
          type: op.machineType,
          status: "Operational",
        }).lean();

        // Calculate max allowed time (70% efficiency)
        const maxAllowedSeconds = op.estimatedTimeSeconds
          ? Math.ceil(op.estimatedTimeSeconds / 0.7)
          : 0;

        return {
          ...op,
          availableMachines: availableMachines || [],
          maxAllowedSeconds: maxAllowedSeconds,
          plannedTimeSeconds:
            op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
        };
      }),
    );

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        operations: operationsWithMachines,
        rawMaterials: rawMaterialsWithStock,
        maxProducibleQuantity: Math.max(1, maxProducibleQuantity),
        stockItemOperations: stockItem?.operations || [],
        // Add customer info with address
        customerRequestId: workOrder.customerRequestId
          ? {
            ...workOrder.customerRequestId,
            customerInfo: customerInfo,
            deliveryDeadline: workOrder.customerRequestId.deliveryDeadline,
          }
          : null,
      },
    });
  } catch (error) {
    console.error("Error fetching work order for planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order details",
    });
  }
});

// UPDATE raw material allocation with quantity adjustment AND create new WO for remaining - FIXED VERSION
router.put("/:id/allocate-raw-materials", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, splitRemaining = false, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    let newWorkOrder = null;
    const remainingQuantity = workOrder.quantity - quantity;

    // Validate quantity
    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Quantity must be at least 1",
      });
    }

    if (quantity > workOrder.quantity) {
      return res.status(400).json({
        success: false,
        message: "Quantity cannot exceed original work order quantity",
      });
    }

    // Ensure originalQuantity exists
    if (!workOrder.originalQuantity) {
      workOrder.originalQuantity = workOrder.quantity;
    }

    // Calculate raw material requirements per unit and check stock - FIXED FOR VARIANT-WISE
    let canProduceQuantity = workOrder.quantity;

    for (const rm of workOrder.rawMaterials) {
      if (rm.rawItemId) {
        const rawItem = await RawItem.findById(rm.rawItemId);
        if (rawItem) {
          // FIX: Check for division by zero
          const requiredPerUnit =
            workOrder.quantity > 0
              ? rm.quantityRequired / workOrder.quantity
              : 0;

          // Check if raw material requires specific variant
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            let variantStock = 0;

            // Find variant by ID
            if (rm.rawItemVariantId && rawItem.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                variantStock = variant.quantity || 0;
              }
            }
            // Or find variant by combination
            else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                variantStock = variant.quantity || 0;
              }
            }

            // FIX: Check for division by zero
            const maxUnitsFromThisVariant =
              requiredPerUnit > 0
                ? Math.floor(variantStock / requiredPerUnit)
                : 0;
            canProduceQuantity = Math.min(
              canProduceQuantity,
              maxUnitsFromThisVariant,
            );
          } else {
            // No variant specified, use total stock
            const maxUnitsFromThisMaterial =
              requiredPerUnit > 0
                ? Math.floor(rawItem.quantity / requiredPerUnit)
                : 0;
            canProduceQuantity = Math.min(
              canProduceQuantity,
              maxUnitsFromThisMaterial,
            );
          }
        }
      }
    }

    // Check if requested quantity can be produced
    if (quantity > canProduceQuantity) {
      return res.status(400).json({
        success: false,
        message: `Cannot produce ${quantity} units. Maximum producible is ${canProduceQuantity} units with current stock.`,
      });
    }

    // Create new work order for remaining quantity if splitRemaining is true
    if (splitRemaining && remainingQuantity > 0) {
      // Calculate raw material requirements for new work order
      const newRawMaterials = [];

      for (const rm of workOrder.rawMaterials) {
        // FIX: Check for division by zero
        const requiredPerUnit =
          workOrder.quantity > 0 ? rm.quantityRequired / workOrder.quantity : 0;
        const unitCost = rm.unitCost || 0;
        const quantityRequired = requiredPerUnit * remainingQuantity;
        const totalCost = unitCost * quantityRequired;

        newRawMaterials.push({
          rawItemId: rm.rawItemId,
          name: rm.name,
          sku: rm.sku,
          // PRESERVE VARIANT INFORMATION
          rawItemVariantId: rm.rawItemVariantId,
          rawItemVariantCombination: rm.rawItemVariantCombination || [],
          quantityRequired: quantityRequired,
          quantityAllocated: 0,
          quantityIssued: 0,
          unit: rm.unit,
          unitCost: unitCost,
          totalCost: totalCost,
          allocationStatus: "not_allocated",
          notes: rm.notes || "",
        });
      }

      // Create new work order
      const newWorkOrderData = {
        customerRequestId: workOrder.customerRequestId,
        stockItemId: workOrder.stockItemId,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        variantId: workOrder.variantId,
        variantAttributes: workOrder.variantAttributes,
        quantity: remainingQuantity,
        originalQuantity: remainingQuantity,
        customerId: workOrder.customerId,
        customerName: workOrder.customerName,
        priority: workOrder.priority,
        status: "pending",
        operations: workOrder.operations.map((op) => ({
          operationType: op.operationType,
          machineType: op.machineType,
          assignedMachine: null,
          assignedMachineName: null,
          assignedMachineSerial: null,
          additionalMachines: [],
          estimatedTimeSeconds: op.estimatedTimeSeconds,
          plannedTimeSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds,
          maxAllowedSeconds: op.maxAllowedSeconds,
          status: "pending",
          notes: op.notes || "",
        })),
        rawMaterials: newRawMaterials,
        timeline: {
          totalEstimatedSeconds:
            (workOrder.timeline?.totalEstimatedSeconds || 0) *
            (remainingQuantity / workOrder.quantity),
        },
        specialInstructions: workOrder.specialInstructions,
        createdBy: workOrder.createdBy,
        isSplitOrder: true,
        parentWorkOrderId: workOrder._id,
        splitReason: "Split due to raw material allocation",
      };

      newWorkOrder = new WorkOrder(newWorkOrderData);
      await newWorkOrder.save();
    }

    // Update current work order quantity and raw materials
    workOrder.quantity = quantity;

    // Update raw material quantities for current work order - FIXED
    for (const rm of workOrder.rawMaterials) {
      // FIX: Use workOrder.originalQuantity, not undefined variable
      const requiredPerUnit =
        workOrder.originalQuantity > 0
          ? rm.quantityRequired / workOrder.originalQuantity
          : 0;

      // FIX: Ensure we have a valid number
      const newQuantityRequired = requiredPerUnit * quantity;
      rm.quantityRequired = isNaN(newQuantityRequired)
        ? 0
        : newQuantityRequired;

      // Auto-allocate based on available stock - MODIFIED FOR VARIANT-WISE
      if (rm.rawItemId) {
        const rawItem = await RawItem.findById(rm.rawItemId);
        if (rawItem) {
          let availableStock = 0;

          // Check variant-specific stock if specified
          if (
            rm.rawItemVariantId ||
            (rm.rawItemVariantCombination &&
              rm.rawItemVariantCombination.length > 0)
          ) {
            if (rm.rawItemVariantId && rawItem.variants) {
              const variant = rawItem.variants.find(
                (v) => v._id.toString() === rm.rawItemVariantId.toString(),
              );
              if (variant) {
                availableStock = variant.quantity || 0;
              }
            } else if (
              rm.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              const variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !== rm.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) => val === rm.rawItemVariantCombination[idx],
                );
              });
              if (variant) {
                availableStock = variant.quantity || 0;
              }
            }
          } else {
            // No variant specified, use total stock
            availableStock = rawItem.quantity || 0;
          }

          const maxAllocatable = Math.min(rm.quantityRequired, availableStock);
          rm.quantityAllocated = isNaN(maxAllocatable) ? 0 : maxAllocatable;

          if (maxAllocatable >= rm.quantityRequired) {
            rm.allocationStatus = "fully_allocated";
          } else if (maxAllocatable > 0) {
            rm.allocationStatus = "partially_allocated";
          } else {
            rm.allocationStatus = "not_allocated";
          }
        } else {
          rm.quantityAllocated = 0;
          rm.allocationStatus = "not_allocated";
        }
      } else {
        rm.quantityAllocated = 0;
        rm.allocationStatus = "not_allocated";
      }
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;

    // If quantity changed, update status
    if (quantity < workOrder.originalQuantity) {
      workOrder.status = "partial_allocation";
    } else {
      workOrder.status = "planned";
    }

    await workOrder.save();

    res.json({
      success: true,
      message: `Raw materials allocated successfully for ${quantity} units`,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        quantity: workOrder.quantity,
      },
      newWorkOrder: newWorkOrder
        ? {
          _id: newWorkOrder._id,
          workOrderNumber: newWorkOrder.workOrderNumber,
          quantity: newWorkOrder.quantity,
        }
        : null,
      remainingQuantity: remainingQuantity,
      splitCreated: !!newWorkOrder,
    });
  } catch (error) {
    console.error("Error allocating raw materials:", error);
    res.status(500).json({
      success: false,
      message: "Server error while allocating raw materials",
      error: error.message,
    });
  }
});

// UPDATE operations planning (machines and timing with 70% efficiency constraint)
router.put("/:id/plan-operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { operations, totalPlannedSeconds, planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Update operations with multiple machines
    for (const opUpdate of operations) {
      const operation = workOrder.operations.id(opUpdate._id);
      if (operation) {
        // Primary machine assignment
        if (opUpdate.assignedMachine) {
          const machine = await Machine.findById(opUpdate.assignedMachine);
          if (machine) {
            operation.assignedMachine = opUpdate.assignedMachine;
            operation.assignedMachineName = machine.name;
            operation.assignedMachineSerial = machine.serialNumber;
          }
        }

        // Additional machines
        if (
          opUpdate.additionalMachines &&
          Array.isArray(opUpdate.additionalMachines)
        ) {
          operation.additionalMachines = opUpdate.additionalMachines.map(
            (am) => ({
              assignedMachine: am.assignedMachine,
              assignedMachineName: am.assignedMachineName,
              assignedMachineSerial: am.assignedMachineSerial,
              notes: am.notes || "",
            }),
          );
        }

        // Apply planned time if within 70% efficiency constraint
        if (opUpdate.plannedTimeSeconds && operation.estimatedTimeSeconds > 0) {
          const maxAllowed = Math.ceil(operation.estimatedTimeSeconds / 0.7);
          operation.plannedTimeSeconds = Math.min(
            opUpdate.plannedTimeSeconds,
            maxAllowed,
          );
        }

        if (opUpdate.notes) {
          operation.notes = opUpdate.notes;
        }

        operation.status = "scheduled";
      }
    }

    // Update total planned time if provided
    if (totalPlannedSeconds) {
      const totalEstimated = workOrder.operations.reduce(
        (total, op) => total + (op.estimatedTimeSeconds || 0),
        0,
      );
      const maxAllowed = Math.ceil(totalEstimated / 0.7);
      const actualPlanned = Math.min(totalPlannedSeconds, maxAllowed);

      // Adjust individual operation times proportionally
      const ratio = actualPlanned / totalEstimated;
      workOrder.operations.forEach((op) => {
        if (op.estimatedTimeSeconds > 0) {
          op.plannedTimeSeconds = Math.ceil(op.estimatedTimeSeconds * ratio);
        }
      });
    }

    workOrder.planningNotes = planningNotes || workOrder.planningNotes;
    await workOrder.save();

    res.json({
      success: true,
      message: "Operations planned successfully",
      workOrder,
    });
  } catch (error) {
    console.error("Error planning operations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while planning operations",
    });
  }
});

// COMPLETE planning and issue raw materials - FIXED VERSION
router.post("/:id/complete-planning", async (req, res) => {
  try {
    const { id } = req.params;
    const { planningNotes } = req.body;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check if all raw materials are allocated
    const insufficientAllocations = workOrder.rawMaterials.filter(
      (rm) => rm.allocationStatus === "not_allocated",
    );

    if (insufficientAllocations.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some raw materials are not allocated at all",
        insufficientAllocations,
      });
    }

    // Check if all operations have at least primary machine assigned
    const operationsWithoutMachine = workOrder.operations.filter(
      (op) => !op.assignedMachine,
    );

    if (operationsWithoutMachine.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Some operations do not have machines assigned",
        operationsWithoutMachine,
      });
    }

    // Update raw material stock and create transactions - FIXED ENUM VALUE
    const stockTransactions = [];

    for (const rawMaterial of workOrder.rawMaterials) {
      if (rawMaterial.rawItemId && rawMaterial.quantityAllocated > 0) {
        const rawItem = await RawItem.findById(rawMaterial.rawItemId);

        if (rawItem) {
          // Determine which quantity to reduce
          let previousQuantity = rawItem.quantity;
          let newQuantity = previousQuantity;
          let transactionType = "CONSUME";
          let variantInfo = "";
          let variantPreviousQuantity = null;
          let variantNewQuantity = null;

          // Check if this is variant-specific
          if (
            rawMaterial.rawItemVariantId ||
            (rawMaterial.rawItemVariantCombination &&
              rawMaterial.rawItemVariantCombination.length > 0)
          ) {
            // Find the specific variant
            let variant = null;

            if (rawMaterial.rawItemVariantId && rawItem.variants) {
              variant = rawItem.variants.id(rawMaterial.rawItemVariantId);
            } else if (
              rawMaterial.rawItemVariantCombination?.length > 0 &&
              rawItem.variants
            ) {
              variant = rawItem.variants.find((v) => {
                if (
                  !v.combination ||
                  v.combination.length !==
                  rawMaterial.rawItemVariantCombination.length
                ) {
                  return false;
                }
                return v.combination.every(
                  (val, idx) =>
                    val === rawMaterial.rawItemVariantCombination[idx],
                );
              });
            }

            if (variant) {
              // Reduce variant-specific quantity
              variantPreviousQuantity = variant.quantity;
              variantNewQuantity = Math.max(
                0,
                variantPreviousQuantity - rawMaterial.quantityAllocated,
              );
              variant.quantity = variantNewQuantity;

              // Also update total raw item quantity
              previousQuantity = rawItem.quantity;
              newQuantity = Math.max(
                0,
                rawItem.quantity - rawMaterial.quantityAllocated,
              );
              rawItem.quantity = newQuantity;

              // FIXED: Use VARIANT_REDUCE instead of VARIANT_CONSUME
              transactionType = "VARIANT_REDUCE";
              variantInfo =
                rawMaterial.rawItemVariantCombination?.join(" • ") ||
                `Variant ID: ${rawMaterial.rawItemVariantId?.toString().slice(-6)}`;
            } else {
              // Variant not found, fallback to total stock
              previousQuantity = rawItem.quantity;
              newQuantity = Math.max(
                0,
                previousQuantity - rawMaterial.quantityAllocated,
              );
              rawItem.quantity = newQuantity;

              variantInfo = "Variant not found, used total stock";
            }
          } else {
            // No variant specified, reduce total quantity
            previousQuantity = rawItem.quantity;
            newQuantity = Math.max(
              0,
              previousQuantity - rawMaterial.quantityAllocated,
            );
            rawItem.quantity = newQuantity;
          }

          rawMaterial.quantityIssued = rawMaterial.quantityAllocated;
          rawMaterial.allocationStatus = "issued";

          // Add stock transaction with variant info
          const transactionData = {
            type: transactionType,
            quantity: rawMaterial.quantityAllocated,
            previousQuantity: previousQuantity,
            newQuantity: newQuantity,
            reason: `Issued for Work Order: ${workOrder.workOrderNumber}`,
            notes: `Work Order: ${workOrder.workOrderNumber}, Product: ${workOrder.stockItemName}, Quantity: ${workOrder.quantity} units${variantInfo ? `, ${variantInfo}` : ""}`,
            performedBy: req.user.id,
          };

          // Add variant-specific fields if applicable
          if (rawMaterial.rawItemVariantId) {
            transactionData.variantId = rawMaterial.rawItemVariantId;
          }
          if (rawMaterial.rawItemVariantCombination?.length > 0) {
            transactionData.variantCombination =
              rawMaterial.rawItemVariantCombination;
          }
          if (variantPreviousQuantity !== null) {
            transactionData.variantPreviousQuantity = variantPreviousQuantity;
            transactionData.variantNewQuantity = variantNewQuantity;
          }

          rawItem.stockTransactions.push(transactionData);

          await rawItem.save();
          stockTransactions.push({
            rawItemId: rawItem._id,
            name: rawItem.name,
            sku: rawItem.sku,
            variantId: rawMaterial.rawItemVariantId,
            variantCombination: rawMaterial.rawItemVariantCombination,
            quantityIssued: rawMaterial.quantityAllocated,
            transactionType: transactionType,
          });
        }
      }
    }

    // Update work order status
    workOrder.status = "scheduled";
    workOrder.plannedBy = req.user.id;
    workOrder.plannedAt = new Date();
    workOrder.planningNotes = planningNotes || workOrder.planningNotes;

    await workOrder.save();

    res.json({
      success: true,
      message: "Planning completed successfully",
      workOrder,
      stockTransactions,
    });
  } catch (error) {
    console.error("Error completing planning:", error);
    res.status(500).json({
      success: false,
      message: "Server error while completing planning",
    });
  }
});

// GET available machines by type
router.get("/machines/:machineType", async (req, res) => {
  try {
    const { machineType } = req.params;

    const machines = await Machine.find({
      type: machineType,
      status: "Operational",
    }).lean();

    res.json({
      success: true,
      machines,
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching machines",
    });
  }
});

// Create new machine
router.post("/machines", async (req, res) => {
  try {
    const machineData = req.body;

    const machine = new Machine({
      ...machineData,
      createdBy: req.user.id,
    });

    await machine.save();

    res.json({
      success: true,
      message: "Machine created successfully",
      machine,
    });
  } catch (error) {
    console.error("Error creating machine:", error);
    res.status(500).json({
      success: false,
      message: "Server error while creating machine",
    });
  }
});

router.post("/:id/start-production", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check if work order can start production
    const canStart =
      (workOrder.status === "scheduled" ||
        workOrder.status === "ready_to_start") &&
      !workOrder.rawMaterials?.some((rm) => rm.allocationStatus !== "issued") &&
      !workOrder.operations?.some((op) => !op.assignedMachine);

    if (!canStart) {
      return res.status(400).json({
        success: false,
        message:
          "Work order cannot start production. Check raw material allocation and machine assignments.",
      });
    }

    // Update status
    workOrder.status = "in_progress";
    workOrder.timeline.actualStartDate = new Date();

    // Update all operations to pending (they'll start when scanned)
    workOrder.operations.forEach((op) => {
      op.status = "pending";
    });

    await workOrder.save();

    res.json({
      success: true,
      message: "Production started successfully",
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        startedAt: workOrder.timeline.actualStartDate,
      },
    });
  } catch (error) {
    console.error("Error starting production:", error);
    res.status(500).json({
      success: false,
      message: "Server error while starting production",
    });
  }
});

<<<<<<< HEAD
// Export the router
module.exports = router;
=======
// DELETE /:id/operations/batch
router.delete("/:id/operations/batch", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationIds } = req.body;
    if (!Array.isArray(operationIds) || operationIds.length === 0)
      return res.status(400).json({ success: false, message: "operationIds array is required" });

    const workOrder = await WorkOrder.findById(id);
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const idSet  = new Set(operationIds.map(String));
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



router.post("/bulk-plan", async (req, res) => {
  try {
    const { workOrderIds } = req.body;
    
    if (!workOrderIds || !Array.isArray(workOrderIds) || workOrderIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        message: "workOrderIds array is required" 
      });
    }

    const results = {
      success: [],
      failed: [],
      totalProcessed: 0,
      totalSuccess: 0,
      totalFailed: 0
    };

    for (const workOrderId of workOrderIds) {
      try {
        if (!mongoose.Types.ObjectId.isValid(workOrderId)) {
          results.failed.push({ 
            id: workOrderId, 
            reason: "Invalid work order ID" 
          });
          results.totalFailed++;
          continue;
        }

        const workOrder = await WorkOrder.findById(workOrderId);
        
        if (!workOrder) {
          results.failed.push({ 
            id: workOrderId, 
            reason: "Work order not found" 
          });
          results.totalFailed++;
          continue;
        }

        // Check if work order is in pending status
        if (workOrder.status !== "pending") {
          results.failed.push({ 
            id: workOrderId, 
            workOrderNumber: workOrder.workOrderNumber,
            reason: `Cannot plan work order with status: ${workOrder.status}` 
          });
          results.totalFailed++;
          continue;
        }

        // Check if raw materials are allocated
        const insufficientAllocations = workOrder.rawMaterials.filter(
          rm => rm.allocationStatus === "not_allocated"
        );
        
        if (insufficientAllocations.length > 0) {
          results.failed.push({ 
            id: workOrderId, 
            workOrderNumber: workOrder.workOrderNumber,
            reason: `${insufficientAllocations.length} raw material(s) not allocated` 
          });
          results.totalFailed++;
          continue;
        }

        // Check if any raw materials are partially allocated
        const partiallyAllocated = workOrder.rawMaterials.filter(
          rm => rm.allocationStatus === "partially_allocated"
        );
        
        if (partiallyAllocated.length > 0) {
          results.failed.push({ 
            id: workOrderId, 
            workOrderNumber: workOrder.workOrderNumber,
            reason: `${partiallyAllocated.length} raw material(s) partially allocated` 
          });
          results.totalFailed++;
          continue;
        }

        // Issue raw materials if not already issued
        const stockTransactions = [];
        
        for (const rawMaterial of workOrder.rawMaterials) {
          if (rawMaterial.allocationStatus !== "issued") {
            const rawItem = await RawItem.findById(rawMaterial.rawItemId);
            if (rawItem) {
              const rawItemRegisteredUnit = rawItem.customUnit || rawItem.unit;
              let deductionQty = rawMaterial.quantityAllocated;
              
              if (rawMaterial.unit && rawItemRegisteredUnit && rawMaterial.unit !== rawItemRegisteredUnit) {
                deductionQty = await convertQuantity(
                  rawMaterial.quantityAllocated, 
                  rawMaterial.unit, 
                  rawItemRegisteredUnit
                );
              }

              let previousQuantity = rawItem.quantity;
              let newQuantity = previousQuantity;
              let transactionType = "CONSUME";
              let variantInfo = "";
              let variantPreviousQuantity = null;
              let variantNewQuantity = null;

              if (rawMaterial.rawItemVariantId || rawMaterial.rawItemVariantCombination?.length > 0) {
                let variant = null;
                if (rawMaterial.rawItemVariantId && rawItem.variants) {
                  variant = rawItem.variants.id(rawMaterial.rawItemVariantId);
                } else if (rawMaterial.rawItemVariantCombination?.length > 0 && rawItem.variants) {
                  variant = rawItem.variants.find(v =>
                    v.combination?.length === rawMaterial.rawItemVariantCombination.length &&
                    v.combination.every((val, idx) => val === rawMaterial.rawItemVariantCombination[idx])
                  );
                }

                if (variant) {
                  variantPreviousQuantity = variant.quantity;
                  variantNewQuantity = Math.max(0, variantPreviousQuantity - deductionQty);
                  variant.quantity = variantNewQuantity;
                  previousQuantity = rawItem.quantity;
                  newQuantity = Math.max(0, rawItem.quantity - deductionQty);
                  rawItem.quantity = newQuantity;
                  transactionType = "VARIANT_REDUCE";
                  variantInfo = rawMaterial.rawItemVariantCombination?.join(" • ") ||
                    `Variant ID: ${rawMaterial.rawItemVariantId?.toString().slice(-6)}`;
                } else {
                  previousQuantity = rawItem.quantity;
                  newQuantity = Math.max(0, previousQuantity - deductionQty);
                  rawItem.quantity = newQuantity;
                  variantInfo = "Variant not found, used total stock";
                }
              } else {
                previousQuantity = rawItem.quantity;
                newQuantity = Math.max(0, previousQuantity - deductionQty);
                rawItem.quantity = newQuantity;
              }

              rawMaterial.quantityIssued = rawMaterial.quantityAllocated;
              rawMaterial.allocationStatus = "issued";

              const conversionNote = rawMaterial.unit !== rawItemRegisteredUnit
                ? `, Deducted: ${deductionQty} ${rawItemRegisteredUnit} (from ${rawMaterial.quantityAllocated} ${rawMaterial.unit})`
                : "";

              const transactionData = {
                type: transactionType,
                quantity: deductionQty,
                previousQuantity,
                newQuantity,
                reason: `Issued for Work Order: ${workOrder.workOrderNumber} (Bulk Plan)`,
                notes: `Work Order: ${workOrder.workOrderNumber}, Product: ${workOrder.stockItemName}, ` +
                  `Quantity: ${workOrder.quantity} units${conversionNote}${variantInfo ? `, ${variantInfo}` : ""}`,
                performedBy: req.user.id,
              };
              
              if (rawMaterial.rawItemVariantId) transactionData.variantId = rawMaterial.rawItemVariantId;
              if (rawMaterial.rawItemVariantCombination?.length > 0) {
                transactionData.variantCombination = rawMaterial.rawItemVariantCombination;
              }
              if (variantPreviousQuantity !== null) {
                transactionData.variantPreviousQuantity = variantPreviousQuantity;
                transactionData.variantNewQuantity = variantNewQuantity;
              }

              rawItem.stockTransactions.push(transactionData);
              await rawItem.save();

              stockTransactions.push({
                rawItemId: rawItem._id,
                name: rawItem.name,
                sku: rawItem.sku,
                variantId: rawMaterial.rawItemVariantId,
                variantCombination: rawMaterial.rawItemVariantCombination,
                quantityIssued: deductionQty,
                quantityIssuedBomUnit: rawMaterial.quantityAllocated,
                bomUnit: rawMaterial.unit,
                registeredUnit: rawItemRegisteredUnit,
                transactionType,
              });
            }
          }
        }

        // Update work order status to scheduled
        workOrder.status = "scheduled";
        workOrder.plannedBy = req.user.id;
        workOrder.plannedAt = new Date();
        workOrder.planningNotes = workOrder.planningNotes || "Bulk planned from Manufacturing Order page";
        
        // Update operation statuses
        workOrder.operations.forEach(op => {
          op.status = "scheduled";
        });
        
        await workOrder.save();

        results.success.push({
          id: workOrderId,
          workOrderNumber: workOrder.workOrderNumber,
          stockItemName: workOrder.stockItemName,
          quantity: workOrder.quantity,
          rawMaterialsIssued: stockTransactions.length
        });
        results.totalSuccess++;
        
      } catch (error) {
        console.error(`Error planning work order ${workOrderId}:`, error);
        results.failed.push({ 
          id: workOrderId, 
          reason: error.message || "Unknown error" 
        });
        results.totalFailed++;
      }
      
      results.totalProcessed++;
    }

    res.json({
      success: results.totalSuccess > 0,
      message: `Planned ${results.totalSuccess} work order(s) successfully. ${results.totalFailed} failed.`,
      results
    });
    
  } catch (error) {
    console.error("Error in bulk planning:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while planning work orders",
      error: error.message 
    });
  }
});


module.exports = router;
>>>>>>> origin/main
