// routes/Cms_routes/Inventory/Products/stockItems.js

const express = require("express");
const router = express.Router();
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

// Categories for stock items
const STOCK_ITEM_CATEGORIES = [
  "T-Shirts",
  "Shirts",
  "Jeans",
  "Bottoms",
  "Ethnic Wear",
  "Kids Wear",
  "Sportswear",
  "Sweatshirts",
  "Outerwear",
  "Accessories",
  "Innerwear",
  "Formal Wear",
  "Casual Wear",
  "Traditional Wear",
  "Winter Wear",
  "Summer Wear"
];

// Common attributes for clothing
const COMMON_ATTRIBUTES = [
  { name: "take", values: ["Round Neck", "V-Neck", "Polo Neck", "Collar", "Hooded"] }
];

// Operation types for clothing manufacturing
const OPERATION_TYPES = [
  "Cutting",
  "Stitching",
  "Finishing",
  "Printing",
  "Embroidery",
  "Washing",
  "Ironing",
  "Quality Check",
  "Packing",
  "Labeling"
];

// Helper function to calculate total cost of a stock item
const calculateStockItemCost = (stockItem) => {
  let totalCost = stockItem.cost || 0;

  // Add raw items cost
  if (stockItem.rawItems && Array.isArray(stockItem.rawItems)) {
    stockItem.rawItems.forEach(item => {
      totalCost += (item.unitCost || 0) * (item.quantity || 0);
    });
  }

  // Add operations cost
  if (stockItem.operations && Array.isArray(stockItem.operations)) {
    stockItem.operations.forEach(op => {
      totalCost += parseFloat(op.operatorCost) || 0;
    });
  }

  // Add miscellaneous costs
  if (stockItem.miscellaneousCosts && Array.isArray(stockItem.miscellaneousCosts)) {
    stockItem.miscellaneousCosts.forEach(cost => {
      totalCost += parseFloat(cost.amount) || 0;
    });
  }

  return totalCost;
};

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all stock items with optional search/filter
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { hsnCode: { $regex: search, $options: "i" } },
        { barcode: { $regex: search, $options: "i" } }
      ];
    }

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.category = category;
    }

    const stockItems = await StockItem.find(filter)
      .select("name reference category unit quantityOnHand minStock maxStock cost salesPrice status images hsnCode totalCost profitMargin inventoryValue potentialRevenue")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 });

    // Get statistics
    const total = await StockItem.countDocuments();
    const lowStock = await StockItem.countDocuments({ status: "Low Stock" });
    const outOfStock = await StockItem.countDocuments({ status: "Out of Stock" });

    // Calculate totals
    const totalInventoryValue = stockItems.reduce((sum, item) => sum + (item.inventoryValue || 0), 0);
    const totalPotentialRevenue = stockItems.reduce((sum, item) => sum + (item.potentialRevenue || 0), 0);
    const averageMargin = stockItems.length > 0 ?
      stockItems.reduce((sum, item) => sum + (item.profitMargin || 0), 0) / stockItems.length : 0;

    res.json({
      success: true,
      stockItems,
      stats: {
        total,
        lowStock,
        outOfStock,
        totalInventoryValue,
        totalPotentialRevenue,
        averageMargin
      },
      filters: {
        categories: STOCK_ITEM_CATEGORIES,
        statuses: ["In Stock", "Low Stock", "Out of Stock"]
      }
    });

  } catch (error) {
    console.error("Error fetching stock items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching stock items"
    });
  }
});

// ✅ GET stock item by ID
router.get("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");
    // Removed vendorCosts population since it doesn't exist anymore

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found"
      });
    }

    // If raw items have rawItemId references, populate them separately
    if (stockItem.rawItems && stockItem.rawItems.length > 0) {
      const rawItemIds = stockItem.rawItems
        .filter(item => item.rawItemId)
        .map(item => item.rawItemId);

      if (rawItemIds.length > 0) {
        const rawItemsData = await RawItem.find({ _id: { $in: rawItemIds } })
          .select("name sku customUnit unit sellingPrice customCategory category");

        // Map the raw item data back
        stockItem.rawItems = stockItem.rawItems.map(item => {
          const rawItemData = rawItemsData.find(ri => ri._id.toString() === item.rawItemId?.toString());
          if (rawItemData) {
            return {
              ...item.toObject(),
              rawItemData: {
                name: rawItemData.name,
                sku: rawItemData.sku,
                unit: rawItemData.customUnit || rawItemData.unit,
                category: rawItemData.customCategory || rawItemData.category,
                sellingPrice: rawItemData.sellingPrice
              }
            };
          }
          return item;
        });
      }
    }

    res.json({ success: true, stockItem });

  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching stock item"
    });
  }
});

// ✅ SEARCH raw items for stock item form with cost calculation
router.get("/search/raw-items", async (req, res) => {
  try {
    const { search = "", limit = 20 } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } },
        { customCategory: { $regex: search, $options: "i" } }
      ];
    }

    const rawItems = await RawItem.find(filter)
      .select("name sku category customCategory unit customUnit quantity sellingPrice stockTransactions")
      .limit(parseInt(limit))
      .sort({ name: 1 });

    // Process raw items to get latest cost from transactions
    const processedRawItems = rawItems.map(item => {
      // Get latest cost from stock transactions
      let latestCost = 0;
      if (item.stockTransactions && item.stockTransactions.length > 0) {
        // Filter for ADD or PURCHASE_ORDER transactions and sort by date (newest first)
        const purchaseTransactions = item.stockTransactions
          .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (purchaseTransactions.length > 0) {
          latestCost = purchaseTransactions[0].unitPrice || 0;
        }
      }

      // If no transaction cost, use selling price as fallback
      if (latestCost === 0 && item.sellingPrice) {
        latestCost = item.sellingPrice * 0.8; // 20% discount as estimated cost
      }

      return {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        unit: item.customUnit || item.unit || "Unit",
        quantity: item.quantity || 0,
        cost: latestCost,
        sellingPrice: item.sellingPrice || 0,
        currentStock: item.quantity || 0
      };
    });

    res.json({
      success: true,
      rawItems: processedRawItems,
      count: processedRawItems.length
    });

  } catch (error) {
    console.error("Error searching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while searching raw items"
    });
  }
});

// ✅ GET data for creating stock item (raw items, machines, etc.)
router.get("/data/create", async (req, res) => {
  try {
    // Get raw items with their latest cost from transactions
    const rawItems = await RawItem.find({})
      .select("name sku category unit quantity sellingPrice stockTransactions")
      .limit(20)
      .sort({ name: 1 });

    // Get machines
    const machines = await Machine.find({ status: "Operational" })
      .select("name type model serialNumber")
      .sort({ type: 1, name: 1 });

    // Get operator average salary
    const operators = await Employee.find({
      department: "Operator",
      status: "active"
    }).select("salary");

    const averageSalary = operators.length > 0 ?
      operators.reduce((sum, emp) => sum + (emp.salary?.netSalary || 0), 0) / operators.length : 0;

    // Process raw items to get latest cost from transactions
    const processedRawItems = rawItems.map(item => {
      // Get latest cost from stock transactions
      let latestCost = 0;
      if (item.stockTransactions && item.stockTransactions.length > 0) {
        // Filter for ADD or PURCHASE_ORDER transactions and sort by date (newest first)
        const purchaseTransactions = item.stockTransactions
          .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        if (purchaseTransactions.length > 0) {
          latestCost = purchaseTransactions[0].unitPrice || 0;
        }
      }

      // If no transaction cost, use selling price as fallback
      if (latestCost === 0 && item.sellingPrice) {
        latestCost = item.sellingPrice * 0.8; // 20% discount as estimated cost
      }

      return {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        unit: item.customUnit || item.unit || "Unit",
        quantity: item.quantity || 0,
        cost: latestCost, // Now using cost from transactions
        sellingPrice: item.sellingPrice || 0
      };
    });

    res.json({
      success: true,
      data: {
        categories: STOCK_ITEM_CATEGORIES,
        attributes: COMMON_ATTRIBUTES,
        operationTypes: OPERATION_TYPES,
        rawItems: processedRawItems, // Use processed items
        machines: machines.map(machine => ({
          id: machine._id,
          name: machine.name,
          type: machine.type,
          model: machine.model,
          serialNumber: machine.serialNumber
        })),
        averageOperatorSalary: Math.round(averageSalary)
      }
    });

  } catch (error) {
    console.error("Error fetching create data:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching create data"
    });
  }
});

// ✅ CREATE new stock item
// ✅ CREATE new stock item
router.post("/", async (req, res) => {
  try {
    const {
      name,
      productType,
      invoicingPolicy,
      trackInventory,
      category,
      hsnCode,
      internalNotes,
      unit,
      salesPrice,
      salesTax,
      cost,
      purchaseTax,
      quantityOnHand,
      minStock,
      maxStock,
      attributes,
      variants,
      measurements,
      numberOfPanels,
      rawItems,
      operations,
      miscellaneousCosts,
      images
    } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Product name is required"
      });
    }

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Category is required"
      });
    }

    if (!salesPrice || isNaN(salesPrice) || parseFloat(salesPrice) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid sales price is required"
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

    // Generate reference (SKU)
    const nameWords = name.trim().split(' ');
    const nameCode = nameWords.map(word => word.substring(0, 3).toUpperCase()).join('');
    const categoryCode = category.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`;

    // Check for duplicate reference
    const existingItem = await StockItem.findOne({ reference });
    if (existingItem) {
      return res.status(400).json({
        success: false,
        message: "A product with similar reference already exists"
      });
    }

    // Generate barcode (EAN-13 format for demo)
    const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');

    // Process raw items
    const processedRawItems = [];
    if (rawItems && Array.isArray(rawItems)) {
      for (const rawItem of rawItems) {
        if (rawItem.rawItemId && rawItem.quantity && rawItem.quantity > 0) {
          const rawItemData = await RawItem.findById(rawItem.rawItemId)
            .select("name sku customUnit unit stockTransactions sellingPrice customCategory category");

          if (rawItemData) {
            // Get latest cost from stock transactions
            let unitCost = 0;
            if (rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
              // Filter for ADD or PURCHASE_ORDER transactions and sort by date (newest first)
              const purchaseTransactions = rawItemData.stockTransactions
                .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
                .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

              if (purchaseTransactions.length > 0) {
                unitCost = purchaseTransactions[0].unitPrice || 0;
              }
            }

            // If no transaction cost, use selling price as fallback
            if (unitCost === 0 && rawItemData.sellingPrice) {
              unitCost = rawItemData.sellingPrice * 0.8; // 20% discount as estimated cost
            }

            processedRawItems.push({
              rawItemId: rawItem.rawItemId,
              name: rawItemData.name,
              sku: rawItemData.sku,
              quantity: parseFloat(rawItem.quantity),
              unit: rawItemData.customUnit || rawItemData.unit || "Unit",
              unitCost: unitCost,
              totalCost: parseFloat(rawItem.quantity) * unitCost
            });
          }
        }
      }
    }

    // Process operations
    const processedOperations = [];
    if (operations && Array.isArray(operations)) {
      operations.forEach(op => {
        const minutes = parseFloat(op.minutes) || 0;
        const seconds = parseFloat(op.seconds) || 0;
        const totalSeconds = (minutes * 60) + seconds;

        processedOperations.push({
          type: op.type || "",
          machine: op.machine || "",
          machineType: op.machineType || "",
          minutes: minutes,
          seconds: seconds,
          totalSeconds: totalSeconds,
          operatorSalary: parseFloat(op.operatorSalary) || 0,
          operatorCost: parseFloat(op.operatorCost) || 0
        });
      });
    }

    // Process miscellaneous costs
    const processedMiscellaneousCosts = [];
    if (miscellaneousCosts && Array.isArray(miscellaneousCosts)) {
      miscellaneousCosts.forEach(cost => {
        if (cost.name && cost.name.trim()) {
          processedMiscellaneousCosts.push({
            name: cost.name.trim(),
            amount: parseFloat(cost.amount) || 0,
            unit: cost.unit || "Fixed"
          });
        }
      });
    }

    // Process attributes
    const processedAttributes = [];
    if (attributes && Array.isArray(attributes)) {
      attributes.forEach(attr => {
        if (attr.name && attr.name.trim() && attr.values && Array.isArray(attr.values)) {
          processedAttributes.push({
            name: attr.name.trim(),
            values: attr.values.filter(val => val && val.trim()).map(val => val.trim())
          });
        }
      });
    }

    // Process measurements
    const processedMeasurements = [];
    if (measurements && Array.isArray(measurements)) {
      measurements.forEach(measurement => {
        if (measurement && measurement.trim()) {
          processedMeasurements.push(measurement.trim());
        }
      });
    }

    // Process variants
    const processedVariants = [];
    if (variants && Array.isArray(variants)) {
      variants.forEach((variant, index) => {
        const variantSku = `${reference}-V${(index + 1).toString().padStart(2, '0')}`;

        processedVariants.push({
          sku: variantSku,
          attributes: variant.attributes || [],
          quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
          minStock: parseFloat(variant.minStock) || 0,
          maxStock: parseFloat(variant.maxStock) || 0,
          cost: parseFloat(variant.cost) || 0,
          salesPrice: parseFloat(variant.salesPrice) || 0,
          barcode: variant.barcode || "",
          images: variant.images || []
        });
      });
    }

    // Create new stock item
    const newStockItem = new StockItem({
      name: name.trim(),
      reference: reference.toUpperCase(),
      productType: productType || "Goods",
      invoicingPolicy: invoicingPolicy || "Ordered quantities",
      trackInventory: trackInventory !== undefined ? trackInventory : true,
      category: category.trim(),
      barcode: barcode,
      hsnCode: hsnCode ? hsnCode.trim() : "",
      internalNotes: internalNotes ? internalNotes.trim() : "",
      unit: unit || "Units",
      salesPrice: parseFloat(salesPrice),
      salesTax: salesTax || "5% GST S",
      cost: parseFloat(cost) || 0,
      purchaseTax: purchaseTax || "5% GST P",
      quantityOnHand: parseFloat(quantityOnHand) || 0,
      minStock: parseFloat(minStock),
      maxStock: parseFloat(maxStock),
      attributes: processedAttributes,
      measurements: processedMeasurements,
      numberOfPanels: parseInt(numberOfPanels) || 0,
      variants: processedVariants,
      rawItems: processedRawItems,
      operations: processedOperations,
      miscellaneousCosts: processedMiscellaneousCosts,
      images: images || [],
      createdBy: req.user.id
    });

    await newStockItem.save();

    // Calculate and update totals
    const totalCost = calculateStockItemCost(newStockItem);
    const profitMargin = ((newStockItem.salesPrice - totalCost) / totalCost * 100) || 0;
    const inventoryValue = newStockItem.quantityOnHand * totalCost;
    const potentialRevenue = newStockItem.quantityOnHand * newStockItem.salesPrice;

    newStockItem.totalCost = totalCost;
    newStockItem.profitMargin = profitMargin;
    newStockItem.inventoryValue = inventoryValue;
    newStockItem.potentialRevenue = potentialRevenue;

    await newStockItem.save();

    res.status(201).json({
      success: true,
      message: "Stock item created successfully",
      stockItem: newStockItem
    });

  } catch (error) {
    console.error("Error creating stock item:", error);

    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Product with this reference already exists"
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while creating stock item"
    });
  }
});

// ✅ UPDATE stock item
// ✅ UPDATE stock item
router.put("/:id", async (req, res) => {
  try {
    const {
      name,
      productType,
      invoicingPolicy,
      trackInventory,
      category,
      hsnCode,
      internalNotes,
      unit,
      salesPrice,
      salesTax,
      cost,
      purchaseTax,
      quantityOnHand,
      minStock,
      maxStock,
      attributes,
      variants,
      measurements,
      numberOfPanels,
      rawItems,
      operations,
      miscellaneousCosts,
      images
    } = req.body;

    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found"
      });
    }

    // Update basic fields if provided
    if (name !== undefined) stockItem.name = name.trim();
    if (productType !== undefined) stockItem.productType = productType;
    if (invoicingPolicy !== undefined) stockItem.invoicingPolicy = invoicingPolicy;
    if (trackInventory !== undefined) stockItem.trackInventory = trackInventory;
    if (category !== undefined) stockItem.category = category.trim();
    if (hsnCode !== undefined) stockItem.hsnCode = hsnCode ? hsnCode.trim() : "";
    if (internalNotes !== undefined) stockItem.internalNotes = internalNotes ? internalNotes.trim() : "";
    if (unit !== undefined) stockItem.unit = unit;
    if (salesPrice !== undefined) stockItem.salesPrice = parseFloat(salesPrice);
    if (salesTax !== undefined) stockItem.salesTax = salesTax;
    if (cost !== undefined) stockItem.cost = parseFloat(cost) || 0;
    if (purchaseTax !== undefined) stockItem.purchaseTax = purchaseTax;
    if (quantityOnHand !== undefined) stockItem.quantityOnHand = parseFloat(quantityOnHand) || 0;
    if (minStock !== undefined) stockItem.minStock = parseFloat(minStock);
    if (maxStock !== undefined) stockItem.maxStock = parseFloat(maxStock);

    // Update raw items
    if (rawItems !== undefined) {
      const processedRawItems = [];
      if (Array.isArray(rawItems)) {
        for (const rawItem of rawItems) {
          if (rawItem.rawItemId && rawItem.quantity && rawItem.quantity > 0) {
            const rawItemData = await RawItem.findById(rawItem.rawItemId)
              .select("name sku customUnit unit stockTransactions sellingPrice customCategory category");

            if (rawItemData) {
              // Get latest cost from stock transactions
              let unitCost = 0;
              if (rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
                // Filter for ADD or PURCHASE_ORDER transactions and sort by date (newest first)
                const purchaseTransactions = rawItemData.stockTransactions
                  .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
                  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

                if (purchaseTransactions.length > 0) {
                  unitCost = purchaseTransactions[0].unitPrice || 0;
                }
              }

              // If no transaction cost, use selling price as fallback
              if (unitCost === 0 && rawItemData.sellingPrice) {
                unitCost = rawItemData.sellingPrice * 0.8; // 20% discount as estimated cost
              }

              processedRawItems.push({
                rawItemId: rawItem.rawItemId,
                name: rawItemData.name,
                sku: rawItemData.sku,
                quantity: parseFloat(rawItem.quantity),
                unit: rawItemData.customUnit || rawItemData.unit || "Unit",
                unitCost: unitCost,
                totalCost: parseFloat(rawItem.quantity) * unitCost
              });
            }
          }
        }
      }
      stockItem.rawItems = processedRawItems;
    }

    // Update operations
    if (operations !== undefined) {
      const processedOperations = [];
      if (Array.isArray(operations)) {
        operations.forEach(op => {
          const minutes = parseFloat(op.minutes) || 0;
          const seconds = parseFloat(op.seconds) || 0;
          const totalSeconds = (minutes * 60) + seconds;

          processedOperations.push({
            type: op.type || "",
            machine: op.machine || "",
            machineType: op.machineType || "",
            minutes: minutes,
            seconds: seconds,
            totalSeconds: totalSeconds,
            operatorSalary: parseFloat(op.operatorSalary) || 0,
            operatorCost: parseFloat(op.operatorCost) || 0
          });
        });
      }
      stockItem.operations = processedOperations;
    }

    // Update miscellaneous costs
    if (miscellaneousCosts !== undefined) {
      const processedMiscellaneousCosts = [];
      if (Array.isArray(miscellaneousCosts)) {
        miscellaneousCosts.forEach(cost => {
          if (cost.name && cost.name.trim()) {
            processedMiscellaneousCosts.push({
              name: cost.name.trim(),
              amount: parseFloat(cost.amount) || 0,
              unit: cost.unit || "Fixed"
            });
          }
        });
      }
      stockItem.miscellaneousCosts = processedMiscellaneousCosts;
    }

    // Update attributes
    if (attributes !== undefined) {
      const processedAttributes = [];
      if (Array.isArray(attributes)) {
        attributes.forEach(attr => {
          if (attr.name && attr.name.trim() && attr.values && Array.isArray(attr.values)) {
            processedAttributes.push({
              name: attr.name.trim(),
              values: attr.values.filter(val => val && val.trim()).map(val => val.trim())
            });
          }
        });
      }
      stockItem.attributes = processedAttributes;
    }

    // Update measurements
    if (measurements !== undefined) {
      const processedMeasurements = [];
      if (Array.isArray(measurements)) {
        measurements.forEach(measurement => {
          if (measurement && measurement.trim()) {
            processedMeasurements.push(measurement.trim());
          }
        });
      }
      stockItem.measurements = processedMeasurements;
    }

    if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;

    // Update variants
    if (variants !== undefined) {
      const processedVariants = [];
      if (Array.isArray(variants)) {
        variants.forEach((variant, index) => {
          const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(2, '0')}`;

          processedVariants.push({
            sku: variantSku,
            attributes: variant.attributes || [],
            quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
            minStock: parseFloat(variant.minStock) || 0,
            maxStock: parseFloat(variant.maxStock) || 0,
            cost: parseFloat(variant.cost) || 0,
            salesPrice: parseFloat(variant.salesPrice) || 0,
            barcode: variant.barcode || "",
            images: variant.images || []
          });
        });
      }
      stockItem.variants = processedVariants;
    }

    // Update images
    if (images !== undefined) {
      stockItem.images = images || [];
    }

    stockItem.updatedBy = req.user.id;

    // Calculate and update totals
    const totalCost = calculateStockItemCost(stockItem);
    const profitMargin = ((stockItem.salesPrice - totalCost) / totalCost * 100) || 0;
    const inventoryValue = stockItem.quantityOnHand * totalCost;
    const potentialRevenue = stockItem.quantityOnHand * stockItem.salesPrice;

    stockItem.totalCost = totalCost;
    stockItem.profitMargin = profitMargin;
    stockItem.inventoryValue = inventoryValue;
    stockItem.potentialRevenue = potentialRevenue;

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
    res.status(500).json({
      success: false,
      message: "Server error while updating stock item"
    });
  }
});

// ✅ DELETE stock item
router.delete("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found"
      });
    }

    await stockItem.deleteOne();

    res.json({
      success: true,
      message: "Stock item deleted successfully"
    });

  } catch (error) {
    console.error("Error deleting stock item:", error);
    res.status(500).json({
      success: false,
      message: "Server error while deleting stock item"
    });
  }
});

// ✅ UPDATE stock quantity
router.patch("/:id/quantity", async (req, res) => {
  try {
    const { quantity, type, variantSku, notes } = req.body;

    if (!quantity || isNaN(quantity) || quantity < 0) {
      return res.status(400).json({
        success: false,
        message: "Valid quantity is required"
      });
    }

    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found"
      });
    }

    let newQuantity = stockItem.quantityOnHand;
    if (type === "add") {
      newQuantity += parseFloat(quantity);
    } else if (type === "subtract") {
      newQuantity -= parseFloat(quantity);
      if (newQuantity < 0) newQuantity = 0;
    } else {
      newQuantity = parseFloat(quantity);
    }

    stockItem.quantityOnHand = newQuantity;
    stockItem.updatedBy = req.user.id;

    await stockItem.save();

    res.json({
      success: true,
      message: `Quantity updated to ${newQuantity}`,
      stockItem
    });

  } catch (error) {
    console.error("Error updating quantity:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating quantity"
    });
  }
});

module.exports = router;