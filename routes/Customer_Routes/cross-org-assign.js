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
    const removedPidSet  = new Set(removedProductIds.map(id => id.toString()));
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

      // Step 3: retained (untouched) + newly assigned
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

module.exports = router;