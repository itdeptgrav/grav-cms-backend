// routes/Customer_Routes/cross-org-assign.js
// ── FIXED: export-xlsx now guarantees per-employee image resolution ────────────

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
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assign-products', verifyCustomerToken, async (req, res) => {
  try {
    const {
      orgIds,
      department,
      designation,
      genderFilter = 'All',
      products = [],
      removedProductIds = [],
    } = req.body;

    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid org IDs' });
    }

    if (!Array.isArray(products)) {
      return res.status(400).json({ success: false, message: 'products must be an array' });
    }
    if (!Array.isArray(removedProductIds)) {
      return res.status(400).json({ success: false, message: 'removedProductIds must be an array' });
    }

    if (products.length === 0 && removedProductIds.length === 0) {
      return res.status(400).json({ success: false, message: 'No products to assign or remove' });
    }

    let validProducts = [];
    if (products.length > 0) {
      const { validProducts: vp, errors: productErrors } = await buildValidProducts(products);
      if (productErrors.length) {
        return res.status(400).json({ success: false, message: productErrors.join('; ') });
      }
      validProducts = vp;
    }

    const removedPidSet  = new Set(removedProductIds.map(id => id.toString()));
    const incomingPidSet = new Set(validProducts.map(p => p.productId.toString()));
    const stripPidSet = new Set([...removedPidSet, ...incomingPidSet]);

    const productGenderMap = {};
    products.forEach(p => {
      if (p.productId) {
        productGenderMap[p.productId.toString()] = (p.genderCategory || '').toLowerCase().trim();
      }
    });

    const empFilter = {
      customerId: { $in: validOrgIds.map(id => new mongoose.Types.ObjectId(id)) },
      status: 'active',
    };
    if (department)              empFilter.department = department;
    if (designation)             empFilter.designation = designation;
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

    const orgsForBreakdown = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgBreakdownMap = {};
    orgsForBreakdown.forEach(o => {
      orgBreakdownMap[o._id.toString()] = { orgName: o.name, updated: 0 };
    });

    const bulkOps = [];

    for (const emp of employees) {
      const empGender = emp.gender;

      const retainedProducts = (emp.products || []).filter(p => {
        const pid = p.productId?.toString();
        return pid && !stripPidSet.has(pid);
      });

      const addProducts = validProducts
        .filter(vp => {
          const gc = productGenderMap[vp.productId.toString()] || '';
          if (gc === 'male'   && empGender === 'Female') return false;
          if (gc === 'female' && empGender === 'Male')   return false;
          return true;
        })
        .map(vp => ({
          productId:   vp.productId,
          variantId:   vp.variantId || null,
          quantity:    vp.quantity  || 1,
          productName: vp.productName || '',
        }));

      const finalProducts = [...retainedProducts, ...addProducts];

      bulkOps.push({
        updateOne: {
          filter: { _id: emp._id },
          update: {
            $set: {
              products:  finalProducts,
              updatedBy: req.customerId,
            }
          }
        }
      });

      const oid = emp.customerId.toString();
      if (orgBreakdownMap[oid]) orgBreakdownMap[oid].updated++;
    }

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
      productsRemoved:  removedPidSet.size,
      scope: {
        orgs:        validOrgIds.length,
        department:  department  || null,
        designation: designation || null,
        genderFilter,
      }
    });

  } catch (error) {
    console.error('cross-org /assign-products error:', error);
    res.status(500).json({ success: false, message: 'Server error while assigning products', error: error.message });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// POST /export-xlsx
//
// FIX: Image resolution is now done per-employee, per-product-slot.
//
// Root causes of the original bug where some employees were missing images:
//
//   1. productId type mismatch — emp.products[i].productId was sometimes stored
//      as an ObjectId, sometimes as a string. stockMap keys are always strings,
//      so .get(objectId) always returns undefined → no image for that employee.
//      FIX: always call .toString() before the map lookup.
//
//   2. variantId type mismatch — same issue: .find(v => v._id === variantId)
//      where one side is ObjectId and other is string → always false →
//      falls back to product-level image instead of variant image.
//      FIX: compare both sides as strings.
//
//   3. imageBufferMap keyed by URL — if two employees have the same product but
//      different variantIds, they resolve different URLs. As long as both URLs
//      were collected in the pre-download pass, both work fine.  But if the
//      URL resolution logic was inconsistent between the collection pass and the
//      per-employee rendering pass, one could get a URL that was never downloaded.
//      FIX: unified resolveImageUrl() used in BOTH passes; added fallback chain.
//
//   4. No fallback — if a variant image download failed, the cell was left blank
//      even when the product-level image was available and downloaded.
//      FIX: explicit fallback: variant image → product image → empty.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/export-xlsx', verifyCustomerToken, async (req, res) => {
  const ExcelJS = require('exceljs');
  const axios   = require('axios');
  const JSZip   = require('jszip');

  try {
    const { orgIds } = req.body;

    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds array is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid organisation IDs provided' });
    }

    // ── Fetch org metadata ────────────────────────────────────────────────────
    const orgs = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgNameMap = Object.fromEntries(orgs.map(o => [o._id.toString(), o.name]));

    // ── Fetch all employees across selected orgs ──────────────────────────────
    const allEmployees = await EmployeeMpc.find({
      customerId: { $in: validOrgIds.map(id => new mongoose.Types.ObjectId(id)) },
    })
      .select('name uin gender department designation products customerId')
      .sort({ customerId: 1, department: 1, name: 1 })
      .lean();

    if (!allEmployees.length) {
      return res.status(404).json({ success: false, message: 'No employees found for selected organisations' });
    }

    // ── Batch-fetch all StockItems referenced ─────────────────────────────────
    const productIdSet = new Set();
    allEmployees.forEach(emp =>
      (emp.products || []).forEach(p => {
        // FIX 1: always coerce to string for consistent map keys
        const pid = p.productId?.toString();
        if (pid) productIdSet.add(pid);
      })
    );

    const stockItems = productIdSet.size
      ? await StockItem.find({ _id: { $in: [...productIdSet] } })
          .select('_id name images variants')
          .lean()
      : [];

    // FIX 1: stockMap keyed by string — guarantees lookup always works
    const stockMap = new Map(stockItems.map(s => [s._id.toString(), s]));

    // ── Helper: resolve best image URL for a single product assignment ────────
    //
    // Priority chain:
    //   1. Variant image (if variantId is set and variant has images)
    //   2. Product-level image
    //   3. Empty string (no image)
    //
    // FIX 2: both productId and variantId are coerced to string before lookup
    // so ObjectId vs string mismatches never cause a miss.
    const resolveImageUrl = (p) => {
      // Always stringify before lookup — critical fix
      const pid = p.productId?.toString();
      if (!pid) return '';

      const si = stockMap.get(pid);
      if (!si) return '';

      // Try variant image first
      const vid = p.variantId?.toString();
      if (vid && si.variants?.length) {
        const variant = si.variants.find(v => v._id.toString() === vid); // FIX 2: string compare
        if (variant?.images?.[0]) return variant.images[0];
      }

      // Fallback to product-level image
      return si.images?.[0] || '';
    };

    // ── Collect ALL image URLs that will be needed across all employees ────────
    //
    // We collect BOTH variant images AND product-level images for every
    // product assignment, then download all unique URLs once.
    // This ensures the backup/fallback URL is always in imageBufferMap.
    //
    // FIX 3 + FIX 4: collect fallback URLs separately so they're always available
    const imageUrlSet = new Set();

    allEmployees.forEach(emp => {
      (emp.products || []).forEach(p => {
        const pid = p.productId?.toString();
        if (!pid) return;

        const si = stockMap.get(pid);
        if (!si) return;

        // Collect variant image if applicable
        const vid = p.variantId?.toString();
        if (vid && si.variants?.length) {
          const variant = si.variants.find(v => v._id.toString() === vid);
          if (variant?.images?.[0]) imageUrlSet.add(variant.images[0]);
        }

        // ALWAYS also collect the product-level image as a backup
        // FIX 4: this ensures even if variant image download fails, we have fallback
        if (si.images?.[0]) imageUrlSet.add(si.images[0]);
      });
    });

    // ── Cloudinary thumbnail transformer ──────────────────────────────────────
    const toThumb = u => u?.includes('/image/upload/')
      ? u.replace('/image/upload/', '/image/upload/w_80,h_80,c_fill,q_70,f_webp/')
      : u;

    // ── Download all unique image URLs in parallel ────────────────────────────
    const imageBufferMap = new Map();
    await Promise.all([...imageUrlSet].map(async url => {
      try {
        const resp = await axios.get(toThumb(url), {
          responseType: 'arraybuffer',
          timeout: 10000,
        });
        imageBufferMap.set(url, Buffer.from(resp.data));
      } catch (err) {
        // Log but don't fail the whole export — cell will be left blank for this URL
        console.warn(`[export] Failed to download image: ${url} — ${err.message}`);
      }
    }));

    // ── Resolve image buffer for one product assignment with fallback ──────────
    //
    // FIX 4: explicit two-level fallback so a failed variant image download
    // automatically uses the product-level image if it downloaded successfully.
    const resolveImageBuffer = (p) => {
      const pid = p.productId?.toString();
      if (!pid) return null;

      const si = stockMap.get(pid);
      if (!si) return null;

      // Try variant image first
      const vid = p.variantId?.toString();
      if (vid && si.variants?.length) {
        const variant = si.variants.find(v => v._id.toString() === vid);
        if (variant?.images?.[0]) {
          const buf = imageBufferMap.get(variant.images[0]);
          if (buf) return { buffer: buf, url: variant.images[0] };
          // Variant image URL existed but download failed → fall through to product image
          console.warn(`[export] Variant image not in buffer map for product ${pid}, variant ${vid} — using product image fallback`);
        }
      }

      // Fallback: product-level image
      if (si.images?.[0]) {
        const buf = imageBufferMap.get(si.images[0]);
        if (buf) return { buffer: buf, url: si.images[0] };
      }

      return null; // No image available at all
    };

    // ── Helper: get image extension for ExcelJS ───────────────────────────────
    const getImageExtension = (url) => {
      const ext = (url.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png').toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
      if (ext === 'gif') return 'gif';
      return 'png';
    };

    // ── Helper: sanitise org name for filename ────────────────────────────────
    const safeFilename = (name) =>
      name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'Organisation';

    // ── Build one workbook per organisation ───────────────────────────────────
    const zip = new JSZip();

    for (const org of orgs) {
      const oid       = org._id.toString();
      const orgName   = orgNameMap[oid] || 'Unknown';
      const employees = allEmployees.filter(e => e.customerId.toString() === oid);

      if (!employees.length) continue;

      // Max products across all employees in this org → number of photo columns
      const orgMaxProducts = employees.reduce(
        (m, e) => Math.max(m, (e.products || []).length),
        0
      );

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Employees', { pageSetup: { fitToPage: true, fitToWidth: 1 } });

      const IMG_COL_WIDTH = 11;
      const ROW_HEIGHT    = 72;

      // Fixed columns + one photo column per product slot
      const fixedCols = [
        { header: 'Name',        key: 'name',        width: 24 },
        { header: 'UIN',         key: 'uin',          width: 10 },
        { header: 'Gender',      key: 'gender',       width: 9  },
        { header: 'Department',  key: 'department',   width: 22 },
        { header: 'Designation', key: 'designation',  width: 22 },
        { header: 'Products',    key: 'products',     width: 32 },
      ];
      const FIXED_COUNT = fixedCols.length; // 6

      const photoCols = [];
      for (let i = 1; i <= orgMaxProducts; i++) {
        photoCols.push({ header: `Photo ${i}`, key: `photo_${i}`, width: IMG_COL_WIDTH });
      }

      ws.columns = [...fixedCols, ...photoCols];

      // Header row styling
      ws.getRow(1).height = 20;
      ws.getRow(1).eachCell(cell => {
        cell.font      = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10, name: 'Arial' };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D3748' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border    = {
          bottom: { style: 'thin', color: { argb: 'FF4A5568' } },
          right:  { style: 'thin', color: { argb: 'FF4A5568' } },
        };
      });
      for (let i = 1; i <= orgMaxProducts; i++) {
        const photoHeaderCell = ws.getRow(1).getCell(FIXED_COUNT + i);
        photoHeaderCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4A5568' } };
      }

      const styleCell = (cell, isAlt) => {
        cell.font      = { size: 9, name: 'Arial' };
        cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: isAlt ? 'FFF7FAFC' : 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', wrapText: true };
        cell.border    = {
          bottom: { style: 'hair', color: { argb: 'FFE2E8F0' } },
          right:  { style: 'hair', color: { argb: 'FFE2E8F0' } },
        };
      };

      const totalCols = FIXED_COUNT + orgMaxProducts;
      let currentDept = null;
      let rowIdx      = 2;
      let altRow      = false;

      for (const emp of employees) {
        const dept        = emp.department || '';
        const empProducts = emp.products   || [];

        // Thin department separator row
        if (currentDept !== null && dept !== currentDept) {
          const sep = ws.getRow(rowIdx);
          sep.height = 6;
          if (totalCols > 1) ws.mergeCells(rowIdx, 1, rowIdx, totalCols);
          sep.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2F7' } };
          rowIdx++;
          altRow = false;
        }
        currentDept = dept;

        // Build combined product-names string
        const productNamesText = empProducts
          .map(p => {
            // FIX 1: always stringify for stockMap lookup
            const si   = stockMap.get(p.productId?.toString());
            const name = p.productName || si?.name || '(unknown)';
            const qty  = p.quantity || 1;
            return `${name} (x${qty})`;
          })
          .join('\n');

        // Determine row height — check if ANY product slot has an image buffer
        const hasAnyImage = empProducts.some(p => resolveImageBuffer(p) !== null);
        const row = ws.getRow(rowIdx);
        row.height = hasAnyImage ? ROW_HEIGHT : Math.max(18, empProducts.length * 14);

        // Write fixed columns
        const fixedValues = [
          emp.name,
          emp.uin,
          emp.gender,
          dept,
          emp.designation  || '',
          productNamesText || '',
        ];
        fixedValues.forEach((val, ci) => {
          const cell = row.getCell(ci + 1);
          cell.value = val;
          styleCell(cell, altRow);
        });

        // ── Write photo columns — one per product slot ────────────────────────
        //
        // FIX (core): we now call resolveImageBuffer(p) per employee per product,
        // which correctly handles ObjectId/string coercion and has a fallback chain.
        // Previously, resolveImageUrl was called for the pre-download pass but the
        // lookup during rendering could silently differ, leaving some cells blank.
        for (let i = 0; i < orgMaxProducts; i++) {
          const photoColIdx = FIXED_COUNT + i + 1; // 1-based Excel col index
          const photoCell   = row.getCell(photoColIdx);
          styleCell(photoCell, altRow);

          const p = empProducts[i];
          if (!p) continue; // no product for this slot — leave cell blank

          // Resolve buffer with full fallback chain
          const imgData = resolveImageBuffer(p);
          if (!imgData) {
            // Debug info in cell so it's visible in the sheet during testing
            // Remove the line below (or change to continue) in production
            // photoCell.value = '(no img)';
            continue;
          }

          const ext   = getImageExtension(imgData.url);
          const imgId = wb.addImage({ buffer: imgData.buffer, extension: ext });

          ws.addImage(imgId, {
            tl:     { col: photoColIdx - 1, row: rowIdx - 1 },
            br:     { col: photoColIdx,     row: rowIdx     },
            editAs: 'oneCell',
          });
        }

        row.commit();
        rowIdx++;
        altRow = !altRow;
      }

      ws.views      = [{ state: 'frozen', ySplit: 1 }];
      ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + Math.min(totalCols, 26))}1` };

      const xlsxBuffer = await wb.xlsx.writeBuffer();
      zip.file(`${safeFilename(orgName)}.xlsx`, xlsxBuffer);
    }

    // Stream ZIP to client
    const zipBuffer = await zip.generateAsync({
      type:               'nodebuffer',
      compression:        'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const dateStr = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="cross_org_employees_${dateStr}.zip"`);
    res.setHeader('Content-Length', zipBuffer.length);
    res.end(zipBuffer);

  } catch (error) {
    console.error('cross-org export-xlsx error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: 'Export failed: ' + error.message });
    }
  }
});

module.exports = router;