// routes/CMS_Routes/Manufacturing/CuttingMaster/measurementRoutes.js
const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const EmployeeMpc = require("../../../../models/Customer_Models/Employee_Mpc");

const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ============================================================================
// GET: Employee measurements for a work order
// ============================================================================
router.get("/work-orders/:woId/employee-measurements", async (req, res) => {
  try {
    const { woId } = req.params;

    const workOrder = await WorkOrder.findById(woId)
      .select("workOrderNumber stockItemName stockItemReference quantity variantAttributes customerRequestId stockItemId _id")
      .lean();

    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("numberOfPanels genderCategory gender category")
      .lean();

    const panelCount = stockItem?.numberOfPanels || 1;
    const genderCategory =
      stockItem?.genderCategory ||
      stockItem?.gender ||
      stockItem?.category ||
      null;

    const measurement = await Measurement.findOne({
      poRequestId: workOrder.customerRequestId,
    }).select("_id name organizationName employeeMeasurements").lean();

    if (!measurement) {
      return res.status(404).json({ success: false, message: "No measurement data found" });
    }

    const progressDocs = await EmployeeProductionProgress.find({
      workOrderId: workOrder._id,
    })
      .select("employeeId employeeName employeeUIN gender unitStart unitEnd totalUnits completedUnits completionPercentage assignedBarcodeIds isDispatched")
      .lean();

    const progressByEmployee = new Map();
    for (const doc of progressDocs) {
      progressByEmployee.set(doc.employeeId.toString(), doc);
    }

    const employeeIds = (measurement.employeeMeasurements || [])
      .map((e) => e.employeeId)
      .filter(Boolean);

    const mpcDocs = await EmployeeMpc.find({ _id: { $in: employeeIds } })
      .select("_id department designation")
      .lean();

    const mpcById = new Map();
    for (const doc of mpcDocs) {
      mpcById.set(doc._id.toString(), doc);
    }

    const employeeMeasurements = [];

    for (const emp of measurement.employeeMeasurements || []) {
      const empIdStr = emp.employeeId?.toString();
      const progress = progressByEmployee.get(empIdStr);

      if (!progress) continue;

      const productEntry = (emp.products || []).find((p) => {
        const pIdStr = p.productId?.toString();
        return (
          pIdStr === workOrder.stockItemId?.toString() ||
          p.productName === workOrder.stockItemName
        );
      });

      employeeMeasurements.push({
        employeeId: empIdStr,
        employeeName: emp.employeeName,
        employeeUIN: emp.employeeUIN,
        gender: emp.gender,
        department: mpcById.get(empIdStr)?.department || "",
        designation: mpcById.get(empIdStr)?.designation || "",
        quantity: progress.totalUnits,
        unitStart: progress.unitStart,
        unitEnd: progress.unitEnd,
        measurements: productEntry?.measurements || [],
        qrGenerated: productEntry?.qrGenerated || false,
        completedUnits: progress.completedUnits || 0,
        completionPercentage: progress.completionPercentage || 0,
        isDispatched: progress.isDispatched || false,
      });
    }

    const genderOrder = { M: 0, Male: 0, m: 0, F: 1, Female: 1, f: 1 };
    employeeMeasurements.sort((a, b) => {
      const ga = genderOrder[a.gender] ?? 2;
      const gb = genderOrder[b.gender] ?? 2;
      return ga - gb;
    });

    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        workOrderId: workOrder._id.toString(),
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity,
        panelCount,
        genderCategory,
        variantAttributes: workOrder.variantAttributes || [],
      },
      measurement: {
        _id: measurement._id,
        name: measurement.name,
        organizationName: measurement.organizationName || "",
      },
      employeeMeasurements,
      totalEmployees: employeeMeasurements.length,
    });
  } catch (error) {
    console.error("Error fetching employee measurements:", error);
    res.status(500).json({ success: false, message: "Server error while fetching employee measurements" });
  }
});

// ============================================================================
// GET: Search employees by name / UIN / department across an MO
// ============================================================================
router.get("/manufacturing-orders/:moId/search-employees", async (req, res) => {
  try {
    const { moId } = req.params;
    const q = (req.query.q || "").trim().toLowerCase();

    if (!q || q.length < 1) {
      return res.json({ success: true, employees: [] });
    }

    const measurement = await Measurement.findOne({ poRequestId: moId })
      .select("_id name organizationName employeeMeasurements")
      .lean();

    if (!measurement) {
      return res.json({ success: true, employees: [] });
    }

    const matched = (measurement.employeeMeasurements || []).filter((emp) => {
      return (
        emp.employeeName?.toLowerCase().includes(q) ||
        emp.employeeUIN?.toLowerCase().includes(q)
      );
    });

    if (matched.length === 0) {
      return res.json({ success: true, employees: [] });
    }

    const employeeIds = matched.map((e) => e.employeeId).filter(Boolean);

    const mpcDocs = await EmployeeMpc.find({ _id: { $in: employeeIds } })
      .select("_id department designation")
      .lean();

    const mpcById = new Map();
    for (const doc of mpcDocs) {
      mpcById.set(doc._id.toString(), doc);
    }

    const allEmployeeIds = (measurement.employeeMeasurements || [])
      .filter((emp) => {
        const empIdStr = emp.employeeId?.toString();
        const dept = mpcById.get(empIdStr)?.department?.toLowerCase() || "";
        const alreadyMatched =
          emp.employeeName?.toLowerCase().includes(q) ||
          emp.employeeUIN?.toLowerCase().includes(q);
        return !alreadyMatched && dept.includes(q);
      })
      .map((e) => e.employeeId?.toString());

    const finalEmployeeSet = new Set([
      ...matched.map((e) => e.employeeId?.toString()),
      ...allEmployeeIds,
    ]);

    const finalMatched = (measurement.employeeMeasurements || []).filter((emp) =>
      finalEmployeeSet.has(emp.employeeId?.toString())
    );

    const workOrders = await WorkOrder.find({ customerRequestId: moId })
      .select("_id workOrderNumber stockItemName stockItemId")
      .lean();

    const progressDocs = await EmployeeProductionProgress.find({
      workOrderId: { $in: workOrders.map((w) => w._id) },
      employeeId: { $in: Array.from(finalEmployeeSet) },
    })
      .select("employeeId workOrderId unitStart unitEnd totalUnits completedUnits completionPercentage qrGenerated isDispatched")
      .lean();

    const progressMap = new Map();
    for (const p of progressDocs) {
      const key = `${p.employeeId.toString()}_${p.workOrderId.toString()}`;
      progressMap.set(key, p);
    }

    const woById = new Map();
    for (const wo of workOrders) {
      woById.set(wo._id.toString(), wo);
    }

    const employees = finalMatched.map((emp) => {
      const empIdStr = emp.employeeId?.toString();
      const mpc = mpcById.get(empIdStr);

      const products = [];

      for (const wo of workOrders) {
        const woIdStr = wo._id.toString();
        const progressKey = `${empIdStr}_${woIdStr}`;
        const progress = progressMap.get(progressKey);

        if (!progress) continue;

        const productEntry = (emp.products || []).find(
          (p) =>
            p.productId?.toString() === wo.stockItemId?.toString() ||
            p.productName === wo.stockItemName
        );

        products.push({
          productName: wo.stockItemName,
          workOrderNumber: wo.workOrderNumber,
          workOrderId: woIdStr,
          quantity: progress.totalUnits,
          unitStart: progress.unitStart,
          unitEnd: progress.unitEnd,
          measurements: productEntry?.measurements || [],
          qrGenerated: productEntry?.qrGenerated || false,
          completedUnits: progress.completedUnits || 0,
          completionPercentage: progress.completionPercentage || 0,
          isDispatched: progress.isDispatched || false,
        });
      }

      return {
        employeeId: empIdStr,
        employeeName: emp.employeeName,
        employeeUIN: emp.employeeUIN,
        gender: emp.gender,
        department: mpc?.department || "",
        designation: mpc?.designation || "",
        organizationName: measurement.organizationName || "",
        products,
      };
    });

    res.json({ success: true, measurementId: measurement._id, employees });
  } catch (error) {
    console.error("Error searching employees:", error);
    res.status(500).json({ success: false, message: "Server error while searching employees" });
  }
});

// ============================================================================
// POST: Update QR generated status
// ── Also stamps qrGeneratedAt so cutting-history can filter by date ──────────
// ============================================================================
router.post("/employee-measurements/:measurementId/update-status", async (req, res) => {
  try {
    const { measurementId } = req.params;
    const { employeeId, productName } = req.body;

    const measurement = await Measurement.findOne({
      _id: measurementId,
      "employeeMeasurements.employeeId": employeeId,
    });

    if (!measurement) {
      return res.status(404).json({ success: false, message: "Measurement not found" });
    }

    let updated = false;
    const now = new Date();

    measurement.employeeMeasurements.forEach((emp) => {
      if (emp.employeeId.toString() === employeeId) {
        emp.products.forEach((product) => {
          if (product.productName === productName) {
            product.qrGenerated  = true;
            product.qrGeneratedAt = now; // ← NEW: stamp the cut date/time
            updated = true;
          }
        });
      }
    });

    if (!updated) {
      return res.status(404).json({ success: false, message: "Product not found for this employee" });
    }

    await measurement.save();
    res.json({ success: true, message: "Status updated successfully" });
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).json({ success: false, message: "Server error while updating status" });
  }
});

// ============================================================================
// GET: Daily cutting history  (used by the overview dashboard)
// /cutting-history?from=YYYY-MM-DD&to=YYYY-MM-DD&q=searchTerm
//
// Returns employees grouped by organizationName whose barcode (QR) was
// generated within the requested date range, with stats for the stats bar.
// ============================================================================
router.get("/cutting-history", async (req, res) => {
  try {
    const { from, to, q } = req.query;

    // ── Build date window (defaults to today in IST) ─────────────────────
    const istOffset = 5.5 * 60 * 60 * 1000;
    const todayIST  = new Date(Date.now() + istOffset);
    const todayStr  = todayIST.toISOString().split("T")[0];

    const fromDate = new Date(from || todayStr);
    fromDate.setHours(0, 0, 0, 0);

    const toDate = new Date(to || todayStr);
    toDate.setHours(23, 59, 59, 999);

    const searchLower = q ? q.trim().toLowerCase() : null;

    // ── Fetch all measurements (only fields we need) ─────────────────────
    const measurements = await Measurement.find({})
      .select("organizationName employeeMeasurements")
      .lean();

    // ── Batch-fetch EmployeeMpc for dept/designation ─────────────────────
    const allEmpIds = new Set();
    measurements.forEach((m) =>
      (m.employeeMeasurements || []).forEach((e) => {
        if (e.employeeId) allEmpIds.add(e.employeeId.toString());
      })
    );

    const mpcDocs = await EmployeeMpc.find({ _id: { $in: Array.from(allEmpIds) } })
      .select("_id department designation")
      .lean();

    const mpcById = new Map();
    for (const doc of mpcDocs) mpcById.set(doc._id.toString(), doc);

    // ── Build grouped result ─────────────────────────────────────────────
    const groupsMap  = new Map(); // orgName → employee[]
    let totalEmployees = 0;
    let totalPieces    = 0;
    const productSet   = new Set();

    for (const measurement of measurements) {
      const orgName = measurement.organizationName || "Unknown";

      for (const emp of measurement.employeeMeasurements || []) {
        // ── Search filter (name or UIN) ───────────────────────────────
        if (searchLower) {
          const nameHit = emp.employeeName?.toLowerCase().includes(searchLower);
          const uinHit  = emp.employeeUIN?.toLowerCase().includes(searchLower);
          if (!nameHit && !uinHit) continue;
        }

        // ── Only include products whose QR was generated in range ─────
        const cutProducts = (emp.products || []).filter((p) => {
          if (!p.qrGenerated || !p.qrGeneratedAt) return false;
          const d = new Date(p.qrGeneratedAt);
          return d >= fromDate && d <= toDate;
        });

        if (cutProducts.length === 0) continue;

        const empIdStr = emp.employeeId?.toString();
        const mpc      = mpcById.get(empIdStr) || {};

        cutProducts.forEach((p) => {
          productSet.add(p.productName);
          totalPieces += p.quantity || 0;
        });
        totalEmployees++;

        if (!groupsMap.has(orgName)) groupsMap.set(orgName, []);
        groupsMap.get(orgName).push({
          employeeId:  empIdStr,
          employeeName: emp.employeeName,
          employeeUIN:  emp.employeeUIN,
          gender:        emp.gender,
          department:    mpc.department   || "",
          designation:   mpc.designation  || "",
          products: cutProducts.map((p) => ({
            productName:   p.productName,
            quantity:      p.quantity,
            qrGeneratedAt: p.qrGeneratedAt,
          })),
        });
      }
    }

    // ── Sort each org's employees: Male first, then Female ──────────────
    const genderOrder = { Male: 0, M: 0, m: 0, Female: 1, F: 1, f: 1 };
    const groups = Array.from(groupsMap.entries()).map(([orgName, employees]) => {
      employees.sort((a, b) => (genderOrder[a.gender] ?? 2) - (genderOrder[b.gender] ?? 2));
      const orgPieces = employees.reduce(
        (s, e) => s + e.products.reduce((ps, p) => ps + (p.quantity || 0), 0),
        0
      );
      return { organizationName: orgName, employeeCount: employees.length, totalPieces: orgPieces, employees };
    });

    // Sort orgs alphabetically
    groups.sort((a, b) => a.organizationName.localeCompare(b.organizationName));

    res.json({
      success: true,
      dateRange: { from: fromDate, to: toDate },
      stats: {
        totalEmployees,
        totalPieces,
        totalProducts:      productSet.size,
        totalOrganizations: groups.length,
      },
      groups,
    });
  } catch (error) {
    console.error("Error fetching cutting history:", error);
    res.status(500).json({ success: false, message: "Server error while fetching cutting history" });
  }
});

module.exports = router;