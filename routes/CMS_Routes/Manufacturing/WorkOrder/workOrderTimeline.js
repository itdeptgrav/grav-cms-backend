// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes.js
const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

router.use(EmployeeAuthMiddleware);

// GET production progress for a work order (using productionCompletion data)
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber quantity status operations timeline productionCompletion",
      )
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const productionCompletion = workOrder.productionCompletion || {};
    const totalQuantity = workOrder.quantity;
    const totalOperations = workOrder.operations?.length || 0;

    // Calculate overall progress from productionCompletion
    const overallCompletedQuantity =
      productionCompletion.overallCompletedQuantity || 0;
    const overallCompletionPercentage =
      productionCompletion.overallCompletionPercentage || 0;

    // Calculate unit status breakdown
    const completedUnits = overallCompletedQuantity;
    const pendingUnits = Math.max(0, totalQuantity - overallCompletedQuantity);

    // Determine which units are in progress (units that have some scans but not all operations)
    let inProgressUnits = 0;
    if (productionCompletion.operationCompletion && totalOperations > 0) {
      // Find units that appear in some operations but not all
      const operationUnits = {};

      productionCompletion.operationCompletion.forEach((op) => {
        // We need to track which units appear in which operations
        // Since we don't have unit-by-unit tracking in productionCompletion,
        // we'll use a different approach
      });

      // For simplicity, if work is in progress but not completed, consider some units in progress
      if (
        workOrder.status === "in_progress" &&
        completedUnits < totalQuantity
      ) {
        // Estimate: assume at least 1 unit is in progress if work is active
        inProgressUnits = Math.max(
          1,
          totalQuantity - completedUnits - pendingUnits,
        );
      }
    }

    // Get operation progress from productionCompletion
    const operationProgress = (
      productionCompletion.operationCompletion || []
    ).map((op) => {
      const workOrderOp = workOrder.operations[op.operationNumber - 1];
      return {
        operationNumber: op.operationNumber,
        operationType: op.operationType,
        machineType: op.machineType,
        completedQuantity: op.completedQuantity,
        totalQuantity: op.totalQuantity,
        completionPercentage: op.completionPercentage,
        status: op.status,
        assignedMachines: op.assignedMachines || [],
        estimatedTimeSeconds: workOrderOp?.estimatedTimeSeconds || 0,
        plannedTimeSeconds: workOrderOp?.plannedTimeSeconds || 0,
        assignedMachineName: workOrderOp?.assignedMachineName || "Not assigned",
      };
    });

    // Get recent activity from productionCompletion (if available)
    const recentActivity = [];

    // Add operator details if available
    if (productionCompletion.operatorDetails) {
      productionCompletion.operatorDetails.forEach((op) => {
        recentActivity.push({
          type: "operator_activity",
          description: `${op.operatorName} worked on Operation ${op.operationNumber}`,
          timestamp: op.signInTime,
          details: {
            operationNumber: op.operationNumber,
            operationType: op.operationType,
            machineName: op.machineName,
            totalScans: op.totalScans,
          },
        });
      });
    }

    // Add efficiency metrics if available
    if (productionCompletion.efficiencyMetrics) {
      productionCompletion.efficiencyMetrics.slice(0, 5).forEach((metric) => {
        recentActivity.push({
          type: "efficiency_metric",
          description: `${metric.operatorName} achieved ${metric.efficiencyPercentage}% efficiency`,
          timestamp: productionCompletion.lastSyncedAt,
          details: {
            operationNumber: metric.operationNumber,
            machineName: metric.machineName,
            unitsCompleted: metric.unitsCompleted,
            avgTimePerUnit: metric.avgTimePerUnit,
          },
        });
      });
    }

    // Sort recent activity by timestamp
    recentActivity.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
    );

    // Get invalid scans count
    const invalidScansCount = productionCompletion.invalidScansCount || 0;
    const invalidScans = productionCompletion.invalidScans || [];

    // Calculate production rate (if we have timing data)
    let productionRate = "Not available";
    if (
      productionCompletion.lastSyncedAt &&
      workOrder.timeline?.actualStartDate
    ) {
      const startTime = new Date(workOrder.timeline.actualStartDate);
      const endTime = new Date(productionCompletion.lastSyncedAt);
      const hoursDiff = (endTime - startTime) / (1000 * 60 * 60);

      if (hoursDiff > 0 && overallCompletedQuantity > 0) {
        const unitsPerHour = overallCompletedQuantity / hoursDiff;
        productionRate = `${unitsPerHour.toFixed(1)} units/hour`;
      }
    }

    res.json({
      success: true,
      workOrder: {
        id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        totalQuantity: totalQuantity,
        totalOperations: totalOperations,
      },
      progress: {
        overall: {
          completedQuantity: overallCompletedQuantity,
          pendingQuantity: pendingUnits,
          inProgressQuantity: inProgressUnits,
          completionPercentage: Math.min(overallCompletionPercentage, 100),
          productionRate: productionRate,
          lastUpdated: productionCompletion.lastSyncedAt,
        },
        units: {
          completed: overallCompletedQuantity,
          inProgress: inProgressUnits,
          pending: pendingUnits,
          total: totalQuantity,
          breakdown: {
            completedPercentage: Math.round(
              (overallCompletedQuantity / totalQuantity) * 100,
            ),
            inProgressPercentage: Math.round(
              (inProgressUnits / totalQuantity) * 100,
            ),
            pendingPercentage: Math.round((pendingUnits / totalQuantity) * 100),
          },
        },
        operations: operationProgress,
        activity: recentActivity.slice(0, 10),
        quality: {
          invalidScansCount: invalidScansCount,
          invalidScans: invalidScans.slice(0, 5),
          hasQualityIssues: invalidScansCount > 0,
        },
        timing: {
          startedAt: workOrder.timeline?.actualStartDate,
          estimatedCompletion: workOrder.timeline?.plannedEndDate,
          lastSync: productionCompletion.lastSyncedAt,
          syncStatus: productionCompletion.lastSyncedAt
            ? `Last synced ${new Date(productionCompletion.lastSyncedAt).toLocaleTimeString()}`
            : "Never synced",
        },
      },
    });
  } catch (error) {
    console.error("Error fetching work order progress:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order progress",
    });
  }
});

// GET detailed operation progress with scans
router.get("/:id/operation/:operationNumber", async (req, res) => {
  try {
    const { id, operationNumber } = req.params;
    const opNumber = parseInt(operationNumber);

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity operations productionCompletion")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    if (opNumber < 1 || opNumber > workOrder.operations.length) {
      return res.status(400).json({
        success: false,
        message: `Invalid operation number. Valid range: 1-${workOrder.operations.length}`,
      });
    }

    const productionCompletion = workOrder.productionCompletion || {};
    const operationCompletion = (
      productionCompletion.operationCompletion || []
    ).find((op) => op.operationNumber === opNumber);

    const workOrderOperation = workOrder.operations[opNumber - 1];

    // Get operator details for this operation
    const operationOperators = (
      productionCompletion.operatorDetails || []
    ).filter((op) => op.operationNumber === opNumber);

    // Get efficiency metrics for this operation
    const operationEfficiency = (
      productionCompletion.efficiencyMetrics || []
    ).filter((metric) => metric.operationNumber === opNumber);

    // Get time metrics for this operation
    const operationTimeMetrics = (productionCompletion.timeMetrics || []).find(
      (metric) => metric.operationNumber === opNumber,
    );

    // Calculate operator statistics
    const operatorStats = operationOperators.map((op) => {
      const efficiency = operationEfficiency.find(
        (e) => e.operatorId === op.operatorId,
      );
      return {
        operatorId: op.operatorId,
        operatorName: op.operatorName,
        machineId: op.machineId,
        machineName: op.machineName,
        totalScans: op.totalScans,
        signInTime: op.signInTime,
        signOutTime: op.signOutTime,
        efficiency: efficiency
          ? {
              efficiencyPercentage: efficiency.efficiencyPercentage,
              avgTimePerUnit: efficiency.avgTimePerUnit,
              utilizationRate: efficiency.utilizationRate,
              unitsCompleted: efficiency.unitsCompleted,
            }
          : null,
      };
    });

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      operation: {
        number: opNumber,
        type: workOrderOperation?.operationType || "Unknown",
        machineType: workOrderOperation?.machineType || "Unknown",
        assignedMachine:
          workOrderOperation?.assignedMachineName || "Not assigned",
        estimatedTime: workOrderOperation?.estimatedTimeSeconds || 0,
        plannedTime: workOrderOperation?.plannedTimeSeconds || 0,
        status: workOrderOperation?.status || "pending",
      },
      progress: operationCompletion
        ? {
            completedQuantity: operationCompletion.completedQuantity,
            totalQuantity: operationCompletion.totalQuantity,
            completionPercentage: operationCompletion.completionPercentage,
            status: operationCompletion.status,
            assignedMachines: operationCompletion.assignedMachines,
          }
        : {
            completedQuantity: 0,
            totalQuantity: workOrder.quantity,
            completionPercentage: 0,
            status: "pending",
            assignedMachines: [],
          },
      performance: {
        operators: operatorStats,
        efficiencyMetrics: operationEfficiency.map((metric) => ({
          machineName: metric.machineName,
          operatorName: metric.operatorName,
          efficiencyPercentage: metric.efficiencyPercentage,
          avgTimePerUnit: metric.avgTimePerUnit,
          unitsCompleted: metric.unitsCompleted,
          utilizationRate: metric.utilizationRate,
        })),
        timeMetrics: operationTimeMetrics
          ? {
              avgCompletionTime: operationTimeMetrics.avgCompletionTimeSeconds,
              minCompletionTime: operationTimeMetrics.minCompletionTimeSeconds,
              maxCompletionTime: operationTimeMetrics.maxCompletionTimeSeconds,
              unitsAnalyzed: operationTimeMetrics.totalUnitsAnalyzed,
            }
          : null,
      },
      lastUpdated: productionCompletion.lastSyncedAt,
    });
  } catch (error) {
    console.error("Error fetching operation progress:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching operation progress",
    });
  }
});

// GET unit-wise progress breakdown
router.get("/:id/units", async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 20 } = req.query;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity operations productionCompletion")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const totalQuantity = workOrder.quantity;
    const totalOperations = workOrder.operations.length;
    const productionCompletion = workOrder.productionCompletion || {};
    const operationCompletion = productionCompletion.operationCompletion || [];

    // Create unit progress array
    const unitProgress = [];

    for (let unit = 1; unit <= totalQuantity; unit++) {
      let completedOperations = 0;
      const operationStatus = [];

      // Check each operation for this unit
      for (let opNum = 1; opNum <= totalOperations; opNum++) {
        const opComp = operationCompletion.find(
          (op) => op.operationNumber === opNum,
        );
        const isCompleted = opComp && opComp.completedQuantity >= unit;

        operationStatus.push({
          operationNumber: opNum,
          operationType:
            workOrder.operations[opNum - 1]?.operationType || "Unknown",
          completed: isCompleted,
          machineName:
            workOrder.operations[opNum - 1]?.assignedMachineName ||
            "Not assigned",
        });

        if (isCompleted) {
          completedOperations++;
        }
      }

      const unitCompletionPercentage =
        totalOperations > 0
          ? Math.round((completedOperations / totalOperations) * 100)
          : 0;

      let status = "pending";
      if (unitCompletionPercentage === 100) {
        status = "completed";
      } else if (unitCompletionPercentage > 0) {
        status = "in_progress";
      }

      unitProgress.push({
        unitNumber: unit,
        status: status,
        completedOperations: completedOperations,
        totalOperations: totalOperations,
        completionPercentage: unitCompletionPercentage,
        operationStatus: operationStatus,
      });

      // Apply limit
      if (unit >= parseInt(limit)) {
        break;
      }
    }

    // Calculate statistics
    const completedUnits = unitProgress.filter(
      (u) => u.status === "completed",
    ).length;
    const inProgressUnits = unitProgress.filter(
      (u) => u.status === "in_progress",
    ).length;
    const pendingUnits = unitProgress.filter(
      (u) => u.status === "pending",
    ).length;

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      unitProgress: unitProgress,
      statistics: {
        totalUnits: totalQuantity,
        completedUnits: completedUnits,
        inProgressUnits: inProgressUnits,
        pendingUnits: pendingUnits,
        overallCompletion: Math.round((completedUnits / totalQuantity) * 100),
      },
      lastUpdated: productionCompletion.lastSyncedAt,
    });
  } catch (error) {
    console.error("Error fetching unit progress:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching unit progress",
    });
  }
});

// GET production efficiency summary
router.get("/:id/efficiency", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber operations productionCompletion timeline")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const productionCompletion = workOrder.productionCompletion || {};
    const efficiencyMetrics = productionCompletion.efficiencyMetrics || [];
    const timeMetrics = productionCompletion.timeMetrics || [];
    const operatorDetails = productionCompletion.operatorDetails || [];

    // Calculate overall efficiency
    let overallEfficiency = 0;
    let overallUtilization = 0;
    let totalUnitsProduced = 0;

    if (efficiencyMetrics.length > 0) {
      overallEfficiency =
        efficiencyMetrics.reduce((sum, m) => sum + m.efficiencyPercentage, 0) /
        efficiencyMetrics.length;
      overallUtilization =
        efficiencyMetrics.reduce((sum, m) => sum + m.utilizationRate, 0) /
        efficiencyMetrics.length;
      totalUnitsProduced = efficiencyMetrics.reduce(
        (sum, m) => sum + m.unitsCompleted,
        0,
      );
    }

    // Group by operation
    const efficiencyByOperation = {};
    efficiencyMetrics.forEach((metric) => {
      const opNum = metric.operationNumber;
      if (!efficiencyByOperation[opNum]) {
        efficiencyByOperation[opNum] = {
          operationNumber: opNum,
          operationType: metric.operationType,
          metrics: [],
          avgEfficiency: 0,
          avgUtilization: 0,
          totalUnits: 0,
        };
      }
      efficiencyByOperation[opNum].metrics.push(metric);
      efficiencyByOperation[opNum].totalUnits += metric.unitsCompleted;
    });

    // Calculate averages for each operation
    Object.keys(efficiencyByOperation).forEach((opNum) => {
      const opData = efficiencyByOperation[opNum];
      if (opData.metrics.length > 0) {
        opData.avgEfficiency =
          opData.metrics.reduce((sum, m) => sum + m.efficiencyPercentage, 0) /
          opData.metrics.length;
        opData.avgUtilization =
          opData.metrics.reduce((sum, m) => sum + m.utilizationRate, 0) /
          opData.metrics.length;
      }
    });

    // Group by operator
    const efficiencyByOperator = {};
    efficiencyMetrics.forEach((metric) => {
      const operatorId = metric.operatorId;
      if (!efficiencyByOperator[operatorId]) {
        efficiencyByOperator[operatorId] = {
          operatorId: operatorId,
          operatorName: metric.operatorName,
          metrics: [],
          avgEfficiency: 0,
          avgUtilization: 0,
          totalUnits: 0,
        };
      }
      efficiencyByOperator[operatorId].metrics.push(metric);
      efficiencyByOperator[operatorId].totalUnits += metric.unitsCompleted;
    });

    // Calculate averages for each operator
    Object.keys(efficiencyByOperator).forEach((operatorId) => {
      const opData = efficiencyByOperator[operatorId];
      if (opData.metrics.length > 0) {
        opData.avgEfficiency =
          opData.metrics.reduce((sum, m) => sum + m.efficiencyPercentage, 0) /
          opData.metrics.length;
        opData.avgUtilization =
          opData.metrics.reduce((sum, m) => sum + m.utilizationRate, 0) /
          opData.metrics.length;
      }
    });

    // Calculate time performance vs planned
    const timePerformance = workOrder.operations.map((op, index) => {
      const opNum = index + 1;
      const timeMetric = timeMetrics.find((tm) => tm.operationNumber === opNum);
      const plannedTime = op.plannedTimeSeconds || op.estimatedTimeSeconds || 0;
      const actualTime = timeMetric?.avgCompletionTimeSeconds || 0;

      let timeVariance = 0;
      let efficiency = 0;

      if (plannedTime > 0 && actualTime > 0) {
        timeVariance = actualTime - plannedTime;
        efficiency = (plannedTime / actualTime) * 100;
      }

      return {
        operationNumber: opNum,
        operationType: op.operationType,
        plannedTime: plannedTime,
        actualTime: actualTime,
        timeVariance: timeVariance,
        efficiency: efficiency,
        status: timeMetric ? "tracked" : "not_tracked",
      };
    });

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      summary: {
        overallEfficiency: Math.round(overallEfficiency * 100) / 100,
        overallUtilization: Math.round(overallUtilization * 100) / 100,
        totalUnitsProduced: totalUnitsProduced,
        totalOperators: operatorDetails.length,
        totalEfficiencyMetrics: efficiencyMetrics.length,
      },
      byOperation: Object.values(efficiencyByOperation),
      byOperator: Object.values(efficiencyByOperator),
      timePerformance: timePerformance,
      lastUpdated: productionCompletion.lastSyncedAt,
    });
  } catch (error) {
    console.error("Error fetching efficiency data:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching efficiency data",
    });
  }
});

module.exports = router;
