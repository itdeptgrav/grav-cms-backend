// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - UPDATED

const express = require("express");
const router = express.Router();
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

// Helper function to check if ID is barcode (starts with WO-)
const isBarcodeId = (id) => {
    return id && typeof id === 'string' && id.startsWith('WO-');
};

// Helper function to check if ID is employee ObjectId (24 hex chars)
const isEmployeeId = (id) => {
    return id && typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
};


// POST - Process scan (single input for barcode or employee ID)
router.post("/scan", async (req, res) => {
    try {
        const {
            scanId,  // Changed from barcodeId/operatorId to single scanId
            machineId,
            timeStamp
        } = req.body;

        // Validate required fields
        if (!scanId) {
            return res.status(400).json({
                success: false,
                message: "scanId is required"
            });
        }

        if (!machineId) {
            return res.status(400).json({
                success: false,
                message: "machineId is required"
            });
        }

        if (!timeStamp) {
            return res.status(400).json({
                success: false,
                message: "timeStamp is required"
            });
        }

        // Parse timestamp
        const scanTime = new Date(timeStamp);
        if (isNaN(scanTime.getTime())) {
            return res.status(400).json({
                success: false,
                message: "Invalid timeStamp format"
            });
        }

        // Create date key (YYYY-MM-DD format, time set to 00:00:00)
        const scanDate = new Date(scanTime);
        scanDate.setHours(0, 0, 0, 0);

        // Find or create tracking document for the date
        let trackingDoc = await ProductionTracking.findOne({ date: scanDate });

        if (!trackingDoc) {
            trackingDoc = new ProductionTracking({ date: scanDate });
        }

        // Validate machine exists
        const machine = await Machine.findById(machineId);
        if (!machine) {
            return res.status(400).json({
                success: false,
                message: "Machine not found"
            });
        }

        // Find or create machine tracking for this date
        let machineTracking = trackingDoc.machines.find(
            m => m.machineId.toString() === machineId
        );

        if (!machineTracking) {
            machineTracking = {
                machineId: machineId,
                currentOperatorId: null,
                operators: []
            };
            trackingDoc.machines.push(machineTracking);
            machineTracking = trackingDoc.machines[trackingDoc.machines.length - 1];
        }

        // Check if scanId is barcode (starts with WO) or employee ID
        if (isBarcodeId(scanId)) {
            // This is a barcode scan (production tracking)

            // Check if operator is signed in to this machine
            if (!machineTracking.currentOperatorId) {
                return res.status(400).json({
                    success: false,
                    message: "No operator is currently signed in to this machine"
                });
            }

            // Find current operator's active session
            const operatorTracking = machineTracking.operators.find(
                op => op.operatorId.toString() === machineTracking.currentOperatorId.toString() && !op.signOutTime
            );

            if (!operatorTracking) {
                return res.status(400).json({
                    success: false,
                    message: "Operator session not found"
                });
            }

            // Add barcode scan
            operatorTracking.barcodeScans.push({
                barcodeId: scanId,
                timeStamp: scanTime
            });

            await trackingDoc.save();

            return res.json({
                success: true,
                message: `Barcode ${scanId} scanned successfully`,
                action: "barcode_scan",
                barcodeId: scanId,
                operatorId: machineTracking.currentOperatorId,
                machineId: machineId,
                scanTime: scanTime
            });

        } else if (isEmployeeId(scanId)) {
            // This is employee sign in/out scan

            // Validate operator exists and is in Operator department
            const operator = await Employee.findOne({
                _id: scanId,
                department: "Operator",
                status: "active"
            });

            if (!operator) {
                return res.status(400).json({
                    success: false,
                    message: "Operator not found or not in Operator department"
                });
            }

            // Check if operator is currently signed in to any other machine
            let autoSignOutActions = [];
            
            // Check all machines for this operator's active session
            for (const otherMachine of trackingDoc.machines) {
                if (otherMachine.machineId.toString() === machineId) {
                    continue; // Skip current machine
                }
                
                if (otherMachine.currentOperatorId && 
                    otherMachine.currentOperatorId.toString() === scanId) {
                    // Operator is signed in to another machine - auto sign out
                    const otherOperatorTracking = otherMachine.operators.find(
                        op => op.operatorId.toString() === scanId && !op.signOutTime
                    );
                    
                    if (otherOperatorTracking) {
                        otherOperatorTracking.signOutTime = scanTime;
                        otherMachine.currentOperatorId = null;
                        autoSignOutActions.push({
                            machineId: otherMachine.machineId,
                            action: "auto_sign_out",
                            signOutTime: scanTime
                        });
                    }
                }
            }

            // Check current operator status on THIS machine
            if (machineTracking.currentOperatorId) {
                // Someone is currently signed in to this machine
                if (machineTracking.currentOperatorId.toString() === scanId) {
                    // Same operator - sign out
                    const operatorTracking = machineTracking.operators.find(
                        op => op.operatorId.toString() === scanId && !op.signOutTime
                    );

                    if (operatorTracking) {
                        operatorTracking.signOutTime = scanTime;
                        machineTracking.currentOperatorId = null;

                        await trackingDoc.save();

                        return res.json({
                            success: true,
                            message: `Operator ${operator.firstName} ${operator.lastName} signed out from machine ${machine.name}`,
                            action: "sign_out",
                            operatorId: scanId,
                            machineId: machineId,
                            signOutTime: scanTime,
                            autoSignOutActions: autoSignOutActions.length > 0 ? autoSignOutActions : undefined
                        });
                    }
                } else {
                    // Different operator trying to sign in - auto sign out existing operator
                    const existingOperatorId = machineTracking.currentOperatorId;
                    const existingOperator = await Employee.findById(existingOperatorId);
                    
                    // Sign out existing operator
                    const existingOperatorTracking = machineTracking.operators.find(
                        op => op.operatorId.toString() === existingOperatorId.toString() && !op.signOutTime
                    );

                    if (existingOperatorTracking) {
                        existingOperatorTracking.signOutTime = scanTime;
                        autoSignOutActions.push({
                            machineId: machineId,
                            operatorId: existingOperatorId,
                            operatorName: existingOperator ? `${existingOperator.firstName} ${existingOperator.lastName}` : "Previous Operator",
                            action: "auto_sign_out",
                            signOutTime: scanTime
                        });
                    }

                    // Check if new operator has existing session in this machine
                    const existingSessionForNewOperator = machineTracking.operators.find(
                        op => op.operatorId.toString() === scanId && !op.signOutTime
                    );

                    if (existingSessionForNewOperator) {
                        return res.status(400).json({
                            success: false,
                            message: "Operator already signed in and not signed out from this machine"
                        });
                    }

                    // Create new operator tracking
                    machineTracking.operators.push({
                        operatorId: scanId,
                        signInTime: scanTime,
                        signOutTime: null,
                        barcodeScans: []
                    });

                    machineTracking.currentOperatorId = scanId;

                    await trackingDoc.save();

                    return res.json({
                        success: true,
                        message: `Operator ${operator.firstName} ${operator.lastName} signed in to machine ${machine.name}. Previous operator was auto-signed out.`,
                        action: "sign_in_with_auto_signout",
                        operatorId: scanId,
                        machineId: machineId,
                        signInTime: scanTime,
                        previousOperatorId: existingOperatorId,
                        previousOperatorName: existingOperator ? `${existingOperator.firstName} ${existingOperator.lastName}` : null,
                        autoSignOutActions: autoSignOutActions
                    });
                }
            } else {
                // No one is signed in - sign in new operator
                // Check if operator has existing active session in this machine
                const existingOperator = machineTracking.operators.find(
                    op => op.operatorId.toString() === scanId && !op.signOutTime
                );

                if (existingOperator) {
                    return res.status(400).json({
                        success: false,
                        message: "Operator already signed in and not signed out from this machine"
                    });
                }

                // Create new operator tracking
                machineTracking.operators.push({
                    operatorId: scanId,
                    signInTime: scanTime,
                    signOutTime: null,
                    barcodeScans: []
                });

                machineTracking.currentOperatorId = scanId;

                await trackingDoc.save();

                return res.json({
                    success: true,
                    message: `Operator ${operator.firstName} ${operator.lastName} signed in to machine ${machine.name}`,
                    action: "sign_in",
                    operatorId: scanId,
                    machineId: machineId,
                    signInTime: scanTime,
                    autoSignOutActions: autoSignOutActions.length > 0 ? autoSignOutActions : undefined
                });
            }

        } else {
            // Invalid ID format
            return res.status(400).json({
                success: false,
                message: "Invalid scan ID format. Must be either barcode (starts with WO-) or employee ID (24 hex characters)"
            });
        }

    } catch (error) {
        console.error("Error processing scan:", error);
        res.status(500).json({
            success: false,
            message: "Server error while processing scan",
            error: error.message
        });
    }
});



// routes/CMS_Routes/Production/Tracking/trackingRoutes.js - UPDATED SECTION

// GET - Get today's tracking status
router.get("/status/today", async (req, res) => {
    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const trackingDoc = await ProductionTracking.findOne({ date: today })
            .populate('machines.machineId', 'name serialNumber type')
            .populate('machines.currentOperatorId', 'firstName lastName employeeId')
            .populate('machines.operators.operatorId', 'firstName lastName employeeId');

        if (!trackingDoc) {
            return res.json({
                success: true,
                message: "No tracking data for today",
                date: today,
                machines: [],
                totalScans: 0
            });
        }

        // Calculate total scans
        let totalScans = 0;
        const machinesStatus = trackingDoc.machines.map(machine => {
            const machineScans = machine.operators.reduce((total, op) => total + op.barcodeScans.length, 0);
            totalScans += machineScans;
            
            return {
                machineId: machine.machineId?._id,
                machineName: machine.machineId?.name,
                machineSerial: machine.machineId?.serialNumber,
                currentOperator: machine.currentOperatorId ? {
                    id: machine.currentOperatorId._id,
                    name: `${machine.currentOperatorId.firstName} ${machine.currentOperatorId.lastName}`,
                    employeeId: machine.currentOperatorId.employeeId
                } : null,
                operators: machine.operators.map(op => ({
                    id: op.operatorId?._id,
                    name: op.operatorId ? `${op.operatorId.firstName} ${op.operatorId.lastName}` : 'Unknown Operator',
                    employeeId: op.operatorId?.employeeId,
                    signInTime: op.signInTime,
                    signOutTime: op.signOutTime,
                    barcodeScans: op.barcodeScans, // Send the actual array, not just length
                    scanCount: op.barcodeScans.length // Add count separately
                })),
                machineScans: machineScans
            };
        });

        res.json({
            success: true,
            date: trackingDoc.date,
            totalMachines: trackingDoc.machines.length,
            totalScans: totalScans,
            machines: machinesStatus
        });

    } catch (error) {
        console.error("Error getting status:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting status",
            error: error.message
        });
    }
});

// GET - Get tracking by date
router.get("/status/:date", async (req, res) => {
    try {
        const { date } = req.params;
        const queryDate = new Date(date);
        queryDate.setHours(0, 0, 0, 0);

        const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
            .populate('machines.machineId', 'name serialNumber type')
            .populate('machines.currentOperatorId', 'firstName lastName employeeId')
            .populate('machines.operators.operatorId', 'firstName lastName employeeId');

        if (!trackingDoc) {
            return res.json({
                success: true,
                message: `No tracking data for ${date}`,
                date: queryDate,
                machines: [],
                totalScans: 0
            });
        }

        // Calculate total scans
        let totalScans = 0;
        const machinesStatus = trackingDoc.machines.map(machine => {
            const machineScans = machine.operators.reduce((total, op) => total + op.barcodeScans.length, 0);
            totalScans += machineScans;
            
            return {
                machineId: machine.machineId?._id,
                machineName: machine.machineId?.name,
                machineSerial: machine.machineId?.serialNumber,
                currentOperator: machine.currentOperatorId ? {
                    id: machine.currentOperatorId._id,
                    name: `${machine.currentOperatorId.firstName} ${machine.currentOperatorId.lastName}`,
                    employeeId: machine.currentOperatorId.employeeId
                } : null,
                operators: machine.operators.map(op => ({
                    id: op.operatorId?._id,
                    name: op.operatorId ? `${op.operatorId.firstName} ${op.operatorId.lastName}` : 'Unknown Operator',
                    employeeId: op.operatorId?.employeeId,
                    signInTime: op.signInTime,
                    signOutTime: op.signOutTime,
                    barcodeScans: op.barcodeScans.map(scan => ({
                        barcodeId: scan.barcodeId,
                        timeStamp: scan.timeStamp
                    })),
                    scanCount: op.barcodeScans.length
                })),
                machineScans: machineScans
            };
        });

        res.json({
            success: true,
            date: trackingDoc.date,
            totalMachines: trackingDoc.machines.length,
            totalScans: totalScans,
            machines: machinesStatus
        });

    } catch (error) {
        console.error("Error getting date status:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting date status",
            error: error.message
        });
    }
});

module.exports = router;