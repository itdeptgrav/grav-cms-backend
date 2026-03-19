// services/productionSyncService.js
//
// Operation tracking concept:
//   Every barcodeScan carries an `activeOps` string[] of operation CODE strings
//   (e.g. ["SJ-01", "BA-03"]) sent by the device.
//   We match those codes against the WO's operations[].operationCode (case-insensitive).
//   A single scan can credit multiple operations simultaneously.
//   Machine assignment is NOT used — machines identified purely from scan data.

const cron = require("node-cron");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Measurement = require("../models/Customer_Models/Measurement");
const EmployeeProductionProgress = require("../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

class ProductionSyncService {
  constructor() {
    this.syncJob = null;
    this.cleanupJob = null;
    this.employeeSyncJob = null;
    this.isRunning = false;
    this.isEmpSyncRunning = false;
    this.isInitialized = false;
    this.syncCount = 0;
  }

  initialize() {
    if (this.isInitialized) {
      console.log("⚠️  Production Sync Service already initialized — skipping duplicate init");
      return;
    }
    this.isInitialized = true;
    console.log("🚀 Initializing Production Sync Service...");

    this.syncJob = cron.schedule("*/2 * * * *", async () => {
      await this.syncProductionToWorkOrders();
    });

    this.cleanupJob = cron.schedule("0 2 * * *", async () => {
      await this.cleanupOldTrackingData();
    });

    this.employeeSyncJob = cron.schedule("*/5 * * * *", async () => {
      await this.syncEmployeeProgress();
    });

    console.log("✅ Production Sync Service initialized");
  }

  // ─── Resolve activeOps (array or legacy comma-string of codes) → operation numbers
  // activeOps: string[] of operation codes, e.g. ["SJ-01", "BA-03"]
  // Matches against workOrder.operations[].operationCode (case-insensitive).
  // Returns array of 1-based operation numbers that matched.
  resolveActiveOpsCodesToOperationNumbers(activeOps, workOrderOperations) {
    if (!activeOps || !workOrderOperations?.length) return [];

    let codes;
    if (Array.isArray(activeOps)) {
      codes = activeOps.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    } else if (typeof activeOps === "string") {
      // Legacy fallback — older device firmware may send comma-string
      codes = activeOps.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    } else {
      return [];
    }

    if (!codes.length) return [];

    const matched = [];
    for (let i = 0; i < workOrderOperations.length; i++) {
      const woCode = (workOrderOperations[i].operationCode || "").trim().toLowerCase();
      if (woCode && codes.includes(woCode)) {
        matched.push(i + 1); // 1-based
      }
    }
    return matched;
  }

  async syncProductionToWorkOrders() {
    if (this.isRunning) return;
    this.isRunning = true;
    const startTime = Date.now();
    this.syncCount++;
    const shouldLog = this.syncCount % 5 === 1;

    if (shouldLog)
      console.log(`\n🔄 [${new Date().toISOString()}] Starting production sync #${this.syncCount}...`);

    try {
      const activeWorkOrders = await WorkOrder.find({
        status: { $in: ["in_progress", "scheduled", "ready_to_start", "paused"] },
      }).lean();

      if (activeWorkOrders.length > 0 && shouldLog)
        console.log(`📋 Found ${activeWorkOrders.length} active work orders`);

      let updatedCount = 0, errorCount = 0, totalInvalidScans = 0;

      for (const workOrder of activeWorkOrders) {
        try {
          const result = await this.processWorkOrder(workOrder);
          if (result?.updated) {
            updatedCount++;
            totalInvalidScans += result.invalidScans || 0;
          }
        } catch (error) {
          errorCount++;
          if (shouldLog)
            console.error(`❌ Error processing WO ${workOrder.workOrderNumber}:`, error.message);
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (shouldLog || updatedCount > 0 || errorCount > 0)
        console.log(
          `✅ Sync #${this.syncCount} completed in ${duration}s - Updated: ${updatedCount}, Errors: ${errorCount}, Invalid: ${totalInvalidScans}\n`
        );
    } catch (error) {
      if (this.syncCount % 5 === 1)
        console.error("❌ Fatal error in sync:", error.message);
    } finally {
      this.isRunning = false;
    }
  }

  async processWorkOrder(workOrderData) {
    const workOrderShortId = workOrderData._id.toString().slice(-8);
    const totalQuantity = workOrderData.quantity || 0;

    const trackingDocs = await ProductionTracking.find({
      "machines.operators.barcodeScans.barcodeId": {
        $regex: `^WO-${workOrderShortId}-`,
      },
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (trackingDocs.length === 0) return { updated: false, invalidScans: 0 };

    const { scansByOperation, invalidScans, totalInvalidScans } =
      this.extractAndValidateScansForWorkOrder(
        trackingDocs,
        workOrderShortId,
        workOrderData,
        totalQuantity
      );

    if (Object.keys(scansByOperation).length === 0) {
      if (totalInvalidScans > 0) {
        await this.updateWorkOrderInvalidScansOnly(
          workOrderData._id,
          workOrderData.workOrderNumber,
          totalInvalidScans,
          invalidScans
        );
        return { updated: true, invalidScans: totalInvalidScans };
      }
      return { updated: false, invalidScans: totalInvalidScans };
    }

    const completionData = this.calculateCompletionMetrics(
      scansByOperation,
      workOrderData,
      totalInvalidScans
    );
    await this.updateWorkOrder(
      workOrderData._id,
      completionData,
      workOrderData.workOrderNumber,
      totalInvalidScans,
      invalidScans
    );
    return { updated: true, invalidScans: totalInvalidScans };
  }

  // ─── Extract & validate scans, bucket by operation using activeOps codes ────
  extractAndValidateScansForWorkOrder(
    trackingDocs,
    workOrderShortId,
    workOrderData,
    totalQuantity
  ) {
    const scansByOperation = {}; // opNumber(int) → opData
    const invalidScans = [];
    let totalInvalidScans = 0;

    const extractUnitNumber = (barcodeId) => {
      const parts = barcodeId.split("-");
      if (parts.length >= 3) {
        const num = parseInt(parts[2], 10);
        return isNaN(num) ? null : num;
      }
      return null;
    };

    for (const trackingDoc of trackingDocs) {
      for (const machine of trackingDoc.machines) {
        const machineInfo = {
          id: machine.machineId?._id?.toString(),
          name: machine.machineId?.name || "Unknown",
          serialNumber: machine.machineId?.serialNumber,
          type: machine.machineId?.type,
        };

        for (const operator of machine.operators || []) {
          const operatorId = operator.operatorIdentityId;
          const operatorName = operator.operatorName || `Operator ${operatorId}`;

          const relevantScans = (operator.barcodeScans || []).filter((scan) =>
            scan.barcodeId.startsWith(`WO-${workOrderShortId}-`)
          );

          if (relevantScans.length === 0) continue;

          for (const scan of relevantScans) {
            const unitNumber = extractUnitNumber(scan.barcodeId);

            if (unitNumber === null || unitNumber <= 0 || unitNumber > totalQuantity) {
              totalInvalidScans++;
              invalidScans.push({
                barcodeId: scan.barcodeId,
                timestamp: scan.timeStamp,
                unitNumber,
                operatorId,
                operatorName,
                machineId: machineInfo.id,
                machineName: machineInfo.name,
                reason: unitNumber === null ? "invalid_format" : "exceeds_quantity",
                details: unitNumber === null
                  ? "Invalid barcode format"
                  : `Unit ${unitNumber} exceeds total quantity (${totalQuantity})`,
              });
              continue;
            }

            // ── Resolve operations from scan.activeOps (code array) ─────────
            const matchedOpNums = this.resolveActiveOpsCodesToOperationNumbers(
              scan.activeOps,
              workOrderData.operations
            );

            const opNumsToProcess = matchedOpNums.length > 0 ? matchedOpNums : [0];

            for (const opNum of opNumsToProcess) {
              if (!scansByOperation[opNum]) {
                if (opNum === 0) {
                  scansByOperation[0] = {
                    operationNumber: 0,
                    operationType: "Unassigned",
                    operationCode: "",
                    plannedTimeSeconds: 0,
                    machines: {},
                  };
                } else {
                  const workOrderOp = workOrderData.operations?.[opNum - 1];
                  if (!workOrderOp) continue;
                  scansByOperation[opNum] = {
                    operationNumber: opNum,
                    operationType: workOrderOp.operationType,
                    operationCode: workOrderOp.operationCode || "",
                    plannedTimeSeconds: workOrderOp.plannedTimeSeconds || 0,
                    machines: {},
                  };
                }
              }

              const opData = scansByOperation[opNum];
              if (!opData.machines[machineInfo.id]) {
                opData.machines[machineInfo.id] = {
                  machineInfo,
                  operators: {},
                  validScans: [],
                };
              }

              const machineBucket = opData.machines[machineInfo.id];
              if (!machineBucket.operators[operatorId]) {
                machineBucket.operators[operatorId] = {
                  operatorIdentityId: operatorId,
                  operatorName,
                  sessions: [],
                };
              }

              let session = machineBucket.operators[operatorId].sessions.find(
                (s) => s.signInTime?.toString() === operator.signInTime?.toString()
              );
              if (!session) {
                session = {
                  signInTime: operator.signInTime,
                  signOutTime: operator.signOutTime,
                  scans: [],
                };
                machineBucket.operators[operatorId].sessions.push(session);
              }

              const enrichedScan = {
                barcodeId: scan.barcodeId,
                timestamp: scan.timeStamp,
                unitNumber,
                operatorId,
                operatorName,
                machineId: machineInfo.id,
                machineName: machineInfo.name,
                activeOps: scan.activeOps || [],
              };

              session.scans.push(enrichedScan);
              machineBucket.validScans.push(enrichedScan);
            }
          }
        }
      }
    }

    return { scansByOperation, invalidScans, totalInvalidScans };
  }

  calculateCompletionMetrics(scansByOperation, workOrderData, totalInvalidScans = 0) {
    const totalQuantity = workOrderData.quantity;
    const operationCompletion = [];
    const operatorDetails = [];
    const efficiencyMetrics = [];
    const timeMetrics = [];
    const unitsByOperation = {};

    const numberedOpNums = Object.keys(scansByOperation)
      .map(Number)
      .filter((n) => n > 0);

    for (const opNum of numberedOpNums) {
      const opData = scansByOperation[opNum];
      const completedUnits = new Set();

      for (const [machineId, machineData] of Object.entries(opData.machines)) {
        machineData.validScans.forEach((scan) => {
          if (scan.unitNumber && scan.unitNumber <= totalQuantity)
            completedUnits.add(scan.unitNumber);
        });

        for (const [operatorId, operatorData] of Object.entries(machineData.operators)) {
          for (const session of operatorData.sessions) {
            if (!session.scans.length) continue;
            const eff = this.calculateSessionEfficiency(
              session,
              opData.plannedTimeSeconds,
              opData.plannedTimeSeconds
            );
            if (eff) {
              efficiencyMetrics.push({
                operationNumber: opNum,
                operationType: opData.operationType,
                operationCode: opData.operationCode || "",
                machineId,
                machineName: machineData.machineInfo.name,
                operatorId,
                operatorName: operatorData.operatorName,
                ...eff,
              });
            }
            operatorDetails.push({
              operatorId,
              operatorName: operatorData.operatorName,
              operationNumber: opNum,
              operationType: opData.operationType,
              operationCode: opData.operationCode || "",
              machineId,
              machineName: machineData.machineInfo.name,
              totalScans: session.scans.length,
              signInTime: session.signInTime,
              signOutTime: session.signOutTime,
            });
          }
        }

        const timing = this.calculateTimingMetrics(machineData.validScans, opData.plannedTimeSeconds);
        if (timing) {
          timeMetrics.push({
            operationNumber: opNum,
            operationType: opData.operationType,
            operationCode: opData.operationCode || "",
            machineId,
            machineName: machineData.machineInfo.name,
            ...timing,
          });
        }
      }

      unitsByOperation[opNum] = completedUnits;
      const completedCount = completedUnits.size;

      operationCompletion.push({
        operationNumber: opNum,
        operationType: opData.operationType,
        operationCode: opData.operationCode || "",
        completedQuantity: completedCount,
        totalQuantity,
        completionPercentage: Math.min(
          Math.round((completedCount / totalQuantity) * 100),
          100
        ),
        status: completedCount >= totalQuantity ? "completed" : "in_progress",
        // Machines are derived from scan data, not planning
        machinesUsed: Object.values(opData.machines).map((m) => ({
          machineId: m.machineInfo.id,
          machineName: m.machineInfo.name,
          machineSerial: m.machineInfo.serialNumber,
        })),
      });
    }

    const overallCompleted = this.calculateOverallCompletion(
      unitsByOperation,
      workOrderData.operations?.length || 0
    );
    const overallPct = totalQuantity > 0 ? (overallCompleted / totalQuantity) * 100 : 0;

    let newStatus = workOrderData.status;
    if (overallCompleted >= totalQuantity) newStatus = "completed";
    else if (overallCompleted > 0) newStatus = "in_progress";

    return {
      overallCompletedQuantity: overallCompleted,
      overallCompletionPercentage: Math.min(overallPct, 100),
      operationCompletion,
      operatorDetails,
      efficiencyMetrics,
      timeMetrics,
      invalidScansCount: totalInvalidScans,
      newStatus,
      lastSyncedAt: new Date(),
    };
  }

  calculateOverallCompletion(unitsByOperation, totalOperations) {
    if (totalOperations === 0) return 0;
    const opNumbers = Object.keys(unitsByOperation)
      .map(Number)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    if (opNumbers.length < totalOperations) return 0;

    let completedUnits = new Set(unitsByOperation[opNumbers[0]]);
    for (let i = 1; i < opNumbers.length; i++) {
      const opUnits = unitsByOperation[opNumbers[i]];
      if (!opUnits) return 0;
      completedUnits = new Set([...completedUnits].filter((u) => opUnits.has(u)));
    }
    return completedUnits.size;
  }

  calculateSessionEfficiency(session, estimatedTime, plannedTime) {
    const scans = session.scans;
    if (!scans.length) return null;

    const sorted = [...scans].sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );
    const intervals = [];
    for (let i = 1; i < sorted.length; i++) {
      const d = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;
      if (d < 1800) intervals.push(d);
    }
    if (!intervals.length) return null;

    const avgTimePerUnit = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const targetTime = plannedTime || estimatedTime || 0;
    const efficiency = targetTime > 0 && avgTimePerUnit > 0
      ? Math.min((targetTime / avgTimePerUnit) * 100, 200) : 0;
    const productiveTime = intervals.reduce((a, b) => a + b, 0);
    const totalSessionTime =
      ((session.signOutTime ? new Date(session.signOutTime) : new Date()) -
        new Date(session.signInTime)) / 1000;

    return {
      unitsCompleted: scans.length,
      avgTimePerUnit: Math.round(avgTimePerUnit),
      estimatedTimePerUnit: estimatedTime || 0,
      plannedTimePerUnit: plannedTime || 0,
      efficiencyPercentage: Math.round(efficiency * 100) / 100,
      utilizationRate: Math.round(
        ((totalSessionTime > 0 ? productiveTime / totalSessionTime : 0) * 100 * 100) / 100
      ),
      totalProductiveTime: Math.round(productiveTime),
      totalSessionTime: Math.round(totalSessionTime),
    };
  }

  calculateTimingMetrics(scans, plannedTime) {
    if (scans.length < 2) return null;

    const unitGroups = {};
    scans.forEach((scan) => {
      if (scan.unitNumber) {
        if (!unitGroups[scan.unitNumber]) unitGroups[scan.unitNumber] = [];
        unitGroups[scan.unitNumber].push(scan);
      }
    });

    const times = [];
    Object.values(unitGroups).forEach((unitScans) => {
      if (unitScans.length === 1) { times.push(plannedTime || 0); return; }
      const sorted = unitScans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      times.push(
        (new Date(sorted[sorted.length - 1].timestamp) - new Date(sorted[0].timestamp)) / 1000
      );
    });

    if (!times.length) return null;
    return {
      avgCompletionTimeSeconds: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
      minCompletionTimeSeconds: Math.round(Math.min(...times)),
      maxCompletionTimeSeconds: Math.round(Math.max(...times)),
      totalUnitsAnalyzed: times.length,
    };
  }

  async updateWorkOrder(workOrderId, completionData, workOrderNumber, invalidScansCount = 0, invalidScans = []) {
    try {
      const workOrder = await WorkOrder.findById(workOrderId);
      if (!workOrder) throw new Error("Work order not found");

      if (!workOrder.workOrderNumber)
        workOrder.workOrderNumber = `WO-${workOrderId.toString().slice(-8)}`;
      if (!workOrder.productionCompletion) workOrder.productionCompletion = {};

      const existingInvalid = workOrder.productionCompletion.invalidScans || [];
      const merged = [...existingInvalid, ...invalidScans.slice(-100)];
      const unique = Array.from(
        new Map(merged.map((i) => [`${i.barcodeId}-${new Date(i.timestamp).getTime()}`, i])).values()
      ).slice(-100);

      workOrder.productionCompletion = {
        overallCompletedQuantity: completionData.overallCompletedQuantity || 0,
        overallCompletionPercentage: completionData.overallCompletionPercentage || 0,
        operationCompletion: completionData.operationCompletion || [],
        operatorDetails: completionData.operatorDetails || [],
        efficiencyMetrics: completionData.efficiencyMetrics || [],
        timeMetrics: completionData.timeMetrics || [],
        invalidScansCount: (workOrder.productionCompletion.invalidScansCount || 0) + invalidScansCount,
        invalidScans: unique,
        lastSyncedAt: completionData.lastSyncedAt || new Date(),
      };

      if (completionData.operationCompletion) {
        completionData.operationCompletion.forEach((opComp) => {
          const op = workOrder.operations[opComp.operationNumber - 1];
          if (op) op.status = opComp.status;
        });
      }

      if (completionData.newStatus && completionData.newStatus !== workOrder.status) {
        workOrder.status = completionData.newStatus;
        if (completionData.newStatus === "completed" && !workOrder.timeline.actualEndDate) {
          workOrder.timeline.actualEndDate = new Date();
        } else if (completionData.newStatus === "in_progress" && !workOrder.timeline.actualStartDate) {
          workOrder.timeline.actualStartDate = new Date();
        }
      }

      await workOrder.save();

      const shouldLog = this.syncCount % 10 === 1 || invalidScansCount > 0 || completionData.overallCompletedQuantity > 0;
      if (shouldLog) {
        const displayName = workOrder.workOrderNumber || workOrderNumber || workOrderId.toString().slice(-8);
        console.log(
          `      ✅ Updated ${displayName}: ${completionData.overallCompletedQuantity}/${workOrder.quantity} (${(completionData.overallCompletionPercentage || 0).toFixed(1)}%)${invalidScansCount > 0 ? ` | ⚠️ ${invalidScansCount} invalid` : ""}`
        );
      }
    } catch (error) {
      const displayName = workOrderNumber || workOrderId?.toString?.()?.slice(-8) || "unknown";
      console.error(`Error updating WO ${displayName}:`, error.message);
    }
  }

  async updateWorkOrderInvalidScansOnly(workOrderId, workOrderNumber, invalidScansCount = 0, invalidScans = []) {
    try {
      const workOrder = await WorkOrder.findById(workOrderId);
      if (!workOrder) return;

      if (!workOrder.workOrderNumber)
        workOrder.workOrderNumber = `WO-${workOrderId.toString().slice(-8)}`;
      if (!workOrder.productionCompletion) workOrder.productionCompletion = {};

      const existing = workOrder.productionCompletion.invalidScans || [];
      const merged = [...existing, ...invalidScans.slice(-100)];
      const unique = Array.from(
        new Map(merged.map((i) => [`${i.barcodeId}-${new Date(i.timestamp).getTime()}`, i])).values()
      ).slice(-100);

      workOrder.productionCompletion.invalidScansCount =
        (workOrder.productionCompletion.invalidScansCount || 0) + invalidScansCount;
      workOrder.productionCompletion.invalidScans = unique;
      workOrder.productionCompletion.lastSyncedAt = new Date();
      await workOrder.save();
    } catch (error) {
      const displayName = workOrderNumber || workOrderId?.toString?.()?.slice(-8) || "unknown";
      console.error(`Error updating invalid scans for ${displayName}:`, error.message);
    }
  }

  async cleanupOldTrackingData() {
    console.log(`\n🧹 [${new Date().toISOString()}] Cleaning up old tracking data...`);
    try {
      const tenDaysAgo = new Date();
      tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);
      tenDaysAgo.setHours(0, 0, 0, 0);
      const result = await ProductionTracking.deleteMany({ date: { $lt: tenDaysAgo } });
      console.log(`✅ Cleaned up ${result.deletedCount} old tracking docs\n`);
    } catch (error) {
      console.error("❌ Cleanup error:", error);
    }
  }

  stop() {
    if (this.syncJob)        { this.syncJob.stop();        this.syncJob = null; }
    if (this.cleanupJob)     { this.cleanupJob.stop();     this.cleanupJob = null; }
    if (this.employeeSyncJob){ this.employeeSyncJob.stop(); this.employeeSyncJob = null; }
    this.isRunning = false;
    this.isEmpSyncRunning = false;
    this.syncCount = 0;
    console.log("✅ Production Sync Service stopped");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE PROGRESS SYNC
  // ═══════════════════════════════════════════════════════════════════════════
  async syncEmployeeProgress() {
    if (this.isEmpSyncRunning) return;
    this.isEmpSyncRunning = true;
    try {
      const measurements = await Measurement.find({ convertedToPO: true })
        .select("_id employeeMeasurements poRequestId")
        .lean();

      for (const measurement of measurements) {
        try {
          await this._syncOneMeasurement(measurement);
        } catch (err) {
          console.error(`[EmpSync] Measurement ${measurement._id}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error("[EmpSync] Fatal:", err.message);
    } finally {
      this.isEmpSyncRunning = false;
    }
  }

  async _syncOneMeasurement(measurement) {
    const moId = measurement.poRequestId;
    if (!moId) return;

    const workOrders = await WorkOrder.find({ customerRequestId: moId })
      .select("_id workOrderNumber stockItemId variantId quantity")
      .lean();
    if (!workOrders.length) return;

    for (const wo of workOrders) {
      const stockIdStr   = wo.stockItemId?.toString();
      const variantIdStr = wo.variantId?.toString() || null;

      const employeeEntries = [];
      for (const empM of measurement.employeeMeasurements || []) {
        const productEntry = (empM.products || []).find((p) => {
          if (p.productId?.toString() !== stockIdStr) return false;
          if (variantIdStr) return p.variantId?.toString() === variantIdStr;
          return true;
        });
        if (!productEntry) continue;
        employeeEntries.push({
          employeeId:   empM.employeeId,
          employeeName: empM.employeeName,
          employeeUIN:  empM.employeeUIN,
          gender:       empM.gender,
          quantity:     productEntry.quantity || 1,
        });
      }
      if (!employeeEntries.length) continue;

      const woPrefix      = `${wo.workOrderNumber}-`;
      const escapedPrefix = woPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      const trackingDocs = await ProductionTracking.find({
        "machines.operators.barcodeScans.barcodeId": { $regex: `^${escapedPrefix}` },
      })
        .select("machines.operators.barcodeScans.barcodeId")
        .lean();

      const scannedUnits = new Set();
      for (const doc of trackingDocs) {
        for (const machine of doc.machines || []) {
          for (const operator of machine.operators || []) {
            for (const scan of operator.barcodeScans || []) {
              if (!scan.barcodeId.startsWith(woPrefix)) continue;
              const suffix  = scan.barcodeId.slice(woPrefix.length);
              const unitNum = parseInt(suffix, 10);
              if (!isNaN(unitNum) && unitNum > 0) scannedUnits.add(unitNum);
            }
          }
        }
      }

      let cursor = 1;
      for (const emp of employeeEntries) {
        const unitStart = cursor;
        const unitEnd   = cursor + emp.quantity - 1;
        cursor          = unitEnd + 1;

        const completedUnitNumbers = [];
        for (let u = unitStart; u <= unitEnd; u++) {
          if (scannedUnits.has(u)) completedUnitNumbers.push(u);
        }

        const completedUnits = completedUnitNumbers.length;
        const completionPercentage = emp.quantity > 0
          ? Math.min(Math.round((completedUnits / emp.quantity) * 100), 100) : 0;

        await EmployeeProductionProgress.findOneAndUpdate(
          { workOrderId: wo._id, employeeId: emp.employeeId },
          {
            $set: {
              measurementId:        measurement._id,
              manufacturingOrderId: moId,
              employeeName:         emp.employeeName,
              employeeUIN:          emp.employeeUIN,
              gender:               emp.gender,
              unitStart,
              unitEnd,
              totalUnits:           emp.quantity,
              completedUnits,
              completedUnitNumbers,
              completionPercentage,
              lastSyncedAt:         new Date(),
            },
          },
          { upsert: true }
        );
      }
    }
  }

  async manualSync()         { await this.syncProductionToWorkOrders(); }
  async manualCleanup()      { await this.cleanupOldTrackingData(); }
  async manualEmployeeSync() { await this.syncEmployeeProgress(); }
}

module.exports = new ProductionSyncService();