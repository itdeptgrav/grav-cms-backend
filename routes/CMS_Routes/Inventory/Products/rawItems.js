// routes/Cms_routes/Inventory/Products/rawItems.js

const express = require("express");
const router = express.Router();
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const Vendor = require("../../../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Categories for clothing raw materials
const RAW_ITEM_CATEGORIES = [
  "Fabric",
  "Thread",
  "Fasteners",
  "Elastic",
  "Interlining",
  "Trims",
  "Chemicals",
  "Patterns",
  "Labels",
  "Packaging",
  "Accessories",
  "Dyes",
  "Buttons",
  "Zippers",
  "Laces",
  "Ribbons",
  "Cords",
  "Tapes",
  "Piping",
  "Webbing"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all raw items with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { customCategory: { $regex: search, $options: "i" } }
      ];
    }

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.$or = [
        { category: category },
        { customCategory: category }
      ];
    }

    const rawItems = await RawItem.find(filter)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .sort({ createdAt: -1 });

    // Get statistics
    const total = await RawItem.countDocuments();
    const lowStock = await RawItem.countDocuments({ status: "Low Stock" });
    const outOfStock = await RawItem.countDocuments({ status: "Out of Stock" });

    // Calculate total value (using selling price)
    let totalSellingValue = 0;
    let totalVariants = 0;

    rawItems.forEach(item => {
      totalSellingValue += item.quantity * (item.sellingPrice || 0);
      if (item.variants && Array.isArray(item.variants)) {
        totalVariants += item.variants.length;
      }
    });

    // Get unique vendors from stock transactions
    const vendorSet = new Set();
    rawItems.forEach(item => {
      if (item.stockTransactions && Array.isArray(item.stockTransactions)) {
        item.stockTransactions.forEach(tx => {
          if (tx.supplier && (tx.type === "ADD" || tx.type === "PURCHASE_ORDER")) {
            vendorSet.add(tx.supplier);
          }
        });
      }
    });

    res.json({
      success: true,
      rawItems,
      stats: {
        total,
        lowStock,
        outOfStock,
        totalVendors: vendorSet.size,
        totalSellingValue,
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
    res.status(500).json({
      success: false,
      message: "Server error while fetching units"
    });
  }
});

// ✅ GET available suppliers (all active vendors)
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
    res.status(500).json({
      success: false,
      message: "Server error while fetching suppliers"
    });
  }
});

// ✅ GET raw item by ID with variants
router.get("/:id", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName")
      .populate("alternateVendors", "companyName");

    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    // Add virtual fields
    const itemObj = rawItem.toObject();
    itemObj.variantSummary = rawItem.variantSummary;
    itemObj.currentVendorCosts = rawItem.currentVendorCosts;

    res.json({ success: true, rawItem: itemObj });

  } catch (error) {
    console.error("Error fetching raw item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw item"
    });
  }
});

// ✅ CREATE new raw item with variants
// ✅ CREATE new raw item with variants - DEBUG VERSION
router.post("/", async (req, res) => {
  console.log("\n" + "=".repeat(80));
  console.log("📦 RAW ITEM CREATE REQUEST RECEIVED");
  console.log("=".repeat(80));
  
  // Log complete request info
  console.log("📝 Request Method:", req.method);
  console.log("📝 Request URL:", req.originalUrl);
  console.log("📝 Request Headers:", JSON.stringify(req.headers, null, 2));
  console.log("👤 User from Auth Middleware:", req.user);
  console.log("👤 User ID:", req.user?.id);
  console.log("👤 User exists:", !!req.user);
  
  try {
    const {
      name,
      category,
      customCategory,
      unit,
      customUnit,
      minStock,
      maxStock,
      sellingPrice,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    console.log("\n📊 REQUEST BODY DATA:");
    console.log("Name:", name);
    console.log("Category:", category);
    console.log("Custom Category:", customCategory);
    console.log("Unit:", unit);
    console.log("Custom Unit:", customUnit);
    console.log("Min Stock:", minStock);
    console.log("Max Stock:", maxStock);
    console.log("Selling Price:", sellingPrice);
    console.log("Full Request Body:", JSON.stringify(req.body, null, 2));

    // Validation with detailed logging
    console.log("\n🔍 STARTING VALIDATION...");
    
    if (!name || !name.trim()) {
      console.log("❌ VALIDATION FAILED: Item name is required");
      return res.status(400).json({
        success: false,
        message: "Item name is required"
      });
    }
    console.log("✅ Name validation passed");

    if (!category && !customCategory) {
      console.log("❌ VALIDATION FAILED: Category is required");
      return res.status(400).json({
        success: false,
        message: "Category is required"
      });
    }
    console.log("✅ Category validation passed");

    if (!unit && !customUnit) {
      console.log("❌ VALIDATION FAILED: Unit of measurement is required");
      return res.status(400).json({
        success: false,
        message: "Unit of measurement is required"
      });
    }
    console.log("✅ Unit validation passed");

    if (minStock === undefined || isNaN(minStock) || minStock < 0) {
      console.log("❌ VALIDATION FAILED: Valid minimum stock is required");
      return res.status(400).json({
        success: false,
        message: "Valid minimum stock is required"
      });
    }
    console.log("✅ Min Stock validation passed");

    if (maxStock === undefined || isNaN(maxStock) || maxStock < 0) {
      console.log("❌ VALIDATION FAILED: Valid maximum stock is required");
      return res.status(400).json({
        success: false,
        message: "Valid maximum stock is required"
      });
    }
    console.log("✅ Max Stock validation passed");

    if (parseFloat(minStock) >= parseFloat(maxStock)) {
      console.log("❌ VALIDATION FAILED: Maximum stock must be greater than minimum stock");
      return res.status(400).json({
        success: false,
        message: "Maximum stock must be greater than minimum stock"
      });
    }
    console.log("✅ Stock range validation passed");

    // Validate attributes if provided
    if (attributes && Array.isArray(attributes)) {
      console.log("🔍 Validating attributes...");
      for (let attr of attributes) {
        if (!attr.name || !attr.name.trim()) {
          console.log(`❌ VALIDATION FAILED: Attribute name is required`);
          return res.status(400).json({
            success: false,
            message: "Attribute name is required"
          });
        }
        if (!attr.values || !Array.isArray(attr.values) || attr.values.length === 0) {
          console.log(`❌ VALIDATION FAILED: Attribute "${attr.name}" must have at least one value`);
          return res.status(400).json({
            success: false,
            message: `Attribute "${attr.name}" must have at least one value`
          });
        }
      }
      console.log(`✅ ${attributes.length} attributes validation passed`);
    }

    console.log("\n🎯 ALL VALIDATIONS PASSED!");

    // Generate SKU
    console.log("\n🔧 GENERATING SKU...");
    const nameWords = name.trim().split(' ');
    const nameCode = nameWords.map(word => word.substring(0, 3).toUpperCase()).join('');
    const finalCategory = customCategory?.trim() || category;
    const categoryCode = finalCategory.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const sku = `RAW-${categoryCode}-${nameCode}-${randomNum}`;
    console.log("Generated SKU:", sku);

    // Check for duplicate SKU
    console.log("🔍 Checking for duplicate SKU...");
    const existingItem = await RawItem.findOne({ sku });
    if (existingItem) {
      console.log("❌ DUPLICATE SKU FOUND:", existingItem._id);
      return res.status(400).json({
        success: false,
        message: "An item with similar SKU already exists"
      });
    }
    console.log("✅ No duplicate SKU found");

    // Process variants
    console.log("\n🔧 PROCESSING VARIANTS...");
    let processedVariants = [];
    if (variants && Array.isArray(variants)) {
      processedVariants = variants.map(variant => ({
        combination: variant.combination || [],
        quantity: variant.quantity || 0,
        minStock: variant.minStock || minStock,
        maxStock: variant.maxStock || maxStock,
        sellingPrice: variant.sellingPrice || sellingPrice,
        sku: variant.sku || ""
      }));
      console.log(`✅ Processed ${processedVariants.length} variants`);
    }

    // Calculate total quantity
    console.log("\n🧮 CALCULATING TOTAL QUANTITY...");
    const totalQuantity = processedVariants.reduce((total, variant) => {
      return total + (variant.quantity || 0);
    }, 0);
    console.log("Total Quantity:", totalQuantity);

    // Create new raw item
    console.log("\n📝 CREATING NEW RAW ITEM DOCUMENT...");
    const newRawItem = new RawItem({
      name: name.trim(),
      sku: sku.toUpperCase(),
      category: customCategory ? "" : category,
      customCategory: customCategory || "",
      unit: customUnit ? "" : unit,
      customUnit: customUnit || "",
      quantity: totalQuantity,
      minStock: parseFloat(minStock),
      maxStock: parseFloat(maxStock),
      sellingPrice: sellingPrice ? parseFloat(sellingPrice) : null,
      discounts: discounts && Array.isArray(discounts) ?
        discounts
          .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
          .map(d => ({
            minQuantity: parseFloat(d.minQuantity),
            price: parseFloat(d.price)
          })) : [],
      attributes: attributes && Array.isArray(attributes) ?
        attributes
          .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
          .map(attr => ({
            name: attr.name.trim(),
            values: attr.values.filter(val => val && val.trim())
          })) : [],
      variants: processedVariants,
      description: description ? description.trim() : "",
      notes: notes ? notes.trim() : "",
      createdBy: req.user.id
    });

    console.log("Raw Item Object to save:", JSON.stringify(newRawItem, null, 2));

    // Save to database
    console.log("\n💾 SAVING TO DATABASE...");
    await newRawItem.save();
    console.log("✅ Raw item saved successfully! ID:", newRawItem._id);

    // Send success response
    console.log("\n✅ SENDING SUCCESS RESPONSE...");
    res.status(201).json({
      success: true,
      message: "Raw item registered successfully",
      rawItem: newRawItem
    });

    console.log("\n" + "=".repeat(80));
    console.log("✅ REQUEST COMPLETED SUCCESSFULLY");
    console.log("=".repeat(80) + "\n");

  } catch (error) {
    console.error("\n❌" + "=".repeat(80));
    console.error("🚨 ERROR IN RAW ITEM CREATION!");
    console.error("=".repeat(80));
    
    console.error("Error Name:", error.name);
    console.error("Error Message:", error.message);
    console.error("Error Code:", error.code);
    console.error("Error Stack:", error.stack);
    
    if (error.code === 11000) {
      console.error("❌ DUPLICATE KEY ERROR (MongoDB Error 11000)");
      console.error("This usually means a duplicate SKU or unique field violation");
      return res.status(400).json({
        success: false,
        message: "Item with this SKU already exists"
      });
    }

    if (error.name === 'ValidationError') {
      console.error("❌ MONGOOSE VALIDATION ERROR");
      console.error("Validation Errors:", error.errors);
      return res.status(400).json({
        success: false,
        message: "Validation error: " + error.message,
        errors: error.errors
      });
    }

    if (error.name === 'CastError') {
      console.error("❌ MONGOOSE CAST ERROR");
      console.error("This usually means invalid data type for a field");
      return res.status(400).json({
        success: false,
        message: "Invalid data type for field: " + error.message
      });
    }

    console.error("\n🔄 SENDING GENERIC ERROR RESPONSE...");
    res.status(500).json({
      success: false,
      message: "Server error while creating raw item: " + error.message,
      errorType: error.name,
      errorDetails: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
    
    console.log("=".repeat(80) + "\n");
  }
});

// ✅ UPDATE raw item with variants
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
      sellingPrice,
      discounts,
      attributes,
      variants,
      description,
      notes
    } = req.body;

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    // Update basic fields if provided
    if (name) rawItem.name = name.trim();

    // Handle category
    if (category !== undefined) {
      if (customCategory) {
        rawItem.category = "";
        rawItem.customCategory = customCategory.trim();
      } else {
        rawItem.category = category.trim();
        rawItem.customCategory = "";
      }
    }

    // Handle unit
    if (unit !== undefined) {
      if (customUnit) {
        rawItem.unit = "";
        rawItem.customUnit = customUnit.trim();
      } else {
        rawItem.unit = unit.trim();
        rawItem.customUnit = "";
      }
    }

    if (quantity !== undefined) rawItem.quantity = parseFloat(quantity) || 0;
    if (minStock !== undefined) rawItem.minStock = parseFloat(minStock);
    if (maxStock !== undefined) rawItem.maxStock = parseFloat(maxStock);
    if (sellingPrice !== undefined) rawItem.sellingPrice = sellingPrice ? parseFloat(sellingPrice) : null;

    // Update discounts if provided
    if (discounts !== undefined) {
      rawItem.discounts = discounts && Array.isArray(discounts) ?
        discounts
          .filter(d => d.minQuantity && d.price && !isNaN(d.minQuantity) && !isNaN(d.price))
          .map(d => ({
            minQuantity: parseFloat(d.minQuantity),
            price: parseFloat(d.price)
          })) : [];
    }

    // Update attributes if provided
    if (attributes !== undefined) {
      rawItem.attributes = attributes && Array.isArray(attributes) ?
        attributes
          .filter(attr => attr.name && attr.name.trim() && attr.values && attr.values.length > 0)
          .map(attr => ({
            name: attr.name.trim(),
            values: attr.values.filter(val => val && val.trim())
          })) : [];
    }

    // Update variants if provided
    if (variants !== undefined) {
      rawItem.variants = variants && Array.isArray(variants) ?
        variants.map(variant => ({
          combination: variant.combination || [],
          quantity: variant.quantity || 0,
          minStock: variant.minStock || rawItem.minStock,
          maxStock: variant.maxStock || rawItem.maxStock,
          sellingPrice: variant.sellingPrice || rawItem.sellingPrice,
          sku: variant.sku || "",
          status: variant.status || "In Stock"
        })) : [];
    }

    if (description !== undefined) rawItem.description = description ? description.trim() : "";
    if (notes !== undefined) rawItem.notes = notes ? notes.trim() : "";

    rawItem.updatedBy = req.user.id;
    await rawItem.save();

    const updatedRawItem = await RawItem.findById(rawItem._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("primaryVendor", "companyName");

    res.json({
      success: true,
      message: "Raw item updated successfully",
      rawItem: updatedRawItem
    });

  } catch (error) {
    console.error("Error updating raw item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating raw item"
    });
  }
});

// ✅ DELETE raw item
router.delete("/:id", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    await rawItem.deleteOne();

    res.json({
      success: true,
      message: "Raw item deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting raw item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting raw item"
    });
  }
});

// ✅ UPDATE variant quantity
router.patch("/:id/variants/:variantId/quantity", async (req, res) => {
  try {
    const { quantity, type, notes } = req.body;

    if (!quantity || isNaN(quantity) || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid quantity is required"
      });
    }

    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }

    const variant = rawItem.variants[variantIndex];
    const previousQuantity = variant.quantity;
    let newQuantity = previousQuantity;

    if (type === "add") {
      newQuantity += parseFloat(quantity);
    } else if (type === "subtract") {
      newQuantity -= parseFloat(quantity);
      if (newQuantity < 0) newQuantity = 0;
    } else {
      newQuantity = parseFloat(quantity);
    }

    // Update variant quantity
    rawItem.variants[variantIndex].quantity = newQuantity;

    // Create stock transaction
    const transaction = {
      type: type === "add" ? "VARIANT_ADD" : "VARIANT_REDUCE",
      quantity: parseFloat(quantity),
      variantCombination: variant.combination,
      variantId: variant._id,
      previousQuantity: previousQuantity,
      newQuantity: newQuantity,
      reason: `Variant quantity ${type === "add" ? "added" : "reduced"}`,
      notes: notes || "",
      performedBy: req.user.id
    };

    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;

    await rawItem.save();

    res.json({
      success: true,
      message: `Variant quantity updated to ${newQuantity}`,
      variant: rawItem.variants[variantIndex],
      rawItem
    });

  } catch (error) {
    console.error("Error updating variant quantity:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating variant quantity"
    });
  }
});

// ✅ GET variants for a raw item
router.get("/:id/variants", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id).select("variants attributes name sku");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    res.json({
      success: true,
      variants: rawItem.variants || [],
      attributes: rawItem.attributes || [],
      item: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });

  } catch (error) {
    console.error("Error fetching variants:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching variants"
    });
  }
});

// ✅ ADD STOCK to specific variant
router.post("/:id/variants/:variantId/add-stock", async (req, res) => {
  try {
    const {
      quantity,
      supplier,
      supplierId,
      unitPrice,
      purchaseOrder,
      purchaseOrderId,
      invoiceNumber,
      reason,
      notes
    } = req.body;
    
    // Validation
    if (!quantity || isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid quantity is required"
      });
    }
    
    if (!supplier || !supplier.trim()) {
      return res.status(400).json({
        success: false,
        message: "Supplier name is required"
      });
    }
    
    if (!unitPrice || isNaN(unitPrice) || unitPrice <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid unit price is required"
      });
    }
    
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }
    
    const variant = rawItem.variants[variantIndex];
    
    // Calculate new quantity
    const previousQuantity = variant.quantity;
    const newQuantity = previousQuantity + parseFloat(quantity);
    
    // Create stock transaction
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
    
    // Update variant quantity
    rawItem.variants[variantIndex].quantity = newQuantity;
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName");
    
    res.json({
      success: true,
      message: `Stock added to variant successfully. New quantity: ${newQuantity}`,
      rawItem: updatedItem,
      variant: rawItem.variants[variantIndex],
      transaction
    });
    
  } catch (error) {
    console.error("Error adding stock to variant:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while adding stock to variant" 
    });
  }
});

// ✅ REDUCE/CONSUME stock from specific variant
router.post("/:id/variants/:variantId/reduce-stock", async (req, res) => {
  try {
    const {
      quantity,
      reasonType = "CONSUME",
      reason,
      notes
    } = req.body;
    
    // Validation
    if (!quantity || isNaN(quantity) || quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid quantity is required"
      });
    }
    
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    const variantIndex = rawItem.variants.findIndex(v => v._id.toString() === req.params.variantId);
    if (variantIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }
    
    const variant = rawItem.variants[variantIndex];
    
    // Check if enough stock is available
    if (parseFloat(quantity) > variant.quantity) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${variant.quantity}`
      });
    }
    
    // Calculate new quantity
    const previousQuantity = variant.quantity;
    const newQuantity = previousQuantity - parseFloat(quantity);
    
    // Create stock transaction
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
    
    // Update variant quantity
    rawItem.variants[variantIndex].quantity = newQuantity;
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("stockTransactions.performedBy", "name email");
    
    res.json({
      success: true,
      message: `Stock reduced from variant successfully. New quantity: ${newQuantity}`,
      rawItem: updatedItem,
      variant: rawItem.variants[variantIndex],
      transaction
    });
    
  } catch (error) {
    console.error("Error reducing stock from variant:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while reducing stock from variant" 
    });
  }
});

// ✅ GET stock transactions for specific variant
router.get("/:id/variants/:variantId/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku variants");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    const variant = rawItem.variants.find(v => v._id.toString() === req.params.variantId);
    if (!variant) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }
    
    // Filter transactions for this variant
    let transactions = rawItem.stockTransactions.filter(tx => 
      tx.variantId && tx.variantId.toString() === req.params.variantId
    );
    
    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);
    
    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      variant: {
        combination: variant.combination,
        quantity: variant.quantity,
        status: variant.status
      },
      item: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });
    
  } catch (error) {
    console.error("Error fetching variant transactions:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching variant transactions" 
    });
  }
});

// Existing routes remain the same (add-stock, reduce-stock, purchase-orders, transactions, suppliers, etc.)
// ... [Keep all the existing routes from the original file]


// ✅ GET stock transactions for a raw item
router.get("/:id/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku quantity status")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // Get transactions
    let transactions = rawItem.stockTransactions || [];
    
    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);
    
    // Calculate statistics
    const totalAdditions = transactions.filter(tx => 
      tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD"
    ).reduce((sum, tx) => sum + (tx.quantity || 0), 0);
    
    const totalReductions = transactions.filter(tx => 
      tx.type === "REDUCE" || tx.type === "CONSUME" || tx.type === "VARIANT_REDUCE"
    ).reduce((sum, tx) => sum + (tx.quantity || 0), 0);
    
    const totalPurchases = transactions.filter(tx => 
      tx.type === "ADD" || tx.type === "PURCHASE_ORDER"
    ).length;
    
    const uniqueVendors = [...new Set(transactions
      .filter(tx => tx.supplier && tx.supplier.trim())
      .map(tx => tx.supplier))];
    
    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      stats: {
        totalAdditions,
        totalReductions,
        totalPurchases,
        uniqueVendors: uniqueVendors.length,
        currentStock: rawItem.quantity,
        status: rawItem.status
      },
      item: {
        name: rawItem.name,
        sku: rawItem.sku,
        quantity: rawItem.quantity,
        status: rawItem.status
      }
    });
    
  } catch (error) {
    console.error("Error fetching stock transactions:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching stock transactions" 
    });
  }
});

// ✅ GET purchase orders for a raw item
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    // First, get the raw item to ensure it exists
    const rawItem = await RawItem.findById(req.params.id).select("name sku");
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // We need to import PurchaseOrder model
    const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    
    // Find purchase orders that contain this raw item
    const purchaseOrders = await PurchaseOrder.find({
      "items.rawItem": req.params.id
    })
    .select("poNumber orderDate expectedDeliveryDate vendorName status totalAmount totalReceived totalPending items")
    .populate("vendor", "companyName")
    .sort({ orderDate: -1 });
    
    // Process the data to include item details
    const processedOrders = purchaseOrders.map(po => {
      const item = po.items.find(i => i.rawItem.toString() === req.params.id);
      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendor?.companyName || po.vendorName,
        vendorCompany: po.vendor?.companyName || "",
        status: po.status,
        totalAmount: po.totalAmount,
        totalReceived: po.totalReceived,
        totalPending: po.totalPending,
        itemDetails: item ? {
          quantity: item.quantity,
          receivedQuantity: item.receivedQuantity,
          pendingQuantity: item.pendingQuantity,
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status,
          variantId: item.variantId,
          variantCombination: item.variantCombination,
          variantName: item.variantName
        } : null
      };
    });
    
    // Calculate statistics
    const totalOrders = processedOrders.length;
    const totalOrderedQty = processedOrders.reduce((sum, po) => 
      sum + (po.itemDetails?.quantity || 0), 0);
    const totalDeliveredQty = processedOrders.reduce((sum, po) => 
      sum + (po.itemDetails?.receivedQuantity || 0), 0);
    const totalPendingQty = processedOrders.reduce((sum, po) => 
      sum + (po.itemDetails?.pendingQuantity || 0), 0);
    
    const activeOrders = processedOrders.filter(po => 
      po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED"
    );
    
    res.json({
      success: true,
      purchaseOrders: processedOrders,
      stats: {
        totalOrders,
        totalOrderedQty,
        totalDeliveredQty,
        totalPendingQty,
        activeOrders: activeOrders.length,
        deliveredPercentage: totalOrderedQty > 0 ? 
          Math.round((totalDeliveredQty / totalOrderedQty) * 100) : 0
      },
      rawItem: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });
    
  } catch (error) {
    console.error("Error fetching purchase orders:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching purchase orders" 
    });
  }
});

// ✅ GET variant transactions for a specific variant
router.get("/:id/variants/:variantId/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku variants")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // Find the specific variant
    const variant = rawItem.variants.find(v => v._id.toString() === req.params.variantId);
    if (!variant) {
      return res.status(404).json({
        success: false,
        message: "Variant not found"
      });
    }
    
    // Filter transactions for this specific variant
    let transactions = rawItem.stockTransactions.filter(tx => 
      tx.variantId && tx.variantId.toString() === req.params.variantId
    );
    
    // Sort by date (newest first)
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = transactions.slice(startIndex, endIndex);
    
    // Calculate variant statistics
    const variantAdditions = transactions.filter(tx => 
      tx.type === "VARIANT_ADD"
    ).reduce((sum, tx) => sum + (tx.quantity || 0), 0);
    
    const variantReductions = transactions.filter(tx => 
      tx.type === "VARIANT_REDUCE"
    ).reduce((sum, tx) => sum + (tx.quantity || 0), 0);
    
    const purchaseOrders = transactions.filter(tx => 
      tx.purchaseOrder && tx.purchaseOrder.trim()
    ).length;
    
    res.json({
      success: true,
      transactions: paginatedTransactions,
      total: transactions.length,
      page: parseInt(page),
      totalPages: Math.ceil(transactions.length / limit),
      stats: {
        variantAdditions,
        variantReductions,
        purchaseOrders,
        currentQuantity: variant.quantity,
        status: variant.status
      },
      variant: {
        combination: variant.combination,
        sku: variant.sku,
        quantity: variant.quantity,
        status: variant.status,
        minStock: variant.minStock,
        maxStock: variant.maxStock
      },
      item: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });
    
  } catch (error) {
    console.error("Error fetching variant transactions:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching variant transactions" 
    });
  }
});

// ✅ GET supplier/vendor details from transactions
router.get("/:id/suppliers", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku primaryVendor alternateVendors")
      .populate("stockTransactions.supplierId", "companyName contactPerson phone email address")
      .populate("primaryVendor", "companyName contactPerson phone email address gstNumber")
      .populate("alternateVendors", "companyName contactPerson phone email address gstNumber");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // Extract suppliers from transactions
    const transactionSuppliers = {};
    
    rawItem.stockTransactions.forEach(tx => {
      if (tx.supplier && (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")) {
        const supplierName = tx.supplier;
        if (!transactionSuppliers[supplierName]) {
          transactionSuppliers[supplierName] = {
            name: supplierName,
            lastPurchaseDate: tx.createdAt,
            lastCost: tx.unitPrice || 0,
            totalPurchased: tx.quantity || 0,
            purchaseCount: 1,
            supplierId: tx.supplierId
          };
        } else {
          transactionSuppliers[supplierName].totalPurchased += tx.quantity || 0;
          transactionSuppliers[supplierName].purchaseCount += 1;
          
          // Update last purchase date if this is more recent
          if (new Date(tx.createdAt) > new Date(transactionSuppliers[supplierName].lastPurchaseDate)) {
            transactionSuppliers[supplierName].lastPurchaseDate = tx.createdAt;
            transactionSuppliers[supplierName].lastCost = tx.unitPrice || 0;
          }
        }
      }
    });
    
    // Convert to array and sort by last purchase date (most recent first)
    const suppliersArray = Object.values(transactionSuppliers).sort((a, b) => 
      new Date(b.lastPurchaseDate) - new Date(a.lastPurchaseDate)
    );
    
    res.json({
      success: true,
      suppliers: suppliersArray,
      primaryVendor: rawItem.primaryVendor,
      alternateVendors: rawItem.alternateVendors || [],
      item: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });
    
  } catch (error) {
    console.error("Error fetching suppliers:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching suppliers" 
    });
  }
});

// ✅ GET categories
router.get("/data/categories", async (req, res) => {
  res.json({
    success: true,
    categories: RAW_ITEM_CATEGORIES
  });
});

module.exports = router;