// services/rnd/patternBundle.service.js
//
// THE TECHNICAL BUNDLE: A MODEL, A PATTERN AND A SOURCE THAT AGREE WITH EACH
// OTHER — OR SAY WHERE THEY DO NOT.
//
// ── WHY AGREEMENT IS THE WHOLE POINT ────────────────────────────────────────
// Three files describing one garment revision is a useful record. Three files
// describing two different garment revisions is worse than having none, because
// it looks exactly the same. A GLB draped at size M beside a pattern graded
// S–XL is fine and ordinary; a GLB exported from revision 2 beside a pattern
// exported from revision 3 is a bundle somebody will plan production against,
// and nothing about either file's appearance reveals it.
//
// So this module's job is narrow and it is not parsing: it holds the parsed
// pattern, checks the three files against each other, and separates what it
// finds into things that must block a publication from things that are merely
// worth saying. Nothing here guesses, and nothing here silently reconciles two
// files that disagree.
//
// ── THE THREE GRADES OF FINDING, AND WHY THEY ARE NOT ONE LIST ──────────────
// A single list of "problems" trains people to approve past all of them. The
// brief asks for three and the distinction is real:
//
//   BLOCKING         the bundle is internally inconsistent or unreadable. A
//                    publication carrying this cannot be approved, because
//                    somebody downstream would act on a contradiction.
//   NEEDS REVIEW     a person has to look. Usually a missing fact that matters
//                    for this garment and might not for another — no notches on
//                    a knit tee is ordinary, on a tailored jacket it is not,
//                    and this module does not know which it is looking at.
//   INFORMATIONAL    true, worth recording, and nobody has to act.
//
// Optional metadata being absent is never blocking. The brief is explicit about
// that and it is also just correct: a sample-size DXF with no grading is a
// legitimate thing to publish, and refusing it would make the workspace unable
// to hold the most common artifact R&D produces.
"use strict";

const crypto = require("crypto");

const {
  PATTERN_CLASSIFICATION, MAPPING_STATE, ASSET_KIND,
} = require("../../models/CMS_Models/RnD/GarmentModel");
const { UNIT_IN_MM, projectOnSegment } = require("../../utils/dxfInspect");
const mapping = require("./patternMapping.service");
const { fail } = require("../storePurchase/errors");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

/* ═══ LIMITS ═══════════════════════════════════════════════════════════════
 *
 * ── THE ONE THAT IS NOT ABOUT ABUSE ─────────────────────────────────────────
 * `STORED_VERTICES` exists because of MongoDB's 16MB document ceiling, and the
 * pattern set is embedded. A fully graded production pattern — forty pieces
 * across eight sizes, every outline at a hundred-odd points — is comfortably
 * inside it. A whole size range of a tailored garment with internal
 * construction on every piece is not, and the failure mode without this limit
 * is a write that succeeds for months and then starts rejecting the document
 * whole, losing the upload with a driver error nobody can act on.
 *
 * So it is refused at the door, with the fix named: export the sizes you need.
 * The alternative — silently dropping geometry — would produce a pattern set
 * that renders, measures and is wrong.
 */
const LIMITS = Object.freeze({
  PATTERN_BYTES: 40 * 1024 * 1024,
  STORED_VERTICES: 250_000,
  PIECES: 2000,
});

/* ═══ INGESTING A PARSED PATTERN ═══════════════════════════════════════════ */

/**
 * Turn an `inspectDxf` read into the record that gets stored.
 *
 * @param {object} read          what `inspectDxf` returned
 * @param {object} file          the multer file, for name, size and hash
 * @param {object} actor         who published it
 * @param {number} parseRevision 1 on a first upload, incremented on replacement
 */
function ingestPatternSet(read, { file, actor = null, parseRevision = 1 } = {}) {
  if (read.stats.pieces > LIMITS.PIECES) {
    throw fail("PATTERN_TOO_LARGE",
      `This pattern contains ${read.stats.pieces} pieces and the workspace stores ${LIMITS.PIECES}. `
      + "Export one size range at a time.",
      { pieces: read.stats.pieces, limit: LIMITS.PIECES });
  }
  if (read.stats.vertices > LIMITS.STORED_VERTICES) {
    throw fail("PATTERN_TOO_LARGE",
      `This pattern's outlines carry ${read.stats.vertices.toLocaleString()} points and the workspace `
      + `stores ${LIMITS.STORED_VERTICES.toLocaleString()}. Export fewer sizes in one file — the pieces `
      + "are kept whole rather than simplified, so the limit is on the whole set.",
      { vertices: read.stats.vertices, limit: LIMITS.STORED_VERTICES });
  }

  const pieces = read.pieces.map((piece, index) => ({
    ...piece,
    pieceRef: mapping.mintPieceRef(piece, index),
    index,
    /* Mongoose treats an explicit `null` on an array path as a cast error, so
       the two optional outline paths are omitted rather than nulled. */
    sewLine: piece.sewLine || undefined,
    mirrorLine: piece.mirrorLine || undefined,
    approximated: piece.approximated || "",
    insertCount: piece.insertCount ?? null,
  }));

  return {
    patternSetRef: `PS-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
    classification: read.apparel ? PATTERN_CLASSIFICATION.APPAREL : PATTERN_CLASSIFICATION.GENERIC,
    manifest: read.manifest,
    unit: read.unit,
    unitSource: read.unitSource,
    unitDeclared: read.unitDeclared,
    unitInMm: read.unitInMm,
    pieces,
    grading: read.grading,
    stats: read.stats,
    bounds: read.bounds,
    conventions: read.conventions,
    layersSeen: read.layersSeen,
    warnings: read.warnings,
    sha256: file?.buffer ? sha256(file.buffer) : "",
    fileName: str(file?.originalname),
    publishedBy: actor ? { id: str(actor.id), name: str(actor.name), email: str(actor.email) } : {},
    publishedAt: new Date(),
    parseRevision,
  };
}

/* ═══ DO THE BUNDLE'S FILES DESCRIBE THE SAME GARMENT? ═════════════════════ */

/**
 * Everything the three files say that contradicts each other.
 *
 * ── WHY THIS IS RECOMPUTED AND STORED, NOT DERIVED ON READ ──────────────────
 * Stored, because the person who publishes is not the person who later reads,
 * and a warning that only existed at upload time is a warning nobody sees.
 * Recomputed whenever a file changes, because a mismatch that was resolved by
 * replacing the pattern must stop being reported — a stale warning is as
 * corrosive to trust as a missing one.
 */
function bundleCoherence(row) {
  const out = [];
  const pattern = row.patternSet || null;
  const modelAsset = (row.assets || []).find((a) => a.kind === ASSET_KIND.WEB_MODEL) || null;
  const patternAsset = (row.assets || []).find((a) => a.kind === ASSET_KIND.PATTERN) || null;
  const sourceAsset = (row.assets || []).find((a) => a.kind === ASSET_KIND.SOURCE) || null;

  /* ── 1. THE TWO FILES NAME DIFFERENT REVISIONS ─────────────────────────
     The most expensive mismatch there is, and the only one that is blocking:
     every number a reader takes off this bundle would be a mix of two
     garments. Compared only when BOTH were stated — an unstated revision is a
     different and milder finding, below. */
  const modelRevision = str(row.declaredModelRevision);
  const patternRevision = str(row.declaredPatternRevision);
  if (modelRevision && patternRevision
      && modelRevision.toLowerCase() !== patternRevision.toLowerCase()) {
    out.push({
      code: "BUNDLE_REVISION_MISMATCH",
      severity: "blocking",
      message: `The 3D model is from revision ${modelRevision} and the pattern from revision `
        + `${patternRevision}, so this bundle describes two different garments. Publish a bundle whose `
        + "files come from one revision, or correct whichever revision was stated wrongly.",
      details: { modelRevision, patternRevision },
    });
  }

  /* ── 2. THE UNITS DISAGREE ─────────────────────────────────────────────
     Also blocking. A pattern in inches beside a model declared in millimetres
     means every cross-check between them is out by 25.4, and a measurement
     taken in one and compared against the other is simply wrong. */
  const modelUnit = str(row.manifest?.unit);
  const patternUnit = str(pattern?.unit);
  if (modelUnit && patternUnit && modelUnit !== patternUnit) {
    /* Unless they are the same physical length expressed differently, which
       they are not here but could be in a future unit set. */
    const sameLength = UNIT_IN_MM[modelUnit] && UNIT_IN_MM[modelUnit] === UNIT_IN_MM[patternUnit];
    if (!sameLength) {
      out.push({
        code: "BUNDLE_UNIT_MISMATCH",
        severity: "blocking",
        message: `The 3D model is declared in ${modelUnit} and the pattern publishes ${patternUnit}, so `
          + "lengths taken from one cannot be compared with the other. Correct the declared model unit, "
          + "or re-export the pattern in the model's unit.",
        details: { modelUnit, patternUnit, patternUnitSource: str(pattern?.unitSource) },
      });
    }
  }

  /* ── 3. THE SIZES DISAGREE ─────────────────────────────────────────────
     Needs review rather than blocking, and the distinction is the point: a
     model draped at M beside a pattern graded S–XL is correct and normal. What
     is worth a look is a model draped at a size the pattern does not contain,
     because then there is no pattern for the garment that was modelled. */
  const modelSize = str(row.modelSize);
  const patternSizes = (pattern?.grading?.sizes || []).map(str).filter(Boolean);
  if (modelSize && patternSizes.length
      && !patternSizes.some((size) => size.toLowerCase() === modelSize.toLowerCase())) {
    out.push({
      code: "BUNDLE_SIZE_MISMATCH",
      severity: "needs_review",
      message: `The 3D garment was built at size ${modelSize} and the pattern publishes `
        + `${patternSizes.join(", ")}. There is no pattern in this bundle for the size that was modelled, `
        + "so a measurement from the model has nothing in the pattern to be checked against.",
      details: { modelSize, patternSizes },
    });
  }

  /* ── 4. ONE FILE WAS UPDATED WITHOUT THE OTHERS ────────────────────────
     Detected from the per-asset upload times rather than inferred, and only
     once the gap is big enough to be a separate act. Needs review: replacing a
     pattern on a draft to fix a notch is ordinary work, and the point is that
     the model may now be the older of the two. */
  const stamps = [
    { what: "3D model", at: modelAsset?.uploadedAt || null },
    { what: "pattern", at: patternAsset?.uploadedAt || pattern?.publishedAt || null },
    { what: "CLO source", at: sourceAsset?.uploadedAt || null },
  ].filter((entry) => entry.at);
  if (stamps.length > 1) {
    const times = stamps.map((entry) => new Date(entry.at).getTime()).filter(Number.isFinite);
    const spread = Math.max(...times) - Math.min(...times);
    const SEPARATE_ACT_MS = 10 * 60 * 1000;
    if (spread > SEPARATE_ACT_MS) {
      const newest = stamps.reduce((a, b) =>
        (new Date(a.at).getTime() > new Date(b.at).getTime() ? a : b));
      const oldest = stamps.reduce((a, b) =>
        (new Date(a.at).getTime() < new Date(b.at).getTime() ? a : b));
      out.push({
        code: "BUNDLE_FILES_OUT_OF_STEP",
        severity: "needs_review",
        message: `The ${newest.what} was uploaded ${describeGap(spread)} after the ${oldest.what}, so `
          + "they may not come from the same export. Check that every file in this bundle is from the "
          + "same revision before it is approved.",
        details: { newest: newest.what, oldest: oldest.what, spreadMs: spread },
      });
    }
  }

  /* ── 5. A REVISION NOBODY STATED ───────────────────────────────────────
     Informational. Most bundles do not state one and are perfectly usable; what
     is lost is the ability to DETECT finding 1, and saying so is more useful
     than demanding a field. */
  if (pattern && (!modelRevision || !patternRevision)) {
    out.push({
      code: "BUNDLE_REVISION_UNSTATED",
      severity: "informational",
      message: "This bundle does not state which export revision its model and pattern came from, so a "
        + "mismatch between them cannot be detected automatically. State both to have it checked.",
      details: { modelRevision, patternRevision },
    });
  }

  /* ── 6. A BUNDLE WITH NO PATTERN AT ALL ────────────────────────────────
     Informational, deliberately. Many styles have a 3D model before the pattern
     is drafted, and refusing that would make the workspace unable to hold the
     normal order of work. */
  if (!pattern) {
    out.push({
      code: "BUNDLE_NO_PATTERN",
      severity: "informational",
      message: "No flat pattern is attached to this bundle, so there are no cut pieces, no grading and "
        + "nothing to map to the 3D components. The model can still be annotated and measured.",
    });
  } else if (pattern.classification === PATTERN_CLASSIFICATION.GENERIC) {
    out.push({
      code: "BUNDLE_PATTERN_IS_GENERIC_DXF",
      severity: "needs_review",
      message: "The attached DXF is readable CAD geometry but not an apparel pattern set: it publishes no "
        + "piece names, sizes, quantities, grainlines or notches. It can be viewed and measured, and it "
        + "must not be read as a cut-ready pattern.",
    });
  }

  return out;
}

const describeGap = (ms) => {
  const minutes = Math.round(ms / 60000);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
};

/* ═══ DERIVED TECHNICAL CHECKS ═════════════════════════════════════════════ */

/**
 * WHAT THE VERIFIED DATA SAYS IS WRONG, SEPARATED BY WHETHER IT BLOCKS.
 *
 * ── THE RULE EVERY CHECK HERE OBEYS ─────────────────────────────────────────
 * A check reports only what the files actually published. There is no check in
 * here that fires because a value is missing and the checker assumed a default,
 * and no check that fails a publication for lacking optional metadata. The
 * difference between "this pattern has no notches" and "this pattern is
 * wrong" is the difference between a workspace people use and one they
 * route around.
 */
function derivedChecks(row, mappingState = null, coherence = null) {
  const pattern = row.patternSet || null;
  const findings = [];
  const add = (severity, code, message, details) =>
    findings.push({ severity, code, message, details: details || {} });

  /* Computed here when the caller did not, so there is no path that produces an
     `approvable` answer without the bundle's own mismatches in it. */
  const bundle = Array.isArray(coherence) ? coherence : bundleCoherence(row);

  if (!pattern) {
    for (const finding of bundle) {
      findings.push({
        severity: finding.severity || "needs_review",
        code: finding.code, message: finding.message, details: finding.details || {},
      });
    }
    return group(findings);
  }
  const pieces = pattern.pieces || [];

  /* ── IDENTITY ─────────────────────────────────────────────────────────── */

  const unnamed = pieces.filter((p) => !p.name || p.generatedName);
  if (unnamed.length) {
    add("needs_review", "PIECES_UNNAMED",
      `${unnamed.length} of ${pieces.length} pieces carry an exporter-generated identifier rather than a `
      + "name a patternmaker chose. The pieces are complete and measurable; what cannot be done is "
      + "matching them to garment components by name.",
      { pieceRefs: unnamed.map((p) => p.pieceRef).slice(0, 50) });
  }

  /* ── DUPLICATE IDS ARE BLOCKING, AND THE ONLY NAME CHECK THAT IS ───────
     Two pieces publishing one identifier means every mapping, measurement and
     IE reference that quotes it is ambiguous, and nothing downstream can
     detect which one it got. */
  const byPublishedId = new Map();
  for (const piece of pieces) {
    const id = str(piece.publishedId);
    if (!id) continue;
    byPublishedId.set(id, (byPublishedId.get(id) || 0) + 1);
  }
  const duplicated = [...byPublishedId.entries()].filter(([, count]) => count > 1);
  if (duplicated.length) {
    add("blocking", "PIECE_IDS_DUPLICATED",
      `${duplicated.length} piece ${duplicated.length === 1 ? "identifier is" : "identifiers are"} used `
      + `by more than one piece (${duplicated.map(([id]) => id).join(", ")}). A reference to one of them `
      + "cannot say which piece it means.",
      { ids: duplicated.map(([id, count]) => ({ id, count })) });
  }

  /* ── GEOMETRY ─────────────────────────────────────────────────────────── */

  const malformed = pieces.filter((p) => (p.outline || []).length < 3);
  if (malformed.length) {
    add("blocking", "PIECE_OUTLINE_MALFORMED",
      `${malformed.length} piece${malformed.length === 1 ? " has" : "s have"} no usable closed outline, `
      + "so it cannot be cut, measured or shown.",
      { pieceRefs: malformed.map((p) => p.pieceRef) });
  }
  const open = pieces.filter((p) => (p.outline || []).length >= 3 && !p.outlineClosed);
  if (open.length) {
    add("needs_review", "PIECE_OUTLINE_NOT_CLOSED",
      `${open.length} piece outline${open.length === 1 ? " is" : "s are"} not closed in the file. The area `
      + "and perimeter are computed as though the last point joins the first, which may not be what was "
      + "drafted.",
      { pieceRefs: open.map((p) => p.pieceRef) });
  }

  /* ── CONSTRUCTION FACTS THE FILE DID NOT PUBLISH ───────────────────────
     All needs-review or informational. None of them is evidence of an error —
     each is a fact a reader must not assume is present. */

  const noGrain = pieces.filter((p) => !p.grainline);
  if (noGrain.length) {
    add(noGrain.length === pieces.length ? "needs_review" : "needs_review", "PIECES_NO_GRAINLINE",
      `${noGrain.length} of ${pieces.length} pieces publish no grainline, so those pieces carry no cut `
      + "direction. A piece cut off-grain hangs wrong and cannot be corrected after cutting.",
      { pieceRefs: noGrain.map((p) => p.pieceRef).slice(0, 50) });
  }

  const noQuantity = pieces.filter((p) => p.quantity === null || p.quantity === undefined);
  if (noQuantity.length) {
    add("needs_review", "PIECES_NO_QUANTITY",
      `${noQuantity.length} of ${pieces.length} pieces publish no cut quantity. It is unpublished rather `
      + "than one — a cutting room cannot tell from this file how many of each to cut.",
      { pieceRefs: noQuantity.map((p) => p.pieceRef).slice(0, 50) });
  }

  const noNotches = pieces.filter((p) => !(p.notches || []).length);
  if (noNotches.length === pieces.length && pieces.length) {
    add("needs_review", "PIECES_NO_NOTCHES",
      "No piece in this pattern publishes a notch, so there is no registration between pieces for a "
      + "sewing operator to align to. Ordinary on a simple knit; on a set-in sleeve or a tailored "
      + "garment it is a gap.");
  } else if (noNotches.length) {
    add("informational", "SOME_PIECES_NO_NOTCHES",
      `${noNotches.length} of ${pieces.length} pieces publish no notches.`,
      { pieceRefs: noNotches.map((p) => p.pieceRef).slice(0, 50) });
  }

  const noAllowance = pieces.filter((p) => !p.seamAllowance);
  if (noAllowance.length === pieces.length && pieces.length) {
    add("needs_review", "SEAM_ALLOWANCE_UNPUBLISHED",
      "This pattern publishes one outline per piece and no separate sewing line, so the seam allowance "
      + "is unpublished. It is not zero and it cannot be read from this file — export the sew line "
      + "(AAMA layer 14) beside the cut line to carry it.");
  }

  /* ── PAIRING ──────────────────────────────────────────────────────────
     Two pieces with the same name and no stated side, or a stated side with no
     counterpart. Reported, never corrected: this module cannot know whether a
     single sleeve is an error or a piece cut twice from one draft. */
  const sides = new Map();
  for (const piece of pieces) {
    const side = mapping.sideOf(piece.name);
    if (!side) continue;
    const base = mapping.normaliseName(piece.name).replace(/\b(left|right|lh|rh|l|r)\b/g, "").trim();
    const entry = sides.get(base) || { left: [], right: [] };
    entry[side].push(piece);
    sides.set(base, entry);
  }
  const unpaired = [...sides.entries()]
    .filter(([, entry]) => Boolean(entry.left.length) !== Boolean(entry.right.length))
    .map(([base, entry]) => ({
      base,
      has: entry.left.length ? "left" : "right",
      pieceRefs: [...entry.left, ...entry.right].map((p) => p.pieceRef),
    }));
  if (unpaired.length) {
    add("needs_review", "PIECES_UNPAIRED",
      `${unpaired.length} piece${unpaired.length === 1 ? "" : "s"} name${unpaired.length === 1 ? "s" : ""} `
      + `a side with no counterpart in the pattern (${unpaired.map((u) => `${u.base} ${u.has}`).join(", ")}). `
      + "Either the other half is missing, or the piece is cut twice and mirrored and the file does not "
      + "say so.",
      { unpaired });
  }

  /* ── UNITS AND SCALE ──────────────────────────────────────────────────── */

  if (!pattern.unit) {
    add("needs_review", "PATTERN_UNIT_UNPUBLISHED",
      "This pattern states no unit, so every length in it is in drawing units and nothing has been "
      + "converted. Areas and distances stay unscaled until somebody states what one unit is.");
  }

  /* An apparel pattern whose pieces are implausible at the declared unit. A
     front bodice 0.9 units across in millimetres is a pattern drawn in
     centimetres and labelled wrongly, and it is worth catching because every
     derived number is then out by ten. */
  if (pattern.unit && pattern.unitInMm) {
    const widest = Math.max(0, ...pieces.map((p) => p.width || 0));
    const widestMm = widest * pattern.unitInMm;
    if (widest > 0 && widestMm < 40) {
      add("blocking", "PATTERN_SCALE_IMPLAUSIBLE",
        `The largest piece in this pattern is ${widestMm.toFixed(1)}mm across at the declared unit of `
        + `${pattern.unit}. No garment piece is that small, so the declared unit or the drawing scale is `
        + "wrong, and every measurement derived from this pattern would be wrong with it.",
        { widest, unit: pattern.unit, widestMm });
    } else if (widest > 0 && widestMm > 5000) {
      add("needs_review", "PATTERN_SCALE_IMPLAUSIBLE",
        `The largest piece in this pattern is ${(widestMm / 1000).toFixed(2)}m across at the declared unit `
        + `of ${pattern.unit}, which is larger than any garment piece. Check the declared unit.`,
        { widest, unit: pattern.unit, widestMm });
    }
  }

  /* ── GRADING ──────────────────────────────────────────────────────────── */

  if (pattern.grading?.graded) {
    /* A piece that exists at some sizes and not others. Reported as a gap in
       the range rather than as a count, because the missing size is the fact. */
    const allSizes = new Set((pattern.grading.sizes || []).map(str));
    const bySetName = new Map();
    for (const piece of pieces) {
      const key = mapping.normaliseName(piece.name || piece.blockName)
        .replace(new RegExp(`\\b${escapeRe(str(piece.size).toLowerCase())}\\b`, "g"), "").trim();
      const entry = bySetName.get(key) || new Set();
      if (piece.size) entry.add(str(piece.size));
      bySetName.set(key, entry);
    }
    const gaps = [...bySetName.entries()]
      .map(([key, found]) => ({
        piece: key,
        missing: [...allSizes].filter((size) => !found.has(size)),
      }))
      .filter((entry) => entry.missing.length && entry.missing.length < allSizes.size);
    if (gaps.length) {
      add("needs_review", "GRADING_INCOMPLETE",
        `${gaps.length} piece${gaps.length === 1 ? "" : "s"} are not present at every size this pattern `
        + "publishes, so the range has gaps. A size with a missing piece cannot be cut.",
        { gaps: gaps.slice(0, 50) });
    }
  } else if (pattern.classification === PATTERN_CLASSIFICATION.APPAREL) {
    add("informational", "PATTERN_NOT_GRADED",
      `This pattern publishes ${pattern.grading?.sizeCount || 0} size`
      + `${(pattern.grading?.sizeCount || 0) === 1 ? "" : "s"}, so it is a sample pattern rather than a `
      + "graded range. Grading is absent from the file, not computed and withheld.");
  }

  /* ── ARTWORK OUTSIDE ITS PIECE ────────────────────────────────────────
     An internal line, drill point or placement mark whose coordinates fall
     outside the outline it was published inside. Almost always a layer
     assigned to the wrong block, and it means a print lands off the panel. */
  const strays = [];
  for (const piece of pieces) {
    if (!piece.bounds) continue;
    /* ── MEASURED AGAINST A REAL EXPORT, TWICE, BEFORE IT WAS RIGHT ─────
       This check asks whether a mark was published against the wrong piece. Two
       earlier versions of it were wrong about a genuine CLO export instead.
       A fixed epsilon flagged any mark extending past the bounding box: three of
       five pieces, because CLO extends an internal construction line past the
       edge so a cutter can see where it runs. Requiring the mark to be WHOLLY
       outside still flagged two, and measuring them explained it — they are
       full-width lines sitting exactly 0.7874in (20.0mm) below each bodice hem,
       which is CLO publishing the hem allowance just outside the cut line.
       Both are deliberate drafting conventions.
       What they have in common is that they are ADJACENT to the piece: 20mm is
       2.8% of that bodice's 28.41in. A mark assigned to the wrong block is not
       adjacent to anything — it sits where its real piece sits, a piece-width
       or more away. So the test is distance, normalised by the piece's own size,
       and ten percent separates the two cases by more than an order of
       magnitude in both directions. */
    const scale = Math.max(piece.width || 0, piece.height || 0) || 1;
    const ADJACENT_FRACTION = 0.1;
    const slack = Math.max(0.01, scale * ADJACENT_FRACTION);
    /* How far outside the piece a point is; 0 when it is inside. */
    const outsideBy = (p) => Math.max(
      0,
      piece.bounds.minX - p.x, p.x - piece.bounds.maxX,
      piece.bounds.minY - p.y, p.y - piece.bounds.maxY,
    );
    const strayed = (points) => points.length > 0 && points.every((p) => outsideBy(p) > slack);
    const strayLines = (piece.internalLines || []).filter((line) => strayed(line.points || []));
    const strayDrills = (piece.drillPoints || []).filter((d) => strayed([d]));
    if (strayLines.length || strayDrills.length) {
      strays.push({
        pieceRef: piece.pieceRef, pieceName: piece.name,
        internalLines: strayLines.length, drillPoints: strayDrills.length,
      });
    }
  }
  if (strays.length) {
    add("needs_review", "MARKS_OUTSIDE_PIECE",
      `${strays.length} piece${strays.length === 1 ? " has" : "s have"} internal lines or drill points `
      + "that lie entirely outside the piece outline, so they were published against the wrong piece. A "
      + "placement mark off its panel puts a print, a pocket or a drill hole off the cloth.",
      { strays });
  }

  /* ── CORRESPONDENCE WITH THE 3D MODEL ─────────────────────────────────
     Only computed where a mapping pass has run. The severity is needs-review
     and never blocking: an unmapped piece is a piece nobody has matched yet,
     which is a state every bundle passes through. */
  if (mappingState) {
    const unmappedPieces = mappingState.unmapped || [];
    if (unmappedPieces.length) {
      add("needs_review", "PIECES_WITHOUT_3D_MATCH",
        `${unmappedPieces.length} of ${pieces.length} pattern pieces have no 3D component matched to `
        + `them. ${mappingState.availability?.limitation
          || "Confirm each one against the model, or record that it has no separate component."}`,
        { pieceRefs: unmappedPieces.map((u) => u.pieceRef) });
    }
    const unmatched = mappingState.unmatchedComponents || [];
    if (unmatched.length) {
      add("informational", "COMPONENTS_WITHOUT_2D_MATCH",
        `${unmatched.length} named 3D component${unmatched.length === 1 ? "" : "s"} have no pattern piece `
        + `matched to them (${unmatched.slice(0, 5).map((c) => c.nodeName).join(", ")}`
        + `${unmatched.length > 5 ? ", …" : ""}). Trims, bindings and merged geometry legitimately have `
        + "none.",
        { components: unmatched.slice(0, 50) });
    }
    const unconfirmed = (mappingState.mappings || [])
      .filter((m) => m.state === MAPPING_STATE.UNCONFIRMED);
    if (unconfirmed.length) {
      add("needs_review", "MAPPINGS_UNCONFIRMED",
        `${unconfirmed.length} piece-to-component ${unconfirmed.length === 1 ? "match has" : "matches have"} `
        + "been proposed and not confirmed by anybody. A proposed match is not a mapping and is not "
        + "handed to Industrial Engineering.",
        { pieceRefs: unconfirmed.map((m) => m.pieceRef) });
    }
  }

  /* ── THE PARSER'S OWN WARNINGS, FOLDED IN WITHOUT BEING SAID TWICE ─────
     One list answers "what is wrong with this bundle" rather than two that have
     to be read together. But several parser warnings are the SAME finding a
     check above already made at a properly judged severity — the parser says
     "no notches in this file", the check says "no piece publishes a notch, and
     here is when that matters. A reader seeing both learns nothing from the
     second and trusts the list less for repeating itself, so the weaker
     statement is dropped and the judged one kept. */
  const ALREADY_SAID = Object.freeze({
    PATTERN_PIECES_UNNAMED: "PIECES_UNNAMED",
    PATTERN_NO_NOTCHES: "PIECES_NO_NOTCHES",
    PATTERN_NO_SEAM_ALLOWANCE: "SEAM_ALLOWANCE_UNPUBLISHED",
    PATTERN_NO_GRAINLINE: "PIECES_NO_GRAINLINE",
    PATTERN_UNIT_UNPUBLISHED: "PATTERN_UNIT_UNPUBLISHED",
  });
  for (const warning of (pattern.warnings || [])) {
    const supersededBy = ALREADY_SAID[warning.code];
    if (supersededBy && findings.some((f) => f.code === supersededBy)) continue;
    if (findings.some((f) => f.code === warning.code)) continue;
    /* An approximated outline is the one parser warning that changes what a
       number may be trusted for, so it is a review item rather than a note. */
    add(warning.code === "PATTERN_SPLINE_APPROXIMATED" ? "needs_review" : "informational",
      warning.code, warning.message);
  }

  /* ── AND THE BUNDLE'S OWN MISMATCHES, IN THE SAME LIST ─────────────────
     Merged here rather than kept beside, because `approvable` has to account
     for them: a bundle whose files name two different revisions is exactly
     what must not be approved, and a reviewer reading two separate lists is a
     reviewer who will approve past one of them. */
  for (const finding of bundle) {
    if (findings.some((f) => f.code === finding.code)) continue;
    findings.push({
      severity: finding.severity || "needs_review",
      code: finding.code,
      message: finding.message,
      details: finding.details || {},
    });
  }

  return group(findings);
}

const escapeRe = (v) => str(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The three lists, plus the one question a lifecycle actually asks.
 *
 * `approvable` is the whole reason this is grouped: a reviewer needs one answer
 * to "can I accept this", and it must be computed from the severities rather
 * than from a reviewer's reading of a long list.
 */
function group(findings) {
  const blocking = findings.filter((f) => f.severity === "blocking");
  const needsReview = findings.filter((f) => f.severity === "needs_review");
  const informational = findings.filter((f) => f.severity === "informational");
  return {
    blocking,
    needsReview,
    informational,
    counts: {
      blocking: blocking.length,
      needsReview: needsReview.length,
      informational: informational.length,
    },
    approvable: blocking.length === 0,
  };
}

/* ═══ WHAT CAN BE MEASURED, AND WHAT IT MUST NOT BE CALLED ═════════════════ */

/**
 * The figures a verified pattern genuinely supports.
 *
 * ── THE ONE NAMING RULE THAT MATTERS MOST IN THIS FILE ──────────────────────
 * `totalNetArea` is NOT fabric consumption and is never labelled as such.
 * The net area of the pieces is a lower bound that no real cutting operation
 * ever achieves, and the gap between it and the truth is large — the marker
 * arrangement, the fabric width, grain and nap constraints, pattern matching,
 * piece spacing, shrinkage, fabric defects and end loss. A costing taken from
 * net area is wrong by a margin that depends on all of those, and is wrong in
 * the direction that loses money.
 *
 * So the field is named for what it is, it carries its own disclaimer in the
 * payload, and the honest consumer of it is the marker-making system — which
 * gets the verified geometry as INPUT and does the nesting itself.
 */
function patternMeasurements(pattern) {
  if (!pattern) return null;
  const pieces = pattern.pieces || [];
  const unit = str(pattern.unit);
  const inMm = pattern.unitInMm || null;

  /* ── SCALE IS VERIFIED OR IT IS NOT, AND NOTHING IN BETWEEN ───────────
     Every converted figure below exists only when the file stated a unit. A
     reader of an unscaled pattern gets drawing units, labelled as such, which
     is the same discipline the 3D measurements already follow. */
  const verified = Boolean(unit && inMm);
  const toMm = (value) => (verified && value !== null && value !== undefined
    ? Number((value * inMm).toFixed(3)) : null);
  const toMm2 = (value) => (verified && value !== null && value !== undefined
    ? Number((value * inMm * inMm).toFixed(2)) : null);

  const byMaterial = new Map();
  const byComponentClass = new Map();
  for (const piece of pieces) {
    /* Quantity is unpublished on most pieces, and multiplying by an assumed 1
       would present a per-cut total nobody stated. So the area totals are the
       area of the DRAFTED pieces, and the quantity-weighted total is offered
       separately and only where every piece published one. */
    const key = str(piece.material) || "(not published)";
    byMaterial.set(key, (byMaterial.get(key) || 0) + (piece.area || 0));
    const cls = str(piece.componentClass) || "(not published)";
    byComponentClass.set(cls, (byComponentClass.get(cls) || 0) + (piece.area || 0));
  }

  const everyQuantityPublished = pieces.length > 0
    && pieces.every((p) => p.quantity !== null && p.quantity !== undefined);
  const drafted = pieces.reduce((sum, p) => sum + (p.area || 0), 0);
  const weighted = everyQuantityPublished
    ? pieces.reduce((sum, p) => sum + ((p.area || 0) * p.quantity), 0)
    : null;

  return {
    unit: verified ? unit : "drawing units",
    scaleVerified: verified,
    unitSource: str(pattern.unitSource),

    pieces: pieces.map((piece) => ({
      pieceRef: piece.pieceRef,
      name: piece.name,
      size: piece.size,
      width: piece.width, height: piece.height,
      area: piece.area, perimeter: piece.perimeter,
      widthMm: toMm(piece.width), heightMm: toMm(piece.height),
      perimeterMm: toMm(piece.perimeter), areaMm2: toMm2(piece.area),
      /* Distance between consecutive notches along the outline — the figure a
         sewing operator's registration depends on. Only where there are two. */
      notchSpacing: notchSpacing(piece),
      approximated: str(piece.approximated) || null,
    })),

    /* ── TOTALS, NAMED FOR WHAT THEY ARE ───────────────────────────────── */
    totalNetArea: Number(drafted.toFixed(4)),
    totalNetAreaMm2: toMm2(drafted),
    /* Only when every piece said how many. Null is "the file did not say",
       never an assumed one-of-each. */
    totalNetAreaByQuantity: weighted === null ? null : Number(weighted.toFixed(4)),
    totalNetAreaByQuantityMm2: toMm2(weighted),
    quantityPublishedForEveryPiece: everyQuantityPublished,

    byMaterial: [...byMaterial.entries()].map(([material, area]) => ({
      material, area: Number(area.toFixed(4)), areaMm2: toMm2(area),
    })),
    byComponentClass: [...byComponentClass.entries()].map(([componentClass, area]) => ({
      componentClass, area: Number(area.toFixed(4)), areaMm2: toMm2(area),
    })),

    /* The increments between sizes, straight from the parse. Empty on an
       ungraded file, which is a statement about the file. */
    grading: pattern.grading?.pieces || [],

    /* ── SAID IN THE PAYLOAD, NOT ONLY ON THE SCREEN ───────────────────
       A consumer reading this API must not be able to mistake net area for
       consumption, and a disclaimer that lives only in a React component is one
       the next consumer never sees. */
    netAreaIsNotConsumption:
      "This is the net area of the drafted pieces. It is not fabric consumption: the quantity a "
      + "garment really takes also depends on fabric width, marker arrangement, grain and nap, "
      + "matching constraints, piece spacing, shrinkage, fabric defects and end loss. Consumption is "
      + "the marker-making system's answer, computed from this geometry as its input.",
  };
}

/**
 * How far apart consecutive notches are, measured ALONG the outline.
 *
 * Along rather than across, because a sewing operator walks the edge: the
 * straight-line distance between two notches either side of an armhole curve is
 * materially shorter than the cloth between them, and it is the cloth that has
 * to match the piece it is joined to.
 */
function notchSpacing(piece) {
  const notches = piece.notches || [];
  const outline = piece.outline || [];
  if (notches.length < 2 || outline.length < 3) return [];

  /* ── EACH NOTCH'S POSITION AS ARC LENGTH AROUND THE OUTLINE ─────────────
     Projected onto the nearest EDGE and interpolated along it, not snapped to
     the nearest vertex. An earlier version snapped, on the reasoning that an
     apparel outline is published at a hundred-odd points so a vertex is a
     fraction of a millimetre of arc — true of the CLO exports read here, and
     wrong in general. On a four-point rectangle two notches 80 apart on one
     edge measured 220, because each snapped to a different corner. */
  const cumulative = [0];
  for (let i = 1; i <= outline.length; i++) {
    const from = outline[i - 1];
    const to = outline[i % outline.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(to.x - from.x, to.y - from.y));
  }

  const placed = notches.map((notch) => {
    let best = Infinity;
    let along = 0;
    for (let i = 0; i < outline.length; i++) {
      const found = projectOnSegment(notch.at, outline[i], outline[(i + 1) % outline.length]);
      if (found.distance < best) {
        best = found.distance;
        along = cumulative[i] + (found.t * (cumulative[i + 1] - cumulative[i]));
      }
    }
    return { along, offOutline: Number(best.toFixed(4)) };
  }).sort((a, b) => a.along - b.along);

  const spacing = [];
  for (let i = 1; i < placed.length; i++) {
    spacing.push({
      from: i - 1, to: i,
      along: Number((placed[i].along - placed[i - 1].along).toFixed(4)),
    });
  }
  return spacing;
}

module.exports = {
  LIMITS,
  ingestPatternSet, bundleCoherence, derivedChecks, patternMeasurements,
  notchSpacing, group,
};
