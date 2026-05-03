// routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee = require("../../../../models/Employee");

const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");

// ============================================================================
// HELPERS
// ============================================================================

const parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
      };
    }
    return { success: false };
  } catch {
    return { success: false };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({}).lean();
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId) || null;
  } catch {
    return null;
  }
};

const extractCategory = (code) => {
  if (!code) return "OTHER";
  const m = String(code).match(/^[A-Za-z]+/);
  return m ? m[0].toUpperCase() : "OTHER";
};

// 60-second in-memory cache for the master ops list (it changes rarely).
let opsCache = null;
let opsCacheAt = 0;
const OPS_CACHE_MS = 60 * 1000;

const getMasterOperations = async () => {
  const now = Date.now();
  if (opsCache && now - opsCacheAt < OPS_CACHE_MS) return opsCache;
  opsCache = await Operation.find({ operationCode: { $ne: "" } })
    .select("name operationCode totalSam machineType")
    .lean();
  opsCacheAt = now;
  return opsCache;
};

const makeEmployeeNameCache = () => {
  const cache = new Map();
  return async (identityId) => {
    if (cache.has(identityId)) return cache.get(identityId);
    try {
      const employee = await Employee.findOne({
        $or: [{ identityId }, { biometricId: identityId }],
      }).select("firstName lastName").lean();
      const name = employee
        ? `${employee.firstName || ""} ${employee.lastName || ""}`.trim()
        : identityId;
      cache.set(identityId, name);
      return name;
    } catch {
      cache.set(identityId, identityId);
      return identityId;
    }
  };
};

// ─── IST date for "today" ───────────────────────────────────────────────────
const istTodayDate = () => {
  const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const d = new Date(istNow.toISOString().split("T")[0]);
  d.setHours(0, 0, 0, 0);
  return d;
};

// ============================================================================
// MASTER OPERATIONS (for ops-mode assignment modal)
// ============================================================================
router.get("/operations", async (req, res) => {
  try {
    const ops = await getMasterOperations();

    const enriched = ops.map((op) => ({
      _id:           op._id,
      name:          op.name,
      operationCode: op.operationCode,
      totalSam:      op.totalSam,
      machineType:   op.machineType,
      category:      extractCategory(op.operationCode),
    }));

    enriched.sort((a, b) => {
      if (a.category !== b.category) return a.category.localeCompare(b.category);
      return a.operationCode.localeCompare(b.operationCode);
    });

    const categoryCounts = {};
    enriched.forEach((op) => {
      categoryCounts[op.category] = (categoryCounts[op.category] || 0) + 1;
    });
    const categories = Object.entries(categoryCounts)
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => a.code.localeCompare(b.code));

    res.json({
      success: true,
      operations: enriched,
      categories,
      total: enriched.length,
    });
  } catch (error) {
    console.error("Error fetching master operations:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/operations/refresh-cache", (_req, res) => {
  opsCache = null;
  opsCacheAt = 0;
  res.json({ success: true });
});

// ============================================================================
// MACHINE STATUS
// ============================================================================
router.get("/machine-status", async (req, res) => {
  try {
    const allMachines = await Machine.find({}).lean();
    const todayDate   = istTodayDate();

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const activeTodayMap = new Map();
    const machineWOMap   = new Map();

    if (todayTracking) {
      for (const m of todayTracking.machines || []) {
        const mId = m.machineId?._id?.toString();
        if (!mId) continue;
        activeTodayMap.set(mId, !!m.currentOperatorIdentityId);

        const wos = new Set();
        for (const op of m.operators || []) {
          for (const scan of op.barcodeScans || []) {
            const parsed = parseBarcode(scan.barcodeId);
            if (parsed.success) wos.add(parsed.workOrderShortId);
          }
        }
        machineWOMap.set(mId, wos);
      }
    }

    const machines = allMachines.map((machine) => {
      const mId         = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woShortIds  = machineWOMap.get(mId) || new Set();

      let status = "free";
      if (["Under Maintenance", "maintenance"].includes(machine.status)) status = "maintenance";
      else if (["Offline", "offline"].includes(machine.status))          status = "offline";
      else if (isActiveNow)                                              status = "busy";

      return {
        _id: machine._id,
        name: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        model: machine.model || null,
        location: machine.location || null,
        status,
        isActiveToday: isActiveNow,
        workOrdersToday: Array.from(woShortIds),
        freeFromDate: status === "free" ? (machine.updatedAt || null) : null,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
      };
    });

    res.json({
      success: true,
      machines,
      summary: {
        total: machines.length,
        free: machines.filter((m) => m.status === "free").length,
        busy: machines.filter((m) => m.status === "busy").length,
        maintenance: machines.filter((m) => m.status === "maintenance").length,
        offline: machines.filter((m) => m.status === "offline").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machine status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// CURRENT PRODUCTION ← Slim version. No WO maths, no employee metrics.
// Just enough to render machine cards on the canvas.
// ============================================================================
router.get("/current-production", async (req, res) => {
  try {
    const { date } = req.query;
    let queryDate;
    if (date) {
      queryDate = new Date(date);
      queryDate.setHours(0, 0, 0, 0);
    } else {
      queryDate = istTodayDate();
    }

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({
        success: true,
        date: queryDate,
        machines: [],
        totalScans: 0,
      });
    }

    const getEmployeeName = makeEmployeeNameCache();
    const machines = [];
    let totalScans = 0;

    for (const machine of trackingDoc.machines) {
      const machineId = machine.machineId?._id?.toString();
      if (!machineId) continue;

      const hasCurrentOperator = !!machine.currentOperatorIdentityId;

      // Compact operator list — just what the canvas tooltip needs
      const operatorList    = [];
      const uniqueBarcodes  = new Set();
      const activeOpCodes   = new Set();
      const woShortIds      = new Set();
      let machineScanCount  = 0;

      for (const operator of machine.operators || []) {
        const operatorName = await getEmployeeName(operator.operatorIdentityId);
        const scans        = operator.barcodeScans || [];
        machineScanCount  += scans.length;

        // Track unique barcodes scanned on this machine
        for (const scan of scans) {
          if (scan.barcodeId) uniqueBarcodes.add(scan.barcodeId);
          const parsed = parseBarcode(scan.barcodeId);
          if (parsed.success) woShortIds.add(parsed.workOrderShortId);
        }

        // Active op codes = last scan codes from non-signed-out operators
        if (!operator.signOutTime && scans.length > 0) {
          const lastScan = scans[scans.length - 1];
          const codes = Array.isArray(lastScan.activeOps)
            ? lastScan.activeOps
            : (lastScan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);
          codes.forEach((c) => activeOpCodes.add(c));
        }

        // Per-operator unique pieces count (for the canvas tooltip)
        const operatorPieces = new Set(scans.map((s) => s.barcodeId).filter(Boolean));
        const lastOpCodesArr = scans.length > 0
          ? (Array.isArray(scans[scans.length - 1].activeOps)
              ? scans[scans.length - 1].activeOps
              : (scans[scans.length - 1].activeOps || "").split(",").map((s) => s.trim()).filter(Boolean))
          : [];

        operatorList.push({
          operatorIdentityId: operator.operatorIdentityId,
          operatorName,
          signInTime:  operator.signInTime,
          signOutTime: operator.signOutTime,
          scans:       scans.length,
          piecesDone:  operatorPieces.size,
          lastActiveOpCodes: lastOpCodesArr,
        });
      }

      totalScans += machineScanCount;

      machines.push({
        machineId,
        machineName:   machine.machineId?.name || "Unknown",
        machineSerial: machine.machineId?.serialNumber || "N/A",
        machineType:   machine.machineId?.type || "Unknown",
        isActive:      hasCurrentOperator,
        currentOperator: hasCurrentOperator ? machine.currentOperatorIdentityId : null,
        totalScans:    machineScanCount,
        uniquePieces:  uniqueBarcodes.size,
        operatorList,
        currentActiveOpCodes: Array.from(activeOpCodes),
        workOrdersScanned:    Array.from(woShortIds),
      });
    }

    res.json({
      success: true,
      date: queryDate,
      machines,
      totalScans,
    });
  } catch (error) {
    console.error("Error fetching current production:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// ALL MACHINES (canvas needs the full list to render placeholders)
// ============================================================================
router.get("/all-machines", async (req, res) => {
  try {
    const allMachines = await Machine.find({})
      .select("_id name serialNumber type status location")
      .lean();
    res.json({
      success: true,
      machines: allMachines.map((m) => ({ ...m, _id: m._id })),
      stats: { total: allMachines.length },
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// EMPLOYEES TODAY  ← For the employee filter tab
// Returns operators who signed in today + their status + pieces done.
// ============================================================================
router.get("/employees-today", async (req, res) => {
  try {
    const { date } = req.query;
    let queryDate;
    if (date) {
      queryDate = new Date(date);
      queryDate.setHours(0, 0, 0, 0);
    } else {
      queryDate = istTodayDate();
    }

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name")
      .lean();

    if (!trackingDoc) {
      return res.json({ success: true, date: queryDate, employees: [] });
    }

    const getEmployeeName = makeEmployeeNameCache();

    // Aggregate across ALL machines this operator signed into today.
    // operatorId → { name, isActive, piecesDone, machinesUsed[], firstSignIn, lastSignOut }
    const empMap = new Map();

    for (const machine of trackingDoc.machines || []) {
      const machineName = machine.machineId?.name || "Unknown";
      for (const operator of machine.operators || []) {
        const id = operator.operatorIdentityId;
        if (!id) continue;

        if (!empMap.has(id)) {
          empMap.set(id, {
            operatorId:   id,
            name:         await getEmployeeName(id),
            isActive:     false,
            piecesSet:    new Set(),
            machinesSet:  new Set(),
            firstSignIn:  operator.signInTime || null,
            lastSignOut:  operator.signOutTime || null,
          });
        }
        const entry = empMap.get(id);

        if (!operator.signOutTime) entry.isActive = true;

        (operator.barcodeScans || []).forEach((s) => {
          if (s.barcodeId) entry.piecesSet.add(s.barcodeId);
        });
        if (machineName) entry.machinesSet.add(machineName);

        if (operator.signInTime && (!entry.firstSignIn || new Date(operator.signInTime) < new Date(entry.firstSignIn))) {
          entry.firstSignIn = operator.signInTime;
        }
        if (operator.signOutTime && (!entry.lastSignOut || new Date(operator.signOutTime) > new Date(entry.lastSignOut))) {
          entry.lastSignOut = operator.signOutTime;
        }
      }
    }

    const employees = Array.from(empMap.values()).map((e) => ({
      operatorId:  e.operatorId,
      name:        e.name,
      isActive:    e.isActive,
      piecesDone:  e.piecesSet.size,
      machines:    Array.from(e.machinesSet),
      firstSignIn: e.firstSignIn,
      lastSignOut: e.isActive ? null : e.lastSignOut,
    }));

    // Active operators first, then signed-out ones, both sorted by pieces done desc
    employees.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.piecesDone - a.piecesDone;
    });

    res.json({ success: true, date: queryDate, employees });
  } catch (error) {
    console.error("Error fetching today's employees:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// FIND PIECE (kept as-is — used by the Find Piece modal, not the sidebar)
// ============================================================================
router.get("/find-piece", async (req, res) => {
  try {
    const { barcode } = req.query;
    if (!barcode) {
      return res.status(400).json({ success: false, message: "barcode query param is required" });
    }

    const parsed = parseBarcode(barcode.trim());
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        message: "Invalid barcode format. Expected WO-<shortId>-<unitNumber>",
      });
    }

    const { workOrderShortId, unitNumber } = parsed;

    const workOrder = await findWorkOrderByShortId(workOrderShortId);
    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: `Work order with short id "${workOrderShortId}" not found`,
      });
    }
    if (!unitNumber || unitNumber <= 0 || unitNumber > workOrder.quantity) {
      return res.status(400).json({
        success: false,
        message: `Unit ${unitNumber} is out of range for this WO (1 – ${workOrder.quantity})`,
      });
    }

    const customerRequest = workOrder.customerRequestId
      ? await CustomerRequest.findById(workOrder.customerRequestId).lean()
      : null;
    const isMeasurementConversion = customerRequest?.requestType === "measurement_conversion";

    let pieceOwner = null, siblingPieces = [], measurementDoc = null;
    if (isMeasurementConversion) {
      const empProgress = await EmployeeProductionProgress.findOne({
        workOrderId: workOrder._id,
        unitStart: { $lte: unitNumber },
        unitEnd:   { $gte: unitNumber },
      }).lean();

      if (empProgress) {
        pieceOwner = {
          employeeId:     empProgress.employeeId,
          employeeName:   empProgress.employeeName,
          employeeUIN:    empProgress.employeeUIN,
          gender:         empProgress.gender,
          unitStart:      empProgress.unitStart,
          unitEnd:        empProgress.unitEnd,
          totalUnits:     empProgress.totalUnits,
          completedUnits: empProgress.completedUnits,
          isDispatched:   empProgress.isDispatched,
        };
        const completedSet = new Set(empProgress.completedUnitNumbers || []);
        for (let u = empProgress.unitStart; u <= empProgress.unitEnd; u++) {
          if (u === unitNumber) continue;
          siblingPieces.push({
            unitNumber: u,
            barcodeId: `WO-${workOrderShortId}-${String(u).padStart(3, "0")}`,
            completed: completedSet.has(u),
          });
        }
      }
      if (customerRequest?.measurementId) {
        measurementDoc = await Measurement.findById(customerRequest.measurementId)
          .select("name organizationName")
          .lean();
      }
    }

    const trackingDocs = await ProductionTracking.find({
      "machines.operators.barcodeScans.barcodeId": barcode.trim(),
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const getEmployeeName = makeEmployeeNameCache();
    const operationLog = [];

    for (const doc of trackingDocs) {
      for (const machine of doc.machines) {
        for (const operator of machine.operators || []) {
          const operatorName = await getEmployeeName(operator.operatorIdentityId);
          for (const scan of operator.barcodeScans || []) {
            if (scan.barcodeId !== barcode.trim()) continue;
            const codes = Array.isArray(scan.activeOps)
              ? scan.activeOps
              : (scan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);

            const resolvedOps = codes.map((code) => {
              const op = (workOrder.operations || []).find(
                (o) => (o.operationCode || "").trim().toLowerCase() === code.trim().toLowerCase()
              );
              return op
                ? { code, name: op.operationType, plannedTimeSeconds: op.plannedTimeSeconds || 0 }
                : { code, name: "", plannedTimeSeconds: 0 };
            });

            operationLog.push({
              timestamp:     scan.timeStamp,
              trackingDate:  doc.date,
              machineId:     machine.machineId?._id,
              machineName:   machine.machineId?.name || "Unknown",
              machineSerial: machine.machineId?.serialNumber || "",
              machineType:   machine.machineId?.type || "",
              operatorId:    operator.operatorIdentityId,
              operatorName,
              signInTime:    operator.signInTime,
              signOutTime:   operator.signOutTime,
              operations:    resolvedOps,
            });
          }
        }
      }
    }
    operationLog.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    return res.json({
      success: true,
      barcode: barcode.trim(),
      unitNumber,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        workOrderShortId,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity,
        status: workOrder.status,
        variantAttributes: workOrder.variantAttributes || [],
        operations: (workOrder.operations || []).map((op, idx) => ({
          operationNumber: idx + 1,
          operationType:   op.operationType,
          operationCode:   op.operationCode || "",
          plannedTimeSeconds: op.plannedTimeSeconds || 0,
          status:          op.status,
        })),
      },
      manufacturingOrder: customerRequest
        ? {
            _id:              customerRequest._id,
            requestId:        customerRequest.requestId,
            moNumber:         `MO-${customerRequest.requestId}`,
            requestType:      customerRequest.requestType,
            customerName:     customerRequest.customerInfo?.name,
            customerPhone:    customerRequest.customerInfo?.phone,
            customerEmail:    customerRequest.customerInfo?.email,
            deliveryDeadline: customerRequest.customerInfo?.deliveryDeadline,
            status:           customerRequest.status,
            measurementName:  customerRequest.measurementName || null,
          }
        : null,
      isMeasurementConversion,
      pieceOwner,
      siblingPieces,
      measurement: measurementDoc,
      operationLog,
      totalScans: operationLog.length,
    });
  } catch (error) {
    console.error("Error finding piece:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;