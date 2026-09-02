// routes/cms/units.js  (or wherever your unit routes live)
// Make sure ALL routes that return unit data populate conversions.toUnit

const express = require("express");
const router = express.Router();
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");

/* ── Chunk 1: this router was mounted with NO AUTHENTICATION AT ALL ─────────
 * Chunk 0 found and pinned it: `/api/cms/units` answered every request,
 * signed in or not, including POST, PUT and DELETE. The unit master is what
 * every stock conversion in the system trusts — a wrong conversion factor
 * silently changes what a receipt puts on the shelf — so an anonymous writer
 * could corrupt inventory arithmetic across the whole company.
 *
 * Reads now require a signed-in Store/Purchase reader; writes require
 * master-maintenance authority. If some other application genuinely needs a
 * public unit vocabulary, it gets its own narrow read-only endpoint with a
 * stated contract — the administrative router does not stay open for it. */
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const {
  requireTenant, requireCapability, refuseLegacyWrite,
} = require("../../../../Middlewear/storePurchaseTenant");
const { CAPABILITIES } = require("../../../../services/storePurchase/capabilities");

router.use(EmployeeAuth);
router.use(requireTenant);

const canRead = requireCapability(CAPABILITIES.READ);
const canMaintain = [requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite];

// ─── GET all units (list page) ───────────────────────────────────────────────
router.get("/", canRead, async (req, res) => {
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
router.get("/available-units", canRead, async (req, res) => {
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
router.get("/:id", canRead, async (req, res) => {
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
router.post("/", ...canMaintain, async (req, res) => {
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
router.put("/:id", ...canMaintain, async (req, res) => {
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
router.delete("/:id", ...canMaintain, async (req, res) => {
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