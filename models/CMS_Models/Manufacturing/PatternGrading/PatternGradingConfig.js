// models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js

const mongoose = require("mongoose");

// ── Keyframe delta per node
const keyframeDeltaSchema = new mongoose.Schema(
  {
    pi: { type: Number, required: true },
    si: { type: Number, required: true },
    dx: { type: Number, default: 0 },
    dy: { type: Number, default: 0 },
    dc1x: { type: Number, default: 0 },
    dc1y: { type: Number, default: 0 },
    dc2x: { type: Number, default: 0 },
    dc2y: { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Keyframe
const keyframeSchema = new mongoose.Schema(
  {
    clientId: { type: String },
    gid: { type: String, required: true },
    targetFullInches: { type: Number, required: true },
    targetRawInches: { type: Number },
    sizeTag: { type: String, default: null },
    deltas: [keyframeDeltaSchema],
    ts: { type: String },
  },
  { _id: true }
);

// ── Nested Condition (stored inside each measureGroup)
const nestedConditionSchema = new mongoose.Schema(
  {
    id: { type: String },
    enabled: { type: Boolean, default: true },
    label: { type: String, default: "Condition" },
    // WHEN: this group [operator] [compareValue or compareGroup]
    operator: {
      type: String,
      enum: ["greater_than", "less_than", "greater_equal", "less_equal", "equals"],
      default: "greater_than",
    },
    compareGroupId: { type: String, default: null }, // null = fixed value
    compareValue: { type: Number, default: 0 },
    // THEN: apply to [targetGroupId]
    targetGroupId: { type: String, default: null }, // null = self
    action: {
      type: String,
      enum: [
        "match_to_current",
        "match_to_target",
        "add_offset",
        "subtract_offset",
        "multiply_by",
        "set_to_value",
      ],
      default: "match_to_current",
    },
    actionValue: { type: Number, default: 0 },
  },
  { _id: false }
);

// ── Rule profile for rule-based grading
const ruleProfileSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    axis: { type: String, default: "between_refs" },
    gain: { type: Number, default: 1 },
    influenceRadiusInches: { type: Number, default: 6 },
    falloff: { type: String, default: "smooth" },
    handleGain: { type: Number, default: 1 },
    invert: { type: Boolean, default: false },
    limitToReferencePaths: { type: Boolean, default: true },
  },
  { _id: false }
);

// ── Measurement Group
const measureGroupSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true },
    name: { type: String, required: true },
    partKey: { type: String, required: true },
    assignedSize: { type: String },
    multiplier: { type: Number, default: 1 },
    ref1: {
      pathIdx: { type: Number, required: true },
      segIdx: { type: Number, required: true },
    },
    ref2: {
      pathIdx: { type: Number, required: true },
      segIdx: { type: Number, required: true },
    },
    color: { type: String, default: "#2980b9" },
    targetFullInches: { type: Number, default: 0 },
    baseFullInches: { type: Number, default: 0 },
    measurementOffset: { type: Number, default: 0 },
    gradingMode: {
      type: String,
      enum: ["keyframe", "rule"],
      default: "keyframe",
    },
    ruleProfile: ruleProfileSchema,
    // ← Nested conditions stored per group
    nestedConditions: { type: [nestedConditionSchema], default: [] },
  },
  { _id: true }
);

// ── SVG Path Segment
const segmentSchema = new mongoose.Schema(
  {
    t: { type: String, enum: ["M", "L", "C", "Z"], required: true },
    x: { type: Number },
    y: { type: Number },
    c1: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 } },
    c2: { x: { type: Number, default: 0 }, y: { type: Number, default: 0 } },
  },
  { _id: false }
);

// ── SVG Path
const pathSchema = new mongoose.Schema(
  {
    id: { type: String },
    isClosed: { type: Boolean, default: false },
    isConnector: { type: Boolean, default: false },
    connectorFrom: { pi: { type: Number }, si: { type: Number } },
    connectorTo: { pi: { type: Number }, si: { type: Number } },
    segs: [segmentSchema],
  },
  { _id: false }
);

// ── Main Schema
const patternGradingConfigSchema = new mongoose.Schema(
  {
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
      index: true,
    },
    stockItemName: { type: String, trim: true },
    stockItemReference: { type: String, trim: true },

    svgFileUrl: { type: String, trim: true, default: null },
    svgPublicId: { type: String, trim: true, default: null },
    svgFileName: { type: String, trim: true, default: null },
    originalFilename: { type: String, default: null },
    svgFileSizeBytes: { type: Number, default: null },
    svgUploadedAt: { type: Date, default: null },

    basePaths: [pathSchema],
    unitsPerInch: { type: Number, default: 25.4 },

    // Groups now carry nestedConditions inside them
    measureGroups: [measureGroupSchema],
    keyframes: [keyframeSchema],

    basePatternSize: { type: String, default: "M" },
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1 },

    lastConfiguredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CuttingMaster",
      default: null,
    },
    lastConfiguredAt: { type: Date, default: null },

    configSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    measurementPartRules: { type: mongoose.Schema.Types.Mixed, default: null },

    savedViewport: {
      scale: { type: Number, default: null },
      x: { type: Number, default: null },
      y: { type: Number, default: null },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CuttingMaster",
    },
  },
  { timestamps: true }
);

patternGradingConfigSchema.index({ stockItemId: 1, isActive: 1 }, { unique: false });

module.exports = mongoose.model("PatternGradingConfig", patternGradingConfigSchema);