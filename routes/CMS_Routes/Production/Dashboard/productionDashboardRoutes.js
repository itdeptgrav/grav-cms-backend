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

/**
 * Parse barcode to extract work order short ID and unit number
 */
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

/**
 * Find work order by short ID
 */
const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({}).lean();
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch (error) {
    console.error("Error finding work order:", error);
    return null;
  }
};

/**
 * Get manufacturing order
 */
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

/**
 * Get employee name by identity ID
 */
const getEmployeeName = async (identityId) => {
  try {
    const employee = await Employee.findOne({
      $or: [
        { identityId: identityId },
        { biometricId: identityId }
      ]
    }).select("firstName lastName").lean();
    
    if (employee) {
      return `${employee.firstName} ${employee.lastName}`;
    }
    return identityId;
  } catch (error) {
    return identityId;
  }
};

/**
 * FIXED: Calculate unit positions and completion
 * A unit is COMPLETE only when it has been scanned in ALL required operations
 */
const calculateUnitPositions = (scans, workOrderOperations, totalUnits) => {
  const unitPositions = {};
  
  // Get total number of operations from work order
  const totalOperations = workOrderOperations.length;
  
  console.log(`📊 Calculating for ${totalUnits} units across ${totalOperations} operations`);

  // Initialize all units
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

  // Group scans by unit number and operation number
  // Key: "unitNumber-operationNumber"
  // Value: array of scans (we only care if it exists, not count)
  const scansByUnitAndOperation = new Map();
  
  scans.forEach((scan) => {
    const parsed = parseBarcode(scan.barcodeId);
    if (parsed.success && parsed.unitNumber) {
      const unitNum = parsed.unitNumber;
      const opNum = parsed.operationNumber || scan.operationNumber || 1;
      
      const key = `${unitNum}-${opNum}`;
      
      if (!scansByUnitAndOperation.has(key)) {
        scansByUnitAndOperation.set(key, []);
      }
      
      scansByUnitAndOperation.get(key).push({
        ...scan,
        timestamp: scan.timestamp || scan.timeStamp,
      });
    }
  });

  console.log(`📦 Found scans for ${scansByUnitAndOperation.size} unique unit-operation combinations`);

  // Now check each unit to see which operations are complete
  for (let unitNum = 1; unitNum <= totalUnits; unitNum++) {
    const unit = unitPositions[unitNum];
    const completedOpsForThisUnit = [];
    
    // Check each operation (1 to totalOperations)
    for (let opNum = 1; opNum <= totalOperations; opNum++) {
      const key = `${unitNum}-${opNum}`;
      const scansForThisOp = scansByUnitAndOperation.get(key);
      
      // If this unit has been scanned in this operation (even once), mark operation as complete
      if (scansForThisOp && scansForThisOp.length > 0) {
        completedOpsForThisUnit.push(opNum);
        
        // Update unit info with latest scan
        const latestScan = scansForThisOp[scansForThisOp.length - 1];
        unit.lastScanTime = latestScan.timestamp;
        unit.currentMachine = latestScan.machineName;
        unit.currentOperator = latestScan.operatorName;
      }
    }
    
    unit.completedOperations = completedOpsForThisUnit.sort((a, b) => a - b);
    
    // CRITICAL: A unit is COMPLETE only when ALL operations are done
    const allOperationsComplete = unit.completedOperations.length === totalOperations;
    
    if (allOperationsComplete) {
      unit.currentOperation = totalOperations;
      unit.status = "completed";
      unit.isMoving = false;
      console.log(`✅ Unit ${unitNum} COMPLETED all ${totalOperations} operations`);
    } else if (unit.completedOperations.length > 0) {
      const lastCompletedOp = unit.completedOperations[unit.completedOperations.length - 1];
      unit.currentOperation = lastCompletedOp;
      unit.status = "in_progress";
      
      if (unit.lastScanTime) {
        const timeSinceLastScan = Date.now() - new Date(unit.lastScanTime);
        unit.isMoving = timeSinceLastScan < 300000; // 5 minutes
      }
      console.log(`🔄 Unit ${unitNum} in progress: ${unit.completedOperations.length}/${totalOperations} operations done`);
    } else {
      unit.currentOperation = 0;
      unit.status = "pending";
      console.log(`⏳ Unit ${unitNum} pending (no scans yet)`);
    }
  }

  return unitPositions;
};

/**
 * FIXED: Calculate production completion by operation
 */
const calculateProductionCompletion = (scans, workOrderOperations, totalUnits) => {
  const operationCompletion = [];
  const totalOperations = workOrderOperations.length;
  
  // For each operation, count how many unique units have been scanned
  for (let opNum = 1; opNum <= totalOperations; opNum++) {
    const operation = workOrderOperations[opNum - 1];
    const uniqueUnitsForThisOp = new Set();
    
    scans.forEach((scan) => {
      const parsed = parseBarcode(scan.barcodeId);
      if (parsed.success && parsed.unitNumber) {
        const scanOpNum = parsed.operationNumber || scan.operationNumber || 1;
        
        // If this scan is for the current operation, add the unit number
        if (scanOpNum === opNum) {
          uniqueUnitsForThisOp.add(parsed.unitNumber);
        }
      }
    });
    
    const completedQuantity = uniqueUnitsForThisOp.size;
    const completionPercentage = Math.round((completedQuantity / totalUnits) * 100);
    
    operationCompletion.push({
      operationNumber: opNum,
      operationType: operation.operationType || `Operation ${opNum}`,
      totalQuantity: totalUnits,
      completedQuantity: completedQuantity,
      completionPercentage: completionPercentage,
    });
    
    console.log(`🔧 Operation ${opNum}: ${completedQuantity}/${totalUnits} units (${completionPercentage}%)`);
  }
  
  return {
    operationCompletion,
  };
};

/**
 * Calculate employee efficiency
 */
const calculateEmployeeEfficiency = (operatorScans, plannedTimePerUnit) => {
  if (operatorScans.length < 2) {
    return {
      avgTimePerUnit: 0,
      efficiency: 0,
      scansPerHour: 0,
      totalProductiveTime: 0,
    };
  }

  const sortedScans = operatorScans.sort(
    (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
  );

  const timeBetweenScans = [];
  for (let i = 1; i < sortedScans.length; i++) {
    const timeDiff =
      (new Date(sortedScans[i].timestamp) -
        new Date(sortedScans[i - 1].timestamp)) /
      1000;
    if (timeDiff < 3600) {
      timeBetweenScans.push(timeDiff);
    }
  }

  if (timeBetweenScans.length === 0) {
    return {
      avgTimePerUnit: 0,
      efficiency: 0,
      scansPerHour: 0,
      totalProductiveTime: 0,
    };
  }

  const avgTimePerUnit =
    timeBetweenScans.reduce((sum, t) => sum + t, 0) / timeBetweenScans.length;
  const efficiency = plannedTimePerUnit
    ? Math.min(100, (plannedTimePerUnit / avgTimePerUnit) * 100)
    : 0;

  const totalProductiveTime = timeBetweenScans.reduce((sum, t) => sum + t, 0);
  const scansPerHour = totalProductiveTime
    ? (operatorScans.length / totalProductiveTime) * 3600
    : 0;

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
 * FIXED: Properly calculate completed units
 */
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
      queryDate = new Date(istTime.toISOString().split('T')[0]);
    }
    queryDate.setHours(0, 0, 0, 0);

    console.log("📊 Fetching production data for IST date:", queryDate.toISOString());

    const trackingDoc = await ProductionTracking.findOne({
      date: queryDate,
    })
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
        machineId: machineId,
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
                operatorName: operatorName,
                signInTime: operator.signInTime,
                signOutTime: operator.signOutTime,
                barcodeScans: operator.barcodeScans || [],
              };

              operationData.operators.push(operatorData);

              // Process scans
              if (operator.barcodeScans) {
                operator.barcodeScans.forEach((scan) => {
                  totalScans++;

                  const parsed = parseBarcode(scan.barcodeId);
                  if (parsed.success) {
                    const woShortId = parsed.workOrderShortId;

                    if (!workOrderScans.has(woShortId)) {
                      workOrderScans.set(woShortId, []);
                    }

                    workOrderScans.get(woShortId).push({
                      ...scan,
                      unitNumber: parsed.unitNumber,
                      operationNumber: parsed.operationNumber || operation.operationNumber,
                      machineId: machineId,
                      machineName: machine.machineId?.name,
                      operatorId: operator.operatorIdentityId,
                      operatorName: operatorName,
                      timestamp: scan.timeStamp || scan.timestamp,
                    });

                    machineInfo.totalScans++;

                    if (
                      !machineInfo.operators.find(
                        (op) => op.operatorId === operator.operatorIdentityId
                      )
                    ) {
                      machineInfo.operators.push({
                        operatorId: operator.operatorIdentityId,
                        operatorName: operatorName,
                        scans: 1,
                      });
                    } else {
                      const op = machineInfo.operators.find(
                        (op) => op.operatorId === operator.operatorIdentityId
                      );
                      op.scans++;
                    }
                  }
                });
              }
            }
          }

          machineInfo.operationTracking.push(operationData);

          if (operation.currentOperatorIdentityId) {
            machineInfo.status = "active";
          } else if (machineInfo.totalScans > 0) {
            machineInfo.status = "used_today";
          }
        }
      }
    }

    const activeWorkOrders = [];

    for (const [woShortId, scans] of workOrderScans) {
      const workOrder = await findWorkOrderByShortId(woShortId);
      if (!workOrder) continue;

      const manufacturingOrder = await getManufacturingOrder(
        workOrder.customerRequestId
      );

      const totalOperations = workOrder.operations?.length || 0;
      
      console.log(`\n🔍 Processing WO ${workOrder.workOrderNumber}:`);
      console.log(`   - Total Units: ${workOrder.quantity}`);
      console.log(`   - Total Operations: ${totalOperations}`);
      console.log(`   - Total Scans: ${scans.length}`);

      // FIXED: Calculate unit positions with correct logic
      const unitPositions = calculateUnitPositions(
        scans,
        workOrder.operations || [],
        workOrder.quantity
      );

      // FIXED: Calculate production completion by operation
      const productionCompletion = calculateProductionCompletion(
        scans,
        workOrder.operations || [],
        workOrder.quantity
      );

      // Count units by status
      const completedUnits = Object.values(unitPositions).filter(
        (u) => u.status === "completed"
      ).length;
      
      const inProgressUnits = Object.values(unitPositions).filter(
        (u) => u.status === "in_progress"
      ).length;

      console.log(`✅ COMPLETED UNITS: ${completedUnits}/${workOrder.quantity}`);
      console.log(`🔄 IN PROGRESS: ${inProgressUnits}`);
      console.log(`⏳ PENDING: ${workOrder.quantity - completedUnits - inProgressUnits}`);

      const operationDistribution = {};
      for (let i = 0; i <= totalOperations + 1; i++) {
        operationDistribution[i] = 0;
      }

      Object.values(unitPositions).forEach((unit) => {
        operationDistribution[unit.currentOperation]++;
      });

      // Employee metrics
      const employeeMetrics = [];
      const employeeScansMap = new Map();

      scans.forEach((scan) => {
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

      for (const [operatorId, data] of employeeScansMap) {
        const plannedTimePerUnit =
          workOrder.operations && workOrder.operations.length > 0
            ? workOrder.operations[0].plannedTimeSeconds || 0
            : 0;

        const efficiency = calculateEmployeeEfficiency(
          data.scans,
          plannedTimePerUnit
        );

        employeeMetrics.push({
          operatorId: data.operatorId,
          operatorName: data.operatorName,
          totalScans: data.scans.length,
          machinesUsed: Array.from(data.machines),
          ...efficiency,
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
        operations: workOrder.operations || [],
        totalScans: scans.length,
        completedUnits: completedUnits,
        inProgressUnits: inProgressUnits,
        pendingUnits: workOrder.quantity - completedUnits - inProgressUnits,
        completionPercentage: Math.round(
          (completedUnits / workOrder.quantity) * 100
        ),
        unitPositions: unitPositions,
        operationDistribution: operationDistribution,
        productionCompletion: productionCompletion,
        employeeMetrics: employeeMetrics,
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
    activeWorkOrders.forEach(wo => {
      console.log(`   - ${wo.workOrderNumber}: ${wo.completedUnits}/${wo.quantity} units done`);
    });

    res.json({
      success: true,
      date: queryDate,
      totalScans: totalScans,
      activeWorkOrders: activeWorkOrders,
      machines: Array.from(machineData.values()),
      stats: {
        totalActiveWorkOrders: activeWorkOrders.length,
        totalMachinesUsed: Array.from(machineData.values()).filter(
          (m) => m.status !== "idle"
        ).length,
        totalActiveMachines: Array.from(machineData.values()).filter(
          (m) => m.status === "active"
        ).length,
      },
    });
  } catch (error) {
    console.error("Error fetching current production:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching production data",
      error: error.message,
    });
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

    const trackingDoc = await ProductionTracking.findOne({
      date: queryDate,
    })
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
              machineStatus.currentOperator = {
                operatorId: operation.currentOperatorIdentityId,
                operationType: operation.operationType,
              };
            }

            if (operation.operators) {
              for (const operator of operation.operators) {
                const operatorName = await getEmployeeName(operator.operatorIdentityId);

                const scanCount = operator.barcodeScans?.length || 0;
                totalScans += scanCount;

                if (scanCount > 0) {
                  operators.push({
                    operatorId: operator.operatorIdentityId,
                    operatorName: operatorName,
                    scans: scanCount,
                    signInTime: operator.signInTime,
                    signOutTime: operator.signOutTime,
                  });

                  operationData.operators.push({
                    operatorIdentityId: operator.operatorIdentityId,
                    operatorName: operatorName,
                    signInTime: operator.signInTime,
                    signOutTime: operator.signOutTime,
                    barcodeScans: operator.barcodeScans,
                  });

                  operator.barcodeScans.forEach((scan) => {
                    const parsed = parseBarcode(scan.barcodeId);
                    if (parsed.success) {
                      workOrderSet.add(parsed.workOrderShortId);
                    }
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

        if (totalScans > 0 && machineStatus.dailyStatus === "idle") {
          machineStatus.dailyStatus = "used_today";
        }
      }
    }

    res.json({
      success: true,
      date: queryDate,
      machines: Array.from(machineStatusMap.values()),
      stats: {
        total: allMachines.length,
        active: Array.from(machineStatusMap.values()).filter(
          (m) => m.isActive
        ).length,
        usedToday: Array.from(machineStatusMap.values()).filter(
          (m) => m.dailyStatus === "used_today" || m.dailyStatus === "active"
        ).length,
        idle: Array.from(machineStatusMap.values()).filter(
          (m) => m.dailyStatus === "idle"
        ).length,
      },
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching machines",
      error: error.message,
    });
  }
});

/**
 * GET /api/cms/production/dashboard/operators
 */
router.get("/operators", async (req, res) => {
  try {
    const operators = await Employee.find({
      needsToOperate: true,
      status: "active",
    })
      .select("firstName lastName identityId biometricId")
      .lean();

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
    res.status(500).json({
      success: false,
      message: "Server error while fetching operators",
      error: error.message,
    });
  }
});


const validateAndParseBarcode = (barcodeId, workOrder) => {
  try {
    const parts = barcodeId.split("-");
    
    // Valid format: WO-{workOrderId}-{unitNumber}-{operationNumber}
    if (parts.length >= 4 && parts[0] === "WO") {
      const woId = parts[1];
      const unitNumber = parseInt(parts[2]);
      const operationNumber = parseInt(parts[3]);
      
      // Validate work order ID matches
      const woIdStr = workOrder._id.toString();
      const woShortId = woIdStr.slice(-8);
      
      if (woId === woShortId || woId === woIdStr) {
        // Validate unit number is within range
        if (unitNumber >= 1 && unitNumber <= workOrder.quantity) {
          // Validate operation number is within range
          const totalOperations = workOrder.operations?.length || 0;
          if (operationNumber >= 1 && operationNumber <= totalOperations) {
            return {
              success: true,
              workOrderId: woId,
              unitNumber: unitNumber,
              operationNumber: operationNumber,
              isValid: true
            };
          }
        }
      }
    }
    return { success: false, error: "Invalid barcode format or data" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};



// Add this to your productionDashboardRoutes.js file:

/**
 * GET /api/cms/production/dashboard/operator-details
 * Get detailed operator information including all sessions
 */
router.get("/operator-details", async (req, res) => {
  try {
    const { operatorId, date } = req.query;
    
    let queryDate;
    if (date) {
      queryDate = new Date(date);
    } else {
      queryDate = new Date();
    }
    queryDate.setHours(0, 0, 0, 0);

    console.log("👤 Fetching operator details:", operatorId, "for date:", queryDate);

    // Get basic employee info
    const employee = await Employee.findOne({
      $or: [
        { identityId: operatorId },
        { biometricId: operatorId },
        { _id: operatorId }
      ]
    })
    .select("firstName lastName identityId biometricId department designation")
    .lean();

    if (!employee) {
      return res.json({
        success: true,
        details: {
          name: operatorId,
          department: "Unknown",
          designation: "Operator"
        }
      });
    }

    // Get tracking data for the day
    const trackingDoc = await ProductionTracking.findOne({
      date: queryDate,
    })
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
                if (operator.operatorIdentityId === operatorId || 
                    operator.operatorIdentityId === employee.identityId ||
                    operator.operatorIdentityId === employee.biometricId) {
                  
                  const scanCount = operator.barcodeScans?.length || 0;
                  totalScans += scanCount;
                  
                  sessions.push({
                    machineId: machine.machineId?._id,
                    machineName: machineName,
                    operationType: operation.operationType,
                    operationNumber: operation.operationNumber,
                    signInTime: operator.signInTime,
                    signOutTime: operator.signOutTime,
                    isCurrent: !operator.signOutTime,
                    scansCount: scanCount,
                    barcodeScans: operator.barcodeScans || []
                  });
                }
              }
            }
          }
        }
      }
    }

    // Calculate efficiency from scans
    let avgTimeBetweenScans = 0;
    let scansPerHour = 0;
    
    if (totalScans > 1) {
      const allScans = sessions.flatMap(s => s.barcodeScans);
      const sortedScans = allScans.sort((a, b) => 
        new Date(a.timeStamp) - new Date(b.timeStamp)
      );
      
      const timeGaps = [];
      for (let i = 1; i < sortedScans.length; i++) {
        const timeDiff = (new Date(sortedScans[i].timeStamp) - 
                         new Date(sortedScans[i-1].timeStamp)) / 1000;
        if (timeDiff > 0 && timeDiff < 28800) {
          timeGaps.push(timeDiff);
        }
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
        totalScans: totalScans,
        avgTimeBetweenScans: avgTimeBetweenScans,
        scansPerHour: scansPerHour,
        efficiency: avgTimeBetweenScans > 0 ? Math.round((3600 / avgTimeBetweenScans) * 100) : 0
      }
    });

  } catch (error) {
    console.error("Error fetching operator details:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching operator details",
      error: error.message,
    });
  }
});

module.exports = router;