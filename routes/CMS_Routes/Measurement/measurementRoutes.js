const express = require('express');
const router = express.Router();
const Measurement = require('../../../models/Customer_Models/Measurement');
const Customer = require('../../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../../models/CMS_Models/Inventory/Products/StockItem');
const EmployeeAuthMiddleware = require('../../../Middlewear/EmployeeAuthMiddlewear');
const CustomerRequest = require('../../../models/Customer_Models/CustomerRequest');
const mongoose = require('mongoose');

router.use(EmployeeAuthMiddleware);

// GET organizations with measurement stats
router.get('/organizations', async (req, res) => {
    try {
        const customers = await Customer.find({})
            .select('_id name email phone createdAt')
            .sort({ name: 1 })
            .lean();

        const [employeeStats, measurementStats] = await Promise.all([
            EmployeeMpc.aggregate([
                { $group: { _id: '$customerId', totalEmployees: { $sum: 1 }, activeEmployees: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }
            ]),
            Measurement.aggregate([
                { $group: { _id: '$organizationId', totalMeasurements: { $sum: 1 }, lastUpdated: { $max: '$updatedAt' } } }
            ])
        ]);

        const employeeMap = new Map(employeeStats.map(s => [s._id.toString(), s]));
        const measurementMap = new Map(measurementStats.map(s => [s._id.toString(), s]));

        const organizations = customers.map(customer => ({
            ...customer,
            employeeStats: employeeMap.get(customer._id.toString()) || { totalEmployees: 0, activeEmployees: 0 },
            measurementStats: measurementMap.get(customer._id.toString()) || { totalMeasurements: 0, lastUpdated: null }
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
        res.status(500).json({ success: false, message: 'Server error while fetching organizations' });
    }
});

// GET organization employees with their products (measurements included)
router.get('/organization/:orgId/employees', async (req, res) => {
    try {
        const { orgId } = req.params;

        const customer = await Customer.findById(orgId).select('_id name email phone').lean();
        if (!customer) return res.status(404).json({ success: false, message: 'Organization not found' });

        const employees = await EmployeeMpc.find({ customerId: orgId, status: 'active' })
            .select('_id name uin gender products')
            .populate({
                path: 'products.productId',
                select: '_id name reference measurements variants'
            })
            .lean();

        res.status(200).json({ success: true, organization: customer, employees });
    } catch (error) {
        console.error('Error fetching organization employees:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching employees' });
    }
});

// GET stock item by productId
router.get('/stock-item/:productId', async (req, res) => {
    try {
        const stockItem = await StockItem.findById(req.params.productId)
            .select('name reference measurements variants')
            .lean();

        if (!stockItem) return res.status(404).json({ success: false, message: 'Product not found' });

        res.status(200).json({ success: true, stockItem: { ...stockItem, measurements: stockItem.measurements || [] } });
    } catch (error) {
        console.error('Error fetching stock item:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching product' });
    }
});

// GET organization details with employee stats
router.get('/organization/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;

        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({ success: false, message: 'Valid organization ID is required' });
        }

        const customer = await Customer.findById(orgId).select('_id name email phone').lean();
        if (!customer) return res.status(404).json({ success: false, message: 'Organization not found' });

        const [employeeStats, productStats, measurementStats] = await Promise.all([
            EmployeeMpc.aggregate([
                { $match: { customerId: new mongoose.Types.ObjectId(orgId) } },
                { $group: { _id: null, totalEmployees: { $sum: 1 }, activeEmployees: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } } } }
            ]),
            EmployeeMpc.aggregate([
                { $match: { customerId: new mongoose.Types.ObjectId(orgId) } },
                { $unwind: { path: "$products", preserveNullAndEmptyArrays: true } },
                { $group: { _id: null, totalProductAssignments: { $sum: 1 }, uniqueProducts: { $addToSet: "$products.productId" } } }
            ]),
            Measurement.aggregate([
                { $match: { organizationId: new mongoose.Types.ObjectId(orgId) } },
                { $group: { _id: null, totalMeasurements: { $sum: 1 }, lastUpdated: { $max: '$updatedAt' } } }
            ])
        ]);

        res.status(200).json({
            success: true,
            organization: {
                ...customer,
                employeeStats: employeeStats[0] || { totalEmployees: 0, activeEmployees: 0 },
                productStats: { totalAssignments: productStats[0]?.totalProductAssignments || 0, uniqueProducts: productStats[0]?.uniqueProducts?.length || 0 },
                measurementStats: measurementStats[0] || { totalMeasurements: 0, lastUpdated: null }
            }
        });
    } catch (error) {
        console.error('Error fetching organization:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching organization' });
    }
});

// ─── Helper: build employee measurements map from measurementData ─────────────
async function buildEmployeeMeasurementsMap(measurementData, categoryData) {
    const employeeMeasurementsMap = new Map();

    // Batch-fetch all stock items needed
    const stockItemIds = [...new Set((measurementData || []).map(d => d.productId).filter(Boolean))];
    const stockItems = stockItemIds.length
        ? await StockItem.find({ _id: { $in: stockItemIds } }).select('_id name reference measurements variants').lean()
        : [];
    const stockItemMap = new Map(stockItems.map(i => [i._id.toString(), i]));

    // Process product-based employees
    for (const data of (measurementData || [])) {
        if (!data.employeeId) continue;
        const employeeId = data.employeeId.toString();

        if (!employeeMeasurementsMap.has(employeeId)) {
            const employee = await EmployeeMpc.findById(employeeId).select('name uin gender').lean();
            if (!employee) { console.warn(`Employee ${employeeId} not found`); continue; }
            employeeMeasurementsMap.set(employeeId, {
                employeeId: data.employeeId,
                employeeName: employee.name,
                employeeUIN: employee.uin,
                gender: employee.gender,
                remarks: data.remarks || "",
                noProductAssigned: false,
                products: [],
                categoryMeasurements: []
            });
        }

        const stockItem = stockItemMap.get(data.productId?.toString());
        if (!stockItem) { console.warn(`Product ${data.productId} not found`); continue; }

        let variantName = "Default";
        if (data.variantId && stockItem.variants) {
            const v = stockItem.variants.find(v => v._id.toString() === data.variantId.toString());
            if (v?.attributes?.length) variantName = v.attributes.map(a => a.value).join(" • ");
        }

        const measurementsArray = Array.isArray(data.measurements)
            ? data.measurements
            : Object.entries(data.measurements || {}).map(([measurementName, value]) => ({ measurementName, value: value || '', unit: '' }));

        employeeMeasurementsMap.get(employeeId).products.push({
            productId: data.productId,
            productName: stockItem.name,
            variantId: data.variantId || null,
            variantName,
            quantity: data.quantity || 1,
            measurements: measurementsArray,
            measuredAt: new Date()
        });
    }

    // Process no-product / category employees
    for (const catEmp of (categoryData || [])) {
        if (!catEmp.employeeId) continue;
        const eid = catEmp.employeeId.toString();

        if (!employeeMeasurementsMap.has(eid)) {
            const employee = await EmployeeMpc.findById(eid).select('name uin gender').lean();
            if (!employee) { console.warn(`Employee ${eid} not found`); continue; }
            employeeMeasurementsMap.set(eid, {
                employeeId: catEmp.employeeId,
                employeeName: employee.name,
                employeeUIN: employee.uin,
                gender: employee.gender,
                remarks: catEmp.remarks || "",
                noProductAssigned: true,
                products: [],
                categoryMeasurements: catEmp.categoryMeasurements || []
            });
        } else {
            // Employee exists (maybe has products too), just add category data
            const emp = employeeMeasurementsMap.get(eid);
            emp.categoryMeasurements = catEmp.categoryMeasurements || [];
            emp.noProductAssigned = true;
            emp.remarks = catEmp.remarks || emp.remarks;
        }
    }

    return employeeMeasurementsMap;
}

// ─── Helper: compute isCompleted for an employee entry ───────────────────────
function computeIsCompleted(emp) {
    if (emp.noProductAssigned) {
        return emp.categoryMeasurements?.length > 0 &&
            emp.categoryMeasurements.every(cm =>
                cm.measurements?.every(m => m.value && m.value.trim() !== '')
            );
    }
    return emp.products.length > 0 &&
        emp.products.every(p =>
            p.measurements.length > 0 &&
            p.measurements.every(m => m.value && m.value.trim() !== '')
        );
}

// CREATE new measurement
router.post('/', async (req, res) => {
    try {
        const { organizationId, name, description, measurementData, registeredEmployeeIds, categoryData } = req.body;

        if (!organizationId) return res.status(400).json({ success: false, message: 'Organization ID is required' });
        if (!name?.trim()) return res.status(400).json({ success: false, message: 'Measurement name is required' });

        const customer = await Customer.findById(organizationId).select('_id name').lean();
        if (!customer) return res.status(404).json({ success: false, message: 'Organization not found' });

        const employeeMeasurementsMap = await buildEmployeeMeasurementsMap(measurementData, categoryData);

        const employeeMeasurements = Array.from(employeeMeasurementsMap.values()).map(emp => {
            const isCompleted = computeIsCompleted(emp);
            return { ...emp, isCompleted, completedAt: isCompleted ? new Date() : null };
        });

        const totalRegisteredEmployees = registeredEmployeeIds?.length || 0;
        const measuredEmployees = employeeMeasurements.filter(e => e.isCompleted).length;

        // Measurement field counts
        let totalMeasurements = 0, completedMeasurements = 0;
        employeeMeasurements.forEach(emp => {
            if (emp.noProductAssigned) {
                emp.categoryMeasurements?.forEach(cm => {
                    totalMeasurements += cm.measurements?.length || 0;
                    completedMeasurements += cm.measurements?.filter(m => m.value?.trim()).length || 0;
                });
            } else {
                emp.products.forEach(p => {
                    totalMeasurements += p.measurements.length;
                    completedMeasurements += p.measurements.filter(m => m.value?.trim()).length;
                });
            }
        });

        const newMeasurement = new Measurement({
            organizationId: customer._id,
            organizationName: customer.name,
            name: name.trim(),
            description: description?.trim() || '',
            registeredEmployeeIds: registeredEmployeeIds || [],
            employeeMeasurements,
            totalRegisteredEmployees,
            measuredEmployees,
            pendingEmployees: totalRegisteredEmployees - measuredEmployees,
            completionRate: totalRegisteredEmployees > 0 ? Math.round((measuredEmployees / totalRegisteredEmployees) * 100) : 0,
            totalMeasurements,
            completedMeasurements,
            pendingMeasurements: totalMeasurements - completedMeasurements,
            createdBy: req.user.id
        });

        await newMeasurement.save();
        res.status(201).json({ success: true, message: 'Measurement created successfully', measurement: newMeasurement });

    } catch (error) {
        console.error('Error creating measurement:', error);
        res.status(500).json({ success: false, message: 'Server error while creating measurement' });
    }
});

// UPDATE measurement (edit)
router.put('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { name, description, measurementData, registeredEmployeeIds, categoryData } = req.body;

        const measurement = await Measurement.findById(measurementId);
        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

        if (name !== undefined && name.trim()) measurement.name = name.trim();
        // if name not sent or blank, keep existing name
        if (description !== undefined) measurement.description = description?.trim() || '';

        // Merge registered employee IDs (don't drop existing ones)
        if (registeredEmployeeIds?.length) {
            const existingSet = new Set(measurement.registeredEmployeeIds.map(id => id.toString()));
            registeredEmployeeIds.forEach(id => existingSet.add(id.toString()));
            measurement.registeredEmployeeIds = Array.from(existingSet);
        }

        // Build a map of existing employee entries for quick lookup
        const existingMap = new Map(
            measurement.employeeMeasurements.map((emp, idx) => [emp.employeeId.toString(), { emp, idx }])
        );

        // ── Process product-based employees ───────────────────────────────────
        if (measurementData?.length) {
            // Batch-fetch stock items
            const productIds = [...new Set(measurementData.map(d => d.productId).filter(Boolean))];
            const stockItems = productIds.length
                ? await StockItem.find({ _id: { $in: productIds } }).select('_id name measurements variants').lean()
                : [];
            const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

            // Group incoming data by employee
            const incomingByEmployee = new Map();
            for (const data of measurementData) {
                if (!data.employeeId) continue;
                const eid = data.employeeId.toString();
                if (!incomingByEmployee.has(eid)) {
                    incomingByEmployee.set(eid, {
                        remarks: data.remarks || "",
                        employeeName: data.employeeName,
                        employeeUIN: data.employeeUIN,
                        gender: data.gender,
                        products: []
                    });
                }
                const si = stockMap.get(data.productId?.toString());
                if (!si) continue;

                let variantName = "Default";
                if (data.variantId && si.variants) {
                    const v = si.variants.find(v => v._id.toString() === data.variantId.toString());
                    if (v?.attributes?.length) variantName = v.attributes.map(a => a.value).join(" • ");
                }

                const measurementsArray = Array.isArray(data.measurements)
                    ? data.measurements
                    : Object.entries(data.measurements || {}).map(([n, v]) => ({ measurementName: n, value: v || '', unit: '' }));

                incomingByEmployee.get(eid).products.push({
                    productId: data.productId,
                    productName: si.name,
                    variantId: data.variantId || null,
                    variantName,
                    quantity: data.quantity || 1,
                    measurements: measurementsArray,
                    measuredAt: new Date()
                });
            }

            for (const [eid, inData] of incomingByEmployee) {
                const isCompleted = inData.products.every(p => p.measurements.every(m => m.value?.trim()));

                if (existingMap.has(eid)) {
                    // Update existing employee entry in-place
                    const { emp } = existingMap.get(eid);
                    emp.products = inData.products;
                    emp.remarks = inData.remarks || emp.remarks;
                    emp.noProductAssigned = false;
                    emp.isCompleted = isCompleted;
                    emp.completedAt = isCompleted ? new Date() : emp.completedAt;
                } else {
                    // New employee added during edit — fetch their details
                    let empName = inData.employeeName, empUIN = inData.employeeUIN, empGender = inData.gender;
                    if (!empName) {
                        const dbEmp = await EmployeeMpc.findById(eid).select('name uin gender').lean();
                        if (dbEmp) { empName = dbEmp.name; empUIN = dbEmp.uin; empGender = dbEmp.gender; }
                    }
                    measurement.employeeMeasurements.push({
                        employeeId: eid,
                        employeeName: empName || eid,
                        employeeUIN: empUIN || "",
                        gender: empGender || "",
                        remarks: inData.remarks || "",
                        noProductAssigned: false,
                        products: inData.products,
                        categoryMeasurements: [],
                        isCompleted,
                        completedAt: isCompleted ? new Date() : null
                    });
                    // Add to existingMap so categoryData loop can see it
                    existingMap.set(eid, { emp: measurement.employeeMeasurements[measurement.employeeMeasurements.length - 1] });
                }
            }
        }

        // ── Process no-product / category employees ───────────────────────────
        for (const catEmp of (categoryData || [])) {
            if (!catEmp.employeeId) continue;
            const eid = catEmp.employeeId.toString();
            const isCompleted = catEmp.categoryMeasurements?.every(cm =>
                cm.measurements?.every(m => m.value?.trim())
            ) || false;

            if (existingMap.has(eid)) {
                const { emp } = existingMap.get(eid);
                emp.categoryMeasurements = catEmp.categoryMeasurements || [];
                emp.remarks = catEmp.remarks || emp.remarks;
                emp.noProductAssigned = true;
                emp.isCompleted = isCompleted;
                emp.completedAt = isCompleted ? new Date() : emp.completedAt;
            } else {
                // New no-product employee added during edit
                const dbEmp = await EmployeeMpc.findById(eid).select('name uin gender').lean();
                if (!dbEmp) continue;
                measurement.employeeMeasurements.push({
                    employeeId: eid,
                    employeeName: dbEmp.name,
                    employeeUIN: dbEmp.uin,
                    gender: dbEmp.gender,
                    remarks: catEmp.remarks || "",
                    noProductAssigned: true,
                    products: [],
                    categoryMeasurements: catEmp.categoryMeasurements || [],
                    isCompleted,
                    completedAt: isCompleted ? new Date() : null
                });
            }
        }

        // Recalculate stats
        measurement.totalRegisteredEmployees = measurement.registeredEmployeeIds?.length || 0;
        measurement.measuredEmployees = measurement.employeeMeasurements.filter(e => e.isCompleted).length;
        measurement.pendingEmployees = measurement.totalRegisteredEmployees - measurement.measuredEmployees;
        measurement.completionRate = measurement.totalRegisteredEmployees > 0
            ? Math.round((measurement.measuredEmployees / measurement.totalRegisteredEmployees) * 100)
            : 0;

        let totalMeasurements = 0, completedMeasurements = 0;
        measurement.employeeMeasurements.forEach(emp => {
            if (emp.noProductAssigned) {
                emp.categoryMeasurements?.forEach(cm => {
                    totalMeasurements += cm.measurements?.length || 0;
                    completedMeasurements += cm.measurements?.filter(m => m.value?.trim()).length || 0;
                });
            } else {
                emp.products.forEach(p => {
                    totalMeasurements += p.measurements.length;
                    completedMeasurements += p.measurements.filter(m => m.value?.trim()).length;
                });
            }
        });
        measurement.totalMeasurements = totalMeasurements;
        measurement.completedMeasurements = completedMeasurements;
        measurement.pendingMeasurements = totalMeasurements - completedMeasurements;
        measurement.updatedBy = req.user.id;
        measurement.updatedAt = new Date();

        const saved = await measurement.save();
        res.status(200).json({ success: true, message: 'Measurement updated successfully', measurement: saved });

    } catch (error) {
        console.error('Error updating measurement:', error);
        res.status(500).json({ success: false, message: 'Server error while updating measurement', error: error.message });
    }
});

// ADD NEW EMPLOYEES to existing measurement
router.put('/:measurementId/add-employees', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { measurementData, categoryData, newEmployeeIds, updatedRegisteredEmployeeIds } = req.body;

        const measurement = await Measurement.findById(measurementId);
        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

        if (updatedRegisteredEmployeeIds?.length) {
            measurement.registeredEmployeeIds = [...new Set(updatedRegisteredEmployeeIds)];
        }

        const existingIds = new Set(measurement.employeeMeasurements.map(e => e.employeeId.toString()));

        // Process new product-based employees
        if (measurementData?.length) {
            const productIds = [...new Set(measurementData.map(d => d.productId).filter(Boolean))];
            const stockItems = productIds.length
                ? await StockItem.find({ _id: { $in: productIds } }).select('_id name reference').lean()
                : [];
            const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

            const newEmpMap = new Map();
            for (const data of measurementData) {
                if (!data.employeeId) continue;
                const eid = data.employeeId.toString();
                if (existingIds.has(eid)) continue;

                if (!newEmpMap.has(eid)) {
                    const employee = await EmployeeMpc.findById(eid).select('name uin gender').lean();
                    if (!employee) continue;
                    newEmpMap.set(eid, {
                        employeeId: data.employeeId, employeeName: employee.name,
                        employeeUIN: employee.uin, gender: employee.gender,
                        remarks: data.remarks || "", noProductAssigned: false,
                        products: [], categoryMeasurements: []
                    });
                }

                const si = stockMap.get(data.productId?.toString());
                if (!si) continue;

                let variantName = "Default";
                if (data.variantId) {
                    const full = await StockItem.findById(data.productId).select('variants').lean();
                    const v = full?.variants?.find(v => v._id.toString() === data.variantId.toString());
                    if (v?.attributes?.length) variantName = v.attributes.map(a => a.value).join(" • ");
                }

                const measurementsArray = Array.isArray(data.measurements)
                    ? data.measurements
                    : Object.entries(data.measurements || {}).map(([n, v]) => ({ measurementName: n, value: v || '', unit: '' }));

                newEmpMap.get(eid).products.push({
                    productId: data.productId, productName: si.name,
                    variantId: data.variantId || null, variantName,
                    quantity: data.quantity || 1, measurements: measurementsArray, measuredAt: new Date()
                });
            }

            for (const empData of newEmpMap.values()) {
                const isCompleted = empData.products.every(p => p.measurements.every(m => m.value?.trim()));
                measurement.employeeMeasurements.push({ ...empData, isCompleted, completedAt: isCompleted ? new Date() : null });
            }
        }

        // Process new no-product / category employees
        for (const catEmp of (categoryData || [])) {
            if (!catEmp.employeeId) continue;
            const eid = catEmp.employeeId.toString();
            if (existingIds.has(eid)) continue;

            const employee = await EmployeeMpc.findById(eid).select('name uin gender').lean();
            if (!employee) continue;

            const isCompleted = catEmp.categoryMeasurements?.every(cm =>
                cm.measurements?.every(m => m.value?.trim())
            ) || false;

            measurement.employeeMeasurements.push({
                employeeId: eid, employeeName: employee.name,
                employeeUIN: employee.uin, gender: employee.gender,
                remarks: catEmp.remarks || "", noProductAssigned: true,
                products: [], categoryMeasurements: catEmp.categoryMeasurements || [],
                isCompleted, completedAt: isCompleted ? new Date() : null
            });
        }

        measurement.updatedBy = req.user.id;
        measurement.updatedAt = new Date();
        const saved = await measurement.save();

        res.status(200).json({
            success: true,
            message: `Added ${newEmployeeIds?.length || 0} new employee(s) to measurement`,
            measurement: saved
        });
    } catch (error) {
        console.error('Error adding employees:', error);
        res.status(500).json({ success: false, message: 'Server error while adding employees', error: error.message });
    }
});

// GET single measurement
router.get('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({ success: false, message: 'Valid measurement ID is required' });
        }

        const measurement = await Measurement.findById(measurementId)
            .populate({ path: 'employeeMeasurements.products.productId', select: 'name reference measurements' })
            .populate('convertedBy', 'name email')
            .lean();

        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

        // Ensure productName is set from populated data
        measurement.employeeMeasurements.forEach(emp => {
            emp.products.forEach(product => {
                if (product.productId?.name) product.productName = product.productId.name;
            });
        });

        const totalEmployees = await EmployeeMpc.countDocuments({
            customerId: measurement.organizationId, status: 'active'
        });

        res.status(200).json({
            success: true,
            measurement: {
                ...measurement,
                totalEmployees
            }
        });
    } catch (error) {
        console.error('Error fetching measurement:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching measurement' });
    }
});

// GET organization measurements list
router.get('/organization/:orgId/measurements', async (req, res) => {
    try {
        const { orgId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({ success: false, message: 'Valid organization ID is required' });
        }

        const measurements = await Measurement.find({ organizationId: new mongoose.Types.ObjectId(orgId) })
            .select('name description totalRegisteredEmployees measuredEmployees pendingEmployees completionRate createdAt updatedAt convertedToPO poRequestId employeeMeasurements registeredEmployeeIds poConversionDate')
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
        res.status(500).json({ success: false, message: 'Server error while fetching measurements' });
    }
});

// DELETE measurement
router.delete('/:measurementId', async (req, res) => {
    try {
        const measurement = await Measurement.findByIdAndDelete(req.params.measurementId);
        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });
        res.status(200).json({ success: true, message: 'Measurement deleted successfully' });
    } catch (error) {
        console.error('Error deleting measurement:', error);
        res.status(500).json({ success: false, message: 'Server error while deleting measurement' });
    }
});

// ASSIGN PRODUCT to a no-product employee within a measurement

router.post('/:measurementId/assign-product', async (req, res) => {
    try {
        const { measurementId } = req.params;
        // categoryName is informational — tells us which category this product is for
        const { employeeId, organizationId, product, measurements, categoryName } = req.body;
 
        if (!mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({ success: false, message: 'Valid measurement ID is required' });
        }
        if (!employeeId || !product?.productId) {
            return res.status(400).json({ success: false, message: 'employeeId and product.productId are required' });
        }
 
        // ── 1. Fetch stock item ───────────────────────────────────────────────
        const stockItem = await StockItem.findById(product.productId)
            .select('_id name reference measurements variants')
            .lean();
        if (!stockItem) {
            return res.status(404).json({ success: false, message: 'Product not found' });
        }
 
        let resolvedVariantName = product.variantName || 'Default';
        if (product.variantId && stockItem.variants?.length) {
            const v = stockItem.variants.find(v => v._id.toString() === product.variantId.toString());
            if (v?.attributes?.length) {
                resolvedVariantName = v.attributes.map(a => a.value).join(' • ');
            }
        }
 
        // ── 2. Update EmployeeMpc — push product (avoid exact duplicates) ────
        const employeeDoc = await EmployeeMpc.findById(employeeId);
        if (!employeeDoc) {
            return res.status(404).json({ success: false, message: 'Employee not found' });
        }
 
        const alreadyAssigned = employeeDoc.products?.some(p => {
            if (p.productId.toString() !== product.productId.toString()) return false;
            if (product.variantId) return p.variantId?.toString() === product.variantId.toString();
            return !p.variantId;
        });
 
        if (!alreadyAssigned) {
            employeeDoc.products.push({
                productId:   product.productId,
                variantId:   product.variantId || undefined,
                quantity:    product.quantity || 1,
                productName: product.productName || stockItem.name,
            });
            await employeeDoc.save();
        }
 
        // ── 3. Build the product measurement entry ────────────────────────────
        const measurementsArray = (measurements || []).map(m => ({
            measurementName: m.measurementName,
            value:           m.value || '',
            unit:            m.unit  || '',
        }));
 
        const finalMeasurements = measurementsArray.length
            ? measurementsArray
            : (stockItem.measurements || []).map(field => ({
                measurementName: field, value: '', unit: '',
            }));
 
        const newProductEntry = {
            productId:    product.productId,
            productName:  product.productName || stockItem.name,
            variantId:    product.variantId   || null,
            variantName:  resolvedVariantName,
            quantity:     product.quantity    || 1,
            measurements: finalMeasurements,
            measuredAt:   new Date(),
        };
 
        // ── 4. Update employee entry in Measurement document ──────────────────
        const measurement = await Measurement.findById(measurementId);
        if (!measurement) {
            return res.status(404).json({ success: false, message: 'Measurement not found' });
        }
 
        const empEntry = measurement.employeeMeasurements.find(
            e => e.employeeId.toString() === employeeId.toString()
        );
        if (!empEntry) {
            return res.status(404).json({ success: false, message: 'Employee not found in this measurement' });
        }
 
        // Append this product — do NOT clear existing products or categoryMeasurements
        empEntry.products.push(newProductEntry);
 
        // ── 5. Flip noProductAssigned only when ALL categories have a product ──
        // Count how many distinct categories exist on this employee entry.
        const totalCategories = empEntry.categoryMeasurements?.length || 0;
 
        if (totalCategories === 0) {
            // Employee had no categories — flip immediately (legacy path)
            empEntry.noProductAssigned = false;
            empEntry.categoryMeasurements = [];
        } else if (empEntry.products.length >= totalCategories) {
            // Every category now has a product assigned → fully convert to product-based
            empEntry.noProductAssigned = false;
            // Intentionally keep categoryMeasurements for audit trail
        }
        // If products.length < totalCategories: still more categories to assign,
        // leave noProductAssigned = true so the table still shows "Assign product"
 
        const allFilled = empEntry.products.every(p =>
            p.measurements.every(m => m.value?.trim())
        );
        empEntry.isCompleted = allFilled;
        empEntry.completedAt = allFilled ? new Date() : empEntry.completedAt;
 
        measurement.updatedBy = req.user.id;
        await measurement.save();
 
        res.status(200).json({
            success:                 true,
            message:                 `Product "${stockItem.name}" assigned to ${empEntry.employeeName}`,
            employeeName:            empEntry.employeeName,
            productName:             stockItem.name,
            categoryName:            categoryName || null,
            totalCategoriesAssigned: empEntry.products.length,
            totalCategoriesNeeded:   totalCategories,
            allCategoriesAssigned:   empEntry.products.length >= totalCategories,
        });
 
    } catch (error) {
        console.error('Error assigning product:', error);
        res.status(500).json({ success: false, message: 'Server error while assigning product' });
    }
});

// CONVERT measurement to PO
router.post('/:measurementId/convert-to-po', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { poName, poDescription, selectedEmployeeIds } = req.body;

        if (!mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({ success: false, message: 'Valid measurement ID is required' });
        }
        if (!selectedEmployeeIds?.length) {
            return res.status(400).json({ success: false, message: 'Select at least one employee for the PO' });
        }

        const measurement = await Measurement.findById(measurementId)
            .populate({ path: 'employeeMeasurements.products.productId', select: '_id name reference baseSalesPrice variants' })
            .lean();

        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });
        if (measurement.convertedToPO) return res.status(400).json({ success: false, message: 'Already converted to PO' });

        const selectedSet = new Set(selectedEmployeeIds.map(id => id.toString()));
        const selectedEmployeeMeasurements = measurement.employeeMeasurements.filter(e => selectedSet.has(e.employeeId?.toString()));
        const remainingEmployeeMeasurements = measurement.employeeMeasurements.filter(e => !selectedSet.has(e.employeeId?.toString()));

        if (!selectedEmployeeMeasurements.length) {
            return res.status(400).json({ success: false, message: 'None of the selected employees found in this measurement.' });
        }

        // Only product-based employees can be converted to PO
        const convertibleEmployees = selectedEmployeeMeasurements.filter(e => !e.noProductAssigned && e.products?.length);
        if (!convertibleEmployees.length) {
            return res.status(400).json({ success: false, message: 'Selected employees have no product assignments. Cannot convert category-only measurements to PO.' });
        }

        // Validate completeness
        let totalFields = 0, completedFields = 0;
        convertibleEmployees.forEach(emp => {
            emp.products.forEach(p => {
                totalFields += p.measurements.length;
                completedFields += p.measurements.filter(m => m.value?.trim()).length;
            });
        });
        if (totalFields > 0 && Math.round((completedFields / totalFields) * 100) < 100) {
            return res.status(400).json({ success: false, message: 'Cannot convert: some selected employees have incomplete measurements.' });
        }

        const customer = await Customer.findById(measurement.organizationId);
        if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

        // Get EmployeeMpc product assignments
        const measuredEmployees = await EmployeeMpc.find({
            _id: { $in: convertibleEmployees.map(e => e.employeeId) }, status: 'active'
        }).select('_id name products').populate({ path: 'products.productId', select: 'name reference baseSalesPrice variants' }).lean();

        const employeeProductMap = new Map(measuredEmployees.map(e => [e._id.toString(), e]));

        // Build product map
        const productMap = new Map();
        convertibleEmployees.forEach(emp => {
            const employeeData = employeeProductMap.get(emp.employeeId.toString());
            if (!employeeData) return;

            emp.products.forEach(measuredProduct => {
                const pa = employeeData.products.find(p => {
                    if (p.productId?._id?.toString() !== measuredProduct.productId?._id?.toString()) return false;
                    if (p.variantId && measuredProduct.variantId) return p.variantId.toString() === measuredProduct.variantId.toString();
                    return !p.variantId && !measuredProduct.variantId;
                });
                if (!pa) return;

                const si = pa.productId;
                if (!si?._id) return;

                const key = `${si._id}_${pa.variantId || 'default'}`;
                if (!productMap.has(key)) {
                    let variantName = 'Default', variantAttrs = [], variantPrice = si.baseSalesPrice || 0;
                    if (pa.variantId && si.variants) {
                        const v = si.variants.find(v => v._id.toString() === pa.variantId.toString());
                        if (v) {
                            variantName = v.attributes?.length ? v.attributes.map(a => a.value).join(' • ') : v.name || 'Default';
                            variantAttrs = v.attributes?.map(a => ({ name: a.name || 'Attribute', value: a.value })) || [];
                            if (v.salesPrice) variantPrice = v.salesPrice;
                        }
                    }
                    productMap.set(key, { stockItemId: si._id, stockItemName: si.name, stockItemReference: si.reference || '', variantId: pa.variantId || null, variantName, variantAttributes: variantAttrs, unitPrice: variantPrice, employeeCount: 0, totalQuantity: 0, employeeNames: [] });
                }

                const pd = productMap.get(key);
                pd.employeeCount++;
                pd.totalQuantity += pa.quantity || 1;
                pd.employeeNames.push(employeeData.name);
            });
        });

        const products = Array.from(productMap.values());
        if (!products.length) return res.status(400).json({ success: false, message: 'No valid products found for PO' });

        const requestCount = await CustomerRequest.countDocuments();
        const requestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, '0')}`;

        const validatedItems = products.map(p => ({
            stockItemId: p.stockItemId, stockItemName: p.stockItemName, stockItemReference: p.stockItemReference,
            variants: [{ variantId: p.variantId?.toString() || `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`, attributes: p.variantAttributes.length ? p.variantAttributes : (p.variantName !== 'Default' ? [{ name: 'Variant', value: p.variantName }] : []), quantity: p.totalQuantity, specialInstructions: [], estimatedPrice: p.totalQuantity * p.unitPrice }],
            totalQuantity: p.totalQuantity, totalEstimatedPrice: p.totalQuantity * p.unitPrice,
            employeeCount: p.employeeCount, employeeNames: p.employeeNames.join(', ')
        }));

        const newRequest = new CustomerRequest({
            requestId, customerId: measurement.organizationId,
            customerInfo: { name: customer.name, email: customer.email || '', phone: customer.phone || '', address: customer.profile?.address?.street || '', city: customer.profile?.address?.city || '', postalCode: customer.profile?.address?.pincode || '', description: poDescription || `PO from measurement: ${measurement.name}`, deliveryDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), preferredContactMethod: 'phone' },
            items: validatedItems, status: 'pending', priority: 'high',
            measurementId: measurement._id, measurementName: measurement.name, requestType: 'measurement_conversion'
        });
        await newRequest.save();

        const cleanList = (list) => list.map(emp => ({
            employeeId: emp.employeeId, employeeName: emp.employeeName, employeeUIN: emp.employeeUIN,
            gender: emp.gender, remarks: emp.remarks || '', noProductAssigned: emp.noProductAssigned || false,
            isCompleted: emp.isCompleted || false, completedAt: emp.completedAt || null,
            products: (emp.products || []).map(p => ({
                productId: p.productId?._id || p.productId, productName: p.productName,
                variantId: p.variantId || null, variantName: p.variantName || 'Default',
                quantity: p.quantity || 1, measuredAt: p.measuredAt || new Date(),
                measurements: p.measurements.map(m => ({ measurementName: m.measurementName, value: m.value || '', unit: m.unit || '' }))
            })),
            categoryMeasurements: emp.categoryMeasurements || []
        }));

        // Create new measurement for remaining employees if any
        let newMeasurementId = null;
        if (remainingEmployeeMeasurements.length > 0) {
            const remName = `${measurement.name} - Part ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}`;
            const remCompleted = remainingEmployeeMeasurements.filter(e => e.isCompleted).length;
            const newMeasurementDoc = new Measurement({
                organizationId: measurement.organizationId, organizationName: measurement.organizationName,
                name: remName, description: `Continuation of "${measurement.name}". ${remainingEmployeeMeasurements.length} employee(s) not included in PO ${requestId}.`,
                registeredEmployeeIds: remainingEmployeeMeasurements.map(e => e.employeeId),
                employeeMeasurements: cleanList(remainingEmployeeMeasurements),
                totalRegisteredEmployees: remainingEmployeeMeasurements.length,
                measuredEmployees: remCompleted, pendingEmployees: remainingEmployeeMeasurements.length - remCompleted,
                completionRate: Math.round((remCompleted / remainingEmployeeMeasurements.length) * 100),
                convertedToPO: false, createdBy: req.user?.id || measurement.createdBy
            });
            await newMeasurementDoc.save();
            newMeasurementId = newMeasurementDoc._id;
        }

        // Update original measurement
        const selCompleted = selectedEmployeeMeasurements.filter(e => e.isCompleted).length;
        await Measurement.findByIdAndUpdate(measurementId, {
            employeeMeasurements: cleanList(selectedEmployeeMeasurements),
            registeredEmployeeIds: selectedEmployeeMeasurements.map(e => e.employeeId),
            totalRegisteredEmployees: selectedEmployeeMeasurements.length,
            measuredEmployees: selCompleted, pendingEmployees: selectedEmployeeMeasurements.length - selCompleted,
            completionRate: selectedEmployeeMeasurements.length > 0 ? Math.round((selCompleted / selectedEmployeeMeasurements.length) * 100) : 100,
            convertedToPO: true, poRequestId: newRequest._id, poConversionDate: new Date(), convertedBy: req.user?.id || null
        });

        res.status(201).json({
            success: true,
            message: `PO created for ${convertibleEmployees.length} employee(s).${remainingEmployeeMeasurements.length > 0 ? ` ${remainingEmployeeMeasurements.length} employee(s) moved to new measurement.` : ''}`,
            poRequestId: newRequest._id, requestId: newRequest.requestId,
            totalEstimatedPrice: validatedItems.reduce((s, i) => s + i.totalEstimatedPrice, 0),
            totalItems: validatedItems.length, selectedEmployeeCount: convertibleEmployees.length,
            remainingEmployeeCount: remainingEmployeeMeasurements.length, newMeasurementId
        });

    } catch (error) {
        console.error('Error converting to PO:', error);
        if (error.name === 'ValidationError') {
            return res.status(400).json({ success: false, message: Object.values(error.errors).map(e => e.message).join(', ') });
        }
        res.status(500).json({ success: false, message: 'Server error while converting to PO' });
    }
});

// EXPORT product pricing CSV
router.get('/organization/:orgId/export-product-pricing', async (req, res) => {
    try {
        const { orgId } = req.params;
        const customer = await Customer.findById(orgId).select('name').lean();
        if (!customer) return res.status(404).json({ success: false, message: 'Organization not found' });

        const measurements = await Measurement.find({ organizationId: new mongoose.Types.ObjectId(orgId) }).select('employeeMeasurements').lean();
        if (!measurements?.length) return res.status(404).json({ success: false, message: 'No measurements found' });

        const measuredEmployeeIds = new Set();
        measurements.forEach(m => m.employeeMeasurements?.forEach(e => { if (e.employeeId) measuredEmployeeIds.add(e.employeeId.toString()); }));
        if (!measuredEmployeeIds.size) return res.status(404).json({ success: false, message: 'No employees have been measured yet' });

        const measuredEmployees = await EmployeeMpc.find({
            customerId: orgId, status: 'active', _id: { $in: Array.from(measuredEmployeeIds) }
        }).select('_id name uin gender products').populate({ path: 'products.productId', select: 'name reference baseSalesPrice variants' }).lean();

        const productMap = new Map();
        measuredEmployees.forEach(emp => {
            (emp.products || []).forEach(pa => {
                if (!pa.productId) return;
                const si = pa.productId;
                const key = `${si._id}_${pa.variantId || 'default'}`;
                if (!productMap.has(key)) {
                    let variantName = "Default", variantPrice = null;
                    if (pa.variantId && si.variants) {
                        const v = si.variants.find(v => v._id.toString() === pa.variantId.toString());
                        if (v) { variantName = v.attributes?.map(a => a.value).join(" • ") || "Default"; variantPrice = v.salesPrice; }
                    }
                    productMap.set(key, { productName: si.name, reference: si.reference || '', variantName, basePrice: si.baseSalesPrice || 0, variantPrice, employeeNames: new Set(), totalQuantity: 0, employeeCount: 0 });
                }
                const pd = productMap.get(key);
                pd.employeeNames.add(emp.name);
                pd.totalQuantity += pa.quantity || 1;
                pd.employeeCount = pd.employeeNames.size;
            });
        });

        const products = Array.from(productMap.values());
        if (!products.length) return res.status(404).json({ success: false, message: 'No product assignments found' });

        const headers = ['Product Name', 'Variant', 'Reference', 'Unit Price', 'Total Quantity', 'Employee Count', 'Employee Names', 'Total Price'];
        const allEmpNames = new Set();
        let grandTotal = 0, grandQty = 0;

        const rows = products.map(p => {
            const unitPrice = p.variantPrice || p.basePrice || 0;
            const totalPrice = p.totalQuantity * unitPrice;
            grandTotal += totalPrice; grandQty += p.totalQuantity;
            p.employeeNames.forEach(n => allEmpNames.add(n));
            return [`"${p.productName}"`, `"${p.variantName}"`, p.reference, unitPrice.toFixed(2), p.totalQuantity, p.employeeCount, `"${Array.from(p.employeeNames).join(', ')}"`, totalPrice.toFixed(2)];
        });

        const metadata = [`Organization: ${customer.name}`, `Export Date: ${new Date().toLocaleDateString()}`, `Total Measured Employees: ${allEmpNames.size}`, `Grand Total: ${grandTotal.toFixed(2)}`, ''];
        const csvContent = ['\uFEFF', ...metadata, headers.join(','), ...rows.map(r => r.join(',')), `,,,,${grandQty},,,"Grand Total: ${grandTotal.toFixed(2)}"`].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="Product_Pricing_${customer.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv"`);
        res.send(csvContent);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ success: false, message: 'Export failed' });
    }
});

// EXPORT measurement CSV
router.get('/:measurementId/export', async (req, res) => {
    try {
        const measurement = await Measurement.findById(req.params.measurementId)
            .populate({ path: 'employeeMeasurements.products.productId', select: 'name reference' })
            .lean();
        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

        const allMeasurements = new Set();
        measurement.employeeMeasurements.forEach(e => e.products?.forEach(p => p.measurements?.forEach(m => allMeasurements.add(m.measurementName))));
        const measurementNames = Array.from(allMeasurements);

        const headers = ['Employee Name', 'UIN', 'Gender', 'Remarks', 'Product', 'Variant', 'Quantity', ...measurementNames];
        const rows = measurement.employeeMeasurements.flatMap(emp =>
            emp.noProductAssigned
                ? (emp.categoryMeasurements || []).map(cm => {
                    const base = [`"${emp.employeeName}"`, emp.employeeUIN, emp.gender, `"${emp.remarks || ''}"`, `"[Category] ${cm.categoryName}"`, '', ''];
                    return [...base, ...measurementNames.map(() => '')];
                })
                : (emp.products || []).map(p => {
                    const base = [`"${emp.employeeName}"`, emp.employeeUIN, emp.gender, `"${emp.remarks || ''}"`, `"${p.productName}"`, p.variantName || 'Default', p.quantity || 1];
                    return [...base, ...measurementNames.map(n => { const m = p.measurements?.find(m => m.measurementName === n); return m?.value || ''; })];
                })
        );

        const csv = ['\uFEFF', headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${measurement.name}_${req.params.measurementId}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({ success: false, message: 'Server error while exporting' });
    }
});

// EXPORT grouped CSV
router.get('/:measurementId/export-grouped', async (req, res) => {
    try {
        const measurement = await Measurement.findById(req.params.measurementId)
            .populate({ path: 'employeeMeasurements.products.productId', select: 'name reference' })
            .lean();
        if (!measurement) return res.status(404).json({ success: false, message: 'Measurement not found' });

        const productMap = new Map();
        measurement.employeeMeasurements.forEach(emp => {
            (emp.products || []).forEach(p => {
                const key = p.productId?._id?.toString() || p.productName;
                if (!productMap.has(key)) {
                    productMap.set(key, { productName: p.productName, variantName: p.variantName, reference: p.productId?.reference || '', employees: [], measurementNames: p.measurements?.map(m => m.measurementName) || [] });
                }
                const pd = productMap.get(key);
                const mValues = {};
                p.measurements?.forEach(m => { mValues[m.measurementName] = m.value || ''; });
                pd.employees.push({ name: emp.employeeName, uin: emp.employeeUIN, gender: emp.gender, remarks: emp.remarks || '', quantity: p.quantity || 1, measurements: mValues });
            });
        });

        let csv = '\uFEFF';
        productMap.forEach((pd) => {
            csv += `Product: "${pd.productName}"${pd.variantName !== "Default" ? ` (Variant: ${pd.variantName})` : ''}\n\n`;
            const headers = ['Employee Name', 'UIN', 'Gender', 'Quantity', 'Remarks', ...pd.measurementNames];
            csv += headers.join(',') + '\n';
            pd.employees.forEach(e => {
                csv += [`"${e.name}"`, e.uin, e.gender, e.quantity, `"${e.remarks}"`, ...pd.measurementNames.map(n => e.measurements[n] || '')].join(',') + '\n';
            });
            csv += '\n\n';
        });

        // Append category measurements
        const catEmployees = measurement.employeeMeasurements.filter(e => e.noProductAssigned);
        if (catEmployees.length) {
            csv += 'Category Measurements (No Product Assigned)\n\n';
            catEmployees.forEach(emp => {
                csv += `Employee: ${emp.employeeName} (${emp.employeeUIN})\n`;
                (emp.categoryMeasurements || []).forEach(cm => {
                    csv += `Category: ${cm.categoryName}\n`;
                    csv += `Field,Value\n`;
                    cm.measurements?.forEach(m => { csv += `${m.fieldName},${m.value || ''}\n`; });
                    csv += '\n';
                });
                csv += '\n';
            });
        }

        csv += `=== SUMMARY ===\nTotal Employees: ${measurement.employeeMeasurements.length}\nTotal Products: ${productMap.size}\nGenerated: ${new Date().toLocaleString()}\n`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${measurement.name.replace(/\s+/g, '_')}_grouped.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Export grouped error:', error);
        res.status(500).json({ success: false, message: 'Server error while exporting grouped measurement' });
    }
});

// GET all employees (lightweight)
router.get('/', async (req, res) => {
    try {
        const employees = await EmployeeMpc.find({})
            .select('_id name uin gender status products customerId createdAt')
            .populate({ path: 'products.productId', select: '_id name reference' })
            .sort({ createdAt: -1 })
            .lean();

        const processed = employees.map(emp => ({
            ...emp,
            products: (emp.products || []).map(p => ({
                ...p,
                productName: p.productId?.name || "Unknown",
                variantName: p.variantName || "Default",
                quantity: p.quantity || 1
            }))
        }));

        res.status(200).json({ success: true, employees: processed });
    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({ success: false, message: 'Server error while fetching employees' });
    }
});

module.exports = router;