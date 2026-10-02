// services/rnd/fitReadiness.service.js
//
// CAN THIS PATTERN BE DRAPED, AND IF NOT, WHAT IS MISSING.
//
// Implements `docs/product/rnd-fit/garment-template-contract.md` §8 (R1–R12,
// W1–W9), §4.12 (the sewing-line hierarchy) and §6.4 (the neck-finish decision),
// plus `fabric-profile-contract.md` §4 (partial profiles) and §5 (grades).
//
// ── WHY THIS IS ONE FUNCTION AND NOT TWO ────────────────────────────────────
// The screen that says what is still needed and the check that refuses a drape
// must be the same check. When they were separate, the screen enabled "Drape this
// revision" because one seam was mapped while the server would have refused for
// four other reasons — and a reader pressing an enabled button and being refused
// learns to distrust the screen rather than the pattern.
//
// So readiness is computed HERE, once, and the frontend renders what this
// returns. It derives nothing of its own. The parity is a test, not a convention.
//
// ── THE THREE OUTCOMES ──────────────────────────────────────────────────────
// `refused`  no drape; a named failure and what to do about it
// `partial`  a drape, with named findings withheld because they would be biased
// `fitting`  a drape and its findings
//
// A partial is not a degraded fitting. It is the correct outcome whenever the
// drape is watchable but a number would be wrong, and the two cases that produce
// one — a cut-boundary sewing line and a missing neck finish — are both cases
// where refusing would throw away everything true to protect one thing that is
// not.
"use strict";

const templates = require("./fitTemplates");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
/* ── NULL IS NOT ZERO, AND `Number(null)` IS ───────────────────────────────
   `Number(null)` is 0, `Number("")` is 0, and `Number(undefined)` is NaN. A
   coercion that accepted the first two reported "stretch stated: 0%" for a knit
   that stated nothing — which is the same defect that once made our DXF parser
   report inches for every file with no unit, for exactly the same reason. */
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };

/* ═══ THE STEPS, WHICH ARE ALSO THE SCREEN ════════════════════════════════
 *
 * One ordered list, so the setup flow and the refusal cannot describe different
 * work. Each step says what it is for in the words the screen shows, because a
 * step labelled "fabric" and a step labelled "how the cloth behaves, which
 * decides which number is trusted" ask for different care.
 */
const STEP_KEYS = Object.freeze([
  "template", "size", "body", "fabric", "roles", "grain", "sewingLine", "seams", "boundary",
]);

const STEP_LABELS = Object.freeze({
  template: "Garment category",
  size: "Which size is being draped",
  body: "The body it is draped on",
  fabric: "The cloth, and who measured it",
  roles: "What each piece is",
  grain: "Which way the grain runs on each piece",
  sewingLine: "Where the seams actually sew",
  seams: "Which edge is sewn to which",
  boundary: "Which perimeter is finished rather than sewn",
});

/* ═══ FAILURES AND WARNINGS ═══════════════════════════════════════════════ */

const fail = (code, step, message, detail = {}) => ({ code, step, message, ...detail });
const warn = (code, step, message, detail = {}) => ({ code, step, message, ...detail });

/* ═══ GEOMETRY HELPERS ════════════════════════════════════════════════════ */

const pointAt = (outline, i) => {
  const p = outline[i];
  if (!p) return null;
  return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: Number(p.x), y: Number(p.y) };
};

/** Arc length of the run between two outline point indices, the shorter way. */
function runLength(outline, from, to) {
  const n = outline.length;
  if (n < 3 || from === to) return 0;
  const walk = (step) => {
    let total = 0;
    let i = from;
    for (let guard = 0; guard <= n; guard += 1) {
      if (i === to) break;
      const j = (i + step + n) % n;
      const a = pointAt(outline, i);
      const b = pointAt(outline, j);
      if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
      i = j;
    }
    return total;
  };
  const forward = walk(1);
  const backward = walk(-1);
  return Math.min(forward, backward);
}

/** The outline index an anchor names, or null when it names nothing usable. */
function anchorIndex(anchor, pointCount) {
  if (!anchor) return null;
  const kind = str(anchor.kind);
  if (kind === "fraction") {
    const f = num(anchor.fraction);
    if (f === null) return null;
    return Math.min(pointCount - 1, Math.max(0, Math.round(f * pointCount)));
  }
  const i = num(anchor.pointIndex);
  if (i === null || i < 0 || i >= pointCount) return null;
  return Math.round(i);
}

/* ═══ SEWING LINE ═════════════════════════════════════════════════════════
 *
 * The hierarchy from §4.12, in order, and the only place it is decided.
 *
 * Step 4 — the cut boundary — is not a fallback with a small error on it. Sewing
 * on the cut line changes WHERE the pieces meet and how they drape. On a chest
 * girth with two side seams and two armholes, 10mm of allowance is of the order
 * of 40mm, comparable to the entire width of a fit band. It is never called
 * slight, and every dimensional finding is withheld.
 */
const WITHHELD_ON_CUT_BOUNDARY = Object.freeze([
  "chest", "waist", "hem", "bicep", "collar", "shoulder", "armhole",
  "sleeveLength", "garmentLength",
]);

function resolveSewingLine(patternSet, inputs, simulatedPlans) {
  const pieces = patternSet?.pieces || [];
  const byRef = new Map(pieces.map((p) => [str(p.pieceRef), p]));
  const refs = simulatedPlans.map((p) => str(p.pieceRef));

  /* 1 · published, if the file publishes one for every simulated piece. */
  const published = refs.filter((ref) => (byRef.get(ref)?.sewLine || []).length >= 3);
  if (refs.length && published.length === refs.length) {
    return {
      source: "published",
      authoritative: true,
      allowanceMm: null,
      message: "Sewing lines are published by the pattern file (AAMA layer 14) and are used "
        + "directly.",
      withheld: [],
    };
  }

  /* 2 · derived from a confirmed allowance, per piece or per garment. */
  const garmentAllowance = positive(inputs?.seamAllowanceMm);
  const missingAllowance = refs.filter((ref) => {
    const plan = simulatedPlans.find((p) => str(p.pieceRef) === ref);
    return !positive(plan?.seamAllowanceMm) && garmentAllowance === null;
  });
  if (!missingAllowance.length && refs.length) {
    return {
      source: "derived",
      authoritative: true,
      allowanceMm: garmentAllowance,
      message: "Sewing lines were derived from a stated seam allowance. Dimensional findings are "
        + "marked derived.",
      withheld: [],
      /* Whether the inset geometry survives is decided when it is built, not
         here: a derivation that fails validation falls to the cut boundary, and
         the drape records which it actually used. */
      validateDerived: true,
    };
  }

  /* 4 · the cut boundary, non-authoritative. */
  return {
    source: "cut-boundary",
    authoritative: false,
    allowanceMm: null,
    message: "No sewing line could be constructed: the pattern publishes none and no seam "
      + "allowance has been stated. The drape is sewn on the CUT boundary, which changes where "
      + "the pieces meet and how they hang — on a chest with two side seams and two armholes a "
      + "10 mm allowance is of the order of 40 mm. The garment may be looked at; every "
      + "dimensional finding is withheld.",
    withheld: WITHHELD_ON_CUT_BOUNDARY.map((finding) => ({
      finding,
      why: "This drape was sewn on the cut boundary, so this measurement is biased by the "
        + "unstated seam allowance.",
    })),
    missingAllowanceFor: missingAllowance,
  };
}

/* ═══ FABRIC ══════════════════════════════════════════════════════════════
 *
 * Validated by VALUE. The old check was `(inputs.fabrics || []).length > 0` —
 * presence — and a profile with every number at zero passed it. Zero gravity and
 * zero stiffness give cloth that looks like cloth and behaves like nothing, and
 * it is indistinguishable on screen from a real result (VM-14).
 *
 * The rule behind which absences stop and which warn:
 * **a missing value that changes WHERE the cloth settles stops the fitting; a
 * missing value that changes HOW IT GETS THERE warns.**
 */
const GRADE_ORDER = ["measured", "stated", "estimated", "preset"];

function checkFabrics(inputs, simulatedPlans) {
  const profiles = Array.isArray(inputs?.fabrics) ? inputs.fabrics : [];
  const failures = [];
  const warnings = [];
  const withheld = [];

  const refs = simulatedPlans.map((p) => str(p.pieceRef));
  const profileFor = (ref) => profiles.find((f) => (f.appliesTo || []).includes(ref))
    || profiles.find((f) => !(f.appliesTo || []).length)
    || null;

  /* R9 — no profile at all for a simulated piece. */
  const uncovered = refs.filter((ref) => !profileFor(ref));
  if (uncovered.length) {
    failures.push(fail("R9", "fabric",
      `${uncovered.length === 1 ? "A piece has" : `${uncovered.length} pieces have`} no fabric `
      + "profile, so the drape would be of a fabric nobody specified.",
      { pieceRefs: uncovered }));
  }

  const used = profiles.filter((f) => !(f.appliesTo || []).length
    || (f.appliesTo || []).some((ref) => refs.includes(ref)));

  for (const profile of used) {
    const name = str(profile.name) || "an unnamed profile";

    /* Gravity is the drape, and there is no defensible default weight. */
    if (positive(profile.weightGsm) === null) {
      failures.push(fail("R9", "fabric",
        `"${name}" states no fabric weight. Weight is how hard gravity pulls and it is the single `
        + "most visible value in a drape; there is no defensible default, so the drape cannot run.",
        { profileId: str(profile.profileId), field: "weightGsm" }));
    }

    const behaviour = str(profile.behaviour);
    if (!behaviour) {
      /* Not a refusal: the garment still drapes. But girth findings go, because
         the two kinds are judged on different evidence and defaulting to woven
         reverses which number is primary. */
      warnings.push(warn("W5", "fabric",
        `"${name}" does not say whether the cloth is woven or knit. It is never inferred from a `
        + "fabric's name, so girth findings are withheld — a woven and a knit of the same weight "
        + "are judged on different evidence.",
        { profileId: str(profile.profileId), field: "behaviour" }));
      for (const finding of ["chest", "waist", "hem"]) {
        withheld.push({
          finding,
          why: `"${name}" does not state whether the cloth is woven or knit, and the two are `
            + "judged on different primary evidence.",
        });
      }
    }

    if (behaviour === "knit") {
      const warp = positive(profile.stretchWarpPercent);
      const weft = positive(profile.stretchWeftPercent);
      if (warp === null && weft === null) {
        failures.push(fail("R9", "fabric",
          `"${name}" is a knit with no stretch stated. On a knit the stretch IS the primary `
          + "evidence — the garment is held on by it — so the drape cannot run without it.",
          { profileId: str(profile.profileId), field: "stretchWarpPercent" }));
      } else if (num(profile.stretchLoadN) === null) {
        warnings.push(warn("W5", "fabric",
          `"${name}" states a stretch percentage but not the load it was measured at. `
          + "A percentage is not a number until you say under what force, and two profiles "
          + "measured at different loads are not comparable.",
          { profileId: str(profile.profileId), field: "stretchLoadN" }));
      }
    }

    /* Values that change how it gets there rather than where it settles. */
    for (const [field, what] of [
      ["bendingRigidity", "whether it folds in soft rolls or sharp creases"],
      ["shearStiffness", "resistance to skewing, which is why a bias panel falls differently"],
      ["damping", "how fast motion dies out"],
    ]) {
      if (positive(profile[field]) === null) {
        warnings.push(warn("W5", "fabric",
          `"${name}" states no ${field} (${what}). A category typical is used and the fitting is `
          + "marked estimated.",
          { profileId: str(profile.profileId), field }));
      }
    }

    if (positive(profile.collisionOffsetMm) === null) {
      warnings.push(warn("W5", "fabric",
        `"${name}" states no collision offset, so one is derived from the mesh density. It is a `
        + "solver setting and not the cloth's thickness — the two were one field once and they "
        + "differ by a factor of ten.",
        { profileId: str(profile.profileId), field: "collisionOffsetMm" }));
    }

    const grade = str(profile.grade);
    if (!grade) {
      warnings.push(warn("W5", "fabric",
        `"${name}" does not say where its values came from, so measured cloth and guessed cloth `
        + "are indistinguishable. The fitting is marked estimated.",
        { profileId: str(profile.profileId), field: "grade" }));
    } else if (grade === "preset") {
      warnings.push(warn("W5", "fabric",
        `"${name}" is an unedited preset. A preset is a starting point and never a conclusion: `
        + "it is not this house's cloth, and no dimensional finding from it can be "
        + "high-confidence.",
        { profileId: str(profile.profileId) }));
    } else if (grade === "estimated") {
      warnings.push(warn("W5", "fabric",
        `"${name}" is estimated from a similar cloth, so the whole fitting is marked estimated.`,
        { profileId: str(profile.profileId) }));
    }
  }

  /* The LOWEST grade among the simulated pieces is the grade of the fitting. One
     estimated lining does not matter much; the product still says estimated,
     because the alternative is a reader checking each piece. */
  let grade = "";
  for (const candidate of GRADE_ORDER) {
    if (used.some((f) => str(f.grade) === candidate)) grade = candidate;
  }
  if (!grade && used.length) grade = "estimated";

  return {
    failures, warnings, withheld, grade,
    profileCount: profiles.length,
    behaviours: [...new Set(used.map((f) => str(f.behaviour)).filter(Boolean))],
  };
}

/* ═══ SEAMS ═══════════════════════════════════════════════════════════════ */

function checkSeams(patternSet, inputs, simulatedPlans, template) {
  const failures = [];
  const warnings = [];
  const seams = Array.isArray(inputs?.seams) ? inputs.seams : [];
  const planByRef = new Map(simulatedPlans.map((p) => [str(p.pieceRef), p]));
  const parsedByRef = new Map((patternSet?.pieces || []).map((p) => [str(p.pieceRef), p]));
  const anchorKindsUsed = new Set();
  const mappedRuns = new Map();   /* pieceRef → Set(runId) */
  const reviewed = [];

  const runOf = (ref, runId) => {
    const plan = planByRef.get(ref);
    return (plan?.runs || []).find((r) => str(r.runId) === str(runId)) || null;
  };

  const measure = (ref, run) => {
    const stated = positive(run?.lengthMm);
    if (stated !== null) return stated;
    const parsed = parsedByRef.get(ref);
    const outline = parsed?.outline || [];
    const from = anchorIndex(run?.startAnchor, outline.length);
    const to = anchorIndex(run?.endAnchor, outline.length);
    if (from === null || to === null) return null;
    return runLength(outline, from, to);
  };

  for (const seam of seams) {
    const seamId = str(seam.seamId);
    const label = str(seam.name) || seamId || "an unnamed seam";
    const sides = [["sideA", seam.sideA], ["sideB", seam.sideB]];
    let broken = false;

    for (const [which, side] of sides) {
      const list = Array.isArray(side) ? side : [];
      if (!list.length) {
        failures.push(fail("R4", "seams",
          `"${label}" has nothing on its ${which === "sideA" ? "first" : "second"} side. `
          + "A seam joins two sequences of boundary runs, and one of them is empty.",
          { seamId }));
        broken = true;
        continue;
      }

      let previousEnd = null;
      let previousDirection = null;
      let previousPieceRef = "";
      for (let k = 0; k < list.length; k += 1) {
        const ref = str(list[k].pieceRef);
        const runId = str(list[k].runId);
        const run = runOf(ref, runId);
        if (!run) {
          failures.push(fail("R4", "seams",
            `"${label}" names a boundary run (${runId || "—"} on ${ref || "—"}) that is not `
            + "placed on any simulated piece.",
            { seamId, pieceRef: ref, runId }));
          broken = true;
          continue;
        }
        if (!mappedRuns.has(ref)) mappedRuns.set(ref, new Set());
        mappedRuns.get(ref).add(runId);
        anchorKindsUsed.add(str(run.startAnchor?.kind));
        anchorKindsUsed.add(str(run.endAnchor?.kind));

        /* ── R6 · COMPOUND SIDES MUST BE CONTIGUOUS AND CO-DIRECTIONAL ──
           Each run's end anchor is the next run's start anchor, and all of them
           travel the same way round their pieces. A side that is not contiguous,
           or that reverses part-way, is a readiness failure and NOT something to
           be silently re-ordered or flipped to make it fit (§4.4, M1). */
        if (k > 0) {
          const startIndex = anchorIndex(run.startAnchor,
            (parsedByRef.get(ref)?.outline || []).length);
          /* ── CONTIGUITY MEANS TWO DIFFERENT THINGS ────────────────────
             Within ONE piece it is index equality: this run starts where the last
             one ended, on the same boundary.

             ACROSS two pieces it cannot be, and an armhole is always across two:
             side B is the front armhole then the back armhole, and the front's
             armhole ends at the shoulder point while the back's starts at a
             different point of a different outline. What makes them one
             continuous stretch is that the two pieces are JOINED there — by the
             shoulder seam. So the check is that another seam in this map joins
             the two pieces. An armhole cannot run from a front to a back that are
             not sewn to each other.

             What this does NOT verify is that they are joined at exactly these
             two anchors rather than somewhere else on the same two pieces. That
             would need the joining seam's own alignment resolved into point
             correspondences, and it is stated here rather than implied. */
          if (previousPieceRef && previousPieceRef === ref) {
            if (previousEnd !== null && startIndex !== null && previousEnd !== startIndex) {
              failures.push(fail("R6", "seams",
                `"${label}" has a gap on its ${which === "sideA" ? "first" : "second"} side: `
                + `run ${runId} starts at outline point ${startIndex} and the run before it ended `
                + `at point ${previousEnd} on the same piece. A compound seam side has to be one `
                + "continuous stretch of boundary, and the runs are not re-ordered to make them "
                + "fit.",
                { seamId, pieceRef: ref, runId }));
              broken = true;
            }
          } else if (previousPieceRef) {
            const joined = seams.some((other) => str(other.seamId) !== seamId
              && [[other.sideA, other.sideB], [other.sideB, other.sideA]].some(([x, y]) =>
                (x || []).some((e) => str(e.pieceRef) === previousPieceRef)
                && (y || []).some((e) => str(e.pieceRef) === ref)));
            if (!joined) {
              failures.push(fail("R6", "seams",
                `"${label}" runs from one piece onto another on its `
                + `${which === "sideA" ? "first" : "second"} side, and those two pieces are not `
                + "sewn to each other anywhere in this mapping. A compound side cannot cross a "
                + "join that does not exist.",
                { seamId, pieceRef: ref, runId, from: previousPieceRef }));
              broken = true;
            }
          }
          if (previousDirection && str(run.direction) && previousDirection !== str(run.direction)) {
            failures.push(fail("R6", "seams",
              `"${label}" changes direction part-way along its `
              + `${which === "sideA" ? "first" : "second"} side. Every run in a sequence has to `
              + "travel the same way round its piece.",
              { seamId, pieceRef: ref, runId }));
            broken = true;
          }
        }
        previousEnd = anchorIndex(run.endAnchor, (parsedByRef.get(ref)?.outline || []).length);
        previousDirection = str(run.direction) || previousDirection;
        previousPieceRef = ref;
      }
    }

    /* ── R4 · ALIGNMENT, CONFIRMED BY A NAMED PERSON ────────────────────
       The failure nothing downstream can catch. A sleeve cap sewn front-to-back
       has the same perimeter, the same seam length and the same scale as one
       sewn correctly. */
    const alignment = str(seam.alignment);
    const confirmedBy = str(seam.alignmentConfirmed?.by?.name)
      || str(seam.alignmentConfirmed?.by?.id);
    const confirmedAt = seam.alignmentConfirmed?.at || null;
    if (!alignment) {
      failures.push(fail("R4", "seams",
        `"${label}" does not say which end meets which. A seam confirmed the wrong way round `
        + "produces a believable garment with a twisted sleeve, and nothing afterwards flags it "
        + "— so the drape will not run until somebody states and confirms it.",
        { seamId }));
      broken = true;
    } else if (!confirmedBy || !confirmedAt) {
      failures.push(fail("R4", "seams",
        `"${label}" has an alignment that nobody has confirmed. A confirmation nobody is `
        + "attributable for is a guess.",
        { seamId }));
      broken = true;
    } else if (str(seam.confidence) === "rejected") {
      failures.push(fail("R4", "seams",
        `"${label}" was rejected and has not been re-mapped.`, { seamId }));
      broken = true;
    }

    /* ── R7 · DECLARED LENGTHS, BEFORE ANY MESH EXISTS (M4) ─────────────
       Distinct from the post-meshing fidelity gate, which compares a declared
       length to the length actually sewn. Neither replaces the other. */
    const lengthOf = (side) => (Array.isArray(side) ? side : []).reduce((total, entry) => {
      const got = measure(str(entry.pieceRef), runOf(str(entry.pieceRef), str(entry.runId)));
      return total === null || got === null ? null : total + got;
    }, 0);
    const aLength = lengthOf(seam.sideA);
    const bLength = lengthOf(seam.sideB);
    if (!broken && aLength !== null && bLength !== null && aLength > 0 && bLength > 0) {
      const shorter = Math.min(aLength, bLength);
      const ease = Math.abs(aLength - bLength) / shorter;
      const roleOfSeam = str(seam.sideA?.[0]
        && runOf(str(seam.sideA[0].pieceRef), str(seam.sideA[0].runId))?.role);
      const allowed = templates.easeAllowanceFor(roleOfSeam);
      reviewed.push({
        seamId, name: label, aLengthMm: aLength, bLengthMm: bLength,
        easePercent: Number((ease * 100).toFixed(1)),
        allowedPercent: Number((allowed * 100).toFixed(1)),
        role: roleOfSeam,
      });
      if (ease > allowed) {
        failures.push(fail("R7", "seams",
          `"${label}" joins sides of ${(aLength / 10).toFixed(1)} cm and `
          + `${(bLength / 10).toFixed(1)} cm — ${(ease * 100).toFixed(1)}% apart, where this seam `
          + `allows ${(allowed * 100).toFixed(0)}%. The pieces as mapped do not fit each other.`,
          { seamId, aLengthMm: aLength, bLengthMm: bLength }));
      } else if (ease > allowed * 0.6 && ease > 0.01) {
        warnings.push(warn("W3", "seams",
          `"${label}" carries ${(ease * 100).toFixed(1)}% ease, inside the `
          + `${(allowed * 100).toFixed(0)}% this seam allows but worth a look.`,
          { seamId }));
      }
    }

    /* ── W9 · A PROPAGATED CONFIRMATION IS WEAKER THAN TWO REAL ONES ───── */
    if (str(seam.propagatedFrom?.seamId)) {
      warnings.push(warn("W9", "seams",
        `"${label}" inherited its confirmation from "${str(seam.propagatedFrom.seamId)}" rather `
        + "than being confirmed independently. Both are legitimate production forms and the "
        + "evidence distinguishes them.",
        { seamId }));
    }
  }

  /* ── W7 · ARC-LENGTH FRACTIONS DO NOT SURVIVE A PATTERN EDIT ────────── */
  if (anchorKindsUsed.has("fraction")) {
    warnings.push(warn("W7", "seams",
      "Some anchors are arc-length fractions rather than turn points. This mapping will need "
      + "re-checking after any pattern edit: move one point and every fraction after it means "
      + "something else.", {}));
  }

  return { failures, warnings, mappedRuns, reviewed, seamCount: seams.length };
}

/* ═══ THE WHOLE ANSWER ════════════════════════════════════════════════════ */

/**
 * @param {object} patternSet  the parse — read, never written
 * @param {object} inputs      `simulationInputs`
 * @param {object} opts        { revisionRef, mappingConfirmedAgainstRef }
 */
function assess(patternSet, inputs = {}, opts = {}) {
  const failures = [];
  const warnings = [];
  const withheld = [];
  const notes = [];

  const parsed = (patternSet?.pieces || []);
  const usable = parsed.filter((p) => (p.outline || []).length >= 3);

  /* ── R1 · SOMETHING TO SEW ─────────────────────────────────────────── */
  if (!usable.length) {
    failures.push(fail("R1", "roles",
      "No piece in this pattern has a usable closed outline, so there is nothing to sew."));
  }

  /* ── R8 · AN OUTLINE THAT CANNOT BE MADE INTO CLOTH ────────────────── */
  const open = parsed.filter((p) => (p.outline || []).length >= 3 && p.outlineClosed === false);
  if (open.length) {
    failures.push(fail("R8", "roles",
      `${open.length === 1 ? "A piece outline is" : `${open.length} piece outlines are`} open, `
      + "so there is no inside to make into cloth.",
      { pieceRefs: open.map((p) => str(p.pieceRef)) }));
  }

  /* ── R2 · THE UNIT ─────────────────────────────────────────────────── */
  const unit = str(patternSet?.unit);
  const unitInMm = positive(patternSet?.unitInMm);
  if (!unit && unitInMm === null) {
    failures.push(fail("R2", "template",
      "This pattern states no unit, so every length in it is meaningless. It is not assumed: "
      + "millimetres and inches differ by a factor of 25.4 and nothing about the shape on screen "
      + "would reveal the mistake."));
  }

  /* ── THE TEMPLATE ──────────────────────────────────────────────────── */
  const template = templates.templateFor(inputs?.template);
  if (!template) {
    failures.push(fail("R3", "template",
      inputs?.template
        ? `"${str(inputs.template)}" is not a garment category this workspace knows. Choose one `
          + `of: ${templates.TEMPLATE_IDS.join(", ")}.`
        : "No garment category has been chosen. A role means something only inside a category — "
          + "“band” is a neck band on a tee and a cuff band on a polo.",
      { options: templates.TEMPLATE_IDS }));
  }

  /* ── THE SIZE ──────────────────────────────────────────────────────── */
  if (!str(inputs?.renderSize)) {
    failures.push(fail("R3", "size",
      "No size has been chosen. A graded pattern holds several and a drape is of exactly one."));
  }

  /* ── THE BODY ──────────────────────────────────────────────────────── */
  const measurements = inputs?.avatar?.measurements || {};
  const chest = positive(measurements.chestMm) || positive(measurements.chest);
  if (!str(inputs?.avatar?.name) && !Object.keys(measurements).length) {
    failures.push(fail("R3", "body",
      "No body has been chosen. A garment is draped on a body, and which body changes the "
      + "result."));
  } else if (chest === null) {
    failures.push(fail("R3", "body",
      "The body states no chest girth. It is the one measurement every finding in this release "
      + "depends on.", { field: "chestMm" }));
  }
  if (!positive(measurements.heightMm) && !positive(measurements.height)) {
    warnings.push(warn("W6", "body",
      "The body states no height, so the torso and arm proportions are derived from the chest. "
      + "The body is a set of capsules built from measurements and is marked estimated either "
      + "way."));
  }
  if (!str(inputs?.avatar?.scaleVerifiedAgainst)) {
    warnings.push(warn("W6", "body",
      "The pattern's scale is self-consistent but not externally verified: its stated unit, its "
      + "declared lengths and its built mesh agree, which a pattern drawn at the wrong scale "
      + "throughout also satisfies. Check one length against a measured sample to rule that out."));
  }

  /* ── ROLES, QUANTITIES, SYMMETRY, PAIRING ──────────────────────────── */
  const plans = Array.isArray(inputs?.pieces) ? inputs.pieces : [];
  const planByRef = new Map(plans.map((p) => [str(p.pieceRef), p]));
  const allPlans = usable.map((p) => {
    const ref = str(p.pieceRef);
    return planByRef.get(ref) || { pieceRef: ref };
  });
  const simulatedPlans = allPlans.filter((plan) => templates.simulates(plan));

  const unassigned = allPlans.filter((plan) => !str(plan.role));
  const rolesPresent = new Set(allPlans.map((plan) => str(plan.role)).filter(Boolean));

  if (template) {
    const unknownRoles = allPlans
      .map((plan) => str(plan.role))
      .filter((role) => role && !template.roles.includes(role));
    if (unknownRoles.length) {
      failures.push(fail("R3", "roles",
        `${[...new Set(unknownRoles)].map((r) => `"${r}"`).join(", ")} `
        + `${unknownRoles.length === 1 ? "is not a role" : "are not roles"} `
        + `${template.label} declares. A role is meaningful only inside a category.`,
        { roles: [...new Set(unknownRoles)] }));
    }

    for (const required of template.required) {
      /* ── §6.4 · THE NECK FINISH IS THE ONE EXCEPTION ──────────────────
         An absent neck finish does NOT refuse. Front, back and sleeves sewn to
         each other make a complete, readable garment; the neck opening is simply
         unfinished, exactly as it is on a sampling-room table before the band
         goes on. Refusing threw away every finding about the body and the
         sleeves to protect one finding about a collar that is not there. */
      if (required === "neckFinish") {
        const finish = [...rolesPresent].filter((role) => templates.isNeckFinish(role));
        if (!finish.length) {
          notes.push({
            code: "W4", step: "roles",
            prominent: true,
            message: "This pattern has no neck finish. The neck opening is unfinished — nothing "
              + "is invented to close it, no band is generated, and the collar findings are "
              + "withheld.",
          });
          for (const finding of ["collar", "neckClearance", "collarRoll"]) {
            withheld.push({
              finding,
              why: "This pattern has no neck band, collar or facing, so there is no finished neck "
                + "opening to measure.",
            });
          }
        }
        continue;
      }
      if (!rolesPresent.has(required)) {
        failures.push(fail("R3", "roles",
          `No piece has been given the role "${required}", which ${template.label} requires. `
          + "The required list is short on purpose, so this means something structural is absent.",
          { role: required }));
      }
    }

    /* ── R12 · A NECK FINISH THAT EXISTS AND IS HALF-JOINED ──────────────
       The other half of the §6.4 decision, and the opposite answer. An absent
       piece is a known absence the product can describe honestly; a piece that
       exists and is not joined is an unfinished mapping, and draping around it
       would silently exclude cloth the pattern-maker drew. */
    const finishPieces = allPlans.filter((plan) => templates.isNeckFinish(str(plan.role)));
    const seams = Array.isArray(inputs?.seams) ? inputs.seams : [];
    for (const piece of finishPieces) {
      const ref = str(piece.pieceRef);
      const inAnySeam = seams.some((seam) => [...(seam.sideA || []), ...(seam.sideB || [])]
        .some((entry) => str(entry.pieceRef) === ref));
      const confirmed = seams
        .filter((seam) => [...(seam.sideA || []), ...(seam.sideB || [])]
          .some((entry) => str(entry.pieceRef) === ref))
        .every((seam) => str(seam.alignment) && seam.alignmentConfirmed?.at);
      if (!inAnySeam) {
        failures.push(fail("R12", "seams",
          `The neck finish "${str(piece.role)}" is in this pattern and is not joined to anything. `
          + "A piece that exists and is half-joined is not the same as one that is absent: "
          + "draping around it would silently leave out cloth the pattern-maker drew.",
          { pieceRef: ref }));
      } else if (!confirmed) {
        failures.push(fail("R12", "seams",
          `The neck finish "${str(piece.role)}" is mapped but its alignment is not confirmed.`,
          { pieceRef: ref }));
      }
    }

    /* Optional pieces that come in pairs, and ones that need a companion. */
    for (const [a, b] of template.pairedRoles || []) {
      if (rolesPresent.has(a) !== rolesPresent.has(b)) {
        failures.push(fail("R3", "roles",
          `"${rolesPresent.has(a) ? a : b}" is present and "${rolesPresent.has(a) ? b : a}" is `
          + "not. These two are halves of one construction.",
          { roles: [a, b] }));
      }
    }
    for (const [role, needs] of Object.entries(template.requiresWhenPresent || {})) {
      if (!rolesPresent.has(role)) continue;
      for (const need of needs) {
        if (!rolesPresent.has(need)) {
          failures.push(fail("R3", "roles",
            `"${role}" is present but "${need}" is not, and it has nothing to sit on.`,
            { roles: [role, need] }));
        }
      }
    }
    for (const optional of template.optional || []) {
      if (!rolesPresent.has(optional)) {
        warnings.push(warn("W4", "roles",
          `This garment has no ${optional.replace(/[.-]/g, " ")}.`, { role: optional }));
      }
    }

    /* Cut quantity, counted after unfolding and mirroring. */
    for (const [role, expected] of Object.entries(template.requiredCutQuantity || {})) {
      const mine = allPlans.filter((plan) => str(plan.role) === role);
      if (!mine.length) continue;
      const total = mine.reduce((n, plan) => {
        const q = num(plan.cutQuantity);
        if (q !== null) return n + q;
        return n + (str(plan.symmetry) === "mirrored-pair"
          || str(plan.symmetry) === "identical-pair" ? 2 : 1);
      }, 0);
      if (total !== expected) {
        failures.push(fail("R3", "roles",
          `"${role}" accounts for ${total} piece${total === 1 ? "" : "s"} in the finished `
          + `garment and ${template.label} needs ${expected}. Cut quantity is the count after `
          + "unfolding and mirroring, not the number of outlines in the file.",
          { role, got: total, expected }));
      }
    }

    /* Form A versus Form B, recorded because a propagated confirmation is weaker
       than two independent ones. */
    for (const plan of allPlans) {
      const symmetry = str(plan.symmetry);
      if (symmetry === "cut-on-fold") {
        warnings.push(warn("W6", "roles",
          `"${str(plan.role) || str(plan.pieceRef)}" is cut on the fold, so the drawing holds `
          + "half of it and assembly reflects it with no seam at the fold. Our exports publish "
          + "no mirror line, so this was stated by a person.",
          { pieceRef: str(plan.pieceRef) }));
      }
      if (str(plan.pairedWith) && !planByRef.has(str(plan.pairedWith))) {
        failures.push(fail("R3", "roles",
          `"${str(plan.pieceRef)}" is paired with "${str(plan.pairedWith)}", which is not a piece `
          + "in this pattern.",
          { pieceRef: str(plan.pieceRef) }));
      }
    }
  }

  if (unassigned.length) {
    failures.push(fail("R3", "roles",
      `${unassigned.length} piece${unassigned.length === 1 ? "" : "s"} ${unassigned.length === 1
        ? "has" : "have"} no role yet. A piece with no role is not an error — it is a piece `
      + "nobody has placed, and nothing guesses one from its name.",
      { pieceRefs: unassigned.map((p) => str(p.pieceRef)) }));
  }

  /* ── GRAIN (R10) ───────────────────────────────────────────────────── */
  const fabricCheck = checkFabrics(inputs, simulatedPlans);
  const anisotropic = fabricCheck.behaviours.includes("knit")
    || (inputs?.fabrics || []).some((f) => {
      const warp = num(f.stretchWarpPercent);
      const weft = num(f.stretchWeftPercent);
      return warp !== null && weft !== null && Math.abs(warp - weft) > 2;
    });
  const parsedByRef = new Map(parsed.map((p) => [str(p.pieceRef), p]));
  const grainless = simulatedPlans.filter((plan) => {
    const vector = Array.isArray(plan.grainVector) ? plan.grainVector : null;
    if (vector && vector.length >= 2 && Math.hypot(vector[0], vector[1]) > 1e-9) return false;
    /* Layer 7 is published on every piece of our real export, so a derived
       vector is the normal case; this is about the ones where it is not. */
    const marker = parsedByRef.get(str(plan.pieceRef))?.grainline;
    return !(marker && marker.from && marker.to);
  });
  if (grainless.length && anisotropic) {
    failures.push(fail("R10", "grain",
      `${grainless.length === 1 ? "A simulated piece has" : `${grainless.length} simulated pieces `
        + "have"} no grain vector, and this cloth behaves differently along and across. The `
      + "stretch direction is undefined, so the drape cannot run.",
      { pieceRefs: grainless.map((p) => str(p.pieceRef)) }));
  } else if (grainless.length) {
    warnings.push(warn("W6", "grain",
      `${grainless.length} piece${grainless.length === 1 ? "" : "s"} have no grain vector. This `
      + "cloth is effectively the same along and across, so it does not change the result.",
      { pieceRefs: grainless.map((p) => str(p.pieceRef)) }));
  }
  for (const plan of simulatedPlans) {
    if (str(plan.grainSource) === "stated" && !plan.grainConfirmed?.at) {
      warnings.push(warn("W6", "grain",
        `The grain vector on "${str(plan.role) || str(plan.pieceRef)}" was stated rather than `
        + "read from a published grainline, and nobody has confirmed it.",
        { pieceRef: str(plan.pieceRef) }));
    }
  }

  failures.push(...fabricCheck.failures);
  warnings.push(...fabricCheck.warnings);
  withheld.push(...fabricCheck.withheld);

  /* ── SEWING LINE ───────────────────────────────────────────────────── */
  const sewingLine = resolveSewingLine(patternSet, inputs, simulatedPlans);
  if (sewingLine.source === "derived") {
    warnings.push(warn("W1", "sewingLine", sewingLine.message));
  } else if (sewingLine.source === "cut-boundary") {
    warnings.push(warn("W2", "sewingLine", sewingLine.message));
    withheld.push(...sewingLine.withheld);
  }

  /* ── SEAMS ─────────────────────────────────────────────────────────── */
  const seamCheck = checkSeams(patternSet, inputs, simulatedPlans, template);
  failures.push(...seamCheck.failures);
  warnings.push(...seamCheck.warnings);
  if (!seamCheck.seamCount) {
    failures.push(fail("R4", "seams",
      "No seam has been mapped. The pattern says where the pieces are; only a person says which "
      + "edge is sewn to which, and nothing guesses it from proximity or length — on a shirt "
      + "several pairs of runs match in length and only one pairing is correct."));
  }

  /* ── R5 · BOUNDARY COVERAGE ────────────────────────────────────────── */
  const uncovered = [];
  for (const plan of simulatedPlans) {
    const ref = str(plan.pieceRef);
    const parsedPiece = parsedByRef.get(ref);
    const perimeter = positive(parsedPiece?.perimeter) || 0;
    const sewn = (plan.runs || [])
      .filter((run) => (seamCheck.mappedRuns.get(ref) || new Set()).has(str(run.runId)))
      .reduce((total, run) => {
        const outline = parsedPiece?.outline || [];
        const stated = positive(run.lengthMm);
        if (stated !== null) return total + stated;
        const from = anchorIndex(run.startAnchor, outline.length);
        const to = anchorIndex(run.endAnchor, outline.length);
        return from === null || to === null ? total : total + runLength(outline, from, to);
      }, 0);
    const explicit = (plan.runs || [])
      .filter((run) => ["fold", "vent", "opening", "sleeve.slit"].includes(str(run.role)))
      .length > 0;
    const share = perimeter > 0 ? Math.min(1, sewn / perimeter) : 0;
    if (plan.boundaryConfirmed?.at) continue;
    if (share >= 0.999 && perimeter > 0) continue;
    uncovered.push({
      pieceRef: ref,
      name: str(parsedPiece?.name) || ref,
      role: str(plan.role),
      sewnShare: Number(share.toFixed(3)),
      uncoveredMm: Math.max(0, perimeter - sewn),
      hasExplicitSpecialRuns: explicit,
    });
  }
  if (uncovered.length) {
    failures.push(fail("R5", "boundary",
      `${uncovered.length === 1 ? "One piece has" : `${uncovered.length} pieces have`} perimeter `
      + "that is neither sewn nor confirmed as finished. The uncovered portions are shown on the "
      + "piece — confirm the remainder once per piece rather than edge by edge.",
      { pieces: uncovered }));
  }

  /* ── R11 · THE MAPPING WAS CONFIRMED AGAINST ANOTHER REVISION ──────── */
  const confirmedAgainst = str(opts.mappingConfirmedAgainstRef);
  const revisionRef = str(opts.revisionRef);
  if (confirmedAgainst && revisionRef && confirmedAgainst !== revisionRef) {
    failures.push(fail("R11", "seams",
      `This seam mapping was confirmed against pattern revision ${confirmedAgainst} and this is `
      + `${revisionRef}. The mapping may point at geometry that has moved, so it has to be `
      + "re-checked rather than re-pointed: a fitting is a statement about one revision and "
      + "expires with it.",
      { confirmedAgainst, revisionRef }));
  }

  /* ── WHAT IS NOT MODELLED, AND THE SENTENCE FOR IT ─────────────────── */
  const seamTypes = new Set((inputs?.seams || []).map((s) => str(s.seamType)).filter(Boolean));
  for (const entry of templates.UNMODELLED) {
    const hit = (entry.whenRole || []).some((role) => rolesPresent.has(role))
      || (entry.whenSeamType || []).some((type) => seamTypes.has(type));
    if (hit) warnings.push(warn("W8", "roles", entry.sentence));
  }

  /* ── THE STEPS, WHICH ARE ALSO THE SCREEN ──────────────────────────── */
  const failuresByStep = new Map();
  for (const f of failures) {
    if (!failuresByStep.has(f.step)) failuresByStep.set(f.step, []);
    failuresByStep.get(f.step).push(f);
  }
  const warningsByStep = new Map();
  for (const w of warnings) {
    if (!warningsByStep.has(w.step)) warningsByStep.set(w.step, []);
    warningsByStep.get(w.step).push(w);
  }
  const detail = {
    template: template ? template.label : "",
    size: str(inputs?.renderSize),
    body: str(inputs?.avatar?.name) || (chest !== null ? `chest ${(chest / 10).toFixed(1)} cm` : ""),
    fabric: fabricCheck.profileCount
      ? `${fabricCheck.profileCount} profile${fabricCheck.profileCount === 1 ? "" : "s"}`
        + (fabricCheck.grade ? ` · ${fabricCheck.grade}` : "")
      : "",
    roles: `${allPlans.length - unassigned.length} of ${allPlans.length} pieces`,
    grain: `${simulatedPlans.length - grainless.length} of ${simulatedPlans.length} pieces`,
    sewingLine: sewingLine.source,
    seams: `${seamCheck.seamCount} mapped`,
    boundary: `${simulatedPlans.length - uncovered.length} of ${simulatedPlans.length} pieces`,
  };
  const steps = STEP_KEYS.map((key) => ({
    key,
    label: STEP_LABELS[key],
    failures: failuresByStep.get(key) || [],
    warnings: warningsByStep.get(key) || [],
    done: !(failuresByStep.get(key) || []).length,
    detail: detail[key] || "",
  }));

  /* ── ONE ENTRY PER FINDING ─────────────────────────────────────────
     Two different reasons can withhold the same number — a missing neck finish
     and a cut-boundary sewing line both take the collar — and a screen listing
     "collar" twice reads as two problems. The first reason is kept and the rest
     are folded into it, because a reader needs to know the finding is gone and
     then why, not how many ways. */
  const withheldByFinding = [];
  for (const entry of withheld) {
    const held = withheldByFinding.find((w) => w.finding === entry.finding);
    if (!held) withheldByFinding.push({ ...entry, alsoBecause: [] });
    else if (!held.alsoBecause.includes(entry.why)) held.alsoBecause.push(entry.why);
  }

  const outcome = failures.length ? "refused" : (withheldByFinding.length ? "partial" : "fitting");

  return {
    /* The one boolean every surface branches on. */
    ready: failures.length === 0,
    outcome,
    failures,
    warnings,
    notes,
    /* Named findings this drape may not report, with the reason each. */
    withheld: withheldByFinding,
    steps,
    sewingLine: {
      source: sewingLine.source,
      authoritative: sewingLine.authoritative,
      allowanceMm: sewingLine.allowanceMm,
      message: sewingLine.message,
    },
    fabric: { grade: fabricCheck.grade, behaviours: fabricCheck.behaviours },
    seams: seamCheck.reviewed,
    uncovered,
    pieceCount: usable.length,
    simulatedCount: simulatedPlans.length,
    template: template ? { id: template.id, label: template.label } : null,
    /* Said once, here, so no screen has to compose it. */
    alignmentCaveat: "This fitting assumes each seam is joined the way it was confirmed. A seam "
      + "confirmed the wrong way round will still produce a believable garment, and nothing "
      + "afterwards will flag it.",
  };
}

module.exports = { assess, STEP_KEYS, STEP_LABELS, resolveSewingLine, checkFabrics, runLength };
