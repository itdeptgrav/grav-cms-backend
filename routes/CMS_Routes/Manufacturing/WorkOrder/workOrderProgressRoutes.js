// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes.js - FINAL CORRECTED

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

router.use(EmployeeAuthMiddleware);

// Helper function to parse barcode
function parseBarcodeId(barcodeId) {
    try {
        // Format: [WorkOrderNumber]-[Unit3]-[Operation2]-[Checksum4]
        const pattern = /^([A-Z0-9-]+)-(\d{3})-(\d{2})-([A-F0-9]{4})$/;
        const match = barcodeId.match(pattern);
        
        if (!match) {
            return { valid: false, error: "Invalid barcode format" };
        }

        const [, workOrderNumber, unitStr, operationStr, checksum] = match;
        const unit = parseInt(unitStr);
        const operation = parseInt(operationStr);
        
        if (isNaN(unit) || isNaN(operation)) {
            return { valid: false, error: "Invalid unit or operation number" };
        }

        return {
            valid: true,
            workOrderNumber: workOrderNumber,
            unit: unit,
            operation: operation,
            checksum: checksum
        };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// Get work order progress with FINAL CORRECT logic
router.get("/:id/progress", async (req, res) => {
    try {
        const { id } = req.params;

        const workOrder = await WorkOrder.findById(id);
        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        // Get all production tracking records
        const productionRecords = await ProductionTracking.find({
            date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } // Last 30 days
        });

        // Extract and parse all barcode scans
        const allScans = [];
        productionRecords.forEach(record => {
            record.machines.forEach(machine => {
                machine.operators.forEach(operator => {
                    operator.barcodeScans.forEach(scan => {
                        allScans.push({
                            barcodeId: scan.barcodeId,
                            timestamp: scan.timeStamp,
                            operatorId: operator.operatorId,
                            machineId: machine.machineId
                        });
                    });
                });
            });
        });

        // Filter and parse scans for this work order
        const workOrderScans = allScans
            .filter(scan => scan.barcodeId.includes(workOrder.workOrderNumber))
            .map(scan => {
                const parsed = parseBarcodeId(scan.barcodeId);
                if (parsed.valid) {
                    return {
                        ...scan,
                        unit: parsed.unit,
                        operation: parsed.operation,
                        workOrderNumber: parsed.workOrderNumber
                    };
                }
                return null;
            })
            .filter(scan => scan !== null);

        const totalUnits = workOrder.quantity;
        const totalOperations = workOrder.operations.length;

        // Group scans by unit and sort by timestamp
        const unitScans = {};
        workOrderScans.forEach(scan => {
            if (!unitScans[scan.unit]) {
                unitScans[scan.unit] = [];
            }
            unitScans[scan.unit].push(scan);
        });

        // Sort scans within each unit by timestamp
        Object.keys(unitScans).forEach(unit => {
            unitScans[unit].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        });

        // Calculate unit progress - FINAL CORRECT LOGIC
        const unitProgress = {};
        const completedUnits = new Set();
        const inProgressUnits = new Set();
        const pendingUnits = new Set();
        
        const unitDetails = [];
        
        for (let unit = 1; unit <= totalUnits; unit++) {
            const scans = unitScans[unit] || [];
            
            // Track operation status based on scan sequence
            const operationStatus = {};
            const operationScanTimes = {};
            
            // Initialize all operations as pending
            for (let op = 1; op <= totalOperations; op++) {
                operationStatus[op] = 'pending';
                operationScanTimes[op] = null;
            }
            
            // Process scans in chronological order
            let lastScannedOperation = null;
            
            scans.forEach((scan, index) => {
                const currentOp = scan.operation;
                operationScanTimes[currentOp] = scan.timestamp;
                
                if (index === 0) {
                    // First scan: mark this operation as in progress
                    operationStatus[currentOp] = 'in_progress';
                    lastScannedOperation = currentOp;
                } else {
                    // Not first scan: complete the previous operation, start current
                    if (lastScannedOperation !== null) {
                        operationStatus[lastScannedOperation] = 'completed';
                    }
                    operationStatus[currentOp] = 'in_progress';
                    lastScannedOperation = currentOp;
                }
                
                // If this is the last scan and it's the last operation, mark it as completed
                if (index === scans.length - 1 && currentOp === totalOperations) {
                    operationStatus[currentOp] = 'completed';
                }
            });
            
            // Count completed operations
            let completedOps = 0;
            for (let op = 1; op <= totalOperations; op++) {
                if (operationStatus[op] === 'completed') {
                    completedOps++;
                }
            }
            
            // Determine unit status
            let unitStatus = 'pending';
            if (completedOps === totalOperations) {
                unitStatus = 'completed';
                completedUnits.add(unit);
            } else if (scans.length > 0) {
                unitStatus = 'in_progress';
                inProgressUnits.add(unit);
            } else {
                unitStatus = 'pending';
                pendingUnits.add(unit);
            }
            
            // Find current operation (operation that is in_progress)
            let currentOperation = 0;
            for (let op = 1; op <= totalOperations; op++) {
                if (operationStatus[op] === 'in_progress') {
                    currentOperation = op;
                    break;
                }
            }
            
            unitProgress[unit] = {
                status: unitStatus,
                completedOperations: completedOps,
                currentOperation: currentOperation,
                operationStatus: operationStatus,
                lastScan: scans.length > 0 ? scans[scans.length - 1].timestamp : null,
                firstScan: scans.length > 0 ? scans[0].timestamp : null,
                totalScans: scans.length
            };
            
            unitDetails.push({
                unitNumber: unit,
                currentOperation: currentOperation,
                completedOperations: completedOps,
                totalOperations: totalOperations,
                completionPercentage: Math.round((completedOps / totalOperations) * 100),
                status: unitStatus,
                lastActivity: scans.length > 0 ? scans[scans.length - 1].timestamp : null,
                firstActivity: scans.length > 0 ? scans[0].timestamp : null,
                scanCount: scans.length,
                lastScannedOperation: scans.length > 0 ? scans[scans.length - 1].operation : null
            });
        }

        // Calculate operation-wise completion
        const operationCompletion = [];
        for (let op = 1; op <= totalOperations; op++) {
            const operation = workOrder.operations[op - 1];
            
            let unitsCompleted = 0;
            let unitsInProgress = 0;
            let unitsPending = 0;
            
            for (let unit = 1; unit <= totalUnits; unit++) {
                const status = unitProgress[unit]?.operationStatus?.[op] || 'pending';
                if (status === 'completed') {
                    unitsCompleted++;
                } else if (status === 'in_progress') {
                    unitsInProgress++;
                } else {
                    unitsPending++;
                }
            }
            
            const completionPercentage = Math.round((unitsCompleted / totalUnits) * 100);
            
            let opStatus = 'pending';
            if (unitsCompleted === totalUnits) {
                opStatus = 'completed';
            } else if (unitsInProgress > 0) {
                opStatus = 'in_progress';
            } else if (unitsCompleted > 0) {
                opStatus = 'partially_completed';
            }
            
            operationCompletion.push({
                operationNumber: op,
                operationType: operation?.operationType || 'Unknown',
                machineName: operation?.assignedMachineName || 'Not assigned',
                unitsCompleted: unitsCompleted,
                unitsInProgress: unitsInProgress,
                unitsPending: unitsPending,
                totalUnits: totalUnits,
                completionPercentage: completionPercentage,
                status: opStatus
            });
        }

        // Calculate overall progress
        const totalBarcodes = totalUnits * totalOperations;
        const totalScans = workOrderScans.length;
        
        // Count total completed operations across all units
        let totalCompletedOperations = 0;
        for (let unit = 1; unit <= totalUnits; unit++) {
            totalCompletedOperations += unitProgress[unit]?.completedOperations || 0;
        }
        
        const maxPossibleCompletedOps = totalUnits * totalOperations;
        const overallCompletionPercentage = totalUnits > 0 && totalOperations > 0 ? 
            Math.round((totalCompletedOperations / maxPossibleCompletedOps) * 100) : 0;
        
        // Ensure percentage doesn't exceed 100%
        const safeCompletionPercentage = Math.min(100, Math.max(0, overallCompletionPercentage));

        // Get recent scans (last 10)
        const recentScans = workOrderScans
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 10)
            .map((scan, index, array) => {
                let meaning = '';
                if (index === array.length - 1) {
                    // First in list (most recent)
                    meaning = `Started Operation ${scan.operation}`;
                } else {
                    const prevScan = array[index + 1]; // Next in chronological order
                    meaning = `Completed Operation ${prevScan.operation}, Started Operation ${scan.operation}`;
                }
                
                return {
                    barcodeId: scan.barcodeId,
                    unit: scan.unit,
                    operation: scan.operation,
                    timestamp: scan.timestamp,
                    operationType: workOrder.operations[scan.operation - 1]?.operationType || 'Unknown',
                    meaning: meaning
                };
            });

        res.json({
            success: true,
            progress: {
                workOrderId: workOrder._id,
                workOrderNumber: workOrder.workOrderNumber,
                productName: workOrder.stockItemName,
                totalUnits: totalUnits,
                totalOperations: totalOperations,
                totalBarcodes: totalBarcodes,
                totalScans: totalScans,
                totalCompletedOperations: totalCompletedOperations,
                
                // Unit progress
                completedUnits: completedUnits.size,
                inProgressUnits: inProgressUnits.size,
                pendingUnits: pendingUnits.size,
                unitCompletionPercentage: totalUnits > 0 ? Math.round((completedUnits.size / totalUnits) * 100) : 0,
                
                // Overall progress
                overallCompletionPercentage: safeCompletionPercentage,
                
                // Status
                currentStatus: workOrder.status,
                canComplete: workOrder.status === 'in_progress' && completedUnits.size === totalUnits
            },
            unitDetails: unitDetails.slice(0, 10), // Show first 10 units
            operationCompletion,
            recentScans,
            scanningLogic: {
                explanation: "Scan Logic: Each scan starts a new operation and completes the previous one",
                example: "Scan Op2 → Op2 starts, Scan Op4 → Op2 completes & Op4 starts"
            }
        });
//
    } catch (error) {
        console.error("Error getting work order progress:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting work order progress"
        });
    }
});

// Get detailed unit timeline
router.get("/:id/unit/:unitNumber/timeline", async (req, res) => {
    try {
        const { id, unitNumber } = req.params;
        const unit = parseInt(unitNumber);

        const workOrder = await WorkOrder.findById(id);
        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        if (unit < 1 || unit > workOrder.quantity) {
            return res.status(400).json({
                success: false,
                message: `Invalid unit number. Must be between 1 and ${workOrder.quantity}`
            });
        }

        // Get production tracking records
        const productionRecords = await ProductionTracking.find({
            date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        });

        // Extract scans for this unit
        const scans = [];
        productionRecords.forEach(record => {
            record.machines.forEach(machine => {
                machine.operators.forEach(operator => {
                    operator.barcodeScans.forEach(scan => {
                        if (scan.barcodeId.includes(workOrder.workOrderNumber)) {
                            const parsed = parseBarcodeId(scan.barcodeId);
                            if (parsed.valid && parsed.unit === unit) {
                                scans.push({
                                    ...scan,
                                    operation: parsed.operation,
                                    operatorId: operator.operatorId,
                                    machineId: machine.machineId
                                });
                            }
                        }
                    });
                });
            });
        });

        // Sort scans by timestamp
        scans.sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));

        const totalOperations = workOrder.operations.length;
        
        // Build timeline based on scan sequence
        const timeline = [];
        let previousOperation = null;
        
        scans.forEach((scan, index) => {
            const currentOp = scan.operation;
            const operation = workOrder.operations[currentOp - 1];
            
            if (index === 0) {
                // First scan
                timeline.push({
                    type: 'start',
                    operation: currentOp,
                    operationType: operation?.operationType || 'Unknown',
                    timestamp: scan.timeStamp,
                    description: `Started Operation ${currentOp}`
                });
            } else {
                // Not first scan: complete previous, start current
                timeline.push({
                    type: 'complete',
                    operation: previousOperation,
                    operationType: workOrder.operations[previousOperation - 1]?.operationType || 'Unknown',
                    timestamp: scan.timeStamp,
                    description: `Completed Operation ${previousOperation}`
                });
                
                timeline.push({
                    type: 'start',
                    operation: currentOp,
                    operationType: operation?.operationType || 'Unknown',
                    timestamp: scan.timeStamp,
                    description: `Started Operation ${currentOp}`
                });
            }
            
            previousOperation = currentOp;
            
            // If this is the last scan and it's the last operation, add completion
            if (index === scans.length - 1 && currentOp === totalOperations) {
                timeline.push({
                    type: 'complete',
                    operation: currentOp,
                    operationType: operation?.operationType || 'Unknown',
                    timestamp: new Date(new Date(scan.timeStamp).getTime() + 60000), // 1 minute after
                    description: `Completed Operation ${currentOp} (Final)`
                });
            }
        });

        // Calculate current status
        let currentOperation = 0;
        let completedOperations = 0;
        const operationStatus = {};
        
        for (let op = 1; op <= totalOperations; op++) {
            operationStatus[op] = 'pending';
        }
        
        if (scans.length > 0) {
            // Process to determine current status
            let lastScanned = scans[scans.length - 1].operation;
            
            // Mark all scanned except last as completed
            scans.forEach((scan, index) => {
                if (index < scans.length - 1) {
                    operationStatus[scan.operation] = 'completed';
                }
            });
            
            // Last scanned is in progress (unless it's the last operation)
            if (lastScanned === totalOperations) {
                operationStatus[lastScanned] = 'completed';
                currentOperation = 0; // All done
            } else {
                operationStatus[lastScanned] = 'in_progress';
                currentOperation = lastScanned;
            }
            
            // Count completed
            completedOperations = Object.values(operationStatus).filter(s => s === 'completed').length;
        }

        res.json({
            success: true,
            unitProgress: {
                unitNumber: unit,
                workOrderNumber: workOrder.workOrderNumber,
                currentOperation: currentOperation,
                completedOperations: completedOperations,
                totalOperations: totalOperations,
                completionPercentage: Math.round((completedOperations / totalOperations) * 100),
                status: completedOperations === totalOperations ? 'completed' : 
                       scans.length > 0 ? 'in_progress' : 'pending',
                firstScan: scans.length > 0 ? scans[0].timeStamp : null,
                lastScan: scans.length > 0 ? scans[scans.length - 1].timeStamp : null,
                totalScans: scans.length
            },
            timeline,
            operationStatus,
            scans: scans.map(scan => ({
                operation: scan.operation,
                timestamp: scan.timeStamp,
                operationType: workOrder.operations[scan.operation - 1]?.operationType || 'Unknown'
            }))
        });

    } catch (error) {
        console.error("Error getting unit timeline:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting unit timeline"
        });
    }
});

module.exports = router;