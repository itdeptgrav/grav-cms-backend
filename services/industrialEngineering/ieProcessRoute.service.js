// services/industrialEngineering/ieProcessRoute.service.js
//
// THE PROCESS ROUTE — DECLARED ON THE DRAFT, APPROVED WITH THE BULLETIN.
//
// A person states which production processes a style passes through, in what
// dependency order, and which optional processes do NOT apply. That draft is
// frozen into the next submitted bulletin version and approved by a second
// person with the rows (ieBulletinVersion.service), carried verbatim into each
// release issued from that version (ieRelease.service), and published to
// Planning read-only (releasePublication.service).
//
// ── WHAT THIS FILE REFUSES TO DO ─────────────────────────────────────────────
//   · infer a stage from an operation's name, code or machine type — a route
//     is only ever what somebody declared;
//   · assume a universal order — the order is the predecessors given here;
//   · treat a missing route as "no stages" — it publishes as UNKNOWN.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const {
  PROCESS_KINDS, APPLICABILITY, ROUTE_LIMITS,
  STANDARD_KINDS, STANDARD_UNITS, SETUP_UNITS, CUTTING_RESOURCE_TYPES,
  STANDARD_METHODS, STANDARD_LIMITS,
  TIME_BASES, SCALING_METHODS, CREW_ROLES,
} = require("../../models/CMS_Models/IndustrialEngineering/processRoute.schema");
const { fail } = require("../storePurchase/errors");
const styleFiles = require("./ieStyleFile.service");

const ROUTE_STATE = Object.freeze({ DECLARED: "DECLARED", UNKNOWN: "UNKNOWN" });

const BODY_FIELDS = Object.freeze(["expectedRevision", "stages"]);
const STAGE_FIELDS = Object.freeze([
  "stageId", "process", "label", "applicability", "predecessors", "technicalStandard",
]);

/* The kind of standard each process may carry. A process not named here takes
   none: this slice states cutting's work, and a stage typed for another
   process must not be given a cutting figure under a different heading. */
const STANDARD_FOR_PROCESS = Object.freeze({ CUTTING: "CUTTING_SAM" });

const STANDARD_FIELDS = Object.freeze([
  "kind", "standardMinutesPerPiece", "standardUnit", "setupMinutesPerOrder", "setupUnit",
  "resourceType", "resourceLabel", "basis", "source", "capacityModel",
]);
const CAPACITY_FIELDS = Object.freeze([
  "timeBasis", "standardCrewSize", "minimumCrewSize", "maximumUsefulCrewSize",
  "scalingMethod", "standardEfficiencyPercent", "requiredRoles",
]);
const ROLE_FIELDS = Object.freeze(["role", "count"]);

/* Figures somebody will try to put on the capacity model, refused by name.
   The model says what the STANDARD assumes about people; who is actually
   available on a given day is Cutting's own record and a later slice. */
const CAPACITY_REFUSED = Object.freeze({
  availableCrewSize: "today's available crew, which Cutting owns and reports",
  actualCrewSize: "an actual crew, which Cutting owns and reports",
  shiftMinutes: "shift minutes, which Cutting owns",
  availableMinutes: "available minutes, which Cutting owns",
  tableCount: "a count of tables, which is an asset record",
  machineCount: "a count of machines, which is an asset record",
  operatorIds: "named operators. A standard describes a crew, never people",
  employeeIds: "named employees. A standard describes a crew, never people",
  setupTimeBasis: "a second time basis for setup. Every figure shares the one declared basis",
  piecesPerHour: "a throughput, which Planning derives from the standard and the crew",
  plannedCrewSize: "a planned crew, which Planning allocates against Cutting's own resources",
});
const SOURCE_FIELDS = Object.freeze(["method", "reference"]);

/* Figures somebody will reasonably try to put on a standard, refused by name.
   A standard says how much work ONE piece is; everything below is either a
   different record's fact or Planning's own. */
const STANDARD_REFUSED = Object.freeze({
  garmentSamMinutes: "the garment SAM, which is the bulletin's own total and is not a cutting standard",
  sewingSamMinutes: "the sewing SAM, which is other work entirely",
  sam: "an untyped SAM. Say which standard this is, with its unit",
  quantity: "a quantity, which the confirmed order line carries",
  totalMinutes: "a total, which Planning calculates from the quantity",
  workloadMinutes: "a workload, which Planning calculates from the quantity",
  efficiencyPercent: "an efficiency, which belongs to the capacity standard",
  operatorCount: "a headcount, which Cutting owns",
  machineId: "a specific machine, which is an asset record",
  tableId: "a specific table, which is an asset record",
  shiftId: "a shift, which Cutting owns",
  plannedStart: "a date, which Planning decides",
  plannedEnd: "a date, which Planning decides",
  approvedByName: "an approval. The bulletin version this is frozen into IS the approval",
  approvedAt: "an approval. The bulletin version this is frozen into IS the approval",
  declaredAt: "the moment it was stated — the server records that",
  declaredByName: "who stated it — the server records that from your session",
});

/* Facts somebody will reasonably try to put on a stage, refused by name with
   where they actually live. A route says WHICH processes and in what order —
   never when, where, by whom or how much. */
const STAGE_REFUSED = Object.freeze({
  sequence: "its own position — the order of the list is the sequence",
  predecessorStageIds: "resolved predecessors — send `predecessors` as stage ids or list positions",
  startDate: "a date, which Planning decides",
  endDate: "a date, which Planning decides",
  plannedStart: "a date, which Planning decides",
  plannedEnd: "a date, which Planning decides",
  capacity: "capacity, which Planning commits",
  quantity: "a quantity, which the confirmed order line carries",
  lineId: "a production line, which Planning allocates",
  machineId: "a specific machine, which is an asset record",
  operatorId: "an operator. A route arranges processes, never people",
  employeeId: "an employee. A route arranges processes, never people",
  workOrderId: "a work order, which Production owns",
  status: "a progress status, which the executing department reports",
  completed: "a completion, which the executing department reports",
  companyId: "the company — that comes from your own membership",
});

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const mintStageId = () => `stg_${crypto.randomBytes(9).toString("hex")}`;
const actorName = (actor) => str(actor?.name || actor?.email);
const actorId = (actor) => (isId(actor?.id) ? oid(actor.id) : null);

const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

const invalid = (message, fieldErrors) => fail("IE_PROCESS_ROUTE_INVALID", message, {
  field: fieldErrors[0]?.field || "stages", fieldErrors,
});

/* ═══ PUBLISH ═══════════════════════════════════════════════════════════════ */

/**
 * One stage's technical standard as every reader sees it, or null.
 *
 * Null is the answer when IE has stated none — never a zeroed shape, which a
 * reader would do arithmetic on and get a free stage.
 */
function publishStandard(std) {
  if (!std || !str(std.kind)) return null;
  const cm = std.capacityModel;
  return {
    kind: str(std.kind),
    /* What the minutes mean and what they assume about people. Null only on a
       record written before this was required — which PPC reads as
       unreadable, not as a crew of one. */
    capacityModel: cm ? {
      timeBasis: str(cm.timeBasis),
      standardCrewSize: cm.standardCrewSize,
      minimumCrewSize: cm.minimumCrewSize,
      maximumUsefulCrewSize: cm.maximumUsefulCrewSize,
      scalingMethod: str(cm.scalingMethod),
      standardEfficiencyPercent: cm.standardEfficiencyPercent,
      requiredRoles: (cm.requiredRoles || []).map((r) => ({ role: str(r.role), count: r.count })),
    } : null,
    standardMinutesPerPiece: std.standardMinutesPerPiece,
    standardUnit: str(std.standardUnit),
    setupMinutesPerOrder: std.setupMinutesPerOrder,
    setupUnit: str(std.setupUnit),
    resourceType: str(std.resourceType),
    resourceLabel: str(std.resourceLabel),
    basis: str(std.basis),
    source: { method: str(std.source?.method), reference: str(std.source?.reference) },
    declaredAt: std.declaredAt ? new Date(std.declaredAt).toISOString() : null,
    declaredByName: str(std.declaredByName),
  };
}

/**
 * A stored route (draft, version or release copy) as every reader sees it.
 *
 * No route, or one with no stages, is UNKNOWN with `stages: null` — never an
 * empty list, which a reader would take as "this garment needs no processes".
 */
function publishRoute(route) {
  const stages = Array.isArray(route?.stages) ? route.stages : [];
  if (!stages.length) return { routeState: ROUTE_STATE.UNKNOWN, stages: null };
  return {
    routeState: ROUTE_STATE.DECLARED,
    stages: stages.map((s) => ({
      stageId: str(s.stageId),
      sequence: s.sequence,
      process: str(s.process),
      label: str(s.label),
      applicability: str(s.applicability),
      predecessorStageIds: (s.predecessorStageIds || []).map(str),
      technicalStandard: publishStandard(s.technicalStandard),
    })),
  };
}

/** A plain, frozen copy for a version or release — never a live subdocument. */
function freezeRoute(route) {
  const published = publishRoute(route);
  if (published.routeState !== ROUTE_STATE.DECLARED) return undefined;
  return { stages: published.stages };
}

/* ═══ SHAPE ═════════════════════════════════════════════════════════════════ */

/**
 * The stages a caller sent, as stages this route may store — or a refusal
 * naming every problem at once. Nothing is written until all of it is valid.
 *
 * `predecessors` entries are either a stage id this route already holds, or a
 * 1-based position in the submitted list (so a new stage can be depended on in
 * the same request that creates it). Either way a predecessor must sit EARLIER
 * in the list, which keeps the list readable top to bottom and makes a cycle
 * impossible to express.
 */
/**
 * WHAT THE FIGURE ASSUMES ABOUT PEOPLE — validated, never inferred.
 *
 * Four rules, and each exists because its absence produces a confident wrong
 * number rather than an error:
 *
 *   · minimum ≤ standard ≤ maximum useful. A range that does not contain its
 *     own standard describes no crew at all.
 *   · the named roles add up to at most the standard crew. Four roles on a
 *     crew of three is a composition nobody can staff.
 *   · FIXED_TEAM has no range. Its whole meaning is "this exact crew", so a
 *     minimum or maximum that differs from the standard is the author saying
 *     two contradictory things — and the contradiction would be read later as
 *     licence to scale.
 *   · CAPPED_LINEAR has a real range. A cap equal to the floor is a fixed
 *     team written in the wrong word, and it must be said in the right one.
 */
function shapeCapacityModel(raw, { at }) {
  const errs = [];
  const bad = (field, code, message) => { errs.push({ field: at(`technicalStandard.capacityModel.${field}`), code, message }); };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { errs: [{ field: at("technicalStandard.capacityModel"), code: "REQUIRED",
      message: "Say what these minutes assume about people: the basis, the crew and how it scales." }],
    model: null };
  }
  for (const field of Object.keys(raw)) {
    const refused = CAPACITY_REFUSED[field];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A capacity model cannot carry ${refused}.`,
        { field: at(`technicalStandard.capacityModel.${field}`),
          fieldErrors: [{ field: at(`technicalStandard.capacityModel.${field}`), code: "NOT_ACCEPTED",
            message: `"${field}" is not accepted.` }] });
    }
    if (!CAPACITY_FIELDS.includes(field)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a capacity model.`,
        { field: at(`technicalStandard.capacityModel.${field}`),
          fieldErrors: [{ field: at(`technicalStandard.capacityModel.${field}`), code: "NOT_ACCEPTED",
            message: `"${field}" is not accepted.` }] });
    }
  }

  const timeBasis = str(raw.timeBasis).toUpperCase();
  if (!TIME_BASES.includes(timeBasis)) {
    bad("timeBasis", "REQUIRED",
      `Say what a minute here is: ${TIME_BASES.join(" or ")}. Both the per-piece and the setup figure are in it.`);
  }
  const scalingMethod = str(raw.scalingMethod).toUpperCase();
  if (!SCALING_METHODS.includes(scalingMethod)) {
    bad("scalingMethod", "REQUIRED",
      `Say whether more people help: ${SCALING_METHODS.join(", ")}. Planning never assumes.`);
  }

  const whole = (field, value, { min, max }) => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      bad(field, "INVALID", "This is a whole number of people.");
      return null;
    }
    if (value < min || value > max) {
      bad(field, "OUT_OF_RANGE", `Between ${min} and ${max}.`);
      return null;
    }
    return value;
  };
  const standardCrewSize = whole("standardCrewSize", raw.standardCrewSize,
    { min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW });
  const minimumCrewSize = whole("minimumCrewSize", raw.minimumCrewSize,
    { min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW });
  const maximumUsefulCrewSize = whole("maximumUsefulCrewSize", raw.maximumUsefulCrewSize,
    { min: STANDARD_LIMITS.MIN_CREW, max: STANDARD_LIMITS.MAX_CREW });

  if (minimumCrewSize !== null && standardCrewSize !== null && minimumCrewSize > standardCrewSize) {
    bad("minimumCrewSize", "OUT_OF_RANGE", "The minimum crew cannot exceed the standard crew.");
  }
  if (standardCrewSize !== null && maximumUsefulCrewSize !== null && standardCrewSize > maximumUsefulCrewSize) {
    bad("maximumUsefulCrewSize", "OUT_OF_RANGE", "The maximum useful crew cannot be below the standard crew.");
  }

  if (typeof raw.standardEfficiencyPercent !== "number"
    || !Number.isFinite(raw.standardEfficiencyPercent)
    || raw.standardEfficiencyPercent < STANDARD_LIMITS.MIN_EFFICIENCY
    || raw.standardEfficiencyPercent > STANDARD_LIMITS.MAX_EFFICIENCY) {
    bad("standardEfficiencyPercent", "OUT_OF_RANGE",
      `The efficiency this figure already assumes, between ${STANDARD_LIMITS.MIN_EFFICIENCY} and ${STANDARD_LIMITS.MAX_EFFICIENCY}.`);
  }

  /* ── THE CREW COMPOSITION ────────────────────────────────────────── */
  let requiredRoles = null;
  if (!Array.isArray(raw.requiredRoles) || !raw.requiredRoles.length) {
    bad("requiredRoles", "REQUIRED", "Say who is in the crew — three people is not a composition.");
  } else if (raw.requiredRoles.length > STANDARD_LIMITS.ROLES) {
    bad("requiredRoles", "TOO_MANY", `At most ${STANDARD_LIMITS.ROLES} roles.`);
  } else {
    const seen = new Set();
    const shaped = [];
    raw.requiredRoles.forEach((entry, j) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        bad(`requiredRoles.${j}`, "INVALID", "Every role is an object.");
        return;
      }
      for (const field of Object.keys(entry)) {
        if (!ROLE_FIELDS.includes(field)) {
          throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a crew role.`,
            { field: at(`technicalStandard.capacityModel.requiredRoles.${j}.${field}`),
              fieldErrors: [{ field: at(`technicalStandard.capacityModel.requiredRoles.${j}.${field}`),
                code: "NOT_ACCEPTED", message: `"${field}" is not accepted.` }] });
        }
      }
      const role = str(entry.role).toUpperCase();
      if (!CREW_ROLES.includes(role)) {
        bad(`requiredRoles.${j}.role`, "INVALID", `Choose a role: ${CREW_ROLES.join(", ")}.`);
      } else if (seen.has(role)) {
        bad(`requiredRoles.${j}.role`, "DUPLICATE", "The same role appears twice — give it one count.");
      }
      seen.add(role);
      const count = entry.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1
        || count > STANDARD_LIMITS.MAX_CREW) {
        bad(`requiredRoles.${j}.count`, "INVALID", "A role has at least one person.");
        return;
      }
      shaped.push({ role, count });
    });
    if (shaped.length === raw.requiredRoles.length) {
      const total = shaped.reduce((sum, r) => sum + r.count, 0);
      if (standardCrewSize !== null && total > standardCrewSize) {
        bad("requiredRoles", "OUT_OF_RANGE",
          `The roles add up to ${total} people but the standard crew is ${standardCrewSize}.`);
      } else {
        requiredRoles = shaped;
      }
    }
  }

  /* ── AND THE TWO RULES EACH SCALING METHOD OWES ─────────────────── */
  if (scalingMethod === "FIXED_TEAM" && standardCrewSize !== null
    && minimumCrewSize !== null && maximumUsefulCrewSize !== null
    && (minimumCrewSize !== standardCrewSize || maximumUsefulCrewSize !== standardCrewSize)) {
    bad("scalingMethod", "CONTRADICTORY",
      "A FIXED_TEAM standard is for one exact crew, so its minimum and maximum useful crew are that "
      + "same number. A range here would later be read as permission to scale.");
  }
  if (scalingMethod === "CAPPED_LINEAR" && minimumCrewSize !== null && maximumUsefulCrewSize !== null
    && maximumUsefulCrewSize <= minimumCrewSize) {
    bad("scalingMethod", "CONTRADICTORY",
      "A CAPPED_LINEAR standard scales up to its cap, so the maximum useful crew is above the minimum. "
      + "A cap equal to the floor is a FIXED_TEAM standard and should say so.");
  }

  if (errs.length) return { errs, model: null };
  return {
    errs: [],
    model: {
      timeBasis, standardCrewSize, minimumCrewSize, maximumUsefulCrewSize, scalingMethod,
      standardEfficiencyPercent: raw.standardEfficiencyPercent,
      requiredRoles,
    },
  };
}

/**
 * One stage's technical standard, as this route may store it — or a refusal
 * naming what is wrong.
 *
 * Every number is bounded on both sides and every unit is stated, because the
 * whole point of the type is that a reader never has to assume. A standard on
 * a stage that may not carry one is refused rather than quietly dropped: the
 * author meant something by it, and silently discarding it would leave them
 * believing a figure was saved.
 */
function shapeStandard(raw, { process, applicability, at, actor }) {
  const errs = [];
  const bad = (field, code, message) => { errs.push({ field: at(field), code, message }); };
  const expected = STANDARD_FOR_PROCESS[process];

  if (!expected) {
    throw fail("FIELD_NOT_ACCEPTED",
      `A ${process || "stage"} stage carries no technical standard in this contract.`,
      { field: at("technicalStandard"),
        fieldErrors: [{ field: at("technicalStandard"), code: "NOT_ACCEPTED",
          message: `No standard kind is defined for ${process}.` }] });
  }
  if (applicability !== "REQUIRED") {
    /* A stage that does not apply has no work to state. */
    throw fail("FIELD_NOT_ACCEPTED",
      "A stage marked NOT_APPLICABLE carries no technical standard — there is no work to state.",
      { field: at("technicalStandard"),
        fieldErrors: [{ field: at("technicalStandard"), code: "NOT_ACCEPTED",
          message: "Not applicable stages carry no standard." }] });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("A technical standard is an object.",
      [{ field: at("technicalStandard"), code: "INVALID", message: "A technical standard is an object." }]);
  }
  for (const field of Object.keys(raw)) {
    const refused = STANDARD_REFUSED[field];
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `A technical standard cannot carry ${refused}.`,
        { field: at(`technicalStandard.${field}`),
          fieldErrors: [{ field: at(`technicalStandard.${field}`), code: "NOT_ACCEPTED",
            message: `"${field}" is not accepted.` }] });
    }
    if (!STANDARD_FIELDS.includes(field)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a technical standard.`,
        { field: at(`technicalStandard.${field}`),
          fieldErrors: [{ field: at(`technicalStandard.${field}`), code: "NOT_ACCEPTED",
            message: `"${field}" is not accepted.` }] });
    }
  }

  const kind = str(raw.kind).toUpperCase();
  if (!STANDARD_KINDS.includes(kind)) {
    bad("technicalStandard.kind", "INVALID", `Name the standard: ${STANDARD_KINDS.join(", ")}.`);
  } else if (kind !== expected) {
    bad("technicalStandard.kind", "INVALID", `A ${process} stage takes a ${expected} standard.`);
  }

  /* A number, and a real one: a string, NaN and Infinity are each refused by
     name rather than coerced into something arithmetic would accept. */
  const number = (field, value, { min, max }) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      bad(`technicalStandard.${field}`, "INVALID", "This is a number of minutes.");
      return null;
    }
    if (value < min || value > max) {
      bad(`technicalStandard.${field}`, "OUT_OF_RANGE", `Between ${min} and ${max} minutes.`);
      return null;
    }
    return value;
  };
  const perPiece = number("standardMinutesPerPiece", raw.standardMinutesPerPiece, {
    min: STANDARD_LIMITS.MIN_STANDARD_MINUTES, max: STANDARD_LIMITS.MAX_STANDARD_MINUTES,
  });
  const setup = number("setupMinutesPerOrder", raw.setupMinutesPerOrder, {
    min: STANDARD_LIMITS.MIN_SETUP_MINUTES, max: STANDARD_LIMITS.MAX_SETUP_MINUTES,
  });

  const standardUnit = str(raw.standardUnit).toUpperCase();
  if (!STANDARD_UNITS.includes(standardUnit)) {
    bad("technicalStandard.standardUnit", "REQUIRED", `State the unit: ${STANDARD_UNITS.join(", ")}.`);
  }
  const setupUnit = str(raw.setupUnit).toUpperCase();
  if (!SETUP_UNITS.includes(setupUnit)) {
    bad("technicalStandard.setupUnit", "REQUIRED", `State the unit: ${SETUP_UNITS.join(", ")}.`);
  }

  const resourceType = str(raw.resourceType).toUpperCase();
  if (!CUTTING_RESOURCE_TYPES.includes(resourceType)) {
    bad("technicalStandard.resourceType", "INVALID",
      `Choose the resource type: ${CUTTING_RESOURCE_TYPES.join(", ")}.`);
  }
  const resourceLabel = typeof raw.resourceLabel === "string"
    ? raw.resourceLabel.trim().replace(/\s+/g, " ") : "";
  if (resourceType === "OTHER" && !resourceLabel) {
    bad("technicalStandard.resourceLabel", "REQUIRED", "Name the resource an OTHER type stands for.");
  }
  if (resourceLabel.length > STANDARD_LIMITS.LABEL) {
    bad("technicalStandard.resourceLabel", "TOO_LONG", `At most ${STANDARD_LIMITS.LABEL} characters.`);
  }

  const basis = typeof raw.basis === "string" ? raw.basis.trim().replace(/\s+/g, " ") : "";
  if (!basis) {
    bad("technicalStandard.basis", "REQUIRED",
      "Say what this figure assumes — ply, marker, fabric. A number with no stated basis cannot be judged.");
  }
  if (basis.length > STANDARD_LIMITS.BASIS) {
    bad("technicalStandard.basis", "TOO_LONG", `At most ${STANDARD_LIMITS.BASIS} characters.`);
  }

  const source = raw.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    bad("technicalStandard.source", "REQUIRED", "Say how this figure was arrived at.");
  } else {
    for (const field of Object.keys(source)) {
      if (!SOURCE_FIELDS.includes(field)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a standard's source.`,
          { field: at(`technicalStandard.source.${field}`),
            fieldErrors: [{ field: at(`technicalStandard.source.${field}`), code: "NOT_ACCEPTED",
              message: `"${field}" is not accepted.` }] });
      }
    }
    if (!STANDARD_METHODS.includes(str(source.method).toUpperCase())) {
      bad("technicalStandard.source.method", "INVALID", `Choose how: ${STANDARD_METHODS.join(", ")}.`);
    }
    if (str(source.reference).length > STANDARD_LIMITS.REFERENCE) {
      bad("technicalStandard.source.reference", "TOO_LONG", `At most ${STANDARD_LIMITS.REFERENCE} characters.`);
    }
  }

  const capacity = shapeCapacityModel(raw.capacityModel, { at });
  errs.push(...capacity.errs);

  if (errs.length) return { errs, standard: null };
  return {
    errs: [],
    standard: {
      kind,
      capacityModel: capacity.model,
      standardMinutesPerPiece: perPiece,
      standardUnit,
      setupMinutesPerOrder: setup,
      setupUnit,
      resourceType,
      resourceLabel,
      basis,
      source: { method: str(source.method).toUpperCase(), reference: str(source.reference) },
      /* Server-recorded, both of them: a browser does not get to say when a
         standard was stated or by whom. */
      declaredAt: new Date(),
      declaredByName: actorName(actor),
    },
  };
}

function shapeRoute(list, { existingIds, actor = null }) {
  if (!Array.isArray(list)) {
    throw invalid("Stages are an ordered list.", [{ field: "stages", code: "NOT_A_LIST", message: "Stages are an ordered list." }]);
  }
  if (!list.length) {
    throw invalid("A route has at least one stage. A style with no known route is left undeclared, not declared empty.",
      [{ field: "stages", code: "REQUIRED", message: "Declare at least one stage." }]);
  }
  if (list.length > ROUTE_LIMITS.STAGES) {
    throw invalid(`A route has at most ${ROUTE_LIMITS.STAGES} stages.`,
      [{ field: "stages", code: "TOO_MANY", message: `At most ${ROUTE_LIMITS.STAGES}.` }]);
  }

  const errs = [];
  const shaped = [];
  const seenIds = new Set();

  /* Pass 1: identity, process, label and applicability. */
  list.forEach((raw, i) => {
    const at = (f) => `stages.${i}.${f}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      errs.push({ field: `stages.${i}`, code: "INVALID", message: "Every stage is an object.", index: i });
      shaped.push(null);
      return;
    }
    for (const field of Object.keys(raw)) {
      const refused = STAGE_REFUSED[field];
      if (refused) {
        throw fail("FIELD_NOT_ACCEPTED", `A route stage cannot carry ${refused}.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: i }] });
      }
      if (!STAGE_FIELDS.includes(field)) {
        throw fail("FIELD_NOT_ACCEPTED", `"${field}" is not part of a route stage.`,
          { field: at(field), fieldErrors: [{ field: at(field), code: "NOT_ACCEPTED", message: `"${field}" is not accepted.`, index: i }] });
      }
    }

    let stageId = str(raw.stageId);
    if (stageId) {
      if (!existingIds.has(stageId)) {
        errs.push({ field: at("stageId"), code: "INVALID", message: "That stage is not part of this route.", stageId, index: i });
      } else if (seenIds.has(stageId)) {
        errs.push({ field: at("stageId"), code: "DUPLICATE", message: "The same stage appears twice.", stageId, index: i });
      }
    } else {
      stageId = mintStageId();
    }
    seenIds.add(stageId);

    const process = str(raw.process).toUpperCase();
    if (!PROCESS_KINDS.includes(process)) {
      errs.push({ field: at("process"), code: "INVALID",
        message: `Choose the process: ${PROCESS_KINDS.join(", ")}.`, index: i });
    }
    /* Explicit, never defaulted: "required" and "not applicable" are both
       decisions, and a default would record one nobody made. */
    const applicability = str(raw.applicability).toUpperCase();
    if (!APPLICABILITY.includes(applicability)) {
      errs.push({ field: at("applicability"), code: "REQUIRED",
        message: "Say whether this stage is REQUIRED or NOT_APPLICABLE for this style.", index: i });
    }
    if (raw.label !== undefined && raw.label !== null && typeof raw.label !== "string") {
      errs.push({ field: at("label"), code: "INVALID", message: "A label is text.", index: i });
    }
    const label = typeof raw.label === "string" ? raw.label.trim().replace(/\s+/g, " ") : "";
    if (label.length > ROUTE_LIMITS.LABEL) {
      errs.push({ field: at("label"), code: "TOO_LONG", message: `At most ${ROUTE_LIMITS.LABEL} characters.`, index: i });
    }
    if (process === "OTHER" && !label) {
      errs.push({ field: at("label"), code: "REQUIRED", message: "Name the process an OTHER stage stands for.", index: i });
    }
    /* The stage's technical standard, when IE has stated one. Optional: a
       route may be declared before its work is measured, and Planning is told
       by name when a required stage still has none. */
    let technicalStandard = null;
    if (raw.technicalStandard !== undefined && raw.technicalStandard !== null) {
      const out = shapeStandard(raw.technicalStandard, { process, applicability, at, actor });
      errs.push(...out.errs);
      technicalStandard = out.standard;
    }
    shaped.push({
      stageId, sequence: i + 1, process, label, applicability,
      predecessorStageIds: [], technicalStandard,
    });
  });

  /* A process that appears twice needs labels that tell the two apart —
     a planner keys on the stage id, but a person reads the label. */
  const byProcess = new Map();
  shaped.forEach((s, i) => {
    if (!s) return;
    if (!byProcess.has(s.process)) byProcess.set(s.process, []);
    byProcess.get(s.process).push(i);
  });
  for (const [process, positions] of byProcess) {
    if (positions.length < 2) continue;
    const labels = positions.map((i) => shaped[i].label.toUpperCase());
    if (labels.some((l) => !l) || new Set(labels).size !== labels.length) {
      for (const i of positions) {
        errs.push({ field: `stages.${i}.label`, code: "AMBIGUOUS",
          message: `${process} appears more than once; give each a distinct label.`, index: i });
      }
    }
  }

  /* Pass 2: dependencies, resolved to stage ids. */
  const positionOf = new Map(shaped.map((s, i) => [s?.stageId, i]));
  list.forEach((raw, i) => {
    const stage = shaped[i];
    if (!stage || raw.predecessors === undefined || raw.predecessors === null) return;
    const at = `stages.${i}.predecessors`;
    if (!Array.isArray(raw.predecessors)) {
      errs.push({ field: at, code: "NOT_A_LIST", message: "Predecessors are a list.", index: i });
      return;
    }
    if (raw.predecessors.length > ROUTE_LIMITS.PREDECESSORS) {
      errs.push({ field: at, code: "TOO_MANY", message: `At most ${ROUTE_LIMITS.PREDECESSORS}.`, index: i });
      return;
    }
    if (raw.predecessors.length && stage.applicability === "NOT_APPLICABLE") {
      errs.push({ field: at, code: "NOT_APPLICABLE",
        message: "A stage that does not apply has no place in the order, so it has no predecessors.", index: i });
      return;
    }
    const seen = new Set();
    raw.predecessors.forEach((ref, k) => {
      let j = -1;
      if (typeof ref === "number" && Number.isInteger(ref)) j = ref - 1;
      else if (typeof ref === "string" && positionOf.has(str(ref))) j = positionOf.get(str(ref));
      const field = `${at}.${k}`;
      if (j < 0 || j >= shaped.length || !shaped[j]) {
        errs.push({ field, code: "UNKNOWN_STAGE", message: "That predecessor is not a stage of this route.", index: i });
        return;
      }
      if (j >= i) {
        errs.push({ field, code: "ORDER",
          message: "A predecessor must come earlier in the route than the stage that waits for it.", index: i });
        return;
      }
      if (shaped[j].applicability !== "REQUIRED") {
        errs.push({ field, code: "NOT_APPLICABLE",
          message: "A stage that does not apply cannot hold another one up.", index: i });
        return;
      }
      if (seen.has(j)) {
        errs.push({ field, code: "DUPLICATE", message: "The same predecessor is named twice.", index: i });
        return;
      }
      seen.add(j);
      stage.predecessorStageIds.push(shaped[j].stageId);
    });
  });

  if (!shaped.some((s) => s?.applicability === "REQUIRED")) {
    errs.push({ field: "stages", code: "NO_REQUIRED_STAGE", message: "At least one stage must be REQUIRED." });
  }

  if (errs.length) throw invalid("Some of these stages need fixing.", errs);
  return shaped;
}

const routeKey = (stages = []) => JSON.stringify(stages.map((s) => [
  s.stageId, s.sequence, s.process, s.label || "", s.applicability, [...(s.predecessorStageIds || [])],
]));

/* ═══ EDIT THE DRAFT ════════════════════════════════════════════════════════
 *
 * The same discipline as the bulletin rows beside it: one conditional update
 * carrying company, expected revision, DRAFT status and the review freeze, the
 * revision and audit line in the same write, and a no-op that writes nothing.
 */
async function updateProcessRoute(ctx, { fileId, body = {}, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fileNotFound();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("VALIDATION", "That is not a process route.");
  for (const key of Object.keys(body)) {
    if (!BODY_FIELDS.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of a process route edit.`,
        { field: key, fieldErrors: [{ field: key, code: "NOT_ACCEPTED", message: `"${key}" is not accepted.` }] });
    }
  }
  const expected = Number(body.expectedRevision);
  if (!Number.isInteger(expected) || expected < 1) {
    throw fail("VALIDATION", "Say which revision of this engineering file you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Send the file revision you read." }],
    });
  }
  if (body.stages === undefined) {
    throw fail("VALIDATION", "Send the stages you want this route to have.", {
      field: "stages", fieldErrors: [{ field: "stages", code: "REQUIRED", message: "Send the stages." }],
    });
  }

  const current = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!current) throw fileNotFound();
  const before = current.bulletin?.processRoute?.stages || [];
  const stages = shapeRoute(body.stages, {
    existingIds: new Set(before.map((s) => s.stageId)), actor,
  });

  if (current.status !== "DRAFT") {
    throw fail("IE_FILE_REVISION_CONFLICT", "This engineering file is no longer a draft.",
      { expected, actual: current.revision, fileId: String(current._id) });
  }
  /* The route is frozen with the bulletin while a submission is in review:
     the reviewer is approving both. */
  if (current.bulletinReviewVersionId) throw styleFiles.draftUnderReview(current);
  if (current.revision !== expected) {
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were editing it. Re-read it and decide again.",
      { expected, actual: current.revision, fileId: String(current._id) });
  }
  if (routeKey(before) === routeKey(stages)) {
    return { file: await styleFiles.readPublished(current), updated: false, events: [] };
  }

  const nextRevision = expected + 1;
  const required = stages.filter((s) => s.applicability === "REQUIRED").length;
  const event = {
    eventId: `fev_${crypto.randomBytes(9).toString("hex")}`,
    type: "PROCESS_ROUTE_EDITED",
    at: new Date(),
    actorId: actorId(actor),
    actorName: actorName(actor),
    fileRevision: nextRevision,
    summary: `Process route: ${stages.length} stage${stages.length === 1 ? "" : "s"}, ${required} required`,
  };

  const updated = await IeStyleFile.findOneAndUpdate(
    {
      _id: oid(fileId), companyId: ctx.companyId, revision: expected, status: "DRAFT",
      bulletinReviewVersionId: { $exists: false },
    },
    {
      $set: {
        "bulletin.processRoute": { stages },
        updatedBy: actorId(actor),
        updatedByName: actorName(actor),
      },
      $inc: { revision: 1 },
      $push: { history: { $each: [event], $slice: -IeStyleFile.LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
      .select("_id revision status bulletinReviewVersionId bulletinReviewVersionNo").lean();
    if (!now) throw fileNotFound();
    if (now.bulletinReviewVersionId) throw styleFiles.draftUnderReview(now);
    throw fail("IE_FILE_REVISION_CONFLICT",
      "Somebody changed this engineering file while you were editing it. Re-read it and decide again.",
      { expected, actual: now.revision, fileId: String(now._id) });
  }

  return { file: await styleFiles.readPublished(updated), updated: true, events: [styleFiles.publishEvent(event)] };
}

module.exports = {
  publishStandard,
  ROUTE_STATE, BODY_FIELDS, STAGE_FIELDS, STAGE_REFUSED,
  publishRoute, freezeRoute, shapeRoute, updateProcessRoute,
};
