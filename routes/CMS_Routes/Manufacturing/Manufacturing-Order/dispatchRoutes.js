// routes/CMS_Routes/Manufacturing/Manufacturing-Order/dispatchRoutes.js
//
// Mount in server.js as:
//   const dispatchRoutes = require("./routes/CMS_Routes/Manufacturing/Manufacturing-Order/dispatchRoutes");
//   app.use("/api/cms/manufacturing/dispatch", dispatchRoutes);

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// POST /employee
// Create dispatch for one or more employees (measurement order)
// Body: { employeeProgressIds: [...], dispatchedBy: "name", notes: "..." }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/employee", async (req, res) => {
  try {
    const { employeeProgressIds, dispatchedBy = "Admin", notes = "" } = req.body;

    if (!employeeProgressIds?.length) {
      return res.status(400).json({ success: false, message: "No employees selected for dispatch" });
    }

    // Cast to ObjectIds so Mongoose finds them reliably
    const objectIds = employeeProgressIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    if (!objectIds.length) {
      return res.status(400).json({ success: false, message: "No valid progress IDs provided" });
    }

    // Fetch ALL matching docs first — use $ne:true so docs that never had
    // the field set (existing records) are also matched. isDispatched:false
    // would miss them because the field simply doesn't exist on old docs.
    const docs = await EmployeeProductionProgress.find({
      _id: { $in: objectIds },
      isDispatched: { $ne: true },
    }).lean();

    if (!docs.length) {
      return res.status(400).json({ success: false, message: "No eligible employees found — they may already be dispatched" });
    }

    // Filter: only employees where production is complete (completedUnits >= totalUnits)
    // Use Number() to guard against any type mismatch between the two fields.
    const eligible = docs.filter((d) => Number(d.completedUnits) >= Number(d.totalUnits));
    if (!eligible.length) {
      const incomplete = docs.map((d) => `${d.employeeName} (${d.completedUnits}/${d.totalUnits})`).join(", ");
      return res.status(400).json({
        success: false,
        message: `Production not yet complete for: ${incomplete}`,
      });
    }

    const now = new Date();
    const eligibleIds = eligible.map((d) => d._id);

    // Mark each employee as dispatched
    await EmployeeProductionProgress.updateMany(
      { _id: { $in: eligibleIds } },
      {
        $set: {
          isDispatched: true,
          dispatchedAt: now,
          dispatchedBy,
          dispatchNotes: notes,
        },
        $push: {
          dispatchHistory: { dispatchedAt: now, dispatchedBy, notes },
        },
      }
    );

    // Group by workOrderId and update WO.dispatchedQuantity + WO.dispatchRecords
    const woGroups = {};
    for (const doc of eligible) {
      const woKey = doc.workOrderId.toString();
      if (!woGroups[woKey]) {
        woGroups[woKey] = {
          employeeIds: [],
          employeeNames: [],
          employeeDetails: [],   // ← NEW: carries qty data into dispatchRecords
          qty: 0,
        };
      }
      woGroups[woKey].employeeIds.push(doc.employeeId);
      woGroups[woKey].employeeNames.push(doc.employeeName);
      woGroups[woKey].qty += doc.totalUnits;

      // ← NEW: save per-employee qty from EmployeeProductionProgress fields
      woGroups[woKey].employeeDetails.push({
        name: doc.employeeName,
        totalUnits: doc.totalUnits,      // units assigned  (unitEnd - unitStart + 1)
        completedUnits: doc.completedUnits,  // units actually finished (updated by cron)
      });
    }

    for (const [woId, group] of Object.entries(woGroups)) {
      await WorkOrder.findByIdAndUpdate(woId, {
        $inc: { dispatchedQuantity: group.qty },
        $push: {
          dispatchRecords: {
            dispatchedQuantity: group.qty,
            dispatchedAt: now,
            dispatchedBy,
            notes,
            dispatchType: "person_wise",
            employeeIds: group.employeeIds,
            employeeNames: group.employeeNames,
            employeeDetails: group.employeeDetails,  // ← NEW
          },
        },
      });
    }

    return res.json({
      success: true,
      message: `${eligible.length} employee(s) dispatched successfully`,
      dispatchedCount: eligible.length,
      skippedCount: docs.length - eligible.length,
    });

  } catch (err) {
    console.error("Employee dispatch error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /bulk
// Create dispatch for a bulk WO (not measurement)
// Body: { workOrderId, quantity, dispatchedBy, notes }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bulk", async (req, res) => {
  try {
    const { workOrderId, quantity, dispatchedBy = "Admin", notes = "" } = req.body;

    if (!workOrderId || !quantity || quantity < 1) {
      return res.status(400).json({ success: false, message: "workOrderId and quantity are required" });
    }

    const wo = await WorkOrder.findById(workOrderId);
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });

    const alreadyDispatched = wo.dispatchedQuantity || 0;
    const completed = wo.productionCompletion?.overallCompletedQuantity || 0;
    const availableForDispatch = completed - alreadyDispatched;

    if (quantity > availableForDispatch) {
      return res.status(400).json({
        success: false,
        message: `Only ${availableForDispatch} unit(s) available for dispatch (${completed} completed, ${alreadyDispatched} already dispatched)`,
      });
    }

    const now = new Date();
    wo.dispatchedQuantity = alreadyDispatched + quantity;
    wo.dispatchRecords = wo.dispatchRecords || [];
    wo.dispatchRecords.push({
      dispatchedQuantity: quantity,
      dispatchedAt: now,
      dispatchedBy,
      notes,
      dispatchType: "bulk",
    });
    await wo.save();

    return res.json({
      success: true,
      message: `${quantity} unit(s) dispatched successfully`,
      totalDispatched: wo.dispatchedQuantity,
      remainingForDispatch: completed - wo.dispatchedQuantity,
    });

  } catch (err) {
    console.error("Bulk dispatch error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /work-order/:woId/history
// Returns dispatch history for a single WO
// ─────────────────────────────────────────────────────────────────────────────
router.get("/work-order/:woId/history", async (req, res) => {
  try {
    const wo = await WorkOrder.findById(req.params.woId)
      .select("workOrderNumber quantity dispatchedQuantity dispatchRecords productionCompletion")
      .lean();
    if (!wo) return res.status(404).json({ success: false, message: "Work order not found" });

    const completed = wo.productionCompletion?.overallCompletedQuantity || 0;
    return res.json({
      success: true,
      workOrderNumber: wo.workOrderNumber,
      totalQuantity: wo.quantity,
      completedQuantity: completed,
      dispatchedQuantity: wo.dispatchedQuantity || 0,
      remainingForDispatch: completed - (wo.dispatchedQuantity || 0),
      dispatchRecords: (wo.dispatchRecords || []).sort((a, b) => new Date(b.dispatchedAt) - new Date(a.dispatchedAt)),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-order/:moId/summary
// Returns dispatch summary for all WOs under an MO (used by both tabs)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-order/:moId/summary", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid MO ID" });
    }

    const workOrders = await WorkOrder.find({ customerRequestId: moId })
      .select("workOrderNumber stockItemName stockItemReference quantity dispatchedQuantity productionCompletion variantAttributes")
      .lean();

    const summary = workOrders.map((wo) => {
      const completed = wo.productionCompletion?.overallCompletedQuantity || 0;
      const dispatched = wo.dispatchedQuantity || 0;
      return {
        workOrderId: wo._id,
        workOrderNumber: wo.workOrderNumber,
        productName: wo.stockItemName || "—",
        productRef: wo.stockItemReference || "",
        variantAttributes: wo.variantAttributes || [],
        totalQuantity: wo.quantity,
        completedQuantity: completed,
        dispatchedQuantity: dispatched,
        availableForDispatch: Math.max(0, completed - dispatched),
        pendingProduction: Math.max(0, wo.quantity - completed),
        isFullyDispatched: dispatched >= wo.quantity,
      };
    });

    const totals = summary.reduce(
      (acc, s) => {
        acc.totalQty += s.totalQuantity;
        acc.completedQty += s.completedQuantity;
        acc.dispatchedQty += s.dispatchedQuantity;
        acc.availableQty += s.availableForDispatch;
        return acc;
      },
      { totalQty: 0, completedQty: 0, dispatchedQty: 0, availableQty: 0 }
    );

    return res.json({ success: true, workOrders: summary, totals });
  } catch (err) {
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manufacturing-order/:moId/dispatch-history
// Returns a unified, chronologically-sorted dispatch history for ALL WOs
// under the MO. Works for both measurement (person_wise) and bulk orders.
//
// Response shape:
// {
//   success: true,
//   manufacturingOrderId,
//   totals: { totalDispatched, totalQuantity, totalCompleted, totalWOs },
//   history: [
//     {
//       recordId,           // _id of the dispatchRecord sub-doc
//       workOrderId,
//       workOrderNumber,
//       productName,
//       variantAttributes,  // [{ name, value }]
//       dispatchType,       // "person_wise" | "bulk"
//       dispatchedQuantity,
//       dispatchedAt,
//       dispatchedBy,
//       notes,
//       employeeNames,      // only for person_wise; empty array otherwise
//     },
//     ...sorted newest first
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
router.get("/manufacturing-order/:moId/dispatch-history", async (req, res) => {
  try {
    const { moId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(moId)) {
      return res.status(400).json({ success: false, message: "Invalid MO ID" });
    }

    // Pull all WOs for this MO — only the fields we need
    const workOrders = await WorkOrder.find({ customerRequestId: moId })
      .select(
        "workOrderNumber stockItemName stockItemReference quantity variantAttributes " +
        "dispatchedQuantity dispatchRecords productionCompletion"
      )
      .lean();

    // Fetch MO customer info for the challan
    let moInfo = null;
    try {
      const mo = await CustomerRequest.findById(moId)
        .select("requestId customerInfo")
        .lean();
      if (mo) moInfo = { requestId: mo.requestId, customerInfo: mo.customerInfo || {} };
    } catch (_) { /* non-fatal — challan still works without customer info */ }

    // Flatten all dispatchRecords across all WOs into one list
    const history = [];

    for (const wo of workOrders) {
      const completed = wo.productionCompletion?.overallCompletedQuantity || 0;
      for (const rec of wo.dispatchRecords || []) {
        history.push({
          recordId: rec._id,
          workOrderId: wo._id,
          workOrderNumber: wo.workOrderNumber || `WO-${wo._id.toString().slice(-8)}`,
          productName: wo.stockItemName || "—",
          productRef: wo.stockItemReference || "",
          variantAttributes: wo.variantAttributes || [],
          totalQuantity: wo.quantity,
          completedQuantity: completed,
          dispatchType: rec.dispatchType || "bulk",
          dispatchedQuantity: rec.dispatchedQuantity,
          dispatchedAt: rec.dispatchedAt,
          dispatchedBy: rec.dispatchedBy || "—",
          notes: rec.notes || "",
          employeeNames: rec.employeeNames || [],
        });
      }
    }

    // Sort newest first
    history.sort((a, b) => new Date(b.dispatchedAt) - new Date(a.dispatchedAt));

    // Compute MO-level totals
    const totals = workOrders.reduce(
      (acc, wo) => {
        acc.totalQuantity += wo.quantity || 0;
        acc.totalCompleted += wo.productionCompletion?.overallCompletedQuantity || 0;
        acc.totalDispatched += wo.dispatchedQuantity || 0;
        return acc;
      },
      { totalQuantity: 0, totalCompleted: 0, totalDispatched: 0, totalWOs: workOrders.length }
    );

    return res.json({
      success: true,
      manufacturingOrderId: moId,
      moInfo,
      totals,
      history,
    });

  } catch (err) {
    console.error("MO dispatch history error:", err);
    return res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;