// services/rnd/patternMapping.service.js
//
// WHICH FLAT PIECE IS WHICH 3D COMPONENT, AND HOW SURE ANYBODY IS.
//
// ── THE PROBLEM, STATED HONESTLY ────────────────────────────────────────────
// A DXF publishes pattern pieces. A GLB publishes meshes. Nothing in either
// file says they are the same objects, because they are produced by two
// different exports of the same project and neither carries the other's
// identifiers. So "which 3D part is this sleeve" is not a lookup — it is an
// INFERENCE, and the quality of the inference varies from certain to worthless
// depending on what the two files happened to publish.
//
// Every real failure mode here is the same failure: an inference presented as a
// fact. A matcher that reports 62% name similarity as a mapping will have a
// left sleeve highlighted as a right one, a facing shown as a front, and
// nobody able to tell which of its answers were guesses. So this module's whole
// design is about keeping the grade of evidence attached to the answer.
//
// ── THE LADDER, STRONGEST FIRST ─────────────────────────────────────────────
//   1. A STABLE ID BOTH FILES PUBLISHED. Not an inference at all — the two
//      exports named the same thing. Accepted without a person.
//   2. AN EXACT NAME MATCH. Strong, and still an inference: two files can
//      legitimately contain different objects with the same name. Proposed,
//      and a person confirms.
//   3. SIZE AND MATERIAL. Narrows, rarely decides.
//   4. A NORMALISED NAME. "Front_Bodice_L" vs "front bodice left". Useful and
//      exactly where a wrong answer looks right.
//   5. SHAPE OR AREA SIMILARITY. A SUGGESTION, labelled as one wherever it
//      appears, and never a mapping on its own. Area cannot tell a left sleeve
//      from a right one, and those are the two pieces it will be asked about.
//   6. A PERSON. The only rung with a name attached, and therefore the only
//      one that can settle a case the files left ambiguous.
//
// ── AND WHAT IS NEVER DONE ──────────────────────────────────────────────────
// Nothing below the exact-ID rung is ever stored as confirmed by this module.
// A proposal is a proposal until somebody says otherwise, and a piece with no
// proposal says "needs mapping" rather than being quietly attached to whichever
// mesh scored highest among a set of bad options.
"use strict";

const crypto = require("crypto");

const { MAPPING_METHOD, MAPPING_STATE } = require("../../models/CMS_Models/RnD/GarmentModel");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/**
 * A stored mapping as plain data.
 *
 * ── THE BUG THIS EXISTS TO PREVENT, WHICH ONLY THE ROUTES COULD SHOW ────────
 * `{ ...doc }` on a Mongoose subdocument copies the document's INTERNALS —
 * `$__`, `_doc`, `$isNew` — and none of its fields. An earlier version of
 * `proposeMappings` spread each existing mapping that way to carry it forward,
 * so every confirmed mapping read back from the database arrived with an empty
 * `pieceRef`, no `nodeRef`, no `method` and no `state`. A confirmation somebody
 * had made silently became a blank row, and `usable` computed to false on it.
 *
 * The unit tests could not see it, because they pass plain objects in. It took
 * a route test, where the mappings come off a real document, which is the
 * argument for having both.
 */
const plain = (value) => {
  if (!value || typeof value !== "object") return value;
  return typeof value.toObject === "function" ? value.toObject() : value;
};

/* ═══ CONFIDENCE ═══════════════════════════════════════════════════════════
 *
 * ── WHY THESE NUMBERS AND NOT A TRAINED SCORE ───────────────────────────────
 * Each value is the grade of the EVIDENCE, not a probability anybody measured.
 * They exist to be ordered and to be compared against one threshold, and
 * dressing them up as calibrated likelihoods would be the same overstatement
 * this module exists to prevent. What matters is that only the top rung is
 * certain, and that the bottom rung sits below the threshold at which anything
 * is proposed at all unless it is unambiguous.
 */
const CONFIDENCE = Object.freeze({
  [MAPPING_METHOD.PUBLISHED_ID]: 1,
  [MAPPING_METHOD.EXACT_NAME]: 0.9,
  [MAPPING_METHOD.NORMALISED_NAME]: 0.7,
  [MAPPING_METHOD.SIZE_AND_MATERIAL]: 0.55,
  [MAPPING_METHOD.SHAPE_SIMILARITY]: 0.4,
  [MAPPING_METHOD.MANUAL]: 1,
});

/**
 * Below this a match is not even offered.
 *
 * A piece showing "needs mapping" is a piece somebody will look at. A piece
 * showing a wrong 41% suggestion is a piece somebody will accept.
 */
const PROPOSE_ABOVE = 0.5;

/** Only this rung is stored as settled without a person. */
const SELF_EVIDENT = new Set([MAPPING_METHOD.PUBLISHED_ID]);

/* ═══ NAMES ════════════════════════════════════════════════════════════════ */

/**
 * A name reduced to what it is actually saying.
 *
 * Case, separators and the words every exporter adds are removed; the words
 * that DISTINGUISH pieces are not. `left` and `right` survive, because folding
 * them away is how a left sleeve maps to a right one — the single most likely
 * wrong answer in this whole module, and the one hardest to spot on screen.
 */
function normaliseName(value) {
  return str(value)
    .toLowerCase()
    .replace(/\.(glb|gltf|dxf|obj)$/i, "")
    /* Exporter noise: a trailing counter, a mesh/node suffix, a copy marker. */
    .replace(/\b(mesh|node|geo|geom|shape|obj|object|pattern|piece|panel|part|copy|final|new)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The side a name states, where it states one. Never inferred from position. */
function sideOf(value) {
  const name = ` ${normaliseName(value)} `;
  const left = /\s(left|lh|l)\s/.test(name);
  const right = /\s(right|rh|r)\s/.test(name);
  if (left && !right) return "left";
  if (right && !left) return "right";
  return "";
}

/** Tokens, for a comparison that does not care about word order. */
const tokensOf = (value) => new Set(normaliseName(value).split(" ").filter(Boolean));

/**
 * How alike two names are, as the share of tokens they have in common.
 *
 * Jaccard rather than an edit distance, because the real variation between a
 * pattern name and a mesh name is word order and extra words, not typos:
 * "Front Bodice" against "bodice_front_01" is a token problem, and an edit
 * distance scores it as badly as two genuinely unrelated names.
 */
function nameSimilarity(a, b) {
  const left = tokensOf(a);
  const right = tokensOf(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/* ═══ WHAT THE MODEL OFFERS TO BE MAPPED TO ════════════════════════════════ */

/**
 * Trim, binding and stitch geometry a CLO export writes beside the garment.
 *
 * Excluded from the pattern-piece candidates because they are NOT pattern
 * pieces: a `BindedTrim_57204` is the stitching CLO generated along a seam, and
 * offering nineteen of them as candidate matches for a front bodice buries the
 * one real answer. They stay in the structure and stay anchorable — a marker
 * can be placed on one — they are simply not proposed as pieces.
 */
/* ── WHY A LOOKAHEAD AND NOT `\b` ──────────────────────────────────────────
   Exporters separate a name from its counter with an underscore, and `_` is a
   word character — so `\b` finds no boundary in `BindedTrim_57204` and the
   pattern silently matches nothing. Nineteen trim meshes were offered as
   candidate pattern pieces because of exactly that. The test is "not followed
   by another letter", which is what was meant. */
const TRIM_NODE = /^(binded\s*trim|trim|stitch|topstitch|button|buttonhole|zipper|zip|seam|fold|puckering|elastic|binding)(?![a-z])/i;

/** Rig and avatar scaffolding. Has no mesh, and is not a garment component. */
const RIG_NODE = /^(joint|bone|armature|skeleton|rig|pelvis|spine|clavicle|thigh|shin|ankle|toe|shoulder|elbow|wrist|hand|finger|thumb|head|eye|jaw|avatar|mannequin)(?![a-z])/i;

/**
 * The 3D components a pattern piece could sensibly BE.
 *
 * @param {object[]} structure the publication's stored scene graph
 */
function garmentComponents(structure = []) {
  return structure.filter((node) => (
    node.kind === "mesh"
    && !TRIM_NODE.test(str(node.name))
    && !RIG_NODE.test(str(node.name))
  ));
}

/**
 * CAN THIS MODEL IDENTIFY PATTERN PIECES AT ALL?
 *
 * ── THE TWO WAYS THE ANSWER IS NO, AND WHY THEY ARE DIFFERENT ───────────────
 * The first is the one the brief names: an export with ONE mesh called
 * `Object_2`. Nothing in it is separable and nothing in it is named.
 *
 * The second is subtler and is what a real CLO export actually does. It writes
 * the whole garment as one mesh called `Cloth` — a genuine name, so every
 * naming check passes — surrounded by nineteen separately named trim meshes. A
 * check that only asked "are the meshes named" would report this model as fully
 * identifiable and then fail to match a single one of five pattern pieces,
 * leaving a reader to conclude the pattern was at fault.
 *
 * So the question asked here is the one that matters: how many GARMENT meshes
 * are there, as opposed to how many meshes are named. One garment mesh is one
 * merged garment however well it is labelled, and that is reported plainly.
 */
function componentAvailability(structure = [], pieceCount = 0) {
  const components = garmentComponents(structure);
  const named = components.filter((node) => !node.generatedName);
  const allMeshes = structure.filter((node) => node.kind === "mesh");

  const merged = components.length <= 1;
  /* Fewer garment components than pattern pieces means some pieces cannot have
     a component of their own, whatever the matcher does. Said up front rather
     than discovered as a list of unexplained failures. */
  const fewerThanPieces = pieceCount > 0 && components.length > 0 && components.length < pieceCount;

  let limitation = "";
  if (!allMeshes.length) {
    limitation = "This 3D export contains no mesh, so there is nothing for a pattern piece to map to.";
  } else if (merged) {
    /* The brief's own sentence, because it is the right one: it says what the
       file is, says what follows from that, and blames neither the pattern nor
       the reader. */
    limitation = "This 3D export contains one merged garment mesh, so individual pattern pieces "
      + "cannot be highlighted in 3D.";
  } else if (!named.length) {
    limitation = `This 3D export contains ${components.length} unnamed garment meshes, so a pattern `
      + "piece cannot be matched to one by name. Re-export from CLO with pattern-piece names switched on.";
  } else if (fewerThanPieces) {
    limitation = `This pattern has ${pieceCount} pieces and the 3D export publishes `
      + `${components.length} garment ${components.length === 1 ? "mesh" : "meshes"}, so the pieces are `
      + "merged in the model and cannot each be highlighted separately. Export the pattern pieces as "
      + "separate objects from CLO to map them one to one.";
  }

  return {
    /* True only when a piece could, in principle, be matched to a component of
       its own and named. Everything else is honest about why not. */
    identifiable: !merged && named.length > 0 && !fewerThanPieces,
    mergedGarmentMesh: merged,
    components: components.length,
    namedComponents: named.length,
    totalMeshes: allMeshes.length,
    trimMeshes: allMeshes.length - components.length,
    limitation,
  };
}

/* ═══ THE MATCH ════════════════════════════════════════════════════════════ */

/**
 * Propose the best mapping for one piece, or nothing.
 *
 * Returns the first rung that produces an UNAMBIGUOUS answer. Ambiguity is
 * treated as failure at every rung on purpose: two meshes matching a piece
 * equally well is not a reason to pick one, it is the reason a person is asked.
 */
function proposeForPiece(piece, components) {
  const candidates = components.filter((node) => !node.mapped);

  /* ── 1. AN IDENTIFIER BOTH FILES PUBLISHED ──────────────────────────────
     Compared case-insensitively and nothing else: an id is an id, and
     normalising one would be inventing a match between two different ids. */
  const publishedId = str(piece.publishedId);
  if (publishedId) {
    const exact = candidates.filter((node) => (
      str(node.name).toLowerCase() === publishedId.toLowerCase()
      || str(node.meshName).toLowerCase() === publishedId.toLowerCase()
    ));
    if (exact.length === 1) {
      return {
        node: exact[0],
        method: MAPPING_METHOD.PUBLISHED_ID,
        basis: `The pattern and the model both publish the identifier "${publishedId}".`,
      };
    }
  }

  /* ── 2. THE SAME NAME, EXACTLY ──────────────────────────────────────────
     Only for a name somebody actually chose. Two pieces called
     `Pattern_636968` and a mesh called `Pattern_636968` would match here and
     mean nothing, because neither name is a statement about the garment. */
  const pieceName = str(piece.name);
  if (pieceName && !piece.generatedName) {
    const exact = candidates.filter((node) => (
      str(node.name).toLowerCase() === pieceName.toLowerCase() && !node.generatedName
    ));
    if (exact.length === 1) {
      return {
        node: exact[0],
        method: MAPPING_METHOD.EXACT_NAME,
        basis: `The pattern piece and the 3D component are both named "${pieceName}".`,
      };
    }
  }

  /* ── 3. THE SAME NAME, ALLOWING FOR HOW TWO EXPORTERS WRITE IT ──────────
     And REFUSING to cross a stated side. A piece that says "left" is never
     matched to a component that says "right", at any similarity — the names are
     otherwise identical, which is exactly why the scorer would rank it first. */
  if (pieceName && !piece.generatedName) {
    const pieceSide = sideOf(pieceName);
    const scored = candidates
      .filter((node) => !node.generatedName)
      .map((node) => {
        const nodeSide = sideOf(node.name);
        const contradictorySide = pieceSide && nodeSide && pieceSide !== nodeSide;
        return {
          node,
          score: contradictorySide ? 0 : nameSimilarity(pieceName, node.name),
          contradictorySide,
        };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const runnerUp = scored[1];
    /* A clear winner only. Two components scoring the same is the ambiguity a
       person exists to settle, and picking the first is picking arbitrarily. */
    if (best && best.score >= 0.6 && (!runnerUp || runnerUp.score < best.score - 0.15)) {
      return {
        node: best.node,
        method: MAPPING_METHOD.NORMALISED_NAME,
        basis: `"${pieceName}" and "${best.node.name}" read as the same component once separators and `
          + `exporter wording are set aside (${Math.round(best.score * 100)}% of words in common).`,
      };
    }
  }

  /* ── 4. SIZE AND MATERIAL ───────────────────────────────────────────────
     Only ever decisive when it leaves exactly one candidate, which is rare and
     real: one piece in rib, one component whose material is the rib. */
  const material = str(piece.material);
  if (material) {
    const byMaterial = candidates.filter((node) => (
      (node.materialNames || []).some((name) => nameSimilarity(material, name) >= 0.5)
    ));
    if (byMaterial.length === 1) {
      return {
        node: byMaterial[0],
        method: MAPPING_METHOD.SIZE_AND_MATERIAL,
        basis: `This is the only 3D component whose material matches the piece's "${material}".`,
      };
    }
  }

  /* ── 5. SHAPE SIMILARITY IS NOT PROPOSED AS A MAPPING ───────────────────
     It is computed and offered as a SUGGESTION elsewhere, and it is deliberately
     not returned from here. Its confidence sits below the threshold, so a
     mapping built on it alone would be stored unconfirmed and shown as a guess;
     what the brief asks is that it never become a mapping without a person, and
     the way to guarantee that is not to create one. */
  return null;
}

/**
 * Area-based suggestions for a piece nothing else matched.
 *
 * ── WHY THESE ARE OFFERED AT ALL, GIVEN THEY PROVE NOTHING ──────────────────
 * Because the alternative is a list of twenty mesh names in arbitrary order.
 * Somebody mapping a pattern by hand is helped by having the plausible
 * candidates first, and is not helped by being told a 43% area overlap is a
 * match. So they are ordered, capped, and returned under a name that cannot be
 * mistaken for a decision.
 *
 * Triangle count is used as the proxy for component size. It is a weak proxy —
 * tessellation density varies per material — and that is said rather than
 * smoothed over.
 */
function suggestionsFor(piece, components, { limit = 4 } = {}) {
  const totalTriangles = components.reduce((sum, node) => sum + (node.triangles || 0), 0);
  const area = piece.area;
  if (!totalTriangles || !area) return [];

  /* The piece's share of the pattern's area, against the component's share of
     the model's triangles. Both are proportions, so neither needs a unit. */
  return components
    .map((node) => ({
      nodeRef: node.nodeRef,
      nodeName: str(node.name),
      triangles: node.triangles || 0,
      share: (node.triangles || 0) / totalTriangles,
      nameLikeness: Number(nameSimilarity(piece.name, node.name).toFixed(3)),
    }))
    .sort((a, b) => b.nameLikeness - a.nameLikeness || b.triangles - a.triangles)
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      /* Said in the payload, so no screen can present this as a match. */
      kind: "suggestion",
      basis: "Offered to shorten a manual search. Relative size and name wording cannot distinguish "
        + "a left piece from a right one, and this is not a mapping.",
    }));
}

/**
 * PROPOSE MAPPINGS FOR A WHOLE PATTERN SET.
 *
 * @param {object}   patternSet  the stored, parsed set
 * @param {object[]} structure   the publication's 3D scene graph
 * @param {object[]} existing    mappings already on the publication; confirmed
 *                               ones are preserved and never re-proposed
 * @param {number}   revision    the mapping revision these belong to
 */
function proposeMappings(patternSet, structure = [], existing = [], revision = 1) {
  const pieces = patternSet?.pieces || [];
  const availability = componentAvailability(structure, pieces.length);
  const components = garmentComponents(structure)
    .map((node) => ({ ...plain(node), mapped: false }));

  /* ── WHAT A PERSON ALREADY DECIDED IS NOT RE-DECIDED ────────────────────
     Confirmed and rejected mappings both survive a re-match. A matcher that
     re-proposed a mapping somebody rejected would ask the same question every
     time the pattern was re-parsed, and a matcher that overwrote a confirmed
     one would discard the only evidence in the system that has a name on it. */
  const settled = new Map();
  for (const stored of existing) {
    const mapping = plain(stored);
    if (mapping.state === MAPPING_STATE.CONFIRMED || mapping.state === MAPPING_STATE.REJECTED) {
      settled.set(mapping.pieceRef, mapping);
      if (mapping.state === MAPPING_STATE.CONFIRMED) {
        const taken = components.find((node) => node.nodeRef === mapping.nodeRef);
        /* A component confirmed as a repeated left/right pair stays available:
           that is the whole point of the flag. */
        if (taken && !mapping.repeatedComponent) taken.mapped = true;
      }
    }
  }

  const mappings = [];
  const unmapped = [];

  for (const piece of pieces) {
    const already = settled.get(piece.pieceRef);
    if (already) {
      mappings.push({ ...already, mappingRevision: revision });
      if (already.state === MAPPING_STATE.REJECTED) {
        unmapped.push({ pieceRef: piece.pieceRef, pieceName: piece.name, reason: "rejected" });
      }
      continue;
    }

    const proposal = availability.totalMeshes ? proposeForPiece(piece, components) : null;
    if (!proposal) {
      unmapped.push({
        pieceRef: piece.pieceRef,
        pieceName: piece.name,
        /* The reason is the file's, and it is named. "Needs mapping" with no
           explanation is a to-do; with one it is actionable. */
        reason: availability.mergedGarmentMesh ? "merged_model"
          : (piece.generatedName ? "piece_unnamed" : "no_match"),
        suggestions: suggestionsFor(piece, components),
      });
      continue;
    }

    const confidence = CONFIDENCE[proposal.method] ?? 0;
    const selfEvident = SELF_EVIDENT.has(proposal.method);

    /* ── THE THRESHOLD, APPLIED ONCE AND HERE ───────────────────────────── */
    if (confidence < PROPOSE_ABOVE) {
      unmapped.push({
        pieceRef: piece.pieceRef,
        pieceName: piece.name,
        reason: "low_confidence",
        suggestions: suggestionsFor(piece, components),
      });
      continue;
    }

    proposal.node.mapped = true;
    mappings.push({
      pieceRef: piece.pieceRef,
      pieceName: str(piece.name),
      nodeRef: proposal.node.nodeRef,
      nodeName: str(proposal.node.name),
      method: proposal.method,
      confidence,
      basis: proposal.basis,
      /* ── THE ONE AUTOMATIC CONFIRMATION, AND WHY IT IS SAFE ───────────
         A published identifier shared by both files is not this module's
         opinion — it is a statement the two exports agree on. Everything else
         waits for a person, which is what "never silently accept a
         low-confidence match" means in code rather than in a comment. */
      state: selfEvident ? MAPPING_STATE.CONFIRMED : MAPPING_STATE.UNCONFIRMED,
      confirmedAt: selfEvident ? new Date() : null,
      repeatedComponent: false,
      mappingRevision: revision,
    });
  }

  /* ── COMPONENTS NOTHING MAPPED TO ───────────────────────────────────────
     Reported as a derived check rather than as an error: a model legitimately
     contains geometry no pattern piece corresponds to — a trim, a binding, an
     avatar. What is worth flagging is a MEANINGFUL one, which is a named
     garment mesh carrying real geometry. */
  const mappedRefs = new Set(mappings
    .filter((m) => m.state !== MAPPING_STATE.REJECTED)
    .map((m) => m.nodeRef));
  const unmatchedComponents = garmentComponents(structure)
    .filter((node) => !mappedRefs.has(node.nodeRef) && !node.generatedName && (node.triangles || 0) > 0)
    .map((node) => ({ nodeRef: node.nodeRef, nodeName: str(node.name), triangles: node.triangles }));

  return {
    mappings,
    unmapped,
    unmatchedComponents,
    availability,
    mappingRevision: revision,
    /* How many mappings a person still has to look at. The number a workspace
       puts on a badge, and it counts unconfirmed proposals as outstanding —
       because they are. */
    awaitingConfirmation: mappings.filter((m) => m.state === MAPPING_STATE.UNCONFIRMED).length,
  };
}

/* ═══ MINTING PIECE REFS ═══════════════════════════════════════════════════ */

/**
 * A stable handle for one piece, derived from what the file published.
 *
 * ── WHY DERIVED AND NOT RANDOM ──────────────────────────────────────────────
 * Re-parsing the same DXF must produce the same refs, or every confirmed
 * mapping is orphaned the moment somebody re-uploads an identical file. So the
 * ref is a hash of the facts that identify the piece within its set, which is
 * stable across parses and across servers, and the index is included so two
 * genuinely identical pieces — a left and a right sleeve drawn the same, which
 * is the common case — still get different refs.
 */
function mintPieceRef(piece, index) {
  const basis = [
    str(piece.publishedId), str(piece.blockName), str(piece.name), str(piece.size),
    String(index),
  ].join("|");
  return `PP-${crypto.createHash("sha256").update(basis).digest("hex").slice(0, 10).toUpperCase()}`;
}

module.exports = {
  proposeMappings, componentAvailability, garmentComponents, plain,
  mintPieceRef, normaliseName, nameSimilarity, sideOf, suggestionsFor,
  CONFIDENCE, PROPOSE_ABOVE, TRIM_NODE, RIG_NODE,
};
