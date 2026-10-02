// test/rnd/fixtures/renderableTee.js
//
// A TEE THAT THE TEMPLATE ACTUALLY ACCEPTS.
//
// One definition, used by every R&D suite that needs a revision a drape can be
// requested from. Shared rather than copied because the previous version lived in
// two test files with slightly different contents, and the one that declared a
// pattern "renderable" whose seams named no edges at all was the copy nobody
// looked at twice.
//
// ── WHAT IT EXERCISES ON PURPOSE ────────────────────────────────────────────
// Four pieces, so `body.front`, `body.back` and two sleeves are all present and
// the template's required list is satisfied — except the neck finish, which is
// deliberately ABSENT so the default fixture is the §6.4 case: the drape runs as a
// Partial and the collar findings are withheld. `withNeckBand()` adds one.
//
// The armhole seams are COMPOUND: a sleeve cap sewn to the front armhole and then
// the back armhole, in order, from the underarm. That is the shape a contract
// pairing one run to one run cannot express, and the reason seam sides are
// sequences.
//
// Every length is chosen so the ease on each seam is inside the template's
// allowance: shoulders and sides match exactly, and the cap is 0.4% longer than
// the armhole it is sewn to.
"use strict";

/* ── THE PIECES ───────────────────────────────────────────────────────────
   Eight outline points on each body panel, so a seam can name part of an edge:
   with four corners a seam can only ever sew a whole side. Indices are what the
   mapping refers to and are therefore fixed by this list. */

/** 0 hem-R · 1 … · armpit-R 2 · shoulder-out-R 3 · neck-R 4 · neck-L 5 · shoulder-out-L 6 · armpit-L 7 */
const bodyOutline = (x, w, h) => [
  { x, y: 0 },                        /* 0 — hem, right end */
  { x: x + w, y: 0 },                 /* 1 — hem, left end */
  { x: x + w, y: h * 0.62 },          /* 2 — armpit */
  { x: x + w, y: h },                 /* 3 — shoulder point */
  { x: x + w * 0.70, y: h },          /* 4 — neck */
  { x: x + w * 0.30, y: h },          /* 5 — neck, other side */
  { x, y: h },                        /* 6 — shoulder point, other side */
  { x, y: h * 0.62 },                 /* 7 — armpit, other side */
];

/** 0 hem · 1 hem · 2 cap · 3 cap */
const sleeveOutline = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

const BODY_W = 560;
const BODY_H = 760;
/* 2 x 288.8 of armhole on the body; a 580 cap is 0.4% longer, inside the 5%. */
const SLEEVE_W = 580;
const SLEEVE_H = 240;

const piece = (ref, name, outline, over = {}) => ({
  pieceRef: ref,
  index: 0,
  name,
  generatedName: false,
  quantity: 1,
  componentClass: "shell",
  outline,
  outlineClosed: true,
  notches: [],
  internalLines: [],
  gradePoints: [],
  turnPoints: outline.map((p, i) => ({ ...p, index: i })),
  perimeter: outline.reduce((total, p, i) => {
    const q = outline[(i + 1) % outline.length];
    return total + Math.hypot(q.x - p.x, q.y - p.y);
  }, 0),
  /* Layer 7 is published on every piece of the real CLO export, so a derived
     grain vector is the normal case and the fixture matches it. */
  grainline: {
    from: { x: outline[0].x + 10, y: outline[0].y + 10 },
    to: { x: outline[0].x + 10, y: outline[0].y + 190 },
    length: 180,
    angleDegrees: 90,
  },
  seamAllowance: { value: 10, source: "parsed" },
  ...over,
});

/**
 * The parse, as `ingestPatternSet` would produce it.
 *
 * `over` may carry `withNeckBand`, or any patternSet field to replace outright —
 * `patternSet({ pieces: [] })` is how a suite asks for a pattern with nothing in
 * it. One level of nesting, because two is how a `{ pieces: [] }` override came
 * to be silently ignored and a test expecting a refusal passed instead.
 */
function patternSet(over = {}) {
  const { withNeckBand, ...rest } = over;
  const pieces = [
    piece("PC-FRONT", "Front", bodyOutline(0, BODY_W, BODY_H)),
    piece("PC-BACK", "Back", bodyOutline(700, BODY_W, BODY_H)),
    piece("PC-SLV-L", "Sleeve Left", sleeveOutline(0, 900, SLEEVE_W, SLEEVE_H)),
    piece("PC-SLV-R", "Sleeve Right", sleeveOutline(700, 900, SLEEVE_W, SLEEVE_H)),
  ];
  if (withNeckBand) {
    pieces.push(piece("PC-BAND", "Neck Band", sleeveOutline(1400, 900, 420, 40)));
  }
  return {
    patternSetRef: "PS-TEE",
    classification: "apparel_pattern_set",
    manifest: { styleName: "Tee", sampleSize: "M" },
    unit: "mm",
    unitSource: "header",
    unitInMm: 1,
    pieces,
    grading: { graded: false, sizes: [], sizeCount: 0, gradePointsPublished: false, pieces: [] },
    stats: { pieces: pieces.length, namedPieces: pieces.length, piecesWithOutline: pieces.length },
    ...rest,
  };
}

/* ── RUNS ─────────────────────────────────────────────────────────────────
   Anchored on turn points, which is what a template should prefer: a turn point
   usually survives a pattern edit and an arc-length fraction never does. */
const turn = (i) => ({ kind: "turn-point", pointIndex: i });
const run = (runId, from, to, role, lengthMm) => ({
  runId,
  startAnchor: turn(from),
  endAnchor: turn(to),
  direction: "forward",
  role,
  lengthMm,
});

const SIDE_LEN = BODY_H * 0.62;              /* 471.2 */
const ARMHOLE_LEN = BODY_H - BODY_H * 0.62;  /* 288.8 */
const SHOULDER_LEN = BODY_W * 0.30;          /* 168 */
const NECK_LEN = BODY_W * 0.40;              /* 224 */

const bodyRuns = () => [
  run("hem", 0, 1, "hem", BODY_W),
  run("side-r", 1, 2, "side", SIDE_LEN),
  run("armhole-r", 2, 3, "armhole.front", ARMHOLE_LEN),
  run("shoulder-r", 3, 4, "shoulder", SHOULDER_LEN),
  run("neck", 4, 5, "neck", NECK_LEN),
  run("shoulder-l", 5, 6, "shoulder", SHOULDER_LEN),
  run("armhole-l", 6, 7, "armhole.front", ARMHOLE_LEN),
  run("side-l", 7, 0, "side", SIDE_LEN),
];

const sleeveRuns = () => [
  run("hem", 0, 1, "sleeve.hem", SLEEVE_W),
  run("underarm-r", 1, 2, "underarm", SLEEVE_H),
  run("cap", 2, 3, "cap", SLEEVE_W),
  run("underarm-l", 3, 0, "underarm", SLEEVE_H),
];

const confirmed = () => ({ by: { id: "fixture", name: "A Patternmaker" }, at: new Date() });

const piecePlan = (pieceRef, role, over = {}) => ({
  pieceRef,
  role,
  roleConfirmed: confirmed(),
  cutQuantity: 1,
  symmetry: "single",
  layer: "shell",
  grainVector: [0, 1],
  grainSource: "marker-grainline",
  runs: bodyRuns(),
  /* One confirmation for the whole remaining perimeter — the hem and the neck on
     a body panel, the hem on a sleeve. Not one per edge. */
  boundaryConfirmed: confirmed(),
  seamAllowanceMm: 10,
  ...over,
});

const seam = (seamId, name, sideA, sideB, over = {}) => ({
  seamId,
  name,
  sideA,
  sideB,
  alignment: "start-to-start",
  alignmentConfirmed: confirmed(),
  confidence: "confirmed",
  seamType: "overlocked",
  ...over,
});

const at = (pieceRef, runId) => ({ pieceRef, runId });

/* ── A MEASURED JERSEY ────────────────────────────────────────────────────
   Every value the contract calls load-bearing, and `grade: measured`, so the
   fixture is not quietly exercising the estimated path. */
const JERSEY = Object.freeze({
  profileId: "FP-JERSEY-1",
  name: "Cotton jersey 180",
  appliesTo: [],
  behaviour: "knit",
  grade: "measured",
  source: "lab test on the actual cloth",
  measuredBy: "A Technologist",
  measuredAt: new Date("2026-09-01"),
  weightGsm: 180,
  thicknessMm: 0.62,
  collisionOffsetMm: 1.5,
  stretchWarpPercent: 60,
  stretchWeftPercent: 95,
  stretchLoadN: 5,
  shearStiffness: 0.2,
  bendingRigidity: 0.4,
  damping: 0.9,
  frictionBody: 0.5,
  frictionSelf: 0.45,
});

/**
 * Everything a drape needs, in the shape the record stores.
 *
 * @param {object} over  { withNeckBand, fabrics, seams, pieces, ... }
 */
function simulationInputs(over = {}) {
  const pieces = [
    piecePlan("PC-FRONT", "body.front"),
    piecePlan("PC-BACK", "body.back"),
    piecePlan("PC-SLV-L", "sleeve", { runs: sleeveRuns(), symmetry: "single" }),
    piecePlan("PC-SLV-R", "sleeve", { runs: sleeveRuns(), symmetry: "single" }),
  ];
  const seams = [
    seam("S-SH-R", "Right shoulder",
      [at("PC-FRONT", "shoulder-r")], [at("PC-BACK", "shoulder-l")]),
    seam("S-SH-L", "Left shoulder",
      [at("PC-FRONT", "shoulder-l")], [at("PC-BACK", "shoulder-r")]),
    seam("S-SIDE-R", "Right side seam",
      [at("PC-FRONT", "side-r")], [at("PC-BACK", "side-l")]),
    seam("S-SIDE-L", "Left side seam",
      [at("PC-FRONT", "side-l")], [at("PC-BACK", "side-r")]),
    /* ── THE COMPOUND ONES ────────────────────────────────────────────
       One cap run sewn to two body runs in order, from the underarm. */
    seam("S-ARM-R", "Right armhole",
      [at("PC-SLV-R", "cap")],
      [at("PC-FRONT", "armhole-r"), at("PC-BACK", "armhole-l")]),
    seam("S-ARM-L", "Left armhole",
      [at("PC-SLV-L", "cap")],
      [at("PC-FRONT", "armhole-l"), at("PC-BACK", "armhole-r")]),
  ];

  if (over.withNeckBand) {
    pieces.push(piecePlan("PC-BAND", "neck.band", {
      runs: [
        run("join", 0, 1, "join", 420),
        run("end-r", 1, 2, "fold", 40),
        run("outer", 2, 3, "outer", 420),
        run("end-l", 3, 0, "fold", 40),
      ],
      grainVector: [1, 0],
      grainSource: "stated",
      grainConfirmed: confirmed(),
    }));
    /* The band is 420 against a 448 neck opening — 6.7% stretched on, inside the
       25% a neck seam allows. */
    seams.push(seam("S-NECK", "Neckline",
      [at("PC-BAND", "join")],
      [at("PC-FRONT", "neck"), at("PC-BACK", "neck")]));
  }

  return {
    template: "tshirt",
    renderSize: "M",
    avatar: {
      name: "Male M",
      size: "M",
      measurements: { chestMm: 1000, waistMm: 880, shoulderMm: 450, heightMm: 1750, bicepMm: 320 },
      scaleVerifiedAgainst: "a measured sample front length",
    },
    pieces: over.pieces || pieces,
    seams: over.seams || seams,
    fabrics: over.fabrics || [JERSEY],
    seamAllowanceMm: over.seamAllowanceMm === undefined ? 10 : over.seamAllowanceMm,
    settings: { quality: "normal" },
    ...(over.inputs || {}),
  };
}

module.exports = {
  patternSet, simulationInputs, JERSEY,
  bodyOutline, sleeveOutline, bodyRuns, sleeveRuns, piecePlan, seam, run, turn, at, confirmed,
  BODY_W, BODY_H, SLEEVE_W, SLEEVE_H,
  SIDE_LEN, ARMHOLE_LEN, SHOULDER_LEN, NECK_LEN,
};
