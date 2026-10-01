// models/CMS_Models/RnD/PatternRevision.js
//
// THE FLAT PATTERN IS THE GARMENT. THE 3D IS A PICTURE OF IT.
//
// ── THE INVERSION THIS RECORD EXISTS TO MAKE ────────────────────────────────
// Until now a publication WAS the bundle: a 3D model and a pattern set,
// published together, approved together, peers. That reading is defensible and
// it is written down in GarmentModel.js — but it is not how a garment is
// actually made. A factory cuts cloth to a pattern. Nobody cuts to a render.
//
// So the authority moves here. A pattern revision is the design: the pieces,
// their outlines, their seam allowances, their grading, their notches. A 3D
// preview is DERIVED from exactly one of these revisions, is read-only, and
// goes out of date the moment a new revision lands. Nothing in 3D can change a
// pattern — not a measurement, not an annotation, not an approval.
//
// ── WHAT THE ORIGINAL DXF IS FOR ────────────────────────────────────────────
// Kept byte-for-byte on every revision that descends from it, and never
// re-written. The parse is this system's reading of the file; the file is what
// the pattern room sent. When those two disagree the file wins, and the only
// way to settle it is to still have the file.
//
// ── WHY AN APPROVED REVISION CANNOT BE EDITED ───────────────────────────────
// Because something was cut to it. An approved revision is the answer to "what
// was this sample made from", and a record that can be edited after the fact
// cannot answer that. Editing an approved revision creates the NEXT one, with
// a parent pointer, and the approved one stays exactly as it was approved.
"use strict";

const mongoose = require("mongoose");

/* The pattern set, piece and point shapes are already modelled on the
   publication and are the same shapes here — the parse does not change
   because the authority did. Imported rather than redeclared so a change to
   what a piece is cannot apply to one of them and not the other. */
const { patternSetSchema, actorRef, eventSchema } = require("./GarmentModel").SHARED;

const REVISION_STATE = Object.freeze({
  /* Being worked on. Editable, and not something anybody may cut to. */
  DRAFT: "draft",
  /* Signed off. Frozen for ever; the thing samples are made from. */
  APPROVED: "approved",
  /* A later revision was approved. Kept, readable, and never current. */
  SUPERSEDED: "superseded",
  /* Taken out of use without a successor. */
  WITHDRAWN: "withdrawn",
});

/**
 * WHAT CHANGED, AND WHAT IT WAS CHANGED FROM.
 *
 * A revision that says only "edited" is a revision nobody can review. Each
 * entry names the piece, the kind of change and enough of the before and
 * after for a reader to see what was done without diffing two whole patterns.
 */
const EDIT_KIND = Object.freeze({
  OUTLINE: "outline",             /* points moved or reshaped */
  SEAM_ALLOWANCE: "seam-allowance",
  GRADING: "grading",
  NOTCHES: "notches",
  INTERNAL_LINES: "internal-lines",
  RENAME: "rename",
  METADATA: "metadata",           /* quantity, material, component class */
  PIECE_ADDED: "piece-added",
  PIECE_REMOVED: "piece-removed",
});

const editSchema = new mongoose.Schema({
  kind: { type: String, enum: Object.values(EDIT_KIND), required: true },
  pieceRef: { type: String, trim: true, default: "" },
  pieceName: { type: String, trim: true, default: "" },
  /* Said in words, for the person reading the revision list. */
  summary: { type: String, trim: true, required: true, maxlength: 400 },
  /* The numbers, for the person who needs them. Mixed because what is worth
     keeping differs per kind and a schema per kind would be nine schemas
     nobody reads. */
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  by: actorRef(),
  at: { type: Date, default: Date.now },
}, { _id: false });

/* ═══ WHAT A SIMULATION NEEDS BEFORE IT CAN DRAPE ANYTHING ═════════════════
 *
 * ── AND WHY THE LIST IS HERE RATHER THAN IN THE RENDERER ────────────────────
 * Because the answer to "can this be rendered" has to be visible while
 * somebody is still working on the pattern, not discovered when a job fails.
 * Each of these is a real input a cloth simulator cannot proceed without, and
 * each is stated by a person — none of it can be inferred from a DXF.
 *
 * A pattern with none of this filled in is a perfectly good pattern. It is
 * simply not yet something a 3D preview can be made from, and the screen says
 * which parts are missing in those words.
 */
const seamPairingSchema = new mongoose.Schema({
  /* Two edges that are sewn to each other. The pattern says where the pieces
     are; only a person says which edge joins which. */
  fromPieceRef: { type: String, trim: true, required: true },
  fromEdge: { type: String, trim: true, default: "" },
  toPieceRef: { type: String, trim: true, required: true },
  toEdge: { type: String, trim: true, default: "" },
  seamType: { type: String, trim: true, default: "" },
  note: { type: String, trim: true, default: "", maxlength: 240 },
}, { _id: false });

const fabricSchema = new mongoose.Schema({
  /* Which pieces this fabric is for. Empty means every piece without its own. */
  pieceRefs: [{ type: String, trim: true }],
  name: { type: String, trim: true, required: true, maxlength: 160 },
  /* The handful of numbers every cloth solver asks for. Absent is absent — a
     default weight would be this system inventing a fabric. */
  weightGsm: { type: Number, default: null, min: 0 },
  thicknessMm: { type: Number, default: null, min: 0 },
  stretchWarpPercent: { type: Number, default: null },
  stretchWeftPercent: { type: Number, default: null },
  bendingRigidity: { type: Number, default: null },
  note: { type: String, trim: true, default: "", maxlength: 240 },
}, { _id: false });

const avatarSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: "" },
  size: { type: String, trim: true, default: "" },
  /* Body measurements, as whatever set the pattern room works in. Mixed
     because a measurement chart is not a fixed schema and forcing one would
     drop whatever this house happens to measure. */
  measurements: { type: mongoose.Schema.Types.Mixed, default: {} },
  poseRef: { type: String, trim: true, default: "" },
}, { _id: false });

const simulationInputsSchema = new mongoose.Schema({
  seamPairings: { type: [seamPairingSchema], default: [] },
  fabrics: { type: [fabricSchema], default: [] },
  avatar: { type: avatarSchema, default: () => ({}) },
  /* Solver settings — iterations, particle distance, gravity. Named by the
     adapter that will consume them, not by this record. */
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  /* Which size of the graded pattern to drape. */
  renderSize: { type: String, trim: true, default: "" },
}, { _id: false });

/* ═══ THE REVISION ════════════════════════════════════════════════════════ */

const patternRevisionSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  styleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

  revisionRef: { type: String, trim: true, required: true, unique: true, immutable: true },
  /* Counts up per style. The number a person says out loud: "pattern
     revision 3". */
  revisionNumber: { type: Number, required: true, min: 1, immutable: true },
  name: { type: String, trim: true, default: "", maxlength: 200 },

  state: {
    type: String, enum: Object.values(REVISION_STATE),
    default: REVISION_STATE.DRAFT, index: true,
  },

  /* ── WHERE THIS REVISION CAME FROM ───────────────────────────────────
     An import starts a line; every edit continues one. `parentRevisionRef`
     is what makes the history walkable, and what makes "edited after it was
     approved" impossible to express — an edit of an approved revision is a
     new revision whose parent is the approved one. */
  origin: {
    kind: { type: String, enum: ["dxf-import", "edit"], required: true },
    parentRevisionRef: { type: String, trim: true, default: "" },
  },

  /* ── THE FILE THE PATTERN ROOM SENT, UNCHANGED ───────────────────────
     Carried forward on every descendant revision: the edits are recorded
     against the parse, and the original is what settles an argument about
     what the parse got wrong. Never rewritten, by anything. */
  sourceDxf: {
    driveFileId: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    sha256: { type: String, trim: true, default: "" },
    bytes: { type: Number, default: 0 },
    /* Which revision first imported it, so a reader can see that revision 7's
       DXF is revision 1's DXF. */
    importedInRevisionRef: { type: String, trim: true, default: "" },
  },

  /* The pattern itself. Same shape as the publication's parse. */
  patternSet: { type: patternSetSchema, default: null },

  /* What this revision changed from its parent. Empty on an import. */
  edits: { type: [editSchema], default: [] },

  /* What a 3D preview would need. Stated by people, never inferred. */
  simulationInputs: { type: simulationInputsSchema, default: () => ({}) },

  author: actorRef(),
  approvedBy: actorRef(),
  approvedAt: { type: Date, default: null },
  supersededByRef: { type: String, trim: true, default: "" },
  events: { type: [eventSchema], default: [] },

  /* Optimistic concurrency, for a save from a stale screen. */
  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "rnd_pattern_revisions" });

patternRevisionSchema.index({ companyId: 1, styleId: 1, revisionNumber: 1 }, { unique: true });
patternRevisionSchema.index({ companyId: 1, styleId: 1, state: 1 });

/* ═══ THE RENDER JOB ══════════════════════════════════════════════════════
 *
 * ── WHY A JOB RECORD AND NOT A FLAG ON THE PATTERN ──────────────────────────
 * Because a render takes minutes, can fail, and is worth keeping after it has
 * been replaced. A boolean on the pattern could answer none of "is it running",
 * "what did it produce", "what was it rendered FROM" or "why did it fail", and
 * the last of those is the question asked most often.
 *
 * ── WHAT MAKES A PREVIEW GO STALE ───────────────────────────────────────────
 * It is derived from ONE revision, named here and never updated. When a later
 * revision is approved, this job still points at the one it used — which is
 * precisely what lets the workspace say "out of date" rather than quietly
 * showing a garment that is not the current pattern.
 */
const RENDER_STATUS = Object.freeze({
  QUEUED: "queued",
  SIMULATING: "simulating",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

const renderJobSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  styleId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

  jobRef: { type: String, trim: true, required: true, unique: true, immutable: true },

  /* ── EXACTLY WHICH PATTERN THIS IS A PICTURE OF ──────────────────────
     Immutable, all three. A job that could be re-pointed at another revision
     would make "derived from revision 3" a claim rather than a fact. */
  patternRevisionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },
  patternRevisionRef: { type: String, trim: true, required: true, immutable: true },
  patternRevisionNumber: { type: Number, required: true, immutable: true },

  /* ── AND EXACTLY WHAT IT WAS RENDERED WITH ───────────────────────────
     A copy, not a reference. The revision's inputs may be edited afterwards;
     what this garment was draped with cannot change retrospectively. */
  inputs: { type: simulationInputsSchema, required: true, immutable: true },

  status: {
    type: String, enum: Object.values(RENDER_STATUS),
    default: RENDER_STATUS.QUEUED, index: true,
  },

  /* Which simulation engine, and which version of it. A garment draped by
     two different solvers is two different garments. */
  engine: {
    adapter: { type: String, trim: true, default: "" },
    version: { type: String, trim: true, default: "" },
    externalJobId: { type: String, trim: true, default: "" },
  },

  /* What it produced. A publication id, because a completed render becomes an
     ordinary garment-model publication — read-only, and marked as derived. */
  resultPublicationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  resultPublicationRef: { type: String, trim: true, default: "" },

  /* Why it did not. Both fields, because a code a screen can branch on and a
     sentence a person can act on are different things. */
  failure: {
    code: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "", maxlength: 2000 },
  },

  requestedBy: actorRef(),
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  events: { type: [eventSchema], default: [] },
  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "rnd_render_jobs" });

renderJobSchema.index({ companyId: 1, styleId: 1, createdAt: -1 });
renderJobSchema.index({ companyId: 1, patternRevisionRef: 1 });

module.exports = {
  REVISION_STATE, EDIT_KIND, RENDER_STATUS,
  PatternRevision: mongoose.models.PatternRevision
    || mongoose.model("PatternRevision", patternRevisionSchema),
  RenderJob: mongoose.models.RenderJob
    || mongoose.model("RenderJob", renderJobSchema),
};
