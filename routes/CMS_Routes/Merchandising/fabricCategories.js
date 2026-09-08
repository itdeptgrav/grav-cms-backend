// routes/CMS_Routes/Merchandising/fabricCategories.js
// Mount: app.use("/api/cms/merchandising/fabric-categories", EmployeeAuth, fabricCategories)
//
// The fabric categories merchandisers import from the Excel template, shared
// by everyone: the shade-card page adds them to its list and the fabric
// library shows their shades. See models/CMS_Models/Merchandising/
// FabricCategory.js for what one holds and services/fabricCategoryImport.js
// for what is checked before storing.
//
//   GET    /            every category, by name
//   POST   /import      { file, categories: [...] } — upsert by name; all or
//                       nothing, with every problem listed on a 400
//   DELETE /:name       remove one

const express = require("express");
const router = express.Router();
const FabricCategory = require("../../../models/CMS_Models/Merchandising/FabricCategory");
const { normaliseImport } = require("../../../services/fabricCategoryImport");

const actorName = (req) =>
  req.user?.name || [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || "";

const listAll = () => FabricCategory.find({}).sort({ name: 1 }).lean();

router.get("/", async (req, res) => {
  try {
    res.json({ success: true, categories: await listAll() });
  } catch (err) {
    console.error("[fabric-categories] GET failed:", err);
    res.status(500).json({ success: false, message: "Failed to load the imported fabric categories" });
  }
});

router.post("/import", async (req, res) => {
  try {
    const body = req.body || {};
    const { categories, errors } = normaliseImport(body.categories);
    if (errors.length) {
      return res.status(400).json({
        success: false,
        message: `${errors.length} ${errors.length === 1 ? "category" : "categories"} could not be imported — nothing was saved`,
        errors,
      });
    }
    const names = categories.map((c) => c.name);
    const existing = new Set((await FabricCategory.find({ name: { $in: names } }, { name: 1 }).lean()).map((d) => d.name));
    const source = {
      file: String(body.file || "").trim().slice(0, 200),
      importedAt: new Date(),
      importedByRef: req.user?._id || req.user?.id || null,
      importedByName: actorName(req),
    };
    for (const c of categories) {
      await FabricCategory.findOneAndUpdate({ name: c.name }, { $set: { ...c, source } }, { upsert: true, new: true, runValidators: true });
    }
    const added = names.filter((n) => !existing.has(n)).length;
    const updated = names.length - added;
    res.json({
      success: true,
      added,
      updated,
      names,
      categories: await listAll(),
      message: `${added} added, ${updated} updated`,
    });
  } catch (err) {
    console.error("[fabric-categories] import failed:", err);
    res.status(500).json({ success: false, message: "Failed to save the imported fabric categories" });
  }
});

router.delete("/:name", async (req, res) => {
  try {
    const name = String(req.params.name || "").trim().toUpperCase();
    const gone = await FabricCategory.findOneAndDelete({ name });
    if (!gone) return res.status(404).json({ success: false, message: `${name} is not an imported category` });
    res.json({ success: true, name, categories: await listAll() });
  } catch (err) {
    console.error("[fabric-categories] delete failed:", err);
    res.status(500).json({ success: false, message: "Failed to remove the category" });
  }
});

module.exports = router;
