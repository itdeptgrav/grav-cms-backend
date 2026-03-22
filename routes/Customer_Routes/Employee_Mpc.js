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
// Now also accepts an optional `productName` per entry so callers can persist
// the display-name that was shown in the popup (could be an additionalName alias).
async function buildValidProducts(products, rowLabel = '') {
  const validProducts = [];
  const errors = [];

  if (!products || !Array.isArray(products) || products.length === 0) {
    return { validProducts, errors };
  }

  // Batch-fetch all stock items at once to avoid N+1
  const productIds = [...new Set(products.map(p => p.productId).filter(Boolean))];
  const stockItems = await StockItem.find({ _id: { $in: productIds } })
    .select('name additionalNames variants')
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

    // ── Determine the display name to persist ─────────────────────────────
    // Priority:
    //   1. Caller-supplied productName (e.g. the additionalName the user saw in the popup)
    //   2. Canonical product name from the DB
    const resolvedName = (product.productName && product.productName.trim())
      ? product.productName.trim()
      : stockItem.name;

    validProducts.push({
      productId: product.productId,
      variantId: product.variantId || null,
      quantity: parseInt(product.quantity) || 1,
      productName: resolvedName
    });
  }
  return { validProducts, errors };
}

// ─── GET all employees (paginated, lightweight) ───────────────────────────────
// Products now carry a persisted `productName` field — no need to re-resolve
// them on the frontend for the visible page.
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
        { $match: { customerId: req.customerId } },
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


router.get('/export', verifyCustomerToken, async (req, res) => {
  try {
    // Fetch ALL employees sorted by department then name
    const employees = await EmployeeMpc.find({ customerId: req.customerId })
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
    // ── 1. Fetch all employees sorted by dept → name ──────────────────────
    const employees = await EmployeeMpc.find({ customerId: req.customerId })
      .select('name uin gender department designation products')
      .sort({ department: 1, name: 1 })
      .lean();

    if (!employees.length) {
      return res.status(404).json({ success: false, message: 'No employees found' });
    }

    // ── 2. Batch-fetch StockItems ─────────────────────────────────────────
    const productIdSet = new Set();
    employees.forEach(emp =>
      (emp.products || []).forEach(p => { if (p.productId) productIdSet.add(p.productId.toString()); })
    );

    const stockItems = productIdSet.size
      ? await StockItem.find({ _id: { $in: [...productIdSet] } })
        .select('_id name images variants')
        .lean()
      : [];

    const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

    // ── 3. Pre-download all unique image URLs in parallel ─────────────────
    const imageUrlSet = new Set();
    employees.forEach(emp => {
      (emp.products || []).forEach(p => {
        const si = stockMap.get(p.productId?.toString());
        if (!si) return;
        let url = si.images?.[0] || '';
        if (p.variantId && si.variants?.length) {
          const v = si.variants.find(v => v._id.toString() === p.variantId.toString());
          if (v?.images?.[0]) url = v.images[0];
        }
        if (url) imageUrlSet.add(url);
      });
    });

    const imageBufferMap = new Map();
    await Promise.all([...imageUrlSet].map(async url => {
      try {
        const toThumb = (u) => u?.includes('/image/upload/')
          ? u.replace('/image/upload/', '/image/upload/w_80,h_80,c_fill,q_70,f_webp/')
          : u;
        const resp = await axios.get(toThumb(url), { responseType: 'arraybuffer', timeout: 8000 });
        imageBufferMap.set(url, Buffer.from(resp.data));
      } catch { /* skip failed images */ }
    }));

    // ── 4. Build workbook ─────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees', { pageSetup: { fitToPage: true, fitToWidth: 1 } });

    const IMG_HEIGHT = 60; // row height (pts) when images present

    // Columns — NO Status, photo is col 9 (I)
    ws.columns = [
      { header: 'Name', key: 'name', width: 24 },
      { header: 'UIN', key: 'uin', width: 10 },
      { header: 'Gender', key: 'gender', width: 9 },
      { header: 'Department', key: 'department', width: 22 },
      { header: 'Designation', key: 'designation', width: 22 },
      { header: 'Product Name', key: 'productName', width: 28 },
      { header: 'Variant', key: 'variant', width: 14 },
      { header: 'Quantity', key: 'quantity', width: 10 },
      { header: 'Photo', key: 'photo', width: 12 },
    ];

    // Header styling
    ws.getRow(1).height = 20;
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF4A5568' } }, right: { style: 'thin', color: { argb: 'FF4A5568' } } };
    });

    const styleCell = (cell, isAlt) => {
      cell.font = { size: 9, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFF7FAFC' : 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } }, right: { style: 'hair', color: { argb: 'FFE2E8F0' } } };
    };

    let currentDept = null;
    let rowIdx = 2;   // 1-based; row 1 = header
    let altRow = false;

    for (const emp of employees) {
      const dept = emp.department || '';

      // Blank separator between departments
      if (currentDept !== null && dept !== currentDept) {
        const sep = ws.getRow(rowIdx);
        sep.height = 8;
        ws.mergeCells(rowIdx, 1, rowIdx, 9);
        sep.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } };
        rowIdx++;
        altRow = false;
      }
      currentDept = dept;

      // ── Resolve all products for this employee ────────────────────────
      const productLines = [];   // strings for the text cell
      const imageUrls = [];   // one url per product (may repeat if same image)

      (emp.products || []).forEach((p, idx) => {
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

        const qty = p.quantity || 1;
        productLines.push(`${idx + 1}. ${prodName} | Qty: ${qty}`);
        imageUrls.push(imageUrl);
      });

      const hasAnyImage = imageUrls.some(u => u && imageBufferMap.has(u));
      const row = ws.getRow(rowIdx);
      row.height = hasAnyImage ? IMG_HEIGHT * imageUrls.filter(u => u && imageBufferMap.has(u)).length : 18;

      // Write the 8 text columns (no photo text — images handle col 9)
      const textValues = [
        emp.name,
        emp.uin,
        emp.gender,
        dept,
        emp.designation || '',
        productLines.join('\n') || '',   // all products in one cell, newline-separated
        '',   // variant — already in productLines
        '',   // quantity — already in productLines
      ];

      textValues.forEach((val, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = val;
        styleCell(cell, altRow);
      });
      // Style the photo cell too
      styleCell(row.getCell(9), altRow);
      row.commit();

      // ── Embed images stacked in the Photo column ──────────────────────
      // Each image gets an equal slice of the row height
      const validImages = imageUrls.filter(u => u && imageBufferMap.has(u));
      if (validImages.length > 0) {
        const sliceHeight = 1 / validImages.length; // fraction of row in ExcelJS units

        validImages.forEach((url, imgIdx) => {
          const buf = imageBufferMap.get(url);
          const ext = (url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png').toLowerCase();
          const type = (ext === 'jpg' || ext === 'jpeg') ? 'jpeg' : ext === 'gif' ? 'gif' : 'png';
          const id = wb.addImage({ buffer: buf, extension: type });

          ws.addImage(id, {
            tl: { col: 8, row: rowIdx - 1 + imgIdx * sliceHeight },
            br: { col: 9, row: rowIdx - 1 + (imgIdx + 1) * sliceHeight },
            editAs: 'oneCell',
          });
        });
      }

      rowIdx++;
      altRow = !altRow;
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'I1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="employees_${new Date().toISOString().split('T')[0]}.xlsx"`);
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

    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { reference: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
        // ── NEW: also search inside the additionalNames array ──────────────
        { additionalNames: { $elemMatch: { $regex: search, $options: 'i' } } },
        // Also try direct array match for string arrays
        { additionalNames: { $regex: search, $options: 'i' } }
      ];
    }

    const products = await StockItem.find(filter)
      .select('name reference category genderCategory baseSalesPrice totalQuantityOnHand images variants additionalNames')
      .sort({ name: 1 })
      .limit(50)
      .lean();

    // ── Attach matchedName ────────────────────────────────────────────────────
    // For each product decide which label the popup should display.
    const searchLower = search.toLowerCase();
    const enriched = products.map(p => {
      let matchedName = p.name; // default: canonical name

      if (search) {
        // Check if the canonical name does NOT match but an additionalName does
        const canonicalMatches = p.name.toLowerCase().includes(searchLower);
        if (!canonicalMatches && Array.isArray(p.additionalNames)) {
          const hit = p.additionalNames.find(
            an => an.toLowerCase().includes(searchLower)
          );
          if (hit) matchedName = hit;
        }
        // If canonical name itself matched, keep matchedName = p.name (already set)
      }

      return { ...p, matchedName };
    });

    res.status(200).json({ success: true, products: enriched });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching products' });
  }
});

// ─── POST /products/available — fetch specific products by ID ─────────────────
// Used by the popup when editing: guarantees the already-assigned products are
// always present in the list regardless of search/limit.
// Returns the same shape as GET /products/available (including matchedName).
// matchedName is taken from the caller-supplied `persistedName` if provided
// (i.e. the name that was stored when the product was originally assigned —
//  could be an additionalName alias), otherwise falls back to canonical name.
router.post('/products/available', verifyCustomerToken, async (req, res) => {
  try {
    const { productIds = [], persistedNames = {} } = req.body;
    // persistedNames: { "productId": "storedName" }

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(200).json({ success: true, products: [] });
    }

    const uniqueIds = [...new Set(productIds)].slice(0, 100);
    const items = await StockItem.find({ _id: { $in: uniqueIds } })
      .select('name reference category genderCategory baseSalesPrice totalQuantityOnHand images variants additionalNames')
      .lean();

    const enriched = items.map(p => {
      const pidStr = p._id.toString();
      // Use the persisted name (the name stored on the employee assignment).
      // This is exactly what should be shown in the popup for this assignment.
      const stored = persistedNames[pidStr];
      const matchedName = (stored && stored.trim()) ? stored.trim() : p.name;
      return { ...p, matchedName };
    });

    res.status(200).json({ success: true, products: enriched });
  } catch (error) {
    console.error('Error fetching products by id:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET product variants ─────────────────────────────────────────────────────
router.get('/products/:id/variants', verifyCustomerToken, async (req, res) => {
  try {
    const product = await StockItem.findById(req.params.id)
      .select('name reference variants additionalNames')
      .lean();

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({
      success: true,
      productName: product.name,
      additionalNames: product.additionalNames || [],
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
      .select('name images variants additionalNames')
      .lean();

    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });

    res.status(200).json({ success: true, product });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── BATCH resolve product names (fallback / migration helper) ────────────────
// POST /products/resolve  body: { productIds: ["id1","id2",...] }
// Still used by older code paths and the assignment-history sidebar.
// Returns canonical name + image (not additionalNames — callers use persisted
// productName on the employee record for the display label instead).
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
// Each product entry may now include `productName` — persisted as-is.
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

    // ── Pre-fetch all existing employees for this customer ────────────────────
    const existingEmployees = await EmployeeMpc.find({ customerId: req.customerId })
      .select('uin name department designation')
      .lean();

    // Map keyed by uppercase UIN for O(1) lookup
    const existingMap = Object.fromEntries(
      existingEmployees.map(emp => [emp.uin.toUpperCase(), emp])
    );

    // ── Pre-fetch ALL unique product IDs in one query ─────────────────────────
    const allProductIds = [...new Set(
      employees.flatMap(emp => (emp.products || []).map(p => p.productId).filter(Boolean))
    )];
    const stockItems = await StockItem.find({ _id: { $in: allProductIds } })
      .select('name additionalNames variants')
      .lean();
    const stockMap = Object.fromEntries(stockItems.map(s => [s._id.toString(), s]));

    const validationErrors = [];
    const employeesToCreate = [];
    const skippedEmployees = [];
    const deptPatchOps = [];

    // Track UINs queued for creation this batch to catch intra-batch duplicates
    const seenUins = new Set(Object.keys(existingMap));

    for (const [index, emp] of employees.entries()) {
      const rowNumber = index + 1;

      // ── Basic field validation ──────────────────────────────────────────────
      if (!emp.name?.trim()) {
        validationErrors.push(`Row ${rowNumber}: Name is required`);
        continue;
      }
      if (!emp.uin?.trim()) {
        validationErrors.push(`Row ${rowNumber}: UIN is required`);
        continue;
      }
      if (!emp.gender) {
        validationErrors.push(`Row ${rowNumber}: Gender is required`);
        continue;
      }

      const formattedUin = emp.uin.trim().toUpperCase();
      const formattedName = emp.name.trim();

      // ── Check if UIN already exists ────────────────────────────────────────
      if (existingMap[formattedUin]) {
        const stored = existingMap[formattedUin];

        if (stored.name.trim().toLowerCase() !== formattedName.toLowerCase()) {
          skippedEmployees.push({
            row: rowNumber,
            name: formattedName,
            uin: formattedUin,
            reason: `UIN exists but name mismatch (stored: "${stored.name}")`
          });
          continue;
        }

        const needsDeptPatch = !stored.department?.trim() && emp.department?.trim();
        const needsDesigPatch = !stored.designation?.trim() && emp.designation?.trim();

        if (needsDeptPatch || needsDesigPatch) {
          const patch = { updatedBy: req.customerId };
          if (needsDeptPatch) patch.department = emp.department.trim();
          if (needsDesigPatch) patch.designation = emp.designation.trim();
          deptPatchOps.push({ _id: stored._id, patch });
        } else {
          skippedEmployees.push({
            row: rowNumber,
            name: formattedName,
            uin: formattedUin,
            reason: 'Already exists with department & designation — no changes needed'
          });
        }
        continue;
      }

      // ── Intra-batch duplicate check ────────────────────────────────────────
      if (seenUins.has(formattedUin)) {
        skippedEmployees.push({ row: rowNumber, name: formattedName, uin: formattedUin, reason: 'Duplicate UIN in this import' });
        continue;
      }

      // ── Validate products using pre-fetched map ────────────────────────────
      const validProducts = [];
      let hasProductError = false;

      if (emp.products && Array.isArray(emp.products) && emp.products.length > 0) {
        for (const product of emp.products) {
          if (!product.productId) {
            validationErrors.push(`Row ${rowNumber}: Product ID is required`);
            hasProductError = true;
            break;
          }
          const stockItem = stockMap[product.productId.toString()];
          if (!stockItem) {
            validationErrors.push(`Row ${rowNumber}: Product not found`);
            hasProductError = true;
            break;
          }
          if (product.variantId) {
            const variant = (stockItem.variants || []).find(
              v => v._id.toString() === product.variantId.toString()
            );
            if (!variant) {
              validationErrors.push(`Row ${rowNumber}: Variant not found`);
              hasProductError = true;
              break;
            }
          }
          // Persist whichever display name was supplied by the caller
          const resolvedName = (product.productName && product.productName.trim())
            ? product.productName.trim()
            : stockItem.name;

          validProducts.push({
            productId: product.productId,
            variantId: product.variantId || null,
            quantity: parseInt(product.quantity) || 1,
            productName: resolvedName
          });
        }
      }

      if (hasProductError) continue;

      employeesToCreate.push({
        customerId: req.customerId,
        name: formattedName,
        uin: formattedUin,
        gender: emp.gender,
        department: emp.department?.trim() || '',
        designation: emp.designation?.trim() || '',
        products: validProducts,
        status: 'active',
        createdBy: req.customerId
      });

      seenUins.add(formattedUin);
    }

    // ── Execute dept/desig patches in a single bulkWrite ──────────────────────
    let patchedCount = 0;
    if (deptPatchOps.length > 0) {
      const bulkOps = deptPatchOps.map(({ _id, patch }) => ({
        updateOne: {
          filter: { _id, customerId: req.customerId },
          update: { $set: patch }
        }
      }));
      const bulkResult = await EmployeeMpc.bulkWrite(bulkOps, { ordered: false });
      patchedCount = bulkResult.modifiedCount || 0;
    }

    // ── Insert new employees ──────────────────────────────────────────────────
    let createdEmployees = [];
    if (employeesToCreate.length > 0) {
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
        } else {
          throw error;
        }
      }
    }

    if (createdEmployees.length === 0 && patchedCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'No changes were made',
        validationErrors,
        skippedEmployees,
        totalProcessed: employees.length,
        createdCount: 0,
        patchedCount: 0
      });
    }

    res.status(201).json({
      success: true,
      message: `Processed ${employees.length} employees`,
      createdCount: createdEmployees.length,
      patchedCount,
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
      .select('name reference images variants additionalNames')
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