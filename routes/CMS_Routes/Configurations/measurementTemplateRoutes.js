// routes/CMS_Routes/Configurations/measurementTemplateRoutes.js
// Mount: app.use("/api/cms/measurement-templates", measurementTemplateRoutes)

const express = require("express");
const router = express.Router();
const MeasurementTemplate = require("../../../models/CMS_Models/Configurations/MeasurementTemplate");
const MeasurementCategory = require("../../../models/CMS_Models/Configurations/MeasurementCategory");
const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// GET / — list, optionally filtered by category or a name search
router.get("/", async (req, res) => {
  try {
    const { categoryId, search } = req.query;
    const filter = { isActive: true };
    if (categoryId) filter.category = categoryId;
    if (search?.trim()) filter.name = { $regex: search.trim(), $options: "i" };

    const templates = await MeasurementTemplate.find(filter)
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, templates });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /:id — single, for prefilling the edit form
router.get("/:id", async (req, res) => {
  try {
    const template = await MeasurementTemplate.findById(req.params.id).lean();
    if (!template) return res.status(404).json({ success: false, message: "Template not found" });
    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.post("/", async (req, res) => {
  try {
    const { name, categoryId, values, notes } = req.body;

    if (!name?.trim()) return res.status(400).json({ success: false, message: "Template name is required" });
    if (!categoryId) return res.status(400).json({ success: false, message: "A measurement category is required" });

    const category = await MeasurementCategory.findById(categoryId);
    if (!category) return res.status(404).json({ success: false, message: "Measurement category not found" });

    const cleanValues = (values || [])
      .filter((v) => v?.fieldName?.trim())
      .map((v) => ({ fieldName: v.fieldName.trim(), value: (v.value ?? "").toString().trim() }));

    const template = new MeasurementTemplate({
      name: name.trim(),
      category: category._id,
      categoryName: category.name,
      values: cleanValues,
      notes: (notes || "").trim(),
      createdBy: req.user.id,
    });
    await template.save();
    res.status(201).json({ success: true, template });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const { name, categoryId, values, notes, isActive } = req.body;
    const template = await MeasurementTemplate.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: "Template not found" });

    if (name?.trim()) template.name = name.trim();

    if (categoryId) {
      const category = await MeasurementCategory.findById(categoryId);
      if (!category) return res.status(404).json({ success: false, message: "Measurement category not found" });
      template.category = category._id;
      template.categoryName = category.name;
    }

    if (Array.isArray(values)) {
      template.values = values
        .filter((v) => v?.fieldName?.trim())
        .map((v) => ({ fieldName: v.fieldName.trim(), value: (v.value ?? "").toString().trim() }));
    }

    if (notes !== undefined) template.notes = (notes || "").trim();
    if (typeof isActive === "boolean") template.isActive = isActive;

    await template.save();
    res.json({ success: true, template });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const template = await MeasurementTemplate.findByIdAndDelete(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: "Template not found" });
    res.json({ success: true, message: "Template deleted" });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
