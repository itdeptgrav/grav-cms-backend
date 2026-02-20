// routes/CMS_Routes/Manufacturing/CuttingMaster/patternGradingRoutes.js

const express = require("express");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const PatternGradingConfig = require("../../../../models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const Measurement = require("../../../../models/Customer_Models/Measurement");
const mongoose = require("mongoose");

router.use(EmployeeAuthMiddleware);

// ─── GET: Fetch pattern config for a stock item ───────────────
// GET /api/cms/manufacturing/cutting-master/pattern-grading/stock-item/:stockItemId
router.get("/pattern-grading/stock-item/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;

    const config = await PatternGradingConfig.findOne({
      stockItemId,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Also fetch stock item info
    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference numberOfPanels measurements category")
      .lean();

    res.json({
      success: true,
      config: config || null,
      stockItem: stockItem || null,
    });
  } catch (error) {
    console.error("Error fetching pattern config:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/pattern-grading/stock-item/:stockItemId/save-svg-url", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { svgFileUrl, svgPublicId, originalFilename, bytes } = req.body;

    if (!svgFileUrl) {
      return res
        .status(400)
        .json({ success: false, message: "svgFileUrl is required" });
    }

    if (!svgFileUrl.startsWith("https://")) {
      return res.status(400).json({
        success: false,
        message: "svgFileUrl must be a valid https URL",
      });
    }

    const config = await PatternGradingConfig.findOneAndUpdate(
      { stockItemId },
      {
        $set: {
          svgFileUrl,
          svgPublicId: svgPublicId || null,
          originalFilename: originalFilename || null,
          svgFileSizeBytes: bytes || null,
          svgUploadedAt: new Date(),
          updatedAt: new Date(),
        },
        $setOnInsert: {
          stockItemId,
          createdAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );

    return res.json({
      success: true,
      message: "SVG URL saved successfully",
      svgFileUrl: config.svgFileUrl,
      configId: config._id,
    });
  } catch (err) {
    console.error("Error saving SVG URL:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST: Save full pattern grading config (paths + groups + keyframes) ─
// POST /api/cms/manufacturing/cutting-master/pattern-grading/stock-item/:stockItemId/save-config
router.post(
  "/pattern-grading/stock-item/:stockItemId/save-config",
  async (req, res) => {
    try {
      const { stockItemId } = req.params;
      const {
        basePaths,
        measureGroups,
        keyframes,
        unitsPerInch,
        basePatternSize,
        configSnapshot,
      } = req.body;

      const stockItem = await StockItem.findById(stockItemId)
        .select("name reference")
        .lean();
      if (!stockItem) {
        return res
          .status(404)
          .json({ success: false, message: "Stock item not found" });
      }

      let config = await PatternGradingConfig.findOne({
        stockItemId,
        isActive: true,
      });

      if (!config) {
        config = new PatternGradingConfig({
          stockItemId,
          stockItemName: stockItem.name,
          stockItemReference: stockItem.reference,
          createdBy: req.user.id,
        });
      }

      if (basePaths !== undefined) config.basePaths = basePaths;
      if (measureGroups !== undefined) config.measureGroups = measureGroups;
      if (keyframes !== undefined) config.keyframes = keyframes;
      if (unitsPerInch !== undefined) config.unitsPerInch = unitsPerInch;
      if (basePatternSize !== undefined)
        config.basePatternSize = basePatternSize;
      if (configSnapshot !== undefined) config.configSnapshot = configSnapshot;

      config.lastConfiguredBy = req.user.id;
      config.lastConfiguredAt = new Date();
      config.version = (config.version || 1) + 1;

      await config.save();

      res.json({
        success: true,
        message: "Pattern config saved successfully",
        configId: config._id,
        version: config.version,
      });
    } catch (error) {
      console.error("Error saving pattern config:", error);
      res
        .status(500)
        .json({ success: false, message: "Server error: " + error.message });
    }
  },
);

// ─── GET: Fetch employee measurements + pattern config for CAD page ─────
// This is the main endpoint used when a master opens the CAD page for an employee
// GET /api/cms/manufacturing/cutting-master/pattern-grading/employee/:employeeId/cad-data
//     ?woId=xxx
router.get(
  "/pattern-grading/employee/:employeeId/cad-data",
  async (req, res) => {
    try {
      const { employeeId } = req.params;
      const { woId } = req.query;

      if (!woId) {
        return res
          .status(400)
          .json({ success: false, message: "woId query param required" });
      }

      // 1. Get work order → get stockItemId + customerRequestId
      const workOrder = await WorkOrder.findById(woId)
        .select(
          "workOrderNumber stockItemId stockItemName stockItemReference variantAttributes customerRequestId quantity",
        )
        .lean();

      if (!workOrder) {
        return res
          .status(404)
          .json({ success: false, message: "Work order not found" });
      }

      // 2. Get stock item → measurements list + panelCount
      const stockItem = await StockItem.findById(workOrder.stockItemId)
        .select("name reference numberOfPanels measurements category")
        .lean();

      // 3. Find measurement doc for this PO
      const measurement = await Measurement.findOne({
        poRequestId: workOrder.customerRequestId,
      }).lean();

      // 4. Find this specific employee's measurements for this product
      let employeeMeasurementData = null;
      let employeeInfo = null;

      if (measurement) {
        for (const emp of measurement.employeeMeasurements) {
          // Match by employeeId (ObjectId or string)
          if (emp.employeeId.toString() === employeeId.toString()) {
            employeeInfo = {
              employeeId: emp.employeeId,
              employeeName: emp.employeeName,
              employeeUIN: emp.employeeUIN,
              gender: emp.gender,
            };

            // Find the product matching this work order
            const product = emp.products.find(
              (p) => p.productName === workOrder.stockItemName,
            );

            if (product) {
              employeeMeasurementData = {
                productName: product.productName,
                quantity: product.quantity,
                measurements: product.measurements,
                qrGenerated: product.qrGenerated,
              };
            }
            break;
          }
        }
      }

      // 5. Get pattern grading config for this stock item
      const patternConfig = await PatternGradingConfig.findOne({
        stockItemId: workOrder.stockItemId,
        isActive: true,
      })
        .sort({ updatedAt: -1 })
        .lean();

      // 6. Build measurement map: { measurementName: { value, unit } }
      const measurementMap = {};
      if (employeeMeasurementData?.measurements) {
        for (const m of employeeMeasurementData.measurements) {
          measurementMap[m.measurementName] = {
            value: parseFloat(m.value) || 0,
            unit: m.unit || "inch",
          };
        }
      }

      // 7. If we have pattern config + employee measurements, compute what
      //    targetFullInches should be for each group based on employee's body data
      let computedGroupTargets = [];

      if (
        patternConfig &&
        patternConfig.measureGroups?.length &&
        employeeMeasurementData
      ) {
        computedGroupTargets = patternConfig.measureGroups.map((group) => {
          // Map part key to possible measurement names
          const PART_KEY_TO_MEASUREMENT_NAMES = {
            chest: ["Chest", "chest", "CHEST"],
            shoulder: ["Shoulder", "shoulder", "SHOULDER"],
            waist: ["Waist", "waist", "WAIST", "Stomach"],
            hip: ["Hip", "hip", "HIP"],
            sleeve: ["Sleeve Length", "sleeve", "Sleeve", "SLEEVE"],
            neck: ["Coller", "Collar", "collar", "Neck", "neck"],
            length: ["Length", "length", "LENGTH"],
            armhole: ["Armhole", "armhole"],
          };

          const possibleNames = PART_KEY_TO_MEASUREMENT_NAMES[
            group.partKey
          ] || [group.partKey];
          let employeeValue = null;

          for (const name of possibleNames) {
            if (measurementMap[name] !== undefined) {
              employeeValue = measurementMap[name].value;
              break;
            }
          }

          return {
            groupClientId: group.clientId,
            groupName: group.name,
            partKey: group.partKey,
            assignedSize: group.assignedSize,
            multiplier: group.multiplier,
            baseFullInches: group.baseFullInches,
            // If employee has this measurement, use it; else fall back to base
            targetFullInches:
              employeeValue !== null ? employeeValue : group.baseFullInches,
            hasEmployeeData: employeeValue !== null,
            employeeValue,
          };
        });
      }

      res.json({
        success: true,
        workOrder: {
          _id: workOrder._id,
          workOrderNumber: workOrder.workOrderNumber,
          stockItemName: workOrder.stockItemName,
          stockItemReference: workOrder.stockItemReference,
          variantAttributes: workOrder.variantAttributes,
          quantity: workOrder.quantity,
        },
        stockItem: stockItem || null,
        employeeInfo,
        employeeMeasurementData,
        measurementMap,
        patternConfig: patternConfig || null,
        computedGroupTargets,
        hasPatternConfig: !!patternConfig,
        hasSVGFile: !!patternConfig?.svgFileUrl,
        hasGroups: !!patternConfig?.measureGroups?.length,
        hasKeyframes: !!patternConfig?.keyframes?.length,
      });
    } catch (error) {
      console.error("Error fetching CAD data:", error);
      res
        .status(500)
        .json({ success: false, message: "Server error: " + error.message });
    }
  },
);

// ─── GET: List all pattern configs (for management UI) ───────
router.get("/pattern-grading/configs", async (req, res) => {
  try {
    const configs = await PatternGradingConfig.find({ isActive: true })
      .select(
        "stockItemId stockItemName stockItemReference svgFileName measureGroups keyframes basePatternSize updatedAt version",
      )
      .sort({ updatedAt: -1 })
      .lean();

    const enriched = configs.map((c) => ({
      ...c,
      groupCount: c.measureGroups?.length || 0,
      keyframeCount: c.keyframes?.length || 0,
      hasSVG: !!c.svgFileName,
    }));

    res.json({ success: true, configs: enriched, total: enriched.length });
  } catch (error) {
    console.error("Error listing configs:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── DELETE: Remove a pattern config ─────────────────────────
router.delete("/pattern-grading/configs/:configId", async (req, res) => {
  try {
    const { configId } = req.params;

    const config = await PatternGradingConfig.findById(configId);
    if (!config) {
      return res
        .status(404)
        .json({ success: false, message: "Config not found" });
    }

    // Soft delete
    config.isActive = false;
    await config.save();

    res.json({ success: true, message: "Pattern config deleted" });
  } catch (error) {
    console.error("Error deleting config:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
