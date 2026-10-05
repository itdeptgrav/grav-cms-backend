// models/CMS_Models/IndustrialEngineering/feasibility.schema.js
//
// THE ENGINEERING FEASIBILITY ASSESSMENT — can this factory make this style
// correctly and repeatedly?
//
// ── WHAT IT IS, AND WHAT IT IS NOT ──────────────────────────────────────────
// It is a PRE-ORDER engineering judgement about construction, materials,
// processes, machines, skills, quality risk and what the sample proved. It is
// not a plan: there is no quantity, no month, no line, no daily target, no
// capacity reservation and no release in this schema, and no field one could be
// put in. Those begin after confirmed demand, in their own areas.
//
// ── IT RIDES THE BULLETIN'S LIFECYCLE, IT DOES NOT GROW ITS OWN ──────────────
// Industrial Engineering already has one submit → return → approve chain, with
// maker-checker, on the bulletin version. A second approval for the assessment
// would be a second place to say the same yes, and the two would disagree. So:
//
//   · the DRAFT lives on the engineering file, editable while the file is;
//   · submitting the bulletin FREEZES a copy into that version;
//   · approving the version approves the assessment with it, uneditable after.
//
// This is the same shape the process route uses, for the same reason.
//
// ── AND ABSENCE IS NEVER A PASS ─────────────────────────────────────────────
// `NOT_ASSESSED` is the default and it is a real state: nobody has looked. A
// style with no recorded problems is not feasible — it is unassessed, and the
// readiness gate says so rather than letting silence read as a yes.
"use strict";

const mongoose = require("mongoose");

/* The four outcomes, in the words the screen uses. No fifth state, and no
   "partially feasible": a condition is a condition, and it is listed. */
const OUTCOME = Object.freeze({
  NOT_ASSESSED: "NOT_ASSESSED",
  FEASIBLE: "FEASIBLE",
  FEASIBLE_WITH_CONDITIONS: "FEASIBLE_WITH_CONDITIONS",
  BLOCKED: "BLOCKED",
});
const OUTCOMES = Object.freeze(Object.values(OUTCOME));

/* What IE assesses. One finding names exactly one of these, so a reader can
   see at a glance which part of making the garment is in doubt. */
const AREAS = Object.freeze([
  "CONSTRUCTION", "MATERIALS", "SPECIAL_PROCESSES", "MACHINES",
  "SKILLS", "DIFFICULT_OPERATIONS", "QUALITY_RISK", "SAMPLE_EVIDENCE",
]);

/* How much a finding matters. `BLOCKING` is the only one that stops an
   approval; the other two are recorded engineering judgement. */
const SEVERITY = Object.freeze({
  INFORMATION: "INFORMATION",
  CONCERN: "CONCERN",
  BLOCKING: "BLOCKING",
});
const SEVERITIES = Object.freeze(Object.values(SEVERITY));

/* The desk that must answer. IE may own a finding itself — most difficult
   operations and quality controls are IE's own work. */
const OWNERS = Object.freeze([
  "SALES", "MERCHANDISING", "RESEARCH_DEVELOPMENT", "PRODUCTION", "INDUSTRIAL_ENGINEERING",
]);

const FINDING_STATUS = Object.freeze({ OPEN: "OPEN", RESOLVED: "RESOLVED" });

/* Whether the TYPE of machine or attachment a style needs can be had. It is
   never a specific machine: naming an asset here would be IE allocating
   equipment, which is Maintenance's and Production's to do. */
const AVAILABILITY = Object.freeze(["AVAILABLE", "NEED_TO_ARRANGE", "NOT_CHECKED"]);

const FEASIBILITY_LIMITS = Object.freeze({
  FINDINGS: 120,
  CONDITIONS: 40,
  TITLE: 160,
  TEXT: 2000,
  NOTE: 1000,
  REFERENCE: 200,
});

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId, default: null },
  name: { type: String, trim: true, default: "" },
});

/**
 * ONE FINDING — a thing somebody noticed, and what has to happen about it.
 *
 * Repeatable rows rather than one notes field: a note cannot be severity-sorted,
 * owned, actioned or resolved, and the whole point of the assessment is that
 * each concern has a desk and a next move.
 */
const findingSchema = new mongoose.Schema(
  {
    /* Server-minted, stable across edits, and what a resolution keys on. */
    findingId: { type: String, required: true, trim: true },
    area: { type: String, enum: AREAS, required: true },
    title: { type: String, required: true, trim: true, maxlength: FEASIBILITY_LIMITS.TITLE },
    /* What was observed, in plain words — "fabric stretches while attaching the
       collar", not "material instability constraint". */
    observation: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.TEXT },
    severity: { type: String, enum: SEVERITIES, required: true },
    owner: { type: String, enum: OWNERS, required: true },
    requiredAction: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.TEXT },
    status: { type: String, enum: Object.values(FINDING_STATUS), default: FINDING_STATUS.OPEN },
    resolutionNote: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.NOTE },

    /* ── WHICH UPSTREAM FACT THIS IS ABOUT ────────────────────────────────
       A short reference into the manufacturing inputs the endpoint already
       publishes — a decoration row's key, a material's name, an outside
       process. It is a POINTER for a reader, never a copy: the assessment does
       not duplicate another desk's record, and nothing here is resolved
       through. */
    sourceKind: { type: String, trim: true, default: "", maxlength: 60 },
    sourceRef: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.REFERENCE },

    /* Availability answers only on the two areas that can have one, and only
       ever as a TYPE question. */
    availability: { type: String, enum: AVAILABILITY, default: undefined },

    createdBy: actorRef(),
    createdAt: { type: Date, default: null },
    updatedBy: actorRef(),
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** A condition that must be satisfied before this style is made in bulk. */
const conditionSchema = new mongoose.Schema(
  {
    conditionId: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true, maxlength: FEASIBILITY_LIMITS.TEXT },
    owner: { type: String, enum: OWNERS, required: true },
    requiredAction: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.TEXT },
    status: { type: String, enum: Object.values(FINDING_STATUS), default: FINDING_STATUS.OPEN },
  },
  { _id: false },
);

/**
 * THE ASSESSMENT.
 *
 * `basedOnTechnicalRevision` is what makes staleness detectable: it records the
 * R&D technical pack the judgement was made against. When the file's source
 * moves past it the assessment is reported as NEEDING REASSESSMENT rather than
 * carried forward as current — a feasibility verdict about a garment that has
 * since changed is not a verdict about this one.
 */
const feasibilitySchema = new mongoose.Schema(
  {
    outcome: { type: String, enum: OUTCOMES, default: OUTCOME.NOT_ASSESSED, required: true },
    recommendation: { type: String, trim: true, default: "", maxlength: FEASIBILITY_LIMITS.TEXT },
    findings: { type: [findingSchema], default: () => [] },
    conditions: { type: [conditionSchema], default: () => [] },

    /* The R&D technical pack this judgement was made against. */
    basedOnTechnicalRevision: { type: Number, default: null, min: 0 },

    assessedBy: actorRef(),
    assessedAt: { type: Date, default: null },
    /* Bumped on every save, and what an edit must name — the same optimistic
       rule the file and every other IE record follows. */
    revision: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

module.exports = {
  OUTCOME, OUTCOMES, AREAS, SEVERITY, SEVERITIES, OWNERS,
  FINDING_STATUS, AVAILABILITY, FEASIBILITY_LIMITS,
  findingSchema, conditionSchema, feasibilitySchema,
};
