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

// Apply auth middleware to all routes
router.use(EmployeeAuthMiddleware);

// ✅ GET all stock items with variants
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category } = req.query;

    let filter = {};

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { "variants.sku": { $regex: search, $options: "i" } }
      ];
    }

    if (status) {
      filter.status = status;
    }

    if (category) {
      filter.category = category;
    }

    const stockItems = await StockItem.find(filter)
      .select("name reference category unit totalQuantityOnHand averageCost averageSalesPrice status images variants")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ createdAt: -1 });

    // Calculate statistics
    const total = await StockItem.countDocuments();
    const lowStock = await StockItem.countDocuments({ status: "Low Stock" });
    const outOfStock = await StockItem.countDocuments({ status: "Out of Stock" });
    
    // Count total variants across all stock items
    const totalVariants = stockItems.reduce((sum, item) => sum + (item.variants?.length || 0), 0);

    res.json({
      success: true,
      stockItems,
      stats: {
        total,
        lowStock,
        outOfStock,
        totalVariants,
        totalStockItems: total
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

// ✅ GET stock item by ID with variants
router.get("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email");

    if (!stockItem) {
      return res.status(404).json({
        success: false,
        message: "Stock item not found"
      });
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

    // Process raw items with their variants
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

      // If raw item has variants, include them
      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => {
          // Get latest cost for this variant from stock transactions
          let latestCost = 0;
          if (item.stockTransactions && item.stockTransactions.length > 0) {
            const variantTransactions = item.stockTransactions
              .filter(tx => 
                tx.variantId && 
                tx.variantId.toString() === variant._id.toString() &&
                (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")
              )
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            if (variantTransactions.length > 0) {
              latestCost = variantTransactions[0].unitPrice || 0;
            }
          }

          // If no variant-specific cost, use base selling price
          if (latestCost === 0 && item.sellingPrice) {
            latestCost = item.sellingPrice * 0.8;
          }

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
        // For raw items without variants, create a default variant
        let latestCost = 0;
        if (item.stockTransactions && item.stockTransactions.length > 0) {
          const purchaseTransactions = item.stockTransactions
            .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

          if (purchaseTransactions.length > 0) {
            latestCost = purchaseTransactions[0].unitPrice || 0;
          }
        }

        if (latestCost === 0 && item.sellingPrice) {
          latestCost = item.sellingPrice * 0.8;
        }

        baseItem.variants = [{
          id: item._id, // Use raw item ID as variant ID
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

    res.json({
      success: true,
      rawItems: processedRawItems
    });

  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching raw items"
    });
  }
});

// ✅ GET data for creating stock item
router.get("/data/create", async (req, res) => {
  try {
    // Get raw items with variants
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

      // Add variants if they exist
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

// ✅ CREATE new stock item with variants
router.post("/", async (req, res) => {
  try {
    const {
      name,
      productType,
      category,
      unit,
      baseSalesPrice,
      baseCost,
      attributes,
      variants,
      measurements,
      numberOfPanels,
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

    if (!baseSalesPrice || isNaN(baseSalesPrice) || parseFloat(baseSalesPrice) <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid base sales price is required"
      });
    }

    if (!attributes || !Array.isArray(attributes) || attributes.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one attribute is required for variants"
      });
    }

    if (!variants || !Array.isArray(variants) || variants.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one variant is required"
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

    // Generate barcode
    const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, '0');

    // Process attributes
    const processedAttributes = attributes.filter(attr => 
      attr.name && attr.name.trim() && 
      attr.values && Array.isArray(attr.values) && attr.values.length > 0
    ).map(attr => ({
      name: attr.name.trim(),
      values: attr.values.filter(val => val && val.trim()).map(val => val.trim())
    }));

    // Process variants
    const processedVariants = await Promise.all(variants.map(async (variant, index) => {
      const variantSku = `${reference}-V${(index + 1).toString().padStart(3, '0')}`;
      const variantBarcode = `${barcode}-${(index + 1).toString().padStart(3, '0')}`;

      // Process raw items for this variant
      const processedRawItems = [];
      if (variant.rawItems && Array.isArray(variant.rawItems)) {
        for (const rawItem of variant.rawItems) {
          if (rawItem.rawItemId && rawItem.quantity && rawItem.quantity > 0) {
            const rawItemData = await RawItem.findById(rawItem.rawItemId)
              .select("name sku unit customUnit variants stockTransactions");

            if (rawItemData) {
              let unitCost = 0;
              let variantCombination = [];
              let variantId = rawItemData._id;

              // If variantId is provided (specific variant of raw item)
              if (rawItem.variantId) {
                const rawItemVariant = rawItemData.variants.id(rawItem.variantId);
                if (rawItemVariant) {
                  variantCombination = rawItemVariant.combination || [];
                  variantId = rawItem.variantId;
                  
                  // Get cost for this specific variant
                  if (rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
                    const variantTransactions = rawItemData.stockTransactions
                      .filter(tx => 
                        tx.variantId && 
                        tx.variantId.toString() === rawItem.variantId &&
                        (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")
                      )
                      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

                    if (variantTransactions.length > 0) {
                      unitCost = variantTransactions[0].unitPrice || 0;
                    }
                  }
                }
              }

              // If no variant-specific cost found
              if (unitCost === 0 && rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
                const purchaseTransactions = rawItemData.stockTransactions
                  .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
                  .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

                if (purchaseTransactions.length > 0) {
                  unitCost = purchaseTransactions[0].unitPrice || 0;
                }
              }

              processedRawItems.push({
                rawItemId: rawItemData._id,
                rawItemName: rawItemData.name,
                rawItemSku: rawItemData.sku,
                variantId: variantId,
                variantCombination: variantCombination,
                quantity: parseFloat(rawItem.quantity),
                unit: rawItemData.customUnit || rawItemData.unit || "Unit",
                unitCost: unitCost,
                totalCost: parseFloat(rawItem.quantity) * unitCost
              });
            }
          }
        }
      }

      return {
        sku: variantSku,
        attributes: variant.attributes || [],
        quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
        minStock: parseFloat(variant.minStock) || 10,
        maxStock: parseFloat(variant.maxStock) || 100,
        cost: parseFloat(variant.cost) || parseFloat(baseCost) || 0,
        salesPrice: parseFloat(variant.salesPrice) || parseFloat(baseSalesPrice),
        barcode: variantBarcode,
        images: variant.images || images || [],
        rawItems: processedRawItems
      };
    }));

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

    // Create new stock item
    const newStockItem = new StockItem({
      name: name.trim(),
      reference: reference.toUpperCase(),
      productType: productType || "Goods",
      category: category.trim(),
      unit: unit || "Units",
      baseSalesPrice: parseFloat(baseSalesPrice),
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

    await newStockItem.save();

    res.status(201).json({
      success: true,
      message: "Stock item created successfully with variants",
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

// ✅ UPDATE stock item with variants
router.put("/:id", async (req, res) => {
  try {
    const {
      name,
      productType,
      category,
      unit,
      baseSalesPrice,
      baseCost,
      attributes,
      variants,
      measurements,
      numberOfPanels,
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

    // Update basic fields
    if (name !== undefined) stockItem.name = name.trim();
    if (productType !== undefined) stockItem.productType = productType;
    if (category !== undefined) stockItem.category = category.trim();
    if (unit !== undefined) stockItem.unit = unit;
    if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice);
    if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;

    // Update attributes
    if (attributes !== undefined) {
      const processedAttributes = attributes.filter(attr => 
        attr.name && attr.name.trim() && 
        attr.values && Array.isArray(attr.values) && attr.values.length > 0
      ).map(attr => ({
        name: attr.name.trim(),
        values: attr.values.filter(val => val && val.trim()).map(val => val.trim())
      }));
      stockItem.attributes = processedAttributes;
    }

    // Update measurements
    if (measurements !== undefined) {
      stockItem.measurements = measurements.filter(m => m && m.trim()).map(m => m.trim());
    }

    if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;

    // Update variants
    if (variants !== undefined) {
      const processedVariants = await Promise.all(variants.map(async (variant, index) => {
        const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, '0')}`;
        const variantBarcode = variant.barcode || `${stockItem.barcode}-${(index + 1).toString().padStart(3, '0')}`;

        // Process raw items for this variant
        const processedRawItems = [];
        if (variant.rawItems && Array.isArray(variant.rawItems)) {
          for (const rawItem of variant.rawItems) {
            if (rawItem.rawItemId && rawItem.quantity && rawItem.quantity > 0) {
              const rawItemData = await RawItem.findById(rawItem.rawItemId)
                .select("name sku unit customUnit variants stockTransactions");

              if (rawItemData) {
                let unitCost = 0;
                let variantCombination = [];
                let variantId = rawItemData._id;

                if (rawItem.variantId) {
                  const rawItemVariant = rawItemData.variants.id(rawItem.variantId);
                  if (rawItemVariant) {
                    variantCombination = rawItemVariant.combination || [];
                    variantId = rawItem.variantId;
                    
                    if (rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
                      const variantTransactions = rawItemData.stockTransactions
                        .filter(tx => 
                          tx.variantId && 
                          tx.variantId.toString() === rawItem.variantId &&
                          (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD")
                        )
                        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

                      if (variantTransactions.length > 0) {
                        unitCost = variantTransactions[0].unitPrice || 0;
                      }
                    }
                  }
                }

                if (unitCost === 0 && rawItemData.stockTransactions && rawItemData.stockTransactions.length > 0) {
                  const purchaseTransactions = rawItemData.stockTransactions
                    .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
                    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

                  if (purchaseTransactions.length > 0) {
                    unitCost = purchaseTransactions[0].unitPrice || 0;
                  }
                }

                processedRawItems.push({
                  rawItemId: rawItemData._id,
                  rawItemName: rawItemData.name,
                  rawItemSku: rawItemData.sku,
                  variantId: variantId,
                  variantCombination: variantCombination,
                  quantity: parseFloat(rawItem.quantity),
                  unit: rawItemData.customUnit || rawItemData.unit || "Unit",
                  unitCost: unitCost,
                  totalCost: parseFloat(rawItem.quantity) * unitCost
                });
              }
            }
          }
        }

        return {
          sku: variantSku,
          attributes: variant.attributes || [],
          quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
          minStock: parseFloat(variant.minStock) || 10,
          maxStock: parseFloat(variant.maxStock) || 100,
          cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
          salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice,
          barcode: variantBarcode,
          images: variant.images || stockItem.images || [],
          rawItems: processedRawItems
        };
      }));

      stockItem.variants = processedVariants;
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

    // Update images
    if (images !== undefined) {
      stockItem.images = images || [];
    }

    stockItem.updatedBy = req.user.id;
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

module.exports = router;