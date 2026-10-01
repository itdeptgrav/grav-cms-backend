// services/industrialEngineering/ieFeasibility.service.js
//
// ENGINEERING FEASIBILITY — the assessment, its rules, and the gate it feeds.
//
// ── THE QUESTION ────────────────────────────────────────────────────────────
// Can this factory make this style correctly and repeatedly with the proposed
// construction, materials, processes, machines and skills? That is all this
// record answers. It carries no quantity, no date, no line and no target: a
// feasibility verdict is about the GARMENT, and planning begins after demand is
// confirmed, somewhere else.
//
// ── WHY THERE IS NO APPROVE HERE ────────────────────────────────────────────
// The bulletin version already has submit → return → approve with maker-checker
// on it. The assessment is frozen into that version at submission and decided
// with it. A second approval button in this service would be a second place to
// say yes about one style, and the two would eventually disagree.
//
// So this file has exactly one writer — save the draft — plus the pure rules
// the submission gate and the screens read.
//
// ── AND SILENCE IS NOT A PASS ───────────────────────────────────────────────
// `FEASIBLE` is something a person states, with no unresolved blocking finding
// under it. It is never derived from "nothing was recorded": an unassessed
// style reports NOT_ASSESSED, and the readiness gate refuses a submission on
// it rather than letting an empty record read as a yes.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const {
  OUTCOME, OUTCOMES, AREAS, SEVERITY, SEVERITIES, OWNERS,
  FINDING_STATUS, AVAILABILITY, FEASIBILITY_LIMITS,
} = require("../../models/CMS_Models/IndustrialEngineering/feasibility.schema");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v) => (Array.isArray(v) ? v : []);
const mintId = (prefix) => `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
const actorOf = (actor) => ({
  id: isId(actor?.id) ? oid(actor.id) : null,
  name: str(actor?.name || actor?.email),
});

const fileNotFound = () => fail("IE_FILE_NOT_FOUND", "That engineering file was not found.");

const invalid = (message, fieldErrors) => fail("IE_FEASIBILITY_INVALID", message, {
  field: fieldErrors[0]?.field || "assessment", fieldErrors,
});

/* The body's allowlist. Everything server-owned — who assessed it, when, the
   revision, the technical pack it was judged against — is refused by name. */
const BODY_FIELDS = Object.freeze(["expectedRevision", "outcome", "recommendation", "findings", "conditions"]);
const FINDING_FIELDS = Object.freeze([
  "findingId", "area", "title", "observation", "severity", "owner",
  "requiredAction", "status", "resolutionNote", "sourceKind", "sourceRef", "availability",
]);
const CONDITION_FIELDS = Object.freeze(["conditionId", "text", "owner", "requiredAction", "status"]);

/* Facts somebody will reasonably try to put on an assessment, refused with
   where they actually live. A feasibility judgement prices nothing, plans
   nothing and allocates nothing. */
const REFUSED_FIELDS = Object.freeze({
  machineId: "a specific machine. The assessment names machine TYPES; the asset is Maintenance's",
  serialNumber: "a machine serial number, which is an asset record",
  operatorId: "an operator. It assesses skills, never people",
  employeeId: "an employee. It assesses skills, never people",
  quantity: "an order quantity, which is commercial and belongs to a confirmed order",
  targetOutput: "a target output, which is capacity planning after confirmed demand",
  lineId: "a production line, which Planning allocates",
  shift: "a shift, which is capacity planning",
  price: "a price. Nothing here is costed",
  rate: "a rate. Nothing here is costed",
  cost: "a cost. Nothing here is costed",
  supplierId: "a supplier, which is Store's and Finance's",
  approvedBy: "an approver — the assessment is decided with the bulletin version",
  approvedAt: "an approval date — the assessment is decided with the bulletin version",
  assessedBy: "who assessed it, which comes from your session",
  assessedAt: "when it was assessed, which the server stamps",
  revision: "its own revision — send `expectedRevision` to say which one you read",
  basedOnTechnicalRevision: "which technical pack it was judged against, which the server records",
});

/* ══ THE RULES ═════════════════════════════════════════════════════════════
 *
 * Pure, exported, and read by the writer AND by the submission gate, so the
 * screen, the save and the gate can never disagree about what a valid
 * assessment is. */

const isBlocking = (f) => f.severity === SEVERITY.BLOCKING && f.status === FINDING_STATUS.OPEN;
const openConditions = (a) => list(a?.conditions).filter((c) => c.status !== FINDING_STATUS.RESOLVED);

/**
 * What is wrong with this assessment, as a list of reasons — empty when the
 * outcome is one a person may honestly record.
 *
 * Each rule exists because its absence lets a false claim through:
 *   · FEASIBLE with an open blocking finding says "yes" over an unresolved no;
 *   · FEASIBLE_WITH_CONDITIONS with no condition names no condition to meet;
 *   · BLOCKED with nothing blocking cannot say what to fix, or who fixes it.
 */
function outcomeProblems(assessment) {
  const a = assessment || {};
  const findings = list(a.findings);
  const blocking = findings.filter(isBlocking);
  const problems = [];

  if (a.outcome === OUTCOME.FEASIBLE && blocking.length) {
    problems.push({
      code: "FEASIBLE_WITH_OPEN_BLOCKER",
      message: `This cannot be recorded as feasible while ${blocking.length} blocking `
        + `${blocking.length === 1 ? "finding is" : "findings are"} still open. Resolve `
        + "it, or record the result as blocked.",
    });
  }
  if (a.outcome === OUTCOME.FEASIBLE_WITH_CONDITIONS && !openConditions(a).length) {
    problems.push({
      code: "CONDITIONS_REQUIRED",
      message: "Feasible with conditions needs at least one condition, with the desk that owes it.",
    });
  }
  if (a.outcome === OUTCOME.BLOCKED && !blocking.length) {
    problems.push({
      code: "BLOCKER_REQUIRED",
      message: "Blocked needs at least one open blocking finding, naming the desk that must respond.",
    });
  }
  return problems;
}

/**
 * Has the ground moved under this assessment?
 *
 * The judgement was made against one R&D technical pack. When the file is now
 * engineered from a later one, the assessment is about a garment that has since
 * changed — so it is reported as needing reassessment rather than carried
 * forward as current. Never silently cleared: what was said stays readable.
 */
function stalenessOf(file) {
  const assessment = file?.feasibility || null;
  if (!assessment || assessment.outcome === OUTCOME.NOT_ASSESSED) return { stale: false, basedOn: null, current: null };
  const basedOn = num(assessment.basedOnTechnicalRevision);
  const current = num(file?.source?.technicalRevision);
  return {
    stale: basedOn !== null && current !== null && current > basedOn,
    basedOn,
    current,
  };
}

/**
 * What stops this assessment satisfying the Development standard, by stage.
 *
 * SUBMIT refuses an unassessed style: a standard submitted with nobody having
 * asked whether it can be made is the gap this whole record exists to close.
 * APPROVE refuses that AND an open block — a blocked assessment may be saved
 * and shared, which is how a desk learns what to fix, but it cannot become the
 * approved standard until the block is cleared or a new assessment supersedes
 * it.
 */
function feasibilityGaps(file, { stage = "submitted" } = {}) {
  const assessment = file?.feasibility || null;
  const gaps = [];
  const outcome = assessment?.outcome || OUTCOME.NOT_ASSESSED;

  if (outcome === OUTCOME.NOT_ASSESSED) {
    gaps.push({
      code: "IE_FEASIBILITY_NOT_ASSESSED",
      action: "RECORD_FEASIBILITY",
      message: "Nobody has recorded whether this style can be made. Assess it on Engineering Feasibility.",
    });
    return gaps;
  }

  const blocking = list(assessment.findings).filter(isBlocking);
  if (stage === "approved" && blocking.length) {
    gaps.push({
      code: "IE_FEASIBILITY_BLOCKED",
      action: "CLEAR_FEASIBILITY_BLOCKER",
      message: `${blocking.length} blocking ${blocking.length === 1 ? "finding" : "findings"} on the `
        + "feasibility assessment must be resolved before this standard can be approved.",
      details: { findings: blocking.map((f) => ({ area: f.area, title: f.title, owner: f.owner })) },
    });
  }
  if (stage === "approved") {
    const problems = outcomeProblems(assessment);
    for (const p of problems) {
      gaps.push({ code: "IE_FEASIBILITY_INVALID", action: "RECORD_FEASIBILITY", message: p.message });
    }
    const { stale, basedOn, current } = stalenessOf(file);
    if (stale) {
      gaps.push({
        code: "IE_FEASIBILITY_STALE",
        action: "RECORD_FEASIBILITY",
        message: `The feasibility assessment was made against R&D technical pack ${basedOn}, and this `
          + `file is now engineered from pack ${current}. Reassess it before approving.`,
      });
    }
  }
  return gaps;
}

/* ══ SHAPE ═════════════════════════════════════════════════════════════════ */

const refuseUnknown = (obj, allowed, what, prefix) => {
  for (const key of Object.keys(obj || {})) {
    const refused = REFUSED_FIELDS[key];
    const field = prefix ? `${prefix}.${key}` : key;
    if (refused) {
      throw fail("FIELD_NOT_ACCEPTED", `${what} cannot carry ${refused}.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${key}" is not accepted.` }] });
    }
    if (!allowed.includes(key)) {
      throw fail("FIELD_NOT_ACCEPTED", `"${key}" is not part of ${what}.`,
        { field, fieldErrors: [{ field, code: "NOT_ACCEPTED", message: `"${key}" is not accepted.` }] });
    }
  }
};

const text = (v, field, max, errs, required = false) => {
  const out = str(v).replace(/\s+/g, " ");
  if (required && !out) {
    errs.push({ field, code: "REQUIRED", message: "This is needed." });
    return "";
  }
  if (out.length > max) {
    errs.push({ field, code: "TOO_LONG", message: `This is at most ${max} characters.` });
    return out.slice(0, max);
  }
  return out;
};

const oneOf = (v, values, field, errs, label) => {
  const out = str(v).toUpperCase();
  if (!values.includes(out)) {
    errs.push({ field, code: "INVALID", message: `Choose ${label}: ${values.join(", ")}.` });
    return "";
  }
  return out;
};

/**
 * The findings a caller sent, as findings this assessment may store.
 *
 * A `findingId` the assessment already holds keeps its identity and its
 * authorship through every edit; one it does not hold is refused rather than
 * minted, exactly as a station id is on a line layout.
 */
function shapeFindings(raw, { existing, actor, now }) {
  const rows = list(raw);
  if (rows.length > FEASIBILITY_LIMITS.FINDINGS) {
    throw invalid(`An assessment holds at most ${FEASIBILITY_LIMITS.FINDINGS} findings.`,
      [{ field: "findings", code: "TOO_MANY", message: `At most ${FEASIBILITY_LIMITS.FINDINGS}.` }]);
  }
  const errs = [];
  const seen = new Set();
  const shaped = rows.map((row, i) => {
    const at = (f) => `findings.${i}.${f}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errs.push({ field: `findings.${i}`, code: "INVALID", message: "Every finding is an object." });
      return null;
    }
    refuseUnknown(row, FINDING_FIELDS, "a finding", `findings.${i}`);

    let findingId = str(row.findingId);
    const was = findingId ? existing.get(findingId) : null;
    if (findingId && !was) {
      errs.push({ field: at("findingId"), code: "INVALID", message: "That finding is not part of this assessment." });
    } else if (findingId && seen.has(findingId)) {
      errs.push({ field: at("findingId"), code: "DUPLICATE", message: "The same finding appears twice." });
    }
    if (!findingId) findingId = mintId("fnd");
    seen.add(findingId);

    const area = oneOf(row.area, AREAS, at("area"), errs, "the area this is about");
    const severity = oneOf(row.severity, SEVERITIES, at("severity"), errs, "how much it matters");
    const owner = oneOf(row.owner, OWNERS, at("owner"), errs, "the desk that must answer");
    const status = row.status === undefined
      ? (was?.status || FINDING_STATUS.OPEN)
      : oneOf(row.status, Object.values(FINDING_STATUS), at("status"), errs, "open or resolved");
    const title = text(row.title, at("title"), FEASIBILITY_LIMITS.TITLE, errs, true);
    const resolutionNote = text(row.resolutionNote, at("resolutionNote"), FEASIBILITY_LIMITS.NOTE, errs);

    /* A resolution is a statement somebody has to stand behind, so it says
       what was done rather than closing silently. */
    if (status === FINDING_STATUS.RESOLVED && !resolutionNote) {
      errs.push({
        field: at("resolutionNote"), code: "REQUIRED",
        message: "Say what was done to resolve this before marking it resolved.",
      });
    }

    const availability = row.availability === undefined || row.availability === null || row.availability === ""
      ? (was?.availability || undefined)
      : oneOf(row.availability, AVAILABILITY, at("availability"), errs, "whether it can be had");

    return {
      findingId,
      area,
      title,
      observation: text(row.observation, at("observation"), FEASIBILITY_LIMITS.TEXT, errs),
      severity,
      owner,
      requiredAction: text(row.requiredAction, at("requiredAction"), FEASIBILITY_LIMITS.TEXT, errs),
      status,
      resolutionNote,
      sourceKind: text(row.sourceKind, at("sourceKind"), 60, errs),
      sourceRef: text(row.sourceRef, at("sourceRef"), FEASIBILITY_LIMITS.REFERENCE, errs),
      ...(availability ? { availability } : {}),
      /* Authorship survives every later edit: who first wrote a finding is part
         of what the finding is. */
      createdBy: was?.createdBy || actorOf(actor),
      createdAt: was?.createdAt || now,
      updatedBy: actorOf(actor),
      updatedAt: now,
    };
  });
  if (errs.length) throw invalid("Some of these findings need fixing.", errs);
  return shaped.filter(Boolean);
}

function shapeConditions(raw, { existing }) {
  const rows = list(raw);
  if (rows.length > FEASIBILITY_LIMITS.CONDITIONS) {
    throw invalid(`An assessment holds at most ${FEASIBILITY_LIMITS.CONDITIONS} conditions.`,
      [{ field: "conditions", code: "TOO_MANY", message: `At most ${FEASIBILITY_LIMITS.CONDITIONS}.` }]);
  }
  const errs = [];
  const seen = new Set();
  const shaped = rows.map((row, i) => {
    const at = (f) => `conditions.${i}.${f}`;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      errs.push({ field: `conditions.${i}`, code: "INVALID", message: "Every condition is an object." });
      return null;
    }
    refuseUnknown(row, CONDITION_FIELDS, "a condition", `conditions.${i}`);
    let conditionId = str(row.conditionId);
    if (conditionId && !existing.has(conditionId)) {
      errs.push({ field: at("conditionId"), code: "INVALID", message: "That condition is not part of this assessment." });
    } else if (conditionId && seen.has(conditionId)) {
      errs.push({ field: at("conditionId"), code: "DUPLICATE", message: "The same condition appears twice." });
    }
    if (!conditionId) conditionId = mintId("cnd");
    seen.add(conditionId);
    return {
      conditionId,
      text: text(row.text, at("text"), FEASIBILITY_LIMITS.TEXT, errs, true),
      owner: oneOf(row.owner, OWNERS, at("owner"), errs, "the desk that owes it"),
      requiredAction: text(row.requiredAction, at("requiredAction"), FEASIBILITY_LIMITS.TEXT, errs),
      status: row.status === undefined
        ? FINDING_STATUS.OPEN
        : oneOf(row.status, Object.values(FINDING_STATUS), at("status"), errs, "open or resolved"),
    };
  });
  if (errs.length) throw invalid("Some of these conditions need fixing.", errs);
  return shaped.filter(Boolean);
}

/* ══ PUBLISH ═══════════════════════════════════════════════════════════════ */

/* One word per area for the strip a manager reads in seconds. Derived from the
   findings and from nothing else, so the strip and the list cannot disagree. */
const AREA_STATE = Object.freeze({
  CLEAR: "CLEAR", CONCERN: "CONCERN", BLOCKING: "BLOCKING", NOT_CHECKED: "NOT_CHECKED",
});

function areaStates(assessment) {
  const findings = list(assessment?.findings);
  const assessed = assessment && assessment.outcome !== OUTCOME.NOT_ASSESSED;
  return AREAS.map((area) => {
    const mine = findings.filter((f) => f.area === area);
    const open = mine.filter((f) => f.status !== FINDING_STATUS.RESOLVED);
    let state = AREA_STATE.NOT_CHECKED;
    if (open.some((f) => f.severity === SEVERITY.BLOCKING)) state = AREA_STATE.BLOCKING;
    else if (open.some((f) => f.severity === SEVERITY.CONCERN)) state = AREA_STATE.CONCERN;
    /* An area with no open finding is CLEAR only once somebody has actually
       made an assessment. Before that it is NOT_CHECKED — an empty area is
       not a clean one. */
    else if (assessed) state = AREA_STATE.CLEAR;
    return { area, state, findings: mine.length, open: open.length };
  });
}

/** The assessment as every screen reads it. Never the stored sub-document. */
function publishFeasibility(file, { frozen = null } = {}) {
  const assessment = frozen || file?.feasibility || null;
  const outcome = assessment?.outcome || OUTCOME.NOT_ASSESSED;
  const findings = list(assessment?.findings).map((f) => ({
    findingId: f.findingId,
    area: f.area,
    title: str(f.title),
    observation: str(f.observation),
    severity: f.severity,
    owner: f.owner,
    requiredAction: str(f.requiredAction),
    status: f.status || FINDING_STATUS.OPEN,
    resolutionNote: str(f.resolutionNote),
    sourceKind: str(f.sourceKind),
    sourceRef: str(f.sourceRef),
    availability: f.availability || null,
    updatedByName: str(f.updatedBy?.name),
    updatedAt: f.updatedAt ? new Date(f.updatedAt).toISOString() : null,
  }));
  const staleness = frozen ? { stale: false, basedOn: num(assessment?.basedOnTechnicalRevision), current: null } : stalenessOf(file);
  return {
    outcome,
    assessed: outcome !== OUTCOME.NOT_ASSESSED,
    recommendation: str(assessment?.recommendation),
    findings,
    conditions: list(assessment?.conditions).map((c) => ({
      conditionId: c.conditionId, text: str(c.text), owner: c.owner,
      requiredAction: str(c.requiredAction), status: c.status || FINDING_STATUS.OPEN,
    })),
    areas: areaStates(assessment),
    openBlockers: findings.filter((f) => f.severity === SEVERITY.BLOCKING && f.status === FINDING_STATUS.OPEN).length,
    basedOnTechnicalRevision: num(assessment?.basedOnTechnicalRevision),
    needsReassessment: staleness.stale,
    currentTechnicalRevision: staleness.current,
    assessedByName: str(assessment?.assessedBy?.name),
    assessedAt: assessment?.assessedAt ? new Date(assessment.assessedAt).toISOString() : null,
    revision: num(assessment?.revision) ?? 0,
    /* Frozen copies are evidence and are never editable, whatever the file
       says — the screen reads this rather than deciding it again. */
    editable: !frozen,
    problems: outcomeProblems(assessment),
  };
}

/**
 * The same judgement, small enough to ride on the engineering file.
 *
 * The Summary and Review & Approval both have to say what IE decided and what
 * is still owed, and neither of them needs the findings' prose to do it. A
 * second request for the full assessment would be a second answer to the same
 * question — and the two could disagree the moment one of them was stale. So
 * this is the SAME `publishFeasibility`, reduced: the verdict, the counts and
 * the staleness, with nothing a card cannot use.
 */
function summariseFeasibility(file) {
  const full = publishFeasibility(file);
  return {
    outcome: full.outcome,
    assessed: full.assessed,
    recommendation: full.recommendation,
    openBlockers: full.openBlockers,
    openFindings: full.findings.filter((f) => f.status === FINDING_STATUS.OPEN).length,
    openConditions: full.conditions.filter((c) => c.status !== FINDING_STATUS.RESOLVED).length,
    conditions: full.conditions
      .filter((c) => c.status !== FINDING_STATUS.RESOLVED)
      .map((c) => ({ text: c.text, owner: c.owner })),
    needsReassessment: full.needsReassessment,
    basedOnTechnicalRevision: full.basedOnTechnicalRevision,
    currentTechnicalRevision: full.currentTechnicalRevision,
    assessedByName: full.assessedByName,
    assessedAt: full.assessedAt,
  };
}

/* ══ THE ONE WRITER ════════════════════════════════════════════════════════ */

/**
 * Save the assessment.
 *
 * One conditional update carrying the company, the file's DRAFT status, the
 * assessment's expected revision and the bulletin's review freeze — the same
 * rules every other IE edit follows. A submission in review freezes this too:
 * the reviewer is deciding on the assessment that was submitted with it.
 */
async function saveFeasibility(ctx, { fileId, body = {}, actor = null } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fileNotFound();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw fail("VALIDATION", "That is not an assessment.");
  }
  refuseUnknown(body, BODY_FIELDS, "a feasibility assessment", "");

  const expected = num(body.expectedRevision);
  if (expected === null || !Number.isInteger(expected) || expected < 0) {
    throw fail("VALIDATION", "Say which revision of this assessment you read.", {
      field: "expectedRevision",
      fieldErrors: [{ field: "expectedRevision", code: "REQUIRED", message: "Send the revision you read." }],
    });
  }

  const current = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!current) throw fileNotFound();
  if (current.status !== "DRAFT") {
    throw fail("IE_FILE_REVISION_CONFLICT", "This engineering file is no longer a draft.",
      { fileId: String(current._id) });
  }
  if (current.bulletinReviewVersionId) {
    throw fail("IE_BULLETIN_VERSION_IN_REVIEW",
      "This file's bulletin is under review, so its feasibility assessment is frozen with it. "
      + "It becomes editable again when the submission is returned or approved.",
      {
        fileId: String(current._id),
        bulletinReviewVersionNo: current.bulletinReviewVersionNo ?? null,
      });
  }

  const was = current.feasibility || null;
  const wasRevision = num(was?.revision) ?? 0;
  if (wasRevision !== expected) {
    throw fail("IE_FEASIBILITY_REVISION_CONFLICT",
      "Somebody changed this assessment while you were editing it. Re-read it and decide again.",
      { expected, actual: wasRevision, fileId: String(current._id) });
  }

  const now = new Date();
  const existingFindings = new Map(list(was?.findings).map((f) => [f.findingId, f]));
  const existingConditions = new Set(list(was?.conditions).map((c) => c.conditionId));

  const errs = [];
  const outcome = body.outcome === undefined
    ? (was?.outcome || OUTCOME.NOT_ASSESSED)
    : oneOf(body.outcome, OUTCOMES, "outcome", errs, "the result");
  if (errs.length) throw invalid("That is not a result this assessment can record.", errs);

  const findings = body.findings === undefined
    ? list(was?.findings)
    : shapeFindings(body.findings, { existing: existingFindings, actor, now });
  const conditions = body.conditions === undefined
    ? list(was?.conditions)
    : shapeConditions(body.conditions, { existing: existingConditions });
  const recommendation = body.recommendation === undefined
    ? str(was?.recommendation)
    : text(body.recommendation, "recommendation", FEASIBILITY_LIMITS.TEXT, errs);
  if (errs.length) throw invalid("Some of this assessment needs fixing.", errs);

  /* The outcome is judged against the findings being SAVED, not the ones
     stored a moment ago — otherwise resolving a blocker and recording
     "feasible" in one save would be refused for a state that no longer
     exists. */
  const candidate = { outcome, findings, conditions };
  const problems = outcomeProblems(candidate);
  if (problems.length) {
    throw invalid(problems[0].message, problems.map((p) => ({
      field: "outcome", code: p.code, message: p.message,
    })));
  }

  const assessed = outcome !== OUTCOME.NOT_ASSESSED;
  const next = {
    outcome,
    recommendation,
    findings,
    conditions,
    /* Stamped from the file's own source the moment a judgement is made, which
       is what later makes staleness detectable. */
    basedOnTechnicalRevision: assessed
      ? (num(current.source?.technicalRevision) ?? null)
      : (num(was?.basedOnTechnicalRevision) ?? null),
    assessedBy: assessed ? actorOf(actor) : (was?.assessedBy || { id: null, name: "" }),
    assessedAt: assessed ? now : (was?.assessedAt || null),
    revision: wasRevision + 1,
  };

  const event = {
    eventId: `fev_${crypto.randomBytes(9).toString("hex")}`,
    type: "FEASIBILITY_ASSESSED",
    at: now,
    actorId: actorOf(actor).id,
    actorName: actorOf(actor).name,
    /* The file's revision as it stands. Recording an assessment does NOT move
       it: the assessment carries its own optimistic revision, and bumping the
       file's would make every assessment save invalidate somebody's open
       bulletin draft — two independent edits coupled for no reason. */
    fileRevision: num(current.revision) ?? 1,
    summary: `Feasibility: ${outcome.toLowerCase().replace(/_/g, " ")} — `
      + `${findings.length} finding${findings.length === 1 ? "" : "s"}, `
      + `${findings.filter(isBlocking).length} blocking`,
  };

  const updated = await IeStyleFile.findOneAndUpdate(
    {
      _id: oid(fileId), companyId: ctx.companyId, status: "DRAFT",
      bulletinReviewVersionId: { $exists: false },
      /* The assessment's own revision is in the filter, so two editors cannot
         both believe they saved. */
      ...(was ? { "feasibility.revision": wasRevision } : {}),
    },
    {
      $set: { feasibility: next, updatedBy: actorOf(actor).id, updatedByName: actorOf(actor).name },
      $push: { history: { $each: [event], $slice: -IeStyleFile.LIMITS.HISTORY } },
    },
    { new: true },
  ).lean();

  if (!updated) {
    const now2 = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId })
      .select("_id revision status feasibility.revision bulletinReviewVersionId").lean();
    if (!now2) throw fileNotFound();
    if (now2.bulletinReviewVersionId) {
      throw fail("IE_BULLETIN_VERSION_IN_REVIEW",
        "This file's bulletin went into review while you were editing. The assessment is frozen with it.",
        { fileId: String(now2._id) });
    }
    throw fail("IE_FEASIBILITY_REVISION_CONFLICT",
      "Somebody changed this assessment while you were editing it. Re-read it and decide again.",
      { expected, actual: num(now2.feasibility?.revision) ?? 0, fileId: String(now2._id) });
  }

  return { assessment: publishFeasibility(updated), updated: true };
}

/** The assessment on one file, read. */
async function readFeasibility(ctx, { fileId } = {}) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
  if (!isId(fileId)) throw fileNotFound();
  const file = await IeStyleFile.findOne({ _id: oid(fileId), companyId: ctx.companyId }).lean();
  if (!file) throw fileNotFound();
  return { assessment: publishFeasibility(file), fileId: String(file._id), fileRevision: num(file.revision) };
}

/** A plain copy for freezing into a bulletin version at submission. */
function freezeFeasibility(file) {
  const a = file?.feasibility || null;
  if (!a || a.outcome === OUTCOME.NOT_ASSESSED) return undefined;
  return JSON.parse(JSON.stringify(a));
}

module.exports = {
  OUTCOME, OUTCOMES, AREAS, SEVERITY, SEVERITIES, OWNERS,
  FINDING_STATUS, AVAILABILITY, AREA_STATE, BODY_FIELDS, REFUSED_FIELDS,
  outcomeProblems, stalenessOf, feasibilityGaps, areaStates,
  publishFeasibility, summariseFeasibility, freezeFeasibility,
  saveFeasibility, readFeasibility,
};
