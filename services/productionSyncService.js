// services/productionSyncService.js - COMPLETE FIXED VERSION
const cron = require("node-cron");
const mongoose = require("mongoose");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

class ProductionSyncService {
  constructor() {
    this.syncJob = null;
    this.cleanupJob = null;
    this.isRunning = false;
    this.syncCount = 0; // Track sync runs
  }

  /**
   * Initialize cron jobs
   */
  initialize() {
    console.log("🚀 Initializing Production Sync Service...");

    // Run every 1 minute - sync production data to work orders
    this.syncJob = cron.schedule("*/1 * * * *", async () => {
      await this.syncProductionToWorkOrders();
    });

    // Run daily at 2 AM - cleanup old production tracking data (10+ days old)
    this.cleanupJob = cron.schedule("0 2 * * *", async () => {
      await this.cleanupOldTrackingData();
    });

    console.log("✅ Production Sync Service initialized");
    console.log("   - Sync job: Every 1 minutes (for testing)");
    console.log("   - Cleanup job: Daily at 2 AM");
  }

  /**
   * Main sync function - runs every minute (or 20 minutes in production)
   */
  async syncProductionToWorkOrders() {
    if (this.isRunning) {
      console.log("⏭️  Sync already running, skipping...");
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();
    this.syncCount++;

    // Only log every 5th sync to reduce console spam
    if (this.syncCount % 5 === 1) {
      console.log(
        `\n🔄 [${new Date().toISOString()}] Starting production sync #${this.syncCount}...`,
      );
    }

    try {
      // Get all work orders that are in production and not completed
      const activeWorkOrders = await WorkOrder.find({
        status: {
          $in: ["in_progress", "scheduled", "ready_to_start", "paused"],
        },
      }).lean();

      // Only log if there are work orders to process
      if (activeWorkOrders.length > 0 && this.syncCount % 5 === 1) {
        console.log(`📋 Found ${activeWorkOrders.length} active work orders`);
      }

      let updatedCount = 0;
      let errorCount = 0;
      let totalInvalidScans = 0;

      for (const workOrder of activeWorkOrders) {
        try {
          const result = await this.processWorkOrder(workOrder);
          if (result && result.updated) {
            updatedCount++;
            totalInvalidScans += result.invalidScans || 0;
          }
        } catch (error) {
          errorCount++;
          const woNumber =
            workOrder.workOrderNumber ||
            `WO-${workOrder._id.toString().slice(-8)}`;
          if (this.syncCount % 5 === 1) {
            console.error(`❌ Error processing WO ${woNumber}:`, error.message);
          }
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);

      // Only log summary every 5th sync
      if (this.syncCount % 5 === 1 || updatedCount > 0 || errorCount > 0) {
        console.log(
          `✅ Sync #${this.syncCount} completed in ${duration}s - Updated: ${updatedCount}, Errors: ${errorCount}, Invalid Scans: ${totalInvalidScans}\n`,
        );
      }
    } catch (error) {
      if (this.syncCount % 5 === 1) {
        console.error("❌ Fatal error in sync process:", error.message);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Process a single work order
   */
  async processWorkOrder(workOrderData) {
    const workOrderShortId = workOrderData._id.toString().slice(-8);
    const workOrderNumber =
      workOrderData.workOrderNumber || `WO-${workOrderShortId}`;
    const totalQuantity = workOrderData.quantity || 0;

    // Find all production tracking documents that might contain this work order
    // Search for barcodes matching WO-{shortId}-*
    const trackingDocs = await ProductionTracking.find({
      "machines.operationTracking.operators.barcodeScans.barcodeId": {
        $regex: `^WO-${workOrderShortId}-`,
      },
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (trackingDocs.length === 0) {
      // No scans found for this work order yet
      return { updated: false, invalidScans: 0 };
    }

    // Only log every 10th work order processing to reduce console spam
    const shouldLog = this.syncCount % 10 === 1;
    if (shouldLog) {
      console.log(
        `   📦 Processing WO-${workOrderShortId} (${workOrderNumber})`,
      );
    }

    // Extract all scans for this work order WITH QUANTITY VALIDATION
    const extractionResult = this.extractAndValidateScansForWorkOrder(
      trackingDocs,
      workOrderShortId,
      workOrderData,
      totalQuantity,
    );

    const { scansByOperation, invalidScans, totalInvalidScans } =
      extractionResult;

    if (Object.keys(scansByOperation).length === 0) {
      if (totalInvalidScans > 0 && shouldLog) {
        console.log(
          `      ⚠️  Found ${totalInvalidScans} invalid scans but no valid scans`,
        );
      }
      // Even if no valid scans, we should still save the invalid scans
      if (totalInvalidScans > 0) {
        await this.updateWorkOrderInvalidScansOnly(
          workOrderData._id,
          workOrderNumber,
          totalInvalidScans,
          invalidScans,
        );
        return { updated: true, invalidScans: totalInvalidScans };
      }
      return { updated: false, invalidScans: totalInvalidScans };
    }

    if (totalInvalidScans > 0 && shouldLog) {
      console.log(
        `      ⚠️  Found ${totalInvalidScans} invalid unit scans (units > ${totalQuantity})`,
      );
    }

    // Calculate completion metrics
    const completionData = this.calculateCompletionMetrics(
      scansByOperation,
      workOrderData,
      totalInvalidScans,
    );

    // Update the work order with invalid scans
    await this.updateWorkOrder(
      workOrderData._id,
      completionData,
      workOrderNumber,
      totalInvalidScans,
      invalidScans, // Pass the invalid scans array
    );

    return { updated: true, invalidScans: totalInvalidScans };
  }

  /**
   * Extract and organize scans by operation for a specific work order
   * WITH QUANTITY VALIDATION
   */
  extractAndValidateScansForWorkOrder(
    trackingDocs,
    workOrderShortId,
    workOrderData,
    totalQuantity,
  ) {
    const scansByOperation = {};
    const invalidScans = [];
    let totalInvalidScans = 0;

    // Helper function to extract unit number
    const extractUnitNumber = (barcodeId) => {
      const parts = barcodeId.split("-");
      if (parts.length >= 3) {
        // Remove leading zeros and convert to int
        const unitNum = parseInt(parts[2], 10);
        return isNaN(unitNum) ? null : unitNum;
      }
      return null;
    };

    for (const trackingDoc of trackingDocs) {
      for (const machine of trackingDoc.machines) {
        const machineInfo = {
          id: machine.machineId?._id,
          name: machine.machineId?.name || "Unknown",
          serialNumber: machine.machineId?.serialNumber,
          type: machine.machineId?.type,
        };

        for (const opTracking of machine.operationTracking) {
          const opNumber = opTracking.operationNumber;

          // Find matching operation in work order
          const workOrderOp = workOrderData.operations?.[opNumber - 1];
          if (!workOrderOp) continue;

          // Check if this machine is assigned to this operation
          const isAssignedMachine =
            workOrderOp.assignedMachine?.toString() ===
              machineInfo.id?.toString() ||
            workOrderOp.additionalMachines?.some(
              (am) =>
                am.assignedMachine?.toString() === machineInfo.id?.toString(),
            );

          if (!isAssignedMachine) continue;

          // Initialize operation tracking
          if (!scansByOperation[opNumber]) {
            scansByOperation[opNumber] = {
              operationNumber: opNumber,
              operationType: workOrderOp.operationType,
              machineType: workOrderOp.machineType,
              estimatedTimeSeconds: workOrderOp.estimatedTimeSeconds,
              plannedTimeSeconds: workOrderOp.plannedTimeSeconds,
              machines: {},
            };
          }

          // Initialize machine tracking
          if (!scansByOperation[opNumber].machines[machineInfo.id]) {
            scansByOperation[opNumber].machines[machineInfo.id] = {
              machineInfo,
              operators: {},
              allScans: [],
              validScans: [], // Track only valid scans
            };
          }

          // Process each operator's scans
          for (const operator of opTracking.operators) {
            const operatorId = operator.operatorIdentityId;
            const operatorName =
              operator.operatorName || `Operator ${operatorId}`;

            if (
              !scansByOperation[opNumber].machines[machineInfo.id].operators[
                operatorId
              ]
            ) {
              scansByOperation[opNumber].machines[machineInfo.id].operators[
                operatorId
              ] = {
                operatorIdentityId: operatorId,
                operatorName: operatorName,
                sessions: [],
              };
            }

            // Process this operator session
            const sessionScans = operator.barcodeScans.filter((scan) => {
              return scan.barcodeId.startsWith(`WO-${workOrderShortId}-`);
            });

            if (sessionScans.length > 0) {
              // Separate valid and invalid scans
              const validSessionScans = [];

              sessionScans.forEach((scan) => {
                const unitNumber = extractUnitNumber(scan.barcodeId);

                // VALIDATE: Check if unit number exceeds total quantity
                if (
                  unitNumber !== null &&
                  unitNumber > 0 &&
                  unitNumber <= totalQuantity
                ) {
                  validSessionScans.push({
                    barcodeId: scan.barcodeId,
                    timestamp: scan.timeStamp,
                    unitNumber: unitNumber,
                  });
                } else {
                  // Track invalid scan
                  totalInvalidScans++;
                  const reasonType =
                    unitNumber === null ? "invalid_format" : "exceeds_quantity";
                  const reasonDetails =
                    unitNumber === null
                      ? "Invalid barcode format"
                      : `Unit ${unitNumber} exceeds total quantity (${totalQuantity})`;

                  invalidScans.push({
                    barcodeId: scan.barcodeId,
                    timestamp: scan.timeStamp,
                    unitNumber: unitNumber,
                    operatorId: operatorId,
                    operatorName: operatorName,
                    machineId: machineInfo.id,
                    machineName: machineInfo.name,
                    reason: reasonType, // Use enum value instead of custom string
                    details: reasonDetails, // Store the detailed message here
                  });
                }
              });

              if (validSessionScans.length > 0) {
                scansByOperation[opNumber].machines[machineInfo.id].operators[
                  operatorId
                ].sessions.push({
                  signInTime: operator.signInTime,
                  signOutTime: operator.signOutTime,
                  scans: validSessionScans,
                });

                // Add to all valid scans for this machine
                scansByOperation[opNumber].machines[
                  machineInfo.id
                ].allScans.push(
                  ...validSessionScans.map((scan) => ({
                    barcodeId: scan.barcodeId,
                    timestamp: scan.timestamp,
                    unitNumber: scan.unitNumber,
                    operatorId: operatorId,
                    operatorName: operatorName,
                  })),
                );

                // Also add to validScans array
                scansByOperation[opNumber].machines[
                  machineInfo.id
                ].validScans.push(
                  ...validSessionScans.map((scan) => ({
                    ...scan,
                    operatorId: operatorId,
                    operatorName: operatorName,
                  })),
                );
              }
            }
          }
        }
      }
    }

    return {
      scansByOperation,
      invalidScans,
      totalInvalidScans,
    };
  }

  /**
   * Calculate completion metrics from scans
   */
  calculateCompletionMetrics(
    scansByOperation,
    workOrderData,
    totalInvalidScans = 0,
  ) {
    const totalQuantity = workOrderData.quantity;
    const operationCompletion = [];
    const operatorDetails = [];
    const efficiencyMetrics = [];
    const timeMetrics = [];

    // Track overall completed units (units that completed ALL operations)
    const unitsByOperation = {};

    for (const [opNumber, opData] of Object.entries(scansByOperation)) {
      const opNum = parseInt(opNumber);

      // Collect all unique units scanned for this operation across all machines
      const completedUnits = new Set();
      const operatorsByMachine = [];

      for (const [machineId, machineData] of Object.entries(opData.machines)) {
        // Track units for this machine from VALID SCANS ONLY
        machineData.validScans.forEach((scan) => {
          if (scan.unitNumber && scan.unitNumber <= totalQuantity) {
            completedUnits.add(scan.unitNumber);
          }
        });

        // Process operators for this machine
        for (const [operatorId, operatorData] of Object.entries(
          machineData.operators,
        )) {
          // Calculate efficiency for each session
          for (const session of operatorData.sessions) {
            if (session.scans.length > 0) {
              const efficiency = this.calculateSessionEfficiency(
                session,
                opData.estimatedTimeSeconds,
                opData.plannedTimeSeconds,
              );

              if (efficiency) {
                efficiencyMetrics.push({
                  operationNumber: opNum,
                  operationType: opData.operationType,
                  machineId: machineId,
                  machineName: machineData.machineInfo.name,
                  operatorId: operatorId,
                  operatorName: operatorData.operatorName,
                  ...efficiency,
                });
              }

              // Track operator details
              if (
                !operatorsByMachine.find(
                  (o) =>
                    o.operatorId === operatorId && o.machineId === machineId,
                )
              ) {
                operatorsByMachine.push({
                  operatorId: operatorId,
                  operatorName: operatorData.operatorName,
                  machineId: machineId,
                  machineName: machineData.machineInfo.name,
                  totalScans: session.scans.length,
                  signInTime: session.signInTime,
                  signOutTime: session.signOutTime,
                });
              }
            }
          }
        }

        // Calculate timing metrics for this machine
        const timingData = this.calculateTimingMetrics(
          machineData.validScans, // Use only valid scans
          opData.estimatedTimeSeconds,
        );

        if (timingData) {
          timeMetrics.push({
            operationNumber: opNum,
            operationType: opData.operationType,
            machineId: machineId,
            machineName: machineData.machineInfo.name,
            ...timingData,
          });
        }
      }

      // Store units completed for this operation
      unitsByOperation[opNum] = completedUnits;

      // Calculate completion quantity for this operation
      const completedCount = completedUnits.size;
      const completionPercentage =
        totalQuantity > 0 ? (completedCount / totalQuantity) * 100 : 0;

      operationCompletion.push({
        operationNumber: opNum,
        operationType: opData.operationType,
        machineType: opData.machineType,
        completedQuantity: completedCount,
        totalQuantity: totalQuantity,
        completionPercentage: Math.min(completionPercentage, 100),
        status: completedCount >= totalQuantity ? "completed" : "in_progress",
        assignedMachines: Object.values(opData.machines).map((m) => ({
          machineId: m.machineInfo.id,
          machineName: m.machineInfo.name,
          machineSerial: m.machineInfo.serialNumber,
        })),
      });

      // Add operators to the master list
      operatorDetails.push(
        ...operatorsByMachine.map((op) => ({
          ...op,
          operationNumber: opNum,
          operationType: opData.operationType,
        })),
      );
    }

    // Calculate overall completion (units that completed ALL operations)
    const overallCompletedUnits = this.calculateOverallCompletion(
      unitsByOperation,
      workOrderData.operations?.length || 0,
    );

    const overallCompletionPercentage =
      totalQuantity > 0 ? (overallCompletedUnits / totalQuantity) * 100 : 0;

    // Determine work order status
    let newStatus = workOrderData.status;
    if (overallCompletedUnits >= totalQuantity) {
      newStatus = "completed";
    } else if (overallCompletedUnits > 0) {
      newStatus = "in_progress";
    }

    return {
      overallCompletedQuantity: overallCompletedUnits,
      overallCompletionPercentage: Math.min(overallCompletionPercentage, 100),
      operationCompletion,
      operatorDetails,
      efficiencyMetrics,
      timeMetrics,
      invalidScansCount: totalInvalidScans,
      newStatus,
      lastSyncedAt: new Date(),
    };
  }

  /**
   * Calculate which units completed ALL operations
   */
  calculateOverallCompletion(unitsByOperation, totalOperations) {
    if (totalOperations === 0) return 0;

    const operationNumbers = Object.keys(unitsByOperation)
      .map(Number)
      .sort((a, b) => a - b);

    // If we don't have data for all operations yet, return 0
    if (operationNumbers.length < totalOperations) {
      return 0;
    }

    // Find units that appear in ALL operations
    const firstOpUnits = unitsByOperation[operationNumbers[0]];
    if (!firstOpUnits || firstOpUnits.size === 0) return 0;

    let completedUnits = new Set(firstOpUnits);

    for (let i = 1; i < operationNumbers.length; i++) {
      const opUnits = unitsByOperation[operationNumbers[i]];
      if (!opUnits) return 0;

      // Intersection: keep only units that exist in both sets
      completedUnits = new Set(
        [...completedUnits].filter((unit) => opUnits.has(unit)),
      );
    }

    return completedUnits.size;
  }

  /**
   * Calculate efficiency for an operator session
   */
  calculateSessionEfficiency(session, estimatedTime, plannedTime) {
    const scans = session.scans;
    if (scans.length === 0) return null;

    // Sort scans by timestamp
    const sortedScans = [...scans].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp),
    );

    const sessionStart = session.signInTime;
    const sessionEnd = session.signOutTime || new Date();

    // Calculate time between consecutive scans
    const scanIntervals = [];
    for (let i = 1; i < sortedScans.length; i++) {
      const interval =
        (new Date(sortedScans[i].timestamp) -
          new Date(sortedScans[i - 1].timestamp)) /
        1000;

      // Filter out unreasonably long intervals (> 30 minutes = likely a break/pause)
      if (interval < 1800) {
        scanIntervals.push(interval);
      }
    }

    // Calculate average time per unit
    const avgTimePerUnit =
      scanIntervals.length > 0
        ? scanIntervals.reduce((a, b) => a + b, 0) / scanIntervals.length
        : 0;

    // Calculate efficiency
    const targetTime = plannedTime || estimatedTime || 0;
    const efficiency =
      targetTime > 0 && avgTimePerUnit > 0
        ? Math.min((targetTime / avgTimePerUnit) * 100, 200) // Cap at 200%
        : 0;

    // Calculate total productive time (excluding long gaps)
    const productiveTime = scanIntervals.reduce((a, b) => a + b, 0);
    const totalSessionTime =
      (new Date(sessionEnd) - new Date(sessionStart)) / 1000;
    const utilizationRate =
      totalSessionTime > 0 ? (productiveTime / totalSessionTime) * 100 : 0;

    return {
      unitsCompleted: scans.length,
      avgTimePerUnit: Math.round(avgTimePerUnit),
      estimatedTimePerUnit: estimatedTime || 0,
      plannedTimePerUnit: plannedTime || 0,
      efficiencyPercentage: Math.round(efficiency * 100) / 100,
      utilizationRate: Math.round(utilizationRate * 100) / 100,
      totalProductiveTime: Math.round(productiveTime),
      totalSessionTime: Math.round(totalSessionTime),
    };
  }

  /**
   * Calculate timing metrics for a set of scans
   */
  calculateTimingMetrics(scans, estimatedTime) {
    if (scans.length < 2) return null;

    // Sort by unit number and timestamp
    const sortedScans = [...scans].sort((a, b) => {
      if (a.unitNumber !== b.unitNumber) {
        return a.unitNumber - b.unitNumber;
      }
      return new Date(a.timestamp) - new Date(b.timestamp);
    });

    // Group by unit number
    const unitGroups = {};
    sortedScans.forEach((scan) => {
      if (scan.unitNumber) {
        if (!unitGroups[scan.unitNumber]) {
          unitGroups[scan.unitNumber] = [];
        }
        unitGroups[scan.unitNumber].push(scan);
      }
    });

    // Calculate time to complete each unit
    const completionTimes = [];
    Object.values(unitGroups).forEach((unitScans) => {
      if (unitScans.length >= 1) {
        // Time from first to last scan of this unit (if multiple scans)
        const firstScan = unitScans[0];
        const lastScan = unitScans[unitScans.length - 1];

        if (unitScans.length === 1) {
          // Single scan - use estimated time as approximation
          completionTimes.push(estimatedTime || 0);
        } else {
          const completionTime =
            (new Date(lastScan.timestamp) - new Date(firstScan.timestamp)) /
            1000;
          completionTimes.push(completionTime);
        }
      }
    });

    if (completionTimes.length === 0) return null;

    // Calculate statistics
    const avgCompletionTime =
      completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length;
    const minCompletionTime = Math.min(...completionTimes);
    const maxCompletionTime = Math.max(...completionTimes);

    return {
      avgCompletionTimeSeconds: Math.round(avgCompletionTime),
      minCompletionTimeSeconds: Math.round(minCompletionTime),
      maxCompletionTimeSeconds: Math.round(maxCompletionTime),
      totalUnitsAnalyzed: completionTimes.length,
    };
  }

  /**
   * Update work order with completion data
   */
  async updateWorkOrder(
    workOrderId,
    completionData,
    workOrderNumber,
    invalidScansCount = 0,
    invalidScans = [],
  ) {
    try {
      const workOrder = await WorkOrder.findById(workOrderId);
      if (!workOrder) {
        throw new Error("Work order not found");
      }

      // Update production completion tracking
      if (!workOrder.productionCompletion) {
        workOrder.productionCompletion = {};
      }

      // Only store the last 100 invalid scans to prevent database bloat
      const limitedInvalidScans = invalidScans.slice(-100);

      // Merge existing invalid scans with new ones (keeping unique)
      const existingInvalidScans =
        workOrder.productionCompletion.invalidScans || [];
      const allInvalidScans = [...existingInvalidScans, ...limitedInvalidScans];

      // Remove duplicates based on barcodeId and timestamp
      const uniqueInvalidScans = Array.from(
        new Map(
          allInvalidScans.map((item) => [
            `${item.barcodeId}-${item.timestamp.getTime()}`,
            item,
          ]),
        ).values(),
      ).slice(-100); // Keep only last 100 after deduplication

      workOrder.productionCompletion = {
        overallCompletedQuantity: completionData.overallCompletedQuantity || 0,
        overallCompletionPercentage:
          completionData.overallCompletionPercentage || 0,
        operationCompletion: completionData.operationCompletion || [],
        operatorDetails: completionData.operatorDetails || [],
        efficiencyMetrics: completionData.efficiencyMetrics || [],
        timeMetrics: completionData.timeMetrics || [],
        invalidScansCount:
          (workOrder.productionCompletion.invalidScansCount || 0) +
          invalidScansCount,
        invalidScans: uniqueInvalidScans,
        lastSyncedAt: completionData.lastSyncedAt || new Date(),
      };

      // Update operation statuses
      if (completionData.operationCompletion) {
        completionData.operationCompletion.forEach((opCompletion) => {
          const operation =
            workOrder.operations[opCompletion.operationNumber - 1];
          if (operation) {
            operation.status = opCompletion.status;
          }
        });
      }

      // Update overall status
      if (
        completionData.newStatus &&
        completionData.newStatus !== workOrder.status
      ) {
        workOrder.status = completionData.newStatus;

        // Update timeline
        if (
          completionData.newStatus === "completed" &&
          !workOrder.timeline.actualEndDate
        ) {
          workOrder.timeline.actualEndDate = new Date();
        } else if (
          completionData.newStatus === "in_progress" &&
          !workOrder.timeline.actualStartDate
        ) {
          workOrder.timeline.actualStartDate = new Date();
        }
      }

      await workOrder.save();

      // Only log if we have updates or invalid scans
      const shouldLog =
        this.syncCount % 10 === 1 ||
        invalidScansCount > 0 ||
        completionData.overallCompletedQuantity > 0;
      if (shouldLog) {
        console.log(
          `      ✅ Updated ${workOrderNumber}: ${completionData.overallCompletedQuantity || 0}/${workOrder.quantity} units (${(completionData.overallCompletionPercentage || 0).toFixed(1)}%)${invalidScansCount > 0 ? ` | ⚠️ ${invalidScansCount} invalid scans` : ""}`,
        );
      }
    } catch (error) {
      console.error(
        `Error updating work order ${workOrderNumber}:`,
        error.message,
      );
      // Don't throw error - just log it and continue
    }
  }

  /**
   * Update only invalid scans when there are no valid scans
   */
  async updateWorkOrderInvalidScansOnly(
    workOrderId,
    workOrderNumber,
    invalidScansCount = 0,
    invalidScans = [],
  ) {
    try {
      const workOrder = await WorkOrder.findById(workOrderId);
      if (!workOrder) {
        return;
      }

      // Update production completion tracking
      if (!workOrder.productionCompletion) {
        workOrder.productionCompletion = {};
      }

      // Only store the last 100 invalid scans
      const limitedInvalidScans = invalidScans.slice(-100);

      // Merge existing invalid scans with new ones (keeping unique)
      const existingInvalidScans =
        workOrder.productionCompletion.invalidScans || [];
      const allInvalidScans = [...existingInvalidScans, ...limitedInvalidScans];

      // Remove duplicates
      const uniqueInvalidScans = Array.from(
        new Map(
          allInvalidScans.map((item) => [
            `${item.barcodeId}-${item.timestamp.getTime()}`,
            item,
          ]),
        ).values(),
      ).slice(-100);

      workOrder.productionCompletion.invalidScansCount =
        (workOrder.productionCompletion.invalidScansCount || 0) +
        invalidScansCount;
      workOrder.productionCompletion.invalidScans = uniqueInvalidScans;
      workOrder.productionCompletion.lastSyncedAt = new Date();

      await workOrder.save();

      if (invalidScansCount > 0 && this.syncCount % 10 === 1) {
        console.log(
          `      📝 Tracked ${invalidScansCount} invalid scans for ${workOrderNumber}`,
        );
      }
    } catch (error) {
      console.error(
        `Error updating invalid scans for ${workOrderNumber}:`,
        error.message,
      );
      // Don't throw error - just log it
    }
  }

  /**
   * Extract unit number from barcode
   * Format: WO-{shortId}-{unitNumber}
   * Example: WO-98640327-001 -> 1
   */
  extractUnitNumber(barcodeId) {
    const parts = barcodeId.split("-");
    if (parts.length >= 3) {
      // Remove leading zeros and convert to int
      const unitNum = parseInt(parts[2], 10);
      return isNaN(unitNum) ? null : unitNum;
    }
    return null;
  }

  /**
   * Cleanup old production tracking data (10+ days old)
   */
  async cleanupOldTrackingData() {
    console.log(
      `\n🧹 [${new Date().toISOString()}] Starting cleanup of old tracking data...`,
    );

    try {
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
      tenDaysAgo.setHours(0, 0, 0, 0);

      const result = await ProductionTracking.deleteMany({
        date: { $lt: tenDaysAgo },
      });

      console.log(
        `✅ Cleaned up ${result.deletedCount} old tracking documents (older than ${tenDaysAgo.toISOString()})\n`,
      );
    } catch (error) {
      console.error("❌ Error during cleanup:", error);
    }
  }

  /**
   * Stop all cron jobs and cleanup
   */
  stop() {
    console.log("\n🛑 Stopping Production Sync Service...");

    if (this.syncJob) {
      this.syncJob.stop();
      this.syncJob = null;
      console.log("   ✅ Sync job stopped");
    }

    if (this.cleanupJob) {
      this.cleanupJob.stop();
      this.cleanupJob = null;
      console.log("   ✅ Cleanup job stopped");
    }

    this.isRunning = false;
    this.syncCount = 0;
    console.log("✅ Production Sync Service stopped successfully\n");
  }

  /**
   * Manual trigger for sync (for testing)
   */
  async manualSync() {
    console.log("\n🔧 Manual sync triggered");
    await this.syncProductionToWorkOrders();
  }

  /**
   * Manual trigger for cleanup (for testing)
   */
  async manualCleanup() {
    console.log("\n🔧 Manual cleanup triggered");
    await this.cleanupOldTrackingData();
  }
}

// Export singleton instance
module.exports = new ProductionSyncService();
