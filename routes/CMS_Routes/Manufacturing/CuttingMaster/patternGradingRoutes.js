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

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: save with optimistic-concurrency retry (handles Mongoose VersionError)
// ─────────────────────────────────────────────────────────────────────────────
async function saveWithRetry(getDoc, mutate, maxRetries = 3) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const doc = await getDoc();
      mutate(doc);
      await doc.save();
      return doc;
    } catch (err) {
      if (err.name === "VersionError" && attempt < maxRetries - 1) {
        attempt++;
        await new Promise((r) => setTimeout(r, 80 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers to normalise nested conditions (avoid enum validation failures)
// ─────────────────────────────────────────────────────────────────────────────
const VALID_ACTIONS = [
  "match_to_current", "match_to_current_offset", "match_to_target",
  "add_offset", "subtract_offset", "multiply_by", "set_to_value",
  "change_by_percent", "change_by_ratio_of_trigger", "derive_from_source",
  "db_measurement_formula", "multi_group_expression", "live_canvas_value",
];
const VALID_OPS = ["plus", "minus", "multiply", "divide", "set"];
const VALID_BINOPS = ["plus", "minus", "multiply", "divide"];

function normaliseCondition(cond) {
  return {
    id: String(cond.id || ""),
    enabled: cond.enabled !== false,
    label: cond.label || "Condition",
    priority: Math.max(1, Math.min(10, Number(cond.priority) || 5)),
    operator: cond.operator || "greater_than",
    compareGroupId: cond.compareGroupId || null,
    compareValue: Number(cond.compareValue) || 0,
    targetGroupId: cond.targetGroupId || null,
    action: VALID_ACTIONS.includes(cond.action) ? cond.action : "match_to_current",
    actionValue: Number(cond.actionValue) || 0,
    matchOffsetOp: VALID_BINOPS.includes(cond.matchOffsetOp) ? cond.matchOffsetOp : "plus",
    actionOperator: ["plus", "minus", "set", "multiply"].includes(cond.actionOperator) ? cond.actionOperator : "plus",
    actionBaseGroupId: cond.actionBaseGroupId || null,
    deriveSourceGroupId: cond.deriveSourceGroupId || null,
    deriveOperator: VALID_OPS.includes(cond.deriveOperator) ? cond.deriveOperator : "plus",
    expressionGroups: (cond.expressionGroups || []).map((eg) => ({
      type: ["group", "constant"].includes(eg.type) ? eg.type : "group",
      groupId: String(eg.groupId || ""),
      operator: VALID_BINOPS.includes(eg.operator) ? eg.operator : "plus",
      constantValue: eg.constantValue !== undefined ? Number(eg.constantValue) : undefined,
    })),
    expressionOffset: Number(cond.expressionOffset) || 0,
    expressionScalarOp: ["none", ...VALID_BINOPS].includes(cond.expressionScalarOp) ? cond.expressionScalarOp : "none",
    sumGroupAId: cond.sumGroupAId || null,
    sumGroupBId: cond.sumGroupBId || null,
    sumOperator: VALID_BINOPS.includes(cond.sumOperator) ? cond.sumOperator : "plus",
    sumOffsetValue: Number(cond.sumOffsetValue) || 0,
    liveSourceGroupId: cond.liveSourceGroupId || null,
    liveOperator: VALID_BINOPS.includes(cond.liveOperator) ? cond.liveOperator : "plus",
    liveOffsetValue: Number(cond.liveOffsetValue) || 0,
    dbExpressionGroups: (cond.dbExpressionGroups || []).map((eg) => ({
      type: ["group", "constant"].includes(eg.type) ? eg.type : "group",
      groupId: String(eg.groupId || ""),
      operator: VALID_BINOPS.includes(eg.operator) ? eg.operator : "plus",
      constantValue: eg.constantValue !== undefined ? Number(eg.constantValue) : undefined,
    })),
    dbExpressionOffset: Number(cond.dbExpressionOffset) || 0,
    dbExpressionScalarOp: ["none", ...VALID_BINOPS].includes(cond.dbExpressionScalarOp) ? cond.dbExpressionScalarOp : "none",
    dbSourceGroupId: cond.dbSourceGroupId || null,
    dbOperator: VALID_BINOPS.includes(cond.dbOperator) ? cond.dbOperator : "plus",
    dbOffsetValue: Number(cond.dbOffsetValue) || 0,
  };
}

function normaliseGroup(g) {
  // Accept both old-style (clientId/name) and new-style (groupId/groupName)
  const id = String(g.groupId || g.clientId || g.id || "");
  const name = g.groupName || g.name || "";
  return {
    clientId: id,
    groupId: id,
    name,
    groupName: name,
    partKey: g.partKey || "chest",
    assignedSize: g.assignedSize || null,
    multiplier: Number(g.multiplier) || 1,
    ref1: { pathIdx: Number(g.ref1?.pathIdx ?? 0), segIdx: Number(g.ref1?.segIdx ?? 0) },
    ref2: { pathIdx: Number(g.ref2?.pathIdx ?? 0), segIdx: Number(g.ref2?.segIdx ?? 0) },
    color: g.color || "#2563eb",
    targetFullInches: Number(g.targetFullInches) || 0,
    baseFullInches: Number(g.baseFullInches) || 0,
    measurementOffset: Number(g.measurementOffset) || 0,
    gradingMode: g.gradingMode || (g.ruleProfile?.enabled ? "rule" : "keyframe"),
    ruleProfile: g.ruleProfile || null,
    loosingEnabled: Boolean(g.loosingEnabled),
    loosingValueInches: Number(g.loosingValueInches) || 0,
    loosingSide: ["ref1", "ref2", "both"].includes(g.loosingSide) ? g.loosingSide : "both",
    loosingValueRef1Inches: Number(g.loosingValueRef1Inches) || 0,
    loosingValueRef2Inches: Number(g.loosingValueRef2Inches) || 0,
    conditionsFollowLoosing: Boolean(g.conditionsFollowLoosing),
    nestedConditions: (g.nestedConditions || []).map(normaliseCondition),
    keyframes: (g.keyframes || []).map(normaliseKeyframe),
  };
}

function normaliseKeyframe(kf) {
  const id = String(kf.clientId || kf.id || "");
  return {
    clientId: id,
    id,
    gid: String(kf.gid || kf.groupId || ""),
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
    _autoMirror: kf._autoMirror === true ? true : undefined,
    _mirrorOfId: kf._mirrorOfId ? String(kf._mirrorOfId) : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK ITEM ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET: List / search stock items
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
      .select("stockItemId svgFileUrl sizePatterns measureGroups keyframes seamEdges setupCompleted updatedAt")
      .lean();

    const configMap = {};
    for (const c of configs) {
      const hasSizePatterns = (c.sizePatterns || []).length > 0;
      configMap[c.stockItemId.toString()] = {
        hasConfig: true,
        hasSVG: hasSizePatterns ? true : !!c.svgFileUrl,
        groupCount: hasSizePatterns
          ? (c.sizePatterns[0]?.keyframeGroups?.length || 0)
          : (c.measureGroups?.length || 0),
        keyframeCount: hasSizePatterns
          ? (c.sizePatterns[0]?.keyframeGroups?.reduce((a, g) => a + (g.keyframes?.length || 0), 0) || 0)
          : (c.keyframes?.length || 0),
        seamEdgeCount: c.seamEdges?.length || 0,
        sizePatternCount: c.sizePatterns?.length || 0,
        setupCompleted: c.setupCompleted || false,
        updatedAt: c.updatedAt,
      };
    }

    const enriched = stockItems.map((s) => ({
      ...s,
      patternInfo: configMap[s._id.toString()] || {
        hasConfig: false, hasSVG: false, groupCount: 0,
        keyframeCount: 0, seamEdgeCount: 0, sizePatternCount: 0, setupCompleted: false,
      },
    }));

    res.json({ success: true, stockItems: enriched, total, page: parseInt(page), pages: Math.ceil(total / limitNum) });
  } catch (error) {
    console.error("Error listing stock items:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET: Single stock item
router.get("/pattern-grading/stock-items/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference category measurements numberOfPanels status")
      .lean();
    if (!stockItem)
      return res.status(404).json({ success: false, message: "Stock item not found" });

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true })
      .select("svgFileUrl sizePatterns measureGroups keyframes seamEdges setupCompleted updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      success: true,
      stockItem: {
        ...stockItem,
        patternInfo: config
          ? {
            hasConfig: true,
            hasSVG: (config.sizePatterns?.length > 0) ? true : !!config.svgFileUrl,
            groupCount: config.measureGroups?.length || 0,
            keyframeCount: config.keyframes?.length || 0,
            seamEdgeCount: config.seamEdges?.length || 0,
            sizePatternCount: config.sizePatterns?.length || 0,
            setupCompleted: config.setupCompleted || false,
            updatedAt: config.updatedAt,
          }
          : { hasConfig: false, hasSVG: false, groupCount: 0, keyframeCount: 0, seamEdgeCount: 0, sizePatternCount: 0, setupCompleted: false },
      },
    });
  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET: Full pattern config (legacy + new combined)
router.get("/pattern-grading/stock-item/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true })
      .sort({ updatedAt: -1 })
      .lean();

    const stockItem = await StockItem.findById(stockItemId)
      .select("name reference numberOfPanels measurements category")
      .lean();

    if (config && config.seamEdges) {
      config.seamEdges = config.seamEdges.map((se) => ({
        ...se,
        clientId: se.clientId || se._id?.toString() || String(Date.now() + Math.random()),
      }));
    }
    if (config && !config.globalRotation) {
      config.globalRotation = { angle: 0, pivotX: 0, pivotY: 0 };
    }

    res.json({ success: true, config: config || null, stockItem: stockItem || null });
  } catch (error) {
    console.error("Error fetching pattern config:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET: Setup status
router.get("/pattern-grading/stock-item/:stockItemId/setup-status", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    res.json({
      success: true,
      setupCompleted: config?.setupCompleted || false,
      designatedGroup: config?.designatedGroup || "chest",
      hasSizePatterns: (config?.sizePatterns?.length || 0) > 0,
    });
  } catch (error) {
    console.error("Error fetching setup status:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Mark setup complete
router.post("/pattern-grading/stock-item/:stockItemId/setup-complete", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { designatedGroup } = req.body;
    const config = await PatternGradingConfig.findOneAndUpdate(
      { stockItemId, isActive: true },
      { $set: { setupCompleted: true, designatedGroup: designatedGroup || "chest" } },
      { new: true, upsert: true }
    );
    res.json({ success: true, message: "Setup marked as completed", designatedGroup: config.designatedGroup });
  } catch (error) {
    console.error("Error marking setup complete:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Set designated group
router.post("/pattern-grading/stock-item/:stockItemId/designated-group", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { designatedGroup } = req.body;
    await PatternGradingConfig.findOneAndUpdate(
      { stockItemId, isActive: true },
      { $set: { designatedGroup: designatedGroup || "chest" } },
      { upsert: true }
    );
    res.json({ success: true, message: `Designated group set to ${designatedGroup}` });
  } catch (error) {
    console.error("Error setting designated group:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SIZE PATTERN ROUTES  (must come before the generic /:stockItemId routes)
// ─────────────────────────────────────────────────────────────────────────────

// POST: Upload / replace a size pattern
router.post("/pattern-grading/stock-item/:stockItemId/size-pattern", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { sizeName, sizeValue, svgFileUrl, svgPublicId, originalFilename, bytes, baseMeasurements, unitsPerInch } = req.body;

    if (!sizeName || !sizeValue || !svgFileUrl)
      return res.status(400).json({ success: false, message: "sizeName, sizeValue, and svgFileUrl are required" });

    const doc = await saveWithRetry(
      async () => {
        let config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
        if (!config) {
          const stockItem = await StockItem.findById(stockItemId).select("name reference").lean();
          config = new PatternGradingConfig({
            stockItemId,
            stockItemName: stockItem?.name,
            stockItemReference: stockItem?.reference,
            isActive: true,
            sizePatterns: [],
          });
        }
        return config;
      },
      (config) => {
        const existingIndex = config.sizePatterns.findIndex((p) => p.sizeName === sizeName);
        const sizePattern = {
          sizeName,
          sizeValue,
          svgFileUrl,
          svgPublicId,
          originalFilename,
          bytes,
          baseMeasurements: baseMeasurements || {},
          unitsPerInch: (unitsPerInch && Number.isFinite(Number(unitsPerInch)) && Number(unitsPerInch) > 0) ? Number(unitsPerInch) : 25.4,
          keyframeGroups: existingIndex >= 0 ? (config.sizePatterns[existingIndex].keyframeGroups || []) : [],
          seamEdges: existingIndex >= 0 ? (config.sizePatterns[existingIndex].seamEdges || []) : [],
          foldAxes: existingIndex >= 0 ? (config.sizePatterns[existingIndex].foldAxes || []) : [],
        };

        if (existingIndex >= 0) {
          config.sizePatterns[existingIndex] = sizePattern;
        } else {
          config.sizePatterns.push(sizePattern);
        }
        config.markModified("sizePatterns");
      },
      5
    );

    const sizePattern = doc.sizePatterns.find((p) => p.sizeName === sizeName);
    res.json({ success: true, message: `Size pattern ${sizeName} saved successfully`, sizePattern });
  } catch (error) {
    console.error("Error saving size pattern:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE: Remove a size pattern
router.delete("/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName", async (req, res) => {
  try {
    const { stockItemId, sizeName } = req.params;

    await saveWithRetry(
      () => PatternGradingConfig.findOne({ stockItemId, isActive: true }),
      (config) => {
        if (!config) throw Object.assign(new Error("No pattern config found"), { statusCode: 404 });
        config.sizePatterns = config.sizePatterns.filter((p) => p.sizeName !== sizeName);
        config.markModified("sizePatterns");
      },
      5
    );

    res.json({ success: true, message: `Size pattern ${sizeName} deleted` });
  } catch (error) {
    console.error("Error deleting size pattern:", error);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// GET: All size patterns (metadata only)
router.get("/pattern-grading/stock-item/:stockItemId/size-patterns", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) return res.json({ success: true, sizePatterns: [] });
    res.json({ success: true, sizePatterns: config.sizePatterns || [] });
  } catch (error) {
    console.error("Error fetching size patterns:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET: All size patterns with their groups (for setup screen)
router.get("/pattern-grading/stock-item/:stockItemId/size-patterns-with-groups", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) return res.json({ success: true, sizePatterns: [], designatedGroup: "chest" });

    const sizePatternsWithGroups = (config.sizePatterns || []).map((p) => ({
      sizeName: p.sizeName,
      sizeValue: p.sizeValue,
      svgFileUrl: p.svgFileUrl,
      baseMeasurements: p.baseMeasurements || {},
      groups: p.keyframeGroups || [],
      groupsSetupCompleted: p.groupsSetupCompleted || false,
      hasKeyframes: (p.keyframeGroups || []).some((g) => g.keyframes?.length > 0),
    }));

    res.json({
      success: true,
      sizePatterns: sizePatternsWithGroups,
      designatedGroup: config.designatedGroup || "chest",
      setupCompleted: config.setupCompleted || false,
    });
  } catch (error) {
    console.error("Error fetching size patterns with groups:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET: Single size pattern (full data)
router.get("/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName", async (req, res) => {
  try {
    const { stockItemId, sizeName } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

    const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
    if (!sizePattern) return res.status(404).json({ success: false, message: "Size pattern not found" });

    res.json({ success: true, sizePattern });
  } catch (error) {
    console.error("Error fetching size pattern:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT: Update base measurements for a size pattern
router.put("/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName", async (req, res) => {
  try {
    const { stockItemId, sizeName } = req.params;
    const { baseMeasurements } = req.body;

    const doc = await saveWithRetry(
      () => PatternGradingConfig.findOne({ stockItemId, isActive: true }),
      (config) => {
        if (!config) throw Object.assign(new Error("Pattern config not found"), { statusCode: 404 });
        const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
        if (!sizePattern) throw Object.assign(new Error("Size pattern not found"), { statusCode: 404 });
        sizePattern.baseMeasurements = baseMeasurements || {};
        config.markModified("sizePatterns");
      },
      5
    );

    const sizePattern = doc.sizePatterns.find((p) => p.sizeName === sizeName);
    res.json({ success: true, message: `Measurements updated for ${sizeName}`, sizePattern });
  } catch (error) {
    console.error("Error updating size pattern measurements:", error);
    const status = error.statusCode || 500;
    res.status(status).json({ success: false, message: error.message });
  }
});

// GET: Groups for a specific size pattern
router.get("/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName/groups", async (req, res) => {
  try {
    const { stockItemId, sizeName } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) return res.json({ success: true, groups: [] });

    const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
    if (!sizePattern) return res.json({ success: true, groups: [] });

    res.json({ success: true, groups: sizePattern.keyframeGroups || [] });
  } catch (error) {
    console.error("Error fetching size pattern groups:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Save all groups for a size pattern at once
router.post("/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName/groups", async (req, res) => {
  try {
    const { stockItemId, sizeName } = req.params;
    const { groups } = req.body;

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

    const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
    if (!sizePattern) return res.status(404).json({ success: false, message: `Size pattern '${sizeName}' not found` });

    for (const incomingGroup of groups || []) {
      const gid = incomingGroup.groupId || incomingGroup.clientId || incomingGroup.id;
      const existingIdx = sizePattern.keyframeGroups.findIndex(
        (g) => (g.groupId || g.clientId) === gid
      );
      const normalised = normaliseGroup(incomingGroup);

      if (existingIdx === -1) {
        sizePattern.keyframeGroups.push(normalised);
      } else {
        const existing = sizePattern.keyframeGroups[existingIdx];
        // Preserve existing keyframes if incoming has none
        if (!normalised.keyframes?.length && existing.keyframes?.length) {
          normalised.keyframes = existing.keyframes;
        }
        sizePattern.keyframeGroups[existingIdx] = { ...existing.toObject?.() || existing, ...normalised };
      }
    }

    sizePattern.groupsSetupCompleted = true;
    config.markModified("sizePatterns");
    await config.save();

    res.json({ success: true, message: `Groups saved for ${sizeName}`, groups: sizePattern.keyframeGroups });
  } catch (error) {
    console.error("Error saving size pattern groups:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST: Save keyframes for one group of one size pattern
router.post(
  "/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName/group/:groupId/keyframes",
  async (req, res) => {
    try {
      const { stockItemId, sizeName, groupId } = req.params;
      const {
        keyframes, groupName, partKey, multiplier, ref1, ref2, color, ruleProfile,
        assignedSize, baseFullInches, targetFullInches, measurementOffset, gradingMode,
        loosingEnabled, loosingValueInches, loosingSide, loosingValueRef1Inches, loosingValueRef2Inches, conditionsFollowLoosing, nestedConditions,
      } = req.body;

      let retries = 0;
      const MAX_RETRIES = 3;

      while (retries < MAX_RETRIES) {
        try {
          const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
          if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

          const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
          if (!sizePattern) return res.status(404).json({ success: false, message: "Size pattern not found" });

          let groupIndex = sizePattern.keyframeGroups.findIndex(
            (g) => (g.groupId || g.clientId) === groupId
          );

          if (groupIndex === -1) {
            const newGroup = normaliseGroup({
              groupId, groupName, partKey, multiplier, ref1, ref2, color, ruleProfile,
              assignedSize, baseFullInches, targetFullInches, measurementOffset, gradingMode,
              loosingEnabled, loosingValueInches, loosingSide, loosingValueRef1Inches, loosingValueRef2Inches, conditionsFollowLoosing,
              nestedConditions: nestedConditions || [],
              keyframes: [],
            });
            sizePattern.keyframeGroups.push(newGroup);
            groupIndex = sizePattern.keyframeGroups.length - 1;
          }

          const g = sizePattern.keyframeGroups[groupIndex];
          g.keyframes = (keyframes || []).map(normaliseKeyframe);
          g.groupName = groupName || g.groupName;
          g.name = g.groupName;
          g.partKey = partKey || g.partKey;
          g.multiplier = multiplier ?? g.multiplier;
          g.assignedSize = assignedSize || g.assignedSize;
          g.baseFullInches = Number(baseFullInches) || g.baseFullInches || 0;
          g.targetFullInches = Number(targetFullInches) || g.targetFullInches || 0;
          g.measurementOffset = Number(measurementOffset) || g.measurementOffset || 0;
          g.gradingMode = gradingMode || g.gradingMode || "keyframe";
          g.loosingEnabled = Boolean(loosingEnabled);
          g.loosingValueInches = Number(loosingValueInches) || 0;
          if (["ref1", "ref2", "both"].includes(loosingSide)) g.loosingSide = loosingSide;
          if (loosingValueRef1Inches !== undefined) g.loosingValueRef1Inches = Number(loosingValueRef1Inches) || 0;
          if (loosingValueRef2Inches !== undefined) g.loosingValueRef2Inches = Number(loosingValueRef2Inches) || 0;
          g.conditionsFollowLoosing = Boolean(conditionsFollowLoosing);
          if (ref1) g.ref1 = ref1;
          if (ref2) g.ref2 = ref2;
          if (color) g.color = color;
          if (ruleProfile) g.ruleProfile = ruleProfile;
          if (nestedConditions) g.nestedConditions = (nestedConditions || []).map(normaliseCondition);

          config.markModified("sizePatterns");
          await config.save();

          return res.json({
            success: true,
            message: `Keyframes saved for ${sizeName} - ${groupName}`,
            group: sizePattern.keyframeGroups[groupIndex],
          });
        } catch (err) {
          if (err.name === "VersionError" && retries < MAX_RETRIES - 1) {
            retries++;
            await new Promise((r) => setTimeout(r, 100 * retries));
            continue;
          }
          throw err;
        }
      }
    } catch (error) {
      console.error("Error saving size pattern keyframes:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// POST: Delete a group from a size pattern
// Supports two modes:
//   - Default: delete from the specified sizeName only
//   - allSizes=true: delete from ALL sizes (matched by partKey)
router.post(
  "/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName/group/:groupId/delete",
  async (req, res) => {
    try {
      const { stockItemId, sizeName, groupId } = req.params;
      const { allSizes, partKey } = req.body || {};
      let retries = 0;
      const MAX_RETRIES = 3;

      while (retries < MAX_RETRIES) {
        try {
          const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
          if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

          if (allSizes && partKey) {
            // Delete from ALL sizes by partKey
            let totalRemoved = 0;
            for (const sp of config.sizePatterns) {
              const before = sp.keyframeGroups?.length || 0;
              sp.keyframeGroups = (sp.keyframeGroups || []).filter(g => g.partKey !== partKey);
              totalRemoved += before - sp.keyframeGroups.length;
            }
            config.markModified("sizePatterns");
            await config.save();
            return res.json({ success: true, message: `Group "${partKey}" deleted from all sizes (${totalRemoved} removed)` });
          } else {
            // Delete from this size only
            const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
            if (!sizePattern) return res.status(404).json({ success: false, message: "Size pattern not found" });

            sizePattern.keyframeGroups = sizePattern.keyframeGroups.filter(
              (g) => (g.groupId || g.clientId) !== groupId
            );
            config.markModified("sizePatterns");
            await config.save();
            return res.json({ success: true, message: `Group ${groupId} deleted from ${sizeName}` });
          }
        } catch (err) {
          if (err.name === "VersionError" && retries < MAX_RETRIES - 1) {
            retries++;
            await new Promise((r) => setTimeout(r, 100 * retries));
            continue;
          }
          throw err;
        }
      }
    } catch (error) {
      console.error("Error deleting group:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// POST: Delete a specific keyframe from a specific size's group
// This directly removes the KF from the database so it persists even through re-propagation.
// Can target a single size or all sizes with matching partKey.
router.post(
  "/pattern-grading/stock-item/:stockItemId/size-pattern/delete-keyframe",
  async (req, res) => {
    try {
      const { stockItemId } = req.params;
      const { sizeName, groupId, kfId, targetFullInches, partKey, allSizes } = req.body;

      const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
      if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

      let deletedCount = 0;

      if (allSizes && partKey) {
        // Delete from ALL sizes — match by partKey + targetFullInches
        for (const sp of config.sizePatterns) {
          for (const grp of (sp.keyframeGroups || [])) {
            if (grp.partKey !== partKey) continue;
            const before = (grp.keyframes || []).length;
            grp.keyframes = (grp.keyframes || []).filter(
              (k) => Math.abs((k.targetFullInches || 0) - targetFullInches) >= 0.5
            );
            deletedCount += before - grp.keyframes.length;
          }
        }
      } else if (sizeName && groupId && kfId) {
        // Delete from ONE specific size+group by KF id
        const sp = config.sizePatterns.find((p) => p.sizeName === sizeName);
        if (sp) {
          const grp = (sp.keyframeGroups || []).find(
            (g) => (g.groupId || g.clientId) === groupId
          );
          if (grp) {
            const before = (grp.keyframes || []).length;
            grp.keyframes = (grp.keyframes || []).filter((k) => {
              const kid = String(k.id || k.clientId || "");
              return kid !== String(kfId) && k._mirrorOfId !== String(kfId);
            });
            deletedCount = before - grp.keyframes.length;
          }
        }
      }

      config.markModified("sizePatterns");
      await config.save();

      res.json({ success: true, message: `Deleted ${deletedCount} keyframe(s)`, deletedCount });
    } catch (error) {
      console.error("Error deleting keyframe:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// POST: Save full designer editor state for a size pattern
//  (persists basePaths + groups + keyframes so refresh restores canvas geometry)
router.post(
  "/pattern-grading/stock-item/:stockItemId/size-pattern/:sizeName/editor-state",
  async (req, res) => {
    try {
      const { stockItemId, sizeName } = req.params;
      const {
        basePaths, currentPaths, measureGroups, keyframes,
        seamEdges, foldAxes, viewportSlots, measurementPartRules,
        unitsPerInch, customMeasurements,
      } = req.body || {};

      const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
      if (!config) return res.status(404).json({ success: false, message: "Pattern config not found" });

      const sizePattern = config.sizePatterns.find((p) => p.sizeName === sizeName);
      if (!sizePattern) return res.status(404).json({ success: false, message: "Size pattern not found" });

      // Persist geometry (use basePaths or fall back to currentPaths)
      const pathsToSave =
        Array.isArray(basePaths) && basePaths.length ? basePaths
          : Array.isArray(currentPaths) && currentPaths.length ? currentPaths
            : null;
      if (pathsToSave) sizePattern.basePaths = pathsToSave;

      if (unitsPerInch != null) {
        const n = Number(unitsPerInch);
        if (Number.isFinite(n) && n > 0) sizePattern.unitsPerInch = n;
      }
      // ── Safeguard: if basePaths are being saved, the editor has already
      //    normalized coordinates to 25.4 (mm) space. Force UPI to match
      //    so the next load doesn't create a mismatch.
      if (pathsToSave && pathsToSave.length > 0 && sizePattern.unitsPerInch !== 25.4) {
        sizePattern.unitsPerInch = 25.4;
      }

      if (Array.isArray(seamEdges)) sizePattern.seamEdges = seamEdges.map((se) => ({
        clientId: String(se.id || se.clientId || `seam-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
        name: se.name || "Seam",
        pathIdx: Number(se.pathIdx) || 0,
        fromSegIdx: Number(se.fromSegIdx) || 0,
        toSegIdx: Number(se.toSegIdx) || 0,
        toPathIdx: se.toPathIdx != null ? Number(se.toPathIdx) : null,
        fullPath: !!se.fullPath,
        width: Math.max(0.0625, Math.min(10, Number(se.width) || 0.5)),
        visible: se.visible !== false,
        outwardSign: Number(se.outwardSign) || 1,
      }));

      if (Array.isArray(foldAxes)) sizePattern.foldAxes = foldAxes.map((fa) => ({
        clientId: String(fa.clientId || `fa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        name: fa.name || "Fold Axis",
        n1: { pathIdx: Number(fa.n1?.pathIdx ?? 0), segIdx: Number(fa.n1?.segIdx ?? 0), x: fa.n1?.x, y: fa.n1?.y },
        n2: { pathIdx: Number(fa.n2?.pathIdx ?? 0), segIdx: Number(fa.n2?.segIdx ?? 0), x: fa.n2?.x, y: fa.n2?.y },
        seamAllowanceInches: Number(fa.seamAllowanceInches) || 0,
        foldPathIdx: fa.foldPathIdx !== undefined ? Number(fa.foldPathIdx) : null,
        axisExplicit: !!fa.axisExplicit || !!fa._axisExplicit,
      }));

      if (viewportSlots !== undefined) { config.viewportSlots = viewportSlots; config.markModified("viewportSlots"); }
      if (req.body.viewport?.scale > 0) {
        config.savedViewport = { scale: parseFloat(req.body.viewport.scale), x: parseFloat(req.body.viewport.x) || 0, y: parseFloat(req.body.viewport.y) || 0 };
        config.markModified("savedViewport");
      }
      if (measurementPartRules !== undefined) { config.measurementPartRules = measurementPartRules; config.markModified("measurementPartRules"); }
      if (Array.isArray(customMeasurements)) { config.customMeasurements = customMeasurements; config.markModified("customMeasurements"); }

      // Rebuild keyframeGroups from measureGroups + keyframes arrays
      const keyframesArr = Array.isArray(keyframes) ? keyframes : [];
      const kfByGid = new Map();
      for (const kf of keyframesArr) {
        const gid = String(kf?.gid ?? kf?.groupId ?? "");
        if (!gid) continue;
        if (!kfByGid.has(gid)) kfByGid.set(gid, []);
        kfByGid.get(gid).push(normaliseKeyframe(kf));
      }

      const mgArr = Array.isArray(measureGroups) ? measureGroups : [];
      if (measureGroups !== undefined) {
        const filteredMG = mgArr.filter((mg) => {
          const as = String(mg.assignedSize || "").trim();
          return !as || as === sizeName;
        });

        const rebuiltGroups = filteredMG.map((mg) => {
          const gid = String(mg?.groupId ?? mg?.id ?? mg?.clientId ?? mg?.gid ?? "");
          if (!gid) return null;
          const groupKFs = kfByGid.get(gid) || [];
          const merged = normaliseGroup({ ...mg, groupId: gid, assignedSize: sizeName });
          // Frontend keyframes are ALWAYS authoritative when the keyframes field exists in the request.
          // Empty array = all keyframes deleted. We must NOT fall back to server data.
          if (keyframes !== undefined) {
            merged.keyframes = groupKFs; // may be empty — that's intentional (deletion)
          } else {
            // keyframes field not in request at all — preserve server data
            const existing = sizePattern.keyframeGroups.find((g) => (g.groupId || g.clientId) === gid);
            if (existing?.keyframes?.length) {
              merged.keyframes = existing.keyframes;
            }
          }
          return merged;
        }).filter(Boolean);

        sizePattern.keyframeGroups = rebuiltGroups;
      }

      sizePattern.groupsSetupCompleted = true;

      // ── Groups are INDEPENDENT per size — no cross-size sync ───────
      // Groups exist only where the designer creates them.
      // Keyframe propagation only works when matching partKeys exist
      // on target sizes (designer creates them manually).
      const savedGroups = sizePattern.keyframeGroups || [];

      // ── AUTO-PROPAGATION DISABLED ──────────────────────────────────
      // Designer records keyframes manually on each size.
      // This block is preserved for future use when a reliable
      // cross-SVG node-mapping algorithm is implemented.
      // To re-enable: uncomment the block below.
      /*
      const groupsWithKFs = savedGroups.filter(g => g.keyframes?.length > 0);
      ... (auto-propagation code removed for clarity — see git history)
      */

      config.markModified("sizePatterns");
      await config.save();

      res.json({ success: true, message: "Editor state saved" });
    } catch (error) {
      console.error("Error saving editor state:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// POST: Extrapolate keyframes from one reference size to all other sizes
router.post("/pattern-grading/stock-item/:stockItemId/extrapolate-keyframes", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { referenceSize, referencePartKey = "chest" } = req.body;

    if (!referenceSize)
      return res.status(400).json({ success: false, message: "referenceSize is required" });

    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config || !config.sizePatterns?.length)
      return res.status(404).json({ success: false, message: "No size patterns found" });

    const refPattern = config.sizePatterns.find((p) => p.sizeName === referenceSize);
    if (!refPattern)
      return res.status(404).json({ success: false, message: `Reference size "${referenceSize}" not found` });

    const refGroupsWithKFs = (refPattern.keyframeGroups || []).filter((g) => g.keyframes?.length > 0);
    if (!refGroupsWithKFs.length)
      return res.status(400).json({ success: false, message: `No keyframes recorded for ${referenceSize}` });

    // Standard Indian size chart for scaling
    const INDIAN_SIZE_CHART = {
      "4XS": { chest: 28, waist: 24, hip: 30 }, "3XS": { chest: 30, waist: 26, hip: 32 },
      "2XS": { chest: 32, waist: 28, hip: 34 }, "XS": { chest: 34, waist: 30, hip: 36 },
      "S": { chest: 36, waist: 32, hip: 38 }, "M": { chest: 38, waist: 34, hip: 40 },
      "L": { chest: 40, waist: 36, hip: 42 }, "XL": { chest: 42, waist: 38, hip: 44 },
      "2XL": { chest: 44, waist: 40, hip: 46 }, "3XL": { chest: 46, waist: 42, hip: 48 },
      "4XL": { chest: 48, waist: 44, hip: 50 }, "5XL": { chest: 50, waist: 46, hip: 52 },
      "6XL": { chest: 52, waist: 48, hip: 54 },
    };

    const refBase = refPattern.sizeValue || INDIAN_SIZE_CHART[referenceSize]?.[referencePartKey];
    if (!refBase)
      return res.status(400).json({ success: false, message: `Cannot determine base for ${referenceSize}` });

    let extrapolatedCount = 0;
    let skippedCount = 0;

    for (let si = 0; si < config.sizePatterns.length; si++) {
      const target = config.sizePatterns[si];
      if (target.sizeName === referenceSize) continue;

      const targetBase = target.sizeValue || INDIAN_SIZE_CHART[target.sizeName]?.[referencePartKey];
      if (!targetBase) { skippedCount++; continue; }

      const geoRatio = targetBase / refBase;
      if (!target.keyframeGroups) target.keyframeGroups = [];

      for (const refGroup of refGroupsWithKFs) {
        const gid = refGroup.groupId || refGroup.clientId;
        let targetGroupIdx = target.keyframeGroups.findIndex((g) => (g.groupId || g.clientId) === gid);
        if (targetGroupIdx === -1)
          targetGroupIdx = target.keyframeGroups.findIndex((g) => g.partKey === refGroup.partKey);

        const refBaseForGroup = refGroup.baseFullInches > 0 ? refGroup.baseFullInches : refBase;
        const existingTarget = targetGroupIdx !== -1 ? target.keyframeGroups[targetGroupIdx] : null;
        const targetBaseForGroup = existingTarget?.baseFullInches > 0
          ? existingTarget.baseFullInches
          : refBaseForGroup * geoRatio;
        const geoRatioForGroup = refBaseForGroup > 0 ? targetBaseForGroup / refBaseForGroup : geoRatio;

        // Only extrapolate designer-recorded KFs, NOT auto-mirrors
        const designerKFs = refGroup.keyframes.filter(kf => !kf._autoMirror);

        const extrapolatedKFs = designerKFs.map((refKF) => {
          const increment = refKF.targetFullInches - refBaseForGroup;
          return {
            id: `kf-ext-${target.sizeName}-${gid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            clientId: `kf-ext-${target.sizeName}-${gid}-${Date.now()}`,
            gid,
            targetFullInches: targetBaseForGroup + increment,
            targetRawInches: (targetBaseForGroup + increment) / (refGroup.multiplier || 1),
            sizeTag: target.sizeName,
            deltas: (refKF.deltas || []).map((d) => ({
              pi: d.pi, si: d.si,
              dx: d.dx * geoRatioForGroup, dy: d.dy * geoRatioForGroup,
              dc1x: d.dc1x * geoRatioForGroup, dc1y: d.dc1y * geoRatioForGroup,
              dc2x: d.dc2x * geoRatioForGroup, dc2y: d.dc2y * geoRatioForGroup,
            })),
            ts: new Date().toISOString(),
            _autoMirror: false,
          };
        });

        if (targetGroupIdx === -1) {
          target.keyframeGroups.push({
            ...normaliseGroup(refGroup),
            groupId: gid, clientId: gid,
            assignedSize: target.sizeName,
            baseFullInches: targetBaseForGroup,
            targetFullInches: targetBaseForGroup,
            keyframes: extrapolatedKFs,
          });
        } else {
          target.keyframeGroups[targetGroupIdx].keyframes = extrapolatedKFs;
          target.keyframeGroups[targetGroupIdx].partKey = refGroup.partKey;
          target.keyframeGroups[targetGroupIdx].ref1 = refGroup.ref1;
          target.keyframeGroups[targetGroupIdx].ref2 = refGroup.ref2;
          if (!target.keyframeGroups[targetGroupIdx].baseFullInches)
            target.keyframeGroups[targetGroupIdx].baseFullInches = targetBaseForGroup;
        }
        extrapolatedCount++;
      }
      config.sizePatterns[si] = target;
    }

    config.markModified("sizePatterns");
    await config.save();

    res.json({
      success: true,
      message: `Extrapolated ${extrapolatedCount} group(s) across ${config.sizePatterns.length - 1 - skippedCount} size(s).`,
      extrapolatedCount, skippedCount, referenceSize, referencePartKey, refBase,
    });
  } catch (error) {
    console.error("[Extrapolate Keyframes] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ROUTES (kept working for old single-pattern flow)
// ─────────────────────────────────────────────────────────────────────────────

// POST: Save SVG URL (legacy)
router.post("/pattern-grading/stock-item/:stockItemId/save-svg-url", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { svgFileUrl, svgPublicId, originalFilename, bytes } = req.body;

    if (!svgFileUrl) return res.status(400).json({ success: false, message: "svgFileUrl is required" });
    if (!svgFileUrl.startsWith("https://")) return res.status(400).json({ success: false, message: "svgFileUrl must be https" });

    const config = await PatternGradingConfig.findOneAndUpdate(
      { stockItemId, isActive: true },
      {
        $set: {
          svgFileUrl, svgPublicId: svgPublicId || null,
          originalFilename: originalFilename || null,
          svgFileSizeBytes: bytes || null, svgUploadedAt: new Date(),
        },
        $setOnInsert: { stockItemId, isActive: true, createdAt: new Date() },
      },
      { upsert: true, new: true }
    );

    return res.json({ success: true, message: "SVG URL saved", svgFileUrl: config.svgFileUrl, configId: config._id });
  } catch (err) {
    console.error("Error saving SVG URL:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// POST: Save full pattern grading config (legacy + works for single-pattern flow)
router.post("/pattern-grading/stock-item/:stockItemId/save-config", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const {
      basePaths, measureGroups, keyframes, seamEdges, foldAxes,
      viewportSlots, unitsPerInch, basePatternSize, configSnapshot,
      measurementPartRules, globalRotation,
    } = req.body;

    const stockItem = await StockItem.findById(stockItemId).select("name reference").lean();
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    let config = await PatternGradingConfig.findOne({ stockItemId, isActive: true });
    if (!config) {
      config = new PatternGradingConfig({
        stockItemId, stockItemName: stockItem.name,
        stockItemReference: stockItem.reference, isActive: true,
        createdBy: req.user.id,
      });
    }

    if (basePaths !== undefined) {
      config.basePaths = basePaths.map((path) => ({
        ...path,
        originalSegs: path.segs.map((seg) => ({ ...seg })),
        rotationAngle: path.rotationAngle || 0,
        rotationPivot: path.rotationPivot || null,
        mirrorSourceIdx: null,
        mirrorFoldAxis: null,
      }));
    }

    if (measureGroups !== undefined) config.measureGroups = measureGroups.map(normaliseGroup);
    if (keyframes !== undefined) config.keyframes = keyframes.map(normaliseKeyframe);

    if (seamEdges !== undefined) {
      config.seamEdges = (seamEdges || []).map((se) => ({
        clientId: String(se.id || se.clientId || `seam-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`),
        name: se.name || "Seam",
        pathIdx: Number(se.pathIdx) || 0,
        fromSegIdx: Number(se.fromSegIdx) || 0,
        toSegIdx: Number(se.toSegIdx) || 0,
        toPathIdx: se.toPathIdx != null ? Number(se.toPathIdx) : null,
        fullPath: !!se.fullPath,
        width: Math.max(0.0625, Math.min(10, Number(se.width) || 0.5)),
        visible: se.visible !== false,
        outwardSign: Number(se.outwardSign) || 1,
      }));
    }

    if (foldAxes !== undefined) {
      config.foldAxes = (foldAxes || []).map((fa) => ({
        clientId: String(fa.clientId || `fa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
        name: fa.name || "Fold Axis",
        n1: { pathIdx: Number(fa.n1?.pathIdx ?? 0), segIdx: Number(fa.n1?.segIdx ?? 0), x: fa.n1?.x, y: fa.n1?.y },
        n2: { pathIdx: Number(fa.n2?.pathIdx ?? 0), segIdx: Number(fa.n2?.segIdx ?? 0), x: fa.n2?.x, y: fa.n2?.y },
        seamAllowanceInches: Number(fa.seamAllowanceInches) || 0,
        foldPathIdx: fa.foldPathIdx !== undefined ? Number(fa.foldPathIdx) : null,
        axisExplicit: !!fa._axisExplicit || !!fa.axisExplicit,
      }));
    }

    if (unitsPerInch !== undefined) config.unitsPerInch = unitsPerInch;
    // ── Safeguard: editor normalizes all coords to 25.4 (mm) space.
    //    Force UPI to 25.4 when basePaths are being saved.
    if (basePaths !== undefined && Array.isArray(basePaths) && basePaths.length > 0 && config.unitsPerInch !== 25.4) {
      config.unitsPerInch = 25.4;
    }
    if (basePatternSize !== undefined) config.basePatternSize = basePatternSize;
    if (req.body.viewport?.scale > 0) {
      config.savedViewport = { scale: parseFloat(req.body.viewport.scale), x: parseFloat(req.body.viewport.x) || 0, y: parseFloat(req.body.viewport.y) || 0 };
    }
    if (viewportSlots && typeof viewportSlots === "object") config.viewportSlots = viewportSlots;
    if (globalRotation) config.globalRotation = { angle: Number(globalRotation.angle) || 0, pivotX: Number(globalRotation.pivotX) || 0, pivotY: Number(globalRotation.pivotY) || 0 };
    if (configSnapshot !== undefined) config.configSnapshot = configSnapshot;
    if (measurementPartRules !== undefined) config.measurementPartRules = measurementPartRules;
    if (req.body.customMeasurements !== undefined) config.customMeasurements = req.body.customMeasurements;

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
      seamEdgeCount: (config.seamEdges || []).length,
    });
  } catch (error) {
    console.error("Error saving pattern config:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUTTING MASTER: List all employees + measurements for a work order
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pattern-grading/work-order/:woId/employees", async (req, res) => {
  try {
    const { woId } = req.params;

    const workOrder = await WorkOrder.findById(woId)
      .select("workOrderNumber stockItemId stockItemName stockItemReference customerRequestId quantity variantAttributes")
      .lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const stockItem = await StockItem.findById(workOrder.stockItemId)
      .select("name reference measurements category")
      .lean();

    const measurement = await Measurement.findOne({ poRequestId: workOrder.customerRequestId }).lean();

    const employees = [];
    if (measurement?.employeeMeasurements) {
      for (const emp of measurement.employeeMeasurements) {
        const product = emp.products?.find((p) => p.productName === workOrder.stockItemName);
        employees.push({
          employeeId: emp.employeeId,
          employeeName: emp.employeeName,
          employeeUIN: emp.employeeUIN,
          gender: emp.gender,
          quantity: product?.quantity || 1,
          measurements: product?.measurements || [],
          measurementCount: (product?.measurements || []).length,
          qrGenerated: product?.qrGenerated || false,
        });
      }
    }

    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        stockItemId: workOrder.stockItemId,
        stockItemName: workOrder.stockItemName,
        stockItemReference: workOrder.stockItemReference,
        quantity: workOrder.quantity,
        variantAttributes: workOrder.variantAttributes,
      },
      stockItem: stockItem || null,
      employees,
      total: employees.length,
    });
  } catch (error) {
    console.error("Error listing WO employees:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CUTTING MASTER: employee CAD data
// Works for BOTH old (single-pattern) and new (size-based) configs.
// For new configs, we pick the closest matching size pattern based on
// the designated group measurement of the employee.
// ─────────────────────────────────────────────────────────────────────────────
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
            employeeId: emp.employeeId, employeeName: emp.employeeName,
            employeeUIN: emp.employeeUIN, gender: emp.gender,
          };
          const product = emp.products.find((p) => p.productName === workOrder.stockItemName);
          if (product) {
            employeeMeasurementData = {
              productName: product.productName, quantity: product.quantity,
              measurements: product.measurements, qrGenerated: product.qrGenerated,
            };
          }
          break;
        }
      }
    }

    const patternConfig = await PatternGradingConfig.findOne({
      stockItemId: workOrder.stockItemId,
      isActive: true,
    })
      .sort({ updatedAt: -1 })
      .lean();

    // Build measurement lookup
    const measurementMap = {};
    if (employeeMeasurementData?.measurements) {
      for (const m of employeeMeasurementData.measurements) {
        measurementMap[m.measurementName] = parseFloat(m.value) || 0;
        measurementMap[m.measurementName.toLowerCase()] = parseFloat(m.value) || 0;
      }
    }

    // ── Debug logging ──
    console.log("[cad-data] DEBUG:",
      "stockItemId:", workOrder.stockItemId,
      "| stockItemName:", workOrder.stockItemName,
      "| patternConfig found:", !!patternConfig,
      "| sizePatterns:", patternConfig?.sizePatterns?.length || 0,
      "| designatedGroup:", patternConfig?.designatedGroup || "none",
      "| measurementMap:", JSON.stringify(measurementMap)
    );

    // ── NEW: size-based pattern matching ────────────────────────────────────
    let selectedSizePattern = null;
    let resolvedPaths = null;
    let resolvedUpi = 25.4;
    let resolvedSeamEdges = [];
    let resolvedFoldAxes = [];
    let computedGroupTargets = [];

    if (patternConfig && (patternConfig.sizePatterns || []).length > 0) {
      const designatedGroup = patternConfig.designatedGroup || "chest";
      const empDesignatedValue =
        measurementMap[designatedGroup] ||
        measurementMap[designatedGroup.toLowerCase()] ||
        null;

      if (empDesignatedValue) {
        // ── Size matching: always round DOWN to the lower size ──
        // Pick the largest size whose compareVal <= empValue.
        // This ensures grading always goes UP (adds inches) from the base.
        // e.g., employee chest=39.3 with sizes 38(L) and 40(XL) → pick L (38)
        //        so grading adds 1.3" rather than subtracting 0.7"
        const sizeComparisonLog = [];
        const sizeEntries = [];
        for (const sp of patternConfig.sizePatterns) {
          const designerVal =
            sp.baseMeasurements?.[designatedGroup] ??
            sp.baseMeasurements?.[designatedGroup.toLowerCase()] ??
            sp.baseMeasurements?.[designatedGroup.charAt(0).toUpperCase() + designatedGroup.slice(1)] ??
            null;
          const compareVal = (designerVal !== null && designerVal !== undefined && designerVal !== "")
            ? parseFloat(designerVal)
            : sp.sizeValue;
          sizeEntries.push({ sp, compareVal, designerVal });
          sizeComparisonLog.push(`${sp.sizeName}: designerVal=${designerVal} sizeValue=${sp.sizeValue} using=${compareVal}`);
        }

        // Sort by compareVal ascending
        sizeEntries.sort((a, b) => a.compareVal - b.compareVal);

        // Check for exact match first
        let selectedEntry = sizeEntries.find(e => Math.abs(e.compareVal - empDesignatedValue) < 0.001);

        if (!selectedEntry) {
          // Find the LARGEST size whose compareVal <= employee value (round DOWN / floor)
          // Filter to sizes that are <= empValue, then pick the last (largest) one
          const candidates = sizeEntries.filter(e => e.compareVal <= empDesignatedValue);
          if (candidates.length > 0) {
            selectedEntry = candidates[candidates.length - 1];
          }
        }

        if (!selectedEntry) {
          // Employee is SMALLER than all sizes — pick the smallest available
          selectedEntry = sizeEntries[0];
        }

        selectedSizePattern = selectedEntry.sp;

        console.log("[cad-data] SIZE MATCHING (round-down):");
        console.log("  designatedGroup:", designatedGroup, "| empValue:", empDesignatedValue);
        sizeComparisonLog.forEach(l => console.log("  ", l));
        console.log("  RESULT:", selectedSizePattern?.sizeName, "(compareVal:", selectedEntry.compareVal, ")");
      } else {
        // No measurement found — use first pattern
        selectedSizePattern = patternConfig.sizePatterns[0];
      }

      if (selectedSizePattern) {
        // Paths
        resolvedPaths = selectedSizePattern.basePaths || null;
        // If basePaths exist they were normalized to 25.4 (mm) space by the editor.
        // Always use 25.4 in that case to prevent mismatched coordinates/UPI.
        resolvedUpi = (resolvedPaths && resolvedPaths.length > 0)
          ? 25.4
          : (selectedSizePattern.unitsPerInch || 25.4);

        // Seam / fold
        resolvedSeamEdges = (selectedSizePattern.seamEdges || [])
          .filter((se) => se.visible !== false)
          .map((se) => ({
            id: se.clientId || se._id?.toString(),
            clientId: se.clientId || se._id?.toString(),
            name: se.name || "Seam", pathIdx: se.pathIdx,
            fromSegIdx: se.fromSegIdx, toSegIdx: se.toSegIdx,
            toPathIdx: se.toPathIdx != null ? se.toPathIdx : undefined,
            fullPath: !!se.fullPath,
            width: se.width, visible: se.visible !== false, outwardSign: se.outwardSign || 1,
          }));

        resolvedFoldAxes = (selectedSizePattern.foldAxes || []).map((fa) => ({
          id: fa.clientId || fa._id?.toString(),
          clientId: fa.clientId || fa._id?.toString(),
          name: fa.name || "Fold Axis",
          n1: fa.n1, n2: fa.n2,
          seamAllowanceInches: fa.seamAllowanceInches || 0,
          foldPathIdx: fa.foldPathIdx ?? fa.n1?.pathIdx ?? 0,
          axisExplicit: !!fa.axisExplicit,
        }));

        // Compute group targets from this size pattern's keyframeGroups
        computedGroupTargets = (selectedSizePattern.keyframeGroups || []).map((group) => {
          const gid = group.groupId || group.clientId;
          const pKey = group.partKey;
          // Skip __dup__ prefixed partKeys when looking up employee measurements
          const cleanPartKey = pKey?.startsWith("__dup__") ? pKey.slice(7) : pKey;
          const empVal = cleanPartKey
            ? (measurementMap[cleanPartKey] || measurementMap[cleanPartKey?.toLowerCase()] || null)
            : null;

          // ── Fallback for missing employee measurements ──
          // If the employee doesn't have this measurement (field missing or empty),
          // use the designer's baseMeasurements for this size pattern.
          // e.g., employee matched to Size L but has no Knee → use L's baseMeasurements.knee
          let fallbackVal = null;
          if (empVal === null && cleanPartKey && selectedSizePattern.baseMeasurements) {
            fallbackVal =
              selectedSizePattern.baseMeasurements[cleanPartKey] ??
              selectedSizePattern.baseMeasurements[cleanPartKey?.toLowerCase()] ??
              selectedSizePattern.baseMeasurements[cleanPartKey?.charAt(0).toUpperCase() + cleanPartKey?.slice(1)] ??
              null;
            if (fallbackVal !== null && fallbackVal !== undefined && fallbackVal !== "") {
              fallbackVal = parseFloat(fallbackVal);
              console.log(`[cad-data] Missing measurement "${cleanPartKey}" for employee — using size ${selectedSizePattern.sizeName} baseMeasurement: ${fallbackVal}`);
            } else {
              fallbackVal = null;
            }
          }

          // The effective employee value: actual measurement > designer fallback > null
          const effectiveEmpVal = empVal !== null ? empVal : fallbackVal;

          // ── Check keyframe coverage ──
          // Collect all targetFullInches values from this group's keyframes
          const keyframes = group.keyframes || [];
          const kfValues = keyframes.map(kf => kf.targetFullInches).filter(v => v != null && !isNaN(v));
          const baseVal = group.baseFullInches || 0;
          const hasKeyframes = kfValues.length > 0;

          // The grading range is from baseFullInches through all keyframe targets
          let gradingMin = baseVal;
          let gradingMax = baseVal;
          if (hasKeyframes) {
            const allVals = [baseVal, ...kfValues];
            gradingMin = Math.min(...allVals);
            gradingMax = Math.max(...allVals);
          }

          // Determine if grading can be applied for this group
          let gradingApplicable = true;
          let gradingWarning = null;

          if (effectiveEmpVal !== null && hasKeyframes) {
            if (effectiveEmpVal < gradingMin || effectiveEmpVal > gradingMax) {
              gradingApplicable = false;
              gradingWarning = `Employee ${cleanPartKey} (${effectiveEmpVal}") is outside the graded range (${gradingMin}" – ${gradingMax}"). No grading applied.`;
            }
          } else if (effectiveEmpVal !== null && !hasKeyframes) {
            gradingApplicable = false;
            gradingWarning = `No keyframes recorded for ${group.groupName || group.name || cleanPartKey}. Grading cannot be applied.`;
          }

          return {
            groupClientId: gid,
            groupName: group.groupName || group.name,
            partKey: pKey,
            assignedSize: group.assignedSize || selectedSizePattern.sizeName,
            multiplier: group.multiplier || 1,
            baseFullInches: baseVal,
            targetFullInches: effectiveEmpVal !== null ? effectiveEmpVal : baseVal,
            hasEmployeeData: effectiveEmpVal !== null,
            employeeValue: effectiveEmpVal,
            usedFallback: empVal === null && fallbackVal !== null,
            fallbackSource: empVal === null && fallbackVal !== null ? `Size ${selectedSizePattern.sizeName} default` : null,
            // New fields for grading status
            hasKeyframes,
            keyframeCount: kfValues.length,
            gradingMin,
            gradingMax,
            gradingApplicable,
            gradingWarning,
          };
        });
      }
    }

    // ── LEGACY: single-pattern flow ─────────────────────────────────────────
    if (!selectedSizePattern && patternConfig?.measureGroups?.length > 0) {
      computedGroupTargets = patternConfig.measureGroups.map((group) => {
        const pKey = group.partKey;
        const empVal = pKey ? (measurementMap[pKey] ?? null) : null;
        return {
          groupClientId: group.clientId,
          groupName: group.name,
          partKey: pKey,
          assignedSize: group.assignedSize,
          multiplier: group.multiplier,
          baseFullInches: group.baseFullInches,
          targetFullInches: empVal !== null ? empVal : group.baseFullInches,
          hasEmployeeData: empVal !== null,
          employeeValue: empVal,
        };
      });

      resolvedSeamEdges = (patternConfig.seamEdges || [])
        .filter((se) => se.visible !== false)
        .map((se) => ({
          id: se.clientId || se._id?.toString(),
          clientId: se.clientId || se._id?.toString(),
          name: se.name || "Seam", pathIdx: se.pathIdx,
          fromSegIdx: se.fromSegIdx, toSegIdx: se.toSegIdx,
          toPathIdx: se.toPathIdx != null ? se.toPathIdx : undefined,
          fullPath: !!se.fullPath,
          width: se.width, visible: se.visible !== false, outwardSign: se.outwardSign || 1,
        }));

      resolvedFoldAxes = (patternConfig.foldAxes || []).map((fa) => ({
        id: fa.clientId || fa._id?.toString(),
        clientId: fa.clientId || fa._id?.toString(),
        name: fa.name || "Fold Axis",
        n1: fa.n1, n2: fa.n2,
        seamAllowanceInches: fa.seamAllowanceInches || 0,
        foldPathIdx: fa.foldPathIdx ?? fa.n1?.pathIdx ?? 0,
        axisExplicit: !!fa.axisExplicit,
      }));
    }

    res.json({
      success: true,
      workOrder: {
        _id: workOrder._id, workOrderNumber: workOrder.workOrderNumber,
        stockItemName: workOrder.stockItemName, stockItemReference: workOrder.stockItemReference,
        variantAttributes: workOrder.variantAttributes, quantity: workOrder.quantity,
      },
      stockItem: stockItem || null,
      employeeInfo,
      employeeMeasurementData,
      measurementMap,
      patternConfig: patternConfig || null,
      // If size-based, override patternConfig paths with the selected size's paths
      selectedSizePattern: selectedSizePattern || null,
      resolvedPaths, // null means use patternConfig.basePaths or fetch from svgFileUrl
      resolvedUpi,
      computedGroupTargets,
      seamEdges: resolvedSeamEdges,
      foldAxes: resolvedFoldAxes,
      hasFoldAxes: resolvedFoldAxes.length > 0,
      viewportSlots: patternConfig?.viewportSlots || {},
      savedViewport: patternConfig?.savedViewport || null,
      globalRotation: patternConfig?.globalRotation || { angle: 0, pivotX: 0, pivotY: 0 },
      hasPatternConfig: !!patternConfig,
      hasSVGFile: selectedSizePattern ? !!selectedSizePattern.svgFileUrl : !!patternConfig?.svgFileUrl,
      hasGroups: selectedSizePattern
        ? (selectedSizePattern.keyframeGroups?.length > 0)
        : !!patternConfig?.measureGroups?.length,
      hasKeyframes: selectedSizePattern
        ? selectedSizePattern.keyframeGroups?.some((g) => g.keyframes?.length > 0)
        : !!patternConfig?.keyframes?.length,
      hasSeamEdges: resolvedSeamEdges.length > 0,
      customMeasurements: patternConfig?.customMeasurements || [],
    });
  } catch (error) {
    console.error("Error fetching CAD data:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET: Bulk resolve matched sizes for ALL employees in a work order
// Returns a lightweight map of employeeId → matchedSizeName without loading full CAD data
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pattern-grading/work-order/:woId/employee-sizes", async (req, res) => {
  try {
    const { woId } = req.params;
    const workOrder = await WorkOrder.findById(woId)
      .select("stockItemId stockItemName customerRequestId")
      .lean();
    if (!workOrder) return res.status(404).json({ success: false, message: "Work order not found" });

    const patternConfig = await PatternGradingConfig.findOne({
      stockItemId: workOrder.stockItemId,
      isActive: true,
    }).sort({ updatedAt: -1 }).lean();

    if (!patternConfig || !patternConfig.sizePatterns?.length) {
      return res.json({ success: true, employeeSizes: {}, hasConfig: false });
    }

    const designatedGroup = patternConfig.designatedGroup || "chest";

    // Build sorted size entries once
    const sizeEntries = patternConfig.sizePatterns.map(sp => {
      const designerVal =
        sp.baseMeasurements?.[designatedGroup] ??
        sp.baseMeasurements?.[designatedGroup.toLowerCase()] ??
        sp.baseMeasurements?.[designatedGroup.charAt(0).toUpperCase() + designatedGroup.slice(1)] ??
        null;
      const compareVal = (designerVal !== null && designerVal !== undefined && designerVal !== "")
        ? parseFloat(designerVal) : sp.sizeValue;
      return { sizeName: sp.sizeName, compareVal };
    }).sort((a, b) => a.compareVal - b.compareVal);

    // Get all employee measurements
    const measurement = await Measurement.findOne({ poRequestId: workOrder.customerRequestId }).lean();
    if (!measurement) return res.json({ success: true, employeeSizes: {}, hasConfig: true });

    const employeeSizes = {};
    for (const emp of measurement.employeeMeasurements) {
      const product = emp.products?.find(p => p.productName === workOrder.stockItemName);
      if (!product) continue;

      // Find the designated group measurement
      let empDesignatedValue = null;
      for (const m of product.measurements || []) {
        if (m.measurementName === designatedGroup ||
          m.measurementName?.toLowerCase() === designatedGroup.toLowerCase()) {
          empDesignatedValue = parseFloat(m.value) || null;
          break;
        }
      }

      if (!empDesignatedValue) {
        // No measurement — assign first size
        employeeSizes[String(emp.employeeId)] = sizeEntries[0]?.sizeName || null;
        continue;
      }

      // Same round-down logic as cad-data endpoint
      let matched = sizeEntries.find(e => Math.abs(e.compareVal - empDesignatedValue) < 0.001);
      if (!matched) {
        const candidates = sizeEntries.filter(e => e.compareVal <= empDesignatedValue);
        matched = candidates.length > 0 ? candidates[candidates.length - 1] : sizeEntries[0];
      }
      employeeSizes[String(emp.employeeId)] = matched?.sizeName || null;
    }

    res.json({ success: true, employeeSizes, designatedGroup, hasConfig: true });
  } catch (error) {
    console.error("Error resolving employee sizes:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS (keyboard shortcuts + pattern metadata)
// ─────────────────────────────────────────────────────────────────────────────

router.get("/pattern-grading/stock-item/:stockItemId/settings", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true })
      .select("keyboardShortcuts patternTitle patternDescription patternNotes patternTags patternRevision patternDesigner stockItemName stockItemReference updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    if (!config) return res.json({ success: true, settings: null, keyboardShortcuts: {} });

    res.json({
      success: true,
      settings: {
        patternTitle: config.patternTitle || "",
        patternDescription: config.patternDescription || "",
        patternNotes: config.patternNotes || "",
        patternTags: config.patternTags || [],
        patternRevision: config.patternRevision || "1.0",
        patternDesigner: config.patternDesigner || "",
        stockItemName: config.stockItemName || "",
        stockItemReference: config.stockItemReference || "",
        updatedAt: config.updatedAt,
      },
      keyboardShortcuts: config.keyboardShortcuts || {},
    });
  } catch (error) {
    console.error("Error fetching pattern settings:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post("/pattern-grading/stock-item/:stockItemId/settings", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const { keyboardShortcuts, patternTitle, patternDescription, patternNotes, patternTags, patternRevision, patternDesigner } = req.body;

    const update = {};
    if (keyboardShortcuts !== undefined) {
      const sanitized = {};
      for (const [actionId, binding] of Object.entries(keyboardShortcuts)) {
        if (typeof binding === "object" && binding !== null) {
          sanitized[actionId] = {
            key: typeof binding.key === "string" ? binding.key : "",
            ctrl: !!binding.ctrl, shift: !!binding.shift, alt: !!binding.alt, meta: !!binding.meta,
            label: typeof binding.label === "string" ? binding.label : actionId,
            category: typeof binding.category === "string" ? binding.category : "general",
            mouseButton: binding.mouseButton !== undefined ? Number(binding.mouseButton) : null,
          };
        }
      }
      update.keyboardShortcuts = sanitized;
    }
    if (patternTitle !== undefined) update.patternTitle = String(patternTitle).trim().slice(0, 200);
    if (patternDescription !== undefined) update.patternDescription = String(patternDescription).trim().slice(0, 2000);
    if (patternNotes !== undefined) update.patternNotes = String(patternNotes).trim().slice(0, 5000);
    if (patternTags !== undefined) update.patternTags = Array.isArray(patternTags) ? patternTags.map((t) => String(t).trim()).filter(Boolean).slice(0, 20) : [];
    if (patternRevision !== undefined) update.patternRevision = String(patternRevision).trim().slice(0, 50);
    if (patternDesigner !== undefined) update.patternDesigner = String(patternDesigner).trim().slice(0, 100);
    update.lastConfiguredBy = req.user.id;
    update.lastConfiguredAt = new Date();

    const config = await PatternGradingConfig.findOneAndUpdate(
      { stockItemId, isActive: true },
      { $set: update },
      { new: true, sort: { updatedAt: -1 } }
    );
    if (!config) return res.status(404).json({ success: false, message: "Pattern config not found — save first" });

    res.json({
      success: true, message: "Settings saved",
      keyboardShortcuts: config.keyboardShortcuts || {},
      settings: {
        patternTitle: config.patternTitle, patternDescription: config.patternDescription,
        patternNotes: config.patternNotes, patternTags: config.patternTags,
        patternRevision: config.patternRevision, patternDesigner: config.patternDesigner,
      },
    });
  } catch (error) {
    console.error("Error saving pattern settings:", error);
    res.status(500).json({ success: false, message: "Server error: " + error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LIST / DELETE configs
// ─────────────────────────────────────────────────────────────────────────────

router.get("/pattern-grading/configs", async (req, res) => {
  try {
    const configs = await PatternGradingConfig.find({ isActive: true })
      .select("stockItemId stockItemName stockItemReference svgFileName sizePatterns measureGroups keyframes seamEdges basePatternSize setupCompleted updatedAt version")
      .sort({ updatedAt: -1 })
      .lean();

    const enriched = configs.map((c) => ({
      ...c,
      groupCount: c.measureGroups?.length || 0,
      keyframeCount: c.keyframes?.length || 0,
      seamEdgeCount: c.seamEdges?.length || 0,
      sizePatternCount: c.sizePatterns?.length || 0,
      hasSVG: !!(c.svgFileName || (c.sizePatterns?.length > 0)),
      conditionCount: (c.measureGroups || []).reduce((acc, g) => acc + (g.nestedConditions?.length || 0), 0),
    }));

    res.json({ success: true, configs: enriched, total: enriched.length });
  } catch (error) {
    console.error("Error listing configs:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

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

// ─────────────────────────────────────────────────────────────────────────────
// PATTERN SVG UPLOAD — Google Drive
// ─────────────────────────────────────────────────────────────────────────────

let multer;
try { multer = require("multer"); } catch (e) { /* multer not installed — routes will return 501 */ }

const multerUpload = multer ? multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }) : null;

// GET: Test Google Drive connection (diagnostic — hit this in browser to debug)
router.get("/pattern-grading/test-drive", async (req, res) => {
  try {
    const { testDriveConnection } = require("../../../../utils/googleDrivePatternUpload");
    const result = await testDriveConnection();
    res.json({ success: true, ...result, message: "Google Drive connection working!" });
  } catch (error) {
    console.error("[Drive Test] Error:", error);
    res.status(500).json({
      success: false,
      message: error.message,
      envCheck: {
        hasServiceAccountKey: !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY,
        keyLength: (process.env.GOOGLE_SERVICE_ACCOUNT_KEY || "").length,
        hasFolderId: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
        folderIdValue: process.env.GOOGLE_DRIVE_FOLDER_ID || "(not set)",
      },
    });
  }
});

// POST: Upload SVG pattern file to Google Drive
router.post(
  "/pattern-grading/upload-pattern-svg",
  multerUpload ? multerUpload.single("file") : (req, res, next) => res.status(501).json({ success: false, message: "multer not installed — run: npm install multer" }),
  async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const { stockItemId, sizeName, stockItemName } = req.body;
      if (!stockItemId || !sizeName) {
        return res.status(400).json({ success: false, message: "stockItemId and sizeName are required" });
      }

      let driveUpload;
      try {
        const { uploadPatternToDrive } = require("../../../../utils/googleDrivePatternUpload");
        driveUpload = await uploadPatternToDrive(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          stockItemId,
          sizeName,
          stockItemName
        );
      } catch (driveError) {
        console.warn("[Pattern Upload] Google Drive upload failed, check configuration:", driveError.message);
        return res.status(500).json({
          success: false,
          message: "Google Drive not configured: " + driveError.message,
          hint: "Set GOOGLE_SERVICE_ACCOUNT_KEY (JSON) and GOOGLE_DRIVE_FOLDER_ID env vars. Also run: npm install googleapis",
        });
      }

      // ── Detect UPI from SVG content so the correct value is stored in DB ──
      // Adobe Illustrator always uses 72 pt/inch internally. When it exports
      // SVGs with a unitless width="1234" attribute, that value is in points,
      // NOT CSS pixels (96). We detect Adobe signatures first so the correct
      // divisor (72) is used instead of the CSS default (96).
      let detectedUpi = 25.4;
      try {
        const svgText = req.file.buffer.toString("utf-8");
        const svgMatch = svgText.match(/<svg([^>]*)>([\s\S]*?)<\/svg>/i);
        if (svgMatch) {
          const svgAttr = svgMatch[1];
          const svgBody = (svgMatch[2] || "").substring(0, 2000);
          const fullTag = svgAttr + svgBody;
          const isAdobe = /illustrator|adobe|data-name/i.test(fullTag);
          const isInkscape = /inkscape/i.test(fullTag);

          const wm = svgAttr.match(/\bwidth=["']([0-9.]+)(mm|cm|in|pt|px)?["']/i);
          const vbm = svgAttr.match(/viewBox=["'][^"']*["']/i);
          if (wm && vbm) {
            const physW = parseFloat(wm[1]);
            const unit = (wm[2] || "").toLowerCase(); // "" when no unit suffix
            const pts = vbm[0].match(/-?[\d.]+/g), vbW = pts ? parseFloat(pts[2]) : 0;
            if (physW && vbW) {
              if (unit) {
                // Explicit CSS unit — trust it
                const inchW = unit === "mm" ? physW / 25.4 : unit === "cm" ? physW / 2.54 : unit === "in" ? physW : unit === "pt" ? physW / 72 : physW / 96;
                detectedUpi = vbW / inchW;
              } else {
                // No unit suffix — use tool signature to decide
                if (isAdobe) detectedUpi = vbW / (physW / 72);  // Adobe = points
                else if (isInkscape) detectedUpi = vbW / (physW / 96);  // Inkscape = CSS px
                else detectedUpi = vbW / (physW / 96);  // Unknown = assume CSS px
              }
            }
          } else {
            // No width/height — check for tool signatures
            if (isAdobe) detectedUpi = 72;
            else if (isInkscape) detectedUpi = 96;
            else if (vbm) detectedUpi = 72;
          }
        }
      } catch (_) { /* ignore parse errors */ }

      res.json({
        success: true,
        url: driveUpload.url,
        fileId: driveUpload.fileId,
        webViewLink: driveUpload.webViewLink,
        originalFilename: req.file.originalname,
        bytes: req.file.size,
        mimeType: req.file.mimetype,
        unitsPerInch: Math.round(detectedUpi * 100) / 100,
      });
    } catch (error) {
      console.error("[Pattern Upload] Error:", error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
);

// POST: Delete SVG pattern file from Google Drive
router.post("/pattern-grading/delete-pattern-svg", async (req, res) => {
  try {
    const { fileId, stockItemId } = req.body;
    if (!fileId) return res.status(400).json({ success: false, message: "fileId is required" });

    const { deletePatternFromDrive } = require("../../../../utils/googleDrivePatternUpload");
    await deletePatternFromDrive(fileId);

    res.json({ success: true, message: "File deleted from Google Drive" });
  } catch (error) {
    console.error("[Pattern Delete] Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET: Proxy SVG content from Google Drive (service account auth)
// GET: Proxy SVG content from Google Drive (service account auth)
router.get("/pattern-grading/svg-content/:fileId", async (req, res) => {
  try {
    const { fileId } = req.params;
    if (!fileId || fileId === "undefined") {
      return res.status(400).json({ success: false, message: "fileId is required" });
    }

    const { fetchFileContentFromDrive } = require("../../../../utils/googleDrivePatternUpload");
    const svgContent = await fetchFileContentFromDrive(fileId);

    res.set("Content-Type", "image/svg+xml");
    res.set("Cache-Control", "public, max-age=3600");
    res.send(svgContent);
  } catch (error) {
    console.error("[SVG Proxy] Error fetching file:", error.message);
    res.status(500).json({ success: false, message: "Failed to fetch SVG: " + error.message });
  }
});

// GET: Debug — inspect SVG headers for all size patterns of a stock item
router.get("/pattern-grading/debug-svg-headers/:stockItemId", async (req, res) => {
  try {
    const { stockItemId } = req.params;
    const config = await PatternGradingConfig.findOne({ stockItemId, isActive: true }).lean();
    if (!config) return res.status(404).json({ success: false, message: "Config not found" });

    const { fetchFileContentFromDrive } = require("../../../../utils/googleDrivePatternUpload");
    const results = [];

    for (const sp of (config.sizePatterns || [])) {
      const fileId = sp.svgPublicId;
      if (!fileId) { results.push({ sizeName: sp.sizeName, error: "no fileId" }); continue; }
      try {
        const svgText = await fetchFileContentFromDrive(fileId);
        const svgMatch = svgText.match(/<svg([^>]*)>/i);
        const svgAttr = svgMatch ? svgMatch[1] : "(no svg tag)";

        const widthMatch = svgAttr.match(/\bwidth=["']([^"']+)["']/i);
        const heightMatch = svgAttr.match(/\bheight=["']([^"']+)["']/i);
        const viewBoxMatch = svgAttr.match(/viewBox=["']([^"']+)["']/i);

        const wm = svgAttr.match(/\bwidth=["']([0-9.]+)(mm|cm|in|pt|px)?["']/i);
        const vbm = svgAttr.match(/viewBox=["'][^"']*["']/i);
        let computedUpi = 25.4, upiDetail = "fallback";
        if (wm && vbm) {
          const physW = parseFloat(wm[1]), unit = (wm[2] || "px").toLowerCase();
          const pts = vbm[0].match(/-?[\d.]+/g), vbW = pts ? parseFloat(pts[2]) : 0;
          if (physW && vbW) {
            const inchW = unit === "mm" ? physW / 25.4 : unit === "cm" ? physW / 2.54 : unit === "in" ? physW : unit === "pt" ? physW / 72 : physW / 96;
            computedUpi = vbW / inchW;
            upiDetail = `w=${physW}${unit} vbW=${vbW} inW=${inchW.toFixed(3)}`;
          }
        }

        // Rough bounding box from path d attributes
        const pathDs = [...svgText.matchAll(/\bd="([^"]+)"/gi)].map(m => m[1]);
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const d of pathDs) {
          const nums = d.match(/-?[\d.]+/g)?.map(Number) || [];
          for (let i = 0; i < nums.length; i += 2) {
            if (!isNaN(nums[i])) { minX = Math.min(minX, nums[i]); maxX = Math.max(maxX, nums[i]); }
            if (!isNaN(nums[i + 1])) { minY = Math.min(minY, nums[i + 1]); maxY = Math.max(maxY, nums[i + 1]); }
          }
        }

        results.push({
          sizeName: sp.sizeName, sizeValue: sp.sizeValue, bytes: sp.bytes,
          svgTag: svgAttr.substring(0, 300),
          width: widthMatch?.[1], height: heightMatch?.[1], viewBox: viewBoxMatch?.[1],
          computedUpi: Math.round(computedUpi * 100) / 100, upiDetail,
          approxBBox: minX !== Infinity ? {
            minX: Math.round(minX * 10) / 10, maxX: Math.round(maxX * 10) / 10, minY: Math.round(minY * 10) / 10, maxY: Math.round(maxY * 10) / 10,
            widthUnits: Math.round((maxX - minX) * 10) / 10, heightUnits: Math.round((maxY - minY) * 10) / 10
          } : null,
        });
      } catch (err) { results.push({ sizeName: sp.sizeName, error: err.message }); }
    }
    res.json({ success: true, results });
  } catch (error) { res.status(500).json({ success: false, message: error.message }); }
});

module.exports = router;