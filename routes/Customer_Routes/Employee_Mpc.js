// routes/customer/employees.js

const express = require('express');
const router = express.Router();
const EmployeeMpc = require('../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');
const jwt = require('jsonwebtoken');

// ─── Auth middleware ──────────────────────────────────────────────────────────
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Access denied. Please sign in.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'grav_clothing_secret_key_2024');
    req.customerId = decoded.id;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid token. Please sign in again.' });
  }
};

// ─── Helper: validate & build product array ───────────────────────────────────
async function buildValidProducts(products, rowLabel = '') {
  const validProducts = [];
  const errors = [];

  if (!products || !Array.isArray(products) || products.length === 0) {
    return { validProducts, errors };
  }

  // Batch-fetch all stock items at once to avoid N+1
  const productIds = [...new Set(products.map(p => p.productId).filter(Boolean))];
  const stockItems = await StockItem.find({ _id: { $in: productIds } })
    .select('name variants')
    .lean();
  const stockMap = Object.fromEntries(stockItems.map(s => [s._id.toString(), s]));

  for (const product of products) {
    if (!product.productId) {
      errors.push(`${rowLabel}Product ID is required`);
      continue;
    }
    const stockItem = stockMap[product.productId.toString()];
    if (!stockItem) {
      errors.push(`${rowLabel}Product not found: ${product.productId}`);
      continue;
    }
    if (product.variantId) {
      const variant = (stockItem.variants || []).find(
        v => v._id.toString() === product.variantId.toString()
      );
      if (!variant) {
        errors.push(`${rowLabel}Variant not found: ${product.variantId}`);
        continue;
      }
    }
    validProducts.push({
      productId: product.productId,
      variantId: product.variantId || null,
      quantity: parseInt(product.quantity) || 1
    });
  }
  return { validProducts, errors };
}

// ─── GET all employees (paginated, lightweight) ───────────────────────────────
// Returns employee list WITHOUT resolving product names — the frontend handles that
// only for the visible page, dramatically reducing load time.
router.get('/', verifyCustomerToken, async (req, res) => {
  try {
    const {
      search = '',
      status = '',
      page = 1,
      limit = 10,
      department = '',
      designation = ''
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    let filter = { customerId: req.customerId };

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { uin: { $regex: search, $options: 'i' } }
      ];
    }
    if (status) filter.status = status;
    if (department) filter.department = department;
    if (designation) filter.designation = designation;

    const [employees, totalCount, statusCounts] = await Promise.all([
      EmployeeMpc.find(filter)
        .select('-__v')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      EmployeeMpc.countDocuments(filter),
      EmployeeMpc.aggregate([
        { $match: { customerId: req.customerId } },  // always count over full set
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    const activeCount = statusCounts.find(s => s._id === 'active')?.count || 0;
    const inactiveCount = statusCounts.find(s => s._id === 'inactive')?.count || 0;

    // Aggregate department/designation list for filter dropdowns
    const deptAgg = await EmployeeMpc.aggregate([
      { $match: { customerId: req.customerId } },
      { $group: { _id: { department: '$department', designation: '$designation' } } },
      { $sort: { '_id.department': 1, '_id.designation': 1 } }
    ]);

    const departments = [...new Set(deptAgg.map(d => d._id.department).filter(Boolean))];
    const designations = [...new Set(deptAgg.map(d => d._id.designation).filter(Boolean))];

    res.status(200).json({
      success: true,
      employees,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum)
      },
      stats: {
        total: totalCount,
        active: activeCount,
        inactive: inactiveCount
      },
      departments,
      designations
    });

  } catch (error) {
    console.error('Error fetching employees:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching employees' });
  }
});

// ─── GET available products (search-aware) ────────────────────────────────────
router.get('/products/available', verifyCustomerToken, async (req, res) => {
  try {
    const { search = '' } = req.query;

    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    const products = await StockItem.find(filter)
      .select('name reference category genderCategory baseSalesPrice totalQuantityOnHand images variants')
      .sort({ name: 1 })
      .limit(50)
      .lean();

    res.status(200).json({ success: true, products });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching products' });
  }
});

// ─── GET product variants ─────────────────────────────────────────────────────
router.get('/products/:id/variants', verifyCustomerToken, async (req, res) => {
  try {
    const product = await StockItem.findById(req.params.id)
      .select('name reference variants')
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      productName: product.name,
      variants: (product.variants || []).map(v => ({
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
    res.status(500).json({ success: false, message: 'Server error while fetching product variants' });
  }
});

// ─── GET product name by ID (for list display) ───────────────────────────────
router.get('/products/details/:id', verifyCustomerToken, async (req, res) => {
  try {
    const product = await StockItem.findById(req.params.id)
      .select('name images variants')
      .lean();

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    res.status(200).json({ success: true, product });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── BATCH resolve product names (for pagination performance) ─────────────────
// POST /products/resolve  body: { productIds: ["id1","id2",...] }
router.post('/products/resolve', verifyCustomerToken, async (req, res) => {
  try {
    const { productIds = [] } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(200).json({ success: true, products: {} });
    }

    const uniqueIds = [...new Set(productIds)].slice(0, 200);
    const items = await StockItem.find({ _id: { $in: uniqueIds } })
      .select('name images')
      .lean();

    const products = {};
    items.forEach(item => { products[item._id.toString()] = { name: item.name, image: item.images?.[0] || null }; });

    res.status(200).json({ success: true, products });
  } catch (error) {
    console.error('Error resolving product names:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET employees by dept/designation (for bulk product edit) ────────────────
router.get('/by-group', verifyCustomerToken, async (req, res) => {
  try {
    const { department = '', designation = '' } = req.query;

    let filter = { customerId: req.customerId };
    if (department) filter.department = department;
    if (designation) filter.designation = designation;

    const employees = await EmployeeMpc.find(filter)
      .select('name uin gender department designation products status')
      .sort({ name: 1 })
      .lean();

    res.status(200).json({ success: true, employees });
  } catch (error) {
    console.error('Error fetching group employees:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── BULK UPDATE products for a dept/designation group ────────────────────────
// PATCH /bulk-products
// body: { department, designation, employees: [{ _id, products: [...] }] }
router.patch('/bulk-products', verifyCustomerToken, async (req, res) => {
  try {
    const { department, designation, employees } = req.body;

    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ success: false, message: 'Employee data is required' });
    }

    const results = { updated: 0, errors: [] };

    for (const [idx, empData] of employees.entries()) {
      const { _id, products } = empData;
      if (!_id) { results.errors.push(`Row ${idx + 1}: Missing employee ID`); continue; }

      const { validProducts, errors } = await buildValidProducts(products, `Employee ${idx + 1}: `);
      if (errors.length > 0) { results.errors.push(...errors); continue; }

      await EmployeeMpc.findOneAndUpdate(
        { _id, customerId: req.customerId },
        { products: validProducts, updatedBy: req.customerId },
        { new: true }
      );
      results.updated++;
    }

    res.status(200).json({
      success: true,
      message: `Updated ${results.updated} employees`,
      ...results
    });
  } catch (error) {
    console.error('Error bulk updating products:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CREATE single employee ───────────────────────────────────────────────────
router.post('/', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, gender, department, designation, products } = req.body;

    if (!name?.trim()) return res.status(400).json({ success: false, message: 'Name is required' });
    if (!uin?.trim()) return res.status(400).json({ success: false, message: 'UIN is required' });
    if (!gender) return res.status(400).json({ success: false, message: 'Gender is required' });

    const existingEmployee = await EmployeeMpc.findOne({
      uin: uin.toUpperCase(),
      customerId: req.customerId
    });
    if (existingEmployee) {
      return res.status(400).json({ success: false, message: 'Employee with this UIN already exists' });
    }

    const { validProducts, errors } = await buildValidProducts(products);
    if (errors.length > 0) return res.status(400).json({ success: false, message: errors[0] });

    const newEmployee = new EmployeeMpc({
      customerId: req.customerId,
      name: name.trim(),
      uin: uin.trim().toUpperCase(),
      gender,
      department: department?.trim() || '',
      designation: designation?.trim() || '',
      products: validProducts,
      status: 'active',
      createdBy: req.customerId
    });

    await newEmployee.save();

    res.status(201).json({ success: true, message: 'Employee created successfully', employee: newEmployee });
  } catch (error) {
    console.error('Error creating employee:', error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Employee with this UIN already exists' });
    }
    res.status(500).json({ success: false, message: 'Server error while creating employee' });
  }
});

// ─── BATCH CREATE ─────────────────────────────────────────────────────────────
router.post('/batch', verifyCustomerToken, async (req, res) => {
  try {
    const { employees } = req.body;

    if (!employees || !Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ success: false, message: 'Employee data is required' });
    }

    // Pre-fetch all existing UINs once
    const existingEmployees = await EmployeeMpc.find({ customerId: req.customerId })
      .select('uin').lean();
    const existingUins = new Set(existingEmployees.map(emp => emp.uin.toUpperCase()));

    // Pre-fetch ALL unique product IDs in a single query
    const allProductIds = [...new Set(
      employees.flatMap(emp => (emp.products || []).map(p => p.productId).filter(Boolean))
    )];
    const stockItems = await StockItem.find({ _id: { $in: allProductIds } })
      .select('name variants')
      .lean();
    const stockMap = Object.fromEntries(stockItems.map(s => [s._id.toString(), s]));

    const validationErrors = [];
    const employeesToCreate = [];
    const skippedEmployees = [];

    for (const [index, emp] of employees.entries()) {
      const rowNumber = index + 1;

      if (!emp.name?.trim()) { validationErrors.push(`Row ${rowNumber}: Name is required`); continue; }
      if (!emp.uin?.trim()) { validationErrors.push(`Row ${rowNumber}: UIN is required`); continue; }
      if (!emp.gender) { validationErrors.push(`Row ${rowNumber}: Gender is required`); continue; }

      const formattedUin = emp.uin.trim().toUpperCase();

      if (existingUins.has(formattedUin)) {
        skippedEmployees.push({ row: rowNumber, name: emp.name.trim(), uin: formattedUin, reason: 'UIN already exists' });
        continue;
      }

      // Build products using pre-fetched map (no extra DB calls)
      const validProducts = [];
      let hasProductError = false;

      if (emp.products && Array.isArray(emp.products) && emp.products.length > 0) {
        for (const product of emp.products) {
          if (!product.productId) { validationErrors.push(`Row ${rowNumber}: Product ID is required`); hasProductError = true; break; }
          const stockItem = stockMap[product.productId.toString()];
          if (!stockItem) { validationErrors.push(`Row ${rowNumber}: Product not found`); hasProductError = true; break; }
          if (product.variantId) {
            const variant = (stockItem.variants || []).find(v => v._id.toString() === product.variantId.toString());
            if (!variant) { validationErrors.push(`Row ${rowNumber}: Variant not found`); hasProductError = true; break; }
          }
          validProducts.push({
            productId: product.productId,
            variantId: product.variantId || null,
            quantity: parseInt(product.quantity) || 1
          });
        }
      }

      if (hasProductError) continue;

      employeesToCreate.push({
        customerId: req.customerId,
        name: emp.name.trim(),
        uin: formattedUin,
        gender: emp.gender,
        department: emp.department?.trim() || '',
        designation: emp.designation?.trim() || '',
        products: validProducts,
        status: 'active',
        createdBy: req.customerId
      });

      existingUins.add(formattedUin);
    }

    if (employeesToCreate.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid employees to create',
        validationErrors,
        skippedEmployees,
        totalProcessed: employees.length,
        createdCount: 0
      });
    }

    let createdEmployees = [];
    try {
      createdEmployees = await EmployeeMpc.insertMany(employeesToCreate, { ordered: false });
    } catch (error) {
      if (error.writeErrors?.length > 0) {
        error.writeErrors.forEach(writeError => {
          if (writeError.code === 11000) {
            const failedUin = writeError.err.op.uin;
            const failedRow = employees.findIndex(e => e.uin?.toUpperCase() === failedUin) + 1;
            skippedEmployees.push({ row: failedRow, uin: failedUin, reason: 'Duplicate UIN (database constraint)' });
          }
        });
        createdEmployees = error.insertedDocs || [];
      }
    }

    res.status(201).json({
      success: true,
      message: `Processed ${employees.length} employees`,
      createdCount: createdEmployees.length,
      validationErrors: validationErrors.slice(0, 20),
      skippedEmployees: skippedEmployees.slice(0, 20)
    });

  } catch (error) {
    console.error('Error creating batch employees:', error);
    res.status(500).json({ success: false, message: 'Server error while processing employees' });
  }
});

// ─── GET single employee ──────────────────────────────────────────────────────
router.get('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const employee = await EmployeeMpc.findOne({
      _id: req.params.id,
      customerId: req.customerId
    }).lean();

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({ success: true, employee });
  } catch (error) {
    console.error('Error fetching employee:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching employee' });
  }
});

// ─── UPDATE single employee ───────────────────────────────────────────────────
router.put('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const { name, uin, gender, department, designation, products, status } = req.body;

    const employee = await EmployeeMpc.findOne({
      _id: req.params.id,
      customerId: req.customerId
    });

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    if (uin && uin !== employee.uin) {
      const existing = await EmployeeMpc.findOne({
        uin: uin.toUpperCase(),
        _id: { $ne: req.params.id },
        customerId: req.customerId
      });
      if (existing) {
        return res.status(400).json({ success: false, message: 'Another employee with this UIN already exists' });
      }
    }

    if (name !== undefined) employee.name = name.trim();
    if (uin !== undefined) employee.uin = uin.trim().toUpperCase();
    if (gender !== undefined) employee.gender = gender;
    if (department !== undefined) employee.department = department.trim();
    if (designation !== undefined) employee.designation = designation.trim();
    if (status !== undefined) employee.status = status;

    if (products !== undefined) {
      // Allow empty products array (remove all)
      const { validProducts, errors } = await buildValidProducts(products);
      if (errors.length > 0) return res.status(400).json({ success: false, message: errors[0] });
      employee.products = validProducts;
    }

    employee.updatedBy = req.customerId;
    await employee.save();

    res.status(200).json({ success: true, message: 'Employee updated successfully', employee });
  } catch (error) {
    console.error('Error updating employee:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: 'Validation error', error: error.message });
    }
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: 'Employee with this UIN already exists' });
    }
    res.status(500).json({ success: false, message: 'Server error while updating employee' });
  }
});

// ─── DELETE employee ──────────────────────────────────────────────────────────
router.delete('/:id', verifyCustomerToken, async (req, res) => {
  try {
    const employee = await EmployeeMpc.findOneAndDelete({
      _id: req.params.id,
      customerId: req.customerId
    });

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({ success: true, message: 'Employee deleted successfully' });
  } catch (error) {
    console.error('Error deleting employee:', error);
    res.status(500).json({ success: false, message: 'Server error while deleting employee' });
  }
});

// ─── UPDATE employee status ───────────────────────────────────────────────────
router.patch('/:id/status', verifyCustomerToken, async (req, res) => {
  try {
    const { status } = req.body;

    if (!status || !['active', 'inactive'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Valid status is required' });
    }

    const employee = await EmployeeMpc.findOneAndUpdate(
      { _id: req.params.id, customerId: req.customerId },
      { status, updatedBy: req.customerId },
      { new: true }
    );

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    res.status(200).json({ success: true, message: 'Status updated', employee });
  } catch (error) {
    console.error('Error updating employee status:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET stock item details (legacy support) ──────────────────────────────────
router.get('/stock-items/:id', verifyCustomerToken, async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .select('name reference images variants')
      .lean();

    if (!stockItem) {
      return res.status(404).json({ success: false, message: 'Stock item not found' });
    }

    res.status(200).json({ success: true, stockItem });
  } catch (error) {
    console.error('Error fetching stock item:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;