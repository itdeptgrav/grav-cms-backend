const express = require('express');
const router = express.Router();
const EmployeeMpc = require('../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');
const jwt = require('jsonwebtoken');

// Middleware to verify customer token
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please sign in.'
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'grav_clothing_secret_key_2024');
    req.customerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid token. Please sign in again.'
    });
  }
};

// GET all employees for the customer
router.get('/', verifyCustomerToken, async (req, res) => {
  try {
    const { search = '', status = '' } = req.query;

    let filter = { customerId: req.customerId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { uin: { $regex: search, $options: 'i' } }
      ];
    }

    if (status) {
      filter.status = status;
    }

    const employees = await EmployeeMpc.find(filter)
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean();

    // Get status counts
    const statusCounts = await EmployeeMpc.aggregate([
      { $match: { customerId: req.customerId } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const activeCount = statusCounts.find(s => s._id === 'active')?.count || 0;
    const inactiveCount = statusCounts.find(s => s._id === 'inactive')?.count || 0;

    res.status(200).json({
      success: true,
      employees,
      stats: {
        total: employees.length,
        active: activeCount,
        inactive: inactiveCount
      }
    });

  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching employees'
    });
  }
});

// GET available products for customer
// GET available products for customer with search
router.get('/products/available', verifyCustomerToken, async (req, res) => {
  try {
    const { search = '' } = req.query;
    
    let filter = {
      status: { $in: ["In Stock", "Low Stock"] }
    };
    
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    const products = await StockItem.find(filter)
      .select('name reference category baseSalesPrice totalQuantityOnHand images variants')
      .sort({ name: 1 })
      .limit(50) // Limit results
      .lean();

    res.status(200).json({
      success: true,
      products
    });

  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching products'
    });
  }
});

// GET product variants
router.get('/products/:id/variants', verifyCustomerToken, async (req, res) => {
  try {
    const product = await StockItem.findById(req.params.id)
      .select('name reference variants')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    const variants = product.variants || [];

    res.status(200).json({
      success: true,
      productName: product.name,
      variants: variants.map(v => ({
        _id: v._id,
        sku: v.sku,
        attributes: v.attributes,
        salesPrice: v.salesPrice,
        quantityOnHand: v.quantityOnHand,
        images: v.images || []
      }))
    });

  } catch (error) {
    console.error('Error fetching product variants:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching product variants'
    });
  }
});

// CREATE single employee
router.post('/', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, gender, products } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Name is required'
      });
    }

    if (!uin || !uin.trim()) {
      return res.status(400).json({
        success: false,
        message: 'UIN is required'
      });
    }

    if (!gender) {
      return res.status(400).json({
        success: false,
        message: 'Gender is required'
      });
    }

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one product is required'
      });
    }

    // Check for existing UIN
    const existingEmployee = await EmployeeMpc.findOne({ 
      uin: uin.toUpperCase(),
      customerId: req.customerId 
    });
    
    if (existingEmployee) {
      return res.status(400).json({
        success: false,
        message: 'Employee with this UIN already exists'
      });
    }

    // Validate products
    const validProducts = [];
    for (const product of products) {
      if (!product.productId) {
        return res.status(400).json({
          success: false,
          message: 'Product ID is required'
        });
      }

      const stockItem = await StockItem.findById(product.productId);
      if (!stockItem) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${product.productId}`
        });
      }

      if (product.variantId) {
        const variant = stockItem.variants.find(v => v._id.toString() === product.variantId);
        if (!variant) {
          return res.status(400).json({
            success: false,
            message: `Variant not found: ${product.variantId}`
          });
        }
      }

      validProducts.push({
        productId: product.productId,
        variantId: product.variantId || null,
        quantity: product.quantity || 1
      });
    }

    const newEmployee = new EmployeeMpc({
      customerId: req.customerId,
      name: name.trim(),
      uin: uin.trim().toUpperCase(),
      gender: gender,
      products: validProducts,
      status: 'active',
      createdBy: req.customerId
    });

    await newEmployee.save();

    res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      employee: newEmployee
    });

  } catch (error) {
    console.error('Error creating employee:', error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Employee with this UIN already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while creating employee'
    });
  }
});

// CREATE multiple employees (batch)
router.post('/batch', verifyCustomerToken, async (req, res) => {
  try {
    const { employees } = req.body;

    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Employee data is required'
      });
    }

    const existingEmployees = await EmployeeMpc.find({
      customerId: req.customerId
    }).select('uin').lean();

    const existingUins = existingEmployees.map(emp => emp.uin.toUpperCase());

    const validationErrors = [];
    const employeesToCreate = [];
    const skippedEmployees = [];

    for (const [index, emp] of employees.entries()) {
      const rowNumber = index + 1;

      // Validate required fields
      if (!emp.name || !emp.name.trim()) {
        validationErrors.push(`Row ${rowNumber}: Name is required`);
        continue;
      }

      if (!emp.uin || !emp.uin.trim()) {
        validationErrors.push(`Row ${rowNumber}: UIN is required`);
        continue;
      }

      if (!emp.gender) {
        validationErrors.push(`Row ${rowNumber}: Gender is required`);
        continue;
      }

      if (!emp.products || !Array.isArray(emp.products) || emp.products.length === 0) {
        validationErrors.push(`Row ${rowNumber}: At least one product is required`);
        continue;
      }

      const formattedUin = emp.uin.trim().toUpperCase();

      // Check for duplicates
      if (existingUins.includes(formattedUin)) {
        skippedEmployees.push({
          row: rowNumber,
          name: emp.name.trim(),
          uin: formattedUin,
          reason: 'UIN already exists'
        });
        continue;
      }

      const isDuplicateInBatch = employeesToCreate.some(e => e.uin === formattedUin);
      if (isDuplicateInBatch) {
        skippedEmployees.push({
          row: rowNumber,
          name: emp.name.trim(),
          uin: formattedUin,
          reason: 'Duplicate UIN in this file'
        });
        continue;
      }

      // Validate products
      const validProducts = [];
      for (const product of emp.products) {
        if (!product.productId) {
          validationErrors.push(`Row ${rowNumber}: Product ID is required`);
          continue;
        }

        const stockItem = await StockItem.findById(product.productId);
        if (!stockItem) {
          validationErrors.push(`Row ${rowNumber}: Product not found`);
          continue;
        }

        if (product.variantId) {
          const variant = stockItem.variants.find(v => v._id.toString() === product.variantId);
          if (!variant) {
            validationErrors.push(`Row ${rowNumber}: Variant not found`);
            continue;
          }
        }

        validProducts.push({
          productId: product.productId,
          variantId: product.variantId || null,
          quantity: product.quantity || 1
        });
      }

      if (validProducts.length === 0) {
        validationErrors.push(`Row ${rowNumber}: No valid products to assign`);
        continue;
      }

      employeesToCreate.push({
        customerId: req.customerId,
        name: emp.name.trim(),
        uin: formattedUin,
        gender: emp.gender,
        products: validProducts,
        status: 'active',
        createdBy: req.customerId
      });

      existingUins.push(formattedUin);
    }

    if (employeesToCreate.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid employees to create',
        errors: validationErrors,
        skipped: skippedEmployees,
        totalProcessed: employees.length,
        validCount: 0,
        errorCount: validationErrors.length,
        skippedCount: skippedEmployees.length
      });
    }

    let createdEmployees = [];
    try {
      createdEmployees = await EmployeeMpc.insertMany(employeesToCreate, { ordered: false });
    } catch (error) {
      if (error.writeErrors && error.writeErrors.length > 0) {
        error.writeErrors.forEach(writeError => {
          if (writeError.code === 11000) {
            const failedUin = writeError.err.op.uin;
            const failedRow = employees.findIndex(e => e.uin.toUpperCase() === failedUin) + 1;
            skippedEmployees.push({
              row: failedRow,
              uin: failedUin,
              reason: 'Duplicate UIN (database constraint)'
            });
          }
        });
        createdEmployees = error.insertedDocs || [];
      }
    }

    res.status(201).json({
      success: true,
      message: `Processed ${employees.length} employees`,
      summary: {
        totalProcessed: employees.length,
        created: createdEmployees.length,
        skipped: skippedEmployees.length,
        validationErrors: validationErrors.length
      },
      createdCount: createdEmployees.length,
      validationErrors: validationErrors.slice(0, 20),
      skippedEmployees: skippedEmployees.slice(0, 20),
      note: validationErrors.length > 20 || skippedEmployees.length > 20
        ? '... and more (only showing first 20 of each)'
        : null
    });

  } catch (error) {
    console.error('Error creating batch employees:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while processing employees'
    });
  }
});

// GET single employee
router.get('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const employee = await EmployeeMpc.findOne({
      _id: req.params.id,
      customerId: req.customerId
    }).lean();

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    res.status(200).json({
      success: true,
      employee
    });

  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching employee'
    });
  }
});

// UPDATE employee
router.put('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, gender, products, status } = req.body;

    let employee = await EmployeeMpc.findOne({
      _id: req.params.id,
      customerId: req.customerId
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    if (uin && uin !== employee.uin) {
      const existingEmployee = await EmployeeMpc.findOne({
        uin: uin.toUpperCase(),
        _id: { $ne: req.params.id },
        customerId: req.customerId
      });

      if (existingEmployee) {
        return res.status(400).json({
          success: false,
          message: 'Another employee with this UIN already exists'
        });
      }
    }

    if (name !== undefined) employee.name = name.trim();
    if (uin !== undefined) employee.uin = uin.trim().toUpperCase();
    if (gender !== undefined) employee.gender = gender;
    
    if (products !== undefined) {
      if (!Array.isArray(products) || products.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'At least one product is required'
        });
      }

      const validProducts = [];
      for (const product of products) {
        if (!product.productId) {
          return res.status(400).json({
            success: false,
            message: 'Product ID is required'
          });
        }

        const stockItem = await StockItem.findById(product.productId);
        if (!stockItem) {
          return res.status(400).json({
            success: false,
            message: `Product not found: ${product.productId}`
          });
        }

        if (product.variantId) {
          const variant = stockItem.variants.find(v => v._id.toString() === product.variantId);
          if (!variant) {
            return res.status(400).json({
              success: false,
              message: `Variant not found: ${product.variantId}`
            });
          }
        }

        validProducts.push({
          productId: product.productId,
          variantId: product.variantId || null,
          quantity: product.quantity || 1
        });
      }

      employee.products = validProducts;
    }
    
    if (status !== undefined) employee.status = status;
    employee.updatedBy = req.customerId;

    await employee.save();

    res.status(200).json({
      success: true,
      message: 'Employee updated successfully',
      employee
    });

  } catch (error) {
    console.error('Error updating employee:', error);

    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        error: error.message
      });
    }

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Employee with this UIN already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Server error while updating employee'
    });
  }
});

// DELETE employee
router.delete('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const employee = await EmployeeMpc.findOneAndDelete({
      _id: req.params.id,
      customerId: req.customerId
    });

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Employee deleted successfully'
    });

  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while deleting employee'
    });
  }
});

// UPDATE employee status
router.patch('/:id/status', verifyCustomerToken, async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Valid status is required'
      });
    }

    const employee = await EmployeeMpc.findOneAndUpdate(
      {
        _id: req.params.id,
        customerId: req.customerId
      },
      {
        status,
        updatedBy: req.customerId
      },
      { new: true }
    );

    if (!employee) {
      return res.status(404).json({
        success: false,
        message: 'Employee not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Employee status updated successfully',
      employee
    });

  } catch (error) {
    console.error('Error updating employee status:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while updating employee status'
    });
  }
});

// GET stock item details
router.get('/stock-items/:id', verifyCustomerToken, async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .select('name reference images variants')
      .lean();

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: 'Stock item not found'
      });
    }

    res.status(200).json({
      success: true,
      stockItem
    });

  } catch (error) {
    console.error('Error fetching stock item:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching stock item'
    });
  }
});

// Export employees to CSV
router.get('/export/csv', verifyCustomerToken, async (req, res) => {
  try {
    const employees = await EmployeeMpc.find({ customerId: req.customerId })
      .select('name uin gender products status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    // Fetch product details for CSV
    const employeesWithProductDetails = await Promise.all(
      employees.map(async (emp) => {
        const productDetails = [];
        for (const product of emp.products) {
          const stockItem = await StockItem.findById(product.productId)
            .select('name reference')
            .lean();
          
          if (stockItem) {
            let variantInfo = '';
            if (product.variantId && stockItem.variants) {
              const variant = stockItem.variants.find(v => v._id.toString() === product.variantId);
              if (variant && variant.attributes) {
                variantInfo = variant.attributes.map(a => a.value).join(' | ');
              }
            }
            
            productDetails.push({
              name: stockItem.name,
              variant: variantInfo,
              quantity: product.quantity,
              reference: stockItem.reference
            });
          }
        }
        
        return {
          ...emp,
          productDetails: productDetails
        };
      })
    );

    const headers = ['Name', 'UIN', 'Gender', 'Products', 'Status', 'Created At'];

    const csvRows = employeesWithProductDetails.map(emp => [
      `"${emp.name}"`,
      emp.uin,
      emp.gender,
      emp.productDetails.map(p => 
        `${p.name}${p.variant ? ` (${p.variant})` : ''} x${p.quantity}`
      ).join('; '),
      emp.status,
      new Date(emp.createdAt).toISOString()
    ]);

    const csvContent = [
      headers.join(','),
      ...csvRows.map(row => row.join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=employees_${Date.now()}.csv`);
    res.send(csvContent);

  } catch (error) {
    console.error('Error exporting employees:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while exporting employees'
    });
  }
});

module.exports = router;