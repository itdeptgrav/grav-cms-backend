const express = require("express");
const router = express.Router();
const MeasurementCategory = require("../../../models/CMS_Models/Configurations/MeasurementCategory");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

router.get("/", async (req, res) => {
  try {
    const categories = await MeasurementCategory.find({}).sort({ name: 1 }).lean();
    res.json({ success: true, categories });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.post("/", async (req, res) => {
  try {
    const { name, fields } = req.body;
    if (!name?.trim()) return res.status(400).json({ success: false, message: "Category name is required" });
    const cleanFields = (fields || []).map(f => f.trim()).filter(Boolean);
    if (!cleanFields.length) return res.status(400).json({ success: false, message: "At least one field is required" });
    const existing = await MeasurementCategory.findOne({ name: { $regex: `^${name.trim()}$`, $options: "i" } });
    if (existing) return res.status(400).json({ success: false, message: "A category with this name already exists" });
    const cat = new MeasurementCategory({ name: name.trim(), fields: cleanFields, createdBy: req.user.id });
    await cat.save();
    res.status(201).json({ success: true, category: cat });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put("/:id", async (req, res) => {
  try {
    const { name, fields } = req.body;
    const cat = await MeasurementCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: "Category not found" });
    if (name?.trim()) cat.name = name.trim();
    if (Array.isArray(fields)) cat.fields = fields.map(f => f.trim()).filter(Boolean);
    await cat.save();
    res.json({ success: true, category: cat });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete("/:id", async (req, res) => {
  try {
    const cat = await MeasurementCategory.findByIdAndDelete(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: "Category not found" });
    res.json({ success: true, message: "Category deleted" });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// Bulk-assign: overwrite `measurements` on every StockItem in a given product
// category to match this measurement category's field list.
router.post("/:id/assign-to-product-category", async (req, res) => {
  try {
    const { productCategory } = req.body;
    if (!productCategory?.trim())
      return res.status(400).json({ success: false, message: "Product category is required" });

    const cat = await MeasurementCategory.findById(req.params.id);
    if (!cat) return res.status(404).json({ success: false, message: "Measurement category not found" });

    const StockItem = require("../../../models/CMS_Models/Inventory/Products/StockItem");
    const result = await StockItem.updateMany(
      { category: productCategory },
      { $set: { measurements: cat.fields } }
    );

    res.json({
      success: true,
      message: `Updated ${result.modifiedCount} product(s) in "${productCategory}" to use "${cat.name}" measurements`,
      modifiedCount: result.modifiedCount,
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;