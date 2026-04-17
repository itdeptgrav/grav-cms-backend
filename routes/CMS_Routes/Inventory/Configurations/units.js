// routes/cms/units.js  (or wherever your unit routes live)
// Make sure ALL routes that return unit data populate conversions.toUnit

const express = require("express");
const router = express.Router();
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");

// ─── GET all units (list page) ───────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const units = await Unit.find()
      .populate("conversions.toUnit", "_id name") // ← MUST populate
      .sort({ createdAt: -1 });

    return res.json({ success: true, units });
  } catch (error) {
    console.error("Error fetching units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET available units (for conversion dropdowns) ───────────────────────────
router.get("/available-units", async (req, res) => {
  try {
    const units = await Unit.find({ status: "Active" })
      .select("_id name")
      .sort({ name: 1 });

    return res.json({ success: true, units });
  } catch (error) {
    console.error("Error fetching available units:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET single unit by ID ────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const unit = await Unit.findById(req.params.id)
      .populate("conversions.toUnit", "_id name"); // ← MUST populate

    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    return res.json({ success: true, unit });
  } catch (error) {
    console.error("Error fetching unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── CREATE unit ──────────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { name, conversions } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: "Unit name is required" });
    }

    // Check duplicate name
    const existing = await Unit.findOne({ name: name.trim() });
    if (existing) {
      return res.status(400).json({ success: false, message: "A unit with this name already exists" });
    }

    // Validate & clean conversions
    const cleanConversions = [];
    if (Array.isArray(conversions) && conversions.length > 0) {
      for (const conv of conversions) {
        if (!conv.toUnit || !conv.quantity || parseFloat(conv.quantity) <= 0) continue;

        // Verify the target unit actually exists
        const targetUnit = await Unit.findById(conv.toUnit);
        if (!targetUnit) {
          return res.status(400).json({
            success: false,
            message: `Target unit not found: ${conv.toUnit}`
          });
        }

        cleanConversions.push({
          toUnit: conv.toUnit,
          quantity: parseFloat(conv.quantity)
        });
      }
    }

    const unit = new Unit({
      name: name.trim(),
      conversions: cleanConversions,
      createdBy: req.user?._id // attach if you have auth middleware
    });

    await unit.save();

    // Return populated unit
    const populated = await Unit.findById(unit._id)
      .populate("conversions.toUnit", "_id name");

    return res.status(201).json({ success: true, unit: populated });
  } catch (error) {
    console.error("Error creating unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── UPDATE unit ──────────────────────────────────────────────────────────────
router.put("/:id", async (req, res) => {
  try {
    const { conversions, status } = req.body;

    const unit = await Unit.findById(req.params.id);
    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    // Validate & clean conversions
    const cleanConversions = [];
    if (Array.isArray(conversions) && conversions.length > 0) {
      for (const conv of conversions) {
        if (!conv.toUnit || !conv.quantity || parseFloat(conv.quantity) <= 0) continue;

        // Make sure we're not converting to itself
        if (conv.toUnit.toString() === req.params.id.toString()) {
          return res.status(400).json({
            success: false,
            message: "A unit cannot convert to itself"
          });
        }

        // Verify the target unit actually exists
        const targetUnit = await Unit.findById(conv.toUnit);
        if (!targetUnit) {
          return res.status(400).json({
            success: false,
            message: `Target unit not found: ${conv.toUnit}`
          });
        }

        cleanConversions.push({
          toUnit: conv.toUnit,
          quantity: parseFloat(conv.quantity)
        });
      }
    }

    // Replace conversions entirely with the new set
    unit.conversions = cleanConversions;

    if (status && ["Active", "Inactive"].includes(status)) {
      unit.status = status;
    }

    unit.updatedBy = req.user?._id;

    await unit.save();

    // Return populated unit
    const populated = await Unit.findById(unit._id)
      .populate("conversions.toUnit", "_id name");

    return res.json({ success: true, unit: populated });
  } catch (error) {
    console.error("Error updating unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── DELETE unit ──────────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const unit = await Unit.findByIdAndDelete(req.params.id);
    if (!unit) {
      return res.status(404).json({ success: false, message: "Unit not found" });
    }

    // Also remove this unit from any other unit's conversions
    await Unit.updateMany(
      { "conversions.toUnit": req.params.id },
      { $pull: { conversions: { toUnit: req.params.id } } }
    );

    return res.json({ success: true, message: "Unit deleted successfully" });
  } catch (error) {
    console.error("Error deleting unit:", error);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;