const express = require('express');
const router = express.Router();
const Measurement = require('../../../models/Customer_Models/Measurement');
const Customer = require('../../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');
const OrganizationDepartment = require('../../../models/CMS_Models/Configuration/OrganizationDepartment');
const StockItem = require('../../../models/CMS_Models/Inventory/Products/StockItem');
const EmployeeAuthMiddleware = require('../../../Middlewear/EmployeeAuthMiddlewear');
// Add this import at the top of your measurementRoutes.js file
const CustomerRequest = require('../../../models/Customer_Models/CustomerRequest');

const mongoose = require('mongoose');

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

router.get('/organization/:orgId/export-product-pricing', async (req, res) => {
    try {
        const { orgId } = req.params;

        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

        const customer = await Customer.findById(orgId)
            .select('_id name email phone')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        const measurements = await Measurement.find({
            organizationId: orgId
        })
            .select('name employeeMeasurements')
            .populate({
                path: 'employeeMeasurements.stockItems.stockItemId',
                select: 'name reference baseSalesPrice'
            })
            .lean();

        if (!measurements || measurements.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No measurements found for this organization'
            });
        }

        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active'
        }).lean();

        if (!orgDept) {
            return res.status(404).json({
                success: false,
                message: 'Organization departments not found'
            });
        }

        const getAssignedQuantity = (departmentName, designationName, stockItemId, variantId) => {
            const department = orgDept.departments.find(
                d => d.status === 'active' && d.name === departmentName
            );
            if (!department) return 1;

            const designation = department.designations.find(
                des => des.status === 'active' && des.name === designationName
            );
            if (!designation || !designation.assignedStockItems) return 1;

            const assignedItem = designation.assignedStockItems.find(item => {
                const stockMatch = item.stockItemId.toString() === stockItemId.toString();
                if (variantId) {
                    return stockMatch && (
                        (item.variantId && item.variantId.toString() === variantId.toString()) ||
                        !item.variantId
                    );
                }
                return stockMatch && !item.variantId;
            });

            return assignedItem ? assignedItem.quantity : 1;
        };

        /** ---------------- FIX STARTS HERE ---------------- **/

        const productDataMap = new Map();

        measurements.forEach(measurement => {
            measurement.employeeMeasurements.forEach(emp => {
                emp.stockItems.forEach(stockItem => {
                    if (!stockItem.stockItemId) return;

                    const stockItemId = stockItem.stockItemId._id.toString();
                    const variantId = stockItem.variantId ? stockItem.variantId.toString() : null;
                    const key = `${stockItemId}_${variantId || 'no-variant'}`;

                    if (!productDataMap.has(key)) {
                        productDataMap.set(key, {
                            stockItemId,
                            stockItemName: stockItem.stockItemId.name || '',
                            stockItemReference: stockItem.stockItemId.reference || '',
                            variantId,
                            variantName: stockItem.variantName || 'Default',
                            basePrice: stockItem.stockItemId.baseSalesPrice || 0,

                            // 👇 IMPORTANT: dedupe employees using Map
                            employees: new Map(), // key = employeeUIN

                            departmentDesignationMap: new Map()
                        });
                    }

                    const data = productDataMap.get(key);

                    // Deduplicate employees
                    if (emp.employeeUIN && !data.employees.has(emp.employeeUIN)) {
                        data.employees.set(emp.employeeUIN, {
                            name: emp.employeeName,
                            department: emp.department,
                            designation: emp.designation,
                            uin: emp.employeeUIN
                        });
                    }

                    const deptDesigKey = `${emp.department}_${emp.designation}`;
                    if (!data.departmentDesignationMap.has(deptDesigKey)) {
                        data.departmentDesignationMap.set(deptDesigKey, {
                            department: emp.department,
                            designation: emp.designation,
                            employeeCount: 0
                        });
                    }

                    data.departmentDesignationMap.get(deptDesigKey).employeeCount += 1;
                });
            });
        });

        const productData = Array.from(productDataMap.values()).map(data => {
            let totalQuantity = 0;
            const departmentBreakdown = [];

            data.departmentDesignationMap.forEach(deptData => {
                const assignedQuantity = getAssignedQuantity(
                    deptData.department,
                    deptData.designation,
                    data.stockItemId,
                    data.variantId
                );

                const deptTotal = deptData.employeeCount * assignedQuantity;
                totalQuantity += deptTotal;

                departmentBreakdown.push({
                    department: deptData.department,
                    designation: deptData.designation,
                    employeeCount: deptData.employeeCount,
                    quantityPerEmployee: assignedQuantity,
                    totalQuantity: deptTotal
                });
            });

            const uniqueEmployees = Array.from(data.employees.values());

            return {
                ...data,
                employeeDetails: uniqueEmployees.map(e => e.name).join(', '),
                totalEmployees: uniqueEmployees.length,
                totalQuantity,
                totalEstimatedPrice: totalQuantity * data.basePrice,
                departmentBreakdown
            };
        });

        /** ---------------- FIX ENDS HERE ---------------- **/

        const headers = [
            'Stock Item Name',
            'Variant Name',
            'Stock Item Reference',
            'Employees with Measurements',
            'Total Employees',
            'Total Quantity',
            'Base Price',
            'Total Estimated Price'
        ];

        const rows = productData.map(item => [
            `"${item.stockItemName}"`,
            `"${item.variantName}"`,
            item.stockItemReference,
            `"${item.employeeDetails}"`,
            item.totalEmployees,
            item.totalQuantity,
            item.basePrice.toFixed(2),
            item.totalEstimatedPrice.toFixed(2)
        ]);

        const csvContent = [
            headers.join(','),
            ...rows.map(r => r.join(','))
        ].join('\n');

        const filename = `Product_Pricing_${customer.name.replace(/\s+/g, '_')}.csv`;
        const bom = '\uFEFF';

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(bom + csvContent);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting product pricing data'
        });
    }
});


// Simplified version focusing on quantity calculation
router.get('/organization/:orgId/export-product-pricing', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Validate organization ID
        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

        // Get organization details
        const customer = await Customer.findById(orgId).select('name').lean();
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        console.log(`Exporting for organization: ${customer.name}`);

        // Step 1: Get all measurements for this organization
        const measurements = await Measurement.find({
            organizationId: orgId
        })
            .select('employeeMeasurements')
            .populate({
                path: 'employeeMeasurements.stockItems.stockItemId',
                select: 'name reference baseSalesPrice'
            })
            .lean();

        if (!measurements || measurements.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No measurements found for this organization'
            });
        }

        console.log(`Found ${measurements.length} measurements`);

        // Step 2: Get organization department assignments
        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active'
        }).lean();

        if (!orgDept) {
            return res.status(404).json({
                success: false,
                message: 'Organization departments not found'
            });
        }

        console.log(`Found organization department document`);

        // Step 3: Create a map to track employee counts by department-designation
        const employeeCountMap = new Map();
        
        // Extract all unique employee department-designation combinations from measurements
        measurements.forEach(measurement => {
            measurement.employeeMeasurements.forEach(emp => {
                const key = `${emp.employeeId}_${emp.department}_${emp.designation}`;
                employeeCountMap.set(key, {
                    employeeId: emp.employeeId,
                    employeeName: emp.employeeName,
                    department: emp.department,
                    designation: emp.designation
                });
            });
        });

        console.log(`Found ${employeeCountMap.size} unique employees in measurements`);

        // Step 4: Process each department-designation combination
        const productQuantityMap = new Map(); // key: stockItemId_variantId

        // For each department in organization departments
        orgDept.departments.forEach(dept => {
            if (dept.status !== 'active') return;
            
            // For each designation in the department
            dept.designations.forEach(desig => {
                if (desig.status !== 'active' || !desig.assignedStockItems) return;
                
                // Count how many employees in measurements have this exact department-designation
                let employeeCount = 0;
                const matchingEmployees = [];
                
                employeeCountMap.forEach(emp => {
                    // Direct string comparison for department and designation
                    if (emp.department === dept.name && emp.designation === desig.name) {
                        employeeCount++;
                        matchingEmployees.push(emp.employeeName);
                    }
                });
                
                if (employeeCount > 0) {
                    console.log(`\nDepartment: "${dept.name}", Designation: "${desig.name}"`);
                    console.log(`Found ${employeeCount} employees: ${matchingEmployees.join(', ')}`);
                    
                    // For each stock item assigned to this designation
                    desig.assignedStockItems.forEach(item => {
                        if (!item.stockItemId) return;
                        
                        const stockItemId = item.stockItemId.toString();
                        const variantId = item.variantId ? item.variantId.toString() : 'default';
                        const key = `${stockItemId}_${variantId}`;
                        const quantityPerEmployee = item.quantity || 1;
                        const totalQuantityForThisGroup = employeeCount * quantityPerEmployee;
                        
                        console.log(`  Stock Item: ${stockItemId}, Variant: ${variantId}`);
                        console.log(`  Quantity per employee: ${quantityPerEmployee}`);
                        console.log(`  Total for ${employeeCount} employees: ${totalQuantityForThisGroup}`);
                        
                        if (!productQuantityMap.has(key)) {
                            productQuantityMap.set(key, {
                                stockItemId: stockItemId,
                                variantId: variantId,
                                totalQuantity: 0,
                                employeeGroups: [],
                                allEmployees: new Set()
                            });
                        }
                        
                        const product = productQuantityMap.get(key);
                        product.totalQuantity += totalQuantityForThisGroup;
                        
                        // Track which employee group contributed to this quantity
                        product.employeeGroups.push({
                            department: dept.name,
                            designation: desig.name,
                            employeeCount: employeeCount,
                            employeeNames: matchingEmployees,
                            quantityPerEmployee: quantityPerEmployee,
                            groupTotal: totalQuantityForThisGroup
                        });
                        
                        // Add all employee names to the set
                        matchingEmployees.forEach(name => product.allEmployees.add(name));
                    });
                }
            });
        });

        console.log(`\n=== FINAL PRODUCT QUANTITIES ===`);
        console.log(`Found ${productQuantityMap.size} unique products with assignments`);

        // Step 5: Get stock item details for the products we found
        const stockItemIds = Array.from(productQuantityMap.values()).map(p => p.stockItemId);
        const stockItems = await StockItem.find({
            _id: { $in: stockItemIds }
        })
            .select('name reference baseSalesPrice')
            .lean();

        // Create a map for quick lookup
        const stockItemMap = new Map();
        stockItems.forEach(item => {
            stockItemMap.set(item._id.toString(), {
                name: item.name,
                reference: item.reference,
                basePrice: item.baseSalesPrice || 0
            });
        });

        // Step 6: Prepare final product data
        const products = Array.from(productQuantityMap.values()).map(product => {
            const stockItemInfo = stockItemMap.get(product.stockItemId) || {
                name: 'Unknown Product',
                reference: '',
                basePrice: 0
            };
            
            const totalPrice = product.totalQuantity * stockItemInfo.basePrice;
            
            // Find variant name from measurements (if available)
            let variantName = "Default";
            measurements.forEach(measurement => {
                measurement.employeeMeasurements.forEach(emp => {
                    emp.stockItems.forEach(stockItem => {
                        const stockItemId = stockItem.stockItemId?._id?.toString();
                        const stockVariantId = stockItem.variantId?.toString() || 'default';
                        
                        if (stockItemId === product.stockItemId && 
                            stockVariantId === product.variantId &&
                            stockItem.variantName) {
                            variantName = stockItem.variantName;
                        }
                    });
                });
            });
            
            return {
                stockItemName: stockItemInfo.name,
                variantName: variantName,
                reference: stockItemInfo.reference,
                basePrice: stockItemInfo.basePrice,
                totalQuantity: product.totalQuantity,
                totalPrice: totalPrice,
                employeeCount: product.allEmployees.size,
                employeeNames: Array.from(product.allEmployees).join(', '),
                employeeGroups: product.employeeGroups
            };
        });

        // Step 7: Create CSV
        const headers = [
            'Stock Item', 
            'Variant', 
            'Reference', 
            'Employees', 
            'Employee Count', 
            'Total Quantity', 
            'Unit Price', 
            'Total Price'
        ];
        
        const rows = products.map(p => [
            `"${p.stockItemName}"`,
            `"${p.variantName}"`,
            p.reference,
            `"${p.employeeNames}"`,
            p.employeeCount,
            p.totalQuantity,
            p.basePrice.toFixed(2),
            p.totalPrice.toFixed(2)
        ]);

        // Add detailed breakdown section
        let detailedRows = ['\n=== DETAILED BREAKDOWN ==='];
        products.forEach(p => {
            detailedRows.push(`\n${p.stockItemName} (${p.variantName}):`);
            p.employeeGroups.forEach(group => {
                detailedRows.push(`  ${group.department} - ${group.designation}:`);
                detailedRows.push(`    Employees: ${group.employeeNames.join(', ')}`);
                detailedRows.push(`    Quantity per employee: ${group.quantityPerEmployee}`);
                detailedRows.push(`    Total: ${group.groupTotal}`);
            });
        });

        // Add totals
        const totals = products.reduce((acc, p) => ({
            totalQuantity: acc.totalQuantity + p.totalQuantity,
            totalPrice: acc.totalPrice + p.totalPrice,
            totalProducts: acc.totalProducts + 1
        }), { totalQuantity: 0, totalPrice: 0, totalProducts: 0 });

        const csvContent = [
            headers.join(','),
            ...rows.map(r => r.join(',')),
            `,,,,Total: ${totals.totalQuantity},,Total: ${totals.totalPrice.toFixed(2)}`,
            ...detailedRows
        ].join('\n');

        // Send response
        const filename = `Product_Pricing_${customer.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
        
        // Add UTF-8 BOM for Excel compatibility
        const bom = '\uFEFF';
        const csvWithBom = bom + csvContent;
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        
        console.log(`\nExport complete: ${products.length} products, ${totals.totalQuantity} total quantity`);
        res.send(csvWithBom);

    } catch (error) {
        console.error('Export error:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Export failed',
            error: error.message
        });
    }
});



router.get('/organization/:orgId/departments-with-items-variants', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Get organization departments with populated stock items and variant info
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
                                variantId: item.variantId || null,
                                variantName: item.variantName || "Default",
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
        console.error('Error fetching departments with items and variants:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching departments with stock items and variants'
        });
    }
});


// Add this route in your measurementRoutes.js (before the export route)
router.get('/organization/:orgId/export-product-pricing/stats', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Validate organization ID
        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

        // Step 1: Get all measurements for this organization
        const measurements = await Measurement.find({
            organizationId: orgId
        })
            .select('employeeMeasurements')
            .lean();

        if (!measurements || measurements.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No measurements found for this organization'
            });
        }

        // Step 2: Get organization departments
        const orgDept = await OrganizationDepartment.findOne({
            customerId: orgId,
            status: 'active'
        }).lean();

        if (!orgDept) {
            return res.status(404).json({
                success: false,
                message: 'Organization departments not found'
            });
        }

        // Helper function to get assigned quantity (same as in export route)
        const getAssignedQuantity = (departmentName, designationName, stockItemId, variantId) => {
            const department = orgDept.departments.find(dept =>
                dept.status === 'active' && dept.name === departmentName
            );

            if (!department) return 1;

            const designation = department.designations.find(desig =>
                desig.status === 'active' && desig.name === designationName
            );

            if (!designation || !designation.assignedStockItems) return 1;

            const assignedItem = designation.assignedStockItems.find(item => {
                const stockItemMatches = item.stockItemId.toString() === stockItemId.toString();

                if (variantId) {
                    return stockItemMatches && (
                        (item.variantId && item.variantId.toString() === variantId.toString()) ||
                        !item.variantId
                    );
                } else {
                    return stockItemMatches && !item.variantId;
                }
            });

            return assignedItem ? assignedItem.quantity : 1;
        };

        // Process measurements to calculate stats
        const productMap = new Map();
        let totalEmployees = 0;
        const employeeSet = new Set();

        measurements.forEach(measurement => {
            measurement.employeeMeasurements.forEach(emp => {
                // Track unique employees
                const employeeKey = `${emp.employeeId}_${emp.department}_${emp.designation}`;
                if (!employeeSet.has(employeeKey)) {
                    employeeSet.add(employeeKey);
                    totalEmployees++;
                }

                emp.stockItems.forEach(stockItem => {
                    if (!stockItem.stockItemId) return;

                    const stockItemId = stockItem.stockItemId.toString();
                    const variantId = stockItem.variantId ? stockItem.variantId.toString() : null;
                    const key = `${stockItemId}_${variantId || 'no-variant'}`;

                    if (!productMap.has(key)) {
                        productMap.set(key, {
                            stockItemId: stockItemId,
                            variantId: variantId,
                            deptDesignationMap: new Map()
                        });
                    }

                    const data = productMap.get(key);
                    const deptDesigKey = `${emp.department}_${emp.designation}`;

                    if (!data.deptDesignationMap.has(deptDesigKey)) {
                        data.deptDesignationMap.set(deptDesigKey, {
                            department: emp.department,
                            designation: emp.designation,
                            employeeCount: 0
                        });
                    }

                    const deptData = data.deptDesignationMap.get(deptDesigKey);
                    deptData.employeeCount += 1;
                });
            });
        });

        // Calculate totals
        let totalProducts = productMap.size;
        let totalQuantity = 0;

        productMap.forEach(data => {
            data.deptDesignationMap.forEach(deptData => {
                const assignedQuantity = getAssignedQuantity(
                    deptData.department,
                    deptData.designation,
                    data.stockItemId,
                    data.variantId
                );
                totalQuantity += deptData.employeeCount * assignedQuantity;
            });
        });

        // For demo, we'll use an average price - you might want to fetch actual prices
        const averagePrice = 500; // Average product price
        const totalEstimatedPrice = totalQuantity * averagePrice;

        res.status(200).json({
            success: true,
            stats: {
                totalProducts,
                totalQuantity,
                totalEstimatedPrice,
                totalEmployees
            }
        });

    } catch (error) {
        console.error('Error fetching export stats:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching export stats'
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

// here the conversion to purchase order will be handled

// CONVERT measurement to Purchase Order (SIMPLIFIED VERSION)
// CONVERT measurement to Purchase Order (FULLY WORKING VERSION)
router.post('/:measurementId/convert-to-po', async (req, res) => {
    try {
        const { measurementId } = req.params;

        // Validate measurementId
        if (!measurementId || !mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid measurement ID is required'
            });
        }

        // Get measurement
        const measurement = await Measurement.findById(measurementId);
        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Check if already converted to PO
        if (measurement.convertedToPO) {
            return res.status(400).json({
                success: false,
                message: 'Measurement already converted to PO'
            });
        }

        // Calculate completion rate
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

        const completionRate = totalMeasurementFields > 0
            ? Math.round((completedMeasurementFields / totalMeasurementFields) * 100)
            : 0;

        // Check if measurement is complete
        if (completionRate < 100) {
            return res.status(400).json({
                success: false,
                message: 'Cannot convert incomplete measurement to PO. Please complete all measurements first.'
            });
        }

        // Get customer
        const customer = await Customer.findById(measurement.organizationId);
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Customer not found'
            });
        }

        // Get organization departments
        const orgDepartment = await OrganizationDepartment.findOne({
            customerId: measurement.organizationId,
            status: 'active'
        }).lean();

        if (!orgDepartment) {
            return res.status(404).json({
                success: false,
                message: 'Organization departments not found'
            });
        }

        // STEP 1: Collect all unique stockItemIds from measurement
        const stockItemIds = new Set();
        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                if (stockItem.stockItemId) {
                    stockItemIds.add(stockItem.stockItemId.toString());
                }
            });
        });

        // STEP 2: Fetch ALL stock items WITH their variants populated
        const stockItems = await StockItem.find({
            _id: { $in: Array.from(stockItemIds) }
        }).select('_id name reference baseSalesPrice attributes variants');

        // Create a map for quick access
        const stockItemMap = new Map();
        stockItems.forEach(item => {
            stockItemMap.set(item._id.toString(), item);
        });

        // STEP 3: Group measurements by stockItemId + variantId
        const itemGroupMap = new Map();

        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                const stockItemId = stockItem.stockItemId.toString();
                const variantId = stockItem.variantId ? stockItem.variantId.toString() : 'no-variant';
                const groupKey = `${stockItemId}_${variantId}`;

                if (!itemGroupMap.has(groupKey)) {
                    itemGroupMap.set(groupKey, {
                        stockItemId: stockItem.stockItemId,
                        variantId: stockItem.variantId,
                        variantName: stockItem.variantName || "Default",
                        employeeGroups: new Map() // Group by department+designation
                    });
                }

                const group = itemGroupMap.get(groupKey);
                const deptDesigKey = `${emp.department}_${emp.designation}`;

                if (!group.employeeGroups.has(deptDesigKey)) {
                    group.employeeGroups.set(deptDesigKey, {
                        department: emp.department,
                        designation: emp.designation,
                        employeeCount: 0
                    });
                }

                const deptGroup = group.employeeGroups.get(deptDesigKey);
                deptGroup.employeeCount += 1;
            });
        });

        // STEP 4: Create validated items for CustomerRequest
        const validatedItems = [];

        for (const [groupKey, groupData] of itemGroupMap) {
            const stockItem = stockItemMap.get(groupData.stockItemId.toString());
            if (!stockItem) {
                console.error(`CRITICAL: Stock item ${groupData.stockItemId} not found in database`);
                continue;
            }

            // STEP 5: Find the variant and get its attributes
            let variantAttributes = [];
            let variantPrice = stockItem.baseSalesPrice;
            let finalVariantId = groupData.variantId;

            

            // Find variant by variantId
            if (groupData.variantId && stockItem.variants && stockItem.variants.length > 0) {
                const variant = stockItem.variants.find(v => {
                    const variantId = v._id ? v._id.toString() : null;
                    return variantId === groupData.variantId.toString();
                });

                if (variant) {
                    console.log(`Found variant: ${variant._id}, attributes: ${JSON.stringify(variant.attributes)}`);
                    variantPrice = variant.salesPrice || stockItem.baseSalesPrice;
                    finalVariantId = variant._id;
                    variantAttributes = variant.attributes || [];

                    // If variant has no attributes but stock item has attribute definitions, create empty attributes
                    if (variantAttributes.length === 0 && stockItem.attributes && stockItem.attributes.length > 0) {
                        variantAttributes = stockItem.attributes.map(attr => ({
                            name: attr.name,
                            value: "" // Empty value
                        }));
                    }
                } else {
                    console.warn(`Variant ${groupData.variantId} not found in stock item ${stockItem.name}`);

                    // If variant not found, use first variant or create default
                    if (stockItem.variants.length > 0) {
                        const firstVariant = stockItem.variants[0];
                        variantPrice = firstVariant.salesPrice || stockItem.baseSalesPrice;
                        finalVariantId = firstVariant._id;
                        variantAttributes = firstVariant.attributes || [];
                    }
                }
            } else if (stockItem.attributes && stockItem.attributes.length > 0) {
                // If no variant but stock item has attributes, create empty attributes
                variantAttributes = stockItem.attributes.map(attr => ({
                    name: attr.name,
                    value: ""
                }));
            }

            // STEP 6: Calculate total quantity
            let totalQuantity = 0;

            for (const [deptDesigKey, empGroup] of groupData.employeeGroups) {
                // Find department
                const department = orgDepartment.departments.find(dept =>
                    dept.name === empGroup.department && dept.status === 'active'
                );

                if (!department) {
                    console.warn(`Department ${empGroup.department} not found`);
                    continue;
                }

                const designation = department.designations.find(desig =>
                    desig.name === empGroup.designation && desig.status === 'active'
                );

                if (!designation) {
                    console.warn(`Designation ${empGroup.designation} not found`);
                    continue;
                }

                // Find assigned stock item
                let assignedItem = null;

                // Try exact match with variantId
                if (finalVariantId) {
                    assignedItem = designation.assignedStockItems.find(item =>
                        item.stockItemId.toString() === groupData.stockItemId.toString() &&
                        item.variantId && item.variantId.toString() === finalVariantId.toString()
                    );
                }

                // Try without variantId
                if (!assignedItem) {
                    assignedItem = designation.assignedStockItems.find(item =>
                        item.stockItemId.toString() === groupData.stockItemId.toString() &&
                        (!item.variantId || !item.variantId.toString())
                    );
                }

                // Try any variant of this stock item
                if (!assignedItem) {
                    assignedItem = designation.assignedStockItems.find(item =>
                        item.stockItemId.toString() === groupData.stockItemId.toString()
                    );
                }

                const quantityPerEmployee = assignedItem ? (assignedItem.quantity || 1) : 1;
                totalQuantity += empGroup.employeeCount * quantityPerEmployee;
            }

            if (totalQuantity < 1) {
                totalQuantity = 1; // Minimum quantity
            }

            // STEP 7: Create variant for CustomerRequest
            const variant = {
                variantId: finalVariantId,
                attributes: variantAttributes, // Will have attributes even if empty
                quantity: totalQuantity,
                specialInstructions: [],
                estimatedPrice: variantPrice * totalQuantity
            };

            // STEP 8: If attributes are empty but stock item has attribute definitions, ensure we have the structure
            if (variant.attributes.length === 0 && stockItem.attributes && stockItem.attributes.length > 0) {
                variant.attributes = stockItem.attributes.map(attr => ({
                    name: attr.name,
                    value: "" // Empty but at least has structure
                }));
            }

            validatedItems.push({
                stockItemId: stockItem._id,
                stockItemName: stockItem.name,
                stockItemReference: stockItem.reference,
                variants: [variant],
                totalQuantity,
                totalEstimatedPrice: variant.estimatedPrice
            });
        }

        // STEP 9: Validate items
        if (!validatedItems || !Array.isArray(validatedItems) || validatedItems.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid stock items found for PO creation'
            });
        }

        // STEP 10: Create CustomerRequest
        const requestCount = await CustomerRequest.countDocuments();
        const requestId = `REQ-${new Date().getFullYear()}-${String(requestCount + 1).padStart(4, '0')}`;

        const newRequest = new CustomerRequest({
            requestId,
            customerId: measurement.organizationId,
            customerInfo: {
                name: customer.name,
                email: customer.email || '',
                phone: customer.phone || '',
                address: customer.profile?.address?.street || '',
                city: customer.profile?.address?.city || '',
                postalCode: customer.profile?.address?.pincode || '',
                description: `Purchase order generated from measurement: ${measurement.name}`,
                deliveryDeadline: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
                preferredContactMethod: 'phone'
            },
            items: validatedItems,
            status: 'pending',
            priority: 'high',
            measurementId: measurement._id,
            measurementName: measurement.name,
            requestType: 'measurement_conversion',
            createdAt: new Date()
        });

        await newRequest.save();

        // Populate request
        const populatedRequest = await CustomerRequest.findById(newRequest._id)
            .populate({
                path: 'items.stockItemId',
                select: 'name reference category images'
            });

        // Send email
        try {
            if (CustomerEmailService && CustomerEmailService.sendRequestConfirmationEmail) {
                CustomerEmailService.sendRequestConfirmationEmail(
                    {
                        requestId: populatedRequest.requestId,
                        createdAt: populatedRequest.createdAt,
                        items: populatedRequest.items.map(item => ({
                            name: item.stockItemName,
                            reference: item.stockItemReference,
                            variants: item.variants,
                            totalQuantity: item.totalQuantity,
                            totalEstimatedPrice: item.totalEstimatedPrice
                        })),
                        totalEstimatedPrice: populatedRequest.items.reduce((sum, item) => sum + item.totalEstimatedPrice, 0)
                    },
                    {
                        name: customer.name,
                        email: customer.email,
                        phone: customer.phone
                    }
                );
            }
        } catch (emailError) {
            console.error('Request email sending failed:', emailError);
        }

        // Update measurement
        measurement.convertedToPO = true;
        measurement.poRequestId = newRequest._id;
        measurement.poConversionDate = new Date();
        if (req.user && req.user.id) {
            measurement.convertedBy = req.user.id;
        }

        measurement.completionRate = 100;
        measurement.measuredEmployees = measurement.registeredEmployeeIds?.length || 0;
        measurement.pendingEmployees = 0;

        await measurement.save();

        res.status(201).json({
            success: true,
            message: 'Measurement successfully converted to Purchase Order. Confirmation email has been sent.',
            request: populatedRequest,
            totalEstimatedPrice: populatedRequest.items.reduce((sum, item) => sum + item.totalEstimatedPrice, 0)
        });

    } catch (error) {
        console.error('Error converting measurement to PO:', error);

        if (error.name === 'ValidationError') {
            const messages = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: messages.join(', ')
            });
        }

        res.status(500).json({
            success: false,
            message: 'Server error while converting measurement to PO',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});


// GET organization details
router.get('/organization/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Validate orgId
        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

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
            { $match: { customerId: new mongoose.Types.ObjectId(orgId) } },
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
            { $match: { organizationId: new mongoose.Types.ObjectId(orgId) } },
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
// GET organization measurements
router.get('/organization/:orgId/measurements', async (req, res) => {
    try {
        const { orgId } = req.params;

        // Validate orgId
        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

        const measurements = await Measurement.find({
            organizationId: new mongoose.Types.ObjectId(orgId)
        })
            .select('name description totalRegisteredEmployees measuredEmployees pendingEmployees completionRate totalMeasurements completedMeasurements pendingMeasurements createdAt updatedAt convertedToPO poRequestId')
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

// CREATE new measurement (updated to fetch attributes from variants)
// CREATE new measurement (updated to fetch attributes from variants)
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

        // Get all stock items in one query for performance
        const stockItemIds = [...new Set(measurementData.map(data => data.stockItemId))];
        const stockItems = await StockItem.find({
            _id: { $in: stockItemIds }
        }).select('_id name reference variants');

        const stockItemMap = new Map();
        stockItems.forEach(item => {
            stockItemMap.set(item._id.toString(), item);
        });

        // Group measurements by employee
        const employeeMeasurementsMap = new Map();

        for (const data of measurementData) {
            const employeeId = data.employeeId;

            if (!employeeMeasurementsMap.has(employeeId)) {
                employeeMeasurementsMap.set(employeeId, {
                    employeeId: data.employeeId,
                    employeeName: data.employeeName,
                    employeeUIN: data.employeeUIN,
                    department: data.department,
                    designation: data.designation,
                    remarks: data.remarks || "",
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

            // Include variant information in stock item name if variant exists
            let stockItemName = data.stockItemName;
            let attributes = [];

            // Get the stock item from map
            const stockItem = stockItemMap.get(data.stockItemId.toString());
            if (!stockItem) {
                console.warn(`Stock item ${data.stockItemId} not found`);
                continue;
            }

            // If variant exists, fetch its attributes
            if (data.variantId && stockItem.variants && stockItem.variants.length > 0) {
                const variant = stockItem.variants.find(v =>
                    v._id.toString() === data.variantId.toString()
                );

                if (variant) {
                    attributes = variant.attributes || [];

                    if (data.variantName && data.variantName !== "Default") {
                        // Append variant info to stock item name
                        stockItemName = `${data.stockItemName.includes(" (Variant:")
                            ? data.stockItemName.split(" (Variant:")[0]
                            : data.stockItemName} (Variant: ${data.variantName})`;
                    }
                }
            }

            // Check if stock item already exists for this employee
            const existingStockItemIndex = employeeData.stockItems.findIndex(
                item => item.stockItemId.toString() === data.stockItemId.toString() &&
                    item.variantId?.toString() === data.variantId?.toString()
            );

            if (existingStockItemIndex >= 0) {
                // Update existing stock item measurements
                employeeData.stockItems[existingStockItemIndex] = {
                    ...employeeData.stockItems[existingStockItemIndex],
                    measurements: measurementsArray,
                    measuredAt: new Date()
                };
            } else {
                // Add new stock item with variant info AND attributes
                employeeData.stockItems.push({
                    stockItemId: data.stockItemId,
                    stockItemName: stockItemName,
                    variantId: data.variantId || null,
                    variantName: data.variantName || "Default",
                    attributes: attributes, // Store fetched attributes
                    measurements: measurementsArray,
                    measuredAt: new Date()
                });
            }
        }

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

        // Calculate statistics
        const totalRegisteredEmployees = registeredEmployeeIds?.length || 0;
        const measuredEmployees = employeeMeasurements.filter(emp => emp.isCompleted).length;
        const pendingEmployees = totalRegisteredEmployees - measuredEmployees;
        const completionRate = totalRegisteredEmployees > 0
            ? Math.round((measuredEmployees / totalRegisteredEmployees) * 100)
            : 0;

        // Count measurements
        let totalMeasurements = 0;
        let completedMeasurements = 0;

        employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                totalMeasurements += stockItem.measurements.length;
                completedMeasurements += stockItem.measurements.filter(m =>
                    m.value && m.value.trim() !== ''
                ).length;
            });
        });

        // Create new measurement
        const newMeasurement = new Measurement({
            organizationId: customer._id,
            organizationName: customer.name,
            name: name.trim(),
            description: description ? description.trim() : '',
            registeredEmployeeIds: registeredEmployeeIds || [],
            employeeMeasurements: employeeMeasurements,
            totalRegisteredEmployees: totalRegisteredEmployees,
            measuredEmployees: measuredEmployees,
            pendingEmployees: pendingEmployees,
            completionRate: completionRate,
            totalMeasurements: totalMeasurements,
            completedMeasurements: completedMeasurements,
            pendingMeasurements: totalMeasurements - completedMeasurements,
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


router.get('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;

        // Validate measurementId
        if (!measurementId || !mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid measurement ID is required'
            });
        }

        // Use select to explicitly include all necessary fields including remarks
        const measurement = await Measurement.findById(measurementId)
            .select('organizationId organizationName name description registeredEmployeeIds employeeMeasurements totalRegisteredEmployees measuredEmployees pendingEmployees completionRate totalMeasurements completedMeasurements pendingMeasurements convertedToPO poRequestId poConversionDate convertedBy createdBy updatedBy createdAt updatedAt')
            .populate({
                path: 'employeeMeasurements.stockItems.stockItemId',
                select: 'name reference category measurements'
            })
            .populate('convertedBy', 'name email')
            .lean();

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        

        // Rest of your existing code...
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
                        remarks: data.remarks || "",  // Store remarks here
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

                    // Add new employee with their measurements AND REMARKS
                    measurement.employeeMeasurements.push({
                        employeeId: newEmployeeData.employeeId,
                        employeeName: newEmployeeData.employeeName,
                        employeeUIN: newEmployeeData.employeeUIN,
                        department: newEmployeeData.department,
                        designation: newEmployeeData.designation,
                        remarks: newEmployeeData.remarks || "",  // MAKE SURE TO INCLUDE REMARKS HERE
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
// UPDATE measurement (updated with attributes) - FIXED VERSION
router.put('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { name, description, measurementData, registeredEmployeeIds } = req.body;

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

        // If measurementData is provided, update measurements
        if (measurementData && Array.isArray(measurementData)) {
            // Create a map for incoming data by employeeId for remarks lookup
            const incomingEmployeeDataMap = new Map();
            measurementData.forEach(data => {
                if (data.employeeId) {
                    incomingEmployeeDataMap.set(data.employeeId.toString(), {
                        remarks: data.remarks || ""
                    });
                }
            });

            // Create a map of existing employees for quick lookup
            const existingEmployeeMap = new Map();
            measurement.employeeMeasurements.forEach(emp => {
                existingEmployeeMap.set(emp.employeeId.toString(), emp);
            });

            // Group incoming data by employee and stock item with variant
            const incomingUpdates = new Map();

            measurementData.forEach(data => {
                if (!data.employeeId || !data.stockItemId) {
                    console.log('Skipping invalid data:', data);
                    return;
                }

                const employeeId = data.employeeId.toString();
                const stockItemId = data.stockItemId.toString();
                const variantId = data.variantId || "default";
                const key = `${employeeId}_${stockItemId}_${variantId}`;

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
                    variantId: data.variantId,
                    variantName: data.variantName || "Default",
                    stockItemName: data.stockItemName,
                    attributes: data.attributes || [],
                    measurements: measurementsArray
                });
            });

            // Update employee measurements
            measurement.employeeMeasurements = measurement.employeeMeasurements.map(emp => {
                const employeeId = emp.employeeId.toString();

                // Get remarks from incoming data if available
                const incomingEmployeeData = incomingEmployeeDataMap.get(employeeId);
                const employeeRemarks = incomingEmployeeData ? incomingEmployeeData.remarks : emp.remarks;

                // Update stock items for this employee
                const updatedStockItems = emp.stockItems.map(stockItem => {
                    const stockItemId = stockItem.stockItemId.toString();
                    const variantId = stockItem.variantId?.toString() || "default";
                    const key = `${employeeId}_${stockItemId}_${variantId}`;

                    if (incomingUpdates.has(key)) {
                        const update = incomingUpdates.get(key);
                        // Include variant info in stock item name
                        let stockItemName = update.stockItemName;
                        if (update.variantId && update.variantName !== "Default") {
                            stockItemName = `${update.stockItemName.includes(" (Variant:")
                                ? update.stockItemName.split(" (Variant:")[0]
                                : update.stockItemName} (Variant: ${update.variantName})`;
                        }

                        return {
                            ...stockItem.toObject ? stockItem.toObject() : stockItem,
                            stockItemName: stockItemName,
                            variantId: update.variantId,
                            variantName: update.variantName,
                            attributes: update.attributes || [],
                            measurements: update.measurements,
                            measuredAt: new Date()
                        };
                    }

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
                    remarks: employeeRemarks,  // FIXED: Use employeeRemarks instead of data.remarks
                    isCompleted: isCompleted,
                    completedAt: isCompleted ? new Date() : emp.completedAt
                };
            });
        }

        // Update statistics
        measurement.totalRegisteredEmployees = measurement.registeredEmployeeIds?.length || 0;
        measurement.measuredEmployees = measurement.employeeMeasurements.filter(emp => emp.isCompleted).length;
        measurement.pendingEmployees = measurement.totalRegisteredEmployees - measurement.measuredEmployees;
        measurement.completionRate = measurement.totalRegisteredEmployees > 0
            ? Math.round((measurement.measuredEmployees / measurement.totalRegisteredEmployees) * 100)
            : 0;

        // Recalculate measurement counts
        let totalMeasurements = 0;
        let completedMeasurements = 0;

        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                totalMeasurements += stockItem.measurements.length;
                completedMeasurements += stockItem.measurements.filter(m =>
                    m.value && m.value.trim() !== ''
                ).length;
            });
        });

        measurement.totalMeasurements = totalMeasurements;
        measurement.completedMeasurements = completedMeasurements;
        measurement.pendingMeasurements = totalMeasurements - completedMeasurements;

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

// In your measurementRoutes.js, update the export route and add new grouped export route

// Add this route for grouped CSV export
router.get('/:measurementId/export-grouped', async (req, res) => {
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

        // Group measurements by stock item
        const stockItemMap = new Map();

        measurement.employeeMeasurements.forEach(emp => {
            emp.stockItems.forEach(stockItem => {
                const key = stockItem.stockItemId?._id?.toString() || stockItem.stockItemName;
                if (!stockItemMap.has(key)) {
                    stockItemMap.set(key, {
                        stockItemName: stockItem.stockItemName,
                        reference: stockItem.stockItemId?.reference || '',
                        employees: [],
                        measurements: stockItem.measurements.map(m => ({
                            name: m.measurementName,
                            unit: m.unit || ''
                        }))
                    });
                }

                const stockItemData = stockItemMap.get(key);

                // Create employee measurement object
                const empMeasurement = {
                    employeeName: emp.employeeName,
                    employeeUIN: emp.employeeUIN,
                    department: emp.department,
                    designation: emp.designation,
                    remarks: emp.remarks || '',
                    measurements: {}
                };

                // Map measurements to object for easy access
                stockItem.measurements.forEach(m => {
                    empMeasurement.measurements[m.measurementName] = m.value || '';
                });

                stockItemData.employees.push(empMeasurement);
            });
        });

        // Create CSV content grouped by stock item
        let csvContent = '';

        // Add BOM for UTF-8 encoding
        csvContent += '\uFEFF';

        stockItemMap.forEach((stockItemData, stockItemId) => {
            csvContent += `Stock Item: "${stockItemData.stockItemName}"`;
            if (stockItemData.reference) {
                csvContent += ` (Ref: ${stockItemData.reference})`;
            }
            csvContent += '\n\n';

            // Headers
            const headers = ['Employee Name', 'UIN', 'Department', 'Designation', 'Remarks'];
            stockItemData.measurements.forEach(m => {
                headers.push(`${m.name}${m.unit ? ` (${m.unit})` : ''}`);
            });
            csvContent += headers.join(',') + '\n';

            // Rows
            stockItemData.employees.forEach(emp => {
                const row = [
                    `"${emp.employeeName}"`,
                    emp.employeeUIN,
                    emp.department,
                    emp.designation,
                    `"${emp.remarks}"`,
                    ...stockItemData.measurements.map(m => emp.measurements[m.name] || '')
                ];
                csvContent += row.join(',') + '\n';
            });

            csvContent += '\n\n';
        });

        // Add summary
        csvContent += '=== SUMMARY ===\n';
        csvContent += `Total Employees: ${measurement.employeeMeasurements.length}\n`;
        csvContent += `Total Stock Items: ${stockItemMap.size}\n`;
        csvContent += `Generated: ${new Date().toLocaleString()}\n`;

        const filename = `${measurement.name.replace(/\s+/g, '_')}_grouped_measurements.csv`;

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

    } catch (error) {
        console.error('Error exporting grouped measurement:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while exporting grouped measurement'
        });
    }
});

// Update the existing export route to fix UTF-8 encoding
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
            'Remarks',
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
                    `"${emp.remarks || ''}"`,
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
            '\uFEFF', // BOM for UTF-8
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
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
