// routes/CMS_Routes/Manufacturing/WorkOrder/workOrderProgressRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");

router.use(EmployeeAuthMiddleware);

// Helper function to generate barcode ID
function generateBarcodeId(workOrderNumber, unit, operation, totalOperations) {
    // Format: [WorkOrderNumber]-[Unit3]-[Operation2]-[Checksum4]
    const unitStr = unit.toString().padStart(3, '0');
    const operationStr = operation.toString().padStart(2, '0');
    const baseId = `${workOrderNumber}-${unitStr}-${operationStr}`;
    
    // Simple checksum
    let hash = 0;
    for (let i = 0; i < baseId.length; i++) {
        const char = baseId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const checksum = Math.abs(hash).toString(16).toUpperCase().substring(0, 4).padStart(4, '0');
    
    return `${baseId}-${checksum}`;
}

// Generate barcodes for work order
router.get("/:id/barcodes/generate", async (req, res) => {
    try {
        const { id } = req.params;

        const workOrder = await WorkOrder.findById(id);
        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        const totalOperations = workOrder.operations.length;
        const barcodes = [];

        // Generate barcode for each unit and operation
        for (let unit = 1; unit <= workOrder.quantity; unit++) {
            for (let operation = 1; operation <= totalOperations; operation++) {
                const barcodeId = generateBarcodeId(
                    workOrder.workOrderNumber,
                    unit,
                    operation,
                    totalOperations
                );

                barcodes.push({
                    barcodeId,
                    unitNumber: unit,
                    operationNumber: operation,
                    operationType: workOrder.operations[operation - 1]?.operationType || 'Unknown',
                    machineAssigned: workOrder.operations[operation - 1]?.assignedMachineName || 'Not assigned',
                    status: 'pending' // Initial status
                });
            }
        }

        res.json({
            success: true,
            barcodes: barcodes,
            summary: {
                workOrderNumber: workOrder.workOrderNumber,
                totalUnits: workOrder.quantity,
                totalOperations: totalOperations,
                totalBarcodes: barcodes.length,
                generatedAt: new Date()
            }
        });

    } catch (error) {
        console.error("Error generating barcodes:", error);
        res.status(500).json({
            success: false,
            message: "Server error while generating barcodes"
        });
    }
});


// GET production summary for manufacturing order
router.get("/manufacturing-order/:moId/summary", async (req, res) => {
    try {
        const { moId } = req.params;

        // First get the manufacturing order to get all work orders
        const manufacturingOrder = await CustomerRequest.findById(moId)
            .populate({
                path: 'workOrders',
                model: 'WorkOrder'
            })
            .lean();

        if (!manufacturingOrder) {
            return res.status(404).json({
                success: false,
                message: "Manufacturing order not found"
            });
        }

        const workOrderIds = manufacturingOrder.workOrders.map(wo => wo._id);
        const summary = {
            totalWorkOrders: workOrderIds.length,
            totalUnitsInMO: manufacturingOrder.workOrders.reduce((sum, wo) => sum + (wo.quantity || 0), 0),
            workOrderStats: []
        };

        // Get progress for each work order
        for (const woId of workOrderIds) {
            const progress = await calculateWorkOrderProgress(woId);
            if (progress) {
                summary.workOrderStats.push({
                    workOrderId: woId,
                    workOrderNumber: progress.workOrderNumber,
                    ...progress.progress
                });
            }
        }

        // Calculate aggregated stats
        summary.totalUnitsCompleted = summary.workOrderStats.reduce((sum, stat) => 
            sum + (stat.completedUnits || 0), 0);
        summary.totalUnitsInProgress = summary.workOrderStats.reduce((sum, stat) => 
            sum + (stat.partiallyCompletedUnits || 0), 0);
        summary.totalScans = summary.workOrderStats.reduce((sum, stat) => 
            sum + (stat.completedBarcodes || 0), 0);
        
        // Calculate average completion percentage
        const validStats = summary.workOrderStats.filter(stat => stat.overallCompletionPercentage !== undefined);
        summary.avgCompletionPercentage = validStats.length > 0 ?
            Math.round(validStats.reduce((sum, stat) => sum + stat.overallCompletionPercentage, 0) / validStats.length) : 0;

        // Calculate efficiency
        const totalEstimatedTime = summary.workOrderStats.reduce((sum, stat) => 
            sum + (stat.estimatedTotalTime || 0), 0);
        const totalActualTime = summary.workOrderStats.reduce((sum, stat) => 
            sum + (stat.actualTotalTime || 0), 0);
        
        summary.efficiency = totalEstimatedTime > 0 && totalActualTime > 0 ?
            Math.round((totalEstimatedTime / totalActualTime) * 100) : 0;

        res.json({
            success: true,
            summary
        });

    } catch (error) {
        console.error("Error getting manufacturing order summary:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting manufacturing order summary"
        });
    }
});

// Get work order progress
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

        // Get today's production tracking
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Get all scans for this work order in the last 30 days
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const productionRecords = await ProductionTracking.find({
            date: { $gte: thirtyDaysAgo }
        });

        // Extract all barcode scans for this work order
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

        // Filter scans for this work order and parse barcodes
        const workOrderScans = allScans.filter(scan => 
            scan.barcodeId.includes(workOrder.workOrderNumber)
        );

        // Parse barcode IDs to get unit and operation info
        const parsedScans = workOrderScans.map(scan => {
            const parts = scan.barcodeId.split('-');
            // Format: [WorkOrderNumber]-[Unit3]-[Operation2]-[Checksum4]
            if (parts.length >= 4) {
                const unit = parseInt(parts[parts.length - 3]); // Second last part before checksum
                const operation = parseInt(parts[parts.length - 2]); // Third last part before checksum
                return {
                    ...scan,
                    unit,
                    operation,
                    isValid: !isNaN(unit) && !isNaN(operation)
                };
            }
            return { ...scan, unit: 0, operation: 0, isValid: false };
        }).filter(scan => scan.isValid);

        // Calculate progress by unit
        const totalUnits = workOrder.quantity;
        const totalOperations = workOrder.operations.length;
        
        // Track completed operations per unit
        const unitProgress = {};
        for (let unit = 1; unit <= totalUnits; unit++) {
            unitProgress[unit] = {
                completedOperations: new Set(),
                operationTimes: {}
            };
        }

        // Group scans by unit and operation
        parsedScans.forEach(scan => {
            if (scan.unit >= 1 && scan.unit <= totalUnits && 
                scan.operation >= 1 && scan.operation <= totalOperations) {
                unitProgress[scan.unit].completedOperations.add(scan.operation);
                unitProgress[scan.unit].operationTimes[scan.operation] = scan.timestamp;
            }
        });

        // Calculate completion statistics
        let completedUnits = 0;
        let partiallyCompletedUnits = 0;
        let pendingUnits = 0;
        
        const unitDetails = [];
        
        for (let unit = 1; unit <= totalUnits; unit++) {
            const completedOps = unitProgress[unit].completedOperations.size;
            const isCompleted = completedOps === totalOperations;
            const hasProgress = completedOps > 0 && completedOps < totalOperations;
            
            if (isCompleted) completedUnits++;
            else if (hasProgress) partiallyCompletedUnits++;
            else pendingUnits++;

            // Find first and last operation times for this unit
            const operationTimes = Object.values(unitProgress[unit].operationTimes);
            const firstScanTime = operationTimes.length > 0 ? 
                new Date(Math.min(...operationTimes.map(t => new Date(t).getTime()))) : null;
            const lastScanTime = operationTimes.length > 0 ? 
                new Date(Math.max(...operationTimes.map(t => new Date(t).getTime()))) : null;

            unitDetails.push({
                unitNumber: unit,
                completedOperations: completedOps,
                totalOperations: totalOperations,
                completionPercentage: Math.round((completedOps / totalOperations) * 100),
                status: isCompleted ? 'completed' : (hasProgress ? 'in_progress' : 'pending'),
                firstOperationTime: firstScanTime,
                lastOperationTime: lastScanTime
            });
        }

        // Calculate operation-wise completion
        const operationCompletion = [];
        for (let op = 1; op <= totalOperations; op++) {
            const operation = workOrder.operations[op - 1];
            let completedUnitsForOp = 0;
            
            for (let unit = 1; unit <= totalUnits; unit++) {
                if (unitProgress[unit].completedOperations.has(op)) {
                    completedUnitsForOp++;
                }
            }

            operationCompletion.push({
                operationNumber: op,
                operationType: operation?.operationType || 'Unknown',
                machineName: operation?.assignedMachineName || 'Not assigned',
                completedUnits: completedUnitsForOp,
                totalUnits: totalUnits,
                completionPercentage: Math.round((completedUnitsForOp / totalUnits) * 100),
                status: completedUnitsForOp === totalUnits ? 'completed' : 
                       completedUnitsForOp > 0 ? 'in_progress' : 'pending'
            });
        }

        // Calculate overall progress
        const totalBarcodes = totalUnits * totalOperations;
        const completedBarcodes = parsedScans.length;
        const overallCompletionPercentage = Math.round((completedBarcodes / totalBarcodes) * 100);

        // Calculate efficiency (if we have time data)
        let estimatedTotalTime = 0;
        let actualTotalTime = 0;
        
        if (workOrder.timeline?.totalPlannedSeconds) {
            estimatedTotalTime = workOrder.timeline.totalPlannedSeconds * totalUnits;
            
            // Calculate actual time based on scan timestamps
            const unitTimeRanges = {};
            parsedScans.forEach(scan => {
                if (!unitTimeRanges[scan.unit]) {
                    unitTimeRanges[scan.unit] = {
                        start: new Date(scan.timestamp),
                        end: new Date(scan.timestamp)
                    };
                } else {
                    unitTimeRanges[scan.unit].start = new Date(
                        Math.min(unitTimeRanges[scan.unit].start.getTime(), new Date(scan.timestamp).getTime())
                    );
                    unitTimeRanges[scan.unit].end = new Date(
                        Math.max(unitTimeRanges[scan.unit].end.getTime(), new Date(scan.timestamp).getTime())
                    );
                }
            });

            // Sum up actual times for units with multiple scans
            Object.values(unitTimeRanges).forEach(range => {
                actualTotalTime += (range.end.getTime() - range.start.getTime()) / 1000;
            });
        }

        const efficiency = estimatedTotalTime > 0 ? 
            Math.round((estimatedTotalTime / actualTotalTime) * 100) : 0;

        res.json({
            success: true,
            progress: {
                workOrderId: workOrder._id,
                workOrderNumber: workOrder.workOrderNumber,
                productName: workOrder.stockItemName,
                totalUnits: totalUnits,
                totalOperations: totalOperations,
                totalBarcodes: totalBarcodes,
                completedBarcodes: completedBarcodes,
                
                // Unit progress
                completedUnits,
                partiallyCompletedUnits,
                pendingUnits,
                unitCompletionPercentage: Math.round((completedUnits / totalUnits) * 100),
                
                // Overall progress
                overallCompletionPercentage,
                
                // Time and efficiency
                estimatedTotalTime: workOrder.timeline?.totalPlannedSeconds || 0,
                actualTotalTime,
                efficiency: Math.min(efficiency, 100), // Cap at 100%
                
                // Scan statistics
                totalScans: parsedScans.length,
                firstScan: parsedScans.length > 0 ? 
                    new Date(Math.min(...parsedScans.map(s => new Date(s.timestamp).getTime()))) : null,
                lastScan: parsedScans.length > 0 ? 
                    new Date(Math.max(...parsedScans.map(s => new Date(s.timestamp).getTime()))) : null,
                
                // Status
                currentStatus: workOrder.status,
                canStartProduction: workOrder.status === 'scheduled' || workOrder.status === 'planned',
                canComplete: workOrder.status === 'in_progress' && completedUnits === totalUnits
            },
            unitDetails,
            operationCompletion,
            recentScans: parsedScans.slice(-10).map(scan => ({
                barcodeId: scan.barcodeId,
                unit: scan.unit,
                operation: scan.operation,
                timestamp: scan.timestamp,
                operationType: workOrder.operations[scan.operation - 1]?.operationType || 'Unknown'
            }))
        });

    } catch (error) {
        console.error("Error getting work order progress:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting work order progress"
        });
    }
});

// Get real-time production updates
router.get("/:id/progress/realtime", async (req, res) => {
    try {
        const { id } = req.params;

        const workOrder = await WorkOrder.findById(id);
        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        // Get scans from the last hour
        const oneHourAgo = new Date();
        oneHourAgo.setHours(oneHourAgo.getHours() - 1);

        const productionRecords = await ProductionTracking.find({
            date: { $gte: oneHourAgo }
        });

        // Extract recent scans
        const recentScans = [];
        productionRecords.forEach(record => {
            record.machines.forEach(machine => {
                machine.operators.forEach(operator => {
                    operator.barcodeScans.forEach(scan => {
                        if (scan.barcodeId.includes(workOrder.workOrderNumber) && 
                            new Date(scan.timeStamp) >= oneHourAgo) {
                            recentScans.push({
                                barcodeId: scan.barcodeId,
                                timestamp: scan.timeStamp,
                                machineId: machine.machineId,
                                operatorId: operator.operatorId
                            });
                        }
                    });
                });
            });
        });

        // Parse and summarize
        const parsedRecentScans = recentScans.map(scan => {
            const parts = scan.barcodeId.split('-');
            if (parts.length >= 4) {
                const unit = parseInt(parts[parts.length - 3]);
                const operation = parseInt(parts[parts.length - 2]);
                return {
                    ...scan,
                    unit,
                    operation,
                    operationType: workOrder.operations[operation - 1]?.operationType || 'Unknown'
                };
            }
            return scan;
        }).filter(scan => scan.unit && scan.operation);

        res.json({
            success: true,
            realtimeUpdates: {
                totalScansLastHour: parsedRecentScans.length,
                scansByMinute: groupScansByMinute(parsedRecentScans),
                recentScans: parsedRecentScans.slice(-5),
                currentRate: calculateProductionRate(parsedRecentScans)
            }
        });

    } catch (error) {
        console.error("Error getting realtime progress:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting realtime progress"
        });
    }
});

// Helper functions
function groupScansByMinute(scans) {
    const groups = {};
    scans.forEach(scan => {
        const minute = new Date(scan.timestamp).toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
        if (!groups[minute]) groups[minute] = 0;
        groups[minute]++;
    });
    return groups;
}

function calculateProductionRate(scans) {
    if (scans.length < 2) return 0;
    
    const times = scans.map(s => new Date(s.timestamp).getTime()).sort((a, b) => a - b);
    const totalTime = (times[times.length - 1] - times[0]) / 1000; // in seconds
    const totalScans = scans.length;
    
    return totalTime > 0 ? Math.round((totalScans / totalTime) * 3600) : 0; // scans per hour
}

module.exports = router;