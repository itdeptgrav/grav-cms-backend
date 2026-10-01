// models/CMS_Models/IndustrialEngineering/processRoute.schema.js
//
// THE PROCESS ROUTE — WHICH PRODUCTION PROCESSES A STYLE PASSES THROUGH.
//
// An IE statement, approved with the bulletin: this garment is cut, then
// embroidered, then sewn; or it is cut and sewn and embroidery does NOT apply.
// It is what Planning reads to know which stages exist for a confirmed line.
//
// ── DECLARED, NEVER INFERRED ─────────────────────────────────────────────────
// Nothing here is derived from an operation's name, code or machine type. A
// bulletin row called "EMB LOGO" is not evidence that embroidery is a stage, and
// a route read off names would be believed exactly when it was wrong. Every stage
// is typed by a person choosing a process, and approved by a second one.
//
// ── NOT A UNIVERSAL ROUTE ────────────────────────────────────────────────────
// `PROCESS_KINDS` is the vocabulary a stage is typed in, not an order. The order
// is the route's own: each stage names the stages that must finish before it,
// and two stages with no path between them run in parallel. Nothing in this file
// says cutting comes first.
//
// ── ONE SHAPE, TWO HOMES ─────────────────────────────────────────────────────
// The draft lives on the engineering file beside the draft bulletin, and is
// frozen into each submitted bulletin version. Both use this schema, so the
// draft and what was approved can never be spelled differently.
"use strict";

const mongoose = require("mongoose");

/* The vocabulary. `OTHER` exists so a real process this list does not name can
   still be declared — with a label saying what it is — rather than forced into
   the nearest wrong word. */
const PROCESS_KINDS = Object.freeze([
  "CUTTING", "EMBROIDERY", "PRINTING", "SEWING", "WASHING", "FINISHING", "PACKING", "OTHER",
]);

/* Explicit both ways. `NOT_APPLICABLE` is an approved answer — "this style is
   not embroidered" — and is different from a route that never mentions
   embroidery, which says nothing either way. */
const APPLICABILITY = Object.freeze(["REQUIRED", "NOT_APPLICABLE"]);

const ROUTE_LIMITS = Object.freeze({ STAGES: 30, LABEL: 120, PREDECESSORS: 30 });

/* ══ THE TECHNICAL STANDARD ON A STAGE ═══════════════════════════════════════
 *
 * How much WORK a required stage is, as Industrial Engineering states it. It
 * is the same kind of statement as the route itself — declared by a person,
 * approved with the bulletin, frozen into the release — and it exists so that
 * Planning can calculate a workload instead of guessing one.
 *
 * ── WHY IT IS TYPED, AND WHY IT CARRIES ITS OWN UNITS ──────────────────────
 * A bare number called "sam" on a stage is the beginning of every unit bug
 * this industry has: minutes per piece read as minutes per order, a garment
 * SAM read as a cutting SAM, seconds read as minutes. So the kind is named,
 * each figure states its own unit as stored data rather than convention, and
 * a reader that does not recognise the kind refuses the standard instead of
 * doing arithmetic on it.
 *
 * ── AND WHY IT IS NOT DERIVED FROM ANYTHING ────────────────────────────────
 * Nothing here is computed from the garment SAM, the sewing SAM, an
 * operation's name or code, a machine's name, or a later release. Those
 * describe other work or other versions, and a cutting standard inferred from
 * one of them is a number nobody approved. It is authored, or it is absent —
 * and absent is a state Planning is told about by name.
 */
const STANDARD_KINDS = Object.freeze(["CUTTING_SAM"]);

/* Stored on each figure, so a reader never has to assume which unit a number
   is in. Single-valued today on purpose: a second unit is a schema change and
   a migration, not a silent reinterpretation of existing rows. */
const STANDARD_UNITS = Object.freeze(["MINUTES_PER_PIECE"]);
const SETUP_UNITS = Object.freeze(["MINUTES_PER_ORDER"]);

/* The KIND of cutting resource the standard assumes. A type, never a specific
   machine: which table or knife is used is Cutting's own asset record and
   Cutting's own decision, and a route that named one would be IE allocating
   equipment it does not own. */
const CUTTING_RESOURCE_TYPES = Object.freeze([
  "STRAIGHT_KNIFE", "BAND_KNIFE", "AUTO_CUTTER", "DIE_PRESS", "MANUAL_SCISSOR", "OTHER",
]);

/* How the figure was arrived at. Recorded because "4.5 minutes" means
   something different when it is a time study than when it is an estimate,
   and a planner deciding whether to trust it needs to know which. */
const STANDARD_METHODS = Object.freeze([
  "TIME_STUDY", "PREDETERMINED_MOTION", "HISTORICAL_ACTUAL", "ENGINEERING_ESTIMATE",
]);

/* ── WHAT A MINUTE ON THIS STANDARD MEANS ──────────────────────────────────
 *
 * `standardMinutesPerPiece: 0.8` says nothing on its own. Is it 0.8 minutes of
 * one person's labour, so three people cut three times as fast? Or 0.8 minutes
 * of wall-clock time for a crew of three, so a fourth person changes nothing?
 * Those are different numbers with the same name, and a planner dividing the
 * wrong one by a headcount is wrong by a factor of three.
 *
 * So the basis is declared, and EVERY time figure on the standard — the
 * per-piece minutes and the setup minutes alike — is in it. There is no second
 * basis for setup: a standard with two clocks is a standard nobody can add up.
 */
const TIME_BASES = Object.freeze(["LABOUR_MINUTES", "TEAM_ELAPSED_MINUTES"]);

/* ── AND WHETHER MORE PEOPLE HELP ──────────────────────────────────────────
 * Never assumed, always declared. Linear scaling is an assumption that is
 * wrong for most cutting rooms — one knife, one lay — and a planner that
 * assumed it would promise throughput no floor can deliver.
 *
 *   LINEAR         within the validated crew range, output rises with crew.
 *                  ABOVE the maximum useful crew nothing is claimed: that is
 *                  not "no further benefit", it is "not measured", and the
 *                  two are different answers.
 *   CAPPED_LINEAR  output rises with crew up to the maximum useful crew and
 *                  saturates there — extra people are positively known not to
 *                  help.
 *   FIXED_TEAM     the figure is for this exact crew. Adding people does not
 *                  increase output, and removing one does not merely slow it:
 *                  the standard no longer applies at all.
 */
const SCALING_METHODS = Object.freeze(["LINEAR", "FIXED_TEAM", "CAPPED_LINEAR"]);

/* The roles a cutting crew is composed of. A closed list, because a crew
   composition that could be free text is one nobody can plan against. */
const CREW_ROLES = Object.freeze([
  "CUTTER", "SPREADER_OR_HELPER", "MARKER_PLANNER", "BUNDLER", "QUALITY_CHECKER",
]);

const STANDARD_LIMITS = Object.freeze({
  /* Bounded on both sides. Zero is not a standard — it would make a stage
     free — and the ceilings are absurdity guards, not engineering opinions:
     a figure beyond them is a unit mistake, not a slow process. */
  MIN_STANDARD_MINUTES: 0.001,
  MAX_STANDARD_MINUTES: 600,
  MIN_SETUP_MINUTES: 0,
  MAX_SETUP_MINUTES: 10080,
  BASIS: 2000,
  REFERENCE: 120,
  LABEL: 120,
  /* A crew is people, so whole numbers, and bounded: a cutting crew of 200 is
     a unit mistake, not a cutting room. */
  MIN_CREW: 1,
  MAX_CREW: 60,
  /* Efficiency as a percentage of the standard, bounded well either side of
     100 so a real floor's 65% or a very good one's 120% both fit, and 0 or
     4000 do not. */
  MIN_EFFICIENCY: 1,
  MAX_EFFICIENCY: 200,
  ROLES: 10,
});

/* One role in the approved crew composition. */
const crewRoleSchema = new mongoose.Schema(
  {
    role: { type: String, enum: CREW_ROLES, required: true },
    count: { type: Number, required: true, min: 1, max: STANDARD_LIMITS.MAX_CREW },
  },
  { _id: false },
);

/**
 * WHAT THE FIGURE ASSUMES ABOUT PEOPLE.
 *
 * Required on every cutting standard. Its absence is not a gentler version of
 * the standard — it is a standard whose minutes cannot be interpreted, and PPC
 * refuses it rather than picking a meaning.
 */
const capacityModelSchema = new mongoose.Schema(
  {
    timeBasis: { type: String, enum: TIME_BASES, required: true },

    /* The crew the figure was measured on, and the range over which it was
       validated. `minimum` is the crew below which the standard does not
       apply at all — not a slower version of it. */
    standardCrewSize: {
      type: Number, required: true, min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW,
    },
    minimumCrewSize: {
      type: Number, required: true, min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW,
    },
    maximumUsefulCrewSize: {
      type: Number, required: true, min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW,
    },

    scalingMethod: { type: String, enum: SCALING_METHODS, required: true },

    /* The efficiency the figure already assumes. Recorded so a later capacity
       calculation does not apply it twice — a mistake that halves a plan. */
    standardEfficiencyPercent: {
      type: Number, required: true,
      min: STANDARD_LIMITS.MIN_EFFICIENCY, max: STANDARD_LIMITS.MAX_EFFICIENCY,
    },

    /* Who is in that crew. A planner allocating three people needs to know
       whether that is three cutters or one cutter and two spreaders. */
    requiredRoles: { type: [crewRoleSchema], required: true },
  },
  { _id: false },
);

const technicalStandardSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: STANDARD_KINDS, required: true },

    /* The work itself, each figure with its unit beside it. */
    standardMinutesPerPiece: {
      type: Number, required: true,
      min: STANDARD_LIMITS.MIN_STANDARD_MINUTES, max: STANDARD_LIMITS.MAX_STANDARD_MINUTES,
    },
    standardUnit: { type: String, enum: STANDARD_UNITS, required: true },
    /* Paid once per order or batch, not per piece: marker setting, spreading,
       blade change. Zero is a legitimate answer here — some processes have no
       setup — which is why its floor differs from the standard's. */
    setupMinutesPerOrder: {
      type: Number, required: true,
      min: STANDARD_LIMITS.MIN_SETUP_MINUTES, max: STANDARD_LIMITS.MAX_SETUP_MINUTES,
    },
    setupUnit: { type: String, enum: SETUP_UNITS, required: true },

    resourceType: { type: String, enum: CUTTING_RESOURCE_TYPES, required: true },
    /* Required when the type is OTHER, so an unnamed resource is never just
       "other" to the person reading it a year later. */
    resourceLabel: { type: String, trim: true, default: "", maxlength: STANDARD_LIMITS.LABEL },

    /* What the figure assumes, in a person's words: ply height, marker
       efficiency, fabric, how many pieces per lay. Not derivable from any
       other record, which is exactly why it is stored. */
    basis: { type: String, trim: true, required: true, maxlength: STANDARD_LIMITS.BASIS },

    /* Where it came from, so it can be audited back to its study. */
    source: {
      method: { type: String, enum: STANDARD_METHODS, required: true },
      reference: { type: String, trim: true, default: "", maxlength: STANDARD_LIMITS.REFERENCE },
    },

    /* What the minutes above mean, and whether more people change them. Both
       figures share this one basis — see TIME_BASES. */
    capacityModel: { type: capacityModelSchema, required: true },

    /* Who stated it and when. The APPROVAL is the bulletin version's — this
       standard is frozen into it by a second person, and the version and
       release numbers it travels in are its approval trail. Duplicating them
       here would create two answers that can disagree. */
    declaredAt: { type: Date, required: true },
    declaredByName: { type: String, trim: true, default: "", maxlength: STANDARD_LIMITS.LABEL },
  },
  { _id: false },
);

const stageSchema = new mongoose.Schema(
  {
    /* Server-minted once and kept through every edit and every version, so a
       plan keyed on it survives a revision of the route. */
    stageId: { type: String, required: true, trim: true },
    /* Display order only. Dependencies are `predecessorStageIds`, and every
       predecessor sits earlier in this order, so the list is always readable
       top to bottom. */
    sequence: { type: Number, required: true, min: 1 },
    process: { type: String, enum: PROCESS_KINDS, required: true },
    label: { type: String, trim: true, default: "", maxlength: ROUTE_LIMITS.LABEL },
    applicability: { type: String, enum: APPLICABILITY, required: true },
    predecessorStageIds: { type: [{ type: String, trim: true }], default: () => [] },
    /* Absent unless IE has stated one. Absent is a real state — the stage is
       declared and its work is not — and Planning is told so by name rather
       than left to read a missing number as zero. */
    technicalStandard: { type: technicalStandardSchema, default: null },
  },
  { _id: false },
);

/* Absent (never defaulted) on every file and version written before this: a
   default would claim "a route was considered and is empty" about records
   nobody declared a route on. */
const processRouteSchema = new mongoose.Schema(
  {
    stages: { type: [stageSchema], default: () => [] },
  },
  { _id: false },
);

module.exports = {
  PROCESS_KINDS, APPLICABILITY, ROUTE_LIMITS, stageSchema, processRouteSchema,
  STANDARD_KINDS, STANDARD_UNITS, SETUP_UNITS, CUTTING_RESOURCE_TYPES, STANDARD_METHODS,
  STANDARD_LIMITS, technicalStandardSchema,
  TIME_BASES, SCALING_METHODS, CREW_ROLES, capacityModelSchema, crewRoleSchema,
};
