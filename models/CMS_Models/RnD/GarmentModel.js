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
  WEB_MODEL: "web_model",   /* .glb — the only thing the browser loads */
  SOURCE: "source",         /* .zprj / .zpac — immutable evidence */
  PREVIEW: "preview",       /* a still, shown before the canvas is ready */
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

const vec3 = () => ({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
  z: { type: Number, required: true },
});

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

/** The view the author was looking from, restored when the marker is opened. */
const cameraSchema = new mongoose.Schema({
  position: vec3(),
  target: vec3(),
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

/** Everything that happened to this marker, in the order it happened. */
const eventSchema = new mongoose.Schema({
  kind: { type: String, trim: true, required: true },
  note: { type: String, trim: true, default: "", maxlength: 2000 },
  by: actorRef(),
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
  GarmentModelPublication: mongoose.models.GarmentModelPublication
    || mongoose.model("GarmentModelPublication", publicationSchema),
  GarmentModelAnnotation: mongoose.models.GarmentModelAnnotation
    || mongoose.model("GarmentModelAnnotation", annotationSchema),
};
