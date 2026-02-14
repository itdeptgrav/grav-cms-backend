// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - COMPLETELY UPDATED

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");



// Helper functions
const isBarcodeId = (id) => id && typeof id === "string" && id.startsWith("WO-");
const isEmployeeId = (id) => id && typeof id === "string" && id.startsWith("GR");

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
  } catch (err) {
    return value;
  }
};

router.post("/scan", async (req, res) => {
  try {
    const { scanId: rawScanId, machineId, timeStamp } = req.body;
    const scanId = extractEmployeeIdFromUrl(rawScanId);

    // Quick validation
    if (!scanId || !machineId || !timeStamp) {
      return res.status(400).json({
        success: false,
        message: "scanId, machineId, and timeStamp are required"
      });
    }

    const scanTime = new Date(timeStamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({
        success: false,
        message: "Invalid timeStamp format"
      });
    }

    // Get today's date
    const scanDate = new Date(scanTime);
    scanDate.setHours(0, 0, 0, 0);

    // Get or create tracking doc - use upsert for speed
    let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
    if (!trackingDoc) {
      trackingDoc = new ProductionTracking({ 
        date: scanDate,
        machines: [] 
      });
    }

    // Fast machine validation
    const machine = await Machine.findById(machineId).select("name").lean();
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: "Machine not found"
      });
    }

    // Find or create machine tracking
    let machineTracking = trackingDoc.machines.find(
      m => m.machineId && m.machineId.toString() === machineId
    );

    if (!machineTracking) {
      machineTracking = {
        machineId: machineId,
        operationTracking: []
      };
      trackingDoc.machines.push(machineTracking);
    }

    // -------------------- BARCODE SCAN (OPTIMIZED) --------------------
    if (isBarcodeId(scanId)) {
      // Fast operator check
      const operationTracking = machineTracking.operationTracking.find(
        op => op.currentOperatorIdentityId
      );

      if (!operationTracking) {
        return res.status(403).json({
          success: false,
          message: "No operator signed in"
        });
      }

      const operatorTracking = operationTracking.operators?.find(
        op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
      );

      if (!operatorTracking) {
        return res.status(404).json({
          success: false,
          message: "Operator session not found"
        });
      }

      // Save scan
      operatorTracking.barcodeScans = operatorTracking.barcodeScans || [];
      operatorTracking.barcodeScans.push({
        barcodeId: scanId,
        timeStamp: scanTime
      });

      await trackingDoc.save();

      // Fast response - no WebSocket
      return res.status(202).json({
        success: true,
        message: "New Scan recorded"
      });
    }

    // -------------------- EMPLOYEE SIGN IN/OUT (OPTIMIZED) --------------------
    if (isEmployeeId(scanId)) {
      // Quick employee lookup
      const operator = await Employee.findOne({
        identityId: scanId,
        status: "active"
      }).select("firstName lastName identityId").lean();

      if (!operator) {
        return res.status(404).json({
          success: false,
          message: "Employee not found"
        });
      }

      const employeeName = `${operator.firstName || ""} ${operator.lastName || ""}`.trim();

      // Simple operation tracking - default to operation 1
      let operationTracking = machineTracking.operationTracking.find(
        op => op.operationNumber === 1
      );

      if (!operationTracking) {
        operationTracking = {
          operationNumber: 1,
          operationType: "Default",
          currentOperatorIdentityId: null,
          operators: []
        };
        machineTracking.operationTracking.push(operationTracking);
      }

      // Handle sign in/out
      if (operationTracking.currentOperatorIdentityId) {
        // Someone is signed in
        if (operationTracking.currentOperatorIdentityId === scanId) {
          // Sign out current operator
          const currentOp = operationTracking.operators?.find(
            op => op.operatorIdentityId === scanId && !op.signOutTime
          );
          
          if (currentOp) {
            currentOp.signOutTime = scanTime;
            operationTracking.currentOperatorIdentityId = null;
            await trackingDoc.save();

            return res.status(200).json({
              success: true,
              message: `${employeeName} signed out`,
              employeeName: employeeName,
              action: "signout"
            });
          }
        } else {
          // Auto sign out previous and sign in new
          const prevOp = operationTracking.operators?.find(
            op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
          );
          if (prevOp) prevOp.signOutTime = scanTime;
        }
      }

      // Sign in new operator
      if (!operationTracking.operators) operationTracking.operators = [];
      
      operationTracking.operators.push({
        operatorIdentityId: scanId,
        operatorName: employeeName,
        signInTime: scanTime,
        signOutTime: null,
        barcodeScans: []
      });

      operationTracking.currentOperatorIdentityId = scanId;
      await trackingDoc.save();

      return res.status(201).json({
        success: true,
        message: `${employeeName} signed in`,
        employeeName: employeeName,
        action: "signin"
      });
    }

    // Invalid format
    return res.status(400).json({
      success: false,
      message: "Invalid scan format"
    });

  } catch (error) {
    console.error("Scan error:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
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




// 