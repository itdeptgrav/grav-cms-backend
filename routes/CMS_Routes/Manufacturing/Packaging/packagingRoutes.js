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
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const PackingCarton = require("../../../../models/CMS_Models/Manufacturing/Packaging/PackingCarton");
const { nextCartonNumber, normaliseCartonNumber } = require("../../../../services/packingCartonRef");
const { displayWorkOrderNumber } = require("../../../../services/manufacturing/workOrderNumber");
const { resolvePhotos, resolveVariantAttributes, variantText } = require("../../../../services/manufacturing/workOrderPhoto");
const { buildStageReport, reportWindow, compactRanges } = require("../../../../services/manufacturing/stageReport");
const access = require("./packagingAccess");


router.use(EmployeeAuthMiddleware);

/* ── WHO, AND WHOSE WORK ─────────────────────────────────────────────────────
   Reads are for Packaging and the two departments whose own screens already
   show these numbers (Production planning, the executive office). RECORDING
   packing is Packaging's editor alone — watching the floor is not being on it.

   Every query below is narrowed to the acting company through
   `WorkOrder.salesLineLink.companyId`, the link the Sales-line ↔ WorkOrder
   bridge stamps at creation. A WorkOrder with no link belongs to nobody: it is
   in no list and unaddressable by id, and is never given a company from its
   order, buyer, style, product, barcode text or the last characters of its id. */
const canRead = [access.packagingReader(), access.packagingCompany];
const canRecord = [access.packagingDepartment("editor"), access.packagingCompany];

/** The acting company, resolved server-side. Never from the client. */
const companyOf = (req) => req.packaging.companyId;

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
// Record packed units on a work order that is already loaded (in a session).
//
// Pushes ONE packagingRecords entry naming the carton, moves packagedQuantity
// (capped at the order's quantity), and marks the units complete. The caller
// has already removed units that any earlier record holds, so a unit is never
// recorded twice. Returns how many units became newly complete overall.
// ─────────────────────────────────────────────────────────────────────────────
function recordOnWorkOrder(wo, {
  units, packagingType, packagedBy, notes, now,
  employeeIds = [], employeeNames = [], carton = null,
}) {
  wo.packagedQuantity = Math.min(wo.quantity || 0, (wo.packagedQuantity || 0) + units.length);
  wo.packagingRecords = wo.packagingRecords || [];
  wo.packagingRecords.push({
    packagedQuantity: units.length,
    packagedAt: now,
    packagedBy,
    packagingType,
    employeeIds,
    employeeNames,
    notes,
    unitNumbers: units,
    ...(carton ? { cartonId: carton.cartonId, cartonNumber: carton.cartonNumber, packedByUserId: carton.packedByUserId } : {}),
  });
  const before = wo.productionCompletion?.overallCompletedQuantity || 0;
  markUnitsAsFullyCompleted(wo, units, now);
  return (wo.productionCompletion?.overallCompletedQuantity || 0) - before;
}

/** What a carton line records about the work order it came from. */
function cartonLineBase(wo) {
  return {
    workOrderId: wo._id,
    workOrderNumber: displayWorkOrderNumber(wo),
    workOrderShortId: String(wo._id).slice(-8),
    stockItemId: wo.stockItemId || null,
    productName: wo.stockItemName || "",
    productReference: wo.stockItemReference || "",
    variantId: wo.variantId || "",
    variantAttributes: wo.variantAttributes || [],
  };
}

router.get("/logs-by-mo", ...canRead, async (req, res) => {
  try {
    const { from, to, type = "all", page = 1, limit = 25 } = req.query;

    // Date filter
    /* A date filter names an IST calendar day. The host runs on UTC, so
       `new Date("2026-09-24").setHours(…)` meant 05:30 IST today to 05:29 IST
       tomorrow — invisible while the filters started empty, wrong the moment
       every screen opens on today (24 Sep 2026). shiftHours.istDayWindow is the
       one definition of an IST day. */
    const DAY = /^\d{4}-\d{2}-\d{2}$/;
    const dateRange = {};
    if (DAY.test(String(from || ""))) dateRange.from = shift.istDayWindow(from).start;
    if (DAY.test(String(to || ""))) dateRange.to = new Date(shift.istDayWindow(to).end.getTime() - 1);
    const inRange = (d) => {
      if (!d) return false;
      const dt = new Date(d);
      if (dateRange.from && dt < dateRange.from) return false;
      if (dateRange.to && dt > dateRange.to) return false;
      return true;
    };

    // Find all WOs with packagingRecords
    const allWOs = await access.findWorkOrders(companyOf(req), { "packagingRecords.0": { $exists: true } },
      "workOrderNumber stockItemName stockItemReference variantAttributes quantity customerRequestId packagingRecords packagedQuantity").lean();

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
router.post("/fetch-order", ...canRead, async (req, res) => {
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

    /* Only this company's work orders are candidates, and a short id two of
       them share resolves to neither: the last 8 characters of an id are not
       unique and are not proof of whose work this is. */
    const workOrderShortIds = [...byWO.keys()];
    const allWOs = await access.findWorkOrders(companyOf(req), {}).lean();
    const byShortId = new Map();
    for (const wo of allWOs) {
      const shortId = wo._id.toString().slice(-8);
      if (byShortId.has(shortId)) byShortId.set(shortId, null);
      else byShortId.set(shortId, wo);
    }
    const woMap = new Map();
    for (const shortId of workOrderShortIds) {
      const wo = byShortId.get(shortId);
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
        workOrderNumber: displayWorkOrderNumber(wo),
        stockItemId: wo.stockItemId || null,
        variantId: wo.variantId || "",
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

    /* Same read-time variant as the carton (see describeCartonLines), so the
       packer sees "Size: M" while scanning, not only on the printed label. */
    const [photos, variants] = await Promise.all([resolvePhotos(groups), resolveVariantAttributes(groups)]);
    groups.forEach((g, i) => {
      g.productImage = photos[i];
      const text = variantText({ attributes: variants[i]?.attributes });
      g.variantText = text === "Not specified" ? "" : text;
    });

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
// POST /done — SEAL A CARTON, OR ADD PIECES TO ONE
// ═════════════════════════════════════════════════════════════════════════════
/* ── PACKING IS CARTON-WISE (24 Sep 2026) ────────────────────────────────────
 * One call = one packing session into ONE physical box. With no
 * `cartonNumber` in the body a new carton is opened and numbered; with one,
 * the pieces go into that existing carton (five today, three more tomorrow).
 * Every legacy record this route already wrote (packagingRecords on the work
 * order, packagingHistory on the person's progress) carries the carton's id,
 * so the quantity screens keep working and the box is one hop away.
 *
 * Refusals, all BEFORE anything is written:
 *   · pieces from two orders in one request, or pieces of another order into
 *     an existing carton — a label names ONE PO;
 *   · a carton that has already been dispatched — it has left the building;
 *   · nothing NEW — every scanned piece is already in a carton.
 *
 * ── ONE TRANSACTION ─────────────────────────────────────────────────────────
 * This used to write the work orders first and the carton last. When the
 * carton insert failed, the pieces stayed recorded as packed against a carton
 * that did not exist, with no way to tell which. Now every write — progress
 * documents, work orders, the carton — commits together or not at all. The
 * transaction callback re-reads everything it writes, so MongoDB can retry it
 * after a write conflict (two people topping up one carton at once) without
 * counting a piece twice.
 *
 * ── WHY IT USED TO SAY "Server error" ───────────────────────────────────────
 * The Atlas cluster is at its 500-collection cap, and the carton book's
 * collection did not exist yet. MongoDB refused to create it and the seal died
 * with a bare 500. The collection is now created up front, before anything is
 * written, and that refusal is reported in words (503, DB_COLLECTION_LIMIT).
 *
 * Who packed it is the signed-in user, from the session — never the body. */

class PackingRefusal extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const isCollectionCap = (e) =>
  /cannot create a new collection|already using \d+ collections/i.test(String(e?.message || ""));

const COLLECTION_CAP_MESSAGE =
  "The database has reached its limit of 500 collections, so the carton book cannot be created. " +
  "Nothing was packed. An administrator needs to free space in the database before cartons can be sealed.";

/* The carton book's collection exists before any transaction touches it:
   creating a collection inside a transaction is version-dependent, and this
   is also where a full cluster refuses — before a single piece is written. */
let cartonCollectionReady = false;
async function ensureCartonCollection() {
  if (cartonCollectionReady) return;
  try {
    await PackingCarton.createCollection();
  } catch (e) {
    if (e?.codeName !== "NamespaceExists" && e?.code !== 48) throw e;
  }
  await PackingCarton.init().catch(() => {}); // indexes; a failure here must not block packing
  cartonCollectionReady = true;
}

/** Merge this session's lines into the carton's current contents: one line
 *  per work order, or per person on a measurement order. */
function mergeCartonLines(existing, incoming) {
  for (const l of incoming) {
    const key = `${l.workOrderId}|${l.employee?.progressDocId || ""}`;
    const hit = existing.find((e) => `${e.workOrderId}|${e.employee?.progressDocId || ""}` === key);
    if (hit) {
      const units = [...new Set([...(hit.unitNumbers || []), ...l.unitNumbers])].sort((a, b) => a - b);
      hit.unitNumbers = units;
      hit.quantity = units.length;
    } else {
      existing.push(l);
    }
  }
  return existing;
}

/**
 * Everything the seal writes, inside the transaction. Re-reads what it writes
 * so a retried attempt starts from the committed state, not from its own
 * half-finished first try.
 */
async function applyPackingSession({
  session, companyId, groups, notes, packagedBy, packedBy, now,
  cartonId, cartonNumber, appendTo, mo,
}) {
  const cartonRef = { cartonId, cartonNumber, packedByUserId: packedBy.userId };
  const lines = [];
  const summary = { measurementUpdates: 0, bulkUpdates: 0, totalUnitsPackaged: 0, totalUnitsMarkedComplete: 0, workOrdersTouched: 0 };

  for (const g of groups) {
    const wo = await WorkOrder.findOne(access.scoped(companyId, { _id: access.oid(g.workOrderId) })).session(session);
    if (!wo) continue; // proved before the transaction; gone since means nothing to do
    const alreadyOnWo = new Set((wo.packagingRecords || []).flatMap((r) => r.unitNumbers || []));
    const base = cartonLineBase(wo);

    if (g.isMeasurement && Array.isArray(g.employees) && g.employees.length) {
      const woUnits = [];
      const empIds = [];
      const empNames = [];
      for (const emp of g.employees) {
        const scanned = Array.isArray(emp.scannedUnits) ? emp.scannedUnits.map(Number) : [];
        if (!scanned.length) continue;
        const doc = await EmployeeProductionProgress.findById(access.oid(emp.progressDocId)).session(session);
        if (!doc || String(doc.workOrderId) !== String(wo._id)) continue;

        const inHistory = new Set((doc.packagingHistory || []).flatMap((h) => h.unitNumbers || []));
        const fresh = [...new Set(scanned)].filter((u) =>
          u >= (doc.unitStart || 0) && u <= (doc.unitEnd || 0) && !inHistory.has(u) && !alreadyOnWo.has(u))
          .sort((a, b) => a - b);
        if (!fresh.length) continue;

        doc.packagedUnits = Math.min(doc.totalUnits || 0, (doc.packagedUnits || 0) + fresh.length);
        doc.lastPackagedAt = now;
        doc.isFullyPackaged = doc.packagedUnits >= (doc.totalUnits || 0);
        const completed = new Set(doc.completedUnitNumbers || []);
        fresh.forEach((u) => completed.add(u));
        doc.completedUnitNumbers = [...completed].sort((a, b) => a - b);
        doc.completedUnits = doc.completedUnitNumbers.length;
        doc.completionPercentage = doc.totalUnits > 0
          ? Math.min(Math.round((doc.completedUnits / doc.totalUnits) * 100), 100) : 0;
        doc.lastSyncedAt = now;
        doc.packagingHistory = doc.packagingHistory || [];
        doc.packagingHistory.push({ packagedQuantity: fresh.length, packagedAt: now, packagedBy, notes, unitNumbers: fresh });
        await doc.save({ session });

        fresh.forEach((u) => { woUnits.push(u); alreadyOnWo.add(u); });
        if (doc.employeeId) empIds.push(doc.employeeId);
        if (doc.employeeName) empNames.push(doc.employeeName);
        summary.measurementUpdates++;
        lines.push({
          ...base,
          packagingType: "person_wise",
          employee: {
            progressDocId: doc._id,
            /* Only when it is an id: on some progress documents this field is
               a UIN string, and casting one into the ref fails the seal. */
            employeeId: access.isId(doc.employeeId) ? doc.employeeId : null,
            employeeName: doc.employeeName || "",
            employeeUIN: doc.employeeUIN || "",
          },
          unitNumbers: fresh,
          quantity: fresh.length,
        });
      }
      if (woUnits.length) {
        summary.totalUnitsMarkedComplete += recordOnWorkOrder(wo, {
          units: woUnits, packagingType: "person_wise", packagedBy, notes, now,
          employeeIds: empIds.filter(access.isId), employeeNames: empNames, carton: cartonRef,
        });
        await wo.save({ session });
        summary.totalUnitsPackaged += woUnits.length;
        summary.workOrdersTouched++;
      }
    } else if (!g.isMeasurement) {
      const scanned = Array.isArray(g.scannedUnits) ? g.scannedUnits.map(Number) : [];
      const fresh = [...new Set(scanned)]
        .filter((u) => u > 0 && u <= (wo.quantity || 0) && !alreadyOnWo.has(u))
        .sort((a, b) => a - b);
      if (!fresh.length) continue;
      summary.totalUnitsMarkedComplete += recordOnWorkOrder(wo, {
        units: fresh, packagingType: "bulk", packagedBy, notes, now, carton: cartonRef,
      });
      await wo.save({ session });
      summary.bulkUpdates++;
      summary.totalUnitsPackaged += fresh.length;
      summary.workOrdersTouched++;
      lines.push({ ...base, packagingType: "bulk", unitNumbers: fresh, quantity: fresh.length });
    }
  }

  if (!lines.length) return { nothingNew: true, summary };

  const added = lines.reduce((n, l) => n + l.quantity, 0);
  const addition = {
    at: now,
    packedBy,
    quantity: added,
    notes: access.str(notes),
    items: lines.map((l) => ({
      workOrderId: l.workOrderId,
      progressDocId: l.employee?.progressDocId || null,
      unitNumbers: l.unitNumbers,
    })),
  };

  let carton;
  if (appendTo) {
    carton = await PackingCarton.findOne({ _id: cartonId, companyId }).session(session);
    if (!carton) throw new PackingRefusal(404, "CARTON_NOT_FOUND", `Carton ${cartonNumber} was not found.`);
    if (carton.status !== "packed") {
      throw new PackingRefusal(409, "CARTON_DISPATCHED", `Carton ${cartonNumber} has already been dispatched — it cannot take more pieces.`);
    }
    mergeCartonLines(carton.lines, lines);
    carton.additions.push(addition);
    carton.lastPackedAt = now;
    if (addition.notes) carton.notes = carton.notes ? `${carton.notes} · ${addition.notes}` : addition.notes;
  } else {
    carton = new PackingCarton({
      _id: cartonId,
      cartonNumber,
      companyId,
      manufacturingOrderId: mo?._id || null,
      moNumber: mo ? `MO-${mo.requestId}` : "",
      poNumber: mo?.poProof?.poNumber || "",
      customerName: mo?.customerInfo?.name || "",
      requestType: mo?.requestType || "",
      lines,
      packedBy,
      packedAt: now,
      lastPackedAt: now,
      notes: addition.notes,
      additions: [addition],
    });
  }
  carton.totalQuantity = carton.lines.reduce((n, l) => n + (l.quantity || 0), 0);
  carton.workOrderCount = new Set(carton.lines.map((l) => String(l.workOrderId))).size;
  await carton.save({ session });

  return { carton, added, summary, appended: Boolean(appendTo) };
}

router.post("/done", ...canRecord, async (req, res) => {
  try {
    const { groups, notes = "" } = req.body;
    const appendTo = access.str(req.body?.cartonNumber) ? normaliseCartonNumber(req.body.cartonNumber) : "";
    const packagedBy = req.user?.name || req.user?.employeeId || "Packaging Dept";
    const packedBy = {
      userId: access.str(req.user?.id),
      name: access.str(req.user?.name),
      employeeId: access.str(req.user?.employeeId),
      email: access.str(req.user?.email).toLowerCase(),
      role: access.str(req.user?.role),
    };

    if (!Array.isArray(groups) || !groups.length) {
      return res.status(400).json({ success: false, message: "No groups provided" });
    }

    /* ── PROVED WHOLE, BEFORE ANYTHING IS WRITTEN ──────────────────────
       Every work order and every progress document this request names is
       proved to be this company's FIRST, and one that is another company's,
       unlinked-and-foreign, unknown or malformed refuses the whole batch. */
    const askedWorkOrders = groups.map((g) => access.str(g?.workOrderId));
    const provenWorkOrders = askedWorkOrders.filter(access.isId).length
      ? await access.findWorkOrders(companyOf(req),
        { _id: { $in: askedWorkOrders.filter(access.isId).map(access.oid) } }, "_id customerRequestId").lean()
      : [];
    const ownWorkOrderIds = new Set(provenWorkOrders.map((w) => String(w._id)));
    if (askedWorkOrders.some((id) => !ownWorkOrderIds.has(id))) {
      return access.notFound(res, "work order");
    }

    /* Each named progress document must belong to a work order of this
       company too — and to the work order its own group names, so a batch
       cannot quietly attribute one person's units to another order. */
    const askedProgress = groups.flatMap((g) => (Array.isArray(g?.employees) ? g.employees : [])
      .map((e) => access.str(e?.progressDocId)));
    const progress = await access.resolveProgressDocs(companyOf(req), askedProgress);
    if (progress.unproven.length) return access.notFound(res, "packable work");
    for (const g of groups) {
      for (const emp of (Array.isArray(g?.employees) ? g.employees : [])) {
        const doc = progress.byId.get(access.str(emp?.progressDocId));
        if (!doc || String(doc.workOrderId) !== access.str(g?.workOrderId)) {
          return access.notFound(res, "packable work");
        }
      }
    }

    /* ── ONE CARTON, ONE ORDER ─────────────────────────────────────────── */
    const orderKeys = new Set(provenWorkOrders.map((w) => String(w.customerRequestId || "")));
    if (orderKeys.size > 1) {
      return res.status(400).json({
        success: false,
        code: "MIXED_ORDERS",
        message: `A carton holds one order. The scanned pieces belong to ${orderKeys.size} different orders — pack them as separate cartons.`,
      });
    }
    const orderId = [...orderKeys][0] || "";
    const mo = orderId && access.isId(orderId)
      ? await CustomerRequest.findById(orderId).select("requestId requestType customerInfo.name poProof.poNumber").lean()
      : null;

    await ensureCartonCollection();

    /* ── AN EXISTING CARTON: it must be this company's, still on the floor,
       and holding the same order. Checked here so the person hears why
       before anything is written; re-checked inside the transaction in case
       it was dispatched in between. */
    let cartonId;
    let cartonNumber;
    if (appendTo) {
      const target = await PackingCarton.findOne({ companyId: companyOf(req), cartonNumber: appendTo })
        .select("_id cartonNumber status manufacturingOrderId moNumber customerName").lean();
      if (!target) {
        return res.status(404).json({ success: false, code: "CARTON_NOT_FOUND", message: `Carton ${appendTo} was not found.` });
      }
      if (target.status !== "packed") {
        return res.status(409).json({ success: false, code: "CARTON_DISPATCHED",
          message: `Carton ${appendTo} has already been dispatched — it cannot take more pieces.` });
      }
      if (String(target.manufacturingOrderId || "") !== orderId) {
        /* Customer names are part of the message on purpose: three order
           numbers are shared by two different orders each (services/requestId.js),
           so "holds MO-REQ-2026-0003; these belong to MO-REQ-2026-0003" is a
           true refusal that reads like a bug without them. */
        const cartonSide = [target.moNumber, target.customerName].filter(Boolean).join(" · ") || "a different order";
        const pieceSide = mo ? [`MO-${mo.requestId}`, mo.customerInfo?.name].filter(Boolean).join(" · ") : "another order";
        return res.status(400).json({ success: false, code: "CARTON_OTHER_ORDER",
          message: `Carton ${appendTo} holds ${cartonSide}; these pieces belong to ${pieceSide}. A carton holds one order.` });
      }
      cartonId = target._id;
      cartonNumber = target.cartonNumber;
    } else {
      cartonId = new mongoose.Types.ObjectId();
      cartonNumber = await nextCartonNumber();
    }

    const now = new Date();
    const session = await mongoose.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        result = await applyPackingSession({
          session, companyId: companyOf(req), groups, notes, packagedBy, packedBy, now,
          cartonId, cartonNumber, appendTo, mo,
        });
      });
    } finally {
      await session.endSession();
    }

    if (result?.nothingNew) {
      return res.status(400).json({
        success: false,
        code: "NOTHING_NEW",
        message: "Nothing new to pack — every scanned piece is already in a carton.",
        summary: result.summary,
      });
    }

    const c = result.carton;
    return res.json({
      success: true,
      message: result.appended
        ? `${result.added} piece${result.added !== 1 ? "s" : ""} added to carton ${c.cartonNumber} — it now holds ${c.totalQuantity}`
        : `Carton ${c.cartonNumber} sealed — ${c.totalQuantity} piece${c.totalQuantity !== 1 ? "s" : ""}`,
      summary: result.summary,
      appended: result.appended,
      added: result.added,
      carton: {
        _id: c._id,
        cartonNumber: c.cartonNumber,
        totalQuantity: c.totalQuantity,
        workOrderCount: c.workOrderCount,
        moNumber: c.moNumber,
        poNumber: c.poNumber,
        customerName: c.customerName,
        packedAt: c.packedAt,
        packedBy: c.packedBy,
        sessions: (c.additions || []).length,
      },
    });
  } catch (err) {
    if (err instanceof PackingRefusal) {
      return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    }
    if (isCollectionCap(err)) {
      console.error("Packaging done refused — collection cap:", err.message);
      return res.status(503).json({ success: false, code: "DB_COLLECTION_LIMIT", message: COLLECTION_CAP_MESSAGE });
    }
    console.error("Packaging done error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CARTONS — the book of boxes
// ═════════════════════════════════════════════════════════════════════════════

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// GET /cartons?q=&from=&to=&page=&limit=
// Newest first. `q` matches carton number, PO, order, customer, work order,
// product or person. Unit-number arrays are left out of the list — they are
// the bulk of every document and a list never needs them.
router.get("/cartons", ...canRead, async (req, res) => {
  try {
    const { q = "", from, to, weight = "all" } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

    const filter = { companyId: companyOf(req) };
    const needle = access.str(q);
    if (needle) {
      const rx = new RegExp(escapeRegex(needle), "i");
      filter.$or = [
        { cartonNumber: rx }, { poNumber: rx }, { moNumber: rx }, { customerName: rx },
        { "lines.workOrderNumber": rx }, { "lines.workOrderShortId": rx },
        { "lines.productName": rx }, { "lines.employee.employeeName": rx },
        { "packedBy.name": rx },
      ];
    }
    if (from || to) {
      /* IST calendar days — see the note on /logs-by-mo. */
      const DAY = /^\d{4}-\d{2}-\d{2}$/;
      filter.packedAt = {};
      if (DAY.test(String(from || ""))) filter.packedAt.$gte = shift.istDayWindow(from).start;
      if (DAY.test(String(to || ""))) filter.packedAt.$lt = shift.istDayWindow(to).end;
      if (!Object.keys(filter.packedAt).length) delete filter.packedAt;
    }

    /* Weighed / not weighed. The counts are for the same search and dates
       WITHOUT the weight filter, so the two tabs always add up to the total. */
    const baseFilter = { ...filter };
    if (weight === "pending") filter.weightKg = null;
    else if (weight === "done") filter.weightKg = { $ne: null };

    const [total, cartons, weighedCount, allCount] = await Promise.all([
      PackingCarton.countDocuments(filter),
      PackingCarton.find(filter)
        .select("-lines.unitNumbers -weightHistory")
        .sort({ packedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      PackingCarton.countDocuments({ ...baseFilter, weightKg: { $ne: null } }),
      PackingCarton.countDocuments(baseFilter),
    ]);

    return res.json({
      success: true,
      cartons: cartons.map(withWeightState),
      weightSummary: { weighed: weighedCount, pending: allCount - weighedCount, total: allCount },
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  } catch (err) {
    console.error("Cartons list error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

/* What a carton line shows, resolved at read time and never stored:
     productImage   — variant image first, see services/manufacturing/workOrderPhoto.js
     variantText    — the line's own attributes, else the variant its id names,
                      else the product's ONLY variant (a product with one
                      variant can only be that one — the PPC walkthrough polo's
                      work order carries none, its product has exactly Size M).
                      "" when it is honestly unknown. */
async function describeCartonLines(lines) {
  const [photos, variants] = await Promise.all([resolvePhotos(lines), resolveVariantAttributes(lines)]);
  return lines.map((l, i) => {
    const text = variantText({ attributes: variants[i]?.attributes });
    return {
      ...l,
      productImage: photos[i],
      variantText: text === "Not specified" ? "" : text,
      variantInferred: Boolean(variants[i]?.inferred),
    };
  });
}

/* A weight recorded before the carton's last packing session no longer
   describes the box — pieces went in after it was on the scale. */
function withWeightState(c) {
  const last = c.lastPackedAt || c.packedAt;
  const needsReweigh = c.weightKg != null && c.weighedAt && last && new Date(c.weighedAt) < new Date(last);
  return { ...c, needsReweigh: Boolean(needsReweigh) };
}

const MAX_CARTON_KG = 500;

// PUT /cartons/:cartonNumber/weight   { weightKg }
// Record (or correct) a carton's gross weight. Who and when come from the
// session; a correction keeps the previous value in weightHistory. A carton
// that has been dispatched may be weighed if it never was, but its recorded
// weight is not changed after it left.
router.put("/cartons/:cartonNumber/weight", ...canRecord, async (req, res) => {
  try {
    const cartonNumber = normaliseCartonNumber(req.params.cartonNumber);
    const raw = req.body?.weightKg;
    const kg = typeof raw === "string" ? Number(raw.trim()) : Number(raw);
    if (raw === "" || raw == null || !Number.isFinite(kg) || kg <= 0) {
      return res.status(400).json({ success: false, message: "Enter the carton's weight in kg — a number above 0." });
    }
    if (kg > MAX_CARTON_KG) {
      return res.status(400).json({ success: false, message: `${kg} kg is more than a carton can weigh (limit ${MAX_CARTON_KG} kg). Check the scale reading.` });
    }
    const weightKg = Math.round(kg * 1000) / 1000;

    const carton = await PackingCarton.findOne({ companyId: companyOf(req), cartonNumber });
    if (!carton) return res.status(404).json({ success: false, message: `Carton ${cartonNumber} was not found.` });
    if (carton.status === "dispatched" && carton.weightKg != null) {
      return res.status(409).json({ success: false, code: "CARTON_DISPATCHED", message: `Carton ${cartonNumber} has been dispatched; its recorded weight (${carton.weightKg} kg) can no longer be changed.` });
    }

    const by = {
      userId: access.str(req.user?.id),
      name: access.str(req.user?.name) || access.str(req.user?.employeeId) || "Packaging Dept",
      employeeId: access.str(req.user?.employeeId),
      email: access.str(req.user?.email).toLowerCase(),
      role: access.str(req.user?.role),
    };
    const now = new Date();
    const previous = carton.weightKg;
    if (previous != null) carton.weightHistory.push({ weightKg: previous, at: carton.weighedAt || now, by: carton.weighedBy || {} });
    carton.weightKg = weightKg;
    carton.weighedAt = now;
    carton.weighedBy = by;
    await carton.save();

    return res.json({
      success: true,
      message: previous != null && previous !== weightKg
        ? `Carton ${cartonNumber}: weight corrected from ${previous} kg to ${weightKg} kg.`
        : `Carton ${cartonNumber}: ${weightKg} kg recorded.`,
      carton: withWeightState({
        cartonNumber: carton.cartonNumber, weightKg: carton.weightKg, weighedAt: carton.weighedAt, weighedBy: carton.weighedBy,
        weightHistory: carton.weightHistory, lastPackedAt: carton.lastPackedAt, packedAt: carton.packedAt,
      }),
    });
  } catch (err) {
    console.error("Carton weight error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// GET /cartons/:cartonNumber — one carton, complete. What the QR code opens.
router.get("/cartons/:cartonNumber", ...canRead, async (req, res) => {
  try {
    const cartonNumber = normaliseCartonNumber(req.params.cartonNumber);
    const carton = await PackingCarton.findOne({ companyId: companyOf(req), cartonNumber }).lean();
    if (!carton) {
      return res.status(404).json({ success: false, message: `Carton ${cartonNumber} was not found.` });
    }
    /* The PO is read from the order NOW, not only from the copy taken when the
       carton was opened: Sales records it (poProof.poNumber) when the customer's
       PO is uploaded, which can be after packing began — a reprinted label then
       carries it. The stored copy stands if the order has none. */
    const [lines, order] = await Promise.all([
      describeCartonLines(carton.lines || []),
      carton.manufacturingOrderId && access.isId(String(carton.manufacturingOrderId))
        ? CustomerRequest.findById(carton.manufacturingOrderId).select("poProof.poNumber").lean().catch(() => null)
        : null,
    ]);
    carton.lines = lines;
    carton.poNumber = String(order?.poProof?.poNumber || "").trim() || carton.poNumber || "";
    return res.json({ success: true, carton: withWeightState(carton) });
  } catch (err) {
    console.error("Carton read error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /find-piece?barcode=WO-<short id>-<unit>
// ═════════════════════════════════════════════════════════════════════════════
/* One garment's standing in packing: is it packed, in which carton, by whom,
   when, and has that carton left. The barcode is resolved to a work order the
   same way /fetch-order does it — among THIS company's work orders only, and
   an ambiguous short id is refused rather than guessed.

   A unit that is in a legacy packagingRecord but in no carton is reported as
   packed WITH `legacyRecord` and no carton: that is the truth for anything
   packed before 24 Sep 2026, and inventing a carton for it would be worse. */
router.get("/find-piece", ...canRead, async (req, res) => {
  try {
    const barcode = access.str(req.query.barcode);
    if (!barcode) {
      return res.status(400).json({ success: false, message: "barcode is required" });
    }
    const parsed = parseBarcode(barcode);
    if (!parsed.success || isNaN(parsed.unitNumber)) {
      return res.json({ success: true, recognised: false, barcode,
        reason: "Not a piece barcode — expected WO-<short id>-<unit>." });
    }

    const allWOs = await access.findWorkOrders(companyOf(req), {},
      "_id workOrderNumber stockItemName stockItemReference variantAttributes quantity packagedQuantity packagingRecords customerRequestId")
      .lean();
    const byShortId = new Map();
    for (const wo of allWOs) {
      const sid = String(wo._id).slice(-8);
      byShortId.set(sid, byShortId.has(sid) ? null : wo);
    }
    const wo = byShortId.get(parsed.workOrderShortId);
    if (wo === null) {
      return res.json({ success: true, recognised: false, barcode,
        reason: `Two work orders share the id ${parsed.workOrderShortId} — this barcode cannot be resolved.` });
    }
    if (!wo) {
      return res.json({ success: true, recognised: false, barcode,
        reason: `No work order of this company matches ${parsed.workOrderShortId}.` });
    }
    const unit = parsed.unitNumber;
    if (unit <= 0 || unit > (wo.quantity || 0)) {
      return res.json({ success: true, recognised: false, barcode,
        reason: `Unit ${unit} is outside this work order (1–${wo.quantity || 0}).` });
    }

    const [mo, carton] = await Promise.all([
      wo.customerRequestId
        ? CustomerRequest.findById(wo.customerRequestId).select("requestId customerInfo.name").lean()
        : null,
      PackingCarton.findOne({
        companyId: companyOf(req),
        lines: { $elemMatch: { workOrderId: wo._id, unitNumbers: unit } },
      }).lean(),
    ]);

    const line = carton
      ? (carton.lines || []).find((l) => String(l.workOrderId) === String(wo._id) && (l.unitNumbers || []).includes(unit))
      : null;
    /* The session that put THIS piece in the box. A carton filled over two
       days has two packers; the carton's opener is not necessarily this
       piece's. Cartons written before sessions existed fall back to it. */
    const session = carton
      ? (carton.additions || []).find((a) => (a.items || []).some((it) =>
        String(it.workOrderId) === String(wo._id) && (it.unitNumbers || []).includes(unit)))
      : null;
    const legacyRecord = !carton
      ? (wo.packagingRecords || []).find((r) => (r.unitNumbers || []).includes(unit))
      : null;

    return res.json({
      success: true,
      recognised: true,
      barcode,
      unitNumber: unit,
      workOrder: {
        _id: wo._id,
        workOrderNumber: displayWorkOrderNumber(wo),
        shortId: parsed.workOrderShortId,
        productName: wo.stockItemName || "",
        productReference: wo.stockItemReference || "",
        variantAttributes: wo.variantAttributes || [],
        quantity: wo.quantity || 0,
        packagedQuantity: wo.packagedQuantity || 0,
        moNumber: mo ? `MO-${mo.requestId}` : "",
        customerName: mo?.customerInfo?.name || "",
      },
      packed: Boolean(carton || legacyRecord),
      carton: carton ? {
        _id: carton._id,
        cartonNumber: carton.cartonNumber,
        status: carton.status,
        totalQuantity: carton.totalQuantity,
        /* When and by whom THIS piece went in. */
        packedAt: session?.at || carton.packedAt,
        packedBy: session?.packedBy || carton.packedBy,
        /* Who opened the carton, when that differs. */
        openedAt: carton.packedAt,
        openedBy: carton.packedBy,
        sessions: (carton.additions || []).length,
        dispatchedAt: carton.dispatchedAt,
        notes: carton.notes,
      } : null,
      line: line ? {
        productName: line.productName,
        variantAttributes: line.variantAttributes,
        packagingType: line.packagingType,
        employee: line.employee || null,
      } : null,
      legacyRecord: legacyRecord ? {
        packagedAt: legacyRecord.packagedAt,
        packagedBy: legacyRecord.packagedBy || "",
      } : null,
    });
  } catch (err) {
    console.error("Find piece error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /hourly?date=YYYY-MM-DD — the day, hour by hour: pieces, cartons, who
// ═════════════════════════════════════════════════════════════════════════════
/* Two sources, never double-counted:
 *   · PackingCarton — every carton sealed since 24 Sep 2026, with the packer
 *     as a person (packedBy.name) and packedAt as the moment of sealing;
 *   · WorkOrder.packagingRecords WITHOUT a cartonId — packing recorded before
 *     cartons existed, with packagedBy as a display string.
 * A record that carries a cartonId is the same event as its carton and is
 * skipped. The day is an IST calendar day (Asia/Kolkata, +05:30, no DST),
 * computed the way the rest of this backend does it — shift by the offset and
 * read UTC fields — so an hour here is the hour on the wall clock on the floor. */
/* The factory's hours — 09:30–18:30 IST, nine shift hours plus a bucket either
   side — come from ONE place so every hour-wise report agrees:
   services/manufacturing/shiftHours.js. */
const shift = require("../../../../services/manufacturing/shiftHours");
const istDayWindow = shift.istDayWindow;

router.get("/hourly", ...canRead, async (req, res) => {
  try {
    const { start, end, label } = istDayWindow(req.query.date);
    const companyId = companyOf(req);

    const [cartons, legacyWOs] = await Promise.all([
      /* A carton belongs in the day if any of its sessions does — a carton
         opened yesterday and topped up today has pieces in both days. */
      PackingCarton.find({
        companyId,
        $or: [
          { "additions.at": { $gte: start, $lt: end } },
          { "additions.0": { $exists: false }, packedAt: { $gte: start, $lt: end } },
        ],
      })
        .select("cartonNumber totalQuantity workOrderCount packedAt packedBy moNumber customerName additions.at additions.packedBy additions.quantity")
        .lean(),
      access.findWorkOrders(companyId,
        { packagingRecords: { $elemMatch: { packagedAt: { $gte: start, $lt: end }, cartonId: { $exists: false } } } },
        "workOrderNumber stockItemName packagingRecords").lean(),
    ]);

    /* One flat list of packing events, whichever book they came from. */
    const events = [];
    for (const c of cartons) {
      const sessions = (c.additions || []).length
        ? c.additions
        : [{ at: c.packedAt, packedBy: c.packedBy, quantity: c.totalQuantity }]; // before sessions existed
      sessions.forEach((a, i) => {
        const at = new Date(a.at);
        if (at < start || at >= end) return;
        events.push({
          at, bucket: shift.bucketIndexOf(at),
          pieces: a.quantity || 0,
          /* A carton is "sealed" in the hour its FIRST session happened;
             later sessions are top-ups of a carton already counted. */
          cartons: i === 0 ? 1 : 0,
          topUp: i > 0,
          packer: a.packedBy?.name || "Unknown", packerId: a.packedBy?.userId || "",
          cartonNumber: c.cartonNumber, moNumber: c.moNumber || "", customerName: c.customerName || "",
          source: "carton",
        });
      });
    }
    let legacyCount = 0;
    for (const wo of legacyWOs) {
      for (const r of wo.packagingRecords || []) {
        if (r.cartonId) continue;
        const at = r.packagedAt ? new Date(r.packagedAt) : null;
        if (!at || at < start || at >= end) continue;
        legacyCount++;
        events.push({
          at, bucket: shift.bucketIndexOf(at),
          pieces: r.packagedQuantity || (r.unitNumbers || []).length || 0, cartons: 0,
          packer: r.packagedBy || "Unknown", packerId: "",
          cartonNumber: null, workOrderNumber: wo.workOrderNumber || "", productName: wo.stockItemName || "",
          source: "legacy",
        });
      }
    }

    /* The shift's buckets, always — an empty hour is information (nobody packed then). */
    const hours = shift.shiftBuckets().map((b) => ({ ...b, pieces: 0, cartons: 0, events: 0, packers: new Map() }));
    const dayPackers = new Map();
    const bump = (map, e) => {
      const key = e.packerId || e.packer;
      const row = map.get(key) || { name: e.packer, pieces: 0, cartons: 0, events: 0, firstAt: e.at, lastAt: e.at };
      row.pieces += e.pieces; row.cartons += e.cartons; row.events += 1;
      if (e.at < row.firstAt) row.firstAt = e.at;
      if (e.at > row.lastAt) row.lastAt = e.at;
      map.set(key, row);
    };
    for (const e of events) {
      const b = hours[e.bucket];
      b.pieces += e.pieces; b.cartons += e.cartons; b.events += 1;
      bump(b.packers, e);
      bump(dayPackers, e);
    }

    const finish = (map) => [...map.values()].sort((a, b) => b.pieces - a.pieces);
    const out = hours.map((h) => ({ ...h, packers: finish(h.packers) }));
    const active = out.filter((h) => h.events > 0);
    const peak = active.reduce((best, h) => (!best || h.pieces > best.pieces ? h : best), null);
    const totalPieces = out.reduce((n, h) => n + h.pieces, 0);

    return res.json({
      success: true,
      date: label,
      timezone: "Asia/Kolkata",
      shift: shift.SHIFT,
      hours: out,
      totals: {
        pieces: totalPieces,
        cartons: events.reduce((n, e) => n + e.cartons, 0),
        cartonTopUps: events.filter((e) => e.topUp).length,
        events: events.length,
        activeHours: active.filter((h) => !h.outside).length,
        outsideShift: out.filter((h) => h.outside).reduce((n, h) => n + h.pieces, 0),
        avgPiecesPerActiveHour: active.length ? Math.round(totalPieces / active.length) : 0,
        firstAt: events.length ? events.reduce((a, e) => (e.at < a ? e.at : a), events[0].at) : null,
        lastAt: events.length ? events.reduce((a, e) => (e.at > a ? e.at : a), events[0].at) : null,
        packers: finish(dayPackers),
      },
      peakHour: peak ? { key: peak.key, label: peak.label, pieces: peak.pieces } : null,
      sources: { cartons: cartons.length, legacyRecords: legacyCount },
      /* Newest first; the table under the chart shows these. */
      /* The per-event log is no longer sent (24 Sep 2026); the Excel report has it. */
    });
  } catch (err) {
    console.error("Hourly packing error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /report?from=YYYY-MM-DD&to=YYYY-MM-DD   (or ?all=1)
// ═════════════════════════════════════════════════════════════════════════════
/* Everything the Excel workbook shows, computed here once: summary, shift
   hours (09:30–18:30 IST), days, who packed how much, orders with each work
   order's product and variant, variant totals, cartons, the people measurement
   orders were made for, and the packing log. The CMS lays it out and computes
   nothing, so the workbook cannot disagree with the screens.

   Source: `WorkOrder.packagingRecords` — every packing event, carton-era or
   not, is one of these (a carton seal writes one per work order). The packer's
   employee id comes from the carton session when there is one. */
router.get("/report", ...canRead, async (req, res) => {
  try {
    let window;
    try { window = reportWindow(req.query); }
    catch (e) { return res.status(e.status || 400).json({ success: false, message: e.message }); }
    const companyId = companyOf(req);
    const inWin = (d) => Boolean(d) && (window.all || (d >= window.start && d < window.end));

    const recFilter = window.all
      ? { "packagingRecords.0": { $exists: true } }
      : { packagingRecords: { $elemMatch: { packagedAt: { $gte: window.start, $lt: window.end } } } };
    const wos = await access.findWorkOrders(companyId, recFilter,
      "workOrderNumber quantity packagedQuantity customerRequestId stockItemId stockItemName stockItemReference variantId variantAttributes packagingRecords").lean();

    const moIds = [...new Set(wos.map((w) => String(w.customerRequestId || "")).filter(access.isId))];
    const [resolved, mos, cartonDocs] = await Promise.all([
      resolveVariantAttributes(wos),
      moIds.length
        ? CustomerRequest.find({ _id: { $in: moIds.map(access.oid) } }).select("requestId requestType customerInfo.name poProof.poNumber").lean()
        : [],
      PackingCarton.find({ companyId, ...(window.all ? {} : { "additions.at": { $gte: window.start, $lt: window.end } }) })
        .select("cartonNumber manufacturingOrderId moNumber customerName poNumber totalQuantity workOrderCount status packedAt lastPackedAt dispatchedAt weightKg weighedAt additions.at additions.packedBy additions.quantity")
        .sort({ packedAt: 1 })
        .lean(),
    ]);
    const moById = new Map(mos.map((m) => [String(m._id), {
      moNumber: `MO-${m.requestId}`, customerName: m.customerInfo?.name || "", poNumber: m.poProof?.poNumber || "", requestType: m.requestType || "",
    }]));
    const sessionBy = new Map();
    for (const c of cartonDocs) for (const a of c.additions || []) sessionBy.set(`${c._id}|${new Date(a.at).getTime()}`, a.packedBy || {});

    const events = [];
    const woTotals = new Map();
    const variantOf = new Map();
    wos.forEach((wo, i) => {
      const variant = variantText(resolved[i]);
      variantOf.set(String(wo._id), variant);
      woTotals.set(String(wo._id), { quantity: wo.quantity || 0, doneOverall: wo.packagedQuantity || 0 });
      const o = moById.get(String(wo.customerRequestId || "")) || null;
      for (const r of wo.packagingRecords || []) {
        const at = r.packagedAt ? new Date(r.packagedAt) : null;
        if (!inWin(at)) continue;
        const sess = r.cartonId ? sessionBy.get(`${r.cartonId}|${at.getTime()}`) : null;
        const name = sess?.name || r.packagedBy || "Unknown";
        events.push({
          at,
          personKey: sess?.userId || r.packedByUserId || `name:${name}`,
          personName: name,
          personEmployeeId: sess?.employeeId || "",
          qty: r.packagedQuantity || (r.unitNumbers || []).length,
          units: r.unitNumbers || [],
          woId: String(wo._id), woNumber: displayWorkOrderNumber(wo),
          product: wo.stockItemName || "", reference: wo.stockItemReference || "", variant,
          moId: wo.customerRequestId ? String(wo.customerRequestId) : null,
          moNumber: o?.moNumber || "", customerName: o?.customerName || "", poNumber: o?.poNumber || "", requestType: o?.requestType || "",
          cartonNumber: r.cartonNumber || "",
          source: r.packagingType === "person_wise" ? "Person-wise" : "Bulk",
        });
      }
    });

    const report = buildStageReport({ events, window, woTotals });

    /* Cartons touched in the period — with what was added IN the period and
       by whom, beside the carton's whole contents. */
    const cartons = cartonDocs.map((c) => {
      const inPeriod = (c.additions || []).filter((a) => inWin(new Date(a.at)));
      const first = (c.additions || [])[0];
      return {
        cartonNumber: c.cartonNumber, moNumber: c.moNumber || "", customerName: c.customerName || "", poNumber: c.poNumber || "",
        totalQuantity: c.totalQuantity || 0, workOrderCount: c.workOrderCount || 0,
        addedInPeriod: inPeriod.reduce((n, a) => n + (a.quantity || 0), 0),
        sessionsInPeriod: inPeriod.length, sessionsTotal: (c.additions || []).length,
        packers: [...new Set(inPeriod.map((a) => a.packedBy?.name).filter(Boolean))],
        openedInPeriod: first ? inWin(new Date(first.at)) : inWin(c.packedAt ? new Date(c.packedAt) : null),
        status: c.status, openedAt: c.packedAt, lastPackedAt: c.lastPackedAt || c.packedAt, dispatchedAt: c.dispatchedAt || null,
        weightKg: c.weightKg ?? null, needsReweigh: withWeightState(c).needsReweigh,
      };
    });
    report.summary.cartonsOpened = cartons.filter((c) => c.openedInPeriod).length;
    report.summary.cartonsTouched = cartons.length;

    /* Measurement orders: who each garment was MADE FOR. The only place a
       person's name and UIN belong in this report — never on a bulk row. */
    const woById = new Map(wos.map((w) => [String(w._id), w]));
    const madeFor = [];
    const personWiseWoIds = wos.filter((w) => (w.packagingRecords || []).some((r) => r.packagingType === "person_wise")).map((w) => w._id);
    if (personWiseWoIds.length) {
      const docs = await EmployeeProductionProgress.find({
        workOrderId: { $in: personWiseWoIds },
        ...(window.all ? { "packagingHistory.0": { $exists: true } } : { "packagingHistory.packagedAt": { $gte: window.start, $lt: window.end } }),
      }).select("employeeId employeeName employeeUIN gender workOrderId packagingHistory").lean();
      const mpc = await buildMpcEnrichmentMap({ employeeIds: docs.map((d) => d.employeeId), uins: docs.map((d) => d.employeeUIN) });
      for (const d of docs) {
        const wo = woById.get(String(d.workOrderId));
        if (!wo) continue;
        const o = moById.get(String(wo.customerRequestId || "")) || null;
        const m = lookupMpc(mpc, d);
        for (const h of d.packagingHistory || []) {
          const at = h.packagedAt ? new Date(h.packagedAt) : null;
          if (!inWin(at)) continue;
          madeFor.push({
            person: d.employeeName || "", uin: d.employeeUIN || "", gender: d.gender || "",
            department: m?.department || "", designation: m?.designation || "",
            moNumber: o?.moNumber || "", customerName: o?.customerName || "",
            woNumber: displayWorkOrderNumber(wo), product: wo.stockItemName || "", variant: variantOf.get(String(wo._id)) || "",
            qty: h.packagedQuantity || (h.unitNumbers || []).length, units: compactRanges(h.unitNumbers), packedBy: h.packagedBy || "", at,
          });
        }
      }
      madeFor.sort((a, b) => String(a.customerName).localeCompare(String(b.customerName)) || String(a.person).localeCompare(String(b.person)) || a.at - b.at);
    }

    return res.json({
      success: true,
      department: "Packaging & Dispatch",
      doneLabel: "Packed",
      generatedAt: new Date(),
      ...report,
      cartons,
      madeFor,
      notes: {
        inferredVariant: report.variants.some((v) => String(v.variant).endsWith("†")),
      },
    });
  } catch (err) {
    console.error("Packaging report error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /logs
// ═════════════════════════════════════════════════════════════════════════════
/* No screen calls this today (the dashboards use /logs-by-mo). It is left in
   place, guarded and company-scoped like everything else here rather than
   rewritten: an unused door that is open is still a door. */
router.get("/logs", ...canRead, async (req, res) => {
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

    const woFilter = access.workOrderScope(companyOf(req));
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


router.get("/remaining-units/:woId", ...canRead, async (req, res) => {
  try {
    const wo = await access.findWorkOrder(companyOf(req), req.params.woId,
      "quantity packagingRecords workOrderNumber");
    if (!wo) return access.notFound(res, "work order");
    const packaged = new Set((wo.packagingRecords || []).flatMap(r => r.unitNumbers || []));
    const remaining = Array.from({ length: wo.quantity }, (_, i) => i + 1).filter(u => !packaged.has(u));
    res.json({ success: true, remaining, packedCount: packaged.size, totalCount: wo.quantity });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;


// Basically the data is not showing why, see how the remaining products are not showing/the needed products are not showing for that person     