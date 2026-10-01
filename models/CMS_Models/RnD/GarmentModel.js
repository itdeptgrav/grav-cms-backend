// models/CMS_Models/RnD/GarmentModel.js
//
// R&D'S PUBLISHED GARMENT MODEL, AND THE MARKERS PINNED TO IT.
//
// ── WHY THIS IS NOT A FILE ON THE TECHNICAL RECORD ──────────────────────────
// The technical record already carries a supporting document, and a GLB could
// have gone in beside it. It is a different kind of thing. A document is
// evidence a person reads; this is a SURFACE other records point AT — a seam
// marker names a pattern piece on it, a measurement names a point on it, and
// later an IE operation names the construction point an R&D marker already
// established. Things that are pointed at need identity, versions and an
// immutable history of their own, and a file field has none of those.
//
// ── THE THREE FACTS A PUBLICATION KEEPS APART ───────────────────────────────
//   1. THE SOURCE — the CLO `.zprj`/`.zpac` the garment was built in. Kept
//      byte-for-byte as evidence and never rendered. It is the only artifact
//      that can reproduce the garment, and nothing downstream may alter it.
//   2. THE WEB MODEL — the `.glb` a browser can draw. Derived, replaceable in
//      principle, and the only thing the viewer ever loads.
//   3. THE MANIFEST — what the export WAS: CLO version, export date, unit and
//      scale, axis convention, file hashes, and the pattern-piece names that
//      were published. Without it a model is a shape with no units, and a
//      measurement marker on a shape with no units measures nothing.
//
// ── AND WHY MARKERS LIVE IN THEIR OWN COLLECTION ────────────────────────────
// A publication is immutable once approved; markers are not — they are
// replied to, resolved and carried into an approved pack. Embedding a growing
// discussion inside a document whose whole purpose is to stop changing is how
// an immutable record quietly becomes mutable. They are also queried on their
// own ("every open clarification across this style"), which a subdocument
// cannot answer without loading every publication it might be in.
"use strict";

const mongoose = require("mongoose");

/* ═══ VOCABULARY ═══════════════════════════════════════════════════════════ */

/**
 * Where a publication stands.
 *
 * `SUPERSEDED` is set when a later publication is approved, and is the reason
 * "current approved model" is a question with one answer rather than a guess
 * about which row sorts last.
 */
const PUBLICATION_STATE = Object.freeze({
  DRAFT: "DRAFT",
  IN_REVIEW: "IN_REVIEW",
  APPROVED: "APPROVED",
  RETURNED: "RETURNED",
  SUPERSEDED: "SUPERSEDED",
});

/**
 * What a marker is ABOUT. Each one routes to a different desk.
 *
 * ── WHY THESE TEN AND NOT FIVE ──────────────────────────────────────────────
 * The list is the vocabulary a sampling room already uses, not a tidy
 * taxonomy. "Stitch/seam" is separate from "construction" because one is a
 * specification an operator follows and the other is how the garment goes
 * together; "material" is separate from "trim" because they are bought from
 * different people on different lead times. Collapsing either pair saves a
 * line in an enum and costs the person reading the list the distinction they
 * opened it for.
 *
 * `GENERAL` exists so nobody is forced to misfile something to save it.
 */
const MARKER_CATEGORY = Object.freeze({
  CONSTRUCTION: "construction",
  MEASUREMENT: "measurement",
  STITCH_SEAM: "stitch_seam",
  MATERIAL: "material",
  PRINT_EMBROIDERY: "print_embroidery",
  TRIM: "trim",
  FIT: "fit",
  QUALITY: "quality",
  /* Raised by R&D, read by IE later. IE writes its own mapping records
     elsewhere and never edits this one — see the route's header. */
  IE_CONSIDERATION: "ie_consideration",
  GENERAL: "general",
});

const MARKER_STATUS = Object.freeze({
  OPEN: "open",
  RESOLVED: "resolved",
  /* Carried into the approved technical pack. Terminal, and only reachable
     while the publication it belongs to is approved. */
  IN_APPROVED_PACK: "in_approved_pack",
});

/** Which asset a stored file is. One of each, at most. */
const ASSET_KIND = Object.freeze({
  WEB_MODEL: "web_model",   /* .glb / .gltf — the only thing the browser loads */
  SOURCE: "source",         /* .zprj / .zpac — immutable evidence */
  PREVIEW: "preview",       /* a still, shown before the canvas is ready */
  /* ── THE FLAT PATTERN, WHICH IS THE OTHER HALF OF THE GARMENT ─────────
     Stored as the uploaded bytes, exactly as the source and the model are,
     and parsed into `patternSet` below. BOTH are kept on purpose: the parse
     is what every screen and the IE projection read, and the file is what
     anybody can re-read if the parse is ever questioned. A derived geometry
     that replaced its source would make a parser improvement indistinguishable
     from a pattern change. */
  PATTERN: "pattern",       /* .dxf — AAMA/ASTM pattern export */
});

/**
 * What a classified bundle file turned out to BE.
 *
 * Distinct from `ASSET_KIND`, which is the slot a file occupies. Two files can
 * fill the pattern slot and be different things — an apparel pattern set and a
 * generic CAD drawing — and collapsing that distinction is how a collection of
 * lines gets read as cut pieces.
 */
const PATTERN_CLASSIFICATION = Object.freeze({
  APPAREL: "apparel_pattern_set",
  GENERIC: "generic_dxf",
});

const actorRef = () => ({
  id: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
});

/* ═══ THE PUBLICATION ══════════════════════════════════════════════════════ */

const assetSchema = new mongoose.Schema({
  kind: { type: String, enum: Object.values(ASSET_KIND), required: true },
  /* The private Drive object. Never sent to a browser — a reader is handed a
     short-lived URL back into this service instead, which re-reads the session
     and the row before a byte moves. */
  driveFileId: { type: String, trim: true, required: true },
  name: { type: String, trim: true, default: "" },
  mimeType: { type: String, trim: true, default: "" },
  bytes: { type: Number, default: 0 },
  /* Content hash, so "is this the file that was approved" is answerable
     without trusting a filename somebody could reuse. */
  sha256: { type: String, trim: true, default: "" },
  /* ── WHEN THIS PARTICULAR FILE ARRIVED ────────────────────────────────
     Per asset rather than per publication, because the bundle's three files
     can be uploaded and replaced at different moments while it is a draft —
     and "one file was updated without the others" is a mismatch the bundle has
     to be able to detect. A single `createdAt` on the row cannot answer it. */
  uploadedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * One published node, exactly as the file named it.
 *
 * `generatedName` is the honest half: an exporter that wrote `Object_12` has
 * published no pattern-piece identity, and the screen says so rather than
 * showing a counted-out name as though somebody had chosen it.
 */
const nodeSchema = new mongoose.Schema({
  nodeRef: { type: String, trim: true, required: true },
  parentRef: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  kind: { type: String, enum: ["mesh", "group"], default: "mesh" },
  meshName: { type: String, trim: true, default: "" },
  materialNames: [{ type: String, trim: true }],
  triangles: { type: Number, default: 0 },
  generatedName: { type: Boolean, default: false },
  depth: { type: Number, default: 0 },
}, { _id: false });

/* The three numbers every anchored point is made of. Declared here because
   the publication's own calibration stores picked points too. */
const vec3 = () => ({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  z: { type: Number, required: true },
});

/** One picked point: anchored exactly as a marker is, for exactly the same
 *  reason — a screen position is a fact about a camera. */
const measurementPointSchema = new mongoose.Schema({
  nodeRef: { type: String, trim: true, required: true },
  nodeName: { type: String, trim: true, default: "" },
  meshName: { type: String, trim: true, default: "" },
  triangleIndex: { type: Number, default: null },
  /* The point in the node's own frame — what makes it redrawable after a
     reload, exactly as a marker's anchor is. */
  local: vec3(),
  /* And the same point in the scene's frame. Kept because it is what the
     LENGTH is computed from, and because keeping it means the server does
     that arithmetic rather than trusting a number the browser sent: a client
     can only change the result by changing the points, and the points ARE the
     measurement. Stable across reloads — the node transforms come from the
     published file and the file cannot change. */
  world: vec3(),
}, { _id: false });

/** The view the author was looking from, restored when the marker is opened. */
const cameraSchema = new mongoose.Schema({
  position: vec3(),
  target: vec3(),
}, { _id: false });

/** Everything that happened to a marker or a measurement, in the order it
 *  happened. Shared, because "who changed this and when" is the same question
 *  whichever of the two is being read. */
const eventSchema = new mongoose.Schema({
  kind: { type: String, trim: true, required: true },
  note: { type: String, trim: true, default: "", maxlength: 2000 },
  by: actorRef(),
  at: { type: Date, default: Date.now },
}, { _id: false });

/* ═══ MEASUREMENTS ═════════════════════════════════════════════════════════
 *
 * A NUMBER OFF A MESH IS NOT A MEASUREMENT UNTIL SOMEBODY CAN SAY WHAT IT IS
 * A MEASUREMENT OF.
 *
 * Three.js will return a distance between any two points to fifteen decimal
 * places, and every one of those digits is a fact about the file rather than
 * about the garment. Whether it is also a fact about the garment depends on
 * something the geometry cannot tell you: what one model unit is worth in the
 * real world. An export that declares centimetres may have been modelled at
 * the wrong scale; an export that declares nothing may still be perfectly
 * scaled. So this record keeps the two apart, permanently:
 *
 *   · `rawValue` — computed from the mesh, in MODEL UNITS. Always stored,
 *     always meaningful, never a millimetre.
 *   · `scale` — what, at the moment this measurement was taken, was known
 *     about converting that into a real length, and HOW it was known.
 *
 * `scale` is frozen onto the measurement rather than read back from the
 * publication, because calibrating a model later must not retroactively
 * relabel a number somebody already recorded as "verified". The old number
 * keeps the honesty it was taken with; a new one gets the new basis.
 *
 * An ANGLE is the exception worth naming: a ratio of lengths has no units, so
 * an angle is exactly as trustworthy on an unscaled export as on a calibrated
 * one, and it is not labelled with a scale warning.
 */

/**
 * THREE WAYS OF MEASURING A GARMENT, AND THEY ARE NOT INTERCHANGEABLE.
 *
 * The distinction that matters is whether the measurement goes THROUGH the
 * cloth or ALONG it. A neckline measured as a straight line is a chord: it
 * cuts across the neck hole, and it always reads SHORT, which is the dangerous
 * direction because a pattern cut to it does not fit. A neckline measured
 * along the surface is what a tape laid on the garment reads.
 *
 * So they are separate kinds, separately named on screen, and nothing converts
 * one into the other.
 */
const MEASUREMENT_KIND = Object.freeze({
  /* Two points, the straight line between them. Width, depth, a reference
     check across a gap — useful, and never called a surface measurement. */
  DISTANCE: "distance",
  /* Two points, the shortest route between them ACROSS the cloth. The route
     itself is stored, because it is the measurement. */
  SURFACE: "surface",
  /* Several points the person placed along a seam, armhole, neckline or hem,
     each leg of the route following the surface. */
  PATH: "path",
  /* Three points, the angle at the middle one. */
  ANGLE: "angle",
});

/** Which kinds carry a route over the cloth rather than a line through it. */
const SURFACE_KINDS = Object.freeze([MEASUREMENT_KIND.SURFACE, MEASUREMENT_KIND.PATH]);

/**
 * What a measurement is FOR. R&D's own vocabulary, not a data shape.
 *
 * It decides which rail filter the measurement appears under, and — for
 * "point of measure" — that it is a candidate for the technical pack rather
 * than a working note.
 */
const MEASUREMENT_CATEGORY = Object.freeze({
  POINT_OF_MEASURE: "point_of_measure",
  SEAM_PATH: "seam_path",
  CONSTRUCTION: "construction",
  PRINT_PLACEMENT: "print_placement",
  TRIM_PLACEMENT: "trim_placement",
  FIT_CHECK: "fit_check",
  GENERAL: "general",
});

/**
 * WHERE A MEASUREMENT HAS GOT TO.
 *
 * `draft` is R&D's own working figure and stays inside R&D — it is explicitly
 * NOT handed to Industrial Engineering, because a number somebody is still
 * taking is not a fact anybody downstream should be planning against.
 * `reviewed` and `accepted` are facts a second person has looked at, and are
 * what the handover carries. `withdrawn` is kept as evidence and never
 * presented as current.
 */
const MEASUREMENT_STATUS = Object.freeze({
  DRAFT: "draft",
  REVIEWED: "reviewed",
  ACCEPTED: "accepted",
  WITHDRAWN: "withdrawn",
});

/** The states IE is allowed to see. Declared once, beside the states. */
const MEASUREMENT_HANDOVER_STATES = Object.freeze([
  MEASUREMENT_STATUS.REVIEWED, MEASUREMENT_STATUS.ACCEPTED,
]);

/**
 * HOW MUCH THE NUMBER CAN BE TRUSTED, IN THE THREE STATES A PERSON CAN ACT ON.
 *
 * `VERIFIED`   somebody measured a known distance on THIS publication and
 *              entered what it really is. The factor is theirs and is
 *              attributable.
 * `DECLARED`   the export stated a unit and nobody has checked it. Usable,
 *              and labelled as the exporter's claim rather than a measurement.
 * `UNVERIFIED` nothing is known. The raw model-space value is shown and is
 *              never dressed up as millimetres.
 */
const SCALE_STATE = Object.freeze({
  VERIFIED: "verified",
  DECLARED: "declared",
  UNVERIFIED: "unverified",
});


/**
 * The conversion in force when this measurement was taken, and its provenance.
 *
 * `factor` multiplies `rawValue` to produce `displayValue` in `unit`. It is 1
 * with unit "model units" when nothing is known, which is not a fallback
 * pretending to be centimetres — it is the honest statement that the number is
 * in whatever the file was drawn in.
 */
const scaleBasisSchema = new mongoose.Schema({
  state: { type: String, enum: Object.values(SCALE_STATE), required: true },
  /* "calibration" | "export-manifest" | "none" — said in the UI as a sentence,
     never as this key. */
  source: { type: String, trim: true, required: true },
  factor: { type: Number, required: true, min: 0 },
  unit: { type: String, trim: true, required: true },
  /* Only on a calibrated basis, and only ever the calibration belonging to
     this measurement's own publication. */
  calibrationRef: { type: String, trim: true, default: "" },
  calibratedBy: { type: String, trim: true, default: "" },
  calibratedAt: { type: Date, default: null },
}, { _id: false });

/* ── WHY A MEASUREMENT IS EMBEDDED AND A MARKER IS NOT ────────────────────
 *
 * Three things are true of a measurement and only two of a marker, and the
 * third is what decides it: a measurement belongs to exactly one publication,
 * can never move to another (the surface it was taken on may not exist in the
 * next export), and is ALWAYS read together with that publication — the
 * workspace cannot show a number without the model it was taken on and the
 * scale basis that is stored beside it. There is no query anywhere that wants
 * measurements without their publication.
 *
 * The deciding constraint was blunter. This deployment is at its database's
 * collection ceiling, so a new collection is not available — the same reason
 * `DepartmentRole` carries company grants on the row rather than in a second
 * collection. Embedding is what that constraint allows AND what the access
 * pattern wanted, which is the only combination worth taking.
 *
 * What is given up, and why it does not matter here: a measurement cannot be
 * queried across publications without naming one. Nothing asks that. What is
 * KEPT, because losing it would matter: each measurement has its own `_id`,
 * its own `revision` for stale-save refusal, its own status, author and event
 * list — a subdocument, not a flattened field.
 */
const measurementSchema = new mongoose.Schema({
  measurementRef: { type: String, trim: true, required: true },
  seq: { type: Number, required: true, min: 1 },

  kind: { type: String, enum: Object.values(MEASUREMENT_KIND), required: true, immutable: true },
  /* Two for a distance, three for an angle, two or more for a path. Immutable
     as a set: changing a point changes what was measured, and that is a new
     measurement, not an edit of this one. */
  /* The points the person PLACED. Not immutable any more: while a
     measurement is a draft its author may drag one onto the seam they meant,
     which is an ordinary correction. The moment it is reviewed or accepted
     they are frozen — see `assertDraft` in the service. */
  points: { type: [measurementPointSchema], required: true },

  /* ── THE ROUTE OVER THE CLOTH, WHICH IS THE MEASUREMENT ────────────────
     For a surface or guided measurement the placed points say where somebody
     clicked and THIS says what was measured. Stored rather than recomputed,
     for two reasons: a reader next month must see the same line without
     re-deriving it, and a re-export may tessellate differently, which would
     silently change a number somebody already accepted. Empty on a straight
     distance and on an angle, where the points are the line. */
  surfacePath: { type: [measurementPointSchema], default: [] },

  /* In model units for a distance, a surface route or a path; in DEGREES for
     an angle, which needs no scale and carries none. */
  rawValue: { type: Number, required: true },
  scale: { type: scaleBasisSchema, required: true, immutable: true },

  /* ── A NAME SOMEBODY CHOSE ─────────────────────────────────────────────
     Required, and the save panel refuses the suggested default unchanged.
     "Measurement 4" tells the next reader nothing, and a rail of them is
     unreadable; "Front neckline curve" is the whole point of recording it. */
  name: { type: String, trim: true, required: true, maxlength: 200 },
  category: {
    type: String, enum: Object.values(MEASUREMENT_CATEGORY),
    default: MEASUREMENT_CATEGORY.GENERAL,
  },
  note: { type: String, trim: true, default: "", maxlength: 4000 },

  /* What this is a measurement OF, in the technical record. A reference, never
     a copy — the technical pack stays the one place it lives. */
  linkedTechnicalItem: {
    kind: { type: String, trim: true, default: "" },
    ref: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "" },
  },
  /* Which size the garment was built at, where R&D said. A point of measure
     means nothing without it. */
  intendedSize: { type: String, trim: true, default: "", maxlength: 40 },
  /* Only when R&D explicitly records one. Absent is an absent tolerance, not
     a zero one. */
  toleranceMm: { type: Number, default: null, min: 0 },

  status: {
    type: String, enum: Object.values(MEASUREMENT_STATUS),
    default: MEASUREMENT_STATUS.DRAFT, index: true,
  },
  /* Who looked at it and when — "reviewed" with nobody's name on it is an
     unattributed decision. */
  reviewedBy: actorRef(),
  reviewedAt: { type: Date, default: null },

  /* Where it came from, when it was duplicated rather than taken. */
  duplicatedFromRef: { type: String, trim: true, default: "" },

  camera: { type: cameraSchema, default: null },
  author: actorRef(),
  events: { type: [eventSchema], default: [] },

  revision: { type: Number, default: 0 },
}, { timestamps: true });

/* ═══ THE FLAT PATTERN SET ═════════════════════════════════════════════════
 *
 * THE PIECES, AS THE DXF PUBLISHED THEM — AND NOT ONE FIELD MORE.
 *
 * ── WHY THIS IS EMBEDDED, LIKE THE MEASUREMENTS ─────────────────────────────
 * The same two reasons, and they both still hold. A pattern set belongs to
 * exactly one publication and can never move to another — a later export may
 * be graded differently, named differently or cut differently, and a pattern
 * that followed a model forward would be a set of pieces nobody drafted. And
 * it is always read WITH its publication: there is no screen and no projection
 * anywhere that wants pieces without the bundle revision, the unit and the
 * model they were published beside.
 *
 * The deciding constraint is the blunter one, unchanged since the measurements
 * were embedded for it: this deployment is at its database's collection
 * ceiling, so a new collection is not available.
 *
 * ── AND WHY EVERY ABSENT FIELD IS NULL RATHER THAN A DEFAULT ────────────────
 * This is the schema's single most important property. A piece whose DXF
 * published no quantity has `quantity: null`, not `1`. No grainline is `null`,
 * not vertical. No seam allowance is `null`, not `0`. Each of those defaults
 * would be a statement somebody could cut cloth against, attributed to a
 * patternmaker who never made it, and indistinguishable afterwards from one
 * who did. `null` is the honest answer and the screens render it as
 * "not published".
 */

/** A point on a piece. Stored in DRAWING units — see `unit` on the set. */
const point2dSchema = new mongoose.Schema({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
}, { _id: false });

/**
 * A notch, reduced to the fact every consumer asks for plus what was drawn.
 *
 * Three vendors draw a notch three ways — a point, a slit, a V — and all three
 * mean "align here". `at` is that position; `form` and `points` keep what the
 * file actually contained, so nothing is lost by the normalisation.
 */
const notchSchema = new mongoose.Schema({
  at: { type: point2dSchema, required: true },
  form: { type: String, enum: ["point", "slit", "v"], default: "point" },
  points: { type: [point2dSchema], default: [] },
  depth: { type: Number, default: null },
}, { _id: false });

/**
 * The grain, as an axis and the angle a cutting room acts on.
 *
 * `offVerticalDegrees` is the number that matters: 0 is with the warp, 90 is
 * across it, 45 is a true bias. `direction` names those three and says
 * "angled" for everything else rather than rounding it to the nearest one.
 */
const grainlineSchema = new mongoose.Schema({
  from: { type: point2dSchema, required: true },
  to: { type: point2dSchema, required: true },
  length: { type: Number, default: null },
  angleDegrees: { type: Number, default: null },
  offVerticalDegrees: { type: Number, default: null },
  direction: {
    type: String,
    enum: ["lengthwise", "crosswise", "bias", "angled", ""],
    default: "",
  },
}, { _id: false });

/**
 * The seam allowance, and HOW it is known.
 *
 * Only ever present when the file published two outlines — a cut line and a
 * sewing line — or stated a figure outright. `source` says which, because
 * "measured between the cut and sew lines" and "the exporter typed it" are
 * different grades of evidence and a cutting room may want to know which.
 */
const seamAllowanceSchema = new mongoose.Schema({
  value: { type: Number, required: true },
  uniform: { type: Boolean, default: true },
  minimum: { type: Number, default: null },
  maximum: { type: Number, default: null },
  source: { type: String, trim: true, default: "" },
}, { _id: false });

const patternPieceSchema = new mongoose.Schema({
  /* ── IDENTITY ───────────────────────────────────────────────────────────
     `pieceRef` is minted here and is what a mapping, a measurement and the IE
     projection all quote. It exists because none of the file's own identifiers
     is reliably present: `publishedId` is empty in every CLO export read so
     far, and an array index changes the moment a piece is added. */
  pieceRef: { type: String, trim: true, required: true },
  /* The file's OWN stable id, where it published one. The first and only
     non-guessing rung of the 2D→3D mapping ladder. */
  publishedId: { type: String, trim: true, default: "" },
  blockName: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  /* ── WHETHER A HUMAN CHOSE THAT NAME ──────────────────────────────────
     `Pattern_636968` is an identifier CLO counted out. The distinction is not
     cosmetic: it decides whether this piece can be matched to a 3D component
     by name at all, and whether "no 3D match" is the model's fault or the
     pattern's. */
  generatedName: { type: Boolean, default: false },
  index: { type: Number, required: true },

  /* ── WHAT IT IS, WHERE THE FILE SAID ─────────────────────────────────── */
  size: { type: String, trim: true, default: "" },
  quantity: { type: Number, default: null },
  material: { type: String, trim: true, default: "" },
  componentClass: {
    type: String,
    enum: ["shell", "lining", "interlining", "rib", "trim", "pocketing", ""],
    default: "",
  },
  description: { type: String, trim: true, default: "", maxlength: 500 },
  annotations: [{ type: String, trim: true, maxlength: 240 }],

  /* ── GEOMETRY, IN DRAWING UNITS ─────────────────────────────────────── */
  outline: { type: [point2dSchema], default: [] },
  outlineClosed: { type: Boolean, default: false },
  extraBoundaries: { type: [[point2dSchema]], default: [] },
  sewLine: { type: [point2dSchema], default: undefined },
  internalLines: {
    type: [new mongoose.Schema({
      points: { type: [point2dSchema], default: [] },
      closed: { type: Boolean, default: false },
      length: { type: Number, default: null },
    }, { _id: false })],
    default: [],
  },
  cutouts: { type: [[point2dSchema]], default: [] },
  grainline: { type: grainlineSchema, default: null },
  notches: { type: [notchSchema], default: [] },
  drillPoints: {
    type: [new mongoose.Schema({
      x: { type: Number, required: true },
      y: { type: Number, required: true },
      radius: { type: Number, default: null },
    }, { _id: false })],
    default: [],
  },
  turnPoints: { type: [point2dSchema], default: [] },
  curvePoints: { type: [point2dSchema], default: [] },
  gradePoints: { type: [point2dSchema], default: [] },
  mirrorLine: { type: [point2dSchema], default: undefined },
  stripeReference: { type: [[point2dSchema]], default: [] },
  plaidReference: { type: [[point2dSchema]], default: [] },

  /* ── CONSTRUCTION FACTS, EACH NULL UNTIL PUBLISHED ──────────────────── */
  seamAllowance: { type: seamAllowanceSchema, default: null },
  /* Tri-state deliberately. `false` means the file said "not on the fold";
     `null` means it said nothing, and a cutter needs to tell those apart. */
  cutOnFold: { type: Boolean, default: null },
  mirrored: { type: Boolean, default: null },
  rotation: { type: Number, default: null },
  /* The drawing inserted this block more than once, which is the file's own
     statement that the piece is cut more than once. Better evidence than a
     QUANTITY text, and kept separately from it rather than merged. */
  insertCount: { type: Number, default: null },

  /* ── MEASURED FROM THE GEOMETRY, IN DRAWING UNITS ───────────────────── */
  width: { type: Number, default: null },
  height: { type: Number, default: null },
  area: { type: Number, default: null },
  perimeter: { type: Number, default: null },
  bounds: {
    type: new mongoose.Schema({
      minX: Number, minY: Number, maxX: Number, maxY: Number,
    }, { _id: false }),
    default: null,
  },
  /* Where the drawing laid this piece out, so a 2D view can show the pattern
     as the file arranged it rather than stacking every piece at the origin. */
  insert: {
    type: new mongoose.Schema({
      x: Number, y: Number, rotation: Number, scaleX: Number, scaleY: Number,
    }, { _id: false }),
    default: null,
  },

  layersUsed: [{ type: String, trim: true }],
  /* Set when the outline came from something this parser could only
     approximate — a spline read as its control hull. A length derived from an
     approximated outline is never presented as verified. */
  approximated: { type: String, trim: true, default: "" },
  /* Dropped geometry, when the set was too large to store whole. Named so a
     reader knows the screen is showing less than the file holds, and the DXF
     itself remains the source. */
  geometryOmitted: { type: Boolean, default: false },
}, { _id: false });

/**
 * HOW A FLAT PIECE WAS MATCHED TO A 3D COMPONENT, AND HOW SURE ANYBODY IS.
 *
 * ── WHY A MAPPING IS A RECORD AND NOT A LOOKUP ──────────────────────────────
 * The tempting implementation is a function: given a piece name and a node
 * list, return the best match. It would be wrong, because the answer is a
 * CLAIM — "this flat piece is that sleeve" — and a claim needs an author, a
 * basis and a date, or nobody downstream can tell a stable identifier published
 * by CLO apart from a guess somebody's name-similarity scorer made at 60%.
 *
 * So each mapping stores the METHOD that produced it and whether a person has
 * confirmed it. `state` and `method` are independent on purpose: a high-
 * confidence exact-ID match is still unconfirmed until somebody says so, and a
 * low-confidence shape match CAN be confirmed by a person who knows the
 * garment. Neither implies the other.
 */
const MAPPING_METHOD = Object.freeze({
  /* The DXF and the GLB published the same stable identifier. The only rung
     that is not an inference. */
  PUBLISHED_ID: "published_id",
  EXACT_NAME: "exact_name",
  SIZE_AND_MATERIAL: "size_and_material",
  NORMALISED_NAME: "normalised_name",
  /* A SUGGESTION, and labelled as one everywhere it appears. Area similarity
     cannot distinguish a left sleeve from a right one. */
  SHAPE_SIMILARITY: "shape_similarity",
  /* A person said so. Carries the highest standing of any method here, because
     it is the only one with a name attached. */
  MANUAL: "manual",
});

const MAPPING_STATE = Object.freeze({
  /* Proposed by the matcher, acted on by nobody. NOT usable downstream. */
  UNCONFIRMED: "unconfirmed",
  CONFIRMED: "confirmed",
  /* Somebody looked and said no. Kept, so the matcher does not re-propose it
     and so "has anybody checked this piece" has an answer. */
  REJECTED: "rejected",
});

const pieceMappingSchema = new mongoose.Schema({
  /* The flat piece, by the ref minted on the set. */
  pieceRef: { type: String, trim: true, required: true },
  pieceName: { type: String, trim: true, default: "" },
  /* The 3D node, by the same `n<index>` identity a marker's anchor uses — so a
     mapping and a marker name the same component the same way. */
  nodeRef: { type: String, trim: true, required: true },
  nodeName: { type: String, trim: true, default: "" },

  method: { type: String, enum: Object.values(MAPPING_METHOD), required: true },
  /* 0–1. Stored as the matcher computed it and never rounded up for display:
     a 0.62 shown as "high" is how a guess becomes a fact. */
  confidence: { type: Number, required: true, min: 0, max: 1 },
  /* Why this match, in a sentence, so a person confirming it can see the
     reasoning rather than a score. */
  basis: { type: String, trim: true, default: "", maxlength: 400 },

  state: { type: String, enum: Object.values(MAPPING_STATE), default: MAPPING_STATE.UNCONFIRMED },
  confirmedBy: actorRef(),
  confirmedAt: { type: Date, default: null },
  /* ── ONE PIECE TO A REPEATED LEFT/RIGHT COMPONENT ────────────────────
     Allowed, and only ever when a person explicitly confirmed it: a single
     drafted sleeve really is both sleeves on the model. Never inferred, because
     a matcher that paired one piece with two nodes on its own would also pair a
     front with a back. */
  repeatedComponent: { type: Boolean, default: false },
  note: { type: String, trim: true, default: "", maxlength: 1000 },

  /* Which mapping revision this belongs to. Bumped whenever the set is
     re-matched, so "was this confirmed against the current pieces" is
     answerable rather than assumed. */
  mappingRevision: { type: Number, default: 1 },
}, { _id: false, timestamps: true });

/**
 * THE PARSED PATTERN SET.
 *
 * One per publication, replaceable while the bundle is a draft and frozen when
 * it is approved — exactly as the model is.
 */
const patternSetSchema = new mongoose.Schema({
  patternSetRef: { type: String, trim: true, required: true },
  /* ── APPAREL PATTERN OR CAD DRAWING ──────────────────────────────────
     The whole reason this field exists is that the second must never be read
     as the first. A generic DXF is stored, shown and measurable, and is not a
     pattern set: it has no piece names, no sizes, no quantities, no grain. */
  classification: {
    type: String, enum: Object.values(PATTERN_CLASSIFICATION), required: true,
  },

  /* What the file said about itself. */
  manifest: {
    dxfVersion: { type: String, trim: true, default: "" },
    styleName: { type: String, trim: true, default: "" },
    author: { type: String, trim: true, default: "" },
    product: { type: String, trim: true, default: "" },
    formatVersion: { type: String, trim: true, default: "" },
    sampleSize: { type: String, trim: true, default: "" },
    createdOn: { type: String, trim: true, default: "" },
    createdAt: { type: String, trim: true, default: "" },
    /* Every `KEY: value` the file published, including ones this parser does
       not model — visible to a person rather than discarded. */
    declared: { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  /* ── THE UNIT, AND WHERE IT CAME FROM ───────────────────────────────────
     Empty is a real state and the commonest failure to guard against: a
     pattern read as millimetres when it was drawn in inches is out by 25.4,
     which nothing about the shape on screen reveals. `unitSource` travels with
     it so a reader can see whether the unit is the pattern's own statement or
     an AutoCAD header variable. */
  unit: { type: String, trim: true, enum: ["mm", "cm", "m", "in", "ft", ""], default: "" },
  unitSource: { type: String, trim: true, default: "none" },
  unitDeclared: { type: String, trim: true, default: "" },
  unitInMm: { type: Number, default: null },

  pieces: { type: [patternPieceSchema], default: [] },

  /* ── GRADING ──────────────────────────────────────────────────────────
     `graded: false` is a statement about the FILE, not about the pattern.
     A single-size sample export is not a production range, and presenting one
     size as a grading with one step is how a sample DXF gets planned against. */
  grading: {
    graded: { type: Boolean, default: false },
    sizes: [{ type: String, trim: true }],
    sizeCount: { type: Number, default: 0 },
    gradePointsPublished: { type: Boolean, default: false },
    pieces: { type: mongoose.Schema.Types.Mixed, default: [] },
  },

  stats: {
    pieces: { type: Number, default: 0 },
    namedPieces: { type: Number, default: 0 },
    piecesWithOutline: { type: Number, default: 0 },
    sizes: { type: Number, default: 0 },
    notches: { type: Number, default: 0 },
    drillPoints: { type: Number, default: 0 },
    internalLines: { type: Number, default: 0 },
    gradePoints: { type: Number, default: 0 },
    grainlines: { type: Number, default: 0 },
    vertices: { type: Number, default: 0 },
    /* In drawing units squared. Named `totalOutlineArea` and never
       `consumption`: the net area of the pieces is not how much cloth a
       garment takes, and the difference is the marker, the grain, the
       shrinkage and the end loss. See the service's own header. */
    totalOutlineArea: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
  },

  bounds: {
    type: new mongoose.Schema({
      minX: Number, minY: Number, maxX: Number, maxY: Number, width: Number, height: Number,
    }, { _id: false }),
    default: null,
  },

  /* Which AAMA layer conventions the file actually used. Stored so a reader can
     see that "no notches" is the file's silence and not the parser's blind
     spot — the single most useful thing for judging what a pattern can be
     trusted for. */
  conventions: {
    type: [new mongoose.Schema({
      layer: { type: String, trim: true },
      meaning: { type: String, trim: true },
    }, { _id: false })],
    default: [],
  },
  layersSeen: [{ type: String, trim: true }],

  warnings: { type: mongoose.Schema.Types.Mixed, default: [] },

  /* The uploaded file's hash, so "is this the pattern that was approved" is
     answerable without trusting a filename. Mirrors the asset's own. */
  sha256: { type: String, trim: true, default: "" },
  fileName: { type: String, trim: true, default: "" },

  publishedBy: actorRef(),
  publishedAt: { type: Date, default: Date.now },
  /* Bumped on every replacement while the bundle is a draft, so a mapping can
     say which parse it was confirmed against. */
  parseRevision: { type: Number, default: 1 },
}, { _id: false });

const publicationSchema = new mongoose.Schema({
  /* ── TENANCY, FIRST AND INDEXED ───────────────────────────────────────
     Every read is scoped by it; nothing is found without it. */
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  styleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

  /* The identity anything downstream quotes. Minted once. */
  publicationRef: { type: String, trim: true, required: true, unique: true, immutable: true },

  /* ── THE BUSINESS NAME, NOT A FILE REVISION ───────────────────────────
     `modelNumber` counts publications on this style, so the workspace can
     say "3D model 2" — language a merchandiser and a sampling room both
     use. The storage object's own id is never shown as a version, and the
     uploaded filename is never the tab label. */
  modelNumber: { type: Number, required: true, min: 1, immutable: true },
  title: { type: String, trim: true, default: "", maxlength: 160 },

  state: {
    type: String, enum: Object.values(PUBLICATION_STATE),
    default: PUBLICATION_STATE.DRAFT, index: true,
  },

  assets: { type: [assetSchema], default: [] },

  /* ── WHAT THE EXPORT WAS ──────────────────────────────────────────────
     Half read from the file, half stated by the publisher. Both are kept
     because neither alone is sufficient: the file knows its generator and
     its glTF version, and only a person knows the unit a CLO export was
     written in or which pattern release it came from. */
  manifest: {
    cloVersion: { type: String, trim: true, default: "" },
    generator: { type: String, trim: true, default: "" },
    gltfVersion: { type: String, trim: true, default: "" },
    exportedAt: { type: Date, default: null },
    /* A measurement marker on a model with no unit measures nothing. */
    unit: { type: String, trim: true, enum: ["mm", "cm", "m", "in", ""], default: "" },
    unitScale: { type: Number, default: null },
    upAxis: { type: String, trim: true, enum: ["Y", "Z", ""], default: "" },
    handedness: { type: String, trim: true, enum: ["right", "left", ""], default: "" },
    sourceFileName: { type: String, trim: true, default: "" },
    extensionsUsed: [{ type: String, trim: true }],
    extensionsRequired: [{ type: String, trim: true }],
    note: { type: String, trim: true, default: "", maxlength: 2000 },
  },

  /* The published scene graph, as the file named it. */
  structure: { type: [nodeSchema], default: [] },

  stats: {
    nodes: { type: Number, default: 0 },
    meshes: { type: Number, default: 0 },
    materials: { type: Number, default: 0 },
    triangles: { type: Number, default: 0 },
    bytes: { type: Number, default: 0 },
    animations: { type: Number, default: 0 },
    namedPieces: { type: Number, default: 0 },
  },

  /* ── ONLY WHEN THERE GENUINELY IS ONE ─────────────────────────────────
     A show/hide control for an avatar that is not separately identifiable
     in the file would hide part of the garment. Detected from the published
     scene graph and stored, so the viewer offers the control only where it
     does something. */
  hasAvatar: { type: Boolean, default: false },
  avatarNodeRefs: [{ type: String, trim: true }],

  /* ── WHAT WAS ACCEPTED ANYWAY, AND WHY IT IS WORTH SAYING ─────────────
     A publication can be perfectly loadable and still be unable to carry
     everything a technical record needs — one merged mesh with no pattern
     names, a material extension the viewer cannot honour, a 40MB download.
     None of those is a reason to refuse the model, and all of them change
     what a reader should trust it for. Stored rather than only returned at
     upload: the person who publishes is rarely the person who later wonders
     why the fabric looks grey. */
  warnings: { type: mongoose.Schema.Types.Mixed, default: [] },

  /* ── WHY IT MAY NOT LOOK LIKE IT DID IN CLO ───────────────────────────
     The appearance audit: which materials sample texture that is not there,
     which meshes wear them, and the CLO export change that would fix it.
     Recorded, never acted on — nothing in this system rewrites a material or
     removes a mesh, because the value of a published model is that it is what
     CLO produced. Mixed, because it is a report rather than a record anything
     queries by. */
  surfaceAudit: { type: mongoose.Schema.Types.Mixed, default: null },

  /* Every measurement taken on this model. See the schema's own header for
     why these live here rather than in a collection of their own. */
  measurements: { type: [measurementSchema], default: [] },

  /* ═══ THE TECHNICAL BUNDLE ═══════════════════════════════════════════════
   *
   * ── WHY THE PUBLICATION *IS* THE BUNDLE, RATHER THAN HOLDING ONE ──────────
   * A 3D model, a flat pattern set and a CLO source that describe the same
   * approved revision are one thing in the sampling room's language: "the
   * technical pack for style X, revision 2". They are already published
   * together, approved together by one person, superseded together, and read
   * together by IE. Giving them a parent record would create a second identity
   * for the same fact, and the first question anybody asked would be whether
   * `GM-…` or the bundle's own ref is the version to quote.
   *
   * So this row is the bundle, `modelNumber` is the bundle revision, and
   * `publicationRef` is what everything downstream quotes. The three component
   * identities that the handover needs — the model, the pattern and the source
   * — are the assets and the pattern set below, each with its own ref and its
   * own hash.
   *
   * ── WHAT THIS BUYS, CONCRETELY ───────────────────────────────────────────
   * Approving one thing approves all three. There is no reachable state in
   * which an approved model sits beside an unapproved pattern, which is exactly
   * the state a separate lifecycle per file would make possible and which
   * nobody downstream could detect.
   */

  /* The parsed flat pattern, or null where the bundle has no pattern yet. A
     bundle is publishable with only a model — many styles have one before the
     pattern is drafted — and the absence is reported rather than blocking. */
  patternSet: { type: patternSetSchema, default: null },

  /* 2D piece → 3D component. See `pieceMappingSchema` for why each one is a
     record with an author rather than a lookup. */
  pieceMappings: { type: [pieceMappingSchema], default: [] },
  /* Bumped whenever the pattern set is re-parsed or re-matched, so a confirmed
     mapping can say which parse it was confirmed against — and a confirmation
     against a superseded parse is visibly stale rather than silently applied. */
  mappingRevision: { type: Number, default: 0 },

  /* ── WHICH VARIANT THIS BUNDLE DESCRIBES ──────────────────────────────
     A colourway and a size range are facts about what was published, and a
     bundle that does not state them has not stated them — hence empty strings
     rather than "all" or the style's own defaults. A pattern graded S–XL and a
     model built at M is a perfectly ordinary bundle, and the two fields are
     what let a reader see that it is. */
  colourway: { type: String, trim: true, default: "", maxlength: 120 },
  sizeRange: { type: String, trim: true, default: "", maxlength: 120 },
  /* The size the 3D garment was draped at, where R&D said. A measurement off
     the model means nothing without it, and it is the field a revision-mismatch
     check compares against the pattern's own sample size. */
  modelSize: { type: String, trim: true, default: "", maxlength: 40 },

  /* ── WHAT THE PUBLISHER SAID EACH FILE'S OWN REVISION WAS ─────────────
     Stated, not derived. A CLO export and a pattern export carry their own
     revision numbers from whatever system produced them, and when those two
     disagree the bundle is built from files describing different garments —
     which is the single most expensive mismatch here and the one the brief
     asks to be detected rather than silently combined. Empty is unstated, and
     an unstated revision raises a different, milder warning than two that
     contradict each other. */
  declaredModelRevision: { type: String, trim: true, default: "", maxlength: 60 },
  declaredPatternRevision: { type: String, trim: true, default: "", maxlength: 60 },

  /* Mismatches found between the bundle's own files, recomputed whenever a
     file changes. Stored for the same reason the model's warnings are: the
     person who publishes is rarely the person who later reads it. */
  bundleWarnings: { type: mongoose.Schema.Types.Mixed, default: [] },

  /* ── WHERE THIS BUNDLE'S 3D MODEL CAME FROM, WHEN IT WAS NOT UPLOADED ──
     A pattern can be imported onto a style whose every bundle is already
     accepted. Rather than demand a 40MB re-upload of a model that is already
     on record, a new draft references the accepted one — same stored object,
     same bytes, same hash. This names the bundle it came out of, so a reader
     can see that the 3D half of this draft is the accepted model rather than a
     new export, and a warning on the row says the same thing in words. */
  carriedModelFromRef: { type: String, trim: true, default: "" },

  /* ── WHAT ONE MODEL UNIT IS REALLY WORTH, IF ANYBODY HAS CHECKED ──────
     Somebody measured a distance they already knew — a placket length off
     the approved spec, a printed scale bar — and said what it really is.
     That gives a factor, and it belongs to THIS publication and no other: a
     later export may be drawn at a different scale, and carrying a factor
     across versions would silently relabel a wrong number as verified. A
     successor publication starts uncalibrated, every time.

     Attributable, because "verified" is a claim somebody is making. */
  scaleCalibration: {
    type: new mongoose.Schema({
      calibrationRef: { type: String, trim: true, required: true },
      /* raw model-space length between the two points the person picked */
      rawValue: { type: Number, required: true, min: 0 },
      /* what they said that length really is, and in what */
      knownValue: { type: Number, required: true, min: 0 },
      unit: { type: String, trim: true, enum: ["mm", "cm", "m", "in"], required: true },
      /* knownValue / rawValue — multiply a raw length by this for `unit` */
      factor: { type: Number, required: true, min: 0 },
      points: { type: [measurementPointSchema], required: true },
      note: { type: String, trim: true, default: "", maxlength: 1000 },
      by: actorRef(),
      at: { type: Date, default: Date.now },
    }, { _id: false }),
    default: null,
  },

  /* Which R&D technical revision this model belongs beside, where one exists.
     A reference and nothing more: the technical record is not changed by a
     model being published against it. */
  technicalRevisionRef: { type: String, trim: true, default: "" },

  createdBy: actorRef(),
  submittedAt: { type: Date, default: null },
  submittedBy: actorRef(),
  decidedAt: { type: Date, default: null },
  decidedBy: actorRef(),
  decisionNote: { type: String, trim: true, default: "", maxlength: 2000 },
  supersededByRef: { type: String, trim: true, default: "" },

  /* Optimistic concurrency. A save carrying a stale number is refused rather
     than overwriting a decision taken while the screen was open. */
  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "rnd_garment_model_publications" });

/* One model number per style, enforced by the database rather than by a
   handler that could lose a race. */
publicationSchema.index({ companyId: 1, styleId: 1, modelNumber: 1 }, { unique: true });
publicationSchema.index({ companyId: 1, styleId: 1, state: 1, modelNumber: -1 });

publicationSchema.statics.STATE = PUBLICATION_STATE;

/* ═══ THE MARKERS ══════════════════════════════════════════════════════════ */


/**
 * WHERE A MARKER IS, AND WHY IT IS NOT A SCREEN POSITION.
 *
 * A pin stored as an x/y on the canvas is correct for exactly one camera on
 * exactly one viewport size. Rotate the garment and it is pointing at the
 * floor; open it on a laptop and it has moved. It would also be unreadable to
 * anything that is not this viewer — IE cannot map "412px from the left" to a
 * construction point.
 *
 * So a marker names the NODE it is on, and a point in that node's OWN
 * coordinate frame. Both survive every camera, every viewport and every
 * reload, because neither has anything to do with the view. The surface
 * normal is kept beside it so the marker can be drawn facing outward, and the
 * triangle index is kept where the loader could supply one — it is the finest
 * identity the format offers and it makes "the same point" provable rather
 * than approximate.
 */
const anchorSchema = new mongoose.Schema({
  nodeRef: { type: String, trim: true, required: true },
  /* Stored beside the ref so a reader can see what was pinned without
     resolving the publication's structure, and so a successor publication can
     be compared by name as well as by index. */
  nodeName: { type: String, trim: true, default: "" },
  meshName: { type: String, trim: true, default: "" },
  primitiveIndex: { type: Number, default: null },
  triangleIndex: { type: Number, default: null },
  local: vec3(),
  normal: vec3(),
}, { _id: false });


/**
 * The structured half of a construction marker.
 *
 * Every field is optional and every field is NAMED, because "SPI 12" typed
 * into a comment box is a sentence and `spi: 12` is a requirement. A free-text
 * note stays available beside it for the half of any instruction that does not
 * fit a field.
 */
const constructionSchema = new mongoose.Schema({
  seam: { type: String, trim: true, default: "", maxlength: 160 },
  stitchClass: { type: String, trim: true, default: "", maxlength: 40 },
  spi: { type: Number, default: null, min: 0 },
  seamAllowanceMm: { type: Number, default: null, min: 0 },
  measurementPoint: { type: String, trim: true, default: "", maxlength: 160 },
  toleranceMm: { type: Number, default: null, min: 0 },
  componentRelationship: { type: String, trim: true, default: "", maxlength: 240 },
  trimPlacement: { type: String, trim: true, default: "", maxlength: 240 },
  qualityCritical: { type: Boolean, default: false },
  approvedSampleDifference: { type: String, trim: true, default: "", maxlength: 1000 },
}, { _id: false });

const replySchema = new mongoose.Schema({
  body: { type: String, trim: true, required: true, maxlength: 4000 },
  author: actorRef(),
  at: { type: Date, default: Date.now },
}, { _id: false });


const annotationSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  styleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

  /* ── BOUND TO ONE PUBLICATION, AND IT CANNOT MOVE ─────────────────────
     Immutable on purpose. A marker was placed on a surface; a later export
     may have moved that surface, renamed the piece or removed it, and a
     marker that silently followed would be a measurement nobody took. A
     successor publication starts with no markers and a future flow decides,
     piece by piece, what to carry forward. */
  publicationId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  publicationRef: { type: String, trim: true, required: true, immutable: true },
  modelNumber: { type: Number, required: true, immutable: true },

  markerRef: { type: String, trim: true, required: true, unique: true, immutable: true },
  /* Drawing order and the number a person says out loud: "marker 4". */
  seq: { type: Number, required: true, min: 1 },

  anchor: { type: anchorSchema, required: true },
  camera: { type: cameraSchema, default: null },

  category: { type: String, enum: Object.values(MARKER_CATEGORY), required: true },
  title: { type: String, trim: true, required: true, maxlength: 200 },
  note: { type: String, trim: true, default: "", maxlength: 4000 },
  construction: { type: constructionSchema, default: () => ({}) },

  status: { type: String, enum: Object.values(MARKER_STATUS), default: MARKER_STATUS.OPEN, index: true },

  /* ── HOW URGENT, AND WHOSE PROBLEM — BOTH OPTIONAL ────────────────────
     Optional because most markers are neither urgent nor anybody else's, and
     a required priority field turns into everything being "normal". Stated
     where it matters: a quality-critical seam that blocks sampling is a
     different thing from a note somebody wanted on the record, and the person
     who has to act is often in another department. */
  priority: {
    type: String,
    enum: ["blocker", "high", "normal", "low", ""],
    default: "",
  },
  /* A department slug, where R&D knows who needs to see it. Never an
     assignment and never a permission — it does not let that department edit
     anything here. */
  departmentRelevance: [{ type: String, trim: true }],

  /* What this marker is a requirement ABOUT, where R&D has said. A reference
     into the technical record, never a copy of it. */
  linkedTechnicalItem: {
    kind: { type: String, trim: true, default: "" },
    ref: { type: String, trim: true, default: "" },
    label: { type: String, trim: true, default: "" },
  },

  attachments: {
    type: [new mongoose.Schema({
      driveFileId: { type: String, trim: true, required: true },
      name: { type: String, trim: true, default: "" },
      mimeType: { type: String, trim: true, default: "" },
      bytes: { type: Number, default: 0 },
    }, { _id: false })],
    default: [],
  },

  author: actorRef(),
  replies: { type: [replySchema], default: [] },
  events: { type: [eventSchema], default: [] },

  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "rnd_garment_model_annotations" });

annotationSchema.index({ companyId: 1, publicationId: 1, seq: 1 }, { unique: true });
annotationSchema.index({ companyId: 1, styleId: 1, status: 1 });

annotationSchema.statics.CATEGORY = MARKER_CATEGORY;
annotationSchema.statics.STATUS = MARKER_STATUS;

module.exports = {
  PUBLICATION_STATE, MARKER_CATEGORY, MARKER_STATUS, ASSET_KIND,
  PATTERN_CLASSIFICATION, MAPPING_METHOD, MAPPING_STATE,
  MEASUREMENT_KIND, MEASUREMENT_STATUS, MEASUREMENT_CATEGORY, SCALE_STATE,
  SURFACE_KINDS, MEASUREMENT_HANDOVER_STATES,
  GarmentModelPublication: mongoose.models.GarmentModelPublication
    || mongoose.model("GarmentModelPublication", publicationSchema),
  GarmentModelAnnotation: mongoose.models.GarmentModelAnnotation
    || mongoose.model("GarmentModelAnnotation", annotationSchema),
};
