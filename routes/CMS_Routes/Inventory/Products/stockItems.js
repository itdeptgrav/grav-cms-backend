// routes/CMS_Routes/Inventory/Products/stockItemRoutes.js

const express = require("express");
const router = express.Router();
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const OperationGroup = require("../../../../models/CMS_Models/Inventory/Configurations/OperationGroup");

// Categories for stock items
const STOCK_ITEM_CATEGORIES = [
  "T-Shirts", "Shirts", "Jeans", "Bottoms", "Ethnic Wear",
  "Kids Wear", "Sportswear", "Sweatshirts", "Outerwear",
  "Accessories", "Innerwear", "Formal Wear", "Casual Wear",
  "Traditional Wear", "Winter Wear", "Summer Wear"
];

// Operation types for clothing manufacturing
const OPERATION_TYPES = [
  "Cutting", "Stitching", "Finishing", "Printing", "Embroidery",
  "Washing", "Ironing", "Quality Check", "Packing", "Labeling"
];

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Specific /data/* routes MUST be defined BEFORE /:id routes
// ─────────────────────────────────────────────────────────────────────────────

// ✅ GET raw items with their variants for stock item form
router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "", limit = 50 } = req.query;

    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } }
      ];
    }

    const rawItems = await RawItem.find(filter)
      .select("name sku category unit customUnit variants quantity minStock maxStock sellingPrice stockTransactions")
      .limit(parseInt(limit))
      .sort({ name: 1 });

    const processedRawItems = rawItems.map(item => {
      const baseItem = {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        baseUnit: item.customUnit || item.unit || "Unit",
        baseQuantity: item.quantity || 0,
        baseSellingPrice: item.sellingPrice || 0,
        hasVariants: item.variants && item.variants.length > 0,
        variants: []
      };

      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => {
          let latestCost = 0;
          if (item.stockTransactions && item.stockTransactions.length > 0) {
            const variantTransactions = item.stockTransactions
              .filter(tx =>
                tx.variantId &&
                tx.variantId.toString() === variant._id.toString() &&
                (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")
              )
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            if (variantTransactions.length > 0) latestCost = variantTransactions[0].unitPrice || 0;
          }
          if (latestCost === 0 && item.sellingPrice) latestCost = item.sellingPrice * 0.8;

          return {
            id: variant._id,
            combination: variant.combination || [],
            combinationText: variant.combination?.join(" • ") || "Default",
            quantity: variant.quantity || 0,
            unit: baseItem.baseUnit,
            cost: latestCost,
            status: variant.status || "Out of Stock",
            sku: variant.sku || `${baseItem.sku}-var`
          };
        });
      } else {
        let latestCost = 0;
        if (item.stockTransactions && item.stockTransactions.length > 0) {
          const purchaseTransactions = item.stockTransactions
            .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          if (purchaseTransactions.length > 0) latestCost = purchaseTransactions[0].unitPrice || 0;
        }
        if (latestCost === 0 && item.sellingPrice) latestCost = item.sellingPrice * 0.8;

        baseItem.variants = [{
          id: item._id,
          combination: [],
          combinationText: "Default",
          quantity: item.quantity || 0,
          unit: baseItem.baseUnit,
          cost: latestCost,
          status: item.status || "Out of Stock",
          sku: baseItem.sku
        }];
      }

      return baseItem;
    });

    res.json({ success: true, rawItems: processedRawItems });

  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw items" });
  }
});

// ✅ GET data for creating stock item (includes registered operations & groups)
router.get("/data/create", async (req, res) => {
  try {
    const rawItemsResponse = await RawItem.find({})
      .select("name sku category unit variants quantity sellingPrice stockTransactions")
      .limit(20)
      .sort({ name: 1 });

    const processedRawItems = rawItemsResponse.map(item => {
      const baseItem = {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.category || "Uncategorized",
        baseUnit: item.unit || "Unit",
        hasVariants: item.variants && item.variants.length > 0,
        variants: []
      };
      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => ({
          id: variant._id,
          combination: variant.combination || [],
          combinationText: variant.combination?.join(" • ") || "Default",
          quantity: variant.quantity || 0,
          unit: baseItem.baseUnit,
          cost: item.sellingPrice ? item.sellingPrice * 0.8 : 0,
          status: variant.status || "Out of Stock"
        }));
      }
      return baseItem;
    });

    const machines = await Machine.find({ status: "Operational" })
      .select("name type model serialNumber")
      .sort({ type: 1, name: 1 });

    const operators = await Employee.find({ department: "Operator", status: "active" })
      .select("salary");

    const averageSalary = operators.length > 0
      ? operators.reduce((sum, emp) => sum + (emp.salary?.netSalary || 0), 0) / operators.length
      : 0;

    const [registeredOperations, registeredGroups] = await Promise.all([
      Operation.find().sort({ name: 1 }),
      OperationGroup.find()
        .populate("operations", "name totalSam durationSeconds machineType")
        .sort({ name: 1 })
    ]);

    res.json({
      success: true,
      data: {
        categories: STOCK_ITEM_CATEGORIES,
        operationTypes: OPERATION_TYPES,
        rawItems: processedRawItems,
        machines: machines.map(machine => ({
          id: machine._id,
          name: machine.name,
          type: machine.type,
          model: machine.model,
          serialNumber: machine.serialNumber
        })),
        averageOperatorSalary: Math.round(averageSalary),
        registeredOperations: registeredOperations.map(op => ({
          _id: op._id,
          name: op.name,
          totalSam: op.totalSam,
          durationSeconds: op.durationSeconds,
          machineType: op.machineType
        })),
        registeredGroups: registeredGroups.map(grp => ({
          _id: grp._id,
          name: grp.name,
          operations: grp.operations
        }))
      }
    });

  } catch (error) {
    console.error("Error fetching create data:", error);
    res.status(500).json({ success: false, message: "Server error while fetching create data" });
  }
});

// ✅ NEW: Tab-specific data endpoint to avoid loading everything at once
// Usage: GET /api/cms/stock-items/:id/tab/:tabName
router.get("/:id/tab/:tabName", async (req, res) => {
  try {
    const { id, tabName } = req.params;

    let selectFields = "";
    let response = {};

    switch (tabName) {
      case "general":
        selectFields = "name productType category unit hsnCode baseSalesPrice baseCost internalNotes numberOfPanels reference images";
        break;
      case "attributes":
        selectFields = "attributes";
        break;
      case "variants":
        selectFields = "variants attributes reference baseCost baseSalesPrice";
        break;
      case "raw-items":
        selectFields = "variants.rawItems variants._id variants.attributes variants.sku";
        break;
      case "operations":
        selectFields = "operations";
        break;
      case "measurements":
        selectFields = "measurements numberOfPanels";
        break;
      case "costs":
        selectFields = "miscellaneousCosts";
        break;
      default:
        // For unknown tabs, return basic info
        selectFields = "name category";
    }

    const stockItem = await StockItem.findById(id).select(selectFields);

    if (!stockItem) {
      return res.status(404).json({ success: false, message: "Stock item not found" });
    }

    response = { success: true, tab: tabName, data: stockItem };

    // For operations tab, also return registered operations and groups
    if (tabName === "operations") {
      const [registeredOperations, registeredGroups] = await Promise.all([
        Operation.find().sort({ name: 1 }),
        OperationGroup.find()
          .populate("operations", "name totalSam durationSeconds machineType")
          .sort({ name: 1 })
      ]);
      response.registeredOperations = registeredOperations.map(op => ({
        _id: op._id,
        name: op.name,
        totalSam: op.totalSam,
        durationSeconds: op.durationSeconds,
        machineType: op.machineType
      }));
      response.registeredGroups = registeredGroups.map(grp => ({
        _id: grp._id,
        name: grp.name,
        operations: grp.operations
      }));
    }

    res.json(response);

  } catch (error) {
    console.error(`Error fetching tab data (${req.params.tabName}):`, error);
    res.status(500).json({ success: false, message: "Server error while fetching tab data" });
  }
});

// ✅ GET all stock items with variants (with pagination)
// FIX: Use aggregation for stats so we don't have to load all docs into memory
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category, page = 1, limit = 10 } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build filter for paginated list
    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { "variants.sku": { $regex: search, $options: "i" } }
      ];
    }
    if (category) filter.category = category;

    // FIX: status filter — the DB status field may be stale; filter based on
    // the stored status field but also recompute on the fly for display.
    // We keep the DB-level filter for quick queries.
    if (status) filter.status = status;

    // Run paginated query + stats aggregation in parallel for speed
    const [totalItems, stockItems, statsAgg] = await Promise.all([
      StockItem.countDocuments(filter),
      StockItem.find(filter)
        .select("name reference category unit totalQuantityOnHand averageCost averageSalesPrice status images variants hsnCode profitMargin operations")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      // Use aggregation for global stats — much faster than loading all docs
      StockItem.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            lowStock: { $sum: { $cond: [{ $eq: ["$status", "Low Stock"] }, 1, 0] } },
            outOfStock: { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"] }, 1, 0] } },
            totalVariants: { $sum: { $size: { $ifNull: ["$variants", []] } } },
            totalInventoryValue: {
              $sum: { $multiply: [{ $ifNull: ["$averageCost", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] }
            },
            totalPotentialRevenue: {
              $sum: { $multiply: [{ $ifNull: ["$averageSalesPrice", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] }
            },
            averageMargin: { $avg: { $ifNull: ["$profitMargin", 0] } }
          }
        }
      ])
    ]);

    const statsData = statsAgg[0] || {
      total: 0, lowStock: 0, outOfStock: 0, totalVariants: 0,
      totalInventoryValue: 0, totalPotentialRevenue: 0, averageMargin: 0
    };

    const totalPages = Math.ceil(totalItems / limitNum);

    res.json({
      success: true,
      stockItems,
      stats: {
        total: statsData.total,
        lowStock: statsData.lowStock,
        outOfStock: statsData.outOfStock,
        totalVariants: statsData.totalVariants,
        totalInventoryValue: statsData.totalInventoryValue,
        totalPotentialRevenue: statsData.totalPotentialRevenue,
        averageMargin: statsData.averageMargin,
        totalStockItems: statsData.total
      },
      filters: {
        categories: STOCK_ITEM_CATEGORIES,
        statuses: ["In Stock", "Low Stock", "Out of Stock"]
      },
      pagination: {
        currentPage: pageNum,
        totalPages,
        totalItems,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1
      }
    });

  } catch (error) {
    console.error("Error fetching stock items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock items" });
  }
});

// ✅ GET stock item by ID with variants
router.get("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");

    if (!stockItem) {
      return res.status(404).json({ success: false, message: "Stock item not found" });
    }

    res.json({ success: true, stockItem });

  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock item" });
  }
});

// ✅ GET variant by stockItemId and variantId
router.get("/:stockItemId/variant/:variantId", async (req, res) => {
  try {
    const { stockItemId, variantId } = req.params;
    const stockItem = await StockItem.findById(stockItemId);

    if (!stockItem) {
      return res.status(404).json({ success: false, message: "Stock item not found" });
    }

    const variant = stockItem.variants.find(v => v._id.toString() === variantId.toString());
    if (!variant) {
      return res.status(404).json({ success: false, message: "Variant not found" });
    }

    res.json({
      success: true,
      variant: {
        _id: variant._id,
        attributes: variant.attributes || [],
        salesPrice: variant.salesPrice,
        quantityOnHand: variant.quantityOnHand
      }
    });

  } catch (error) {
    console.error("Error fetching variant:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variant" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: process raw items for a variant (shared by POST and PUT)
// ─────────────────────────────────────────────────────────────────────────────
async function processVariantRawItems(rawItemsInput) {
  const processedRawItems = [];
  if (!rawItemsInput || !Array.isArray(rawItemsInput)) return processedRawItems;

  for (const rawItem of rawItemsInput) {
    if (!rawItem.rawItemId || !rawItem.quantity || rawItem.quantity <= 0) continue;

    const rawItemData = await RawItem.findById(rawItem.rawItemId)
      .select("name sku unit customUnit variants stockTransactions sellingPrice");

    if (!rawItemData) continue;

    let unitCost = 0;
    let variantCombination = [];
    let variantId = rawItemData._id;

    if (rawItem.variantId) {
      const rawItemVariant = rawItemData.variants.id(rawItem.variantId);
      if (rawItemVariant) {
        variantCombination = rawItemVariant.combination || [];
        variantId = rawItem.variantId;

        if (rawItemData.stockTransactions?.length > 0) {
          const variantTxs = rawItemData.stockTransactions
            .filter(tx =>
              tx.variantId?.toString() === rawItem.variantId &&
              (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")
            )
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          if (variantTxs.length > 0) unitCost = variantTxs[0].unitPrice || 0;
        }
      }
    }

    if (unitCost === 0 && rawItemData.stockTransactions?.length > 0) {
      const purchaseTxs = rawItemData.stockTransactions
        .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      if (purchaseTxs.length > 0) unitCost = purchaseTxs[0].unitPrice || 0;
    }

    if (unitCost === 0 && rawItemData.sellingPrice) unitCost = rawItemData.sellingPrice * 0.8;

    processedRawItems.push({
      rawItemId: rawItemData._id,
      rawItemName: rawItemData.name,
      rawItemSku: rawItemData.sku,
      variantId,
      variantCombination,
      quantity: parseFloat(rawItem.quantity),
      unit: rawItemData.customUnit || rawItemData.unit || "Unit",
      unitCost,
      totalCost: parseFloat(rawItem.quantity) * unitCost
    });
  }

  return processedRawItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute and update aggregate fields on a StockItem doc
// FIX: averageSalesPrice and averageCost calculated from variants, not base fields
// ─────────────────────────────────────────────────────────────────────────────
function updateStockItemAggregates(stockItem) {
  const variants = stockItem.variants || [];

  // Total quantity
  stockItem.totalQuantityOnHand = variants.reduce((s, v) => s + (v.quantityOnHand || 0), 0);

  // Average cost and sales price from variants (FIX: was using baseSalesPrice)
  if (variants.length > 0) {
    stockItem.averageCost = variants.reduce((s, v) => s + (v.cost || 0), 0) / variants.length;
    stockItem.averageSalesPrice = variants.reduce((s, v) => s + (v.salesPrice || 0), 0) / variants.length;
  } else {
    stockItem.averageCost = stockItem.baseCost || 0;
    stockItem.averageSalesPrice = stockItem.baseSalesPrice || 0;
  }

  // Profit margin
  if (stockItem.averageCost > 0 && stockItem.averageSalesPrice > 0) {
    stockItem.profitMargin = ((stockItem.averageSalesPrice - stockItem.averageCost) / stockItem.averageCost) * 100;
  } else {
    stockItem.profitMargin = 0;
  }

  // Inventory/revenue value
  stockItem.inventoryValue = stockItem.averageCost * stockItem.totalQuantityOnHand;
  stockItem.potentialRevenue = stockItem.averageSalesPrice * stockItem.totalQuantityOnHand;

  // Status: derived from variants
  const outOfStockCount = variants.filter(v => (v.quantityOnHand || 0) <= 0).length;
  const lowStockCount = variants.filter(v =>
    (v.quantityOnHand || 0) > 0 && (v.quantityOnHand || 0) <= (v.minStock || 10)
  ).length;

  if (outOfStockCount === variants.length && variants.length > 0) {
    stockItem.status = "Out of Stock";
  } else if (lowStockCount > 0 || outOfStockCount > 0) {
    stockItem.status = "Low Stock";
  } else {
    stockItem.status = "In Stock";
  }

  // Update individual variant statuses
  stockItem.variants = variants.map(v => {
    if ((v.quantityOnHand || 0) <= 0) {
      v.status = "Out of Stock";
    } else if ((v.quantityOnHand || 0) <= (v.minStock || 10)) {
      v.status = "Low Stock";
    } else {
      v.status = "In Stock";
    }
    return v;
  });
}

// ✅ CREATE new stock item with variants
// FIX: Removed baseSalesPrice required validation; hsnCode now saved
router.post("/", async (req, res) => {
  try {
    const {
      name, productType, category, unit, hsnCode,
      baseSalesPrice, baseCost, internalNotes,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    // Validation — baseSalesPrice is now optional (removed restriction)
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Product name is required" });
    }
    if (!category) {
      return res.status(400).json({ success: false, message: "Category is required" });
    }
    if (!attributes || !Array.isArray(attributes) || attributes.length === 0) {
      return res.status(400).json({ success: false, message: "At least one attribute is required" });
    }
    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({ success: false, message: "At least one variant is required" });
    }

    // Generate reference
    const nameWords = name.trim().split(" ");
    const nameCode = nameWords.map(w => w.substring(0, 3).toUpperCase()).join("");
    const categoryCode = category.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`;

    const existingItem = await StockItem.findOne({ reference });
    if (existingItem) {
      return res.status(400).json({ success: false, message: "A product with similar reference already exists" });
    }

    const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

    const processedAttributes = attributes
      .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
      .map(attr => ({
        name: attr.name.trim(),
        values: attr.values.filter(v => v?.trim()).map(v => v.trim())
      }));

    const processedVariants = await Promise.all(
      variants.map(async (variant, index) => {
        const variantSku = `${reference}-V${(index + 1).toString().padStart(3, "0")}`;
        const variantBarcode = `${barcode}-${(index + 1).toString().padStart(3, "0")}`;
        const processedRawItems = await processVariantRawItems(variant.rawItems);

        return {
          sku: variantSku,
          attributes: variant.attributes || [],
          quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
          minStock: parseFloat(variant.minStock) || 10,
          maxStock: parseFloat(variant.maxStock) || 100,
          cost: parseFloat(variant.cost) || parseFloat(baseCost) || 0,
          salesPrice: parseFloat(variant.salesPrice) || parseFloat(baseSalesPrice) || 0,
          barcode: variantBarcode,
          images: variant.images || images || [],
          rawItems: processedRawItems
        };
      })
    );

    const processedOperations = (operations || []).map(op => {
      const minutes = parseFloat(op.minutes) || 0;
      const seconds = parseFloat(op.seconds) || 0;
      return {
        type: op.type || "",
        machine: op.machine || "",
        machineType: op.machineType || "",
        minutes,
        seconds,
        totalSeconds: minutes * 60 + seconds,
        operatorSalary: parseFloat(op.operatorSalary) || 0,
        operatorCost: parseFloat(op.operatorCost) || 0
      };
    });

    const processedMiscellaneousCosts = (miscellaneousCosts || [])
      .filter(c => c.name?.trim())
      .map(c => ({
        name: c.name.trim(),
        amount: parseFloat(c.amount) || 0,
        unit: c.unit || "Fixed"
      }));

    const newStockItem = new StockItem({
      name: name.trim(),
      reference: reference.toUpperCase(),
      productType: productType || "Goods",
      category: category.trim(),
      unit: unit || "Units",
      hsnCode: hsnCode || "",            // FIX: hsnCode now saved
      internalNotes: internalNotes || "",
      baseSalesPrice: parseFloat(baseSalesPrice) || 0,
      baseCost: parseFloat(baseCost) || 0,
      attributes: processedAttributes,
      measurements: measurements || [],
      numberOfPanels: parseInt(numberOfPanels) || 0,
      variants: processedVariants,
      operations: processedOperations,
      miscellaneousCosts: processedMiscellaneousCosts,
      images: images || [],
      createdBy: req.user.id
    });

    // Compute aggregated fields before saving
    updateStockItemAggregates(newStockItem);

    await newStockItem.save();

    res.status(201).json({
      success: true,
      message: "Stock item created successfully",
      stockItem: newStockItem
    });

  } catch (error) {
    console.error("Error creating stock item:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Product with this reference already exists" });
    }
    res.status(500).json({ success: false, message: "Server error while creating stock item" });
  }
});

// ✅ UPDATE stock item with variants
// FIX: hsnCode, internalNotes now included; aggregates recomputed after save
router.put("/:id", async (req, res) => {
  try {
    const {
      name, productType, category, unit, hsnCode, internalNotes,
      baseSalesPrice, baseCost,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) {
      return res.status(404).json({ success: false, message: "Stock item not found" });
    }

    // Update basic fields
    if (name !== undefined) stockItem.name = name.trim();
    if (productType !== undefined) stockItem.productType = productType;
    if (category !== undefined) stockItem.category = category.trim();
    if (unit !== undefined) stockItem.unit = unit;
    if (hsnCode !== undefined) stockItem.hsnCode = hsnCode;             // FIX: was missing
    if (internalNotes !== undefined) stockItem.internalNotes = internalNotes; // FIX: was missing
    if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice) || 0;
    if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;

    if (attributes !== undefined) {
      stockItem.attributes = attributes
        .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
        .map(attr => ({
          name: attr.name.trim(),
          values: attr.values.filter(v => v?.trim()).map(v => v.trim())
        }));
    }

    if (measurements !== undefined) {
      stockItem.measurements = measurements.filter(m => m?.trim()).map(m => m.trim());
    }

    if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;

    if (variants !== undefined) {
      const processedVariants = await Promise.all(
        variants.map(async (variant, index) => {
          const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, "0")}`;
          const variantBarcode = variant.barcode || `${stockItem.barcode || ""}-${(index + 1).toString().padStart(3, "0")}`;
          const processedRawItems = await processVariantRawItems(variant.rawItems);

          return {
            sku: variantSku,
            attributes: variant.attributes || [],
            quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
            minStock: parseFloat(variant.minStock) || 10,
            maxStock: parseFloat(variant.maxStock) || 100,
            cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
            salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0,
            barcode: variantBarcode,
            images: variant.images || stockItem.images || [],
            rawItems: processedRawItems
          };
        })
      );
      stockItem.variants = processedVariants;
    }

    if (operations !== undefined) {
      stockItem.operations = (Array.isArray(operations) ? operations : []).map(op => {
        const minutes = parseFloat(op.minutes) || 0;
        const seconds = parseFloat(op.seconds) || 0;
        return {
          type: op.type || "",
          machine: op.machine || "",
          machineType: op.machineType || "",
          minutes,
          seconds,
          totalSeconds: minutes * 60 + seconds,
          operatorSalary: parseFloat(op.operatorSalary) || 0,
          operatorCost: parseFloat(op.operatorCost) || 0
        };
      });
    }

    if (miscellaneousCosts !== undefined) {
      stockItem.miscellaneousCosts = (Array.isArray(miscellaneousCosts) ? miscellaneousCosts : [])
        .filter(c => c.name?.trim())
        .map(c => ({
          name: c.name.trim(),
          amount: parseFloat(c.amount) || 0,
          unit: c.unit || "Fixed"
        }));
    }

    if (images !== undefined) stockItem.images = images || [];

    stockItem.updatedBy = req.user.id;

    // Recompute aggregated fields before saving
    updateStockItemAggregates(stockItem);

    await stockItem.save();

    const updatedStockItem = await StockItem.findById(stockItem._id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");

    res.json({
      success: true,
      message: "Stock item updated successfully",
      stockItem: updatedStockItem
    });

  } catch (error) {
    console.error("Error updating stock item:", error);
    res.status(500).json({ success: false, message: "Server error while updating stock item" });
  }
});

// ✅ DELETE stock item
router.delete("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) {
      return res.status(404).json({ success: false, message: "Stock item not found" });
    }
    await stockItem.deleteOne();
    res.json({ success: true, message: "Stock item deleted successfully" });
  } catch (error) {
    console.error("Error deleting stock item:", error);
    res.status(500).json({ success: false, message: "Server error while deleting stock item" });
  }
});

module.exports = router;