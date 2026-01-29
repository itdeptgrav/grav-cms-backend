const express = require('express');
const router = express.Router();
const Measurement = require('../../../models/Customer_Models/Measurement');
const Customer = require('../../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../../models/CMS_Models/Inventory/Products/StockItem');
const EmployeeAuthMiddleware = require('../../../Middlewear/EmployeeAuthMiddlewear');
const CustomerRequest = require('../../../models/Customer_Models/CustomerRequest');
const mongoose = require('mongoose');

// Apply auth middleware
router.use(EmployeeAuthMiddleware);

// GET organizations with measurement stats
router.get('/organizations', async (req, res) => {
    try {
        const customers = await Customer.find({})
            .select('_id name email phone createdAt')
            .sort({ name: 1 })
            .lean();

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

        const measurementStats = await Measurement.aggregate([
            {
                $group: {
                    _id: '$organizationId',
                    totalMeasurements: { $sum: 1 },
                    lastUpdated: { $max: '$updatedAt' }
                }
            }
        ]);

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

// GET organization employees with their products
// GET organization employees with their products
router.get('/organization/:orgId/employees', async (req, res) => {
    try {
        const { orgId } = req.params;

        const customer = await Customer.findById(orgId)
            .select('_id name email phone')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        const employees = await EmployeeMpc.find({
            customerId: orgId,
            status: 'active'
        })
            .select('_id name uin gender products')
            .populate({
                path: 'products.productId',
                select: '_id name reference measurements', // ADD measurements here
                populate: { // If you need variants populated too
                    path: 'variants',
                    select: '_id sku attributes salesPrice'
                }
            })
            .lean();

        // Log to debug
        console.log(`Found ${employees.length} employees`);
        employees.forEach((emp, index) => {
            console.log(`Employee ${index + 1}: ${emp.name}, Products: ${emp.products?.length || 0}`);
            emp.products?.forEach((prod, prodIndex) => {
                console.log(`  Product ${prodIndex + 1}: ${prod.productId?.name}, Measurements: ${prod.productId?.measurements?.length || 0}`);
            });
        });

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


// In your routes file, add this route:
router.get('/stock-item/:productId', async (req, res) => {
    try {
        const { productId } = req.params;

        const stockItem = await StockItem.findById(productId)
            .select('name reference measurements variants')
            .lean();

        if (!stockItem) {
            return res.status(404).json({
                success: false,
                message: 'Product not found'
            });
        }

        res.status(200).json({
            success: true,
            stockItem: {
                ...stockItem,
                measurements: stockItem.measurements || [] // Ensure measurements array exists
            }
        });

    } catch (error) {
        console.error('Error fetching stock item:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching product'
        });
    }
});




// GET organization details with employee stats
router.get('/organization/:orgId', async (req, res) => {
    try {
        const { orgId } = req.params;

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

        // Get product stats
        const productStats = await EmployeeMpc.aggregate([
            { $match: { customerId: new mongoose.Types.ObjectId(orgId) } },
            { $unwind: { path: "$products", preserveNullAndEmptyArrays: true } },
            {
                $group: {
                    _id: null,
                    totalProductAssignments: { $sum: 1 },
                    uniqueProducts: { $addToSet: "$products.productId" }
                }
            }
        ]);

        // Calculate unique product count
        const uniqueProductsCount = productStats.length > 0 ? productStats[0].uniqueProducts.length : 0;

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
                productStats: {
                    totalAssignments: productStats[0]?.totalProductAssignments || 0,
                    uniqueProducts: uniqueProductsCount
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

// CREATE new measurement
router.post('/', async (req, res) => {
    try {
        const { organizationId, name, description, measurementData, registeredEmployeeIds } = req.body;

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

        const customer = await Customer.findById(organizationId)
            .select('_id name')
            .lean();

        if (!customer) {
            return res.status(404).json({
                success: false,
                message: 'Organization not found'
            });
        }

        // Get all stock items for measurements
        const stockItemIds = [...new Set(measurementData.map(data => data.productId))];
        const stockItems = await StockItem.find({
            _id: { $in: stockItemIds }
        }).select('_id name reference measurements');

        const stockItemMap = new Map();
        stockItems.forEach(item => {
            stockItemMap.set(item._id.toString(), item);
        });

        // Group measurements by employee
        const employeeMeasurementsMap = new Map();

        for (const data of measurementData) {
            const employeeId = data.employeeId;

            if (!employeeMeasurementsMap.has(employeeId)) {
                // Get employee details
                const employee = await EmployeeMpc.findById(employeeId)
                    .select('name uin gender')
                    .lean();

                if (!employee) {
                    console.warn(`Employee ${employeeId} not found`);
                    continue;
                }

                employeeMeasurementsMap.set(employeeId, {
                    employeeId: data.employeeId,
                    employeeName: employee.name,
                    employeeUIN: employee.uin,
                    gender: employee.gender,
                    remarks: data.remarks || "",
                    products: []
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

            // Get the stock item
            const stockItem = stockItemMap.get(data.productId.toString());
            if (!stockItem) {
                console.warn(`Product ${data.productId} not found`);
                continue;
            }

            // Get variant name if exists
            let variantName = "Default";
            if (data.variantId && stockItem.variants) {
                const variant = stockItem.variants.find(v => 
                    v._id.toString() === data.variantId.toString()
                );
                if (variant && variant.attributes) {
                    variantName = variant.attributes.map(a => a.value).join(" • ") || "Default";
                }
            }

            employeeData.products.push({
                productId: data.productId,
                productName: stockItem.name,
                variantId: data.variantId || null,
                variantName: variantName,
                quantity: data.quantity || 1,
                measurements: measurementsArray,
                measuredAt: new Date()
            });
        }

        // Convert map to array and calculate completion
        const employeeMeasurements = Array.from(employeeMeasurementsMap.values()).map(emp => {
            const isCompleted = emp.products.length > 0 && emp.products.every(product =>
                product.measurements.length > 0 &&
                product.measurements.every(m => m.value && m.value.trim() !== '')
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
            emp.products.forEach(product => {
                totalMeasurements += product.measurements.length;
                completedMeasurements += product.measurements.filter(m =>
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

// Updated export product pricing route - FIXED to only include measured employees
router.get('/organization/:orgId/export-product-pricing', async (req, res) => {
    try {
        const { orgId } = req.params;
        
        // 1. Get organization name
        const customer = await Customer.findById(orgId).select('name').lean();
        if (!customer) {
            return res.status(404).json({ success: false, message: 'Organization not found' });
        }

        // 2. Get ALL measurements for this organization
        const measurements = await Measurement.find({
            organizationId: new mongoose.Types.ObjectId(orgId)
        })
        .select('employeeMeasurements')
        .lean();

        if (!measurements || measurements.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No measurements found for this organization' 
            });
        }

        // 3. Extract ALL measured employee IDs from ALL measurements
        const measuredEmployeeIds = new Set();
        
        measurements.forEach(measurement => {
            measurement.employeeMeasurements?.forEach(emp => {
                if (emp.employeeId) {
                    measuredEmployeeIds.add(emp.employeeId.toString());
                }
            });
        });

        console.log(`Found ${measuredEmployeeIds.size} measured employees:`, Array.from(measuredEmployeeIds));

        if (measuredEmployeeIds.size === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No employees have been measured yet' 
            });
        }

        // 4. Get ONLY measured employees from EmployeeMpc with their product assignments
        const measuredEmployees = await EmployeeMpc.find({ 
            customerId: orgId, 
            status: 'active',
            _id: { $in: Array.from(measuredEmployeeIds) }
        })
        .select('_id name uin gender products')
        .populate({
            path: 'products.productId',
            select: 'name reference baseSalesPrice variants'
        })
        .lean();
        
        console.log(`Fetched ${measuredEmployees.length} measured employees from EmployeeMpc`);

        if (measuredEmployees.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'Measured employees not found in EmployeeMpc' 
            });
        }

        // 5. Process product assignments from ONLY measured employees
        const productMap = new Map(); // Key: productId_variantId
        
        measuredEmployees.forEach(employee => {
            if (!employee.products || employee.products.length === 0) {
                console.log(`Employee ${employee.name} has no product assignments`);
                return;
            }
            
            console.log(`Processing measured employee ${employee.name}: ${employee.products.length} product assignments`);
            
            employee.products.forEach(productAssignment => {
                if (!productAssignment.productId) return;
                
                const productId = productAssignment.productId._id.toString();
                const variantId = productAssignment.variantId ? productAssignment.variantId.toString() : 'default';
                const productKey = `${productId}_${variantId}`;
                const quantity = productAssignment.quantity || 1;
                
                // Get product details from populated data
                const stockItem = productAssignment.productId;
                
                if (!productMap.has(productKey)) {
                    // Get variant name if exists
                    let variantName = "Default";
                    if (productAssignment.variantId && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === productAssignment.variantId.toString()
                        );
                        if (variant && variant.attributes) {
                            variantName = variant.attributes.map(a => a.value).join(" • ") || "Default";
                        }
                    }
                    
                    productMap.set(productKey, {
                        productId: productId,
                        productName: stockItem.name,
                        reference: stockItem.reference || '',
                        variantId: variantId,
                        variantName: variantName,
                        basePrice: stockItem.baseSalesPrice || 0,
                        variantPrice: null, // Will be populated below
                        employeeNames: new Set(),
                        totalQuantity: 0,
                        employeeCount: 0
                    });
                }
                
                const productData = productMap.get(productKey);
                
                // Add employee name
                productData.employeeNames.add(employee.name);
                productData.employeeCount = productData.employeeNames.size;
                
                // Add quantity
                productData.totalQuantity += quantity;
                
                console.log(`  Product: ${stockItem.name}, Variant: ${productData.variantName}, Qty: ${quantity}`);
            });
        });

        const products = Array.from(productMap.values());
        
        if (products.length === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No product assignments found for measured employees' 
            });
        }

        console.log(`Found ${products.length} unique product-variant combinations for measured employees`);

        // 6. Get variant prices for each product
        for (const product of products) {
            if (product.variantId !== 'default') {
                try {
                    const stockItem = await StockItem.findById(product.productId)
                        .select('variants')
                        .lean();
                    
                    if (stockItem && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === product.variantId
                        );
                        if (variant && variant.salesPrice) {
                            product.variantPrice = variant.salesPrice;
                            console.log(`Variant price for ${product.productName}: ${variant.salesPrice}`);
                        }
                    }
                } catch (err) {
                    console.error(`Error fetching variant price for product ${product.productId}:`, err);
                }
            }
        }

        // 7. Prepare CSV data
        const headers = [
            'Product Name',
            'Variant',
            'Reference',
            'Unit Price',
            'Quantity Per Employee',
            'Total Quantity',
            'Employee Count',
            'Employee Names',
            'Total Price'
        ];
        
        const rows = products.map(product => {
            const unitPrice = product.variantPrice || product.basePrice || 0;
            const quantityPerEmployee = product.employeeCount > 0 ? (product.totalQuantity / product.employeeCount) : 0;
            const totalPrice = product.totalQuantity * unitPrice;
            
            return [
                `"${product.productName}"`,
                `"${product.variantName}"`,
                product.reference,
                unitPrice.toFixed(2),
                quantityPerEmployee.toFixed(2),
                product.totalQuantity,
                product.employeeCount,
                `"${Array.from(product.employeeNames).join(', ')}"`,
                totalPrice.toFixed(2)
            ];
        });

        // Calculate totals
        let totalQuantity = 0;
        let totalPrice = 0;
        const allEmployeeNames = new Set();
        
        products.forEach(product => {
            const unitPrice = product.variantPrice || product.basePrice || 0;
            totalQuantity += product.totalQuantity;
            totalPrice += product.totalQuantity * unitPrice;
            
            // Add all employee names to the set
            product.employeeNames.forEach(name => allEmployeeNames.add(name));
        });

        // Add summary row
        const summaryRow = [
            '', '', '', '', '',
            `Total Quantity: ${totalQuantity}`,
            `Measured Employees: ${allEmployeeNames.size}`,
            '',
            `Grand Total: ${totalPrice.toFixed(2)}`
        ];

        // Add metadata header
        const metadata = [
            `Organization: ${customer.name}`,
            `Export Date: ${new Date().toLocaleDateString()}`,
            `Total Measured Employees: ${allEmployeeNames.size}`,
            `Total Product Variants: ${products.length}`,
            `Total Estimated Cost: ${totalPrice.toFixed(2)}`,
            ''
        ];

        const csvContent = [
            '\uFEFF', // BOM for UTF-8
            ...metadata,
            headers.join(','),
            ...rows.map(row => row.join(',')),
            summaryRow.join(',')
        ].join('\n');

        // 8. Send response
        const filename = `Product_Pricing_${customer.name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csvContent);

        console.log(`Successfully exported product pricing for ${allEmployeeNames.size} measured employees`);

    } catch (error) {
        console.error('Export error:', error);
        res.status(500).json({
            success: false,
            message: 'Export failed',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Updated PO conversion route - FIXED VERSION
// Updated PO conversion route - FIXED VERSION with correct variant structure
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

        // Get measurement with populated products
        const measurement = await Measurement.findById(measurementId)
            .populate({
                path: 'employeeMeasurements.products.productId',
                select: '_id name reference baseSalesPrice attributes variants'
            })
            .lean();

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
            emp.products.forEach(product => {
                totalMeasurementFields += product.measurements.length;
                completedMeasurementFields += product.measurements.filter(m =>
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

        console.log(`Found ${measurement.employeeMeasurements.length} employees with measurements`);

        // STEP 1: Get all measured employees from EmployeeMpc
        const measuredEmployeeIds = measurement.employeeMeasurements.map(emp => 
            emp.employeeId.toString()
        );

        const measuredEmployees = await EmployeeMpc.find({
            _id: { $in: measuredEmployeeIds },
            status: 'active'
        })
        .select('_id name products')
        .populate({
            path: 'products.productId',
            select: 'name reference baseSalesPrice variants'
        })
        .lean();

        console.log(`Fetched ${measuredEmployees.length} measured employees from EmployeeMpc`);

        // Create employee map for quick lookup
        const employeeProductMap = new Map();
        measuredEmployees.forEach(emp => {
            employeeProductMap.set(emp._id.toString(), {
                name: emp.name,
                products: emp.products || []
            });
        });

        // STEP 2: Group products by productId + variantId from EmployeeMpc data
        const productMap = new Map();

        measurement.employeeMeasurements.forEach(emp => {
            const employeeData = employeeProductMap.get(emp.employeeId.toString());
            if (!employeeData) {
                console.warn(`Employee ${emp.employeeId} not found in EmployeeMpc`);
                return;
            }

            // For each product in measurement, find matching product assignment in EmployeeMpc
            emp.products.forEach(measuredProduct => {
                // Find the matching product assignment from EmployeeMpc
                const productAssignment = employeeData.products.find(pa => {
                    const paProductId = pa.productId?._id?.toString();
                    const mpProductId = measuredProduct.productId?._id?.toString();
                    
                    // Match productId
                    if (paProductId !== mpProductId) return false;
                    
                    // Match variantId if both exist
                    if (pa.variantId && measuredProduct.variantId) {
                        return pa.variantId.toString() === measuredProduct.variantId.toString();
                    }
                    
                    // If one has variantId and other doesn't, don't match
                    if ((pa.variantId && !measuredProduct.variantId) || 
                        (!pa.variantId && measuredProduct.variantId)) {
                        return false;
                    }
                    
                    // Match if both don't have variantId
                    return true;
                });

                if (!productAssignment) {
                    console.warn(`Product assignment not found for ${measuredProduct.productName} for employee ${employeeData.name}`);
                    return;
                }

                // Get the actual product details from populated data
                const stockItem = productAssignment.productId;
                if (!stockItem || !stockItem._id) {
                    console.warn(`Product data not found for assignment`);
                    return;
                }

                const productId = stockItem._id.toString();
                const variantId = productAssignment.variantId ? productAssignment.variantId.toString() : 'default';
                const productKey = `${productId}_${variantId}`;
                const quantity = productAssignment.quantity || 1;

                if (!productMap.has(productKey)) {
                    // Get variant name and attributes if exists
                    let variantName = "Default";
                    let variantAttributes = [];
                    
                    if (productAssignment.variantId && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === productAssignment.variantId.toString()
                        );
                        if (variant) {
                            // Set variant name
                            if (variant.attributes && variant.attributes.length > 0) {
                                variantName = variant.attributes.map(a => a.value).join(" • ");
                            } else if (variant.name) {
                                variantName = variant.name;
                            }
                            
                            // Extract attributes for the variant
                            if (variant.attributes) {
                                variantAttributes = variant.attributes.map(attr => ({
                                    name: attr.name || "Attribute",
                                    value: attr.value || ""
                                }));
                            }
                        }
                    }

                    // Get variant price if exists
                    let variantPrice = stockItem.baseSalesPrice || 0;
                    if (productAssignment.variantId && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === productAssignment.variantId.toString()
                        );
                        if (variant && variant.salesPrice) {
                            variantPrice = variant.salesPrice;
                        }
                    }

                    productMap.set(productKey, {
                        stockItemId: stockItem._id,
                        stockItemName: stockItem.name,
                        stockItemReference: stockItem.reference || '',
                        variantId: productAssignment.variantId || null,
                        variantName: variantName,
                        variantAttributes: variantAttributes,
                        unitPrice: variantPrice,
                        employeeCount: 0,
                        totalQuantity: 0,
                        employeeNames: []
                    });
                }

                const productData = productMap.get(productKey);
                productData.employeeCount += 1;
                productData.totalQuantity += quantity;
                productData.employeeNames.push(employeeData.name);
            });
        });

        // Convert map to array
        const products = Array.from(productMap.values());
        
        if (products.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid products found for PO creation'
            });
        }

        console.log(`Found ${products.length} unique product-variant combinations for PO`);

        // STEP 3: Create validated items for CustomerRequest - FIXED STRUCTURE
        const validatedItems = products.map(product => {
            const totalPrice = product.totalQuantity * product.unitPrice;

            // Create variant object according to requestItemVariantSchema
            const variant = {
                // variantId should be a string. Use the actual variantId if exists, or generate one
                variantId: product.variantId ? product.variantId.toString() : `VAR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                // attributes should be an array of objects with name and value
                attributes: product.variantAttributes.length > 0 
                    ? product.variantAttributes 
                    : (product.variantName !== "Default" 
                        ? [{ name: "Variant", value: product.variantName }] 
                        : []),
                quantity: product.totalQuantity,
                specialInstructions: [],
                estimatedPrice: totalPrice
            };

            return {
                stockItemId: product.stockItemId,
                stockItemName: product.stockItemName,
                stockItemReference: product.stockItemReference,
                variants: [variant], // Array with one variant object
                totalQuantity: product.totalQuantity,
                totalEstimatedPrice: totalPrice,
                // Additional fields you might want to include
                employeeCount: product.employeeCount,
                employeeNames: product.employeeNames.join(', ')
            };
        });

        // Log items for debugging
        console.log('PO Items to be created:');
        validatedItems.forEach(item => {
            const variant = item.variants[0];
            console.log(`  ${item.stockItemName}, Variant: ${variant.variantId}, Quantity: ${item.totalQuantity}, Price: ${item.totalEstimatedPrice}`);
            console.log(`  Attributes: ${JSON.stringify(variant.attributes)}`);
        });

        // STEP 4: Create CustomerRequest
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

        // Update measurement
        await Measurement.findByIdAndUpdate(measurementId, {
            convertedToPO: true,
            poRequestId: newRequest._id,
            poConversionDate: new Date(),
            convertedBy: req.user && req.user.id ? req.user.id : null,
            completionRate: 100,
            measuredEmployees: measurement.registeredEmployeeIds?.length || 0,
            pendingEmployees: 0
        });

        res.status(201).json({
            success: true,
            message: 'Measurement successfully converted to Purchase Order',
            poRequestId: newRequest._id,
            totalEstimatedPrice: validatedItems.reduce((sum, item) => sum + item.totalEstimatedPrice, 0),
            totalItems: validatedItems.length,
            items: validatedItems.map(item => ({
                name: item.stockItemName,
                variantId: item.variants[0].variantId,
                attributes: item.variants[0].attributes,
                quantity: item.totalQuantity,
                price: item.totalEstimatedPrice
            }))
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



// GET /api/customer/employees - MODIFIED
router.get('/', async (req, res) => {
    try {
        const employees = await EmployeeMpc.find({})
            .select('_id name uin gender status products customerId createdAt')
            .populate({
                path: 'products.productId',
                select: '_id name reference' // ADD THIS: populate product name
            })
            .sort({ createdAt: -1 })
            .lean();

        // Process the employees to ensure productName is available
        const processedEmployees = employees.map(employee => {
            if (employee.products && employee.products.length > 0) {
                const processedProducts = employee.products.map(product => {
                    // Get product name from populated productId
                    let productName = "Unknown Product";
                    if (product.productId && typeof product.productId === 'object') {
                        productName = product.productId.name || "Unknown Product";
                    }
                    
                    return {
                        ...product,
                        productName: productName, // Ensure productName is set
                        variantName: product.variantName || "Default",
                        quantity: product.quantity || 1
                    };
                });

                return {
                    ...employee,
                    products: processedProducts
                };
            }
            return employee;
        });

        res.status(200).json({
            success: true,
            employees: processedEmployees
        });

    } catch (error) {
        console.error('Error fetching employees:', error);
        res.status(500).json({
            success: false,
            message: 'Server error while fetching employees'
        });
    }
});

// GET single measurement
// GET single measurement - MODIFIED
router.get('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;

        if (!measurementId || !mongoose.Types.ObjectId.isValid(measurementId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid measurement ID is required'
            });
        }

        const measurement = await Measurement.findById(measurementId)
            .select('organizationId organizationName name description registeredEmployeeIds employeeMeasurements totalRegisteredEmployees measuredEmployees pendingEmployees completionRate totalMeasurements completedMeasurements pendingMeasurements convertedToPO poRequestId poConversionDate convertedBy createdBy updatedBy createdAt updatedAt')
            .populate({
                path: 'employeeMeasurements.products.productId',
                select: 'name reference measurements' // CHANGED: Added 'name' here
            })
            .populate('convertedBy', 'name email')
            .lean();

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // IMPORTANT: Ensure productName is set for each product
        measurement.employeeMeasurements.forEach(emp => {
            emp.products.forEach(product => {
                // If productId is populated, use its name
                if (product.productId && product.productId.name) {
                    product.productName = product.productId.name;
                }
                // If productName doesn't exist, try to fetch it
                if (!product.productName && product.productId) {
                    // This is a fallback - ideally the populate above should handle it
                    product.productName = product.productId.name || 'Unknown Product';
                }
            });
        });

        // Calculate employee statistics
        const totalEmployees = await EmployeeMpc.countDocuments({
            customerId: measurement.organizationId,
            status: 'active'
        });

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
            emp.products.forEach(product => {
                totalMeasurementFields += product.measurements.length;
                completedMeasurementFields += product.measurements.filter(m =>
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
                }
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

// UPDATE measurement
router.put('/:measurementId', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { name, description, measurementData, registeredEmployeeIds } = req.body;

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

            // Update employee measurements
            measurement.employeeMeasurements = measurement.employeeMeasurements.map(emp => {
                const employeeId = emp.employeeId.toString();

                // Get remarks from incoming data if available
                const incomingEmployeeData = incomingEmployeeDataMap.get(employeeId);
                const employeeRemarks = incomingEmployeeData ? incomingEmployeeData.remarks : emp.remarks;

                // Update products for this employee
                const updatedProducts = emp.products.map(product => {
                    // Find matching product update
                    const matchingUpdate = measurementData.find(data =>
                        data.employeeId.toString() === employeeId &&
                        data.productId.toString() === product.productId.toString() &&
                        (
                            (!data.variantId && !product.variantId) ||
                            (data.variantId && product.variantId && 
                             data.variantId.toString() === product.variantId.toString())
                        )
                    );

                    if (matchingUpdate) {
                        // Convert measurements
                        const measurementsArray = [];
                        if (matchingUpdate.measurements && Array.isArray(matchingUpdate.measurements)) {
                            measurementsArray.push(...matchingUpdate.measurements);
                        } else if (matchingUpdate.measurements && typeof matchingUpdate.measurements === 'object') {
                            Object.entries(matchingUpdate.measurements).forEach(([measurementName, value]) => {
                                measurementsArray.push({
                                    measurementName,
                                    value: value || '',
                                    unit: ''
                                });
                            });
                        }

                        return {
                            ...product,
                            measurements: measurementsArray,
                            measuredAt: new Date()
                        };
                    }

                    return product;
                });

                // Calculate completion for this employee
                const isCompleted = updatedProducts.length > 0 &&
                    updatedProducts.every(product =>
                        product.measurements && Array.isArray(product.measurements) &&
                        product.measurements.length > 0 &&
                        product.measurements.every(m =>
                            m && m.value && typeof m.value === 'string' && m.value.trim() !== ''
                        )
                    );

                return {
                    ...emp,
                    products: updatedProducts,
                    remarks: employeeRemarks,
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
            emp.products.forEach(product => {
                totalMeasurements += product.measurements.length;
                completedMeasurements += product.measurements.filter(m =>
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

// ADD NEW EMPLOYEES to existing measurement
router.put('/:measurementId/add-employees', async (req, res) => {
    try {
        const { measurementId } = req.params;
        const { measurementData, newEmployeeIds, updatedRegisteredEmployeeIds } = req.body;

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

            for (const data of measurementData) {
                if (!data.employeeId || !data.productId) {
                    console.log('Skipping invalid data:', data);
                    continue;
                }

                const employeeId = data.employeeId.toString();

                // Get employee details
                const employee = await EmployeeMpc.findById(employeeId)
                    .select('name uin gender')
                    .lean();

                if (!employee) {
                    console.warn(`Employee ${employeeId} not found`);
                    continue;
                }

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

                // Get product details
                const product = await StockItem.findById(data.productId)
                    .select('name reference')
                    .lean();

                if (!product) {
                    console.warn(`Product ${data.productId} not found`);
                    continue;
                }

                // Get variant name if exists
                let variantName = "Default";
                if (data.variantId) {
                    const productWithVariants = await StockItem.findById(data.productId)
                        .select('variants')
                        .lean();
                    
                    if (productWithVariants.variants) {
                        const variant = productWithVariants.variants.find(v => 
                            v._id.toString() === data.variantId.toString()
                        );
                        if (variant && variant.attributes) {
                            variantName = variant.attributes.map(a => a.value).join(" • ") || "Default";
                        }
                    }
                }

                if (!newEmployeesMap.has(employeeId)) {
                    newEmployeesMap.set(employeeId, {
                        employeeId: data.employeeId,
                        employeeName: employee.name,
                        employeeUIN: employee.uin,
                        gender: employee.gender,
                        remarks: data.remarks || "",
                        products: []
                    });
                }

                const employeeData = newEmployeesMap.get(employeeId);

                employeeData.products.push({
                    productId: data.productId,
                    productName: product.name,
                    variantId: data.variantId || null,
                    variantName: variantName,
                    quantity: data.quantity || 1,
                    measurements: measurementsArray,
                    measuredAt: new Date()
                });
            }

            // Add new employees to the measurement
            newEmployeesMap.forEach((newEmployeeData, employeeId) => {
                if (!existingEmployeeMap.has(employeeId)) {
                    const isCompleted = newEmployeeData.products.length > 0 &&
                        newEmployeeData.products.every(product =>
                            product.measurements.length > 0 &&
                            product.measurements.every(m => m.value && m.value.trim() !== '')
                        );

                    measurement.employeeMeasurements.push({
                        employeeId: newEmployeeData.employeeId,
                        employeeName: newEmployeeData.employeeName,
                        employeeUIN: newEmployeeData.employeeUIN,
                        gender: newEmployeeData.gender,
                        remarks: newEmployeeData.remarks || "",
                        products: newEmployeeData.products,
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
            return res.status(404).json({
                success: false,
                message: 'Measurement already converted to PO'
            });
        }

        // Check if measurement is complete
        let totalMeasurementFields = 0;
        let completedMeasurementFields = 0;

        measurement.employeeMeasurements.forEach(emp => {
            emp.products.forEach(product => {
                totalMeasurementFields += product.measurements.length;
                completedMeasurementFields += product.measurements.filter(m =>
                    m.value && m.value.trim() !== ""
                ).length;
            });
        });

        const completionRate = totalMeasurementFields > 0
            ? Math.round((completedMeasurementFields / totalMeasurementFields) * 100)
            : 0;

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

        console.log(`Converting measurement to PO for customer: ${customer.name}`);

        // STEP 1: Get measured employee IDs
        const measuredEmployeeIds = measurement.employeeMeasurements.map(emp => 
            emp.employeeId.toString()
        );

        console.log(`Measured employee IDs: ${measuredEmployeeIds.join(', ')}`);

        // STEP 2: Get product assignments from EmployeeMpc for measured employees
        const measuredEmployees = await EmployeeMpc.find({
            _id: { $in: measuredEmployeeIds },
            status: 'active'
        })
        .select('_id name products')
        .populate({
            path: 'products.productId',
            select: 'name reference baseSalesPrice variants'
        })
        .lean();

        if (measuredEmployees.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No product assignments found for measured employees'
            });
        }

        console.log(`Found ${measuredEmployees.length} measured employees with product assignments`);

        // STEP 3: Group product assignments by productId + variantId
        const productMap = new Map(); // Key: productId_variantId
        
        measuredEmployees.forEach(employee => {
            if (!employee.products || employee.products.length === 0) return;
            
            employee.products.forEach(productAssignment => {
                if (!productAssignment.productId) return;
                
                const productId = productAssignment.productId._id.toString();
                const variantId = productAssignment.variantId ? productAssignment.variantId.toString() : 'no-variant';
                const productKey = `${productId}_${variantId}`;
                const quantity = productAssignment.quantity || 1;
                
                const stockItem = productAssignment.productId;
                
                if (!productMap.has(productKey)) {
                    // Get variant name if exists
                    let variantName = "Default";
                    if (productAssignment.variantId && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === productAssignment.variantId.toString()
                        );
                        if (variant && variant.attributes) {
                            variantName = variant.attributes.map(a => a.value).join(" • ") || "Default";
                        }
                    }
                    
                    productMap.set(productKey, {
                        stockItemId: productId,
                        stockItemName: stockItem.name,
                        stockItemReference: stockItem.reference || '',
                        variantId: variantId !== 'no-variant' ? variantId : null,
                        variantName: variantName,
                        basePrice: stockItem.baseSalesPrice || 0,
                        variantPrice: null,
                        totalQuantity: 0,
                        employeeCount: 0,
                        employeeNames: []
                    });
                }
                
                const productData = productMap.get(productKey);
                productData.totalQuantity += quantity;
                productData.employeeCount += 1;
                productData.employeeNames.push(employee.name);
            });
        });

        const products = Array.from(productMap.values());
        
        if (products.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No valid products found for PO creation'
            });
        }

        console.log(`Found ${products.length} unique product-variant combinations`);

        // STEP 4: Get variant prices
        for (const product of products) {
            if (product.variantId) {
                try {
                    const stockItem = await StockItem.findById(product.stockItemId)
                        .select('variants')
                        .lean();
                    
                    if (stockItem && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === product.variantId
                        );
                        if (variant && variant.salesPrice) {
                            product.variantPrice = variant.salesPrice;
                            console.log(`Variant price for ${product.stockItemName}: ${variant.salesPrice}`);
                        }
                    }
                } catch (err) {
                    console.error(`Error fetching variant price for product ${product.stockItemId}:`, err);
                }
            }
        }

        // STEP 5: Create items for CustomerRequest
        const items = products.map(product => {
            const unitPrice = product.variantPrice || product.basePrice || 0;
            const totalEstimatedPrice = product.totalQuantity * unitPrice;
            
            // Get variant attributes if available
            let variantAttributes = [];
            if (product.variantId) {
                try {
                    const stockItem = StockItem.findById(product.stockItemId)
                        .select('variants')
                        .lean();
                    
                    if (stockItem && stockItem.variants) {
                        const variant = stockItem.variants.find(v => 
                            v._id.toString() === product.variantId
                        );
                        if (variant && variant.attributes) {
                            variantAttributes = variant.attributes.map(attr => ({
                                name: attr.name,
                                value: attr.value || ""
                            }));
                        }
                    }
                } catch (err) {
                    console.error(`Error fetching variant attributes:`, err);
                }
            }

            const variant = {
                variantId: product.variantId,
                variantName: product.variantName,
                attributes: variantAttributes,
                quantity: product.totalQuantity,
                specialInstructions: [],
                estimatedPrice: totalEstimatedPrice
            };

            return {
                stockItemId: product.stockItemId,
                stockItemName: product.stockItemName,
                stockItemReference: product.stockItemReference,
                variants: [variant],
                totalQuantity: product.totalQuantity,
                totalEstimatedPrice: totalEstimatedPrice,
                employeeCount: product.employeeCount,
                employeeNames: product.employeeNames
            };
        });

        // STEP 6: Create CustomerRequest
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
            items: items,
            status: 'pending',
            priority: 'high',
            measurementId: measurement._id,
            measurementName: measurement.name,
            requestType: 'measurement_conversion',
            createdAt: new Date()
        });

        await newRequest.save();

        console.log(`Created PO request: ${requestId}`);

        // Populate request
        const populatedRequest = await CustomerRequest.findById(newRequest._id)
            .populate({
                path: 'items.stockItemId',
                select: 'name reference category images'
            });

        // Send email (optional)
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
                console.log('Confirmation email sent');
            }
        } catch (emailError) {
            console.error('Request email sending failed:', emailError);
        }

        // STEP 7: Update measurement
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

        console.log(`Measurement ${measurementId} successfully converted to PO`);

        res.status(201).json({
            success: true,
            message: 'Measurement successfully converted to Purchase Order.',
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


// GET organization measurements
// GET organization measurements - MODIFIED
router.get('/organization/:orgId/measurements', async (req, res) => {
    try {
        const { orgId } = req.params;

        if (!orgId || !mongoose.Types.ObjectId.isValid(orgId)) {
            return res.status(400).json({
                success: false,
                message: 'Valid organization ID is required'
            });
        }

        const measurements = await Measurement.find({
            organizationId: new mongoose.Types.ObjectId(orgId)
        })
            .select('name description totalRegisteredEmployees measuredEmployees pendingEmployees completionRate totalMeasurements completedMeasurements pendingMeasurements createdAt updatedAt convertedToPO poRequestId employeeMeasurements registeredEmployeeIds') // ADD employeeMeasurements and registeredEmployeeIds
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

// Export measurement to CSV
router.get('/:measurementId/export', async (req, res) => {
    try {
        const { measurementId } = req.params;

        const measurement = await Measurement.findById(measurementId)
            .populate({
                path: 'employeeMeasurements.products.productId',
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
            emp.products.forEach(product => {
                product.measurements.forEach(m => {
                    allMeasurements.add(m.measurementName);
                });
            });
        });

        const measurementNames = Array.from(allMeasurements);

        // Create CSV headers
        const headers = [
            'Employee Name',
            'UIN',
            'Gender',
            'Remarks',
            'Product',
            'Variant',
            'Quantity'
        ].concat(measurementNames.map(name => `${name}`));

        // Create CSV rows
        const rows = measurement.employeeMeasurements.flatMap(emp =>
            emp.products.map(product => {
                const baseData = [
                    `"${emp.employeeName}"`,
                    emp.employeeUIN,
                    emp.gender,
                    `"${emp.remarks || ''}"`,
                    `"${product.productName}"`,
                    product.variantName !== "Default" ? `"${product.variantName}"` : 'Default',
                    product.quantity || 1
                ];

                // Add measurement values
                const measurementValues = measurementNames.map(name => {
                    const measurement = product.measurements.find(m => m.measurementName === name);
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

// Export grouped by product
router.get('/:measurementId/export-grouped', async (req, res) => {
    try {
        const { measurementId } = req.params;

        const measurement = await Measurement.findById(measurementId)
            .populate({
                path: 'employeeMeasurements.products.productId',
                select: 'name reference'
            })
            .lean();

        if (!measurement) {
            return res.status(404).json({
                success: false,
                message: 'Measurement not found'
            });
        }

        // Group measurements by product
        const productMap = new Map();

        measurement.employeeMeasurements.forEach(emp => {
            emp.products.forEach(product => {
                const key = product.productId?._id?.toString() || product.productName;
                if (!productMap.has(key)) {
                    productMap.set(key, {
                        productName: product.productName,
                        variantName: product.variantName,
                        reference: product.productId?.reference || '',
                        employees: [],
                        measurements: product.measurements.map(m => ({
                            name: m.measurementName,
                            unit: m.unit || ''
                        }))
                    });
                }

                const productData = productMap.get(key);

                // Create employee measurement object
                const empMeasurement = {
                    employeeName: emp.employeeName,
                    employeeUIN: emp.employeeUIN,
                    gender: emp.gender,
                    remarks: emp.remarks || '',
                    quantity: product.quantity || 1,
                    measurements: {}
                };

                // Map measurements to object for easy access
                product.measurements.forEach(m => {
                    empMeasurement.measurements[m.measurementName] = m.value || '';
                });

                productData.employees.push(empMeasurement);
            });
        });

        // Create CSV content grouped by product
        let csvContent = '\uFEFF'; // BOM for UTF-8

        productMap.forEach((productData, productId) => {
            csvContent += `Product: "${productData.productName}"`;
            if (productData.variantName !== "Default") {
                csvContent += ` (Variant: ${productData.variantName})`;
            }
            if (productData.reference) {
                csvContent += ` [Ref: ${productData.reference}]`;
            }
            csvContent += '\n\n';

            // Headers
            const headers = ['Employee Name', 'UIN', 'Gender', 'Quantity', 'Remarks'];
            productData.measurements.forEach(m => {
                headers.push(`${m.name}${m.unit ? ` (${m.unit})` : ''}`);
            });
            csvContent += headers.join(',') + '\n';

            // Rows
            productData.employees.forEach(emp => {
                const row = [
                    `"${emp.employeeName}"`,
                    emp.employeeUIN,
                    emp.gender,
                    emp.quantity,
                    `"${emp.remarks}"`,
                    ...productData.measurements.map(m => emp.measurements[m.name] || '')
                ];
                csvContent += row.join(',') + '\n';
            });

            csvContent += '\n\n';
        });

        // Add summary
        csvContent += '=== SUMMARY ===\n';
        csvContent += `Total Employees: ${measurement.employeeMeasurements.length}\n`;
        csvContent += `Total Products: ${productMap.size}\n`;
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

module.exports = router;