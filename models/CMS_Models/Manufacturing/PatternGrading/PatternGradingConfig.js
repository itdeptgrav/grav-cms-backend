// models/CMS_Models/Manufacturing/PatternGrading/PatternGradingConfig.js

const mongoose = require("mongoose");

// ── Keyframe delta per node ──────────────────────────────────
const keyframeDeltaSchema = new mongoose.Schema(
  {
    pi: { type: Number, required: true }, // path index
    si: { type: Number, required: true }, // segment index
    dx: { type: Number, default: 0 },
    dy: { type: Number, default: 0 },
    dc1x: { type: Number, default: 0 },
    dc1y: { type: Number, default: 0 },
    dc2x: { type: Number, default: 0 },
    dc2y: { type: Number, default: 0 },
  },
  { _id: false },
);

// ── Keyframe ─────────────────────────────────────────────────
const keyframeSchema = new mongoose.Schema(
  {
    clientId: { type: String }, // original JS id from frontend
    gid: { type: String, required: true }, // references measureGroup.clientId
    targetFullInches: { type: Number, required: true },
    targetRawInches: { type: Number },
    sizeTag: { type: String, default: null },
    deltas: [keyframeDeltaSchema],
    ts: { type: String },
  },
  { _id: true },
);

// ── Measurement Group ─────────────────────────────────────────
const measureGroupSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true }, // frontend-generated id
    name: { type: String, required: true },
    partKey: { type: String, required: true }, // chest | shoulder | waist etc.
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
  },
  { _id: true },
);

// ── SVG Path Segment ─────────────────────────────────────────
const segmentSchema = new mongoose.Schema(
  {
    t: { type: String, enum: ["M", "L", "C", "Z"], required: true },
    x: { type: Number },
    y: { type: Number },
    c1: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
    c2: {
      x: { type: Number, default: 0 },
      y: { type: Number, default: 0 },
    },
  },
  { _id: false },
);

// ── SVG Path ─────────────────────────────────────────────────
const pathSchema = new mongoose.Schema(
  {
    id: { type: String },
    isClosed: { type: Boolean, default: false },
    isConnector: { type: Boolean, default: false },
    connectorFrom: {
      pi: { type: Number },
      si: { type: Number },
    },
    connectorTo: {
      pi: { type: Number },
      si: { type: Number },
    },
    segs: [segmentSchema],
  },
  { _id: false },
);

// ── Main Schema ───────────────────────────────────────────────
const patternGradingConfigSchema = new mongoose.Schema(
  {
    // Link to the stock item this pattern belongs to
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
      required: true,
      index: true,
    },
    stockItemName: { type: String, trim: true },
    stockItemReference: { type: String, trim: true },

    // Original SVG file stored in Cloudinary
    svgFileUrl: {
      type: String,
      trim: true,
      default: null,
    },
    svgPublicId: {
      type: String,
      trim: true,
      default: null,
    },
    svgFileName: {
      type: String,
      trim: true,
      default: null,
    },
    originalFilename: { type: String, default: null },
    svgFileSizeBytes: { type: Number, default: null },
    svgUploadedAt: { type: Date, default: null },

    // Parsed SVG paths (the "base" paths — not graded)
    basePaths: [pathSchema],

    // Units per inch derived from SVG viewBox/width
    unitsPerInch: { type: Number, default: 25.4 },

    // Measurement groups configured by master
    measureGroups: [measureGroupSchema],

    // Keyframes for grading interpolation
    keyframes: [keyframeSchema],

    // Which size this pattern represents by default
    basePatternSize: { type: String, default: "M" },

    // Meta
    isActive: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    lastConfiguredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CuttingMaster",
      default: null,
    },
    lastConfiguredAt: { type: Date, default: null },

    // Configuration export snapshot (JSON blob for quick restore)
    configSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CuttingMaster",
    },
  },
  { timestamps: true },
);

// Compound index so each stock item has one active config
patternGradingConfigSchema.index(
  { stockItemId: 1, isActive: 1 },
  { unique: false },
);

module.exports = mongoose.model(
  "PatternGradingConfig",
  patternGradingConfigSchema,
);
