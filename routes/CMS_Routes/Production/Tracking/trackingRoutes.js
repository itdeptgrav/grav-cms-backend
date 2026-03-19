// routes/CMS_Routes/Production/Tracking/trackingRoutes.js
// UPDATED: activeOps is now an array of operation code strings, not a comma-separated string.

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../models/ProductionTracking");
const Employee = require("../models/Employee");
const Machine = require("../models/Machine");
const WorkOrder = require("../models/WorkOrder");

let io;

router.use((req, res, next) => {
  io = req.app.get("io");
  next();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isBarcodeId = (id) => id && typeof id === "string" && id.startsWith("WO-");

const isEmployeeId = (id) => id && typeof id === "string" && id.startsWith("GR");

const parseBarcode = (barcodeId) => {
  try {
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
        operationNumber: parts[3] ? parseInt(parts[3]) : null,
      };
    }
    return { success: false, error: "Invalid barcode format" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({});
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch {
    return null;
  }
};

const extractEmployeeIdFromUrl = (value) => {
  try {
    if (!value || typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const url = new URL(trimmed);
      const parts = url.pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || value;
    }
    return value;
  } catch {
    return value;
  }
};

// Normalise whatever the device sends for activeOps into a clean string[].
// Accepts: string[] | string (comma-separated) | undefined/null → always returns string[]
// AFTER — handles all cases including ["MJ030,MJ020,MJ032"]
const normaliseActiveOps = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    // flatMap splits any element that is itself comma-separated e.g. ["MJ030,MJ020"]
    return raw
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
};

// ─── POST /scan ────────────────────────────────────────────────────────────────

router.post("/scan", async (req, res) => {
  try {
    const { scanId: rawScanId, machineId, timeStamp, activeOps } = req.body;
    const scanId = extractEmployeeIdFromUrl(rawScanId);

    if (!scanId || !machineId || !timeStamp) {
      return res.status(400).json({
        success: false,
        message: "scanId, machineId, and timeStamp are required",
      });
    }

    const scanTime = new Date(timeStamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid timeStamp format" });
    }

    const activeOpsCodes = normaliseActiveOps(activeOps); // always string[]

    const scanDate = new Date(scanTime);
    scanDate.setHours(0, 0, 0, 0);

    let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
    if (!trackingDoc) {
      trackingDoc = new ProductionTracking({ date: scanDate, machines: [] });
    }

    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(400).json({ success: false, message: "Machine not found" });
    }

    let machineTracking = trackingDoc.machines.find(
      (m) => m.machineId.toString() === machineId
    );
    if (!machineTracking) {
      trackingDoc.machines.push({ machineId, currentOperatorIdentityId: null, operators: [] });
      machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
    }

    // ─── BARCODE SCAN ──────────────────────────────────────────────────────────
    if (isBarcodeId(scanId)) {
      if (!machineTracking.currentOperatorIdentityId) {
        return res.status(400).json({
          success: false,
          message: "No operator is signed in on this machine",
          action: "error",
        });
      }

      const operatorTracking = machineTracking.operators.find(
        (op) =>
          op.operatorIdentityId === machineTracking.currentOperatorIdentityId &&
          !op.signOutTime
      );
      if (!operatorTracking) {
        return res.status(400).json({
          success: false,
          message: "Operator session not found",
        });
      }

      // Store scan with the array of active operation codes
      operatorTracking.barcodeScans.push({
        barcodeId: scanId,
        timeStamp: scanTime,
        activeOps: activeOpsCodes,
      });
      await trackingDoc.save();

      const employeeName = operatorTracking.operatorName || "Unknown";
      const scanCount    = operatorTracking.barcodeScans.length;

      // WebSocket events
      try {
        const parsedBarcode = parseBarcode(scanId);
        if (parsedBarcode.success && io) {
          let workOrder = await findWorkOrderByShortId(parsedBarcode.workOrderShortId);
          if (!workOrder) {
            try { workOrder = await WorkOrder.findById(parsedBarcode.workOrderShortId); } catch { }
          }

          if (workOrder) {
            io.to(`workorder-${workOrder._id}`).emit("workorder-scan-update", {
              workOrderId:     workOrder._id,
              workOrderNumber: workOrder.workOrderNumber,
              barcodeId:       scanId,
              unitNumber:      parsedBarcode.unitNumber,
              operationNumber: parsedBarcode.operationNumber,
              machineId,
              machineName: machine.name,
              timestamp:   scanTime,
              employeeName,
              activeOps:   activeOpsCodes, // array
              type:        "scan",
              scanCount,
            });
          }

          io.emit("tracking-data-updated", {
            date:        scanDate,
            timestamp:   new Date(),
            message:     "New scan recorded",
            workOrderId: workOrder?._id,
            unitNumber:  parsedBarcode.unitNumber,
            activeOps:   activeOpsCodes, // array
          });
        }
      } catch (wsError) {
        console.error("Error emitting WebSocket event:", wsError);
      }

      return res.json({
        success:      true,
        message:      "Barcode scanned",
        employeeName,
        scanCount,
        barcodeData:  { barcodeId: scanId, activeOps: activeOpsCodes },
      });
    }

    // ─── EMPLOYEE SIGN IN / OUT ────────────────────────────────────────────────
    if (isEmployeeId(scanId)) {
      const operator = await Employee.findOne({
        identityId:     scanId,
        needsToOperate: true,
        status:         "active",
      }).select("firstName lastName identityId");

      if (!operator) {
        return res.status(400).json({
          success: false,
          message: `Employee with identityId ${scanId} not found`,
        });
      }

      const employeeName = `${operator.firstName || ""} ${operator.lastName || ""}`.trim();

      // Sign out from any other machine they may be on
      for (const m of trackingDoc.machines) {
        if (
          m.currentOperatorIdentityId === scanId &&
          m.machineId.toString() !== machineId.toString()
        ) {
          const existingSession = m.operators.find(
            (op) => op.operatorIdentityId === scanId && !op.signOutTime
          );
          if (existingSession) existingSession.signOutTime = scanTime;
          m.currentOperatorIdentityId = null;
        }
      }

      // Same operator already signed in on THIS machine → sign out
      if (machineTracking.currentOperatorIdentityId === scanId) {
        const session = machineTracking.operators.find(
          (op) => op.operatorIdentityId === scanId && !op.signOutTime
        );
        if (session) {
          session.signOutTime = scanTime;
          machineTracking.currentOperatorIdentityId = null;
          await trackingDoc.save();

          try {
            if (io)
              io.emit("operator-status-update", {
                machineId,
                machineName: machine.name,
                employeeName,
                message:   `${employeeName} signed out`,
                timestamp: new Date(),
              });
          } catch { }

          return res.json({
            success:     true,
            message:     `${employeeName} signed out`,
            employeeName,
            employeeId:  scanId,
            action:      "signout",
            scanCount:   0,
          });
        }
        return res.status(400).json({
          success: false,
          message: "Operator session not found",
        });
      }

      // Different operator is signed in → sign out existing, sign in new
      if (machineTracking.currentOperatorIdentityId) {
        const existingSession = machineTracking.operators.find(
          (op) =>
            op.operatorIdentityId === machineTracking.currentOperatorIdentityId &&
            !op.signOutTime
        );
        if (existingSession) existingSession.signOutTime = scanTime;
      }

      machineTracking.operators.push({
        operatorIdentityId: scanId,
        operatorName:       employeeName,
        signInTime:         scanTime,
        signOutTime:        null,
        barcodeScans:       [],
      });
      machineTracking.currentOperatorIdentityId = scanId;
      await trackingDoc.save();

      try {
        if (io)
          io.emit("operator-status-update", {
            machineId,
            machineName: machine.name,
            employeeName,
            status:    `${employeeName} signed in to ${machine.name}`,
            timestamp: new Date(),
          });
      } catch { }

      return res.json({
        success:     true,
        message:     `${employeeName} signed in`,
        employeeName,
        employeeId:  scanId,
        action:      "signin",
        scanCount:   0,
      });
    }

    return res.status(400).json({ success: false, message: "Invalid scan ID format" });
  } catch (error) {
    console.error("Error processing scan:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing scan",
      error:   error.message,
    });
  }
});

// ─── POST /bulk-scans ──────────────────────────────────────────────────────────

router.post("/bulk-scans", async (req, res) => {
  try {
    const { scans } = req.body;
    if (!scans || !Array.isArray(scans) || scans.length === 0) {
      return res.status(400).json({ success: false, message: "Scans array is required" });
    }

    const results = { total: scans.length, successful: 0, failed: 0, errors: [] };
    const scansByDate = {};

    for (const scanData of scans) {
      const { scanId, machineId, timeStamp } = scanData;
      if (!scanId || !machineId || !timeStamp) {
        results.failed++;
        results.errors.push({ scanId, error: "Missing required fields" });
        continue;
      }
      const scanTime = new Date(timeStamp);
      if (isNaN(scanTime.getTime())) {
        results.failed++;
        results.errors.push({ scanId, error: "Invalid timestamp" });
        continue;
      }
      const scanDate = new Date(scanTime);
      scanDate.setHours(0, 0, 0, 0);
      const dateKey = scanDate.toISOString();
      if (!scansByDate[dateKey]) scansByDate[dateKey] = { date: scanDate, machines: {} };
      if (!scansByDate[dateKey].machines[machineId])
        scansByDate[dateKey].machines[machineId] = { machineId, scans: [] };
      scansByDate[dateKey].machines[machineId].scans.push({
        ...scanData,
        timeStamp:  scanTime,
        activeOps:  normaliseActiveOps(scanData.activeOps), // always array
      });
    }

    for (const dateKey in scansByDate) {
      const dateGroup = scansByDate[dateKey];
      let trackingDoc = await ProductionTracking.findOne({ date: dateGroup.date });
      if (!trackingDoc)
        trackingDoc = new ProductionTracking({ date: dateGroup.date, machines: [] });

      for (const machineId in dateGroup.machines) {
        const machineData = dateGroup.machines[machineId];
        const machine     = await Machine.findById(machineId);
        if (!machine) {
          results.failed += machineData.scans.length;
          results.errors.push({ machineId, error: "Machine not found" });
          continue;
        }

        let machineTracking = trackingDoc.machines.find(
          (m) => m.machineId && m.machineId.toString() === machineId
        );
        if (!machineTracking) {
          trackingDoc.machines.push({ machineId, currentOperatorIdentityId: null, operators: [] });
          machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
        }

        for (const scan of machineData.scans) {
          try {
            if (scan.isEmployeeScan) {
              const { employeeName, employeeId, action } = scan;
              if (action === "signout") {
                const session = machineTracking.operators.find(
                  (op) =>
                    op.operatorIdentityId === (employeeId || scan.scanId) && !op.signOutTime
                );
                if (session) {
                  session.signOutTime = scan.timeStamp;
                  machineTracking.currentOperatorIdentityId = null;
                }
              } else {
                if (machineTracking.currentOperatorIdentityId) {
                  const existing = machineTracking.operators.find(
                    (op) =>
                      op.operatorIdentityId === machineTracking.currentOperatorIdentityId &&
                      !op.signOutTime
                  );
                  if (existing) existing.signOutTime = scan.timeStamp;
                }
                machineTracking.operators.push({
                  operatorIdentityId: employeeId || scan.scanId,
                  operatorName:       employeeName || "",
                  signInTime:         scan.timeStamp,
                  signOutTime:        null,
                  barcodeScans:       [],
                });
                machineTracking.currentOperatorIdentityId = employeeId || scan.scanId;
              }
            } else {
              // Barcode scan — store with activeOps as array
              if (!machineTracking.currentOperatorIdentityId)
                throw new Error("No operator signed in");
              const operatorSession = machineTracking.operators.find(
                (op) =>
                  op.operatorIdentityId === machineTracking.currentOperatorIdentityId &&
                  !op.signOutTime
              );
              if (!operatorSession) throw new Error("Operator session not found");
              operatorSession.barcodeScans.push({
                barcodeId: scan.scanId,
                timeStamp: scan.timeStamp,
                activeOps: scan.activeOps, // already normalised above
              });
            }
            results.successful++;
          } catch (scanError) {
            results.failed++;
            results.errors.push({ scanId: scan.scanId, error: scanError.message });
          }
        }
      }
      await trackingDoc.save();
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${results.successful} of ${results.total} scans`,
      results,
    });
  } catch (error) {
    console.error("Bulk scan error:", error);
    res.status(500).json({
      success: false,
      message: "Server error processing bulk scans",
      error:   error.message,
    });
  }
});

// ─── GET /status/:date ─────────────────────────────────────────────────────────

router.get("/status/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({
        success: true, message: `No tracking data for ${date}`,
        date: queryDate, machines: [], totalScans: 0, totalMachines: 0,
      });
    }

    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operatorsWithDetails = [];

      for (const operator of machine.operators) {
        const employeeDoc = await Employee.findOne({ identityId: operator.operatorIdentityId })
          .select("firstName lastName identityId");

        machineScans += operator.barcodeScans.length;
        totalScans   += operator.barcodeScans.length;

        operatorsWithDetails.push({
          identityId: operator.operatorIdentityId,
          name:       employeeDoc
            ? `${employeeDoc.firstName} ${employeeDoc.lastName}`
            : "Unknown Operator",
          signInTime:  operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans.map((s) => ({
            barcodeId: s.barcodeId,
            timeStamp: s.timeStamp,
            activeOps: s.activeOps || [], // array
          })),
          scanCount: operator.barcodeScans.length,
          isActive:  !operator.signOutTime,
        });
      }

      let currentOperator = null;
      if (machine.currentOperatorIdentityId) {
        const empDoc = await Employee.findOne({
          identityId: machine.currentOperatorIdentityId,
        }).select("firstName lastName identityId");
        currentOperator = empDoc
          ? { identityId: empDoc.identityId, name: `${empDoc.firstName} ${empDoc.lastName}` }
          : { identityId: machine.currentOperatorIdentityId, name: "Unknown Operator" };
      }

      machinesStatus.push({
        machineId:     machine.machineId?._id,
        machineName:   machine.machineId?.name   || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        currentOperator,
        operators: operatorsWithDetails,
        machineScans,
      });
    }

    res.json({
      success: true,
      date:    trackingDoc.date,
      totalMachines: trackingDoc.machines.length,
      totalScans,
      machines: machinesStatus,
    });
  } catch (error) {
    console.error("Error getting date status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /status/today ─────────────────────────────────────────────────────────

router.get("/status/today", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({ date: today })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) {
      return res.json({
        success: true, message: "No tracking data for today",
        date: today, machines: [], totalScans: 0, totalMachines: 0,
      });
    }

    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operatorsWithDetails = [];

      for (const operator of machine.operators) {
        const employeeDoc = await Employee.findOne({ identityId: operator.operatorIdentityId })
          .select("firstName lastName identityId");

        machineScans += operator.barcodeScans.length;
        totalScans   += operator.barcodeScans.length;

        operatorsWithDetails.push({
          identityId: operator.operatorIdentityId,
          name:       employeeDoc
            ? `${employeeDoc.firstName} ${employeeDoc.lastName}`
            : "Unknown Operator",
          signInTime:  operator.signInTime,
          signOutTime: operator.signOutTime,
          barcodeScans: operator.barcodeScans.map((s) => ({
            barcodeId: s.barcodeId,
            timeStamp: s.timeStamp,
            activeOps: s.activeOps || [], // array
          })),
          scanCount: operator.barcodeScans.length,
          isActive:  !operator.signOutTime,
        });
      }

      let currentOperator = null;
      if (machine.currentOperatorIdentityId) {
        const empDoc = await Employee.findOne({
          identityId: machine.currentOperatorIdentityId,
        }).select("firstName lastName identityId");
        currentOperator = empDoc
          ? { identityId: empDoc.identityId, name: `${empDoc.firstName} ${empDoc.lastName}` }
          : { identityId: machine.currentOperatorIdentityId, name: "Unknown Operator" };
      }

      machinesStatus.push({
        machineId:     machine.machineId?._id,
        machineName:   machine.machineId?.name   || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        currentOperator,
        operators: operatorsWithDetails,
        machineScans,
      });
    }

    res.json({
      success: true,
      date:    trackingDoc.date,
      totalMachines: trackingDoc.machines.length,
      totalScans,
      machines: machinesStatus,
    });
  } catch (error) {
    console.error("Error getting today's status:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /machine/:machineId/operations ───────────────────────────────────────

router.get("/machine/:machineId/operations", async (req, res) => {
  try {
    const { machineId } = req.params;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({
      date: today,
      "machines.machineId": machineId,
    }).populate("machines.machineId", "name serialNumber type");

    if (!trackingDoc) {
      return res.json({
        success: true,
        message: "No tracking data for this machine today",
        machineId,
        operations: [],
      });
    }

    const machine = trackingDoc.machines.find(
      (m) => m.machineId.toString() === machineId
    );
    if (!machine) {
      return res.json({
        success: true,
        message: "Machine not found in today's tracking",
        machineId,
        operations: [],
      });
    }

    const operationMap = {};
    let totalScans = 0;

    machine.operators.forEach((op) => {
      totalScans += op.barcodeScans.length;
      op.barcodeScans.forEach((scan) => {
        const parts = scan.barcodeId?.split("-");
        if (parts?.[0] === "WO" && parts.length >= 3) {
          const woKey = parts[1];
          if (!operationMap[woKey])
            operationMap[woKey] = { shortId: woKey, scans: 0, operators: new Set() };
          operationMap[woKey].scans++;
          operationMap[woKey].operators.add(op.operatorIdentityId);
        }
      });
    });

    const operations = Object.values(operationMap).map((wo) => ({
      workOrderShortId: wo.shortId,
      scansCount:       wo.scans,
      operatorCount:    wo.operators.size,
      isActive:         !!machine.currentOperatorIdentityId,
    }));

    res.json({
      success:         true,
      machineId,
      machineName:     machine.machineId?.name,
      totalScans,
      isActive:        !!machine.currentOperatorIdentityId,
      currentOperator: machine.currentOperatorIdentityId,
      operations,
    });
  } catch (error) {
    console.error("Error getting machine operations:", error);
    res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;