// routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee = require("../../../../models/Employee");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ============================================================================
// HELPER FUNCTIONS
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
    return { success: false, error: "Invalid barcode format" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    // Use lean: false initially to get full doc including productionCompletion
    const workOrders = await WorkOrder.find({}).lean();
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch (error) {
    console.error("Error finding work order:", error);
    return null;
  }
};

const getManufacturingOrder = async (customerRequestId) => {
  try {
    return await CustomerRequest.findById(customerRequestId)
      .select("requestId customerInfo moNumber status priority")
      .lean();
  } catch (error) {
    console.error("Error fetching manufacturing order:", error);
    return null;
  }
};

const getEmployeeName = async (identityId) => {
  try {
    const employee = await Employee.findOne({
      $or: [{ identityId: identityId }, { biometricId: identityId }],
    })
      .select("firstName lastName")
      .lean();
    if (employee) return `${employee.firstName} ${employee.lastName}`;
    return identityId;
  } catch (error) {
    return identityId;
  }
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

  const scansByUnitAndOperation = new Map();
  scans.forEach((scan) => {
    const parsed = parseBarcode(scan.barcodeId);
    if (parsed.success && parsed.unitNumber) {
      const unitNum = parsed.unitNumber;
      const opNum = parsed.operationNumber || scan.operationNumber || 1;
      const key = `${unitNum}-${opNum}`;
      if (!scansByUnitAndOperation.has(key)) scansByUnitAndOperation.set(key, []);
      scansByUnitAndOperation.get(key).push({ ...scan, timestamp: scan.timestamp || scan.timeStamp });
    }
  });

  for (let unitNum = 1; unitNum <= totalUnits; unitNum++) {
    const unit = unitPositions[unitNum];
    const completedOpsForThisUnit = [];

    for (let opNum = 1; opNum <= totalOperations; opNum++) {
      const key = `${unitNum}-${opNum}`;
      const scansForThisOp = scansByUnitAndOperation.get(key);
      if (scansForThisOp && scansForThisOp.length > 0) {
        completedOpsForThisUnit.push(opNum);
        const latestScan = scansForThisOp[scansForThisOp.length - 1];
        unit.lastScanTime = latestScan.timestamp;
        unit.currentMachine = latestScan.machineName;
        unit.currentOperator = latestScan.operatorName;
      }
    }

    unit.completedOperations = completedOpsForThisUnit.sort((a, b) => a - b);
    const allOperationsComplete = unit.completedOperations.length === totalOperations;

    if (allOperationsComplete) {
      unit.currentOperation = totalOperations;
      unit.status = "completed";
      unit.isMoving = false;
    } else if (unit.completedOperations.length > 0) {
      const lastCompletedOp = unit.completedOperations[unit.completedOperations.length - 1];
      unit.currentOperation = lastCompletedOp;
      unit.status = "in_progress";
      if (unit.lastScanTime) {
        const timeSinceLastScan = Date.now() - new Date(unit.lastScanTime);
        unit.isMoving = timeSinceLastScan < 300000;
      }
    } else {
      unit.currentOperation = 0;
      unit.status = "pending";
    }
  }

  return unitPositions;
};

const calculateProductionCompletion = (scans, workOrderOperations, totalUnits) => {
  const operationCompletion = [];
  const totalOperations = workOrderOperations.length;

  for (let opNum = 1; opNum <= totalOperations; opNum++) {
    const operation = workOrderOperations[opNum - 1];
    const uniqueUnitsForThisOp = new Set();

    scans.forEach((scan) => {
      const parsed = parseBarcode(scan.barcodeId);
      if (parsed.success && parsed.unitNumber) {
        const scanOpNum = parsed.operationNumber || scan.operationNumber || 1;
        if (scanOpNum === opNum) uniqueUnitsForThisOp.add(parsed.unitNumber);
      }
    });

    const completedQuantity = uniqueUnitsForThisOp.size;
    operationCompletion.push({
      operationNumber: opNum,
      operationType: operation.operationType || `Operation ${opNum}`,
      totalQuantity: totalUnits,
      completedQuantity,
      completionPercentage: Math.round((completedQuantity / totalUnits) * 100),
    });
  }

  return { operationCompletion };
};

const calculateEmployeeEfficiency = (operatorScans, plannedTimePerUnit) => {
  if (operatorScans.length < 2) return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };

  const sortedScans = operatorScans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const timeBetweenScans = [];
  for (let i = 1; i < sortedScans.length; i++) {
    const timeDiff = (new Date(sortedScans[i].timestamp) - new Date(sortedScans[i - 1].timestamp)) / 1000;
    if (timeDiff < 3600) timeBetweenScans.push(timeDiff);
  }

  if (timeBetweenScans.length === 0) return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };

  const avgTimePerUnit = timeBetweenScans.reduce((sum, t) => sum + t, 0) / timeBetweenScans.length;
  const efficiency = plannedTimePerUnit ? Math.min(100, (plannedTimePerUnit / avgTimePerUnit) * 100) : 0;
  const totalProductiveTime = timeBetweenScans.reduce((sum, t) => sum + t, 0);
  const scansPerHour = totalProductiveTime ? (operatorScans.length / totalProductiveTime) * 3600 : 0;

  return {
    avgTimePerUnit: Math.round(avgTimePerUnit),
    efficiency: Math.round(efficiency),
    scansPerHour: Math.round(scansPerHour * 10) / 10,
    totalProductiveTime: Math.round(totalProductiveTime),
  };
};

// ============================================================================
// API ENDPOINTS
// ============================================================================

/**
 * GET /api/cms/production/dashboard/current-production
 * FIXED: Now includes productionCompletion from WorkOrder schema (overall historical data)
 */



router.get("/machine-status", async (req, res) => {
  try {
    // 1. ALL machines — no status filter, no type filter
    const allMachines = await Machine.find({}).lean();

    // 2. Today's IST date
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow    = new Date(Date.now() + istOffset);
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
      const mId         = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woEntry     = woByMachineMap.get(mId);

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
        const wo  = woEntry.wo;
        const pct = wo.quantity > 0
          ? Math.round(((wo.productionCompletion?.overallCompletedQuantity || 0) / wo.quantity) * 100)
          : 0;
        const totalSecs    = wo.timeline?.totalPlannedSeconds || 0;
        const remainSecs   = Math.max(0, totalSecs * ((100 - pct) / 100));
        const estimatedFreeAt = remainSecs > 0 ? new Date(Date.now() + remainSecs * 1000) : null;

        currentWorkOrder = {
          _id: wo._id,
          workOrderNumber: wo.workOrderNumber,
          stockItemName:   wo.stockItemName,
          status:          wo.status,
          quantity:        wo.quantity,
          completionPercentage: pct,
          totalPlannedSeconds:  totalSecs,
          remainingSeconds:     remainSecs,
          estimatedFreeAt,
        };
      }

      return {
        _id:            machine._id,
        name:           machine.name,
        serialNumber:   machine.serialNumber,
        type:           machine.type,
        model:          machine.model  || null,
        location:       machine.location || null,
        status,                    // "free" | "busy" | "maintenance" | "offline"
        currentWorkOrder,
        isActiveToday:  isActiveNow,
        freeFromDate:   status === "free" ? (machine.updatedAt || null) : null,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
      };
    });

    res.json({
      success: true,
      machines,
      summary: {
        total:       machines.length,
        free:        machines.filter(m => m.status === "free").length,
        busy:        machines.filter(m => m.status === "busy").length,
        maintenance: machines.filter(m => m.status === "maintenance").length,
        offline:     machines.filter(m => m.status === "offline").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machine status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});



router.get("/current-production", async (req, res) => {
  try {
    const { date } = req.query;

    let queryDate;
    if (date) {
      queryDate = new Date(date);
    } else {
      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istTime = new Date(now.getTime() + istOffset);
      queryDate = new Date(istTime.toISOString().split("T")[0]);
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
      });
    }

    const workOrderScans = new Map();
    const machineData = new Map();
    let totalScans = 0;

    // Collect all scans and populate operator names
    for (const machine of trackingDoc.machines) {
      const machineId = machine.machineId?._id?.toString();
      if (!machineId) continue;

      machineData.set(machineId, {
        machineId,
        machineName: machine.machineId?.name || "Unknown",
        machineSerial: machine.machineId?.serialNumber || "N/A",
        machineType: machine.machineId?.type || "Unknown",
        totalScans: 0,
        operators: [],
        status: "idle",
        operationTracking: [],
      });

      const machineInfo = machineData.get(machineId);

      if (machine.operationTracking) {
        machineInfo.operationTracking = [];

        for (const operation of machine.operationTracking) {
          const operationData = {
            operationNumber: operation.operationNumber,
            operationType: operation.operationType,
            currentOperatorIdentityId: operation.currentOperatorIdentityId,
            operators: [],
          };

          if (operation.operators) {
            for (const operator of operation.operators) {
              const operatorName = await getEmployeeName(operator.operatorIdentityId);

              const operatorData = {
                operatorIdentityId: operator.operatorIdentityId,
                operatorName,
                signInTime: operator.signInTime,
                signOutTime: operator.signOutTime,
                barcodeScans: operator.barcodeScans || [],
              };

              operationData.operators.push(operatorData);

              if (operator.barcodeScans) {
                operator.barcodeScans.forEach((scan) => {
                  totalScans++;
                  const parsed = parseBarcode(scan.barcodeId);
                  if (parsed.success) {
                    const woShortId = parsed.workOrderShortId;
                    if (!workOrderScans.has(woShortId)) workOrderScans.set(woShortId, []);
                    workOrderScans.get(woShortId).push({
                      ...scan,
                      unitNumber: parsed.unitNumber,
                      operationNumber: parsed.operationNumber || operation.operationNumber,
                      machineId,
                      machineName: machine.machineId?.name,
                      operatorId: operator.operatorIdentityId,
                      operatorName,
                      timestamp: scan.timeStamp || scan.timestamp,
                    });
                    machineInfo.totalScans++;
                    const existingOp = machineInfo.operators.find(op => op.operatorId === operator.operatorIdentityId);
                    if (!existingOp) {
                      machineInfo.operators.push({ operatorId: operator.operatorIdentityId, operatorName, scans: 1 });
                    } else {
                      existingOp.scans++;
                    }
                  }
                });
              }
            }
          }

          machineInfo.operationTracking.push(operationData);

          if (operation.currentOperatorIdentityId) machineInfo.status = "active";
          else if (machineInfo.totalScans > 0) machineInfo.status = "used_today";
        }
      }
    }

    const activeWorkOrders = [];

    for (const [woShortId, scans] of workOrderScans) {
      // ── IMPORTANT: fetch full WO doc including productionCompletion ──
      const workOrder = await findWorkOrderByShortId(woShortId);
      if (!workOrder) continue;

      const manufacturingOrder = await getManufacturingOrder(workOrder.customerRequestId);
      const totalOperations = workOrder.operations?.length || 0;

      console.log(`\n🔍 Processing WO ${workOrder.workOrderNumber}:`);
      console.log(`   - Total Units: ${workOrder.quantity}`);
      console.log(`   - Total Operations: ${totalOperations}`);
      console.log(`   - Total Scans Today: ${scans.length}`);
      // Log the cron-synced overall completion
      console.log(`   - Overall Completed (cron): ${workOrder.productionCompletion?.overallCompletedQuantity ?? "N/A"}`);

      const unitPositions = calculateUnitPositions(scans, workOrder.operations || [], workOrder.quantity);
      const productionCompletion = calculateProductionCompletion(scans, workOrder.operations || [], workOrder.quantity);

      const completedUnits = Object.values(unitPositions).filter(u => u.status === "completed").length;
      const inProgressUnits = Object.values(unitPositions).filter(u => u.status === "in_progress").length;

      console.log(`✅ TODAY COMPLETED: ${completedUnits}/${workOrder.quantity}`);
      console.log(`🔄 IN PROGRESS: ${inProgressUnits}`);

      const operationDistribution = {};
      for (let i = 0; i <= totalOperations + 1; i++) operationDistribution[i] = 0;
      Object.values(unitPositions).forEach(unit => { operationDistribution[unit.currentOperation]++; });

      // Employee metrics
      const employeeMetrics = [];
      const employeeScansMap = new Map();
      scans.forEach((scan) => {
        if (!employeeScansMap.has(scan.operatorId)) {
          employeeScansMap.set(scan.operatorId, { operatorId: scan.operatorId, operatorName: scan.operatorName, scans: [], machines: new Set() });
        }
        const empData = employeeScansMap.get(scan.operatorId);
        empData.scans.push(scan);
        empData.machines.add(scan.machineName);
      });

      for (const [operatorId, data] of employeeScansMap) {
        const plannedTimePerUnit = workOrder.operations?.length > 0 ? (workOrder.operations[0].plannedTimeSeconds || 0) : 0;
        const efficiency = calculateEmployeeEfficiency(data.scans, plannedTimePerUnit);
        employeeMetrics.push({
          operatorId: data.operatorId,
          operatorName: data.operatorName,
          totalScans: data.scans.length,
          machinesUsed: Array.from(data.machines),
          avgTimeBetweenOperations: efficiency.avgTimePerUnit,
          ...efficiency,
        });
      }

      // ── KEY FIX: attach the WO's productionCompletion (cron-synced overall data) ──
      const woProductionCompletion = workOrder.productionCompletion || null;

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
        operations: workOrder.operations || [],

        // Today's counts (from today's scans)
        totalScans: scans.length,
        completedUnits,           // units fully completed TODAY
        inProgressUnits,
        pendingUnits: workOrder.quantity - completedUnits - inProgressUnits,
        completionPercentage: Math.round((completedUnits / workOrder.quantity) * 100),

        unitPositions,
        operationDistribution,
        productionCompletion,    // today's operation-level breakdown

        // ── OVERALL historical data from WorkOrder schema (cron-synced) ──
        woProductionCompletion,  // { overallCompletedQuantity, overallCompletionPercentage, operationCompletion, ... }

        employeeMetrics,
        lastScanTime: scans.length > 0 ? scans[scans.length - 1].timestamp : null,
      });
    }

    activeWorkOrders.sort((a, b) => {
      if (!a.lastScanTime) return 1;
      if (!b.lastScanTime) return -1;
      return new Date(b.lastScanTime) - new Date(a.lastScanTime);
    });

    console.log(`\n📈 SUMMARY:`);
    console.log(`   Total Active WOs: ${activeWorkOrders.length}`);
    console.log(`   Total Scans: ${totalScans}`);
    activeWorkOrders.forEach((wo) => {
      console.log(`   - ${wo.workOrderNumber}: today=${wo.completedUnits}/${wo.quantity}, overall=${wo.woProductionCompletion?.overallCompletedQuantity ?? "N/A"}`);
    });

    res.json({
      success: true,
      date: queryDate,
      totalScans,
      activeWorkOrders,
      machines: Array.from(machineData.values()),
      stats: {
        totalActiveWorkOrders: activeWorkOrders.length,
        totalMachinesUsed: Array.from(machineData.values()).filter(m => m.status !== "idle").length,
        totalActiveMachines: Array.from(machineData.values()).filter(m => m.status === "active").length,
      },
    });
  } catch (error) {
    console.error("Error fetching current production:", error);
    res.status(500).json({ success: false, message: "Server error while fetching production data", error: error.message });
  }
});

/**
 * GET /api/cms/production/dashboard/all-machines
 */
router.get("/all-machines", async (req, res) => {
  try {
    const { date } = req.query;
    const queryDate = date ? new Date(date) : new Date();
    queryDate.setHours(0, 0, 0, 0);

    const allMachines = await Machine.find({}).lean();
    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId")
      .lean();

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
        operationTracking: [],
      });
    });

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineId = machine.machineId?._id?.toString();
        if (!machineId || !machineStatusMap.has(machineId)) continue;

        const machineStatus = machineStatusMap.get(machineId);
        let totalScans = 0;
        const operators = [];
        const workOrderSet = new Set();

        if (machine.operationTracking) {
          machineStatus.operationTracking = [];

          for (const operation of machine.operationTracking) {
            const operationData = {
              operationNumber: operation.operationNumber,
              operationType: operation.operationType,
              currentOperatorIdentityId: operation.currentOperatorIdentityId,
              operators: [],
            };

            if (operation.currentOperatorIdentityId) {
              machineStatus.isActive = true;
              machineStatus.dailyStatus = "active";
              machineStatus.currentOperator = { operatorId: operation.currentOperatorIdentityId, operationType: operation.operationType };
            }

            if (operation.operators) {
              for (const operator of operation.operators) {
                const operatorName = await getEmployeeName(operator.operatorIdentityId);
                const scanCount = operator.barcodeScans?.length || 0;
                totalScans += scanCount;

                if (scanCount > 0) {
                  operators.push({ operatorId: operator.operatorIdentityId, operatorName, scans: scanCount, signInTime: operator.signInTime, signOutTime: operator.signOutTime });
                  operationData.operators.push({ operatorIdentityId: operator.operatorIdentityId, operatorName, signInTime: operator.signInTime, signOutTime: operator.signOutTime, barcodeScans: operator.barcodeScans });
                  operator.barcodeScans.forEach((scan) => {
                    const parsed = parseBarcode(scan.barcodeId);
                    if (parsed.success) workOrderSet.add(parsed.workOrderShortId);
                  });
                }
              }
            }
            machineStatus.operationTracking.push(operationData);
          }
        }

        machineStatus.totalScans = totalScans;
        machineStatus.operators = operators;
        machineStatus.workOrders = Array.from(workOrderSet);
        if (totalScans > 0 && machineStatus.dailyStatus === "idle") machineStatus.dailyStatus = "used_today";
      }
    }

    res.json({
      success: true,
      date: queryDate,
      machines: Array.from(machineStatusMap.values()),
      stats: {
        total: allMachines.length,
        active: Array.from(machineStatusMap.values()).filter(m => m.isActive).length,
        usedToday: Array.from(machineStatusMap.values()).filter(m => m.dailyStatus === "used_today" || m.dailyStatus === "active").length,
        idle: Array.from(machineStatusMap.values()).filter(m => m.dailyStatus === "idle").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({ success: false, message: "Server error while fetching machines", error: error.message });
  }
});

/**
 * GET /api/cms/production/dashboard/operators
 */
router.get("/operators", async (req, res) => {
  try {
    const operators = await Employee.find({ needsToOperate: true, status: "active" })
      .select("firstName lastName identityId biometricId")
      .lean();

    res.json({
      success: true,
      operators: operators.map(op => ({
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
    res.status(500).json({ success: false, message: "Server error while fetching operators", error: error.message });
  }
});

/**
 * GET /api/cms/production/dashboard/operator-details
 */
router.get("/operator-details", async (req, res) => {
  try {
    const { operatorId, date } = req.query;
    let queryDate = date ? new Date(date) : new Date();
    queryDate.setHours(0, 0, 0, 0);

    const employee = await Employee.findOne({
      $or: [{ identityId: operatorId }, { biometricId: operatorId }, { _id: operatorId }],
    }).select("firstName lastName identityId biometricId department designation").lean();

    if (!employee) {
      return res.json({ success: true, details: { name: operatorId, department: "Unknown", designation: "Operator" } });
    }

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const sessions = [];
    let totalScans = 0;

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineName = machine.machineId?.name || "Unknown";
        if (machine.operationTracking) {
          for (const operation of machine.operationTracking) {
            if (operation.operators) {
              for (const operator of operation.operators) {
                if (operator.operatorIdentityId === operatorId || operator.operatorIdentityId === employee.identityId || operator.operatorIdentityId === employee.biometricId) {
                  const scanCount = operator.barcodeScans?.length || 0;
                  totalScans += scanCount;
                  sessions.push({
                    machineId: machine.machineId?._id,
                    machineName,
                    operationType: operation.operationType,
                    operationNumber: operation.operationNumber,
                    signInTime: operator.signInTime,
                    signOutTime: operator.signOutTime,
                    isCurrent: !operator.signOutTime,
                    scansCount: scanCount,
                    barcodeScans: operator.barcodeScans || [],
                  });
                }
              }
            }
          }
        }
      }
    }

    let avgTimeBetweenScans = 0, scansPerHour = 0;
    if (totalScans > 1) {
      const allScans = sessions.flatMap(s => s.barcodeScans);
      const sortedScans = allScans.sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
      const timeGaps = [];
      for (let i = 1; i < sortedScans.length; i++) {
        const timeDiff = (new Date(sortedScans[i].timeStamp) - new Date(sortedScans[i - 1].timeStamp)) / 1000;
        if (timeDiff > 0 && timeDiff < 28800) timeGaps.push(timeDiff);
      }
      if (timeGaps.length > 0) {
        avgTimeBetweenScans = Math.round(timeGaps.reduce((a, b) => a + b, 0) / timeGaps.length);
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
    res.status(500).json({ success: false, message: "Server error while fetching operator details", error: error.message });
  }
});

module.exports = router;









// Ok let's move to the another page where basically the WO are going for the planning(means assigning the machine's to each and every operations) ok so currently the machine's are getting suggest in dropdown which is very bad because the admin/project manager can't get to know which machine it is and whether it is in free or assigned work, or if assigned then what's the deadline/expected time to be complete(you can get from the WO) so as per the various perspective the admin goona choose the machine and that machine will goona assigned 



// means in the 2nd tab where the machine assign are happening to each and every operations, so basically now it's need to showcase in an canvas ok where first of all the designed machine alignment structure need to showcase and also showcase all the corresponding machine's status means busy or free if busy then when it is goona free , if free then from what date it is getting free ok so properly  the admin can understand ok..



// and the corresponding operations needed to keep in the left/right sidebar ok so that the admin can just drag the operations and drop/put in the corresponding machine's ok so that we can say ki that operations is assigned with the corresponding machine's where getting dropped ok so keep an button for Assigned & Next ok.



