// routes/CMS_Routes/Manufacturing/Manufacturing-Order/markAsDoneRoutes.js

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware     = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const WorkOrder                  = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking         = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Machine                    = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee                   = require("../../../../models/Employee");

router.use(EmployeeAuthMiddleware);

// ─── Helper: resolve operator ─────────────────────────────────────────────────
async function resolveOperator() {
  const emp =
    (await Employee.findOne({ needsToOperate: true, status: "active" })
      .select("identityId firstName lastName").lean()) ||
    (await Employee.findOne({ status: "active" })
      .select("identityId firstName lastName").lean());

  if (emp) return { identityId: emp.identityId, name: `${emp.firstName} ${emp.lastName}`.trim() };
  throw new Error("No active operator/employee found to record scans against");
}

// ─── Helper: WO short-id ──────────────────────────────────────────────────────
function woShortId(workOrderId) {
  return workOrderId.toString().slice(-8);
}

// ─── Helper: get pending unit numbers ────────────────────────────────────────
function getPendingUnits(progressDoc, requestedQty = null) {
  const { unitStart, unitEnd, completedUnitNumbers } = progressDoc;
  const completedSet = new Set((completedUnitNumbers || []).map(Number));
  const pending = [];
  for (let u = unitStart; u <= unitEnd; u++) {
    if (!completedSet.has(u)) pending.push(u);
  }
  return requestedQty !== null && requestedQty > 0
    ? pending.slice(0, requestedQty)
    : pending;
}

// ─── Helper: collect all machine IDs assigned to a WO ────────────────────────
// Falls back to any machine in DB if WO has no machines assigned.
async function resolveAssignedMachines(workOrderId) {
  const wo = await WorkOrder.findById(workOrderId).select("operations").lean();
  const machineSet = new Set();

  if (wo?.operations?.length) {
    for (const op of wo.operations) {
      if (op.assignedMachine) machineSet.add(op.assignedMachine.toString());
      for (const am of op.additionalMachines || []) {
        if (am.assignedMachine) machineSet.add(am.assignedMachine.toString());
      }
    }
  }

  if (machineSet.size > 0) return [...machineSet];

  const m = await Machine.findOne({}).select("_id").lean();
  if (m) return [m._id.toString()];

  throw new Error("No machine found in the system to associate scans with");
}

// ─── Helper: get operation codes from a WO ───────────────────────────────────
// Returns string[] of operationCode values for all operations in the WO.
// These are stored as activeOps on each virtual scan — matching exactly
// what the physical ESP scanner sends (a comma-split array of op codes).
async function resolveOperationCodes(workOrderId) {
  const wo = await WorkOrder.findById(workOrderId)
    .select("operations")
    .lean();

  if (!wo?.operations?.length) return [];

  return wo.operations
    .map((op) => (op.operationCode || "").trim())
    .filter(Boolean);
}

// ─── Core: write virtual barcode scans into ProductionTracking ────────────────
//
// Replicates physical scanner behaviour exactly:
//   For EACH assigned machine → find/create its slot in today's tracking doc
//   → find/create an open operator session → push ONE scan per unit.
//
// activeOps is now stored as string[] (e.g. ["MJ030", "MJ020", "MJ032"])
// matching the normalised format written by the real trackingRoutes /scan endpoint.
//
// Args:
//   unitNumbers    : int[]    — units to mark (e.g. [1, 2, 5])
//   shortId        : string   — WO short-id, e.g. "710c4ae3"
//   machineIds     : string[] — all machine ObjectId strings assigned to this WO
//   operator       : { identityId, name }
//   operationCodes : string[] — op codes from WO operations e.g. ["MJ030","MJ020"]
async function writeVirtualScans({ unitNumbers, shortId, machineIds, operator, operationCodes }) {
  if (!unitNumbers.length || !machineIds.length) return;

  const now      = new Date();
  const scanDate = new Date(now);
  scanDate.setHours(0, 0, 0, 0);

  let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
  if (!trackingDoc) {
    trackingDoc = new ProductionTracking({ date: scanDate, machines: [] });
  }

  const barcodeIds = unitNumbers.map(
    (u) => `WO-${shortId}-${String(u).padStart(3, "0")}`
  );

  for (const machineId of machineIds) {
    let machineTracking = trackingDoc.machines.find(
      (m) => m.machineId && m.machineId.toString() === machineId
    );
    if (!machineTracking) {
      trackingDoc.machines.push({
        machineId,
        currentOperatorIdentityId: null,
        operators: [],
      });
      machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
    }

    let session = machineTracking.operators.find(
      (op) => op.operatorIdentityId === operator.identityId && !op.signOutTime
    );
    if (!session) {
      machineTracking.operators.push({
        operatorIdentityId: operator.identityId,
        operatorName:       operator.name,
        signInTime:         now,
        signOutTime:        null,
        barcodeScans:       [],
      });
      session = machineTracking.operators[machineTracking.operators.length - 1];
      machineTracking.currentOperatorIdentityId = operator.identityId;
    }

    for (let i = 0; i < barcodeIds.length; i++) {
      const barcodeId = barcodeIds[i];
      const alreadyExists = session.barcodeScans.some((s) => s.barcodeId === barcodeId);
      if (!alreadyExists) {
        const ts = new Date(now.getTime() + i * 50);
        session.barcodeScans.push({
          barcodeId,
          timeStamp: ts,
          // Store operation codes as proper string[] — same format as real scans
          activeOps: operationCodes,
        });
      }
    }
  }

  await trackingDoc.save();
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST /mark-as-done/bulk
// Body: { progressDocIds: string[], markedBy?: string }
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/bulk", async (req, res) => {
  try {
    const { progressDocIds, markedBy = "Admin" } = req.body;

    if (!progressDocIds || !Array.isArray(progressDocIds) || !progressDocIds.length) {
      return res.status(400).json({ success: false, message: "progressDocIds array is required" });
    }

    const validIds = progressDocIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (!validIds.length) {
      return res.status(400).json({ success: false, message: "No valid progressDocIds provided" });
    }

    let operator;
    try { operator = await resolveOperator(); }
    catch (err) { return res.status(500).json({ success: false, message: err.message }); }

    const results   = [];
    const errors    = [];
    let totalMarked = 0;

    for (const docId of validIds) {
      try {
        const progressDoc = await EmployeeProductionProgress.findById(docId).lean();
        if (!progressDoc) { errors.push({ docId, error: "Progress record not found" }); continue; }

        if (progressDoc.completedUnits >= progressDoc.totalUnits) {
          results.push({ docId, employeeName: progressDoc.employeeName, message: "Already complete", marked: 0 });
          continue;
        }

        const workOrder = await WorkOrder.findById(progressDoc.workOrderId)
          .select("_id workOrderNumber operations").lean();
        if (!workOrder) { errors.push({ docId, error: "Work order not found" }); continue; }

        const pending = getPendingUnits(progressDoc);
        if (!pending.length) {
          results.push({ docId, employeeName: progressDoc.employeeName, message: "No pending units", marked: 0 });
          continue;
        }

        const [machineIds, operationCodes] = await Promise.all([
          resolveAssignedMachines(progressDoc.workOrderId),
          resolveOperationCodes(progressDoc.workOrderId),
        ]);

        await writeVirtualScans({
          unitNumbers:    pending,
          shortId:        woShortId(workOrder._id),
          machineIds,
          operator,
          operationCodes,
        });

        totalMarked += pending.length;
        results.push({
          docId,
          employeeName:    progressDoc.employeeName,
          workOrderNumber: workOrder.workOrderNumber,
          marked:          pending.length,
          machinesWritten: machineIds.length,
          operationCodes,
          message: `${pending.length} unit(s) × ${machineIds.length} machine(s) marked as done`,
        });
      } catch (err) {
        errors.push({ docId, error: err.message });
      }
    }

    return res.json({
      success:     true,
      message:     `Marked ${totalMarked} unit(s) as done across ${results.length} record(s)`,
      totalMarked,
      results,
      errors,
      note: "Production sync (every 2 min) will update completion percentages shortly.",
    });
  } catch (err) {
    console.error("[MarkAsDone/bulk]", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// POST /mark-as-done/single
// Body: { progressDocId: string, quantity: number, markedBy?: string }
// ═══════════════════════════════════════════════════════════════════════════════
router.post("/single", async (req, res) => {
  try {
    const { progressDocId, quantity, markedBy = "Admin" } = req.body;

    if (!progressDocId || !mongoose.Types.ObjectId.isValid(progressDocId)) {
      return res.status(400).json({ success: false, message: "Valid progressDocId is required" });
    }

    const qty = parseInt(quantity, 10);
    if (!qty || qty < 1) {
      return res.status(400).json({ success: false, message: "quantity must be a positive integer" });
    }

    const progressDoc = await EmployeeProductionProgress.findById(progressDocId).lean();
    if (!progressDoc) {
      return res.status(404).json({ success: false, message: "Progress record not found" });
    }

    const pending = getPendingUnits(progressDoc);
    if (!pending.length) {
      return res.json({ success: true, message: "No pending units remaining for this employee", marked: 0 });
    }

    const toMark = pending.slice(0, qty);

    const workOrder = await WorkOrder.findById(progressDoc.workOrderId)
      .select("_id workOrderNumber operations").lean();
    if (!workOrder) {
      return res.status(404).json({ success: false, message: "Work order not found" });
    }

    let operator;
    try { operator = await resolveOperator(); }
    catch (err) { return res.status(500).json({ success: false, message: err.message }); }

    const [machineIds, operationCodes] = await Promise.all([
      resolveAssignedMachines(progressDoc.workOrderId),
      resolveOperationCodes(progressDoc.workOrderId),
    ]);

    await writeVirtualScans({
      unitNumbers:    toMark,
      shortId:        woShortId(workOrder._id),
      machineIds,
      operator,
      operationCodes,
    });

    return res.json({
      success:         true,
      message:         `${toMark.length} unit(s) marked as done for ${progressDoc.employeeName}`,
      employeeName:    progressDoc.employeeName,
      workOrderNumber: workOrder.workOrderNumber,
      marked:          toMark.length,
      markedUnits:     toMark,
      machinesWritten: machineIds.length,
      operationCodes,
      remaining:       pending.length - toMark.length,
      note:            "Production sync (every 2 min) will update completion percentages shortly.",
    });
  } catch (err) {
    console.error("[MarkAsDone/single]", err);
    res.status(500).json({ success: false, message: "Server error", error: err.message });
  }
});

module.exports = router;