// routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes.js
//
// Operation tracking concept:
//   Every barcodeScan carries an `activeOps` array of operation CODE strings
//   (e.g. ["SJ-01", "BA-03"]) sent by the device.
//   We match those codes against the WO's operations[].operationCode (case-insensitive).
//   A single scan can credit multiple operations simultaneously.
//   Machine assignment is NOT used — machines are identified purely from scan data.

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Employee = require("../../../../models/Employee");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");

const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
const Measurement = require("../../../../models/Customer_Models/Measurement");

router.use(EmployeeAuthMiddleware);

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

const getManufacturingOrder = async (customerRequestId) => {
  try {
    return await CustomerRequest.findById(customerRequestId)
      .select("requestId customerInfo moNumber status priority")
      .lean();
  } catch {
    return null;
  }
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

// ─── Resolve activeOps (array of codes) → matched WO operation numbers ───────
// activeOps: string[] of operation codes from device, e.g. ["SJ-01", "BA-03"]
// Matches against workOrder.operations[].operationCode (case-insensitive).
// Returns array of 1-based operation numbers that matched.
const resolveActiveOpsCodesToOperationNumbers = (activeOps, workOrderOperations) => {
  if (!activeOps?.length || !workOrderOperations?.length) return [];

  // Normalise — handle legacy comma-string sent by older device firmware
  let codes;
  if (Array.isArray(activeOps)) {
    codes = activeOps.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  } else if (typeof activeOps === "string") {
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
};

// ─── Enrich scans using scan.activeOps codes matched to WO operations ─────────
const enrichScansWithActiveOps = (scans, workOrder) => {
  const ops = workOrder.operations || [];
  const enriched = [];

  for (const scan of scans) {
    const matchedOpNums = resolveActiveOpsCodesToOperationNumbers(scan.activeOps, ops);

    if (matchedOpNums.length > 0) {
      for (const opNum of matchedOpNums) {
        enriched.push({ ...scan, operationNumber: opNum });
      }
    } else {
      // No operation matched — still count the scan
      enriched.push({ ...scan, operationNumber: null });
    }
  }
  return enriched;
};

// ─── Calculate unit positions from enriched scans ────────────────────────────
const calculateUnitPositions = (enrichedScans, workOrderOperations, totalUnits) => {
  const unitPositions = {};
  const totalOps = workOrderOperations.length;

  for (let i = 1; i <= totalUnits; i++) {
    unitPositions[i] = {
      currentOperation: 0,
      completedOperations: [],
      lastScanTime: null,
      currentMachine: null,
      currentOperator: null,
      isMoving: false,
      status: "pending",
    };
  }

  if (totalOps === 0) {
    enrichedScans.forEach((scan) => {
      const parsed = parseBarcode(scan.barcodeId);
      if (parsed.success && parsed.unitNumber && unitPositions[parsed.unitNumber]) {
        const u = unitPositions[parsed.unitNumber];
        u.status = "in_progress";
        u.lastScanTime = scan.timestamp || scan.timeStamp;
        u.currentMachine = scan.machineName;
        u.currentOperator = scan.operatorName;
      }
    });
    return unitPositions;
  }

  const scansByUnitOp = new Map();
  enrichedScans.forEach((scan) => {
    const parsed = parseBarcode(scan.barcodeId);
    if (!parsed.success || !parsed.unitNumber || !scan.operationNumber) return;
    const key = `${parsed.unitNumber}-${scan.operationNumber}`;
    if (!scansByUnitOp.has(key)) scansByUnitOp.set(key, []);
    scansByUnitOp.get(key).push({ ...scan, timestamp: scan.timestamp || scan.timeStamp });
  });

  for (let unitNum = 1; unitNum <= totalUnits; unitNum++) {
    const unit = unitPositions[unitNum];
    const completedOps = [];

    for (let opNum = 1; opNum <= totalOps; opNum++) {
      const scansForOp = scansByUnitOp.get(`${unitNum}-${opNum}`);
      if (scansForOp?.length > 0) {
        completedOps.push(opNum);
        const latest = scansForOp[scansForOp.length - 1];
        unit.lastScanTime = latest.timestamp;
        unit.currentMachine = latest.machineName;
        unit.currentOperator = latest.operatorName;
      }
    }

    unit.completedOperations = completedOps.sort((a, b) => a - b);

    if (unit.completedOperations.length === totalOps && totalOps > 0) {
      unit.currentOperation = totalOps;
      unit.status = "completed";
      unit.isMoving = false;
    } else if (unit.completedOperations.length > 0) {
      unit.currentOperation = unit.completedOperations[unit.completedOperations.length - 1];
      unit.status = "in_progress";
      unit.isMoving = unit.lastScanTime
        ? Date.now() - new Date(unit.lastScanTime) < 300000
        : false;
    }
  }

  return unitPositions;
};

// ─── Per-operation completion counts from enriched scans ─────────────────────
const calculateProductionCompletion = (enrichedScans, workOrderOperations, totalUnits) => {
  const totalOps = workOrderOperations.length;

  if (totalOps === 0) {
    const uniqueUnits = new Set(
      enrichedScans
        .map((s) => parseBarcode(s.barcodeId))
        .filter((p) => p.success)
        .map((p) => p.unitNumber)
    );
    return {
      operationCompletion: [{
        operationNumber: 1,
        operationType: "Production",
        operationCode: "",
        totalQuantity: totalUnits,
        completedQuantity: uniqueUnits.size,
        completionPercentage: totalUnits > 0
          ? Math.round((uniqueUnits.size / totalUnits) * 100) : 0,
      }],
    };
  }

  const operationCompletion = [];
  for (let opNum = 1; opNum <= totalOps; opNum++) {
    const op = workOrderOperations[opNum - 1];
    const uniqueUnits = new Set();
    enrichedScans.forEach((scan) => {
      if (scan.operationNumber === opNum) {
        const parsed = parseBarcode(scan.barcodeId);
        if (parsed.success && parsed.unitNumber) uniqueUnits.add(parsed.unitNumber);
      }
    });
    operationCompletion.push({
      operationNumber: opNum,
      operationType: op.operationType || `Operation ${opNum}`,
      operationCode: op.operationCode || "",
      totalQuantity: totalUnits,
      completedQuantity: uniqueUnits.size,
      completionPercentage: totalUnits > 0
        ? Math.round((uniqueUnits.size / totalUnits) * 100) : 0,
    });
  }
  return { operationCompletion };
};

const calculateEmployeeEfficiency = (scans, plannedTimePerUnit) => {
  if (scans.length < 2)
    return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };
  const sorted = [...scans].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const diff = (new Date(sorted[i].timestamp) - new Date(sorted[i - 1].timestamp)) / 1000;
    if (diff > 0 && diff < 3600) gaps.push(diff);
  }
  if (!gaps.length)
    return { avgTimePerUnit: 0, efficiency: 0, scansPerHour: 0, totalProductiveTime: 0 };
  const avg = gaps.reduce((s, t) => s + t, 0) / gaps.length;
  const totalProductiveTime = gaps.reduce((s, t) => s + t, 0);
  return {
    avgTimePerUnit: Math.round(avg),
    efficiency: plannedTimePerUnit
      ? Math.min(100, Math.round((plannedTimePerUnit / avg) * 100)) : 0,
    scansPerHour: Math.round((scans.length / (totalProductiveTime || 1)) * 3600 * 10) / 10,
    totalProductiveTime: Math.round(totalProductiveTime),
  };
};


router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
 
    if (!q || q.trim().length < 2) {
      return res.json({
        success: true,
        products: [],
        message: "Enter at least 2 characters to search",
      });
    }
 
    const searchTerm = q.trim();
    console.log(`🔍 Searching products for: "${searchTerm}"`);
 
    // Search by name OR additionalNames
    const products = await StockItem.find({
      $or: [
        { name: { $regex: searchTerm, $options: "i" } },
        { additionalNames: { $elemMatch: { $regex: searchTerm, $options: "i" } } },
      ],
    })
      .select("_id name reference additionalNames genderCategory operations status")
      .limit(15)
      .lean();
 
    console.log(`Found ${products.length} products matching "${searchTerm}"`);
 
    const enrichedProducts = products.map((p) => {
      // Only include ops that have an operationCode
      const ops = (p.operations || [])
        .filter((op) => op.operationCode)
        .map((op, idx) => ({
          _id: op._id || `${p._id}-op-${idx}`,
          operationType: op.type || op.operationType || `Operation ${idx + 1}`,
          operationCode: op.operationCode,
          // StockItem operations use minutes/seconds/totalSeconds fields
          plannedTimeSeconds:
            op.totalSeconds ||
            (op.minutes || 0) * 60 + (op.seconds || 0) ||
            0,
          status: "active",
        }));
 
      // Which alt name matched the query (for display hint under result)
      const matchedAltName =
        (p.additionalNames || []).find((n) =>
          n.toLowerCase().includes(searchTerm.toLowerCase())
        ) || null;
 
      return {
        _id: p._id,
        name: p.name,
        reference: p.reference,
        additionalNames: p.additionalNames || [],
        matchedAltName,
        genderCategory: p.genderCategory || "",
        operationCount: ops.length,
        operations: ops,
        status: p.status || "In Stock",
      };
    });
 
    // Sort: exact name match → alt-name match → partial
    enrichedProducts.sort((a, b) => {
      const aExact = a.name.toLowerCase() === searchTerm.toLowerCase() ? 0 : 1;
      const bExact = b.name.toLowerCase() === searchTerm.toLowerCase() ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return (a.matchedAltName ? 0 : 1) - (b.matchedAltName ? 0 : 1);
    });
 
    res.json({
      success: true,
      products: enrichedProducts,
      total: enrichedProducts.length,
    });
  } catch (error) {
    console.error("Error searching products:", error);
    res.status(500).json({
      success: false,
      message: "Server error while searching products",
      error: error.message,
    });
  }
});

// ============================================================================
// MACHINE STATUS
// ============================================================================
router.get("/machine-status", async (req, res) => {
  try {
    const allMachines = await Machine.find({}).lean();
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const todayDate = new Date(istNow.toISOString().split("T")[0]);
    todayDate.setHours(0, 0, 0, 0);

    const todayTracking = await ProductionTracking.findOne({ date: todayDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    // Build active map from scan data — no WO assignment needed
    const activeTodayMap = new Map();
    const machineWOMap = new Map(); // machineId → Set of WO shortIds scanned

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
      const mId = machine._id.toString();
      const isActiveNow = activeTodayMap.get(mId) || false;
      const woShortIds = machineWOMap.get(mId) || new Set();

      let status = "free";
      if (["Under Maintenance", "maintenance"].includes(machine.status)) status = "maintenance";
      else if (["Offline", "offline"].includes(machine.status)) status = "offline";
      else if (isActiveNow) status = "busy";

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
// CURRENT PRODUCTION  ← Main dashboard feed
// ============================================================================
router.get("/current-production", async (req, res) => {
  try {
    const { date } = req.query;
    let queryDate;
    if (date) {
      queryDate = new Date(date);
      queryDate.setHours(0, 0, 0, 0);
    } else {
      const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
      queryDate = new Date(istNow.toISOString().split("T")[0]);
      queryDate.setHours(0, 0, 0, 0);
    }

    console.log("📊 Fetching production data for IST date:", queryDate.toISOString());

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({
        success: true,
        message: "No production data for this date",
        date: queryDate,
        activeWorkOrders: [],
        machines: [],
        totalScans: 0,
        stats: {
          totalActiveWorkOrders: 0,
          totalMachinesUsed: 0,
          totalActiveMachines: 0,
        },
      });
    }

    const getEmployeeName = makeEmployeeNameCache();

    // ── 1. Build per-machine info + collect scans grouped by WO short ID ─────
    const workOrderScans = new Map(); // woShortId → scan[]
    const machineDataMap = new Map(); // machineId → machineInfo
    let totalScans = 0;

    for (const machine of trackingDoc.machines) {
      const machineId = machine.machineId?._id?.toString();
      if (!machineId) continue;

      const hasCurrentOperator = !!machine.currentOperatorIdentityId;

      machineDataMap.set(machineId, {
        machineId,
        machineName: machine.machineId?.name || "Unknown",
        machineSerial: machine.machineId?.serialNumber || "N/A",
        machineType: machine.machineId?.type || "Unknown",
        totalScans: 0,
        operators: [],
        operatorList: [],
        status: hasCurrentOperator ? "active" : "idle",
        currentOperator: hasCurrentOperator ? machine.currentOperatorIdentityId : null,
        isActive: hasCurrentOperator,
        // WO short IDs scanned on this machine today (derived from scan data)
        workOrdersScanned: new Set(),
        // Operation codes active on this machine right now (from last scan of active operators)
        currentActiveOpCodes: new Set(),
      });

      const machineInfo = machineDataMap.get(machineId);

      for (const operator of machine.operators || []) {
        const operatorName = await getEmployeeName(operator.operatorIdentityId);

        machineInfo.operatorList.push({
          operatorIdentityId: operator.operatorIdentityId,
          operatorName,
          signInTime: operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans || [],
        });

        const scanCount = (operator.barcodeScans || []).length;

        const existingOp = machineInfo.operators.find(
          (o) => o.operatorId === operator.operatorIdentityId
        );
        if (!existingOp) {
          machineInfo.operators.push({
            operatorId: operator.operatorIdentityId,
            operatorName,
            scans: scanCount,
            signInTime: operator.signInTime,
            isActive: !operator.signOutTime,
          });
        } else {
          existingOp.scans += scanCount;
        }

        // Track currently active op codes (from last scan of non-signed-out operators)
        if (!operator.signOutTime && operator.barcodeScans?.length > 0) {
          const lastScan = operator.barcodeScans[operator.barcodeScans.length - 1];
          const codes = Array.isArray(lastScan.activeOps)
            ? lastScan.activeOps
            : (lastScan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);
          codes.forEach((c) => machineInfo.currentActiveOpCodes.add(c));
        }

        if (scanCount === 0) continue;

        totalScans += scanCount;
        machineInfo.totalScans += scanCount;
        if (machineInfo.status === "idle") machineInfo.status = "used_today";

        // Group scans by WO short ID
        for (const scan of operator.barcodeScans) {
          const parsed = parseBarcode(scan.barcodeId);
          if (!parsed.success) continue;

          const woShortId = parsed.workOrderShortId;
          machineInfo.workOrdersScanned.add(woShortId);

          if (!workOrderScans.has(woShortId)) workOrderScans.set(woShortId, []);
          workOrderScans.get(woShortId).push({
            barcodeId: scan.barcodeId,
            unitNumber: parsed.unitNumber,
            // activeOps is now a string[] of operation codes
            activeOps: Array.isArray(scan.activeOps)
              ? scan.activeOps
              : (scan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean),
            machineId,
            machineName: machine.machineId?.name,
            operatorId: operator.operatorIdentityId,
            operatorName,
            timestamp: scan.timeStamp,
          });
        }
      }

      // Serialise Sets for JSON output
      machineInfo.workOrdersScanned = Array.from(machineInfo.workOrdersScanned);
      machineInfo.currentActiveOpCodes = Array.from(machineInfo.currentActiveOpCodes);
    }

    // ── 2. Build active work orders ──────────────────────────────────────────
    const activeWorkOrders = [];

    for (const [woShortId, scans] of workOrderScans) {
      const workOrder = await findWorkOrderByShortId(woShortId);
      if (!workOrder) continue;

      // Enrich scans using activeOps codes matched against this WO's operations
      const enrichedScans = enrichScansWithActiveOps(scans, workOrder);

      const manufacturingOrder = await getManufacturingOrder(workOrder.customerRequestId);

      const unitPositions = calculateUnitPositions(
        enrichedScans,
        workOrder.operations || [],
        workOrder.quantity
      );

      const productionCompletion = calculateProductionCompletion(
        enrichedScans,
        workOrder.operations || [],
        workOrder.quantity
      );

      const completedUnits = Object.values(unitPositions).filter(
        (u) => u.status === "completed"
      ).length;
      const inProgressUnits = Object.values(unitPositions).filter(
        (u) => u.status === "in_progress"
      ).length;

      const operationDistribution = {};
      for (let i = 0; i <= (workOrder.operations?.length || 0) + 1; i++)
        operationDistribution[i] = 0;
      Object.values(unitPositions).forEach((u) => {
        operationDistribution[u.currentOperation] =
          (operationDistribution[u.currentOperation] || 0) + 1;
      });

      // Employee metrics
      const employeeScansMap = new Map();
      enrichedScans.forEach((scan) => {
        if (!employeeScansMap.has(scan.operatorId)) {
          employeeScansMap.set(scan.operatorId, {
            operatorId: scan.operatorId,
            operatorName: scan.operatorName,
            scans: [],
            machines: new Set(),
          });
        }
        const empData = employeeScansMap.get(scan.operatorId);
        empData.scans.push(scan);
        empData.machines.add(scan.machineName);
      });

      const woMachineIds = new Set(scans.map((s) => s.machineId));
      for (const [mId, machineInfo] of machineDataMap) {
        if (!woMachineIds.has(mId)) continue;
        for (const opr of machineInfo.operatorList || []) {
          if (opr.signOutTime) continue;
          if (employeeScansMap.has(opr.operatorIdentityId)) continue;
          const hasWOScans = (opr.barcodeScans || []).some((s) => {
            const p = parseBarcode(s.barcodeId);
            return p.success && p.workOrderShortId === woShortId;
          });
          if (!hasWOScans) {
            employeeScansMap.set(opr.operatorIdentityId, {
              operatorId: opr.operatorIdentityId,
              operatorName: opr.operatorName,
              scans: [],
              machines: new Set([machineInfo.machineName]),
              isSignedInOnly: true,
            });
          }
        }
      }

      const employeeMetrics = [];
      for (const [, data] of employeeScansMap) {
        const plannedTime = workOrder.operations?.[0]?.plannedTimeSeconds || 0;
        const eff = calculateEmployeeEfficiency(data.scans, plannedTime);
        employeeMetrics.push({
          operatorId: data.operatorId,
          operatorName: data.operatorName,
          totalScans: data.scans.length,
          machinesUsed: Array.from(data.machines),
          isSignedInOnly: data.isSignedInOnly || false,
          ...eff,
        });
      }

      // Active operation CODES on this WO right now (from currently signed-in operators)
      const currentActiveOpCodesSet = new Set();
      for (const [mId, machineInfo] of machineDataMap) {
        if (!woMachineIds.has(mId)) continue;
        machineInfo.currentActiveOpCodes?.forEach((c) => currentActiveOpCodesSet.add(c));
      }

      // Resolve active codes to operation labels for display
      const currentActiveOps = workOrder.operations
        ?.filter((op) =>
          op.operationCode &&
          currentActiveOpCodesSet.has(op.operationCode.trim().toLowerCase())
        )
        .map((op) => ({
          code: op.operationCode,
          name: op.operationType,
        })) || [];

      activeWorkOrders.push({
        workOrderId: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        workOrderShortId: woShortId,
        stockItemName: workOrder.stockItemName,
        quantity: workOrder.quantity,
        status: workOrder.status,
        priority: workOrder.priority,
        manufacturingOrder: manufacturingOrder
          ? {
              id: manufacturingOrder._id,
              moNumber: `MO-${manufacturingOrder.requestId}`,
              customerName: manufacturingOrder.customerInfo?.name,
            }
          : null,
        operations: (workOrder.operations || []).map((op) => ({
          _id: op._id,
          operationType: op.operationType,
          operationCode: op.operationCode || "",
          plannedTimeSeconds: op.plannedTimeSeconds || 0,
          status: op.status,
        })),
        totalScans: enrichedScans.length,
        completedUnits,
        inProgressUnits,
        pendingUnits: workOrder.quantity - completedUnits - inProgressUnits,
        completionPercentage:
          workOrder.quantity > 0
            ? Math.round((completedUnits / workOrder.quantity) * 100)
            : 0,
        unitPositions,
        operationDistribution,
        productionCompletion,
        woProductionCompletion: workOrder.productionCompletion || null,
        employeeMetrics,
        // Array of { code, name } for operations active RIGHT NOW
        currentActiveOps,
        lastScanTime:
          enrichedScans.length > 0
            ? enrichedScans[enrichedScans.length - 1]?.timestamp
            : null,
      });
    }

    activeWorkOrders.sort((a, b) => {
      if (!a.lastScanTime) return 1;
      if (!b.lastScanTime) return -1;
      return new Date(b.lastScanTime) - new Date(a.lastScanTime);
    });

    // Serialise machine data for response
    const machinesForResponse = Array.from(machineDataMap.values()).map((m) => ({
      ...m,
      workOrdersScanned: Array.isArray(m.workOrdersScanned)
        ? m.workOrdersScanned
        : Array.from(m.workOrdersScanned || []),
      currentActiveOpCodes: Array.isArray(m.currentActiveOpCodes)
        ? m.currentActiveOpCodes
        : Array.from(m.currentActiveOpCodes || []),
    }));

    res.json({
      success: true,
      date: queryDate,
      totalScans,
      activeWorkOrders,
      machines: machinesForResponse,
      stats: {
        totalActiveWorkOrders: activeWorkOrders.length,
        totalMachinesUsed: machinesForResponse.filter((m) => m.status !== "idle").length,
        totalActiveMachines: machinesForResponse.filter((m) => m.status === "active").length,
      },
    });
  } catch (error) {
    console.error("Error fetching current production:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// ALL MACHINES
// ============================================================================
router.get("/all-machines", async (req, res) => {
  try {
    const { date } = req.query;
    let queryDate = date
      ? new Date(date)
      : new Date(new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0]);
    queryDate.setHours(0, 0, 0, 0);

    const allMachines = await Machine.find({}).lean();
    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId")
      .lean();

    const getEmployeeName = makeEmployeeNameCache();

    const machineStatusMap = new Map();
    allMachines.forEach((machine) => {
      machineStatusMap.set(machine._id.toString(), {
        _id: machine._id,
        name: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        status: machine.status,
        location: machine.location,
        dailyStatus: "idle",
        totalScans: 0,
        operators: [],
        workOrders: [],          // WO short IDs scanned on this machine
        currentActiveOpCodes: [], // op codes active right now
        currentOperator: null,
        isActive: false,
      });
    });

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineId = machine.machineId?._id?.toString();
        if (!machineId || !machineStatusMap.has(machineId)) continue;

        const machineStatus = machineStatusMap.get(machineId);

        if (machine.currentOperatorIdentityId) {
          machineStatus.isActive = true;
          machineStatus.dailyStatus = "active";
          machineStatus.currentOperator = { operatorId: machine.currentOperatorIdentityId };
        }

        let totalScans = 0;
        const operators = [];
        const workOrderSet = new Set();
        const activeOpCodesSet = new Set();

        for (const operator of machine.operators || []) {
          const operatorName = await getEmployeeName(operator.operatorIdentityId);
          const scanCount = operator.barcodeScans?.length || 0;
          totalScans += scanCount;

          const isActive = !operator.signOutTime;
          if (scanCount > 0 || isActive) {
            operators.push({
              operatorId: operator.operatorIdentityId,
              operatorName,
              scans: scanCount,
              signInTime: operator.signInTime,
              signOutTime: operator.signOutTime,
              isActive,
            });
          }

          // Track op codes from last scan of active operators
          if (isActive && operator.barcodeScans?.length > 0) {
            const lastScan = operator.barcodeScans[operator.barcodeScans.length - 1];
            const codes = Array.isArray(lastScan.activeOps)
              ? lastScan.activeOps
              : (lastScan.activeOps || "").split(",").map((s) => s.trim()).filter(Boolean);
            codes.forEach((c) => activeOpCodesSet.add(c));
          }

          (operator.barcodeScans || []).forEach((scan) => {
            const parsed = parseBarcode(scan.barcodeId);
            if (parsed.success) workOrderSet.add(parsed.workOrderShortId);
          });
        }

        machineStatus.totalScans = totalScans;
        machineStatus.operators = operators;
        machineStatus.workOrders = Array.from(workOrderSet);
        machineStatus.currentActiveOpCodes = Array.from(activeOpCodesSet);
        if (totalScans > 0 && machineStatus.dailyStatus === "idle") {
          machineStatus.dailyStatus = "used_today";
        }
      }
    }

    const machinesArray = Array.from(machineStatusMap.values());
    res.json({
      success: true,
      date: queryDate,
      machines: machinesArray,
      stats: {
        total: allMachines.length,
        active: machinesArray.filter((m) => m.isActive).length,
        usedToday: machinesArray.filter((m) => ["used_today", "active"].includes(m.dailyStatus)).length,
        idle: machinesArray.filter((m) => m.dailyStatus === "idle").length,
      },
    });
  } catch (error) {
    console.error("Error fetching machines:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// OPERATORS
// ============================================================================
router.get("/operators", async (req, res) => {
  try {
    const operators = await Employee.find({})
      .select("firstName lastName identityId biometricId")
      .lean();
    res.json({
      success: true,
      operators: operators.map((op) => ({
        _id: op._id,
        identityId: op.identityId || op.biometricId,
        name: `${op.firstName || ""} ${op.lastName || ""}`.trim(),
        firstName: op.firstName,
        lastName: op.lastName,
      })),
      total: operators.length,
    });
  } catch (error) {
    console.error("Error fetching operators:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ============================================================================
// OPERATOR DETAILS
// ============================================================================
router.get("/operator-details", async (req, res) => {
  try {
    const { operatorId, date } = req.query;
    let queryDate = date
      ? new Date(date)
      : new Date(new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0]);
    queryDate.setHours(0, 0, 0, 0);

    const employee = await Employee.findOne({
      $or: [{ identityId: operatorId }, { biometricId: operatorId }, { _id: operatorId }],
    }).select("firstName lastName identityId biometricId department designation").lean();

    if (!employee) {
      return res.json({
        success: true,
        details: { name: operatorId, department: "Unknown", designation: "Operator" },
      });
    }

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    const sessions = [];
    let totalScans = 0;

    if (trackingDoc) {
      for (const machine of trackingDoc.machines) {
        const machineName = machine.machineId?.name || "Unknown";
        for (const operator of machine.operators || []) {
          const isThisOperator =
            operator.operatorIdentityId === operatorId ||
            operator.operatorIdentityId === employee.identityId ||
            operator.operatorIdentityId === employee.biometricId;
          if (!isThisOperator) continue;

          const scanCount = operator.barcodeScans?.length || 0;
          totalScans += scanCount;
          sessions.push({
            machineId: machine.machineId?._id,
            machineName,
            signInTime: operator.signInTime,
            signOutTime: operator.signOutTime,
            isCurrent: !operator.signOutTime,
            scansCount: scanCount,
            barcodeScans: operator.barcodeScans || [],
          });
        }
      }
    }

    let avgTimeBetweenScans = 0, scansPerHour = 0;
    if (totalScans > 1) {
      const allScans = sessions.flatMap((s) => s.barcodeScans);
      const sorted = allScans.sort(
        (a, b) => new Date(a.timeStamp) - new Date(b.timeStamp)
      );
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const diff = (new Date(sorted[i].timeStamp) - new Date(sorted[i - 1].timeStamp)) / 1000;
        if (diff > 0 && diff < 28800) gaps.push(diff);
      }
      if (gaps.length > 0) {
        avgTimeBetweenScans = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
        scansPerHour = Math.round((3600 / avgTimeBetweenScans) * 10) / 10;
      }
    }

    res.json({
      success: true,
      details: {
        name: `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
        identityId: employee.identityId || employee.biometricId,
        department: employee.department || "Production",
        designation: employee.designation || "Operator",
        sessions: sessions.sort((a, b) => new Date(b.signInTime) - new Date(a.signInTime)),
        totalScans,
        avgTimeBetweenScans,
        scansPerHour,
        efficiency: avgTimeBetweenScans > 0
          ? Math.round((3600 / avgTimeBetweenScans) * 100) : 0,
      },
    });
  } catch (error) {
    console.error("Error fetching operator details:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});


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

    // ── MO / CustomerRequest ──────────────────────────────────────────────
    const customerRequest = workOrder.customerRequestId
      ? await CustomerRequest.findById(workOrder.customerRequestId).lean()
      : null;

    const isMeasurementConversion = customerRequest?.requestType === "measurement_conversion";

    // ── Piece owner (measurement-to-PO only) ──────────────────────────────
    let pieceOwner = null;
    let siblingPieces = [];
    let measurementDoc = null;

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

    // ── Operation log across ALL tracking docs for this exact barcode ────
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
        _id:                 workOrder._id,
        workOrderNumber:     workOrder.workOrderNumber,
        workOrderShortId,
        stockItemName:       workOrder.stockItemName,
        stockItemReference:  workOrder.stockItemReference,
        quantity:            workOrder.quantity,
        status:              workOrder.status,
        variantAttributes:   workOrder.variantAttributes || [],
        operations: (workOrder.operations || []).map((op, idx) => ({
          operationNumber:    idx + 1,
          operationType:      op.operationType,
          operationCode:      op.operationCode || "",
          plannedTimeSeconds: op.plannedTimeSeconds || 0,
          status:             op.status,
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