// routes/CMS_Routes/Inventory/Products/stockItemRoutes.js

const express = require("express");
const router = express.Router();
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const OperationGroup = require("../../../../models/CMS_Models/Inventory/Configurations/OperationGroup");

const STOCK_ITEM_CATEGORIES = [
  "T-Shirts", "Shirts", "Jeans", "Bottoms", "Ethnic Wear",
  "Kids Wear", "Sportswear", "Sweatshirts", "Outerwear",
  "Accessories", "Innerwear", "Formal Wear", "Casual Wear",
  "Traditional Wear", "Winter Wear", "Summer Wear"
];

const OPERATION_TYPES = [
  "Cutting", "Stitching", "Finishing", "Printing", "Embroidery",
  "Washing", "Ironing", "Quality Check", "Packing", "Labeling"
];

router.use(EmployeeAuthMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build a map of unitName → { baseUnit, conversions: [{toUnit, factor}] }
// ─────────────────────────────────────────────────────────────────────────────
async function buildUnitConversionsMap() {
  try {
    const units = await Unit.find({ status: "Active" }).populate("conversions.toUnit", "name");
    const map = {};

    units.forEach(u => {
      if (!map[u.name]) map[u.name] = { baseUnit: u.name, conversions: [] };
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName) return;
        map[u.name].conversions.push({ toUnit: toUnitName, factor: c.quantity });
      });
    });

    units.forEach(u => {
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName || !c.quantity) return;
        if (!map[toUnitName]) map[toUnitName] = { baseUnit: toUnitName, conversions: [] };
        const alreadyHas = map[toUnitName].conversions.some(x => x.toUnit === u.name);
        if (!alreadyHas) {
          map[toUnitName].conversions.push({ toUnit: u.name, factor: 1 / c.quantity });
        }
      });
    });

    return map;
  } catch (err) {
    console.error("buildUnitConversionsMap:", err);
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: process raw items for a variant
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

    const registeredUnit = rawItemData.customUnit || rawItemData.unit || "Unit";
    const chosenUnit = rawItem.unit || registeredUnit;
    const baseUnit = rawItem.baseUnit || registeredUnit;

    processedRawItems.push({
      rawItemId: rawItemData._id,
      rawItemName: rawItemData.name,
      rawItemSku: rawItemData.sku,
      variantId,
      variantCombination,
      quantity: parseFloat(rawItem.quantity),
      unit: chosenUnit,
      baseUnit,
      unitCost,
      totalCost: parseFloat(rawItem.quantity) * unitCost
    });
  }

  return processedRawItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute and update aggregate fields
// ─────────────────────────────────────────────────────────────────────────────
function updateStockItemAggregates(stockItem) {
  const variants = stockItem.variants || [];

  stockItem.totalQuantityOnHand = variants.reduce((s, v) => s + (v.quantityOnHand || 0), 0);

  if (variants.length > 0) {
    stockItem.averageCost = variants.reduce((s, v) => s + (v.cost || 0), 0) / variants.length;
    stockItem.averageSalesPrice = variants.reduce((s, v) => s + (v.salesPrice || 0), 0) / variants.length;
  } else {
    stockItem.averageCost = stockItem.baseCost || 0;
    stockItem.averageSalesPrice = stockItem.baseSalesPrice || 0;
  }

  if (stockItem.averageCost > 0 && stockItem.averageSalesPrice > 0) {
    stockItem.profitMargin = ((stockItem.averageSalesPrice - stockItem.averageCost) / stockItem.averageCost) * 100;
  } else {
    stockItem.profitMargin = 0;
  }

  stockItem.inventoryValue = stockItem.averageCost * stockItem.totalQuantityOnHand;
  stockItem.potentialRevenue = stockItem.averageSalesPrice * stockItem.totalQuantityOnHand;

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

  stockItem.variants = variants.map(v => {
    if ((v.quantityOnHand || 0) <= 0) v.status = "Out of Stock";
    else if ((v.quantityOnHand || 0) <= (v.minStock || 10)) v.status = "Low Stock";
    else v.status = "In Stock";
    return v;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation routes (keep existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { type, machine, machineType, totalSeconds, minutes, seconds, operatorSalary, operatorCost } = req.body;

    if (!type || !machineType) {
      return res.status(400).json({ success: false, message: "type and machineType are required" });
    }

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const alreadyExists = (stockItem.operations || []).some(
      (op) => op.type === type && op.machineType === machineType
    );
    if (alreadyExists) {
      return res.json({ success: true, message: "Operation already exists on product (no duplicate added)", skipped: true });
    }

    const newOp = { type, machine: machine || machineType, machineType, totalSeconds: totalSeconds || 0, minutes: minutes || 0, seconds: seconds || 0, operatorSalary: operatorSalary || 0, operatorCost: operatorCost || 0 };
    stockItem.operations.push(newOp);
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();

    return res.json({ success: true, message: "Operation added to product successfully", operation: stockItem.operations[stockItem.operations.length - 1] });
  } catch (error) {
    console.error("Error adding operation to stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

router.delete("/:id/operations/by-type", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationType, machineType } = req.body;
    if (!operationType) return res.status(400).json({ success: false, message: "operationType is required" });

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const originalCount = stockItem.operations.length;
    stockItem.operations = stockItem.operations.filter((op) => {
      const typeMatch = op.type === operationType;
      const machineMatch = machineType ? op.machineType === machineType : true;
      return !(typeMatch && machineMatch);
    });

    const removed = originalCount - stockItem.operations.length;
    if (removed === 0) return res.json({ success: true, message: "No matching operation found on product (nothing removed)", removed: 0 });

    stockItem.updatedBy = req.user?.id;
    await stockItem.save();
    return res.json({ success: true, message: `Removed ${removed} operation(s) from product`, removed });
  } catch (error) {
    console.error("Error removing operation from stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

router.delete("/:id/operations/:operationIndex", async (req, res) => {
  try {
    const { id, operationIndex } = req.params;
    const idx = parseInt(operationIndex, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ success: false, message: "operationIndex must be a non-negative integer" });

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    if (idx >= stockItem.operations.length) return res.status(400).json({ success: false, message: `operationIndex ${idx} is out of range` });

    stockItem.operations.splice(idx, 1);
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();
    return res.json({ success: true, message: "Operation removed from product successfully" });
  } catch (error) {
    console.error("Error removing operation from stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Specific /data/* routes MUST be defined BEFORE /:id routes
// ─────────────────────────────────────────────────────────────────────────────

// ✅ GET raw items with their variants + unit conversions for stock item form
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

    const unitConversionsMap = await buildUnitConversionsMap();

    const processedRawItems = rawItems.map(item => {
      const baseUnitName = item.customUnit || item.unit || "Unit";
      const baseItem = {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        baseUnit: baseUnitName,
        baseQuantity: item.quantity || 0,
        baseSellingPrice: item.sellingPrice || 0,
        hasVariants: item.variants && item.variants.length > 0,
        variants: [],
        unitConversions: unitConversionsMap[baseUnitName]?.conversions || []
      };

      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => {
          let latestCost = 0;
          if (item.stockTransactions && item.stockTransactions.length > 0) {
            const variantTransactions = item.stockTransactions
              .filter(tx => tx.variantId && tx.variantId.toString() === variant._id.toString() && (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD"))
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            if (variantTransactions.length > 0) latestCost = variantTransactions[0].unitPrice || 0;
          }
          if (latestCost === 0 && item.sellingPrice) latestCost = item.sellingPrice * 0.8;
          return { id: variant._id, combination: variant.combination || [], combinationText: variant.combination?.join(" • ") || "Default", quantity: variant.quantity || 0, unit: baseUnitName, cost: latestCost, status: variant.status || "Out of Stock", sku: variant.sku || `${baseItem.sku}-var` };
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
        baseItem.variants = [{ id: item._id, combination: [], combinationText: "Default", quantity: item.quantity || 0, unit: baseUnitName, cost: latestCost, status: item.status || "Out of Stock", sku: baseItem.sku }];
      }

      return baseItem;
    });

    res.json({ success: true, rawItems: processedRawItems });
  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw items" });
  }
});

// ✅ GET data for creating stock item
router.get("/data/create", async (req, res) => {
  try {
    const rawItemsResponse = await RawItem.find({})
      .select("name sku category unit variants quantity sellingPrice stockTransactions")
      .limit(20)
      .sort({ name: 1 });

    const unitConversionsMap = await buildUnitConversionsMap();

    const processedRawItems = rawItemsResponse.map(item => {
      const baseUnit = item.unit || "Unit";
      const baseItem = {
        id: item._id, name: item.name, sku: item.sku,
        category: item.category || "Uncategorized", baseUnit,
        hasVariants: item.variants && item.variants.length > 0,
        variants: [],
        unitConversions: unitConversionsMap[baseUnit]?.conversions || []
      };
      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => ({
          id: variant._id, combination: variant.combination || [],
          combinationText: variant.combination?.join(" • ") || "Default",
          quantity: variant.quantity || 0, unit: baseUnit,
          cost: item.sellingPrice ? item.sellingPrice * 0.8 : 0,
          status: variant.status || "Out of Stock"
        }));
      }
      return baseItem;
    });

    const machines = await Machine.find({ status: "Operational" })
      .select("name type model serialNumber").sort({ type: 1, name: 1 });

    const operators = await Employee.find({ department: "Operator", status: "active" }).select("salary");
    const averageSalary = operators.length > 0
      ? operators.reduce((sum, emp) => sum + (emp.salary?.netSalary || 0), 0) / operators.length
      : 0;

    const [registeredOperations, registeredGroups] = await Promise.all([
      Operation.find().sort({ name: 1 }),
      OperationGroup.find().populate("operations", "name operationCode totalSam durationSeconds machineType").sort({ name: 1 })
    ]);

    res.json({
      success: true,
      data: {
        categories: STOCK_ITEM_CATEGORIES,
        operationTypes: OPERATION_TYPES,
        rawItems: processedRawItems,
        machines: machines.map(m => ({ id: m._id, name: m.name, type: m.type, model: m.model, serialNumber: m.serialNumber })),
        averageOperatorSalary: Math.round(averageSalary),
        registeredOperations: registeredOperations.map(op => ({ _id: op._id, name: op.name, operationCode: op.operationCode || op.code || "", totalSam: op.totalSam, durationSeconds: op.durationSeconds, machineType: op.machineType })),
        registeredGroups: registeredGroups.map(grp => ({ _id: grp._id, name: grp.name, operations: grp.operations })),
        unitConversions: unitConversionsMap
      }
    });
  } catch (error) {
    console.error("Error fetching create data:", error);
    res.status(500).json({ success: false, message: "Server error while fetching create data" });
  }
});

// ✅ Tab-specific data fetch endpoint
router.get("/:id/tab/:tabName", async (req, res) => {
  try {
    const { id, tabName } = req.params;
    let selectFields = "";

    switch (tabName) {
      case "general":       selectFields = "name additionalNames productType category unit hsnCode baseSalesPrice baseCost internalNotes numberOfPanels reference images genderCategory"; break;
      case "attributes":    selectFields = "attributes"; break;
      case "variants":      selectFields = "variants attributes reference baseCost baseSalesPrice"; break;
      case "raw-items":     selectFields = "variants.rawItems variants._id variants.attributes variants.sku"; break;
      case "operations":    selectFields = "operations"; break;
      case "measurements":  selectFields = "measurements numberOfPanels"; break;
      case "costs":         selectFields = "miscellaneousCosts"; break;
      default:              selectFields = "name category";
    }

    const stockItem = await StockItem.findById(id).select(selectFields);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const response = { success: true, tab: tabName, data: stockItem };

    if (tabName === "operations") {
      const [registeredOperations, registeredGroups] = await Promise.all([
        Operation.find().sort({ name: 1 }),
        OperationGroup.find().populate("operations", "name operationCode totalSam durationSeconds machineType").sort({ name: 1 })
      ]);
      response.registeredOperations = registeredOperations.map(op => ({ _id: op._id, name: op.name,operationCode: op.operationCode || op.code || "", totalSam: op.totalSam, durationSeconds: op.durationSeconds, machineType: op.machineType }));
      response.registeredGroups = registeredGroups.map(grp => ({ _id: grp._id, name: grp.name, operations: grp.operations }));
    }

    res.json(response);
  } catch (error) {
    console.error(`Error fetching tab data (${req.params.tabName}):`, error);
    res.status(500).json({ success: false, message: "Server error while fetching tab data" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ NEW: Tab-wise PATCH endpoints — each saves ONLY that tab's fields
//    PATCH /api/cms/stock-items/:id/tab/:tabName
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/tab/:tabName", async (req, res) => {
  try {
    const { id, tabName } = req.params;
    const body = req.body;

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    switch (tabName) {

      // ── General Info ────────────────────────────────────────────────────
      case "general": {
        const { name, additionalNames, productType, category, unit, hsnCode, genderCategory, baseSalesPrice, baseCost, internalNotes, numberOfPanels, images } = body;
        if (name !== undefined) stockItem.name = name.trim();
        if (productType !== undefined) stockItem.productType = productType;
        if (category !== undefined) stockItem.category = category.trim();
        if (unit !== undefined) stockItem.unit = unit;
        if (hsnCode !== undefined) stockItem.hsnCode = hsnCode;
        if (internalNotes !== undefined) stockItem.internalNotes = internalNotes;
        if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice) || 0;
        if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;
        if (genderCategory !== undefined) stockItem.genderCategory = genderCategory;
        if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;
        if (images !== undefined) stockItem.images = images || [];
        if (additionalNames !== undefined) {
          stockItem.additionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
            .map(n => n?.trim()).filter(n => n && n.length > 0);
        }
        break;
      }

      // ── Attributes ──────────────────────────────────────────────────────
      case "attributes": {
        const { attributes } = body;
        if (attributes !== undefined) {
          stockItem.attributes = (attributes || [])
            .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(v => v?.trim()).map(v => v.trim())
            }));
        }
        break;
      }

      // ── Variants ────────────────────────────────────────────────────────
      case "variants": {
        const { variants } = body;
        if (variants !== undefined) {
          const existingVariantsById = {};
          stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

          const processedVariants = await Promise.all(
            variants.map(async (variant, index) => {
              const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, "0")}`;

              if (variant._id && existingVariantsById[variant._id.toString()]) {
                const existing = existingVariantsById[variant._id.toString()];
                existing.sku = variantSku;
                existing.attributes = variant.attributes || existing.attributes;
                existing.quantityOnHand = parseFloat(variant.quantityOnHand) ?? existing.quantityOnHand;
                existing.minStock = parseFloat(variant.minStock) || existing.minStock || 10;
                existing.maxStock = parseFloat(variant.maxStock) || existing.maxStock || 100;
                existing.cost = parseFloat(variant.cost) || stockItem.baseCost || 0;
                existing.salesPrice = parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0;
                existing.barcode = variant.barcode || existing.barcode || "";
                existing.images = variant.images || existing.images || [];
                return existing;
              }

              return {
                sku: variantSku,
                attributes: variant.attributes || [],
                quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
                minStock: parseFloat(variant.minStock) || 10,
                maxStock: parseFloat(variant.maxStock) || 100,
                cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
                salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0,
                barcode: variant.barcode || "",
                images: variant.images || [],
                rawItems: []
              };
            })
          );
          stockItem.variants = processedVariants;
          updateStockItemAggregates(stockItem);
        }
        break;
      }

      // ── Raw Items ────────────────────────────────────────────────────────
      // Saves raw items for each variant individually — does NOT touch
      // operations, costs, or any other field.
      case "raw-items": {
        const { variants } = body;
        if (variants !== undefined) {
          const existingVariantsById = {};
          stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

          for (const dv of variants) {
            const match = dv._id && existingVariantsById[dv._id.toString()];
            if (match) {
              match.rawItems = await processVariantRawItems(dv.rawItems || []);
            }
          }
        }
        break;
      }

      // ── Operations ───────────────────────────────────────────────────────
      case "operations": {
        const { operations } = body;
        if (operations !== undefined) {
          stockItem.operations = (Array.isArray(operations) ? operations : []).map(op => {
            const minutes = parseFloat(op.minutes) || 0;
            const seconds = parseFloat(op.seconds) || 0;
            return {
              type: op.type || "",
              operationCode: op.operationCode || "",
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
        break;
      }

      // ── Measurements ─────────────────────────────────────────────────────
      case "measurements": {
        const { measurements, numberOfPanels } = body;
        if (measurements !== undefined) {
          stockItem.measurements = (Array.isArray(measurements) ? measurements : [])
            .filter(m => m?.trim()).map(m => m.trim());
        }
        if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;
        break;
      }

      // ── Costs ────────────────────────────────────────────────────────────
      case "costs": {
        const { miscellaneousCosts } = body;
        if (miscellaneousCosts !== undefined) {
          stockItem.miscellaneousCosts = (Array.isArray(miscellaneousCosts) ? miscellaneousCosts : [])
            .filter(c => c.name?.trim())
            .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));
        }
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown tab: ${tabName}` });
    }

    stockItem.updatedBy = req.user.id;
    await stockItem.save();

    res.json({
      success: true,
      message: `${tabName} saved successfully`,
      tab: tabName
    });
  } catch (error) {
    console.error(`Error saving tab (${req.params.tabName}):`, error);
    res.status(500).json({ success: false, message: "Server error while saving tab data" });
  }
});

// ✅ GET all stock items with variants (with pagination)
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { "variants.sku": { $regex: search, $options: "i" } },
        { additionalNames: { $regex: search, $options: "i" } }
      ];
    }
    if (category) filter.category = category;
    if (status) filter.status = status;

    const [totalItems, stockItems, statsAgg] = await Promise.all([
      StockItem.countDocuments(filter),
      StockItem.find(filter)
        .select("name additionalNames reference category unit totalQuantityOnHand averageCost averageSalesPrice status images variants hsnCode profitMargin operations genderCategory")
        .sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      StockItem.aggregate([{
        $group: {
          _id: null,
          total: { $sum: 1 },
          lowStock: { $sum: { $cond: [{ $eq: ["$status", "Low Stock"] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"] }, 1, 0] } },
          totalVariants: { $sum: { $size: { $ifNull: ["$variants", []] } } },
          totalInventoryValue: { $sum: { $multiply: [{ $ifNull: ["$averageCost", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] } },
          totalPotentialRevenue: { $sum: { $multiply: [{ $ifNull: ["$averageSalesPrice", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] } },
          averageMargin: { $avg: { $ifNull: ["$profitMargin", 0] } }
        }
      }])
    ]);

    const statsData = statsAgg[0] || { total: 0, lowStock: 0, outOfStock: 0, totalVariants: 0, totalInventoryValue: 0, totalPotentialRevenue: 0, averageMargin: 0 };
    const totalPages = Math.ceil(totalItems / limitNum);

    res.json({
      success: true, stockItems,
      stats: { total: statsData.total, lowStock: statsData.lowStock, outOfStock: statsData.outOfStock, totalVariants: statsData.totalVariants, totalInventoryValue: statsData.totalInventoryValue, totalPotentialRevenue: statsData.totalPotentialRevenue, averageMargin: statsData.averageMargin, totalStockItems: statsData.total },
      filters: { categories: STOCK_ITEM_CATEGORIES, statuses: ["In Stock", "Low Stock", "Out of Stock"] },
      pagination: { currentPage: pageNum, totalPages, totalItems, itemsPerPage: limitNum, hasNextPage: pageNum < totalPages, hasPrevPage: pageNum > 1 }
    });
  } catch (error) {
    console.error("Error fetching stock items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock items" });
  }
});

// ✅ GET stock item by ID
router.get("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .populate("createdBy", "name email").populate("updatedBy", "name email");
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
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
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    const variant = stockItem.variants.find(v => v._id.toString() === variantId.toString());
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });
    res.json({ success: true, variant: { _id: variant._id, attributes: variant.attributes || [], salesPrice: variant.salesPrice, quantityOnHand: variant.quantityOnHand } });
  } catch (error) {
    console.error("Error fetching variant:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variant" });
  }
});

// ✅ CREATE new stock item with variants
router.post("/", async (req, res) => {
  try {
    const {
      name, additionalNames, productType, category, unit, hsnCode, genderCategory,
      baseSalesPrice, baseCost, internalNotes,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ success: false, message: "Product name is required" });
    if (!category) return res.status(400).json({ success: false, message: "Category is required" });
    if (!attributes || !Array.isArray(attributes) || attributes.length === 0) return res.status(400).json({ success: false, message: "At least one attribute is required" });
    if (!variants || !Array.isArray(variants) || variants.length === 0) return res.status(400).json({ success: false, message: "At least one variant is required" });

    const nameWords = name.trim().split(" ");
    const nameCode = nameWords.map(w => w.substring(0, 3).toUpperCase()).join("");
    const categoryCode = category.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`;

    const existingItem = await StockItem.findOne({ reference });
    if (existingItem) return res.status(400).json({ success: false, message: "A product with similar reference already exists" });

    const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

    const processedAttributes = attributes
      .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
      .map(attr => ({ name: attr.name.trim(), values: attr.values.filter(v => v?.trim()).map(v => v.trim()) }));

    const processedVariants = await Promise.all(
      variants.map(async (variant, index) => {
        const variantSku = `${reference}-V${(index + 1).toString().padStart(3, "0")}`;
        const variantBarcode = `${barcode}-${(index + 1).toString().padStart(3, "0")}`;
        const processedRawItems = await processVariantRawItems(variant.rawItems);
        return {
          sku: variantSku, attributes: variant.attributes || [],
          quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
          minStock: parseFloat(variant.minStock) || 10, maxStock: parseFloat(variant.maxStock) || 100,
          cost: parseFloat(variant.cost) || parseFloat(baseCost) || 0,
          salesPrice: parseFloat(variant.salesPrice) || parseFloat(baseSalesPrice) || 0,
          barcode: variantBarcode, images: variant.images || images || [],
          rawItems: processedRawItems
        };
      })
    );

    const processedOperations = (operations || []).map(op => {
      const minutes = parseFloat(op.minutes) || 0, seconds = parseFloat(op.seconds) || 0;
      return { type: op.type || "", operationCode: op.operationCode || "", machine: op.machine || "", machineType: op.machineType || "", minutes, seconds, totalSeconds: minutes * 60 + seconds, operatorSalary: parseFloat(op.operatorSalary) || 0, operatorCost: parseFloat(op.operatorCost) || 0 };
    });

    const processedMiscellaneousCosts = (miscellaneousCosts || [])
      .filter(c => c.name?.trim())
      .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));

    const processedAdditionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
      .map(n => n?.trim()).filter(n => n && n.length > 0);

    const newStockItem = new StockItem({
      name: name.trim(), additionalNames: processedAdditionalNames,
      reference: reference.toUpperCase(), productType: productType || "Goods",
      category: category.trim(), unit: unit || "Units", hsnCode: hsnCode || "",
      genderCategory: genderCategory || "", internalNotes: internalNotes || "",
      baseSalesPrice: parseFloat(baseSalesPrice) || 0, baseCost: parseFloat(baseCost) || 0,
      attributes: processedAttributes, measurements: measurements || [],
      numberOfPanels: parseInt(numberOfPanels) || 0,
      variants: processedVariants, operations: processedOperations,
      miscellaneousCosts: processedMiscellaneousCosts, images: images || [],
      createdBy: req.user.id
    });

    updateStockItemAggregates(newStockItem);
    await newStockItem.save();

    res.status(201).json({ success: true, message: "Stock item created successfully", stockItem: newStockItem });
  } catch (error) {
    console.error("Error creating stock item:", error);
    if (error.code === 11000) return res.status(400).json({ success: false, message: "Product with this reference already exists" });
    res.status(500).json({ success: false, message: "Server error while creating stock item" });
  }
});

// ✅ UPDATE stock item (full PUT — kept for backward compatibility)
router.put("/:id", async (req, res) => {
  try {
    const {
      name, additionalNames, productType, category, unit, hsnCode, internalNotes,
      baseSalesPrice, baseCost, genderCategory,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    if (name !== undefined) stockItem.name = name.trim();
    if (productType !== undefined) stockItem.productType = productType;
    if (category !== undefined) stockItem.category = category.trim();
    if (unit !== undefined) stockItem.unit = unit;
    if (hsnCode !== undefined) stockItem.hsnCode = hsnCode;
    if (internalNotes !== undefined) stockItem.internalNotes = internalNotes;
    if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice) || 0;
    if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;
    if (genderCategory !== undefined) stockItem.genderCategory = genderCategory;

    if (additionalNames !== undefined) {
      stockItem.additionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
        .map(n => n?.trim()).filter(n => n && n.length > 0);
    }

    if (attributes !== undefined) {
      stockItem.attributes = attributes
        .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
        .map(attr => ({ name: attr.name.trim(), values: attr.values.filter(v => v?.trim()).map(v => v.trim()) }));
    }

    if (measurements !== undefined) {
      stockItem.measurements = measurements.filter(m => m?.trim()).map(m => m.trim());
    }
    if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;

    if (variants !== undefined) {
      const existingVariantsById = {};
      stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

      const processedVariants = await Promise.all(
        variants.map(async (variant, index) => {
          const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, "0")}`;
          const processedRawItems = await processVariantRawItems(variant.rawItems);

          if (variant._id && existingVariantsById[variant._id.toString()]) {
            const existing = existingVariantsById[variant._id.toString()];
            existing.sku = variantSku;
            existing.attributes = variant.attributes || existing.attributes;
            existing.quantityOnHand = parseFloat(variant.quantityOnHand) ?? existing.quantityOnHand;
            existing.minStock = parseFloat(variant.minStock) || existing.minStock || 10;
            existing.maxStock = parseFloat(variant.maxStock) || existing.maxStock || 100;
            existing.cost = parseFloat(variant.cost) || stockItem.baseCost || 0;
            existing.salesPrice = parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0;
            existing.barcode = variant.barcode || existing.barcode || "";
            existing.images = variant.images || stockItem.images || existing.images || [];
            existing.rawItems = processedRawItems;
            return existing;
          }

          return {
            sku: variantSku, attributes: variant.attributes || [],
            quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
            minStock: parseFloat(variant.minStock) || 10, maxStock: parseFloat(variant.maxStock) || 100,
            cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
            salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0,
            barcode: variant.barcode || "", images: variant.images || stockItem.images || [],
            rawItems: processedRawItems
          };
        })
      );
      stockItem.variants = processedVariants;
    }

    if (operations !== undefined) {
      stockItem.operations = (Array.isArray(operations) ? operations : []).map(op => {
        const minutes = parseFloat(op.minutes) || 0, seconds = parseFloat(op.seconds) || 0;
        return { type: op.type || "", machine: op.machine || "", machineType: op.machineType || "", minutes, seconds, totalSeconds: minutes * 60 + seconds, operatorSalary: parseFloat(op.operatorSalary) || 0, operatorCost: parseFloat(op.operatorCost) || 0 };
      });
    }

    if (miscellaneousCosts !== undefined) {
      stockItem.miscellaneousCosts = (Array.isArray(miscellaneousCosts) ? miscellaneousCosts : [])
        .filter(c => c.name?.trim())
        .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));
    }

    if (images !== undefined) stockItem.images = images || [];
    stockItem.updatedBy = req.user.id;
    updateStockItemAggregates(stockItem);
    await stockItem.save();

    const updatedStockItem = await StockItem.findById(stockItem._id)
      .populate("createdBy", "name email").populate("updatedBy", "name email");

    res.json({ success: true, message: "Stock item updated successfully", stockItem: updatedStockItem });
  } catch (error) {
    console.error("Error updating stock item:", error);
    res.status(500).json({ success: false, message: "Server error while updating stock item" });
  }
});

// ✅ CLONE stock item
router.post("/:id/clone", async (req, res) => {
  try {
    const original = await StockItem.findById(req.params.id);
    if (!original) return res.status(404).json({ success: false, message: "Stock item not found" });

    const clonedName = `${original.name}_Clone`;
    const nameWords = clonedName.split(" ");
    const nameCode = nameWords.map(w => w.substring(0, 3).toUpperCase()).join("");
    const categoryCode = (original.category || "CAT").substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 9000 + 1000).toString();
    const newReference = `PROD-${categoryCode}-${nameCode}-${randomNum}`.toUpperCase();
    const newBarcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

    const clonedVariants = original.variants.map((v, index) => ({
      sku: `${newReference}-V${(index + 1).toString().padStart(3, "0")}`,
      attributes: v.attributes, quantityOnHand: v.quantityOnHand,
      minStock: v.minStock, maxStock: v.maxStock, cost: v.cost, salesPrice: v.salesPrice,
      barcode: `${newBarcode}-${(index + 1).toString().padStart(3, "0")}`,
      images: v.images, rawItems: v.rawItems, status: v.status
    }));

    const clonedItem = new StockItem({
      name: clonedName, additionalNames: original.additionalNames || [],
      reference: newReference, productType: original.productType,
      category: original.category, unit: original.unit, hsnCode: original.hsnCode,
      genderCategory: original.genderCategory || "", internalNotes: original.internalNotes,
      baseSalesPrice: original.baseSalesPrice, baseCost: original.baseCost,
      attributes: original.attributes, measurements: original.measurements,
      numberOfPanels: original.numberOfPanels, variants: clonedVariants,
      operations: original.operations, miscellaneousCosts: original.miscellaneousCosts,
      images: original.images, createdBy: req.user.id
    });

    updateStockItemAggregates(clonedItem);
    await clonedItem.save();

    res.status(201).json({ success: true, message: `Cloned successfully as "${clonedName}"`, stockItem: clonedItem });
  } catch (error) {
    console.error("Error cloning stock item:", error);
    if (error.code === 11000) return res.status(400).json({ success: false, message: "Clone reference collision — please try again" });
    res.status(500).json({ success: false, message: "Server error while cloning stock item" });
  }
});

// ✅ DELETE stock item
router.delete("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    await stockItem.deleteOne();
    res.json({ success: true, message: "Stock item deleted successfully" });
  } catch (error) {
    console.error("Error deleting stock item:", error);
    res.status(500).json({ success: false, message: "Server error while deleting stock item" });
  }
});

module.exports = router;