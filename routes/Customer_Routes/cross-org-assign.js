// routes/Customer_Routes/cross-org-assign.js

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const Customer = require('../../models/Customer_Models/Customer');
const EmployeeMpc = require('../../models/Customer_Models/Employee_Mpc');
const StockItem = require('../../models/CMS_Models/Inventory/Products/StockItem');

// ─── Auth middleware (same pattern as employees.js) ───────────────────────────
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

// ─── Helper: build & validate product array (identical to employees.js) ───────
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
// Returns all Customer organisations + their active employee counts.
// The logged-in token is used to scope to the same sales portal that manages
// employee records (EmployeeMpc.customerId references Customer._id).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/organisations', verifyCustomerToken, async (req, res) => {
  try {
    // Fetch all Customers (organisations)
    const customers = await Customer.find({})
      .select('_id name email phone')
      .sort({ name: 1 })
      .lean();

    if (!customers.length) {
      return res.status(200).json({ success: true, organisations: [] });
    }

    // Count active employees per customer in one aggregation
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
// Body: { orgIds: ["id1", "id2", ...] }
// Returns all active employees from the given org IDs, enriched with orgName.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/employees', verifyCustomerToken, async (req, res) => {
  try {
    const { orgIds } = req.body;

    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds array is required' });
    }

    // Validate all IDs are valid ObjectIds
    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid organisation IDs provided' });
    }

    // Fetch org names for enrichment
    const orgs = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    const orgNameMap = Object.fromEntries(orgs.map(o => [o._id.toString(), o.name]));

    // Fetch all active employees from these orgs
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
//   orgIds       – array of org IDs to scope
//   department   – filter by department (null = all depts)
//   designation  – filter by designation (null = all desigs within dept)
//   genderFilter – "All" | "Male" | "Female"
//   products     – array of { productId, variantId, quantity, productName, genderCategory }
//
// Logic:
//   1. Validate products
//   2. Find all scoped employees (by orgIds + dept + desig + gender)
//   3. For each employee:
//      a. Remove any existing entries for the same productIds (replace, not duplicate)
//      b. Apply gender restriction: Male product → skip Female employees, vice-versa
//      c. Append/replace products
//   4. BulkWrite all updates in one query per org
// ─────────────────────────────────────────────────────────────────────────────
router.post('/assign-products', verifyCustomerToken, async (req, res) => {
  try {
    const { orgIds, department, designation, genderFilter = 'All', products } = req.body;

    // ── Validation ────────────────────────────────────────────────────────────
    if (!Array.isArray(orgIds) || !orgIds.length) {
      return res.status(400).json({ success: false, message: 'orgIds is required' });
    }
    if (!Array.isArray(products) || !products.length) {
      return res.status(400).json({ success: false, message: 'products array is required' });
    }

    const validOrgIds = orgIds.filter(id => mongoose.Types.ObjectId.isValid(id));
    if (!validOrgIds.length) {
      return res.status(400).json({ success: false, message: 'No valid org IDs' });
    }

    // Validate & resolve products (batch fetch StockItems once)
    const { validProducts, errors: productErrors } = await buildValidProducts(products);
    if (productErrors.length) {
      return res.status(400).json({ success: false, message: productErrors.join('; ') });
    }
    if (!validProducts.length) {
      return res.status(400).json({ success: false, message: 'No valid products after validation' });
    }

    // Keep genderCategory from original payload for restriction logic
    // (buildValidProducts strips it — we re-attach from req body)
    const productGenderMap = {};
    products.forEach(p => {
      if (p.productId) productGenderMap[p.productId.toString()] = (p.genderCategory || '').toLowerCase().trim();
    });

    // ── Build employee filter ─────────────────────────────────────────────────
    const empFilter = {
      customerId: { $in: validOrgIds.map(id => new mongoose.Types.ObjectId(id)) },
      status: 'active',
    };
    if (department) empFilter.department = department;
    if (designation) empFilter.designation = designation;
    if (genderFilter === 'Male') empFilter.gender = 'Male';
    if (genderFilter === 'Female') empFilter.gender = 'Female';

    // Fetch all matching employees
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

    // ── Build bulkWrite ops ───────────────────────────────────────────────────
    // For each employee:
    //   - keep all existing products whose productId is NOT in the new batch
    //   - then add the new ones (with gender restriction per-employee)
    const incomingPidSet = new Set(validProducts.map(p => p.productId.toString()));

    const orgBreakdownMap = {};   // orgId → { orgName, updated }

    // Fetch org names for breakdown
    const orgsForBreakdown = await Customer.find({ _id: { $in: validOrgIds } })
      .select('_id name')
      .lean();
    orgsForBreakdown.forEach(o => {
      orgBreakdownMap[o._id.toString()] = { orgName: o.name, updated: 0 };
    });

    const bulkOps = [];

    for (const emp of employees) {
      const empGender = emp.gender; // "Male" or "Female"

      // 1. Keep products not touched by this assignment
      const retainedProducts = (emp.products || []).filter(p => {
        const pid = p.productId?.toString();
        return pid && !incomingPidSet.has(pid);
      });

      // 2. Add new products with gender restriction
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

      // Track per-org count
      const oid = emp.customerId.toString();
      if (orgBreakdownMap[oid]) orgBreakdownMap[oid].updated++;
    }

    // ── Execute bulkWrite ─────────────────────────────────────────────────────
    let totalUpdated = 0;
    if (bulkOps.length > 0) {
      const result = await EmployeeMpc.bulkWrite(bulkOps, { ordered: false });
      totalUpdated = result.modifiedCount || bulkOps.length;
    }

    const orgBreakdown = Object.values(orgBreakdownMap).filter(o => o.updated > 0);

    res.status(200).json({
      success: true,
      message: `Products assigned to ${totalUpdated} employee(s) across ${orgBreakdown.length} organisation(s)`,
      updated: totalUpdated,
      orgBreakdown,
      productsAssigned: validProducts.length,
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

module.exports = router;