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

    rawItems.forEach(item => {
      totalSellingValue += item.quantity * (item.sellingPrice || 0);
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
        totalSellingValue
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

// ✅ GET raw item by ID
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

    res.json({ success: true, rawItem });

  } catch (error) {
    console.error("Error fetching raw item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw item"
    });
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
      sellingPrice,
      discounts,
      description,
      notes
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Item name is required"
      });
    }

    if (!category && !customCategory) {
      return res.status(400).json({
        success: false,
        message: "Category is required"
      });
    }

    if (!unit && !customUnit) {
      return res.status(400).json({
        success: false,
        message: "Unit of measurement is required"
      });
    }

    if (minStock === undefined || isNaN(minStock) || minStock < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid minimum stock is required"
      });
    }

    if (maxStock === undefined || isNaN(maxStock) || maxStock < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid maximum stock is required"
      });
    }

    if (parseFloat(minStock) >= parseFloat(maxStock)) {
      return res.status(400).json({
        success: false,
        message: "Maximum stock must be greater than minimum stock"
      });
    }

    // Generate SKU
    const nameWords = name.trim().split(' ');
    const nameCode = nameWords.map(word => word.substring(0, 3).toUpperCase()).join('');
    const finalCategory = customCategory?.trim() || category;
    const categoryCode = finalCategory.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const sku = `RAW-${categoryCode}-${nameCode}-${randomNum}`;

    // Check for duplicate SKU
    const existingItem = await RawItem.findOne({ sku });
    if (existingItem) {
      return res.status(400).json({
        success: false,
        message: "An item with similar SKU already exists"
      });
    }

    // Create new raw item
    const newRawItem = new RawItem({
      name: name.trim(),
      sku: sku.toUpperCase(),
      category: customCategory ? "" : category,
      customCategory: customCategory || "",
      unit: customUnit ? "" : unit,
      customUnit: customUnit || "",
      quantity: 0, // Start with 0 quantity
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
      return res.status(400).json({
        success: false,
        message: "Item with this SKU already exists"
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while creating raw item"
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
      sellingPrice,
      discounts,
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

    // Update fields if provided
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

// ✅ UPDATE raw item quantity (for stock adjustments)
router.patch("/:id/quantity", async (req, res) => {
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

    let newQuantity = rawItem.quantity;
    if (type === "add") {
      newQuantity += parseFloat(quantity);
    } else if (type === "subtract") {
      newQuantity -= parseFloat(quantity);
      if (newQuantity < 0) newQuantity = 0;
    } else {
      newQuantity = parseFloat(quantity);
    }

    rawItem.quantity = newQuantity;
    rawItem.updatedBy = req.user.id;

    // Add note about quantity change
    if (notes) {
      const timestamp = new Date().toLocaleString();
      rawItem.notes = rawItem.notes ?
        `${rawItem.notes}\n${timestamp}: ${notes} (Qty: ${type} ${quantity})` :
        `${timestamp}: ${notes} (Qty: ${type} ${quantity})`;
    }

    await rawItem.save();

    res.json({
      success: true,
      message: `Quantity updated to ${newQuantity}`,
      rawItem
    });

  } catch (error) {
    console.error("Error updating quantity:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating quantity"
    });
  }
});

// ✅ ADD STOCK to raw item (with transaction history)
router.post("/:id/add-stock", async (req, res) => {
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
    
    // Calculate new quantity
    const previousQuantity = rawItem.quantity;
    const newQuantity = previousQuantity + parseFloat(quantity);
    
    // Create stock transaction
    const transaction = {
      type: "ADD",
      quantity: parseFloat(quantity),
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
    
    // Update raw item
    rawItem.quantity = newQuantity;
    rawItem.stockTransactions.unshift(transaction); // Add to beginning
    
    // Update primary vendor if this is the first purchase or if we want to set a primary
    if (req.body.setAsPrimary || !rawItem.primaryVendor) {
      if (supplierId) {
        rawItem.primaryVendor = supplierId;
      }
    }
    
    // Add to alternate vendors if not already there
    if (supplierId && !rawItem.alternateVendors.includes(supplierId)) {
      rawItem.alternateVendors.push(supplierId);
    }
    
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    // Populate user info
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("stockTransactions.performedBy", "name email")
      .populate("primaryVendor", "companyName")
      .populate("alternateVendors", "companyName")
      .populate("stockTransactions.supplierId", "companyName");
    
    res.json({
      success: true,
      message: `Stock added successfully. New quantity: ${newQuantity}`,
      rawItem: updatedItem,
      transaction
    });
    
  } catch (error) {
    console.error("Error adding stock:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while adding stock" 
    });
  }
});

// ✅ REDUCE/CONSUME stock from raw item
router.post("/:id/reduce-stock", async (req, res) => {
  try {
    const {
      quantity,
      reasonType = "CONSUME", // "CONSUME" or "REDUCE"
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
    
    // Check if enough stock is available
    if (parseFloat(quantity) > rawItem.quantity) {
      return res.status(400).json({
        success: false,
        message: `Insufficient stock. Available: ${rawItem.quantity}`
      });
    }
    
    // Calculate new quantity
    const previousQuantity = rawItem.quantity;
    const newQuantity = previousQuantity - parseFloat(quantity);
    
    // Get average cost from recent transactions
    let averageCost = 0;
    if (rawItem.stockTransactions && rawItem.stockTransactions.length > 0) {
      const purchaseTransactions = rawItem.stockTransactions
        .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
        .slice(0, 5); // Take last 5 purchases
      
      if (purchaseTransactions.length > 0) {
        const total = purchaseTransactions.reduce((sum, tx) => sum + (tx.unitPrice || 0), 0);
        averageCost = total / purchaseTransactions.length;
      }
    }
    
    // Create stock transaction
    const transaction = {
      type: reasonType === "CONSUME" ? "CONSUME" : "REDUCE",
      quantity: parseFloat(quantity),
      previousQuantity,
      newQuantity,
      reason: reason || "Stock Consumption",
      supplier: "Mixed",
      unitPrice: averageCost,
      notes: notes || "",
      performedBy: req.user.id
    };
    
    // Update raw item
    rawItem.quantity = newQuantity;
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    // Populate user info
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .populate("stockTransactions.performedBy", "name email");
    
    res.json({
      success: true,
      message: `Stock reduced successfully. New quantity: ${newQuantity}`,
      rawItem: updatedItem,
      transaction
    });
    
  } catch (error) {
    console.error("Error reducing stock:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while reducing stock" 
    });
  }
});


// ✅ GET purchase orders for a specific raw item
router.get("/:id/purchase-orders", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }

    // First, let's check if we have access to the PurchaseOrder model
    // If not, we need to import it
    const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

    // Query purchase orders that have this raw item in their items
    const purchaseOrders = await PurchaseOrder.find({
      "items.rawItem": req.params.id
    })
      .select("poNumber orderDate expectedDeliveryDate vendorName status items paymentStatus totalAmount")
      .populate("vendor", "companyName contactPerson")
      .populate("createdBy", "name email")
      .sort({ createdAt: -1 });

    // Transform the data to include item-specific details
    const formattedPurchaseOrders = purchaseOrders.map(po => {
      // Find the specific item within the PO that matches our raw item
      const item = po.items.find(i => 
        i.rawItem && i.rawItem.toString() === req.params.id
      );
      
      if (!item) return null;

      return {
        _id: po._id,
        poNumber: po.poNumber,
        orderDate: po.orderDate,
        expectedDeliveryDate: po.expectedDeliveryDate,
        vendorName: po.vendorName,
        vendorId: po.vendor?._id,
        vendorCompany: po.vendor?.companyName,
        status: po.status,
        paymentStatus: po.paymentStatus,
        totalAmount: po.totalAmount,
        itemDetails: {
          quantity: item.quantity,
          receivedQuantity: item.receivedQuantity || 0,
          pendingQuantity: item.pendingQuantity || (item.quantity - (item.receivedQuantity || 0)),
          unitPrice: item.unitPrice,
          totalPrice: item.totalPrice,
          status: item.status,
          itemName: item.itemName,
          sku: item.sku,
          unit: item.unit
        },
        createdBy: po.createdBy?.name || "Unknown",
        createdAt: po.createdAt
      };
    }).filter(po => po !== null); // Remove any null entries

    // Get statistics for this raw item
    const totalOrders = formattedPurchaseOrders.length;
    const totalOrderedQty = formattedPurchaseOrders.reduce((sum, po) => 
      sum + (po.itemDetails.quantity || 0), 0
    );
    const totalDeliveredQty = formattedPurchaseOrders.reduce((sum, po) => 
      sum + (po.itemDetails.receivedQuantity || 0), 0
    );
    const pendingDeliveryQty = formattedPurchaseOrders.reduce((sum, po) => 
      sum + (po.itemDetails.pendingQuantity || 0), 0
    );

    // Get active purchase orders (not completed or cancelled)
    const activePOs = formattedPurchaseOrders.filter(po => 
      po.status === "ISSUED" || po.status === "PARTIALLY_RECEIVED" || po.status === "DRAFT"
    );

    // Get total order value
    const totalOrderValue = formattedPurchaseOrders.reduce((sum, po) => 
      sum + (po.itemDetails.totalPrice || 0), 0
    );

    // Get latest purchase order
    const latestPO = formattedPurchaseOrders.length > 0 
      ? formattedPurchaseOrders[0] 
      : null;

    res.json({
      success: true,
      purchaseOrders: formattedPurchaseOrders,
      stats: {
        totalOrders,
        totalOrderedQty,
        totalDeliveredQty,
        pendingDeliveryQty,
        deliveryProgress: totalOrderedQty > 0 
          ? Math.round((totalDeliveredQty / totalOrderedQty) * 100) 
          : 0,
        activePOs: activePOs.length,
        totalOrderValue,
        latestPO: latestPO ? {
          poNumber: latestPO.poNumber,
          orderDate: latestPO.orderDate,
          quantity: latestPO.itemDetails.quantity,
          vendorName: latestPO.vendorName
        } : null
      }
    });

  } catch (error) {
    console.error("Error fetching purchase orders for raw item:", error);
    
    // If PurchaseOrder model is not found, provide a helpful message
    if (error.message.includes("PurchaseOrder") || error.message.includes("model")) {
      return res.status(500).json({
        success: false,
        message: "Purchase order module is not available. Please ensure the PurchaseOrder model is properly set up."
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while fetching purchase orders"
    });
  }
});

// ✅ GET stock transactions history
router.get("/:id/transactions", async (req, res) => {
  try {
    const { page = 1, limit = 20, type } = req.query;
    
    const rawItem = await RawItem.findById(req.params.id)
      .select("stockTransactions name sku")
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName");
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    let transactions = [...rawItem.stockTransactions];
    
    // Filter by type if provided
    if (type) {
      transactions = transactions.filter(t => t.type === type);
    }
    
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
      item: {
        name: rawItem.name,
        sku: rawItem.sku
      }
    });
    
  } catch (error) {
    console.error("Error fetching transactions:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while fetching transactions" 
    });
  }
});

// ✅ GET available suppliers for specific raw item (from transactions)
router.get("/:id/suppliers", async (req, res) => {
  try {
    const rawItem = await RawItem.findById(req.params.id);
    
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // Get unique suppliers from stock transactions
    const suppliers = [];
    const supplierMap = new Map();
    
    if (rawItem.stockTransactions && Array.isArray(rawItem.stockTransactions)) {
      rawItem.stockTransactions
        .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
        .forEach(tx => {
          if (tx.supplier && tx.supplier.trim()) {
            // Get the most recent transaction for each supplier
            if (!supplierMap.has(tx.supplier) || 
                new Date(tx.createdAt) > new Date(supplierMap.get(tx.supplier).lastTransaction)) {
              supplierMap.set(tx.supplier, {
                supplier: tx.supplier,
                supplierId: tx.supplierId,
                lastCost: tx.unitPrice,
                lastTransaction: tx.createdAt
              });
            }
          }
        });
    }
    
    // Convert map to array
    supplierMap.forEach(value => {
      suppliers.push({
        supplier: value.supplier,
        supplierId: value.supplierId,
        lastCost: value.lastCost
      });
    });
    
    // Get all active vendors from database
    const allVendors = await Vendor.find({ status: "Active" })
      .select("companyName vendorType")
      .sort({ companyName: 1 });
    
    res.json({
      success: true,
      suppliers: suppliers,
      allVendors: allVendors.map(v => ({
        id: v._id,
        name: v.companyName,
        type: v.vendorType
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

// ✅ ADD PURCHASE ORDER transaction
router.post("/:id/purchase-order", async (req, res) => {
  try {
    const {
      quantity,
      supplier,
      supplierId,
      unitPrice,
      purchaseOrder,
      purchaseOrderId,
      invoiceNumber,
      status = "PENDING", // PENDING, DELIVERED, CANCELLED
      expectedDelivery,
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
    
    // Create purchase order transaction
    const transaction = {
      type: "PURCHASE_ORDER",
      quantity: parseFloat(quantity),
      previousQuantity: rawItem.quantity,
      newQuantity: rawItem.quantity, // Will be updated when delivered
      reason: "Purchase Order Created",
      supplier: supplier.trim(),
      supplierId: supplierId || null,
      unitPrice: parseFloat(unitPrice),
      purchaseOrder: purchaseOrder || "",
      purchaseOrderId: purchaseOrderId || null,
      invoiceNumber: invoiceNumber || "",
      status: status,
      expectedDelivery: expectedDelivery || null,
      notes: notes || "",
      performedBy: req.user.id
    };
    
    // Update raw item
    rawItem.stockTransactions.unshift(transaction);
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    // Populate user info
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName");
    
    res.json({
      success: true,
      message: "Purchase order transaction recorded successfully",
      rawItem: updatedItem,
      transaction
    });
    
  } catch (error) {
    console.error("Error recording purchase order:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while recording purchase order" 
    });
  }
});

// ✅ UPDATE purchase order status and add stock when delivered
router.post("/:id/purchase-order/:transactionId/deliver", async (req, res) => {
  try {
    const { actualQuantity, actualUnitPrice, invoiceNumber, notes } = req.body;
    
    const rawItem = await RawItem.findById(req.params.id);
    if (!rawItem) {
      return res.status(404).json({
        success: false,
        message: "Raw item not found"
      });
    }
    
    // Find the purchase order transaction
    const transactionIndex = rawItem.stockTransactions.findIndex(
      tx => tx._id.toString() === req.params.transactionId && tx.type === "PURCHASE_ORDER"
    );
    
    if (transactionIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Purchase order transaction not found"
      });
    }
    
    const poTransaction = rawItem.stockTransactions[transactionIndex];
    
    // Update purchase order status
    poTransaction.status = "DELIVERED";
    poTransaction.deliveredAt = new Date();
    poTransaction.actualQuantity = actualQuantity || poTransaction.quantity;
    poTransaction.actualUnitPrice = actualUnitPrice || poTransaction.unitPrice;
    if (invoiceNumber) poTransaction.invoiceNumber = invoiceNumber;
    if (notes) poTransaction.notes = notes ? `${poTransaction.notes}\n${notes}` : notes;
    
    // Create ADD transaction for the delivered stock
    const previousQuantity = rawItem.quantity;
    const deliveredQuantity = actualQuantity || poTransaction.quantity;
    const newQuantity = previousQuantity + parseFloat(deliveredQuantity);
    
    const addTransaction = {
      type: "ADD",
      quantity: parseFloat(deliveredQuantity),
      previousQuantity,
      newQuantity,
      reason: "Purchase Order Delivery",
      supplier: poTransaction.supplier,
      supplierId: poTransaction.supplierId,
      unitPrice: actualUnitPrice || poTransaction.unitPrice,
      purchaseOrder: poTransaction.purchaseOrder,
      purchaseOrderId: poTransaction.purchaseOrderId,
      invoiceNumber: invoiceNumber || poTransaction.invoiceNumber,
      relatedPO: poTransaction._id,
      notes: `Delivered from PO: ${poTransaction.purchaseOrder}`,
      performedBy: req.user.id
    };
    
    // Update raw item quantity and add transaction
    rawItem.quantity = newQuantity;
    rawItem.stockTransactions.unshift(addTransaction);
    
    // Update primary vendor if not set
    if (!rawItem.primaryVendor && poTransaction.supplierId) {
      rawItem.primaryVendor = poTransaction.supplierId;
    }
    
    // Add to alternate vendors if not already there
    if (poTransaction.supplierId && !rawItem.alternateVendors.includes(poTransaction.supplierId)) {
      rawItem.alternateVendors.push(poTransaction.supplierId);
    }
    
    rawItem.updatedBy = req.user.id;
    
    await rawItem.save();
    
    // Populate user info
    const updatedItem = await RawItem.findById(rawItem._id)
      .populate("stockTransactions.performedBy", "name email")
      .populate("stockTransactions.supplierId", "companyName")
      .populate("primaryVendor", "companyName");
    
    res.json({
      success: true,
      message: `Purchase order delivered successfully. ${deliveredQuantity} units added to stock. New quantity: ${newQuantity}`,
      rawItem: updatedItem,
      purchaseOrder: poTransaction,
      deliveryTransaction: addTransaction
    });
    
  } catch (error) {
    console.error("Error delivering purchase order:", error);
    res.status(500).json({ 
      success: false, 
      message: "Server error while delivering purchase order" 
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

// Helper functions
const getRecentVendorCost = (item) => {
  if (!item.stockTransactions || item.stockTransactions.length === 0) return 0;
  
  const recentTransaction = item.stockTransactions
    .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  
  return recentTransaction?.unitPrice || 0;
}

const getAverageVendorCost = (item) => {
  if (!item.stockTransactions || item.stockTransactions.length === 0) return 0;
  
  const purchaseTransactions = item.stockTransactions
    .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER");
  
  if (purchaseTransactions.length === 0) return 0;
  
  const total = purchaseTransactions.reduce((sum, tx) => sum + (tx.unitPrice || 0), 0);
  return total / purchaseTransactions.length;
}

module.exports = router;