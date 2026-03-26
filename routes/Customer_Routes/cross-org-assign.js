// routes/Customer_Routes/cross-org-assign.js

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Customer = require('../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');

// ─── Auth middleware ───────────────────────────────────────────────────────────
const verifyCustomerToken = async (req, res, next) => {
  try {
    const token = req.cookies.customerToken;
    if (!token) return res.status(401).json({ success: false, message: 'Access denied. Please sign in.' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'grav_clothing_secret_key_2024');
    req.customerId = decoded.id;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token. Please sign in again.' });
  }
};

// ─── Helper: build & validate product array ────────────────────────────────────
async function buildValidProducts(products) {
  const validProducts = [];
  const errors = [];
  if (!products?.length) return { validProducts, errors };

  const productIds = [...new Set(products.map(p => p.productId).filter(Boolean))];
  const stockItems = await StockItem.find({ _id: { $in: productIds } })
    .select('name additionalNames variants')
    .lean();
  const stockMap = Object.fromEntries(stockItems.map(s => [s._id.toString(), s]));

  for (const product of products) {
    if (!product.productId) { errors.push('Product ID is required'); continue; }
    const stockItem = stockMap[product.productId.toString()];
    if (!stockItem) { errors.push(`Product not found: ${product.productId}`); continue; }
    if (product.variantId) {
      const variant = (stockItem.variants || []).find(v => v._id.toString() === product.variantId.toString());
      if (!variant) { errors.push(`Variant not found: ${product.variantId}`); continue; }
    }
    const resolvedName = (product.productName && product.productName.trim())
      ? product.productName.trim()
      : stockItem.name;
    validProducts.push({
      productId: product.productId,
      variantId: product.variantId || null,
      quantity: parseInt(product.quantity) || 1,
      productName: resolvedName,
    });
  }
  return { validProducts, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /organisations
// ─────────────────────────────────────────────────────────────────────────────
router.get('/organisations', verifyCustomerToken, async (req, res) => {
  try {
    const customers = await Customer.find({})
      .select('_id name email phone')
      .sort({ name: 1 })
      .lean();

    if (!customers.length) {
      return res.status(200).json({ success: true, organisations: [] });
    }

    const counts = await EmployeeMpc.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$customerId', employeeCount: { $sum: 1 } } }
    ]);
    const countMap = Object.fromEntries(counts.map(c => [c._id.toString(), c.employeeCount]));

    const organisations = customers.map(c => ({
      ...c,
      employeeCount: countMap[c._id.toString()] || 0,
    }));

    res.status(200).json({ success: true, organisations });
  } catch (error) {
    console.error('cross-org /organisations error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching organisations' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /employees
// ─────────────────────────────────────────────────────────────────────────────
router.post('/employees', verifyCustomerToken, async (req, res) => {
  try {
    const { orgIds } = req.body;

    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds array is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid organisation IDs provided' });
    }

    const orgs = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgNameMap = Object.fromEntries(orgs.map(o => [o._id.toString(), o.name]));

    const employees = await EmployeeMpc.find({
      customerId: { $in: validOrgIds },
      status: 'active',
    })
      .select('_id name uin gender department designation products customerId')
      .sort({ customerId: 1, department: 1, name: 1 })
      .lean();

    const enriched = employees.map(e => ({
      ...e,
      orgId: e.customerId.toString(),
      orgName: orgNameMap[e.customerId.toString()] || 'Unknown',
    }));

    res.status(200).json({
      success: true,
      employees: enriched,
      total: enriched.length,
      orgCount: validOrgIds.length,
    });
  } catch (error) {
    console.error('cross-org /employees error:', error);
    res.status(500).json({ success: false, message: 'Server error while fetching employees' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /assign-products
// Body:
//   orgIds            – array of org IDs to scope
//   department        – filter (null = all depts)
//   designation       – filter (null = all desigs)
//   genderFilter      – "All" | "Male" | "Female"
//   products          – array of { productId, variantId, quantity, productName, genderCategory }
//   removedProductIds – array of productId strings that were explicitly unchecked
//
// Logic per employee:
//   1. Start with their current products array
//   2. Strip out every pid in removedProductIds  ← THE FIX: was missing before
//   3. Strip out every pid in the incoming products batch (to avoid duplicates)
//   4. Re-append the incoming batch (with per-employee gender restriction)
//   → net result: removed = gone, updated = replaced, untouched = kept
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assign-products', verifyCustomerToken, async (req, res) => {
  try {
    const {
      orgIds,
      department,
      designation,
      genderFilter = 'All',
      products = [],                // may be empty if user removed everything
      removedProductIds = [],       // ← pids the user explicitly unchecked
    } = req.body;

    // ── Basic validation ──────────────────────────────────────────────────────
    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid org IDs' });
    }

    // ── BUG FIX: allow empty products array ───────────────────────────────────
    // Previously this returned 400 when products was empty, which meant you
    // could never save a state where all products were removed. Now we allow it
    // as long as removedProductIds has entries (or products is intentionally []).
    if (!Array.isArray(products)) {
      return res.status(400).json({ success: false, message: 'products must be an array' });
    }
    if (!Array.isArray(removedProductIds)) {
      return res.status(400).json({ success: false, message: 'removedProductIds must be an array' });
    }

    // Nothing to do at all
    if (products.length === 0 && removedProductIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No products to assign or remove' });
    }

    // ── Validate incoming products (skip if empty) ────────────────────────────
    let validProducts = [];
    if (products.length > 0) {
      const { validProducts: vp, errors: productErrors } = await buildValidProducts(products);
      if (productErrors.length) {
        return res.status(400).json({ success: false, message: productErrors.join('; ') });
      }
      validProducts = vp;
    }

    // Build sets for fast lookup
    // removedPidSet  — pids to unconditionally strip from every matched employee
    // incomingPidSet — pids being re-added / updated (also needs stripping first to avoid dupes)
    const removedPidSet = new Set(removedProductIds.map(id => id.toString()));
    const incomingPidSet = new Set(validProducts.map(p => p.productId.toString()));

    // Combined set of pids to remove before re-adding incoming ones
    const stripPidSet = new Set([...removedPidSet, ...incomingPidSet]);

    // genderCategory map from original payload (buildValidProducts strips it)
    const productGenderMap = {};
    products.forEach(p => {
      if (p.productId) {
        productGenderMap[p.productId.toString()] = (p.genderCategory || '').toLowerCase().trim();
      }
    });

    // ── Build employee query ──────────────────────────────────────────────────
    const empFilter = {
      customerId: { $in: validOrgIds.map(id => new mongoose.Types.ObjectId(id)) },
      status: 'active',
    };
    if (department) empFilter.department = department;
    if (designation) empFilter.designation = designation;
    if (genderFilter === 'Male') empFilter.gender = 'Male';
    if (genderFilter === 'Female') empFilter.gender = 'Female';

    const employees = await EmployeeMpc.find(empFilter)
      .select('_id customerId gender products')
      .lean();

    if (!employees.length) {
      return res.status(200).json({
        success: true,
        message: 'No matching employees found for the given scope',
        updated: 0,
        orgBreakdown: [],
      });
    }

    // ── Org breakdown setup ───────────────────────────────────────────────────
    const orgsForBreakdown = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgBreakdownMap = {};
    orgsForBreakdown.forEach(o => {
      orgBreakdownMap[o._id.toString()] = { orgName: o.name, updated: 0 };
    });

    // ── Build bulkWrite ops ───────────────────────────────────────────────────
    const bulkOps = [];

    for (const emp of employees) {
      const empGender = emp.gender; // "Male" | "Female"

      // Step 1: keep products that are not being touched at all
      //         (neither removed nor part of the incoming batch)
      const retainedProducts = (emp.products || []).filter(p => {
        const pid = p.productId?.toString();
        // ── FIX: strip both explicitly removed pids AND incoming pids (dedup) ──
        return pid && !stripPidSet.has(pid);
      });

      // Step 2: from the incoming batch, only add products whose gender matches
      //         this employee (skip male products for female employees, vice versa)
      const addProducts = validProducts
        .filter(vp => {
          const gc = productGenderMap[vp.productId.toString()] || '';
          if (gc === 'male' && empGender === 'Female') return false;
          if (gc === 'female' && empGender === 'Male') return false;
          return true;
        })
        .map(vp => ({
          productId: vp.productId,
          variantId: vp.variantId || null,
          quantity: vp.quantity || 1,
          productName: vp.productName || '',
        }));

      // Step 3: retained (untouched) + newly assigned
      const finalProducts = [...retainedProducts, ...addProducts];

      bulkOps.push({
        updateOne: {
          filter: { _id: emp._id },
          update: {
            $set: {
              products: finalProducts,
              updatedBy: req.customerId,
            }
          }
        }
      });

      const oid = emp.customerId.toString();
      if (orgBreakdownMap[oid]) orgBreakdownMap[oid].updated++;
    }

    // ── Execute ───────────────────────────────────────────────────────────────
    let totalUpdated = 0;
    if (bulkOps.length > 0) {
      const result = await EmployeeMpc.bulkWrite(bulkOps, { ordered: false });
      totalUpdated = result.modifiedCount || bulkOps.length;
    }

    const orgBreakdown = Object.values(orgBreakdownMap).filter(o => o.updated > 0);

    res.status(200).json({
      success: true,
      message: `Products assigned/removed for ${totalUpdated} employee(s) across ${orgBreakdown.length} organisation(s)`,
      updated: totalUpdated,
      orgBreakdown,
      productsAssigned: validProducts.length,
      productsRemoved: removedPidSet.size,
      scope: {
        orgs: validOrgIds.length,
        department: department || null,
        designation: designation || null,
        genderFilter,
      }
    });

  } catch (error) {
    console.error('cross-org /assign-products error:', error);
    res.status(500).json({ success: false, message: 'Server error while assigning products', error: error.message });
  }
});



router.post('/export-xlsx', verifyCustomerToken, async (req, res) => {
  const ExcelJS = require('exceljs');
  const axios = require('axios');

  try {
    const { orgIds } = req.body;

    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds array is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid organisation IDs provided' });
    }

    // Org name map
    const orgs = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgNameMap = Object.fromEntries(orgs.map(o => [o._id.toString(), o.name]));

    // Fetch all employees across selected orgs, sorted org → dept → name
    const employees = await EmployeeMpc.find({
      customerId: { $in: validOrgIds.map(id => new mongoose.Types.ObjectId(id)) },
    })
      .select('name uin gender department designation products customerId')
      .sort({ customerId: 1, department: 1, name: 1 })
      .lean();

    if (!employees.length) {
      return res.status(404).json({ success: false, message: 'No employees found for selected organisations' });
    }

    // Batch-fetch all StockItems referenced
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

    // Pre-download unique images in parallel
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
        const toThumb = u => u?.includes('/image/upload/')
          ? u.replace('/image/upload/', '/image/upload/w_80,h_80,c_fill,q_70,f_webp/')
          : u;
        const resp = await axios.get(toThumb(url), { responseType: 'arraybuffer', timeout: 8000 });
        imageBufferMap.set(url, Buffer.from(resp.data));
      } catch { /* skip failed images */ }
    }));

    // Build workbook — same visual style as the single-org export
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Employees', { pageSetup: { fitToPage: true, fitToWidth: 1 } });

    const IMG_HEIGHT = 60;

    // 10 columns — adds Organisation before Name
    ws.columns = [
      { header: 'Organisation', key: 'org', width: 22 },
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

    // Header row styling
    ws.getRow(1).height = 20;
    ws.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FF4A5568' } },
        right: { style: 'thin', color: { argb: 'FF4A5568' } },
      };
    });

    const styleCell = (cell, isAlt) => {
      cell.font = { size: 9, name: 'Arial' };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFF7FAFC' : 'FFFFFFFF' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = {
        bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } },
        right: { style: 'hair', color: { argb: 'FFE2E8F0' } },
      };
    };

    let currentOrg = null;
    let currentDept = null;
    let rowIdx = 2;
    let altRow = false;

    for (const emp of employees) {
      const orgId = emp.customerId.toString();
      const orgName = orgNameMap[orgId] || 'Unknown';
      const dept = emp.department || '';

      // Blank separator row between organisations
      if (currentOrg !== null && orgId !== currentOrg) {
        const sep = ws.getRow(rowIdx);
        sep.height = 12;
        ws.mergeCells(rowIdx, 1, rowIdx, 10);
        sep.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE4EE' } };
        sep.getCell(1).value = orgName;
        sep.getCell(1).font = { bold: true, size: 9, name: 'Arial', color: { argb: 'FF2D3748' } };
        sep.getCell(1).alignment = { vertical: 'middle', indent: 1 };
        rowIdx++;
        currentDept = null;
        altRow = false;
      } else if (currentOrg !== null && dept !== currentDept) {
        // Lighter separator between departments within the same org
        const sep = ws.getRow(rowIdx);
        sep.height = 6;
        ws.mergeCells(rowIdx, 1, rowIdx, 10);
        sep.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } };
        rowIdx++;
        altRow = false;
      }

      currentOrg = orgId;
      currentDept = dept;

      // Resolve products
      const productLines = [];
      const imageUrls = [];

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

        productLines.push(`${idx + 1}. ${prodName} | Qty: ${p.quantity || 1}`);
        imageUrls.push(imageUrl);
      });

      const hasAnyImage = imageUrls.some(u => u && imageBufferMap.has(u));
      const validImages = imageUrls.filter(u => u && imageBufferMap.has(u));
      const row = ws.getRow(rowIdx);
      row.height = hasAnyImage ? IMG_HEIGHT * validImages.length : 18;

      const textValues = [
        orgName,
        emp.name,
        emp.uin,
        emp.gender,
        dept,
        emp.designation || '',
        productLines.join('\n') || '',
        '',
        '',
      ];

      textValues.forEach((val, ci) => {
        const cell = row.getCell(ci + 1);
        cell.value = val;
        styleCell(cell, altRow);
      });
      styleCell(row.getCell(10), altRow);
      row.commit();

      // Embed images stacked in Photo column (col 10)
      if (validImages.length > 0) {
        const sliceHeight = 1 / validImages.length;
        validImages.forEach((url, imgIdx) => {
          const buf = imageBufferMap.get(url);
          const ext = (url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png').toLowerCase();
          const type = (ext === 'jpg' || ext === 'jpeg') ? 'jpeg' : ext === 'gif' ? 'gif' : 'png';
          const id = wb.addImage({ buffer: buf, extension: type });
          ws.addImage(id, {
            tl: { col: 9, row: rowIdx - 1 + imgIdx * sliceHeight },
            br: { col: 10, row: rowIdx - 1 + (imgIdx + 1) * sliceHeight },
            editAs: 'oneCell',
          });
        });
      }

      rowIdx++;
      altRow = !altRow;
    }

    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: 'A1', to: 'J1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="cross_org_employees_${new Date().toISOString().split('T')[0]}.xlsx"`
    );
    await wb.xlsx.write(res);
    res.end();

  } catch (error) {
    console.error('cross-org export-xlsx error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Export failed: ' + error.message });
    }
  }
});


module.exports = router;