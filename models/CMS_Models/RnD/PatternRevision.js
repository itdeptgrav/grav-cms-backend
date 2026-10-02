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
/* ── A BOUNDARY RUN, AND WHY A SEAM SIDE IS A SEQUENCE OF THEM ────────────
   A run is a stretch of ONE piece's closed boundary, between two anchors, with a
   direction. Not a line, not a segment list, not a name.

   Seam sides are ordered SEQUENCES of runs because on every garment in scope the
   armhole is one sleeve-cap run sewn to two or three body runs in order. A
   contract pairing one run to one run cannot express a set-in sleeve — which is
   what the first version of this file tried to do, and why it is replaced rather
   than extended (garment-template-contract.md §4.4).

   Anchors are stored by KIND, because the kind is what tells a reader how much a
   pattern edit is likely to have broken: a turn point usually survives one, an
   arc-length fraction never does (§4.3). */
const ANCHOR_KIND = Object.freeze({
  TURN_POINT: "turn-point",
  NOTCH: "notch",
  PLACED: "placed",
  FRACTION: "fraction",
});

const anchorSchema = new mongoose.Schema({
  kind: { type: String, enum: Object.values(ANCHOR_KIND), required: true },
  /* An index into the piece's own outline, as parsed. The authoritative locator
     for every kind except `fraction`. */
  pointIndex: { type: Number, default: null, min: 0 },
  /* Fraction of the piece's perimeter. Only for `fraction`, and the reason W7
     exists: move one point and every fraction after it means something else. */
  fraction: { type: Number, default: null, min: 0, max: 1 },
}, { _id: false });

const boundaryRunSchema = new mongoose.Schema({
  runId: { type: String, trim: true, required: true },
  /* Both anchors are REQUIRED. A run with one end is not a run. */
  startAnchor: { type: anchorSchema, required: true },
  endAnchor: { type: anchorSchema, required: true },
  /* Which way round the boundary this run travels, start to end. Derived, and
     stored because everything downstream — pairing, easing, sampling — depends on
     the order being the stated one rather than the storage order of the outline. */
  direction: { type: String, enum: ["forward", "reverse"], default: "forward" },
  /* WHICH OF THE TWO STRETCHES BETWEEN THE ANCHORS THIS IS.
     Two points on a closed boundary divide it into two runs and both are real: a
     neckline and "all of the piece except the neckline" share their ends. The
     solver takes the shorter one unless told otherwise, so the choice has to be
     recorded — without this field the screen could offer the long way round,
     draw it, and have the garment sewn along the short one. */
  theLongWay: { type: Boolean, default: false },
  /* What this run is for, from the template's own run vocabulary. */
  role: { type: String, trim: true, default: "" },
  /* Arc length between the anchors, in the pattern's own unit. Derived at the
     time the run was placed, and stored so readiness can compare DECLARED
     lengths before any mesh exists (M4). */
  lengthMm: { type: Number, default: null, min: 0 },
  note: { type: String, trim: true, default: "", maxlength: 240 },
}, { _id: false });

/* ── PER-PIECE SETUP: EVERYTHING ONLY A PERSON CAN SAY ────────────────────
   Separate from `patternSet.pieces`, which is the PARSE. A role is assigned and
   never recognised; nothing here is read from a piece's name. */
const SYMMETRY = Object.freeze({
  SINGLE: "single",
  MIRRORED_PAIR: "mirrored-pair",
  IDENTICAL_PAIR: "identical-pair",
  CUT_ON_FOLD: "cut-on-fold",
});

const PIECE_LAYER = Object.freeze({
  SHELL: "shell", LINING: "lining", INTERLINING: "interlining",
  RIB: "rib", TRIM: "trim", POCKETING: "pocketing",
});

const confirmationSchema = new mongoose.Schema({
  by: actorRef(),
  at: { type: Date, default: null },
}, { _id: false });

const piecePlanSchema = new mongoose.Schema({
  pieceRef: { type: String, trim: true, required: true },
  /* From the TEMPLATE's own role vocabulary. Never read from the piece's name:
     a second shop sends a DXF whose pieces are called `Pattern_636968`. */
  role: { type: String, trim: true, default: "" },
  roleConfirmed: { type: confirmationSchema, default: null },
  /* The count in the FINISHED garment, after unfolding and mirroring — not the
     number of outlines in the DXF. */
  cutQuantity: { type: Number, default: null, min: 0 },
  symmetry: { type: String, enum: [...Object.values(SYMMETRY), ""], default: "" },
  /* The other half, when left and right are drawn separately (§4.7 Form B). */
  pairedWith: { type: String, trim: true, default: "" },
  layer: { type: String, enum: [...Object.values(PIECE_LAYER), ""], default: "" },

  /* ── GRAIN IS A VECTOR, NOT A LABEL ──────────────────────────────────
     In the piece's OWN local coordinates. Every piece on a marker carries a
     grainline parallel to the selvedge, so the absolute angle is ~90° for all of
     them and says nothing about the garment — our parser labels the neck rib
     "lengthwise", the one piece that must be cut across (§4.8). */
  grainVector: { type: [Number], default: undefined },
  grainSource: {
    type: String, enum: ["marker-grainline", "stated", "confirmed", ""], default: "",
  },
  grainConfirmed: { type: confirmationSchema, default: null },

  /* The runs placed on this piece's boundary. */
  runs: { type: [boundaryRunSchema], default: [] },

  /* ── ONE CONFIRMATION FOR THE WHOLE REMAINING PERIMETER ──────────────
     Not one per edge. Before anybody places anchors there is no edge set, only a
     closed boundary, and demanding a declaration per edge made a first fitting
     cost a dozen pointless clicks (§4.11). */
  boundaryConfirmed: { type: confirmationSchema, default: null },

  /* Per-piece allowance, where it differs from the garment's. */
  seamAllowanceMm: { type: Number, default: null, min: 0 },
  note: { type: String, trim: true, default: "", maxlength: 400 },
}, { _id: false });

/* ── A SEAM: TWO ORDERED SEQUENCES, AND AN EXPLICIT ALIGNMENT ─────────────
   `alignment` is the single most important field in this file.

   A sleeve cap sewn front-to-back has the same piece perimeter, the same seam
   length and the same scale as one sewn correctly, so the geometry-fidelity gate
   passes it without complaint and the twist reads as a drape fold. Nothing
   downstream detects it. The defence is prevention: the alignment is a STORED
   value, never inferred from storage order, a named person confirms it against a
   visual preview, and simulation is refused without it (§4.5, R4). */
const SEAM_ALIGNMENT = Object.freeze({
  START_TO_START: "start-to-start",
  START_TO_END: "start-to-end",
});

const seamSideRefSchema = new mongoose.Schema({
  pieceRef: { type: String, trim: true, required: true },
  runId: { type: String, trim: true, required: true },
}, { _id: false });

const seamSchema = new mongoose.Schema({
  seamId: { type: String, trim: true, required: true },
  name: { type: String, trim: true, default: "", maxlength: 160 },
  /* Ordered. The order is the traversal order and is not a set. */
  sideA: { type: [seamSideRefSchema], default: [] },
  sideB: { type: [seamSideRefSchema], default: [] },

  alignment: { type: String, enum: [...Object.values(SEAM_ALIGNMENT), ""], default: "" },
  /* A confirmation nobody is attributable for is a guess. */
  alignmentConfirmed: { type: confirmationSchema, default: null },
  confidence: {
    type: String, enum: ["proposed", "confirmed", "rejected"], default: "proposed",
  },

  /* ── LEFT AND RIGHT ARE SEPARATE SEAMS ───────────────────────────────
     Every body-to-sleeve, shoulder and side seam exists twice, and a confirmation
     on one is never applied to the other by inference. The one exception is a
     mirrored piece pair, where a single confirmation may be PROPAGATED — and then
     this field records that it was, which is what makes W9 possible (§4.7). */
  propagatedFrom: {
    seamId: { type: String, trim: true, default: "" },
    side: { type: String, trim: true, default: "" },
  },

  /* Length difference as a percentage of the shorter side, with where it goes. */
  easePercent: { type: Number, default: null },
  easeDistribution: { type: String, trim: true, default: "even" },
  seamType: {
    type: String,
    enum: ["plain", "flat-felled", "french", "overlocked", "bound", "topstitched", "taped", ""],
    default: "",
  },
  note: { type: String, trim: true, default: "", maxlength: 400 },
}, { _id: false });

/* ── THE FABRIC PROFILE, VALIDATED BY VALUE AND NOT BY PRESENCE ───────────
   The old block carried seven fields and the adapter checked only that the array
   was non-empty. A profile with every number at zero passed, and zero gravity
   with zero stiffness gives cloth that looks like cloth and behaves like nothing
   — indistinguishable on screen from a real result (fabric-profile-contract.md
   §1, VM-14).

   `behaviour` is load-bearing: the Fit Assistant takes a different primary
   evidence path for knit and for woven, and getting it wrong reverses which
   number is trusted. It is never inferred from the fabric's name. */
const FABRIC_BEHAVIOUR = Object.freeze({ WOVEN: "woven", KNIT: "knit" });
const FABRIC_GRADE = Object.freeze({
  MEASURED: "measured", STATED: "stated", ESTIMATED: "estimated", PRESET: "preset",
});

const fabricProfileSchema = new mongoose.Schema({
  profileId: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, required: true, maxlength: 160 },
  /* The pieceRefs this covers. Empty means every simulated piece without its own. */
  appliesTo: [{ type: String, trim: true }],

  behaviour: { type: String, enum: [...Object.values(FABRIC_BEHAVIOUR), ""], default: "" },
  behaviourConfirmed: { type: confirmationSchema, default: null },
  grade: { type: String, enum: [...Object.values(FABRIC_GRADE), ""], default: "" },
  source: { type: String, trim: true, default: "" },
  measuredBy: { type: String, trim: true, default: "" },
  measuredAt: { type: Date, default: null },

  /* How hard gravity pulls. The single most visible value in a drape, and the
     one whose absence is a readiness failure: there is no defensible default. */
  weightGsm: { type: Number, default: null, min: 0 },
  /* The cloth's actual thickness, as a material property. */
  thicknessMm: { type: Number, default: null, min: 0 },
  /* A SOLVER parameter, and routinely larger than the cloth because it also
     absorbs mesh coarseness. The archive's own preset had thickness 0.012 and a
     gap of 0.16 — a factor of thirteen. Conflating them produces either
     self-intersection or cloth that is reported too thick (§2.2, M6). */
  collisionOffsetMm: { type: Number, default: null, min: 0 },

  stretchWarpPercent: { type: Number, default: null },
  stretchWeftPercent: { type: Number, default: null },
  /* "40% stretch" is not a number until you say under what force. Two profiles
     measured at different loads are not comparable. */
  stretchLoadN: { type: Number, default: null, min: 0 },

  shearStiffness: { type: Number, default: null, min: 0 },
  bendingRigidity: { type: Number, default: null, min: 0 },
  damping: { type: Number, default: null, min: 0 },
  frictionBody: { type: Number, default: null, min: 0 },
  frictionSelf: { type: Number, default: null, min: 0 },
  note: { type: String, trim: true, default: "", maxlength: 400 },
}, { _id: false });

const avatarSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: "" },
  size: { type: String, trim: true, default: "" },
  /* Body measurements, as whatever set the pattern room works in. Mixed because
     a measurement chart is not a fixed schema and forcing one would drop whatever
     this house happens to measure. */
  measurements: { type: mongoose.Schema.Types.Mixed, default: {} },
  poseRef: { type: String, trim: true, default: "" },
  /* ── SELF-CONSISTENT IS NOT VERIFIED (M3) ────────────────────────────
     Self-consistent means the stated unit, the declared lengths and the built
     mesh agree — which a pattern drawn at the wrong scale throughout satisfies.
     Externally verified means at least one length was checked against something
     outside the file. A fitting states which it has. */
  scaleVerifiedAgainst: { type: String, trim: true, default: "" },
}, { _id: false });

const simulationInputsSchema = new mongoose.Schema({
  /* Which of the three categories. Chosen, never guessed. */
  template: { type: String, trim: true, default: "" },
  /* A graded pattern holds several sizes and a drape is of exactly one. */
  renderSize: { type: String, trim: true, default: "" },
  avatar: { type: avatarSchema, default: () => ({}) },
  pieces: { type: [piecePlanSchema], default: [] },
  seams: { type: [seamSchema], default: [] },
  fabrics: { type: [fabricProfileSchema], default: [] },
  /* Per garment, where it is not stated per piece or per run. Without a
     published sewing line and without this, no sewing line can be constructed
     and every dimensional finding is withheld (§4.12 step 4). */
  seamAllowanceMm: { type: Number, default: null, min: 0 },
  /* Solver settings, named by the adapter that consumes them. */
  settings: { type: mongoose.Schema.Types.Mixed, default: {} },
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

  /* ── WHICH REVISION THE SEAM MAPPING WAS CONFIRMED AGAINST ───────────
     A mapping names outline point indices. An edit moves them, so a mapping
     carried onto the next revision may point at geometry that moved — which is
     R11, and the reason a fitting is never silently re-pointed at a new
     revision. Holding the ref it was confirmed against is what lets the product
     say "re-check this" instead of guessing. */
  mappingConfirmedAgainstRef: { type: String, trim: true, default: "" },

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

  /* ── OR A DRAPE, WHEN THE SOLVER RAN IN THE BROWSER ──────────────────
     ── WHY A DRAPE IS NOT A PUBLICATION ──────────────────────────────
     A garment-model publication is a CLO export: a file somebody made, with a
     source project behind it, that a sample can be approved against. A drape is
     this system's own reading of a 2D pattern — derived, read-only, reproducible
     from the revision and the solver version. Filing one as a publication would
     put it in the same list as approvable models and somebody would approve it.

     So a completed render names a publication OR a drape, and the two are
     different kinds of evidence.

     The positions are stored and the triangles are not: the triangulation is a
     pure function of the pattern, the quality and the solver version, all three
     of which are recorded here, so it is cheaper to rebuild than to keep. At
     High quality the positions are about 100KB, which is what a drape costs. */
  drape: {
    solverVersion: { type: String, trim: true, default: "" },
    quality: { type: String, trim: true, default: "" },
    fabric: { id: String, label: String, version: String },
    /* Millimetres, always. The one place a 25.4x error could hide is the unit,
       so the unit is written down beside the numbers. */
    unit: { type: String, trim: true, default: "mm" },
    vertexCount: { type: Number, default: 0 },
    triangleCount: { type: Number, default: 0 },
    pieces: {
      type: [new mongoose.Schema({
        pieceRef: String, name: String, role: String,
        base: Number, vertexCount: Number,
      }, { _id: false })],
      default: [],
    },
    /* Float32, three per vertex, in the piece order above. */
    positions: { type: Buffer, default: null },
    /* ── WHAT THE DRAPE FOUND, KEPT WITH IT ─────────────────────────
       A seam that did not close and cloth still under tension are findings
       about the PATTERN, and they are the reason to look at a drape at all.
       Stored so they can be read without re-running a minute of arithmetic. */
    seamClosure: { type: mongoose.Schema.Types.Mixed, default: [] },
    strain: { type: mongoose.Schema.Types.Mixed, default: null },
    fidelity: { type: mongoose.Schema.Types.Mixed, default: null },
    tightestClearanceMm: { type: Number, default: null },
    template: { type: mongoose.Schema.Types.Mixed, default: null },
    body: { type: mongoose.Schema.Types.Mixed, default: null },
    frames: { type: Number, default: 0 },
    finalMoveMm: { type: Number, default: null },
    msElapsed: { type: Number, default: 0 },

    /* ── WHICH SEWING LINE THIS DRAPE WAS SEWN ON ────────────────────
        `published` | `derived` | `cut-boundary`. Never absent, because a drape
        sewn on the cut boundary is NOT a drape with a small offset: the panels
        meet in the wrong places and the whole assembly differs. On a chest with
        two side seams and two armholes, 10mm of allowance is of the order of
        40mm — the width of a whole fit band. The error is never called slight
        (garment-template-contract.md §4.12). */
    sewingLineSource: {
      type: String, enum: ["published", "derived", "cut-boundary", ""], default: "",
    },
    seamAllowanceMm: { type: Number, default: null },
    /* False when the cut boundary was used. A non-authoritative drape may be
       looked at and may not report a dimension. */
    authoritative: { type: Boolean, default: true },
    /* Named findings this drape may NOT report, each with the reason, so a
       screen cannot show a number the drape is not entitled to. */
    withheld: {
      type: [new mongoose.Schema({
        finding: { type: String, trim: true, required: true },
        why: { type: String, trim: true, required: true, maxlength: 400 },
      }, { _id: false })],
      default: [],
    },
    /* `fitting` | `partial`. A partial is not a degraded fitting: it is the
       correct outcome whenever the drape is watchable but a number would be
       biased (validation-matrix.md §1). */
    outcome: { type: String, enum: ["fitting", "partial", ""], default: "" },
    /* The readiness result this drape was run against, as it stood. A fitting is
       evidence, and evidence that cannot say what it assumed is weak. */
    readiness: { type: mongoose.Schema.Types.Mixed, default: null },
    /* ── CAN THIS DRAPE BE REDRAWN? ──────────────────────────────────
        The triangles are rebuilt from the pattern rather than stored, which is
        only honest if the rebuild is provably the same mesh. This fingerprints
        the geometry the drape was built from — the piece refs, their point
        counts and their perimeters — alongside the solver version. If a rebuild
        does not match it, the drape is NOT redrawn through today's faces; the
        reader is told why instead. */
    geometryIdentity: { type: String, trim: true, default: "" },
    fabricGrade: { type: String, trim: true, default: "" },
    /* ── DID THE CLOTH STOP MOVING? ──────────────────────────────────
        A drape that reached the end of its frame budget still moving was
        photographed mid-motion: the folds are still finding their places, so the
        cloth's exact position — and any dimension measured on it — would differ a
        second later. Stored as a verdict rather than only as a number, because
        "settled to 12.7 mm per frame" reads like a small number and means the
        opposite. An unsettled drape is a PREVIEW and may not report a dimension. */
    settled: { type: Boolean, default: null },
    settledBelowMm: { type: Number, default: null },
    convergence: { type: String, trim: true, default: "" },
  },

  /* Why it did not. Both fields, because a code a screen can branch on and a
     sentence a person can act on are different things. */
  failure: {
    code: { type: String, trim: true, default: "" },
    message: { type: String, trim: true, default: "", maxlength: 2000 },
  },

  /* ── WHAT THE PATTERN WAS JUDGED READY ON ────────────────────────────
     A copy, frozen with the job, so a drape can say which sewing line it was
     entitled to use and which findings it was never allowed to report. The
     readiness result itself can change the moment somebody edits the setup; what
     THIS render was accepted under cannot. */
  acceptedReadiness: { type: mongoose.Schema.Types.Mixed, default: null },

  /* ── THE LEASE, AND WHY A JOB NEEDS ONE ──────────────────────────────
     The solver runs in the reader's browser. A closed tab, a crash or a laptop
     lid therefore ends the arithmetic with no message, and the first version of
     this record had no way to tell that from a drape still in progress — so one
     closed tab blocked the revision for ever, because only one render may run at
     a time.

     So a browser-run job holds a LEASE and beats a heartbeat while it solves.
     A lease that has expired means nobody is working on this: the job is
     abandoned, it says so on screen, and an authorised person can clear it and
     try again. The job is not deleted — the history is the point.

     Short on purpose. A Normal drape beats every few seconds, so a minute of
     silence is already conclusive. */
  lease: {
    /* Who is holding it — the browser run's own id, so two tabs cannot be
       mistaken for one. */
    runId: { type: String, trim: true, default: "" },
    heldBy: actorRef(),
    heartbeatAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },

  /* ── WHAT HAPPENED TO AN ABANDONED JOB ───────────────────────────────
     Recorded rather than inferred, so "this was cleared because its tab died"
     and "somebody pressed Stop" are different sentences afterwards. */
  recovery: {
    recoveredBy: actorRef(),
    recoveredAt: { type: Date, default: null },
    reason: { type: String, trim: true, default: "" },
  },

  requestedBy: actorRef(),
  startedAt: { type: Date, default: null },
  finishedAt: { type: Date, default: null },
  events: { type: [eventSchema], default: [] },
  revision: { type: Number, default: 0 },
}, { timestamps: true, collection: "rnd_render_jobs" });

renderJobSchema.index({ companyId: 1, styleId: 1, createdAt: -1 });
renderJobSchema.index({ companyId: 1, patternRevisionRef: 1 });
/* Finding the jobs whose lease has run out, which is what makes recovery cheap. */
renderJobSchema.index({ companyId: 1, status: 1, "lease.expiresAt": 1 });

module.exports = {
  REVISION_STATE, EDIT_KIND, RENDER_STATUS,
  ANCHOR_KIND, SYMMETRY, PIECE_LAYER, SEAM_ALIGNMENT, FABRIC_BEHAVIOUR, FABRIC_GRADE,
  PatternRevision: mongoose.models.PatternRevision
    || mongoose.model("PatternRevision", patternRevisionSchema),
  RenderJob: mongoose.models.RenderJob
    || mongoose.model("RenderJob", renderJobSchema),
};
