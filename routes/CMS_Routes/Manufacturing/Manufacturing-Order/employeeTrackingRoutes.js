// routes/CMS_Routes/Manufacturing/Manufacturing-Order/employeeTrackingRoutes.js
// UPDATED: product records now include progressDocId, isDispatched, dispatchedAt
// so the frontend EmployeeTrackingTab can use them for dispatch selection.

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

router.use(EmployeeAuthMiddleware);

// ── Helper: build per-employee records with dispatch info ─────────────────────
async function buildEmployeeRecords(docs) {
  if (!docs.length) return [];

  const woIds = [...new Set(docs.map((d) => d.workOrderId.toString()))];
  const wos   = await WorkOrder.find({ _id: { $in: woIds } })
    .select("_id workOrderNumber stockItemName stockItemReference variantAttributes")
    .lean();
  const woMap = new Map(wos.map((wo) => [wo._id.toString(), wo]));

  const empMap = new Map();

  for (const doc of docs) {
    const empKey = doc.employeeId.toString();
    const wo     = woMap.get(doc.workOrderId.toString());

    if (!empMap.has(empKey)) {
      empMap.set(empKey, {
        employeeId:                  doc.employeeId,
        employeeName:                doc.employeeName,
        employeeUIN:                 doc.employeeUIN,
        gender:                      doc.gender || "",
        products:                    [],
        totalUnitsAssigned:          0,
        totalUnitsCompleted:         0,
        overallCompletionPercentage: 0,
        lastSyncedAt:                null,
      });
    }

    const rec = empMap.get(empKey);

    // Derive variant display name from WO variantAttributes
    const variantName = wo?.variantAttributes?.length
      ? wo.variantAttributes.map((v) => v.value).join(" / ")
      : "Default";

    rec.products.push({
      // ── ADDED: dispatch-required fields ──────────────────────────────────
      progressDocId:        doc._id,           // used as the select key in EmployeeTrackingTab
      isDispatched:         doc.isDispatched || false,
      dispatchedAt:         doc.dispatchedAt   || null,
      dispatchedBy:         doc.dispatchedBy   || null,
      // ── existing fields ───────────────────────────────────────────────────
      workOrderId:          doc.workOrderId,
      workOrderNumber:      wo?.workOrderNumber    || "—",
      productName:          wo?.stockItemName      || "—",
      productRef:           wo?.stockItemReference || "",
      variantName,
      unitStart:            doc.unitStart,
      unitEnd:              doc.unitEnd,
      totalUnits:           doc.totalUnits,
      completedUnits:       doc.completedUnits,
      completionPercentage: doc.completionPercentage,
    });

    rec.totalUnitsAssigned  += doc.totalUnits;
    rec.totalUnitsCompleted += doc.completedUnits;

    if (doc.lastSyncedAt && (!rec.lastSyncedAt || doc.lastSyncedAt > rec.lastSyncedAt)) {
      rec.lastSyncedAt = doc.lastSyncedAt;
    }
  }

  for (const rec of empMap.values()) {
    rec.overallCompletionPercentage =
      rec.totalUnitsAssigned > 0
        ? Math.min(Math.round((rec.totalUnitsCompleted / rec.totalUnitsAssigned) * 100), 100)
        : 0;
  }

  return [...empMap.values()];
}

// ── GET /manufacturing-order/:moId/employees ──────────────────────────────────
router.get("/manufacturing-order/:moId/employees", async (req, res) => {
  try {
    const { moId } = req.params;
    const page     = Math.max(1, parseInt(req.query.page  || "1",  10));
    const limit    = Math.max(1, parseInt(req.query.limit || "10", 10));
    const search   = (req.query.search || "").trim();

    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid manufacturing order ID" });
    }

    const filter = { manufacturingOrderId: new mongoose.Types.ObjectId(moId) };
    if (search) {
      const re = new RegExp(search, "i");
      filter.$or = [{ employeeName: re }, { employeeUIN: re }];
    }

    const allDocs = await EmployeeProductionProgress.find(filter)
      .sort({ employeeName: 1, workOrderId: 1 })
      .lean();

    if (!allDocs.length) {
      return res.json({
        success: true,
        employeeData: [],
        stats: { totalEmployees: 0, totalUnitsAssigned: 0, totalUnitsCompleted: 0, totalWorkOrders: 0, averageCompletion: 0 },
        pagination: { page, limit, total: 0, totalPages: 0 },
      });
    }

    const allEmployees = await buildEmployeeRecords(allDocs);
    const total        = allEmployees.length;
    const totalPages   = Math.ceil(total / limit);
    const pageData     = allEmployees.slice((page - 1) * limit, page * limit);

    const woIds = [...new Set(allDocs.map((d) => d.workOrderId.toString()))];
    const stats = {
      totalEmployees:      total,
      totalUnitsAssigned:  allDocs.reduce((s, d) => s + d.totalUnits,     0),
      totalUnitsCompleted: allDocs.reduce((s, d) => s + d.completedUnits, 0),
      totalWorkOrders:     woIds.length,
      averageCompletion:   total > 0
        ? Math.round(allEmployees.reduce((s, e) => s + e.overallCompletionPercentage, 0) / total)
        : 0,
    };

    return res.json({ success: true, employeeData: pageData, stats, pagination: { page, limit, total, totalPages } });

  } catch (err) {
    console.error("Employee tracking error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ── GET /search ───────────────────────────────────────────────────────────────
router.get("/search", async (req, res) => {
  try {
    const { query, manufacturingOrderId } = req.query;
    if (!query || query.length < 2) return res.json({ success: true, results: [] });

    const filter = {
      $or: [{ employeeName: new RegExp(query, "i") }, { employeeUIN: new RegExp(query, "i") }],
    };
    if (manufacturingOrderId && mongoose.Types.ObjectId.isValid(manufacturingOrderId)) {
      filter.manufacturingOrderId = new mongoose.Types.ObjectId(manufacturingOrderId);
    }

    const docs    = await EmployeeProductionProgress.find(filter).limit(100).lean();
    const results = await buildEmployeeRecords(docs);
    return res.json({ success: true, results });
  } catch (err) {
    console.error("Employee search error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;