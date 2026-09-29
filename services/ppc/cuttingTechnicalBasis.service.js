// services/ppc/cuttingTechnicalBasis.service.js
//
// HOW MUCH CUTTING WORK A CONFIRMED LINE IS — READ FROM IE, CALCULATED BY PPC.
//
// Industrial Engineering states the standard: how long one piece takes to cut,
// what the order costs to set up, and on which kind of resource. That statement
// is approved with the bulletin and frozen into the release. PPC reads it here
// and multiplies it by the quantity Sales confirmed.
//
// ── THE ONE CALCULATION, AND WHOSE NUMBERS ARE IN IT ────────────────────────
//     workloadMinutes = setupMinutesPerOrder + quantity × standardMinutesPerPiece
//
// Both minute figures are IE's and neither is touched here. The quantity is
// Sales', through the planning file's frozen basis. PPC contributes the
// multiplication and nothing else — which is the whole point: a planner can
// see where every number came from, and none of them is PPC's opinion.
//
// ── WHAT PPC MAY NOT DO ─────────────────────────────────────────────────────
// Create a standard, edit one, override one, approve one, or supply a figure
// when IE has not. There is no write path in this file and no default value in
// it. A missing standard is reported by name and stops cutting being dated;
// it never becomes zero, and it never becomes a number a planner typed.
//
// ── AND WHAT IT REFUSES TO INFER ────────────────────────────────────────────
// Not from the garment SAM, which is the whole bulletin's total for sewing
// work. Not from a sewing standard, which is other work. Not from an
// operation's name or code, a machine's name, or a newer release than the one
// this plan froze. Each of those would produce a confident number for the
// wrong thing, and a planner would have no way to tell.
//
// ── NOT CAPACITY ────────────────────────────────────────────────────────────
// A workload is how much work there is. It is not how much of it fits in a
// day: tables, knives, operators, shifts and availability are Cutting's own
// and are a later slice. Nothing here divides by a resource, and nothing here
// produces a date.
"use strict";

const {
  STANDARD_KINDS, TIME_BASES, SCALING_METHODS, CREW_ROLES, STANDARD_LIMITS,
} = require("../../models/CMS_Models/IndustrialEngineering/processRoute.schema");

const str = (v) => String(v ?? "").trim();

/** The process this slice states the work for. */
const CUTTING = "CUTTING";

/**
 * Why cutting cannot be planned from this release, by name.
 *
 * Two codes, deliberately distinct. MISSING is IE never stated one — the
 * remedy is for IE to publish it. UNREADABLE is IE stated something this
 * contract cannot use — a kind PPC does not recognise, a figure that is not a
 * positive number, a unit this version does not know. The remedy is different
 * and so is the sentence, because "nobody wrote it" and "what was written
 * cannot be trusted" send a planner to different people.
 */
const BASIS_STATE = Object.freeze({
  SCHEDULABLE: "SCHEDULABLE",
  MISSING: "PPC_CUTTING_STANDARD_MISSING",
  UNREADABLE: "PPC_CUTTING_STANDARD_UNREADABLE",
  /* The stage is declared NOT_APPLICABLE: no work, and nothing missing. */
  NOT_APPLICABLE: "NOT_APPLICABLE",
  /* No confirmed quantity to multiply by — a Sales fact, not an IE one. */
  QUANTITY_UNKNOWN: "PPC_CUTTING_QUANTITY_UNKNOWN",
});

const MESSAGE = Object.freeze({
  [BASIS_STATE.MISSING]:
    "Industrial Engineering has not published a cutting standard for this stage in the release this "
    + "plan is frozen to. Cutting cannot be dated until IE approves one — Planning cannot supply it.",
  [BASIS_STATE.UNREADABLE]:
    "The cutting standard in this release cannot be read: its kind, figures or units are not ones "
    + "this contract accepts. Industrial Engineering must re-publish it. Planning cannot correct it.",
  [BASIS_STATE.QUANTITY_UNKNOWN]:
    "This plan has no confirmed quantity frozen, so the cutting workload cannot be calculated.",
});

/** Rounded to the minute-hundredth it was calculated in, never to a whole. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Is this a standard this contract may calculate from?
 *
 * Read strictly. Anything the type promises but this record does not keep —
 * an unknown kind, a non-finite figure, a zero or negative per-piece minute,
 * a negative setup, a unit this version does not recognise — makes it
 * UNREADABLE rather than something to work around. A standard is either
 * trustworthy or it is refused; there is no partial credit.
 */
function readStandard(standard) {
  if (!standard || typeof standard !== "object") return { ok: false, reason: BASIS_STATE.MISSING };
  const kind = str(standard.kind);
  if (!kind) return { ok: false, reason: BASIS_STATE.MISSING };
  if (!STANDARD_KINDS.includes(kind) || kind !== "CUTTING_SAM") {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { kind } };
  }
  const perPiece = standard.standardMinutesPerPiece;
  const setup = standard.setupMinutesPerOrder;
  if (typeof perPiece !== "number" || !Number.isFinite(perPiece) || perPiece <= 0) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "standardMinutesPerPiece" } };
  }
  if (typeof setup !== "number" || !Number.isFinite(setup) || setup < 0) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "setupMinutesPerOrder" } };
  }
  /* The units are stored precisely so they can be checked rather than
     assumed. A figure in a unit this version does not know is not a figure
     this version may multiply. */
  if (str(standard.standardUnit) !== "MINUTES_PER_PIECE") {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "standardUnit" } };
  }
  if (str(standard.setupUnit) !== "MINUTES_PER_ORDER") {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "setupUnit" } };
  }
  if (!str(standard.resourceType)) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "resourceType" } };
  }

  /* ── AND WHAT THE MINUTES MEAN ────────────────────────────────────────
     A figure without its capacity model is a number whose unit is known and
     whose MEANING is not: labour content or elapsed time for a crew, and
     three people either help or they do not. Planning refuses it rather than
     choosing — choosing is how a plan is wrong by a factor of three. */
  const cm = standard.capacityModel;
  if (!cm || typeof cm !== "object") {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel" } };
  }
  if (!TIME_BASES.includes(str(cm.timeBasis))) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.timeBasis" } };
  }
  if (!SCALING_METHODS.includes(str(cm.scalingMethod))) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.scalingMethod" } };
  }
  const crew = ["standardCrewSize", "minimumCrewSize", "maximumUsefulCrewSize"];
  for (const field of crew) {
    const v = cm[field];
    if (typeof v !== "number" || !Number.isInteger(v)
      || v < STANDARD_LIMITS.MIN_CREW || v > STANDARD_LIMITS.MAX_CREW) {
      return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: `capacityModel.${field}` } };
    }
  }
  /* The range must contain its own standard, whatever was stored. */
  if (cm.minimumCrewSize > cm.standardCrewSize || cm.standardCrewSize > cm.maximumUsefulCrewSize) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.crewRange" } };
  }
  /* A fixed team with a range would be read as scalable. Re-checked here and
     not merely at authoring: this reader is the last thing between a stored
     contradiction and a plan built on it. */
  if (str(cm.scalingMethod) === "FIXED_TEAM"
    && (cm.minimumCrewSize !== cm.standardCrewSize || cm.maximumUsefulCrewSize !== cm.standardCrewSize)) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.scalingMethod" } };
  }
  const eff = cm.standardEfficiencyPercent;
  if (typeof eff !== "number" || !Number.isFinite(eff)
    || eff < STANDARD_LIMITS.MIN_EFFICIENCY || eff > STANDARD_LIMITS.MAX_EFFICIENCY) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.standardEfficiencyPercent" } };
  }
  const roles = cm.requiredRoles;
  if (!Array.isArray(roles) || !roles.length) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.requiredRoles" } };
  }
  let people = 0;
  for (const r of roles) {
    if (!CREW_ROLES.includes(str(r?.role))
      || typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1) {
      return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.requiredRoles" } };
    }
    people += r.count;
  }
  if (people > cm.standardCrewSize) {
    return { ok: false, reason: BASIS_STATE.UNREADABLE, detail: { field: "capacityModel.requiredRoles" } };
  }

  return { ok: true, perPiece, setup, capacityModel: cm };
}

/* ══ WHAT A CREW OF N ACTUALLY BUYS ══════════════════════════════════════
 *
 * The declared rule, applied — never an assumption. This does not produce a
 * date, a duration or a resource allocation: it answers the one question a
 * later planner must ask before it does any of that, which is how much of a
 * proposed crew the approved standard says is useful.
 *
 * Note what it refuses to do. Above a LINEAR standard's validated maximum it
 * returns null rather than a number: IE measured up to there and no further,
 * and "not measured" is not "no further benefit". Only CAPPED_LINEAR claims
 * saturation, because only CAPPED_LINEAR was declared to saturate.
 */
function effectiveCrew(capacityModel, proposedCrew) {
  const cm = capacityModel;
  if (!cm) return { usable: null, reason: "NO_CAPACITY_MODEL" };
  const n = Number(proposedCrew);
  if (!Number.isInteger(n) || n < 1) return { usable: null, reason: "CREW_INVALID" };

  if (n < cm.minimumCrewSize) {
    /* Below the floor the standard does not apply at all — it is not a slower
       version of itself. */
    return { usable: null, reason: "BELOW_MINIMUM_CREW", minimumCrewSize: cm.minimumCrewSize };
  }
  if (str(cm.scalingMethod) === "FIXED_TEAM") {
    return {
      usable: cm.standardCrewSize,
      reason: n > cm.standardCrewSize ? "FIXED_TEAM_EXTRA_PEOPLE_DO_NOT_HELP" : "FIXED_TEAM",
      scales: false,
    };
  }
  if (n > cm.maximumUsefulCrewSize) {
    if (str(cm.scalingMethod) === "CAPPED_LINEAR") {
      return {
        usable: cm.maximumUsefulCrewSize, reason: "CAPPED_AT_MAXIMUM_USEFUL_CREW",
        maximumUsefulCrewSize: cm.maximumUsefulCrewSize, scales: true,
      };
    }
    /* LINEAR, above what was measured. */
    return {
      usable: null, reason: "ABOVE_VALIDATED_CREW",
      maximumUsefulCrewSize: cm.maximumUsefulCrewSize, scales: true,
    };
  }
  return { usable: n, reason: "WITHIN_VALIDATED_RANGE", scales: true };
}

/**
 * The technical basis for one cutting stage of one plan, read-only.
 *
 * @param stage        the stage as the FROZEN release publishes it
 * @param release      `{ releaseId, releaseRef, versionNo }` the plan froze
 * @param quantity     Sales' confirmed quantity from the plan's frozen basis
 */
function cuttingBasis({ stage, release = {}, quantity } = {}) {
  if (!stage || str(stage.process) !== CUTTING) return null;

  const identity = {
    stageId: str(stage.stageId),
    process: CUTTING,
    /* The exact release these figures came from, so a planner reading a
       workload can see which approved engineering produced it. */
    ieReleaseId: release.releaseId ? str(release.releaseId) : null,
    ieReleaseRef: str(release.releaseRef),
    ieReleaseVersionNo: release.versionNo ?? null,
    /* Said plainly on every answer: this is IE's statement, read here. */
    ownedBy: "INDUSTRIAL_ENGINEERING",
    editableByPpc: false,
    booksCapacity: false,
  };

  if (str(stage.applicability) === "NOT_APPLICABLE") {
    /* Nothing is missing. A stage that does not apply needs no standard, and
       reporting one as absent would send somebody to IE for a figure that
       should not exist. */
    return {
      ...identity,
      state: BASIS_STATE.NOT_APPLICABLE,
      schedulable: false,
      blocker: null,
      message: "Cutting does not apply to this style, so it carries no technical standard.",
      standard: null, quantity: null, workloadMinutes: null,
    };
  }

  const read = readStandard(stage.technicalStandard);
  if (!read.ok) {
    return {
      ...identity,
      state: read.reason,
      schedulable: false,
      blocker: read.reason,
      message: MESSAGE[read.reason],
      detail: read.detail || null,
      standard: null, quantity: null, workloadMinutes: null,
    };
  }

  const std = stage.technicalStandard;
  const cm = read.capacityModel;
  const standard = {
    kind: str(std.kind),
    /* What the minutes mean and what they assume about people — published
       exactly as IE approved it, and never collapsed into a single number. */
    capacityModel: {
      timeBasis: str(cm.timeBasis),
      standardCrewSize: cm.standardCrewSize,
      minimumCrewSize: cm.minimumCrewSize,
      maximumUsefulCrewSize: cm.maximumUsefulCrewSize,
      scalingMethod: str(cm.scalingMethod),
      standardEfficiencyPercent: cm.standardEfficiencyPercent,
      requiredRoles: (cm.requiredRoles || []).map((r) => ({ role: str(r.role), count: r.count })),
      /* The one sentence that stops the figure being misused. */
      meaning: str(cm.timeBasis) === "LABOUR_MINUTES"
        ? "Labour content. A later capacity calculation may divide it by available person-minutes, "
          + "within the declared crew range and scaling rule."
        : `Elapsed time for the approved crew of ${cm.standardCrewSize}. It must NOT be multiplied or `
          + "divided by headcount except by the declared scaling rule.",
      scalesWithCrew: str(cm.scalingMethod) !== "FIXED_TEAM",
    },
    standardMinutesPerPiece: read.perPiece,
    standardUnit: str(std.standardUnit),
    setupMinutesPerOrder: read.setup,
    setupUnit: str(std.setupUnit),
    resourceType: str(std.resourceType),
    resourceLabel: str(std.resourceLabel),
    basis: str(std.basis),
    source: { method: str(std.source?.method), reference: str(std.source?.reference) },
    declaredAt: std.declaredAt || null,
    declaredByName: str(std.declaredByName),
  };

  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return {
      ...identity,
      state: BASIS_STATE.QUANTITY_UNKNOWN,
      schedulable: false,
      blocker: BASIS_STATE.QUANTITY_UNKNOWN,
      message: MESSAGE[BASIS_STATE.QUANTITY_UNKNOWN],
      standard, quantity: null, workloadMinutes: null,
    };
  }

  return {
    ...identity,
    state: BASIS_STATE.SCHEDULABLE,
    schedulable: true,
    blocker: null,
    message: null,
    standard,
    quantity: qty,
    /* The one calculation. Written the way it reads, so the screen and this
       line say the same thing. */
    workloadMinutes: round2(read.setup + (qty * read.perPiece)),
    /* The arithmetic in the open, so a planner can check it rather than
       trust it. */
    workloadFormula: "setupMinutesPerOrder + quantity × standardMinutesPerPiece",
    /* Both figures are in the standard's one declared basis — there is no
       separate clock for setup, and a reader must not assume one. */
    workloadTimeBasis: str(cm.timeBasis),
    /* Said plainly, because the next slice is the one that will be tempted:
       a workload is not a duration until it meets a real crew, a real table
       and real shift minutes, and none of those are in this record. */
    schedulesResources: false,
    resourcePlanningNote:
      "This is work content, not a date. Turning it into a cutting window needs Cutting's own crew, "
      + "machine or table, shift minutes and availability, combined with the crew range and scaling "
      + "rule above — none of which is in this standard.",
  };
}

/** Every cutting stage's basis for one plan, keyed by stage id. */
function cuttingBasisByStage({ stages = [], release = {}, quantity } = {}) {
  const out = new Map();
  for (const stage of stages || []) {
    if (str(stage?.process) !== CUTTING) continue;
    out.set(str(stage.stageId), cuttingBasis({ stage, release, quantity }));
  }
  return out;
}

/** May this stage be dated and published? Any non-cutting stage: yes, here. */
const blocksScheduling = (basis) => Boolean(basis)
  && basis.state !== BASIS_STATE.SCHEDULABLE
  && basis.state !== BASIS_STATE.NOT_APPLICABLE;

module.exports = {
  CUTTING, BASIS_STATE, MESSAGE,
  readStandard, cuttingBasis, cuttingBasisByStage, blocksScheduling, effectiveCrew,
};
