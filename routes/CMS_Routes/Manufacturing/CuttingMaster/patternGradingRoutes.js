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

// ─── GET: List / search stock items ───────────────────────────────────────────
router.get("/pattern-grading/stock-items", async (req, res) => {
  try {
    const { search = "", limit = 30, page = 1 } = req.query;
    const limitNum = Math.min(parseInt(limit) || 30, 100);
    const skip = (parseInt(page) - 1) * limitNum;

    const query = { productType: { $in: ["Goods", "Combo"] } };
    if (search.trim()) {
      const rx = new RegExp(search.trim(), "i");
      query.$or = [{ name: rx }, { reference: rx }, { category: rx }];
    }

    const [stockItems, total] = await Promise.all([
      StockItem.find(query)
        .select("name reference category measurements numberOfPanels status")
        .sort({ name: 1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      StockItem.countDocuments(query),
    ]);

    const ids = stockItems.map((s) => s._id);
    const configs = await PatternGradingConfig.find({
      stockItemId: { $in: ids },
      isActive: true,
    })
      .select("stockItemId svgFileUrl measureGroups keyframes updatedAt")
      .lean();

    const configMap = {};
    for (const c of configs) {
      configMap[c.stockItemId.toString()] = {
        hasConfig: true,
        hasSVG: !!c.svgFileUrl,
        groupCount: c.measureGroups?.length || 0,
        keyframeCount: c.keyframes?.length || 0,
        updatedAt: c.updatedAt,
      };
    }

    const enriched = stockItems.map((s) => ({
      ...s,
      patternInfo: configMap[s._id.toString()] || {
        hasConfig: false,
        hasSVG: false,
        groupCount: 0,
        keyframeCount: 0,
      },
    }));

    res.json({ success: true, stockItems: enriched, total, page: parseInt(page), pages: Math.ceil(total / limitNum) });
  } catch (error) {
    console.error("Error listing stock items:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET: Single stock item ───────────────────────────────────
router.get("/pattern-grading/stock-items/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference category measurements numberOfPanels status")
      .lean();

    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true })
      .select("svgFileUrl measureGroups keyframes updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      stockItem: {
        ...stockItem,
        patternInfo: config
          ? { hasConfig: true, hasSVG: !!config.svgFileUrl, groupCount: config.measureGroups?.length || 0, keyframeCount: config.keyframes?.length || 0, updatedAt: config.updatedAt }
          : { hasConfig: false, hasSVG: false, groupCount: 0, keyframeCount: 0 },
      },
    });
  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── GET: Fetch pattern config for a stock item ───────────────
router.get("/pattern-grading/stock-item/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true })
      .sort({ updatedAt: -1 })
      .lean();

    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference numberOfPanels measurements category")
      .lean();

    res.json({ success: true, config: config || null, stockItem: stockItem || null });
  } catch (error) {
    console.error("Error fetching pattern config:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─── POST: Save SVG URL ───────────────────────────────────────
router.post("/pattern-grading/stock-item/:stockItemId/save-svg-url", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { svgFileUrl, svgPublicId, originalFilename, bytes } = req.body;

    if (!svgFileUrl) return res.status(400).json({ success: false, message: "svgFileUrl is required" });
    if (!svgFileUrl.startsWith("https://")) return res.status(400).json({ success: false, message: "svgFileUrl must be a valid https URL" });

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
        $setOnInsert: { stockItemId, createdAt: new Date() },
      },
      { upsert: true, new: true }
    );

    return res.json({ success: true, message: "SVG URL saved successfully", svgFileUrl: config.svgFileUrl, configId: config._id });
  } catch (err) {
    console.error("Error saving SVG URL:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ─── POST: Save full pattern grading config (WITH nestedConditions) ──────────
router.post("/pattern-grading/stock-item/:stockItemId/save-config", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const {
      basePaths,
      measureGroups,
      keyframes,
      unitsPerInch,
      basePatternSize,
      configSnapshot,
      measurementPartRules,
    } = req.body;

    const stockItem = await StockItem.findById(stockItemId).select("name reference").lean();
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    let config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });

    if (!config) {
      config = new PatternGradingConfig({
        stockItemId,
        stockItemName: stockItem.name,
        stockItemReference: stockItem.reference,
        createdBy: req.user.id,
      });
    }

    if (basePaths !== undefined) config.basePaths = basePaths;

    // ── KEY: Persist measureGroups with their nestedConditions ──────────────
    if (measureGroups !== undefined) {
      config.measureGroups = measureGroups.map((g) => ({
        clientId: String(g.clientId || g.id || ""),
        name: g.name || "",
        partKey: g.partKey || "chest",
        assignedSize: g.assignedSize || null,
        multiplier: Number(g.multiplier) || 1,
        ref1: {
          pathIdx: Number(g.ref1?.pathIdx ?? 0),
          segIdx: Number(g.ref1?.segIdx ?? 0),
        },
        ref2: {
          pathIdx: Number(g.ref2?.pathIdx ?? 0),
          segIdx: Number(g.ref2?.segIdx ?? 0),
        },
        color: g.color || "#2980b9",
        targetFullInches: Number(g.targetFullInches) || 0,
        baseFullInches: Number(g.baseFullInches) || 0,
        measurementOffset: Number(g.measurementOffset) || 0,
        gradingMode: g.gradingMode || (g.ruleProfile?.enabled ? "rule" : "keyframe"),
        ruleProfile: g.ruleProfile || null,
        // ← Nested conditions persisted here
        nestedConditions: (g.nestedConditions || []).map((cond) => ({
          id: String(cond.id || ""),
          enabled: Boolean(cond.enabled !== false),
          label: cond.label || "Condition",
          operator: cond.operator || "greater_than",
          compareGroupId: cond.compareGroupId || null,
          compareValue: Number(cond.compareValue) || 0,
          targetGroupId: cond.targetGroupId || null,
          action: cond.action || "match_to_current",
          actionValue: Number(cond.actionValue) || 0,
        })),
      }));
    }

    // ── Persist keyframes ───────────────────────────────────────────────────
    if (keyframes !== undefined) {
      config.keyframes = keyframes.map((kf) => ({
        clientId: String(kf.clientId || kf.id || ""),
        gid: String(kf.gid || ""),
        targetFullInches: Number(kf.targetFullInches) || 0,
        targetRawInches: Number(kf.targetRawInches) || 0,
        sizeTag: kf.sizeTag || null,
        deltas: (kf.deltas || []).map((d) => ({
          pi: Number(d.pi),
          si: Number(d.si),
          dx: Number(d.dx) || 0,
          dy: Number(d.dy) || 0,
          dc1x: Number(d.dc1x) || 0,
          dc1y: Number(d.dc1y) || 0,
          dc2x: Number(d.dc2x) || 0,
          dc2y: Number(d.dc2y) || 0,
        })),
        ts: kf.ts || new Date().toISOString(),
      }));
    }

    if (unitsPerInch !== undefined) config.unitsPerInch = unitsPerInch;
    if (basePatternSize !== undefined) config.basePatternSize = basePatternSize;
    if (configSnapshot !== undefined) config.configSnapshot = configSnapshot;
    if (measurementPartRules !== undefined) config.measurementPartRules = measurementPartRules;

    config.lastConfiguredBy = req.user.id;
    config.lastConfiguredAt = new Date();
    config.version = (config.version || 1) + 1;

    await config.save();

    res.json({
      success: true,
      message: "Pattern config saved successfully",
      configId: config._id,
      version: config.version,
      groupsWithConditions: (config.measureGroups || []).filter((g) => g.nestedConditions?.length > 0).length,
    });
  } catch (error) {
    console.error("Error saving pattern config:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─── GET: Employee CAD data ───────────────────────────────────
router.get("/pattern-grading/employee/:employeeId/cad-data", async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { woId } = req.query;

    if (!woId) return res.status(400).json({ success: false, message: "woId query param required" });

    const workOrder = await WorkOrder.findById(woId)
      .select("workOrderNumber stockItemId stockItemName stockItemReference variantAttributes customerRequestId quantity")
      .lean();

    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("name reference numberOfPanels measurements category")
      .lean();

    const measurement = await Measurement.findOne({ poRequestId: workOrder.customerRequestId }).lean();

    let employeeMeasurementData = null;
    let employeeInfo = null;

    if (measurement) {
      for (const emp of measurement.employeeMeasurements) {
        if (emp.employeeId.toString() === employeeId.toString()) {
          employeeInfo = {
            employeeId: emp.employeeId,
            employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN,
            gender: emp.gender,
          };
          const product = emp.products.find((p) => p.productName === workOrder.stockItemName);
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

    const patternConfig = await PatternGradingConfig.findOne({ stockItemId: workOrder.stockItemId, isActive: true })
      .sort({ updatedAt: -1 })
      .lean();

    const measurementMap = {};
    if (employeeMeasurementData?.measurements) {
      for (const m of employeeMeasurementData.measurements) {
        measurementMap[m.measurementName] = parseFloat(m.value) || 0;
      }
    }

    let computedGroupTargets = [];
    if (patternConfig && patternConfig.measureGroups?.length && employeeMeasurementData) {
      computedGroupTargets = patternConfig.measureGroups.map((group) => {
        const employeeValue =
          measurementMap[group.partKey] !== undefined ? measurementMap[group.partKey] : null;
        return {
          groupClientId: group.clientId,
          groupName: group.name,
          partKey: group.partKey,
          assignedSize: group.assignedSize,
          multiplier: group.multiplier,
          baseFullInches: group.baseFullInches,
          targetFullInches: employeeValue !== null ? employeeValue : group.baseFullInches,
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
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─── GET: List all pattern configs ───────────────────────────
router.get("/pattern-grading/configs", async (req, res) => {
  try {
    const configs = await PatternGradingConfig.find({ isActive: true })
      .select("stockItemId stockItemName stockItemReference svgFileName measureGroups keyframes basePatternSize updatedAt version")
      .sort({ updatedAt: -1 })
      .lean();

    const enriched = configs.map((c) => ({
      ...c,
      groupCount: c.measureGroups?.length || 0,
      keyframeCount: c.keyframes?.length || 0,
      hasSVG: !!c.svgFileName,
      conditionCount: (c.measureGroups || []).reduce((acc, g) => acc + (g.nestedConditions?.length || 0), 0),
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
    if (!config) return res.status(404).json({ success: false, message: "Config not found" });
    config.isActive = false;
    await config.save();
    res.json({ success: true, message: "Pattern config deleted" });
  } catch (error) {
    console.error("Error deleting config:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;