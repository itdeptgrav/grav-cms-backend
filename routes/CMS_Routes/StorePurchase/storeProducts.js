// routes/CMS_Routes/StorePurchase/storeProducts.js
//
// STORE → FINISHED PRODUCTS & BOM (read-only bridge)
//
// Exposes the legacy StockItem catalogue (finished/semi-finished products, their
// variants, BOM and operations) inside the Store shell, READ ONLY. It never
// writes StockItem, never touches its schema or write routes, never derives
// costing, and never mixes it with the accountant's Acc_StockItem.
//
// StockItem has no companyId, so this is only offered in an unambiguously
// single-company deployment (the codebase's existing premise); otherwise it
// returns a clear unavailable state instead of listing every company's products.
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
const { Acc_Company } = require("../../../models/Accountant_model/Acc_MasterModels");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability } = require("../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../services/storePurchase/capabilities");
const bridge = require("../../../services/storePurchase/productCatalogueBridge.service");

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

// The Products & BOM editor is owned by other applications. A link is offered
// only to a session whose role already reaches one of those apps; a Store role
// gets no edit affordance at all (this bridge is read-only).
const EDITOR_BY_ROLE = {
  project_manager: (id) => `/project-manager/products/stock-item-view/${id}`,
  sales: (id) => `/sales/dashboard/stock-items/stock-item-view/${id}`,
  owner: (id) => `/project-manager/products/stock-item-view/${id}`,
};
const editorFor = (role, id) => {
  const build = EDITOR_BY_ROLE[role];
  return { accessible: Boolean(build), href: build ? build(id) : null };
};

// Is the deployment unambiguously single-company? (limit 2 == the existing
// serviceScope/salesScope premise.) A DB failure is an outage, not "no data".
async function deploymentAvailability() {
  let companies;
  try {
    companies = await Acc_Company.find({}).select("_id").limit(2).lean();
  } catch (err) {
    console.error("[store-products] company lookup failed:", err?.message || err);
    return { available: false, code: "OUTAGE", reason: "Company access could not be checked just now. Try again in a moment." };
  }
  return bridge.assessDeployment(companies.length);
}

const unavailablePayload = (a) => ({
  success: true, available: false,
  unavailable: { code: a.code, reason: a.reason },
  limitations: [bridge.LIMITATIONS.sharedCatalogue],
});

// ─────────────────────────────────────────────────────────────────────────────
// GET / — the read-only finished-product register (server-paginated + searched)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const avail = await deploymentAvailability();
    if (!avail.available) return res.status(avail.code === "OUTAGE" ? 503 : 200).json(unavailablePayload(avail));

    const q = req.query || {};
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 20));
    const skip = (page - 1) * pageSize;

    // Read-only StockItem query. Mirrors the existing list route's active filter
    // and search fields; adds honest presence filters (variants / BOM).
    const filter = { isActive: { $ne: false } };
    const search = typeof q.search === "string" ? q.search.trim() : "";
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { reference: rx }, { "variants.sku": rx }, { additionalNames: rx }];
    }
    if (typeof q.category === "string" && q.category.trim()) filter.category = q.category.trim();
    if (typeof q.status === "string" && q.status.trim()) filter.status = q.status.trim();
    if (q.hasVariants === "true") filter["variants.0"] = { $exists: true };
    // "Has BOM" = at least one variant carries at least one raw-item line.
    if (q.hasBom === "true") filter.variants = { $elemMatch: { "rawItems.0": { $exists: true } } };

    const [totalItems, docs, categories] = await Promise.all([
      StockItem.countDocuments(filter),
      StockItem.find(filter)
        .select("name reference category genderCategory productType variants operations isActive status updatedAt createdAt")
        .sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      StockItem.distinct("category", { isActive: { $ne: false } }),
    ]);

    const products = docs.map(bridge.catalogueRow);
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

    res.json({
      success: true, available: true,
      products,
      // Counts describe the full backend result, not the loaded page.
      pagination: { page, pageSize, totalItems, totalPages, hasNextPage: page < totalPages, hasPrevPage: page > 1 },
      filters: { categories: categories.filter(Boolean).sort(), statuses: ["In Stock", "Low Stock", "Out of Stock"] },
      editorAccess: editorFor(req.user && req.user.role, null).accessible,
      companyScoped: false,
      limitations: [bridge.LIMITATIONS.sharedCatalogue, bridge.LIMITATIONS.legacyQuantity],
    });
  } catch (error) {
    console.error("[store-products] list error:", error);
    res.status(500).json({ success: false, message: "Server error while loading the product catalogue" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id — read-only product preview (identity, variants, BOM, operations)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    const avail = await deploymentAvailability();
    if (!avail.available) return res.status(avail.code === "OUTAGE" ? 503 : 200).json(unavailablePayload(avail));

    // GET /:id resolves an archived product too (history stays readable), unlike
    // the register which lists only active ones.
    const doc = await StockItem.findById(req.params.id)
      .select("name reference additionalNames category genderCategory productType hsnCode unit variants operations images isActive createdAt updatedAt")
      .lean();
    if (!doc) return res.status(404).json({ success: false, message: "Product not found" });

    res.json({
      success: true, available: true,
      product: bridge.catalogueDetail(doc),
      editor: editorFor(req.user && req.user.role, String(doc._id)),
      companyScoped: false,
      limitations: [bridge.LIMITATIONS.sharedCatalogue, bridge.LIMITATIONS.legacyQuantity],
    });
  } catch (error) {
    console.error("[store-products] detail error:", error);
    res.status(500).json({ success: false, message: "Server error while loading the product" });
  }
});

module.exports = router;
