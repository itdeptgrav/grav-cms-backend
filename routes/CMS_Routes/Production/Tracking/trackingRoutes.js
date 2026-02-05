// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - COMPLETELY UPDATED

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

let io;

// Initialize Socket.IO instance
router.use((req, res, next) => {
  io = req.app.get("io");
  next();
});

// Helper function to emit tracking updates
const emitTrackingUpdate = async (date) => {
  if (!io) return;

  try {
    // Fetch fresh tracking data
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    const trackingDoc = await ProductionTracking.findOne({
      date: queryDate,
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    if (!trackingDoc) return;

    // Calculate total scans
    let totalScans = 0;
    trackingDoc.machines.forEach((machine) => {
      machine.operationTracking?.forEach((op) => {
        totalScans +=
          op.operators?.reduce(
            (total, operator) => total + (operator.barcodeScans?.length || 0),
            0,
          ) || 0;
      });
    });

    // Emit to all interested clients
    io.emit("tracking-data-updated", {
      date: trackingDoc.date,
      totalScans: totalScans,
      totalMachines: trackingDoc.machines?.length || 0,
      timestamp: new Date(),
    });

    // Also emit to specific work orders if we can identify them
    // Collect all work orders from barcode scans
    const workOrderIds = new Set();

    trackingDoc.machines.forEach((machine) => {
      machine.operationTracking?.forEach((op) => {
        op.operators?.forEach((operator) => {
          operator.barcodeScans?.forEach((scan) => {
            if (scan.barcodeId && scan.barcodeId.startsWith("WO-")) {
              const parts = scan.barcodeId.split("-");
              if (parts.length >= 3) {
                const shortId = parts[1];
                // Find work order by short ID
                workOrderIds.add(shortId);
              }
            }
          });
        });
      });
    });

    // Convert short IDs to actual work order IDs and emit
    for (const shortId of workOrderIds) {
      const workOrder = await findWorkOrderByShortId(shortId);
      if (workOrder) {
        io.to(`workorder-${workOrder._id}`).emit("workorder-tracking-update", {
          workOrderId: workOrder._id,
          date: trackingDoc.date,
          timestamp: new Date(),
        });
      }
    }
  } catch (error) {
    console.error("Error emitting tracking update:", error);
  }
};

// Helper functions
const isBarcodeId = (id) => {
  return id && typeof id === "string" && id.startsWith("WO-");
};

const isEmployeeId = (id) => {
  return id && typeof id === "string" && id.startsWith("GR");
};

// Parse barcode to extract work order ID and unit number
const parseBarcode = (barcodeId) => {
  try {
    // Format: WO-[MongoID]-[Unit3]
    const parts = barcodeId.split("-");
    if (parts.length >= 3 && parts[0] === "WO") {
      return {
        success: true,
        workOrderShortId: parts[1],
        unitNumber: parseInt(parts[2]),
        operationNumber: parts[3] ? parseInt(parts[3]) : null, // If operation number is included
      };
    }
    return { success: false, error: "Invalid barcode format" };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// Helper to determine unit completion based on scan sequence
const determineUnitStatus = (unitNumber, allScans) => {
  // Get all units that have been scanned
  const scannedUnits = [...new Set(allScans.map((s) => s.unitNumber))];

  // Sort units by their first scan time
  scannedUnits.sort((a, b) => {
    const firstScanA = allScans.find((s) => s.unitNumber === a)?.timestamp;
    const firstScanB = allScans.find((s) => s.unitNumber === b)?.timestamp;
    return new Date(firstScanA) - new Date(firstScanB);
  });

  // Find the current/last scanned unit
  const lastScannedUnit =
    scannedUnits.length > 0 ? scannedUnits[scannedUnits.length - 1] : 0;

  // Check if this unit has been scanned
  const hasScans = allScans.some((s) => s.unitNumber === unitNumber);

  if (!hasScans) {
    return { status: "pending", isCurrent: false };
  }

  if (unitNumber === lastScannedUnit) {
    return { status: "in_progress", isCurrent: true };
  } else if (
    scannedUnits.includes(unitNumber) &&
    unitNumber < lastScannedUnit
  ) {
    return { status: "completed", isCurrent: false };
  } else {
    return { status: "in_progress", isCurrent: false };
  }
};

const findWorkOrderByShortId = async (shortId) => {
  try {
    const workOrders = await WorkOrder.find({});
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch (error) {
    return null;
  }
};

const extractEmployeeIdFromUrl = (value) => {
  try {
    if (!value || typeof value !== "string") return value;

    const trimmed = value.trim();

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const url = new URL(trimmed);
      const parts = url.pathname.split("/").filter(Boolean); // ["employee","GR045"]
      const lastPart = parts[parts.length - 1];
      return lastPart || value;
    }

    return value;
  } catch (err) {
    return value;
  }
};

router.post("/scan", async (req, res) => {
  try {
    const { scanId: rawScanId, machineId, timeStamp } = req.body;

    const scanId = extractEmployeeIdFromUrl(rawScanId);
<<<<<<< HEAD
=======

>>>>>>> origin/main

    // Validate required fields
    if (!scanId || !machineId || !timeStamp) {
      return res.status(400).json({
        success: false,
        message: "scanId, machineId, and timeStamp are required",
      });
    }

    // Parse timestamp
    const scanTime = new Date(timeStamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid timeStamp format",
      });
    }

    // Create date key
    const scanDate = new Date(scanTime);
    scanDate.setHours(0, 0, 0, 0);

    // Find or create tracking document
    let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
    if (!trackingDoc) {
      trackingDoc = new ProductionTracking({ date: scanDate });
    }

    // Validate machine exists
    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(400).json({
        success: false,
        message: "Machine not found",
      });
    }

    // Find or create machine tracking
    let machineTracking = trackingDoc.machines.find(
      (m) => m.machineId.toString() === machineId,
    );

    if (!machineTracking) {
      machineTracking = {
        machineId: machineId,
        operationTracking: [],
      };
      trackingDoc.machines.push(machineTracking);
      machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
    }

    // -------------------- BARCODE SCAN (FAST + NO WORKORDER CHECK) --------------------
    if (isBarcodeId(scanId)) {
      // Must have signed-in operator
      const operationTracking = machineTracking.operationTracking.find(
        (op) => op.currentOperatorIdentityId,
      );

      if (!operationTracking) {
        return res.status(400).json({
          success: false,
          message: "No operator is signed in on this machine",
        });
      }

      const operatorTracking = operationTracking.operators.find(
        (op) =>
          op.operatorIdentityId ===
            operationTracking.currentOperatorIdentityId && !op.signOutTime,
      );

      if (!operatorTracking) {
        return res.status(400).json({
          success: false,
          message: "Operator session not found",
        });
      }

      // Just save scan directly (NO WO SEARCH)
      operatorTracking.barcodeScans.push({
        barcodeId: scanId,
        timeStamp: scanTime,
      });

      await trackingDoc.save();

      const employeeName = operatorTracking.operatorName || "Unknown";
      const scanCount = operatorTracking.barcodeScans.length;

      // ============ WEBSOCKET EMIT WITH ERROR HANDLING ============
      // If it's a barcode scan, emit work order specific update
      try {
        const parsedBarcode = parseBarcode(scanId);
        if (parsedBarcode.success) {
          console.log("📡 Parsed barcode data:", {
            barcodeId: scanId,
            shortId: parsedBarcode.workOrderShortId,
            unitNumber: parsedBarcode.unitNumber,
            operationNumber: parsedBarcode.operationNumber,
          });

          const workOrder = await findWorkOrderByShortId(
            parsedBarcode.workOrderShortId,
          );

          if (workOrder) {
            console.log("✅ Found work order:", workOrder._id);
            console.log("📡 Work order number:", workOrder.workOrderNumber);

            if (io) {
              const roomName = `workorder-${workOrder._id}`;

              // Emit to specific work order room
              io.to(roomName).emit("workorder-scan-update", {
                workOrderId: workOrder._id,
                workOrderNumber: workOrder.workOrderNumber,
                barcodeId: scanId,
                unitNumber: parsedBarcode.unitNumber,
                operationNumber: parsedBarcode.operationNumber,
                machineId: machineId,
                machineName: machine.name,
                timestamp: scanTime,
                employeeName: employeeName,
                type: "scan",
                scanCount: scanCount,
              });

              console.log(`📢 Emitted to room: ${roomName}`);

              // Also emit general tracking update
              io.emit("tracking-data-updated", {
                date: scanDate,
                timestamp: new Date(),
                message: "New scan recorded",
                workOrderId: workOrder._id,
                unitNumber: parsedBarcode.unitNumber,
              });

              console.log("📢 Emitted general tracking update");
            } else {
              console.warn("⚠️ WebSocket (io) not available");
            }
          } else {
            console.warn(
              "⚠️ Work order not found for short ID:",
              parsedBarcode.workOrderShortId,
            );

            // Try to find work order by full ID if short ID doesn't work
            // If your barcode contains the full work order ID, try that:
            if (scanId.includes("WO-")) {
              const parts = scanId.split("-");
              if (parts.length >= 2) {
                // Try to find by full ID (parts[1] might be the full Mongo ID)
                const possibleWorkOrderId = parts[1];
                try {
                  const workOrderByFullId =
                    await WorkOrder.findById(possibleWorkOrderId);
                  if (workOrderByFullId && io) {
                    io.to(`workorder-${workOrderByFullId._id}`).emit(
                      "workorder-scan-update",
                      {
                        workOrderId: workOrderByFullId._id,
                        workOrderNumber: workOrderByFullId.workOrderNumber,
                        barcodeId: scanId,
                        unitNumber: parsedBarcode.unitNumber,
                        operationNumber: parsedBarcode.operationNumber,
                        machineId: machineId,
                        machineName: machine.name,
                        timestamp: scanTime,
                        employeeName: employeeName,
                        type: "scan",
                        scanCount: scanCount,
                      },
                    );
                    console.log(
                      `📢 Emitted using full ID to room: workorder-${workOrderByFullId._id}`,
                    );
                  }
                } catch (idError) {
                  console.error(
                    "Error finding work order by full ID:",
                    idError,
                  );
                }
              }
            }
          }
        } else {
          console.warn("⚠️ Failed to parse barcode:", parsedBarcode.error);
        }
      } catch (wsError) {
        console.error("❌ Error emitting WebSocket event:", wsError);
        // Don't fail the scan if WebSocket fails - scan was already saved
      }
      // ============ END WEBSOCKET EMIT ============

      return res.json({
        success: true,
        message: "New Barcode scanned",
        employeeName,
        scanCount,
        barcodeData: {
          barcodeId: scanId,
        },
      });
    }

    // -------------------- EMPLOYEE SIGN IN/OUT --------------------
    if (isEmployeeId(scanId)) {
      const operator = await Employee.findOne({
        identityId: scanId,
        needsToOperate: true,
        status: "active",
      }).select("firstName lastName identityId");

      if (!operator) {
        return res.status(400).json({
          success: false,
          message: `Employee with identityId ${scanId} not found`,
        });
      }

      let targetOperationNumber = 1;
      let targetOperationType = "Default Operation";

      const allWorkOrders = await WorkOrder.find({
        "operations.assignedMachine": machineId,
      }).select("operations");

      if (allWorkOrders.length > 0) {
        const workOrder = allWorkOrders[0];
        const operation = workOrder.operations.find(
          (op) =>
            op.assignedMachine && op.assignedMachine.toString() === machineId,
        );
        if (operation) {
          targetOperationNumber = workOrder.operations.indexOf(operation) + 1;
          targetOperationType = operation.operationType;
        }
      }

      let operationTracking = machineTracking.operationTracking.find(
        (op) => op.operationNumber === targetOperationNumber,
      );

      if (!operationTracking) {
        operationTracking = {
          operationNumber: targetOperationNumber,
          operationType: targetOperationType,
          currentOperatorIdentityId: null,
          operators: [],
        };
        machineTracking.operationTracking.push(operationTracking);
        operationTracking =
          machineTracking.operationTracking[
            machineTracking.operationTracking.length - 1
          ];
      }

      const employeeName =
        `${operator.firstName || ""} ${operator.lastName || ""}`.trim();

      // Someone already signed in
      if (operationTracking.currentOperatorIdentityId) {
        if (operationTracking.currentOperatorIdentityId === scanId) {
          // Sign out
          const operatorTracking = operationTracking.operators.find(
            (op) => op.operatorIdentityId === scanId && !op.signOutTime,
          );

          if (operatorTracking) {
            operatorTracking.signOutTime = scanTime;
            operationTracking.currentOperatorIdentityId = null;

            await trackingDoc.save();

            // Emit operator sign-out event
            try {
              if (io) {
                io.emit("operator-status-update", {
                  machineId: machineId,
                  machineName: machine.name,
                  employeeName: employeeName,
                  status: "signed_out",
                  timestamp: new Date(),
                });
              }
            } catch (wsError) {
              console.error("Error emitting operator status update:", wsError);
            }

            return res.json({
              success: true,
              message: `${employeeName} signed out from ${machine.name}`,
              employeeName,
              scanCount: 0,
            });
          }

          return res.status(400).json({
            success: false,
            message: "Operator session not found",
          });
        } else {
          // Different operator: sign out existing and sign in new
          const existingOperatorId =
            operationTracking.currentOperatorIdentityId;

          const existingOperatorTracking = operationTracking.operators.find(
            (op) =>
              op.operatorIdentityId === existingOperatorId && !op.signOutTime,
          );

          if (existingOperatorTracking) {
            existingOperatorTracking.signOutTime = scanTime;
          }

          operationTracking.operators.push({
            operatorIdentityId: scanId,
            operatorName: employeeName,
            signInTime: scanTime,
            signOutTime: null,
            barcodeScans: [],
          });

          operationTracking.currentOperatorIdentityId = scanId;

          await trackingDoc.save();

          // Emit operator sign-in event
          try {
            if (io) {
              io.emit("operator-status-update", {
                machineId: machineId,
                machineName: machine.name,
                employeeName: employeeName,
                status: `${employeeName} signed in to ${machine.name}`,
                timestamp: new Date(),
              });
            }
          } catch (wsError) {
            console.error("Error emitting operator status update:", wsError);
          }

          return res.json({
            success: true,
            message: `${employeeName} signed in to ${machine.name}`,
            employeeName,
            scanCount: 0,
          });
        }
      }

      // No one signed in -> sign in
      const existingOperator = operationTracking.operators.find(
        (op) => op.operatorIdentityId === scanId && !op.signOutTime,
      );

      if (existingOperator) {
        return res.status(400).json({
          success: false,
          message: "Operator already signed in and not signed out",
        });
      }

      operationTracking.operators.push({
        operatorIdentityId: scanId,
        operatorName: employeeName,
        signInTime: scanTime,
        signOutTime: null,
        barcodeScans: [],
      });

      operationTracking.currentOperatorIdentityId = scanId;

      await trackingDoc.save();

      // Emit operator sign-in event
      try {
        if (io) {
          io.emit("operator-status-update", {
            machineId: machineId,
            machineName: machine.name,
            employeeName: employeeName,
            status: "signed_in",
            timestamp: new Date(),
          });
        }
      } catch (wsError) {
        console.error("Error emitting operator status update:", wsError);
      }

      return res.json({
        success: true,
        message: `Signed in`,
        employeeName,
        scanCount: 0,
      });
    }

    // -------------------- INVALID --------------------
    return res.status(400).json({
      success: false,
      message: "Invalid scan ID format",
    });
  } catch (error) {
    console.error("Error processing scan:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing scan",
      error: error.message,
    });
  }
});

// basically sometime the scan id is coming as https

router.get("/status/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const queryDate = new Date(date);
    queryDate.setHours(0, 0, 0, 0);

    console.log("Fetching tracking for date:", queryDate);

    const trackingDoc = await ProductionTracking.findOne({
      date: queryDate,
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean(); // Use lean() for better performance

    console.log("Found tracking doc:", trackingDoc ? "Yes" : "No");

    if (!trackingDoc) {
      return res.json({
        success: true,
        message: `No tracking data for ${date}`,
        date: queryDate,
        machines: [],
        totalScans: 0,
        totalMachines: 0,
      });
    }

    // Calculate total scans and get details
    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operationStatus = [];

      // Process each operation on this machine
      for (const op of machine.operationTracking) {
        const operationScans = op.operators.reduce(
          (total, operator) => total + operator.barcodeScans.length,
          0,
        );
        machineScans += operationScans;
        totalScans += operationScans;

        // Get current operator details
        let currentOperator = null;
        if (op.currentOperatorIdentityId) {
          const operator = await Employee.findOne({
            identityId: op.currentOperatorIdentityId,
          }).select("firstName lastName identityId");

          currentOperator = operator
            ? {
                identityId: operator.identityId,
                name: `${operator.firstName} ${operator.lastName}`,
              }
            : {
                identityId: op.currentOperatorIdentityId,
                name: "Unknown Operator",
              };
        }

        // Get all operator details for this operation
        const operatorsWithDetails = [];
        for (const operator of op.operators) {
          const operatorDetails = await Employee.findOne({
            identityId: operator.operatorIdentityId,
          }).select("firstName lastName identityId");

          operatorsWithDetails.push({
            identityId: operator.operatorIdentityId,
            name: operatorDetails
              ? `${operatorDetails.firstName} ${operatorDetails.lastName}`
              : "Unknown Operator",
            signInTime: operator.signInTime,
            signOutTime: operator.signOutTime,
            barcodeScans: operator.barcodeScans.map((scan) => ({
              barcodeId: scan.barcodeId,
              timeStamp: scan.timeStamp,
            })),
            scanCount: operator.barcodeScans.length,
          });
        }

        operationStatus.push({
          operationNumber: op.operationNumber,
          operationType: op.operationType,
          currentOperator: currentOperator,
          operators: operatorsWithDetails,
          operationScans: operationScans,
        });
      }

      machinesStatus.push({
        machineId: machine.machineId?._id,
        machineName: machine.machineId?.name || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        operationStatus: operationStatus,
        machineScans: machineScans,
      });
    }

    console.log(
      `Returning ${machinesStatus.length} machines with ${totalScans} total scans`,
    );

    res.json({
      success: true,
      date: trackingDoc.date,
      totalMachines: trackingDoc.machines.length,
      totalScans: totalScans,
      machines: machinesStatus,
    });
  } catch (error) {
    console.error("Error getting date status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while getting date status",
      error: error.message,
    });
  }
});

// Also update the /status/today endpoint to use the same logic:
router.get("/status/today", async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    console.log("Fetching tracking for today:", today);

    const trackingDoc = await ProductionTracking.findOne({
      date: today,
    })
      .populate("machines.machineId", "name serialNumber type")
      .lean();

    console.log("Found tracking doc for today:", trackingDoc ? "Yes" : "No");

    if (!trackingDoc) {
      return res.json({
        success: true,
        message: "No tracking data for today",
        date: today,
        machines: [],
        totalScans: 0,
        totalMachines: 0,
      });
    }

    // Calculate total scans and get details
    let totalScans = 0;
    const machinesStatus = [];

    for (const machine of trackingDoc.machines) {
      let machineScans = 0;
      const operationStatus = [];

      // Process each operation on this machine
      for (const op of machine.operationTracking) {
        const operationScans = op.operators.reduce(
          (total, operator) => total + operator.barcodeScans.length,
          0,
        );
        machineScans += operationScans;
        totalScans += operationScans;

        // Get current operator details
        let currentOperator = null;
        if (op.currentOperatorIdentityId) {
          const operator = await Employee.findOne({
            identityId: op.currentOperatorIdentityId,
          }).select("firstName lastName identityId");

          currentOperator = operator
            ? {
                identityId: operator.identityId,
                name: `${operator.firstName} ${operator.lastName}`,
              }
            : {
                identityId: op.currentOperatorIdentityId,
                name: "Unknown Operator",
              };
        }

        // Get all operator details for this operation
        const operatorsWithDetails = [];
        for (const operator of op.operators) {
          const operatorDetails = await Employee.findOne({
            identityId: operator.operatorIdentityId,
          }).select("firstName lastName identityId");

          operatorsWithDetails.push({
            identityId: operator.operatorIdentityId,
            name: operatorDetails
              ? `${operatorDetails.firstName} ${operatorDetails.lastName}`
              : "Unknown Operator",
            signInTime: operator.signInTime,
            signOutTime: operator.signOutTime,
            barcodeScans: operator.barcodeScans.map((scan) => ({
              barcodeId: scan.barcodeId,
              timeStamp: scan.timeStamp,
            })),
            scanCount: operator.barcodeScans.length,
          });
        }

        operationStatus.push({
          operationNumber: op.operationNumber,
          operationType: op.operationType,
          currentOperator: currentOperator,
          operators: operatorsWithDetails,
          operationScans: operationScans,
        });
      }

      machinesStatus.push({
        machineId: machine.machineId?._id,
        machineName: machine.machineId?.name || "Unknown Machine",
        machineSerial: machine.machineId?.serialNumber || "Unknown",
        operationStatus: operationStatus,
        machineScans: machineScans,
      });
    }

    console.log(
      `Returning ${machinesStatus.length} machines with ${totalScans} total scans for today`,
    );

    res.json({
      success: true,
      date: trackingDoc.date,
      totalMachines: trackingDoc.machines.length,
      totalScans: totalScans,
      machines: machinesStatus,
    });
  } catch (error) {
    console.error("Error getting today's status:", error);
    res.status(500).json({
      success: false,
      message: "Server error while getting today's status",
      error: error.message,
    });
  }
});

// New endpoint: Get machine operation status
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
        machineId: machineId,
        operations: [],
      });
    }

    const machine = trackingDoc.machines.find(
      (m) => m.machineId.toString() === machineId,
    );

    if (!machine) {
      return res.json({
        success: true,
        message: "Machine not found in today's tracking",
        machineId: machineId,
        operations: [],
      });
    }

    const operations = await Promise.all(
      machine.operationTracking.map(async (op) => {
        // Get current operator details
        let currentOperator = null;
        if (op.currentOperatorIdentityId) {
          const operator = await Employee.findOne({
            identityId: op.currentOperatorIdentityId,
          }).select("firstName lastName identityId");

          currentOperator = operator
            ? {
                identityId: operator.identityId,
                name: `${operator.firstName} ${operator.lastName}`,
              }
            : {
                identityId: op.currentOperatorIdentityId,
                name: "Unknown Operator",
              };
        }

        // Calculate scans for this operation
        const totalScans = op.operators.reduce(
          (total, operator) => total + operator.barcodeScans.length,
          0,
        );

        return {
          operationNumber: op.operationNumber,
          operationType: op.operationType,
          currentOperator: currentOperator,
          totalScans: totalScans,
          operatorCount: op.operators.length,
          isActive: op.currentOperatorIdentityId !== null,
        };
      }),
    );

    res.json({
      success: true,
      machineId: machineId,
      machineName: machine.machineId?.name,
      operations: operations,
    });
  } catch (error) {
    console.error("Error getting machine operations:", error);
    res.status(500).json({
      success: false,
      message: "Server error while getting machine operations",
      error: error.message,
    });
  }
});

module.exports = router;
