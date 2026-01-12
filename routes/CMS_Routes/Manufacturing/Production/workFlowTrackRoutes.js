// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes.js - CORRECTED LOGIC

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

// Get work order progress with CORRECT scan logic
router.get("/production-tracking/:id/progress", async (req, res) => {
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

        // Sort all scans by timestamp globally
        workOrderScans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        const totalUnits = workOrder.quantity;
        const totalOperations = workOrder.operations.length;

        // Group scans by machine first (since operations complete when next scan happens on same machine)
        const scansByMachine = {};
        workOrderScans.forEach(scan => {
            const machineKey = scan.machineId?.toString() || 'unknown';
            if (!scansByMachine[machineKey]) {
                scansByMachine[machineKey] = [];
            }
            scansByMachine[machineKey].push(scan);
        });

        // Sort scans within each machine by timestamp
        Object.values(scansByMachine).forEach(machineScans => {
            machineScans.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        });

        // Track operation completion with CORRECT logic
        const unitOperationStatus = {};
        const machineOperationSequence = {};
        
        // Initialize tracking
        for (let unit = 1; unit <= totalUnits; unit++) {
            unitOperationStatus[unit] = {};
            for (let op = 1; op <= totalOperations; op++) {
                unitOperationStatus[unit][op] = {
                    started: false,
                    completed: false,
                    startTime: null,
                    endTime: null,
                    scans: []
                };
            }
        }

        // Process scans with correct logic
        // For each machine, track the sequence of scans to determine completions
        Object.values(scansByMachine).forEach(machineScans => {
            let previousScan = null;
            
            machineScans.forEach((scan, index) => {
                const unit = scan.unit;
                const operation = scan.operation;
                
                // Add this scan to the operation's scan list
                unitOperationStatus[unit][operation].scans.push({
                    timestamp: scan.timestamp,
                    machineId: scan.machineId,
                    operatorId: scan.operatorId
                });
                
                // If this is the first scan for this operation, mark it as started
                if (!unitOperationStatus[unit][operation].started) {
                    unitOperationStatus[unit][operation].started = true;
                    unitOperationStatus[unit][operation].startTime = scan.timestamp;
                }
                
                // If there was a previous scan on this machine
                if (previousScan) {
                    const prevUnit = previousScan.unit;
                    const prevOperation = previousScan.operation;
                    
                    // If previous scan was for same unit but different operation
                    if (prevUnit === unit) {
                        // Previous operation on same unit is now completed
                        unitOperationStatus[prevUnit][prevOperation].completed = true;
                        unitOperationStatus[prevUnit][prevOperation].endTime = scan.timestamp;
                    } else {
                        // Different unit - previous operation stays in progress
                        // (unless it's the last scan of the day or shift changes)
                    }
                }
                
                previousScan = scan;
                
                // Special case: last scan for a machine
                if (index === machineScans.length - 1) {
                    // Last operation scanned remains in progress (not completed yet)
                    // Don't mark as completed because there's no next scan
                }
            });
        });

        // Calculate statistics
        let completedUnits = 0;
        let inProgressUnits = 0;
        let pendingUnits = 0;
        
        const unitDetails = [];
        
        for (let unit = 1; unit <= totalUnits; unit++) {
            let completedOps = 0;
            let startedOps = 0;
            let firstStartTime = null;
            let lastActivityTime = null;
            
            for (let op = 1; op <= totalOperations; op++) {
                const status = unitOperationStatus[unit][op];
                
                if (status.completed) {
                    completedOps++;
                }
                if (status.started) {
                    startedOps++;
                    if (!firstStartTime || new Date(status.startTime) < new Date(firstStartTime)) {
                        firstStartTime = status.startTime;
                    }
                    if (!lastActivityTime || new Date(status.startTime) > new Date(lastActivityTime)) {
                        lastActivityTime = status.startTime;
                    }
                    // Check if there are scans but not completed
                    if (status.scans.length > 0 && !status.completed) {
                        lastActivityTime = status.scans[status.scans.length - 1].timestamp;
                    }
                }
            }
            
            // Determine unit status
            let unitStatus = 'pending';
            if (completedOps === totalOperations) {
                unitStatus = 'completed';
                completedUnits++;
            } else if (startedOps > 0) {
                unitStatus = 'in_progress';
                inProgressUnits++;
            } else {
                unitStatus = 'pending';
                pendingUnits++;
            }
            
            const completionPercentage = Math.round((completedOps / totalOperations) * 100);
            
            unitDetails.push({
                unitNumber: unit,
                completedOperations: completedOps,
                startedOperations: startedOps,
                totalOperations: totalOperations,
                completionPercentage: completionPercentage,
                status: unitStatus,
                firstStartTime: firstStartTime,
                lastActivityTime: lastActivityTime,
                currentOperation: startedOps > completedOps ? startedOps : completedOps + 1
            });
        }

        // Calculate operation-wise completion
        const operationCompletion = [];
        for (let op = 1; op <= totalOperations; op++) {
            const operation = workOrder.operations[op - 1];
            
            let unitsCompleted = 0;
            let unitsInProgress = 0; // Started but not completed
            let unitsNotStarted = 0;
            
            for (let unit = 1; unit <= totalUnits; unit++) {
                const status = unitOperationStatus[unit][op];
                if (status.completed) {
                    unitsCompleted++;
                } else if (status.started) {
                    unitsInProgress++;
                } else {
                    unitsNotStarted++;
                }
            }
            
            const completionPercentage = Math.round((unitsCompleted / totalUnits) * 100);
            
            let opStatus = 'not_started';
            if (unitsCompleted === totalUnits) {
                opStatus = 'completed';
            } else if (unitsInProgress > 0 || unitsCompleted > 0) {
                opStatus = 'in_progress';
            }
            
            operationCompletion.push({
                operationNumber: op,
                operationType: operation?.operationType || 'Unknown',
                machineName: operation?.assignedMachineName || 'Not assigned',
                unitsCompleted: unitsCompleted,
                unitsInProgress: unitsInProgress,
                unitsNotStarted: unitsNotStarted,
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
            for (let op = 1; op <= totalOperations; op++) {
                if (unitOperationStatus[unit][op].completed) {
                    totalCompletedOperations++;
                }
            }
        }
        
        const maxPossibleCompletedOps = totalUnits * totalOperations;
        const overallCompletionPercentage = Math.round((totalCompletedOperations / maxPossibleCompletedOps) * 100);
        
        // Ensure percentage doesn't exceed 100%
        const safeCompletionPercentage = Math.min(100, overallCompletionPercentage);

        // Get recent scans (last 10)
        const recentScans = workOrderScans
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 10)
            .map(scan => {
                const unit = scan.unit;
                const operation = scan.operation;
                const status = unitOperationStatus[unit][operation];
                
                let meaning = '';
                if (status.scans.length === 1) {
                    meaning = `Started Operation ${operation}`;
                } else {
                    // Check if this scan completed a previous operation
                    const scansOnMachine = scansByMachine[scan.machineId?.toString()] || [];
                    const scanIndex = scansOnMachine.findIndex(s => 
                        s.timestamp === scan.timestamp && 
                        s.unit === scan.unit && 
                        s.operation === scan.operation
                    );
                    
                    if (scanIndex > 0) {
                        const prevScan = scansOnMachine[scanIndex - 1];
                        if (prevScan.unit === scan.unit) {
                            meaning = `Completed Operation ${prevScan.operation}, Started Operation ${operation}`;
                        } else {
                            meaning = `Started Operation ${operation}`;
                        }
                    } else {
                        meaning = `Started Operation ${operation}`;
                    }
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
                completedUnits: completedUnits,
                inProgressUnits: inProgressUnits,
                pendingUnits: pendingUnits,
                unitCompletionPercentage: Math.round((completedUnits / totalUnits) * 100),
                
                // Overall progress
                overallCompletionPercentage: safeCompletionPercentage,
                
                // Status
                currentStatus: workOrder.status,
                canComplete: workOrder.status === 'in_progress' && completedUnits === totalUnits
            },
            unitDetails: unitDetails.slice(0, 10), // Show first 10 units
            operationCompletion,
            recentScans,
            scanningLogic: {
                explanation: "CORRECT LOGIC: It takes TWO scans to complete one operation",
                rules: [
                    "1. Scan Op1 → Operation 1 starts (in progress)",
                    "2. Scan Op2 → Operation 1 completes, Operation 2 starts",
                    "3. Scan Op3 → Operation 2 completes, Operation 3 starts",
                    "4. Last scan of the day → Operation remains in progress (not completed)"
                ],
                note: "Operations complete only when the NEXT scan happens on the SAME machine"
            }
        });

    } catch (error) {
        console.error("Error getting work order progress:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting work order progress"
        });
    }
});

// Get machine-wise scan sequence
router.get("/production-tracking/:id/machine/:machineId/sequence", async (req, res) => {
    try {
        const { id, machineId } = req.params;

        const workOrder = await WorkOrder.findById(id);
        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        // Get production tracking records
        const productionRecords = await ProductionTracking.find({
            date: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        });

        // Extract scans for this machine and work order
        const machineScans = [];
        productionRecords.forEach(record => {
            record.machines.forEach(machine => {
                if (machine.machineId?.toString() === machineId) {
                    machine.operators.forEach(operator => {
                        operator.barcodeScans.forEach(scan => {
                            if (scan.barcodeId.includes(workOrder.workOrderNumber)) {
                                const parsed = parseBarcodeId(scan.barcodeId);
                                if (parsed.valid) {
                                    machineScans.push({
                                        ...scan,
                                        unit: parsed.unit,
                                        operation: parsed.operation,
                                        operatorId: operator.operatorId
                                    });
                                }
                            }
                        });
                    });
                }
            });
        });

        // Sort by timestamp
        machineScans.sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));

        // Build sequence with completion logic
        const sequence = [];
        let previousScan = null;
        
        machineScans.forEach((scan, index) => {
            const sequenceItem = {
                scanNumber: index + 1,
                timestamp: scan.timeStamp,
                unit: scan.unit,
                operation: scan.operation,
                operationType: workOrder.operations[scan.operation - 1]?.operationType || 'Unknown',
                barcodeId: scan.barcodeId,
                action: 'started'
            };
            
            // If there was a previous scan
            if (previousScan) {
                // Check if same unit
                if (previousScan.unit === scan.unit) {
                    // Previous operation completed
                    sequenceItem.previousCompleted = {
                        unit: previousScan.unit,
                        operation: previousScan.operation,
                        operationType: workOrder.operations[previousScan.operation - 1]?.operationType || 'Unknown'
                    };
                }
            }
            
            sequence.push(sequenceItem);
            previousScan = scan;
        });

        res.json({
            success: true,
            machineId: machineId,
            workOrderNumber: workOrder.workOrderNumber,
            totalScans: machineScans.length,
            sequence: sequence,
            summary: {
                uniqueUnits: new Set(machineScans.map(s => s.unit)).size,
                uniqueOperations: new Set(machineScans.map(s => s.operation)).size,
                firstScan: machineScans.length > 0 ? machineScans[0].timeStamp : null,
                lastScan: machineScans.length > 0 ? machineScans[machineScans.length - 1].timeStamp : null
            }
        });

    } catch (error) {
        console.error("Error getting machine sequence:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting machine sequence"
        });
    }
});

module.exports = router;