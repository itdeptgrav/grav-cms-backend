// routes/CMS_Routes/Inventory/Configurations/sizeConfigRoutes.js
// Mount: app.use("/api/cms/size-configs", sizeConfigRoutes)

const express  = require("express");
const router   = express.Router();
const mongoose = require("mongoose");
const MeasurementSizeConfig = require("../../../../models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuth);

// ── Measurement parameters per garment category ────────────────────────────
const CATEGORY_MEASUREMENTS = {
  "Shirts":      ['Length', 'Chest', 'Stomach', 'Bottom hem', 'Shoulder', 'Sleeve Length', 'Cuff', 'Collar'],
  "Formal Wear": ["Chest", "Stomach", "Bottom hem", "Shoulder", "Sleeve Length", "Cuff", "Collar", "Length"],
  "Casual Wear": ["Chest", "Stomach", "Bottom hem", "Shoulder", "Sleeve Length", "Length"],
  "T-Shirts":    ["Chest", "Stomach", "Shoulder", "Length"],
  "Sweatshirts": ["Chest", "Stomach", "Shoulder", "Sleeve Length", "Length"],
  "Outerwear":   ['Length', 'Chest', 'Stomach', 'Bottom hem', 'Shoulder'],
  "Jeans":       ["Waist", "Seat", "Thigh", "Knee", "Bottom", "Length", "Crouch/Kista Cut"],
  "Bottoms":     ['Length', 'Waist', 'Seat', 'Thigh', 'Knee', 'Bottom', 'Crouch/Kista Cut'],
  "Traditional Wear": ["Chest", "Stomach", "Bottom hem", "Shoulder", "Length", "Waist"],
  "Ethnic Wear": ["Chest", "Stomach", "Shoulder", "Length", "Waist"],
  "Kids Wear":   ["Chest", "Waist", "Length", "Shoulder"],
  "Sportswear":  ["Chest", "Waist", "Hip", "Length"],
  "Innerwear":   ["Chest", "Waist", "Hip"],
  "Accessories": ["Length", "Width"],
  "Winter Wear": ["Chest", "Stomach", "Shoulder", "Sleeve Length", "Length"],
  "Summer Wear": ["Chest", "Stomach", "Shoulder", "Length"],
};

// ── GET /data/products-with-sizes ──────────────────────────────────────────
// Returns all products that have a size-like attribute (attribute name
// contains "size", case-insensitive) — used to populate the product picker.
router.get("/data/products-with-sizes", async (req, res) => {
  try {
    const { search = "" } = req.query;
    const filter = {};
    if (search) {
      filter.$or = [
        { name:      { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
      ];
    }

    const items = await StockItem.find(filter)
      .select("name reference category genderCategory attributes variants._id variants.attributes variants.sku")
      .sort({ name: 1 })
      .limit(60)
      .lean();

    // Only return items that actually have a size attribute
    const withSizes = items
      .map(item => {
        const sizeAttr = (item.attributes || []).find(
          a => a.name.toLowerCase().includes("size")
        );
        if (!sizeAttr) return null;
        const sizeValues = sizeAttr.values || [];
        // Build variant list with their size value
        const variantsWithSize = (item.variants || []).map(v => {
          const sizeAV = (v.attributes || []).find(
            a => a.name.toLowerCase().includes("size")
          );
          return {
            _id:       v._id,
            sku:       v.sku,
            sizeValue: sizeAV?.value || "",
            attributes: v.attributes,
          };
        }).filter(v => v.sizeValue);

        return {
          _id:             item._id,
          name:            item.name,
          reference:       item.reference,
          category:        item.category,
          genderCategory:  item.genderCategory,
          sizeAttributeName: sizeAttr.name,
          sizeValues,
          variants:        variantsWithSize,
          measurements:    CATEGORY_MEASUREMENTS[item.category] || [],
        };
      })
      .filter(Boolean);

    res.json({ success: true, products: withSizes });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /data/category-measurements ───────────────────────────────────────
// Returns measurement parameter names for a given garment category.
router.get("/data/category-measurements", (req, res) => {
  const { category } = req.query;
  const measurements = category
    ? (CATEGORY_MEASUREMENTS[category] || [])
    : CATEGORY_MEASUREMENTS;
  res.json({ success: true, measurements });
});

// ── GET / — list all configs ───────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { search = "", category = "", productId = "" } = req.query;
    const filter = {};
    if (search)    filter.$or = [
      { name:        { $regex: search, $options: "i" } },
      { productName: { $regex: search, $options: "i" } },
    ];
    if (category)  filter.garmentCategory = category;
    if (productId) filter.productId = productId;

    const configs = await MeasurementSizeConfig.find(filter)
      .sort({ updatedAt: -1 })
      .lean();

    res.json({ success: true, configs });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /:id — single config ───────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const cfg = await MeasurementSizeConfig.findById(req.params.id).lean();
    if (!cfg) return res.status(404).json({ success: false, message: "Config not found" });
    res.json({ success: true, config: cfg });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST / — create ────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const {
      name, productId, garmentCategory,
      measurementParameter, sizeAttributeName, rules,
    } = req.body;

    if (!name?.trim())          return res.status(400).json({ success: false, message: "Name is required" });
    if (!productId)             return res.status(400).json({ success: false, message: "Product is required" });
    if (!garmentCategory)       return res.status(400).json({ success: false, message: "Garment category is required" });
    if (!measurementParameter)  return res.status(400).json({ success: false, message: "Measurement parameter is required" });
    if (!rules?.length)         return res.status(400).json({ success: false, message: "At least one rule is required" });

    // Validate rules
    for (const r of rules) {
      if (r.fromValue >= r.toValue) return res.status(400).json({ success: false, message: `Rule invalid: from (${r.fromValue}) must be less than to (${r.toValue})` });
      if (!r.sizeValue?.trim())     return res.status(400).json({ success: false, message: "Each rule must have a size value" });
    }

    // Fetch product meta
    const product = await StockItem.findById(productId).select("name reference category variants._id variants.attributes").lean();
    if (!product) return res.status(404).json({ success: false, message: "Product not found" });

    // Resolve variantId for each rule
    const attrName = sizeAttributeName || "Size";
    const resolvedRules = rules.map(r => {
      const match = (product.variants || []).find(v =>
        (v.attributes || []).some(a =>
          a.name.toLowerCase().includes("size") && a.value === r.sizeValue
        )
      );
      return {
        fromValue: parseFloat(r.fromValue),
        toValue:   parseFloat(r.toValue),
        sizeValue: r.sizeValue.trim(),
        variantId: match?._id || null,
      };
    });

    const cfg = await MeasurementSizeConfig.create({
      name: name.trim(),
      productId, productName: product.name, productRef: product.reference,
      garmentCategory, measurementParameter,
      sizeAttributeName: attrName,
      rules: resolvedRules,
      createdBy: req.user._id || req.user.id,
    });

    res.status(201).json({ success: true, message: "Config created", config: cfg });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /:id — update ──────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { name, garmentCategory, measurementParameter, sizeAttributeName, rules, isActive } = req.body;
    const cfg = await MeasurementSizeConfig.findById(req.params.id);
    if (!cfg) return res.status(404).json({ success: false, message: "Config not found" });

    if (name)                cfg.name                = name.trim();
    if (garmentCategory)     cfg.garmentCategory     = garmentCategory;
    if (measurementParameter)cfg.measurementParameter= measurementParameter;
    if (sizeAttributeName)   cfg.sizeAttributeName   = sizeAttributeName;
    if (isActive !== undefined) cfg.isActive         = isActive;

    if (rules?.length) {
      for (const r of rules) {
        if (r.fromValue >= r.toValue) return res.status(400).json({ success: false, message: `Rule invalid: from must be < to` });
        if (!r.sizeValue?.trim())     return res.status(400).json({ success: false, message: "Each rule needs a size value" });
      }
      const product = await StockItem.findById(cfg.productId).select("variants._id variants.attributes").lean();
      cfg.rules = rules.map(r => {
        const match = (product?.variants || []).find(v =>
          (v.attributes || []).some(a => a.name.toLowerCase().includes("size") && a.value === r.sizeValue)
        );
        return {
          fromValue: parseFloat(r.fromValue),
          toValue:   parseFloat(r.toValue),
          sizeValue: r.sizeValue.trim(),
          variantId: match?._id || null,
        };
      });
    }

    cfg.updatedBy = req.user._id || req.user.id;
    await cfg.save();
    res.json({ success: true, message: "Config updated", config: cfg });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /:id ────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    await MeasurementSizeConfig.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "Config deleted" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /resolve — given a measurement value + category, return matched size ──
// Used at order time to auto-assign variant.
router.post("/resolve", async (req, res) => {
  try {
    const { productId, measurementParameter, measurementValue } = req.body;
    if (!productId || !measurementParameter || measurementValue == null)
      return res.status(400).json({ success: false, message: "productId, measurementParameter and measurementValue are required" });

    const cfg = await MeasurementSizeConfig.findOne({
      productId, measurementParameter, isActive: true,
    }).lean();
    if (!cfg) return res.json({ success: false, message: "No config found for this product + measurement" });

    const val = parseFloat(measurementValue);
    const rule = cfg.rules.find(r => val >= r.fromValue && val < r.toValue);
    if (!rule) return res.json({ success: false, message: `No size rule matches value ${val}`, value: val });

    res.json({ success: true, sizeValue: rule.sizeValue, variantId: rule.variantId, rule });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;