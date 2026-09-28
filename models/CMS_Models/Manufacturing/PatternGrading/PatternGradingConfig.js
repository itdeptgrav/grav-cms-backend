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
    /*
     * A reference names geometry two ways: by stable id, and by the array position it used to be identified by.
     *
     * Position alone is not identity. Deleting a connector or a node re-indexes the arrays, and every binding above
     * the hole then addresses different geometry while still resolving perfectly. The ids survive that; the indices
     * are kept so data written before they existed still loads, and as a fallback when a ref has no ids.
     */
    ref1: {
      pathIdx: { type: Number },
      segIdx: { type: Number },
      pathId: { type: String },
      nodeId: { type: String },
      legacyPathIdx: { type: Number },
      legacySegIdx: { type: Number },
    },
    ref2: {
      pathIdx: { type: Number },
      segIdx: { type: Number },
      pathId: { type: String },
      nodeId: { type: String },
      legacyPathIdx: { type: Number },
      legacySegIdx: { type: Number },
    },
    color: { type: String, default: "#2563eb" },
    targetFullInches: { type: Number, default: 0 },
    baseFullInches: { type: Number, default: 0 },
    measurementOffset: { type: Number, default: 0 },
    /*
     * A CORRECTION WRITTEN BY SCRIPT, AND WHAT IT REPLACED.
     *
     * `{ at, by, replaced: { multiplier?, measurementOffset?, partKey? } }`.
     * The groups-save route uses `replaced` to recognise a stale editor tab
     * handing back the pre-correction value, and keeps the correction. Without
     * a schema entry this field would be stripped on the very save it guards.
     */
    tuned: { type: mongoose.Schema.Types.Mixed, default: null },
    /*
     * HOW THIS GROUP GRADES.
     *
     * "parametric" is the default now. It grades from the pattern itself - the
     * group's own ref1->ref2 axis, the fold, and every other group read as a
     * station on the same piece - so nothing has to be recorded size by size,
     * and a size nobody recorded is solved rather than extrapolated.
     *
     * "keyframe" is kept so every already-configured pattern goes on behaving
     * exactly as it did. Nothing in the database changes meaning.
     */
    gradingMode: {
      type: String,
      enum: ["parametric", "keyframe", "rule"],
      default: "parametric",
    },
    // How this group's distance is measured/drawn between its two ref nodes.
    // "auto" keeps the engine's own geometry-based choice; "curve" always
    // follows the path's own arc (necklines, armholes); "straight" always
    // measures point-to-point. No single geometric rule suits both, so the
    // designer states the intent per group.
    measureMode: {
      type: String,
      enum: ["auto", "curve", "straight"],
      default: "auto",
    },
    // WHAT THIS MEASUREMENT IS BOUND TO — the authoritative answer, where
    // measureMode's "auto" was only a hint.
    //
    // Between two points on a closed outline there are three possible answers:
    // the chord and the two arcs. "auto" picked between them from whatever else
    // happened to be drawn — a guide across the same two nodes meant the chord.
    // That makes a measurement's value depend on drawings made after it, which
    // is how a sleeve cap collapsed onto the sleeve width: the two share both
    // endpoints on purpose, and the cap had no way to say it meant the cap.
    //
    // STRAIGHT_SPAN   the chord; needs no guide drawn to exist.
    // BOUNDARY_CURVE  a named run along the piece's own outline, walked in
    //                 `boundaryTraversal` from ref1 to ref2.
    //
    // Left unset on a group that has not been classified yet; both the desktop
    // and the web then derive it from the group's own recorded value on load.
    measurementType: {
      type: String,
      enum: ["STRAIGHT_SPAN", "BOUNDARY_CURVE"],
      default: undefined,
    },
    boundaryTraversal: {
      type: String,
      enum: ["forward", "backward"],
      default: undefined,
    },
    // Which named run along the outline this measurement follows, once runs have stable ids. Until then the pair
    // (ref1, ref2, boundaryTraversal) names it; this field is what makes the reference survive re-ordered geometry.
    boundaryRunId: { type: String, default: undefined },

    // ── PROVENANCE OF THE BINDING ───────────────────────────────────────────
    // A measurement's meaning must be auditable: which migration wrote it, what it measured before, and whether a
    // human still needs to look at it. Without these a binding is just an assertion nobody can check.
    bindingVersion: { type: Number, default: undefined },
    bindingBefore: { type: mongoose.Schema.Types.Mixed, default: undefined },
    needsReview: { type: Boolean, default: undefined },

    // Which catalogue definition this group is an instance of, so the same measurement can be recognised across
    // sizes and products rather than matched by name.
    catalogId: { type: String, default: undefined },

    // ── CANONICAL VALUES ────────────────────────────────────────────────────
    // What the AUTHORING application measured. The website renders these and may recompute independently as a
    // check, but must not silently replace them: a disagreement is a contract mismatch to report, not to paper over.
    rawValue: { type: Number, default: undefined },
    garmentValue: { type: Number, default: undefined },
    contractVersion: { type: Number, default: undefined },
    ruleProfile: ruleProfileSchema,
    nestedConditions: { type: [nestedConditionSchema], default: [] },
    loosingEnabled: { type: Boolean, default: false },
    loosingValueInches: { type: Number, default: 0, min: -20, max: 20 },
    // Which side of the measurement gets the ease/loosing translation.
    // "ref1"  → only the ref1-side anchor moves outward (or inward if value is negative)
    // "ref2"  → only the ref2-side anchor moves
    // "both"  → legacy behavior: loosing is added to the keyframe target so both sides scale
    loosingSide: { type: String, enum: ["ref1", "ref2", "both"], default: "both" },
    // ── Per-side loosing (preferred over the legacy single-value model) ────
    // These let the designer add/remove ease on each side independently and
    // simultaneously: e.g. +0.5" on ref1 and -0.3" on ref2 in the same group.
    // When either is non-zero, the grading core applies a directional
    // translation to that ref's anchor (and bezier handles) in addition to
    // the normal keyframe interpolation. Negative values pull inward.
    loosingValueRef1Inches: { type: Number, default: 0, min: -20, max: 20 },
    loosingValueRef2Inches: { type: Number, default: 0, min: -20, max: 20 },
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
    toPathIdx: { type: Number, default: null },
    fullPath: { type: Boolean, default: false },
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
    /*
     * A SIZE CAN EXIST WITHOUT A DRAWING.
     *
     * Under the per-size architecture every size had its own SVG, so requiring one here cost nothing. V3 grades every
     * size from ONE master, so eight of the nine sizes will never have a drawing — but they all still need their row
     * on the size chart, because that chart is what the master is graded TO. With these required, saving a chart
     * value for a size with no SVG was refused outright, which on screen looked like the field clearing itself.
     *
     * A row with no svgFileUrl is a chart-only size. It is not a broken pattern; it is the normal case now.
     */
    sizeValue: { type: Number },                   // numeric chest/waist inch value
    svgFileUrl: { type: String },
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

    // ── WHICH DRAWING THIS IS ───────────────────────────────────────────────
    // Everything derived from a size — parsed geometry, resolved paths, measurement caches, 3D input — is only
    // valid for the drawing it came from. Without a revision and a checksum there is no way to tell new geometry
    // from old, so a replaced SVG can be combined with the previous size's cached derivatives and nobody notices.
    svgRevision: { type: Number, default: undefined },
    svgChecksum: { type: String, default: undefined },

    // Which version of the pattern contract this size was written under, so a consumer can refuse data it does not
    // understand instead of guessing at it.
    contractVersion: { type: Number, default: undefined },

    // Groups whose binding could not be established with confidence during migration. Named here so they can be
    // listed and resolved deliberately rather than silently assumed correct.
    groupsNeedReview: { type: [String], default: undefined },
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

    /*
     * HOW THE YOKE GRADES — a decision the pattern master makes, not one the engine can derive.
     *
     * There is no yoke in the size chart and nothing in the body implies one, so grading from a single base leaves
     * the depth frozen across the whole range. Until a real rule is recorded here the grade is marked
     * REVIEW REQUIRED rather than production-ready. See packages/pattern-core/yokeProfile.js.
     *
     *   UNCONFIRMED  nobody has been asked yet; the drawn depth is held
     *   PER_SIZE     a depth for each size, interpolated only BETWEEN sizes that were given
     *   STEP_RULE    one increment per size step, from an anchor size
     *   CONSTANT     the pattern master has confirmed one depth is intended for every size
     */
    yokeGradeProfile: {
      mode: { type: String, enum: ["UNCONFIRMED", "PER_SIZE", "STEP_RULE", "CONSTANT"], default: "UNCONFIRMED" },
      anchorSize: { type: String, default: "M" },
      /* inches, by size name */
      depthBySize: { type: Map, of: Number, default: undefined },
      /* inches added per size step, in STEP_RULE */
      depthStep: { type: Number, default: null },
      armholeRule: { type: String, default: null },
      confirmedBy: { type: String, default: null },
      confirmedAt: { type: Date, default: null },
      notes: { type: String, default: "" },
    },

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

    /*
     * THE ONE SIZE THAT IS AUTHORED, AND WHAT KIND OF GARMENT IT IS.
     *
     * `basePatternSize` already existed and already meant this; V3 makes it load-bearing, because it is the size the
     * Designer opens and the size every other size is generated from. The default stays "M" for products that never
     * said, but a product that sets it must have that honoured — a future product may be drawn at S, L or 34.
     */
    basePatternSize: { type: String, default: "M" },
    garmentType: { type: String, default: null },            // SHIRT | TROUSER | … declared, never inferred
    patternEngineVersion: { type: String, default: null },   // LEGACY | V3
    /*
     * WHICH DRAWN PIECE IS WHICH, CONFIRMED ONCE FOR THIS MASTER.
     *
     * Roles are identified by fingerprint rather than by array index, so re-exporting the drawing with its elements
     * in another order cannot silently move "front leg" onto a pocket facing. The index is kept for convenience only.
     */
    pieceRoles: { type: [mongoose.Schema.Types.Mixed], default: [] },
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