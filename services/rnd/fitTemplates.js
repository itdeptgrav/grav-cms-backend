// services/rnd/fitTemplates.js
//
// THE THREE CATEGORIES, AS DATA.
//
// Implements `docs/product/rnd-fit/garment-template-contract.md` §5 and §6.
//
// ── WHY ROLE VOCABULARIES ARE PER TEMPLATE AND NOT GLOBAL ───────────────────
// "Band" means a neck band on a tee and a cuff band on a polo sleeve. A single
// global list would invent a distinction nobody in a sampling room makes, so each
// template declares its own vocabulary and a piece's role is only ever compared
// against the roles its template declared.
//
// ── AND WHY THE REQUIRED LISTS ARE THIS SHORT ───────────────────────────────
// Front, back, sleeves, and a neck finish. Nothing else. An earlier draft of the
// specification required a yoke and a cuff, which would have refused a
// short-sleeved band-collar shirt — an entirely ordinary garment (§6.3). Every
// other role is optional with conditional rules when it is present.
//
// Nothing in this file looks at a piece's NAME. A role is assigned by a person,
// or confirmed from a suggestion, and that is the first of the contract's three
// rules (§1).
"use strict";

/* The run vocabulary is shared across the three categories because a shoulder run
   is a shoulder run on all of them. A template narrows it by which roles it
   requires, not by renaming them. */
const RUN_ROLES = Object.freeze([
  "shoulder", "side", "armhole.front", "armhole.back", "armhole",
  "neck.front", "neck.back", "neck",
  "cap", "underarm", "sleeve.lower", "sleeve.slit",
  "hem", "sleeve.hem", "join", "opening", "fold", "upper", "lower", "outer", "vent",
]);

/**
 * A neck finish is satisfied by any of these. The template requires *a* finish,
 * not a specific one — a band-collar shirt satisfies it with a stand alone.
 */
const NECK_FINISH_ROLES = Object.freeze([
  "neck.band", "collar.flat", "collar.stand", "collar.fall", "neck.facing",
]);

const isNeckFinish = (role) => NECK_FINISH_ROLES.includes(String(role || ""));

/**
 * Pieces that exist in the garment but take no part in the drape.
 *
 * Not a cosmetic exclusion: shoulder tape and labels are not garment shape, and
 * simulating a label as cloth puts a 40mm square of fabric inside the back panel.
 */
const NOT_SIMULATED_ROLES = Object.freeze([
  "reinforcement.shoulder", "reinforcement.placket", "reinforcement",
  "label", "label.brand", "label.care", "label.size",
  "interlining.collar", "interlining.cuff", "interlining", "interlining.placket",
]);

/* Interlining and lining are layers, not roles, and the layer decides too. */
const NOT_SIMULATED_LAYERS = Object.freeze(["interlining"]);

/**
 * How much the two sides of a seam may differ, as a share of the shorter side.
 *
 * Per seam role, because a neck band is *meant* to be 10–25% shorter than the
 * opening it is stretched onto, while a side seam is meant to match exactly. A
 * single global tolerance would either refuse every neck band or accept a sleeve
 * cap mapped to the wrong armhole.
 */
const EASE_ALLOWANCE = Object.freeze({
  shoulder: 0.02,
  side: 0.0,
  armhole: 0.05,
  cap: 0.05,
  neck: 0.25,
  join: 0.25,
  cuff: 0.10,
  placket: 0.03,
  /* Anything the template did not name. Deliberately tight: a seam whose role
     nobody stated is a seam nobody has reviewed. */
  default: 0.05,
});

/**
 * THE DIFFERENCE BELOW WHICH THERE IS NO EASE TO TALK ABOUT.
 *
 * A side seam allows no ease, and 0.0 is the right product rule: two side seams
 * that do not match are a pattern fault, not a sewing allowance. But a ratio of
 * zero cannot be evaluated against lengths accumulated in floating point. The
 * genuine CLO tee's two side seams are 400.2140 mm each — identical to four
 * decimal places and different in the last bits of a double, because one is
 * summed over two chords and the other over three. That refused the garment with
 * "0.0% apart, where this seam allows 0%", which is both unactionable and, read
 * aloud, a contradiction.
 *
 * So the rule is kept and the arithmetic is bounded: a difference under a
 * millimetre is not ease. It is below the spacing of the outline points the
 * length was measured along, below the seam allowance it will be sewn at, and
 * below anything a machinist could sew differently if told. Nothing larger is
 * forgiven — one millimetre on a 40 cm seam is 0.25%, so a side seam that is
 * genuinely out by even half a percent still refuses.
 */
const EASE_FLOOR_MM = 1;

const TEMPLATES = Object.freeze({
  tshirt: {
    id: "tshirt",
    label: "Basic T-shirt",
    typicalBehaviour: "knit",
    roles: [
      "body.front", "body.back", "sleeve",
      "neck.band", "neck.facing",
      "pocket.patch", "reinforcement.shoulder", "label.brand", "label.care", "label.size",
    ],
    /* `neckFinish` is required and is the ONE required role whose absence does
       not refuse the fitting — see §6.4 and `neckFinishAbsentIsPartial`. */
    required: ["body.front", "body.back", "sleeve", "neckFinish"],
    requiredCutQuantity: { "body.front": 1, "body.back": 1, sleeve: 2 },
    optional: ["pocket.patch", "reinforcement.shoulder", "label.brand", "label.care", "label.size"],
  },
  polo: {
    id: "polo",
    label: "Polo shirt",
    typicalBehaviour: "knit",
    roles: [
      "body.front", "body.back", "sleeve",
      "collar.flat", "neck.band", "neck.facing",
      "placket.top", "placket.under", "cuff.band",
      "pocket.patch", "interlining.collar", "reinforcement.shoulder", "label.brand",
    ],
    required: ["body.front", "body.back", "sleeve", "neckFinish"],
    requiredCutQuantity: { "body.front": 1, "body.back": 1, sleeve: 2 },
    optional: ["collar.flat", "placket.top", "placket.under", "cuff.band", "pocket.patch"],
    /* When one of a pair is present the other must be too: a top placket with no
       under placket is half a placket. */
    pairedRoles: [["placket.top", "placket.under"]],
  },
  "woven-shirt": {
    id: "woven-shirt",
    label: "Basic woven shirt",
    typicalBehaviour: "woven",
    roles: [
      "body.front", "body.back", "sleeve",
      "collar.stand", "collar.fall", "neck.band", "neck.facing",
      "panel.upper-back", "cuff", "placket.front", "sleeve.opening",
      "pocket.patch", "interlining.collar", "interlining.cuff", "label.brand",
    ],
    required: ["body.front", "body.back", "sleeve", "neckFinish"],
    /* A front may be one piece or two halves, so the quantity is a range. */
    requiredCutQuantity: { "body.back": 1, sleeve: 2 },
    optional: [
      "collar.stand", "collar.fall", "panel.upper-back", "cuff",
      "placket.front", "sleeve.opening", "pocket.patch",
    ],
    /* A fall needs a stand to sit on. */
    requiresWhenPresent: { "collar.fall": ["collar.stand"] },
  },
});

const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

/** The template, or null. Null is an answer: readiness names it. */
function templateFor(id) {
  return TEMPLATES[String(id || "")] || null;
}

/**
 * How much ease this seam's role allows.
 *
 * Matched on the longest role prefix so `armhole.front` falls to `armhole` and
 * `neck.band` to `neck`, rather than silently taking the default.
 */
function easeAllowanceFor(seamRole) {
  const role = String(seamRole || "");
  if (!role) return EASE_ALLOWANCE.default;
  if (EASE_ALLOWANCE[role] !== undefined) return EASE_ALLOWANCE[role];
  const head = role.split(".")[0];
  return EASE_ALLOWANCE[head] !== undefined ? EASE_ALLOWANCE[head] : EASE_ALLOWANCE.default;
}

/** Does this piece take part in the drape? */
function simulates(plan) {
  const role = String(plan?.role || "");
  if (NOT_SIMULATED_LAYERS.includes(String(plan?.layer || ""))) return false;
  if (NOT_SIMULATED_ROLES.includes(role)) return false;
  if (role.startsWith("label.") || role.startsWith("reinforcement.")) return false;
  if (role.startsWith("interlining")) return false;
  return true;
}

/**
 * Construction this product does not model, and the sentence it must carry.
 *
 * From §7. These appear beside the fitting rather than in a document, because
 * somebody looking at a flat-lying polo collar will otherwise conclude the
 * pattern is wrong.
 */
const UNMODELLED = Object.freeze([
  {
    whenRole: ["collar.flat", "collar.stand", "collar.fall"],
    sentence: "This fitting does not model the collar's roll or stand — the collar is "
      + "simulated lying flat. Judge the stand from the sample.",
  },
  {
    whenRole: ["neck.band"],
    sentence: "The neck band is shown as a single layer, so it will look thinner than the "
      + "made garment.",
  },
  {
    whenRole: ["interlining.collar", "interlining.cuff", "interlining"],
    sentence: "Interlining is not modelled. A fused collar is stiffer than anything this "
      + "fabric profile can express.",
  },
  {
    whenRole: ["placket.top", "placket.under", "placket.front"],
    sentence: "Placket layer thickness, buttons and buttonholes are not modelled.",
  },
  {
    whenSeamType: ["flat-felled"],
    sentence: "A flat-felled seam is four layers and behaves stiffer than the panels either "
      + "side of it. Seam stiffness is not modelled.",
  },
]);

module.exports = {
  TEMPLATES, TEMPLATE_IDS, RUN_ROLES, NECK_FINISH_ROLES, NOT_SIMULATED_ROLES,
  EASE_ALLOWANCE, UNMODELLED,
  templateFor, easeAllowanceFor, EASE_FLOOR_MM, simulates, isNeckFinish,
};
