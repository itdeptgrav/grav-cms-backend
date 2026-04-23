// routes/CMS_Routes/Manufacturing/Packaging/packagingRoutes.js
//
// Mount as:
//   const packagingRoutes = require("./routes/CMS_Routes/Manufacturing/Packaging/packagingRoutes");
//   app.use("/api/cms/manufacturing/packaging", packagingRoutes);
//
// Packaging is treated as the authoritative "this unit is fully done" signal.
// The /done route:
//   1. Records packaging event (packagedQuantity, packagedUnits, history)
//   2. Marks each packaged unit as completed across all operations
//   3. Sets overallCompletedQuantity from the UNION of all packaged units on the WO
//      (authoritative — does NOT rely on intersection of operation scans, which
//      was the bug causing WO "Done" to stay at 0)
//
// Append-only: re-scanning an already-packaged unit is a no-op.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");

router.use(EmployeeAuthMiddleware);

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═════════════════════════════════════════════════════════════════════════════

const parseBarcode = (barcodeId) => {
  try {
    const parts = (barcodeId || "").trim().split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2], 10),
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Mark a list of unit numbers as fully completed on the WO.
//
// FIXED: Overall completed is now computed from the UNION of all unit numbers
// in wo.packagingRecords (authoritative), NOT from the intersection of per-op
// completedUnitNumbers (which was empty whenever one op had missing data).
//
// IMPORTANT: This is called AFTER the new packagingRecords entry has been
// pushed onto wo.packagingRecords, so the union naturally includes the new
// units too.
// ─────────────────────────────────────────────────────────────────────────────
function markUnitsAsFullyCompleted(wo, unitNumbers, now) {
  if (!unitNumbers?.length) return;
  if (!wo.productionCompletion) wo.productionCompletion = {};

  const totalQty = wo.quantity || 0;
  const ops = wo.operations || [];
  const opCount = ops.length;

  let opCompletion = wo.productionCompletion.operationCompletion || [];

  // ── Update per-operation completedUnitNumbers (union these units in) ────
  if (opCount > 0) {
    for (let i = 0; i < opCount; i++) {
      const opNum = i + 1;
      let entry = opCompletion.find((oc) => oc.operationNumber === opNum);
      if (!entry) {
        entry = {
          operationNumber: opNum,
          operationType: ops[i].operationType || `Operation ${opNum}`,
          operationCode: ops[i].operationCode || "",
          completedQuantity: 0,
          completedUnitNumbers: [],
          totalQuantity: totalQty,
          completionPercentage: 0,
          status: "pending",
        };
        opCompletion.push(entry);
      }

      const existing = new Set(entry.completedUnitNumbers || []);
      unitNumbers.forEach((u) => existing.add(u));
      const mergedArr = [...existing].sort((a, b) => a - b);

      entry.completedUnitNumbers = mergedArr;
      entry.completedQuantity = Math.max(entry.completedQuantity || 0, mergedArr.length);
      entry.totalQuantity = totalQty;
      entry.completionPercentage = totalQty > 0
        ? Math.min(Math.round((entry.completedQuantity / totalQty) * 100), 100)
        : 0;
      entry.status = entry.completedQuantity >= totalQty ? "completed" : "in_progress";

      if (wo.operations[i]) wo.operations[i].status = entry.status;
    }
  } else {
    let entry = opCompletion[0];
    if (!entry) {
      entry = {
        operationNumber: 1,
        operationType: "Production",
        operationCode: "",
        completedQuantity: 0,
        completedUnitNumbers: [],
        totalQuantity: totalQty,
        completionPercentage: 0,
        status: "pending",
      };
      opCompletion.push(entry);
    }
    const existing = new Set(entry.completedUnitNumbers || []);
    unitNumbers.forEach((u) => existing.add(u));
    const mergedArr = [...existing].sort((a, b) => a - b);

    entry.completedUnitNumbers = mergedArr;
    entry.completedQuantity = Math.max(entry.completedQuantity || 0, mergedArr.length);
    entry.totalQuantity = totalQty;
    entry.completionPercentage = totalQty > 0
      ? Math.min(Math.round((entry.completedQuantity / totalQty) * 100), 100)
      : 0;
    entry.status = entry.completedQuantity >= totalQty ? "completed" : "in_progress";
  }

  wo.productionCompletion.operationCompletion = opCompletion;

  // ── Overall completed = UNION of all packaged unit numbers on this WO ───
  // This is the authoritative source. We walk through every packagingRecords
  // entry (the current batch has already been pushed before this fn runs) and
  // also fold in the incoming unitNumbers as a safety net.
  const overallSet = new Set();
  for (const rec of wo.packagingRecords || []) {
    for (const u of (rec.unitNumbers || [])) overallSet.add(u);
  }
  for (const u of unitNumbers) overallSet.add(u);

  const newOverall = overallSet.size;
  const existingOverall = wo.productionCompletion.overallCompletedQuantity || 0;
  // Append-only
  const acceptedOverall = Math.max(existingOverall, newOverall);

  wo.productionCompletion.overallCompletedQuantity = acceptedOverall;
  wo.productionCompletion.overallCompletionPercentage = totalQty > 0
    ? Math.min(Math.round((acceptedOverall / totalQty) * 100), 100)
    : 0;
  wo.productionCompletion.lastSyncedAt = now;

  // ── WO status bump (never downgrade) ────────────────────────────────────
  if (wo.status !== "completed") {
    if (acceptedOverall >= totalQty && totalQty > 0) {
      wo.status = "completed";
      if (wo.timeline && !wo.timeline.actualEndDate) wo.timeline.actualEndDate = now;
    } else if (acceptedOverall > 0 && wo.status === "pending") {
      wo.status = "in_progress";
      if (wo.timeline && !wo.timeline.actualStartDate) wo.timeline.actualStartDate = now;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurement path — push packaging record FIRST, then mark complete
// ─────────────────────────────────────────────────────────────────────────────
async function updateWorkOrderOnPackaging({
  workOrderId, packagedAdded, newlyPackagedUnits, packagedBy,
  packagingType, employeeIds = [], employeeNames = [], notes, now,
}) {
  const wo = await WorkOrder.findById(workOrderId);
  if (!wo) return { unitsMarkedComplete: 0 };

  const currentPackaged = wo.packagedQuantity || 0;
  wo.packagedQuantity = Math.min((wo.quantity || 0), currentPackaged + packagedAdded);

  wo.packagingRecords = wo.packagingRecords || [];
  wo.packagingRecords.push({
    packagedQuantity: packagedAdded,
    packagedAt: now,
    packagedBy,
    packagingType,
    employeeIds,
    employeeNames,
    notes,
    unitNumbers: newlyPackagedUnits,
  });

  const beforeOverall = wo.productionCompletion?.overallCompletedQuantity || 0;
  markUnitsAsFullyCompleted(wo, newlyPackagedUnits, now);
  const afterOverall = wo.productionCompletion?.overallCompletedQuantity || 0;

  await wo.save();
  return { unitsMarkedComplete: afterOverall - beforeOverall };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk path — dedupe units against previous packagingRecords, then commit
// ─────────────────────────────────────────────────────────────────────────────
async function commitBulkPackaging({ workOrderId, scannedUnits, packagedBy, notes, now }) {
  const wo = await WorkOrder.findById(workOrderId);
  if (!wo) return { unitsAdded: 0, unitsMarkedComplete: 0 };

  const previouslyPackagedUnits = new Set(
    (wo.packagingRecords || []).flatMap((r) => r.unitNumbers || [])
  );
  const newlyPackaged = scannedUnits.filter(
    (u) => u > 0 && u <= (wo.quantity || 0) && !previouslyPackagedUnits.has(u)
  );
  if (!newlyPackaged.length) return { unitsAdded: 0, unitsMarkedComplete: 0 };

  const currentPackaged = wo.packagedQuantity || 0;
  const cappedPackaged = Math.min((wo.quantity || 0), currentPackaged + newlyPackaged.length);
  const actualAddition = cappedPackaged - currentPackaged;
  if (actualAddition <= 0) return { unitsAdded: 0, unitsMarkedComplete: 0 };

  wo.packagedQuantity = cappedPackaged;
  wo.packagingRecords = wo.packagingRecords || [];
  wo.packagingRecords.push({
    packagedQuantity: actualAddition,
    packagedAt: now,
    packagedBy,
    packagingType: "bulk",
    notes,
    unitNumbers: newlyPackaged,
  });

  const beforeOverall = wo.productionCompletion?.overallCompletedQuantity || 0;
  markUnitsAsFullyCompleted(wo, newlyPackaged, now);
  const afterOverall = wo.productionCompletion?.overallCompletedQuantity || 0;

  await wo.save();

  return {
    unitsAdded: actualAddition,
    unitsMarkedComplete: afterOverall - beforeOverall,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// POST /fetch-order
// ═════════════════════════════════════════════════════════════════════════════
router.post("/fetch-order", async (req, res) => {
  try {
    const { barcodes } = req.body;
    if (!Array.isArray(barcodes) || !barcodes.length) {
      return res.status(400).json({ success: false, message: "No barcodes provided" });
    }

    const parsed = [];
    const invalid = [];
    const seen = new Set();
    for (const raw of barcodes) {
      const trimmed = (raw || "").trim();
      if (!trimmed) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      const p = parseBarcode(trimmed);
      if (!p.success || isNaN(p.unitNumber)) {
        invalid.push({ barcode: trimmed, reason: "Invalid format" });
        continue;
      }
      parsed.push({ barcode: trimmed, ...p });
    }

    if (!parsed.length) {
      return res.status(400).json({ success: false, message: "No valid barcodes found", invalid });
    }

    const byWO = new Map();
    for (const p of parsed) {
      if (!byWO.has(p.workOrderShortId)) byWO.set(p.workOrderShortId, []);
      byWO.get(p.workOrderShortId).push(p);
    }

    const workOrderShortIds = [...byWO.keys()];
    const allWOs = await WorkOrder.find({}).lean();
    const woMap = new Map();
    for (const shortId of workOrderShortIds) {
      const wo = allWOs.find((w) => w._id.toString().slice(-8) === shortId);
      if (wo) woMap.set(shortId, wo);
    }

    for (const shortId of workOrderShortIds) {
      if (!woMap.has(shortId)) {
        byWO.get(shortId).forEach((p) =>
          invalid.push({ barcode: p.barcode, reason: `Work order ${shortId} not found` })
        );
        byWO.delete(shortId);
      }
    }

    if (!byWO.size) {
      return res.status(400).json({ success: false, message: "No barcodes matched a work order", invalid });
    }

    const moIds = [...new Set([...byWO.keys()].map((sid) => woMap.get(sid)?.customerRequestId?.toString()).filter(Boolean))];
    const mos = await CustomerRequest.find({ _id: { $in: moIds } })
      .select("requestId requestType customerInfo")
      .lean();
    const moMap = new Map(mos.map((m) => [m._id.toString(), m]));

    const groups = [];
    for (const [shortId, scans] of byWO) {
      const wo = woMap.get(shortId);
      const mo = wo.customerRequestId ? moMap.get(wo.customerRequestId.toString()) : null;
      const isMeasurement = mo?.requestType === "measurement_conversion";

      const validScans = [];
      for (const s of scans) {
        if (s.unitNumber <= 0 || s.unitNumber > wo.quantity) {
          invalid.push({ barcode: s.barcode, reason: `Unit ${s.unitNumber} out of range (1-${wo.quantity})` });
          continue;
        }
        validScans.push(s);
      }
      if (!validScans.length) continue;

      const group = {
        workOrderId: wo._id,
        workOrderShortId: shortId,
        workOrderNumber: wo.workOrderNumber,
        stockItemName: wo.stockItemName,
        stockItemReference: wo.stockItemReference,
        variantAttributes: wo.variantAttributes || [],
        quantity: wo.quantity,
        moInfo: mo
          ? {
              _id: mo._id,
              moNumber: `MO-${mo.requestId}`,
              customerName: mo.customerInfo?.name || "",
              requestType: mo.requestType,
            }
          : null,
        isMeasurement,
        scannedUnits: validScans.map((s) => s.unitNumber).sort((a, b) => a - b),
        scannedCount: validScans.length,
      };

      if (isMeasurement) {
        const empDocs = await EmployeeProductionProgress.find({ workOrderId: wo._id }).lean();
        const perEmployee = [];

        for (const emp of empDocs) {
          const unitsOfThisEmp = validScans
            .map((s) => s.unitNumber)
            .filter((u) => u >= emp.unitStart && u <= emp.unitEnd);
          if (!unitsOfThisEmp.length) continue;

          const alreadyPackagedUnitsSet = new Set(
            (emp.packagingHistory || []).flatMap((h) => h.unitNumbers || [])
          );
          const newUnitsToPackage = unitsOfThisEmp.filter((u) => !alreadyPackagedUnitsSet.has(u));

          perEmployee.push({
            progressDocId: emp._id,
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN,
            gender: emp.gender,
            productName: wo.stockItemName,
            unitStart: emp.unitStart,
            unitEnd: emp.unitEnd,
            totalUnits: emp.totalUnits,
            completedUnits: emp.completedUnits || 0,
            alreadyPackaged: emp.packagedUnits || 0,
            scannedUnits: unitsOfThisEmp.sort((a, b) => a - b),
            scannedCount: unitsOfThisEmp.length,
            packagingCapacity: newUnitsToPackage.length,
            willPackage: newUnitsToPackage.length,
          });
        }

        const matchedUnits = new Set(perEmployee.flatMap((e) => e.scannedUnits));
        const unmatched = validScans.map((s) => s.unitNumber).filter((u) => !matchedUnits.has(u));
        unmatched.forEach((u) =>
          invalid.push({
            barcode: `WO-${shortId}-${String(u).padStart(3, "0")}`,
            reason: "No employee assigned to this unit",
          })
        );

        group.employees = perEmployee;
      } else {
        const previouslyPackaged = new Set(
          (wo.packagingRecords || []).flatMap((r) => r.unitNumbers || [])
        );
        const newScannedUnits = validScans
          .map((s) => s.unitNumber)
          .filter((u) => !previouslyPackaged.has(u));

        group.alreadyPackaged = wo.packagedQuantity || 0;
        group.packagingCapacity = newScannedUnits.length;
        group.willPackage = newScannedUnits.length;
      }

      groups.push(group);
    }

    if (!groups.length) {
      return res.status(400).json({ success: false, message: "No packageable units found", invalid });
    }

    return res.json({
      success: true,
      groups,
      invalid,
      totalScanned: parsed.length,
      totalValid: parsed.length - invalid.length,
    });
  } catch (err) {
    console.error("Fetch order error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /done
// ═════════════════════════════════════════════════════════════════════════════
router.post("/done", async (req, res) => {
  try {
    const { groups, notes = "" } = req.body;
    const packagedBy = req.user?.name || req.user?.employeeId || "Packaging Dept";

    if (!Array.isArray(groups) || !groups.length) {
      return res.status(400).json({ success: false, message: "No groups provided" });
    }

    const now = new Date();
    const summary = {
      measurementUpdates: 0,
      bulkUpdates: 0,
      totalUnitsPackaged: 0,
      totalUnitsMarkedComplete: 0,
      workOrdersTouched: 0,
    };

    for (const g of groups) {
      if (!mongoose.Types.ObjectId.isValid(g.workOrderId)) continue;

      // ── MEASUREMENT-TO-PO PATH ───────────────────────────────────────
      if (g.isMeasurement && Array.isArray(g.employees) && g.employees.length) {
        let woUnitsPackagedThisBatch = 0;
        const allUnitsNewlyPackaged = [];
        const empIds = [];
        const empNames = [];

        for (const emp of g.employees) {
          if (!mongoose.Types.ObjectId.isValid(emp.progressDocId)) continue;

          const doc = await EmployeeProductionProgress.findById(emp.progressDocId);
          if (!doc) continue;

          const scannedUnitsForThisEmp = Array.isArray(emp.scannedUnits) ? emp.scannedUnits : [];
          if (!scannedUnitsForThisEmp.length) continue;

          const alreadyPackagedUnits = new Set(
            (doc.packagingHistory || []).flatMap((h) => h.unitNumbers || [])
          );
          const newlyPackagedUnits = scannedUnitsForThisEmp.filter(
            (u) => u >= (doc.unitStart || 0) &&
                   u <= (doc.unitEnd || 0) &&
                   !alreadyPackagedUnits.has(u)
          );
          if (!newlyPackagedUnits.length) continue;

          const currentPackaged = doc.packagedUnits || 0;
          const newPackagedTotal = Math.min(
            (doc.totalUnits || 0),
            currentPackaged + newlyPackagedUnits.length
          );
          const actualPackagingAddition = newPackagedTotal - currentPackaged;
          if (actualPackagingAddition <= 0) continue;

          doc.packagedUnits = newPackagedTotal;
          doc.lastPackagedAt = now;
          doc.isFullyPackaged = newPackagedTotal >= (doc.totalUnits || 0);

          const existingCompletedSet = new Set(doc.completedUnitNumbers || []);
          newlyPackagedUnits.forEach((u) => existingCompletedSet.add(u));
          const mergedCompletedArr = [...existingCompletedSet].sort((a, b) => a - b);
          const newCompletedCount = mergedCompletedArr.length;
          const completionPercentage = doc.totalUnits > 0
            ? Math.min(Math.round((newCompletedCount / doc.totalUnits) * 100), 100)
            : 0;

          doc.completedUnits = newCompletedCount;
          doc.completedUnitNumbers = mergedCompletedArr;
          doc.completionPercentage = completionPercentage;
          doc.lastSyncedAt = now;

          doc.packagingHistory = doc.packagingHistory || [];
          doc.packagingHistory.push({
            packagedQuantity: actualPackagingAddition,
            packagedAt: now,
            packagedBy,
            notes,
            unitNumbers: newlyPackagedUnits,
          });

          await doc.save();

          woUnitsPackagedThisBatch += actualPackagingAddition;
          newlyPackagedUnits.forEach((u) => allUnitsNewlyPackaged.push(u));
          summary.measurementUpdates++;
          summary.totalUnitsPackaged += actualPackagingAddition;
          if (doc.employeeId) empIds.push(doc.employeeId);
          if (doc.employeeName) empNames.push(doc.employeeName);
        }

        if (woUnitsPackagedThisBatch > 0) {
          const { unitsMarkedComplete } = await updateWorkOrderOnPackaging({
            workOrderId: g.workOrderId,
            packagedAdded: woUnitsPackagedThisBatch,
            newlyPackagedUnits: allUnitsNewlyPackaged,
            packagedBy,
            packagingType: "person_wise",
            employeeIds: empIds,
            employeeNames: empNames,
            notes,
            now,
          });
          summary.workOrdersTouched++;
          summary.totalUnitsMarkedComplete += unitsMarkedComplete;
        }
      }

      // ── BULK PATH ────────────────────────────────────────────────────
      else {
        const scannedUnits = Array.isArray(g.scannedUnits) ? g.scannedUnits : [];
        if (!scannedUnits.length) continue;

        const result = await commitBulkPackaging({
          workOrderId: g.workOrderId,
          scannedUnits,
          packagedBy,
          notes,
          now,
        });

        if (result.unitsAdded > 0) {
          summary.bulkUpdates++;
          summary.totalUnitsPackaged += result.unitsAdded;
          summary.totalUnitsMarkedComplete += result.unitsMarkedComplete;
          summary.workOrdersTouched++;
        }
      }
    }

    return res.json({ success: true, message: "Packaging recorded successfully", summary });
  } catch (err) {
    console.error("Packaging done error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /logs
// ═════════════════════════════════════════════════════════════════════════════
router.get("/logs", async (req, res) => {
  try {
    const { from, to, moId, type = "all", page = 1, limit = 50 } = req.query;

    const dateFilter = {};
    if (from) {
      const fromDate = new Date(from);
      fromDate.setHours(0, 0, 0, 0);
      dateFilter.$gte = fromDate;
    }
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999);
      dateFilter.$lte = toDate;
    }

    const woFilter = {};
    if (moId && mongoose.Types.ObjectId.isValid(moId)) {
      woFilter.customerRequestId = new mongoose.Types.ObjectId(moId);
    }

    const workOrders = await WorkOrder.find(woFilter)
      .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity customerRequestId packagingRecords packagedQuantity")
      .lean();

    const moIds = [...new Set(workOrders.map((w) => w.customerRequestId?.toString()).filter(Boolean))];
    const mos = await CustomerRequest.find({ _id: { $in: moIds } })
      .select("requestId customerInfo")
      .lean();
    const moMap = new Map(mos.map((m) => [m._id.toString(), m]));

    const logs = [];
    for (const wo of workOrders) {
      const mo = wo.customerRequestId ? moMap.get(wo.customerRequestId.toString()) : null;
      for (const rec of wo.packagingRecords || []) {
        if (dateFilter.$gte && new Date(rec.packagedAt) < dateFilter.$gte) continue;
        if (dateFilter.$lte && new Date(rec.packagedAt) > dateFilter.$lte) continue;
        if (type !== "all" && rec.packagingType !== type) continue;
        logs.push({
          recordId: rec._id,
          workOrderId: wo._id,
          workOrderNumber: wo.workOrderNumber,
          stockItemName: wo.stockItemName,
          stockItemReference: wo.stockItemReference,
          variantAttributes: wo.variantAttributes || [],
          totalQuantity: wo.quantity,
          packagedQuantity: rec.packagedQuantity,
          packagedAt: rec.packagedAt,
          packagedBy: rec.packagedBy,
          packagingType: rec.packagingType,
          employeeNames: rec.employeeNames || [],
          notes: rec.notes || "",
          moNumber: mo ? `MO-${mo.requestId}` : "—",
          customerName: mo?.customerInfo?.name || "—",
          manufacturingOrderId: wo.customerRequestId,
        });
      }
    }

    logs.sort((a, b) => new Date(b.packagedAt) - new Date(a.packagedAt));

    const totalCount = logs.length;
    const totals = logs.reduce(
      (acc, l) => {
        acc.totalUnits += l.packagedQuantity;
        if (l.packagingType === "person_wise") acc.personWiseCount++;
        else acc.bulkCount++;
        return acc;
      },
      { totalUnits: 0, personWiseCount: 0, bulkCount: 0 }
    );

    const pageNum = Math.max(1, parseInt(page, 10));
    const pageLimit = Math.max(1, parseInt(limit, 10));
    const paged = logs.slice((pageNum - 1) * pageLimit, pageNum * pageLimit);

    return res.json({
      success: true,
      logs: paged,
      totals,
      pagination: {
        page: pageNum,
        limit: pageLimit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / pageLimit),
      },
    });
  } catch (err) {
    console.error("Packaging logs error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;