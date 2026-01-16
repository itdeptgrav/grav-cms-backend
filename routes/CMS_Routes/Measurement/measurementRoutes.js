const express = require('express');
const router = express.Router();
const Measurement = require('../../../models/Customer_Models/Measurement');
const Customer = require('../../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');
const OrganizationDepartment = require('../../../models/CMS_Models/Configuration/OrganizationDepartment');
const StockItem = require('../../../models/CMS_Models/Inventory/Products/StockItem');
const EmployeeAuthMiddleware = require('../../../Middlewear/EmployeeAuthMiddlewear');

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// GET organizations with measurement stats
router.get('/organizations', async (req, res) => {
    try {
        // Get all customers with employees
        const customers = await Customer.find({})
            .select('_id name email phone createdAt')
            .sort({ name: 1 })
            .lean();

        // Get employee counts for each customer
        const employeeStats = await EmployeeMpc.aggregate([
            {
                $group: {
                    _id: '$customerId',
                    totalEmployees: { $sum: 1 },
                    activeEmployees: {
                        $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
                    }
                }
            }
        ]);

        // Get measurement stats for each customer
        const measurementStats = await Measurement.aggregate([
            {
                $group: {
                    _id: '$organizationId',
                    totalMeasurements: { $sum: 1 },
                    lastUpdated: { $max: '$updatedAt' }
                }
            }
        ]);

        // Map stats to customers
        const employeeMap = new Map();
        employeeStats.forEach(stat => {
            employeeMap.set(stat._id.toString(), {
                totalEmployees: stat.totalEmployees,
                activeEmployees: stat.activeEmployees
            });
        });

        const measurementMap = new Map();
        measurementStats.forEach(stat => {
            measurementMap.set(stat._id.toString(), {
                totalMeasurements: stat.totalMeasurements,
                lastUpdated: stat.lastUpdated
            });
        });

        const organizations = customers.map(customer => ({
            ...customer,
            employeeStats: employeeMap.get(customer._id.toString()) || {
                totalEmployees: 0,
                activeEmployees: 0
            },
            measurementStats: measurementMap.get(customer._id.toString()) || {
                totalMeasurements: 0,
                lastUpdated: null
            }
        }));

        res.status(200).json({
            success: true,
            organizations,
            stats: {
                totalOrganizations: organizations.length,
                organizationsWithEmployees: organizations.filter(o => o.employeeStats.totalEmployees > 0).length,
                organizationsWithMeasurements: organizations.filter(o => o.measurementStats.totalMeasurements > 0).length
            }
        });

    } catch (error) {
        console.error('Error fetching organizations:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching organizations'
        });
    }
});

// GET stock items for a specific department
router.get('/organization/:orgId/department/:department/stock-items', async (req, res) => {
    try {
        const { orgId, department } = req.params;
        const decodedDepartment = decodeURIComponent(department);

        // Get organization departments to find assigned stock items
        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active',
            'departments.name': decodedDepartment
        })
            .populate({
                path: 'departments.designations.assignedStockItems.stockItemId',
                select: '_id name reference category measurements'
            })
            .lean();

        let stockItems = [];

        if (orgDept && orgDept.departments) {
            const dept = orgDept.departments.find(d => d.name === decodedDepartment);
            if (dept && dept.designations) {
                // Get all unique stock items from all designations in this department
                const stockItemMap = new Map();

                dept.designations.forEach(designation => {
                    if (designation.assignedStockItems && designation.status === 'active') {
                        designation.assignedStockItems.forEach(item => {
                            if (item.stockItemId && item.stockItemId._id) {
                                const stockItemId = item.stockItemId._id.toString();
                                if (!stockItemMap.has(stockItemId)) {
                                    stockItemMap.set(stockItemId, {
                                        _id: item.stockItemId._id,
                                        name: item.stockItemId.name,
                                        reference: item.stockItemId.reference,
                                        category: item.stockItemId.category,
                                        measurementNames: item.stockItemId.measurements || []
                                    });
                                }
                            }
                        });
                    }
                });

                stockItems = Array.from(stockItemMap.values());
            }
        }

        res.status(200).json({
            success: true,
            stockItems
        });

    } catch (error) {
        console.error('Error fetching department stock items:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching department stock items'
        });
    }
});

// GET organization departments with stock items by designation
router.get('/organization/:orgId/departments-with-items', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get organization departments with populated stock items
        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active'
        })
            .populate({
                path: 'departments.designations.assignedStockItems.stockItemId',
                select: '_id name reference category measurements',
                match: { measurements: { $exists: true, $not: { $size: 0 } } }
            })
            .lean();

        if (!orgDept) {
            return res.status(404).json({
                success: false,
                message: 'Organization departments not found'
            });
        }

        // Process departments to include only active designations with stock items
        const departments = orgDept.departments
            .filter(dept => dept.status === 'active')
            .map(dept => ({
                name: dept.name,
                designations: dept.designations
                    .filter(desig => desig.status === 'active')
                    .map(desig => ({
                        name: desig.name,
                        assignedStockItems: (desig.assignedStockItems || [])
                            .filter(item => item.stockItemId && item.stockItemId._id)
                            .map(item => ({
                                stockItemId: item.stockItemId,
                                assignedAt: item.assignedAt
                            }))
                    }))
                    .filter(desig => desig.assignedStockItems.length > 0)
            }))
            .filter(dept => dept.designations.length > 0);

        res.status(200).json({
            success: true,
            departments
        });

    } catch (error) {
        console.error('Error fetching departments with items:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching departments with stock items'
        });
    }
});

// GET organization employees
router.get('/organization/:orgId/employees', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get organization details
        const customer = await Customer.findById(orgId)
            .select('_id name email phone')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        // Get active employees
        const employees = await EmployeeMpc.find({
            customerId: orgId,
            status: 'active'
        })
            .select('_id name uin department designation')
            .sort({ name: 1 })
            .lean();

        res.status(200).json({
            success: true,
            organization: customer,
            employees
        });

    } catch (error) {
        console.error('Error fetching organization employees:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching employees'
        });
    }
});

// GET organization details
router.get('/organization/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get customer details
        const customer = await Customer.findById(orgId)
            .select('_id name email phone')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        // Get employee stats
        const employeeStats = await EmployeeMpc.aggregate([
            { $match: { customerId: orgId } },
            {
                $group: {
                    _id: null,
                    totalEmployees: { $sum: 1 },
                    activeEmployees: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } }
                }
            }
        ]);

        // Get measurement stats for this organization
        const measurementStats = await Measurement.aggregate([
            { $match: { organizationId: orgId } },
            {
                $group: {
                    _id: null,
                    totalMeasurements: { $sum: 1 },
                    lastUpdated: { $max: '$updatedAt' }
                }
            }
        ]);

        res.status(200).json({
            success: true,
            organization: {
                ...customer,
                employeeStats: employeeStats[0] || {
                    totalEmployees: 0,
                    activeEmployees: 0
                },
                measurementStats: measurementStats[0] || {
                    totalMeasurements: 0,
                    lastUpdated: null
                }
            }
        });

    } catch (error) {
        console.error('Error fetching organization:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching organization'
        });
    }
});

// GET organization measurements
router.get('/organization/:orgId/measurements', async (req, res) => {
    try {
        const { orgId } = req.params;

        const measurements = await Measurement.find({ organizationId: orgId })
            .select('name description totalRegisteredEmployees measuredEmployees pendingEmployees completionRate totalMeasurements completedMeasurements pendingMeasurements createdAt updatedAt')
            .sort({ createdAt: -1 })
            .lean();

        res.status(200).json({
            success: true,
            measurements: measurements.map(m => ({
                ...m,
                employeeCount: m.totalRegisteredEmployees,
                completedCount: m.measuredEmployees,
                pendingCount: m.pendingEmployees
            }))
        });

    } catch (error) {
        console.error('Error fetching measurements:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching measurements'
        });
    }
});

// GET organization data for creating measurement
router.get('/organization/:orgId/data', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get organization details
        const customer = await Customer.findById(orgId)
            .select('_id name email phone')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        // Get active employees
        const employees = await EmployeeMpc.find({
            customerId: orgId,
            status: 'active'
        })
            .select('_id name uin department designation gender')
            .sort({ name: 1 })
            .lean();

        // Get departments from organization departments
        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active'
        }).lean();

        let departments = [];
        if (orgDept && orgDept.departments) {
            departments = orgDept.departments
                .filter(dept => dept.status === 'active')
                .map(dept => dept.name);
        }

        // Get stock items that have measurements defined
        const stockItems = await StockItem.find({
            measurements: { $exists: true, $not: { $size: 0 } }
        })
            .select('_id name reference category measurements')
            .lean();

        res.status(200).json({
            success: true,
            organization: customer,
            employees,
            departments,
            stockItems
        });

    } catch (error) {
        console.error('Error fetching organization data:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching organization data'
        });
    }
});

// CREATE new measurement (updated)
router.post('/', async (req, res) => {
    try {
        const { organizationId, name, description, measurementData, registeredEmployeeIds } = req.body;

        // Validation
        if (!organizationId) {
            return res.status(400).json({
                success: false,
                message: 'Organization ID is required'
            });
        }

        if (!name || !name.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Measurement name is required'
            });
        }

        // Get organization details
        const customer = await Customer.findById(organizationId)
            .select('_id name')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        // Group measurements by employee
        const employeeMeasurementsMap = new Map();

        measurementData.forEach(data => {
            const employeeId = data.employeeId;

            if (!employeeMeasurementsMap.has(employeeId)) {
                employeeMeasurementsMap.set(employeeId, {
                    employeeId: data.employeeId,
                    employeeName: data.employeeName,
                    employeeUIN: data.employeeUIN,
                    department: data.department,
                    designation: data.designation,
                    stockItems: []
                });
            }

            const employeeData = employeeMeasurementsMap.get(employeeId);

            // Convert measurements to array format
            const measurementsArray = [];
            if (data.measurements && Array.isArray(data.measurements)) {
                measurementsArray.push(...data.measurements);
            } else if (data.measurements && typeof data.measurements === 'object') {
                Object.entries(data.measurements).forEach(([measurementName, value]) => {
                    measurementsArray.push({
                        measurementName,
                        value: value || '',
                        unit: ''
                    });
                });
            }

            // Check if stock item already exists for this employee
            const existingStockItemIndex = employeeData.stockItems.findIndex(
                item => item.stockItemId.toString() === data.stockItemId.toString()
            );

            if (existingStockItemIndex >= 0) {
                // Update existing stock item measurements
                employeeData.stockItems[existingStockItemIndex] = {
                    ...employeeData.stockItems[existingStockItemIndex],
                    measurements: measurementsArray,
                    measuredAt: new Date()
                };
            } else {
                // Add new stock item
                employeeData.stockItems.push({
                    stockItemId: data.stockItemId,
                    stockItemName: data.stockItemName,
                    measurements: measurementsArray,
                    measuredAt: new Date()
                });
            }
        });

        // Convert map to array and calculate completion
        const employeeMeasurements = Array.from(employeeMeasurementsMap.values()).map(emp => {
            const isCompleted = emp.stockItems.length > 0 && emp.stockItems.every(stockItem =>
                stockItem.measurements.length > 0 &&
                stockItem.measurements.every(m => m.value && m.value.trim() !== '')
            );

            return {
                ...emp,
                isCompleted,
                completedAt: isCompleted ? new Date() : null
            };
        });

        // Create new measurement
        const newMeasurement = new Measurement({
            organizationId: customer._id,
            organizationName: customer.name,
            name: name.trim(),
            description: description ? description.trim() : '',
            registeredEmployeeIds: registeredEmployeeIds || [],
            employeeMeasurements: employeeMeasurements,
            createdBy: req.user.id
        });

        await newMeasurement.save();

        res.status(201).json({
            success: true,
            message: 'Measurement created successfully',
            measurement: newMeasurement
        });

    } catch (error) {
        console.error('Error creating measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while creating measurement'
        });
    }
});

// GET single measurement (updated)
router.get('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;

        const measurement = await Measurement.findById(measurementId)
            .populate({
                path: 'employeeMeasurements.stockItems.stockItemId',
                select: 'name reference category measurements'
            })
            .lean();

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Calculate additional statistics for frontend
        const totalEmployees = await EmployeeMpc.countDocuments({
            customerId: measurement.organizationId,
            status: 'active'
        });

        // Get employee details for registered employees
        const registeredEmployees = await EmployeeMpc.find({
            _id: { $in: measurement.registeredEmployeeIds || [] }
        })
            .select('_id name uin department designation')
            .lean();

        // Calculate employee statistics
        const measuredEmployeeIds = new Set();
        measurement.employeeMeasurements.forEach(emp => {
            if (emp.employeeId) {
                measuredEmployeeIds.add(emp.employeeId.toString());
            }
        });

        const measuredCount = measuredEmployeeIds.size;
        const registeredCount = measurement.registeredEmployeeIds?.length || 0;
        const remainingCount = registeredCount - measuredCount;
        const registeredPercentage = totalEmployees > 0 ? Math.round((registeredCount / totalEmployees) * 100) : 0;
        const measuredPercentage = registeredCount > 0 ? Math.round((measuredCount / registeredCount) * 100) : 0;

        // Calculate measurement field statistics
        let totalMeasurementFields = 0;
        let completedMeasurementFields = 0;

        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                totalMeasurementFields += stockItem.measurements.length;
                completedMeasurementFields += stockItem.measurements.filter(m =>
                    m.value && m.value.trim() !== ""
                ).length;
            });
        });

        const measurementCompletionRate = totalMeasurementFields > 0
            ? Math.round((completedMeasurementFields / totalMeasurementFields) * 100)
            : 0;

        res.status(200).json({
            success: true,
            measurement: {
                ...measurement,
                totalEmployees: totalEmployees,
                employeeStats: {
                    total: totalEmployees,
                    registered: registeredCount,
                    measured: measuredCount,
                    remaining: remainingCount,
                    registeredPercentage: registeredPercentage,
                    measuredPercentage: measuredPercentage
                },
                measurementStats: {
                    total: totalMeasurementFields,
                    completed: completedMeasurementFields,
                    pending: totalMeasurementFields - completedMeasurementFields,
                    completionRate: measurementCompletionRate
                },
                registeredEmployees: registeredEmployees
            }
        });

    } catch (error) {
        console.error('Error fetching measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching measurement'
        });
    }
});

// UPDATE measurement (updated)
// UPDATE measurement (simpler approach)
// UPDATE measurement - SIMPLE FIX
// UPDATE measurement - COMPLETE REPLACEMENT METHOD
router.put('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { name, description, measurementData, registeredEmployeeIds } = req.body;

        console.log('UPDATE REQUEST - Complete Replacement Method');

        // Find measurement
        const measurement = await Measurement.findById(measurementId);
        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Store original for reference
        const originalMeasurement = {
            employeeMeasurements: [...measurement.employeeMeasurements.map(emp => emp.toObject ? emp.toObject() : emp)],
            registeredEmployeeIds: [...measurement.registeredEmployeeIds]
        };

        console.log('Original has', originalMeasurement.employeeMeasurements.length, 'employees');
        console.log('Original registered employees:', originalMeasurement.registeredEmployeeIds.length);

        // Update basic fields
        if (name !== undefined) measurement.name = name.trim();
        if (description !== undefined) measurement.description = description ? description.trim() : '';
        if (registeredEmployeeIds !== undefined) {
            measurement.registeredEmployeeIds = registeredEmployeeIds;
        }

        // If no measurementData, keep existing measurements
        if (!measurementData || !Array.isArray(measurementData)) {
            measurement.updatedBy = req.user.id;
            measurement.updatedAt = new Date();
            await measurement.save();
            
            return res.status(200).json({
                success: true,
                message: 'Basic info updated, measurements unchanged',
                measurement
            });
        }

        // COMPLETE REPLACEMENT APPROACH
        // 1. Group ALL incoming data by employee
        const allEmployeeData = new Map();
        
        measurementData.forEach(data => {
            if (!data.employeeId || !data.stockItemId) return;
            
            const employeeId = data.employeeId.toString();
            const stockItemId = data.stockItemId.toString();
            
            if (!allEmployeeData.has(employeeId)) {
                allEmployeeData.set(employeeId, {
                    employeeId: data.employeeId,
                    employeeName: data.employeeName,
                    employeeUIN: data.employeeUIN,
                    department: data.department,
                    designation: data.designation,
                    stockItems: new Map()
                });
            }
            
            const empData = allEmployeeData.get(employeeId);
            
            // Convert measurements
            const measurementsArray = [];
            if (data.measurements && Array.isArray(data.measurements)) {
                measurementsArray.push(...data.measurements);
            } else if (data.measurements && typeof data.measurements === 'object') {
                Object.entries(data.measurements).forEach(([name, value]) => {
                    measurementsArray.push({
                        measurementName: name,
                        value: value || '',
                        unit: ''
                    });
                });
            }
            
            empData.stockItems.set(stockItemId, {
                stockItemId: data.stockItemId,
                stockItemName: data.stockItemName,
                measurements: measurementsArray,
                measuredAt: new Date()
            });
        });

        // 2. For employees NOT in incoming data, check if we should keep their existing data
        originalMeasurement.employeeMeasurements.forEach(originalEmp => {
            const empId = originalEmp.employeeId.toString();
            
            if (!allEmployeeData.has(empId)) {
                // This employee is NOT in incoming data
                // We need to decide: keep existing or remove?
                // Let's keep them (preserve existing measurements)
                
                const stockItemMap = new Map();
                originalEmp.stockItems.forEach(item => {
                    stockItemMap.set(item.stockItemId.toString(), {
                        stockItemId: item.stockItemId,
                        stockItemName: item.stockItemName,
                        measurements: item.measurements,
                        measuredAt: item.measuredAt || new Date()
                    });
                });
                
                allEmployeeData.set(empId, {
                    employeeId: originalEmp.employeeId,
                    employeeName: originalEmp.employeeName,
                    employeeUIN: originalEmp.employeeUIN,
                    department: originalEmp.department,
                    designation: originalEmp.designation,
                    stockItems: stockItemMap,
                    isCompleted: originalEmp.isCompleted,
                    completedAt: originalEmp.completedAt
                });
                
                console.log(`Preserving existing employee ${originalEmp.employeeName}`);
            }
        });

        // 3. Build COMPLETELY NEW employeeMeasurements array
        const newEmployeeMeasurements = [];
        
        allEmployeeData.forEach((empData, empId) => {
            const stockItemsArray = Array.from(empData.stockItems.values());
            
            // Check if this is an existing employee with preserved data
            const existingEmp = originalMeasurement.employeeMeasurements.find(e => 
                e.employeeId.toString() === empId
            );
            
            const isCompleted = stockItemsArray.length > 0 && 
                stockItemsArray.every(item =>
                    item.measurements && Array.isArray(item.measurements) &&
                    item.measurements.every(m => m && m.value && m.value.trim() !== '')
                );
            
            newEmployeeMeasurements.push({
                employeeId: empData.employeeId,
                employeeName: empData.employeeName,
                employeeUIN: empData.employeeUIN,
                department: empData.department,
                designation: empData.designation,
                stockItems: stockItemsArray,
                isCompleted: isCompleted,
                completedAt: isCompleted ? new Date() : (empData.completedAt || null)
            });
        });

        // 4. REPLACE the entire array
        measurement.employeeMeasurements = newEmployeeMeasurements;
        
        console.log('Final employee count:', measurement.employeeMeasurements.length);
        measurement.employeeMeasurements.forEach((emp, idx) => {
            console.log(`Employee ${idx + 1}: ${emp.employeeName}, Items: ${emp.stockItems.length}`);
        });

        measurement.updatedBy = req.user.id;
        measurement.updatedAt = new Date();
        
        const savedMeasurement = await measurement.save();
        
        res.status(200).json({
            success: true,
            message: 'Measurement completely rebuilt and saved',
            measurement: savedMeasurement
        });

    } catch (error) {
        console.error('Error in complete replacement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error',
            error: error.message
        });
    }
});

// DELETE measurement
router.delete('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;

        const measurement = await Measurement.findByIdAndDelete(measurementId);

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        res.status(200).json({
            success: true,
            message: 'Measurement deleted successfully'
        });

    } catch (error) {
        console.error('Error deleting measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while deleting measurement'
        });
    }
});

// Export measurement to CSV (updated)
router.get('/:measurementId/export', async (req, res) => {
    try {
        const { measurementId } = req.params;

        const measurement = await Measurement.findById(measurementId)
            .populate({
                path: 'employeeMeasurements.stockItems.stockItemId',
                select: 'name reference'
            })
            .lean();

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Get all unique measurement names
        const allMeasurements = new Set();
        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                stockItem.measurements.forEach(m => {
                    allMeasurements.add(m.measurementName);
                });
            });
        });

        const measurementNames = Array.from(allMeasurements);

        // Create CSV headers
        const headers = [
            'Employee Name',
            'UIN',
            'Department',
            'Designation',
            'Stock Item',
            'Stock Item Reference'
        ].concat(measurementNames.map(name => `${name}`));

        // Create CSV rows
        const rows = measurement.employeeMeasurements.flatMap(emp =>
            emp.stockItems.map(stockItem => {
                const baseData = [
                    `"${emp.employeeName}"`,
                    emp.employeeUIN,
                    emp.department,
                    emp.designation,
                    `"${stockItem.stockItemName}"`,
                    stockItem.stockItemId?.reference || ''
                ];

                // Add measurement values in the same order as headers
                const measurementValues = measurementNames.map(name => {
                    const measurement = stockItem.measurements.find(m => m.measurementName === name);
                    return measurement ? measurement.value : '';
                });

                return [...baseData, ...measurementValues];
            })
        );

        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${measurement.name}_${measurementId}.csv"`);
        res.send(csvContent);

    } catch (error) {
        console.error('Error exporting measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting measurement'
        });
    }
});


module.exports = router;