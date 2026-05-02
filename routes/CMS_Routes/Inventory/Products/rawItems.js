// routes/Cms_routes/Inventory/Products/rawItems.js
//
// Refactored from your existing file. Changes:
//   1. REMOVED: item-level /vendor-nicknames endpoints (3 routes)
//   2. ADDED: per-variant /:id/variants/:variantId/vendor-nicknames endpoints (4 routes)
//   3. UPDATED: GET /:id populates variants.vendorNicknames.vendor
//   4. UPDATED: PUT /:id matches incoming variants by _id first, then combination
//      — preserves variant.image + variant.vendorNicknames if not in payload
//   5. UPDATED: POST / accepts variant.image + variant.vendorNicknames
//
// Everything else (auth middleware, embedded stockTransactions, primaryVendor,
// alternateVendors, suppliers history, purchase orders, etc.) is untouched.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const RAW_ITEM_CATEGORIES = [
  "Fabric", "Thread", "Fasteners", "Elastic", "Interlining",
  "Trims", "Chemicals", "Patterns", "Labels", "Packaging",
  "Accessories", "Dyes", "Buttons", "Zippers", "Laces",
  "Ribbons", "Cords", "Tapes", "Piping", "Webbing"
];

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const computeStatus = (qty, minStock) => {
  const q = Number(qty) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "Out of Stock";
  if (q <= m) return "Low Stock";
  return "In Stock";
};

const applyComputedStatus = (item) => {
  if (!item) return item;
  item.status = computeStatus(item.quantity, item.minStock);
  if (Array.isArray(item.variants)) {
    item.variants = item.variants.map(v => ({
      ...v,
      status: computeStatus(v.quantity, v.minStock ?? item.minStock)
    }));
  }
  return item;
};

// Match incoming variant payload to existing variant doc:
// → first by _id (most reliable),
// → fallback by exact combination.
const matchExistingVariant = (incoming, existingList) => {
  if (incoming._id) {
    const byId = existingList.find(e => e._id?.toString() === incoming._id.toString());
    if (byId) return byId;
  }
  if (Array.isArray(incoming.combination) && incoming.combination.length) {
    return existingList.find(e =>
      Array.isArray(e.combination) &&
      e.combination.length === incoming.combination.length &&
      e.combination.every((v, i) => v === incoming.combination[i])
    );
  }
  return null;
};

// Normalise per-variant vendorNicknames input
const normaliseVariantNicknames = (incoming) => {
  if (!Array.isArray(incoming)) return null;
  return incoming
    .filter(vn => vn && vn.vendor && vn.nickname && vn.nickname.toString().trim())
    .map(vn => ({
      _id: vn._id && mongoose.Types.ObjectId.isValid(vn._id) ? vn._id : undefined,
      vendor: vn.vendor,
      nickname: vn.nickname.toString().trim(),
      notes: (vn.notes || "").toString().trim()
    }));
};

// ─────────────────────────────────────────────────────────────────────────────
// GET all raw items (pagination, search, filter)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const {
      search = "",
      status,
      category,
      page = 1,
      limit = 20
    } = req.query;

    const pageNum = parseInt(page) || 1;
    const limitNum = parseInt(limit) || 20;
    const skip = (pageNum - 1) * limitNum;

    let filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { customCategory: { $regex: search, $options: "i" } }
      ];
    }

    if (category) {
      filter.$or = [
        { category: category },
        { customCategory: category }
      ];
    }

    let rawItems = await RawItem.find(filter)
      .select("-stockTransactions")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .sort({ createdAt: -1 })
      .lean();

    rawItems = rawItems.map(applyComputedStatus);

    if (status) {
      rawItems = rawItems.filter(it => it.status === status);
    }

    const totalItems = rawItems.length;
    const paged = rawItems.slice(skip, skip + limitNum);

    const allForStats = await RawItem.find({})
      .select("quantity minStock variants")
      .lean();

    let total = 0, lowStock = 0, outOfStock = 0, totalVariants = 0;
    allForStats.forEach(it => {
      total++;
      const s = computeStatus(it.quantity, it.minStock);
      if (s === "Low Stock") lowStock++;
      else if (s === "Out of Stock") outOfStock++;
      if (Array.isArray(it.variants)) totalVariants += it.variants.length;
    });

    res.json({
      success: true,
      rawItems: paged,
      pagination: {
        total: totalItems,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalItems / limitNum) || 1,
        hasNextPage: pageNum < Math.ceil(totalItems / limitNum),
        hasPrevPage: pageNum > 1
      },
      stats: {
        total,
        lowStock,
        outOfStock,
        totalVariants
      },
      filters: {
        categories: RAW_ITEM_CATEGORIES,
        statuses: ["In Stock", "Low Stock", "Out of Stock"]
      }
    });

  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items"
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET units
// ─────────────────────────────────────────────────────────────────────────────
router.get("/units", async (req, res) => {
  try {
    const units = await Unit.find({ status: "Active" })
      .select("name gstUqc")
      .sort({ name: 1 });

    res.json({
      success: true,
      units: units.map(u => u.name)
    });

  } catch (error) {
    console.error("Error fetching units:", error);
    res.status(500).json({ success: false, message: "Server error while fetching units" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET suppliers
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suppliers", async (req, res) => {
  try {
    const suppliers = await Vendor.find({ status: "Active" })
      .select("companyName vendorType")
      .sort({ companyName: 1 });

    res.json({
      success: true,
      suppliers: suppliers.map(s => ({
        id: s._id,
        name: s.companyName,
        type: s.vendorType
      }))
    });

  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ success: false, message: "Server error while fetching suppliers" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET categories
// ─────────────────────────────────────────────────────────────────────────────
router.get("/data/categories", async (req, res) => {
  res.json({ success: true, categories: RAW_ITEM_CATEGORIES });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET raw item by ID — populates variants.vendorNicknames.vendor
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .populate("alternateVendors", "companyName")
      .populate({
        path: "variants.vendorNicknames.vendor",
        select: "companyName contactPerson email phone"
      })
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    applyComputedStatus(rawItem);

    res.json({ success: true, rawItem });

  } catch (error) {
    console.error("Error fetching raw item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw item" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      name,
      category,
      customCategory,
      unit,
      customUnit,
      minStock,
      maxStock,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Item name is required" });
    }
    if (!category && !customCategory) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    if (!unit && !customUnit) {
      return res.status(400).json({ success: false, message: "Unit of measurement is required" });
    }
    if (minStock === undefined || isNaN(minStock) || minStock < 0) {
      return res.status(400).json({ success: false, message: "Valid minimum stock is required" });
    }
    if (maxStock === undefined || isNaN(maxStock) || maxStock < 0) {
      return res.status(400).json({ success: false, message: "Valid maximum stock is required" });
    }
    if (parseFloat(minStock) >= parseFloat(maxStock)) {
      return res.status(400).json({ success: false, message: "Maximum stock must be greater than minimum stock" });
    }

    if (attributes && Array.isArray(attributes)) {
      for (let attr of attributes) {
        if (!attr.name || !attr.name.trim()) {
          return res.status(400).json({ success: false, message: "Attribute name is required" });
        }
        if (!attr.values || !Array.isArray(attr.values) || attr.values.length === 0) {
          return res.status(400).json({ success: false, message: `Attribute "${attr.name}" must have at least one value` });
        }
      }
    }

    // Generate SKU
    const nameWords = name.trim().split(' ');
    const nameCode = nameWords.map(word => word.substring(0, 3).toUpperCase()).join('');
    const finalCategory = customCategory?.trim() || category;
    const categoryCode = finalCategory.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const sku = `RAW-${categoryCode}-${nameCode}-${randomNum}`;

    const existingItem = await RawItem.findOne({ sku });
    if (existingItem) {
      return res.status(400).json({ success: false, message: "An item with similar SKU already exists. Please try again." });
    }

    // Process variants — accept image + per-variant vendorNicknames
    let processedVariants = [];
    if (variants && Array.isArray(variants)) {
      processedVariants = variants.map(variant => {
        const out = {
          combination: variant.combination || [],
          quantity: parseFloat(variant.quantity) || 0,
          minStock: parseFloat(variant.minStock) || parseFloat(minStock) || 0,
          maxStock: parseFloat(variant.maxStock) || parseFloat(maxStock) || 0,
          sku: variant.sku || "",
          image: variant.image || ""
        };
        const nks = normaliseVariantNicknames(variant.vendorNicknames);
        if (nks) out.vendorNicknames = nks;
        return out;
      });
    }

    const totalQuantity = processedVariants.reduce((total, variant) => {
      return total + (variant.quantity || 0);
    }, 0);

    const newRawItem = new RawItem({
      name: name.trim(),
      sku: sku.toUpperCase(),
      category: customCategory ? "" : (category || ""),
      customCategory: customCategory || "",
      unit: customUnit ? "" : (unit || ""),
      customUnit: customUnit || "",
      quantity: totalQuantity,
      minStock: parseFloat(minStock),
      maxStock: parseFloat(maxStock),
      discounts: discounts && Array.isArray(discounts)
        ? discounts
            .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
            .map(d => ({
              minQuantity: parseFloat(d.minQuantity),
              price: parseFloat(d.price)
            }))
        : [],
      attributes: attributes && Array.isArray(attributes)
        ? attributes
            .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(val => val && val.trim())
            }))
        : [],
      variants: processedVariants,
      description: description ? description.trim() : "",
      notes: notes ? notes.trim() : "",
      createdBy: req.user.id
    });

    await newRawItem.save();

    res.status(201).json({
      success: true,
      message: "Raw item registered successfully",
      rawItem: newRawItem
    });

  } catch (error) {
    console.error("Error creating raw item:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Item with this SKU already exists" });
    }
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: "Validation error: " + error.message,
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: "Server error while creating raw item: " + error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE — preserves variant.image + variant.vendorNicknames if not in payload,
//          matches by _id first then by combination
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const {
      name,
      category,
      customCategory,
      unit,
      customUnit,
      quantity,
      minStock,
      maxStock,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    if (name !== undefined && name.trim()) rawItem.name = name.trim();

    if (category !== undefined || customCategory !== undefined) {
      if (customCategory && customCategory.trim()) {
        rawItem.category = "";
        rawItem.customCategory = customCategory.trim();
      } else if (category !== undefined) {
        rawItem.category = category.trim();
        rawItem.customCategory = "";
      }
    }

    if (unit !== undefined || customUnit !== undefined) {
      if (customUnit && customUnit.trim()) {
        rawItem.unit = "";
        rawItem.customUnit = customUnit.trim();
      } else if (unit !== undefined) {
        rawItem.unit = unit.trim();
        rawItem.customUnit = "";
      }
    }

    if (minStock !== undefined && !isNaN(minStock)) rawItem.minStock = parseFloat(minStock);
    if (maxStock !== undefined && !isNaN(maxStock)) rawItem.maxStock = parseFloat(maxStock);

    if (discounts !== undefined) {
      rawItem.discounts = Array.isArray(discounts)
        ? discounts
            .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
            .map(d => ({
              minQuantity: parseFloat(d.minQuantity),
              price: parseFloat(d.price)
            }))
        : [];
    }

    if (attributes !== undefined) {
      rawItem.attributes = Array.isArray(attributes)
        ? attributes
            .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(val => val && val.trim())
            }))
        : [];
    }

    // ── Variants: match by _id first, then combination, preserve image+nicknames ──
    if (variants !== undefined) {
      if (Array.isArray(variants)) {
        const oldVariants = rawItem.variants.map(v => v.toObject ? v.toObject() : v);

        const newVariants = variants.map(incoming => {
          const existing = matchExistingVariant(incoming, oldVariants);

          // image: if explicitly in payload (even ""), respect it; else preserve
          const image = incoming.image !== undefined
            ? (incoming.image || "")
            : (existing?.image || "");

          // vendorNicknames: if payload has the array, replace; else preserve
          let nicknames;
          if (Array.isArray(incoming.vendorNicknames)) {
            nicknames = normaliseVariantNicknames(incoming.vendorNicknames) || [];
          } else {
            nicknames = existing?.vendorNicknames || [];
          }

          return {
            _id: existing?._id, // preserve where possible
            combination: incoming.combination || existing?.combination || [],
            quantity: parseFloat(incoming.quantity ?? existing?.quantity ?? 0) || 0,
            minStock: parseFloat(incoming.minStock ?? existing?.minStock ?? rawItem.minStock) || 0,
            maxStock: parseFloat(incoming.maxStock ?? existing?.maxStock ?? rawItem.maxStock) || 0,
            sku: incoming.sku ?? existing?.sku ?? "",
            image,
            vendorNicknames: nicknames,
            status: incoming.status || existing?.status || "In Stock"
          };
        });

        rawItem.variants = newVariants;

        if (rawItem.variants.length > 0) {
          rawItem.quantity = rawItem.variants.reduce((sum, v) => sum + (v.quantity || 0), 0);
        }
      } else {
        rawItem.variants = [];
      }
    } else if (quantity !== undefined && !isNaN(quantity)) {
      rawItem.quantity = parseFloat(quantity) || 0;
    }

    if (description !== undefined) rawItem.description = description ? description.trim() : "";
    if (notes !== undefined) rawItem.notes = notes ? notes.trim() : "";

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updatedRawItem = await RawItem.findById(rawItem._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .populate("alternateVendors", "companyName")
      .populate({
        path: "variants.vendorNicknames.vendor",
        select: "companyName contactPerson email phone"
      })
      .lean();

    applyComputedStatus(updatedRawItem);

    res.json({
      success: true,
      message: "Raw item updated successfully",
      rawItem: updatedRawItem
    });

  } catch (error) {
    console.error("Error updating raw item:", error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: "Validation error: " + error.message,
        errors: error.errors
      });
    }
    res.status(500).json({
      success: false,
      message: "Server error while updating raw item: " + error.message
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }
    await rawItem.deleteOne();
    res.json({ success: true, message: "Raw item deleted successfully" });
  } catch (error) {
    console.error("Error deleting raw item:", error);
    res.status(500).json({ success: false, message: "Server error while deleting raw item" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-VARIANT VENDOR NICKNAMES (replaces item-level endpoints)
// ─────────────────────────────────────────────────────────────────────────────

// LIST nicknames for a specific variant
router.get("/:id/variants/:variantId/vendor-nicknames", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("name sku variants")
      .populate({
        path: "variants.vendorNicknames.vendor",
        select: "companyName contactPerson email phone"
      })
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = (rawItem.variants || []).find(
      v => v._id?.toString() === req.params.variantId
    );
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    res.json({
      success: true,
      vendorNicknames: variant.vendorNicknames || [],
      variant: { _id: variant._id, combination: variant.combination, sku: variant.sku },
      item: { name: rawItem.name, sku: rawItem.sku }
    });
  } catch (error) {
    console.error("Error fetching variant vendor nicknames:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ADD nickname to a specific variant
router.post("/:id/variants/:variantId/vendor-nicknames", async (req, res) => {
  try {
    const { vendor, nickname, notes } = req.body;

    if (!vendor || !mongoose.Types.ObjectId.isValid(vendor)) {
      return res.status(400).json({ success: false, message: "Valid vendor is required" });
    }
    if (!nickname || !nickname.trim()) {
      return res.status(400).json({ success: false, message: "Nickname is required" });
    }

    const vendorDoc = await Vendor.findById(vendor).select("companyName");
    if (!vendorDoc) {
      return res.status(404).json({ success: false, message: "Vendor not found" });
    }

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    // Block duplicate vendor entry on same variant
    const existing = (variant.vendorNicknames || []).find(
      vn => vn.vendor?.toString() === vendor
    );
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `${vendorDoc.companyName} already has a nickname for this variant. Edit the existing entry instead.`
      });
    }

    variant.vendorNicknames.push({
      vendor,
      nickname: nickname.trim(),
      notes: (notes || "").trim()
    });

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findById(rawItem._id)
      .select("variants")
      .populate({
        path: "variants.vendorNicknames.vendor",
        select: "companyName contactPerson email phone"
      });

    const updatedVariant = updated.variants.id(req.params.variantId);

    res.status(201).json({
      success: true,
      message: "Vendor nickname added successfully",
      vendorNicknames: updatedVariant?.vendorNicknames || []
    });
  } catch (error) {
    console.error("Error adding variant vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// UPDATE a nickname on a specific variant
router.put("/:id/variants/:variantId/vendor-nicknames/:nicknameId", async (req, res) => {
  try {
    const { nickname, notes, vendor } = req.body;

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    const entry = variant.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor nickname entry not found" });
    }

    if (vendor && mongoose.Types.ObjectId.isValid(vendor)) {
      // Make sure no other entry on this variant already uses this vendor
      const collision = variant.vendorNicknames.find(
        vn => vn._id.toString() !== req.params.nicknameId && vn.vendor?.toString() === vendor
      );
      if (collision) {
        return res.status(400).json({
          success: false,
          message: "Another nickname already exists for that vendor on this variant"
        });
      }
      entry.vendor = vendor;
    }
    if (nickname !== undefined && nickname.trim()) entry.nickname = nickname.trim();
    if (notes !== undefined) entry.notes = (notes || "").trim();

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findById(rawItem._id)
      .select("variants")
      .populate({
        path: "variants.vendorNicknames.vendor",
        select: "companyName contactPerson email phone"
      });

    const updatedVariant = updated.variants.id(req.params.variantId);

    res.json({
      success: true,
      message: "Vendor nickname updated successfully",
      vendorNicknames: updatedVariant?.vendorNicknames || []
    });
  } catch (error) {
    console.error("Error updating variant vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// DELETE a nickname from a specific variant
router.delete("/:id/variants/:variantId/vendor-nicknames/:nicknameId", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variant = rawItem.variants.id(req.params.variantId);
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    const entry = variant.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor nickname entry not found" });
    }

    entry.deleteOne();
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    res.json({ success: true, message: "Vendor nickname removed" });
  } catch (error) {
    console.error("Error deleting variant vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// VARIANTS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/variants", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id).select("variants attributes name sku minStock").lean();
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const variants = (rawItem.variants || []).map(v => ({
      ...v,
      status: computeStatus(v.quantity, v.minStock ?? rawItem.minStock)
    }));

    res.json({
      success: true,
      variants,
      attributes: rawItem.attributes || [],
      item: { name: rawItem.name, sku: rawItem.sku }
    });
  } catch (error) {
    console.error("Error fetching variants:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variants" });
  }
});

router.post("/:id/variants/:variantId/add-stock", async (req, res) => {
  try {
    const { quantity, supplier, supplierId, unitPrice, purchaseOrder, purchaseOrderId, invoiceNumber, reason, notes } = req.body;

    if (!quantity || isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Valid quantity is required" });
    }
    if (!supplier || !supplier.trim()) {
      return res.status(400).json({ success: false, message: "Supplier name is required" });
    }
    if (!unitPrice || isNaN(unitPrice) || unitPrice <= 0) {
      return res.status(400).json({ success: false, message: "Valid unit price is required" });
    }

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) return res.status(404).json({ success: false, message: "Variant not found" });

    const variant = rawItem.variants[variantIndex];
    const previousQuantity = variant.quantity;
    const newQuantity = previousQuantity + parseFloat(quantity);

    const transaction = {
      type: "VARIANT_ADD",
      quantity: parseFloat(quantity),
      variantCombination: variant.combination,
      variantId: variant._id,
      previousQuantity,
      newQuantity,
      reason: reason || "Stock Addition from Purchase",
      supplier: supplier.trim(),
      supplierId: supplierId || null,
      unitPrice: parseFloat(unitPrice),
      purchaseOrder: purchaseOrder || "",
      purchaseOrderId: purchaseOrderId || null,
      invoiceNumber: invoiceNumber || "",
      notes: notes || "",
      performedBy: req.user.id
    };

    rawItem.variants[variantIndex].quantity = newQuantity;
    rawItem.quantity = rawItem.variants.reduce((sum, v) => sum + (v.quantity || 0), 0);
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    res.json({
      success: true,
      message: `Stock added successfully. New quantity: ${newQuantity}`,
      variant: rawItem.variants[variantIndex],
      transaction
    });

  } catch (error) {
    console.error("Error adding stock to variant:", error);
    res.status(500).json({ success: false, message: "Server error while adding stock to variant" });
  }
});

router.post("/:id/variants/:variantId/reduce-stock", async (req, res) => {
  try {
    const { quantity, reason, notes } = req.body;

    if (!quantity || isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({ success: false, message: "Valid quantity is required" });
    }

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) return res.status(404).json({ success: false, message: "Variant not found" });

    const variant = rawItem.variants[variantIndex];
    if (parseFloat(quantity) > variant.quantity) {
      return res.status(400).json({ success: false, message: `Insufficient stock. Available: ${variant.quantity}` });
    }

    const previousQuantity = variant.quantity;
    const newQuantity = previousQuantity - parseFloat(quantity);

    const transaction = {
      type: "VARIANT_REDUCE",
      quantity: parseFloat(quantity),
      variantCombination: variant.combination,
      variantId: variant._id,
      previousQuantity,
      newQuantity,
      reason: reason || "Stock Consumption",
      notes: notes || "",
      performedBy: req.user.id
    };

    rawItem.variants[variantIndex].quantity = newQuantity;
    rawItem.quantity = rawItem.variants.reduce((sum, v) => sum + (v.quantity || 0), 0);
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    res.json({
      success: true,
      message: `Stock reduced successfully. New quantity: ${newQuantity}`,
      variant: rawItem.variants[variantIndex],
      transaction
    });

  } catch (error) {
    console.error("Error reducing stock:", error);
    res.status(500).json({ success: false, message: "Server error while reducing stock" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TRANSACTIONS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;

    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku quantity minStock")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName")
      .lean();

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    let transactions = rawItem.stockTransactions || [];
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const startIndex = (page - 1) * limit;
    const paginatedTransactions = transactions.slice(startIndex, startIndex + parseInt(limit));

    const totalAdditions = transactions
      .filter(tx => ["ADD", "PURCHASE_ORDER", "VARIANT_ADD"].includes(tx.type))
      .reduce((sum, tx) => sum + (tx.quantity || 0), 0);

    const totalReductions = transactions
      .filter(tx => ["REDUCE", "CONSUME", "VARIANT_REDUCE"].includes(tx.type))
      .reduce((sum, tx) => sum + (tx.quantity || 0), 0);

    const uniqueVendors = [...new Set(transactions
      .filter(tx => tx.supplier && tx.supplier.trim())
      .map(tx => tx.supplier))];

    const computedStatus = computeStatus(rawItem.quantity, rawItem.minStock);

    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      stats: {
        totalAdditions,
        totalReductions,
        uniqueVendors: uniqueVendors.length,
        currentStock: rawItem.quantity,
        status: computedStatus
      },
      item: {
        name: rawItem.name,
        sku: rawItem.sku,
        quantity: rawItem.quantity,
        status: computedStatus
      }
    });

  } catch (error) {
    console.error("Error fetching stock transactions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock transactions" });
  }
});

router.get("/:id/variants/:variantId/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku variants minStock")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName")
      .lean();

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const variant = rawItem.variants.find(v => v._id.toString() === req.params.variantId);
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });

    let transactions = rawItem.stockTransactions.filter(tx =>
      tx.variantId && tx.variantId.toString() === req.params.variantId
    );
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const startIndex = (page - 1) * limit;
    const paginatedTransactions = transactions.slice(startIndex, startIndex + parseInt(limit));

    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      variant: {
        combination: variant.combination,
        sku: variant.sku,
        quantity: variant.quantity,
        status: computeStatus(variant.quantity, variant.minStock ?? rawItem.minStock),
        minStock: variant.minStock,
        maxStock: variant.maxStock
      },
      item: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching variant transactions:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variant transactions" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id).select("name sku");
    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

    const purchaseOrders = await PurchaseOrder.find({ "items.rawItem": req.params.id })
      .select("poNumber orderDate expectedDeliveryDate vendorName status totalAmount items")
      .populate("vendor", "companyName")
      .sort({ orderDate: -1 });

    const processedOrders = purchaseOrders.map(po => {
      const item = po.items.find(i => i.rawItem.toString() === req.params.id);
      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendor?.companyName || po.vendorName,
        status: po.status,
        totalAmount: po.totalAmount,
        itemDetails: item ? {
          quantity: item.quantity,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status
        } : null
      };
    });

    res.json({
      success: true,
      purchaseOrders: processedOrders,
      rawItem: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res.status(500).json({ success: false, message: "Server error while fetching purchase orders" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIERS HISTORY  (existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/suppliers", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku primaryVendor alternateVendors")
      .populate("stockTransactions.supplierId", "companyName contactPerson phone email")
      .populate("primaryVendor", "companyName contactPerson phone email gstNumber")
      .populate("alternateVendors", "companyName contactPerson phone email gstNumber");

    if (!rawItem) return res.status(404).json({ success: false, message: "Raw item not found" });

    const transactionSuppliers = {};
    rawItem.stockTransactions.forEach(tx => {
      if (tx.supplier && ["ADD", "PURCHASE_ORDER", "VARIANT_ADD"].includes(tx.type)) {
        const name = tx.supplier;
        if (!transactionSuppliers[name]) {
          transactionSuppliers[name] = {
            name,
            lastPurchaseDate: tx.createdAt,
            lastCost: tx.unitPrice || 0,
            totalPurchased: tx.quantity || 0,
            purchaseCount: 1,
            supplierId: tx.supplierId
          };
        } else {
          transactionSuppliers[name].totalPurchased += tx.quantity || 0;
          transactionSuppliers[name].purchaseCount += 1;
          if (new Date(tx.createdAt) > new Date(transactionSuppliers[name].lastPurchaseDate)) {
            transactionSuppliers[name].lastPurchaseDate = tx.createdAt;
            transactionSuppliers[name].lastCost = tx.unitPrice || 0;
          }
        }
      }
    });

    res.json({
      success: true,
      suppliers: Object.values(transactionSuppliers).sort((a, b) =>
        new Date(b.lastPurchaseDate) - new Date(a.lastPurchaseDate)
      ),
      primaryVendor: rawItem.primaryVendor,
      alternateVendors: rawItem.alternateVendors || [],
      item: { name: rawItem.name, sku: rawItem.sku }
    });

  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ success: false, message: "Server error while fetching suppliers" });
  }
});

module.exports = router;