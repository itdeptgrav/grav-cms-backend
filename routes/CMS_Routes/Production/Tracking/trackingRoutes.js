// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - COMPLETELY UPDATED

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

// Helper functions
const isBarcodeId = (id) => {
  return id && typeof id === "string" && id.startsWith("WO-");
};

const isEmployeeId = (id) => {
  return id && typeof id === "string" && id.startsWith("GR-");
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

// Find work order by short ID
const findWorkOrderByShortId = async (shortId) => {
  try {
    // Find work order where the last 8 characters of _id match the shortId
    const workOrders = await WorkOrder.find({});
    return workOrders.find((wo) => wo._id.toString().slice(-8) === shortId);
  } catch (error) {
    return null;
  }
};

// POST - Process scan (MAJOR UPDATE)
router.post("/scan", async (req, res) => {
  try {
    const { scanId, machineId, timeStamp } = req.body;

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

    // Handle barcode scan
    if (isBarcodeId(scanId)) {
      // Parse barcode
      const barcodeInfo = parseBarcode(scanId);
      if (!barcodeInfo.success) {
        return res.status(400).json({
          success: false,
          message: barcodeInfo.error,
        });
      }

      // Find work order to get operation details
      const workOrder = await findWorkOrderByShortId(
        barcodeInfo.workOrderShortId,
      );
      if (!workOrder) {
        return res.status(400).json({
          success: false,
          message: "Work order not found for this barcode",
        });
      }

      // Check which operation this machine is assigned to in the work order
      let currentOperation = null;
      let operationNumber = 1; // Default to first operation

      // Find if this machine is assigned to any operation in the work order
      for (let i = 0; i < workOrder.operations.length; i++) {
        const op = workOrder.operations[i];
        if (op.assignedMachine && op.assignedMachine.toString() === machineId) {
          currentOperation = op;
          operationNumber = i + 1;
          break;
        }
      }

      // If machine not assigned to any operation, use first operation as default
      if (!currentOperation && workOrder.operations.length > 0) {
        currentOperation = workOrder.operations[0];
        operationNumber = 1;
      }

      if (!currentOperation) {
        return res.status(400).json({
          success: false,
          message: "No operation assigned to this machine",
        });
      }

      // Find or create operation tracking for this machine
      let operationTracking = machineTracking.operationTracking.find(
        (op) => op.operationNumber === operationNumber,
      );

      if (!operationTracking) {
        operationTracking = {
          operationNumber: operationNumber,
          operationType: currentOperation.operationType,
          currentOperatorIdentityId: null,
          operators: [],
        };
        machineTracking.operationTracking.push(operationTracking);
        operationTracking =
          machineTracking.operationTracking[
            machineTracking.operationTracking.length - 1
          ];
      }

      // Check if operator is signed in to this operation
      if (!operationTracking.currentOperatorIdentityId) {
        return res.status(400).json({
          success: false,
          message: `No operator is currently signed in to Operation ${operationNumber}`,
        });
      }

      // Find current operator's active session for this operation
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

      // Add barcode scan
      operatorTracking.barcodeScans.push({
        barcodeId: scanId,
        timeStamp: scanTime,
        operationNumber: operationNumber,
      });

      await trackingDoc.save();

      return res.json({
        success: true,
        message: `Unit ${barcodeInfo.unitNumber} scanned for Operation ${operationNumber} (${currentOperation.operationType})`,
        action: "barcode_scan",
        barcodeId: scanId,
        unitNumber: barcodeInfo.unitNumber,
        operationNumber: operationNumber,
        operationType: currentOperation.operationType,
        machineId: machineId,
        machineName: machine.name,
        scanTime: scanTime,
      });
    } else if (isEmployeeId(scanId)) {
      // Handle employee sign in/out

      // Find employee
      const operator = await Employee.findOne({
        identityId: scanId,
        needsToOperate: true,
        status: "active",
      });

      if (!operator) {
        return res.status(400).json({
          success: false,
          message: `Employee with identityId ${scanId} not found`,
        });
      }

      // Ask which operation the operator wants to work on (for multi-operation machines)
      // For now, we'll use the first operation assigned to this machine
      // In a real system, you'd have a UI to select operation

      let targetOperationNumber = 1;
      let targetOperationType = "Default Operation";

      // Find work orders that have operations assigned to this machine
      const allWorkOrders = await WorkOrder.find({
        "operations.assignedMachine": machineId,
      });

      if (allWorkOrders.length > 0) {
        // Use the first work order's operation assigned to this machine
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

      // Find or create operation tracking
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

      // Check if someone is already signed in to this operation
      if (operationTracking.currentOperatorIdentityId) {
        if (operationTracking.currentOperatorIdentityId === scanId) {
          // Same operator - sign out
          const operatorTracking = operationTracking.operators.find(
            (op) => op.operatorIdentityId === scanId && !op.signOutTime,
          );

          if (operatorTracking) {
            operatorTracking.signOutTime = scanTime;
            operationTracking.currentOperatorIdentityId = null;

            await trackingDoc.save();

            return res.json({
              success: true,
              message: `Operator signed out from Operation ${targetOperationNumber}`,
              action: "sign_out",
              identityId: scanId,
              operationNumber: targetOperationNumber,
              machineId: machineId,
              signOutTime: scanTime,
            });
          }
        } else {
          // Different operator - sign out existing, sign in new
          const existingOperatorId =
            operationTracking.currentOperatorIdentityId;
          const existingOperator = await Employee.findOne({
            identityId: existingOperatorId,
          });

          // Sign out existing operator
          const existingOperatorTracking = operationTracking.operators.find(
            (op) =>
              op.operatorIdentityId === existingOperatorId && !op.signOutTime,
          );

          if (existingOperatorTracking) {
            existingOperatorTracking.signOutTime = scanTime;
          }

          // Sign in new operator
          operationTracking.operators.push({
            operatorIdentityId: scanId,
            signInTime: scanTime,
            signOutTime: null,
            barcodeScans: [],
          });

          operationTracking.currentOperatorIdentityId = scanId;

          await trackingDoc.save();

          return res.json({
            success: true,
            message: `Operator ${operator.firstName} ${operator.lastName} signed in to Operation ${targetOperationNumber}. Previous operator was signed out.`,
            action: "sign_in_with_signout",
            identityId: scanId,
            operationNumber: targetOperationNumber,
            machineId: machineId,
            signInTime: scanTime,
            previousOperatorId: existingOperatorId,
          });
        }
      } else {
        // No one signed in - sign in new operator
        // Check if operator has existing session in this operation
        const existingOperator = operationTracking.operators.find(
          (op) => op.operatorIdentityId === scanId && !op.signOutTime,
        );

        if (existingOperator) {
          return res.status(400).json({
            success: false,
            message: "Operator already signed in and not signed out",
          });
        }

        // Sign in new operator
        operationTracking.operators.push({
          operatorIdentityId: scanId,
          signInTime: scanTime,
          signOutTime: null,
          barcodeScans: [],
        });

        operationTracking.currentOperatorIdentityId = scanId;

        await trackingDoc.save();

        return res.json({
          success: true,
          message: `Operator ${operator.firstName} ${operator.lastName} signed in to Operation ${targetOperationNumber}`,
          action: "sign_in",
          identityId: scanId,
          operationNumber: targetOperationNumber,
          machineId: machineId,
          signInTime: scanTime,
        });
      }
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid scan ID format",
      });
    }
  } catch (error) {
    console.error("Error processing scan:", error);
    res.status(500).json({
      success: false,
      message: "Server error while processing scan",
      error: error.message,
    });
  }
});

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
