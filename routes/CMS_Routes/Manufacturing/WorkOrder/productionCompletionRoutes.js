// routes/CMS_Routes/Manufacturing/WorkOrder/productionCompletionRoutes.js

const express = require("express");
const router = express.Router();
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// GET production completion summary for a work order
router.get("/:id/completion", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity status productionCompletion operations")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      totalQuantity: workOrder.quantity,
      status: workOrder.status,
      completion: workOrder.productionCompletion || {
        overallCompletedQuantity: 0,
        overallCompletionPercentage: 0,
        operationCompletion: [],
        lastSyncedAt: null,
      },
    });
  } catch (error) {
    console.error("Error fetching production completion:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching production completion",
    });
  }
});

// GET detailed operator performance for a work order
router.get("/:id/operator-performance", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber productionCompletion.operatorDetails productionCompletion.efficiencyMetrics",
      )
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const operatorDetails =
      workOrder.productionCompletion?.operatorDetails || [];
    const efficiencyMetrics =
      workOrder.productionCompletion?.efficiencyMetrics || [];

    // Group by operator
    const operatorPerformance = {};

    operatorDetails.forEach((detail) => {
      if (!operatorPerformance[detail.operatorId]) {
        operatorPerformance[detail.operatorId] = {
          operatorId: detail.operatorId,
          operatorName: detail.operatorName,
          operations: [],
          totalScans: 0,
        };
      }

      operatorPerformance[detail.operatorId].operations.push({
        operationNumber: detail.operationNumber,
        operationType: detail.operationType,
        machineName: detail.machineName,
        scans: detail.totalScans,
        signInTime: detail.signInTime,
        signOutTime: detail.signOutTime,
      });

      operatorPerformance[detail.operatorId].totalScans += detail.totalScans;
    });

    // Add efficiency metrics
    efficiencyMetrics.forEach((metric) => {
      if (operatorPerformance[metric.operatorId]) {
        const opIndex = operatorPerformance[
          metric.operatorId
        ].operations.findIndex(
          (op) =>
            op.operationNumber === metric.operationNumber &&
            op.machineName === metric.machineName,
        );

        if (opIndex !== -1) {
          operatorPerformance[metric.operatorId].operations[
            opIndex
          ].efficiency = {
            avgTimePerUnit: metric.avgTimePerUnit,
            efficiencyPercentage: metric.efficiencyPercentage,
            utilizationRate: metric.utilizationRate,
            unitsCompleted: metric.unitsCompleted,
          };
        }
      }
    });

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      operators: Object.values(operatorPerformance),
    });
  } catch (error) {
    console.error("Error fetching operator performance:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching operator performance",
    });
  }
});

// GET operation-wise completion status
router.get("/:id/operations-status", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber quantity productionCompletion.operationCompletion",
      )
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      totalQuantity: workOrder.quantity,
      operations: workOrder.productionCompletion?.operationCompletion || [],
    });
  } catch (error) {
    console.error("Error fetching operations status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching operations status",
    });
  }
});

// GET time analysis for a work order
router.get("/:id/time-analysis", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber productionCompletion.timeMetrics operations")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const timeMetrics = workOrder.productionCompletion?.timeMetrics || [];

    // Group by operation and machine
    const timeAnalysis = timeMetrics.map((metric) => {
      const operation = workOrder.operations.find(
        (op) => workOrder.operations.indexOf(op) === metric.operationNumber - 1,
      );

      return {
        operationNumber: metric.operationNumber,
        operationType: metric.operationType,
        machineName: metric.machineName,
        avgCompletionTime: metric.avgCompletionTimeSeconds,
        minCompletionTime: metric.minCompletionTimeSeconds,
        maxCompletionTime: metric.maxCompletionTimeSeconds,
        estimatedTime: operation?.estimatedTimeSeconds || 0,
        plannedTime: operation?.plannedTimeSeconds || 0,
        variance:
          metric.avgCompletionTimeSeconds -
          (operation?.plannedTimeSeconds ||
            operation?.estimatedTimeSeconds ||
            0),
        unitsAnalyzed: metric.totalUnitsAnalyzed,
      };
    });

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      timeAnalysis: timeAnalysis,
    });
  } catch (error) {
    console.error("Error fetching time analysis:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching time analysis",
    });
  }
});

// GET efficiency summary for a work order
router.get("/:id/efficiency-summary", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber productionCompletion.efficiencyMetrics")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const efficiencyMetrics =
      workOrder.productionCompletion?.efficiencyMetrics || [];

    // Calculate overall averages
    const totalMetrics = efficiencyMetrics.length;
    if (totalMetrics === 0) {
      return res.json({
        success: true,
        workOrderNumber: workOrder.workOrderNumber,
        summary: {
          avgEfficiency: 0,
          avgUtilization: 0,
          totalUnitsProduced: 0,
        },
        byOperation: [],
        byMachine: [],
        byOperator: [],
      });
    }

    const summary = {
      avgEfficiency:
        efficiencyMetrics.reduce((sum, m) => sum + m.efficiencyPercentage, 0) /
        totalMetrics,
      avgUtilization:
        efficiencyMetrics.reduce((sum, m) => sum + m.utilizationRate, 0) /
        totalMetrics,
      totalUnitsProduced: efficiencyMetrics.reduce(
        (sum, m) => sum + m.unitsCompleted,
        0,
      ),
    };

    // Group by operation
    const byOperation = {};
    efficiencyMetrics.forEach((metric) => {
      const key = metric.operationNumber;
      if (!byOperation[key]) {
        byOperation[key] = {
          operationNumber: metric.operationNumber,
          operationType: metric.operationType,
          metrics: [],
        };
      }
      byOperation[key].metrics.push(metric);
    });

    // Group by machine
    const byMachine = {};
    efficiencyMetrics.forEach((metric) => {
      const key = metric.machineId?.toString() || "unknown";
      if (!byMachine[key]) {
        byMachine[key] = {
          machineId: metric.machineId,
          machineName: metric.machineName,
          metrics: [],
        };
      }
      byMachine[key].metrics.push(metric);
    });

    // Group by operator
    const byOperator = {};
    efficiencyMetrics.forEach((metric) => {
      const key = metric.operatorId;
      if (!byOperator[key]) {
        byOperator[key] = {
          operatorId: metric.operatorId,
          operatorName: metric.operatorName,
          metrics: [],
        };
      }
      byOperator[key].metrics.push(metric);
    });

    // Calculate averages for each group
    const calculateGroupAvg = (group) => {
      const metrics = group.metrics;
      return {
        ...group,
        avgEfficiency:
          metrics.reduce((sum, m) => sum + m.efficiencyPercentage, 0) /
          metrics.length,
        avgUtilization:
          metrics.reduce((sum, m) => sum + m.utilizationRate, 0) /
          metrics.length,
        totalUnits: metrics.reduce((sum, m) => sum + m.unitsCompleted, 0),
        count: metrics.length,
      };
    };

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      summary: {
        avgEfficiency: Math.round(summary.avgEfficiency * 100) / 100,
        avgUtilization: Math.round(summary.avgUtilization * 100) / 100,
        totalUnitsProduced: summary.totalUnitsProduced,
      },
      byOperation: Object.values(byOperation).map(calculateGroupAvg),
      byMachine: Object.values(byMachine).map(calculateGroupAvg),
      byOperator: Object.values(byOperator).map(calculateGroupAvg),
    });
  } catch (error) {
    console.error("Error fetching efficiency summary:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching efficiency summary",
    });
  }
});

// GET live production status (most recent sync data)
router.get("/:id/live-status", async (req, res) => {
  try {
    const { id } = req.params;

    const workOrder = await WorkOrder.findById(id)
      .select("workOrderNumber quantity status productionCompletion timeline")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const completion = workOrder.productionCompletion || {};
    const lastSync = completion.lastSyncedAt;
    const timeSinceSync = lastSync
      ? (Date.now() - new Date(lastSync).getTime()) / 60000
      : null; // minutes

    res.json({
      success: true,
      workOrder: {
        id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        status: workOrder.status,
        totalQuantity: workOrder.quantity,
        completedQuantity: completion.overallCompletedQuantity || 0,
        completionPercentage: completion.overallCompletionPercentage || 0,
        startedAt: workOrder.timeline?.actualStartDate,
        estimatedEndDate: workOrder.timeline?.plannedEndDate,
        lastSyncedAt: lastSync,
        timeSinceLastSync: timeSinceSync
          ? `${Math.round(timeSinceSync)} minutes ago`
          : "Never synced",
        nextSyncIn:
          timeSinceSync !== null
            ? `${Math.max(0, 20 - Math.round(timeSinceSync))} minutes`
            : "Unknown",
      },
      operations: completion.operationCompletion || [],
    });
  } catch (error) {
    console.error("Error fetching live status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching live status",
    });
  }
});

router.get("/:id/invalid-scans", async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50 } = req.query;

    const workOrder = await WorkOrder.findById(id)
      .select(
        "workOrderNumber productionCompletion.invalidScans productionCompletion.invalidScansCount",
      )
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    const invalidScans = workOrder.productionCompletion?.invalidScans || [];
    const invalidScansCount =
      workOrder.productionCompletion?.invalidScansCount || 0;

    // Sort by most recent first
    const sortedScans = [...invalidScans].sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp),
    );

    // Apply limit
    const limitedScans = sortedScans.slice(0, parseInt(limit));

    res.json({
      success: true,
      workOrderNumber: workOrder.workOrderNumber,
      totalInvalidScans: invalidScansCount,
      invalidScans: limitedScans,
    });
  } catch (error) {
    console.error("Error fetching invalid scans:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching invalid scans",
    });
  }
});

module.exports = router;
