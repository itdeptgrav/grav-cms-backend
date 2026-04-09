// routes/customer/Employee_Mpc.js

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
    res.status(500).json({ success: false, message: 'Server error while fetching employees' });
  }
});


router.post("/by-uins", async (req, res) => {
  try {
    const { uins } = req.body;
    if (!Array.isArray(uins) || !uins.length) {
      return res.json({ success: true, employees: [] });
    }
 
    const upperUins = uins.map(u => u.toString().toUpperCase());
 
    const employees = await EmployeeMpc.find({ uin: { $in: upperUins } })
      .select("_id uin department designation name gender")
      .lean();
 
    return res.json({
      success: true,
      employees: employees.map(e => ({
        _id:         e._id,  
        uin:         e.uin,
        name:        e.name,
        gender:      e.gender      || "",
        department:  e.department  || "",
        designation: e.designation || "",
      }))
    });
  } catch (err) {
    console.error("by-uins error:", err);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});



const buildExportFilter = (req) => {
  const filter = { customerId: req.customerId };
  const ids = req.query.ids; // single string or array of strings
  if (ids) {
    const idArray = Array.isArray(ids) ? ids : [ids];
    if (idArray.length) {
      filter._id = { $in: idArray };
    }
  }
  return filter;
};


router.get('/export', verifyCustomerToken, async (req, res) => {
  try {
    // Fetch ALL employees sorted by department then name
    const employees = await EmployeeMpc.find(buildExportFilter(req))
      .select('name uin gender department designation products status')
      .sort({ department: 1, name: 1 })
      .lean();

    if (!employees.length) {
      return res.status(404).json({ success: false, message: 'No employees found' });
    }

    // Batch-fetch all referenced StockItems
    const productIdSet = new Set();
    employees.forEach(emp => {
      (emp.products || []).forEach(p => {
        if (p.productId) productIdSet.add(p.productId.toString());
      });
    });

    const stockItems = productIdSet.size
      ? await StockItem.find({ _id: { $in: [...productIdSet] } })
        .select('_id name images variants')
        .lean()
      : [];

    const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

    // ── Build rows grouped by department ─────────────────────────────────────
    const headers = [
      'Name', 'UIN', 'Gender', 'Department', 'Designation', 'Status',
      'Product Name', 'Variant', 'Quantity', 'Product Image'
    ];

    const rows = [];
    let currentDept = null;

    employees.forEach(emp => {
      const dept = emp.department || '';

      // Insert blank separator row when department changes (not before first dept)
      if (currentDept !== null && dept !== currentDept) {
        rows.push(',,,,,,,,, ');
      }
      currentDept = dept;

      const base = [
        `"${emp.name}"`,
        emp.uin,
        emp.gender,
        `"${dept}"`,
        `"${emp.designation || ''}"`,
        emp.status,
      ];

      if (!emp.products?.length) {
        rows.push([...base, '', '', '', ''].join(','));
        return;
      }

      emp.products.forEach(p => {
        const si = stockMap.get(p.productId?.toString());
        const prodName = p.productName || si?.name || '';
        let variantLabel = 'Default';
        let imageUrl = '';

        if (si) {
          imageUrl = si.images?.[0] || '';
          if (p.variantId && si.variants?.length) {
            const v = si.variants.find(v => v._id.toString() === p.variantId.toString());
            if (v) {
              variantLabel = v.attributes?.map(a => a.value).join(' / ') || 'Default';
              if (v.images?.[0]) imageUrl = v.images[0];
            }
          }
        }

        // =IMAGE("url") renders inline in Excel / modern Google Sheets.
        // Doubles the inner quotes so they survive CSV quoting rules.
        const imageCell = imageUrl ? `"=IMAGE(""${imageUrl}"")"` : '';

        rows.push([
          ...base,
          `"${prodName}"`,
          `"${variantLabel}"`,
          p.quantity || 1,
          imageCell,
        ].join(','));
      });
    });

    const csv = ['\uFEFF', headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="employees_export.csv"');
    res.send(csv);

  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: 'Export failed' });
  }
});



router.get('/export-xlsx', verifyCustomerToken, async (req, res) => {
  const ExcelJS = require('exceljs');
  const axios = require('axios');

  try {
    const employees = await EmployeeMpc.find(buildExportFilter(req))
      .select('name uin gender department designation products status')
      .sort({ department: 1, name: 1 })
      .lean();

    if (!employees.length) {
      return res.status(404).json({ success: false, message: 'No employees found' });
    }

    // ── Batch-fetch StockItems ─────────────────────────────────────────────
    const productIdSet = new Set();
    employees.forEach(emp =>
      (emp.products || []).forEach(p => {
        if (p.productId) productIdSet.add(p.productId.toString());
      })
    );

    const stockItems = productIdSet.size
      ? await StockItem.find({ _id: { $in: [...productIdSet] } })
        .select('_id name images variants')
        .lean()
      : [];

    const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

    // ── Max products across all employees → number of photo columns ───────
    const maxProducts = employees.reduce(
      (m, e) => Math.max(m, (e.products || []).length), 0
    );

    // ── Image helpers ─────────────────────────────────────────────────────
    const toThumb = (u) => u?.includes('/image/upload/')
      ? u.replace('/image/upload/', '/image/upload/w_80,h_80,c_fill,q_70,f_webp/')
      : u;

    const getImageExtension = (url) => {
      const ext = (url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png').toLowerCase();
      return (ext === 'jpg' || ext === 'jpeg') ? 'jpeg' : ext === 'gif' ? 'gif' : 'png';
    };

    // Resolve image: assigned variant first, then any variant, then product-level
    const resolveImageUrl = (p) => {
      const pid = p.productId?.toString();
      if (!pid) return '';
      const si = stockMap.get(pid);
      if (!si) return '';

      // 1. Try assigned variant's image
      if (p.variantId && si.variants?.length) {
        const v = si.variants.find(v => v._id.toString() === p.variantId.toString());
        if (v?.images?.[0]) return v.images[0];
      }

      // 2. Fallback: any variant with an image
      if (si.variants?.length) {
        for (const v of si.variants) {
          if (v.images?.[0]) return v.images[0];
        }
      }

      // 3. Fallback: product-level image
      return si.images?.[0] || '';
    };

    // Variant label for combined text
    const getVariantLabel = (p) => {
      const pid = p.productId?.toString();
      if (!pid || !p.variantId) return '';
      const si = stockMap.get(pid);
      if (!si?.variants?.length) return '';
      const v = si.variants.find(v => v._id.toString() === p.variantId.toString());
      if (!v?.attributes?.length) return '';
      return v.attributes.map(a => a.value).join('/');
    };

    // ── Collect and download all unique image URLs ────────────────────────
    const imageUrlSet = new Set();
    employees.forEach(emp => {
      (emp.products || []).forEach(p => {
        const pid = p.productId?.toString();
        if (!pid) return;
        const si = stockMap.get(pid);
        if (!si) return;

        // Collect from all variants (so fallback works)
        (si.variants || []).forEach(v => {
          if (v.images?.[0]) imageUrlSet.add(v.images[0]);
        });
        if (si.images?.[0]) imageUrlSet.add(si.images[0]);
      });
    });

    const imageBufferMap = new Map();
    await Promise.all([...imageUrlSet].map(async url => {
      try {
        const resp = await axios.get(toThumb(url), {
          responseType: 'arraybuffer', timeout: 10000
        });
        imageBufferMap.set(url, Buffer.from(resp.data));
      } catch { /* skip failed images */ }
    }));

    // ── Build workbook ────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees', {
      pageSetup: { fitToPage: true, fitToWidth: 1 }
    });

    const IMG_COL_WIDTH = 11;
    const ROW_HEIGHT = 72;

    const fixedCols = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'UIN', key: 'uin', width: 12 },
      { header: 'Gender', key: 'gender', width: 9 },
      { header: 'Department', key: 'department', width: 22 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Products', key: 'products', width: 34 },
    ];
    const FIXED_COUNT = fixedCols.length;

    const photoCols = [];
    for (let i = 1; i <= maxProducts; i++) {
      photoCols.push({ header: `Photo ${i}`, key: `photo_${i}`, width: IMG_COL_WIDTH });
    }

    ws.columns = [...fixedCols, ...photoCols];
    const totalCols = FIXED_COUNT + maxProducts;

    // ── Header styling ────────────────────────────────────────────────────
    ws.getRow(1).height = 22;
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF4A5568' } },
        right: { style: 'thin', color: { argb: 'FF4A5568' } }
      };
    });
    // Slightly different header bg for photo columns
    for (let i = 1; i <= maxProducts; i++) {
      ws.getRow(1).getCell(FIXED_COUNT + i).fill = {
        type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4A5568' }
      };
    }

    const styleCell = (cell, isAlt) => {
      cell.font = { size: 9, name: 'Arial' };
      cell.fill = {
        type: 'pattern', pattern: 'solid',
        fgColor: { argb: isAlt ? 'FFF7FAFC' : 'FFFFFFFF' }
      };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } },
        right: { style: 'hair', color: { argb: 'FFE2E8F0' } }
      };
    };

    // ── Write rows ────────────────────────────────────────────────────────
    let currentDept = null;
    let rowIdx = 2;
    let altRow = false;

    for (const emp of employees) {
      const dept = emp.department || '';
      const empProducts = emp.products || [];

      // Department separator
      if (currentDept !== null && dept !== currentDept) {
        const sep = ws.getRow(rowIdx);
        sep.height = 6;
        if (totalCols > 1) ws.mergeCells(rowIdx, 1, rowIdx, totalCols);
        sep.getCell(1).fill = {
          type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' }
        };
        rowIdx++;
        altRow = false;
      }
      currentDept = dept;

      // Build combined products text: "1. Chef Coat | Blue/XL (x2)"
      const productNamesText = empProducts.map((p, idx) => {
        const si = stockMap.get(p.productId?.toString());
        const name = p.productName || si?.name || '(unknown)';
        const variant = getVariantLabel(p);
        const qty = p.quantity || 1;
        const parts = [`${idx + 1}. ${name}`];
        if (variant) parts.push(`| ${variant}`);
        parts.push(`(x${qty})`);
        return parts.join(' ');
      }).join('\n');

      // Determine if any product has an image
      const hasAnyImage = empProducts.some(p => {
        const url = resolveImageUrl(p);
        return url && imageBufferMap.has(url);
      });

      const row = ws.getRow(rowIdx);
      row.height = hasAnyImage ? ROW_HEIGHT : Math.max(18, empProducts.length * 14);

      // Status display
      const statusText = emp.status === 'active' ? 'Active' : 'Inactive';

      const fixedValues = [
        emp.name,
        emp.uin,
        emp.gender,
        dept,
        emp.designation || '',
        statusText,
        productNamesText || '',
      ];

      fixedValues.forEach((val, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = val;
        styleCell(cell, altRow);
      });

      // Status cell coloring
      const statusCell = row.getCell(6);
      if (emp.status === 'active') {
        statusCell.font = { size: 9, name: 'Arial', color: { argb: 'FF16A34A' } };
      } else {
        statusCell.font = { size: 9, name: 'Arial', color: { argb: 'FF9CA3AF' } };
      }

      // ── Photo columns — one per product slot ────────────────────────────
      for (let i = 0; i < maxProducts; i++) {
        const photoColIdx = FIXED_COUNT + i + 1;
        const photoCell = row.getCell(photoColIdx);
        styleCell(photoCell, altRow);

        const p = empProducts[i];
        if (!p) continue;

        const imgUrl = resolveImageUrl(p);
        const imgBuffer = imgUrl ? imageBufferMap.get(imgUrl) : null;

        if (!imgBuffer) {
          // Show "No Image" placeholder text
          photoCell.value = 'No Image';
          photoCell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
          photoCell.font = { size: 8, name: 'Arial', color: { argb: 'FF9CA3AF' } };
          continue;
        }

        const ext = getImageExtension(imgUrl);
        const imgId = wb.addImage({ buffer: imgBuffer, extension: ext });
        ws.addImage(imgId, {
          tl: { col: photoColIdx - 1, row: rowIdx - 1 },
          br: { col: photoColIdx, row: rowIdx },
          editAs: 'oneCell',
        });
      }

      row.commit();
      rowIdx++;
      altRow = !altRow;
    }

    // ── Freeze header + auto-filter ───────────────────────────────────────
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // Build auto-filter column letter (handles >26 columns)
    const colToLetter = (col) => {
      let letter = '';
      while (col > 0) {
        col--;
        letter = String.fromCharCode(65 + (col % 26)) + letter;
        col = Math.floor(col / 26);
      }
      return letter;
    };
    ws.autoFilter = { from: 'A1', to: `${colToLetter(totalCols)}1` };

    // ── Stream response ───────────────────────────────────────────────────
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',
      `attachment; filename="employees_${new Date().toISOString().split('T')[0]}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('XLSX export error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Export failed: ' + error.message });
    }
  }
});

// ─── GET available products (search-aware, additionalNames-aware) ─────────────
// When a search term is supplied the query now also checks the `additionalNames`
// array so that typing an alias surfaces the correct product.
// Each returned product includes a `matchedName` field:
//   • If the search matched an additionalName  → matchedName = that additionalName
//   • Otherwise                                → matchedName = product.name (canonical)
// The frontend uses matchedName as the label in the popup AND persists it on save.
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