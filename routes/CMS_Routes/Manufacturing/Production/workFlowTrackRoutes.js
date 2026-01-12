// routes/CMS_Routes/Manufacturing/Production/workFlowTrackRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const ProductionTracking = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

router.use(EmployeeAuthMiddleware);

// Helper function to parse barcode ID
function parseBarcodeId(barcodeId) {
    try {
        // Format: [WorkOrderNumber]-[Unit3]-[Operation2]-[Checksum4]
        const parts = barcodeId.split('-');
        if (parts.length >= 4) {
            const checksumIndex = parts.length - 1;
            const operationIndex = parts.length - 2;
            const unitIndex = parts.length - 3;

            // Reconstruct work order number (everything before unit)
            const workOrderNumber = parts.slice(0, unitIndex).join('-');
            const unit = parseInt(parts[unitIndex]);
            const operation = parseInt(parts[operationIndex]);

            if (!isNaN(unit) && !isNaN(operation)) {
                return {
                    valid: true,
                    workOrderNumber,
                    unit,
                    operation,
                    barcodeId
                };
            }
        }
        return { valid: false, error: "Invalid barcode format" };
    } catch (error) {
        return { valid: false, error: error.message };
    }
}

// GET work flow tracking data
router.get("/:id/tracking", async (req, res) => {
    try {
        const { id } = req.params;
        const { date, operation } = req.query;

        // Parse date or use today
        const targetDate = date ? new Date(date) : new Date();
        targetDate.setHours(0, 0, 0, 0);
        const tomorrow = new Date(targetDate);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Find work order
        const workOrder = await WorkOrder.findById(id)
            .populate('stockItemId', 'name reference')
            .populate('customerRequestId', 'customerInfo')
            .lean();

        if (!workOrder) {
            return res.status(404).json({
                success: false,
                message: "Work order not found"
            });
        }

        // Get production tracking for the date
        const productionTracking = await ProductionTracking.findOne({
            date: { $gte: targetDate, $lt: tomorrow }
        })
            .populate({
                path: 'machines.machineId',
                select: 'name serialNumber type'
            })
            .populate({
                path: 'machines.currentOperatorId',
                select: 'firstName lastName employeeId department',
                model: 'Employee'  // Explicitly specify model
            })
            .populate({
                path: 'machines.operators.operatorId',
                select: 'firstName lastName employeeId department',
                model: 'Employee'  // Explicitly specify model
            });

        if (!productionTracking) {
            return res.json({
                success: true,
                workOrder: {
                    ...workOrder,
                    workOrderNumber: workOrder.workOrderNumber,
                    productName: workOrder.stockItemName,
                    quantity: workOrder.quantity,
                    operations: workOrder.operations || []
                },
                trackingData: {
                    date: targetDate.toISOString().split('T')[0],
                    operationWise: [],
                    employeeWise: [],
                    machines: [],
                    summary: {
                        totalScans: 0,
                        totalEmployees: 0,
                        totalMachines: 0,
                        totalUnitsCompleted: 0,
                        efficiency: 0
                    }
                }
            });
        }

        // Extract all scans for this work order
        const allScans = [];
        const employeeMap = new Map();
        const machineMap = new Map();
        const operationMap = new Map();

        productionTracking.machines.forEach(machine => {
            // Add machine to map
            if (machine.machineId) {
                machineMap.set(machine.machineId._id.toString(), {
                    id: machine.machineId._id,
                    name: machine.machineId.name,
                    serialNumber: machine.machineId.serialNumber,
                    type: machine.machineId.type,
                    currentOperator: machine.currentOperatorId,
                    totalScans: 0
                });
            }

            machine.operators.forEach(operator => {
                // Add employee to map
                if (operator.operatorId) {
                    const empId = operator.operatorId._id.toString();
                    if (!employeeMap.has(empId)) {
                        const fullName = `${operator.operatorId.firstName || ''} ${operator.operatorId.lastName || ''}`.trim();
                        employeeMap.set(empId, {
                            id: operator.operatorId._id,
                            name: fullName || 'Unknown Employee',
                            employeeId: operator.operatorId.employeeId || 'N/A',
                            department: operator.operatorId.department || 'N/A',
                            signInTime: operator.signInTime,
                            signOutTime: operator.signOutTime,
                            totalScans: 0,
                            scansByOperation: {},
                            scansByTime: []
                        });
                    }
                }

                // Process barcode scans
                operator.barcodeScans.forEach(scan => {
                    if (scan.barcodeId.includes(workOrder.workOrderNumber)) {
                        const parsed = parseBarcodeId(scan.barcodeId);
                        if (parsed.valid) {
                            const scanData = {
                                barcodeId: scan.barcodeId,
                                timestamp: scan.timeStamp,
                                operatorId: operator.operatorId?._id,
                                operatorName: operator.operatorId?.name,
                                machineId: machine.machineId?._id,
                                machineName: machine.machineId?.name,
                                ...parsed
                            };

                            allScans.push(scanData);

                            // Update employee stats
                            if (operator.operatorId) {
                                const empId = operator.operatorId._id.toString();
                                const employee = employeeMap.get(empId);
                                if (employee) {
                                    employee.totalScans++;

                                    // Group by operation
                                    if (!employee.scansByOperation[parsed.operation]) {
                                        employee.scansByOperation[parsed.operation] = {
                                            count: 0,
                                            units: new Set()
                                        };
                                    }
                                    employee.scansByOperation[parsed.operation].count++;
                                    employee.scansByOperation[parsed.operation].units.add(parsed.unit);

                                    // Track scan time
                                    employee.scansByTime.push({
                                        timestamp: scan.timeStamp,
                                        unit: parsed.unit,
                                        operation: parsed.operation
                                    });
                                }
                            }

                            // Update machine stats
                            if (machine.machineId) {
                                const machineId = machine.machineId._id.toString();
                                const machineData = machineMap.get(machineId);
                                if (machineData) {
                                    machineData.totalScans++;
                                }
                            }

                            // Update operation stats
                            if (!operationMap.has(parsed.operation)) {
                                operationMap.set(parsed.operation, {
                                    operationNumber: parsed.operation,
                                    operationType: workOrder.operations[parsed.operation - 1]?.operationType || `Operation ${parsed.operation}`,
                                    totalScans: 0,
                                    employees: new Map(),
                                    units: new Set(),
                                    machines: new Set()
                                });
                            }
                            const operationData = operationMap.get(parsed.operation);
                            operationData.totalScans++;
                            operationData.units.add(parsed.unit);
                            operationData.machines.add(machine.machineId?._id);

                            // Track employee in this operation
                            if (operator.operatorId) {
                                const empId = operator.operatorId._id.toString();
                                if (!operationData.employees.has(empId)) {
                                    operationData.employees.set(empId, {
                                        employeeId: operator.operatorId._id,
                                        name: operator.operatorId.name,
                                        employeeCode: operator.operatorId.employeeId,
                                        scans: 0,
                                        units: new Set()
                                    });
                                }
                                const empData = operationData.employees.get(empId);
                                empData.scans++;
                                empData.units.add(parsed.unit);
                            }
                        }
                    }
                });
            });
        });

        // Format operation-wise data
        const operationWiseData = Array.from(operationMap.values()).map(op => ({
            operationNumber: op.operationNumber,
            operationType: op.operationType,
            totalScans: op.totalScans,
            totalUnits: op.units.size,
            totalEmployees: op.employees.size,
            totalMachines: op.machines.size,
            employees: Array.from(op.employees.values()).map(emp => ({
                ...emp,
                units: Array.from(emp.units).sort((a, b) => a - b),
                unitsCount: emp.units.size
            })),
            units: Array.from(op.units).sort((a, b) => a - b)
        })).sort((a, b) => a.operationNumber - b.operationNumber);

        // Filter by specific operation if requested
        let filteredOperationData = operationWiseData;
        if (operation) {
            const opNumber = parseInt(operation);
            filteredOperationData = operationWiseData.filter(op => op.operationNumber === opNumber);
        }

        // Format employee-wise data
        const employeeWiseData = Array.from(employeeMap.values()).map(emp => {
            const scansByOpArray = Object.entries(emp.scansByOperation).map(([op, data]) => ({
                operation: parseInt(op),
                operationType: workOrder.operations[parseInt(op) - 1]?.operationType || `Operation ${op}`,
                scans: data.count,
                units: Array.from(data.units).sort((a, b) => a - b),
                unitsCount: data.units.size
            })).sort((a, b) => a.operation - b.operation);

            return {
                id: emp.id,
                name: emp.name,
                employeeId: emp.employeeId,
                department: emp.department,
                signInTime: emp.signInTime,
                signOutTime: emp.signOutTime,
                totalScans: emp.totalScans,
                operationsWorked: scansByOpArray.length,
                scansByOperation: scansByOpArray,
                efficiency: emp.signInTime && emp.signOutTime ?
                    calculateEfficiency(emp.totalScans, emp.signInTime, emp.signOutTime) : 0,
                scanTimes: emp.scansByTime.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
            };
        }).sort((a, b) => b.totalScans - a.totalScans);

        // Format machine data
        const machineData = Array.from(machineMap.values()).map(machine => {
            const currentOperatorName = machine.currentOperatorId ?
                `${machine.currentOperatorId.firstName || ''} ${machine.currentOperatorId.lastName || ''}`.trim() :
                'No Operator';

            return {
                ...machine,
                currentOperator: {
                    id: machine.currentOperatorId?._id,
                    name: currentOperatorName,
                    employeeId: machine.currentOperatorId?.employeeId
                },
                efficiency: machine.totalScans > 0 ? Math.round((machine.totalScans / (employeeWiseData.length * 8)) * 100) : 0
            };
        }).sort((a, b) => b.totalScans - a.totalScans);


        // Calculate summary
        const totalUnitsCompleted = new Set(allScans.map(scan => scan.unit)).size;
        const totalUniqueUnits = new Set(
            allScans
                .filter(scan => {
                    const opScans = allScans.filter(s =>
                        s.unit === scan.unit && s.operation === scan.operation
                    ).length;
                    return opScans > 0; // At least one scan per operation for this unit
                })
                .map(scan => scan.unit)
        ).size;

        const summary = {
            totalScans: allScans.length,
            totalEmployees: employeeWiseData.length,
            totalMachines: machineData.length,
            totalOperations: operationWiseData.length,
            totalUnitsCompleted,
            totalUnitsInProgress: totalUniqueUnits - totalUnitsCompleted,
            totalUnits: workOrder.quantity,
            overallEfficiency: calculateOverallEfficiency(allScans, workOrder.operations?.length || 1),
            date: targetDate.toISOString().split('T')[0]
        };

        res.json({
            success: true,
            workOrder: {
                ...workOrder,
                workOrderNumber: workOrder.workOrderNumber,
                productName: workOrder.stockItemName,
                quantity: workOrder.quantity,
                operations: workOrder.operations || []
            },
            trackingData: {
                date: targetDate.toISOString().split('T')[0],
                operationWise: filteredOperationData,
                employeeWise: employeeWiseData,
                machines: machineData,
                allScans: allScans.slice(0, 100), // Limit scans for response size
                summary
            }
        });

    } catch (error) {
        console.error("Error getting work flow tracking:", error);
        res.status(500).json({
            success: false,
            message: "Server error while getting work flow tracking"
        });
    }
});

// GET data for Excel export
router.get("/:id/export", async (req, res) => {
    try {
        const { id } = req.params;
        const { date, type } = req.query; // type: 'operations', 'employees', 'all'

        // Get tracking data
        const trackingResponse = await fetchTrackingData(id, date);

        if (!trackingResponse.success) {
            return res.status(404).json(trackingResponse);
        }

        const { workOrder, trackingData } = trackingResponse;

        // Prepare Excel data based on type
        let excelData = [];
        let fileName = '';

        switch (type) {
            case 'operations':
                excelData = prepareOperationsExcelData(trackingData.operationWise);
                fileName = `Operations_${workOrder.workOrderNumber}_${trackingData.date}.xlsx`;
                break;

            case 'employees':
                excelData = prepareEmployeesExcelData(trackingData.employeeWise);
                fileName = `Employees_${workOrder.workOrderNumber}_${trackingData.date}.xlsx`;
                break;

            case 'machines':
                excelData = prepareMachinesExcelData(trackingData.machines);
                fileName = `Machines_${workOrder.workOrderNumber}_${trackingData.date}.xlsx`;
                break;

            case 'all':
            default:
                excelData = prepareAllExcelData(workOrder, trackingData);
                fileName = `Complete_Report_${workOrder.workOrderNumber}_${trackingData.date}.xlsx`;
                break;
        }

        res.json({
            success: true,
            data: excelData,
            fileName,
            workOrderNumber: workOrder.workOrderNumber,
            date: trackingData.date,
            summary: trackingData.summary
        });

    } catch (error) {
        console.error("Error exporting data:", error);
        res.status(500).json({
            success: false,
            message: "Server error while exporting data"
        });
    }
});

// Helper functions
async function fetchTrackingData(id, date) {
    // Similar to the tracking endpoint logic
    // This is a simplified version for export
    const response = await router.get(`/${id}/tracking?date=${date}`);
    return response;
}

function prepareOperationsExcelData(operationWise) {
    const data = [];

    // Header
    data.push(['Operation Report - Detailed Analysis']);
    data.push([]);
    data.push(['Operation', 'Operation Type', 'Total Scans', 'Total Units', 'Total Employees', 'Total Machines']);

    // Data rows
    operationWise.forEach(op => {
        data.push([
            `Operation ${op.operationNumber}`,
            op.operationType,
            op.totalScans,
            op.totalUnits,
            op.totalEmployees,
            op.totalMachines
        ]);

        // Sub-header for employees in this operation
        data.push([]);
        data.push(['Employee Details for this Operation:']);
        data.push(['Employee Name', 'Employee ID', 'Scans', 'Units Completed', 'Unit Numbers']);

        // Employee details
        op.employees.forEach(emp => {
            data.push([
                emp.name,
                emp.employeeCode,
                emp.scans,
                emp.unitsCount,
                emp.units.join(', ')
            ]);
        });

        data.push([]);
        data.push(['Unit Numbers Completed:', op.units.join(', ')]);
        data.push([]);
        data.push(['='.repeat(50)]);
        data.push([]);
    });

    return data;
}

function prepareEmployeesExcelData(employeeWise) {
    const data = [];

    // Header
    data.push(['Employee Performance Report']);
    data.push([]);
    data.push(['Employee Name', 'Employee ID', 'Department', 'Total Scans', 'Operations Worked', 'Efficiency %', 'Sign In', 'Sign Out']);

    // Data rows
    employeeWise.forEach(emp => {
        data.push([
            emp.name,
            emp.employeeId,
            emp.department || 'N/A',
            emp.totalScans,
            emp.operationsWorked,
            `${emp.efficiency}%`,
            emp.signInTime ? new Date(emp.signInTime).toLocaleTimeString() : 'N/A',
            emp.signOutTime ? new Date(emp.signOutTime).toLocaleTimeString() : 'N/A'
        ]);

        // Operation-wise details
        if (emp.scansByOperation.length > 0) {
            data.push([]);
            data.push(['Operation-wise Performance:']);
            data.push(['Operation', 'Operation Type', 'Scans', 'Units Completed', 'Unit Numbers']);

            emp.scansByOperation.forEach(op => {
                data.push([
                    `Operation ${op.operation}`,
                    op.operationType,
                    op.scans,
                    op.unitsCount,
                    op.units.join(', ')
                ]);
            });

            data.push([]);
        }

        data.push(['='.repeat(50)]);
        data.push([]);
    });

    return data;
}

function prepareMachinesExcelData(machines) {
    const data = [];

    // Header
    data.push(['Machine Utilization Report']);
    data.push([]);
    data.push(['Machine Name', 'Serial Number', 'Type', 'Total Scans', 'Current Operator', 'Efficiency %']);

    // Data rows
    machines.forEach(machine => {
        data.push([
            machine.name,
            machine.serialNumber,
            machine.type,
            machine.totalScans,
            machine.currentOperator?.name || 'N/A',
            `${machine.efficiency}%`
        ]);
    });

    return data;
}

function prepareAllExcelData(workOrder, trackingData) {
    const data = [];

    // Cover page
    data.push(['COMPLETE PRODUCTION TRACKING REPORT']);
    data.push([]);
    data.push(['Work Order:', workOrder.workOrderNumber]);
    data.push(['Product:', workOrder.productName]);
    data.push(['Order Quantity:', workOrder.quantity]);
    data.push(['Report Date:', trackingData.date]);
    data.push(['Generated On:', new Date().toLocaleString()]);
    data.push([]);
    data.push(['='.repeat(80)]);
    data.push([]);

    // Summary
    data.push(['PRODUCTION SUMMARY']);
    data.push([]);
    data.push(['Total Scans:', trackingData.summary.totalScans]);
    data.push(['Total Employees:', trackingData.summary.totalEmployees]);
    data.push(['Total Machines:', trackingData.summary.totalMachines]);
    data.push(['Units Completed:', trackingData.summary.totalUnitsCompleted]);
    data.push(['Units In Progress:', trackingData.summary.totalUnitsInProgress]);
    data.push(['Total Units:', trackingData.summary.totalUnits]);
    data.push(['Overall Efficiency:', `${trackingData.summary.overallEfficiency}%`]);
    data.push([]);
    data.push(['='.repeat(80)]);
    data.push([]);

    // Operations Report
    data.push(['OPERATIONS PERFORMANCE REPORT']);
    data.push([]);
    data.push(...prepareOperationsExcelData(trackingData.operationWise).slice(2));
    data.push([]);
    data.push(['='.repeat(80)]);
    data.push([]);

    // Employees Report
    data.push(['EMPLOYEES PERFORMANCE REPORT']);
    data.push([]);
    data.push(...prepareEmployeesExcelData(trackingData.employeeWise).slice(2));
    data.push([]);
    data.push(['='.repeat(80)]);
    data.push([]);

    // Machines Report
    data.push(['MACHINES UTILIZATION REPORT']);
    data.push([]);
    data.push(...prepareMachinesExcelData(trackingData.machines).slice(2));

    return data;
}

function calculateEfficiency(totalScans, signInTime, signOutTime) {
    if (!signInTime || !signOutTime || totalScans === 0) return 0;

    const workDuration = (new Date(signOutTime) - new Date(signInTime)) / 1000 / 3600; // hours
    const scansPerHour = totalScans / workDuration;

    // Assuming 20 scans/hour is 100% efficiency (adjust as needed)
    const targetScansPerHour = 20;
    const efficiency = Math.min(100, Math.round((scansPerHour / targetScansPerHour) * 100));

    return efficiency;
}

function calculateOverallEfficiency(scans, totalOperations) {
    if (scans.length === 0 || totalOperations === 0) return 0;

    // Group scans by unit and operation
    const unitOperations = new Map();

    scans.forEach(scan => {
        const key = `${scan.unit}-${scan.operation}`;
        if (!unitOperations.has(key)) {
            unitOperations.set(key, 1);
        }
    });

    const totalUnitOperations = scans.reduce((sum, scan) => {
        const key = `${scan.unit}-${scan.operation}`;
        return unitOperations.has(key) ? sum + 1 : sum;
    }, 0);

    const expectedUnitOperations = new Set(scans.map(s => s.unit)).size * totalOperations;
    const efficiency = Math.min(100, Math.round((totalUnitOperations / expectedUnitOperations) * 100));

    return efficiency;
}

module.exports = router;