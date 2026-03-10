// routes/CMS_Routes/Production/Dashboard/canvasLayoutRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const CanvasLayout = require("../../../../models/CMS_Models/Manufacturing/Production/CanvasLayout");

router.use(EmployeeAuthMiddleware);

/**
 * GET /api/cms/production/canvas-layout
 * Fetch saved canvas layout
 */
router.get("/", async (req, res) => {
  try {
    const { orgId = "default" } = req.query;

    const layout = await CanvasLayout.findOne({ organizationId: orgId }).lean();

    if (!layout) {
      return res.json({
        success: true,
        layout: null,
        message: "No saved layout found — use defaults",
      });
    }

    res.json({ success: true, layout });
  } catch (error) {
    console.error("Error fetching canvas layout:", error);
    res.status(500).json({
      success: false,
      message: "Server error fetching layout",
      error: error.message,
    });
  }
});

/**
 * POST /api/cms/production/canvas-layout
 * Save / update canvas layout
 */
router.post("/", async (req, res) => {
  try {
    const {
      machinePositions,
      separators,
      chamberTemplates,
      canvasState,
      orgId = "default",
    } = req.body;

    const employeeId =
      req.employee?.identityId || req.employee?._id?.toString() || "unknown";

    const existing = await CanvasLayout.findOne({ organizationId: orgId });

    if (existing) {
      existing.machinePositions = machinePositions || existing.machinePositions;
      existing.separators = separators || existing.separators;
      existing.chamberTemplates =
        chamberTemplates || existing.chamberTemplates;
      existing.canvasState = canvasState || existing.canvasState;
      existing.lastUpdatedBy = employeeId;
      existing.version = (existing.version || 1) + 1;
      await existing.save();

      return res.json({ success: true, layout: existing, message: "Layout saved successfully" });
    }

    const newLayout = new CanvasLayout({
      organizationId: orgId,
      machinePositions: machinePositions || [],
      separators: separators || [],
      chamberTemplates: chamberTemplates || [],
      canvasState: canvasState || { zoom: 1, panX: 0, panY: 0 },
      lastUpdatedBy: employeeId,
    });

    await newLayout.save();

    res.json({ success: true, layout: newLayout, message: "Layout created successfully" });
  } catch (error) {
    console.error("Error saving canvas layout:", error);
    res.status(500).json({
      success: false,
      message: "Server error saving layout",
      error: error.message,
    });
  }
});

/**
 * DELETE /api/cms/production/canvas-layout
 * Reset layout to defaults
 */
router.delete("/", async (req, res) => {
  try {
    const { orgId = "default" } = req.query;
    await CanvasLayout.deleteOne({ organizationId: orgId });
    res.json({ success: true, message: "Layout reset to defaults" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;