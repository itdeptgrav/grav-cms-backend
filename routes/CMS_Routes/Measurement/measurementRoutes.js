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


// ADD NEW EMPLOYEES to existing measurement (NEW ROUTE)
router.put('/:measurementId/add-employees', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { measurementData, newEmployeeIds, updatedRegisteredEmployeeIds } = req.body;

        console.log('ADD EMPLOYEES REQUEST:', {
            newEmployeeCount: newEmployeeIds?.length || 0,
            measurementDataCount: measurementData?.length || 0
        });

        // Find measurement
        const measurement = await Measurement.findById(measurementId);
        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Update registered employees list
        if (updatedRegisteredEmployeeIds && Array.isArray(updatedRegisteredEmployeeIds)) {
            measurement.registeredEmployeeIds = [...new Set(updatedRegisteredEmployeeIds)];
        }

        // Process new employee data
        if (measurementData && Array.isArray(measurementData)) {
            // Create a map of existing employees for quick lookup
            const existingEmployeeMap = new Map();
            measurement.employeeMeasurements.forEach(emp => {
                existingEmployeeMap.set(emp.employeeId.toString(), emp);
            });

            // Group incoming data by employee
            const newEmployeesMap = new Map();

            measurementData.forEach(data => {
                if (!data.employeeId || !data.stockItemId) {
                    console.log('Skipping invalid data:', data);
                    return;
                }

                const employeeId = data.employeeId.toString();

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

                if (!newEmployeesMap.has(employeeId)) {
                    newEmployeesMap.set(employeeId, {
                        employeeId: data.employeeId,
                        employeeName: data.employeeName,
                        employeeUIN: data.employeeUIN,
                        department: data.department,
                        designation: data.designation,
                        stockItems: []
                    });
                }

                const employeeData = newEmployeesMap.get(employeeId);

                // Add stock item for this employee
                employeeData.stockItems.push({
                    stockItemId: data.stockItemId,
                    stockItemName: data.stockItemName,
                    measurements: measurementsArray,
                    measuredAt: new Date()
                });
            });

            // Add new employees to the measurement
            newEmployeesMap.forEach((newEmployeeData, employeeId) => {
                // Check if employee already exists (should not happen, but just in case)
                if (!existingEmployeeMap.has(employeeId)) {
                    const isCompleted = newEmployeeData.stockItems.length > 0 &&
                        newEmployeeData.stockItems.every(stockItem =>
                            stockItem.measurements.length > 0 &&
                            stockItem.measurements.every(m => m.value && m.value.trim() !== '')
                        );

                    // Add new employee with their measurements
                    measurement.employeeMeasurements.push({
                        employeeId: newEmployeeData.employeeId,
                        employeeName: newEmployeeData.employeeName,
                        employeeUIN: newEmployeeData.employeeUIN,
                        department: newEmployeeData.department,
                        designation: newEmployeeData.designation,
                        stockItems: newEmployeeData.stockItems,
                        isCompleted: isCompleted,
                        completedAt: isCompleted ? new Date() : null
                    });
                } else {
                    console.log(`Employee ${employeeId} already exists in measurement, skipping...`);
                }
            });
        }

        measurement.updatedBy = req.user.id;
        measurement.updatedAt = new Date();

        const savedMeasurement = await measurement.save();
        console.log(`Successfully added ${newEmployeeIds?.length || 0} new employees`);

        res.status(200).json({
            success: true,
            message: `Added ${newEmployeeIds?.length || 0} new employees to measurement`,
            measurement: savedMeasurement
        });

    } catch (error) {
        console.error('Error adding employees to measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while adding employees',
            error: error.message
        });
    }
});

// UPDATE measurement (updated)
// UPDATE measurement (simpler approach)
// UPDATE measurement - SIMPLE FIX
// UPDATE measurement - EDIT EXISTING EMPLOYEES ONLY
router.put('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { name, description, measurementData, registeredEmployeeIds } = req.body;

        console.log('EDIT REQUEST - Existing employees only');
        console.log('Measurement data count:', measurementData?.length);

        // Find measurement
        const measurement = await Measurement.findById(measurementId);
        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Update basic fields
        if (name !== undefined) measurement.name = name.trim();
        if (description !== undefined) measurement.description = description ? description.trim() : '';
        if (registeredEmployeeIds !== undefined) {
            measurement.registeredEmployeeIds = registeredEmployeeIds;
        }

        // If measurementData is provided, update measurements for EXISTING employees only
        if (measurementData && Array.isArray(measurementData)) {
            console.log('Processing', measurementData.length, 'measurement records for existing employees');

            // Create a map of existing employees for quick lookup
            const existingEmployeeMap = new Map();
            measurement.employeeMeasurements.forEach(emp => {
                existingEmployeeMap.set(emp.employeeId.toString(), emp);
            });

            // Group incoming data by employee and stock item
            const incomingUpdates = new Map();

            measurementData.forEach(data => {
                if (!data.employeeId || !data.stockItemId) {
                    console.log('Skipping invalid data:', data);
                    return;
                }

                const employeeId = data.employeeId.toString();
                const stockItemId = data.stockItemId.toString();
                const key = `${employeeId}_${stockItemId}`;

                // Convert measurements
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

                incomingUpdates.set(key, {
                    employeeId: data.employeeId,
                    stockItemId: data.stockItemId,
                    measurements: measurementsArray
                });
            });

            // Update only existing employees' measurements
            measurement.employeeMeasurements = measurement.employeeMeasurements.map(emp => {
                const employeeId = emp.employeeId.toString();

                // Update stock items for this employee
                const updatedStockItems = emp.stockItems.map(stockItem => {
                    const stockItemId = stockItem.stockItemId.toString();
                    const key = `${employeeId}_${stockItemId}`;

                    if (incomingUpdates.has(key)) {
                        // Update this stock item's measurements
                        return {
                            ...stockItem.toObject ? stockItem.toObject() : stockItem,
                            measurements: incomingUpdates.get(key).measurements,
                            measuredAt: new Date()
                        };
                    }

                    // Keep existing stock item unchanged
                    return stockItem;
                });

                // Calculate completion for this employee
                const isCompleted = updatedStockItems.length > 0 &&
                    updatedStockItems.every(stockItem =>
                        stockItem.measurements && Array.isArray(stockItem.measurements) &&
                        stockItem.measurements.length > 0 &&
                        stockItem.measurements.every(m =>
                            m && m.value && typeof m.value === 'string' && m.value.trim() !== ''
                        )
                    );

                return {
                    ...emp.toObject ? emp.toObject() : emp,
                    stockItems: updatedStockItems,
                    isCompleted: isCompleted,
                    completedAt: isCompleted ? new Date() : emp.completedAt
                };
            });

            console.log('Updated existing employee measurements');
        }

        measurement.updatedBy = req.user.id;
        measurement.updatedAt = new Date();

        const savedMeasurement = await measurement.save();

        res.status(200).json({
            success: true,
            message: 'Measurement updated successfully',
            measurement: savedMeasurement
        });

    } catch (error) {
        console.error('Error updating measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while updating measurement',
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