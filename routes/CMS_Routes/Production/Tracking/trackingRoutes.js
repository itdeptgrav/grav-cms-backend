// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - SCHEMA COMPLIANT VERSION

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

// Helper functions
const isEmployeeId = (id) => id && typeof id === "string" && id.startsWith("GR");
const isBarcodeId = (id) => id && typeof id === "string" && id.startsWith("WO-");

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

// ==================== SCAN ENDPOINT - SCHEMA COMPLIANT ====================
router.post("/scan", async (req, res) => {
  try {
    const { scanId: rawScanId, machineId, timeStamp } = req.body;
    const scanId = extractEmployeeIdFromUrl(rawScanId);

    // Basic validation
    if (!scanId || !machineId || !timeStamp) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    const scanTime = new Date(timeStamp);
    if (isNaN(scanTime.getTime())) {
      return res.status(400).json({ success: false, message: "Invalid timestamp" });
    }

    // Get today's date
    const scanDate = new Date(scanTime);
    scanDate.setHours(0, 0, 0, 0);

    // Find or create tracking document
    let trackingDoc = await ProductionTracking.findOne({ date: scanDate });
    if (!trackingDoc) {
      trackingDoc = new ProductionTracking({ 
        date: scanDate, 
        machines: [] 
      });
    }

    // Check machine exists
    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(404).json({ success: false, message: "Machine not found" });
    }

    // ==================== EMPLOYEE SIGN IN/OUT ====================
    if (isEmployeeId(scanId)) {
      // Find employee
      const operator = await Employee.findOne({
        identityId: scanId,
        needsToOperate: true,
        status: "active"
      });

      if (!operator) {
        return res.status(404).json({ 
          success: false, 
          message: "Employee not found or not authorized" 
        });
      }

      const employeeName = `${operator.firstName || ""} ${operator.lastName || ""}`.trim();

      // CRITICAL FIX: Find or create machine tracking USING MONGOOSE SUBDOCUMENT
      let machineTracking = trackingDoc.machines.find(
        m => m.machineId && m.machineId.toString() === machineId
      );

      if (!machineTracking) {
        // Create proper Mongoose subdocument
        machineTracking = trackingDoc.machines.create({ 
          machineId: machineId,
          operationTracking: [] 
        });
        trackingDoc.machines.push(machineTracking);
      }

      // CRITICAL FIX: Find or create operation tracking USING MONGOOSE SUBDOCUMENT
      const operationNumber = 1;
      let operationTracking = machineTracking.operationTracking.find(
        op => op.operationNumber === operationNumber
      );

      if (!operationTracking) {
        // Create proper Mongoose subdocument
        operationTracking = machineTracking.operationTracking.create({
          operationNumber: operationNumber,
          operationType: "Default Operation",
          currentOperatorIdentityId: null,
          operators: []
        });
        machineTracking.operationTracking.push(operationTracking);
      }

      // Handle sign in/out
      
      // CASE 1: Same operator signing out
      if (operationTracking.currentOperatorIdentityId === scanId) {
        // Find the operator's session
        const operatorSession = operationTracking.operators.find(
          op => op.operatorIdentityId === scanId && !op.signOutTime
        );

        if (operatorSession) {
          operatorSession.signOutTime = scanTime;
          operationTracking.currentOperatorIdentityId = null;
          
          await trackingDoc.save();
          
          return res.status(200).json({
            success: true,
            message: `${employeeName} signed out`,
            employeeName: employeeName,
            action: "signout"
          });
        }
      }
      
      // CASE 2: Different operator signing in - sign out previous
      if (operationTracking.currentOperatorIdentityId && 
          operationTracking.currentOperatorIdentityId !== scanId) {
        
        const prevOperator = operationTracking.operators.find(
          op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
        );
        
        if (prevOperator) {
          prevOperator.signOutTime = scanTime;
        }
      }

      // Check if operator already has an active session
      const existingSession = operationTracking.operators.find(
        op => op.operatorIdentityId === scanId && !op.signOutTime
      );

      if (existingSession) {
        return res.status(400).json({
          success: false,
          message: "Operator already has an active session"
        });
      }

      // Sign in new operator - create proper Mongoose subdocument
      const newOperatorSession = operationTracking.operators.create({
        operatorIdentityId: scanId,
        operatorName: employeeName,
        signInTime: scanTime,
        signOutTime: null,
        barcodeScans: []
      });

      operationTracking.operators.push(newOperatorSession);
      operationTracking.currentOperatorIdentityId = scanId;

      // Save to database
      await trackingDoc.save();

      console.log("Successfully saved operator. Document state:");
      console.log("Machine Tracking ID:", machineTracking._id);
      console.log("Operation Tracking ID:", operationTracking._id);
      console.log("Operator Session ID:", newOperatorSession._id);

      return res.status(201).json({
        success: true,
        message: `${employeeName} signed in`,
        employeeName: employeeName,
        action: "signin"
      });
    }

    // ==================== BARCODE SCAN ====================
    if (isBarcodeId(scanId)) {
      // Find machine tracking
      const machineTracking = trackingDoc.machines.find(
        m => m.machineId && m.machineId.toString() === machineId
      );

      if (!machineTracking) {
        return res.status(400).json({ 
          success: false, 
          message: "No operator signed in - machine not found" 
        });
      }

      // Find operation with signed-in operator
      const operationTracking = machineTracking.operationTracking.find(
        op => op.currentOperatorIdentityId
      );

      if (!operationTracking) {
        return res.status(400).json({ 
          success: false, 
          message: "No operator signed in" 
        });
      }

      // Find operator session
      const operatorSession = operationTracking.operators.find(
        op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
      );

      if (!operatorSession) {
        return res.status(400).json({ 
          success: false, 
          message: "Operator session not found" 
        });
      }

      // Create barcode scan subdocument
      const newBarcodeScan = operatorSession.barcodeScans.create({
        barcodeId: scanId,
        timeStamp: scanTime
      });

      operatorSession.barcodeScans.push(newBarcodeScan);

      await trackingDoc.save();

      return res.status(202).json({
        success: true,
        message: "New Barcode scanned",
        employeeName: operatorSession.operatorName
      });
    }

    return res.status(400).json({ 
      success: false, 
      message: "Invalid scan format" 
    });

  } catch (error) {
    console.error("Scan error:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error",
      error: error.message 
    });
  }
});


// ==================== BULK SCANS ENDPOINT ====================
router.post("/bulk-scans", async (req, res) => {
  try {
    const { scans } = req.body;

    if (!scans || !Array.isArray(scans) || scans.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Scans array is required"
      });
    }

    console.log(`Processing ${scans.length} bulk scans`);

    const results = {
      total: scans.length,
      successful: 0,
      failed: 0,
      errors: []
    };

    // Group scans by date for efficient processing
    const scansByDate = {};

    for (const scanData of scans) {
      const { scanId, machineId, timeStamp, isEmployeeScan, employeeId, employeeName, action } = scanData;

      // Validate required fields
      if (!scanId || !machineId || !timeStamp) {
        results.failed++;
        results.errors.push({ scanId, error: "Missing required fields" });
        continue;
      }

      // Parse timestamp
      const scanTime = new Date(timeStamp);
      if (isNaN(scanTime.getTime())) {
        results.failed++;
        results.errors.push({ scanId, error: "Invalid timestamp" });
        continue;
      }

      // Get date key
      const scanDate = new Date(scanTime);
      scanDate.setHours(0, 0, 0, 0);
      const dateKey = scanDate.toISOString();

      // Initialize date group
      if (!scansByDate[dateKey]) {
        scansByDate[dateKey] = {
          date: scanDate,
          machines: {}
        };
      }

      // Initialize machine in date group
      if (!scansByDate[dateKey].machines[machineId]) {
        scansByDate[dateKey].machines[machineId] = {
          machineId: machineId,
          scans: []
        };
      }

      // Add scan to machine
      scansByDate[dateKey].machines[machineId].scans.push({
        scanId,
        timeStamp: scanTime,
        isEmployeeScan: isEmployeeScan || false,
        employeeId: employeeId || "",
        employeeName: employeeName || "",
        action: action || ""
      });
    }

    // Process each date group
    for (const dateKey in scansByDate) {
      const dateGroup = scansByDate[dateKey];
      
      // Find or create tracking document for this date
      let trackingDoc = await ProductionTracking.findOne({ date: dateGroup.date });
      if (!trackingDoc) {
        trackingDoc = new ProductionTracking({ 
          date: dateGroup.date,
          machines: [] 
        });
      }

      // Process each machine in this date
      for (const machineId in dateGroup.machines) {
        const machineData = dateGroup.machines[machineId];
        
        // Validate machine exists
        const machine = await Machine.findById(machineId);
        if (!machine) {
          results.failed += machineData.scans.length;
          results.successful -= machineData.scans.length;
          results.errors.push({ machineId, error: "Machine not found" });
          continue;
        }

        // Find or create machine tracking
        let machineTracking = trackingDoc.machines.find(
          m => m.machineId && m.machineId.toString() === machineId
        );

        if (!machineTracking) {
          machineTracking = trackingDoc.machines.create({
            machineId: machineId,
            operationTracking: []
          });
          trackingDoc.machines.push(machineTracking);
        }

        // Process each scan for this machine
        for (const scan of machineData.scans) {
          try {
            if (scan.isEmployeeScan) {
              // Employee sign in/out scan
              await processBulkEmployeeScan(machineTracking, scan, machine);
            } else {
              // Barcode scan
              await processBulkBarcodeScan(machineTracking, scan, machine);
            }
            results.successful++;
          } catch (scanError) {
            results.failed++;
            results.errors.push({ 
              scanId: scan.scanId, 
              error: scanError.message 
            });
          }
        }
      }

      // Save the tracking document
      await trackingDoc.save();
    }

    return res.status(200).json({
      success: true,
      message: `Processed ${results.successful} of ${results.total} scans`,
      results: results
    });

  } catch (error) {
    console.error("Bulk scan error:", error);
    res.status(500).json({
      success: false,
      message: "Server error processing bulk scans",
      error: error.message
    });
  }
});

// Helper function for bulk employee scans
async function processBulkEmployeeScan(machineTracking, scan, machine) {
  const operationNumber = 1;
  
  // Find or create operation tracking
  let operationTracking = machineTracking.operationTracking.find(
    op => op.operationNumber === operationNumber
  );

  if (!operationTracking) {
    operationTracking = machineTracking.operationTracking.create({
      operationNumber: operationNumber,
      operationType: "Default Operation",
      currentOperatorIdentityId: null,
      operators: []
    });
    machineTracking.operationTracking.push(operationTracking);
  }

  const empId = scan.employeeId || scan.scanId;
  const empName = scan.employeeName || "Unknown";

  if (scan.action === "signout") {
    // Sign out
    const operatorSession = operationTracking.operators.find(
      op => op.operatorIdentityId === empId && !op.signOutTime
    );
    
    if (operatorSession) {
      operatorSession.signOutTime = scan.timeStamp;
      if (operationTracking.currentOperatorIdentityId === empId) {
        operationTracking.currentOperatorIdentityId = null;
      }
    }
  } else {
    // Sign in (default action)
    
    // Sign out previous operator if exists
    if (operationTracking.currentOperatorIdentityId) {
      const prevOperator = operationTracking.operators.find(
        op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
      );
      if (prevOperator) {
        prevOperator.signOutTime = scan.timeStamp;
      }
    }

    // Check if operator already has a session
    const existingSession = operationTracking.operators.find(
      op => op.operatorIdentityId === empId && !op.signOutTime
    );

    if (!existingSession) {
      // Create new operator session
      const newOperatorSession = operationTracking.operators.create({
        operatorIdentityId: empId,
        operatorName: empName,
        signInTime: scan.timeStamp,
        signOutTime: null,
        barcodeScans: []
      });
      operationTracking.operators.push(newOperatorSession);
    }

    operationTracking.currentOperatorIdentityId = empId;
  }
}

// Helper function for bulk barcode scans
async function processBulkBarcodeScan(machineTracking, scan, machine) {
  // Find operation with signed-in operator
  const operationTracking = machineTracking.operationTracking.find(
    op => op.currentOperatorIdentityId
  );

  if (!operationTracking) {
    throw new Error("No operator signed in for barcode scan");
  }

  // Find operator session
  const operatorSession = operationTracking.operators.find(
    op => op.operatorIdentityId === operationTracking.currentOperatorIdentityId && !op.signOutTime
  );

  if (!operatorSession) {
    throw new Error("Operator session not found");
  }

  // Create barcode scan
  const newBarcodeScan = operatorSession.barcodeScans.create({
    barcodeId: scan.scanId,
    timeStamp: scan.timeStamp
  });

  operatorSession.barcodeScans.push(newBarcodeScan);
}

module.exports = router;