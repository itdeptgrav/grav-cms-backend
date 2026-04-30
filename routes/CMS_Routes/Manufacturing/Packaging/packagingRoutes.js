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
const EmployeeMpc = require("../../../../models/Customer_Models/Employee_Mpc");

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
// Helper: resolve EmployeeMpc enrichment for a list of employees.
//
// We match on BOTH _id and UIN because:
//   - EmployeeProductionProgress.employeeId may or may not be the EmployeeMpc._id
//     depending on the conversion flow
//   - employeeUIN is a reliable secondary key
//
// Returns Map<lookupKey, { department, designation, aliases }>
// where lookupKey is either the empMpcId.toString() or the UIN string.
// ─────────────────────────────────────────────────────────────────────────────
async function buildMpcEnrichmentMap({ employeeIds = [], uins = [] } = {}) {
  const cleanIds = [...new Set(
    employeeIds
      .filter(Boolean)
      .map((id) => id.toString())
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
  )];
  const cleanUins = [...new Set(uins.filter(Boolean).map((u) => u.toString().toUpperCase()))];

  if (!cleanIds.length && !cleanUins.length) return new Map();

  const orFilter = [];
  if (cleanIds.length) orFilter.push({ _id: { $in: cleanIds } });
  if (cleanUins.length) orFilter.push({ uin: { $in: cleanUins } });

  const docs = await EmployeeMpc.find({ $or: orFilter })
    .select("_id uin name department designation products")
    .lean();

  const map = new Map();
  for (const doc of docs) {
    const aliasMap = new Map();
    for (const p of doc.products || []) {
      if (!p.productName) continue;
      const pid = p.productId?.toString();
      if (!pid) continue;
      const variantKey = p.variantId?.toString() || "default";
      aliasMap.set(`${pid}_${variantKey}`, p.productName);
      // Plain productId fallback (used when variant doesn't match)
      if (!aliasMap.has(pid)) aliasMap.set(pid, p.productName);
    }

    const entry = {
      department: doc.department || "",
      designation: doc.designation || "",
      aliases: aliasMap,
    };

    // Index by both _id AND UIN so the caller can look up either way
    map.set(doc._id.toString(), entry);
    if (doc.uin) map.set(doc.uin.toUpperCase(), entry);
  }
  return map;
}

const lookupMpc = (mpcMap, emp) => {
  if (!emp) return null;
  // Try _id first
  const byId = emp.employeeId ? mpcMap.get(emp.employeeId.toString()) : null;
  if (byId) return byId;
  // Fallback: UIN
  const uin = emp.employeeUIN?.toUpperCase();
  return uin ? mpcMap.get(uin) || null : null;
};

const resolveAlias = (mpcEntry, wo) => {
  if (!mpcEntry || !wo?.stockItemId) return null;
  const productId = wo.stockItemId.toString();
  const variantId = wo.variantAttributes?.[0]?.variantId?.toString();
  if (variantId) {
    const v = mpcEntry.aliases.get(`${productId}_${variantId}`);
    if (v) return v;
  }
  return mpcEntry.aliases.get(`${productId}_default`)
    || mpcEntry.aliases.get(productId)
    || null;
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
// GET /logs-by-mo
// Returns packaging events grouped by MO, then by person (for measurement) or
// by product (for bulk). Used by the overview page.
// Query: from, to, type (all|measurement|bulk), page, limit
// ═════════════════════════════════════════════════════════════════════════════
router.get("/logs-by-mo", async (req, res) => {
  try {
    const { from, to, type = "all", page = 1, limit = 25 } = req.query;

    // Date filter
    const dateRange = {};
    if (from) {
      const f = new Date(from); f.setHours(0, 0, 0, 0);
      dateRange.from = f;
    }
    if (to) {
      const t = new Date(to); t.setHours(23, 59, 59, 999);
      dateRange.to = t;
    }
    const inRange = (d) => {
      if (!d) return false;
      const dt = new Date(d);
      if (dateRange.from && dt < dateRange.from) return false;
      if (dateRange.to && dt > dateRange.to) return false;
      return true;
    };

    // Find all WOs with packagingRecords
    const allWOs = await WorkOrder.find({ "packagingRecords.0": { $exists: true } })
      .select("workOrderNumber stockItemName stockItemReference variantAttributes quantity customerRequestId packagingRecords packagedQuantity")
      .lean();

    // Group by MO
    const moMap = new Map(); // moId -> { wos: [], totalEvents, totalUnits, ... }
    for (const wo of allWOs) {
      const moId = wo.customerRequestId?.toString();
      if (!moId) continue;
      if (!moMap.has(moId)) moMap.set(moId, { wos: [] });
      moMap.get(moId).wos.push(wo);
    }

    // Fetch MO details
    const moIds = [...moMap.keys()];
    const mos = await CustomerRequest.find({ _id: { $in: moIds } })
      .select("requestId customerInfo requestType")
      .lean();
    const moDetailMap = new Map(mos.map((m) => [m._id.toString(), m]));

    // Build per-MO summaries
    const result = [];
    for (const [moId, agg] of moMap) {
      const mo = moDetailMap.get(moId);
      if (!mo) continue;
      const isMeasurement = mo.requestType === "measurement_conversion";

      // Filter by type
      if (type === "measurement" && !isMeasurement) continue;
      if (type === "bulk" && isMeasurement) continue;

      // ── Personwise breakdown (for measurement MOs) ────────────────────────
      // Collect all relevant packagingRecords from all WOs of this MO that
      // are person-wise and within date range. Group by employee.
      let personEvents = [];
      let bulkEvents = [];
      let moTotalUnits = 0;
      let firstAt = null;
      let lastAt = null;

      for (const wo of agg.wos) {
        for (const rec of wo.packagingRecords || []) {
          if (!inRange(rec.packagedAt)) continue;
          moTotalUnits += rec.packagedQuantity || 0;
          const ts = new Date(rec.packagedAt);
          if (!firstAt || ts < firstAt) firstAt = ts;
          if (!lastAt || ts > lastAt) lastAt = ts;

          const woMeta = {
            workOrderId: wo._id,
            workOrderNumber: wo.workOrderNumber,
            stockItemName: wo.stockItemName,
            stockItemReference: wo.stockItemReference,
            variantAttributes: wo.variantAttributes || [],
            totalQuantity: wo.quantity,
          };

          if (rec.packagingType === "person_wise") {
            personEvents.push({
              ...woMeta,
              packagedAt: rec.packagedAt,
              packagedBy: rec.packagedBy,
              packagedQuantity: rec.packagedQuantity,
              unitNumbers: rec.unitNumbers || [],
              employeeIds: rec.employeeIds || [],
              employeeNames: rec.employeeNames || [],
              notes: rec.notes || "",
            });
          } else {
            bulkEvents.push({
              ...woMeta,
              packagedAt: rec.packagedAt,
              packagedBy: rec.packagedBy,
              packagedQuantity: rec.packagedQuantity,
              unitNumbers: rec.unitNumbers || [],
              notes: rec.notes || "",
            });
          }
        }
      }

      if (!personEvents.length && !bulkEvents.length) continue;

      // ── Person-wise: regroup by employee using EmployeeProductionProgress ─
      // Match each unit number back to the employee who owned that unit range
      let personGroups = [];
      if (isMeasurement && personEvents.length) {
        const empProgressDocs = await EmployeeProductionProgress.find({
          manufacturingOrderId: moId,
        })
          .select("employeeId employeeName employeeUIN gender workOrderId unitStart unitEnd packagingHistory")
          .lean();

        const empMap = new Map(); // empId -> { name, UIN, gender, products: [{wo, units, packagedAt[]}] }

        for (const ep of empProgressDocs) {
          const empKey = ep.employeeId?.toString();
          if (!empKey) continue;

          // Filter packagingHistory by date range
          const relevantHistory = (ep.packagingHistory || []).filter((h) =>
            inRange(h.packagedAt)
          );
          if (!relevantHistory.length) continue;

          const wo = agg.wos.find((w) => w._id.toString() === ep.workOrderId.toString());
          if (!wo) continue;

          if (!empMap.has(empKey)) {
            empMap.set(empKey, {
              employeeId: ep.employeeId,
              employeeName: ep.employeeName,
              employeeUIN: ep.employeeUIN,
              gender: ep.gender,
              products: [],
              totalUnits: 0,
              firstAt: null,
              lastAt: null,
            });
          }
          const empRec = empMap.get(empKey);

          // Build product entry — collect all unit numbers + history events
          const allUnits = relevantHistory.flatMap((h) => h.unitNumbers || []);
          const totalQty = relevantHistory.reduce((s, h) => s + (h.packagedQuantity || 0), 0);

          relevantHistory.forEach((h) => {
            const ts = new Date(h.packagedAt);
            if (!empRec.firstAt || ts < empRec.firstAt) empRec.firstAt = ts;
            if (!empRec.lastAt || ts > empRec.lastAt) empRec.lastAt = ts;
          });

          empRec.products.push({
            workOrderId: wo._id,
            workOrderNumber: wo.workOrderNumber,
            productName: wo.stockItemName,
            stockItemReference: wo.stockItemReference,
            variantAttributes: wo.variantAttributes || [],
            unitNumbers: [...new Set(allUnits)].sort((a, b) => a - b),
            totalQuantity: totalQty,
            events: relevantHistory.map((h) => ({
              packagedAt: h.packagedAt,
              packagedBy: h.packagedBy,
              quantity: h.packagedQuantity,
              units: h.unitNumbers || [],
              notes: h.notes || "",
            })),
          });
          empRec.totalUnits += totalQty;
        }

        personGroups = [...empMap.values()].sort((a, b) =>
          (a.employeeName || "").localeCompare(b.employeeName || "")
        );
      }

      // ── Bulk-wise: aggregate by WO ────────────────────────────────────────
      let bulkGroups = [];
      if (bulkEvents.length) {
        const bulkMap = new Map(); // workOrderId -> { wo, totalQty, events: [] }
        for (const ev of bulkEvents) {
          const woKey = ev.workOrderId.toString();
          if (!bulkMap.has(woKey)) {
            bulkMap.set(woKey, {
              workOrderId: ev.workOrderId,
              workOrderNumber: ev.workOrderNumber,
              productName: ev.stockItemName,
              stockItemReference: ev.stockItemReference,
              variantAttributes: ev.variantAttributes,
              totalQuantity: ev.totalQuantity,
              packagedTotal: 0,
              events: [],
            });
          }
          const r = bulkMap.get(woKey);
          r.packagedTotal += ev.packagedQuantity || 0;
          r.events.push({
            packagedAt: ev.packagedAt,
            packagedBy: ev.packagedBy,
            quantity: ev.packagedQuantity,
            units: ev.unitNumbers,
            notes: ev.notes,
          });
        }
        bulkGroups = [...bulkMap.values()].sort((a, b) =>
          (a.productName || "").localeCompare(b.productName || "")
        );
      }

      result.push({
        moId,
        moNumber: `MO-${mo.requestId}`,
        requestId: mo.requestId,
        customerName: mo.customerInfo?.name || "—",
        requestType: mo.requestType,
        isMeasurement,
        firstPackagedAt: firstAt,
        lastPackagedAt: lastAt,
        totalUnitsPackaged: moTotalUnits,
        totalEvents: personEvents.length + bulkEvents.length,
        personGroups,
        bulkGroups,
      });
    }

    // Sort MOs by most recent activity
    result.sort((a, b) => new Date(b.lastPackagedAt) - new Date(a.lastPackagedAt));

    // Paginate
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const paged = result.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    // Totals
    const totals = result.reduce(
      (acc, mo) => {
        acc.totalMOs++;
        acc.totalUnits += mo.totalUnitsPackaged;
        acc.totalEvents += mo.totalEvents;
        if (mo.isMeasurement) acc.measurementMOs++;
        else acc.bulkMOs++;
        return acc;
      },
      { totalMOs: 0, totalUnits: 0, totalEvents: 0, measurementMOs: 0, bulkMOs: 0 }
    );

    return res.json({
      success: true,
      manufacturingOrders: paged,
      totals,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: result.length,
        totalPages: Math.ceil(result.length / limitNum),
      },
    });
  } catch (err) {
    console.error("Logs-by-MO error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

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

        // Resolve MPC enrichment (department/designation/alias)
        const empMpcIds = empDocs.map((e) => e.employeeId);
        const customerId = mo?.customerInfo?.customerId || mo?.customerInfo?._id;
        const mpcMap = await buildMpcEnrichmentMap({
          employeeIds: empDocs.map((e) => e.employeeId),
          uins: empDocs.map((e) => e.employeeUIN),
        });

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

          const mpcEntry = lookupMpc(mpcMap, emp);
          const aliasName = resolveAlias(mpcEntry, wo);

          perEmployee.push({
            progressDocId: emp._id,
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN,
            gender: emp.gender,
            department: mpcEntry?.department || "",
            designation: mpcEntry?.designation || "",
            productName: aliasName || wo.stockItemName, // alias preferred, WO name fallback
            productAliasName: aliasName || null,        // raw alias (for label printing)
            productCanonicalName: wo.stockItemName,     // WO name kept for reference
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
// GET /active-mos
// Lists measurement-conversion MOs that still have unpackaged employee units.
// Used by the UIN-based packaging flow (alternative to barcode scanning).
// ═════════════════════════════════════════════════════════════════════════════
router.get("/active-mos", async (req, res) => {
  try {
    const { search = "" } = req.query;

    const moQuery = {
      requestType: "measurement_conversion",
      status: "quotation_sales_approved",
    };
    if (search) {
      const re = new RegExp(search.trim(), "i");
      moQuery.$or = [
        { "customerInfo.name": re },
        { requestId: re },
        { measurementName: re },
      ];
    }

    const mos = await CustomerRequest.find(moQuery)
      .select("requestId customerInfo measurementName createdAt")
      .sort({ updatedAt: -1 })
      .lean();

    const result = [];
    for (const mo of mos) {
      const docs = await EmployeeProductionProgress.find({
        manufacturingOrderId: mo._id,
        isFullyPackaged: { $ne: true },
      })
        .select("employeeId totalUnits packagedUnits")
        .lean();

      if (!docs.length) continue;

      const totalEmployees = new Set(docs.map((d) => d.employeeId?.toString())).size;
      const remainingUnits = docs.reduce(
        (s, d) => s + Math.max(0, (d.totalUnits || 0) - (d.packagedUnits || 0)),
        0
      );
      if (remainingUnits === 0) continue;

      result.push({
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        requestId: mo.requestId,
        customerName: mo.customerInfo?.name || "—",
        measurementName: mo.measurementName || null,
        totalEmployees,
        remainingUnits,
      });
    }

    return res.json({ success: true, manufacturingOrders: result });
  } catch (err) {
    console.error("Active MOs error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// POST /fetch-by-uins
// Body: { moId, uins: ["UIN1", "UIN2", ...] }
// Returns the same { groups, invalid, ... } shape as /fetch-order, so the
// existing FetchResultView and /done flow work unchanged.
// ═════════════════════════════════════════════════════════════════════════════
router.post("/fetch-by-uins", async (req, res) => {
  try {
    const { moId, uins } = req.body;

    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid MO id" });
    }
    if (!Array.isArray(uins) || !uins.length) {
      return res.status(400).json({ success: false, message: "No UINs provided" });
    }

    const cleanUins = [...new Set(uins.map((u) => (u || "").trim()).filter(Boolean))];
    if (!cleanUins.length) {
      return res.status(400).json({ success: false, message: "No valid UINs" });
    }

    const mo = await CustomerRequest.findById(moId)
      .select("requestId requestType customerInfo")
      .lean();
    if (!mo) return res.status(404).json({ success: false, message: "MO not found" });

    const docs = await EmployeeProductionProgress.find({
      manufacturingOrderId: moId,
      employeeUIN: { $in: cleanUins },
    }).lean();

    const foundUins = new Set(docs.map((d) => d.employeeUIN));
    const invalid = cleanUins
      .filter((u) => !foundUins.has(u))
      .map((u) => ({ barcode: u, reason: "UIN not found in this MO" }));

    if (!docs.length) {
      return res.status(400).json({
        success: false,
        message: "No employees match the provided UINs",
        invalid,
      });
    }

    // Group employee progress docs by workOrderId
    const woGroups = new Map();
    for (const doc of docs) {
      const woKey = doc.workOrderId.toString();
      if (!woGroups.has(woKey)) woGroups.set(woKey, []);
      woGroups.get(woKey).push(doc);
    }

    const woIds = [...woGroups.keys()];
    const wos = await WorkOrder.find({ _id: { $in: woIds } }).lean();
    const woMap = new Map(wos.map((w) => [w._id.toString(), w]));

    // Resolve MPC enrichment for ALL employees once (shared across WOs)
    const allEmpIds = docs.map((d) => d.employeeId);
    const customerId = mo?.customerInfo?.customerId || mo?.customerInfo?._id;
    const mpcMap = await buildMpcEnrichmentMap({
      employeeIds: docs.map((d) => d.employeeId),
      uins: docs.map((d) => d.employeeUIN),
    });

    const groups = [];
    const fullyPackagedEmployees = [];

    for (const [woKey, empDocs] of woGroups) {
      const wo = woMap.get(woKey);
      if (!wo) continue;

      const perEmployee = [];
      for (const emp of empDocs) {
        const alreadyPackagedUnits = new Set(
          (emp.packagingHistory || []).flatMap((h) => h.unitNumbers || [])
        );
        const unpackagedUnits = [];
        for (let u = emp.unitStart; u <= emp.unitEnd; u++) {
          if (!alreadyPackagedUnits.has(u)) unpackagedUnits.push(u);
        }
        if (!unpackagedUnits.length) {
          fullyPackagedEmployees.push({
            barcode: `${emp.employeeUIN} → ${wo.stockItemName}`,
            reason: "Already fully packaged",
          });
          continue;
        }

        const mpcEntry = lookupMpc(mpcMap, emp);
        const aliasName = resolveAlias(mpcEntry, wo);

        perEmployee.push({
          progressDocId: emp._id,
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          employeeUIN: emp.employeeUIN,
          gender: emp.gender,
          department: mpcEntry?.department || "",
          designation: mpcEntry?.designation || "",
          productName: aliasName || wo.stockItemName,
          productAliasName: aliasName || null,
          productCanonicalName: wo.stockItemName,
          unitStart: emp.unitStart,
          unitEnd: emp.unitEnd,
          totalUnits: emp.totalUnits,
          completedUnits: emp.completedUnits || 0,
          alreadyPackaged: emp.packagedUnits || 0,
          scannedUnits: unpackagedUnits,
          scannedCount: unpackagedUnits.length,
          packagingCapacity: unpackagedUnits.length,
          willPackage: unpackagedUnits.length,
        });
      }

      if (!perEmployee.length) continue;

      groups.push({
        workOrderId: wo._id,
        workOrderShortId: wo._id.toString().slice(-8),
        workOrderNumber: wo.workOrderNumber,
        stockItemName: wo.stockItemName,
        stockItemReference: wo.stockItemReference,
        variantAttributes: wo.variantAttributes || [],
        quantity: wo.quantity,
        moInfo: {
          _id: mo._id,
          moNumber: `MO-${mo.requestId}`,
          customerName: mo.customerInfo?.name || "",
          requestType: mo.requestType,
        },
        isMeasurement: true,
        scannedUnits: perEmployee.flatMap((e) => e.scannedUnits).sort((a, b) => a - b),
        scannedCount: perEmployee.reduce((s, e) => s + e.scannedCount, 0),
        employees: perEmployee,
      });
    }

    if (!groups.length) {
      return res.status(400).json({
        success: false,
        message: "All matched employees are already fully packaged",
        invalid: [...invalid, ...fullyPackagedEmployees],
      });
    }

    const totalValid = groups.reduce((s, g) => s + g.scannedCount, 0);

    return res.json({
      success: true,
      groups,
      invalid: [...invalid, ...fullyPackagedEmployees],
      totalScanned: totalValid,
      totalValid,
    });
  } catch (err) {
    console.error("Fetch by UINs error:", err);
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