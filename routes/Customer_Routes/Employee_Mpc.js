const express = require('express');
const router = express.Router();
const EmployeeMpc = require('../../models/Customer_Models/Employee_Mpc');
const OrganizationDepartment = require('../../models/CMS_Models/Configuration/OrganizationDepartment');
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
    const { search = '', department = '', status = '' } = req.query;

    let filter = { customerId: req.customerId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { uin: { $regex: search, $options: 'i' } },
        { department: { $regex: search, $options: 'i' } },
        { designation: { $regex: search, $options: 'i' } }
      ];
    }

    if (department) {
      filter.department = department;
    }

    if (status) {
      filter.status = status;
    }

    const employees = await EmployeeMpc.find(filter)
      .select('-__v')
      .sort({ createdAt: -1 })
      .lean();

    // Get department stats
    const departments = await EmployeeMpc.distinct('department', { customerId: req.customerId });
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
        inactive: inactiveCount,
        departments: departments.filter(d => d) // Remove null/undefined
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

// GET departments for the customer
router.get('/departments', verifyCustomerToken, async (req, res) => {
  try {
    // Get organization departments for this customer
    const orgDept = await OrganizationDepartment.findOne({
      customerId: req.customerId,
      status: 'active'
    }).lean();

    let departments = [];

    if (orgDept && orgDept.departments) {
      departments = orgDept.departments
        .filter(dept => dept.status === 'active')
        .map(dept => dept.name);
    }

    // Also include departments that already have employees (in case they were removed from org dept)
    const employeeDepartments = await EmployeeMpc.distinct('department', {
      customerId: req.customerId
    });

    // Merge and deduplicate
    const allDepartments = [...new Set([...departments, ...employeeDepartments])].filter(d => d);

    res.status(200).json({
      success: true,
      departments: allDepartments
    });

  } catch (error) {
    console.error('Error fetching departments:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching departments'
    });
  }
});

// GET designations for a specific department
router.get('/departments/:department/designations', verifyCustomerToken, async (req, res) => {
  try {
    const { department } = req.params;

    // Get organization departments for this customer
    const orgDept = await OrganizationDepartment.findOne({
      customerId: req.customerId,
      status: 'active'
    }).lean();

    let designations = [];

    if (orgDept && orgDept.departments) {
      const dept = orgDept.departments.find(d =>
        d.name === decodeURIComponent(department) && d.status === 'active'
      );

      if (dept && dept.designations) {
        designations = dept.designations
          .filter(desig => desig.status === 'active')
          .map(desig => desig.name);
      }
    }

    // Also include designations that already have employees in this department
    const employeeDesignations = await EmployeeMpc.distinct('designation', {
      customerId: req.customerId,
      department: decodeURIComponent(department)
    });

    // Merge and deduplicate
    const allDesignations = [...new Set([...designations, ...employeeDesignations])].filter(d => d);

    res.status(200).json({
      success: true,
      designations: allDesignations
    });

  } catch (error) {
    console.error('Error fetching designations:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching designations'
    });
  }
});

// CREATE new employee
router.post('/', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, department, designation, gender, status } = req.body;

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

    if (!department) {
      return res.status(400).json({
        success: false,
        message: 'Department is required'
      });
    }

    if (!designation) {
      return res.status(400).json({
        success: false,
        message: 'Designation is required'
      });
    }


    const existingEmployee = await EmployeeMpc.findOne({ uin: uin.toUpperCase() });
    if (existingEmployee) {
      return res.status(400).json({
        success: false,
        message: 'Employee with this UIN already exists'
      });
    }


    const normalizeString = (str) => {
      if (!str) return '';
      return str.trim().split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
    };


    if (!department) {
      return res.status(400).json({
        success: false,
        message: 'Department is required'
      });
    }

    if (!designation) {
      return res.status(400).json({
        success: false,
        message: 'Designation is required'
      });
    }

    if (!gender) {
      return res.status(400).json({
        success: false,
        message: 'Gender is required'
      });
    }


    const formattedDepartment = normalizeString(department);
    const formattedDesignation = normalizeString(designation);


    const newEmployee = new EmployeeMpc({
      customerId: req.customerId,
      name: name.trim(),
      uin: uin.trim().toUpperCase(),
      department: formattedDepartment,
      designation: formattedDesignation,
      gender: gender,  // <-- Just pass the gender as-is, schema will format it
      status: status || 'active',
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
// CREATE multiple employees (batch) - UPDATED VERSION
router.post('/batch', verifyCustomerToken, async (req, res) => {
  try {
    const { employees } = req.body;

    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Employee data is required'
      });
    }

    // Get existing UINs to check for duplicates
    const existingEmployees = await EmployeeMpc.find({
      customerId: req.customerId
    }).select('uin').lean();

    const existingUins = existingEmployees.map(emp => emp.uin.toUpperCase());

    // Validate and process employees
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

      if (!emp.department) {
        validationErrors.push(`Row ${rowNumber}: Department is required`);
        continue;
      }

      if (!emp.designation) {
        validationErrors.push(`Row ${rowNumber}: Designation is required`);
        continue;
      }

      if (!emp.gender) {
        validationErrors.push(`Row ${rowNumber}: Gender is required`);
        continue;
      }

      const formattedUin = emp.uin.trim().toUpperCase();

      // Check if UIN already exists in database
      if (existingUins.includes(formattedUin)) {
        skippedEmployees.push({
          row: rowNumber,
          name: emp.name.trim(),
          uin: formattedUin,
          reason: 'UIN already exists'
        });
        continue;
      }

      // Check if UIN already exists in this batch (duplicate within the same file)
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

      // Add to create list
      employeesToCreate.push({
        customerId: req.customerId,
        name: emp.name.trim(),
        uin: formattedUin,
        department: emp.department.trim(),
        designation: emp.designation.trim(),
        gender: gender,
        status: 'active',
        createdBy: req.customerId
      });

      // Add to existing UINs list to prevent duplicates within batch
      existingUins.push(formattedUin);
    }

    // If no valid employees to create
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

    // Create employees
    let createdEmployees = [];
    try {
      createdEmployees = await EmployeeMpc.insertMany(employeesToCreate, { ordered: false });
    } catch (error) {
      // Handle individual document errors (like duplicate key errors)
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

        // Get successfully inserted documents
        createdEmployees = error.insertedDocs || [];
      }
    }

    // Return detailed response
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
      validationErrors: validationErrors.slice(0, 20), // Limit to first 20 errors
      skippedEmployees: skippedEmployees.slice(0, 20), // Limit to first 20 skipped
      note: validationErrors.length > 20 || skippedEmployees.length > 20
        ? '... and more (only showing first 20 of each)'
        : null
    });

  } catch (error) {
    console.error('Error creating batch employees:', error);

    res.status(500).json({
      success: false,
      message: 'Server error while processing employees',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// GET organization departments with stock item details
// Update the GET organization departments route to include variant images
router.get('/organization-departments', verifyCustomerToken, async (req, res) => {
  try {
    const orgDept = await OrganizationDepartment.findOne({
      customerId: req.customerId,
      status: 'active'
    })
      .populate("departments.designations.assignedStockItems.stockItemId", "name reference category images variants")
      .lean();

    if (!orgDept) {
      return res.status(404).json({
        success: false,
        message: 'Organization departments not found'
      });
    }

    // Process the organization departments to get variant images
    const processedOrgDept = {
      ...orgDept,
      departments: orgDept.departments?.map(dept => ({
        ...dept,
        designations: dept.designations?.map(designation => ({
          ...designation,
          assignedStockItems: designation.assignedStockItems?.map(item => {
            const stockItem = item.stockItemId;
            if (!stockItem) {
              return item;
            }

            let variantImages = [];
            let variantInfo = null;

            // If variantId exists, get variant-specific images
            if (item.variantId && stockItem.variants) {
              const variant = stockItem.variants.find(v =>
                v._id && v._id.toString() === item.variantId.toString()
              );

              if (variant && variant.images && variant.images.length > 0) {
                variantImages = variant.images;
                variantInfo = {
                  variantId: variant._id,
                  variantName: variant.attributes?.map(a => a.value).join(" • ") || "Default",
                  sku: variant.sku
                };
              } else if (stockItem.images && stockItem.images.length > 0) {
                // Fallback to stock item images if variant has no images
                variantImages = stockItem.images;
                variantInfo = {
                  variantId: item.variantId,
                  variantName: item.variantName || "Default",
                  note: "Using stock item images"
                };
              }
            } else if (stockItem.images && stockItem.images.length > 0) {
              // No variant selected, use stock item images
              variantImages = stockItem.images;
              variantInfo = {
                variantName: "Default",
                note: "No variant selected"
              };
            }

            return {
              ...item,
              stockItemId: stockItem._id,
              stockItemName: stockItem.name,
              stockItemImages: stockItem.images || [],
              variantImages: variantImages,
              variantInfo: variantInfo
            };
          })
        }))
      }))
    };

    res.status(200).json({
      success: true,
      organizationDepartment: processedOrgDept
    });

  } catch (error) {
    console.error('Error fetching organization departments:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching organization departments'
    });
  }
});

// GET stock items details for multiple IDs
router.post('/stock-items/details', verifyCustomerToken, async (req, res) => {
  try {
    const { stockItemIds } = req.body;

    if (!stockItemIds || !Array.isArray(stockItemIds)) {
      return res.status(400).json({
        success: false,
        message: 'Stock item IDs are required'
      });
    }

    const stockItems = await StockItem.find({
      _id: { $in: stockItemIds }
    })
      .select('name reference images')
      .lean();

    res.status(200).json({
      success: true,
      stockItems
    });

  } catch (error) {
    console.error('Error fetching stock items details:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching stock items details'
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


router.put('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, department, designation, gender, status } = req.body;


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
        _id: { $ne: req.params.id }
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
    if (department !== undefined) employee.department = department.trim();
    if (designation !== undefined) employee.designation = designation.trim();
    if (gender !== undefined) {
      // Remove gender validation and just use the setter from schema
      employee.gender = gender;
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

// Add this new route to your backend API

// GET specific stock item with variants
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

    // If a specific variant ID is requested via query parameter
    const { variantId } = req.query;
    if (variantId && stockItem.variants) {
      const variant = stockItem.variants.find(v => v._id.toString() === variantId);
      if (variant) {
        // Return variant-specific images if available
        const variantData = {
          ...stockItem,
          variantImages: variant.images || stockItem.images,
          variantDetails: {
            variantId: variant._id,
            attributes: variant.attributes,
            sku: variant.sku,
            variantName: variant.attributes?.map(a => a.value).join(" • ") || "Default"
          }
        };

        return res.status(200).json({
          success: true,
          stockItem: variantData
        });
      }
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
      .select('name uin department designation gender status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    const headers = ['Name', 'UIN', 'Department', 'Designation', 'Gender', 'Status', 'Created At'];

    const csvRows = employees.map(emp => [
      `"${emp.name}"`,
      emp.uin,
      emp.department,
      emp.designation,
      emp.gender,
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