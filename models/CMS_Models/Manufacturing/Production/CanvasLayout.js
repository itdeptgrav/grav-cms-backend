// models/CMS_Models/Manufacturing/Production/CanvasLayout.js
//
// THE FACTORY FLOOR PLAN. One document per organisation.
//
// ─── Read this before changing anything ──────────────────────────────────────
// There is a REAL layout in the production database: 78 machine positions, 25
// separators and 6 named chambers (FUSING_MACHINE, IRON_DEPARTMENT, LINE NO: 01,
// LINE NO: 02, two TABLE MARKs), at version 31. A supervisor placed every one of
// those by hand. Every field added below is therefore OPTIONAL with a default,
// so that document keeps loading exactly as it did — additive only, no
// migration, no rewrite of coordinates.
//
// ─── Units ───────────────────────────────────────────────────────────────────
// x/y were CSS pixels when the original canvas drew machine cards 158px wide.
// The new designer reads them as CENTIMETRES, which required no data change and
// happens to be right: the saved extents are x −1489→1907 and y −1316→3070,
// i.e. a 34m × 44m floor. That is a plausible garment unit. A 120cm sewing
// table now sits in what used to be a 158px slot, so existing spacing still
// reads as a sensible aisle rather than machines on top of each other.
//
// The origin is wherever the supervisor's first drag put it — coordinates are
// signed and centred on nothing in particular. Nothing depends on that; the
// designer fits the view to the content's bounding box.
//
// ─── Orphans are normal ──────────────────────────────────────────────────────
// 26 of those 78 positions point at machines that have since been deleted from
// the `machines` collection. They are NOT pruned here. A position whose machine
// is gone is shown in the designer as a placeable ghost the supervisor can
// delete or re-point; deleting it silently on load would quietly redraw
// somebody's floor for them.

const mongoose = require("mongoose");

const MachinePositionSchema = new mongoose.Schema({
  machineId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Machine",
    required: true,
  },
  // Empty on every saved row — names come from the Machine collection. Kept
  // because old documents carry the field and dropping it is a schema change
  // for no gain.
  machineName: { type: String },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  templateId: { type: String, default: "main" },
  hidden: { type: Boolean, default: false },

  // ── Added 11 Sep 2026 with the CAD designer ──────────────────────────────
  // Which way the operator faces. Two machines back to back down a line is the
  // single most common real arrangement and was impossible to express before.
  rotation: { type: Number, default: 0 }, // degrees, clockwise, 0 = facing "down"
  // Overrides Machine.type when choosing the 2D glyph and 3D model. For a
  // machine whose registered type is wrong or missing — the supervisor can fix
  // the drawing without editing the asset register.
  assetType: { type: String, default: "" },
  // A label written on the plan ("A12", "Sampling"), independent of the
  // machine's registered name.
  label: { type: String, default: "" },
  // The chamber/zone this machine is considered part of, for grouping and
  // per-line totals. Free-form so it can hold a chamberTemplates[].id.
  zoneId: { type: String, default: "" },
});

const SeparatorSchema = new mongoose.Schema({
  id: { type: String, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  templateId: { type: String, default: "main" },

  // ── Added 11 Sep 2026 ────────────────────────────────────────────────────
  // The original separator was a POINT that the canvas drew as a full-height
  // vertical rail — the 25 saved ones are nearly all at x ≈ −1128 with varying
  // y, i.e. the gangway between two sewing lines. These make that explicit
  // without changing what an existing one draws: orientation defaults to
  // vertical and a null length still means "auto, full height".
  orientation: { type: String, enum: ["vertical", "horizontal"], default: "vertical" },
  length: { type: Number, default: null },
});

const ChamberTemplateSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  width: { type: Number, default: 300 },
  height: { type: Number, default: 250 },
  color: { type: String, default: "#EFF6FF" },
  borderColor: { type: String, default: "#3B82F6" },

  // ── Added 11 Sep 2026 ────────────────────────────────────────────────────
  // The six saved chambers are already departments in all but name —
  // FUSING_MACHINE, IRON_DEPARTMENT, LINE NO: 01. `kind` lets the designer
  // colour and total them as such instead of parsing their names.
  kind: { type: String, default: "" }, // sewing | cutting | finishing | embroidery | packing | store | qc | office
  rotation: { type: Number, default: 0 },
});

/** A wall segment. Drawn as a line in 2D, extruded to wallHeight in 3D. */
const WallSchema = new mongoose.Schema({
  id: { type: String, required: true },
  x1: { type: Number, required: true },
  y1: { type: Number, required: true },
  x2: { type: Number, required: true },
  y2: { type: Number, required: true },
  thickness: { type: Number, default: 20 }, // cm
  height: { type: Number, default: 300 }, // cm
});

/**
 * A walkway. What turns a grid of machines into recognisable LINES — without
 * the gangway drawn, rows of sewing tables read as one undifferentiated block.
 */
const AisleSchema = new mongoose.Schema({
  id: { type: String, required: true },
  points: [{ x: Number, y: Number, _id: false }],
  width: { type: Number, default: 120 }, // cm
  label: { type: String, default: "" },
});

/** Everything on a floor that is not a registered machine. */
const FixtureSchema = new mongoose.Schema({
  id: { type: String, required: true },
  kind: { type: String, required: true }, // pillar | door | rack | trolley | bin | fan | exit | input | output
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  rotation: { type: Number, default: 0 },
  w: { type: Number, default: 0 }, // 0 = use the catalogue default
  d: { type: Number, default: 0 },
  label: { type: String, default: "" },
});

const CanvasLayoutSchema = new mongoose.Schema(
  {
    organizationId: {
      type: String,
      default: "default",
    },
    machinePositions: [MachinePositionSchema],
    separators: [SeparatorSchema],
    chamberTemplates: [ChamberTemplateSchema],
    canvasState: {
      zoom: { type: Number, default: 1 },
      panX: { type: Number, default: 0 },
      panY: { type: Number, default: 0 },
    },

    // ── Added 11 Sep 2026 — the room itself ──────────────────────────────────
    // Absent on the existing document, which is correct: it has no walls drawn
    // yet, and the designer treats an empty `walls` array as "open plan" rather
    // than as an error.
    walls: [WallSchema],
    aisles: [AisleSchema],
    fixtures: [FixtureSchema],

    floor: {
      // Snap grid. 50cm is half a sewing table — fine enough to line a row up,
      // coarse enough that dragging does not feel slippery.
      gridCm: { type: Number, default: 50 },
      showGrid: { type: Boolean, default: true },
      showRulers: { type: Boolean, default: true },
      // Default wall height for newly drawn walls, and the height of the
      // perimeter in the 3D view.
      wallHeightCm: { type: Number, default: 300 },
      // Purely cosmetic in 3D.
      floorColor: { type: String, default: "#e7e5e4" },
    },

    lastUpdatedBy: { type: String },
    version: { type: Number, default: 1 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("CanvasLayout", CanvasLayoutSchema);
