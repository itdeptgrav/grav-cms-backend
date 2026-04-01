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
    id: { type: String }, // also accept 'id' for new-style saves
    gid: { type: String }, // group id — required by grading engine
    targetFullInches: { type: Number, required: true },
    targetRawInches: { type: Number },
    sizeTag: { type: String, default: null },
    deltas: [keyframeDeltaSchema],
    ts: { type: mongoose.Schema.Types.Mixed }, // accept Date or String
    _autoMirror: { type: Boolean, default: false },
    _mirrorOfId: { type: String, default: null },
  },
  { _id: true }
);

// ── Nested Condition (stored inside each measureGroup)
const nestedConditionSchema = new mongoose.Schema(
  {
    id: { type: String },
    enabled: { type: Boolean, default: true },
    label: { type: String, default: "Condition" },
    priority: { type: Number, default: 5, min: 1, max: 10 },
    operator: {
      type: String,
      enum: ["greater_than", "less_than", "greater_equal", "less_equal", "equals"],
      default: "greater_than",
    },
    compareGroupId: { type: String, default: null },
    actionOperator: { type: String, enum: ["plus", "minus", "set", "multiply"], default: "plus" },
    actionBaseGroupId: { type: String, default: null },
    compareValue: { type: Number, default: 0 },
    targetGroupId: { type: String, default: null },
    action: {
      type: String,
      enum: [
        "match_to_current",
        "match_to_current_offset",
        "match_to_target",
        "add_offset",
        "subtract_offset",
        "multiply_by",
        "set_to_value",
        "change_by_percent",
        "change_by_ratio_of_trigger",
        "derive_from_source",
        "db_measurement_formula",
        "multi_group_expression",
        "live_canvas_value",
      ],
      default: "match_to_current",
    },
    actionValue: { type: Number, default: 0 },
    matchOffsetOp: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
    deriveSourceGroupId: { type: String, default: null },
    deriveOperator: { type: String, enum: ["plus", "minus", "multiply", "divide", "set"], default: "plus" },
    expressionGroups: [{
      type: { type: String, enum: ["group", "constant"], default: "group" },
      groupId: { type: String },
      operator: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
      constantValue: { type: Number },
    }],
    expressionOffset: { type: Number, default: 0 },
    expressionScalarOp: { type: String, enum: ["none", "plus", "minus", "multiply", "divide"], default: "none" },
    sumGroupAId: { type: String, default: null },
    sumGroupBId: { type: String, default: null },
    sumOperator: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
    sumOffsetValue: { type: Number, default: 0 },
    liveSourceGroupId: { type: String, default: null },
    liveOperator: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
    liveOffsetValue: { type: Number, default: 0 },
    dbExpressionGroups: [{
      type: { type: String, enum: ["group", "constant"], default: "group" },
      groupId: { type: String },
      operator: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
      constantValue: { type: Number },
    }],
    dbExpressionOffset: { type: Number, default: 0 },
    dbExpressionScalarOp: { type: String, enum: ["none", "plus", "minus", "multiply", "divide"], default: "none" },
    dbSourceGroupId: { type: String, default: null },
    dbOperator: { type: String, enum: ["plus", "minus", "multiply", "divide"], default: "plus" },
    dbOffsetValue: { type: Number, default: 0 },
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

// ── Measurement Group (used inside sizePatterns.keyframeGroups)
const measureGroupSchema = new mongoose.Schema(
  {
    clientId: { type: String },
    groupId: { type: String }, // alias — new code uses groupId
    name: { type: String },
    groupName: { type: String }, // alias — new code uses groupName
    partKey: { type: String },
    assignedSize: { type: String, default: null },
    multiplier: { type: Number, default: 1 },
    ref1: {
      pathIdx: { type: Number },
      segIdx: { type: Number },
    },
    ref2: {
      pathIdx: { type: Number },
      segIdx: { type: Number },
    },
    color: { type: String, default: "#2563eb" },
    targetFullInches: { type: Number, default: 0 },
    baseFullInches: { type: Number, default: 0 },
    measurementOffset: { type: Number, default: 0 },
    gradingMode: {
      type: String,
      enum: ["keyframe", "rule"],
      default: "keyframe",
    },
    ruleProfile: ruleProfileSchema,
    nestedConditions: { type: [nestedConditionSchema], default: [] },
    loosingEnabled: { type: Boolean, default: false },
    loosingValueInches: { type: Number, default: 0, min: 0, max: 20 },
    conditionsFollowLoosing: { type: Boolean, default: false },
    // Keyframes stored INSIDE each group (new concept)
    keyframes: { type: [keyframeSchema], default: [] },
  },
  { _id: true }
);

// ─── SEAM EDGE
const seamEdgeSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true },
    name: { type: String, default: "Seam" },
    pathIdx: { type: Number, required: true },
    fromSegIdx: { type: Number, required: true },
    toSegIdx: { type: Number, required: true },
    width: { type: Number, required: true, default: 0.5, min: 0.0625, max: 10 },
    visible: { type: Boolean, default: true },
    outwardSign: { type: Number, default: 1 },
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
    originalSegs: [segmentSchema],
    rotationAngle: { type: Number, default: 0 },
    rotationPivot: { x: { type: Number }, y: { type: Number } },
    mirrorSourceIdx: { type: Number, default: null },
    mirrorFoldAxis: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false }
);

// ── Fold Axis
const foldAxisSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true },
    name: { type: String, default: "Fold Axis" },
    n1: {
      pathIdx: { type: Number, required: true },
      segIdx: { type: Number, required: true },
      x: { type: Number },
      y: { type: Number },
    },
    n2: {
      pathIdx: { type: Number, required: true },
      segIdx: { type: Number, required: true },
      x: { type: Number },
      y: { type: Number },
    },
    seamN1: { pathIdx: { type: Number }, segIdx: { type: Number } },
    seamN2: { pathIdx: { type: Number }, segIdx: { type: Number } },
    seamAllowanceInches: { type: Number, default: 0 },
    foldPathIdx: { type: Number, default: null },
    axisExplicit: { type: Boolean, default: false },
  },
  { _id: true }
);

// ── Size Pattern (NEW concept: one SVG + groups + keyframes per garment size)
const sizePatternSchema = new mongoose.Schema(
  {
    sizeName: { type: String, required: true },   // "S", "M", "L", "XL" …
    sizeValue: { type: Number, required: true },   // numeric chest/waist inch value
    svgFileUrl: { type: String, required: true },
    svgPublicId: { type: String },
    originalFilename: { type: String },
    bytes: { type: Number },
    // Designer-entered base measurements for each body part in this size
    baseMeasurements: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Parsed/saved SVG paths so refresh restores geometry without re-fetching SVG
    basePaths: [{ type: mongoose.Schema.Types.Mixed }],
    unitsPerInch: { type: Number, default: 25.4 },
    // Measurement groups with their keyframes (grouped here per size)
    keyframeGroups: [measureGroupSchema],
    seamEdges: { type: [seamEdgeSchema], default: [] },
    foldAxes: { type: [foldAxisSchema], default: [] },
    groupsSetupCompleted: { type: Boolean, default: false },
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

    // ════ NEW: size-based patterns ════════════════════════════
    sizePatterns: [sizePatternSchema],
    setupCompleted: { type: Boolean, default: false },
    // The measurement key (e.g. "chest") used to pick the right size pattern
    // on the cutting master side.
    designatedGroup: { type: String, default: "chest" },

    // ════ LEGACY fields (kept so old DB documents still work) ═
    svgFileUrl: { type: String, trim: true, default: null },
    svgPublicId: { type: String, trim: true, default: null },
    svgFileName: { type: String, trim: true, default: null },
    originalFilename: { type: String, default: null },
    svgFileSizeBytes: { type: Number, default: null },
    svgUploadedAt: { type: Date, default: null },

    basePaths: [pathSchema],
    unitsPerInch: { type: Number, default: 25.4 },

    measureGroups: [measureGroupSchema],
    keyframes: [keyframeSchema],
    seamEdges: { type: [seamEdgeSchema], default: [] },
    foldAxes: { type: [foldAxisSchema], default: [] },

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
    customMeasurements: { type: mongoose.Schema.Types.Mixed, default: [] },

    savedViewport: {
      scale: { type: Number, default: null },
      x: { type: Number, default: null },
      y: { type: Number, default: null },
    },
    viewportSlots: { type: mongoose.Schema.Types.Mixed, default: {} },
    globalRotation: {
      angle: { type: Number, default: 0 },
      pivotX: { type: Number, default: 0 },
      pivotY: { type: Number, default: 0 },
    },

    patternTitle: { type: String, trim: true, default: "" },
    patternDescription: { type: String, trim: true, default: "" },
    patternNotes: { type: String, trim: true, default: "" },
    patternTags: { type: [String], default: [] },
    patternRevision: { type: String, trim: true, default: "1.0" },
    patternDesigner: { type: String, trim: true, default: "" },

    keyboardShortcuts: { type: mongoose.Schema.Types.Mixed, default: {} },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CuttingMaster",
    },
  },
  { timestamps: true }
);

patternGradingConfigSchema.index({ stockItemId: 1, isActive: 1 });
patternGradingConfigSchema.index({ "sizePatterns.sizeName": 1 });

module.exports = mongoose.model("PatternGradingConfig", patternGradingConfigSchema);