// routes/Customer_Routes/RequestCatalogue.js
// ─────────────────────────────────────────────────────────────────────────
// Customer-facing product catalogue for the "New Request" form.
//
// Why this exists separately from /api/customer/requests/available-items:
//   - That endpoint queries the entire StockItem collection ignoring the
//     customer's assignedStockItems whitelist. Result: customers see ALL
//     products in the org instead of just the ones the sales team has
//     authorised for them.
//   - It also has a hardcoded .limit(50), so customers who *do* have
//     larger whitelists (e.g. 71 products) only see 50.
//   - It returns `images` exactly as stored on the StockItem document,
//     which is often [] even when the product's VARIANTS have images —
//     so customers see broken thumbnails in the catalogue.
//
// This endpoint fixes all three:
//   1. Filters strictly by Customer.assignedStockItems. If the customer
//      has no assignments, returns empty (no leaking of other products).
//   2. Supports pagination: `?page=1&limit=12` defaults, hard cap 100.
//   3. Resolves the best image URL per product: top-level images[0] →
//      first variant with images[0] → null. The frontend just uses
//      `product.image` (singular) and doesn't have to do any fallback.
//
// Mount in server.js:
//   const customerRequestCatalogueRoutes = require("./routes/Customer_Routes/RequestCatalogue");
//   app.use("/api/customer/request-catalogue", customerRequestCatalogueRoutes);
// ─────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const Customer = require("../../models/Customer_Models/Customer");
const verifyCustomerToken = require("../../Middlewear/CustomerAuthMiddleware");

// ─── Helper: extract the customer's assigned StockItem ids ───────────────
async function getAssignedStockItemIds(customerId) {
  const customer = await Customer.findById(customerId)
    .select("assignedStockItems")
    .lean();
  if (!customer) return null;
  const assigned = customer.assignedStockItems || [];
  // The schema stores objects like { stockItemId, ... } OR raw ObjectIds —
  // handle both shapes for safety.
  return assigned
    .map((a) => {
      if (!a) return null;
      if (typeof a === "string") return a;
      if (a.stockItemId) return a.stockItemId;
      if (a._id) return a._id;
      return null;
    })
    .filter(Boolean);
}

// ─── Helper: resolve the best image url for a product ────────────────────
// Tries top-level images first, then any variant with images, then null.
function resolveProductImage(item) {
  if (Array.isArray(item.images) && item.images[0]) {
    const first = item.images[0];
    return typeof first === "string" ? first : first?.url || null;
  }
  if (Array.isArray(item.variants)) {
    for (const v of item.variants) {
      if (Array.isArray(v?.images) && v.images[0]) {
        const first = v.images[0];
        return typeof first === "string" ? first : first?.url || null;
      }
    }
  }
  return null;
}

// ─── Helper: shape one product for the frontend ──────────────────────────
function shapeProduct(item) {
  const variants = (item.variants || []).map((v) => ({
    _id: v._id,
    sku: v.sku,
    attributes: v.attributes || [],
    salesPrice: v.salesPrice,
    images: v.images || [],
  }));

  return {
    id: item._id,
    _id: item._id,
    name: item.name,
    reference: item.reference,
    category: item.category,
    genderCategory: item.genderCategory || null,
    baseSalesPrice: item.baseSalesPrice || item.salesPrice || 0,
    image: resolveProductImage(item), // single best URL (used by UI)
    images: item.images || [], // raw array kept for compat
    attributes: (item.attributes || []).map((a) => ({
      name: a.name,
      values: a.values || [],
    })),
    variants,
    hasVariants: variants.length > 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════
// GET /
//   Query params:
//     - search   string  (matches name, reference, category, additionalNames)
//     - category string
//     - page     int     (default 1)
//     - limit    int     (default 12, max 100)
//
//   Response:
//     {
//       success: true,
//       items: [...],
//       categories: ["Aprons", "Trousers", ...],
//       page, limit, total, totalPages, hasMore,
//       hasAssignments: boolean   // false = customer has no assigned items
//     }
// ═════════════════════════════════════════════════════════════════════════
router.get("/", verifyCustomerToken, async (req, res) => {
  try {
    const { search = "", category = "" } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(req.query.limit, 10) || 12),
    );

    // ── Load the customer's whitelist ───────────────────────────────
    const assignedIds = await getAssignedStockItemIds(req.customerId);
    if (assignedIds === null) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }
    if (!assignedIds.length) {
      return res.status(200).json({
        success: true,
        items: [],
        categories: [],
        page: 1,
        limit,
        total: 0,
        totalPages: 0,
        hasMore: false,
        hasAssignments: false,
      });
    }

    // ── Build query ─────────────────────────────────────────────────
    const filter = { _id: { $in: assignedIds } };

    if (search && search.trim()) {
      const q = search.trim();
      const re = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"), "i");
      filter.$or = [
        { name: re },
        { reference: re },
        { category: re },
        { genderCategory: re },
        { additionalNames: re },
        { additionalNames: { $elemMatch: re } },
      ];
    }

    if (category && category.trim()) filter.category = category.trim();

    // ── Count total matching (for pagination) ───────────────────────
    const total = await StockItem.countDocuments(filter);
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const skip = (page - 1) * limit;

    // ── Fetch the current page ──────────────────────────────────────
    const stockItems = await StockItem.find(filter)
      .select(
        "_id name reference category genderCategory baseSalesPrice salesPrice images attributes variants additionalNames",
      )
      .sort({ name: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const items = stockItems.map(shapeProduct);

    // ── Categories list for the filter dropdown ─────────────────────
    // Only categories from the customer's whitelist, not the entire DB.
    const categoryDocs = await StockItem.find({ _id: { $in: assignedIds } })
      .select("category")
      .lean();
    const categories = [
      ...new Set(
        categoryDocs.map((c) => c.category).filter((c) => c && c.trim()),
      ),
    ].sort();

    return res.status(200).json({
      success: true,
      items,
      categories,
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
      hasAssignments: true,
    });
  } catch (error) {
    console.error("[request-catalogue] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error loading catalogue" });
  }
});

module.exports = router;
