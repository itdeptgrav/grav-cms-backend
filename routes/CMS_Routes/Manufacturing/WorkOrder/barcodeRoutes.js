// routes/CMS_Routes/Manufacturing/WorkOrder/barcodeRoutes.js - SIMPLIFIED VERSION

const express = require("express");
const router = express.Router();
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

// Simple checksum validation function (must match frontend)
function validateChecksum(baseId, checksum) {
    let hash = 0;
    for (let i = 0; i < baseId.length; i++) {
        const char = baseId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const calculatedChecksum = Math.abs(hash).toString(16).toUpperCase().substring(0, 4).padStart(4, '0');
    return calculatedChecksum === checksum;
}

// Parse the barcode format
function parseBarcodeId(barcodeId) {
    try {
        // Format: [WorkOrderNumber]-[Unit3]-[Operation2]-[Checksum4]
        const pattern = /^([A-Z0-9-]+)-(\d{3})-(\d{2})-([A-F0-9]{4})$/;
        const match = barcodeId.match(pattern);
        
        if (!match) {
            return { valid: false, error: "Invalid barcode format" };
        }

        const [, workOrderNumber, unitStr, operationStr, checksum] = match;
        const baseId = `${workOrderNumber}-${unitStr}-${operationStr}`;
        
        if (!validateChecksum(baseId, checksum)) {
            return { 
                valid: false, 
                error: "Invalid checksum" 
            };
        }

        return {
            valid: true,
            workOrderNumber: workOrderNumber,
            unit: parseInt(unitStr),
            operation: parseInt(operationStr),
            checksum: checksum,
            baseId: baseId
        };

    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// Simple barcode decode endpoint
router.get("/decode/:barcodeId", async (req, res) => {
    try {
        const { barcodeId } = req.params;
        
        if (!barcodeId) {
            return res.status(400).json({
                success: false,
                message: "Barcode ID is required"
            });
        }

        // Parse the barcode ID
        const decoded = parseBarcodeId(barcodeId);
        
        if (!decoded.valid) {
            return res.status(400).json({
                success: false,
                message: "Invalid barcode format",
                error: decoded.error
            });
        }

        // Find Work Order by number
        let workOrder = await WorkOrder.findOne({
            workOrderNumber: decoded.workOrderNumber
        })
        .populate('customerRequestId', 'customerInfo')
        .populate('customerId', 'name')
        .lean();

        // Try with "WO-" prefix if not found
        if (!workOrder && !decoded.workOrderNumber.startsWith('WO-')) {
            workOrder = await WorkOrder.findOne({
                workOrderNumber: `WO-${decoded.workOrderNumber}`
            })
            .populate('customerRequestId', 'customerInfo')
            .populate('customerId', 'name')
            .lean();
        }

        if (!workOrder) {
            return res.json({
                success: false,
                message: `Work Order not found: ${decoded.workOrderNumber}`
            });
        }

        // Get operation details
        let operation = null;
        if (workOrder.operations && workOrder.operations.length >= decoded.operation) {
            operation = workOrder.operations[decoded.operation - 1];
        }

        // Calculate completion status
        const completedOps = workOrder.operations?.filter(op => 
            op.status === "completed"
        ).length || 0;
        const totalOps = workOrder.operations?.length || 0;
        const completionPercentage = totalOps > 0 ? Math.round((completedOps / totalOps) * 100) : 0;

        // Prepare simplified response
        const response = {
            success: true,
            
            // Basic barcode info
            barcode: {
                id: barcodeId,
                unit: decoded.unit,
                operation: decoded.operation
            },
            
            // Work Order info
            workOrder: {
                number: workOrder.workOrderNumber,
                status: workOrder.status,
                priority: workOrder.priority,
                quantity: workOrder.quantity,
                createdAt: workOrder.createdAt
            },
            
            // Product info
            product: {
                name: workOrder.stockItemName,
                code: workOrder.stockItemReference
            },
            
            // Variants
            variants: workOrder.variantAttributes?.map(attr => ({
                name: attr.name,
                value: attr.value
            })) || [],
            
            // Customer info
            customer: {
                name: workOrder.customerRequestId?.customerInfo?.name || workOrder.customerName || 'Unknown',
                company: workOrder.customerRequestId?.customerInfo?.company || ''
            },
            
            // Current operation
            currentOperation: operation ? {
                number: decoded.operation,
                type: operation.operationType,
                machine: operation.assignedMachineName,
                status: operation.status
            } : null,
            
            // Production progress
            progress: {
                currentUnit: decoded.unit,
                totalUnits: workOrder.quantity,
                currentOperation: decoded.operation,
                totalOperations: totalOps,
                completedOperations: completedOps,
                completionPercentage: completionPercentage
            },
            
            // Scan info
            scannedAt: new Date().toISOString()
        };

        res.json(response);

    } catch (error) {
        console.error("Error decoding barcode:", error);
        res.status(500).json({
            success: false,
            message: "Server error while decoding barcode"
        });
    }
});

// Even more minimal version (if needed)
router.get("/decode-minimal/:barcodeId", async (req, res) => {
    try {
        const { barcodeId } = req.params;
        
        if (!barcodeId) {
            return res.status(400).json({
                success: false,
                message: "Barcode ID is required"
            });
        }

        // Parse the barcode ID
        const decoded = parseBarcodeId(barcodeId);
        
        if (!decoded.valid) {
            return res.status(400).json({
                success: false,
                message: "Invalid barcode"
            });
        }

        // Find Work Order
        let workOrder = await WorkOrder.findOne({
            workOrderNumber: decoded.workOrderNumber
        })
        .populate('customerRequestId', 'customerInfo.name')
        .lean();

        if (!workOrder) {
            return res.json({
                success: false,
                message: "Work Order not found"
            });
        }

        // Get operation
        const operation = workOrder.operations && workOrder.operations.length >= decoded.operation 
            ? workOrder.operations[decoded.operation - 1]
            : null;

        // Minimal response
        res.json({
            success: true,
            data: {
                workOrder: workOrder.workOrderNumber,
                product: workOrder.stockItemName,
                unit: decoded.unit,
                operation: decoded.operation,
                operationType: operation?.operationType || 'Unknown',
                customer: workOrder.customerRequestId?.customerInfo?.name || workOrder.customerName,
                variants: workOrder.variantAttributes?.map(v => v.value).join(', ') || 'Standard',
                scannedAt: new Date().toLocaleTimeString()
            }
        });

    } catch (error) {
        console.error("Error decoding barcode:", error);
        res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});

module.exports = router;