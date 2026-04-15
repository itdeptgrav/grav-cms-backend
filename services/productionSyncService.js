const cron = require("node-cron");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const EmployeeProductionProgress = require("../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

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

    // WO sync: every 15 minutes
    this.syncJob = cron.schedule("*/15 * * * *", async () => {
      await this.syncProductionToWorkOrders();
    });

    // Cleanup: daily at 2am
    this.cleanupJob = cron.schedule("0 2 * * *", async () => {
      await this.cleanupOldTrackingData();
    });

    // Employee sync: every 10 minutes (runs after WO sync has written completedUnitNumbers)
    this.employeeSyncJob = cron.schedule("*/10 * * * *", async () => {
      await this.syncEmployeeProgress();
    });

    console.log("✅ Production Sync Service initialized");
  }

  resolveActiveOpsCodesToOperationNumbers(activeOps, workOrderOperations) {
    if (!activeOps || !workOrderOperations?.length) return [];
    let codes;
    if (Array.isArray(activeOps))
      codes = activeOps.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    else if (typeof activeOps === "string")
      codes = activeOps.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else return [];
    if (!codes.length) return [];
    const matched = [];
    for (let i = 0; i < workOrderOperations.length; i++) {
      const woCode = (workOrderOperations[i].operationCode || "").trim().toLowerCase();
      if (woCode && codes.includes(woCode)) matched.push(i + 1);
    }
    return matched;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // WORK ORDER PRODUCTION SYNC (every 15 min)
  // ═══════════════════════════════════════════════════════════════════════════
  async syncProductionToWorkOrders() {
    if (this.isRunning) return;
    this.isRunning = true;
    const startTime = Date.now();
    this.syncCount++;
    const shouldLog = this.syncCount % 3 === 1;

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
            console.error(
              `❌ Error processing WO ${workOrder.workOrderNumber || workOrder._id.toString().slice(-8)}:`,
              error.message
            );
        }
      }

      const duration = ((Date.now() - startTime) / 1000).toFixed(2);
      if (shouldLog || updatedCount > 0 || errorCount > 0)
        console.log(
          `✅ Sync #${this.syncCount} completed in ${duration}s — Updated: ${updatedCount}, Errors: ${errorCount}, Invalid: ${totalInvalidScans}\n`
        );
    } catch (error) {
      if (shouldLog) console.error("❌ Fatal error in sync:", error.message);
    } finally {
      this.isRunning = false;
    }
  }

  async processWorkOrder(workOrderData) {
    const workOrderShortId = workOrderData._id.toString().slice(-8);
    const totalQuantity = workOrderData.quantity || 0;

    const trackingDocs = await ProductionTracking.find({
      "machines.operators.barcodeScans.barcodeId": { $regex: `^WO-${workOrderShortId}-` },
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (trackingDocs.length === 0) return { updated: false, invalidScans: 0 };

    const { scansByOperation, invalidScans, totalInvalidScans } =
      this.extractAndValidateScansForWorkOrder(
        trackingDocs, workOrderShortId, workOrderData, totalQuantity
      );

    if (Object.keys(scansByOperation).length === 0) {
      if (totalInvalidScans > 0) {
        await this.updateWorkOrderInvalidScansOnly(
          workOrderData._id, workOrderData.workOrderNumber, totalInvalidScans, invalidScans
        );
        return { updated: true, invalidScans: totalInvalidScans };
      }
      return { updated: false, invalidScans: totalInvalidScans };
    }

    const completionData = this.calculateCompletionMetrics(
      scansByOperation, workOrderData, totalInvalidScans
    );
    await this.updateWorkOrder(
      workOrderData._id, completionData, workOrderData.workOrderNumber,
      totalInvalidScans, invalidScans
    );
    return { updated: true, invalidScans: totalInvalidScans };
  }

  extractAndValidateScansForWorkOrder(trackingDocs, workOrderShortId, workOrderData, totalQuantity) {
    const scansByOperation = {};
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
          const relevantScans = (operator.barcodeScans || []).filter(
            (scan) => scan.barcodeId.startsWith(`WO-${workOrderShortId}-`)
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
                details:
                  unitNumber === null
                    ? "Invalid barcode format"
                    : `Unit ${unitNumber} exceeds total quantity (${totalQuantity})`,
              });
              continue;
            }

            const matchedOpNums = this.resolveActiveOpsCodesToOperationNumbers(
              scan.activeOps, workOrderData.operations
            );
            const opNumsToProcess = matchedOpNums.length > 0 ? matchedOpNums : [0];

            for (const opNum of opNumsToProcess) {
              if (!scansByOperation[opNum]) {
                if (opNum === 0) {
                  scansByOperation[0] = {
                    operationNumber: 0, operationType: "Unassigned",
                    operationCode: "", plannedTimeSeconds: 0, machines: {},
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
              if (!opData.machines[machineInfo.id])
                opData.machines[machineInfo.id] = { machineInfo, operators: {}, validScans: [] };

              const machineBucket = opData.machines[machineInfo.id];
              if (!machineBucket.operators[operatorId])
                machineBucket.operators[operatorId] = { operatorIdentityId: operatorId, operatorName, sessions: [] };

              let session = machineBucket.operators[operatorId].sessions.find(
                (s) => s.signInTime?.toString() === operator.signInTime?.toString()
              );
              if (!session) {
                session = { signInTime: operator.signInTime, signOutTime: operator.signOutTime, scans: [] };
                machineBucket.operators[operatorId].sessions.push(session);
              }

              const enrichedScan = {
                barcodeId: scan.barcodeId, timestamp: scan.timeStamp,
                unitNumber, operatorId, operatorName,
                machineId: machineInfo.id, machineName: machineInfo.name,
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
    const operationCompletion = [], operatorDetails = [], efficiencyMetrics = [], timeMetrics = [];
    const unitsByOperation = {};
    const numberedOpNums = Object.keys(scansByOperation).map(Number).filter((n) => n > 0);

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
              session, opData.plannedTimeSeconds, opData.plannedTimeSeconds
            );
            if (eff)
              efficiencyMetrics.push({
                operationNumber: opNum, operationType: opData.operationType,
                operationCode: opData.operationCode || "", machineId,
                machineName: machineData.machineInfo.name, operatorId,
                operatorName: operatorData.operatorName, ...eff,
              });
            operatorDetails.push({
              operatorId, operatorName: operatorData.operatorName,
              operationNumber: opNum, operationType: opData.operationType,
              operationCode: opData.operationCode || "", machineId,
              machineName: machineData.machineInfo.name,
              totalScans: session.scans.length,
              signInTime: session.signInTime, signOutTime: session.signOutTime,
            });
          }
        }

        const timing = this.calculateTimingMetrics(machineData.validScans, opData.plannedTimeSeconds);
        if (timing)
          timeMetrics.push({
            operationNumber: opNum, operationType: opData.operationType,
            operationCode: opData.operationCode || "", machineId,
            machineName: machineData.machineInfo.name, ...timing,
          });
      }

      unitsByOperation[opNum] = completedUnits;
      const completedCount = completedUnits.size;

      operationCompletion.push({
        operationNumber: opNum,
        operationType: opData.operationType,
        operationCode: opData.operationCode || "",
        completedQuantity: completedCount,
        completedUnitNumbers: [...completedUnits], // ← written here, read by employee sync
        totalQuantity,
        completionPercentage: Math.min(Math.round((completedCount / totalQuantity) * 100), 100),
        status: completedCount >= totalQuantity ? "completed" : "in_progress",
      });
    }

    const overallCompleted = this.calculateOverallCompletion(
      unitsByOperation, workOrderData.operations?.length || 0
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
      .map(Number).filter((n) => n > 0).sort((a, b) => a - b);
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
    const sorted = [...scans].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
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

  // ─────────────────────────────────────────────────────────────────────────
  // updateWorkOrder — NO-DOWNGRADE rule applied here
  // completedQuantity and completedUnitNumbers are both append-only.
  // ─────────────────────────────────────────────────────────────────────────
  async updateWorkOrder(workOrderId, completionData, workOrderNumber, invalidScansCount = 0, invalidScans = []) {
    try {
      const workOrder = await WorkOrder.findById(workOrderId);
      if (!workOrder) throw new Error("Work order not found");
      if (!workOrder.workOrderNumber)
        workOrder.workOrderNumber = `WO-${workOrderId.toString().slice(-8)}`;
      if (!workOrder.productionCompletion) workOrder.productionCompletion = {};

      // ── overall — only go up, never down ─────────────────────────────
      const existingOverall = workOrder.productionCompletion.overallCompletedQuantity || 0;
      const newOverall = completionData.overallCompletedQuantity || 0;
      const acceptedOverall = Math.max(existingOverall, newOverall);
      const acceptedPct = workOrder.quantity > 0
        ? Math.min(Math.round((acceptedOverall / workOrder.quantity) * 100), 100)
        : 0;

      // ── per-operation — merge completedUnitNumbers (union), keep higher count ──
      const existingOpMap = new Map(
        (workOrder.productionCompletion.operationCompletion || []).map(
          (oc) => [oc.operationNumber, oc]
        )
      );

      const mergedOpCompletion = completionData.operationCompletion.map((incoming) => {
        const existing = existingOpMap.get(incoming.operationNumber);
        if (!existing) return incoming;

        // Union of unit numbers — never shrink
        const existingSet = new Set(existing.completedUnitNumbers || []);
        const incomingSet = new Set(incoming.completedUnitNumbers || []);
        const mergedUnits = [...new Set([...existingSet, ...incomingSet])];
        const mergedCount = Math.max(existing.completedQuantity || 0, incoming.completedQuantity || 0);
        const mergedPct = workOrder.quantity > 0
          ? Math.min(Math.round((mergedCount / workOrder.quantity) * 100), 100)
          : 0;

        return {
          ...incoming,
          completedUnitNumbers: mergedUnits,
          completedQuantity: mergedCount,
          completionPercentage: mergedPct,
          // status: keep "completed" once set
          status: existing.status === "completed" ? "completed" : incoming.status,
        };
      });

      // ── invalid scans — merge + deduplicate, cap at 100 ──────────────
      const existingInvalid = workOrder.productionCompletion.invalidScans || [];
      const merged = [...existingInvalid, ...invalidScans.slice(-100)];
      const unique = Array.from(
        new Map(
          merged.map((i) => [`${i.barcodeId}-${new Date(i.timestamp).getTime()}`, i])
        ).values()
      ).slice(-100);

      // ── write ─────────────────────────────────────────────────────────
      workOrder.productionCompletion = {
        overallCompletedQuantity: acceptedOverall,
        overallCompletionPercentage: acceptedPct,
        operationCompletion: mergedOpCompletion,
        operatorDetails: completionData.operatorDetails || [],
        efficiencyMetrics: completionData.efficiencyMetrics || [],
        timeMetrics: completionData.timeMetrics || [],
        invalidScansCount: (workOrder.productionCompletion.invalidScansCount || 0) + invalidScansCount,
        invalidScans: unique,
        lastSyncedAt: completionData.lastSyncedAt || new Date(),
      };

      // Update per-operation status on the operations array
      mergedOpCompletion.forEach((opComp) => {
        const op = workOrder.operations[opComp.operationNumber - 1];
        if (op) op.status = opComp.status;
      });

      // Update WO status — but never downgrade completed → in_progress
      if (completionData.newStatus && completionData.newStatus !== workOrder.status) {
        if (workOrder.status !== "completed") {
          workOrder.status = completionData.newStatus;
          if (completionData.newStatus === "completed" && !workOrder.timeline.actualEndDate)
            workOrder.timeline.actualEndDate = new Date();
          else if (completionData.newStatus === "in_progress" && !workOrder.timeline.actualStartDate)
            workOrder.timeline.actualStartDate = new Date();
        }
      }

      await workOrder.save();

      const shouldLog =
        this.syncCount % 10 === 1 ||
        invalidScansCount > 0 ||
        acceptedOverall > existingOverall;

      if (shouldLog) {
        const displayName = workOrder.workOrderNumber || workOrderNumber || workOrderId.toString().slice(-8);
        console.log(
          `      ✅ Updated ${displayName}: ${acceptedOverall}/${workOrder.quantity}` +
          ` (${acceptedPct.toFixed(1)}%)` +
          `${acceptedOverall === existingOverall ? " [no change — kept existing]" : ""}` +
          `${invalidScansCount > 0 ? ` | ⚠️ ${invalidScansCount} invalid` : ""}`
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
        new Map(
          merged.map((i) => [`${i.barcodeId}-${new Date(i.timestamp).getTime()}`, i])
        ).values()
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
      const fifteenDaysAgo = new Date();
      fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
      fifteenDaysAgo.setHours(0, 0, 0, 0);

      const completedWorkOrders = await WorkOrder.find({ status: "completed" }).select("_id").lean();
      if (completedWorkOrders.length === 0) {
        console.log("✅ No completed work orders found — skipping cleanup\n");
        return;
      }

      const completedShortIds = completedWorkOrders.map((wo) => wo._id.toString().slice(-8));
      const barcodePatterns = completedShortIds.map((id) => `WO-${id}-`);
      const oldTrackingDocs = await ProductionTracking.find({ date: { $lt: fifteenDaysAgo } }).lean();

      if (oldTrackingDocs.length === 0) {
        console.log("✅ No tracking docs older than 15 days found\n");
        return;
      }

      const docsToDelete = [], docsToPatch = [];

      for (const doc of oldTrackingDocs) {
        let docHasActiveScan = false;
        outer: for (const machine of doc.machines || []) {
          for (const operator of machine.operators || []) {
            for (const scan of operator.barcodeScans || []) {
              if (!barcodePatterns.some((p) => (scan.barcodeId || "").startsWith(p))) {
                docHasActiveScan = true;
                break outer;
              }
            }
          }
        }
        if (docHasActiveScan) docsToPatch.push(doc._id);
        else docsToDelete.push(doc._id);
      }

      if (docsToDelete.length > 0) {
        await ProductionTracking.deleteMany({ _id: { $in: docsToDelete } });
        console.log(`   🗑️  Deleted ${docsToDelete.length} tracking docs`);
      }

      let patchedCount = 0;
      for (const docId of docsToPatch) {
        const doc = await ProductionTracking.findById(docId);
        if (!doc) continue;
        for (const machine of doc.machines)
          for (const operator of machine.operators)
            operator.barcodeScans = operator.barcodeScans.filter(
              (scan) => !barcodePatterns.some((p) => (scan.barcodeId || "").startsWith(p))
            );
        await doc.save();
        patchedCount++;
      }

      if (patchedCount > 0)
        console.log(`   ✂️  Stripped completed WO scans from ${patchedCount} mixed tracking docs`);
      console.log(`✅ Cleanup complete — deleted: ${docsToDelete.length}, patched: ${patchedCount}\n`);
    } catch (error) {
      console.error("❌ Cleanup error:", error);
    }
  }

  stop() {
    if (this.syncJob) { this.syncJob.stop(); this.syncJob = null; }
    if (this.cleanupJob) { this.cleanupJob.stop(); this.cleanupJob = null; }
    if (this.employeeSyncJob) { this.employeeSyncJob.stop(); this.employeeSyncJob = null; }
    this.isRunning = false; this.isEmpSyncRunning = false; this.syncCount = 0;
    console.log("✅ Production Sync Service stopped");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMPLOYEE PROGRESS SYNC (every 10 min)
  //
  // Reads WO.productionCompletion.operationCompletion[].completedUnitNumbers
  // — does NOT re-query ProductionTracking.
  //
  // A unit is "truly complete" only if it appears in ALL operations'
  // completedUnitNumbers (intersection). This matches calculateOverallCompletion.
  //
  // completedUnits on employee docs is also append-only (no-downgrade).
  // ═══════════════════════════════════════════════════════════════════════════
  async syncEmployeeProgress() {
    if (this.isEmpSyncRunning) return;
    this.isEmpSyncRunning = true;
    const shouldLog = this.syncCount % 3 === 1;

    try {
      const progressDocs = await EmployeeProductionProgress.find({
        isDispatched: false,
      }).lean();

      if (!progressDocs.length) {
        if (shouldLog) console.log("[EmpSync] No active employee progress docs found");
        return;
      }

      // Group by workOrderId
      const byWorkOrder = new Map();
      for (const doc of progressDocs) {
        const woId = doc.workOrderId.toString();
        if (!byWorkOrder.has(woId)) byWorkOrder.set(woId, []);
        byWorkOrder.get(woId).push(doc);
      }

      if (shouldLog)
        console.log(
          `[EmpSync] Processing ${progressDocs.length} docs across ${byWorkOrder.size} work orders`
        );

      let updatedCount = 0;

      for (const [woId, empDocs] of byWorkOrder) {
        try {
          // Fetch WO — only need productionCompletion and operations count
          const wo = await WorkOrder.findById(woId)
            .select("_id quantity operations productionCompletion")
            .lean();
          if (!wo) continue;

          const totalOps = wo.operations?.length || 0;
          const opCompletion = wo.productionCompletion?.operationCompletion || [];

          // ── Build truly-completed unit set (intersection across all ops) ──
          const numberedOps = opCompletion
            .filter((oc) => oc.operationNumber > 0)
            .sort((a, b) => a.operationNumber - b.operationNumber);

          let trulyCompletedUnits = new Set();

          if (totalOps === 0 || numberedOps.length === 0) {
            // No operations defined — nothing complete
            trulyCompletedUnits = new Set();
          } else if (numberedOps.length < totalOps) {
            // Not all operations have data yet — nothing fully done
            trulyCompletedUnits = new Set();
          } else {
            // Intersect unit numbers across all operations
            trulyCompletedUnits = new Set(numberedOps[0].completedUnitNumbers || []);
            for (let i = 1; i < numberedOps.length; i++) {
              const opSet = new Set(numberedOps[i].completedUnitNumbers || []);
              for (const u of trulyCompletedUnits) {
                if (!opSet.has(u)) trulyCompletedUnits.delete(u);
              }
            }
          }

          // ── Update each employee doc — no-downgrade rule ──────────────
          for (const empDoc of empDocs) {
            const unitStart = empDoc.unitStart || 1;
            const unitEnd = empDoc.unitEnd || unitStart;

            // New completed unit numbers from the intersection set
            const newlyCompleted = [];
            for (let u = unitStart; u <= unitEnd; u++) {
              if (trulyCompletedUnits.has(u)) newlyCompleted.push(u);
            }

            // Union with existing (no-downgrade)
            const existingSet = new Set(empDoc.completedUnitNumbers || []);
            const mergedSet = new Set([...existingSet, ...newlyCompleted]);
            const mergedArr = [...mergedSet].sort((a, b) => a - b);
            const mergedCount = mergedArr.length;

            const completionPercentage = empDoc.totalUnits > 0
              ? Math.min(Math.round((mergedCount / empDoc.totalUnits) * 100), 100)
              : 0;

            // Only write if something actually changed
            if (mergedCount !== (empDoc.completedUnits || 0)) {
              await EmployeeProductionProgress.updateOne(
                { _id: empDoc._id },
                {
                  $set: {
                    completedUnits: mergedCount,
                    completedUnitNumbers: mergedArr,
                    completionPercentage,
                    lastSyncedAt: new Date(),
                  },
                }
              );
              updatedCount++;
            }
          }
        } catch (err) {
          console.error(`[EmpSync] Error processing WO ${woId}: ${err.message}`);
        }
      }

      if (shouldLog || updatedCount > 0)
        console.log(`[EmpSync] Done — updated ${updatedCount} of ${progressDocs.length} docs`);
    } catch (err) {
      console.error("[EmpSync] Fatal:", err.message);
    } finally {
      this.isEmpSyncRunning = false;
    }
  }

  async manualSync() { await this.syncProductionToWorkOrders(); }
  async manualCleanup() { await this.cleanupOldTrackingData(); }
  async manualEmployeeSync() { await this.syncEmployeeProgress(); }
}

module.exports = new ProductionSyncService();