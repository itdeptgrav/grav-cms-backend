// routes/Cms_routes/Inventory/Products/rawItems.js

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
// Helper: derive status from quantity vs minStock (do NOT trust DB status field)
// ─────────────────────────────────────────────────────────────────────────────
const computeStatus = (qty, minStock) => {
  const q = Number(qty) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "Out of Stock";
  if (q <= m) return "Low Stock";
  return "In Stock";
};

// Apply computed status to a plain rawItem object (and its variants)
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

// ✅ GET all raw items with pagination, search, and filter
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

    // Get items (exclude stockTransactions for performance)
    let rawItems = await RawItem.find(filter)
      .select("-stockTransactions")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .sort({ createdAt: -1 })
      .lean();

    // ── Apply computed status to every item & variant ──
    rawItems = rawItems.map(applyComputedStatus);

    // ── If filtering by status, apply AFTER status computation ──
    if (status) {
      rawItems = rawItems.filter(it => it.status === status);
    }

    // Pagination after filter
    const totalItems = rawItems.length;
    const paged = rawItems.slice(skip, skip + limitNum);

    // ── Stats from computed statuses (full DB scan, lean) ──
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

// ✅ GET available units
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

// ✅ GET available suppliers
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

// ✅ GET categories
router.get("/data/categories", async (req, res) => {
  res.json({ success: true, categories: RAW_ITEM_CATEGORIES });
});

// ✅ GET raw item by ID
router.get("/:id", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .populate("alternateVendors", "companyName")
      .populate("vendorNicknames.vendor", "companyName contactPerson email phone")
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    // Apply computed status
    applyComputedStatus(rawItem);

    res.json({ success: true, rawItem });

  } catch (error) {
    console.error("Error fetching raw item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw item" });
  }
});

// ✅ CREATE new raw item
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

    // Validate attributes
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

    let processedVariants = [];
    if (variants && Array.isArray(variants)) {
      processedVariants = variants.map(variant => ({
        combination: variant.combination || [],
        quantity: parseFloat(variant.quantity) || 0,
        minStock: parseFloat(variant.minStock) || parseFloat(minStock) || 0,
        maxStock: parseFloat(variant.maxStock) || parseFloat(maxStock) || 0,
        sku: variant.sku || ""
      }));
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

// ✅ UPDATE raw item
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

    if (variants !== undefined) {
      rawItem.variants = Array.isArray(variants)
        ? variants.map(variant => ({
            combination: variant.combination || [],
            quantity: parseFloat(variant.quantity) || 0,
            minStock: parseFloat(variant.minStock) || rawItem.minStock,
            maxStock: parseFloat(variant.maxStock) || rawItem.maxStock,
            sku: variant.sku || "",
            status: variant.status || "In Stock"
          }))
        : [];

      if (rawItem.variants.length > 0) {
        rawItem.quantity = rawItem.variants.reduce((sum, v) => sum + (v.quantity || 0), 0);
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
      .populate("vendorNicknames.vendor", "companyName")
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

// ✅ DELETE raw item
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
// VENDOR NICKNAMES
// ─────────────────────────────────────────────────────────────────────────────

// ✅ GET all vendor nicknames for a raw item
router.get("/:id/vendor-nicknames", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("name sku vendorNicknames")
      .populate("vendorNicknames.vendor", "companyName contactPerson email phone")
      .lean();

    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    res.json({
      success: true,
      vendorNicknames: rawItem.vendorNicknames || [],
      item: { name: rawItem.name, sku: rawItem.sku }
    });
  } catch (error) {
    console.error("Error fetching vendor nicknames:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ✅ ADD a vendor nickname
router.post("/:id/vendor-nicknames", async (req, res) => {
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

    // Block duplicate vendor entry
    const existing = (rawItem.vendorNicknames || []).find(
      vn => vn.vendor.toString() === vendor
    );
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `${vendorDoc.companyName} already has a nickname assigned. Edit the existing entry instead.`
      });
    }

    rawItem.vendorNicknames.push({
      vendor,
      nickname: nickname.trim(),
      notes: (notes || "").trim()
    });
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findById(rawItem._id)
      .select("vendorNicknames")
      .populate("vendorNicknames.vendor", "companyName contactPerson email phone");

    res.status(201).json({
      success: true,
      message: "Vendor nickname added successfully",
      vendorNicknames: updated.vendorNicknames
    });
  } catch (error) {
    console.error("Error adding vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ✅ UPDATE a vendor nickname
router.put("/:id/vendor-nicknames/:nicknameId", async (req, res) => {
  try {
    const { nickname, notes, vendor } = req.body;

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const entry = rawItem.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor nickname entry not found" });
    }

    if (vendor && mongoose.Types.ObjectId.isValid(vendor)) {
      // Make sure no other entry already uses this vendor
      const collision = rawItem.vendorNicknames.find(
        vn => vn._id.toString() !== req.params.nicknameId && vn.vendor.toString() === vendor
      );
      if (collision) {
        return res.status(400).json({
          success: false,
          message: "Another nickname already exists for that vendor"
        });
      }
      entry.vendor = vendor;
    }
    if (nickname !== undefined && nickname.trim()) entry.nickname = nickname.trim();
    if (notes !== undefined) entry.notes = (notes || "").trim();

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updated = await RawItem.findById(rawItem._id)
      .select("vendorNicknames")
      .populate("vendorNicknames.vendor", "companyName contactPerson email phone");

    res.json({
      success: true,
      message: "Vendor nickname updated successfully",
      vendorNicknames: updated.vendorNicknames
    });
  } catch (error) {
    console.error("Error updating vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ✅ DELETE a vendor nickname
router.delete("/:id/vendor-nicknames/:nicknameId", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    const entry = rawItem.vendorNicknames.id(req.params.nicknameId);
    if (!entry) {
      return res.status(404).json({ success: false, message: "Vendor nickname entry not found" });
    }

    entry.deleteOne();
    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    res.json({ success: true, message: "Vendor nickname removed" });
  } catch (error) {
    console.error("Error deleting vendor nickname:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// (Existing variant endpoints unchanged below)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/:id/variants", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id).select("variants attributes name sku minStock").lean();
    if (!rawItem) {
      return res.status(404).json({ success: false, message: "Raw item not found" });
    }

    // Apply computed status to variants
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