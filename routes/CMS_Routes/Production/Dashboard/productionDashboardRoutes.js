// routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes.js
// Schema: machines now have flat operators[] (no operationTracking[]).
// Operation info derived at query time from barcode IDs + WO machine assignments.

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee = require("../../../../models/Employee");

router.use(EmployeeAuthMiddleware);

// ============================================================================
// HELPERS
// ============================================================================

const parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
        operationNumber: parts[3] ? parseInt(parts[3]) : null,
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({}).lean();
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId) || null;
  } catch {
    return null;
  }
};

const getManufacturingOrder = async (customerRequestId) => {
  try {
    return await CustomerRequest.findById(customerRequestId)
      .select("requestId customerInfo moNumber status priority")
      .lean();
  } catch {
    return null;
  }
};

// Cache employee names within a single request to avoid repeated DB hits
const makeEmployeeNameCache = () => {
  const cache = new Map();
  return async (identityId) => {
    if (cache.has(identityId)) return cache.get(identityId);
    try {
      const employee = await Employee.findOne({
        $or: [{ identityId }, { biometricId: identityId }],
      }).select("firstName lastName").lean();
      const name = employee ? `${employee.firstName} ${employee.lastName}` : identityId;
      cache.set(identityId, name);
      return name;
    } catch {
      cache.set(identityId, identityId);
      return identityId;
    }
  };
};

// Which operation number (1-based) is a given machine assigned to in a WO?
const deriveOperationNumber = (machineId, workOrder) => {
  if (!workOrder?.operations) return null;
  for (let i = 0; i < workOrder.operations.length; i++) {
    const op = workOrder.operations[i];
    if (op.assignedMachine?.toString() === machineId) return i + 1;
    if (op.additionalMachines?.some((am) => am.assignedMachine?.toString() === machineId)) return i + 1;
  }
  return null;
};

const calculateUnitPositions = (scans, workOrderOperations, totalUnits) => {
  const unitPositions = {};
  const totalOperations = workOrderOperations.length;

  for (let i = 1; i <= totalUnits; i++) {
    unitPositions[i] = {
      currentOperation: 0,
      completedOperations: [],
      lastScanTime: null,
      currentMachine: null,
      currentOperator: null,
      isMoving: false,
      status: "pending",
    };
  }

  // Group scans by unit+operation
  const scansByUnitOp = new Map();
  scans.forEach((scan) => {
    const parsed = parseBarcode(scan.barcodeId);
    if (parsed.success && parsed.unitNumber) {
      const opNum = parsed.operationNumber || scan.operationNumber || 1;
      const key = `${parsed.unitNumber}-${opNum}`;
      if (!scansByUnitOp.has(key)) scansByUnitOp.set(key, []);
      scansByUnitOp.get(key).push({ ...scan, timestamp: scan.timestamp || scan.timeStamp });
    }
  });

  for (let unitNum = 1; unitNum <= totalUnits; unitNum++) {
    const unit = unitPositions[unitNum];
    const completedOps = [];

    for (let opNum = 1; opNum <= totalOperations; opNum++) {
      const key = `${unitNum}-${opNum}`;
      const scansForOp = scansByUnitOp.get(key);
      if (scansForOp?.length > 0) {
        completedOps.push(opNum);
        const latest = scansForOp[scansForOp.length - 1];
        unit.lastScanTime = latest.timestamp;
        unit.currentMachine = latest.machineName;
        unit.currentOperator = latest.operatorName;
      }
    }

    unit.completedOperations = completedOps.sort((a, b) => a - b);

    if (unit.completedOperations.length === totalOperations) {
      unit.currentOperation = totalOperations;
      unit.status = "completed";
      unit.isMoving = false;
    } else if (unit.completedOperations.length > 0) {
      unit.currentOperation = unit.completedOperations[unit.completedOperations.length - 1];
      unit.status = "in_progress";
      unit.isMoving = unit.lastScanTime
        ? (Date.now() - new Date(unit.lastScanTime)) < 300000
        : false;
    } else {
      unit.currentOperation = 0;
      unit.status = "pending";
    }
  }

  return unitPositions;
};

const calculateProductionCompletion = (scans, workOrderOperations, totalUnits) => {
  const operationCompletion = [];
  for (let opNum = 1; opNum <= workOrderOperations.length; opNum++) {
    const op = workOrderOperations[opNum - 1];
    const uniqueUnits = new Set();
    scans.forEach((scan) => {
      const parsed = parseBarcode(scan.barcodeId);
      if (parsed.success && parsed.unitNumber) {
        const scanOpNum = parsed.operationNumber || scan.operationNumber || 1;
        if (scanOpNum === opNum) uniqueUnits.add(parsed.unitNumber);
      }
    });
    operationCompletion.push({
      operationNumber: opNum,
      operationType: op.operationType || `Operation ${opNum}`,
      totalQuantity: totalUnits,
      completedQuantity: uniqueUnits.size,
      completionPercentage: totalUnits > 0 ? Math.round((uniqueUnits.size / totalUnits) * 100) : 0,
    });
  }
  return { operationCompletion };
};

const calculateEmployeeEfficiency = (scans, plannedTimePerUnit) => {
  if (scans.length < 2) return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };
  const sorted = [...scans].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;
    if (diff > 0 && diff < 3600) gaps.push(diff);
  }
  if (!gaps.length) return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };
  const avg = gaps.reduce((s, t) => s + t, 0) / gaps.length;
  const totalProductiveTime = gaps.reduce((s, t) => s + t, 0);
  return {
    avgTimePerUnit: Math.round(avg),
    efficiency: plannedTimePerUnit ? Math.min(100, Math.round((plannedTimePerUnit / avg) * 100)) : 0,
    scansPerHour: Math.round((scans.length / (totalProductiveTime || 1)) * 3600 * 10) / 10,
    totalProductiveTime: Math.round(totalProductiveTime),
  };
};

// ============================================================================
// MACHINE STATUS
// ============================================================================
router.get("/machine-status", async (req, res) => {
  try {
    const allMachines = await Machine.find({}).lean();
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayDate = new Date(istNow.toISOString().split("T")[0]);
    todayDate.setHours(0, 0, 0, 0);

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const activeTodayMap = new Map();
    if (todayTracking) {
      for (const m of todayTracking.machines || []) {
        const mId = m.machineId?._id?.toString();
        if (mId) activeTodayMap.set(mId, !!m.currentOperatorIdentityId);
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

    const machines = allMachines.map((machine) => {
      const mId = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woEntry = woByMachineMap.get(mId);

      let status = "free";
      if (["Under Maintenance", "maintenance"].includes(machine.status)) status = "maintenance";
      else if (["Offline", "offline"].includes(machine.status)) status = "offline";
      else if (woEntry || isActiveNow) status = "busy";

      let currentWorkOrder = null;
      if (woEntry) {
        const wo = woEntry.wo;
        const pct = wo.quantity > 0
          ? Math.round(((wo.productionCompletion?.overallCompletedQuantity || 0) / wo.quantity) * 100) : 0;
        const totalSecs = wo.timeline?.totalPlannedSeconds || 0;
        const remainSecs = Math.max(0, totalSecs * ((100 - pct) / 100));
        currentWorkOrder = {
          _id: wo._id,
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          status: wo.status,
          quantity: wo.quantity,
          completionPercentage: pct,
          totalPlannedSeconds: totalSecs,
          remainingSeconds: remainSecs,
          estimatedFreeAt: remainSecs > 0 ? new Date(Date.now() + remainSecs * 1000) : null,
        };
      }

      return {
        _id: machine._id,
        name: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        model: machine.model || null,
        location: machine.location || null,
        status,
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
        free: machines.filter((m) => m.status === "free").length,
        busy: machines.filter((m) => m.status === "busy").length,
        maintenance: machines.filter((m) => m.status === "maintenance").length,
        offline: machines.filter((m) => m.status === "offline").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machine status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// CURRENT PRODUCTION  ← Main dashboard feed
// ============================================================================
router.get("/current-production", async (req, res) => {
  try {
    const { date } = req.query;
    let queryDate;
    if (date) {
      queryDate = new Date(date);
    } else {
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      queryDate = new Date(istNow.toISOString().split("T")[0]);
    }
    queryDate.setHours(0, 0, 0, 0);

    console.log("📊 Fetching production data for IST date:", queryDate.toISOString());

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({
        success: true,
        message: "No production data for this date",
        date: queryDate,
        activeWorkOrders: [],
        machines: [],
        totalScans: 0,
        stats: { totalActiveWorkOrders: 0, totalMachinesUsed: 0, totalActiveMachines: 0 },
      });
    }

    const getEmployeeName = makeEmployeeNameCache();

    // ── 1. Build per-machine info + collect scans grouped by WO short ID ──
    const workOrderScans = new Map();  // woShortId -> scan[]
    const machineDataMap = new Map();  // machineId -> machineInfo
    let totalScans = 0;

    for (const machine of trackingDoc.machines) {
      const machineId = machine.machineId?._id?.toString();
      if (!machineId) continue;

      const hasCurrentOperator = !!machine.currentOperatorIdentityId;

      machineDataMap.set(machineId, {
        machineId,
        machineName: machine.machineId?.name || "Unknown",
        machineSerial: machine.machineId?.serialNumber || "N/A",
        machineType: machine.machineId?.type || "Unknown",
        totalScans: 0,
        operators: [],       // {operatorId, operatorName, scans} — for stats
        operatorList: [],    // full operator sessions (for frontend canvas/sidebar)
        status: hasCurrentOperator ? "active" : "idle",
        currentOperator: hasCurrentOperator ? machine.currentOperatorIdentityId : null,
        isActive: hasCurrentOperator,
      });

      const machineInfo = machineDataMap.get(machineId);

      // NEW SCHEMA: flat machine.operators[]
      for (const operator of machine.operators || []) {
        const operatorName = await getEmployeeName(operator.operatorIdentityId);

        // Always include operator in the full list (even if zero scans) — frontend needs this
        machineInfo.operatorList.push({
          operatorIdentityId: operator.operatorIdentityId,
          operatorName,
          signInTime: operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans || [],
        });

        const scanCount = (operator.barcodeScans || []).length;

        if (scanCount === 0) {
          // Operator signed in but no scans yet — still show in operators list
          const existing = machineInfo.operators.find((o) => o.operatorId === operator.operatorIdentityId);
          if (!existing) {
            machineInfo.operators.push({
              operatorId: operator.operatorIdentityId,
              operatorName,
              scans: 0,
              signInTime: operator.signInTime,
              isActive: !operator.signOutTime,
            });
          }
          continue; // No scans to process for WO grouping
        }

        totalScans += scanCount;
        machineInfo.totalScans += scanCount;

        // Track in operators summary
        const existingOp = machineInfo.operators.find((o) => o.operatorId === operator.operatorIdentityId);
        if (!existingOp) {
          machineInfo.operators.push({
            operatorId: operator.operatorIdentityId,
            operatorName,
            scans: scanCount,
            signInTime: operator.signInTime,
            isActive: !operator.signOutTime,
          });
        } else {
          existingOp.scans += scanCount;
        }

        // Group scans by WO short ID (WO-conflict-safe: each barcode carries its own WO context)
        for (const scan of operator.barcodeScans) {
          const parsed = parseBarcode(scan.barcodeId);
          if (!parsed.success) continue;

          const woShortId = parsed.workOrderShortId;
          if (!workOrderScans.has(woShortId)) workOrderScans.set(woShortId, []);

          // operationNumber will be enriched after we fetch the WO below
          workOrderScans.get(woShortId).push({
            barcodeId: scan.barcodeId,
            unitNumber: parsed.unitNumber,
            operationNumber: parsed.operationNumber, // from barcode if present
            machineId,
            machineName: machine.machineId?.name,
            operatorId: operator.operatorIdentityId,
            operatorName,
            timestamp: scan.timeStamp,
          });
        }

        if (machineInfo.status === "idle" && scanCount > 0) {
          machineInfo.status = "used_today";
        }
      }
    }

    // ── 2. Build active work orders — one per WO short ID ──────────────────
    const activeWorkOrders = [];

    for (const [woShortId, scans] of workOrderScans) {
      const workOrder = await findWorkOrderByShortId(woShortId);
      if (!workOrder) continue;

      // Enrich scans with derived operation numbers from machine assignments
      const enrichedScans = scans.map((scan) => {
        if (scan.operationNumber) return scan;
        const opNum = deriveOperationNumber(scan.machineId, workOrder);
        return { ...scan, operationNumber: opNum || 1 };
      });

      const manufacturingOrder = await getManufacturingOrder(workOrder.customerRequestId);
      const unitPositions = calculateUnitPositions(enrichedScans, workOrder.operations || [], workOrder.quantity);
      const productionCompletion = calculateProductionCompletion(enrichedScans, workOrder.operations || [], workOrder.quantity);

      const completedUnits = Object.values(unitPositions).filter((u) => u.status === "completed").length;
      const inProgressUnits = Object.values(unitPositions).filter((u) => u.status === "in_progress").length;

      const operationDistribution = {};
      for (let i = 0; i <= (workOrder.operations?.length || 0) + 1; i++) operationDistribution[i] = 0;
      Object.values(unitPositions).forEach((u) => { operationDistribution[u.currentOperation]++; });

      // Employee metrics — one entry per operator, scans filtered to THIS WO only
      const employeeScansMap = new Map();
      enrichedScans.forEach((scan) => {
        if (!employeeScansMap.has(scan.operatorId)) {
          employeeScansMap.set(scan.operatorId, {
            operatorId: scan.operatorId,
            operatorName: scan.operatorName,
            scans: [],
            machines: new Set(),
          });
        }
        const empData = employeeScansMap.get(scan.operatorId);
        empData.scans.push(scan);
        empData.machines.add(scan.machineName);
      });

      // Also include operators who are signed in to an assigned machine but have zero scans for this WO
      const assignedMachineIds = new Set(
        (workOrder.operations || [])
          .flatMap((op) => [
            op.assignedMachine?.toString(),
            ...(op.additionalMachines || []).map((am) => am.assignedMachine?.toString()),
          ])
          .filter(Boolean)
      );

      for (const [machineId, machineInfo] of machineDataMap) {
        if (!assignedMachineIds.has(machineId)) continue;
        for (const opr of machineInfo.operatorList || []) {
          if (opr.signOutTime) continue; // already signed out
          if (employeeScansMap.has(opr.operatorIdentityId)) continue; // already in metrics

          // Check if this operator has zero scans specifically for this WO
          const hasWOScans = (opr.barcodeScans || []).some((s) => {
            const p = parseBarcode(s.barcodeId);
            return p.success && p.workOrderShortId === woShortId;
          });

          if (!hasWOScans) {
            employeeScansMap.set(opr.operatorIdentityId, {
              operatorId: opr.operatorIdentityId,
              operatorName: opr.operatorName,
              scans: [],
              machines: new Set([machineInfo.machineName]),
              isSignedInOnly: true, // flag for frontend
            });
          }
        }
      }

      const employeeMetrics = [];
      for (const [, data] of employeeScansMap) {
        const plannedTime = workOrder.operations?.[0]?.plannedTimeSeconds || 0;
        const eff = calculateEmployeeEfficiency(data.scans, plannedTime);
        employeeMetrics.push({
          operatorId: data.operatorId,
          operatorName: data.operatorName,
          totalScans: data.scans.length,
          machinesUsed: Array.from(data.machines),
          isSignedInOnly: data.isSignedInOnly || false,
          ...eff,
        });
      }

      activeWorkOrders.push({
        workOrderId: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        workOrderShortId: woShortId,
        stockItemName: workOrder.stockItemName,
        quantity: workOrder.quantity,
        status: workOrder.status,
        priority: workOrder.priority,
        manufacturingOrder: manufacturingOrder
          ? {
              id: manufacturingOrder._id,
              moNumber: `MO-${manufacturingOrder.requestId}`,
              customerName: manufacturingOrder.customerInfo?.name,
            }
          : null,
        operations: (workOrder.operations || []).map((op, idx) => ({
          ...op,
          assignedMachineName: op.assignedMachineName || null,
        })),
        totalScans: enrichedScans.length,
        completedUnits,
        inProgressUnits,
        pendingUnits: workOrder.quantity - completedUnits - inProgressUnits,
        completionPercentage: workOrder.quantity > 0
          ? Math.round((completedUnits / workOrder.quantity) * 100) : 0,
        unitPositions,
        operationDistribution,
        productionCompletion,
        // Historical data from WorkOrder schema (cron-synced by productionSyncService)
        woProductionCompletion: workOrder.productionCompletion || null,
        employeeMetrics,
        lastScanTime: enrichedScans.length > 0
          ? enrichedScans[enrichedScans.length - 1]?.timestamp : null,
      });
    }

    // ── 3. Also capture machines with signed-in operators but zero WO scans ─
    // These machines show on the canvas as "active" even though no WO barcode scanned yet.
    // We already built machineDataMap with full operatorList — frontend uses that.

    activeWorkOrders.sort((a, b) => {
      if (!a.lastScanTime) return 1;
      if (!b.lastScanTime) return -1;
      return new Date(b.lastScanTime) - new Date(a.lastScanTime);
    });

    res.json({
      success: true,
      date: queryDate,
      totalScans,
      activeWorkOrders,
      // machines array: FULL machine data including operatorList (flat operators[])
      // The frontend uses this for per-machine operator details on the canvas/sidebar
      machines: Array.from(machineDataMap.values()),
      stats: {
        totalActiveWorkOrders: activeWorkOrders.length,
        totalMachinesUsed: Array.from(machineDataMap.values()).filter((m) => m.status !== "idle").length,
        totalActiveMachines: Array.from(machineDataMap.values()).filter((m) => m.status === "active").length,
      },
    });
  } catch (error) {
    console.error("Error fetching current production:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// ALL MACHINES
// ============================================================================
router.get("/all-machines", async (req, res) => {
  try {
    const { date } = req.query;
    const queryDate = date ? new Date(date) : new Date();
    queryDate.setHours(0, 0, 0, 0);

    const allMachines = await Machine.find({}).lean();
    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId")
      .lean();

    const getEmployeeName = makeEmployeeNameCache();

    const machineStatusMap = new Map();
    allMachines.forEach((machine) => {
      machineStatusMap.set(machine._id.toString(), {
        _id: machine._id,
        name: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        status: machine.status,
        location: machine.location,
        dailyStatus: "idle",
        totalScans: 0,
        operators: [],
        workOrders: [],
        currentOperator: null,
        isActive: false,
      });
    });

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineId = machine.machineId?._id?.toString();
        if (!machineId || !machineStatusMap.has(machineId)) continue;

        const machineStatus = machineStatusMap.get(machineId);

        if (machine.currentOperatorIdentityId) {
          machineStatus.isActive = true;
          machineStatus.dailyStatus = "active";
          machineStatus.currentOperator = { operatorId: machine.currentOperatorIdentityId };
        }

        let totalScans = 0;
        const operators = [];
        const workOrderSet = new Set();

        // NEW SCHEMA: flat machine.operators[]
        for (const operator of machine.operators || []) {
          const operatorName = await getEmployeeName(operator.operatorIdentityId);
          const scanCount = operator.barcodeScans?.length || 0;
          totalScans += scanCount;

          // Include even zero-scan operators if currently active
          const isActive = !operator.signOutTime;
          if (scanCount > 0 || isActive) {
            operators.push({
              operatorId: operator.operatorIdentityId,
              operatorName,
              scans: scanCount,
              signInTime: operator.signInTime,
              signOutTime: operator.signOutTime,
              isActive,
            });
          }

          (operator.barcodeScans || []).forEach((scan) => {
            const parsed = parseBarcode(scan.barcodeId);
            if (parsed.success) workOrderSet.add(parsed.workOrderShortId);
          });
        }

        machineStatus.totalScans = totalScans;
        machineStatus.operators = operators;
        machineStatus.workOrders = Array.from(workOrderSet);
        if (totalScans > 0 && machineStatus.dailyStatus === "idle") {
          machineStatus.dailyStatus = "used_today";
        }
      }
    }

    const machinesArray = Array.from(machineStatusMap.values());
    res.json({
      success: true,
      date: queryDate,
      machines: machinesArray,
      stats: {
        total: allMachines.length,
        active: machinesArray.filter((m) => m.isActive).length,
        usedToday: machinesArray.filter((m) => ["used_today", "active"].includes(m.dailyStatus)).length,
        idle: machinesArray.filter((m) => m.dailyStatus === "idle").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// OPERATORS
// ============================================================================
router.get("/operators", async (req, res) => {
  try {
    const operators = await Employee.find({ needsToOperate: true, status: "active" })
      .select("firstName lastName identityId biometricId").lean();

    res.json({
      success: true,
      operators: operators.map((op) => ({
        _id: op._id,
        identityId: op.identityId || op.biometricId,
        name: `${op.firstName} ${op.lastName}`,
        firstName: op.firstName,
        lastName: op.lastName,
      })),
      total: operators.length,
    });
  } catch (error) {
    console.error("Error fetching operators:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// OPERATOR DETAILS
// ============================================================================
router.get("/operator-details", async (req, res) => {
  try {
    const { operatorId, date } = req.query;
    let queryDate = date ? new Date(date) : new Date();
    queryDate.setHours(0, 0, 0, 0);

    const employee = await Employee.findOne({
      $or: [{ identityId: operatorId }, { biometricId: operatorId }, { _id: operatorId }],
    }).select("firstName lastName identityId biometricId department designation").lean();

    if (!employee) {
      return res.json({
        success: true,
        details: { name: operatorId, department: "Unknown", designation: "Operator" },
      });
    }

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const sessions = [];
    let totalScans = 0;

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineName = machine.machineId?.name || "Unknown";
        // NEW SCHEMA: flat machine.operators[]
        for (const operator of machine.operators || []) {
          const isThisOperator =
            operator.operatorIdentityId === operatorId ||
            operator.operatorIdentityId === employee.identityId ||
            operator.operatorIdentityId === employee.biometricId;
          if (!isThisOperator) continue;

          const scanCount = operator.barcodeScans?.length || 0;
          totalScans += scanCount;
          sessions.push({
            machineId: machine.machineId?._id,
            machineName,
            signInTime: operator.signInTime,
            signOutTime: operator.signOutTime,
            isCurrent: !operator.signOutTime,
            scansCount: scanCount,
            barcodeScans: operator.barcodeScans || [],
          });
        }
      }
    }

    let avgTimeBetweenScans = 0, scansPerHour = 0;
    if (totalScans > 1) {
      const allScans = sessions.flatMap((s) => s.barcodeScans);
      const sorted = allScans.sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const diff = (new Date(sorted[i].timeStamp) - new Date(sorted[i - 1].timeStamp)) / 1000;
        if (diff > 0 && diff < 28800) gaps.push(diff);
      }
      if (gaps.length > 0) {
        avgTimeBetweenScans = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
        scansPerHour = Math.round((3600 / avgTimeBetweenScans) * 10) / 10;
      }
    }

    res.json({
      success: true,
      details: {
        name: `${employee.firstName} ${employee.lastName}`,
        identityId: employee.identityId || employee.biometricId,
        department: employee.department || "Production",
        designation: employee.designation || "Operator",
        sessions: sessions.sort((a, b) => new Date(b.signInTime) - new Date(a.signInTime)),
        totalScans,
        avgTimeBetweenScans,
        scansPerHour,
        efficiency: avgTimeBetweenScans > 0 ? Math.round((3600 / avgTimeBetweenScans) * 100) : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching operator details:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;